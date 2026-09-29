// provider 配置层的兼容与自愈测试（0.1.x 与 0.2.x 两代宿主）。
//
// 两代宿主的差别（实测，见 src/provider-config.ts 的头注释）：
//   0.1.x：配置在 settings.yaml 的 `llm-pi-ai` 段，`settings.get/section` 读、`settings.mutate` 写
//   0.2.x：配置在 profile patch 里「插件条目自己的 config」；settings 没有 get/section，
//          写要走 `ctx.configEditor.edit(条目, change)`
// 这里用桩服务把两代形状都摆出来，盯四件事：读的合并优先级、两条写策略的选择、
// 失败自愈（换另一条路并记住）、以及 merge 的「不覆盖手写字段」保证。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BUILTIN_PROVIDERS,
  LEGACY_NS,
  OWN_ENTRY_ID,
  applyProviderOp,
  configWithProviders,
  mergeLayers,
  parseProviderOp,
  providersOf,
  providerStoreStatus,
  readProviderConfig,
  writeProviderRoutes,
} from '../lib/provider-config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

// ---- 读：合并优先级 内置默认 < 老 llm-pi-ai 段 < 自己条目 config ----
const legacyProviders = { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' }, deepseek: { apiKeyEnv: 'LEGACY_DEEPSEEK' } }

// 0.1.x 形状：settings.get/section 有值
const legacyView = readProviderConfig({
  settings: { get: (ns) => (ns === LEGACY_NS ? { providers: legacyProviders } : undefined) },
})
check('0.1.x：老段被读出来', legacyView.mode === 'legacy' && legacyView.legacyCount === 2)
check('内置默认在最底层（deepseek 被老段盖住）', legacyView.providers.deepseek.apiKeyEnv === 'LEGACY_DEEPSEEK')
check('老段里有、内置没有的路由也在', legacyView.providers['kimi-coding'].apiKeyEnv === 'KIMI_CODING_API_KEY')

// 0.1.x：get 拿不到时退回 section
const sectionView = readProviderConfig({
  settings: { get: () => undefined, section: (ns) => (ns === LEGACY_NS ? { providers: { 'moonshotai-cn': { apiKeyEnv: 'MOONSHOT' } } } : undefined) },
})
check('0.1.x：get 拿不到退回 section', sectionView.providers['moonshotai-cn'].apiKeyEnv === 'MOONSHOT')

// 0.2.x 形状：settings 没有 get/section，老段 = loader 条目列表里 id 为 llm-pi-ai 的那一行
// （每行一个 Entry，`options.id` / `options.config`）。注意 include 条目自己的 config 是
// `{path, patches}`，**不是**行列表——曾经照它读，结果永远读不到东西。
const includeEntry = {
  id: 'include',
  options: { id: 'include', name: '@deepseek-ai/cordis-plugin-include', config: { path: 'cordis.yml', patches: [] } },
}
const legacyRowEntry = {
  id: LEGACY_NS,
  options: { id: LEGACY_NS, name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: legacyProviders } },
}
const ownRowEntry = {
  id: OWN_ENTRY_ID,
  options: { id: OWN_ENTRY_ID, name: '@dsh-one/dsh-llm-provider', config: {} },
}
const loaderOnly = readProviderConfig({
  settings: { mutate: async () => {} },
  loader: { entries: () => [includeEntry, legacyRowEntry, ownRowEntry] },
})
check('0.2.x：老段从 loader 条目里的 llm-pi-ai 行读出来', loaderOnly.mode === 'legacy' && loaderOnly.legacyCount === 2)
check('0.2.x：不会把 include 自己的 config（{path,patches}）当成行列表', loaderOnly.providers.path === undefined)
check('0.2.x：行被 disable 也照样读（配置还在，只是没挂载）', (() => {
  const disabledRow = { options: { id: LEGACY_NS, disabled: true, config: { providers: { solo: {} } } } }
  return readProviderConfig({ loader: { entries: () => [disabledRow] } }).providers.solo !== undefined
})())
check('0.2.x：loader 没有这一行时算「读到了但没有」', (() => {
  const view = readProviderConfig({ loader: { entries: () => [includeEntry, ownRowEntry] } })
  return view.legacySource === 'loader' && view.legacyCount === 0 && view.legacyError === undefined
})())
check('0.2.x：entries() 返回 iterable 也认（不是数组）', (() => {
  const iterable = { entries: () => new Set([legacyRowEntry]).values() }
  return readProviderConfig({ loader: iterable }).legacyCount === 2
})())

