/**
 * provider 路由发现：决定额度面板上显示哪些 provider、各自用哪个凭据名。
 *
 * 两条来源合并：
 *   1. `providers` 记录——由 src/provider-config.ts 从两代宿主各自的落点读出来再合并
 *      （0.1.x：`settings.yaml` 的 `llm-pi-ai` 段；0.2.x：profile patch 里插件条目的 config，
 *      老段也一起读）。这里只做映射、不碰 settings 服务：0.2.x 起 settings 没有 get/section。
 *   2. `ctx.llm.listConfigurableProviders()` 里的原生适配器路由（llm-deepseek 这类）：
 *      它们不写 settings 段也带默认 apiKeyEnv，seam 上查不到这个默认值，只能用
 *      NATIVE_ROUTE_DEFAULTS 对上。必须含进来，否则「deepseek 的 key 被填到 kimi 那一栏」
 *      这类错配检测不到（实测就是靠这条才发现的）。
 */
import { piAiName } from './pi-ai-names.js'
import { asRecord, readString, type AnyRecord, type LlmService } from './types.js'
import type { ProviderRecord } from './provider-config.js'

/** 一条要查额度的路由。 */
export interface ProviderRoute {
  id: string
  apiKeyEnv: string | undefined
  baseURL: string | undefined
  /** wire 协议（settings 段里存的值，卡片展开体要展示）。 */
  api?: string | undefined
  label: string | undefined
  source: 'llm-pi-ai' | 'native'
  /**
   * 路由自己声明的模型清单（`llm-pi-ai.providers.<id>.models`），没声明就是 undefined。
   *
   * 有它才谈得上「编辑清单」：官方 `resolveRouteModels` 里 `configured.length > 0 ? configured : 目录`，
   * 空/缺省都表示跟随 pi-ai 目录。界面把它原样下发给模型清单编辑器（issue #1）。
   */
  models?: unknown
}

/**
 * provider 显示名：pi-ai 注册表原名优先（deepseek → "DeepSeek"），
 * pi-ai 没有的原生路由走 NATIVE_ROUTE_DEFAULTS，再按 id 拼一个（kimi-coding → "Kimi Coding"）。
 */
export function labelOf(providerId: string): string {
  const piName = piAiName(providerId)
  if (piName !== undefined) return piName
  return providerId
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/** provider id → 官网/控制台链接（Provider 卡片名称下的跳转链接）。取自 CC Switch 预设（剥掉 aff/utm 跟踪参数）；CC Switch 没有的（moonshot/zenmux）用官方控制台地址。 */
const KNOWN_WEBSITES: Record<string, string> = {
  'kimi-coding': 'https://www.kimi.com/code',
  'zai-coding-cn': 'https://open.bigmodel.cn',
  'qwen-token-plan-cn': 'https://bailian.console.aliyun.com',
  'deepseek': 'https://platform.deepseek.com',
  'deepseek-official': 'https://platform.deepseek.com',
  'moonshotai-cn': 'https://platform.moonshot.cn',
  'minimax-cn': 'https://platform.minimaxi.com',
  'opencode-go': 'https://opencode.ai/go',
  'openrouter': 'https://openrouter.ai',
}

/** 查官网链接：精确匹配优先，再试前缀（minimax-cn → minimax-intl 这类变体兜底）。 */
export function websiteOf(providerId: string): string | undefined {
  const exact = KNOWN_WEBSITES[providerId]
  if (exact !== undefined) return exact
  for (const key of Object.keys(KNOWN_WEBSITES)) {
    const stem = key.endsWith('-cn') ? key.slice(0, -3) : key
    if (providerId.startsWith(key) || (stem !== key && providerId.startsWith(stem))) return KNOWN_WEBSITES[key]
  }
  return undefined
}

/** 原生适配器的默认 apiKeyEnv：这些适配器不写 settings 段也有 key 引用，值只能在这里认。 */
export const NATIVE_ROUTE_DEFAULTS: Record<string, { apiKeyEnv: string; label: string }> = {
  'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
}

/**
 * 同一家供应商在两套适配器里的 id 对照：pi-ai 的 `deepseek` ↔ 原生 llm-deepseek 的
 * `deepseek-official`。两边是同一个账号、同一个凭据名，所以界面上只该有一张卡片。
 */
export const NATIVE_EQUIVALENTS: Record<string, readonly string[]> = {
  deepseek: ['deepseek-official'],
}

/** 这条原生路由对应那家供应商是不是已经有 pi-ai 路由在服务了。 */
function piAiRouteCovers(nativeProvider: string, routes: ReadonlyMap<string, ProviderRoute>): boolean {
  for (const [piAiId, nativeIds] of Object.entries(NATIVE_EQUIVALENTS)) {
    if (nativeIds.includes(nativeProvider) && routes.has(piAiId)) return true
  }
  return false
}

/**
 * 合并出要查额度的路由表。
 * @param providers - 已合并的 providers 记录（见 src/provider-config.ts；undefined 视作空）。
 * @param llm - llm 服务（可为 undefined）；用它的 listConfigurableProviders 找原生路由。
 */
export function providerRoutes(
  providers: ProviderRecord | undefined,
  llm: LlmService | undefined,
): Map<string, ProviderRoute> {
  const routes = new Map<string, ProviderRoute>()
  for (const [id, rawRoute] of Object.entries(providers ?? {})) {
    const route = asRecord(rawRoute)
    routes.set(id, {
      id,
      apiKeyEnv: readString(route['apiKeyEnv']),
      baseURL: readString(route['baseURL']),
      // wire 协议：卡片展开体要和「添加供应商」表单展示同一组信息，配置里存的就是这个值
      api: readString(route['api']),
      label: readString(route['displayName']),
      source: 'llm-pi-ai',
      // 模型清单编辑器要它：原样下发（数组、字符串条目都允许），由界面解析
      ...(Array.isArray(route['models']) ? { models: route['models'] } : {}),
    })
  }

  let declared: unknown = []
  try {
    declared = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
  } catch {
    declared = []
  }
  for (const rawEntry of Array.isArray(declared) ? declared : []) {
    const entry = asRecord(rawEntry)
    if (entry['settingsNs'] === 'llm-pi-ai') continue
    const provider = readString(entry['provider'])
    if (provider === undefined) continue
    const defaults = NATIVE_ROUTE_DEFAULTS[provider]
    if (defaults === undefined || routes.has(provider)) continue
    // 同一家已经由 pi-ai 路由服务时不再出第二张卡。老用户配过官方 llm-deepseek 的，
    // 目录里就多一条 deepseek-official，两张卡查的是同一个账号、同一把 key。
    if (piAiRouteCovers(provider, routes)) continue
    routes.set(provider, {
      id: provider,
      apiKeyEnv: defaults.apiKeyEnv,
      baseURL: undefined,
      label: defaults.label,
      source: 'native',
    })
  }

  return routes
}
