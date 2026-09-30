// pi-ai 体检测试。
//
// 两件事：能不能从 bundle 源码里读出它对 pi-ai 的 import 需求；体检能不能挡住
// 不兼容的候选——尤其是"先体检一个坏的、再体检一个好的"这种组合，因为 Node 对
// 加载失败的 ESM 会留下半初始化记录，探针目录要是共用一条 URL，第二个必然误判成失败。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseSourceBundle,
  dshGeneration,
  glueGeneration,
  hostAnchors,
  hostDshTree,
  hostPackageEntries,
  orderCandidates,
  piAiCandidates,
  piAiRequirements,
  probePiAi,
  resolveSourceBundle,
} from '../lib/bridge.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

/** 造一个假 pi-ai 包：exports 表 + index.js + providers/all.js + api/*.lazy.js。 */
function fakePiAi({ index, api, exports: exportsMap }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-ai-probe-'))
  mkdirSync(join(root, 'providers'), { recursive: true })
  mkdirSync(join(root, 'api'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '1.0.0',
    type: 'module',
    exports: exportsMap ?? { '.': './index.js', './providers/*': './providers/*.js', './api/*': './api/*.js' },
  }))
  writeFileSync(join(root, 'index.js'), index ?? 'export const createModels = 1\nexport const createProvider = 1\nexport const getSupportedThinkingLevels = 1\nexport const isContextOverflow = 1\n')
  writeFileSync(join(root, 'providers', 'all.js'), 'export const builtinProviders = 1\nexport const getBuiltinModels = 1\nexport const getBuiltinProviders = 1\n')
  writeFileSync(join(root, 'api', 'anthropic-messages.lazy.js'), api ?? 'export const anthropicMessagesApi = 1\n')
  return root
}

// ---- 需求解析（照真实 bundle 的写法）----
const bundleLike = [
  'import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";',
  'import { createModels, createProvider, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";',
  'import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";',
  'import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";',
  '',
  'const name = "llm-pi-ai";',
].join('\n')
const requirements = piAiRequirements(bundleLike)
check('抠出 3 条 pi-ai import', requirements.length === 3)
check('子路径列表正确',
  requirements.map((r) => r.specifier).join(' ') ===
  '@earendil-works/pi-ai @earendil-works/pi-ai/providers/all @earendil-works/pi-ai/api/anthropic-messages.lazy')
check('具名导出解析正确',
  requirements[0].names.join(',') === 'createModels,createProvider,getSupportedThinkingLevels,isContextOverflow')
check('dsh 自己的包不算进来', requirements.every((r) => r.specifier.startsWith('@earendil-works/pi-ai')))
check('没有 pi-ai import 时返回空数组', piAiRequirements('import { x } from "node:fs"').length === 0)

// ---- 体检：能用的通过 ----
const good = fakePiAi({})
check('兼容的 pi-ai 通过', probePiAi(requirements, good, 'good').ok === true)

// ---- 体检：导出改名被挡住 ----
const renamed = fakePiAi({ index: 'export const 改过名了 = 1\n' })
const r1 = probePiAi(requirements, renamed, 'renamed')
check('导出改名被挡住', r1.ok === false)
check('错误信息点出缺哪个导出', String(r1.error).includes('createModels'))

// ---- 体检：子路径被删掉也被挡住 ----
const noSubpath = fakePiAi({ exports: { '.': './index.js' } })
check('子路径消失被挡住', probePiAi(requirements, noSubpath, 'nosub').ok === false)

// ---- 体检：目录不存在被挡住 ----
// 断言错误文案是「目录不存在」而不是别的：这句只可能来自 probePiAi 开头那句显式检查。
// 少了那句检查，探针会给不存在的候选建一条断链，Node 顺着往上找可能撞上主软链上那份
// 能用的 pi-ai，把不合格的候选误判成通过。
const missing = probePiAi(requirements, join(tmpdir(), 'pi-ai-不存在-xyz'), 'missing')
check('目录不存在被挡住', missing.ok === false)
check('拒绝理由是「目录不存在」而不是顺着断链往上找到了别的', missing.error === '目录不存在')

// ---- 关键：坏候选体检完之后，好候选仍然能通过（探针 URL 不能互相污染）----
const r2 = probePiAi(requirements, good, 'good-again')
check('坏 → 好 的顺序下，好候选仍通过', r2.ok === true)

