import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { createId, db, LS_KEYS } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Blade } from '@/types/blade'
import type { Turbine } from '@/types/turbine'
import {
  createEmptyBatchStats,
  type FieldBatch,
  type FieldBatchStats,
  type FieldRecord,
  type FieldRowInput,
  type ReconConflict
} from '@/types/fieldBatch'
import {
  buildLocalIndex,
  fingerprintOfRows,
  indexAddDefect,
  matchFieldRecord,
  sameDiffFields,
  sameSide,
  sideFromDefect,
  sideFromRow,
  type MatchOutcome
} from '@/utils/recon'

/** 写入 / 对账的分块大小：每块一个事务，中断后按进度续跑 */
const WRITE_CHUNK = 50
const RECON_CHUNK = 100

/** 对账页冲突行：冲突 + 现场记录 + 所属批次 */
export interface ConflictRow {
  conflict: ReconConflict
  record: FieldRecord | null
  batch: FieldBatch | null
}

/** 今天的日期（YYYY-MM-DD，本地时区） */
function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

/**
 * 批次对账 store：外委离线巡检表按批次导入，
 * 按「机组编号 + 叶片序号 + 分段区间 + 面位 + 类型 + 位置容差」与本机缺陷对账，
 * 尺寸 / 等级不一致时保留两版并生成待决冲突，由负责人逐条裁决。
 */
