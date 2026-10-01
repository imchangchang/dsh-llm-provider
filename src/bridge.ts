/**
 * pi-ai 桥接层：让 dsh 的官方 llm-pi-ai 适配器跑在我们自己维护的新版 pi-ai 上。
 *
 * 原理：
 *   官方已装的 @deepseek-ai/dsh-llm-pi-ai/lib/index.js 是单文件 bundle，对
 *   @earendil-works/pi-ai 全部走 bare specifier 外部导入（含 api/*.lazy、
 *   providers/all 这些 lazy 协议实现）。把这份 bundle 拷进本插件的
 *   vendor/llm-bridge/，旁边放一个 node_modules/@earendil-works/pi-ai 软链
 *   指向 vendor/pi-ai/<版本>/，Node 的解析就会把拷贝副本接到我们的新版 pi-ai。
 *   结果：模型目录 + wire 协议实现来自上游最新，dsh 的转换胶水层保持稳定。
 *
 * 升级 = 换软链指向 + 拷一份新 bundle，回滚 = 把热更新那版删掉（自动落回内置依赖）。
 *
 * 用哪份 pi-ai 是**加载前先体检**挑出来的，不是"先试再退"：ESM 加载失败后同一个文件
 * 没法重试（Node 会报 "not yet fully loaded"）。候选与体检见 piAiCandidates/probePiAi。
 *
 * 边界：本模块只写插件自己的 vendor/ 目录，pi-ai 本身的文件一个字节都不改——改第三方包的
 * 文件不可复现，也没法保证跟 lockfile 对得上。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './dsh-home.js'
import { asRecord, readString, type AnyRecord } from './types.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const vendorDir = join(pluginRoot, 'vendor')
const bridgeDir = join(vendorDir, 'llm-bridge')
const bridgeLib = join(bridgeDir, 'lib', 'index.js')
const piAiVersionsDir = join(vendorDir, 'pi-ai')
const statusFile = join(vendorDir, 'status.json')

const BRIDGE_PACKAGE_JSON = JSON.stringify({
  name: 'dsh-llm-provider-llm-bridge',
  version: '0.0.0',
  type: 'module',
  main: 'lib/index.js',
  exports: { '.': './lib/index.js', './package.json': './package.json' },
}, null, 2)

/** 桥接副本模块（官方那份 bundle 的形状：我们用到的两样）。 */
export interface BridgePluginModule {
  apply: (ctx: unknown, config: unknown) => void
  Config?: unknown
  [key: string]: unknown
}

/** 一次体检里被跳过的候选。 */
export interface RejectedCandidate {
  version: string
  error?: string
}

/** 体检结果。`unverified` = 需求没解析出来，体检没跑，放行但不算「通过」。 */
export interface ProbeResult {
  ok: boolean
  unverified?: boolean
  error?: string
}

/** loadBridge() 的结果：成功带模块，失败带原因。 */
export type BridgeLoadResult =
  | {
      ok: true
      plugin: BridgePluginModule
      piAiVersion: string
      piAiSource: string
      /** 拷来挂的那份官方 bundle 的版本号（读不到就没有）。 */
      bundleVersion?: string
      /** bundle 的入口文件绝对路径（「换源时强制重拷」就靠它比）。 */
      bundlePath: string
      /** 它来自哪棵树（短标签，如 `app.asar` / `profile` / `dsh-install`）。 */
      bundleTree: string
      /** 生效那份 pi-ai 的包目录（悬浮提示里给出来，方便核对到底加载了哪个副本）。 */
      piAiPath: string
      /** 它的来源：`desktop`（app.asar）/ `dsh-install` / `profile` / `vendor` / `plugin`。 */
      piAiOrigin: string
      /** 需求没解析出来、体检没跑：选中项是靠「目录存在」放行的，没验证过 */
      probeUnverified: boolean
      rejected: RejectedCandidate[]
    }
  | { ok: false; error: string }

/** 一份 pi-ai 候选。`link: false` 表示不建软链、靠自然解析落到它。 */
export interface PiAiCandidate {
  key: string
  version: string
  root: string
  link: boolean
}

/** 从 bundle 源码里抠出来的一条 import 需求。 */
export interface PiAiRequirement {
  specifier: string
  names: string[]
}

/** vendor/pi-ai/ 下已就位的版本目录（有 node_modules 的才算就位）。 */
export function installedVersions(): string[] {
  try {
    return readdirSync(piAiVersionsDir)
      .filter((name) => existsSync(join(piAiVersionsDir, name, 'package.json'))
        && existsSync(join(piAiVersionsDir, name, 'node_modules')))
      .sort(compareVersions)
  } catch {
    return []
  }
}

/**
 * semver 数字比较，够用即可（pi-ai 是 0.x.y 格式）。
 *
 * 预发布 tag（0.86.0-beta.1）这类非纯数字段 Number() 出来是 NaN，NaN 参与比较时
 * `diff !== 0` 永远为真，会把整个排序搅乱（installedVersions 的 sort、updater 的
 * 「已是最新」判断都吃它）。这里把解析不出的段当 0：0.86.0-beta.1 与 0.86.0 视为同版。
 * pi-ai 目前没有预发布版本，这只是防 NaN 的守卫，不追求完整 semver 语义。
 */
