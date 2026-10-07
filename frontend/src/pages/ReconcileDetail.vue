<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, RefreshRight } from '@element-plus/icons-vue'
import ConflictTable from '@/components/reconcile/ConflictTable.vue'
import UnlocatedPanel from '@/components/reconcile/UnlocatedPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReconcileStore } from '@/stores/reconcileStore'
import {
  BATCH_STATE_COLOR,
  isOpenLinkState,
  type ConflictChoice,
  type ImportBatchState,
  type ReconcileLinkState
} from '@/types/reconcile'

const route = useRoute()
const router = useRouter()
const reconcileStore = useReconcileStore()

const batchId = computed(() => String(route.params.id ?? ''))
const batch = computed(() => reconcileStore.batchById(batchId.value) ?? null)
const allViews = computed(() => reconcileStore.viewsOfBatch(batchId.value))
const summary = computed(() => reconcileStore.summarize(batchId.value))

const owner = ref('')
const activeTab = ref<'conflict' | 'matched' | 'spawned' | 'unlocated'>('conflict')
const rerunning = ref(false)

type TabKey = 'conflict' | 'matched' | 'spawned' | 'unlocated'

function stateColor(state: ImportBatchState): string {
  return BATCH_STATE_COLOR[state] ?? '#4a5b63'
}

function isState(view: { link: { state: ReconcileLinkState } }, states: ReconcileLinkState[]): boolean {
  return states.includes(view.link.state)
}

const conflictViews = computed(() =>
  allViews.value.filter((view) => isState(view, ['冲突待决']))
)
const matchedViews = computed(() =>
  allViews.value.filter((view) => isState(view, ['一致', '已决取本机', '已决取现场']))
)
const spawnedViews = computed(() => allViews.value.filter((view) => view.link.state === '已新增'))
const unlocatedViews = computed(() => allViews.value.filter((view) => isState(view, ['无法定位', '已忽略'])))
const openUnlocated = computed(() => allViews.value.filter((view) => view.link.state === '无法定位'))

const tabs = computed(() => [
  { key: 'conflict' as TabKey, label: `冲突待决 (${summary.value.conflict})` },
  { key: 'matched' as TabKey, label: `一致 / 已决 (${summary.value.consistent + summary.value.resolved})` },
  { key: 'spawned' as TabKey, label: `现场新增 (${summary.value.spawned})` },
  { key: 'unlocated' as TabKey, label: `无法定位 (${summary.value.unlocated})` }
])

const currentViews = computed(() => {
  if (activeTab.value === 'conflict') return conflictViews.value
  if (activeTab.value === 'matched') return matchedViews.value
  if (activeTab.value === 'spawned') return spawnedViews.value
  return unlocatedViews.value
})

async function handleResolve(linkId: string, choice: ConflictChoice, resolvedOwner: string): Promise<void> {
  if (!resolvedOwner.trim()) {
    ElMessage.warning('请先填写负责人，再选择本机值或现场值')
    return
  }
  await reconcileStore.resolveLink(linkId, choice, resolvedOwner)
  ElMessage.success(`已按负责人「${resolvedOwner.trim()}」裁决：取${choice}值`)
  if (conflictViews.value.length === 0) {
    ElMessage.success('本批次冲突已全部裁决')
  }
}

async function handleResolveMany(linkIds: string[], choice: ConflictChoice, resolvedOwner: string): Promise<void> {
  await reconcileStore.resolveLinks(linkIds, choice, resolvedOwner)
  ElMessage.success(`已批量裁决 ${linkIds.length} 条：取${choice}值，负责人「${resolvedOwner.trim()}」`)
}

async function handleIgnore(linkIds: string[], resolvedOwner: string): Promise<void> {
  await reconcileStore.ignoreLinks(linkIds, resolvedOwner)
  ElMessage.success(`已忽略 ${linkIds.length} 条无法定位记录`)
}

