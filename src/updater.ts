/**
 * pi-ai 上游更新器：盯 @earendil-works/pi-ai 的 npm registry，
 * 有新版本就下载、装依赖、放进 vendor/pi-ai/<版本>/，验证通过后标记待生效。
 *
 * 替换的硬规矩：**验证通过才能替换**，两道都过才算数——
 *   1. tarball 完整性：按 registry packument 里的 dist.integrity（sha512）校验下载内容；
 *   2. 兼容性体检：用桥接副本自己的 import 需求 probe 那份新 pi-ai（见 bridge.js 的
 *      probePiAi）。体检没跑起来（unverified，需求解析不出）一样不替换。
 * 通过后只写 status.json 的 needsRestart 标记——已 require 的旧模块不受影响，
 * 下一次 dsh 重启时 bridge.js 才会挂到新版本。/provider/status 会报出来。
 *
 * 触发方式：启动时后台自动查一次（6 小时节流，startBackgroundCheck），以及设置页按钮
 * → POST /provider/update 手动触发。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  activePiAiRoot,
  activePiAiVersion,
  bridgeRequirements,
  compareVersions,
  installedVersions,
  piAiCandidates,
  probePiAi,
  readBridgeStatus,
  removeLinkOrDir,
  updateStatus,
  vendorDir,
} from './bridge.js'
import { asRecord, readString, type AnyRecord, type Logger } from './types.js'

const execFileAsync = promisify(execFile)

const PACKAGE = '@earendil-works/pi-ai'
const REGISTRY = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE).replace('%40', '@')}`
const VERSIONS_DIR = join(vendorDir, 'pi-ai')
const STATE_FILE = join(vendorDir, 'updater-state.json')
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时

/**
 * npm 缓存目录：放系统临时目录，**不放插件目录**。
 *
 * 早先放在 `vendor/.npm-cache`，实测一口气留 178 MB（issue #4）；用户默认的全局缓存又可能
 * 因为 root 属主残留不可写，所以不能直接用全局那份。系统临时目录一定可写，插件目录不留垃圾。
 */
const NPM_CACHE_DIR = join(tmpdir(), 'dsh-llm-provider-npm-cache')
/** 老版本留在插件目录里的 npm 缓存（装完/手动清理时删掉）。 */
const LEGACY_NPM_CACHE_DIR = join(vendorDir, '.npm-cache')

/** 一次检查 + 更新的结果（/provider/update 的响应体）。 */
export interface UpdateResult {
  checkedAt: string
  latest: string | undefined
  installed: string | undefined
  applied: boolean
  compatible: boolean | undefined
  error: string | undefined
}

/** registry 上最新版：版本号 + tarball 的 sha512（base64，无前缀）。 */
interface RegistryRelease {
  version: string
  integrity: string | undefined
}

/** 上次检查时间等本地状态。 */
function readState(): AnyRecord {
  try {
    return asRecord(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return {}
  }
}

function writeState(patch: AnyRecord): void {
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch, at: new Date().toISOString() }))
}

/** registry 上最新版与它的 dist.integrity（下载校验用）。 */
export async function latestRelease(): Promise<RegistryRelease> {
  const response = await fetch(REGISTRY, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`registry HTTP ${String(response.status)}`)
  const doc = asRecord(await response.json())
  const latest = readString(asRecord(doc['dist-tags'])['latest'])
  if (latest === undefined) throw new Error('registry 响应里没有 dist-tags.latest')
  const versionDoc = asRecord(asRecord(doc['versions'])[latest])
  return { version: latest, integrity: readString(asRecord(versionDoc['dist'])['integrity']) }
}

