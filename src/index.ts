/**
 * dsh-llm-provider 宿主端。
 *
 * 两件事：
 *   1. LLM 桥接（src/bridge.ts + src/updater.ts）：把官方 llm-pi-ai 适配器跑在
 *      我们自动跟进的新版 pi-ai 上，上游出新模型不用等 dsh 发版。内置的
 *      llm-pi-ai 行由 cordis.patch.yml 禁用，本插件完全接管（settings 的
 *      llm-pi-ai 段、Web Models 设置页、模型选择器行为都不变）。
 *   2. 计费接口（src/adapters/）：按 provider 查额度/余额，挂在
 *      GET /plan/status；适配器各自独立文件，node lib/adapters/run.js 可单独跑测。
 *
 * 之所以用自建 HTTP 路由而不是官方的 Typert Remote：那套生成器是给 dsh 单体仓库写的
 * （只认 <root>/packages/ 下的包、装饰器来源必须在已注册包里），单包插件走不通。
 * 自建路由和 GUI 同源，浏览器端直接 fetch。
 *
 * **边界：插件启动不碰宿主的东西。** 对 dsh 安装目录、settings.yaml、credentials 一律
 * 只读；写只发生在两处——插件自己的 vendor/ 目录（下载 pi-ai、拷桥接副本），以及用户
 * 在界面上显式操作时（添加/删除 provider）。
 */
import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activePiAiRoot, activePiAiVersion, loadBridge, vendorDir } from './bridge.js'
import {
  applyAdapterCapabilities,
  applyDeclaredCapabilities,
  indexDetails,
  loadModelDetails,
  type DeclaredModelEntry,
  type ModelDetail,
} from './model-details.js'
import { checkAndUpdate, pruneVersions, startBackgroundCheck, vendorUsageAsync } from './updater.js'
import {
  LEGACY_NS,
  OWN_ENTRY_ID,
  configWithProviders,
  parseProviderOp,
  providerStoreStatus,
  readProviderConfig,
  writeProviderRoutes,
  type ProviderConfigDeps,
  type ProviderOp,
  type ProviderRecord,
  type ProviderWriteState,
} from './provider-config.js'
import { discoverModelsVia, type DiscoveryState } from './model-discovery.js'
import { disableOfficialRows, loaderEntries } from './official-rows.js'
import { labelOf, providerRoutes, websiteOf, type ProviderRoute } from './routes.js'
import { catalogBaseUrlOf, presetsWithMeta } from './provider-presets.js'
import { findAdapter } from './adapters/registry.js'
import { findSharedCredentials } from './credential-check.js'
import { ensureAuthorizationService, flowKeyForProvider, registerOAuthRoutes } from './oauth.js'
import type { AccountStatus } from './adapters/shared.js'
import {
  asRecord,
  readString,
  type AnyRecord,
  type AuthorizationEntry,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
  type AuthorizationResponse,
  type AuthorizationService,
  type CredentialsService,
  type ConfigEditorService,
  type LlmService,
  type LoaderService,
  type Logger,
  type PluginContext,
  type ServerRequest,
  type ServerResponse,
  type SettingsService,
  type WebServerService,
} from './types.js'

/** 桥接装载在模块加载期完成（loader 要同步读 Config）。失败则退化为纯计费模式。 */
const bridge = loadBridge()

export const name = 'provider'

export const inject = ['llm', 'webServer']

/** 给浏览器渲染的一条账户（额度快照 + 路由元信息）。 */
export interface AccountRow extends AccountStatus {
  api?: string | undefined
  apiKeyEnv?: string | undefined
  credentialWarning?: string
  /** 已经通过 OAuth 登录过（凭据记录里是 grant）：卡片据此显示登录状态、不再要密钥。 */
  oauthAuthorized?: boolean
  /** 这个账号实际可用的模型 id（OAuth 登录时 pi-ai 记下的）。界面按它过滤模型列表。 */
  availableModels?: string[]
}

/** 额度快照（/plan/status 的响应体）。 */
export interface PlanSnapshot {
  accounts: AccountRow[]
  fetchedAt: string
  error?: string
}

export const Config = bridge.ok ? bridge.plugin.Config : Schema.object({})

