/**
 * provider 配置的读写层：一套代码同时伺候 0.1.x 与 0.2.x 两代宿主。
 *
 * 两代宿主的差别（都实测过，见 README 的兼容矩阵）：
 *
 * | 能力 | 0.1.x | 0.2.x（0.2.0-rc.2） |
 * |---|---|---|
 * | 配置存在哪 | `settings.yaml` 的 `llm-pi-ai` 段，`settings.get/section(ns)` 读、`settings.mutate(ns, ops)` 写 | profile patch 里**插件条目自己的 config**；settings 服务没有 `get/section`，命名空间 = 已加载条目的 id |
 * | 官方 bundle 从哪拿 providers | 传入的 config **+ `settings.installSection(NS)` 把 `llm-pi-ai` 段叠上来** | **只认传入的 config**（`config.providers.get()`），不再读 `llm-pi-ai` 段 |
 * | 写配置 | `settings.mutate('llm-pi-ai', ops)` | `ctx.configEditor.edit(条目, change)`（写 profile patch 并触发 Loader 重载）；`settings.mutate` 只剩「volatile 字段」且要求该 id 有活性条目 |
 *
 * 所以 0.2.x 上我们插件遭遇的是三重失效：桥接拿不到用户那批路由、路由发现依赖的
 * `settings.get/section` 不存在、写配置被 "No configurable plugin entry" 拒绝。
 *
 * 这一层的做法：
 *   1. **读**：多个来源依次尝试，合并成一份 providers——
 *      内置默认（最低） < 老 `llm-pi-ai` 段（0.1.x 的 settings、0.2.x 的 profile patch 行）
 *      < **我们自己条目的 config**（0.2.x 上由界面写进去的那份，最高；一旦非空就整体接管，
 *      因为写的时候是整份写下去的，见下）。
 *   2. **写**：`configEditor.edit`（0.2.x）与 `settings.mutate('llm-pi-ai', …)`（0.1.x）
 *      两条策略都留着，按能力挑、失败就换另一条（自愈），并把成功的那条记进状态里给界面看。
 *      0.2.x 上写的是**整份合并结果**，于是老 `llm-pi-ai` 段里的路由被一次性搬进我们条目——
 *      之后删改都能生效（否则删一条只存在于老段里的路由会「点了没反应」）。
 *   3. **改**：merge / unset / unsetFields 三种操作。merge 是**逐字段**语义：只覆盖给到的键，
 *      手写的 `models` / `compat` / `retryPolicy` 一个字不动（issue #1 那条提醒）。
 */
import { asRecord, readString, type AnyRecord, type ConfigEditorService, type LoaderService, type SettingsService } from './types.js'

/** providers 记录：route id → 路由配置（原样透传，不做结构假设）。 */
export type ProviderRecord = Record<string, unknown>

/** 官方条目（老命名空间）的 id：0.1.x 的 settings 段名，0.2.x 的 profile patch 行 id。 */
export const LEGACY_NS = 'llm-pi-ai'

/** 本插件自己的条目 id：0.2.x 上配置写在它名下（也是 settings 命名空间的 id）。 */
export const OWN_ENTRY_ID = 'dsh-llm-provider'

/**
 * 内置默认路由（最低优先级）。
 *
 * 以前这份默认写在 `cordis.patch.yml` 的 `config.providers.deepseek` 里，但 0.2.x 上
 * 「我们条目的 config」同时是界面写配置的落点——默认值与用户写入混在一个键里就分不清优先级了，
 * 所以把默认提到代码里，条目 config 只留用户/界面写的那份。
 */
