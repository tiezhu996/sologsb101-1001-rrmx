<script setup lang="ts">
import { computed, ref } from 'vue'
import { Hide } from '@element-plus/icons-vue'
import type { ReconcileRowView } from '@/stores/reconcileStore'

const props = defineProps<{
  rows: ReconcileRowView[]
  owner: string
}>()

const emit = defineEmits<{
  (event: 'ignore', linkIds: string[], owner: string): void
}>()

const selectedIds = ref<string[]>([])

const rows = computed(() => props.rows)

function ignoreSelected(): void {
  if (selectedIds.value.length === 0) return
  emit('ignore', [...selectedIds.value], props.owner)
  selectedIds.value = []
}
</script>

<template>
  <el-alert
    type="warning"
    :closable="false"
    show-icon
    class="unlocated-alert"
    title="以下现场记录无法在本机台账定位（机组编号 / 叶片序号 / 分段区间对不上），不会生成缺陷也不能派工。请核对后忽略，或修正台账后点「重新对账」。"
  />
  <div class="bulk-bar">
    <el-tag type="warning" effect="dark">{{ rows.length }} 条待处理</el-tag>
    <el-button size="small" :icon="Hide" :disabled="selectedIds.length === 0 || !owner.trim()" @click="ignoreSelected">
      忽略选中
    </el-button>
    <span class="muted">使用当前负责人「{{ owner || '未填写' }}」记录忽略操作</span>
  </div>
  <el-table
    :data="rows"
    row-key="link.id"
    size="small"
    border
    @selection-change="(selected: ReconcileRowView[]) => (selectedIds = selected.map((row) => row.link.id))"
  >
    <el-table-column type="selection" width="46" />
    <el-table-column label="源行" width="80">
      <template #default="{ row }">第 {{ row.fieldRow?.sourceLine ?? '—' }} 行</template>
    </el-table-column>
    <el-table-column label="机组 / 叶片" min-width="140">
      <template #default="{ row }">
        {{ row.fieldRow?.turbineCode }}｜叶片 {{ row.fieldRow?.bladeSerial }}
      </template>
    </el-table-column>
    <el-table-column label="分段区间（现场）" min-width="160">
      <template #default="{ row }">
        <span class="mono">
          {{ row.fieldRow?.segmentStartM }}-{{ row.fieldRow?.segmentEndM }} m · {{ row.fieldRow?.positionM }} m
        </span>
      </template>
    </el-table-column>
    <el-table-column label="缺陷" min-width="160">
      <template #default="{ row }">
        {{ row.fieldRow?.type }}（{{ row.fieldRow?.severity }}）
      </template>
    </el-table-column>
    <el-table-column label="原因" width="140">
      <template #default="{ row }">
        <el-tag type="warning" size="small" effect="plain">{{ row.link.locateReason ?? '无法定位' }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="巡检人" prop="fieldRow.inspector" width="120" />
  </el-table>
</template>

<style scoped>
.unlocated-alert {
  margin-bottom: 10px;
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
</style>
