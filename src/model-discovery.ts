/**
 * 模型发现（「添加供应商 → 测试」那一步）的命名空间适配。
 *
 * 官方 `llm.discoverModels(settingsNs, request)` 是**按命名空间**找注册的发现器，
 * 找不到就抛 `NO_DISCOVERY`。而命名空间在两代宿主里不是一个值：
 *
 * | | 注册用的 ns |
 * |---|---|
 * | 0.1.x 的官方 bundle | 常量 `llm-pi-ai`（`settings.installSection(NS)` 那套） |
 * | 0.2.x 的官方 bundle | `ctx.fiber.entry?.options.id ?? NS`——桥接副本是用**我们自己的 ctx** 装起来的，所以是 `dsh-llm-provider` |
 *
 * 客户端以前把 `llm-pi-ai` 写死，在 0.2.x 上只有「目录里没有的自建网关」会走到这条路
 * （目录 provider 走本地分支，不调发现），于是表现为「自建网关点测试报 no model discovery」。
 *
 * 这里按候选顺序试（先记住上一次成功的那个），只对「这个 ns 没注册」换下一条；
 * 真正的失败（HTTP 401、端点不通）立刻抛出去，不拿换 ns 掩盖。
 */
import { LEGACY_NS } from './provider-config.js'
import type { LlmService } from './types.js'

/** 跨调用记忆：上次发现成功用的命名空间。 */
export interface DiscoveryState {
  ns?: string
  lastError?: string
}

/** 候选命名空间：本插件条目在前（0.2.x 的样子），老常量在后（0.1.x）。 */
export function discoveryNamespaces(ownEntryId: string): string[] {
  return ownEntryId === LEGACY_NS ? [LEGACY_NS] : [ownEntryId, LEGACY_NS]
}

/** 这条错误是不是「这个命名空间没注册发现器」（只有这种才值得换下一条）。 */
export function isMissingDiscovery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no model discovery is registered/i.test(message) || /NO_DISCOVERY/.test(message)
}

/**
 * 试出能用的命名空间并完成一次发现。
 *
 * @param llm - llm 服务。
 * @param request - 发现请求（provider / baseURL / api / apiKey，形状见官方 `LlmModelDiscoveryRequest`）。
 * @param state - 跨调用记忆（调用方持有）。
 * @param ownEntryId - 本插件的条目 id（0.2.x 上发现器注册在它名下）。
 * @returns `{ models, ns }`：发现结果与真正生效的命名空间。
 */
export async function discoverModelsVia(
  llm: LlmService | undefined,
  request: unknown,
  state: DiscoveryState = {},
  ownEntryId: string,
): Promise<{ models: unknown, ns: string, warnings: string[] }> {
  if (llm === undefined || typeof llm.discoverModels !== 'function') {
    throw new Error('宿主没有 llm.discoverModels（这一版 dsh 不支持草稿探测）')
  }
  const all = discoveryNamespaces(ownEntryId)
  // 记忆优先：上次哪条走得通就先试它，走不通再按默认顺序补
  const candidates = state.ns === undefined
    ? all
    : [state.ns, ...all.filter((ns) => ns !== state.ns)]
  const warnings: string[] = []
  for (const ns of candidates) {
    try {
      const models = await llm.discoverModels(ns, request)
      state.ns = ns
      state.lastError = undefined
      return { models, ns, warnings }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastError = message
      if (!isMissingDiscovery(error)) {
        // 真正的失败：换 ns 也是同一个发现器，只会把原因绕远
        throw error
      }
      warnings.push(`${ns} 上没有注册模型发现器，换下一条`)
    }
  }
  throw new Error(`没有可用的模型发现器（试过 ${candidates.join('、')}）：${String(state.lastError)}`)
}
