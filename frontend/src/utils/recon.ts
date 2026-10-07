import type { Blade } from '@/types/blade'
import type { Defect } from '@/types/defect'
import { DEFECT_TYPES, SEVERITIES, type DefectType, type Severity } from '@/types/defect'
import type { Segment, SegmentFace } from '@/types/segment'
import { SEGMENT_FACES } from '@/types/segment'
import type { Turbine } from '@/types/turbine'
import type {
  ConflictField,
  ConflictSide,
  FieldRowInput
} from '@/types/fieldBatch'

/** 分段区间匹配容差（米）：现场表与本机分段起终点之差在此范围内视为同一分段 */
export const SEGMENT_MATCH_EPS_M = 0.11

/* ---------------- 巡检表解析 ---------------- */

const FIELD_HEADERS: Record<keyof FieldRowInput, string[]> = {
  turbineCode: ['机组编号', '机组', '机位号', 'turbine', 'turbinecode'],
  bladeSerial: ['叶片序号', '叶片', 'blade', 'bladeserial', 'serial'],
  segmentStartM: ['分段起点', '分段起始', 'startm', 'segstart', 'segmentstartm'],
  segmentEndM: ['分段终点', '分段结束', 'endm', 'segend', 'segmentendm'],
  face: ['面位', 'face'],
  type: ['类型', '缺陷类型', 'type'],
  severity: ['严重程度', '等级', '程度', 'severity'],
  lengthMm: ['长度', '长', 'lengthmm', 'length'],
  widthMm: ['宽度', '宽', 'widthmm', 'width'],
  positionM: ['展向位置', '位置', 'positionm', 'position'],
  foundAt: ['发现日期', '日期', 'foundat', 'date']
}

/** 表头归一化：去括号注释、空白与连字符并转小写，兼容「长度(mm)」「展向位置（m）」等写法 */
function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-/]/g, '')
}

function buildHeaderLookup(): Map<string, keyof FieldRowInput> {
  const lookup = new Map<string, keyof FieldRowInput>()
  const keys = Object.keys(FIELD_HEADERS) as (keyof FieldRowInput)[]
  for (const key of keys) {
    for (const alias of FIELD_HEADERS[key]) {
      lookup.set(normalizeHeader(alias), key)
    }
  }
  return lookup
}

const HEADER_LOOKUP = buildHeaderLookup()

const FACE_ALIASES: Record<string, SegmentFace> = {
  ps: 'PS',
  迎风面: 'PS',
  迎风: 'PS',
  ss: 'SS',
  背风面: 'SS',
  背风: 'SS',
  le: 'LE',
  前缘: 'LE',
  te: 'TE',
  后缘: 'TE'
}

function parseFace(raw: string): SegmentFace | null {
  const key = raw.trim().toLowerCase()
  return FACE_ALIASES[key] ?? (SEGMENT_FACES.includes(key.toUpperCase() as SegmentFace) ? (key.toUpperCase() as SegmentFace) : null)
}

function parseSeverity(raw: string): Severity | null {
  const key = raw.trim()
  const hit = SEVERITIES.find((severity) => severity === key || severity.startsWith(key))
  return hit ?? null
}

