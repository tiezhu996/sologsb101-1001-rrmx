import { DEFECT_TYPES, SEVERITIES, type DefectType, type Severity } from '@/types/defect'
import { SEGMENT_FACES, type SegmentFace } from '@/types/segment'
import { fieldRowFingerprint } from '@/types/reconcile'

/** 解析后的一行现场记录（尚未赋 id） */
export interface ParsedFieldRow {
  sourceLine: number
  turbineCode: string
  bladeSerial: string
  segmentStartM: number
  segmentEndM: number
  type: DefectType
  severity: Severity
  lengthMm: number
  widthMm: number
  face: SegmentFace
  positionM: number
  foundAt: string
  inspector: string
  fingerprint: string
}

export interface ParseInspectionResult {
  ok: boolean
  rows: ParsedFieldRow[]
  /** 行级错误（源行号 → 错误信息） */
  errors: Array<{ line: number; message: string }>
  /** 批次内重复行（不影响解析，但写入时跳过） */
  duplicateLines: number[]
}

/** 表头中文别名 → 标准字段 */
const HEADER_ALIASES: Record<string, keyof ParsedFieldRow | 'ignore'> = {
  机组编号: 'turbineCode',
  机组: 'turbineCode',
  机组号: 'turbineCode',
  风机编号: 'turbineCode',
  风机号: 'turbineCode',
  叶片序号: 'bladeSerial',
  叶片: 'bladeSerial',
  叶片号: 'bladeSerial',
  分段起始: 'segmentStartM',
  起始米数: 'segmentStartM',
  分段开始: 'segmentStartM',
  段起始: 'segmentStartM',
  startM: 'segmentStartM',
  分段结束: 'segmentEndM',
  结束米数: 'segmentEndM',
  段结束: 'segmentEndM',
  endM: 'segmentEndM',
  分段区间: 'ignore',
  面位: 'face',
  检修面: 'face',
  缺陷类型: 'type',
  类型: 'type',
  严重程度: 'severity',
  等级: 'severity',
  程度: 'severity',
  长度: 'lengthMm',
  缺陷长度: 'lengthMm',
  长mm: 'lengthMm',
  宽度: 'widthMm',
  缺陷宽度: 'widthMm',
  宽mm: 'widthMm',
  展向位置: 'positionM',
  位置: 'positionM',
  位置m: 'positionM',
  positionM: 'positionM',
  发现日期: 'foundAt',
  巡检日期: 'foundAt',
  巡检人: 'inspector',
  负责人: 'inspector',
  填报人: 'inspector',
  备注: 'ignore'
}

/** 导入模板表头（顺序即列顺序） */
export const INSPECTION_HEADERS = [
  '机组编号',
  '叶片序号',
  '分段起始',
  '分段结束',
  '面位',
  '缺陷类型',
  '严重程度',
  '长度',
  '宽度',
  '展向位置',
  '发现日期',
  '巡检人'
] as const

/** 导入模板示例行 */
export const INSPECTION_TEMPLATE_TSV = [
  INSPECTION_HEADERS.join('\t'),
  'WT-A01\tA\t0.0\t22.8\tLE\t前缘腐蚀\t重度\t900\t40\t8.6\t2026-09-30\t外委检修一队',
  'WT-A01\tA\t22.8\t45.7\tPS\t裂纹\t轻度\t420\t3\t30.5\t2026-09-30\t外委检修一队'
].join('\n')

/** 拆分一行文本：优先按 Tab，其次按逗号；支持引号包裹 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (!quoted && char === delimiter) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function detectDelimiter(headerLine: string): string {
  const tabs = (headerLine.match(/\t/g) ?? []).length
  const commas = (headerLine.match(/,/g) ?? []).length
  return tabs >= commas ? '\t' : ','
}

function parseNumber(value: string): number | null {
  if (value === '') return null
  const normalized = value.replace(/[米mM毫]/g, '').replace(/,/g, '').trim()
  const num = Number(normalized)
  return Number.isFinite(num) ? num : null
}

function matchEnum<T extends string>(value: string, options: readonly T[]): T | null {
  const normalized = value.trim().toUpperCase()
  const hit = options.find((option) => option.toUpperCase() === normalized)
  return hit ?? null
}

function todayString(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

/**
 * 解析外委离线巡检表（TSV / CSV）。
 * 表头支持常见中文别名；无法解析的行进 errors，批次内完全重复行进 duplicateLines。
 */
