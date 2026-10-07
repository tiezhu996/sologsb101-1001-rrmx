import type { Blade } from '@/types/blade'
import type { Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Turbine } from '@/types/turbine'
import type { DefectSnapshot } from '@/types/workOrder'
import type {
  ConflictField,
  FieldDefectRow,
  ImportBatch,
  LocateReason,
  ReconcileLink
} from '@/types/reconcile'

/** 现场记录落位结果 */
export interface LocatedRow {
  row: FieldDefectRow
  turbine: Turbine | null
  blade: Blade | null
  segment: Segment | null
  reason: LocateReason | null
}

/** 一条现场记录在本轮对账中的处置动作 */
export interface LinkAction {
  row: FieldDefectRow
  located: LocatedRow
  /** 复用已有未决关联（保留 id / 负责人留痕） */
  existing: ReconcileLink | null
  /** keep：落位失败但旧绑定缺陷仍存活，保留原关联不降级 */
  kind: 'spawn' | 'match' | 'unlocated' | 'keep'
  /** match / spawn 时命中或绑定的缺陷 */
  defect: Defect | null
  state: ReconcileLink['state']
  differences: ConflictField[]
  fieldSnapshot: DefectSnapshot
  localSnapshot: DefectSnapshot | null
}

export interface ReconcilePlan {
  batchId: string
  actions: LinkAction[]
  /** 本轮需要删除的失效关联 id（绑定的缺陷已删除等） */
  removedLinkIds: string[]
}

export interface ReconcileSource {
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
}

/** 从缺陷抽取关键字段快照 */
export function snapshotOfDefect(defect: Defect): DefectSnapshot {
  return {
    type: defect.type,
    severity: defect.severity,
    lengthMm: defect.lengthMm,
    widthMm: defect.widthMm,
    face: defect.face,
    positionM: defect.positionM
  }
}

export function snapshotOfFieldRow(row: FieldDefectRow): DefectSnapshot {
  return {
    type: row.type,
    severity: row.severity,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    face: row.face,
    positionM: row.positionM
  }
}

/** 比对两版的等级与尺寸，返回有差异的字段 */
export function diffSnapshots(field: DefectSnapshot, local: DefectSnapshot): ConflictField[] {
  const diffs: ConflictField[] = []
  if (field.severity !== local.severity) diffs.push('severity')
  if (Math.round(field.lengthMm) !== Math.round(local.lengthMm)) diffs.push('lengthMm')
  if (Math.round(field.widthMm) !== Math.round(local.widthMm)) diffs.push('widthMm')
  return diffs
}

/** 现场记录按自然键落位到 机组 → 叶片 → 分段 */
export function locateRow(
  row: FieldDefectRow,
  source: ReconcileSource,
  rangeToleranceM: number
): LocatedRow {
  const turbine =
    source.turbines.find((item) => item.code.trim().toUpperCase() === row.turbineCode.trim().toUpperCase()) ??
    null
  if (!turbine) return { row, turbine: null, blade: null, segment: null, reason: '机组不存在' }

  const blade =
    source.blades.find(
      (item) =>
        item.turbineId === turbine.id && item.serial.trim().toUpperCase() === row.bladeSerial.trim().toUpperCase()
    ) ?? null
  if (!blade) return { row, turbine, blade: null, segment: null, reason: '叶片不存在' }

  const bladeSegments = source.segments.filter((item) => item.bladeId === blade.id)
  // 优先精确匹配分段序号区间（容差内），其次取包含现场位置的分段
  const withinRange = bladeSegments
    .filter(
      (segment) =>
        Math.abs(segment.startM - row.segmentStartM) <= rangeToleranceM &&
        Math.abs(segment.endM - row.segmentEndM) <= rangeToleranceM
    )
    .sort((a, b) => a.index - b.index)
  const containing = bladeSegments.filter(
    (segment) => row.positionM >= segment.startM - rangeToleranceM && row.positionM <= segment.endM + rangeToleranceM
  )
  const segment = withinRange[0] ?? containing.sort((a, b) => a.index - b.index)[0] ?? null
  if (!segment) return { row, turbine, blade, segment: null, reason: '分段区间不存在' }

  return { row, turbine, blade, segment, reason: null }
}

interface ReconcileOptions {
  /** 位置容差（米） */
  positionToleranceM: number
  rangeToleranceM: number
  /**
   * true：只重算未决关联（本机缺陷后来修改时调用）；
   * false：整批重新对账（手工触发 / 初次对账）。
   */
  pendingOnly: boolean
}

/**
 * 构造批次对账计划（纯函数，不落库）：
 * 保证一条现场记录最多命中一条缺陷、一条缺陷最多被一条现场记录占用。
 */