// 自己条目 config 非空 → 整体接管（写下去的是整份，老段被搬过之后就它说话）。
// 这是 0.2.x 的语义：老段所在的条目被 patch 禁着、界面写不进去，所以条目一有内容就整体接管。
// 0.1.x（settings 宿主）不是这样：老段可写、两层叠着，见下面的 settings 宿主用例。
const ownView = readProviderConfig({
  loader: { entries: () => [legacyRowEntry] },
  ownConfig: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE' } } },
})
check('自己条目非空时整体接管', ownView.mode === 'own' && ownView.providers['opencode-go'].apiKeyEnv === 'OPENCODE')
check('接管后不再带上老段里的路由（那份已经写进条目里了）', ownView.providers['kimi-coding'] === undefined)
// 条目接管之后内置默认不再额外加回来：不然用户删掉内置的 deepseek 下次读又冒出来。
// 首次界面写入会把整份合并结果（含内置默认）写进条目，所以正常使用不会丢默认路由。
check('条目接管后不再额外加回内置默认（删掉 deepseek 才删得掉）', ownView.providers.deepseek === undefined)
check('接管前（条目为空）内置默认照样在', readProviderConfig({ loader: { entries: () => [includeEntry] } }).providers.deepseek.displayName === 'DeepSeek')
check('删掉内置 deepseek 后不会再出现（0.2.x 条目接管）', (() => {
  const view = readProviderConfig({
    loader: { entries: () => [includeEntry] },
    ownConfig: { providers: { 'kimi-coding': { apiKeyEnv: 'K' } } },
  })
  return view.providers.deepseek === undefined && view.providers['kimi-coding'] !== undefined && view.builtinCount === 0
})())

// 删到一条不剩：条目 config 变成 `providers: {}`，条数又回 0。这时**不能**当成「没写过」
// 把内置默认和老段残留加回来——用户眼里就是「删不掉」；更糟的是 /provider/remove 已经清掉
// 凭据，卡片会变成 MISSING_CREDENTIAL。判据是原始 patch 行里有没有 providers 这个键。
const ownRow = (config) => ({ options: { id: OWN_ENTRY_ID, config } })
const deletedAll = readProviderConfig({
  loader: { entries: () => [legacyRowEntry, ownRow({ providers: {} })] },
  ownConfig: { providers: {} },
})
check('0.2.x：删光（providers: {}）也算接管过，内置默认与老段都不再回来',
  Object.keys(deletedAll.providers).length === 0 && deletedAll.mode === 'own' && deletedAll.builtinCount === 0)
// 老段残留照报；这次会话里刚删掉的那两个不算（deletedIds 就是为这个存在的）
check('0.2.x：删光后老段残留照报（不静默）',
  deletedAll.warnings.some((w) => w.indexOf('已被插件条目覆盖') !== -1))
check('0.2.x：刚删掉的那些不算残留', (() => {
  const view = readProviderConfig({
    loader: { entries: () => [legacyRowEntry, ownRow({ providers: {} })] },
    ownConfig: { providers: {} },
    deletedIds: new Set(['kimi-coding', 'deepseek']),
  })
  return view.warnings.every((w) => w.indexOf('已被插件条目覆盖') === -1)
})())
check('0.2.x：没写过（行里没有 providers 键）时内置默认与老段照旧算进来', (() => {
  const view = readProviderConfig({ loader: { entries: () => [legacyRowEntry, ownRow({})] }, ownConfig: {} })
  return view.providers.deepseek !== undefined && view.providers['kimi-coding'] !== undefined && view.mode === 'legacy'
})())
check('0.2.x：enumerable 键在但解析值为空（读写不同步）也按接管处理', (() => {
  const view = readProviderConfig({ loader: { entries: () => [ownRow({ providers: {} })] }, ownConfig: {} })
  return Object.keys(view.providers).length === 0
})())

// 写不动的 route id（0.1.x 的 composition base）：界面不给删除入口，/provider/remove 也拦住
check('0.1.x：内置默认那条列进 immutableIds', (() => {
  const view = readProviderConfig({ settings: { section: () => ({ providers: { 'kimi-coding': { apiKeyEnv: 'K' } } }) } })
  return view.immutableIds.has('deepseek') && !view.immutableIds.has('kimi-coding')
})())
check('0.2.x：没有 immutableIds（界面写下去的就是整份，谁都删得掉）',
  readProviderConfig({ loader: { entries: () => [includeEntry] } }).immutableIds.size === 0)

// 0.2.x 的 schemastery 代理：providers 是带 .get() 的访问器
const proxied = readProviderConfig({
  ownConfig: { providers: { get: () => ({ 'zai-coding-cn': { apiKeyEnv: 'ZAI' } }) } },
})
check('schemastery 代理形状也认（.get()）', proxied.providers['zai-coding-cn'].apiKeyEnv === 'ZAI')
check('providersOf 对怪形状返回空对象', Object.keys(providersOf(null)).length === 0 && Object.keys(providersOf({ providers: 3 })).length === 0)

