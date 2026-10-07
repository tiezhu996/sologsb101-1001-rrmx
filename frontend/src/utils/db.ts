import Dexie, { type Table } from 'dexie'
import type { Turbine } from '@/types/turbine'
import type { Blade, BladeMaterial, BladeSerial } from '@/types/blade'
import type { Segment, SegmentFace } from '@/types/segment'
import type { Defect, DefectState, DefectType, Severity } from '@/types/defect'
import type { WorkOrder, WorkOrderState } from '@/types/workOrder'
import type { FieldDefectRow, ImportBatch, ReconcileLink } from '@/types/reconcile'
import { isOpenLinkState } from '@/types/reconcile'

/** 本地 IndexedDB 库名 */
export const DB_NAME = 'gbwindblade'

/** 本地结构版本号：新增 / 修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** localStorage 侧的少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbwindblade:db-version',
  lastBackupAt: 'gbwindblade:last-backup-at',
  uiPrefs: 'gbwindblade:ui-prefs'
} as const

export interface UiPrefs {
  lastTurbineId: string | null
  lastBladeId: string | null
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastTurbineId: null,
  lastBladeId: null
}

/** 备份 / 导出文件结构，供 utils/export.ts 与报告页使用 */
export interface BackupPayload {
  app: 'gbwindblade'
  dbVersion: number
  exportedAt: string
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
  importBatches: ImportBatch[]
  fieldDefectRows: FieldDefectRow[]
  reconcileLinks: ReconcileLink[]
}

/** 全部业务表集合，清空与导入共用 */
export const ALL_TABLES = [
  'turbines',
  'blades',
  'segments',
  'defects',
  'workOrders',
  'importBatches',
  'fieldDefectRows',
  'reconcileLinks'
] as const

export class WindBladeDatabase extends Dexie {
  turbines!: Table<Turbine, string>
  blades!: Table<Blade, string>
  segments!: Table<Segment, string>
  defects!: Table<Defect, string>
  workOrders!: Table<WorkOrder, string>
  importBatches!: Table<ImportBatch, string>
  fieldDefectRows!: Table<FieldDefectRow, string>
  reconcileLinks!: Table<ReconcileLink, string>

  constructor() {
    super(DB_NAME)
    this.version(1).stores({
      turbines: 'id, code, model, commissionDate, updatedAt',
      blades: 'id, turbineId, serial, material, updatedAt',
      segments: 'id, bladeId, index, airfoil, updatedAt',
      defects: 'id, segmentId, type, severity, updatedAt',
      workOrders: 'id, defectId, team, state, updatedAt'
    })
    // v2：分段补充检修面索引，缺陷补充面位 / 状态 / 发现日期索引，工单补充限期索引
    this.version(2).stores({
      turbines: 'id, code, model, commissionDate, updatedAt',
      blades: 'id, turbineId, serial, material, updatedAt',
      segments: 'id, bladeId, index, face, updatedAt',
      defects: 'id, segmentId, type, severity, face, state, foundAt, updatedAt',
      workOrders: 'id, defectId, team, state, dueDate, updatedAt'
    })
    // v3：外委批次对账——批次、现场记录、对账关联三张新表；缺陷补来源索引
    this.version(DB_VERSION)
      .stores({
        turbines: 'id, code, model, commissionDate, updatedAt',
        blades: 'id, turbineId, serial, material, updatedAt',
        segments: 'id, bladeId, index, face, updatedAt',
        defects: 'id, segmentId, type, severity, face, state, foundAt, sourceBatchId, updatedAt',
        workOrders: 'id, defectId, team, state, dueDate, updatedAt',
        importBatches: 'id, batchNo, state, importedAt, updatedAt',
        fieldDefectRows: 'id, batchId, fingerprint, turbineCode, updatedAt',
        reconcileLinks: 'id, batchId, fieldRowId, defectId, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 → v3 迁移：历史工单补缺陷快照字段（null，展示时回退实时值）
        await tx
          .table<WorkOrder>('workOrders')
          .toCollection()
          .modify((order) => {
            if (order.defectSnapshot === undefined) order.defectSnapshot = null
          })
        // v1 直接升 v3 时，历史缺陷 / 工单 / 分段字段也需补齐
        await tx
          .table<Defect>('defects')
          .toCollection()
          .modify((defect) => {
            if (!defect.state) defect.state = '待处理'
            if (typeof defect.lengthMm !== 'number') defect.lengthMm = 0
            if (typeof defect.widthMm !== 'number') defect.widthMm = 0
            if (typeof defect.positionM !== 'number') defect.positionM = 0
          })
        await tx
          .table<WorkOrder>('workOrders')
          .toCollection()
          .modify((order) => {
            if (!order.state) order.state = '待派'
            if (typeof order.acceptor !== 'string') order.acceptor = ''
            if (order.closedAt === undefined) order.closedAt = null
          })
        await tx
          .table<Segment>('segments')
          .toCollection()
          .modify((segment) => {
            if (typeof segment.sectionImage !== 'string') segment.sectionImage = ''
            if (!segment.face) segment.face = 'PS'
          })
      })
  }
}