export function buildReconcilePlan(
  batch: ImportBatch,
  fieldRows: FieldDefectRow[],
  links: ReconcileLink[],
  source: ReconcileSource,
  options: ReconcileOptions
): ReconcilePlan {
  const openLinks = links.filter((link) => link.batchId === batch.id)
  const rowById = new Map(fieldRows.map((row) => [row.id, row]))

  // 已决关联不参与重算，其绑定的缺陷视为被占用；未决关联按现场行索引
  // 已决 / 已忽略关联不参与重算，其绑定的缺陷视为被占用；
  // 未决关联的旧绑定在逐行处理时按「是否属于本行」区分，避免未决行互相误占。
  const lockedDefectIds = new Set<string>()
  const openLinkByRow = new Map<string, ReconcileLink>()
  openLinks.forEach((link) => {
    if (['已决取本机', '已决取现场', '已忽略'].includes(link.state)) {
      if (link.defectId) lockedDefectIds.add(link.defectId)
    } else {
      openLinkByRow.set(link.fieldRowId, link)
    }
  })

  const actions: LinkAction[] = []
  const removedLinkIds: string[] = []
  const occupiedDefectIds = new Set<string>(lockedDefectIds)

  const candidateRows = fieldRows.filter((row) => {
    if (!options.pendingOnly) return true
    const link = openLinkByRow.get(row.id)
    return !!link
  })

  // 稳定顺序：机组 → 叶片 → 分段 → 位置，保证同一输入重复对账结果一致
  const sortedRows = [...candidateRows].sort((a, b) => {
    const key = (row: FieldDefectRow) =>
      `${row.turbineCode}|${row.bladeSerial}|${row.segmentStartM}|${row.positionM}|${row.sourceLine}`
    return key(a).localeCompare(key(b))
  })

  sortedRows.forEach((row) => {
    const located = locateRow(row, source, options.rangeToleranceM)
    const existing = openLinkByRow.get(row.id) ?? null
    const fieldSnapshot = snapshotOfFieldRow(row)

    // 落位失败：旧绑定缺陷仍存活则保留关联（不降级），否则置为无法定位
    if (!located.segment || located.reason) {
      const boundAlive =
        existing?.defectId && source.defects.some((defect) => defect.id === existing.defectId)
      if (boundAlive) {
        actions.push({
          row,
          located,
          existing,
          kind: 'keep',
          defect: source.defects.find((defect) => defect.id === existing?.defectId) ?? null,
          state: existing ? existing.state : '待匹配',
          differences: [],
          fieldSnapshot,
          localSnapshot: existing?.localSnapshot ?? null
        })
      } else {
        actions.push({
          row,
          located,
          existing,
          kind: 'unlocated',
          defect: null,
          state: '无法定位',
          differences: [],
          fieldSnapshot,
          localSnapshot: null
        })
        if (existing?.defectId) removedLinkIds.push(existing.id)
      }
      return
    }

    // 本行旧绑定（即便在同段也允许重新命中）；其他未决行的旧绑定视为已占用
    const otherOpenDefectIds = new Set<string>()
    openLinkByRow.forEach((link, fieldRowId) => {
      if (fieldRowId !== row.id && link.defectId && link.state !== '无法定位') {
        otherOpenDefectIds.add(link.defectId)
      }
    })

    const sameBucket = source.defects.filter(
      (defect) =>
        defect.segmentId === located.segment?.id &&
        defect.face === row.face &&
        defect.type === row.type &&
        !occupiedDefectIds.has(defect.id) &&
        !otherOpenDefectIds.has(defect.id)
    )

    // 旧关联绑定的缺陷优先保留（本行自己的绑定），只要还在同一落位分段内
    const rebound =
      existing?.defectId
        ? source.defects.find((defect) => defect.id === existing.defectId) ?? null
        : null
    const selfBound =
      rebound?.segmentId === located.segment?.id &&
      rebound.face === row.face &&
      rebound.type === row.type
        ? rebound
        : null

    const withinTolerance = sameBucket
      .filter((defect) => Math.abs(defect.positionM - row.positionM) <= options.positionToleranceM)
      .sort((a, b) => {
        const distance = (defect: Defect) => Math.abs(defect.positionM - row.positionM)
        if (distance(a) !== distance(b)) return distance(a) - distance(b)
        return a.createdAt - b.createdAt
      })

    // 本行旧绑定在位置容差内时优先沿用；否则按最近距离唯一配对
    const selfInTolerance =
      selfBound && Math.abs(selfBound.positionM - row.positionM) <= options.positionToleranceM
        ? selfBound
        : null
    const matched = selfInTolerance ?? withinTolerance[0] ?? null

    if (!matched) {
      // 无命中：派生新缺陷（只在尚无关联或旧关联未绑定存活缺陷时）
      actions.push({
        row,
        located,
        existing,
        kind: 'spawn',
        defect: null,
        state: '已新增',
        differences: [],
        fieldSnapshot,
        localSnapshot: null
      })
      if (existing?.defectId && !source.defects.some((defect) => defect.id === existing.defectId)) {
        removedLinkIds.push(existing.id)
      }
      return
    }

    occupiedDefectIds.add(matched.id)
    const localSnapshot = snapshotOfDefect(matched)
    const differences = diffSnapshots(fieldSnapshot, localSnapshot)
    actions.push({
      row,
      located,
      existing,
      kind: 'match',
      defect: matched,
      state: differences.length > 0 ? '冲突待决' : '一致',
      differences,
      fieldSnapshot,
      localSnapshot
    })
  })

  // 清理现场记录已不存在的悬空关联
  openLinks.forEach((link) => {
    if (!rowById.has(link.fieldRowId)) removedLinkIds.push(link.id)
  })

  return { batchId: batch.id, actions, removedLinkIds: Array.from(new Set(removedLinkIds)) }
}