// 读失败不能崩：给 warning，继续用能拿到的
const brokenRead = readProviderConfig({
  settings: { get: () => { throw new Error('boom') }, section: () => { throw new Error('boom2') } },
  loader: { entries: () => { throw new Error('boom3') } },
})
check('读失败降级到内置默认并留 warning', brokenRead.mode === 'builtin' && brokenRead.warnings.length >= 1 && brokenRead.providers.deepseek !== undefined)
check('读失败要记下「有来源但没读成」', brokenRead.legacySource === 'none' && typeof brokenRead.legacyError === 'string')
// 「读成功但为空」不是失败：新装的机器本来就没有老段，不能因此不让写
const emptyButRead = readProviderConfig({ loader: { entries: () => [includeEntry] } })
check('老段为空但读得到时不算失败', emptyButRead.legacySource === 'loader' && emptyButRead.legacyError === undefined)
check('没有老段来源时也不报失败（0.1.x 的 settings 就是没这两个方法）',
  readProviderConfig({ settings: { mutate: async () => {} } }).legacyError === undefined)

// 条目接管之后，老段里后来手加的路由不会被读：要出 warning（别静默失效）
const orphaned = readProviderConfig({
  loader: { entries: () => [{ options: { id: LEGACY_NS, config: { providers: { a: {}, b: {}, c: {} } } } }] },
  ownConfig: { providers: { a: {} } },
})
check('老段里的孤儿路由出 warning', orphaned.warnings.some((w) => w.indexOf('有 2 行已被插件条目覆盖') !== -1))
check('孤儿路由不进生效集合（条目为准）', orphaned.providers.b === undefined && orphaned.providers.a !== undefined)

// 刚被界面删掉的那些不算孤儿：0.2.x 上老段那一行删不掉（条目被 patch 禁着、寻不到址），
// 用户前脚删完就看到「老段里还有 2 条」会以为没删掉
const justDeleted = readProviderConfig({
  loader: { entries: () => [{ options: { id: LEGACY_NS, config: { providers: { a: {}, b: {}, c: {} } } } }] },
  ownConfig: { providers: { a: {} } },
  deletedIds: new Set(['b', 'c']),
})
check('刚删掉的 route id 不再算孤儿（不弹假告警）：有对照才有意义',
  justDeleted.warnings.every((w) => w.indexOf('已被插件条目覆盖') === -1)
  && justDeleted.providers.b === undefined
  && readProviderConfig({
    loader: { entries: () => [{ options: { id: LEGACY_NS, config: { providers: { a: {}, b: {}, c: {} } } } }] },
    ownConfig: { providers: { a: {} } },
  }).warnings.some((w) => w.indexOf('有 2 行已被插件条目覆盖') !== -1))
check('没删过的照样报出来', (() => {
  const rows = () => [{ options: { id: LEGACY_NS, config: { providers: { a: {}, b: {} } } } }]
  const view = readProviderConfig({ loader: { entries: rows }, ownConfig: { providers: { a: {} } }, deletedIds: new Set(['b']) })
  const viewOther = readProviderConfig({ loader: { entries: rows }, ownConfig: { providers: { a: {} } } })
  return view.warnings.every((w) => w.indexOf('覆盖') === -1) && viewOther.warnings.some((w) => w.indexOf('覆盖') !== -1)
})())

// ---- 0.1.x（settings 宿主）：两层叠着，base 不能带着用户那批路由 ----
// 官方 bundle 会把我们交出去的 config 当 settings 的 composition base：dsh-settings 的解析是
// `schema(mergeLayers(base, section))`，而 mergeLayers 是递归合并——base 里有的键一定活下来。
// 0.1.6 实测：把用户那批路由塞进 base 之后，用户段里 unset 掉 apiKeyEnv 也不管用（base 那份还在，
// 官方适配器照旧抛 MISSING_CREDENTIAL）；删掉整条路由，刷新后又从 base 冒回来。
// 注意两端都包着 `providers`：settings 的 section 是**命名空间那一段**（Config 的形状是
// `{ providers: … }`），不是裸的 providers 记录——0.1.6 的 settings.yaml 里就是 `llm-pi-ai: { providers: … }`
const settingsHost = (section, resolved) => ({
  settings: {
    section: (ns) => (ns === LEGACY_NS ? { providers: section } : undefined),
    get: () => ({ providers: resolved }),
  },
})
const layered = readProviderConfig({
  ...settingsHost({ 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } }, { providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } } }),
  ownConfig: { providers: { copilot: { models: [{ id: 'gpt-5.4' }] } } },
})
check('0.1.x：交出去的 base 只放内置默认 + 条目 config（不含用户那批路由）',
  layered.bridgeProviders.deepseek !== undefined && layered.bridgeProviders.copilot !== undefined
  && layered.bridgeProviders['kimi-coding'] === undefined)
check('0.1.x：生效集合 = base 叠上用户层（两处都有）',
  layered.providers['kimi-coding'].apiKeyEnv === 'KIMI_CODING_API_KEY' && layered.providers.copilot.models.length === 1)