/** 日期归一化：接受 YYYY-MM-DD / YYYY/M/D / YYYY.M.D，非法返回 null */
function parseDateText(raw: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw.trim())
  if (!match) return null
  const [, year, month, day] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/** 机组编号 / 叶片序号归一化：大写、去空白，序号兼容「叶片A」写法 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

export function normalizeSerial(raw: string): string {
  return normalizeCode(raw).replace(/^叶片/, '')
}

export interface ParseResult {
  rows: FieldRowInput[]
  errors: string[]
}

/** 把一行原始键值（表头 → 文本）解析为现场记录行，返回行号定位的错误信息 */
function toFieldRow(raw: Record<string, string>, lineNo: number): { row: FieldRowInput | null; errors: string[] } {
  const errors: string[] = []
  const get = (key: keyof FieldRowInput): string => (raw[key] ?? '').trim()

  const turbineCode = normalizeCode(get('turbineCode'))
  if (!turbineCode) errors.push(`第 ${lineNo} 行：机组编号为空`)
  const bladeSerial = normalizeSerial(get('bladeSerial'))
  if (!bladeSerial) errors.push(`第 ${lineNo} 行：叶片序号为空`)

  const segmentStartM = Number(get('segmentStartM'))
  if (!Number.isFinite(segmentStartM) || segmentStartM < 0) errors.push(`第 ${lineNo} 行：分段起点无效「${get('segmentStartM')}」`)
  const segmentEndM = Number(get('segmentEndM'))
  if (!Number.isFinite(segmentEndM) || segmentEndM <= segmentStartM) {
    errors.push(`第 ${lineNo} 行：分段终点无效「${get('segmentEndM')}」（需大于起点）`)
  }

  const face = parseFace(get('face'))
  if (!face) errors.push(`第 ${lineNo} 行：面位无法识别「${get('face')}」（应为 PS/SS/LE/TE 或 迎风面/背风面/前缘/后缘）`)

  const typeText = get('type')
  const type = (DEFECT_TYPES as string[]).includes(typeText) ? (typeText as DefectType) : null
  if (!type) errors.push(`第 ${lineNo} 行：缺陷类型无法识别「${typeText}」（应为 ${DEFECT_TYPES.join('/')}）`)

  const severity = parseSeverity(get('severity'))
  if (!severity) errors.push(`第 ${lineNo} 行：严重程度无法识别「${get('severity')}」（应为 轻度/中度/重度）`)

  const lengthMm = Number(get('lengthMm'))
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) errors.push(`第 ${lineNo} 行：长度(mm) 无效「${get('lengthMm')}」`)
  const widthMm = Number(get('widthMm'))
  if (!Number.isFinite(widthMm) || widthMm <= 0) errors.push(`第 ${lineNo} 行：宽度(mm) 无效「${get('widthMm')}」`)
  const positionM = Number(get('positionM'))
  if (!Number.isFinite(positionM) || positionM < 0) errors.push(`第 ${lineNo} 行：展向位置(m) 无效「${get('positionM')}」`)

  const foundAtText = get('foundAt')
  let foundAt = ''
  if (foundAtText) {
    const parsed = parseDateText(foundAtText)
    if (!parsed) errors.push(`第 ${lineNo} 行：发现日期无效「${foundAtText}」（应为 YYYY-MM-DD）`)
    else foundAt = parsed
  }

  if (errors.length > 0) return { row: null, errors }
  return {
    row: {
      turbineCode,
      bladeSerial,
      segmentStartM,
      segmentEndM,
      face: face as SegmentFace,
      type: type as DefectType,
      severity: severity as Severity,
      lengthMm,
      widthMm,
      positionM,
      foundAt
    },
    errors
  }
}

/** 必需列：缺少任一列则整个文件不可导入 */
const REQUIRED_KEYS: (keyof FieldRowInput)[] = [
  'turbineCode',
  'bladeSerial',
  'segmentStartM',
  'segmentEndM',
  'face',
  'type',
  'severity',
  'lengthMm',
  'widthMm',
  'positionM'
]

const REQUIRED_LABEL: Record<string, string> = {
  turbineCode: '机组编号',
  bladeSerial: '叶片序号',
  segmentStartM: '分段起点(m)',
  segmentEndM: '分段终点(m)',
  face: '面位',
  type: '类型',
  severity: '严重程度',
  lengthMm: '长度(mm)',
  widthMm: '宽度(mm)',
  positionM: '展向位置(m)'
}

/** 简单 CSV/TSV 行切分：支持双引号包裹单元格 */
function splitLine(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t').map((cell) => cell.trim().replace(/^"|"$/g, ''))
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === delim && !inQuotes) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

/** 表头行 → 列索引映射；返回缺失的必需列 */
function mapHeaders(headerCells: string[]): { columns: Map<keyof FieldRowInput, number>; missing: string[] } {
  const columns = new Map<keyof FieldRowInput, number>()
  headerCells.forEach((cell, index) => {
    const key = HEADER_LOOKUP.get(normalizeHeader(cell))
    if (key !== undefined && !columns.has(key)) columns.set(key, index)
  })
  const missing = REQUIRED_KEYS.filter((key) => !columns.has(key)).map((key) => REQUIRED_LABEL[key])
  return { columns, missing }
}

function parseDelimited(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  if (lines.length < 2) return { rows: [], errors: ['内容不足：需要一行表头与至少一行数据'] }

  const delim = lines[0].includes('\t') ? '\t' : ','
  const { columns, missing } = mapHeaders(splitLine(lines[0], delim))
  if (missing.length > 0) return { rows: [], errors: [`缺少必需列：${missing.join('、')}`] }

  const rows: FieldRowInput[] = []
  const errors: string[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i], delim)
    if (cells.every((cell) => cell.length === 0)) continue
    const raw: Record<string, string> = {}
    columns.forEach((index, key) => {
      raw[key] = cells[index] ?? ''
    })
    const result = toFieldRow(raw, i + 1)
    if (result.row) rows.push(result.row)
    errors.push(...result.errors)
  }
  if (rows.length === 0 && errors.length === 0) errors.push('未解析到任何数据行')
  return { rows, errors }
}