export function compareVersions(a: string, b: string): number {
  const nums = (version: string): number[] => version.split('.').map((part) => Number(part) || 0)
  const pa = nums(a)
  const pb = nums(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 从一个文件位置出发，沿 node_modules 链找出某个包的**包目录**。
 *
 * 用它代替手拼路径：包的依赖可能被提升到上层 node_modules（pnpm 的 hoisted 布局、dsh 把
 * bundle 放在自己的安装目录里……）。手拼 `$DSH_HOME/profiles/node_modules/<包名>` 这类路径，
 * dsh 换个布局就落空；沿解析链找，跟运行时真正会加载的那份永远一致。
 *
 * 刻意**不用** `require.resolve()`：那只认包 `exports` 里给 `require` 条件的入口，而 pi-ai
 * 的 `exports["."]` 只声明了 `import`（0.84.x 就是这样），纯解析会报
 * ERR_PACKAGE_PATH_NOT_EXPORTED。我们要的是包目录本身，逐层找
 * `node_modules/<包名>/package.json` 就够了，与 exports 怎么写无关。
 * @param fromFile - 解析起点（文件不必存在），通常是解析的用例方。
 * @param specifier - 包名。
 * @returns 包目录（绝对路径）；找不到返回 undefined。
 */
function resolvePackageRoot(fromFile: string, specifier: string): string | undefined {
  const parts = specifier.split('/')
  let dir = dirname(fromFile)
  for (;;) {
    const candidate = join(dir, 'node_modules', ...parts)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 解析宿主包时的环境信号（可注入，便于离线测试）。 */
export interface HostEnv {
  /** Electron 的 `process.resourcesPath`；非 Electron 为 undefined。 */
  resourcesPath?: string
  /** `process.execPath`。 */
  execPath: string
  /** 插件自己的根目录。 */
  pluginRoot: string
  /** `$DSH_HOME`；拿不到就不传。 */
  dshHome?: string
  /**
   * 正在跑这个插件的那个 dsh 的入口脚本（`process.argv[1]` 解开软链、并确认它确实落在
   * `@deepseek-ai/dsh` 包里之后）。见 {@link runningDshEntry}。
   */
  entryFile?: string
}

/** 当前进程的环境信号。 */
export function currentHostEnv(): HostEnv {
  let dshHome: string | undefined
  try {
    dshHome = resolveDshHome()
  } catch { /* 拿不到 DSH_HOME 就少一个锚点 */ }
  const resourcesPath = (process as unknown as { resourcesPath?: unknown })['resourcesPath']
  const entryFile = runningDshEntry()
  return {
    ...(typeof resourcesPath === 'string' && resourcesPath !== '' ? { resourcesPath } : {}),
    execPath: process.execPath,
    pluginRoot,
    ...(dshHome === undefined ? {} : { dshHome }),
    ...(entryFile === undefined ? {} : { entryFile }),
  }
}

/**
 * 正在跑这个插件的那个 dsh 的入口脚本——`process.argv[1]`，两道过滤之后才认。
 *
 * 这是「宿主跑哪棵树」最直接的证据：不用猜，进程自己就知道自己是被谁拉起来的。两次实测
 * 决定了过滤怎么写：
 *   1. **要 realpath。**CLI 下 `argv[1]` 是软链那条路径（`~/.dsh/node-macos-arm64/bin/dsh`），
 *      不是包里的 `lib/bin.js`；照原样当锚点，顺着它往上找不到 dsh 包，这一档就白加了。
 *   2. **要确认它真的是 dsh 入口。**`argv[1]` 只要是"某个文件路径"就拿来当锚点的话，离线测试
 *      （`argv[1]` 是 `test/*.mjs`）、`node -e`、Electron 主进程都会命中，而顺着这些路径往上
 *      爬可能撞进一棵"有 `@deepseek-ai`、但没有 pi-ai"的树，把宿主树判错。实测过一次：在主检出
 *      里跑测试时，`test/*.mjs` 往上会撞到开发用的 `~/.dsh/profiles/node_modules` 软链。
 *      所以只认「入口文件落在解析出来的 `@deepseek-ai/dsh` 包目录里面」这一种。
 *
 * @returns dsh 入口文件的绝对路径（软链已解开）；不是 dsh 入口就拿不到。
 */
function runningDshEntry(): string | undefined {
  const raw = process.argv[1]
  if (typeof raw !== 'string' || raw === '' || !raw.includes(sep)) return undefined
  let entry: string
  try {
    entry = realpathSync(raw)
  } catch {
    return undefined
  }
  const dshRoot = resolvePackageRoot(entry, '@deepseek-ai/dsh')
  return dshRoot !== undefined && entry.startsWith(dshRoot + sep) ? entry : undefined
}

/**
 * 沿解析链找宿主包时的锚点文件（文件不必存在，只借它的路径当起点）。
 *
 * 顺序就是「谁更可能是宿主真正在跑的那棵树」，越靠前越优先：
 *   0. **Electron 应用自带的 dsh**（`<resourcesPath>/app.asar/dsh`）——Desktop 就从这儿跑。
 *      注意它的 pi-ai 与 CLI 安装树里的那份**不是同一版**（实测 Desktop 是 0.87.1，
 *      CLI 树是 0.85.1，两边的 DeepSeek 模型 id 都不一样），所以这一档必须排在前面。
 *   1. **正在跑这个插件的那个 dsh**（`process.argv[1]`，见 {@link runningDshEntry}）——Desktop 的
 *      `argv[1]` 不保证是 dsh 入口，所以这一档排在 Electron 自带那份之后；但 CLI、容器、
 *      非标准前缀安装这些场合，它是唯一"不用猜"的答案。
 *   2. `$DSH_HOME/profiles/node_modules`
 *   3. dsh 安装树（Windows 官方安装包在 `<node>/node_modules`，POSIX 在 `<node>/lib/node_modules`）
 *   4. 插件自己
 */
export function hostAnchors(env: HostEnv = currentHostEnv()): string[] {
  const anchors: string[] = []
  if (env.resourcesPath !== undefined) {
    anchors.push(join(env.resourcesPath, 'app.asar', 'dsh', 'node_modules', '_anchor.js'))
    anchors.push(join(env.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', '_anchor.js'))
  }
  if (env.entryFile !== undefined) anchors.push(env.entryFile)
  if (env.dshHome !== undefined) anchors.push(join(env.dshHome, 'profiles', 'node_modules', '_anchor.js'))
  const nodeDir = dirname(env.execPath)
  anchors.push(join(nodeDir, 'node_modules', '_anchor.js'))
  anchors.push(join(nodeDir, '..', 'lib', 'node_modules', '_anchor.js'))
  anchors.push(join(env.pluginRoot, '_anchor.js'))
  return anchors
}

/** 从一个锚点能想到的某个包的包目录（直接命中 + 嵌在 dsh 包自己的 node_modules 里）。 */
function packageRootsAt(anchor: string, specifier: string): string[] {
  const roots: string[] = []
  const direct = resolvePackageRoot(anchor, specifier)
  if (direct !== undefined) roots.push(direct)
  const dshRoot = resolvePackageRoot(anchor, '@deepseek-ai/dsh')
  if (dshRoot !== undefined) roots.push(join(dshRoot, 'node_modules', ...specifier.split('/')))
  return roots
}

/**
 * 一个包目录属于哪棵树（`<tree>/node_modules/<包>` → `<tree>`）。
 *
 * 往上找到第一个叫 `node_modules` 的祖先目录，它的父目录就是树根——这样 scoped 包
 * （`node_modules/@scope/name`，比非 scoped 多一层）也算得对。
 */
function treeOf(packageRoot: string): string {
  let dir = dirname(packageRoot)
  while (dir !== dirname(dir) && basename(dir) !== 'node_modules') dir = dirname(dir)
  return basename(dir) === 'node_modules' ? dirname(dir) : dirname(packageRoot)
}

/**
 * 宿主 dsh 自己那份安装树的根目录：按锚点顺序找 `@deepseek-ai/dsh` 的包目录，取它的树根。
 *
 * 这是「宿主到底在跑哪棵树」的判据——Desktop 下是 `<resourcesPath>/app.asar/dsh`，
 * CLI 下是 `~/.dsh/node-<平台>/lib/node_modules` 那一带。
 */
export function hostDshTree(env: HostEnv = currentHostEnv()): string | undefined {
  for (const anchor of hostAnchors(env)) {
    const root = resolvePackageRoot(anchor, '@deepseek-ai/dsh')
    if (root !== undefined) return treeOf(root)
  }
  return undefined
}

/**
 * 按锚点列出某个宿主包**全部**候选入口（顺序 = 锚点顺序，去重）。
 *
 * 与 {@link resolveSourceBundle} 同一套解析：包可能被提升到任意一层 node_modules，也可能嵌在
 * dsh 包自己的 node_modules 里。用的是宿主那一份——第三方插件自己再装一份同名包会带进第二份
 * cordis 运行时，服务注册就串了。
 *
 * @param specifier - 包名。
 * @param env - 环境信号（默认取当前进程的）。
 * @returns 入口文件绝对路径列表（可能为空）。
 */
export function hostPackageEntries(specifier: string, env: HostEnv = currentHostEnv()): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const anchor of hostAnchors(env)) {
    for (const root of packageRootsAt(anchor, specifier)) {
      if (seen.has(root)) continue
      seen.add(root)
      const entry = join(root, 'lib', 'index.js')
      if (existsSync(entry)) entries.push(entry)
    }
  }
  return entries
}

/**
 * 按锚点找一个宿主包（`@deepseek-ai` 下的包）的入口文件（第一个命中的）。
 *
 * @param specifier - 包名。
 * @param env - 环境信号（默认取当前进程的）。
 * @returns 入口文件绝对路径；找不到返回 undefined。
 */
export function hostPackageEntry(specifier: string, env: HostEnv = currentHostEnv()): string | undefined {
  return hostPackageEntries(specifier, env)[0]
}

/** 官方 bundle 的胶水代次：0.1.x 用 `settings.installSection`，0.2.x 用 `settings.configure`。 */
export type GlueGeneration = 'legacy' | 'modern' | 'unknown'

/**
 * 认一份 bundle 源码是哪一代胶水。
 *
 * 两代的分界实测过（同一份 dsh-llm-pi-ai）：0.1.6-alpha.2 调 `settings.installSection(`，
 * 0.2.0-rc.2 改成 `settings.configure(` + 只读传入的 config。
 */
export function glueGeneration(source: string): GlueGeneration {
  if (source.includes('installSection(')) return 'legacy'
  if (source.includes('settings.configure(')) return 'modern'
  return 'unknown'
}

/** 宿主 dsh 版本 → 它要哪一代胶水（0.1.x / 0.2.x 起）。 */
export function dshGeneration(version: string | undefined): GlueGeneration {
  if (version === undefined) return 'unknown'
  const match = /^(\d+)\.(\d+)/.exec(version)
  if (match === null) return 'unknown'
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 0 && minor <= 1) return 'legacy'
  if (major > 0 || minor >= 2) return 'modern'
  return 'unknown'
}

/** 选定的官方 bundle（桥接要拷的那份）。 */
export interface SourceBundle {
  /** bundle 入口文件绝对路径。 */
  path: string
  /** bundle 自己的版本号（读不到就没有）。 */
  version?: string
  /** 它属于哪棵树（诊断短标签）。 */
  tree: string
  /** 胶水代次。 */
  generation: GlueGeneration
  /** 为什么选它（日志/状态里要能看见）。 */
  reason: 'host-tree+generation' | 'generation' | 'host-tree' | 'first'
}

/** 路径的短标签：状态里一眼看出桥接用的是哪棵树。 */
export function treeLabel(tree: string, env: HostEnv = currentHostEnv()): string {
  if (env.resourcesPath !== undefined && tree.startsWith(join(env.resourcesPath, 'app.asar'))) return 'app.asar'
  if (env.dshHome !== undefined && tree.startsWith(join(env.dshHome, 'profiles'))) return 'profile'
  if (tree.startsWith(dirname(env.execPath))) return 'dsh-install'
  if (tree === env.pluginRoot) return 'plugin'
  return tree
}

/**
 * 生效的那份 pi-ai 来自哪儿（短标签）——`dsh 自带` 也要分 Desktop 与 CLI：
 * 两者是不同副本，版本可能不同（实测 Desktop 的 app.asar 是 0.87.1、CLI 安装树是 0.85.1，
 * 连模型 id 都不一样），界面上必须能分辨。
 *
 * @param root - pi-ai 包目录。
 * @param key - 候选的 key（版本号 / 'dependency' / 'dsh'）。
 * @param env - 环境信号。
 */
export function piAiOriginLabel(root: string, key: string, env: HostEnv = currentHostEnv()): string {
  if (env.resourcesPath !== undefined && root.startsWith(join(env.resourcesPath, 'app.asar'))) return 'desktop'
  if (root.includes(`${sep}vendor${sep}pi-ai${sep}`)) return 'vendor'
  if (key === 'dependency') return 'plugin'
  if (key === 'dsh') return treeLabel(treeOf(root), env)
  return 'vendor'
}

/**
 * 从候选里挑份能用的官方 bundle（纯函数，离线可测）。
 *
 * 排序理由（越靠前越优先）：
 *   1. **宿主自己那棵树里的、且胶水代次对得上**——宿主跑哪棵树，就用哪棵树里的那份；
 *   2. 胶水代次对得上的（宿主树里没有，或读不出来）；
 *   3. 宿主自己那棵树里的（代次认不出来时仍然优先宿主）；
 *   4. 第一个候选（跟改造前一样，找不到更好的就用它）。
 *
 * 「在宿主树里」按路径包含算：直接铺在 `<树>/node_modules/` 下算，嵌在
 * `<树>/node_modules/@deepseek-ai/dsh/node_modules/` 里也算（dsh 把自己的 bundle 放在包内）。
 *
 * 为什么非要对代次：Desktop 的宿主跑 `app.asar` 里那份（0.2.0-rc.2），而 CLI 安装树里
 * 还躺着 0.1.6-alpha.2 那份；按路径顺序先撞上 CLI 的，就会拿 0.1.x 胶水去挂 0.2.x 宿主，
 * pi-ai 也跟着串成 0.85.1——用户看到的就是「模型 id 突然对不上」。
 *
 * @param entries - {@link hostPackageEntries} 的结果（锚点顺序）。
 * @param options - 宿主树、宿主代次、读源码的方式。
 * @returns 选中项；候选为空时 undefined。
 */
export function chooseSourceBundle(
  entries: readonly string[],
  options: { hostTree?: string, hostGeneration: GlueGeneration, read?: (path: string) => string | undefined },
): SourceBundle | undefined {
  if (entries.length === 0) return undefined
  const read = options.read ?? ((path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  })
  const described = entries.map((path) => {
    const root = dirname(dirname(path))
    const source = read(path)
    return {
      path,
      root,
      version: piAiVersionOf(root),
      tree: treeOf(root),
      generation: source === undefined ? ('unknown' as GlueGeneration) : glueGeneration(source),
    }
  })
  // 「在宿主树里」按路径包含判，不是比 treeOf 相等：dsh 把自己的 bundle 放在包内的
  // `node_modules` 里（`<dsh 包>/node_modules/@deepseek-ai/dsh-llm-pi-ai`），那种位置 treeOf
  // 算出来是 dsh 包目录，跟宿主树根不相等——只比相等就会把正在跑那棵树里那份判成"别人的"，
  // 于是又退回按代次和列表顺序碰运气（这正是这次要修的地方）。
  const inHostTree = (row: { root: string }): boolean => options.hostTree !== undefined
    && (row.root === options.hostTree || row.root.startsWith(options.hostTree + sep))
  const matches = (row: { generation: GlueGeneration }): boolean => options.hostGeneration !== 'unknown' && row.generation === options.hostGeneration
  const pick = (reason: SourceBundle['reason'], test: (row: (typeof described)[number]) => boolean): SourceBundle | undefined => {
    const hit = described.find(test)
    return hit === undefined ? undefined : { ...hit, reason }
  }
  return pick('host-tree+generation', (row) => inHostTree(row) && matches(row))
    ?? pick('generation', matches)
    ?? pick('host-tree', inHostTree)
    ?? { ...described[0]!, reason: 'first' }
}

/**
 * 官方 llm-pi-ai bundle 的实际位置（宿主真正会加载的那份）。
 *
 * 路径不写死：桌面端先看 Electron 自带的 `app.asar`，再看 profile 的 node_modules 与 dsh
 * 安装树，最后是插件自己；拿到候选后按「宿主那棵树 + 胶水代次」挑（见
 * {@link chooseSourceBundle}）。
 */
export function resolveSourceBundle(env: HostEnv = currentHostEnv()): SourceBundle | undefined {
  const hostTree = hostDshTree(env)
  const hostGeneration = dshGeneration(hostTree === undefined ? undefined : piAiVersionOf(join(hostTree, 'node_modules', '@deepseek-ai', 'dsh')))
  return chooseSourceBundle(hostPackageEntries('@deepseek-ai/dsh-llm-pi-ai', env), { ...(hostTree === undefined ? {} : { hostTree }), hostGeneration })
}

/**
 * dsh 自己那份 pi-ai 的包目录：从官方 bundle 的位置沿解析链找——那是 bundle 真正会加载的
 * 那份，dsh 把 bundle 放在哪、依赖提升到哪一层都不影响。
 * @param bundlePath - 官方 bundle 的入口文件路径。
 */
function dshPiAiRoot(bundle: SourceBundle | undefined): string | undefined {
  if (bundle === undefined) return undefined
  return resolvePackageRoot(bundle.path, '@earendil-works/pi-ai')
}

/**
 * 兜底那份 pi-ai：`vendor/package.json` 锁死的依赖，装在 `vendor/node_modules/` 里。
 *
 * 位置是挑过的——它在桥接副本的解析路径上（副本在 `vendor/llm-bridge/`，往上找先撞到
 * `vendor/node_modules`，再才是插件根的 node_modules），所以中选这一档时不用挂软链：
 * 删掉软链它就自然生效，"回退"因此只有一个动作。
 *
 * 没放在插件根的 node_modules：那里有一条手工建的 `@deepseek-ai` 软链（桥接副本上的
 * dsh 包靠它解析），在根上跑 npm install 会被 npm 当成待处理的条目，实测直接 EPERM。
 */
function pluginDependencyRoot(): string {
  return join(vendorDir, 'node_modules', '@earendil-works', 'pi-ai')
}

/**
 * 当前生效的 pi-ai 包目录。
 *
 * loadBridge() 挑定之后以它为准——挑的时候可能回退过，跟"vendor 里最新"不是一回事，
 * 而这个根目录下面那三个读 pi-ai 文件的模块（provider 名字、模型详情、候选清单）
 * 必须跟真正被加载的那份对上。没跑过 loadBridge 的场合退回静态推断。
 *
 * **每次读之前核一次盘。**插件被重装（换包目录会把 `vendor/` 一起清掉）而 dsh 没重启时，
 * 内存里记的那份目录已经从盘上消失；不核盘的话上面那三个模块会安静地读出空结果——界面表现
 * 是「供应商预设只剩自定义网关、模型徽章全没了」，既不报错也看不出原因。核到掉盘就退回静态
 * 推断（重装后 vendor 是空的，自然落到宿主那棵树），并把这次漂移记下来给状态页提示重启。
 */
let activeRoot: string | undefined

/**
 * 内存里记着、盘上已经不在的那份 pi-ai（`undefined` = 没发生漂移）。
 *
 * 典型来源就是上面说的「重装没重启」。只有重启 dsh 才能让运行中的桥接与磁盘重新一致，
 * 所以这个值只用来提示，不用来改运行行为。
 */
let staleRoot: string | undefined

/**
 * 「记录的那份 pi-ai 还在不在盘上」的判定（纯函数，离线可测）。
 *
 * @param recorded - 内存里记的那份；`undefined` = 还没挑过（走静态推断的第一个可用候选）。
 * @param fallbacks - 静态推断的候选，按优先级排（下载档新→旧、兜底依赖、dsh 自带）。
 * @param exists - 目录是否还在盘上（注入，便于离线测各种掉盘组合）。
 * @returns `root` 这次用哪份；`stale` = 记录的那份（掉盘时给出，供界面提示重启）。
 */
export function resolveLiveRoot(
  recorded: string | undefined,
  fallbacks: readonly string[],
  exists: (path: string) => boolean,
): { root?: string, stale?: string } {
  const fallback = fallbacks.find((path) => exists(path))
  if (recorded === undefined) return fallback === undefined ? {} : { root: fallback }
  if (exists(recorded)) return { root: recorded }
  return fallback === undefined ? { stale: recorded } : { root: fallback, stale: recorded }
}

/** 静态推断的 pi-ai 候选，顺序 = 优先级（下载档新→旧、兜底依赖、dsh 自带）。 */
function inferredPiAiRoots(): string[] {
  const roots: string[] = []
  const versions = installedVersions()
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const version = versions[i]
    if (version !== undefined) roots.push(join(piAiVersionsDir, version))
  }
  roots.push(pluginDependencyRoot())
  const host = dshPiAiRoot(resolveSourceBundle())
  if (host !== undefined) roots.push(host)
  return roots
}

export function activePiAiRoot(): string | undefined {
  if (activeRoot !== undefined && existsSync(activeRoot)) return activeRoot
  const picked = resolveLiveRoot(activeRoot, inferredPiAiRoots(), existsSync)
  if (picked.stale !== undefined) staleRoot ??= picked.stale
  activeRoot = picked.root
  return activeRoot
}

/** 盘上已经消失的那份 pi-ai（`undefined` = 没漂移）。界面据此提示「重启 dsh 生效」。 */
export function stalePiAiRoot(): string | undefined {
  return staleRoot
}

/** 读一个 pi-ai 包的版本号；读不到返回 undefined。 */
function piAiVersionOf(root: string): string | undefined {
  try {
    return readString(asRecord(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))['version'])
  } catch {
    return undefined
  }
}

/**
 * 当前生效那份 pi-ai 的版本号（loadBridge 挑定的那份）。
 *
 * 给更新器当「已有什么」用：桥接加载失败时调用方拿不到 loadBridge 的结论，
 * 再退回这里按 {@link activePiAiRoot} 的静态推断读一次版本，免得白下一份同版本的。
 */
export function activePiAiVersion(): string | undefined {
  const root = activePiAiRoot()
  return root === undefined ? undefined : piAiVersionOf(root)
}

/**
 * 从 bundle 源码里抠出它对 pi-ai 的 import 需求。
 *
 * 拷来的那份代码写的是 bare specifier；上游改了导出名或子路径，加载就会炸。
 * 这里把"它到底要什么"读出来，好在加载**之前**就能判断某份 pi-ai 合不合格。
 *
 * 覆盖的形态：具名导入 / 具名 re-export（要对方给出这些名字）、动态 import、
 * 副作用导入、namespace/默认导入、`export *`（只要子路径能加载，names 为空）。
 * 解析不出来返回空数组，调用方据此知道"体检没执行"而不是"体检通过"。
 * @param source - bundle 源码。
 * @returns 需求列表；解析不出来时返回空数组（调用方据此跳过体检）。
 */
export function piAiRequirements(source: string): PiAiRequirement[] {
  const bySpecifier = new Map<string, Set<string>>()
  const namedPatterns = [
    /\bimport\s*\{([^}]*)\}\s*from\s*["'](@earendil-works\/pi-ai[^"']*)["']/g,
    /\bexport\s*\{([^}]*)\}\s*from\s*["'](@earendil-works\/pi-ai[^"']*)["']/g,
  ]
  for (const pattern of namedPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      const names = (match[1] ?? '')
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((name) => name !== '')
      const specifier = match[2]
      if (names.length > 0 && specifier !== undefined) {
        const existing = bySpecifier.get(specifier) ?? new Set<string>()
        for (const name of names) existing.add(name)
        bySpecifier.set(specifier, existing)
      }
    }
  }
  const barePatterns = [
    /\bimport\s*\(\s*["'](@earendil-works\/pi-ai[^"']*)["']/g, // 动态 import()
    /\bimport\s*["'](@earendil-works\/pi-ai[^"']*)["']/g, // 副作用导入
    /\bimport[^"'{]*?\sfrom\s*["'](@earendil-works\/pi-ai[^"']*)["']/g, // namespace/默认导入
    /\bexport\s*\*\s*from\s*["'](@earendil-works\/pi-ai[^"']*)["']/g, // export *
  ]
  for (const pattern of barePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]
      if (specifier !== undefined && !bySpecifier.has(specifier)) bySpecifier.set(specifier, new Set())
    }
  }
  return [...bySpecifier.entries()].map(([specifier, names]) => ({ specifier, names: [...names] }))
}