/**
 * 拼一条能跨平台跑起来的 npm 命令。
 *
 * 直接 `execFile('npm', …)` 在 Windows 上是 ENOENT（npm 是 npm.cmd）；换成 `npm.cmd` 又会撞
 * Node 从 18.20.2 / 20.12 / 21.7 起的行为——不经 shell 执行 .cmd/.bat 一律 EINVAL；过 shell
 * 则要自己处理引号（`--cache=` 后面是路径，可能带空格）。
 *
 * 所以首选 Node 自带那份 npm 的 JS 入口，用 `node <npm-cli.js>` 跑：跨平台一致、不经过 .cmd、
 * 也没有 shell 解析。找不到才退回 PATH 上的 npm（Windows 上过 shell，参数自己加引号）。
 * @param args - 传给 npm 的参数。
 */
function npmCommand(args: readonly string[]): { file: string; args: string[]; shell: boolean } {
  const nodeDir = dirname(process.execPath)
  const cli = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows 与官方安装包
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX（nvm、fnm 常见布局）
  ].find((candidate) => existsSync(candidate))
  if (cli !== undefined) return { file: process.execPath, args: [cli, ...args], shell: false }
  const isWindows = process.platform === 'win32'
  return {
    file: isWindows ? 'npm.cmd' : 'npm',
    args: isWindows ? args.map((argument) => (/\s/.test(argument) ? `"${argument}"` : argument)) : [...args],
    shell: isWindows,
  }
}

/**
 * 下载并就位一个版本：tarball 校验后解压到 vendor/pi-ai/<v>/，再补依赖闭包。
 * 已就位则跳过（校验也不重跑——那份内容装的时候验过）。integrity 缺省时不校验，
 * 但会记一行日志：registry 正常都会给，缺了多半是请求/字段出了问题。
 */