check('0.1.x：两层都有同一条路由时逐字段合并（不是整条替换）', (() => {
  const view = readProviderConfig({
    ...settingsHost({ copilot: { apiKeyEnv: 'COPILOT_KEY' } }, {}),
    ownConfig: { providers: { copilot: { models: [{ id: 'gpt-5.4' }] } } },
  })
  return view.providers.copilot.apiKeyEnv === 'COPILOT_KEY' && view.providers.copilot.models.length === 1
})())
check('0.1.x：用户层删掉的路由不会从 base 复活（section 空就是空，不退回 get）', (() => {
  // section 为空、get() 还带着（base 里那份）路由：这正是「删了没反应」的形态
  const view = readProviderConfig(settingsHost({}, { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } }))
  return view.providers['kimi-coding'] === undefined && view.legacyCount === 0 && view.legacySource === 'settings'
})())
check('0.1.x：读的是 section（用户层原文），不是 get() 的解析值',
  readProviderConfig(settingsHost({ a: { apiKeyEnv: 'A' } }, { providers: { b: { apiKeyEnv: 'B' } } })).providers.b === undefined)
check('0.1.x：只有 get 可读时说清「读到的是含 base 的合并值」', (() => {
  const view = readProviderConfig({ settings: { get: () => ({ providers: { a: {} } }) } })
  return view.warnings.some((w) => w.indexOf('composition base') !== -1)
})())
check('0.1.x：settings 宿主上不报「老段已被条目覆盖」（两层叠着，没有接管）', (() => {
  const view = readProviderConfig({
    ...settingsHost({ b: {} }, { providers: { b: {} } }),
    ownConfig: { providers: { a: {} } },
  })
  return view.warnings.every((w) => w.indexOf('已被插件条目覆盖') === -1)
})())
check('0.2.x（loader 宿主）：交出去的就是完整合并结果（官方只读 .get()，交少了那批路由全丢）', (() => {
  const view = readProviderConfig({ loader: { entries: () => [legacyRowEntry] }, ownConfig: {} })
  return JSON.stringify(view.bridgeProviders) === JSON.stringify(view.providers)
})())

// mergeLayers 本身：与 dsh-settings 同语义
check('mergeLayers 逐层递归、上层赢', (() => {
  const merged = mergeLayers({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 } })
  return merged.a.x === 1 && merged.a.y === 3 && merged.b === 1
})())
check('mergeLayers 遇到标量/数组整体取上层', mergeLayers({ k: 'old' }, { k: 'new' }).k === 'new'
  && JSON.stringify(mergeLayers({ k: [1, 2] }, { k: [3] }).k) === '[3]')
check('mergeLayers 跳过 undefined（稀疏 patch 不擦掉下层）', mergeLayers({ k: 'keep' }, { k: undefined }).k === 'keep')
check('mergeLayers 上层缺席就留下层', mergeLayers({ k: 1 }, undefined).k === 1)
check('mergeLayers 两层都缺席就返回 undefined（与宿主一致，调用方自己兜）',
  mergeLayers(undefined, undefined) === undefined && mergeLayers(undefined, { a: 1 }).a === 1)

// loader 在场却一条条目都列不出来：树没建好、或我们的读法又错了。宁可算「没读到」，
// 也不要当成「读到了、老段是空的」——那样护栏放行整份覆盖，会把用户已有路由删光
const emptyTree = readProviderConfig({ loader: { entries: () => [] } })
check('loader 列不出条目时算「没读成」并留痕',
  emptyTree.legacySource === 'none' && emptyTree.legacyError !== undefined
  && emptyTree.warnings.some((w) => w.indexOf('没列出任何条目') !== -1))

// 护栏：老段读失败 + 条目为空 → 拒绝整份写（否则会把用户已有路由删光）
const guardedState = {}
let guardError = ''
try {
  await writeProviderRoutes({
    settings: { get: () => { throw new Error('boom') } },
    loader: { entries: () => { throw new Error('boom') } },
    configEditor: { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async () => { throw new Error('不该走到这儿') } },
    ownConfig: {},
  }, { op: 'merge', routeId: 'new-route', value: { api: 'x' } }, guardedState)
} catch (error) {
  guardError = error.message
}
check('读不到老段且条目为空时拒绝整份覆盖', guardError.indexOf('拒绝整份覆盖') !== -1)
check('护栏触发的错误也带上了原因', guardError.indexOf('读失败') !== -1)
// 同一种情况下，条目里已经有内容（之前迁过）就可以写：权威来源已经是我们自己
const migratedState = {}
let migratedOk = false
try {
  await writeProviderRoutes({
    settings: { get: () => { throw new Error('boom') } },
    configEditor: { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async () => {} },
    ownConfig: { providers: { existing: {} } },
  }, { op: 'merge', routeId: 'new-route', value: { api: 'x' } }, migratedState)
  migratedOk = true
} catch { /* 不该抛 */ }
check('条目已有内容时照常写（权威来源是自己，不碰老段）', migratedOk === true && migratedState.via === 'config-editor')