/** 读桥接副本，返回它对 pi-ai 的 import 需求（updater 装完新版本也拿它体检）。 */
export function bridgeRequirements(): PiAiRequirement[] {
  try {
    return piAiRequirements(readFileSync(bridgeLib, 'utf8'))
  } catch {
    return []
  }
}

/**
 * 建一条目录链要用的目标与类型。
 *
 * Windows 上目录软链需要 SeCreateSymbolicLinkPrivilege（管理员或开发者模式），普通账户会 EPERM；
 * junction 不需要任何权限，但目标必须是绝对路径。POSIX 上仍用相对目标的软链，仓库整体挪位置
 * 也不会断。
 * @param from - 链所在目录（POSIX 相对目标的基准）。
 * @param target - 链要指向的包目录。
 */
function linkSpec(from: string, target: string): { target: string; type: 'dir' | 'junction' } {
  return process.platform === 'win32'
    ? { target: resolve(target), type: 'junction' }
    : { target: relative(from, target), type: 'dir' }
}

/**
 * 体检一个 pi-ai 候选：那份拷贝要的子路径和具名导出，这份 pi-ai 给不给得出。
 *
 * **为什么不直接试着加载拷贝**：Node 对加载失败的 ESM 会留下半初始化记录，同一个文件
 * 再 require 只会报 "not yet fully loaded"——也就是说"先试再退"这条路走不通，必须在加载
 * 之前判。所以体检换个模块来做：照着需求生成一份探针文件，放进自己的临时目录里，配一条
 * 指向候选的软链。解析规则与拷贝完全一致（同一个父目录、同一条链），但模块 URL 不同，
 * 失败不污染拷贝。
 *
 * 探针目录按候选命名：同一候选复用同一条 URL（结论一致），不同候选互不干扰。
 * @param requirements - {@link piAiRequirements} 的结果。
 * @param root - 候选的 pi-ai 包目录。
 * @param key - 候选标识，用于区分探针目录。
 */
