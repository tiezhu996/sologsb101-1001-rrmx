import type { DefectType, Severity } from '@/types/defect'
import type { SegmentFace } from '@/types/segment'
import type { DefectSnapshot } from '@/types/workOrder'

/** 外委批次状态：写入中 → 对账中 → 对账完成 */
export type ImportBatchState = '写入中' | '对账中' | '对账完成'

/** 对账行状态：待匹配（已落位未配对）/ 已新增（现场记录派生出新缺陷）/ 一致 / 冲突待决 / 已决取本机 / 已决取现场 / 无法定位 / 已忽略 */
export type ReconcileLinkState =
  | '待匹配'
  | '已新增'
  | '一致'
  | '冲突待决'
  | '已决取本机'
  | '已决取现场'
  | '无法定位'
  | '已忽略'

/** 负责人逐条选择的版本 */
export type ConflictChoice = '本机' | '现场'

/** 有差异、需要负责人裁决的字段 */
export type ConflictField = 'severity' | 'lengthMm' | 'widthMm'

/** 落位失败原因 */
export type LocateReason = '机组不存在' | '叶片不存在' | '分段区间不存在'

/**
 * 外委批次：一次离线巡检表的导入与对账单元。
 * 同一批次重复粘贴不会新增记录（按 batchNo + 指纹去重）。
 */
export interface ImportBatch {
  id: string
  /** 批次编号（外委交回时填写），重复粘贴的判重依据之一 */
  batchNo: string
  /** 外委单位 / 班组，仅作记录 */
  vendor: string
  state: ImportBatchState
  /** 原始粘贴文本，写入中断后用于重试 */
  rawText: string
  fileName: string
  /** 解析出的现场记录总数 */
  totalRows: number
  /** 已写入 IndexedDB 的现场记录数（断点进度） */
  ingestedRows: number
  /** 判重跳过的记录数（本批次内重复或此前已导入） */
  duplicateRows: number
  /** 最近一次写入错误信息，为空表示正常 */
  lastError: string
  /** 位置容差（米），落段与缺陷配对共用 */
  positionToleranceM: number
  /** 分段区间容差（米）：现场起止米数与本机分段边界的允许偏差 */
  rangeToleranceM: number
  importedAt: number
  reconciledAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 现场缺陷记录：外委离线巡检表中的一行，落库后等待对账。
 */
export interface FieldDefectRow {
  id: string
  batchId: string
  /** 源文件中的行号（1 起，含表头偏移） */
  sourceLine: number
  /** 行内去重指纹：自然键 + 面位 + 类型 + 尺寸等级，用于「重复粘贴不新增」 */
  fingerprint: string

  /* ---- 自然键（机组编号 / 叶片序号 / 分段区间） ---- */
  turbineCode: string
  bladeSerial: string
  segmentStartM: number
  segmentEndM: number

  /* ---- 现场填报值 ---- */
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  face: SegmentFace
  positionM: number
  foundAt: string
  inspector: string

  createdAt: number
  updatedAt: number
}

/**
 * 对账关联：一条现场记录与一条本机缺陷（最多一条）的配对结果。
 */
export interface ReconcileLink {
  id: string
  batchId: string
  fieldRowId: string
  /** 命中的本机缺陷 id；待匹配 / 无法定位 / 已忽略时为空 */
  defectId: string | null
  state: ReconcileLinkState
  /** 无法定位原因 */
  locateReason: LocateReason | null
  /** 存在差异的字段，仅在「冲突待决」时非空 */
  differences: ConflictField[]
  /** 配对当时的现场值快照（两版留存的现场版） */
  fieldSnapshot: DefectSnapshot
  /** 配对当时的本机值快照（两版留存的本机版） */
  localSnapshot: DefectSnapshot | null
  /** 负责人（裁决时逐条记录） */
  owner: string
  /** 裁决结果 */
  resolution: ConflictChoice | null
  resolvedAt: number | null
  /** 现场记录派生出的缺陷是否为本次对账自动新增 */
  spawned: boolean
  createdAt: number
  updatedAt: number
}

/** 批次列表的默认位置 / 区间容差 */
export const DEFAULT_POSITION_TOLERANCE_M = 0.5
export const DEFAULT_RANGE_TOLERANCE_M = 0.1

export const IMPORT_BATCH_STATES: ImportBatchState[] = ['写入中', '对账中', '对账完成']
export const RECONCILE_LINK_STATES: ReconcileLinkState[] = [
  '待匹配',
  '已新增',
  '一致',
  '冲突待决',
  '已决取本机',
  '已决取现场',
  '无法定位',
  '已忽略'
]

/** 状态标签配色（用于批次 / 关联徽标） */
export const LINK_STATE_COLOR: Record<ReconcileLinkState, string> = {
  待匹配: '#8c8479',
  已新增: '#4a6fa5',
  一致: '#1e8449',
  冲突待决: '#c0392b',
  已决取本机: '#0f5c7a',
  已决取现场: '#7d3c98',
  无法定位: '#b9770e',
  已忽略: '#95a5a6'
}

export const BATCH_STATE_COLOR: Record<ImportBatchState, string> = {
  写入中: '#d68910',
  对账中: '#4a6fa5',
  对账完成: '#1e8449'
}

/** 仍属「未决」、会阻止整批完成与派工的关联状态 */
export const OPEN_LINK_STATES: ReconcileLinkState[] = ['待匹配', '冲突待决', '无法定位']

/** 已有明确归属（绑定了本机缺陷或已派生出缺陷）的关联状态 */
export const LINKED_STATES: ReconcileLinkState[] = [
  '已新增',
  '一致',
  '冲突待决',
  '已决取本机',
  '已决取现场'
]

export function isOpenLinkState(state: ReconcileLinkState): boolean {
  return OPEN_LINK_STATES.includes(state)
}

/** 现场记录的自然键指纹：决定「重复粘贴不新增」 */
export function fieldRowFingerprint(input: {
  turbineCode: string
  bladeSerial: string
  segmentStartM: number
  segmentEndM: number
  face: SegmentFace
  type: DefectType
  positionM: number
  severity: Severity
  lengthMm: number
  widthMm: number
}): string {
  const num = (value: number) => String(Math.round(value * 100) / 100)
  return [
    input.turbineCode.trim().toUpperCase(),
    input.bladeSerial.trim().toUpperCase(),
    num(input.segmentStartM),
    num(input.segmentEndM),
    input.face,
    input.type,
    num(input.positionM),
    input.severity,
    Math.round(input.lengthMm),
    Math.round(input.widthMm)
  ].join('|')
}