// ---- 改：op 语义（不覆盖手写字段） ----
const existing = { 'opencode-go': { baseURL: 'https://x', models: [{ id: 'm' }], compat: { thinkingFormat: 'deepseek' }, retryPolicy: { maxRetries: 3 } } }
const mergedRoute = applyProviderOp(existing, { op: 'merge', routeId: 'opencode-go', value: { apiKeyEnv: 'K' } })
check('merge 只动给到的键', mergedRoute['opencode-go'].apiKeyEnv === 'K' && mergedRoute['opencode-go'].baseURL === 'https://x')
check('merge 保住手写的 models / compat / retryPolicy',
  mergedRoute['opencode-go'].models.length === 1
  && mergedRoute['opencode-go'].compat.thinkingFormat === 'deepseek'
  && mergedRoute['opencode-go'].retryPolicy.maxRetries === 3)
check('merge 不改原对象', existing['opencode-go'].apiKeyEnv === undefined)
check('merge 能新建路由', applyProviderOp({}, { op: 'merge', routeId: 'new-one', value: { api: 'openai-completions' } })['new-one'].api === 'openai-completions')
check('unset 摘掉整条', applyProviderOp(existing, { op: 'unset', routeId: 'opencode-go' })['opencode-go'] === undefined)
const afterUnset = applyProviderOp(existing, { op: 'unsetFields', routeId: 'opencode-go', fields: ['apiKeyEnv', 'baseURL'] })
check('unsetFields 只删指名字段', afterUnset['opencode-go'].apiKeyEnv === undefined && afterUnset['opencode-go'].models.length === 1)
// 删空要留着这条（`{}` 是合法 profile，也是 OAuth-only 路由的形态）：整条删除是 `unset` 的事。
// 这条以前摘掉整条，界面上「改用 OAuth 认证」（只删 apiKeyEnv）会让 provider 直接消失。
check('unsetFields 删空后仍留着这条路由（是 {}，不是 undefined）',
  applyProviderOp({ only: { api: 'x' } }, { op: 'unsetFields', routeId: 'only', fields: ['api'] }).only !== undefined)
check('删空后的值是空对象（凭据在 OAuth 记录里，配置里没有字段）',
  Object.keys(applyProviderOp({ only: { apiKeyEnv: 'X' } }, { op: 'unsetFields', routeId: 'only', fields: ['apiKeyEnv'] }).only).length === 0)
check('整条删除只认 unset op',
  applyProviderOp({ only: { apiKeyEnv: 'X' } }, { op: 'unset', routeId: 'only' }).only === undefined)

// ---- 解析客户端请求 ----
check('解析 merge', parseProviderOp({ routeId: 'a', op: 'merge', value: { api: 'x' } })?.op === 'merge')
check('解析 unset', parseProviderOp({ routeId: 'a', op: 'unset' })?.op === 'unset')
check('解析 unsetFields', parseProviderOp({ routeId: 'a', op: 'unsetFields', fields: ['api', 3, ''] })?.fields.join(',') === 'api')
check('没有 routeId 拒掉', parseProviderOp({ op: 'unset' }) === undefined)
check('不认识的 op 拒掉', parseProviderOp({ routeId: 'a', op: 'nuke' }) === undefined)
check('merge 没有 value 拒掉', parseProviderOp({ routeId: 'a', op: 'merge' }) === undefined)

// ---- 写：0.2.x 走 configEditor（写整份 config 进 profile patch） ----
const edits = []
const configEditor = {
  entries: () => [{ options: { id: 'some-other' } }, { options: { id: OWN_ENTRY_ID } }],
  edit: async (entry, change) => {
    const next = change({}, {})
    edits.push({ entry, next })
  },
}
const deps02 = {
  settings: { mutate: async () => { throw new Error('0.2.x 的 settings.mutate 应该没被用到') } },
  configEditor,
  loader: { entries: () => [includeEntry, legacyRowEntry, ownRowEntry] },
  ownConfig: {},
}
const state = {}
const write02 = await writeProviderRoutes(deps02, { op: 'merge', routeId: 'github-copilot', value: { apiKeyEnv: 'COPILOT' } }, state)
check('0.2.x：走 configEditor', write02.via === 'config-editor' && state.via === 'config-editor')
check('0.2.x：写的是整份 providers（老段里的路由被搬进来）',
  edits[0].next.providers['github-copilot'].apiKeyEnv === 'COPILOT'
  && edits[0].next.providers['kimi-coding'] !== undefined
  && edits[0].next.providers.deepseek !== undefined)
check('0.2.x：改的是我们自己的条目', edits[0].entry.options.id === OWN_ENTRY_ID)
check('0.2.x：不动其它键（config 里原有的字段保留）', (() => {
  let captured
  const editor = { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async (_e, change) => { captured = change({ keepMe: 1 }, {}) } }
  return writeProviderRoutes({ configEditor: editor, ownConfig: { providers: {} } }, { op: 'unset', routeId: 'x' }, {})
    .then(() => captured.keepMe === 1)
})())