export function probePiAi(requirements: readonly PiAiRequirement[], root: string, key: string): ProbeResult {
  // 候选目录不在就直接判死，**且绝不能建断链**：探针目录在 vendor/llm-bridge/ 下面，
  // 断链会让 Node 继续往上找，一路找到主软链上那份能用的 pi-ai，把不合格的候选误判成通过。
  if (!existsSync(root)) return { ok: false, error: '目录不存在' }
  // 需求没解析出来（bundle 换了打包格式）就没法验证：放行，但标 unverified——
  // 调用方（loadBridge / updater）据此知道这是「没体检」，不是「体检通过」。
  if (requirements.length === 0) return { ok: true, unverified: true }
  const dir = join(bridgeDir, `.probe-${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}`)
  try {
    const linkDir = join(dir, 'node_modules', '@earendil-works')
    mkdirSync(linkDir, { recursive: true })
    const link = join(linkDir, 'pi-ai')
    removeLinkOrDir(link)
    const spec = linkSpec(linkDir, root)
    symlinkSync(spec.target, link, spec.type)
    // 具名需求验证导出存在；bare 需求（namespace/默认/副作用导入、export *）只要子路径能加载
    const lines = requirements.map(({ specifier, names }) =>
      names.length > 0
        ? `import { ${names.join(', ')} } from ${JSON.stringify(specifier)}`
        : `import ${JSON.stringify(specifier)}`)
    lines.push('export const ok = true')
    writeFileSync(join(dir, 'probe.js'), lines.join('\n') + '\n')
    const require = createRequire(import.meta.url)
    require(join(dir, 'probe.js'))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * pi-ai 候选，按优先级排：
 *   1. `vendor/pi-ai/<版本>/`——updater 下载下来的，新 → 旧
 *   2. `vendor/node_modules/@earendil-works/pi-ai`——可选的手装兜底档（vendor/package.json 锁定）
 *   3. dsh 自己装的那份——从官方 bundle 的位置解析出来，包放哪一层都能找到
 */
export function piAiCandidates(): PiAiCandidate[] {
  const versions = installedVersions()
  const downloads: PiAiCandidate[] = []
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const version = versions[i]
    if (version === undefined) continue
    downloads.push({ key: version, version, root: join(piAiVersionsDir, version), link: true })
  }
  const dependency = pluginDependencyRoot()
  const dependencyCandidate: PiAiCandidate = {
    key: 'dependency',
    version: piAiVersionOf(dependency) ?? '内置依赖',
    root: dependency,
    link: false,
  }
  const dshRoot = dshPiAiRoot(resolveSourceBundle())
  const dshCandidate: PiAiCandidate | undefined = dshRoot === undefined
    ? undefined
    : { key: 'dsh', version: piAiVersionOf(dshRoot) ?? 'dsh 自带', root: dshRoot, link: true }
  const locals = [dependencyCandidate, ...(dshCandidate === undefined ? [] : [dshCandidate])]
  return orderCandidates(downloads, locals)
}

/**
 * 候选排序（纯函数，离线可测）：下载档里**不高于**本机最好那份的排到本机档之后。
 *
 * 同一版本优先复用宿主/兜底那份：省下一份 80 MB 级的重复副本，也免掉一次「换版本要重启」。
 * 比本机新的照旧排最前——热更新的意义就是跑得比宿主新。本机两份之间的相对顺序不变
 * （兜底依赖在前、dsh 自带在后，与文档里的来源表一致）。
 *
 * @param downloads - 下载档，调用方按新 → 旧给（本函数不做版本内排序）。
 * @param locals - 本机档（兜底依赖 / dsh 自带），保持调用方给的顺序。
 */
export function orderCandidates(downloads: readonly PiAiCandidate[], locals: readonly PiAiCandidate[]): PiAiCandidate[] {
  // 版本号解析不出（'dsh 自带' 这种占位串）的不参与「本机最好那份」的比较
  const bestLocal = locals
    .map((candidate) => candidate.version)
    .filter((version) => /^\d+(\.\d+)*$/.test(version))
    .reduce<string | undefined>((best, version) => (best === undefined || compareVersions(version, best) > 0 ? version : best), undefined)
  if (bestLocal === undefined) return [...downloads, ...locals]
  const redundant = downloads.filter((candidate) => compareVersions(candidate.version, bestLocal) <= 0)
  const fresh = downloads.filter((candidate) => compareVersions(candidate.version, bestLocal) > 0)
  return [...fresh, ...locals, ...redundant]
}

function readStatus(): AnyRecord {
  try {
    return asRecord(JSON.parse(readFileSync(statusFile, 'utf8')))
  } catch {
    return {}
  }
}

/** 读 vendor/status.json（启动时写下的那次桥接结论）。清理旧版本时要看 needsRestart。 */
export function readBridgeStatus(): AnyRecord {
  return readStatus()
}

/**
 * 合并状态补丁：传 `undefined` 表示**删掉这个键**。
 *
 * JSON.stringify 会丢掉 undefined，光靠 `{...old, ...patch}` 覆盖不掉旧值，于是
 * "上次体检没过"这类记录会一直粘着——明明后来通过了，界面上还挂着。
 * @param previous - 现有状态。
 * @param patch - 本次要写的字段。
 */
export function mergeStatus(previous: AnyRecord, patch: AnyRecord): AnyRecord {
  const merged: AnyRecord = { ...previous, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key]
  }
  return merged
}

