<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, Upload } from '@element-plus/icons-vue'
import {
  DEFAULT_POSITION_TOLERANCE_M,
  DEFAULT_RANGE_TOLERANCE_M
} from '@/types/reconcile'
import {
  INSPECTION_TEMPLATE_TSV,
  parseInspectionSheet
} from '@/utils/inspectionSheet'
import { readFileText } from '@/utils/export'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (
    event: 'submit',
    payload: {
      batchNo: string
      vendor: string
      fileName: string
      rawText: string
      positionToleranceM: number
      rangeToleranceM: number
    }
  ): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

const batchNo = ref('')
const vendor = ref('')
const fileName = ref('')
const rawText = ref('')
const positionToleranceM = ref(DEFAULT_POSITION_TOLERANCE_M)
const rangeToleranceM = ref(DEFAULT_RANGE_TOLERANCE_M)
const submitting = ref(false)

const preview = computed(() => parseInspectionSheet(rawText.value))

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      batchNo.value = `WW-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-`
      vendor.value = ''
      fileName.value = ''
      rawText.value = ''
      positionToleranceM.value = DEFAULT_POSITION_TOLERANCE_M
      rangeToleranceM.value = DEFAULT_RANGE_TOLERANCE_M
      submitting.value = false
    }
  }
)

async function handleFile(file: { raw?: File }): Promise<void> {
  const raw = file.raw
  if (!raw) return
  fileName.value = raw.name
  rawText.value = await readFileText(raw)
  if (!batchNo.value) {
    const stem = raw.name.replace(/\.[^.]+$/, '')
    batchNo.value = stem.slice(0, 40)
  }
}

function pasteSample(): void {
  rawText.value = INSPECTION_TEMPLATE_TSV
  if (!fileName.value) fileName.value = '离线巡检表模板.tsv'
}

function downloadTemplate(): void {
  const blob = new Blob([INSPECTION_TEMPLATE_TSV], { type: 'text/tab-separated-values;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '外委离线巡检表模板.tsv'
  anchor.click()
  URL.revokeObjectURL(url)
}

const canSubmit = computed(
  () =>
    batchNo.value.trim().length > 0 &&
    rawText.value.trim().length > 0 &&
    preview.value.rows.length > 0
)

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    ElMessage.warning('请填写批次编号并粘贴至少一行可解析的现场记录')
    return
  }
  submitting.value = true
  try {
    emit('submit', {
      batchNo: batchNo.value.trim(),
      vendor: vendor.value.trim(),
      fileName: fileName.value || `${batchNo.value.trim()}.tsv`,
      rawText: rawText.value,
      positionToleranceM: positionToleranceM.value,
      rangeToleranceM: rangeToleranceM.value
    })
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="dialogVisible" title="导入外委离线巡检表" width="820px" destroy-on-close>
    <el-form label-width="110px">
      <el-form-item label="批次编号" required>
        <el-input v-model="batchNo" placeholder="如 WW-202610-07，重复粘贴同编号批次不新增记录" clearable />
      </el-form-item>
      <el-form-item label="外委单位">
        <el-input v-model="vendor" placeholder="如 外委检修一队（仅记录）" clearable />
      </el-form-item>
      <el-form-item label="巡检表文件">
        <el-upload :auto-upload="false" :show-file-list="false" accept=".tsv,.csv,.txt" :on-change="handleFile">
          <el-button :icon="Upload">选择 TSV / CSV</el-button>
        </el-upload>
        <span v-if="fileName" class="muted file-name">{{ fileName }}</span>
        <el-button link type="primary" @click="downloadTemplate">
          <el-icon><Document /></el-icon> 下载模板
        </el-button>
      </el-form-item>
      <el-form-item label="位置容差">
        <el-input-number v-model="positionToleranceM" :min="0" :max="10" :step="0.1" :precision="2" />
        <span class="muted unit">米</span>
        <span class="muted">现场与本机位置差在此范围内才算同一条缺陷</span>
      </el-form-item>
      <el-form-item label="分段区间容差">
        <el-input-number v-model="rangeToleranceM" :min="0" :max="5" :step="0.1" :precision="2" />
        <span class="muted unit">米</span>
        <span class="muted">分段起止米数的允许偏差</span>
      </el-form-item>
      <el-form-item label="现场记录" required>
        <el-input
          v-model="rawText"
          type="textarea"
          :rows="9"
          placeholder="把外委交回的离线巡检表（含表头）整段粘贴到这里，支持从 Excel 直接复制（Tab 分隔）或 CSV。"
          class="raw-input"
        />
      </el-form-item>
    </el-form>

    <div v-if="rawText.trim()" class="preview">
      <el-alert
        v-if="preview.rows.length > 0"
        type="success"
        :closable="false"
        show-icon
        :title="`可导入 ${preview.rows.length} 条现场记录${preview.duplicateLines.length > 0 ? `，批次内重复 ${preview.duplicateLines.length} 条将跳过` : ''}`"
      />
      <el-alert
        v-if="preview.errors.length > 0"
        type="error"
        :closable="false"
        show-icon
        :title="`${preview.errors.length} 行无法解析，将被跳过：`"
        class="preview-alert"
      >
        <ul class="error-list">
          <li v-for="error in preview.errors.slice(0, 6)" :key="error.line">
            第 {{ error.line }} 行：{{ error.message }}
          </li>
          <li v-if="preview.errors.length > 6">…等共 {{ preview.errors.length }} 行</li>
        </ul>
      </el-alert>
      <el-button v-if="preview.rows.length === 0" link type="primary" @click="pasteSample">
        填入模板示例试一下
      </el-button>
    </div>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
        开始导入并对账
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.unit {
  margin: 0 8px;
  font-size: 12px;
}

.file-name {
  margin: 0 10px;
}

.raw-input :deep(textarea) {
  font-family: monospace;
  font-size: 12px;
}

.preview {
  margin: -6px 0 0 110px;
}

.preview-alert {
  margin-top: 8px;
}

.error-list {
  margin: 4px 0 0;
  padding-left: 18px;
  max-height: 120px;
  overflow: auto;
}
</style>
