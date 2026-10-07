<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import { Checked, Delete, Plus, Refresh, RefreshRight, Upload } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useReconStore, type ConflictRow } from '@/stores/reconStore'
import { readFileText } from '@/utils/export'
import { parseFieldSheet, type ParseResult } from '@/utils/recon'
import { formatSize } from '@/utils/severity'
import {
  CONFLICT_FIELD_LABEL,
  CONFLICT_STATUS_LABEL,
  DEFAULT_TOLERANCE_M,
  FIELD_BATCH_STATUS_LABEL,
  FIELD_BATCH_STATUS_TAG,
  MATCH_STATUS_LABEL,
  MATCH_STATUS_TAG,
  MAX_TOLERANCE_M,
  MIN_TOLERANCE_M,
  type FieldBatch,
  type FieldRecord,
  type ReconConflict
} from '@/types/fieldBatch'
import { FACE_LABEL, type SegmentFace } from '@/types/segment'

const reconStore = useReconStore()

function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

function formatDateTime(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

/** 批次状态标签（模板内免去类型断言） */
function batchStatusText(status: string): string {
  return FIELD_BATCH_STATUS_LABEL[status as FieldBatch['status']] ?? status
}

function batchStatusTag(status: string): 'info' | 'warning' | 'success' {
  return FIELD_BATCH_STATUS_TAG[status as FieldBatch['status']] ?? 'info'
}

/** 记录对账结果标签（模板内免去类型断言） */
function matchStatusTag(status: string): 'success' | 'info' | 'warning' | 'danger' {
  return MATCH_STATUS_TAG[status as FieldRecord['matchStatus']] ?? 'info'
}

const summary = computed(() => ({
  batches: reconStore.batches.length,
  records: reconStore.records.length,
  pending: reconStore.pendingConflictCount,
  resolved: reconStore.resolvedConflicts.length,
  added: reconStore.batches.reduce((sum, batch) => sum + batch.stats.added, 0)
}))

/* ---------------- 未决冲突裁决 ---------------- */
const ownerModel = computed({
  get: () => reconStore.owner,
  set: (value: string) => reconStore.setOwner(value)
})

const resolving = ref(false)

/** 差异文案：等级 中度 → 重度 / 长度 820 → 900 mm */
function diffChips(conflict: ReconConflict): string[] {
  return conflict.diffFields.map((field) => {
    if (field === 'severity') {
      return `等级 ${conflict.localVersion.severity} → ${conflict.fieldVersion.severity}`
    }
    const label = CONFLICT_FIELD_LABEL[field]
    const local = conflict.localVersion[field]
    const fieldValue = conflict.fieldVersion[field]
    return `${label} ${local} → ${fieldValue} mm`
  })
}

function locationText(row: ConflictRow): string {
  const record = row.record
  if (!record) return '现场记录已删除'
  return `${record.turbineCode}｜叶片 ${record.bladeSerial}｜${record.segmentStartM}-${record.segmentEndM} m｜${record.face}`
}

async function resolve(row: ConflictRow, choice: 'local' | 'field'): Promise<void> {
  if (!reconStore.owner.trim()) {
    ElMessage.warning('请先填写负责人，再逐条裁决')
    return
  }
  resolving.value = true
  try {
    const done = await reconStore.resolveConflict(row.conflict.id, choice)
    if (done) {
      ElMessage.success(choice === 'local' ? '已保留本机值' : '已采用现场值并写回本机缺陷')
    } else {
      ElMessage.info('该冲突已被处理或重算，请查看最新列表')
    }
  } finally {
    resolving.value = false
  }
}

/* ---------------- 导入批次 ---------------- */
const importVisible = ref(false)
const importSubmitting = ref(false)
const importForm = reactive({
  name: '',
  source: '',
  toleranceM: DEFAULT_TOLERANCE_M,
  text: ''
})
const parseResult = ref<ParseResult | null>(null)

const EXAMPLE_SHEET = [
  '机组编号\t叶片序号\t分段起点(m)\t分段终点(m)\t面位\t类型\t严重程度\t长度(mm)\t宽度(mm)\t展向位置(m)\t发现日期',
  'WT-A01\tA\t22.83\t45.67\tLE\t裂纹\t重度\t1450\t6\t29.68\t2026-09-11',
  'WT-A01\tA\t0\t22.83\tPS\t前缘腐蚀\t重度\t900\t36\t6.85\t2026-09-20',
  'WT-A01\tB\t0\t22.83\tPS\t砂眼\t轻度\t8\t6\t3.25\t2026-10-01',
  'WT-C99\tA\t0\t20\tPS\t裂纹\t轻度\t100\t5\t3\t2026-10-01'
].join('\n')

function openImport(): void {
  importForm.name = `外委巡检 ${todayString()}`
  importForm.source = ''
  importForm.toleranceM = DEFAULT_TOLERANCE_M
  importForm.text = ''
  parseResult.value = null
  importVisible.value = true
}

function analyzeImport(): void {
  parseResult.value = parseFieldSheet(importForm.text)
}

function fillExample(): void {
  importForm.text = EXAMPLE_SHEET
  analyzeImport()
}

async function handleImportFile(file: UploadFile): Promise<void> {
  const raw = file.raw
  if (!raw) return
  importForm.text = await readFileText(raw)
  analyzeImport()
}

const importReady = computed(
  () => parseResult.value !== null && parseResult.value.errors.length === 0 && parseResult.value.rows.length > 0
)

async function submitImport(): Promise<void> {
  const parsed = parseResult.value
  if (!parsed || parsed.rows.length === 0) return
  importSubmitting.value = true
  try {
    const result = await reconStore.importBatch({
      name: importForm.name.trim() || `外委巡检 ${todayString()}`,
      source: importForm.source.trim(),
      toleranceM: importForm.toleranceM,
      rows: parsed.rows
    })
    if (result.duplicated) {
      ElMessage.info(`同一批次已导入过（内容指纹一致），未新增记录：${result.batch.name}`)
    } else {
      const stats = result.batch.stats
      ElMessage.success(
        `批次「${result.batch.name}」对账完成：新增 ${stats.added} · 一致 ${stats.matched} · 冲突 ${stats.conflict} · 未匹配 ${stats.unmatched} · 重复 ${stats.duplicate}`
      )
    }
    importVisible.value = false
  } finally {
    importSubmitting.value = false
  }
}

/* ---------------- 批次操作 ---------------- */
const batchWorking = ref(false)

async function resumeBatch(batch: FieldBatch): Promise<void> {
  batchWorking.value = true
  try {
    await reconStore.resumeBatch(batch.id)
    ElMessage.success(`批次「${batch.name}」已继续写入并对账完成`)
  } finally {
    batchWorking.value = false
  }
}

async function reReconcile(batch: FieldBatch): Promise<void> {
  batchWorking.value = true
  try {
    const count = await reconStore.reReconcileBatch(batch.id)
    if (count > 0) ElMessage.success(`已对 ${count} 条未决 / 未匹配记录重新对账`)
    else ElMessage.info('该批次没有需要重新对账的记录')
  } finally {
    batchWorking.value = false
  }
}

async function removeBatch(batch: FieldBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除批次「${batch.name}」？其现场记录与对账冲突会一并删除；由本批次自动新增的缺陷保留在本机标注中。`,
      '删除批次确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reconStore.removeBatch(batch.id)
  ElMessage.success('批次已删除')
}

/* ---------------- 批次明细抽屉 ---------------- */
const drawerVisible = ref(false)
const activeBatchId = ref('')

const activeBatch = computed(() => reconStore.batches.find((batch) => batch.id === activeBatchId.value) ?? null)
const activeRecords = computed(() => reconStore.recordsOfBatch(activeBatchId.value))
const activeConflictMap = computed(() => {
  const map = new Map<string, ReconConflict>()
  reconStore.conflictsOfBatch(activeBatchId.value).forEach((conflict) => map.set(conflict.recordId, conflict))
  return map
})

function openRecords(batch: FieldBatch): void {
  activeBatchId.value = batch.id
  drawerVisible.value = true
}

function recordStatusText(record: FieldRecord): string {
  const base = MATCH_STATUS_LABEL[record.matchStatus]
  if (record.matchStatus !== 'conflict') return base
  const conflict = activeConflictMap.value.get(record.id)
  if (!conflict) return base
  return `${base} · ${CONFLICT_STATUS_LABEL[conflict.status]}`
}

function progressText(batch: FieldBatch): string {
  return `${batch.writtenRows}/${batch.totalRows}`
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>批次对账</h2>
        <p>
          外委离线巡检表按批次粘贴导入，按「机组编号 + 叶片序号 + 分段区间 + 面位 + 类型 + 位置容差」与本机缺陷对账；
          尺寸或等级不一致时保留两版，负责人逐条裁决，未决前不能生成工单。
        </p>
      </div>
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="openImport">导入巡检批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="巡检批次" :value="summary.batches" suffix="批" tone="primary" icon="Files" />
      <StatBadge label="现场记录" :value="summary.records" suffix="条" tone="info" icon="Document" />
      <StatBadge label="未决冲突" :value="summary.pending" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="已裁决 / 消除" :value="summary.resolved" suffix="条" tone="success" icon="SuccessFilled" />
      <StatBadge label="对账新增缺陷" :value="summary.added" suffix="条" tone="warning" icon="Histogram" />
    </div>

    <div v-if="reconStore.pendingConflictRows.length > 0" class="section-card conflict-card">
      <div class="section-card__head">
        <h3>未决冲突（{{ reconStore.pendingConflictRows.length }} 条，裁决前相关缺陷不能派工）</h3>
        <div class="toolbar">
          <span class="muted">负责人</span>
          <el-input
            v-model="ownerModel"
            placeholder="裁决人姓名"
            class="owner-input"
            clearable
          />
        </div>
      </div>
      <el-table :data="reconStore.pendingConflictRows" row-key="conflict.id" border>
        <el-table-column label="批次" width="160">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.batch?.name ?? '—' }}</span>
              <span class="muted">{{ row.batch?.source || '未注明来源' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="定位" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ locationText(row) }}</span>
              <span class="muted">{{ row.record?.type ?? '—' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="差异（本机 → 现场）" min-width="180">
          <template #default="{ row }">
            <div class="chip-stack">
              <el-tag
                v-for="chip in diffChips(row.conflict)"
                :key="chip"
                size="small"
                type="danger"
                effect="plain"
              >
                {{ chip }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="本机值" width="170">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.conflict.localVersion.severity }}</span>
              <span class="muted mono">
                {{ formatSize(row.conflict.localVersion.lengthMm, row.conflict.localVersion.widthMm) }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="现场值" width="170">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.conflict.fieldVersion.severity }}</span>
              <span class="muted mono">
                {{ formatSize(row.conflict.fieldVersion.lengthMm, row.conflict.fieldVersion.widthMm) }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :loading="resolving" @click="resolve(row, 'local')">选本机值</el-button>
            <el-button size="small" type="primary" :loading="resolving" @click="resolve(row, 'field')">
              选现场值
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>巡检批次（{{ reconStore.batches.length }} 批）</h3>
        <span class="muted">重复粘贴同一批次不会新增记录；写入中断可继续</span>
      </div>

      <EmptyPanel
        v-if="reconStore.batches.length === 0"
        title="还没有巡检批次"
        description="把外委交回的离线巡检表粘贴导入，系统会按匹配键与本机缺陷对账，不再整库覆盖本机标注。"
        action-text="导入巡检批次"
        @action="openImport"
      />

      <el-table v-else :data="reconStore.batches" row-key="id" border>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.name }}</span>
              <span class="muted">{{ row.source || '未注明来源' }} · {{ formatDateTime(row.createdAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="写入进度" width="110">
          <template #default="{ row }">
            <span class="mono">{{ progressText(row) }}</span>
            <el-tag v-if="row.status === 'importing'" size="small" type="danger" effect="plain">中断可续</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="batchStatusTag(row.status)" effect="light">
              {{ batchStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账统计" min-width="240">
          <template #default="{ row }">
            <div class="chip-stack">
              <el-tag size="small" type="success" effect="plain">新增 {{ row.stats.added }}</el-tag>
              <el-tag size="small" type="info" effect="plain">一致 {{ row.stats.matched }}</el-tag>
              <el-tag size="small" type="warning" effect="plain">冲突 {{ row.stats.conflict }}</el-tag>
              <el-tag size="small" type="danger" effect="plain">未匹配 {{ row.stats.unmatched }}</el-tag>
              <el-tag size="small" type="info" effect="plain">重复 {{ row.stats.duplicate }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="位置容差" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.toleranceM }} m</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Checked" @click="openRecords(row)">查看记录</el-button>
            <el-button
              v-if="row.status === 'importing'"
              link
              type="warning"
              :icon="RefreshRight"
              :loading="batchWorking"
              @click="resumeBatch(row)"
            >
              继续写入
            </el-button>
            <el-button
              v-else
              link
              type="primary"
              :icon="Refresh"
              :loading="batchWorking"
              @click="reReconcile(row)"
            >
              重新对账
            </el-button>
            <el-button link type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="importVisible" title="导入巡检批次" width="720px" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="批次名称">
          <el-input v-model="importForm.name" placeholder="如 外委巡检 2026-10-07" clearable />
        </el-form-item>
        <el-form-item label="来源 / 外委">
          <el-input v-model="importForm.source" placeholder="如 某某检测公司（可空）" clearable />
        </el-form-item>
        <el-form-item label="位置容差">
          <el-input-number
            v-model="importForm.toleranceM"
            :min="MIN_TOLERANCE_M"
            :max="MAX_TOLERANCE_M"
            :step="0.1"
            :precision="1"
          />
          <span class="muted unit">米（现场与本机展向位置之差 ≤ 容差才可能命中）</span>
        </el-form-item>
        <el-form-item label="巡检表内容">
          <el-input
            v-model="importForm.text"
            type="textarea"
            :rows="8"
            placeholder="从 Excel 复制粘贴（含表头），或选择 CSV / TXT / JSON 文件"
            @blur="analyzeImport"
          />
        </el-form-item>
        <el-form-item>
          <div class="toolbar">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              accept=".csv,.txt,.json,text/csv,text/plain,application/json"
              :on-change="(file: UploadFile) => handleImportFile(file)"
            >
              <el-button :icon="Upload">选择文件</el-button>
            </el-upload>
            <el-button @click="analyzeImport">解析校验</el-button>
            <el-button link type="primary" @click="fillExample">填入示例</el-button>
          </div>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="列顺序：机组编号、叶片序号、分段起点(m)、分段终点(m)、面位、类型、严重程度、长度(mm)、宽度(mm)、展向位置(m)、发现日期；首行为表头，支持制表符 / 逗号分隔或 JSON 数组。"
        class="import-hint"
      />
      <template v-if="parseResult">
        <el-alert
          v-if="importReady"
          type="success"
          :closable="false"
          show-icon
          :title="`校验通过：共 ${parseResult.rows.length} 条现场记录，确认后写入并对账。`"
          class="import-hint"
        />
        <el-alert
          v-else
          type="error"
          :closable="false"
          show-icon
          title="校验未通过，请修正后重新解析："
          class="import-hint"
        />
        <ul v-if="!importReady" class="import-errors">
          <li v-for="error in parseResult.errors.slice(0, 8)" :key="error">{{ error }}</li>
          <li v-if="parseResult.errors.length > 8">… 共 {{ parseResult.errors.length }} 处问题</li>
        </ul>
      </template>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!importReady" :loading="importSubmitting" @click="submitImport">
          确认导入并对账
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" size="78%" :title="activeBatch ? `批次记录 · ${activeBatch.name}` : '批次记录'">
      <template v-if="activeBatch">
        <div class="drawer-meta">
          <el-tag size="small" :type="FIELD_BATCH_STATUS_TAG[activeBatch.status]" effect="light">
            {{ FIELD_BATCH_STATUS_LABEL[activeBatch.status] }}
          </el-tag>
          <span class="muted">
            {{ activeBatch.source || '未注明来源' }} · 容差 {{ activeBatch.toleranceM }} m ·
            指纹 {{ activeBatch.fingerprint }}
          </span>
        </div>
        <el-table :data="activeRecords" row-key="id" border size="small">
          <el-table-column label="行号" width="70">
            <template #default="{ row }">{{ row.rowNo + 1 }}</template>
          </el-table-column>
          <el-table-column label="机组 / 叶片" width="120">
            <template #default="{ row }">{{ row.turbineCode }}｜{{ row.bladeSerial }}</template>
          </el-table-column>
          <el-table-column label="分段区间" width="120">
            <template #default="{ row }">
              <span class="mono">{{ row.segmentStartM }}-{{ row.segmentEndM }} m</span>
            </template>
          </el-table-column>
          <el-table-column label="面位" width="110">
            <template #default="{ row }">{{ faceText(row.face) }}</template>
          </el-table-column>
          <el-table-column label="类型" prop="type" width="100" />
          <el-table-column label="程度" prop="severity" width="80" />
          <el-table-column label="尺寸" width="140">
            <template #default="{ row }">
              <span class="mono">{{ formatSize(row.lengthMm, row.widthMm) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="展向位置" width="90">
            <template #default="{ row }">
              <span class="mono">{{ row.positionM }} m</span>
            </template>
          </el-table-column>
          <el-table-column label="发现日期" prop="foundAt" width="110">
            <template #default="{ row }">{{ row.foundAt || '—' }}</template>
          </el-table-column>
          <el-table-column label="对账结果" width="130">
            <template #default="{ row }">
              <el-tag size="small" :type="matchStatusTag(row.matchStatus)" effect="light">
                {{ recordStatusText(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="180">
            <template #default="{ row }">
              <span class="muted">{{ row.note || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.conflict-card {
  border-color: #e6b8c0;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.chip-stack {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.owner-input {
  width: 160px;
}

.unit {
  margin-left: 8px;
  font-size: 12px;
}

.import-hint {
  margin-top: 12px;
}

.import-errors {
  margin: 8px 0 0;
  padding-left: 20px;
  color: #c0392b;
  font-size: 13px;
}

.drawer-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
</style>