function writeStatus(patch: AnyRecord): void {
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(statusFile, JSON.stringify({ ...mergeStatus(readStatus(), patch), updatedAt: new Date().toISOString() }))
}

export function updateStatus(patch: AnyRecord): void {
  writeStatus(patch)
}

/**
 * 确保桥接目录就位（同步、幂等），返回加载好的 bridge 插件模块。
 */
/** 准备好桥接目录与选中的 pi-ai（同步部分：require 与 import 两条路共用）。 */
type PreparedBridge =
  | { ok: true, srcBundle: SourceBundle, chosen: PiAiCandidate, probeUnverified: boolean, rejected: RejectedCandidate[] }
  | { ok: false, error: string }

function prepareBridge(): PreparedBridge {
  const srcBundle = resolveSourceBundle()
  if (srcBundle === undefined) {
    return { ok: false, error: '找不到官方 llm-pi-ai bundle：app.asar、profile 的 node_modules 与 dsh 安装目录里都没有 @deepseek-ai/dsh-llm-pi-ai' }
  }

  // 1. 桥接目录：bundle 副本（源更新过就重拷）+ 固定 package.json
  mkdirSync(join(bridgeDir, 'lib'), { recursive: true })
  // 换了一份源（比如从 CLI 安装树换到 app.asar 里那份）就必须重拷：asar 里的文件 mtime
  // 可能读成 0，光比时间戳会留下旧副本，那正是「胶水层与宿主对不上」的老毛病。
  const previousBundle = readStatus()['bundlePath']
  const needsCopy = !existsSync(bridgeLib)
    || previousBundle !== srcBundle.path
    || statSync(srcBundle.path).mtimeMs > statSync(bridgeLib).mtimeMs
  if (needsCopy) copyFileSync(srcBundle.path, bridgeLib)
  writeFileSync(join(bridgeDir, 'package.json'), BRIDGE_PACKAGE_JSON)

  // 2. 挑一份能用的 pi-ai：候选按优先级排（热更新的新→旧 → 插件自带依赖 → dsh 自带），
  //    逐个体检，第一个通过的就是这次用的。**体检必须在加载之前**——ESM 加载失败后
  //    同一个文件没法重试，所以不能"先试再退"。
  //
  //    目录不存在的档直接跳过，不算"体检没通过"：那是这一档没安装（可选档），不是兼容性
  //    问题。写进 rejected 的话，界面上会出现「跳过 兜底依赖：兼容性检查没通过」这种
  //    看着像故障、其实一切正常的行。
  const requirements = piAiRequirements(readFileSync(bridgeLib, 'utf8'))
  const rejected: RejectedCandidate[] = []
  let chosen: PiAiCandidate | undefined
  let probeUnverified = false
  for (const candidate of piAiCandidates()) {
    if (!existsSync(candidate.root)) continue
    const probe = probePiAi(requirements, candidate.root, candidate.key)
    if (probe.ok) {
      chosen = candidate
      probeUnverified = probe.unverified === true
      break
    }
    rejected.push({ version: candidate.version, error: probe.error })
  }
  if (chosen === undefined) {
    return {
      ok: false,
      error: `没有能用的 pi-ai：${rejected.map((entry) => `${entry.version}（${String(entry.error)}）`).join('；')}`,
    }
  }

  // 3. 生效：热更新档挂软链指过去；兜底档（插件自己的依赖）不挂，让 Node 自然往上找到它
  if (chosen.link) setPiAiLink(chosen.root)
  else clearPiAiLink()

  return { ok: true, srcBundle, chosen, probeUnverified, rejected }
}