// 0.2.x：configEditor 失败 → 自愈换 settings.mutate
const fallbackCalls = []
const healState = {}
const fallbackResult = await writeProviderRoutes({
  configEditor: { entries: () => [], edit: async () => { throw new Error('entry 不在') } },
  settings: { mutate: async (ns, ops) => { fallbackCalls.push({ ns, ops }) } },
  ownConfig: {},
}, { op: 'merge', routeId: 'moonshotai-cn', value: { apiKeyEnv: 'M' } }, healState)
check('configEditor 失败自动换 settings.mutate', fallbackResult.via === 'settings-mutate' && healState.via === 'settings-mutate')
check('自愈的警告留痕（说清为什么换路）', fallbackResult.warnings.some((w) => w.indexOf('configEditor.edit：') === 0))
check('换路后写的是老命名空间 + 逐字段 op（不覆盖同路由其它键）',
  fallbackCalls[0].ns === LEGACY_NS
  && fallbackCalls[0].ops.length === 1
  && fallbackCalls[0].ops[0].path.join('.') === 'providers.moonshotai-cn.apiKeyEnv')

// 记忆生效：上次成功的那条先试
const rememberCalls = []
await writeProviderRoutes({
  configEditor: { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async () => { rememberCalls.push('editor') } },
  settings: { mutate: async () => { rememberCalls.push('settings') } },
}, { op: 'unset', routeId: 'x' }, { via: 'settings-mutate' })
check('记住上次成功的策略并优先重试（这次只试它一条）',
  rememberCalls.length === 1 && rememberCalls[0] === 'settings')
// 记忆里的那条又失败 → 换另一条并更新记忆（宿主升降级、条目被禁用都能自愈）
const healAgain = []
await writeProviderRoutes({
  configEditor: { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async () => { healAgain.push('editor') } },
  settings: { mutate: async () => { healAgain.push('settings'); throw new Error('又不行了') } },
}, { op: 'unset', routeId: 'x' }, { via: 'settings-mutate' })
check('记忆的策略失败后换另一条并改记忆', healAgain.join(',') === 'settings,editor')

// 两条都不通：报错里要带两边的失败原因。**包括「这个宿主上没有这条服务」**——
// 这两条都不进 warnings（版本差异），但要是不进错误文案，错误就只剩「两条路都不通：」了
let unavailableBoth = ''
try {
  await writeProviderRoutes({ ownConfig: {} }, { op: 'unset', routeId: 'x' }, {})
} catch (error) {
  unavailableBoth = error.message
}
check('两条服务都不在时错误文案里也有原因',
  unavailableBoth.indexOf('两条路都不通') !== -1 && unavailableBoth.indexOf('configEditor.edit') !== -1
  && unavailableBoth.indexOf('settings.mutate') !== -1 && !unavailableBoth.endsWith('：'))

// 两条都不通：报错里要带两边的失败原因
let bothFailed = ''
try {
  await writeProviderRoutes({
    configEditor: { entries: () => [], edit: async () => {} },
    settings: { mutate: async () => { throw new Error('rejected') } },
  }, { op: 'unset', routeId: 'x' }, {})
} catch (error) {
  bothFailed = error.message
}
check('两条路都失败时报错并列出原因',
  bothFailed.indexOf('两条路都不通') !== -1 && bothFailed.indexOf('rejected') !== -1)

// 「这条写路径这个宿主上没有」不算失败告警：0.1.x 没有 configEditor，每次首次写都报一条
// 「configEditor.edit 失败」会让「配置写入」那行永远挂着假告警
const noEditorWarnings = (await writeProviderRoutes({
  settings: { mutate: async () => {} },
  ownConfig: {},
}, { op: 'unset', routeId: 'x' }, {})).warnings
check('服务缺席（0.1.x 没有 configEditor）不产生告警', noEditorWarnings.length === 0)

// 按能力挑顺序：有 configEditor.edit 就先试它（0.2.x 只有它行得通），
// 记忆优先仍然成立（上面几条已覆盖）
const capabilityOrder = []
await writeProviderRoutes({
  configEditor: { entries: () => [{ options: { id: OWN_ENTRY_ID } }], edit: async () => { capabilityOrder.push('editor') } },
  settings: { mutate: async () => { capabilityOrder.push('settings') } },
  ownConfig: {},
}, { op: 'unset', routeId: 'x' }, {})
check('两条都在时先走 configEditor（0.2.x 的形状）', capabilityOrder.join(',') === 'editor')

// 0.1.x：没有 configEditor 时直接用 settings.mutate
const onlySettings = []
const write01 = await writeProviderRoutes({
  settings: { mutate: async (ns, ops) => { onlySettings.push({ ns, ops }) } },
  ownConfig: {},
}, { op: 'unsetFields', routeId: 'kimi-coding', fields: ['apiKeyEnv'] }, {})
check('0.1.x：没有 configEditor 时走 settings.mutate', write01.via === 'settings-mutate')
check('unsetFields 在老命名空间里逐字段 unset', onlySettings[0].ops[0].op === 'unset' && onlySettings[0].ops[0].path.join('.') === 'providers.kimi-coding.apiKeyEnv')

