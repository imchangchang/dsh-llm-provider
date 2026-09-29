/**
 * provider 配置的读写层：一套代码同时伺候 0.1.x 与 0.2.x 两代宿主。
 *
 * 两代宿主的差别（都实测过，见 README 的兼容矩阵）：
 *
 * | 能力 | 0.1.x | 0.2.x（0.2.0-rc.2） |
 * |---|---|---|
 * | 配置存在哪 | `settings.yaml` 的 `llm-pi-ai` 段，`settings.get/section(ns)` 读、`settings.mutate(ns, ops)` 写 | profile patch 里**插件条目自己的 config**；settings 服务没有 `get/section`，命名空间 = 已加载条目的 id |
 * | 官方 bundle 从哪拿 providers | 传入的 config 被 `settings.installSection(NS)` 当 **composition base**，解析结果是 `mergeLayers(base, 用户段)`（见 {@link mergeLayers} 的注释） | **只认传入的 config**（`config.providers.get()`），不再读 `llm-pi-ai` 段 |
 * | 写配置 | `settings.mutate('llm-pi-ai', ops)` | `ctx.configEditor.edit(条目, change)`（写 profile patch 并触发 Loader 重载）；`settings.mutate` 只剩「volatile 字段」且要求该 id 有活性条目 |
 *
 * 所以 0.2.x 上我们插件遭遇的是三重失效：桥接拿不到用户那批路由、路由发现依赖的
 * `settings.get/section` 不存在、写配置被 "No configurable plugin entry" 拒绝。
 *
 * 这一层的做法：
 *   1. **读**：两代宿主各按自己的合并语义算，因为「哪一层能写」不一样——
 *      0.1.x：老段就是可写的用户层，内置默认与条目 config 当 base，**逐字段递归合并**
 *      （{@link mergeLayers}），跟宿主解析出来的那份一致；
 *      0.2.x：老段写不进去，界面一写就把整份合并结果写进条目，条目从此整体接管
 *      （判据是 patch 行里有没有 `providers` 键，不看条数——删光时也是接管）。
 *   2. **写**：`configEditor.edit`（0.2.x）与 `settings.mutate('llm-pi-ai', …)`（0.1.x）
 *      两条策略都留着，按能力挑、失败就换另一条（自愈），并把成功的那条记进状态里给界面看。
 *      0.2.x 上写的是**整份合并结果**，于是老 `llm-pi-ai` 段里的路由被一次性搬进我们条目——
 *      之后删改都能生效（否则删一条只存在于老段里的路由会「点了没反应」）。
 *   3. **改**：merge / unset / unsetFields 三种操作。merge 是**逐字段**语义：只覆盖给到的键，
 *      手写的 `models` / `compat` / `retryPolicy` 一个字不动（issue #1 那条提醒）；要删字段得
 *      在 `unsets` 里说，要删整条走 `unset`——{@link applyProviderOp} 的两条路径语义一致。
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
  /**
   * 交给官方 bundle 的那份 providers（两代含义不同，都是「官方真正会看到的东西」）。
   *
   * 0.1.x：官方 bundle 把这份 config 交给 `settings.installSection(..., config, ...)` 当
   * **composition base**。dsh-settings 的解析是 `schema(mergeLayers(base, section))`，而
   * {@link mergeLayers} 是递归合并——base 里有的键一定活下来，用户在 section 里删不掉。
   * 所以这里只放界面写不进去的那部分（内置默认 + 本插件条目 config），用户那批路由靠
   * settings 的用户层叠上来（官方读的正是解析后的值）。
   *
   * 0.2.x：官方 bundle 只读 `config.providers.get()`，不碰 settings 层，所以这里就是完整的
   * {@link providers}（写少了就等于用户那批路由全丢）。
   */
  bridgeProviders: ProviderRecord
  /** 我们自己条目 config 里的 providers 条数。 */
  ownCount: number
  /** 老 `llm-pi-ai` 段里的条数。 */
  legacyCount: number
  /** 合并结果里有多少条来自内置默认。 */
  builtinCount: number
  /**
   * 哪个来源在说话：own（自己条目，0.2.x 写过的）/ legacy（老段）/ builtin（只有默认）。
   *
   * 0.2.x 上条目一有内容就整体接管，所以 own 优先；0.1.x 上老段可写、两层叠着，说话的是
   * 用户层（legacy），自己条目那份只是叠在下面的默认。
   */
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
  /**
   * 写不到的那些 route id：0.1.x 上它们在我们交给宿主的 composition base 里，
   * 而 base 之上的用户层表达不了「删除」（`mergeLayers` 只合并）。界面据此不给删除入口。
   */
  immutableIds: Set<string>
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