/** 记下这次桥接的结论（状态文件 + 返回值）。require 与 import 两条路共用。 */
function finishBridge(
  prepared: Extract<PreparedBridge, { ok: true }>,
  plugin: BridgePluginModule,
  persist = true,
): BridgeLoadResult {
  const result = finishBridgeResult(prepared, plugin)
  // persist=false 的（reloadBridge）不在挂载前落盘：swap 挂载失败回滚后，状态文件会跟
  // 实际跑着的那份对不上，prune 可能据此删掉真正在跑的旧下载档。由调用方在挂载成功后
  // 调 commitBridgeState 落盘（src/index.ts 的 swapBridge 就是那样接的）。
  if (persist) commitBridgeState(result)
  return result
}

/** 一份桥接结果的完整落点信息（写状态文件要带上 bundlePath，用于「换源时强制重拷」）。 */
function finishBridgeResult(
  prepared: Extract<PreparedBridge, { ok: true }>,
  plugin: BridgePluginModule,
): Extract<BridgeLoadResult, { ok: true }> {
  const { srcBundle, chosen, probeUnverified, rejected } = prepared
  return {
    ok: true,
    plugin,
    piAiVersion: chosen.version,
    piAiSource: chosen.key,
    bundleVersion: srcBundle.version,
    bundlePath: srcBundle.path,
    bundleTree: treeLabel(srcBundle.tree),
    piAiPath: chosen.root,
    piAiOrigin: piAiOriginLabel(chosen.root, chosen.key),
    probeUnverified,
    rejected,
  }
}