// 0.1.x 那条路也要真删：merge + unsets 得翻成一条 unset 发过去，
// 否则 0.2.x 正常、0.1.x 上 apiKeyEnv 还在，同一个界面动作在两代宿主上行为不一致
const setOps = []
await writeProviderRoutes({
  settings: { mutate: async (ns, ops) => { setOps.push(...ops) } },
  ownConfig: {},
}, { op: 'merge', routeId: 'copilot', value: { api: 'openai-responses' }, unsets: ['apiKeyEnv'] }, {})
check('0.1.x：merge 的 unsets 也翻成 unset 发过去',
  setOps.some((item) => item.op === 'unset' && item.path.join('.') === 'providers.copilot.apiKeyEnv'))
check('0.1.x：要写的字段照样 set', setOps.some((item) => item.op === 'set' && item.path.join('.') === 'providers.copilot.api'))
// value 为空、只有 unsets 时：不能因为「没有 set 可发」就整条跳过
const onlyUnset = []
await writeProviderRoutes({
  settings: { mutate: async (ns, ops) => { onlyUnset.push(...ops) } },
  ownConfig: {},
}, { op: 'merge', routeId: 'copilot', value: {}, unsets: ['apiKeyEnv'] }, {})
check('0.1.x：只删不写时也发得出去',
  onlyUnset.length === 1 && onlyUnset[0].op === 'unset' && onlyUnset[0].path.join('.') === 'providers.copilot.apiKeyEnv')

// ---- 交给官方 bundle 的 config：两代读法都要认 ----
const shimConfig = configWithProviders({ retryPolicy: { maxRetries: 1 } }, () => ({ a: { api: 'x' } }))
check('0.1.x 读法（普通对象展开）能拿到路由', Object.keys(shimConfig.providers).join(',') === 'a')
check('0.2.x 读法（.get()）也能拿到同一份', shimConfig.providers.get().a.api === 'x')
check('其它键透传（retryPolicy 这些官方代码也读）', shimConfig.retryPolicy.maxRetries === 1)
check('providers 上的 get 不可枚举（不会被 Object.entries 当成路由）', Object.keys(shimConfig.providers).join(',') === 'a')
check('config 不是对象时也能兜住', configWithProviders(undefined, () => ({ b: {} })).providers.get().b !== undefined)

// 宿主会对这份 config 做 structuredClone（dsh-settings 的 describe）：Proxy 会抛 DataCloneError，
// 所以这里必须是普通对象 + 不可枚举的访问器
let cloneError = ''
try {
  const cloned = structuredClone(shimConfig)
  check('能过宿主的 structuredClone', cloned.providers.a.api === 'x')
  // 克隆的是值：不可枚举的访问器不会被克隆（宿主那边拿到的就是一份普通数据，正合预期）
  check('克隆后没有 get 访问器（克隆的是值，不是方法）', cloned.providers.get === undefined)
} catch (error) {
  cloneError = error.message
}
check('structuredClone 不抛 DataCloneError', cloneError === '')

// 0.2.x 的 volatile 快路径下插件不重挂：get() 必须每次读活值，否则界面写完配置要重启才生效
let liveProviders = { a: { api: 'x' } }
let supplierCalls = 0
const liveShim = configWithProviders({}, () => { supplierCalls += 1; return liveProviders })
const firstRead = liveShim.providers.get()
liveProviders = { a: { api: 'x' }, b: { api: 'y' } }
const secondRead = liveShim.providers.get()
check('get() 每次都问一遍活值（不是挂载那一刻的快照）', supplierCalls >= 2)
check('内容变了就给新对象，能看见新路由', secondRead.b !== undefined && secondRead !== firstRead)
check('内容没变时复用同一个对象（官方那套 identity 记忆化不被打破）',
  liveShim.providers.get() === secondRead && liveShim.providers.get() === liveShim.providers.get())
check('第一次读的就是当时的内容', firstRead.b === undefined)