/**
 * 递归合并两层配置（与 dsh-settings 的 `mergeLayers(under, over)` 同语义：`over` 赢，
 * 普通对象逐层递归，其余值整体替换）。`undefined` 键跳过——稀疏 patch 不能擦掉下层。
 *
 * 为什么这里要跟宿主一模一样：0.1.x 上官方 bundle 读的是宿主解析后的值，我们自己也得算出
 * 同一份，界面显示的 provider 才等于真正生效的那份。
 */
export function mergeLayers(under: unknown, over: unknown): unknown {
  // 与宿主逐字同语义：over 缺席就留 under；任一侧不是普通对象就整体取 over（标量/数组/类实例
  // 都是「整层替换」）。写成「不是普通对象就给空对象」会把 `apiKeyEnv: 'X'` 这种叶子擦成 {}。
  if (over === undefined) return under
  if (!isPlainRecord(under) || !isPlainRecord(over)) return over
  const merged: AnyRecord = { ...under }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

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

/**
 * 老 `llm-pi-ai` 段：0.1.x 从 settings 服务读。
 *
 * **优先读 `section()`（用户层原文），只在没有 section 时才退回 `get()`**：`get()` 返回的是
 * 「composition base ∪ 用户层」的解析结果，我们交出去的 config 正是那个 base，拿它当用户层会
 * 自咬——用户在设置里删掉的路由会被 base 复活（实测 0.1.6：unset 掉 apiKeyEnv 后 `get()` 里
 * 那个 ref 还在，官方适配器照旧抛 MISSING_CREDENTIAL）。
 */
function legacyFromSettings(settings: SettingsService | undefined, warnings: string[]): { providers: ProviderRecord, read: boolean, error?: string } {
  if (settings === undefined) return { providers: {}, read: false }
  const resolvedWarning = `宿主只有 settings.get（没有 section），读到的是含 composition base 的合并值：在界面上删除老 ${LEGACY_NS} 段里的路由可能不生效`
  // 用户层原文。**空也算读到了**：用户把里面的路由删光是合法状态，不能因为空就退回去读 `get()`
  // ——那是「base ∪ 用户层」的解析值，会把用户刚删掉的路由又读回来（实测 0.1.6 就是这样）。
  if (typeof settings.section === 'function') {
    try {
      return { providers: providersOf(settings.section(LEGACY_NS)), read: true }
    } catch (error) {
      warnings.push(`settings.section('${LEGACY_NS}') 读失败：${messageOf(error)}`)
    }
  }
  // 没有 section（或它读不了）才退回 get()：读到的含 base，删不干净，得说出来
  if (typeof settings.get === 'function') {
    try {
      const providers = providersOf(settings.get(LEGACY_NS))
      warnings.push(resolvedWarning)
      return { providers, read: true }
    } catch (error) {
      const message = `settings.get('${LEGACY_NS}') 读失败：${messageOf(error)}`
      warnings.push(message)
      return { providers: {}, read: false, error: message }
    }
  }
  return { providers: {}, read: false }
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
 * 两代宿主的合并方式不同（因为能写的层不同，见模块头注释）：
 *   - 0.1.x（`settings` 宿主）：内置默认与条目 config 当 composition base，用户段（`section`）
 *     叠在上面逐字段合并；{@link ProviderConfigView.bridgeProviders} 只交 base 出去。
 *   - 0.2.x（`loader` 宿主）：条目一被界面写过（哪怕写成空的 `providers: {}`）就整体接管，
 *     否则内置默认叠上老段的行；{@link ProviderConfigView.bridgeProviders} 就是完整结果。
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
  // 内置默认 + 本插件条目 config：界面在 0.1.x 上写不到这两处，可以安全地当 composition base
  const compositionBase = mergeLayers(builtins, own) as ProviderRecord
  const settingsHost = legacySource === 'settings'
  // 「界面写过没有」不能只看 providers 条数：删掉最后一条路由时界面写下去的是
  // `providers: {}`，条数又回 0，于是下一次读又把内置默认（和老段残留）加回来——用户眼里
  // 就是「删不掉」，而 /provider/remove 这时已经把凭据清掉了，卡片直接变 MISSING_CREDENTIAL。
  // 所以看原始 patch 行里**有没有 providers 这个键**：有（哪怕是空对象）就是接管过了。
  const ownRaw = settingsHost ? undefined : loaderRowConfig(deps.loader, deps.entryId ?? OWN_ENTRY_ID)
  const takenOver = ownCount > 0 || (isPlainRecord(ownRaw) && Object.hasOwn(ownRaw, 'providers'))
  // 两代宿主的合并语义不一样，因为「哪一层可以写」不一样：
  //   0.1.x（settings）：老段就是用户层、可写，官方读的是 mergeLayers(base, section)。
  //     所以这里也逐字段深合并，界面显示的 provider 才等于真正生效的那份；base 里只放
  //     内置默认与条目 config，用户删掉的路由才不会被 base 复活（见 compositionBase 的注释）。
  //   0.2.x（loader）：老段所在的条目被 patch 禁着、写不进去，界面一写就把**整份合并结果**
  //     （含内置默认）写进本插件条目，条目从此整体接管：老段只当迁移来源，内置默认也不再额外
  //     加回来——不然用户删掉内置的那条路由（deepseek）下次读又会冒出来，看着像「删了没反应」。
  const providers: ProviderRecord = settingsHost
    ? (mergeLayers(compositionBase, legacy) as ProviderRecord)
    : (takenOver ? own : (mergeLayers(builtins, legacy) as ProviderRecord))
  // 条目接管之后，老段里新加/手改的路由不会再被读（生效的是条目那份）：说出来，别静默失效。
  // 0.1.x 不存在接管（两层是叠着的），所以只在 loader 宿主上提醒。
  if (!settingsHost && takenOver && legacyCount > 0) {
    const orphans = Object.keys(legacy).filter((id) => own[id] === undefined && deps.deletedIds?.has(id) !== true)
    if (orphans.length > 0) {
      warnings.push(`老 ${LEGACY_NS} 段里有 ${String(orphans.length)} 行已被插件条目覆盖（${orphans.slice(0, 5).join('、')}${orphans.length > 5 ? '…' : ''}）：界面以条目为准，这些行不再生效（要清理就手改 profile patch）`)
    }
  }
  return {
    providers,
    bridgeProviders: settingsHost ? compositionBase : providers,
    ownCount,
    legacyCount,
    // 合并结果里有多少条来自内置默认：0.2.x 上条目接管后内置默认不再额外加回来，就是 0
    builtinCount: !settingsHost && takenOver ? 0 : Object.keys(builtins).length,
    mode: settingsHost
      ? (legacyCount > 0 ? 'legacy' : (ownCount > 0 ? 'own' : 'builtin'))
      : (takenOver ? 'own' : (legacyCount > 0 ? 'legacy' : 'builtin')),
    // 写不动的那些 route id（0.1.x 上在 composition base 里的）：界面不该给删除入口，
    // /provider/remove 也要拦住——路由删不掉、凭据却被清了，卡片会变成 MISSING_CREDENTIAL
    immutableIds: settingsHost ? new Set(Object.keys(compositionBase)) : new Set<string>(),
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
  // 删空也要留着这条路由（`{routeId: {}}`）：空 profile 是合法的（两代 profile schema 只有
  // `models[].id` 是必填），而且正是 OAuth-only 路由的形态——凭据在授权记录里，配置里没有字段。
  // 顺手摘掉会造成「点一下『改用 OAuth 认证』provider 就没了」：那条路由常见形状恰好只有
  // apiKeyEnv 一个字段。要删整条走 `unset`（/provider/remove 就是那条），两条 op 各司其职。
  next[op.routeId] = merged
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
  let lastRealError: unknown
  // 抛出去时的原因清单：与 warnings 分开记——「这条写路径这个宿主上没有」不该进界面的告警，
  // 但两条都不通时说清原因还是要的（不然错误文案以「：」结尾，看不出为什么）
  const reasons: string[] = []
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
      const reason = `${strategy === 'config-editor' ? 'configEditor.edit' : 'settings.mutate'}：${messageOf(error)}`
      reasons.push(reason)
      // 服务压根不在（0.1.x 没有 configEditor / 0.2.x 的 settings 写不了）不算「失败告警」——
      // 那是版本差异，不是故障；只有真的调用出错才值得报给用户
      if (!(error instanceof ProviderWriteUnavailable)) {
        warnings.push(reason)
        lastRealError = error
      }
    }
  }
  // 界面上「上一次写配置失败」要显示**真正的原因**：逐条试的时候最后一条往往只是
  // 「这个宿主上没有 configEditor」，把它当失败原因会把用户引到错的地方
  state.lastError = messageOf(lastRealError ?? lastError)
  throw new Error(`写 provider 配置失败（两条路都不通）：${reasons.join('；')}`)
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
  Object.defineProperty(shim, 'get', {
    // 不可枚举：0.1.x 的 Object.entries 不会把它当成一条路由，structuredClone 也不碰它
    value: () => {
      // 每次都重读一遍。**不能**按「宿主那份 providers 的 identity」决定要不要重读：我们自己的
      // 条目 config 变更时（volatile 快路径，插件不重挂）宿主那份未必换过对象，那样判成「没变」
      // 就永远返回挂载那一刻的旧值——界面写了配置要重启 dsh 才生效，正是这个形态。
      // 重读代价是几次对象拼装 + 遍历 loader 条目，可以接受。
      const next = liveProviders()
      // 内容没变就复用同一个对象：官方那套 identity 记忆化才认为「配置没动」，不会白算
      if (sameContent(lastMerged, next)) return lastMerged
      lastMerged = next
      return lastMerged
    },
    enumerable: false,
  })
  if (!isPlainRecord(config)) return { providers: shim }
  return { ...config, providers: shim }
}

