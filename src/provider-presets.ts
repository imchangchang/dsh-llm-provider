/**
 * 可添加的供应商预设：Provider 标签页「＋ 添加供应商」的候选清单。
 *
 * 清单主体**动态来自生效 pi-ai 包的 providers 数据文件**（上游发新版自动跟进），按名字排序；
 * pi-ai 目录没有的只有 EXTRA_PRESETS 里那一个自定义网关入口，固定排最后。名字一律取 pi-ai
 * 注册表（见 pi-ai-names.ts），官网链接见 routes.ts 的 KNOWN_WEBSITES。每家标记 billing =
 * 有没有余额查询适配器（没有也能加，只是卡片不显示余量）。
 *
 * 契约与官方 Models 页完全一致（写进 settings 的 llm-pi-ai.providers 段）：
 *   - id：路由键，kebab-case（官方正则 ^[a-z][a-z0-9]*(-[a-z0-9]+)*$）
 *   - apiKeyEnv：官方 deriveKeyRef 惯例（路由大写、非字母数字转 _、加 _API_KEY 后缀）
 *   - baseURL：各家默认端点
 *
 * 预设**不带协议**：协议是 pi-ai 的事——每个模型在目录里自带 api，路由上的 api 只会盖掉它
 * （官方适配器 `request.api ?? base?.api ?? routeApi`）。40 家目录里 6 家是多协议
 * （github-copilot / openrouter / fireworks / opencode / opencode-go / cloudflare-ai-gateway），
 * 给它们挑「一个」协议必然是错的。只有 EXTRA_PRESETS 那个自建网关没有目录可回落，才要用户指定。
 */
import { loadModelDetails } from './model-details.js'
import { activePiAiRoot } from './bridge.js'
import { piAiName, piAiProviderMeta } from './pi-ai-names.js'
import { NATIVE_EQUIVALENTS, labelOf, websiteOf } from './routes.js'
import { findAdapter } from './adapters/registry.js'

/** 预设里一条供应商。 */
export interface ProviderPreset {
  id: string
  label: string
  baseURL: string
  /**
   * 只有 EXTRA_PRESETS 里自建的网关有协议——目录 provider 一律 undefined，协议由 pi-ai
   * 按模型决定。客户端只在 custom 的那条上渲染协议选择框。
   */
  api: string | undefined
  apiKeyEnv: string
  websiteUrl: string | undefined
  models: number
  billing: boolean
  custom: boolean
  /**
   * OAuth-only：这家在界面上只给 OAuth 引导，不给密钥输入框（要么登录成功，要么不可用）。
   * 判定来自 pi-ai 元数据（有 oauth、没有 apiKey），加一条例外见 `KEY_PATH_IS_DEAD_END`。
   */
  oauthOnly: boolean
}

/** 带"已配置"标记的预设（/provider/presets 的响应体）。 */
export interface ProviderPresetWithMeta extends ProviderPreset {
  configured: boolean
  /** 路由在、凭据没值：仍算已配置，但不能当成"没得可做"把补密钥的入口堵死。 */
  missingKey: boolean
  /**
   * OAuth 入口（来自 ctx.authorization.list）：没有就不挂字段。
   * 客户端据此在「添加供应商」表单里多一个 "Sign in with ..." 按钮。
   */
  oauth?: {
    /** 完整 credential key（`<scope>/<provider-id>`），begin() 要用。 */
    key: string
    label: string
    methods: { id: string, label: string }[]
    inFlight: boolean
  }
  /**
   * OAuth-only：这家在界面上只给 OAuth 引导，不给密钥输入框（要么登录成功，要么不可用）。
   * 判定来自 pi-ai 元数据（有 oauth、没有 apiKey），加一条例外见 `KEY_PATH_IS_DEAD_END`。
   */
  oauthOnly: boolean
}

/** buildPresets 内部累积的每 provider 信息；目录来源和 EXTRA_PRESETS 都归到这个形状。 */
interface PresetSource {
  api?: string | undefined
  baseURL?: string
  models?: number
  label?: string
  custom?: boolean
}

/** pi-ai 目录外只保留一个任意网关入口：端点、名字由用户自定义；协议也只有这里要选（目录里查不到）。 */
const EXTRA_PRESETS: (PresetSource & { id: string })[] = [
  { id: 'custom-gateway', label: 'Custom Gateway', baseURL: '', api: 'openai-completions', custom: true },
]

/** 官方 deriveKeyRef 同款：路由键 → 凭据名（KIMI_CODING_API_KEY 这种）。 */
export function keyEnvOf(routeId: string): string {
  return String(routeId).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
}

/** provider → 目录默认端点（该家第一个模型的 baseUrl）。缓存键是 pi-ai 根目录，换版本自然失效。 */
let catalogBaseUrls: { root: string | undefined, map: Map<string, string> } | undefined

/**
 * pi-ai 目录里这家 provider 的默认端点；目录没有就 undefined。
 *
 * 路由不再写 baseURL（写了会盖掉每个模型自己的端点，见文件头），但余额查询和界面展示
 * 仍要知道「这家发到哪」——zai / minimax 这类适配器按 host 选站点（api.z.ai vs
 * open.bigmodel.cn），拿不到就掉到错误的站点去查。
 */
