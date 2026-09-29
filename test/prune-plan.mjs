// pi-ai 旧版本清理的保留规则（issue #4）。
//
// 删目录是不可逆动作，所以规则单独做成纯函数（planPrune）先算清楚再动手：
//   1. 正在用 / 等重启生效的那版绝不删；
//   2. 版本不高于本机已有的最好那份（dsh 自带、兜底依赖，含同名版本）→ 删（重复副本）；
//   3. 比本机新的只留最新 keep 份。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPrune, planPrune } from '../lib/updater.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

const versionsOf = (plan) => plan.remove.map((entry) => entry.version).sort().join(',')
const keptOf = (plan) => plan.keep.join(',')

// 1) 和宿主/兜底依赖同版本的下载副本：删（候选排序也不会再选它）
let plan = planPrune(['0.85.1'], '0.85.1', [])
check('与本机同版本的重复副本被清掉', versionsOf(plan) === '0.85.1')
check('重复副本的理由写清楚', plan.remove[0].reason.indexOf('重复副本') !== -1)
check('没有剩下的版本', keptOf(plan) === '')

// 2) 比本机新的那版要留（它就是热更新的意义）
plan = planPrune(['0.85.1', '0.86.0'], '0.85.1', [])
check('比本机新的留下', keptOf(plan) === '0.86.0')
check('低于本机的那份被清掉', versionsOf(plan) === '0.85.1')

// 3) 正在用的那份绝不动（哪怕它低于本机版本）
plan = planPrune(['0.85.1'], '0.86.1', ['0.85.1'])
check('正在用的版本受保护', versionsOf(plan) === '' && keptOf(plan) === '0.85.1')

// 4) 没有本机参照时只按「留最新 keep 份」收缩
plan = planPrune(['0.86.0', '0.87.0', '0.88.0'], undefined, [])
check('没有本机参照时只留最新一份', keptOf(plan) === '0.88.0' && versionsOf(plan) === '0.86.0,0.87.0')
plan = planPrune(['0.86.0', '0.87.0', '0.88.0'], undefined, [], 2)
check('keep=2 时留两份', keptOf(plan) === '0.87.0,0.88.0' && versionsOf(plan) === '0.86.0')

// 5) 等重启生效的那版（status.json 的 needsRestart）不能被当成「旧版本」清掉，
//    也不能因为「只留最新 1 份」被挤掉
plan = planPrune(['0.86.0', '0.87.0', '0.88.0'], '0.85.1', ['0.86.0'])
check('待生效的那版受保护', keptOf(plan) === '0.86.0,0.88.0')
check('受保护的版本不占「最新 keep 份」的名额', versionsOf(plan) === '0.87.0')

// 6) 输入顺序不影响结论
plan = planPrune(['0.88.0', '0.86.0', '0.87.0'], '0.85.1', [])
check('乱序输入结论一致', keptOf(plan) === '0.88.0' && versionsOf(plan) === '0.86.0,0.87.0')

// 7) 空目录：什么都不删
plan = planPrune([], '0.85.1', [])
check('没有下载档时是空计划', plan.remove.length === 0 && plan.keep.length === 0)

// ---- 真删路径：拿临时目录完整跑一遍 applyPrune ----
//
// 这条是补出来的：只测纯函数时，「缓存目录在插件目录之外、被 allowedRoot 校验拦住后又被
// catch 吞掉」这种 bug 一路漏到复查（缓存永远清不掉）。所以这里必须真的建目录、真的删。
const root = mkdtempSync(join(tmpdir(), 'dsh-prune-'))
const versionsDir = join(root, 'vendor', 'pi-ai')
const legacyCache = join(root, 'vendor', '.npm-cache')
const tmpCache = join(root, 'tmp-npm-cache') // 现在缓存放在系统临时目录：在 vendor 之外
function makeVersion(version) {
  mkdirSync(join(versionsDir, version, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(versionsDir, version, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version }))
  writeFileSync(join(versionsDir, version, 'node_modules', 'dep', 'index.js'), 'x'.repeat(4096))
}
function makeCache(dir) {
  mkdirSync(join(dir, '_cacache', 'content-v2'), { recursive: true })
  writeFileSync(join(dir, '_cacache', 'content-v2', 'blob'), 'y'.repeat(8192))
}
for (const version of ['0.85.1', '0.86.0', '0.87.0']) makeVersion(version)
makeCache(legacyCache)
makeCache(tmpCache)

const result = applyPrune({
  versionsDir,
  cacheDirs: [legacyCache, tmpCache],
  installed: ['0.85.1', '0.86.0', '0.87.0'],
  bestLocal: '0.85.1',
  protectedVersions: ['0.87.0'],
  keep: 1,
})
check('重复副本（≤ 本机版本）被删掉', !existsSync(join(versionsDir, '0.85.1')))
check('待生效的那版留着', existsSync(join(versionsDir, '0.87.0')))
check('比本机新的那份按 keep 留着', existsSync(join(versionsDir, '0.86.0')))
check('插件目录里的老缓存被删掉', !existsSync(legacyCache))
check('系统临时目录里的缓存也被删掉（允许根不能只认 vendor/）', !existsSync(tmpCache))
check('释放字节数大于 0', result.freedBytes > 0)
check('删除项都带原因', result.removed.every((entry) => typeof entry.reason === 'string' && entry.reason !== ''))
check('声明保留的版本都在', result.kept.join(',') === '0.86.0,0.87.0')

// 全部被保护时不误删
const keepAll = applyPrune({
  versionsDir,
  installed: ['0.86.0', '0.87.0'],
  bestLocal: '0.85.1',
  protectedVersions: ['0.86.0', '0.87.0'],
})
check('全受保护时一个都不删', keepAll.removed.length === 0 && existsSync(join(versionsDir, '0.86.0')))

console.log(failures === 0 ? 'prune-plan: 全部通过' : `prune-plan: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