/**
 * 从 loader 条目列表里取某个条目那一行的**原始** config（0.2.x 的 profile patch 行）。
 *
 * 为什么要原始那份：`options.config` 是 patch 行里的原文，键在不在看得见；解析后的 config
 * 里 `providers: {}` 与「压根没写过」长得一样，而这两件事的行为不一样（见 takenOver）。
 */
function loaderRowConfig(loader: LoaderService | undefined, entryId: string): AnyRecord | undefined {
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  try {
    const listed = loader.entries()
    for (const entry of (Array.isArray(listed) ? listed : [...(listed as Iterable<unknown>)])) {
      const options = asRecord(asRecord(entry)['options'])
      if (readString(options['id']) !== entryId) continue
      return asRecord(options['config'])
    }
  } catch {
    /* 读不到就当没有：takenOver 退回按条数判断 */
  }
  return undefined
}

/** 从 loader 条目里取 options.id（形状不认识就给 undefined）。 */
function entryIdOf(row: unknown): string | undefined {
  const options = asRecord(asRecord(row)['options'])
  return readString(options['id'])
}

/**
 * 两份配置「内容一样吗」（{@link configWithProviders} 用它决定要不要复用同一个对象）。
 *
 * 不用 JSON.stringify 当指纹：那会把 Map/Set/RegExp 之类一律写成 `{}`，内容变了却判成没变，
 * `get()` 就永远返回旧值；`undefined` 还得靠哨兵，又可能和真值撞车。这里直接比结构：
 *   - 同一个引用（配置多半是冻住的快照，没变时就是同一个对象）→ 一次 `===` 结束
 *   - 普通对象逐键比、数组逐项比
 *   - 其余（Map/Set/RegExp/函数/类实例…）只认同一个引用：认不出就当「变了」，重算一遍
 *     总比留住旧值强
 * 递归有深度上限，防止两份不同的循环引用互相追下去；超限按「变了」处理。
 */
function sameContent(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (depth > 24) return false
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameContent(item, b[index], depth + 1))
  }
  // 普通对象才逐键比。**不能用 isPlainRecord**：它只排除数组，Map/Set 在它眼里也是「记录」，
  // 而 Map 的条目不是自有可枚举属性（Object.keys 为空）——两个内容不同的 Map 会被判成一样。
  // 这里按原型判断：只认 Object.prototype / null 原型（配置的普通对象、冻结快照都算）。
  if (!isStrictPlainObject(a) || !isStrictPlainObject(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false
    if (!sameContent(a[key], b[key], depth + 1)) return false
  }
  return true
}

/** 普通对象（原型是 Object.prototype 或 null）：Map/Set/RegExp/类实例都不算。 */
function isStrictPlainObject(value: unknown): value is AnyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
