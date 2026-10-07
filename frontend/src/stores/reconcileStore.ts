import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { Defect } from '@/types/defect'
import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Turbine } from '@/types/turbine'
import {
  DEFAULT_POSITION_TOLERANCE_M,
  DEFAULT_RANGE_TOLERANCE_M,
  isOpenLinkState,
  type ConflictChoice,
  type FieldDefectRow,
  type ImportBatch,
  type ReconcileLink,
  type ReconcileLinkState
} from '@/types/reconcile'
import { parseInspectionSheet, type ParsedFieldRow } from '@/utils/inspectionSheet'
import { buildReconcilePlan, type ReconcilePlan } from '@/utils/reconcile'

/** 展开后的关联行：关联 + 现场记录 + 命中缺陷 + 落位信息 */
export interface ReconcileRowView {
  link: ReconcileLink
  fieldRow: FieldDefectRow | null
  defect: Defect | null
  segment: Segment | null
  blade: Blade | null
  turbine: Turbine | null
}

export interface BatchSummary {
  total: number
  conflict: number
  consistent: number
  spawned: number
  unlocated: number
  resolved: number
  ignored: number
  pending: number
}

export interface CreateBatchInput {
  batchNo: string
  vendor: string
  fileName: string
  rawText: string
  positionToleranceM?: number
  rangeToleranceM?: number
}

export interface CreateBatchResult {
  batchId: string | null
  added: number
  duplicated: number
  errors: Array<{ line: number; message: string }>
}

const INGEST_CHUNK = 50

function emptySummary(): BatchSummary {
  return { total: 0, conflict: 0, consistent: 0, spawned: 0, unlocated: 0, resolved: 0, ignored: 0, pending: 0 }
}