export const useReconStore = defineStore('recon', () => {
  const batchesTable = useIdbTable<FieldBatch>((database) => database.fieldBatches)
  const recordsTable = useIdbTable<FieldRecord>((database) => database.fieldRecords, {
    sortByUpdatedAt: false
  })
  const conflictsTable = useIdbTable<ReconConflict>((database) => database.reconConflicts)
  const defectsTable = useIdbTable<Defect>((database) => database.defects, { sortByUpdatedAt: false })
  const segmentsTable = useIdbTable<Segment>((database) => database.segments, { sortByUpdatedAt: false })
  const bladesTable = useIdbTable<Blade>((database) => database.blades, { sortByUpdatedAt: false })
  const turbinesTable = useIdbTable<Turbine>((database) => database.turbines, { sortByUpdatedAt: false })

  /** 导入 / 重跑进行中：期间暂停自动重算，避免读到中间态 */
  const busy = ref(false)
  /** 裁决负责人（记住上次填写） */
  const owner = ref<string>(localStorage.getItem(LS_KEYS.reconOwner) ?? '')

  const batches = computed<FieldBatch[]>(() => batchesTable.rows.value)
  const records = computed<FieldRecord[]>(() => recordsTable.rows.value)
  const conflicts = computed<ReconConflict[]>(() => conflictsTable.rows.value)
  const defects = computed<Defect[]>(() => defectsTable.rows.value)
  const segments = computed<Segment[]>(() => segmentsTable.rows.value)
  const blades = computed<Blade[]>(() => bladesTable.rows.value)
  const turbines = computed<Turbine[]>(() => turbinesTable.rows.value)

  const pendingConflicts = computed<ReconConflict[]>(() =>
    conflicts.value.filter((conflict) => conflict.status === 'pending')
  )
  const resolvedConflicts = computed<ReconConflict[]>(() =>
    conflicts.value.filter((conflict) => conflict.status !== 'pending')
  )
  const pendingConflictCount = computed(() => pendingConflicts.value.length)
  /** 有未决冲突的缺陷集合：派工入口据此拦截 */
  const pendingConflictDefectIds = computed<Set<string>>(
    () => new Set(pendingConflicts.value.map((conflict) => conflict.defectId))
  )

  /** 未决冲突行（关联现场记录与批次），对账页直接消费 */
  const pendingConflictRows = computed<ConflictRow[]>(() => {
    const recordMap = new Map(records.value.map((record) => [record.id, record]))
    const batchMap = new Map(batches.value.map((batch) => [batch.id, batch]))
    return pendingConflicts.value.map((conflict) => ({
      conflict,
      record: recordMap.get(conflict.recordId) ?? null,
      batch: batchMap.get(conflict.batchId) ?? null
    }))
  })

  function hasPendingConflict(defectId: string): boolean {
    return pendingConflictDefectIds.value.has(defectId)
  }

  function recordsOfBatch(batchId: string): FieldRecord[] {
    return records.value
      .filter((record) => record.batchId === batchId)
      .sort((a, b) => a.rowNo - b.rowNo)
  }

  function conflictsOfBatch(batchId: string): ReconConflict[] {
    return conflicts.value.filter((conflict) => conflict.batchId === batchId)
  }

  function conflictOfRecord(recordId: string): ReconConflict | undefined {
    return conflicts.value.find((conflict) => conflict.recordId === recordId)
  }

  function setOwner(name: string): void {
    owner.value = name
    localStorage.setItem(LS_KEYS.reconOwner, name)
  }

  /* ---------------- 写入（可断点续跑） ---------------- */

  /**
   * 分块写入现场记录：记录 id 由批次与行号确定性生成，
   * 中断后从 writtenRows 继续，重复写入不会产生新记录。
   */
  async function writeBatchRows(batchId: string): Promise<void> {
    const batch = await db.fieldBatches.get(batchId)
    if (!batch) return
    for (let offset = batch.writtenRows; offset < batch.rows.length; offset += WRITE_CHUNK) {
      const slice = batch.rows.slice(offset, offset + WRITE_CHUNK)
      const now = Date.now()
      const chunk: FieldRecord[] = slice.map((row, index) => ({
        ...row,
        id: `${batchId}:r${offset + index}`,
        batchId,
        rowNo: offset + index,
        matchStatus: 'unmatched',
        matchedDefectId: null,
        applied: false,
        reconciled: false,
        note: '',
        createdAt: now,
        updatedAt: now
      }))
      await db.transaction('rw', [db.fieldRecords, db.fieldBatches], async () => {
        await db.fieldRecords.bulkPut(chunk)
        await db.fieldBatches.update(batchId, {
          writtenRows: offset + chunk.length,
          updatedAt: Date.now()
        })
      })
    }
  }

  /* ---------------- 对账匹配 ---------------- */

  interface ReconcilePass {
    recordPuts: FieldRecord[]
    defectCreates: Defect[]
    conflictPuts: ReconConflict[]
    /** 重跑后不再是冲突的待决冲突 id（标记为自动消除） */
    conflictAutoIds: string[]
  }

  /**
   * 把一条记录的匹配结果落到内存清单（不写库）。
   * 「新增」会同步创建本机缺陷并占位，保证同批次后续记录判重。
   */
  function applyOutcome(
    record: FieldRecord,
    outcome: MatchOutcome,
    options: {
      now: number
      claimed: Map<string, string>
      createdIds: Set<string>
      existingConflict?: ReconConflict
      claimantRowNo?: Map<string, number>
    },
    pass: ReconcilePass
  ): void {
    const { now, claimed, createdIds, existingConflict, claimantRowNo } = options
    record.reconciled = true
    record.updatedAt = now

    if (outcome.kind === 'new') {
      const defectId = createId('dfc')
      const defect: Defect = {
        id: defectId,
        segmentId: outcome.segmentId,
        type: record.type,
        severity: record.severity,
        lengthMm: record.lengthMm,
        widthMm: record.widthMm,
        face: record.face,
        positionM: record.positionM,
        foundAt: record.foundAt || todayString(),
        state: '待处理',
        createdAt: now,
        updatedAt: now
      }
      pass.defectCreates.push(defect)
      createdIds.add(defectId)
      claimed.set(defectId, record.id)
      record.matchStatus = 'new'
      record.matchedDefectId = defectId
      record.applied = true
      record.note = ''
    } else if (outcome.kind === 'matched') {
      claimed.set(outcome.defect.id, record.id)
      record.matchStatus = 'matched'
      record.matchedDefectId = outcome.defect.id
      record.note = ''
    } else if (outcome.kind === 'conflict') {
      claimed.set(outcome.defect.id, record.id)
      record.matchStatus = 'conflict'
      record.matchedDefectId = outcome.defect.id
      record.note = ''
      pass.conflictPuts.push({
        id: `rc_${record.id}`,
        batchId: record.batchId,
        recordId: record.id,
        defectId: outcome.defect.id,
        diffFields: outcome.diffFields,
        fieldVersion: sideFromRow(record),
        localVersion: sideFromDefect(outcome.defect),
        status: 'pending',
        resolvedBy: '',
        resolvedAt: null,
        createdAt: existingConflict?.createdAt ?? now,
        updatedAt: now
      })
    } else if (outcome.kind === 'duplicate') {
      record.matchStatus = 'duplicate'
      record.matchedDefectId = outcome.defect.id
      const claimantNo =
        outcome.claimantRecordId !== null ? claimantRowNo?.get(outcome.claimantRecordId) : undefined
      record.note =
        claimantNo !== undefined
          ? `与第 ${claimantNo + 1} 行重复命中同一条缺陷`
          : '与本批次已新增的缺陷重复'
    } else {
      record.matchStatus = 'unmatched'
      record.matchedDefectId = null
      record.note = outcome.reason
    }

    // 重跑后不再是冲突：旧的待决冲突标记为自动消除
    if (outcome.kind !== 'conflict' && existingConflict && existingConflict.status === 'pending') {
      pass.conflictAutoIds.push(existingConflict.id)
    }
    pass.recordPuts.push(record)
  }

  /**
   * 对账：为批次内尚未对账的记录逐条匹配本机缺陷。
   * 命中且一致 → 不动；命中但尺寸 / 等级不一致 → 生成待决冲突（本机缺陷保持原值）；
   * 未命中 → 自动新增为本机缺陷。分块事务写入，中断后可重入续跑。
   */
  async function reconcileBatch(batchId: string): Promise<void> {
    const batch = await db.fieldBatches.get(batchId)
    if (!batch) return
    const [turbines, blades, segments, defects, batchRecords, batchConflicts] = await Promise.all([
      db.turbines.toArray(),
      db.blades.toArray(),
      db.segments.toArray(),
      db.defects.toArray(),
      db.fieldRecords.where('batchId').equals(batchId).toArray(),
      db.reconConflicts.where('batchId').equals(batchId).toArray()
    ])
    const index = buildLocalIndex(turbines, blades, segments, defects)
    const records = batchRecords.sort((a, b) => a.rowNo - b.rowNo)
    const conflictByRecord = new Map(batchConflicts.map((conflict) => [conflict.recordId, conflict]))
    const claimantRowNo = new Map(records.map((record) => [record.id, record.rowNo]))

    // 预占位：已完成对账的记录（断点续跑时保持「一条记录最多命中一条缺陷」）
    const claimed = new Map<string, string>()
    const createdIds = new Set<string>()
    records
      .filter((record) => record.reconciled)
      .forEach((record) => {
        if (
          record.matchedDefectId &&
          (record.matchStatus === 'matched' ||
            record.matchStatus === 'conflict' ||
            record.matchStatus === 'new')
        ) {
          claimed.set(record.matchedDefectId, record.id)
          if (record.matchStatus === 'new') createdIds.add(record.matchedDefectId)
        }
      })

    const todo = records.filter((record) => !record.reconciled)
    for (let offset = 0; offset < todo.length; offset += RECON_CHUNK) {
      const pass: ReconcilePass = { recordPuts: [], defectCreates: [], conflictPuts: [], conflictAutoIds: [] }
      const now = Date.now()
      for (const record of todo.slice(offset, offset + RECON_CHUNK)) {
        const outcome = matchFieldRecord(record, { index, toleranceM: batch.toleranceM, claimed, createdIds })
        applyOutcome(record, outcome, {
          now,
          claimed,
          createdIds,
          existingConflict: conflictByRecord.get(record.id),
          claimantRowNo
        }, pass)
        // 新增缺陷立即进索引，同批次后续记录可感知（判重）
        pass.defectCreates.forEach((defect) => {
          if (!index.defectsBySegment.get(defect.segmentId)?.some((item) => item.id === defect.id)) {
            indexAddDefect(index, defect)
          }
        })
      }
      await db.transaction('rw', [db.fieldRecords, db.reconConflicts, db.defects], async () => {
        if (pass.defectCreates.length > 0) await db.defects.bulkPut(pass.defectCreates)
        await db.fieldRecords.bulkPut(pass.recordPuts)
        if (pass.conflictPuts.length > 0) await db.reconConflicts.bulkPut(pass.conflictPuts)
        if (pass.conflictAutoIds.length > 0) {
          await db.reconConflicts
            .where('id')
            .anyOf(pass.conflictAutoIds)
            .modify({ status: 'auto', resolvedBy: '系统重算', resolvedAt: now, updatedAt: now })
        }
      })
    }
    await refreshBatchStats(batchId)
  }

  /** 重算批次统计与状态：仍在写入 → 写入中；有待决冲突 → 对账中；否则已结清 */
  async function refreshBatchStats(batchId: string): Promise<void> {
    const batch = await db.fieldBatches.get(batchId)
    if (!batch) return
    const writing = batch.writtenRows < batch.totalRows
    const batchRecords = await db.fieldRecords.where('batchId').equals(batchId).toArray()
    const stats: FieldBatchStats = createEmptyBatchStats()
    batchRecords.forEach((record) => {
      if (record.matchStatus === 'new') stats.added += 1
      else if (record.matchStatus === 'matched') stats.matched += 1
      else if (record.matchStatus === 'conflict') stats.conflict += 1
      else if (record.matchStatus === 'unmatched') stats.unmatched += 1
      else if (record.matchStatus === 'duplicate') stats.duplicate += 1
    })
    const pending = await db.reconConflicts
      .where('batchId')
      .equals(batchId)
      .filter((conflict) => conflict.status === 'pending')
      .count()
    await db.fieldBatches.update(batchId, {
      stats,
      status: writing ? 'importing' : pending > 0 ? 'reconciling' : 'done',
      updatedAt: Date.now()
    })
  }

  /* ---------------- 导入入口 ---------------- */

  /**
   * 导入巡检批次：内容指纹相同的批次直接返回已有批次（重复粘贴不新增记录）。
   * 写入与对账分块落库，中断后批次处于「写入中」，可继续。
   */
  async function importBatch(input: {
    name: string
    source: string
    toleranceM: number
    rows: FieldRowInput[]
  }): Promise<{ batch: FieldBatch; duplicated: boolean }> {
    const fingerprint = fingerprintOfRows(input.rows)
    const existing = await db.fieldBatches.where('fingerprint').equals(fingerprint).first()
    if (existing) return { batch: existing, duplicated: true }

    busy.value = true
    try {
      const id = createId('fb')
      const now = Date.now()
      await db.fieldBatches.put({
        id,
        name: input.name,
        source: input.source,
        fingerprint,
        toleranceM: input.toleranceM,
        status: 'importing',
        totalRows: input.rows.length,
        writtenRows: 0,
        rows: input.rows,
        stats: createEmptyBatchStats(),
        createdAt: now,
        updatedAt: now
      })
      await writeBatchRows(id)
      await reconcileBatch(id)
      const batch = (await db.fieldBatches.get(id)) as FieldBatch
      return { batch, duplicated: false }
    } finally {
      busy.value = false
    }
  }

  /** 继续中断的批次：按 writtenRows 续写，再续跑对账（已 reconciled 的记录自动跳过） */
  async function resumeBatch(batchId: string): Promise<void> {
    busy.value = true
    try {
      await writeBatchRows(batchId)
      await reconcileBatch(batchId)
    } finally {
      busy.value = false
    }
  }

  /**
   * 重新对账：把「未匹配」与「有待决冲突」的记录重置后重跑匹配。
   * 本机补齐机组 / 叶片 / 分段后，未匹配记录可借此重新落账。
   */
  async function reReconcileBatch(batchId: string): Promise<number> {
    const batchConflicts = await db.reconConflicts.where('batchId').equals(batchId).toArray()
    const pendingRecordIds = new Set(
      batchConflicts.filter((conflict) => conflict.status === 'pending').map((conflict) => conflict.recordId)
    )
    const batchRecords = await db.fieldRecords.where('batchId').equals(batchId).toArray()
    const resetIds = batchRecords
      .filter((record) => record.matchStatus === 'unmatched' || pendingRecordIds.has(record.id))
      .map((record) => record.id)
    if (resetIds.length === 0) return 0
    busy.value = true
    try {
      await db.fieldRecords
        .where('id')
        .anyOf(resetIds)
        .modify((record) => {
          record.reconciled = false
        })
      await reconcileBatch(batchId)
      return resetIds.length
    } finally {
      busy.value = false
    }
  }

  /** 删除批次及其现场记录与冲突；由批次自动新增的缺陷保留在本机标注中 */
  async function removeBatch(batchId: string): Promise<void> {
    await db.transaction('rw', [db.fieldBatches, db.fieldRecords, db.reconConflicts], async () => {
      await db.reconConflicts.where('batchId').equals(batchId).delete()
      await db.fieldRecords.where('batchId').equals(batchId).delete()
      await db.fieldBatches.delete(batchId)
    })
  }

  /* ---------------- 冲突裁决 ---------------- */

  /**
   * 裁决冲突：选本机值 → 本机缺陷不动；选现场值 → 把现场版的等级与尺寸写入本机缺陷。
   * 裁决后若同一缺陷还有其他未决冲突，由自动重算刷新。
   */
  async function resolveConflict(conflictId: string, choice: 'local' | 'field'): Promise<boolean> {
    const conflict = await db.reconConflicts.get(conflictId)
    if (!conflict || conflict.status !== 'pending') return false
    const ownerName = owner.value.trim() || '未署名'
    const now = Date.now()
    await db.transaction('rw', [db.reconConflicts, db.defects], async () => {
      if (choice === 'field') {
        await db.defects.update(conflict.defectId, {
          severity: conflict.fieldVersion.severity,
          lengthMm: conflict.fieldVersion.lengthMm,
          widthMm: conflict.fieldVersion.widthMm,
          updatedAt: now
        })
      }
      await db.reconConflicts.update(conflictId, {
        status: choice,
        resolvedBy: ownerName,
        resolvedAt: now,
        updatedAt: now
      })
    })
    await refreshBatchStats(conflict.batchId)
    return true
  }

  /* ---------------- 未决冲突自动重算 ---------------- */

  /**
   * 本机缺陷被修改后重算全部未决冲突：
   * 差异消失 → 冲突自动消除；命中关系或差异变化 → 刷新冲突的缺陷与两版快照。
   * 已裁决的冲突与已生成的工单 / 报告不受影响。
   */
  async function recomputePendingConflicts(): Promise<void> {
    const pendings = await db.reconConflicts.where('status').equals('pending').toArray()
    if (pendings.length === 0) return
    const [turbines, blades, segments, defects, allRecords, allBatches] = await Promise.all([
      db.turbines.toArray(),
      db.blades.toArray(),
      db.segments.toArray(),
      db.defects.toArray(),
      db.fieldRecords.toArray(),
      db.fieldBatches.toArray()
    ])
    const index = buildLocalIndex(turbines, blades, segments, defects)
    const recordMap = new Map(allRecords.map((record) => [record.id, record]))
    const batchMap = new Map(allBatches.map((batch) => [batch.id, batch]))
    const claimantRowNo = new Map(allRecords.map((record) => [record.id, record.rowNo]))

    // 全部已对账记录的命中占位（重算时让出被重算记录自己的位置）
    const claimed = new Map<string, string>()
    allRecords.forEach((record) => {
      if (
        record.reconciled &&
        record.matchedDefectId &&
        (record.matchStatus === 'matched' ||
          record.matchStatus === 'conflict' ||
          record.matchStatus === 'new')
      ) {
        claimed.set(record.matchedDefectId, record.id)
      }
    })

    const now = Date.now()
    const recordPuts: FieldRecord[] = []
    const conflictPuts: ReconConflict[] = []
    const affectedBatches = new Set<string>()

    for (const conflict of pendings) {
      const record = recordMap.get(conflict.recordId)
      const batch = batchMap.get(conflict.batchId)
      if (!record || !batch) {
        conflictPuts.push({ ...conflict, status: 'auto', resolvedBy: '系统重算', resolvedAt: now, updatedAt: now })
        continue
      }
      if (record.matchedDefectId && claimed.get(record.matchedDefectId) === record.id) {
        claimed.delete(record.matchedDefectId)
      }
      const outcome = matchFieldRecord(record, {
        index,
        toleranceM: batch.toleranceM,
        claimed,
        createdIds: new Set()
      })

      if (outcome.kind === 'conflict') {
        claimed.set(outcome.defect.id, record.id)
        const localVersion = sideFromDefect(outcome.defect)
        const changed =
          conflict.defectId !== outcome.defect.id ||
          !sameDiffFields(conflict.diffFields, outcome.diffFields) ||
          !sameSide(conflict.localVersion, localVersion)
        if (changed) {
          conflictPuts.push({
            ...conflict,
            defectId: outcome.defect.id,
            diffFields: outcome.diffFields,
            localVersion,
            updatedAt: now
          })
          affectedBatches.add(conflict.batchId)
        }
        if (record.matchStatus !== 'conflict' || record.matchedDefectId !== outcome.defect.id) {
          record.matchStatus = 'conflict'
          record.matchedDefectId = outcome.defect.id
          record.note = ''
          record.updatedAt = now
          recordPuts.push(record)
        }
        continue
      }

      // 重算后不再是冲突：冲突自动消除，记录落到新的对账结果
      conflictPuts.push({ ...conflict, status: 'auto', resolvedBy: '系统重算', resolvedAt: now, updatedAt: now })
      affectedBatches.add(conflict.batchId)
      if (outcome.kind === 'matched') {
        claimed.set(outcome.defect.id, record.id)
        record.matchStatus = 'matched'
        record.matchedDefectId = outcome.defect.id
        record.note = ''
      } else if (outcome.kind === 'duplicate') {
        record.matchStatus = 'duplicate'
        record.matchedDefectId = outcome.defect.id
        const claimantNo =
          outcome.claimantRecordId !== null ? claimantRowNo.get(outcome.claimantRecordId) : undefined
        record.note = claimantNo !== undefined ? `与第 ${claimantNo + 1} 行重复命中同一条缺陷` : '与本批次已新增的缺陷重复'
      } else {
        // new / unmatched：本机修改后不再命中，退回未匹配（不自动新增缺陷）
        record.matchStatus = 'unmatched'
        record.matchedDefectId = null
        record.note = outcome.kind === 'unmatched' ? outcome.reason : '本机缺陷修改后不再命中'
      }
      record.updatedAt = now
      recordPuts.push(record)
    }

    await db.transaction('rw', [db.fieldRecords, db.reconConflicts], async () => {
      if (recordPuts.length > 0) await db.fieldRecords.bulkPut(recordPuts)
      if (conflictPuts.length > 0) await db.reconConflicts.bulkPut(conflictPuts)
    })
    for (const batchId of affectedBatches) {
      await refreshBatchStats(batchId)
    }
  }

  // 本机数据（缺陷 / 分段 / 叶片 / 机组）变化后，延迟重算未决冲突；只写确有变化的部分，避免循环触发
  let recomputeTimer: number | undefined
  watch([defects, segments, blades, turbines], () => {
    if (busy.value || pendingConflicts.value.length === 0) return
    window.clearTimeout(recomputeTimer)
    recomputeTimer = window.setTimeout(() => {
      void recomputePendingConflicts()
    }, 300)
  })

  return {
    busy,
    owner,
    batches,
    records,
    conflicts,
    pendingConflicts,
    resolvedConflicts,
    pendingConflictCount,
    pendingConflictDefectIds,
    pendingConflictRows,
    hasPendingConflict,
    recordsOfBatch,
    conflictsOfBatch,
    conflictOfRecord,
    setOwner,
    importBatch,
    resumeBatch,
    reReconcileBatch,
    removeBatch,
    resolveConflict,
    recomputePendingConflicts
  }
})