export function catalogBaseUrlOf(providerId: string): string | undefined {
  const root = activePiAiRoot()
  if (catalogBaseUrls === undefined || catalogBaseUrls.root !== root) {
    const map = new Map<string, string>()
    for (const preset of buildPresets()) {
      if (preset.baseURL !== '') map.set(preset.id, preset.baseURL)
    }
    catalogBaseUrls = { root, map }
  }
  return catalogBaseUrls.map.get(providerId)
}

/**
 * 元数据里虽有 apiKey 路径、但那路径拿不到密钥的 provider——界面上按 OAuth-only 处理。
 *
 * 目前只有 github-copilot：pi-ai 的 apiKey 登录就是 `prompt('Enter GitHub Copilot token')`
 * 一个手填框，而 copilot token 本身要靠 GitHub 登录换（pi-ai 只提供 OAuth 那条路），
 * 用户手里根本不会有这种 token，摆个密钥框只会误导。其余 provider 一律以元数据为准：
 * pi-ai 加了新的 OAuth-only provider（`auth.oauth` 且没有 `auth.apiKey`）会自动跟上。
 */
const KEY_PATH_IS_DEAD_END: ReadonlySet<string> = new Set(['github-copilot'])

/** 客户端据此把密码输入框换成 OAuth 引导：pi-ai 里这家只能靠 OAuth（或密钥路径形同虚设）。 */
function oauthOnlyOf(id: string): boolean {
  const meta = piAiProviderMeta(id)
  // 读不到元数据（没装 pi-ai / 版本太老）时只认例外表，至少别把已知的两家判反
  if (meta === undefined) return KEY_PATH_IS_DEAD_END.has(id) || id === 'openai-codex'
  if (meta.oauth !== true) return false
  if (meta.apiKey !== true) return true
  return KEY_PATH_IS_DEAD_END.has(id)
}

function makePreset(id: string, info: PresetSource): ProviderPreset {
  const baseURL = typeof info.baseURL === 'string' ? info.baseURL : ''
  return {
    id,
    // 名字优先级：pi-ai 注册表原名 > 预设自带（EXTRA_PRESETS）> labelOf 按 id 拼
    label: piAiName(id) ?? info.label ?? labelOf(id),
    baseURL,
    api: info.api,
    apiKeyEnv: keyEnvOf(id),
    websiteUrl: websiteOf(id),
    models: typeof info.models === 'number' ? info.models : 0,
    billing: findAdapter(id, baseURL) !== undefined,
    custom: info.custom === true,
    oauthOnly: oauthOnlyOf(id),
  }
}

/** 全量预设：pi-ai 目录（动态）+ 补充预设，自定义入口排最后、其余按名字。 */
export function buildPresets(): ProviderPreset[] {
  const byProvider = new Map<string, PresetSource>()
  for (const detail of loadModelDetails(activePiAiRoot())) {
    let current = byProvider.get(detail.provider)
    if (current === undefined) {
      current = { baseURL: '', models: 0 }
      byProvider.set(detail.provider, current)
    }
    current.models = (current.models ?? 0) + 1
    if (current.baseURL === '' && typeof detail.baseUrl === 'string') current.baseURL = detail.baseUrl
  }
  const presets: ProviderPreset[] = []
  const seen = new Set<string>()
  for (const [id, info] of byProvider) {
    seen.add(id)
    presets.push(makePreset(id, info))
  }
  for (const extra of EXTRA_PRESETS) {
    if (!seen.has(extra.id)) presets.push(makePreset(extra.id, extra))
  }
  // 按名字排（下拉里已经有过滤：名字 + id 模糊匹配，不需要人工优先级表）。
  // Custom Gateway 固定最后：它是"其它，自己填"，不是一家供应商，混在字母序中间反而碍事。
  presets.sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? 1 : -1
    return a.label.localeCompare(b.label, 'en')
  })
  return presets
}

/** 这条预设对应到的已配置路由 id（同厂商被原生适配器覆盖也算）；没有就是 undefined。 */
function matchedRoute(presetId: string, configuredIds: ReadonlySet<string>): string | undefined {
  if (configuredIds.has(presetId)) return presetId
  for (const equivalent of NATIVE_EQUIVALENTS[presetId] ?? []) {
    if (configuredIds.has(equivalent)) return equivalent
  }
  return undefined
}

/**
 * 预设 + 已配置标记（供 /provider/presets 路由）。同厂商被原生适配器覆盖也算已配置。
 * @param configuredIds - 已有路由的 id（providerRoutes 的键）。
 * @param keylessIds - 其中凭据没值的那些：单列 missingKey，界面照旧让用户选中它去补密钥。
 */
export function presetsWithMeta(
  configuredIds: ReadonlySet<string> | undefined,
  keylessIds?: ReadonlySet<string>,
): ProviderPresetWithMeta[] {
  const ids = configuredIds instanceof Set ? configuredIds : new Set<string>()
  const keyless = keylessIds instanceof Set ? keylessIds : new Set<string>()
  return buildPresets().map((preset) => {
    const route = matchedRoute(preset.id, ids)
    return {
      ...preset,
      configured: route !== undefined,
      missingKey: route !== undefined && keyless.has(route),
    }
  })
}