// 非 JSON 值也要比得出来：以前用 JSON.stringify 当指纹，Map/Set/RegExp 一律写成 {}，
// 内容变了却判成没变，get() 就永远返回旧值
let mapLive = { p: { m: new Map([['a', 1]]) } }
const mapShim = configWithProviders({}, () => mapLive)
const firstMap = mapShim.providers.get()
mapLive = { p: { m: new Map([['b', 2]]) } }
check('Map 内容变了也算变了（不再被 JSON 指纹吞掉）', mapShim.providers.get() !== firstMap)
let regexpLive = { p: { r: /a/g } }
const regexpShim = configWithProviders({}, () => regexpLive)
const firstRegexp = regexpShim.providers.get()
regexpLive = { p: { r: /b/g } }
check('RegExp 换了也算变了', regexpShim.providers.get() !== firstRegexp)
check('同一个 Map 实例算没变（引用相同直接复用对象）', (() => {
  const same = { p: { m: new Map([['a', 1]]) } }
  const shim = configWithProviders({}, () => same)
  return shim.providers.get() === shim.providers.get()
})())
check('只在 undefined 字段上不同的两份配置不会被当成同一份', (() => {
  let live = { p: { a: undefined } }
  const shim = configWithProviders({}, () => live)
  const first = shim.providers.get()
  live = { p: { a: 'x' } }
  return shim.providers.get() !== first
})())
check('循环引用不会把比较追死', (() => {
  const cyclic = {}
  cyclic.self = cyclic
  const shim = configWithProviders({}, () => ({ p: cyclic }))
  const first = shim.providers.get()
  return shim.providers.get() === first
})())

// ---- merge 的 unsets：省略一个字段不等于删掉它 ----
const unsetsOp = parseProviderOp({ routeId: 'copilot', op: 'merge', value: { api: 'openai-responses' }, unsets: ['apiKeyEnv'] })
check('parse 认 unsets', unsetsOp !== undefined && unsetsOp.op === 'merge' && unsetsOp.unsets.join(',') === 'apiKeyEnv')
check('merge 把 unsets 列出的字段删掉（老配置里的 apiKeyEnv 不再挡 OAuth）',
  applyProviderOp({ copilot: { apiKeyEnv: 'GITHUB_COPILOT_API_KEY', retryPolicy: { maxRetries: 3 } } }, unsetsOp).copilot.apiKeyEnv === undefined
  && applyProviderOp({ copilot: { apiKeyEnv: 'GITHUB_COPILOT_API_KEY' } }, unsetsOp).copilot.api === 'openai-responses')
check('merge 不动没列出来的字段', applyProviderOp({ copilot: { apiKeyEnv: 'K' } }, unsetsOp).copilot.retryPolicy === undefined
  && applyProviderOp({ copilot: { apiKeyEnv: 'K', baseURL: 'https://x' } }, unsetsOp).copilot.baseURL === 'https://x')
check('没有 unsets 时行为与以前一致（不删任何字段）', (() => {
  const op = parseProviderOp({ routeId: 'p', op: 'merge', value: { api: 'x' } })
  return op.unsets === undefined && applyProviderOp({ p: { apiKeyEnv: 'K' } }, op).p.apiKeyEnv === 'K'
})())
check('unsets 是空数组时也不带这个键', parseProviderOp({ routeId: 'p', op: 'merge', value: {}, unsets: [] }).unsets === undefined)

// ---- /provider/status 的 providerStore 片段：界面的「配置写入」那一行读它 ----
const storePayload = providerStoreStatus(
  { providers: {}, ownCount: 2, legacyCount: 3, builtinCount: 1, mode: 'own', legacySource: 'loader', warnings: ['w'] },
  { via: 'config-editor', lastError: 'boom' },
  OWN_ENTRY_ID,
)
check('providerStore 带上了界面要读的每个字段',
  storePayload.mode === 'own' && storePayload.via === 'config-editor' && storePayload.legacyNs === LEGACY_NS
  && storePayload.ownCount === 2 && storePayload.legacyCount === 3 && storePayload.builtinCount === 1
  && storePayload.entryId === OWN_ENTRY_ID && storePayload.lastError === 'boom'
  && JSON.stringify(storePayload.warnings) === '["w"]')
check('还没写过时 via / lastError 是 null（不是 undefined，JSON 里要能看见「还没写过」）',
  providerStoreStatus({ providers: {}, ownCount: 0, legacyCount: 0, builtinCount: 0, mode: 'builtin', legacySource: 'none', warnings: [] }, {}, 'x').via === null)

// ---- 宿主必须真的把 providerStore 发出去（客户端加了读取、宿主漏了字段，两边各自测都测不出来）----
const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
check('宿主 /provider/status 里确实拼了 providerStore',
  /providerStore:\s*\(?/.test(indexSource)
  && indexSource.indexOf('providerStoreStatus(providerView(), writeState, ownEntryId)') !== -1)
// 交出去的那份必须是 bridgeProviders（0.1.x 当 composition base 用，交错整批路由会丢/复活）
check('宿主把 bridgeProviders 交给官方 bundle，而不是整份 providers',
  indexSource.indexOf('configWithProviders(config, () => providerView().bridgeProviders)') !== -1)

// 内置默认表结构完整（deepseek 是插件声称「同一套存储」的那条）
check('内置默认里有 deepseek 且带凭据名', BUILTIN_PROVIDERS.deepseek.apiKeyEnv === 'DEEPSEEK_API_KEY')

console.log(failures === 0 ? 'provider-config: 全部通过' : `provider-config: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