export async function installVersion(release: RegistryRelease, log: (line: string) => void = () => {}): Promise<string> {
  const { version, integrity } = release
  const target = join(VERSIONS_DIR, version)
  if (existsSync(join(target, 'node_modules'))) {
    log(`${version} 已就位，跳过下载`)
    return target
  }
  // 用 removeLinkOrDir 而不是裸 rmSync：这个目录万一被手工做成了软链/junction（拿本地
  // checkout 试版本这类用法），Node 24.15+ 的递归删会把链目标的内容一起删掉（见 bridge.ts）
  removeLinkOrDir(target, VERSIONS_DIR)
  mkdirSync(target, { recursive: true })

  const tgzPath = join(tmpdir(), `pi-ai-${version}-${Date.now()}.tgz`)
  log(`下载 ${PACKAGE}@${version} ...`)
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/-/pi-ai-${version}.tgz`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`tarball HTTP ${String(response.status)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (integrity !== undefined) {
    const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (actual !== integrity) {
      throw new Error(`tarball 校验失败（本地 sha512 与 registry 的 dist.integrity 不一致），拒绝安装 ${version}`)
    }
    log('完整性校验通过（sha512）')
  } else {
    log('registry 没给 dist.integrity，跳过完整性校验')
  }
  writeFileSync(tgzPath, bytes)

  log('解压 ...')
  await execFileAsync('tar', ['-xzf', tgzPath, '-C', target, '--strip-components', '1'])
  rmSync(tgzPath, { force: true })

  log('安装依赖（--omit=dev --ignore-scripts）...')
  // 缓存放系统临时目录（见 NPM_CACHE_DIR）：插件目录里那份 178 MB 的缓存就是这么来的
  mkdirSync(NPM_CACHE_DIR, { recursive: true })
  const npm = npmCommand([
    'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
    `--cache=${NPM_CACHE_DIR}`,
  ])
  await execFileAsync(npm.file, npm.args, {
    cwd: target,
    timeout: 300_000,
    ...(npm.shell ? { shell: true } : {}),
  })
  // 只清**老版本留在插件目录里**的那份缓存（issue #4 的 178 MB）：系统临时目录那份是这次
  // 安装刚写进去的，删了下次就全冷下载——它由「清理」按钮与保留策略负责，不在这里动
  try {
    removeLinkOrDir(LEGACY_NPM_CACHE_DIR, dirname(LEGACY_NPM_CACHE_DIR))
  } catch (error) {
    log(`清理老 npm 缓存失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return target
}

/**
 * 一次性检查 + 更新。返回给 /provider/update 与 /provider/status。
 * @param log - 进度输出。
 * @param activeVersion - 当前正在用的 pi-ai 版本（可能来自 dsh 自带那份）。已经不比上游旧时
 *   不再下载——否则像 dsh 自带 0.85.1、上游也是 0.85.1 的情况下会白下一份一模一样的。
 *   缺省时自己从生效目录读一次（{@link activePiAiVersion}）：手动「检查更新」以前不传这个参数，
 *   于是点一次就白下 80 MB 的同版本副本（issue #4）。
 */
export async function checkAndUpdate(
  log: (line: string) => void = () => {},
  activeVersion?: string,
): Promise<UpdateResult> {
  const result: UpdateResult = {
    checkedAt: new Date().toISOString(),
    latest: undefined,
    installed: undefined,
    applied: false,
    compatible: undefined,
    error: undefined,
  }
  try {
    const release = await latestRelease()
    result.latest = release.version
    const active = activeVersion ?? activePiAiVersion()
    if (active !== undefined && compareVersions(release.version, active) <= 0) {
      log(`当前已在 ${active}（上游 ${release.version}），无需下载`)
      return result
    }
    const have = installedVersions()
    const newest = have[have.length - 1]
    if (newest !== undefined && compareVersions(release.version, newest) <= 0) {
      log(`已是最新（本地 ${newest}，上游 ${release.version}）`)
      return result
    }
    const target = await installVersion(release, log)
    result.installed = release.version
    // 装完先体检：不兼容的版本不该让用户白重启一趟，也不该在下次启动时才被发现。
    // 体检用桥接副本自己的 import 需求（见 bridge.js 的 probePiAi）。
    const probe = probePiAi(bridgeRequirements(), target, `check-${release.version}`)
    result.compatible = probe.ok && probe.unverified !== true
    if (probe.ok && probe.unverified !== true) {
      updateStatus({ piAiVersion: release.version, needsRestart: true, latestVersion: release.version, latestRejected: undefined })
      result.applied = true
      log(`已验证 ${release.version}（完整性 + 兼容性体检），重启 dsh 后生效`)
    } else {
      // 留着不删：下次启动还会体检一遍，结论一致；万一判断有误也能人工指定。
      // unverified（需求解析不出）同样不替换——「验证才能替换」没有例外。
      const reason = probe.unverified === true
        ? '体检未执行（解析不出 bridge 的 import 需求），按「验证才能替换」不切换'
        : probe.error
      updateStatus({ latestVersion: release.version, latestRejected: { version: release.version, error: reason } })
      log(`${release.version} 未通过验证，已跳过（不会切过去）：${String(reason)}`)
    }
    // 装完顺手清理：不会再被选中的重复副本 + 旧版本（保留规则见 pruneVersions）
    const pruned = pruneVersions(1, log)
    if (pruned.removed.length > 0) {
      log(`清理旧版本：${pruned.removed.map((entry) => `${entry.version}（${entry.reason}）`).join('、')}`)
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(`更新失败：${result.error}`)
  } finally {
    // 磁盘不可写（EACCES/ENOSPC）时不能让状态文件把结果弄丢：writeState 是同步文件写，
    // 抛出去会让 promise reject，把「本来要报的原因」变成未处理 rejection
    try {
      writeState({ lastCheck: result.checkedAt })
    } catch (error) {
      log(`更新状态文件没写进去（不影响本次结果）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/** 目录占用的递归统计（不用 fs.stat 的 size 直接加：目录本身不算，也不跟软链）。 */
function dirSize(path: string): number {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += dirSize(child)
    else if (entry.isFile()) {
      try {
        total += statSync(child).size
      } catch { /* 文件刚没了：跳过 */ }
    }
  }
  return total
}

/** 插件在磁盘上的开销（「pi-ai 桥接」标签页显示，清理按钮据此报省了多少）。 */
export interface VendorUsage {
  /** vendor/ 整个目录的占用（下载的版本、桥接副本、兜底依赖树、老 npm 缓存）。 */
  vendorBytes: number
  /** vendor/ 下已下载的 pi-ai 版本，逐个列出来。 */
  downloads: { version: string, bytes: number }[]
  /** 系统临时目录里的 npm 缓存（更新依赖用，删了只影响下次装依赖的速度）。 */
  cacheBytes: number
  /** 老版本留在插件目录里的 npm 缓存；清理按钮会删掉它。 */
  legacyCacheBytes: number
}

export function vendorUsage(): VendorUsage {
  return {
    vendorBytes: dirSize(vendorDir),
    downloads: installedVersions().map((version) => ({ version, bytes: dirSize(join(VERSIONS_DIR, version)) })),
    cacheBytes: dirSize(NPM_CACHE_DIR),
    legacyCacheBytes: dirSize(LEGACY_NPM_CACHE_DIR),
  }
}

/** {@link dirSize} 的异步版：`/provider/status` 走这条，别让递归 statSync 卡住宿主事件循环。 */
async function dirSizeAsync(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await dirSizeAsync(child)
    else if (entry.isFile()) {
      try {
        total += (await stat(child)).size
      } catch { /* 文件刚没了：跳过 */ }
    }
  }
  return total
}

/**
 * {@link vendorUsage} 的非阻塞版（宿主里用这个）。
 *
 * 同一批目录，`vendor/` 实测两万多个文件，同步递归一次要 300 ms 上下——放在 HTTP handler 里
 * 就是整个宿主停 300 ms。这里逐个 await，等待期间事件循环照常跑。
 */
export async function vendorUsageAsync(): Promise<VendorUsage> {
  const downloads: { version: string, bytes: number }[] = []
  for (const version of installedVersions()) {
    downloads.push({ version, bytes: await dirSizeAsync(join(VERSIONS_DIR, version)) })
  }
  return {
    vendorBytes: await dirSizeAsync(vendorDir),
    downloads,
    cacheBytes: await dirSizeAsync(NPM_CACHE_DIR),
    legacyCacheBytes: await dirSizeAsync(LEGACY_NPM_CACHE_DIR),
  }
}

/** 清理结果：删了哪些、留了哪些、释放了多少字节、有没有没清掉的。 */
export interface PruneResult {
  removed: { version: string, reason: string }[]
  kept: string[]
  freedBytes: number
  /** 没删掉的（版本或缓存）：失败原因写在这里，界面要看得见，不能只进日志。 */
  warnings?: string[]
}

/**
 * 保留规则（纯函数，离线可测——删目录这件事得能先算清楚再动手）。
 *
 * 从强到弱：
 *   1. **正在用的那份**与「已下载、等重启生效」的那版（protectedVersions）绝不删；
 *   2. 版本**不高于**本机已有的最好那份（dsh 自带 / 兜底依赖，含同名版本）的删掉——
 *      候选排序已经不会再选中它（见 piAiCandidates 的 tie-break），留着只是 80 MB 级重复副本；
 *   3. 其余（比本机新的）只留最新 `keep` 份（默认 1）——多留的那份是回滚余地：新版本万一在运行期
 *      出问题，旧的那份还在，删掉软链就能退回去。
 *
 * @param versions - vendor/pi-ai/ 下已就位的版本（任意顺序）。
 * @param bestLocal - 本机非下载档里最高的版本号；都没有则 undefined（跳过规则 2）。
 * @param protectedVersions - 正在用 / 等重启生效的版本号。
 * @param keep - 比本机新的那些保留几份。
 */
export function planPrune(
  versions: readonly string[],
  bestLocal: string | undefined,
  protectedVersions: readonly string[],
  keep = 1,
): { remove: { version: string, reason: string }[], keep: string[] } {
  const protectedSet = new Set(protectedVersions)
  const remove: { version: string, reason: string }[] = []
  const protectedSurvivors: string[] = []
  const trimmable: string[] = []
  for (const version of versions) {
    if (protectedSet.has(version)) {
      protectedSurvivors.push(version)
      continue
    }
    if (bestLocal !== undefined && compareVersions(version, bestLocal) <= 0) {
      remove.push({ version, reason: `不高于本机已有的 ${bestLocal}，重复副本` })
      continue
    }
    trimmable.push(version)
  }
  // 「留最新 keep 份」只在非保护的版本之间收敛：正在用/待生效的那版永远不因为条数被挤掉
  const sorted = [...trimmable].sort(compareVersions)
  const extra = sorted.slice(0, Math.max(0, sorted.length - keep))
  for (const version of extra) remove.push({ version, reason: `只保留最新 ${keep} 份` })
  const kept = [...protectedSurvivors, ...sorted.slice(extra.length)].sort(compareVersions)
  return { remove, keep: kept }
}

/**
 * 清理 vendor/pi-ai/ 里的旧版本与 npm 缓存（issue #4 的保留策略，规则见 {@link planPrune}）。
 *
 * @param keep - 比本机新的那些保留几份。
 */
export function pruneVersions(keep = 1, log?: (line: string) => void): PruneResult {
  const status = readBridgeStatus()
  const protectedVersions: string[] = []
  const active = activePiAiRoot()
  if (active !== undefined) {
    // 生效目录落在 vendor/pi-ai/<版本>/ 里时，把那个版本号标成「正在用」
    const versionsDir = resolve(VERSIONS_DIR)
    const resolved = resolve(active)
    if (resolved.startsWith(versionsDir + sep)) {
      const version = resolved.slice(versionsDir.length + sep.length).split(/[\\/]/)[0]
      if (version !== undefined && version !== '') protectedVersions.push(version)
    }
  }
  if (status['needsRestart'] === true) {
    const pending = readString(status['piAiVersion'])
    if (pending !== undefined && pending !== '') protectedVersions.push(pending)
  }
  return applyPrune({
    versionsDir: VERSIONS_DIR,
    cacheDirs: [LEGACY_NPM_CACHE_DIR, NPM_CACHE_DIR],
    installed: installedVersions(),
    bestLocal: bestLocalVersion(),
    protectedVersions,
    keep,
    ...(log === undefined ? {} : { log }),
  })
}

/** 本机已有的那份最好版本（dsh 自带 / 兜底依赖）——「重复副本」就是这么判的。 */
function bestLocalVersion(): string | undefined {
  let best: string | undefined
  for (const candidate of localCandidates()) {
    if (best === undefined || compareVersions(candidate, best) > 0) best = candidate
  }
  return best
}

/**
 * 本机两份非下载档（dsh 自带 / 兜底依赖）里**真正能用**的版本号。
 *
 * 为什么必须体检过才算：这条版本号是「重复副本」的判定门槛。兜底依赖装了一半（依赖被删、
 * 目录在但加载不了）却版本号很高时，用它当门槛会把一份**能用的**下载档判成重复副本删掉，
 * 运行时反而退到更旧的 dsh 自带那份。体检只跑本机这两档（候选顺序仍由 loadBridge 逐个
 * 体检决定，不需要在这里为所有下载档付体检开销），结果靠 ESM 缓存，重复调用几乎不花时间。
 *
 * @returns 版本号列表；读不出、目录不在、体检不过的都不算。
 */
function localCandidates(): string[] {
  const versions: string[] = []
  const requirements = bridgeRequirements()
  for (const candidate of piAiCandidates()) {
    if (candidate.key !== 'dsh' && candidate.key !== 'dependency') continue
    if (!existsSync(join(candidate.root, 'package.json'))) continue
    if (!/^\d+(\.\d+)*$/.test(candidate.version)) continue
    const probe = probePiAi(requirements, candidate.root, `prune-${candidate.key}`)
    // 体检没跑成（unverified）不算数：门槛宁可低一点，也别拿一份没验证过的本机档去删下载档
    if (!probe.ok || probe.unverified === true) continue
    versions.push(candidate.version)
  }
  return versions
}

/** 一次清理的输入（路径都显式传进来，离线测试才能拿临时目录跑真删）。 */
export interface PruneRequest {
  /** 下载档所在目录。 */
  versionsDir: string
  /** 要一并清掉的 npm 缓存目录（纯缓存，删了只影响下次装依赖的速度）。 */
  cacheDirs?: readonly string[]
  /** 已就位的下载版本。 */
  installed: readonly string[]
  /** 本机非下载档里最高的版本号；没有（读不出/体检不过）则跳过「重复副本」这条规则（偏保守：不误删）。 */
  bestLocal: string | undefined
  /** 正在用 / 等重启生效的版本号（绝不删）。 */
  protectedVersions: readonly string[]
  /** 比本机新的那些保留几份。 */
  keep?: number
  /** 失败留痕（默认丢弃）。 */
  log?: (line: string) => void
}

/**
 * 执行一次清理：算（{@link planPrune}）→ 删 → 报释放了多少。
 *
 * 删目录是不可逆动作，所以规则与执行分开：这里只管照着计划删，路径全部由 {@link PruneRequest}
 * 给，离线测试可以拿临时目录完整跑一遍（缓存删不掉这种 bug 就是靠这条路径测出来的——
 * 缓存目录在系统临时目录里，不在 vendor/ 底下，用 vendor/ 当归档根会被拒绝）。
 */
export function applyPrune(request: PruneRequest): PruneResult {
  const log = request.log ?? (() => {})
  const versionsDir = request.versionsDir
  const cacheDirs = request.cacheDirs ?? []
  const plan = planPrune(request.installed, request.bestLocal, request.protectedVersions, request.keep ?? 1)
  const sizeOf = (): number =>
    dirSize(versionsDir) + cacheDirs.reduce((total, dir) => total + dirSize(dir), 0)
  const before = sizeOf()
  for (const entry of plan.remove) {
    try {
      removeLinkOrDir(join(versionsDir, entry.version), versionsDir)
    } catch (error) {
      entry.reason += `（删除失败：${error instanceof Error ? error.message : String(error)}）`
      log(`删除 ${entry.version} 失败：${entry.reason}`)
    }
  }
  const warnings: string[] = []
  for (const cacheDir of cacheDirs) {
    // 缓存的允许根是它自己的父目录：缓存可能整个在插件目录外（系统临时目录那份），
    // 拿 vendor/ 当根会把「拒绝越界」抛出来、被静默吞掉，缓存永远清不掉
    try {
      removeLinkOrDir(cacheDir, dirname(cacheDir))
    } catch (error) {
      const message = `清理缓存 ${cacheDir} 失败：${error instanceof Error ? error.message : String(error)}`
      warnings.push(message)
      log(message)
    }
  }
  return {
    removed: plan.remove,
    kept: plan.keep,
    freedBytes: Math.max(0, before - sizeOf()),
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

/**
 * 插件启动时调：距上次检查超过间隔才真的发请求，绝不阻塞启动。
 *
 * 装了新版 pi-ai 要重启才生效，所以这里下好的是"下次启动用得上"的那份——目的是让新装的
 * 机器不用手点「检查更新」也能自动跟上上游。
 * @param logger - 宿主日志器。
 * @param activeVersion - 当前生效的 pi-ai 版本（见 {@link checkAndUpdate}）。
 */
export function startBackgroundCheck(logger: Logger | undefined, activeVersion: string | undefined): void {
  if (process.env.DSH_PROVIDER_UPDATE === 'off') return
  const last = readString(readState()['lastCheck'])
  if (last !== undefined && Date.now() - Date.parse(last) < AUTO_CHECK_INTERVAL_MS) return
  void checkAndUpdate((line) => logger?.info?.(`[pi-ai updater] ${line}`), activeVersion)
    .catch(() => undefined)
}