export const BUILTIN_PROVIDERS: ProviderRecord = {
  deepseek: { displayName: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
}

/** 写操作：改哪条路由、怎么改。 */
export type ProviderOp =
  | {
    op: 'merge'
    routeId: string
    value: AnyRecord
    /**
     * 合并完之后要从这条路由上删掉的字段名。
     *
     * 「set 整个对象」时代省略一个字段就等于删掉它；现在是逐字段合并，省略没有任何效果。
     * OAuth 那条路踩过这个坑：授权成功后不再写 `apiKeyEnv`，可老配置里那个 ref 还在，
     * 官方适配器看到 `apiKeyEnv` 就只认它，取不到值直接抛 MISSING_CREDENTIAL。
     * 所以「要删」必须显式说出来。
     */
    unsets?: readonly string[]
  }
  | { op: 'unset', routeId: string }
  | { op: 'unsetFields', routeId: string, fields: readonly string[] }

/** 读的结果：合并后的 providers + 各来源的条数（诊断用）。 */
export interface ProviderConfigView {
  providers: ProviderRecord
  /** 我们自己条目 config 里的 providers 条数。 */
  ownCount: number
  /** 老 `llm-pi-ai` 段里的条数。 */
  legacyCount: number
  /** 合并结果里有多少条来自内置默认。 */
  builtinCount: number
  /** 哪个来源在说话：own（自己条目，0.2.x 写过的）/ legacy（老段）/ builtin（只有默认）。 */
  mode: 'own' | 'legacy' | 'builtin'
  /**
   * 老段是从哪儿读的：settings（0.1.x）/ loader（0.2.x 的 profile patch 行）/ none（两处都没读成）。
   *
   * `none` 且带 {@link ProviderConfigView.legacyError} 时说明「有这个来源但读失败了」——
   * 这种情况下不能拿一份「只有内置默认」的集合去整份覆盖用户配置，见 writeProviderRoutes 的护栏。
   */
  legacySource: 'settings' | 'loader' | 'none'
  /** 老段读取失败的原因（读成功但为空不算失败）。 */
  legacyError?: string
  /** 读的过程中遇到的非致命问题（界面上要能看见，不能只进日志）。 */
  warnings: string[]
}

/** 读写层要用到的宿主服务（都可缺席：缺席就跳过那条路）。 */
export interface ProviderConfigDeps {
  settings?: SettingsService | undefined
  configEditor?: ConfigEditorService | undefined
  loader?: LoaderService | undefined
  /** 本插件 apply 拿到的 config（schemastery 代理或普通对象都行）。 */
  ownConfig?: unknown
  /** 本插件条目 id（默认 {@link OWN_ENTRY_ID}）。 */
  entryId?: string
  /** 内置默认（默认 {@link BUILTIN_PROVIDERS}）。 */
  builtins?: ProviderRecord
  /**
   * 本次会话里被界面删掉的 route id。
   *
   * 删除在 0.2.x 上写的是「整份合并结果」，老段里那一行删不掉（条目被 patch 禁着），
   * 于是每次读都会把它算成「孤儿」。用户刚删完就看到那条告警会以为没删掉，所以这里排掉。
   */
  deletedIds?: ReadonlySet<string>
}

const isPlainRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 从一个 config（或 providers 值）里取出 providers 记录；认不出就给空对象。 */
export function providersOf(config: unknown): ProviderRecord {
  if (!isPlainRecord(config)) return {}
  const raw = (config as AnyRecord)['providers']
  // 0.2.x 的 config 是 schemastery 代理：providers 是带 .get() 的访问器
  const value = isPlainRecord(raw) && typeof (raw as AnyRecord)['get'] === 'function'
    ? (raw as { get: () => unknown }).get()
    : raw
  if (!isPlainRecord(value)) return {}
  const out: ProviderRecord = {}
  for (const [key, entry] of Object.entries(value)) out[key] = entry
  return out
}

/** 老 `llm-pi-ai` 段：0.1.x 从 settings 服务读，取不到再退回 section()。 */
function legacyFromSettings(settings: SettingsService | undefined, warnings: string[]): { providers: ProviderRecord, read: boolean, error?: string } {
  if (settings === undefined) return { providers: {}, read: false }
  const readers: { name: string, read: () => unknown }[] = []
  if (typeof settings.get === 'function') readers.push({ name: 'settings.get', read: () => settings.get?.(LEGACY_NS) })
  if (typeof settings.section === 'function') readers.push({ name: 'settings.section', read: () => settings.section?.(LEGACY_NS) })
  let lastError: string | undefined
  for (const reader of readers) {
    try {
      const providers = providersOf(reader.read())
      // 「读成功但为空」也算读到了：宿主这个版本就是没有这一节，没什么可丢的
      if (Object.keys(providers).length > 0) return { providers, read: true }
      lastError = undefined
    } catch (error) {
      // 这一条读法不可用：留痕（宿主版本差异就靠这条线索），再试下一条
      lastError = `${reader.name}('${LEGACY_NS}') 读失败：${messageOf(error)}`
      warnings.push(lastError)
    }
  }
  return { providers: {}, read: readers.length > 0 && lastError === undefined, ...(lastError === undefined ? {} : { error: lastError }) }
}

/**
 * 老 `llm-pi-ai` 段：0.2.x 上 settings 服务没有 get/section，段还在 profile patch 的那一行里。
 *
 * 那一行的位置：**loader 的条目列表**（profile 的根 include 把各层 patch 组合成条目树，
 * 每行一个 Entry，`options.id` / `options.config` 就是行本身）。注意不是 include 条目自己的
 * config——那是 `{path, patches}`（Include 的配置），曾经照它读，结果永远读不到东西。
 *
 * @param loader - loader 服务。
 * @param warnings - 失败留痕。
 */
function legacyFromLoader(loader: LoaderService | undefined, warnings: string[]): { providers: ProviderRecord, read: boolean, error?: string } {
  if (loader === undefined || typeof loader.entries !== 'function') return { providers: {}, read: false }
  let entries: unknown[]
  try {
    const listed = loader.entries()
    entries = Array.isArray(listed) ? listed : [...(listed as Iterable<unknown>)]
  } catch (error) {
    const message = `loader.entries() 读失败：${messageOf(error)}`
    warnings.push(message)
    return { providers: {}, read: false, error: message }
  }
  if (entries.length === 0) {
    // loader 在场却一条条目都没有：树还没建好，或我们的读法又错了。算「可疑」而不是
    // 「读到了但没有」，护栏才拦得住整份覆盖（否则会把用户已有路由删光）
    const message = 'loader.entries() 没列出任何条目'
    warnings.push(message)
    return { providers: {}, read: false, error: message }
  }
  // 能列出条目就算「读到了」：里面没有 llm-pi-ai 那行说明本来就没有老段，没什么可丢的
  for (const entry of entries) {
    const options = asRecord(asRecord(entry)['options'])
    if (readString(options['id']) !== LEGACY_NS) continue
    // 行被 disable 也一样读：配置还在，只是这一行没挂载
    return { providers: providersOf(options['config']), read: true }
  }
  return { providers: {}, read: true }
}

/**
 * 读一份合并后的 provider 配置。
 *
 * 合并优先级（低 → 高）：内置默认 → 老 `llm-pi-ai` 段 → 我们条目自己的 config。
 * 我们条目的 providers 非空时**整体接管**：写下去的就是整份合并结果（见 writeProviderRoutes），
 * 界面上的改动因此不会被老段里的同 id 路由shadow掉。
 */
export function readProviderConfig(deps: ProviderConfigDeps): ProviderConfigView {
  const warnings: string[] = []
  const fromSettings = legacyFromSettings(deps.settings, warnings)
  let legacy = fromSettings.providers
  let legacySource: ProviderConfigView['legacySource'] = fromSettings.read ? 'settings' : 'none'
  let legacyError = fromSettings.error
  if (!fromSettings.read) {
    const fromLoader = legacyFromLoader(deps.loader, warnings)
    legacy = fromLoader.providers
    if (fromLoader.read) legacySource = 'loader'
    legacyError = fromLoader.error ?? legacyError
  }
  let own: ProviderRecord = {}
  try {
    own = providersOf(deps.ownConfig)
  } catch (error) {
    warnings.push(`读本插件条目 config 失败：${messageOf(error)}`)
  }
  const builtins = deps.builtins ?? BUILTIN_PROVIDERS
  const ownCount = Object.keys(own).length
  const legacyCount = Object.keys(legacy).length
  const base = ownCount > 0 ? own : legacy
  const providers: ProviderRecord = { ...builtins, ...base }
  // 条目接管之后，老段里新加/手改的路由不会再被读（生效的是条目那份）：说出来，别静默失效
  if (ownCount > 0 && legacyCount > 0) {
    const orphans = Object.keys(legacy).filter((id) => own[id] === undefined && deps.deletedIds?.has(id) !== true)
    if (orphans.length > 0) {
      warnings.push(`老 ${LEGACY_NS} 段里有 ${String(orphans.length)} 行已被插件条目覆盖（${orphans.slice(0, 5).join('、')}${orphans.length > 5 ? '…' : ''}）：界面以条目为准，这些行不再生效（要清理就手改 profile patch）`)
    }
  }
  return {
    providers,
    ownCount,
    legacyCount,
    builtinCount: Object.keys(builtins).length,
    mode: ownCount > 0 ? 'own' : (legacyCount > 0 ? 'legacy' : 'builtin'),
    legacySource,
    ...(legacyError === undefined ? {} : { legacyError }),
    warnings,
  }
}

/**
 * 把一次写操作应用到 providers 记录上（纯函数，离线可测）。
 *
 * `merge` 是**逐字段浅合并**：只动给到的键，其它键（手写的 `models` / `compat` / `retryPolicy`）
 * 原样保留。跟宿主 settings 的 `applyPathOp` 对 `set` 的语义一致，两代宿主行为相同。
 */
export function applyProviderOp(providers: ProviderRecord, op: ProviderOp): ProviderRecord {
  const next: ProviderRecord = { ...providers }
  if (op.op === 'unset') {
    delete next[op.routeId]
    return next
  }
  const existing = isPlainRecord(next[op.routeId]) ? (next[op.routeId] as AnyRecord) : undefined
  if (op.op === 'merge') {
    const merged: AnyRecord = { ...(existing ?? {}), ...op.value }
    for (const field of op.unsets ?? []) delete merged[field]
    next[op.routeId] = merged
    return next
  }
  const merged: AnyRecord = { ...(existing ?? {}) }
  for (const field of op.fields) delete merged[field]
  if (Object.keys(merged).length === 0) delete next[op.routeId]
  else next[op.routeId] = merged
  return next
}

/**
 * `/provider/status` 里的 `providerStore` 片段（纯函数，离线可测）。
 *
 * 界面的「pi-ai 桥接 → 配置写入」那一行读它。抽出来是因为这里出过一次岔子：客户端加了读取、
 * 宿主 payload 却没这个字段，界面那行永远不渲染，而渲染函数的测试自己造了对象，测不出来。
 *
 * @param view - {@link readProviderConfig} 的结果。
 * @param state - 写策略记忆。
 * @param entryId - 本插件条目 id。
 */
export function providerStoreStatus(
  view: ProviderConfigView,
  state: ProviderWriteState,
  entryId: string,
): AnyRecord {
  return {
    mode: view.mode,
    ownCount: view.ownCount,
    legacyCount: view.legacyCount,
    builtinCount: view.builtinCount,
    legacySource: view.legacySource,
    via: state.via ?? null,
    lastError: state.lastError ?? null,
    entryId,
    legacyNs: LEGACY_NS,
    warnings: view.warnings,
  }
}

/**
 * 解析客户端发来的写请求（纯函数，离线可测）。
 *
 * 形状：`{ routeId, op: 'merge'|'unset'|'unsetFields', value?, fields? }`。
 * 认不出就返回 undefined——调用方回 400，不要拿一个半懂的操作去改配置。
 */
export function parseProviderOp(input: unknown): ProviderOp | undefined {
  const record = asRecord(input)
  const routeId = readString(record['routeId'])
  if (routeId === undefined || routeId === '') return undefined
  const op = readString(record['op'])
  if (op === 'unset') return { op: 'unset', routeId }
  if (op === 'unsetFields') {
    const fields = Array.isArray(record['fields'])
      ? record['fields'].filter((field): field is string => typeof field === 'string' && field !== '')
      : []
    return { op: 'unsetFields', routeId, fields }
  }
  if (op === 'merge') {
    if (!isPlainRecord(record['value'])) return undefined
    const unsets = Array.isArray(record['unsets'])
      ? record['unsets'].filter((field): field is string => typeof field === 'string' && field !== '')
      : undefined
    return unsets === undefined || unsets.length === 0
      ? { op: 'merge', routeId, value: record['value'] }
      : { op: 'merge', routeId, value: record['value'], unsets }
  }
  return undefined
}

/**
 * 「这条写路径在这个宿主上不存在」——不是故障，是版本差异（0.1.x 没有 configEditor、
 * 0.2.x 的 settings 写不进老命名空间）。不塞进 warnings，免得界面上天天挂着假告警。
 */
class ProviderWriteUnavailable extends Error {}

/** 写成功后记住走的哪条路（自愈：下次先用它，失败再换另一条）。 */
export interface ProviderWriteState {
  via?: 'config-editor' | 'settings-mutate'
  lastError?: string
}

/** 一次写的结果。 */
export interface ProviderWriteResult {
  via: 'config-editor' | 'settings-mutate'
  /** 写下去（或写成功后应当生效）的完整 providers。 */
  providers: ProviderRecord
  /** 被放弃的策略及其原因（界面上要能说明白为什么换路）。 */
  warnings: string[]
}

/**
 * 写 provider 配置：两条策略按能力挑、失败自动换另一条。
 *
 * - `config-editor`：0.2.x。写我们**自己条目**的完整 config（profile patch），
 *   Loader 随即重载本插件，新的 providers 会经 {@link readProviderConfig} 生效。
 * - `settings-mutate`：0.1.x。写 `llm-pi-ai` 段，逐字段 op（merge 不会覆盖同路由的其它键）。
 *
 * 记忆：`state.via` 是上次成功的那条，优先重试；它失败就换另一条并更新记忆——这样
 * 宿主升级/降级、条目被禁用、profile patch 被 home patch 覆盖之类的变化都能自愈。
 *
 * @param deps - 宿主服务。
 * @param op - 要做的改动。
 * @param state - 跨调用记忆（调用方持有，通常挂在插件实例上）。
 */
export async function writeProviderRoutes(
  deps: ProviderConfigDeps,
  op: ProviderOp,
  state: ProviderWriteState = {},
): Promise<ProviderWriteResult> {
  const view = readProviderConfig(deps)
  const providers = applyProviderOp(view.providers, op)
  const warnings: string[] = [...view.warnings]
  // 按能力挑默认顺序：有 configEditor 就先试它（0.2.x 只有它行得通），没有就直接用 settings.mutate。
  // 记忆优先：上次哪条成功先试它，失败再换——宿主升降级、条目失效都能自愈。
  const capable: ('config-editor' | 'settings-mutate')[] = typeof deps.configEditor?.edit === 'function'
    ? ['config-editor', 'settings-mutate']
    : ['settings-mutate', 'config-editor']
  const strategies = state.via === undefined
    ? capable
    : [state.via, ...capable.filter((item) => item !== state.via)]
  let lastError: unknown
  for (const strategy of strategies) {
    try {
      if (strategy === 'config-editor') {
        // 护栏：整份写入会把条目变成「权威来源」。当我们既没读到老段、条目里又是空的
        // （说明有这个来源但读失败了），这份 providers 只含内置默认——写下去等于把用户
        // 现有的路由全删了。宁可失败并说清原因，也不能静默覆盖。
        if (view.legacySource === 'none' && view.ownCount === 0 && view.legacyError !== undefined) {
          throw new Error(`读不到现有的 provider 配置（${view.legacyError}），拒绝整份覆盖以免丢掉已有路由`)
        }
        await writeViaConfigEditor(deps, providers)
      } else await writeViaSettings(deps, op)
      state.via = strategy
      state.lastError = undefined
      return { via: strategy, providers, warnings }
    } catch (error) {
      lastError = error
      // 服务压根不在（0.1.x 没有 configEditor / 0.2.x 的 settings 写不了）不算「失败告警」——
      // 那是版本差异，不是故障；只有真的调用出错才值得报给用户
      if (!(error instanceof ProviderWriteUnavailable)) {
        warnings.push(`${strategy === 'config-editor' ? 'configEditor.edit' : 'settings.mutate'} 失败：${messageOf(error)}`)
      }
    }
  }
  state.lastError = messageOf(lastError)
  throw new Error(`写 provider 配置失败（两条路都不通）：${warnings.join('；')}`)
}

/** 0.2.x：把我们条目的完整 config 写进 profile patch。 */
async function writeViaConfigEditor(deps: ProviderConfigDeps, providers: ProviderRecord): Promise<void> {
  const editor = deps.configEditor
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    throw new ProviderWriteUnavailable('宿主没有 configEditor 服务（0.1.x 的形状）')
  }
  const entryId = deps.entryId ?? OWN_ENTRY_ID
  const entry = editor.entries().find((row) => entryIdOf(row) === entryId)
  if (entry === undefined) throw new Error(`找不到本插件的配置条目 "${entryId}"（条目被禁用或不在 profile 根 include 下）`)
  await editor.edit(entry, (current: unknown) => {
    const base = isPlainRecord(current) ? current : {}
    return { ...base, providers }
  })
}