function parseJsonRows(text: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { rows: [], errors: ['JSON 解析失败，请确认内容完整'] }
  }
  if (!Array.isArray(parsed)) return { rows: [], errors: ['JSON 内容应为现场记录的数组'] }
  const rows: FieldRowInput[] = []
  const errors: string[] = []
  parsed.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`第 ${index + 1} 行：不是对象`)
      return
    }
    const raw: Record<string, string> = {}
    Object.entries(item as Record<string, unknown>).forEach(([key, value]) => {
      const field = HEADER_LOOKUP.get(normalizeHeader(key))
      if (field !== undefined) raw[field] = String(value ?? '')
    })
    const result = toFieldRow(raw, index + 1)
    if (result.row) rows.push(result.row)
    errors.push(...result.errors)
  })
  if (rows.length === 0 && errors.length === 0) errors.push('JSON 数组为空')
  return { rows, errors }
}

/**
 * 解析离线巡检表：支持从 Excel 粘贴的制表符文本、CSV，或现场记录 JSON 数组。
 * 任一数据行非法时返回错误清单（导入被阻止），不返回部分成功的行。
 */
export function parseFieldSheet(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { rows: [], errors: ['内容为空，请粘贴巡检表或选择文件'] }
  if (trimmed.startsWith('[')) return parseJsonRows(trimmed)
  return parseDelimited(trimmed)
}

/* ---------------- 批次指纹（重复粘贴不新增） ---------------- */

/** 批次内容指纹：归一化后的逐行内容做双哈希，同一批次重复粘贴结果一致 */
export function fingerprintOfRows(rows: FieldRowInput[]): string {
  const canonical = rows
    .map((row) =>
      [
        row.turbineCode,
        row.bladeSerial,
        row.segmentStartM,
        row.segmentEndM,
        row.face,
        row.type,
        row.severity,
        row.lengthMm,
        row.widthMm,
        row.positionM,
        row.foundAt
      ].join('|')
    )
    .join('\n')
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i)
    h1 = ((h1 * 33) ^ code) >>> 0
    h2 = ((h2 * 31) ^ code) >>> 0
  }
  return `${rows.length}-${h1.toString(36)}${h2.toString(36)}`
}

/* ---------------- 对账匹配 ---------------- */

/** 本机数据索引：按匹配键逐级定位 */
export interface LocalIndex {
  turbinesByCode: Map<string, Turbine>
  bladesByTurbine: Map<string, Blade[]>
  segmentsByBlade: Map<string, Segment[]>
  defectsBySegment: Map<string, Defect[]>
}

export function buildLocalIndex(
  turbines: Turbine[],
  blades: Blade[],
  segments: Segment[],
  defects: Defect[]
): LocalIndex {
  const turbinesByCode = new Map<string, Turbine>()
  turbines.forEach((turbine) => turbinesByCode.set(normalizeCode(turbine.code), turbine))
  const bladesByTurbine = new Map<string, Blade[]>()
  blades.forEach((blade) => {
    const list = bladesByTurbine.get(blade.turbineId) ?? []
    list.push(blade)
    bladesByTurbine.set(blade.turbineId, list)
  })
  const segmentsByBlade = new Map<string, Segment[]>()
  segments.forEach((segment) => {
    const list = segmentsByBlade.get(segment.bladeId) ?? []
    list.push(segment)
    segmentsByBlade.set(segment.bladeId, list)
  })
  const defectsBySegment = new Map<string, Defect[]>()
  defects.forEach((defect) => {
    const list = defectsBySegment.get(defect.segmentId) ?? []
    list.push(defect)
    defectsBySegment.set(defect.segmentId, list)
  })
  return { turbinesByCode, bladesByTurbine, segmentsByBlade, defectsBySegment }
}

/** 向索引追加一条新增缺陷，保证同批次后续记录能感知（用于批次内重复检测） */
export function indexAddDefect(index: LocalIndex, defect: Defect): void {
  const list = index.defectsBySegment.get(defect.segmentId) ?? []
  list.push(defect)
  index.defectsBySegment.set(defect.segmentId, list)
}

export interface MatchContext {
  index: LocalIndex
  toleranceM: number
  /** 已被本批次其他记录命中的缺陷：缺陷 id → 记录 id */
  claimed: Map<string, string>
  /** 本批次新增的缺陷 id（命中视为批次内重复） */
  createdIds: Set<string>
}