/** 挂载**成功**之后再把这次桥接的结论落盘（activeRoot + status.json）；失败/回滚都不会进来。 */
export function commitBridgeState(result: Extract<BridgeLoadResult, { ok: true }>): void {
  activeRoot = result.piAiPath
  // 刚挂上的这份是活的（挑它之前体检过），漂移标记跟着清掉
  staleRoot = undefined
  writeStatus({
    piAiVersion: result.piAiVersion,
    needsRestart: false,
    piAiSource: result.piAiSource,
    bundleVersion: result.bundleVersion,
    bundlePath: result.bundlePath,
    bundleTree: result.bundleTree,
    piAiPath: result.piAiPath,
    piAiOrigin: result.piAiOrigin,
    probeUnverified: result.probeUnverified || undefined,
    ...(result.rejected.length === 0 ? { rejected: undefined } : { rejected: result.rejected }),
  })
}

/**
 * 确保桥接目录就位（同步、幂等），返回加载好的 bridge 插件模块。启动时用这条。
 */
export function loadBridge(): BridgeLoadResult {
  try {
    const prepared = prepareBridge()
    if (!prepared.ok) return prepared
    // 同步 require 加载（Node 22.12+/24 支持 require ESM；bundle 无 TLA）
    const require = createRequire(import.meta.url)
    delete require.cache?.[bridgeLib]
    const plugin = require(bridgeLib) as BridgePluginModule
    return finishBridge(prepared, plugin, true)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 重新加载一份桥接（**热切换用**：下好新版 pi-ai 之后不用重启 dsh）。
 *
 * 与 {@link loadBridge} 的两点不同：
 *   1. 走 `import()` 并带一个变化的 query——ESM 按 URL 缓存，路径不变的话拿到的还是旧模块，
 *      那样新 pi-ai 永远不会生效；
 *   2. query 一变，bundle 里那句 `import '@earendil-works/pi-ai/…'` 会沿软链重新解析，
 *      软链已经指向新版本，于是这次拿到的是新 pi-ai。
 *
 * 调用方负责先把旧的桥接挂载卸掉（`fiber.dispose()`），失败时再把旧模块挂回去——旧模块
 * 的 pi-ai 绑定还是旧的，回滚是安全的。
 */
export async function reloadBridge(): Promise<BridgeLoadResult> {
  try {
    const prepared = prepareBridge()
    if (!prepared.ok) return prepared
    const url = `${pathToFileURL(bridgeLib).href}?swap=${String(Date.now())}`
    const plugin = (await import(url)) as BridgePluginModule
    return finishBridge(prepared, plugin, false)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 清掉一个路径：链就摘链，真目录才递归删。
 *
 * **为什么不能直接 `rmSync(path, { recursive: true })`**：Windows 上这里的链是 junction，
 * 从 Node 24.15 起（dsh 自带运行时就是这一档：electron 43 / node 24.18）递归删会**连目标目录的
 * 内容一起删掉**，只留一个空壳；同一句在 node ≤24.14 上只是摘链。链指向 dsh 自带那份 pi-ai 时，
 * 等于每启动一次就把宿主那份清空——之后「桥接不可用 → 卸载插件 → 官方 llm-pi-ai 去加载已被清空的
 * 那份 → dsh 起不来」。issue #4 / #6 的事故链就是这三行。
 *
 * 所以先 lstat（junction 在 lstat 下就是 symbolicLink），是链只 unlink，一个字节都不碰目标；
 * 真目录（探针目录这类自己 mkdir 出来的）才递归删，且必须在 allowedRoot 内——拦住拼错路径
 * 把用户目录删掉的写法。
 *
 * @param path - 要清掉的路径。
 * @param allowedRoot - 允许递归删的根（默认 vendor/）；链不受此限制（摘链不改目标）。
 */
export function removeLinkOrDir(path: string, allowedRoot: string = vendorDir): void {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    // 只有「本来就不存在」才算幂等成功；EACCES/EPERM/EBUSY 要照抛——静默吞掉的话，
    // 调用方接着 symlinkSync 会抛 EEXIST，被记成「兼容性检查没通过」，把一份本来可用的
    // pi-ai 判死，原因还指错方向。
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    unlinkSync(path)
    return
  }
  const resolved = resolve(path)
  const root = resolve(allowedRoot)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`拒绝递归删除 ${root} 之外的目录：${resolved}`)
  }
  rmSync(resolved, { force: true, recursive: true })
}

/** 把桥接副本的 pi-ai 链指向指定包目录（指向没变就不动，避免无谓的 mtime 抖动）。 */
function setPiAiLink(target: string): void {
  const linkDir = join(bridgeDir, 'node_modules', '@earendil-works')
  mkdirSync(linkDir, { recursive: true })
  const linkPath = join(linkDir, 'pi-ai')
  const spec = linkSpec(linkDir, target)
  let current: string | undefined
  try {
    // readlink 而不是 readFile：链指向的是目录，readFile 会解析进去抛 EISDIR，
    // 于是"指向没变"永远判不出来，每次加载都白删白建一次。
    current = readlinkSync(linkPath)
  } catch { /* 还没有链 */ }
  if (current === spec.target) return
  removeLinkOrDir(linkPath)
  symlinkSync(spec.target, linkPath, spec.type)
}

/**
 * 删掉软链，让那份拷贝走自然解析，落到插件自己的 node_modules。
 *
 * 这就是"回退到内置依赖"的动作——不用另外指一条链过去，Node 会自己往上找。
 */
function clearPiAiLink(): void {
  removeLinkOrDir(join(bridgeDir, 'node_modules', '@earendil-works', 'pi-ai'))
}

/**
 * 相对路径（自写而不用 path.relative）：软链目标一律用正斜杠。
 * 只在 POSIX 上用到——Windows 走 junction，目标是绝对路径。
 */
function relative(from: string, to: string): string {
  const fromParts = from.split(sep)
  const toParts = to.split(sep)
  let i = 0
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++
  const up = fromParts.length - i
  return [...Array.from({ length: up }, () => '..'), ...toParts.slice(i)].join('/')
}
