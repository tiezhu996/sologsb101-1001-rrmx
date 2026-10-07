<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowRight, Delete, Plus, RefreshRight } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import ImportBatchDialog from '@/components/reconcile/ImportBatchDialog.vue'
import { useReconcileStore, type BatchSummary } from '@/stores/reconcileStore'
import { BATCH_STATE_COLOR, type ImportBatch, type ImportBatchState } from '@/types/reconcile'
import { seedDemoData } from '@/utils/db'

const router = useRouter()
const reconcileStore = useReconcileStore()

const importVisible = ref(false)
const workingId = ref<string | null>(null)

const batches = computed(() => reconcileStore.batches)

const totals = computed(() => {
  let conflict = 0
  let pending = 0
  let writing = 0
  batches.value.forEach((batch) => {
    const summary = reconcileStore.summarize(batch.id)
    conflict += summary.conflict
    pending += summary.pending
    if (batch.state === '写入中') writing += 1
  })
  return { count: batches.value.length, conflict, pending, writing }
})

function summaryOf(batchId: string): BatchSummary {
  return reconcileStore.summarize(batchId)
}

function stateColor(state: ImportBatchState): string {
  return BATCH_STATE_COLOR[state] ?? '#4a5b63'
}

function progressPercent(batch: ImportBatch): number {
  if (batch.totalRows <= 0) return 0
  return Math.min(100, Math.round(((batch.ingestedRows ?? 0) / batch.totalRows) * 100))
}

async function handleImport(payload: {
  batchNo: string
  vendor: string
  fileName: string
  rawText: string
  positionToleranceM: number
  rangeToleranceM: number
}): Promise<void> {
  try {
    const result = await reconcileStore.createBatch(payload)
    if (!result.batchId) {
      ElMessage.error(`未能创建批次：${result.errors.map((error) => error.message).join('；') || '没有可导入的行'}`)
      return
    }
    if (result.added === 0 && result.duplicated > 0) {
      ElMessage.info(`批次「${payload.batchNo}」此前已导入，重复粘贴不新增记录`)
    } else {
      ElMessage.success(
        `批次「${payload.batchNo}」开始导入：新增 ${result.added} 条，重复跳过 ${result.duplicated} 条，写入完成后自动对账`
      )
    }
    void router.push(`/reconcile/${result.batchId}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '批次导入失败')
  }
}

async function retry(batch: ImportBatch): Promise<void> {
  workingId.value = batch.id
  try {
    await reconcileStore.ingestBatch(batch.id)
    ElMessage.success('已从断点继续写入并完成对账')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  } finally {
    workingId.value = null
  }
}

async function rerun(batch: ImportBatch): Promise<void> {
  workingId.value = batch.id
  try {
    await reconcileStore.reconcileBatchFully(batch.id)
    ElMessage.success('已按当前容差与台账重新对账')
  } finally {
    workingId.value = null
  }
}

async function remove(batch: ImportBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除批次「${batch.batchNo}」？现场记录与对账关联一并清除；由该批次新增且尚无工单的缺陷会一并删除。`,
      '删除批次确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  workingId.value = batch.id
  try {
    await reconcileStore.removeBatch(batch.id)
    ElMessage.success('批次已删除')
  } finally {
    workingId.value = null
  }
}

function open(batch: ImportBatch): void {
  void router.push(`/reconcile/${batch.id}`)
}

async function handleSeed(): Promise<void> {
  const seeded = await seedDemoData()
  if (seeded) ElMessage.success('已生成含外委对账示例的演示数据')
  else ElMessage.info('本地已有数据，未重复播种')
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>外委批次对账</h2>
        <p>外委交回的离线巡检表按批次导入，不再整库覆盖；按机组编号、叶片序号、分段区间、面位、类型与位置容差一对一配对，冲突逐条裁决后才能派工。</p>
      </div>
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="importVisible = true">导入巡检表批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="批次总数" :value="totals.count" suffix="个" tone="primary" icon="Files" />
      <StatBadge label="未决冲突" :value="totals.conflict" suffix="条" tone="danger" icon="WarningFilled" />
      <StatBadge label="待处理关联" :value="totals.pending" suffix="条" tone="warning" icon="Document" />
      <StatBadge label="写入中批次" :value="totals.writing" suffix="个" tone="info" icon="RefreshRight" />
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>批次列表</h3>
        <span class="muted">重复粘贴同一批次自动判重，写入中断后保留进度可重试</span>
      </div>

      <EmptyPanel
        v-if="batches.length === 0"
        title="还没有外委批次"
        description="点击「导入巡检表批次」，把外委交回的离线巡检表（TSV/CSV）粘贴进来，系统按机组、叶片、分段、面位、类型与位置容差自动配对本机标注。"
        action-text="导入巡检表批次"
        show-seed
        @action="importVisible = true"
        @seed="handleSeed"
      />

      <el-table v-else :data="batches" row-key="id" border>
        <el-table-column label="批次编号" min-width="170">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.batchNo }}</strong>
              <span class="muted">{{ row.vendor || '未填外委单位' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <span class="state-pill" :style="{ color: '#fff', backgroundColor: stateColor(row.state) }">
              {{ row.state }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="写入进度" width="180">
          <template #default="{ row }">
            <el-progress :percentage="progressPercent(row)" :stroke-width="8" />
            <span class="muted mono">{{ row.ingestedRows }} / {{ row.totalRows }} 条</span>
            <el-tag v-if="row.lastError" type="danger" size="small" effect="plain">写入中断</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账概览" min-width="260">
          <template #default="{ row }">
            <div class="overview">
              <el-tag size="small" type="danger" effect="dark" v-if="summaryOf(row.id).conflict > 0">
                冲突 {{ summaryOf(row.id).conflict }}
              </el-tag>
              <el-tag size="small" type="success" effect="plain">一致 {{ summaryOf(row.id).consistent }}</el-tag>
              <el-tag size="small" type="primary" effect="plain">新增 {{ summaryOf(row.id).spawned }}</el-tag>
              <el-tag size="small" type="warning" effect="plain" v-if="summaryOf(row.id).unlocated > 0">
                无法定位 {{ summaryOf(row.id).unlocated }}
              </el-tag>
              <el-tag size="small" effect="plain" v-if="summaryOf(row.id).resolved > 0">
                已决 {{ summaryOf(row.id).resolved }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="来源文件" prop="fileName" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="open(row)">
              对账明细<el-icon class="el-icon--right"><ArrowRight /></el-icon>
            </el-button>
            <el-button v-if="row.state === '写入中' || row.lastError" link type="warning" :loading="workingId === row.id" @click="retry(row)">
              续传重试
            </el-button>
            <el-button v-else link type="primary" :icon="RefreshRight" :loading="workingId === row.id" @click="rerun(row)">
              重新对账
            </el-button>
            <el-button link type="danger" :icon="Delete" :loading="workingId === row.id" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <ImportBatchDialog v-model:visible="importVisible" @submit="handleImport" />
  </div>
</template>

<style scoped>
.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.state-pill {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.overview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