/** 现场解析行 → 待入库记录 */
function toFieldRow(parsed: ParsedFieldRow, batchId: string, now: number): FieldDefectRow {
  return {
    id: createId('fld'),
    batchId,
    sourceLine: parsed.sourceLine,
    fingerprint: parsed.fingerprint,
    turbineCode: parsed.turbineCode,
    bladeSerial: parsed.bladeSerial,
    segmentStartM: parsed.segmentStartM,
    segmentEndM: parsed.segmentEndM,
    type: parsed.type,
    severity: parsed.severity,
    lengthMm: parsed.lengthMm,
    widthMm: parsed.widthMm,
    face: parsed.face,
    positionM: parsed.positionM,
    foundAt: parsed.foundAt,
    inspector: parsed.inspector,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 外委批次对账 store：批次导入（断点续传 + 判重）、对账计划落库、
 * 负责人逐条裁决，以及本机缺陷修改后的未决冲突重算。
 */
export const useReconcileStore = defineStore('reconcile', () => {
  const batchesTable = useIdbTable<ImportBatch>((database) => database.importBatches)
  const rowsTable = useIdbTable<FieldDefectRow>((database) => database.fieldDefectRows, {
    sortByUpdatedAt: false
  })
  const linksTable = useIdbTable<ReconcileLink>((database) => database.reconcileLinks)
  const defectsTable = useIdbTable<Defect>((database) => database.defects, { sortByUpdatedAt: false })
  const segmentsTable = useIdbTable<Segment>((database) => database.segments, { sortByUpdatedAt: false })
  const bladesTable = useIdbTable<Blade>((database) => database.blades, { sortByUpdatedAt: false })
  const turbinesTable = useIdbTable<Turbine>((database) => database.turbines, { sortByUpdatedAt: false })

  /** 正在写入的批次互斥锁，避免「重试」与自动续传并发 */
  const runningBatches = new Map<string, Promise<void>>()
  const ingestProgress = ref<Record<string, number>>({})

  const batches = computed<ImportBatch[]>(() =>
    [...batchesTable.rows.value].sort((a, b) => b.importedAt - a.importedAt)
  )
  const fieldRows = computed<FieldDefectRow[]>(() => rowsTable.rows.value)
  const links = computed<ReconcileLink[]>(() => linksTable.rows.value)
  const defects = computed<Defect[]>(() => defectsTable.rows.value)
  const loading = computed(() => batchesTable.loading.value)
  const ready = computed(() => batchesTable.ready.value)

  function batchById(id: string): ImportBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  function rowsOfBatch(batchId: string): FieldDefectRow[] {
    return fieldRows.value
      .filter((row) => row.batchId === batchId)
      .sort((a, b) => a.sourceLine - b.sourceLine)
  }

  function linksOfBatch(batchId: string): ReconcileLink[] {
    return links.value.filter((link) => link.batchId === batchId)
  }

  function linkOfFieldRow(fieldRowId: string): ReconcileLink | undefined {
    return links.value.find((link) => link.fieldRowId === fieldRowId)
  }

  /** 展开关联行（附带现场记录、缺陷与机组归属） */
  function viewsOfBatch(batchId: string): ReconcileRowView[] {
    const rows = rowsOfBatch(batchId)
    const batchLinks = linksOfBatch(batchId)
    const rowMap = new Map(rows.map((row) => [row.id, row]))
    const segmentMap = new Map(segmentsTable.rows.value.map((segment) => [segment.id, segment]))
    const bladeMap = new Map(bladesTable.rows.value.map((blade) => [blade.id, blade]))
    const turbineMap = new Map(turbinesTable.rows.value.map((turbine) => [turbine.id, turbine]))
    return batchLinks
      .map((link) => {
        const fieldRow = rowMap.get(link.fieldRowId) ?? null
        const defect = defects.value.find((item) => item.id === link.defectId) ?? null
        const segment = defect ? segmentMap.get(defect.segmentId) ?? null : null
        const blade = segment ? bladeMap.get(segment.bladeId) ?? null : null
        const turbine = blade ? turbineMap.get(blade.turbineId) ?? null : null
        return { link, fieldRow, defect, segment, blade, turbine }
      })
      .sort((a, b) => (a.fieldRow?.sourceLine ?? 0) - (b.fieldRow?.sourceLine ?? 0))
  }

  function summarize(batchId: string): BatchSummary {
    const summary = emptySummary()
    summary.total = rowsOfBatch(batchId).length
    linksOfBatch(batchId).forEach((link) => {
      switch (link.state) {
        case '冲突待决':
        case '待匹配':
          summary.conflict += 1
          break
        case '一致':
          summary.consistent += 1
          break
        case '已新增':
          summary.spawned += 1
          break
        case '无法定位':
          summary.unlocated += 1
          break
        case '已决取本机':
        case '已决取现场':
          summary.resolved += 1
          break
        case '已忽略':
          summary.ignored += 1
          break
      }
    })
    summary.pending = linksOfBatch(batchId).filter((link) => isOpenLinkState(link.state)).length
    return summary
  }

  /** 存在未决冲突的缺陷 id（派工前必须全部裁决） */
  const pendingConflictDefectIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    links.value.forEach((link) => {
      if (link.state === '冲突待决' && link.defectId) ids.add(link.defectId)
    })
    return ids
  })

  const pendingConflictCount = computed(() => pendingConflictDefectIds.value.size)

  function defectHasPendingConflict(defectId: string): boolean {
    return pendingConflictDefectIds.value.has(defectId)
  }

  /* ---------------- 导入与断点续传 ---------------- */

  /**
   * 建立批次并解析文本：同一批次（batchNo + 指纹）重复粘贴不新增记录。
   * 仅落库批次头与 rawText，现场记录由 ingestBatch 分块写入（可中断重试）。
   */
  async function createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
    const parsed = parseInspectionSheet(input.rawText)
    if (parsed.rows.length === 0) {
      return { batchId: null, added: 0, duplicated: parsed.duplicateLines.length, errors: parsed.errors }
    }

    // 同批次编号下已入库指纹：重复粘贴的行不再新增
    const sameNoBatches = batches.value
      .filter((batch) => batch.batchNo.trim().toUpperCase() === input.batchNo.trim().toUpperCase())
      .map((batch) => batch.id)
    const existingFingerprints = new Set(
      fieldRows.value
        .filter((row) => sameNoBatches.includes(row.batchId))
        .map((row) => row.fingerprint)
    )
    const fresh = parsed.rows.filter((row) => !existingFingerprints.has(row.fingerprint))

    // 全部为重复行：直接定位到已有批次，不新建
    if (fresh.length === 0 && sameNoBatches.length > 0) {
      return { batchId: sameNoBatches[0], added: 0, duplicated: parsed.rows.length, errors: [] }
    }

    const now = Date.now()
    const batchId = createId('batch')
    const batch: ImportBatch = {
      id: batchId,
      batchNo: input.batchNo.trim(),
      vendor: input.vendor.trim(),
      state: '写入中',
      rawText: input.rawText,
      fileName: input.fileName,
      totalRows: parsed.rows.length,
      ingestedRows: 0,
      duplicateRows: parsed.rows.length - fresh.length,
      lastError: '',
      positionToleranceM: input.positionToleranceM ?? DEFAULT_POSITION_TOLERANCE_M,
      rangeToleranceM: input.rangeToleranceM ?? DEFAULT_RANGE_TOLERANCE_M,
      importedAt: now,
      reconciledAt: null,
      createdAt: now,
      updatedAt: now
    }
    // 暂存解析结果：挂在 rawText 上即可重放，这里把 fresh 指纹序列化进 rawText 不必要——
    // 直接在首批写入时落库，中断后依据已落库指纹续传。
    await db.importBatches.put(batch)

    // 先把首批记录写入（保证批次非空且可续传），后续分块异步进行
    await ingestBatch(batchId, fresh)
    return {
      batchId,
      added: fresh.length,
      duplicated: parsed.rows.length - fresh.length,
      errors: parsed.errors
    }
  }

  /**
   * 分块写入现场记录。ingestBatch 可重入：已入库指纹自动跳过，
   * 写入中断后保留 ingestedRows 进度，再次调用从断点继续。
   */
  async function ingestBatch(batchId: string, preParsed?: ParsedFieldRow[]): Promise<void> {
    const existingRun = runningBatches.get(batchId)
    if (existingRun) return existingRun

    const run = (async () => {
      const batch = await db.importBatches.get(batchId)
      if (!batch) return
      const parsed = preParsed ?? parseInspectionSheet(batch.rawText).rows
      const stored = await db.fieldDefectRows.where('batchId').equals(batchId).toArray()
      const storedPrints = new Set(stored.map((row) => row.fingerprint))
      const pending = parsed.filter((row) => !storedPrints.has(row.fingerprint))

      ingestProgress.value[batchId] = stored.length
      try {
        for (let start = 0; start < pending.length; start += INGEST_CHUNK) {
          const chunk = pending.slice(start, start + INGEST_CHUNK)
          const now = Date.now()
          const records = chunk.map((row) => toFieldRow(row, batchId, now))
          // 每块独立事务：中断只丢最后一块，前面的进度全部保留
          await db.fieldDefectRows.bulkPut(records)
          const done = Math.min(stored.length + start + chunk.length, batch.totalRows)
          await db.importBatches.update(batchId, { ingestedRows: done, lastError: '', updatedAt: Date.now() })
          ingestProgress.value[batchId] = done
          // 让出主线程，大文件粘贴时界面进度可刷新
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        await db.importBatches.update(batchId, {
          state: '对账中',
          ingestedRows: batch.totalRows,
          lastError: '',
          updatedAt: Date.now()
        })
        await runReconcile(batchId, false)
      } catch (error) {
        await db.importBatches.update(batchId, {
          state: '写入中',
          lastError: error instanceof Error ? error.message : '写入中断，可重试',
          updatedAt: Date.now()
        })
        throw error
      } finally {
        runningBatches.delete(batchId)
      }
    })()

    runningBatches.set(batchId, run)
    return run
  }

  /** 启动时恢复所有「写入中」的批次 */
  async function resumeInterrupted(): Promise<void> {
    const pending = await db.importBatches.filter((batch) => batch.state === '写入中').toArray()
    await Promise.all(pending.map((batch) => ingestBatch(batch.id).catch(() => undefined)))
  }

  /* ---------------- 对账计划落库 ---------------- */

  async function loadReconcileSource() {
    const [turbines, blades, segments, allDefects] = await Promise.all([
      db.turbines.toArray(),
      db.blades.toArray(),
      db.segments.toArray(),
      db.defects.toArray()
    ])
    return { turbines, blades, segments, defects: allDefects }
  }

  /**
   * 执行对账：构造计划并在一个事务内落地（新缺陷 / 关联两版留存）。
   * pendingOnly=true 时仅重算未决关联（本机缺陷修改后调用）。
   */
  async function runReconcile(batchId: string, pendingOnly: boolean): Promise<void> {
    const batch = await db.importBatches.get(batchId)
    if (!batch) return
    const [fieldRowsAll, linksAll, source, orders] = await Promise.all([
      db.fieldDefectRows.where('batchId').equals(batchId).toArray(),
      db.reconcileLinks.where('batchId').equals(batchId).toArray(),
      loadReconcileSource(),
      db.workOrders.toArray()
    ])

    const plan: ReconcilePlan = buildReconcilePlan(batch, fieldRowsAll, linksAll, source, {
      positionToleranceM: batch.positionToleranceM,
      rangeToleranceM: batch.rangeToleranceM,
      pendingOnly
    })

    const now = Date.now()
    await db.transaction(
      'rw',
      [db.defects, db.workOrders, db.reconcileLinks, db.importBatches],
      async () => {
        const newDefects: Defect[] = []
        const upsertLinks: ReconcileLink[] = []
        const obsoleteSpawnedIds = new Set<string>()

        for (const action of plan.actions) {
          const existing = action.existing
          if (action.kind === 'keep') continue

          if (action.kind === 'unlocated') {
            if (existing) {
              // 旧绑定缺陷仍在的情况已走 keep；此处绑定已失效，退回无法定位并解绑
              upsertLinks.push({
                ...existing,
                defectId: null,
                state: '无法定位',
                locateReason: action.located.reason,
                differences: [],
                localSnapshot: null,
                resolution: null,
                resolvedAt: null,
                updatedAt: now
              })
            } else {
              upsertLinks.push({
                id: createId('lnk'),
                batchId,
                fieldRowId: action.row.id,
                defectId: null,
                state: '无法定位',
                locateReason: action.located.reason,
                differences: [],
                fieldSnapshot: action.fieldSnapshot,
                localSnapshot: null,
                owner: '',
                resolution: null,
                resolvedAt: null,
                spawned: false,
                createdAt: now,
                updatedAt: now
              })
            }
            continue
          }

          if (action.kind === 'spawn') {
            const segment = action.located.segment
            if (!segment) continue
            // 旧绑定若是无工单的自动新增缺陷，先回收，避免重复
            if (existing?.spawned && existing.defectId) {
              const hasOrder = orders.some((order) => order.defectId === existing.defectId)
              if (!hasOrder) obsoleteSpawnedIds.add(existing.defectId)
            }
            const defectId = createId('dfc')
            newDefects.push({
              id: defectId,
              segmentId: segment.id,
              type: action.row.type,
              severity: action.row.severity,
              lengthMm: action.row.lengthMm,
              widthMm: action.row.widthMm,
              face: action.row.face,
              positionM: action.row.positionM,
              foundAt: action.row.foundAt,
              state: '待处理',
              sourceBatchId: batchId,
              sourceFieldRowId: action.row.id,
              createdAt: now,
              updatedAt: now
            })
            upsertLinks.push({
              id: existing?.id ?? createId('lnk'),
              batchId,
              fieldRowId: action.row.id,
              defectId,
              state: '已新增',
              locateReason: null,
              differences: [],
              fieldSnapshot: action.fieldSnapshot,
              localSnapshot: action.localSnapshot,
              owner: existing?.owner ?? '',
              resolution: null,
              resolvedAt: null,
              spawned: true,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now
            })
            continue
          }

          // match：命中本机缺陷，按差异决定一致 / 冲突待决，两版都留存
          const defect = action.defect
          if (!defect) continue
          if (existing?.spawned && existing.defectId && existing.defectId !== defect.id) {
            const hasOrder = orders.some((order) => order.defectId === existing.defectId)
            if (!hasOrder) obsoleteSpawnedIds.add(existing.defectId)
          }
          const nextState: ReconcileLinkState = action.differences.length > 0 ? '冲突待决' : '一致'
          upsertLinks.push({
            id: existing?.id ?? createId('lnk'),
            batchId,
            fieldRowId: action.row.id,
            defectId: defect.id,
            state: nextState,
            locateReason: null,
            differences: action.differences,
            fieldSnapshot: action.fieldSnapshot,
            localSnapshot: action.localSnapshot,
            // 重算后若差异消失（本机已改成现场值），自动撤销旧裁决
            owner: nextState === '一致' ? '' : existing?.owner ?? '',
            resolution: nextState === '一致' ? null : existing?.resolution ?? null,
            resolvedAt: nextState === '一致' ? null : existing?.resolvedAt ?? null,
            spawned: existing?.spawned ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
          })
        }

        if (obsoleteSpawnedIds.size > 0) {
          await db.workOrders.where('defectId').anyOf([...obsoleteSpawnedIds]).delete()
          await db.defects.bulkDelete([...obsoleteSpawnedIds])
        }
        if (plan.removedLinkIds.length > 0) {
          await db.reconcileLinks.bulkDelete(plan.removedLinkIds)
        }
        if (newDefects.length > 0) await db.defects.bulkPut(newDefects)
        if (upsertLinks.length > 0) await db.reconcileLinks.bulkPut(upsertLinks)

        const remaining = await db.reconcileLinks.where('batchId').equals(batchId).toArray()
        const hasOpen = remaining.some((link) => isOpenLinkState(link.state))
        await db.importBatches.update(batchId, {
          state: hasOpen ? '对账中' : '对账完成',
          reconciledAt: hasOpen ? null : now,
          updatedAt: now
        })
      }
    )
  }

  /* ---------------- 负责人裁决 ---------------- */

  /** 单条裁决：取本机值或现场值；取现场值时把现场版回写本机缺陷 */
  async function resolveLink(linkId: string, choice: ConflictChoice, owner: string): Promise<void> {
    await resolveLinks([linkId], choice, owner)
  }

  async function resolveLinks(linkIds: string[], choice: ConflictChoice, owner: string): Promise<void> {
    if (linkIds.length === 0) return
    const now = Date.now()
    const affectedBatches = new Set<string>()
    await db.transaction('rw', [db.defects, db.reconcileLinks, db.importBatches], async () => {
      for (const linkId of linkIds) {
        const link = await db.reconcileLinks.get(linkId)
        if (!link || link.state !== '冲突待决') continue
        affectedBatches.add(link.batchId)
        if (choice === '现场' && link.defectId) {
          const snapshot = link.fieldSnapshot
          await db.defects.update(link.defectId, {
            type: snapshot.type,
            severity: snapshot.severity,
            lengthMm: snapshot.lengthMm,
            widthMm: snapshot.widthMm,
            face: snapshot.face,
            positionM: snapshot.positionM,
            updatedAt: now
          })
        }
        await db.reconcileLinks.update(linkId, {
          state: choice === '本机' ? '已决取本机' : '已决取现场',
          resolution: choice,
          owner: owner.trim(),
          resolvedAt: now,
          differences: [],
          updatedAt: now
        })
      }
    })
    for (const batchId of affectedBatches) {
      await refreshBatchState(batchId)
    }
  }

  /** 无法定位行：负责人核对后可忽略（不派工、不阻塞） */
  async function ignoreLinks(linkIds: string[], owner: string): Promise<void> {
    if (linkIds.length === 0) return
    const affectedBatches = new Set<string>()
    await db.transaction('rw', [db.reconcileLinks, db.importBatches], async () => {
      for (const linkId of linkIds) {
        const link = await db.reconcileLinks.get(linkId)
        if (!link || link.state !== '无法定位') continue
        affectedBatches.add(link.batchId)
        await db.reconcileLinks.update(linkId, {
          state: '已忽略',
          owner: owner.trim(),
          resolvedAt: Date.now(),
          updatedAt: Date.now()
        })
      }
    })
    affectedBatches.forEach((batchId) => void refreshBatchState(batchId))
  }

  /** 手工触发整批重新对账（容差调整 / 台账补录后使用） */
  async function reconcileBatchFully(batchId: string): Promise<void> {
    await runReconcile(batchId, false)
  }

  /** 重算批次收口状态 */
  async function refreshBatchState(batchId: string): Promise<void> {
    const linksInBatch = await db.reconcileLinks.where('batchId').equals(batchId).toArray()
    const rowsInBatch = await db.fieldDefectRows.where('batchId').equals(batchId).count()
    const hasOpen = linksInBatch.some((link) => isOpenLinkState(link.state))
    // 现场记录还在写入时不自动收口
    const batch = await db.importBatches.get(batchId)
    if (!batch) return
    if (batch.state === '写入中' || linksInBatch.length < rowsInBatch) return
    const now = Date.now()
    await db.importBatches.update(batchId, {
      state: hasOpen ? '对账中' : '对账完成',
      reconciledAt: hasOpen ? null : now,
      updatedAt: now
    })
  }

  /* ---------------- 本机缺陷变更后的未决重算 ---------------- */

  /**
   * 本机缺陷被修改：重算「绑定该缺陷且仍未决」的批次。
   * 已决关联不动；已生成工单与报告的快照不受影响。
   */
  async function recomputeAfterDefectUpdate(defectId: string): Promise<void> {
    const affected = links.value
      .filter((link) => link.defectId === defectId && isOpenLinkState(link.state))
      .map((link) => link.batchId)
    await Promise.all(Array.from(new Set(affected)).map((batchId) => runReconcile(batchId, true)))
  }

  /**
   * 本机缺陷被删除前的清理：未决关联退回「待匹配」以便重新配对 / 派生，
   * 已决关联直接随缺陷删除。由 defectStore 的删除事务调用。
   */
  async function resetLinksForDeletedDefects(defectIds: string[]): Promise<void> {
    if (defectIds.length === 0) return
    const affected = new Set<string>()
    await db.transaction('rw', [db.reconcileLinks], async () => {
      const bound = await db.reconcileLinks.where('defectId').anyOf(defectIds).toArray()
      for (const link of bound) {
        affected.add(link.batchId)
        if (isOpenLinkState(link.state)) {
          await db.reconcileLinks.update(link.id, {
            defectId: null,
            state: '待匹配',
            differences: [],
            localSnapshot: null,
            spawned: false,
            updatedAt: Date.now()
          })
        } else {
          await db.reconcileLinks.delete(link.id)
        }
      }
    })
    // 退回待匹配的行重新参与未决对账
    if (affected.size > 0) {
      await Promise.all(
        Array.from(affected).map(async (batchId) => {
          // 退回「待匹配」的行重新参与未决对账
          const batchLinks = await db.reconcileLinks.where('batchId').equals(batchId).toArray()
          const needRun = batchLinks.some((link) => link.state === '待匹配')
          if (needRun) await runReconcile(batchId, true)
        })
      )
    }
  }

  /* ---------------- 批次维护 ---------------- */

  /** 删除批次：现场记录 + 关联级联清理；自动新增且无工单的缺陷一并删除 */
  async function removeBatch(batchId: string): Promise<void> {
    const batchLinks = await db.reconcileLinks.where('batchId').equals(batchId).toArray()
    const spawnedIds = batchLinks.filter((link) => link.spawned && link.defectId).map((link) => link.defectId as string)
    const ordersAll = spawnedIds.length > 0 ? await db.workOrders.where('defectId').anyOf(spawnedIds).toArray() : []
    const removable = spawnedIds.filter((id) => !ordersAll.some((order) => order.defectId === id))
    await db.transaction(
      'rw',
      [db.importBatches, db.fieldDefectRows, db.reconcileLinks, db.defects, db.workOrders],
      async () => {
        if (removable.length > 0) {
          await db.workOrders.where('defectId').anyOf(removable).delete()
          await db.defects.bulkDelete(removable)
        }
        await db.reconcileLinks.where('batchId').equals(batchId).delete()
        await db.fieldDefectRows.where('batchId').equals(batchId).delete()
        await db.importBatches.delete(batchId)
      }
    )
  }

  return {
    batches,
    fieldRows,
    links,
    loading,
    ready,
    ingestProgress,
    pendingConflictDefectIds,
    pendingConflictCount,
    batchById,
    rowsOfBatch,
    linksOfBatch,
    linkOfFieldRow,
    viewsOfBatch,
    summarize,
    defectHasPendingConflict,
    createBatch,
    ingestBatch,
    resumeInterrupted,
    runReconcile,
    reconcileBatchFully,
    refreshBatchState,
    resolveLink,
    resolveLinks,
    ignoreLinks,
    recomputeAfterDefectUpdate,
    resetLinksForDeletedDefects,
    removeBatch
  }
})