// ---- 需求解析不出来时只检查目录在不在 ----
check('无需求 + 目录存在 → 通过', probePiAi([], good, 'noreq').ok === true)
check('无需求 + 目录不存在 → 不通过', probePiAi([], join(tmpdir(), 'pi-ai-无-xyz'), 'noreq2').ok === false)
// ---- 候选列表 ----
const candidates = piAiCandidates()
check('候选里必有兜底依赖档', candidates.some((c) => c.key === 'dependency'))
check('兜底依赖档不挂软链', candidates.find((c) => c.key === 'dependency').link === false)
// dsh 自带那一档的目录是沿解析链找出来的：dsh 没装/依赖没装时它可以缺席，
// 但在场时必须排在**本机来源**的最后（下载档里版本不高于本机那份的会排到本机来源之后，
// 见 orderCandidates 的 tie-break），且是挂软链的那一档。
const dshTier = candidates.find((c) => c.key === 'dsh')
const localKeys = candidates.filter((c) => c.key === 'dsh' || c.key === 'dependency').map((c) => c.key)
check('dsh 自带档在场时是本机来源里最后一个且挂软链',
  dshTier === undefined || (localKeys[localKeys.length - 1] === 'dsh' && dshTier.link === true))
check('每档都有 key/version/root', candidates.every((c) => c.key && c.version !== undefined && c.root !== undefined))

// ---- 候选排序：同版本优先复用本机那份（issue #4 第 2 条）----
const dl = (version) => ({ key: version, version, root: '/tmp/pi-ai/' + version, link: true })
const dep = { key: 'dependency', version: '0.85.1', root: '/tmp/vendor/pi-ai', link: false }
const dsh = { key: 'dsh', version: '0.85.1', root: '/tmp/dsh/pi-ai', link: true }
const keysOf = (list) => list.map((c) => c.key).join(',')

check('下载档比本机新 → 排最前', keysOf(orderCandidates([dl('0.86.0')], [dep, dsh])) === '0.86.0,dependency,dsh')
check('下载档与本机同版本 → 排到本机来源之后（不抢热更新档）',
  keysOf(orderCandidates([dl('0.85.1')], [dep, dsh])) === 'dependency,dsh,0.85.1')
check('下载档比本机旧 → 同样排到后面', keysOf(orderCandidates([dl('0.84.0')], [dep, dsh])) === 'dependency,dsh,0.84.0')
check('新旧混合：新的在前、重复的在后',
  keysOf(orderCandidates([dl('0.86.0'), dl('0.85.1')], [dep, dsh])) === '0.86.0,dependency,dsh,0.85.1')
check('门槛取本机两份里最高的那份（不是只看依赖档）',
  keysOf(orderCandidates([dl('0.86.5'), dl('0.86.0')], [dep, { ...dsh, version: '0.86.0' }])) === '0.86.5,dependency,dsh,0.86.0')
check('本机版本读不出（占位串）时不参与比较',
  keysOf(orderCandidates([dl('0.85.1')], [{ ...dep, version: '内置依赖' }])) === '0.85.1,dependency')
check('没有本机档时下载档照旧在前', keysOf(orderCandidates([dl('0.85.1')], [])) === '0.85.1')
check('本机两份的相对顺序不变（依赖在前）', keysOf(orderCandidates([], [dep, dsh])) === 'dependency,dsh')

// ---- 官方 bundle（胶水层）的挑法：宿主跑哪棵树，就用哪棵树里那份 ----
// 实测的背景：Desktop 的宿主跑 app.asar 里那份（dsh 0.2.0-rc.2 + pi-ai 0.87.1），而 CLI 安装树里
// 还躺着 0.1.6-alpha.2 + pi-ai 0.85.1。按路径顺序先撞上 CLI 的，就会拿 0.1.x 胶水挂 0.2.x 宿主，
// pi-ai 也跟着串成 0.85.1——用户看到的是「模型 id 突然对不上」（deepseek-flash vs deepseek-v4-flash）。

check('胶水代次：有 installSection 的是 0.1.x 胶水', glueGeneration('x.installSection(y)') === 'legacy')
check('胶水代次：有 settings.configure 的是 0.2.x 胶水', glueGeneration('x.settings.configure({})') === 'modern')
check('胶水代次：都认不出就是 unknown', glueGeneration('whatever') === 'unknown')
check('宿主代次：0.1.x → legacy', dshGeneration('0.1.6-alpha.2') === 'legacy')
check('宿主代次：0.2.x → modern', dshGeneration('0.2.0-rc.2') === 'modern')
check('宿主代次：读不到版本 → unknown', dshGeneration(undefined) === 'unknown')

