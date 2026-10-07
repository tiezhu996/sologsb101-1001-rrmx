<script setup lang="ts">
import { computed } from 'vue'
import { Check, CircleCheck } from '@element-plus/icons-vue'
import SeverityTag from '@/components/common/SeverityTag.vue'
import { formatSize } from '@/utils/severity'
import { formatRange, FACE_LABEL, type SegmentFace } from '@/types/segment'
import { LINK_STATE_COLOR, type ConflictChoice, type ReconcileLinkState } from '@/types/reconcile'
import type { ReconcileRowView } from '@/stores/reconcileStore'
import type { ConflictField } from '@/types/reconcile'

const props = defineProps<{
  rows: ReconcileRowView[]
  /** 负责人默认值 */
  owner: string
  /** 是否显示批量操作条 */
  showBulk?: boolean
}>()

const emit = defineEmits<{
  (event: 'resolve', linkId: string, choice: ConflictChoice, owner: string): void
  (event: 'resolveMany', linkIds: string[], choice: ConflictChoice, owner: string): void
}>()

function faceText(face: string): string {
  return FACE_LABEL[face as SegmentFace] ?? face
}

function stateColor(state: ReconcileLinkState): string {
  return LINK_STATE_COLOR[state] ?? '#4a5b63'
}

const FIELD_LABEL: Record<ConflictField, string> = {
  severity: '等级',
  lengthMm: '长度',
  widthMm: '宽度'
}

function diffLabel(fields: ConflictField[]): string {
  return fields.map((field) => FIELD_LABEL[field]).join('、')
}

/** 某个差异字段是否命中，命中则高亮对应版本 */
function isDiff(row: ReconcileRowView, field: ConflictField): boolean {
  return row.link.differences.includes(field)
}

function resolve(row: ReconcileRowView, choice: ConflictChoice): void {
  emit('resolve', row.link.id, choice, props.owner)
}

const selected = computed(() => props.rows.filter((row) => row.link.state === '冲突待决'))

function bulk(choice: ConflictChoice): void {
  if (!props.owner.trim()) return
  emit(
    'resolveMany',
    selected.value.map((row) => row.link.id),
    choice,
    props.owner
  )
}
</script>

<template>
  <div>
    <div v-if="showBulk && selected.length > 0" class="bulk-bar">
      <el-tag type="danger" effect="dark">待裁决 {{ selected.length }} 条</el-tag>
      <el-button size="small" type="primary" plain :icon="CircleCheck" :disabled="!owner.trim()" @click="bulk('本机')">
        全部取本机值
      </el-button>
      <el-button size="small" type="warning" plain :icon="Check" :disabled="!owner.trim()" @click="bulk('现场')">
        全部取现场值
      </el-button>
      <span class="muted">批量使用当前负责人「{{ owner || '未填写' }}」</span>
    </div>

    <el-table :data="rows" row-key="link.id" size="small" border>
      <el-table-column label="定位" min-width="210">
        <template #default="{ row }">
          <div class="cell-stack">
            <span>{{ row.turbine?.code ?? row.fieldRow?.turbineCode ?? '—' }}｜叶片 {{ row.blade?.serial ?? row.fieldRow?.bladeSerial ?? '—' }}</span>
            <span class="muted">
              {{ row.segment ? `第 ${row.segment.index} 段 · ${formatRange(row.segment.startM, row.segment.endM)}` : '分段缺失' }}
            </span>
            <span class="muted">{{ row.fieldRow?.type }}｜{{ faceText(row.fieldRow?.face ?? '') }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="本机值" min-width="200">
        <template #default="{ row }">
          <div class="version" :class="{ 'is-diff': isDiff(row, 'severity') || isDiff(row, 'lengthMm') || isDiff(row, 'widthMm') }">
            <SeverityTag
              v-if="row.defect"
              :severity="row.defect.severity"
              :length-mm="row.defect.lengthMm"
              :width-mm="row.defect.widthMm"
              size="small"
            />
            <span v-else class="muted">无本机记录</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="现场值" min-width="200">
        <template #default="{ row }">
          <div class="version">
            <SeverityTag
              v-if="row.fieldRow"
              :severity="row.fieldRow.severity"
              :length-mm="row.fieldRow.lengthMm"
              :width-mm="row.fieldRow.widthMm"
              size="small"
            />
          </div>
          <div class="muted mono">
            {{ row.fieldRow ? formatSize(row.fieldRow.lengthMm, row.fieldRow.widthMm) : '—' }}
            · {{ row.fieldRow?.positionM ?? '—' }} m
          </div>
        </template>
      </el-table-column>

      <el-table-column label="差异字段" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.link.differences.length > 0" type="danger" size="small" effect="plain">
            {{ diffLabel(row.link.differences) }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <el-table-column label="状态 / 负责人" width="150">
        <template #default="{ row }">
          <div class="cell-stack">
            <span class="state-pill" :style="{ color: '#fff', backgroundColor: stateColor(row.link.state) }">
              {{ row.link.state }}
            </span>
            <span class="muted">{{ row.link.owner || '未指派' }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="逐条裁决" width="210" fixed="right">
        <template #default="{ row }">
          <template v-if="row.link.state === '冲突待决'">
            <el-button size="small" type="primary" plain :icon="CircleCheck" @click="resolve(row, '本机')">
              取本机
            </el-button>
            <el-button size="small" type="warning" plain :icon="Check" @click="resolve(row, '现场')">
              取现场
            </el-button>
          </template>
          <template v-else>
            <span class="muted">{{ row.link.resolution ? `已取${row.link.resolution}值` : '—' }}</span>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.version.is-diff {
  border-radius: 6px;
}

.state-pill {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  width: fit-content;
}

.bulk-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: #fdf3f1;
  border: 1px solid #f0c7bf;
  border-radius: 8px;
  font-size: 13px;
}
</style>