export function apply(ctx: PluginContext, config: unknown): void {
  /** 拿宿主服务：只走 ctx.get，不做属性访问兜底。
   *
   * cordis 严格模式下 `ctx[name]` 这种属性访问要求 inject 列表里声明 `name`，否则抛
   * "cannot get property \"X\" without inject"，把整个 handler / apply 挂掉。
   * 原来 `ctx.get?.(name) ?? ctx[name]` 的写法正是这个 bug 的源头——服务未注册时 ctx.get
   * 拿不到、走属性访问就抛。改成纯 ctx.get + try/catch：未挂载返回 undefined，调用方按业务
   * 路径处理降级（路由 handler 通常会回 500，但不再把整插件拖垮）。
   */
  const service = <T>(serviceName: string): T | undefined => {
    if (ctx.get === undefined) return undefined
    try {
      const value = ctx.get(serviceName)
      return value === null || value === undefined ? undefined : (value as T)
    } catch (cause) {
      return undefined
    }
  }

  const logger: Logger | undefined = typeof ctx.logger === 'function' ? ctx.logger('provider') : undefined
  const webServer = ctx['webServer'] as WebServerService

  // 本插件自己的条目 id：0.2.x 上它同时是配置的命名空间（settings/configEditor 都按条目 id 寻址）
  const ownEntryId = ((): string => {
    try {
      const fiber = (ctx as unknown as AnyRecord)['fiber'] as AnyRecord | undefined
      const entry = fiber === undefined ? undefined : (fiber['entry'] as AnyRecord | undefined)
      const options = entry === undefined ? undefined : (entry['options'] as AnyRecord | undefined)
      const id = options === undefined ? undefined : readString(options['id'])
      return id ?? OWN_ENTRY_ID
    } catch {
      return OWN_ENTRY_ID
    }
  })()

  /** 写策略记忆：这次进程里哪条路走得通（自愈用）。 */
  const writeState: ProviderWriteState = {}
  /** 模型发现的命名空间记忆（0.1.x 是 llm-pi-ai，0.2.x 是本插件条目 id）。 */
  const discoveryState: DiscoveryState = {}
  /**
   * 本进程里界面删掉过的 route id。
   *
   * 0.2.x 上老 `llm-pi-ai` 段那一行删不掉（那个条目被 patch 禁着，settings.mutate 寻不到址），
   * 于是每次读都会把刚删的那条当成「老段里的孤儿」。用户前脚删完、后脚就看到这条告警，
   * 会以为没删掉。记下来交给读者排除，进程重启后自然清空。
   */
  const deletedIds = new Set<string>()
  /**
   * provider 配置的读写依赖。每次调用现取服务：0.2.x 上插件会随配置写入被重载，
   * 服务实例可能已经换了一轮，缓存住会指向旧 fiber。
   */
  function providerDeps(): ProviderConfigDeps {
    return {
      settings: service<SettingsService>('settings'),
      configEditor: service<ConfigEditorService>('configEditor'),
      loader: service<LoaderService>('loader'),
      ownConfig: config,
      entryId: ownEntryId,
      deletedIds,
    }
  }
  /** 当前合并后的 providers（两代宿主各自的落点 + 内置默认）。 */
  function providerView() {
    return readProviderConfig(providerDeps())
  }

  /**
   * 桥接没挂上时的原因（{@link bridgeMountError}）：/provider/status 要把它报出来。
   * 挂桥接失败**不能**让整个插件失活——那样用户连设置页都进不去，什么也查不了。
   */
  let bridgeMountError: string | undefined

  if (bridge.ok) {
    // 完全接管官方 llm-pi-ai 的行为：路由注册、模型发现全在这一个调用里。
    // providers 必须由我们合并后传进去：0.2.x 的官方 bundle 只认传入的 config
    // （`config.providers.get()`），不再去读 `llm-pi-ai` 段——不传就等于用户那批路由全丢。
    const view = providerView()
    // 传「取活值」的函数而不是快照：0.2.x 的 config 变更是 volatile 快路径，不重挂插件，
    // 快照会让官方 bundle 永远停在挂载那一刻（见 configWithProviders 的注释）。
    // 交出去的是 bridgeProviders：0.1.x 上官方把这份 config 当 settings 的 composition base
    // 注册，而 base 里的键在 mergeLayers 下一定活下来——放用户那批路由进去，用户在设置里删掉的
    // 路由就会被复活，所以 0.1.x 只交内置默认与条目 config；0.2.x 官方只读 .get()，必须交完整
    // 合并结果（写少了等于用户那批路由全丢）。见 bridgeProviders 的注释。
    const mountBridge = (): void => {
      try {
        bridge.plugin.apply(ctx, configWithProviders(config, () => providerView().bridgeProviders))
        bridgeMountError = undefined
        logger?.info?.(`llm bridge active on pi-ai ${bridge.piAiVersion}；providers 来源 ${view.mode}（自带条目 ${String(view.ownCount)} / ${LEGACY_NS} 段 ${String(view.legacyCount)} / 内置 ${String(view.builtinCount)}）`)
        for (const warning of view.warnings) logger?.warn?.(warning)
      } catch (error) {
        // 官方行没关干净（见 official-rows.ts）、或上游改了什么，都会在这里抛。只降级：
        // 插件其余部分照常工作，原因由 /provider/status 报到界面上
        bridgeMountError = messageOf(error)
        logger?.error?.(`llm bridge 挂载失败：${bridgeMountError}`)
      }
    }

    // 首次挂载时 cordis.patch.yml 里那四处 `disabled: !!js` 守卫**看不到本插件的条目**
    // （Loader 按列表顺序同步求值，而本插件的行是 insert 追加的、排在最后），官方行这时还开着。
    // 这里补一刀：在本进程里把它们关掉（不写回文件），等注销落定再挂桥接，否则会撞
    // `LlmError: configurable provider "..." is already declared`，整个插件条目激活失败。
    const loader = service<LoaderService>('loader')
    const takeover = disableOfficialRows(loaderEntries(loader))
    if (takeover.closed.length === 0) mountBridge()
    else {
      if (takeover.running.length > 0) {
        logger?.warn?.(`官方行 ${takeover.running.join('、')} 还挂着（bundle patch 的守卫在首次挂载时看不到本插件的条目），先在本进程里关掉再挂桥接`)
      }
      // 关掉是同步开始的，但 fiber 注销在后续任务里完成：等 loader 的任务排空（最多 3 秒）再挂
      void waitForDrain(loader, takeover.closed).then(mountBridge)
    }
  } else {
    logger?.warn?.(`llm bridge 不可用，退化为纯计费模式：${bridge.error}`)
  }

  /**
   * 等树的挂载/注销任务落定（`loader.await()`），最多等 `timeoutMs`。
   *
   * 关掉官方行之后必须等它注销完，否则同一个 provider 会在目录里撞车。`await()` 等的是整棵树，
   * 正常很快就返回；给个上限是因为「等不到」也不该把桥接永远卡住——真撞上了挂载会抛，那个错误
   * 会被抓到并报到界面上（比整个插件失活好得多）。
   */
  async function waitForDrain(loader: LoaderService | undefined, closed: readonly string[], timeoutMs = 3_000): Promise<void> {
    const awaited = loader !== undefined && typeof loader.await === 'function' ? loader.await() : undefined
    if (awaited === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([Promise.resolve(awaited).catch(() => undefined), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    logger?.info?.(`已关掉官方行 ${closed.join('、')}，继续挂桥接`)
  }

  interface ResolveKeyResult {
    key: string | undefined
    configured: boolean
    reason: string | undefined
  }

  async function resolveKey(apiKeyEnv: string | undefined): Promise<ResolveKeyResult> {
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') return { key: undefined, configured: false, reason: '未配置 apiKeyEnv' }
    const credentials = service<CredentialsService>('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      return { key: undefined, configured: false, reason: 'credentials 服务不可用' }
    }
    try {
      const resolved = await credentials.resolve(apiKeyEnv)
      const key = typeof resolved === 'string' ? resolved : readString(asRecord(resolved)['value'])
      if (key === undefined) return { key: undefined, configured: false, reason: `${apiKeyEnv} 没有值` }
      return { key, configured: true, reason: undefined }
    } catch (error) {
      return { key: undefined, configured: false, reason: `${apiKeyEnv} 解析失败：${messageOf(error)}` }
    }
  }

  /**
   * provider id → 它的 OAuth flow 写在哪个凭据记录上（`<scope>/<provider-id>`）。
   *
   * 从 `ctx.authorization.list()` 反查而不是自己拼 scope：scope 是「拥有这条 flow 的插件名」
   * （现在是 `llm-pi-ai`，将来官方改名也照样对得上）。拿不到就返回 undefined。
   */
  function oauthKeyFor(providerId: string): string | undefined {
    const authorization = service<AuthorizationService>('authorization')
    if (typeof authorization?.list !== 'function') return undefined
    try {
      return flowKeyForProvider(authorization.list().map((entry) => entry.key), providerId)
    } catch { /* 读不到就当没有 */ }
  }

  /**
   * 这个 provider 是不是已经通过 OAuth 登录过（凭据记录里是 grant）。
   *
   * 卡片状态不能只看 apiKeyEnv：Copilot / Codex 这类走 OAuth 的 provider 本来就没有
   * `*_API_KEY`，照旧判会一直显示「未配置 key」——实际早就授权好了。
   */
  async function oauthAuthorizedFor(providerId: string): Promise<boolean> {
    const key = oauthKeyFor(providerId)
    if (key === undefined) return false
    const credentials = service<CredentialsService>('credentials')
    if (typeof credentials?.readRecord !== 'function') return false
    try {
      return asRecord(await credentials.readRecord(key))['kind'] === 'grant'
    } catch { return false }
  }

  /**
   * 读 OAuth 凭据记录，取出两样东西：
   *   - `token`：喂给额度适配器用。走 OAuth 的 provider 没有 apiKeyEnv，凭据在 grant 里；
   *     记录是 pi-ai 的 `OAuthCredential` 原样存的，`refresh` 是 GitHub 那个长期 token、
   *     `access` 是换来的短命 token。github-copilot 的配额接口要的是前者。
   *   - `availableModelIds`：登录时 pi-ai 记下的「这个账号能用哪些模型」。**界面必须按它过滤**
   *     ——pi-ai 的静态目录有 28 个 Copilot 模型，而账号实际只有 6 个能用，选到别的会拿
   *     400 model_not_supported（实测）。
   * @param providerId - 路由 id。
   */
  async function oauthCredentialFor(providerId: string): Promise<{ token?: string, availableModelIds?: string[] }> {
    const key = oauthKeyFor(providerId)
    if (key === undefined) return {}
    const credentials = service<CredentialsService>('credentials')
    if (typeof credentials?.readRecord !== 'function') return {}
    try {
      const payload = asRecord(asRecord(await credentials.readRecord(key))['payload'])
      const rawIds = payload['availableModelIds']
      const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string' && id !== '') : undefined
      return {
        token: readString(payload['refresh']) ?? readString(payload['access']),
        ...(ids !== undefined && ids.length > 0 ? { availableModelIds: ids } : {}),
      }
    } catch { return {} }
  }

  /**
   * 查一个 provider 路由的额度。
   * @param route - 来自 {@link providerRoutes}。
   * @param credentials - 收集 `{provider, ref, value}` 供凭据体检比对；值不外传。
   */
  async function accountOf(route: ProviderRoute, credentials: { provider: string; ref: string | undefined; value: string }[]): Promise<AccountRow> {
    const providerId = route.id
    const displayName = route.label ?? labelOf(providerId)
    // 官网/控制台链接：卡片名称下的跳转链接（适配器带了自己的就优先用适配器的）
    const websiteUrl = websiteOf(providerId)
    // 端点：只有用户显式写了才算「这条路配的端点」（企业版端点、自建网关这类覆盖）。
    const configuredBaseUrl = typeof route.baseURL === 'string' && route.baseURL !== '' ? route.baseURL : undefined
    // 目录里这家的默认端点：发请求时宿主按 `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`
    // 回落，余额适配器也要知道「发到哪」（zai / minimax 按 host 选站点，拿不到会掉到错的站点）。
    const catalogBaseUrl = catalogBaseUrlOf(providerId)
    const credential = await resolveKey(route.apiKeyEnv)
    // 有没有 OAuth 授权：手填了 key 就不用查；没 key 时才看凭据记录里有没有 grant。
    // routeMeta 会 spread 进每个返回分支，所以放这里就不必逐分支加。
    const oauthAuthorized = credential.configured ? false : await oauthAuthorizedFor(providerId)
    const authConfigured = credential.configured || oauthAuthorized
    // 余额适配器的端点参数：路由没写就用目录默认（查额度得打到这家真正的主机）
    const adapterBaseUrl = configuredBaseUrl ?? catalogBaseUrl
    const adapter = findAdapter(providerId, adapterBaseUrl)
    // 0.1.x 上在 composition base 里的路由删不掉（配置层表达不了删除），界面就别给删除入口
    const deletable = route.source === 'llm-pi-ai' && !providerView().immutableIds.has(providerId)
    // OAuth 授权过的：适配器要的 key 从凭据记录里取（Copilot 的配额接口要 GitHub token）。
    const oauthCredential = oauthAuthorized ? await oauthCredentialFor(providerId) : {}
    const queryKey = credential.configured ? credential.key : oauthCredential.token
    const routeMeta = {
      // 卡片「API 地址」行：路由自己写了就用它，没写就摆目录默认（那是实际会发到的地址）；
      // 只有 OAuth 路由例外——端点由凭据决定（pi-ai 的 toAuth 带 baseUrl，models.js 里
      // `auth.baseUrl` 覆盖模型自己的，企业版 Copilot 的 api.enterprise.* 就这么来的），
      // 摆目录里那个 individual 地址反而是错的。
      baseUrl: configuredBaseUrl ?? (oauthAuthorized ? undefined : catalogBaseUrl),
      // 地址是不是用户/旧版本写到配置里的。界面靠它决定「一键修正」要不要连地址一起删
      // （旧版表单会把目录地址写进路由，那同样会盖掉每个模型自己的端点）。
      baseUrlPinned: configuredBaseUrl !== undefined,
      api: route.api,
      apiKeyEnv: route.apiKeyEnv,
      oauthAuthorized,
      // 账号声明的可用模型：界面据此过滤模型列表（没有就不挂字段，界面不过滤）。
      ...(oauthCredential.availableModelIds === undefined ? {} : { availableModels: oauthCredential.availableModelIds }),
    }
    // 掩码提示（前3+后4）：让界面能认出是哪一把 key（错配一眼可见），值本身不出宿主
    const keyHint = credential.configured ? maskKey(credential.key) : undefined
    const fetchedAt = new Date().toISOString()
    if (credential.configured && credential.key !== undefined) {
      credentials.push({ provider: providerId, ref: route.apiKeyEnv, value: credential.key })
    }

    if (adapter === undefined) {
      return {
        ...routeMeta,
        id: providerId, displayName, kind: 'unknown-provider', authConfigured,
        balances: [], windows: [], fetchedAt, websiteUrl, keyHint, deletable,
        // OAuth 登录过、但没有额度适配器的（Codex / Claude / xAI 这类）：给用户看得懂的一句，
        // 别把「去 src/adapters/ 加适配器」这种给贡献者的话摆到界面上。
        note: oauthAuthorized
          ? '这条路由靠 OAuth 登录使用，暂时没有余额查询接口'
          : '认不出这个 provider 的额度接口；在 src/adapters/ 加一个适配器并在 registry.ts 注册即可',
      }
    }
    if (adapter.id === 'qwen-unsupported') {
      const result = await adapter.query({ id: providerId, displayName, key: undefined, baseUrl: adapterBaseUrl, extras: {} })
      if (result.websiteUrl === undefined) result.websiteUrl = websiteUrl
      if (result.keyHint === undefined) result.keyHint = keyHint
      if (result.deletable === undefined) result.deletable = deletable
      result.membership = undefined // 等级不展示，适配器原始数据保留在适配器内
      return { ...routeMeta, ...result }
    }
    if (!credential.configured && !oauthAuthorized) {
      return {
        ...routeMeta,
        id: providerId, displayName, kind: 'quota', authConfigured,
        balances: [], windows: [], error: credential.reason, fetchedAt, websiteUrl, keyHint,
        deletable,
      }
    }
    try {
      const result = await adapter.query({ id: providerId, displayName, key: queryKey, baseUrl: adapterBaseUrl, extras: {} })
      if (result.websiteUrl === undefined) result.websiteUrl = websiteUrl
      if (result.keyHint === undefined) result.keyHint = keyHint
      if (result.deletable === undefined) result.deletable = deletable
      result.membership = undefined // 等级不展示，适配器原始数据保留在适配器内
      return { ...routeMeta, ...result }
    } catch (error) {
      return {
        ...routeMeta,
        id: providerId, displayName, kind: 'quota', authConfigured: true,
        balances: [], windows: [], error: messageOf(error), fetchedAt, websiteUrl, keyHint,
        deletable,
      }
    }
  }

  /** 额度接口不该被菜单开关打成串流请求，60 秒内复用同一份结果。 */
  const CACHE_MS = 60_000
  let cached: { at: number; value: PlanSnapshot } | undefined
  /** 写完 provider 配置后让额度快照失效：下一轮 /plan/status 按新配置重查。 */
  function invalidatePlanSnapshot(): void {
    cached = undefined
  }

  async function snapshot(force: boolean): Promise<PlanSnapshot> {
    if (!force && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.value
    const settings = service<SettingsService>('settings')
    const llm = service<LlmService>('llm')
    const routes = providerRoutes(providerView().providers, llm)
    const providers = [...routes.values()]
    if (providers.length === 0) {
      return {
        accounts: [],
        error: `没有发现可查额度的 provider：请在「添加供应商」里加一条（0.1.x 写 settings.yaml 的 ${LEGACY_NS}.providers，0.2.x 写 profile patch 里本插件的 config）`,
        fetchedAt: new Date().toISOString(),
      }
    }
    const credentials: { provider: string; ref: string | undefined; value: string }[] = []
    const settled = await Promise.all(providers.map((route) => accountOf(route, credentials)))
    // 凭据体检：共用同一把 key 时在界面上报警（值本身绝不出这个函数）
    const warnings = findSharedCredentials(credentials)
    const accounts = settled.map((account) => {
      const warning = warnings.find((entry) => entry.provider === account.id)
      return warning === undefined ? account : { ...account, credentialWarning: warning.message }
    })
    const value: PlanSnapshot = { accounts, fetchedAt: new Date().toISOString() }
    cached = { at: Date.now(), value }
    return value
  }

  const json = (res: ServerResponse, code: number, payload: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  type WriteHandler = (route: ProviderRoute, parsed: AnyRecord, res: ServerResponse) => Promise<void>

  /**
   * 自建写路由的公共骨架：只收 POST、读 JSON body、按 providerId 找路由（找不到回 404），
   * handler 里抛出的错误统一回 500。refresh / remove / test 三个路由共用这一份。
   */
  function writeRoute(handle: WriteHandler): (req: ServerRequest, res: ServerResponse) => void {
    return (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = asRecord(JSON.parse(body === '' ? '{}' : body))
            const providerId = parsed['providerId']
            const routes = providerRoutes(providerView().providers, service<LlmService>('llm'))
            const route = typeof providerId === 'string' ? routes.get(providerId) : undefined
            if (route === undefined) {
              json(res, 404, { ok: false, error: `没有发现这个 provider：${String(providerId)}` })
              return
            }
            await handle(route, parsed, res)
          } catch (error) {
            json(res, 500, { ok: false, error: messageOf(error) })
          }
        })()
      })
    }
  }

  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/plan/status',
      handler: (req, res) => {
        void (async () => {
          try {
            const force = typeof req.url === 'string' && req.url.includes('refresh=1')
            json(res, 200, await snapshot(force))
          } catch (error) {
            logger?.warn?.(`plan status failed: ${messageOf(error)}`)
            json(res, 500, { accounts: [], error: messageOf(error) })
          }
        })()
      },
    }),
    'dsh-llm-provider: /plan/status route',
  )

  // vendor/ 磁盘占用缓存：统计要走完整个 vendor/（主工作区实测 336 MB、两万多个文件；同步递归
  // 一次 ~113 ms），所以不能同步跑——走 fs/promises 的异步遍历，等待期间事件循环照常。
  // 60 秒内的缓存直接命中；过期或没有就现算（这个响应会多等一会儿，但不阻塞宿主）。
  let vendorUsageCache: { at: number, value: Awaited<ReturnType<typeof vendorUsageAsync>> } | undefined
  let vendorUsagePending: Promise<Awaited<ReturnType<typeof vendorUsageAsync>> | undefined> | undefined
  /** 拿一份占用：新鲜就直出，过期/没有就现算（await 不阻塞事件循环，只是这一个响应等一会儿）。 */
  function vendorUsageFresh(): Promise<Awaited<ReturnType<typeof vendorUsageAsync>> | undefined> {
    if (vendorUsageCache !== undefined && Date.now() - vendorUsageCache.at <= 60_000) {
      return Promise.resolve(vendorUsageCache.value)
    }
    if (vendorUsagePending === undefined) {
      vendorUsagePending = vendorUsageAsync()
        .then((value) => {
          vendorUsageCache = { at: Date.now(), value }
          return value
        })
        .catch((error: unknown) => {
          logger?.warn?.(`统计 vendor 占用失败：${messageOf(error)}`)
          return undefined
        })
        .finally(() => { vendorUsagePending = undefined })
    }
    return vendorUsagePending
  }

  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/status',
      handler: (_req, res) => {
        const { status: bridgeState, updater } = readVendorState()
        // 诊断：这一插件实际发现了哪些路由（含凭据名，不含值），排查配置问题时最有用
        const llm = service<LlmService>('llm')
        let declaredCount = -1
        try {
          declaredCount = typeof llm?.listConfigurableProviders === 'function'
            ? llm.listConfigurableProviders().length
            : -1
        } catch { /* 拿不到就报 -1 */ }
        let routes: { id: string, apiKeyEnv: string | null, source: string, models?: unknown }[] = []
        try {
          routes = [...providerRoutes(providerView().providers, llm).values()]
            .map((route) => ({
              id: route.id,
              apiKeyEnv: route.apiKeyEnv ?? null,
              source: route.source,
              // 自己声明的模型清单（没声明就没有这个键）：模型清单编辑器据此回显并写回
              ...(route.models === undefined ? {} : { models: route.models }),
            }))
        } catch { /* 路由发现失败时留空 */ }
        // 磁盘占用是唯一要异步的部分：其余诊断先算好，占用到了再一起发（不阻塞事件循环）
        const payload = {
          bridge: bridge.ok
            ? {
                // 挂载失败时按「不可用」报：界面上那行会显示原因，而不是整块空白
                active: bridgeMountError === undefined,
                ...(bridgeMountError === undefined ? {} : { error: bridgeMountError }),
                piAiVersion: bridge.piAiVersion,
                // 用的是哪一档：热更新下来的版本号 / 'dependency'（内置依赖）/ 'dsh'（dsh 自带）
                source: bridge.piAiSource,
                // 体检没过、被跳过的候选——有回退就列在这里
                rejected: bridge.rejected,
                // 需求没解析出来、体检没跑：选中项没被验证过，界面上要标出来
                probeUnverified: bridge.probeUnverified,
              }
            : { active: false, error: bridge.error },
          llmDirectorySize: declaredCount,
          routes,
          // providers 的落点与写路径（界面「pi-ai 桥接 → 配置写入」那行读它）。
          // 必须真的发出来：客户端早就加了读取，但这里的 payload 一直没有这个字段，
          // 那行就永远不渲染——渲染函数自己的测试造假对象，测不出来这种断线。
          providerStore: ((): AnyRecord | undefined => {
            try {
              return providerStoreStatus(providerView(), writeState, ownEntryId)
            } catch {
              return undefined
            }
          })(),
          // OAuth 体检：authorization 服务在不在、注册了几条 flow。原版 dsh 不挂这个服务
          // （见 oauth.ts 的 ensureAuthorizationService），所以「界面没有 OAuth 入口」这件事
          // 得能一眼看出是哪一步没成：服务没挂上（available:false）还是挂了但没人注册 flow
          // （available:true, flows:0）。刻意不列 flow 的 key——那是凭据记录名，没必要给浏览器。
          oauth: ((): { available: boolean, flows: number } => {
            const authorization = service<AuthorizationService>('authorization')
            if (authorization === undefined) return { available: false, flows: 0 }
            try {
              return { available: true, flows: typeof authorization.list === 'function' ? authorization.list().length : 0 }
            } catch {
              return { available: true, flows: 0 }
            }
          })(),
          // 只读体检：DeepSeek 走 pi-ai 必须在 settings 的 llm-pi-ai.providers 里有一条
          // deepseek 路由（原生 llm-deepseek 被 cordis.patch.yml 禁用了，全靠这条）。
          // 插件不写宿主配置：缺了就报出来，由用户用「添加 Provider」补。不能静默——
          // 缺了 DeepSeek 会从模型列表里消失，看不出原因。
          deepseekRouteMissing: bridge.ok && !routes.some((route) => route.id === 'deepseek'),
          // 更新状态（界面「pi-ai 桥接」标签页用）：
          //   latest   —— 上次检查时上游的最新版
          //   pending  —— 已下载、等重启生效的版本
          //   rejected —— 下载了但兼容性体检没通过的那版（含原因），永远不会切过去
          update: {
            lastCheck: readString(updater['lastCheck']),
            latest: readString(bridgeState['latestVersion']),
            pending: bridgeState['needsRestart'] === true ? readString(bridgeState['piAiVersion']) : undefined,
            rejected: readRejected(bridgeState['latestRejected']),
          },
            // 磁盘占用在下面按需补上（异步统计）：这里只留测试实例标记
            // 测试环境标识（scripts/test-profile.sh 启动时带 DSH_PROVIDER_TEST=1）：
            // 浏览器端看到后给标题/favicon 加「测」标，一眼区分测试实例
            testMode: process.env.DSH_PROVIDER_TEST === '1',
        }
        void vendorUsageFresh().then((usage) => {
          json(res, 200, { ...payload, storage: usage })
        })
      },
    }),
    'dsh-llm-provider: /provider/status route',
  )

  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/update',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        void (async () => {
          // 正在用的那份也传进去：手动「检查更新」以前不传，点一次就白下一份同版本副本（issue #4）
          const result = await checkAndUpdate(
            (line) => logger?.info?.(`[pi-ai updater] ${line}`),
            bridge.ok ? bridge.piAiVersion : activePiAiVersion(),
          )
          json(res, 200, result)
        })()
      },
    }),
    'dsh-llm-provider: /provider/update route',
  )

  // 清理 vendor 里不会再被选中的 pi-ai 副本与 npm 缓存（「pi-ai 桥接」标签页的清理按钮）
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/prune',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        void (async () => {
          try {
            const result = pruneVersions(1, (line) => logger?.info?.(`[pi-ai updater] ${line}`))
            // 清理后的占用立刻回报，别让 60 秒缓存继续展示旧数字
            const usage = await vendorUsageAsync()
            vendorUsageCache = { at: Date.now(), value: usage }
            logger?.info?.(`[pi-ai updater] 清理完成：删 ${String(result.removed.length)} 份，释放 ${String(Math.round(result.freedBytes / 1024 / 1024))} MB`)
            json(res, 200, { ok: true, ...result, usage })
          } catch (error) {
            json(res, 200, { ok: false, error: messageOf(error), usage: vendorUsageCache?.value ?? null })
          }
        })()
      },
    }),
    'dsh-llm-provider: /provider/prune route',
  )

  // 模型详情（悬浮卡 + 能力徽章）：三条链路合并（route 声明 → pi-ai 目录 → 适配器自报），60 秒缓存
  let modelDetailsCache: { at: number, value: ModelDetail[] } | undefined
  let modelDetailsPending: Promise<ModelDetail[]> | undefined
  /**
   * 合并一次详情：目录 + route 声明 + 适配器自报。
   * 结果按「provider + id」索引建好再摊平成数组下发（客户端也按同一个键查，裸 id 只作兜底）。
   */
  async function buildModelDetails(): Promise<ModelDetail[]> {
    const details = loadModelDetails(activePiAiRoot())
    const index = indexDetails(details)
    try {
      const routes = [...providerRoutes(providerView().providers, service<LlmService>('llm')).values()]
      const declared: DeclaredModelEntry[] = []
      for (const route of routes) {
        if (!Array.isArray(route.models)) continue
        for (const entry of route.models) declared.push({ routeId: route.id, entry })
      }
      applyDeclaredCapabilities(index, declared)
    } catch (error) {
      logger?.warn?.(`route 声明的模型能力合并失败：${messageOf(error)}`)
    }
    try {
      const added = await applyAdapterCapabilities(index, service<LlmService>('llm'))
      if (added > 0) logger?.info?.(`适配器自报补了 ${String(added)} 条模型能力`)
    } catch (error) {
      logger?.warn?.(`适配器自报的模型能力合并失败：${messageOf(error)}`)
    }
    return [...index.values()]
  }
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/models',
      handler: (req, res) => {
        // ?fresh=1：绕开 60 秒缓存（刚写完模型清单，能力徽章要立刻跟着变）
        const cacheFresh = modelDetailsCache !== undefined && Date.now() - modelDetailsCache.at <= 60_000
          && !String(req.url ?? '').includes('fresh=1')
        if (!cacheFresh) {
          // 同一个请求窗口里并发进来只跑一次（自报那段要 await 适配器）
          if (modelDetailsPending === undefined) {
            modelDetailsPending = buildModelDetails()
              .then((value) => {
                modelDetailsCache = { at: Date.now(), value }
                return value
              })
              .finally(() => { modelDetailsPending = undefined })
          }
          void modelDetailsPending.then(
            (value) => { json(res, 200, { models: value, fetchedAt: new Date().toISOString() }) },
            () => { json(res, 200, { models: [], fetchedAt: new Date().toISOString() }) },
          )
          return
        }
        const cached = modelDetailsCache
        if (cached !== undefined) {
          json(res, 200, { models: cached.value, fetchedAt: new Date().toISOString() })
          return
        }
      },
    }),
    'dsh-llm-provider: /provider/models route',
  )

  // 可添加的供应商预设（Provider 标签页「+ 添加」的候选清单，含已配置标记）
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/presets',
      handler: (_req, res) => {
        void (async () => {
          const configured = new Set<string>()
          const keyless = new Set<string>()
          try {
            const routes = providerRoutes(providerView().providers, service<LlmService>('llm'))
            for (const route of routes.values()) {
              configured.add(route.id)
              // 路由在、钥匙没值：插件自己的 config 就声明了 deepseek（没有 key 也能配上路由），
              // 这种"配了一半"的状态若照旧标成"已配置"，用户就既选不了它也补不了 key。
              const credential = await resolveKey(route.apiKeyEnv)
              // OAuth 登录过的不算缺密钥：下拉里不该再标「缺密钥」推用户去填 key。
              if (!credential.configured && !(await oauthAuthorizedFor(route.id))) keyless.add(route.id)
            }
          } catch { /* 路由发现失败就当全部未配置 */ }
          const presets = presetsWithMeta(configured, keyless)
          // OAuth 入口：把 authorization 服务列出的 flow 按 provider id 挂回 preset。
          // key 是 `<scope>/<provider-id>`，scope 是拥有这条 flow 的插件（来自官方 bundle 的注册）；
          // 这里按 provider id 后缀对齐，所以 copilot / claude / codex 这些预设能认出自己。
          const authorization = service<AuthorizationService>('authorization')
          if (typeof authorization?.list === 'function') {
            try {
              const flowsByProvider = new Map<string, AuthorizationEntry>()
              for (const entry of authorization.list()) {
                const slash = entry.key.lastIndexOf('/')
                const providerId = slash < 0 ? entry.key : entry.key.slice(slash + 1)
                flowsByProvider.set(providerId, entry)
              }
              for (const preset of presets) {
                const flow = flowsByProvider.get(preset.id)
                if (flow === undefined) continue
                preset.oauth = {
                  key: flow.key,
                  label: flow.label,
                  methods: flow.methods.map((m) => ({ id: m.id, label: m.label })),
                  inFlight: flow.inFlight,
                }
              }
            } catch (cause) {
              logger?.warn?.(`oauth 元信息挂载失败：${messageOf(cause)}`)
            }
          }
          json(res, 200, { presets })
        })()
      },
    }),
    'dsh-llm-provider: /provider/presets route',
  )

  // 刷新单个 provider 的余量：实查并顺手更新全局缓存里的这一条（徽标等其他读者也能看到新值）
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/refresh',
      handler: writeRoute(async (route, _parsed, res) => {
        const account = await accountOf(route, [])
        if (cached !== undefined) {
          cached = {
            at: cached.at,
            value: {
              ...cached.value,
              accounts: cached.value.accounts.map((entry) => (entry.id === account.id ? account : entry)),
            },
          }
        }
        json(res, 200, { ok: account.error === undefined && account.authConfigured !== false, account })
      }),
    }),
    'dsh-llm-provider: /provider/refresh route',
  )

  /**
   * 草稿探测（「添加供应商 → 测试」）：按命名空间找注册的发现器。
   *
   * 命名空间在两代宿主不是一个值（0.1.x 常量 `llm-pi-ai` / 0.2.x 插件条目 id），
   * 客户端不该知道这件事——这里两种都试、记住能用的那条（见 src/model-discovery.ts）。
   */
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/discover',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += String(chunk) })
        req.on('end', () => {
          void (async () => {
            try {
              const parsed = asRecord(JSON.parse(body === '' ? '{}' : body))
              const request = asRecord(parsed['request'] ?? parsed)
              const result = await discoverModelsVia(service<LlmService>('llm'), request, discoveryState, ownEntryId)
              json(res, 200, { ok: true, models: result.models, ns: result.ns, warnings: result.warnings })
            } catch (error) {
              json(res, 200, { ok: false, error: messageOf(error), ns: discoveryState.ns ?? null })
            }
          })()
        })
      },
    }),
    'dsh-llm-provider: /provider/discover route',
  )

  /**
   * 写 provider 配置：客户端所有写操作都走这里。
   *
   * 为什么不直连 `settings/mutate`：0.2.x 起 settings 的命名空间 = 已加载插件条目的 id，
   * `llm-pi-ai` 条目被本插件的 patch 禁用着，直写会被 "No configurable plugin entry" 拒掉。
   * 这一层按能力选路（configEditor / settings.mutate）并自愈，见 src/provider-config.ts。
   */
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/mutate',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += String(chunk) })
        req.on('end', () => {
          void (async () => {
            try {
              const parsed = asRecord(JSON.parse(body === '' ? '{}' : body))
              const op = parseProviderOp(parsed)
              if (op === undefined) {
                json(res, 400, { ok: false, error: '不认识的写操作（要 op=merge|unset|unsetFields + routeId）' })
                return
              }
              const result = await writeProviderRoutes(providerDeps(), op, writeState)
              if (op.op === 'unset') deletedIds.add(op.routeId)
              logger?.info?.(`写 provider 配置：${op.op} ${op.routeId}（经 ${result.via}）`)
              // 路由/额度面板吃的是同一份 providers，写完立刻让快照失效
              invalidatePlanSnapshot()
              json(res, 200, { ok: true, via: result.via, warnings: result.warnings, providers: result.providers })
            } catch (error) {
              json(res, 500, { ok: false, error: messageOf(error), via: writeState.via, warnings: [messageOf(error)] })
            }
          })()
        })
      },
    }),
    'dsh-llm-provider: /provider/mutate route',
  )

  // 删除 provider：从配置里摘掉这条路由 + 清掉对应凭据；内置原生路由拒绝
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/remove',
      handler: writeRoute(async (route, _parsed, res) => {
        if (route.source !== 'llm-pi-ai') {
          json(res, 400, { ok: false, error: '内置原生路由不支持在这里删除' })
          return
        }
        // 写不动的那条（0.1.x：在内置默认/composition base 里）先说清楚，别写一半：
        // 路由删不掉、凭据却被清了，卡片就变成 MISSING_CREDENTIAL
        if (providerView().immutableIds.has(route.id)) {
          json(res, 400, {
            ok: false,
            error: `${route.id} 是内置默认路由，删不掉（它在交给宿主的内置默认里，0.1.x 的配置层无法表达删除）；要停用它请清掉凭据${typeof route.apiKeyEnv === 'string' && route.apiKeyEnv !== '' ? `（${route.apiKeyEnv}）` : ''}`,
          })
          return
        }
        // 写不下去就抛（两条策略都不通会抛），所以走到这里说明宿主那边已经落盘并重载过。
        // 「写完再回读确认」在这里做不到可信：result.providers 是写之前本地算的，回读又会踩到
        // 重挂那一拍（0.2.x 第一次写入会走普通 update、插件重挂，闭包里的 config 就旧了）——
        // 假确认比没有确认更糟，所以只保留上面那道 immutableIds 前置判断。
        const result = await writeProviderRoutes(providerDeps(), { op: 'unset', routeId: route.id }, writeState)
        deletedIds.add(route.id)
        let keyCleared = true
        try {
          const credentials = service<CredentialsService>('credentials')
          if (typeof route.apiKeyEnv === 'string' && route.apiKeyEnv !== '' && typeof credentials?.unset === 'function') {
            await credentials.unset(route.apiKeyEnv)
          }
        } catch (error) {
          keyCleared = false
          logger?.warn?.(`删除 ${route.id} 后清理凭据 ${String(route.apiKeyEnv)} 失败：${messageOf(error)}`)
        }
        // 全局快照里同步移除这一条
        if (cached !== undefined) {
          cached = {
            at: cached.at,
            value: { ...cached.value, accounts: cached.value.accounts.filter((entry) => entry.id !== route.id) },
          }
        }
        json(res, 200, { ok: true, keyCleared, via: result.via, warnings: result.warnings })
      }),
    }),
    'dsh-llm-provider: /provider/remove route',
  )

  // 检测 provider：用存的 key 实查一次余量（复用计费适配器，key 不出宿主）
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: '/provider/test',
      handler: writeRoute(async (route, _parsed, res) => {
        const account = await accountOf(route, [])
        const ok = account.error === undefined && account.authConfigured !== false
        json(res, 200, { ok, account })
      }),
    }),
    'dsh-llm-provider: /provider/test route',
  )

  // 启动时后台顺带查一次上游（6 小时节流，DSH_PROVIDER_UPDATE=off 可关）：有更新就下好、
  // 验证通过后标待重启，下次启动生效——新装的机器不用手点「检查更新」。手动入口仍在
  // （设置页按钮 → POST /provider/update），替换一律要求验证通过，见 updater.ts 头部注释。
  startBackgroundCheck(logger, bridge.ok ? bridge.piAiVersion : undefined)

  // OAuth / device-code 登录桥：把官方 llm-pi-ai 里注册的 flow 暴露给浏览器端
  // （5 条路由：flows / begin / stream / respond / cancel）。详见 ./oauth.ts 头部注释。
  //
  // 顺序是刻意的：**先挂路由，再去补 authorization 服务，而且不等它**。
  //   - 路由无条件注册、服务按请求解析，所以服务什么时候就位都不影响 404/405；
  //   - 挂载是后台动作：它只负责让官方 llm-pi-ai 的 inject(['authorization']) 触发起来
  //     （原版 dsh 的 bundle 都不挂这个服务，见 ensureAuthorizationService 注释），
  //     挂上之后 flow 由官方自己按 catalog 注册。
  // 反过来写（先 await 挂载、再注册路由）踩过两次坑：await 期间若读不到服务（ctx.get 默认
  // strict，fiber 没 active 就是 undefined）或者干脆挂住，五条路由就一条都不剩，浏览器那边
  // 只看到 "Unexpected end of JSON input"。
  registerOAuthRoutes(ctx, webServer)
  void ensureAuthorizationService(ctx, logger).catch((error: unknown) => {
    logger?.warn?.(`authorization 挂载意外失败：${messageOf(error)}`)
  })

  logger?.info?.('dsh-llm-provider active: GET /plan/status, GET /provider/status, POST /provider/update, /provider/oauth/*')
}

