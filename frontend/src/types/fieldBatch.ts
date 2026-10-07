import type { DefectType, Severity } from '@/types/defect'
import type { SegmentFace } from '@/types/segment'

/**
 * 现场记录的一行（解析后的巡检表内容）。
 * 机组编号 + 叶片序号 + 分段区间 + 面位 + 类型 + 位置容差 共同构成对账匹配键。
 */
export interface FieldRowInput {
  /** 机组编号，如 WT-A01 */
  turbineCode: string
  /** 叶片序号，如 A / B / C */
  bladeSerial: string
  /** 分段区间起点（米） */
  segmentStartM: number
  /** 分段区间终点（米） */
  segmentEndM: number
  /** 面位 */
  face: SegmentFace
  /** 缺陷类型 */
  type: DefectType
  /** 严重程度 */
  severity: Severity
  /** 缺陷长度（毫米） */
  lengthMm: number
  /** 缺陷宽度（毫米） */
  widthMm: number
  /** 展向位置（米） */
  positionM: number
  /** 发现日期 YYYY-MM-DD，可空（落库时取当天） */
  foundAt: string
}

/** 批次状态：写入中（含中断）→ 对账中（有未决冲突）→ 已结清 */
export type FieldBatchStatus = 'importing' | 'reconciling' | 'done'

/** 批次对账统计：按现场记录的当前对账结果计数 */
export interface FieldBatchStats {
  /** 本机无对应缺陷，已新增 */
  added: number
  /** 命中且与本机一致 */
  matched: number
  /** 命中但尺寸 / 等级不一致（含已裁决） */
  conflict: number
  /** 机组 / 叶片 / 分段区间缺失，无法对账 */
  unmatched: number
  /** 批次内重复命中同一缺陷 */
  duplicate: number
}

/**
 * 外委巡检批次：一次粘贴导入的离线巡检表。
 * rows 保存解析后的原始行，写入中断后可按 writtenRows 续跑。
 */
export interface FieldBatch {
  id: string
  /** 批次名称 */
  name: string
  /** 来源（外委单位 / 说明） */
  source: string
  /** 内容指纹：重复粘贴同一批次时命中已有批次，不新增记录 */
  fingerprint: string
  /** 位置容差（米）：|现场位置 - 本机位置| ≤ 容差 才可能命中 */
  toleranceM: number
  status: FieldBatchStatus
  totalRows: number
  /** 已写入的现场记录数（断点续写进度） */
  writtenRows: number
  /** 解析后的原始行，断点续写与重新对账的依据 */
  rows: FieldRowInput[]
  stats: FieldBatchStats
  createdAt: number
  updatedAt: number
}

/** 现场记录的对账结果 */
export type FieldMatchStatus = 'new' | 'matched' | 'conflict' | 'unmatched' | 'duplicate'

/**
 * 现场记录：批次中的一行巡检结果。
 * id 由批次与行号确定性生成（批次:r行号），重复写入不产生新记录。
 */
export interface FieldRecord extends FieldRowInput {
  id: string
  batchId: string
  /** 在批次中的行号（从 0 开始） */
  rowNo: number
  matchStatus: FieldMatchStatus
  /** 命中的本机缺陷 id（new 时为新增的缺陷 id） */
  matchedDefectId: string | null
  /** 是否已落库为缺陷（仅 new 记录） */
  applied: boolean
  /** 是否已完成对账匹配（对账阶段断点续跑用） */
  reconciled: boolean
  /** 未匹配原因 / 重复说明 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 冲突字段：仅尺寸（长 / 宽）与等级参与裁决 */
export type ConflictField = 'severity' | 'lengthMm' | 'widthMm'

/** 冲突处置：待决 / 选本机值 / 选现场值 / 系统重算后自动消除 */
export type ReconConflictStatus = 'pending' | 'local' | 'field' | 'auto'

/** 冲突一侧的版本快照（展示两版用；本机侧随重算刷新） */
export interface ConflictSide {
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  face: SegmentFace
  positionM: number
  foundAt: string
}

/**
 * 对账冲突：一条现场记录命中一条本机缺陷，但尺寸或等级不一致。
 * 未决期间本机缺陷保持原值且不能生成工单；负责人逐条裁决。
 * id 由现场记录确定性生成（rc_记录id），一条记录最多一条未决冲突。
 */
export interface ReconConflict {
  id: string
  batchId: string
  recordId: string
  /** 当前命中的本机缺陷（本机修改后重算可能改指其他缺陷） */
  defectId: string
  diffFields: ConflictField[]
  /** 现场值（导入时定格） */
  fieldVersion: ConflictSide
  /** 本机值（重算时刷新） */
  localVersion: ConflictSide
  status: ReconConflictStatus
  /** 裁决负责人 */
  resolvedBy: string
  resolvedAt: number | null
  createdAt: number
  updatedAt: number
}

export const DEFAULT_TOLERANCE_M = 0.5
export const MIN_TOLERANCE_M = 0.1
export const MAX_TOLERANCE_M = 5

export const FIELD_BATCH_STATUS_LABEL: Record<FieldBatchStatus, string> = {
  importing: '写入中',
  reconciling: '对账中',
  done: '已结清'
}

export const FIELD_BATCH_STATUS_TAG: Record<FieldBatchStatus, 'info' | 'warning' | 'success'> = {
  importing: 'info',
  reconciling: 'warning',
  done: 'success'
}

export const MATCH_STATUS_LABEL: Record<FieldMatchStatus, string> = {
  new: '新增',
  matched: '一致',
  conflict: '冲突',
  unmatched: '未匹配',
  duplicate: '重复'
}

export const MATCH_STATUS_TAG: Record<FieldMatchStatus, 'success' | 'info' | 'warning' | 'danger'> = {
  new: 'success',
  matched: 'info',
  conflict: 'warning',
  unmatched: 'danger',
  duplicate: 'info'
}

export const CONFLICT_STATUS_LABEL: Record<ReconConflictStatus, string> = {
  pending: '待裁决',
  local: '已选本机值',
  field: '已选现场值',
  auto: '已自动消除'
}

export const CONFLICT_FIELD_LABEL: Record<ConflictField, string> = {
  severity: '等级',
  lengthMm: '长度',
  widthMm: '宽度'
}

export function createEmptyBatchStats(): FieldBatchStats {
  return { added: 0, matched: 0, conflict: 0, unmatched: 0, duplicate: 0 }
}