/** 0.1.x：逐字段写 `llm-pi-ai` 段（merge 不覆盖同路由的其它键）。 */
async function writeViaSettings(deps: ProviderConfigDeps, op: ProviderOp): Promise<void> {
  const settings = deps.settings
  if (settings === undefined || typeof settings.mutate !== 'function') {
    throw new ProviderWriteUnavailable('宿主没有可写的 settings 服务')
  }
  const path = ['providers', op.routeId]
  if (op.op === 'unset') {
    await settings.mutate(LEGACY_NS, [{ op: 'unset', path }])
    return
  }
  if (op.op === 'unsetFields') {
    if (op.fields.length === 0) return
    await settings.mutate(LEGACY_NS, op.fields.map((field) => ({ op: 'unset' as const, path: [...path, field] })))
    return
  }
  const ops: { op: 'set' | 'unset', path: string[], value?: unknown }[] = Object.keys(op.value)
    .filter((key) => op.value[key] !== undefined)
    .map((key) => ({ op: 'set' as const, path: [...path, key], value: op.value[key] }))
  // 逐字段合并下「省略不等于删」，要删的字段得翻成 unset 一起发过去（OAuth 清 apiKeyEnv 走这条）。
  // 漏掉它的话 0.2.x 正常、0.1.x 上那个 ref 还在，两条路的行为就不一致了。
  for (const field of op.unsets ?? []) ops.push({ op: 'unset', path: [...path, field] })
  if (ops.length === 0) return
  await settings.mutate(LEGACY_NS, ops)
}