/** 读一版被跳过的记录（status.json 里的 latestRejected）。 */
function readRejected(value: unknown): { version: string | undefined; error: string | undefined } | undefined {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return undefined
  return { version: readString(record['version']), error: readString(record['error']) }
}

/**
 * 读插件在 vendor/ 下的两个状态文件：
 *   status.json        —— 谁装到哪一版、体检结论（bridge.ts 与 updater.ts 写）
 *   updater-state.json —— 上次检查上游的时间（updater.ts 写）
 * 界面要的字段分在两个文件里（needsRestart / latestVersion 在 status.json，
 * lastCheck 在 updater-state.json），所以两个都要读。
 */
function readVendorState(): { status: AnyRecord; updater: AnyRecord } {
  const read = (name: string): AnyRecord => {
    try {
      return asRecord(JSON.parse(readFileSync(join(vendorDir, name), 'utf8')))
    } catch {
      return {}
    }
  }
  return { status: read('status.json'), updater: read('updater-state.json') }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** key 的掩码提示：前 3 + **** + 后 4，够认出是哪一把，又不把值交出去。 */
function maskKey(key: string | undefined): string | undefined {
  if (typeof key !== 'string' || key === '') return undefined
  if (key.length <= 7) return '****'
  return key.slice(0, 3) + '****' + key.slice(-4)
}