export const db = new WindBladeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表，供「清空本地数据」与导入前覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.turbines,
      db.blades,
      db.segments,
      db.defects,
      db.workOrders,
      db.importBatches,
      db.fieldDefectRows,
      db.reconcileLinks
    ],
    async () => {
      await Promise.all([
        db.turbines.clear(),
        db.blades.clear(),
        db.segments.clear(),
        db.defects.clear(),
        db.workOrders.clear(),
        db.importBatches.clear(),
        db.fieldDefectRows.clear(),
        db.reconcileLinks.clear()
      ])
    }
  )
}

/**
 * 级联删除缺陷前回收对账关联（须在含 db.reconcileLinks 的事务内调用）：
 * 未决关联退回「无法定位」并解绑（现场记录保留，负责人可忽略）；已决关联随缺陷删除。
 */
export async function detachReconcileLinksForDefects(defectIds: string[]): Promise<void> {
  if (defectIds.length === 0) return
  const bound = await db.reconcileLinks.where('defectId').anyOf(defectIds).toArray()
  for (const link of bound) {
    if (isOpenLinkState(link.state)) {
      await db.reconcileLinks.update(link.id, {
        defectId: null,
        state: '无法定位',
        locateReason: link.locateReason ?? '分段区间不存在',
        differences: [],
        localSnapshot: null,
        spawned: false,
        updatedAt: Date.now()
      })
    } else {
      await db.reconcileLinks.delete(link.id)
    }
  }
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastTurbineId: typeof parsed.lastTurbineId === 'string' ? parsed.lastTurbineId : null,
      lastBladeId: typeof parsed.lastBladeId === 'string' ? parsed.lastBladeId : null
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本，便于报告页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 相对今天偏移 N 天的日期（YYYY-MM-DD），用于播种出「超期 / 临近」工单 */
function dateOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 播种用的缺陷规格：order 存在时按工单状态反推缺陷状态 */
interface SeedDefectSpec {
  turbine: 0 | 1
  serial: BladeSerial
  seg: number
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  foundOffsetDays: number
  order?: {
    team: string
    dueOffsetDays: number
    state: WorkOrderState
    acceptor: string
    closedOffsetDays: number | null
  }
}

/** 演示数据：2 台机组 × 各 2 片叶片 × 各 3 个展向分段 × 18 条缺陷 × 4 张工单 */
const SEED_DEFECTS: SeedDefectSpec[] = [
  // ---- 机组一 WT-A01 ----
  {
    turbine: 0, serial: 'A', seg: 1, type: '前缘腐蚀', severity: '中度',
    lengthMm: 820, widthMm: 36, foundOffsetDays: -46,
    order: { team: '叶片检修一班', dueOffsetDays: -12, state: '处理中', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 0, serial: 'A', seg: 1, type: '砂眼', severity: '轻度', lengthMm: 12, widthMm: 9, foundOffsetDays: -46 },
  { turbine: 0, serial: 'A', seg: 2, type: '裂纹', severity: '重度', lengthMm: 1450, widthMm: 6, foundOffsetDays: -30 },
  { turbine: 0, serial: 'A', seg: 2, type: '油污', severity: '轻度', lengthMm: 340, widthMm: 210, foundOffsetDays: -30 },
  { turbine: 0, serial: 'A', seg: 3, type: '雷击', severity: '重度', lengthMm: 260, widthMm: 180, foundOffsetDays: -18 },
  {
    turbine: 0, serial: 'B', seg: 1, type: '油污', severity: '轻度',
    lengthMm: 260, widthMm: 140, foundOffsetDays: -52,
    order: { team: '无人机巡检组', dueOffsetDays: 26, state: '待派', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 0, serial: 'B', seg: 2, type: '裂纹', severity: '重度', lengthMm: 1180, widthMm: 5, foundOffsetDays: -25 },
  {
    turbine: 0, serial: 'B', seg: 2, type: '前缘腐蚀', severity: '中度',
    lengthMm: 640, widthMm: 28, foundOffsetDays: -25,
    order: { team: '复材修复三班', dueOffsetDays: 4, state: '待验收', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 0, serial: 'B', seg: 3, type: '砂眼', severity: '中度', lengthMm: 18, widthMm: 14, foundOffsetDays: -11 },
  // ---- 机组二 WT-B07 ----
  {
    turbine: 1, serial: 'A', seg: 1, type: '雷击', severity: '重度',
    lengthMm: 310, widthMm: 220, foundOffsetDays: -64,
    order: { team: '高空作业二班', dueOffsetDays: -40, state: '已闭环', acceptor: '赵鹏', closedOffsetDays: -35 }
  },
  { turbine: 1, serial: 'A', seg: 2, type: '前缘腐蚀', severity: '中度', lengthMm: 910, widthMm: 42, foundOffsetDays: -33 },
  { turbine: 1, serial: 'A', seg: 3, type: '裂纹', severity: '轻度', lengthMm: 420, widthMm: 3, foundOffsetDays: -20 },
  { turbine: 1, serial: 'A', seg: 3, type: '油污', severity: '轻度', lengthMm: 180, widthMm: 120, foundOffsetDays: -20 },
  { turbine: 1, serial: 'B', seg: 1, type: '砂眼', severity: '轻度', lengthMm: 15, widthMm: 11, foundOffsetDays: -58 },
  {
    turbine: 1, serial: 'B', seg: 2, type: '裂纹', severity: '重度',
    lengthMm: 1620, widthMm: 8, foundOffsetDays: -27,
    order: { team: '复材修复三班', dueOffsetDays: 9, state: '处理中', acceptor: '', closedOffsetDays: null }
  },
  { turbine: 1, serial: 'B', seg: 2, type: '雷击', severity: '中度', lengthMm: 150, widthMm: 96, foundOffsetDays: -27 },
  { turbine: 1, serial: 'B', seg: 3, type: '前缘腐蚀', severity: '重度', lengthMm: 1720, widthMm: 55, foundOffsetDays: -14 },
  { turbine: 1, serial: 'B', seg: 3, type: '砂眼', severity: '中度', lengthMm: 22, widthMm: 16, foundOffsetDays: -14 }
]

/** 是否已完成播种（机组表非空即视为已播种） */
export async function isSeeded(): Promise<boolean> {
  return (await db.turbines.count()) > 0
}

/**
 * 首次进入自动播种演示数据：2 台机组 × 各 2 片叶片 × 各 3 个展向分段 × 18 条缺陷 × 4 张工单。
 * 幂等：机组表非空时直接返回 false，不会重复播种。
 */
export async function seedDemoData(): Promise<boolean> {
  if (await isSeeded()) return false

  const now = Date.now()
  const turbines: Turbine[] = []
  const blades: Blade[] = []
  const segments: Segment[] = []
  const defects: Defect[] = []
  const workOrders: WorkOrder[] = []
  const importBatches: ImportBatch[] = []
  const fieldDefectRows: FieldDefectRow[] = []
  const reconcileLinks: ReconcileLink[] = []

  const blueprints: Array<{
    code: string
    model: string
    hubHeightM: number
    commissionDate: string
    lengthM: number
    material: BladeMaterial
    serials: BladeSerial[]
    airfoil: string
    faces: SegmentFace[]
  }> = [
    {
      code: 'WT-A01',
      model: 'GW155-4.5MW',
      hubHeightM: 110,
      commissionDate: '2021-06-18',
      lengthM: 68.5,
      material: '玻璃纤维',
      serials: ['A', 'B'],
      airfoil: 'DU-91-W2-250',
      faces: ['PS', 'LE', 'SS']
    },
    {
      code: 'WT-B07',
      model: 'GW171-6.0MW',
      hubHeightM: 120,
      commissionDate: '2023-03-05',
      lengthM: 84,
      material: '碳纤维',
      serials: ['A', 'B'],
      airfoil: 'DU-93-W-210',
      faces: ['LE', 'PS', 'TE']
    }
  ]

  blueprints.forEach((blueprint, turbineIndex) => {
    const turbineId = createId('tbn')
    turbines.push({
      id: turbineId,
      code: blueprint.code,
      model: blueprint.model,
      hubHeightM: blueprint.hubHeightM,
      commissionDate: blueprint.commissionDate,
      bladeCount: blueprint.serials.length,
      createdAt: now,
      updatedAt: now
    })

    blueprint.serials.forEach((serial, bladeIndex) => {
      const bladeId = createId('bld')
      const segmentCount = 3
      blades.push({
        id: bladeId,
        turbineId,
        serial,
        lengthM: blueprint.lengthM,
        material: blueprint.material,
        segmentCount,
        createdAt: now,
        updatedAt: now
      })

      for (let i = 1; i <= segmentCount; i += 1) {
        const startM = round2(((i - 1) * blueprint.lengthM) / segmentCount)
        const endM = round2((i * blueprint.lengthM) / segmentCount)
        const face = blueprint.faces[(i - 1) % blueprint.faces.length]
        segments.push({
          id: createId('seg'),
          bladeId,
          index: i,
          startM,
          endM,
          airfoil: blueprint.airfoil,
          face,
          sectionImage: `${blueprint.code}-${serial}-seg${String(i).padStart(2, '0')}-${face}.png`,
          createdAt: now,
          updatedAt: now
        })
      }

      // 逐段挂接缺陷
      for (let i = 1; i <= segmentCount; i += 1) {
        const segment = segments.find(
          (item) => item.bladeId === bladeId && item.index === i
        ) as Segment
        const specs = SEED_DEFECTS.filter(
          (spec) =>
            spec.turbine === turbineIndex && spec.serial === serial && spec.seg === i
        )
        specs.forEach((spec, specIndex) => {
          const defectId = createId('dfc')
          const state: DefectState = spec.order
            ? spec.order.state === '已闭环'
              ? '已修复'
              : '已派工'
            : '待处理'
          // 展向位置：在分段区间内按缺陷序号错开，避免重叠
          const ratio = 0.3 + ((bladeIndex + specIndex) % 3) * 0.2
          const positionM = round2(segment.startM + (segment.endM - segment.startM) * ratio)
          defects.push({
            id: defectId,
            segmentId: segment.id,
            type: spec.type,
            severity: spec.severity,
            lengthMm: spec.lengthMm,
            widthMm: spec.widthMm,
            face: segment.face,
            positionM,
            foundAt: dateOffset(spec.foundOffsetDays),
            state,
            createdAt: now,
            updatedAt: now
          })

          if (spec.order) {
            workOrders.push({
              id: createId('wo'),
              defectId,
              team: spec.order.team,
              dueDate: dateOffset(spec.order.dueOffsetDays),
              state: spec.order.state,
              acceptor: spec.order.acceptor,
              closedAt:
                spec.order.closedOffsetDays === null
                  ? null
                  : now + spec.order.closedOffsetDays * 24 * 60 * 60 * 1000,
              defectSnapshot: null,
              createdAt: now,
              updatedAt: now
            })
          }
        })
      }
    })
  })

  await db.transaction(
    'rw',
    [
      db.turbines,
      db.blades,
      db.segments,
      db.defects,
      db.workOrders,
      db.importBatches,
      db.fieldDefectRows,
      db.reconcileLinks
    ],
    async () => {
      await db.turbines.bulkPut(turbines)
      await db.blades.bulkPut(blades)
      await db.segments.bulkPut(segments)
      await db.defects.bulkPut(defects)
      await db.workOrders.bulkPut(workOrders)

      // 外委演示批次：1 条等级冲突（待负责人裁决）+ 1 条一致 + 1 条现场新增缺陷
      const turbineOne = turbines.find((item) => item.code === 'WT-A01') as Turbine
      const bladeA = blades.find((item) => item.turbineId === turbineOne.id && item.serial === 'A') as Blade
      const segA1 = segments.find((item) => item.bladeId === bladeA.id && item.index === 1) as Segment
      const segA3 = segments.find((item) => item.bladeId === bladeA.id && item.index === 3) as Segment
      // 第一条缺陷：WT-A01 / A / 第1段 / LE / 前缘腐蚀（播种时 820×36 中度）
      const conflictDefect = defects.find(
        (item) => item.segmentId === segA1.id && item.type === '前缘腐蚀'
      ) as Defect
      // 第二条缺陷：同段砂眼 12×9 轻度
      const matchDefect = defects.find(
        (item) => item.segmentId === segA1.id && item.type === '砂眼'
      ) as Defect

      const batchId = createId('batch')
      const makeFieldRow = (
        line: number,
        segment: Segment,
        spec: {
          type: DefectType
          severity: Severity
          lengthMm: number
          widthMm: number
          positionM: number
        },
        fingerprintSalt: string
      ): FieldDefectRow => ({
        id: createId('fld'),
        batchId,
        sourceLine: line + 1,
        fingerprint: `seed|${fingerprintSalt}`,
        turbineCode: turbineOne.code,
        bladeSerial: bladeA.serial,
        segmentStartM: segment.startM,
        segmentEndM: segment.endM,
        type: spec.type,
        severity: spec.severity,
        lengthMm: spec.lengthMm,
        widthMm: spec.widthMm,
        face: segment.face,
        positionM: spec.positionM,
        foundAt: dateOffset(-3),
        inspector: '外委检修一队',
        createdAt: now,
        updatedAt: now
      })

      const rowConflict = makeFieldRow(
        1,
        segA1,
        { type: '前缘腐蚀', severity: '重度', lengthMm: 900, widthMm: 40, positionM: conflictDefect.positionM },
        'conflict'
      )
      const rowMatch = makeFieldRow(
        2,
        segA1,
        { type: '砂眼', severity: '轻度', lengthMm: 12, widthMm: 9, positionM: matchDefect.positionM },
        'match'
      )
      const newPosition = round2(segA3.startM + (segA3.endM - segA3.startM) * 0.72)
      const rowNew = makeFieldRow(
        3,
        segA3,
        { type: '砂眼', severity: '轻度', lengthMm: 16, widthMm: 10, positionM: newPosition },
        'new'
      )
      fieldDefectRows.push(rowConflict, rowMatch, rowNew)

      const makeLink = (
        row: FieldDefectRow,
        defect: Defect | null,
        state: ReconcileLink['state'],
        differences: ReconcileLink['differences'],
        spawned: boolean
      ): ReconcileLink => ({
        id: createId('lnk'),
        batchId,
        fieldRowId: row.id,
        defectId: defect ? defect.id : null,
        state,
        locateReason: null,
        differences,
        fieldSnapshot: {
          type: row.type,
          severity: row.severity,
          lengthMm: row.lengthMm,
          widthMm: row.widthMm,
          face: row.face,
          positionM: row.positionM
        },
        localSnapshot: defect
          ? {
              type: defect.type,
              severity: defect.severity,
              lengthMm: defect.lengthMm,
              widthMm: defect.widthMm,
              face: defect.face,
              positionM: defect.positionM
            }
          : null,
        owner: '',
        resolution: null,
        resolvedAt: null,
        spawned,
        createdAt: now,
        updatedAt: now
      })

      reconcileLinks.push(
        makeLink(rowConflict, conflictDefect, '冲突待决', ['severity', 'lengthMm', 'widthMm'], false),
        makeLink(rowMatch, matchDefect, '一致', [], false)
      )

      // 现场新增缺陷：落本机档并回写来源溯源
      const spawnedDefect: Defect = {
        id: createId('dfc'),
        segmentId: segA3.id,
        type: rowNew.type,
        severity: rowNew.severity,
        lengthMm: rowNew.lengthMm,
        widthMm: rowNew.widthMm,
        face: rowNew.face,
        positionM: rowNew.positionM,
        foundAt: rowNew.foundAt,
        state: '待处理',
        sourceBatchId: batchId,
        sourceFieldRowId: rowNew.id,
        createdAt: now,
        updatedAt: now
      }
      defects.push(spawnedDefect)
      reconcileLinks.push(makeLink(rowNew, spawnedDefect, '已新增', [], true))

      importBatches.push({
        id: batchId,
        batchNo: 'WW-202609-03',
        vendor: '外委检修一队',
        state: '对账中',
        rawText: '',
        fileName: 'WW-202609-03-离线巡检表.tsv',
        totalRows: 3,
        ingestedRows: 3,
        duplicateRows: 0,
        lastError: '',
        positionToleranceM: 0.5,
        rangeToleranceM: 0.1,
        importedAt: now,
        reconciledAt: now,
        createdAt: now,
        updatedAt: now
      })

      await db.importBatches.bulkPut(importBatches)
      await db.fieldDefectRows.bulkPut(fieldDefectRows)
      await db.defects.bulkPut([spawnedDefect])
      await db.reconcileLinks.bulkPut(reconcileLinks)
    }
  )

  return true
}

/**
 * 应用启动入口调用：首次进入（机组表为空）自动播种演示数据。
 * 幂等，可重复调用。
 */
export async function ensureSeeded(): Promise<boolean> {
  try {
    return await seedDemoData()
  } catch (error) {
    console.error('[gbwindblade] 播种演示数据失败：', error)
    return false
  }
}