// 锚点：Electron 下 app.asar 必须排最前
const withElectron = hostAnchors({ resourcesPath: '/R', execPath: '/R/App', pluginRoot: '/P', dshHome: '/H' })
check('Electron 下 app.asar 锚点排最前', withElectron[0].indexOf('app.asar') !== -1 && withElectron[0].startsWith('/R'))
check('Electron 下 app.asar.unpacked 也在前面', withElectron[1].indexOf('app.asar.unpacked') !== -1)
check('非 Electron 不带 app.asar 锚点',
  hostAnchors({ execPath: '/usr/bin/node', pluginRoot: '/P', dshHome: '/H' }).every((a) => a.indexOf('app.asar') === -1))

// 纯函数：候选挑法
const desc = (path, generation) => ({ path, generation })
const readOf = (map) => (path) => map[path]
const hostTree = '/HOST'
const modernPath = '/HOST/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const legacyPath = '/CLI/lib/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const read = readOf({
  [modernPath]: 'settings.configure({})',
  [legacyPath]: 'settings.installSection(ctx, NS, Config, config, {})',
})
check('宿主树 + 代次都对的排最前',
  chooseSourceBundle([legacyPath, modernPath], { hostTree, hostGeneration: 'modern', read })?.reason === 'host-tree+generation')
check('宿主树里那份代次不对时，退而选代次对的那份（这次的串台 bug 就是这条）', (() => {
  const chosen = chooseSourceBundle([legacyPath, modernPath], { hostTree: '/CLI-TREE', hostGeneration: 'modern', read })
  return chosen?.path === modernPath && chosen.reason === 'generation'
})())
check('代次认不出来时优先宿主树里那份',
  chooseSourceBundle([legacyPath, modernPath], { hostTree, hostGeneration: 'unknown', read })?.reason === 'host-tree')
check('什么都不匹配就用第一个（与改造前一致）',
  chooseSourceBundle([legacyPath], { hostGeneration: 'modern', read })?.reason === 'first')
check('没有候选就是 undefined', chooseSourceBundle([], { hostGeneration: 'modern', read }) === undefined)

// 端到端：拿真实文件系统搭一份「app.asar（0.2.x）+ CLI 树（0.1.x）」，看选中谁
const root = mkdtempSync(join(tmpdir(), 'dsh-glue-'))
try {
  const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  // app.asar 那棵：dsh 0.2.0-rc.2 + modern 胶水
  write(join(root, 'app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  write(join(root, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '0.2.0-rc.2' }))
  write(join(root, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), 'child.settings.configure({ auto: false }, ctx.fiber)\n')
  // CLI 那棵：dsh 0.1.6-alpha.2 + legacy 胶水
  write(join(root, 'cli/lib/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2' }))
  write(join(root, 'cli/lib/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '0.1.6-alpha.2' }))
  write(join(root, 'cli/lib/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), 'settings.installSection(ctx, NS, Config, config, {})\n')
  const env = { resourcesPath: root, execPath: join(root, 'cli/bin/node'), pluginRoot: join(root, 'plugin'), dshHome: join(root, 'home') }
  check('宿主树判成 app.asar 那棵', hostDshTree(env) === join(root, 'app.asar/dsh'))
  check('候选里两个都在，asar 的排最前',
    hostPackageEntries('@deepseek-ai/dsh-llm-pi-ai', env)[0] === join(root, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'))
  const picked = resolveSourceBundle(env)
  check('Electron 下选中 app.asar 那份（0.2.0-rc.2 胶水）',
    picked?.path === join(root, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js') && picked?.version === '0.2.0-rc.2')
  check('选中理由带上了宿主树+代次', picked?.reason === 'host-tree+generation')
  // 不带 resourcesPath（普通 CLI 启动）：就该用 CLI 那棵里的
  const cliEnv = { execPath: join(root, 'cli/bin/node'), pluginRoot: join(root, 'plugin'), dshHome: join(root, 'home') }
  const cliPicked = resolveSourceBundle(cliEnv)
  check('CLI 启动下选中安装树那份（0.1.6-alpha.2 胶水）', cliPicked?.version === '0.1.6-alpha.2')
} finally {
  rmSync(root, { recursive: true, force: true })
}


console.log(failures === 0 ? '\npi-ai 体检测试全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)