/**
 * 把合并后的 providers 塞进要交给官方 bundle 的 config（**活值**，不是快照）。
 *
 * 两代 bundle 的读法不同，这个对象两边都伺候：
 *   - 0.1.x：`Object.entries(config.providers ?? {})` —— 要普通对象、且有可枚举的路由键；
 *     它还会把这份 config 当 settings 段的 base 交给 `installSection`，宿主会对它做
 *     `structuredClone`（dsh-settings 的 describe），所以**不能是 Proxy**（实测 DataCloneError）。
 *   - 0.2.x：`config.providers.get()` —— 要一个访问器。
 *
 * 为什么 `get()` 必须读活值：0.2.x 上我们条目的 config 变更走 Loader 的 volatile 快路径，
 * **不会重挂插件**（`equalExceptVolatile` 判真 → 只就地更新 resolved config 的 ref）。
 * 如果这里给一份 apply 时的快照，官方 bundle 的 `config.providers.get()` 就永远停在挂载那一刻，
 * `profiles()` 因 identity 不变吃 memo、适配器/模型发现/目录全不更新——界面写了配置要重启 dsh 才生效。
 * 所以每次读都问一遍 `liveProviders()`；读回来的内容与上次相同就复用同一个对象（按内容指纹比），
 * 这样官方那套 identity 记忆化仍然有效，内容真变了才给新对象。
 *
 * @param config - 本插件 apply 拿到的 config（0.2.x 是 schemastery 代理，0.1.x 是普通对象）。
 * @param liveProviders - 取当前合并结果（每次读都会调用一遍，必须是「现在这一刻」的值）。
 */