export function parseInspectionSheet(text: string): ParseInspectionResult {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line, index) => index === 0 || line.trim().length > 0)

  if (lines.length < 2) {
    return { ok: false, rows: [], errors: [{ line: 1, message: '内容为空或缺少表头 / 数据行' }], duplicateLines: [] }
  }

  const delimiter = detectDelimiter(lines[0])
  const headerCells = splitLine(lines[0], delimiter).map((cell) => cell.trim())
  const columnMap: Array<{ key: keyof ParsedFieldRow | 'ignore'; index: number }> = []
  headerCells.forEach((cell, index) => {
    const key = HEADER_ALIASES[cell] ?? HEADER_ALIASES[cell.replace(/\s/g, '')]
    if (key) columnMap.push({ key, index })
  })

  const required: Array<keyof ParsedFieldRow> = [
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
  const presentKeys = new Set(columnMap.filter((item) => item.key !== 'ignore').map((item) => item.key))
  const missing = required.filter((key) => !presentKeys.has(key))
  if (missing.length > 0) {
    return {
      ok: false,
      rows: [],
      errors: [{ line: 1, message: `表头缺少必需列：${missing.join('、')}（可下载模板对照）` }],
      duplicateLines: []
    }
  }

  const rows: ParsedFieldRow[] = []
  const errors: Array<{ line: number; message: string }> = []
  const seen = new Set<string>()
  const duplicateLines: number[] = []

  for (let i = 1; i < lines.length; i += 1) {
    const sourceLine = i + 1
    const cells = splitLine(lines[i], delimiter)
    const valueOf = (key: keyof ParsedFieldRow): string => {
      const column = columnMap.find((item) => item.key === key)
      return column ? cells[column.index] ?? '' : ''
    }

    const turbineCode = valueOf('turbineCode').trim()
    const bladeSerial = valueOf('bladeSerial').trim().toUpperCase()
    const segmentStartM = parseNumber(valueOf('segmentStartM'))
    const segmentEndM = parseNumber(valueOf('segmentEndM'))
    const lengthMm = parseNumber(valueOf('lengthMm'))
    const widthMm = parseNumber(valueOf('widthMm'))
    const positionM = parseNumber(valueOf('positionM'))
    const face = matchEnum(valueOf('face'), SEGMENT_FACES)
    const type = matchEnum(valueOf('type'), DEFECT_TYPES)
    const severity = matchEnum(valueOf('severity'), SEVERITIES)
    const foundAt = valueOf('foundAt').trim() || todayString()
    const inspector = valueOf('inspector').trim()

    const problems: string[] = []
    if (!turbineCode) problems.push('机组编号为空')
    if (!bladeSerial) problems.push('叶片序号为空')
    if (segmentStartM === null || segmentEndM === null) problems.push('分段区间不是数字')
    else if (segmentStartM >= segmentEndM) problems.push('分段起始需小于结束')
    if (lengthMm === null || widthMm === null || lengthMm <= 0 || widthMm <= 0)
      problems.push('长 / 宽需为正数（毫米）')
    if (positionM === null || positionM < 0) problems.push('展向位置无效')
    if (!face) problems.push(`面位需为 ${SEGMENT_FACES.join('/')}`)
    if (!type) problems.push(`类型需为 ${DEFECT_TYPES.join('/')}`)
    if (!severity) problems.push(`等级需为 ${SEVERITIES.join('/')}`)

    if (problems.length > 0 || !face || !type || !severity) {
      errors.push({ line: sourceLine, message: problems.join('；') || '字段无效' })
      continue
    }

    const fingerprint = fieldRowFingerprint({
      turbineCode,
      bladeSerial,
      segmentStartM: segmentStartM as number,
      segmentEndM: segmentEndM as number,
      face,
      type,
      positionM: positionM as number,
      severity,
      lengthMm: lengthMm as number,
      widthMm: widthMm as number
    })
    if (seen.has(fingerprint)) {
      duplicateLines.push(sourceLine)
      continue
    }
    seen.add(fingerprint)

    rows.push({
      sourceLine,
      turbineCode,
      bladeSerial,
      segmentStartM: segmentStartM as number,
      segmentEndM: segmentEndM as number,
      type,
      severity,
      lengthMm: lengthMm as number,
      widthMm: widthMm as number,
      face,
      positionM: positionM as number,
      foundAt,
      inspector,
      fingerprint
    })
  }

  return { ok: errors.length === 0, rows, errors, duplicateLines }
}