export type MatchOutcome =
  | { kind: 'unmatched'; reason: string }
  | { kind: 'new'; segmentId: string }
  | { kind: 'matched'; defect: Defect }
  | { kind: 'conflict'; defect: Defect; diffFields: ConflictField[] }
  | { kind: 'duplicate'; defect: Defect; claimantRecordId: string | null }

/** 尺寸 / 等级差异清单：只有这三项参与冲突裁决 */
export function diffOf(defect: Defect, row: FieldRowInput): ConflictField[] {
  const diff: ConflictField[] = []
  if (defect.severity !== row.severity) diff.push('severity')
  if (defect.lengthMm !== row.lengthMm) diff.push('lengthMm')
  if (defect.widthMm !== row.widthMm) diff.push('widthMm')
  return diff
}

/**
 * 对账匹配：机组编号 → 叶片序号 → 分段区间 → 面位 → 类型 → 位置容差。
 * 多个候选时取展向距离最近的一条，保证一条现场记录最多命中一条缺陷。
 */
export function matchFieldRecord(row: FieldRowInput, ctx: MatchContext): MatchOutcome {
  const { index } = ctx
  const turbine = index.turbinesByCode.get(normalizeCode(row.turbineCode))
  if (!turbine) return { kind: 'unmatched', reason: `机组 ${row.turbineCode} 在本机台账中不存在` }

  const serial = normalizeSerial(row.bladeSerial)
  const blade = (index.bladesByTurbine.get(turbine.id) ?? []).find(
    (item) => normalizeSerial(item.serial) === serial
  )
  if (!blade) return { kind: 'unmatched', reason: `机组 ${turbine.code} 下不存在叶片 ${row.bladeSerial}` }

  const segment = (index.segmentsByBlade.get(blade.id) ?? []).find(
    (item) =>
      Math.abs(item.startM - row.segmentStartM) <= SEGMENT_MATCH_EPS_M &&
      Math.abs(item.endM - row.segmentEndM) <= SEGMENT_MATCH_EPS_M
  )
  if (!segment) {
    return {
      kind: 'unmatched',
      reason: `叶片 ${blade.serial} 上不存在分段区间 ${row.segmentStartM}-${row.segmentEndM} m`
    }
  }

  const candidates = (index.defectsBySegment.get(segment.id) ?? []).filter(
    (defect) =>
      defect.face === row.face &&
      defect.type === row.type &&
      Math.abs(defect.positionM - row.positionM) <= ctx.toleranceM
  )
  if (candidates.length === 0) return { kind: 'new', segmentId: segment.id }

  candidates.sort(
    (a, b) =>
      Math.abs(a.positionM - row.positionM) - Math.abs(b.positionM - row.positionM) ||
      a.updatedAt - b.updatedAt ||
      a.id.localeCompare(b.id)
  )
  const best = candidates[0]

  if (ctx.createdIds.has(best.id)) return { kind: 'duplicate', defect: best, claimantRecordId: null }
  const claimant = ctx.claimed.get(best.id)
  if (claimant !== undefined) return { kind: 'duplicate', defect: best, claimantRecordId: claimant }

  const diffFields = diffOf(best, row)
  return diffFields.length > 0 ? { kind: 'conflict', defect: best, diffFields } : { kind: 'matched', defect: best }
}

/* ---------------- 冲突版本快照 ---------------- */

export function sideFromDefect(defect: Defect): ConflictSide {
  return {
    type: defect.type,
    severity: defect.severity,
    lengthMm: defect.lengthMm,
    widthMm: defect.widthMm,
    face: defect.face,
    positionM: defect.positionM,
    foundAt: defect.foundAt
  }
}

export function sideFromRow(row: FieldRowInput): ConflictSide {
  return {
    type: row.type,
    severity: row.severity,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    face: row.face,
    positionM: row.positionM,
    foundAt: row.foundAt
  }
}

/** 两版快照是否一致（重算时判断本机值是否被修改过） */
export function sameSide(a: ConflictSide, b: ConflictSide): boolean {
  return (
    a.type === b.type &&
    a.severity === b.severity &&
    a.lengthMm === b.lengthMm &&
    a.widthMm === b.widthMm &&
    a.face === b.face &&
    a.positionM === b.positionM &&
    a.foundAt === b.foundAt
  )
}

export function sameDiffFields(a: ConflictField[], b: ConflictField[]): boolean {
  return a.length === b.length && a.every((field) => b.includes(field))
}