async function rerun(): Promise<void> {
  if (!batch.value) return
  try {
    await ElMessageBox.confirm(
      '将按当前容差重新对整批现场记录配对；已裁决的结果保留，未决冲突会依据本机最新值重算。确定继续？',
      '重新对账确认',
      { type: 'info', confirmButtonText: '重新对账', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  rerunning.value = true
  try {
    await reconcileStore.reconcileBatchFully(batchId.value)
    ElMessage.success('已重新对账')
  } finally {
    rerunning.value = false
  }
}

async function retryIngest(): Promise<void> {
  try {
    await reconcileStore.ingestBatch(batchId.value)
    ElMessage.success('已从断点继续写入并完成对账')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  }
}

const canGenerateOrder = computed(() => summary.value.pending === 0)
const anyOpen = computed(() =>
  allViews.value.some((view) => isOpenLinkState(view.link.state))
)
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>
          <el-button link :icon="ArrowLeft" @click="router.push('/reconcile')">批次对账</el-button>
          <span class="title-sep">/</span>{{ batch?.batchNo ?? '批次' }}
        </h2>
        <p v-if="batch">
          {{ batch.vendor || '未填外委单位' }} · {{ batch.fileName }} · 位置容差 {{ batch.positionToleranceM }} m ·
          分段区间容差 {{ batch.rangeToleranceM }} m
        </p>
      </div>
      <div class="toolbar">
        <el-tag v-if="batch" size="large" :style="{ color: '#fff', backgroundColor: stateColor(batch.state), border: 'none' }">
          {{ batch.state }}
        </el-tag>
        <el-button
          v-if="batch && (batch.state === '写入中' || batch.lastError)"
          type="warning"
          @click="retryIngest"
        >
          续传重试
        </el-button>
        <el-button v-else :icon="RefreshRight" :loading="rerunning" @click="rerun">重新对账</el-button>
      </div>
    </div>

    <EmptyPanel
      v-if="!batch"
      title="批次不存在或已被删除"
      description="回到批次对账中心选择一个批次，或导入新的外委离线巡检表。"
      action-text="返回批次列表"
      @action="router.push('/reconcile')"
    />

    <template v-else>
      <div class="stat-row">
        <StatBadge label="现场记录" :value="summary.total" suffix="条" tone="primary" icon="Document" />
        <StatBadge label="冲突待决" :value="summary.conflict" suffix="条" tone="danger" icon="WarningFilled" />
        <StatBadge label="一致" :value="summary.consistent" suffix="条" tone="success" icon="CircleCheckFilled" />
        <StatBadge label="现场新增" :value="summary.spawned" suffix="条" tone="info" icon="Plus" />
        <StatBadge label="无法定位" :value="summary.unlocated" suffix="条" tone="warning" icon="Position" />
        <StatBadge label="已裁决" :value="summary.resolved" suffix="条" tone="default" icon="Checked" />
      </div>

      <el-alert
        v-if="!canGenerateOrder"
        type="error"
        :closable="false"
        show-icon
        class="guard-alert"
        title="本批次尚有未决项（冲突 / 无法定位），相关缺陷不能生成维修工单；请由负责人逐条选择本机值或现场值后再派工。"
      />
      <el-alert
        v-else
        type="success"
        :closable="false"
        show-icon
        class="guard-alert"
        title="本批次无未决冲突，可以正常派工；已生成的工单与报告始终保留派工当时的缺陷版本。"
      />

      <div class="section-card">
        <div class="owner-bar">
          <span class="owner-label">本次负责人：</span>
          <el-input v-model="owner" placeholder="填写姓名，逐条裁决时记录" class="owner-input" clearable />
          <span class="muted">负责人需对每条冲突选择「取本机」或「取现场」</span>
        </div>

        <el-tabs v-model="activeTab" class="reconcile-tabs">
          <el-tab-pane v-for="tab in tabs" :key="tab.key" :label="tab.label" :name="tab.key" />
        </el-tabs>

        <EmptyPanel
          v-if="currentViews.length === 0"
          compact
          :title="
            activeTab === 'conflict'
              ? '没有冲突待决记录'
              : activeTab === 'unlocated'
                ? '没有无法定位的记录'
                : '当前分类下暂无记录'
          "
          :description="
            activeTab === 'conflict'
              ? '现场与本机等级 / 尺寸一致的记录会归入「一致 / 已决」。'
              : '可切换上方页签查看其他对账结果。'
          "
        />

        <ConflictTable
          v-else-if="activeTab !== 'unlocated'"
          :rows="currentViews"
          :owner="owner"
          :show-bulk="activeTab === 'conflict'"
          @resolve="handleResolve"
          @resolve-many="handleResolveMany"
        />

        <UnlocatedPanel
          v-else
          :rows="openUnlocated.length > 0 ? openUnlocated : unlocatedViews"
          :owner="owner"
          @ignore="handleIgnore"
        />
      </div>

      <p v-if="anyOpen" class="muted footnote">
        提示：本机缺陷后来被修改时，未决冲突会自动重算；已选择取现场 / 取本机的裁决与已生成工单、报告不受影响。
      </p>
    </template>
  </div>
</template>

<style scoped>
.title-sep {
  margin: 0 8px;
  color: #b0c2cc;
}

.guard-alert {
  margin-bottom: 14px;
}

.owner-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 14px;
}

.owner-input {
  width: 220px;
}

.reconcile-tabs {
  margin-bottom: 4px;
}

.footnote {
  margin-top: 10px;
  font-size: 12px;
}
</style>
