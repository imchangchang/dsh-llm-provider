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
  | { op: 'merge', routeId: string, value: AnyRecord }
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
function legacyFromSettings(settings: SettingsService | undefined, warnings: string[]): ProviderRecord {
  if (settings === undefined) return {}
  const readers: { name: string, read: () => unknown }[] = []
  if (typeof settings.get === 'function') readers.push({ name: 'settings.get', read: () => settings.get?.(LEGACY_NS) })
  if (typeof settings.section === 'function') readers.push({ name: 'settings.section', read: () => settings.section?.(LEGACY_NS) })
  for (const reader of readers) {
    try {
      const providers = providersOf(reader.read())
      if (Object.keys(providers).length > 0) return providers
    } catch (error) {
      // 这一条读法不可用：留痕（宿主版本差异就靠这条线索），再试下一条
      warnings.push(`${reader.name}('${LEGACY_NS}') 读失败：${messageOf(error)}`)
    }
  }
  return {}
}

/**
 * 老 `llm-pi-ai` 段：0.2.x 上 settings 服务没有 get/section，段还留在 profile patch 的那一行里。
 *
 * 从 loader 的根 include 条目拿补丁行（宿主自己的 config-editor 也是这么找条目的），
 * 递归展开 `insert`，找 `id === 'llm-pi-ai'` 且带 `config.providers` 的那一行。
 */
function legacyFromLoader(loader: LoaderService | undefined, warnings: string[]): ProviderRecord {
  if (loader === undefined || typeof loader.entries !== 'function') return {}
  let rows: unknown
  try {
    const entries = loader.entries()
    if (!Array.isArray(entries)) return {}
    const include = entries.find((entry) => readString(asRecord(entry)['id']) === 'include')
    rows = include === undefined ? undefined : asRecord(include)['config']
  } catch (error) {
    warnings.push(`loader.entries() 读失败：${messageOf(error)}`)
    return {}
  }
  const found = findPatchRow(rows, LEGACY_NS)
  return providersOf(found)
}

/** 在补丁行数组（可能嵌套 insert）里找一条 id 匹配的行，返回它的 config。 */
function findPatchRow(rows: unknown, id: string): unknown {
  if (!Array.isArray(rows)) return undefined
  for (const raw of rows) {
    const row = asRecord(raw)
    if (readString(row['id']) === id && row['config'] !== undefined) return row['config']
    const nested = findPatchRow(row['insert'], id)
    if (nested !== undefined) return nested
  }
  return undefined
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
  let legacy = legacyFromSettings(deps.settings, warnings)
  if (Object.keys(legacy).length === 0) legacy = legacyFromLoader(deps.loader, warnings)
  let own: ProviderRecord = {}
  try {
    own = providersOf(deps.ownConfig)
  } catch (error) {
    warnings.push(`读本插件条目 config 失败：${messageOf(error)}`)
  }
  const builtins = deps.builtins ?? BUILTIN_PROVIDERS
  const ownCount = Object.keys(own).length
  const base = ownCount > 0 ? own : legacy
  const providers: ProviderRecord = { ...builtins, ...base }
  return {
    providers,
    ownCount,
    legacyCount: Object.keys(legacy).length,
    builtinCount: Object.keys(builtins).length,
    mode: ownCount > 0 ? 'own' : (Object.keys(legacy).length > 0 ? 'legacy' : 'builtin'),
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
    next[op.routeId] = { ...(existing ?? {}), ...op.value }
    return next
  }
  const merged: AnyRecord = { ...(existing ?? {}) }
  for (const field of op.fields) delete merged[field]
  if (Object.keys(merged).length === 0) delete next[op.routeId]
  else next[op.routeId] = merged
  return next
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
    return { op: 'merge', routeId, value: record['value'] }
  }
  return undefined
}

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
  const strategies: ('config-editor' | 'settings-mutate')[] = state.via === 'settings-mutate'
    ? ['settings-mutate', 'config-editor']
    : ['config-editor', 'settings-mutate']
  let lastError: unknown
  for (const strategy of strategies) {
    try {
      if (strategy === 'config-editor') await writeViaConfigEditor(deps, providers)
      else await writeViaSettings(deps, op)
      state.via = strategy
      state.lastError = undefined
      return { via: strategy, providers, warnings }
    } catch (error) {
      lastError = error
      warnings.push(`${strategy === 'config-editor' ? 'configEditor.edit' : 'settings.mutate'} 失败：${messageOf(error)}`)
    }
  }
  state.lastError = messageOf(lastError)
  throw new Error(`写 provider 配置失败（两条路都不通）：${warnings.join('；')}`)
}

/** 0.2.x：把我们条目的完整 config 写进 profile patch。 */
async function writeViaConfigEditor(deps: ProviderConfigDeps, providers: ProviderRecord): Promise<void> {
  const editor = deps.configEditor
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    throw new Error('宿主没有 configEditor 服务（0.1.x 的形状）')
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
    throw new Error('宿主没有可写的 settings 服务')
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
  const ops = Object.keys(op.value)
    .filter((key) => op.value[key] !== undefined)
    .map((key) => ({ op: 'set' as const, path: [...path, key], value: op.value[key] }))
  if (ops.length === 0) return
  await settings.mutate(LEGACY_NS, ops)
}

/**
 * 把合并后的 providers 塞进要交给官方 bundle 的 config。
 *
 * 两代 bundle 的读法不同：0.1.x 用 `Object.entries(config.providers ?? {})`（普通对象），
 * 0.2.x 用 `config.providers.get()`（schemastery 访问器）。所以这里放一个两者都认的对象：
 * 可枚举的路由键 + 一个不可枚举的 `get()`。外层用 Proxy 透传其它键（retryPolicy 这些
 * 官方代码同样会读），不破坏原 config 的代理行为。
 *
 * @param config - 本插件 apply 拿到的 config。
 * @param providers - {@link readProviderConfig} 的合并结果。
 */
export function configWithProviders(config: unknown, providers: ProviderRecord): AnyRecord {
  const shim: AnyRecord = { ...providers }
  Object.defineProperty(shim, 'get', { value: () => providers, enumerable: false })
  if (!isPlainRecord(config)) return { providers: shim }
  return new Proxy(config, {
    get(target, key, receiver) {
      if (key === 'providers') return shim
      return Reflect.get(target, key, receiver) as unknown
    },
  })
}

/** 从 loader 条目里取 options.id（形状不认识就给 undefined）。 */
function entryIdOf(row: unknown): string | undefined {
  const options = asRecord(asRecord(row)['options'])
  return readString(options['id'])
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