export function configWithProviders(config: unknown, liveProviders: () => ProviderRecord): AnyRecord {
  const snapshot = liveProviders()
  // 枚举键是 apply 那一刻的快照：0.1.x 的官方 bundle 用 `Object.entries(config.providers)` 读，
  // 而宿主对这份 config 做 structuredClone（Proxy 会抛 DataCloneError），所以这里只能是普通对象。
  const shim: AnyRecord = { ...snapshot }
  let lastMerged = snapshot
  let lastSignature = signatureOf(snapshot)
  Object.defineProperty(shim, 'get', {
    // 不可枚举：0.1.x 的 Object.entries 不会把它当成一条路由，structuredClone 也不碰它
    value: () => {
      // 每次都重读一遍。**不能**按「宿主那份 providers 的 identity」决定要不要重读：我们自己的
      // 条目 config 变更时（volatile 快路径，插件不重挂）宿主那份未必换过对象，那样判成「没变」
      // 就永远返回挂载那一刻的旧值——界面写了配置要重启 dsh 才生效，正是这个形态。
      // 重读代价是几次对象拼装 + 遍历 loader 条目，可以接受。
      const next = liveProviders()
      const signature = signatureOf(next)
      // 内容没变就复用同一个对象：官方那套 identity 记忆化才认为「配置没动」，不会白算
      if (signature !== undefined && signature === lastSignature) return lastMerged
      lastMerged = next
      lastSignature = signature
      return lastMerged
    },
    enumerable: false,
  })
  if (!isPlainRecord(config)) return { providers: shim }
  return { ...config, providers: shim }
}

