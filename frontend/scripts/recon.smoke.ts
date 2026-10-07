/* 对账纯逻辑冒烟测试：解析 → 指纹 → 匹配 → 差异 */
import { parseFieldSheet, fingerprintOfRows, buildLocalIndex, matchFieldRecord, diffOf } from '../src/utils/recon'
import type { FieldRowInput } from '../src/types/fieldBatch'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

const SHEET = [
  '机组编号\t叶片序号\t分段起点(m)\t分段终点(m)\t面位\t类型\t严重程度\t长度(mm)\t宽度(mm)\t展向位置(m)\t发现日期',
  'WT-A01\tA\t22.83\t45.67\tLE\t裂纹\t重度\t1450\t6\t29.68\t2026-09-11',
  'WT-A01\tA\t0\t22.83\tPS\t前缘腐蚀\t重度\t900\t36\t6.85\t2026-09-20',
  'WT-A01\tB\t0\t22.83\tPS\t砂眼\t轻度\t8\t6\t3.25\t2026-10-01',
  'WT-C99\tA\t0\t20\tPS\t裂纹\t轻度\t100\t5\t3\t2026-10-01'
].join('\n')

console.log('--- 解析 TSV ---')
const parsed = parseFieldSheet(SHEET)
check('无解析错误', parsed.errors.length === 0)
check('解析出 4 行', parsed.rows.length === 4)
check('机组编号归一化', parsed.rows[0]?.turbineCode === 'WT-A01')
check('面位解析', parsed.rows[0]?.face === 'LE')
check('日期解析', parsed.rows[0]?.foundAt === '2026-09-11')

console.log('--- 解析 CSV 与坏行 ---')
const csv = '机组编号,叶片序号,分段起点,分段终点,面位,类型,严重程度,长度,宽度,展向位置,发现日期\nWT-A01,A,0,22.83,迎风面,砂眼,轻,12,9,3.5,2026/9/1'
const csvParsed = parseFieldSheet(csv)
check('CSV 无错误', csvParsed.errors.length === 0)
check('中文面位 → PS', csvParsed.rows[0]?.face === 'PS')
check('轻 → 轻度', csvParsed.rows[0]?.severity === '轻度')
check('日期归一化', csvParsed.rows[0]?.foundAt === '2026-09-01')
const bad = parseFieldSheet('机组编号,叶片序号,分段起点,分段终点,面位,类型,严重程度,长度,宽度,展向位置\nWT-A01,A,0,22.83,XX,未知,重度,1,1,3')
check('坏面位报错', bad.errors.some((e) => e.includes('面位')))
check('坏类型报错', bad.errors.some((e) => e.includes('类型')))
check('缺列报错', parseFieldSheet('机组编号,叶片序号\nWT-A01,A').errors.some((e) => e.includes('缺少必需列')))

console.log('--- 指纹幂等 ---')
const again = parseFieldSheet(SHEET)
check('同内容指纹一致', fingerprintOfRows(parsed.rows) === fingerprintOfRows(again.rows))
const changed: FieldRowInput[] = parsed.rows.map((r, i) => (i === 0 ? { ...r, lengthMm: r.lengthMm + 1 } : r))
check('内容变化指纹不同', fingerprintOfRows(parsed.rows) !== fingerprintOfRows(changed))

console.log('--- 匹配 ---')
const turbine = { id: 't1', code: 'WT-A01', model: 'm', hubHeightM: 1, commissionDate: '2021-01-01', bladeCount: 2, createdAt: 1, updatedAt: 1 }
const bladeA = { id: 'bA', turbineId: 't1', serial: 'A' as const, lengthM: 68.5, material: '玻璃纤维' as const, segmentCount: 3, createdAt: 1, updatedAt: 1 }
const bladeB = { ...bladeA, id: 'bB', serial: 'B' as const }
const seg1 = { id: 's1', bladeId: 'bA', index: 1, startM: 0, endM: 22.83, airfoil: '', face: 'PS' as const, sectionImage: '', createdAt: 1, updatedAt: 1 }
const seg2 = { ...seg1, id: 's2', index: 2, startM: 22.83, endM: 45.67, face: 'LE' as const }
const segB1 = { ...seg1, id: 'sB1', bladeId: 'bB' }
const localDefect = {
  id: 'd1', segmentId: 's2', type: '裂纹' as const, severity: '重度' as const,
  lengthMm: 1450, widthMm: 6, face: 'LE' as const, positionM: 29.68, foundAt: '2026-09-11',
  state: '待处理' as const, createdAt: 1, updatedAt: 1
}
const index = buildLocalIndex([turbine], [bladeA, bladeB], [seg1, seg2, segB1], [localDefect])
const claimed = new Map<string, string>()
const created = new Set<string>()

const r0 = matchFieldRecord(parsed.rows[0], { index, toleranceM: 0.5, claimed, createdIds: created })
check('完全一致 → matched', r0.kind === 'matched')

const conflictRow: FieldRowInput = { ...parsed.rows[0], severity: '中度', lengthMm: 1400 }
const r1 = matchFieldRecord(conflictRow, { index, toleranceM: 0.5, claimed, createdIds: created })
check('等级+长度不同 → conflict', r1.kind === 'conflict' && r1.diffFields.join(',') === 'severity,lengthMm')

const farRow: FieldRowInput = { ...parsed.rows[0], positionM: 40 }
const r2 = matchFieldRecord(farRow, { index, toleranceM: 0.5, claimed, createdIds: created })
check('超出容差 → new', r2.kind === 'new')

const r3 = matchFieldRecord(parsed.rows[2], { index, toleranceM: 0.5, claimed, createdIds: created })
check('无候选 → new', r3.kind === 'new')

const r4 = matchFieldRecord(parsed.rows[3], { index, toleranceM: 0.5, claimed, createdIds: created })
check('机组不存在 → unmatched', r4.kind === 'unmatched')

claimed.set('d1', 'rec-0')
const r5 = matchFieldRecord(parsed.rows[0], { index, toleranceM: 0.5, claimed, createdIds: created })
check('已被占位 → duplicate', r5.kind === 'duplicate')

const nearRow: FieldRowInput = { ...parsed.rows[0], positionM: 29.9 }
const r6 = matchFieldRecord(nearRow, { index, toleranceM: 0.5, claimed: new Map(), createdIds: created })
check('容差内偏移仍命中', r6.kind === 'matched')

const diff = diffOf(localDefect, { ...parsed.rows[0], widthMm: 9 })
check('diffOf 只报宽度', diff.join(',') === 'widthMm')

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