/** 从 loader 条目里取 options.id（形状不认识就给 undefined）。 */
function entryIdOf(row: unknown): string | undefined {
  const options = asRecord(asRecord(row)['options'])
  return readString(options['id'])
}

/** 给 {@link signatureOf} 里出现过的函数编号（同一个函数要拿到同一个号）。 */
const functionIds = new WeakMap<object, number>()
/** WeakMap 没有 size，自己数。 */
let functionIdCount = 0

/** 取（必要时分配）某个函数的编号。 */
function functionIdOf(fn: object): number {
  const existing = functionIds.get(fn)
  if (existing !== undefined) return existing
  functionIdCount += 1
  functionIds.set(fn, functionIdCount)
  return functionIdCount
}

/**
 * 配置内容指纹（{@link configWithProviders} 用它判断「内容变了没有」）。
 *
 * `undefined` 这类值 JSON 会丢掉，两份只在 `undefined` 字段上不同的配置就会被判成一样——
 * 用一个不会出现在配置里的哨兵替掉它。算不出来（循环引用之类）就给 `undefined`，调用方
 * 按「变了」处理：宁可多算一次，也不能留住旧值。
 */
function signatureOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      // JSON 会丢掉 undefined，两个只在 undefined 字段上不同的配置会被判成一样 → 换哨兵
      if (item === undefined) return '\u0000undefined'
      // 函数同理（配置里基本不该出现，出现了也不能让两个不同的函数算成同一个）
      if (typeof item === 'function') return `\u0000function:${String(functionIdOf(item as object))}`
      return item
    })
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
