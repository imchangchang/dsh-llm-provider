/**
 * 模型详情：从生效 pi-ai 包的 providers 数据文件读出全量模型元数据。
 *
 * 为什么不用 session/modelCatalog：那条官方 RPC 的模型条目只有 id/name/description/reasoning，
 * 没有上下文窗口、最大输出、能力（视觉/视频）这些——悬浮详情卡（Cherry Studio 式）需要更全的字段，
 * 而 pi-ai 的数据文件里都有（input/contextWindow/maxTokens/reasoning/thinkingLevelMap）。
 *
 * 能力字段是**多链路**取的（issue #5），优先级从高到低：
 *   1. route 自己声明的 `input`（`llm-pi-ai.providers.<id>.models[].input`）——官方
 *      `resolveRouteModels` 里 `declaredInput(entry.input) ?? base?.input`，声明了就它说了算；
 *   2. pi-ai 目录的 providers 数据文件（上面那份）；
 *   3. 适配器自报：`llm.listProviders()` → `llm.listModels()` → `llm.resolveModelInfo()`，
 *      **只补前两条都没覆盖到的 provider**（合成 provider 不在目录里，也不走 llm-pi-ai 路由，
 *      只有它自己知道自己的模态）；
 *   4. 都查不到就什么都不写：界面上不打徽章、详情卡注明能力未知，不猜。
 *
 * 输出按 provider 归组，客户端拿去做 hover 详情卡和上下文标签。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asRecord, readNumber, readString, type LlmService } from './types.js'

const DATA_DIR = join('dist', 'providers', 'data')

/** 能力/参数是哪条链路给的：route 声明 / pi-ai 目录 / 适配器自报。 */
export type ModelDetailSource = 'route' | 'catalog' | 'adapter'

/** 一个模型的元数据（下发给浏览器的形状）。 */
export interface ModelDetail {
  id: string
  name: string
  provider: string
  api: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  vision: boolean
  video: boolean
  reasoning: boolean
  thinkingLevels: string[]
  /** 这条详情的来源（界面据此说明「能力从哪来」）。 */
  source?: ModelDetailSource
  /**
   * 能力字段是不是真查到了。
   *
   * `vision/video` 的 false 有两种意思：「查过，就是不支持」和「不知道」。前者是个结论（文本模型
   * 不该被说成「能力未知」），后者才该在详情卡里注明未知。有 `input` / `inputModalities` 才算查到。
   */
  capabilitiesKnown?: boolean
}

/** 读一个 pi-ai 包目录的 providers 数据文件，拍平成模型详情数组。 */
export function loadModelDetails(piAiRoot: string | undefined): ModelDetail[] {
  if (typeof piAiRoot !== 'string' || piAiRoot === '') return []
  const dir = join(piAiRoot, DATA_DIR)
  if (!existsSync(dir)) return []
  const details: ModelDetail[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue // 单个文件坏了不影响其他家
    }
    const data = asRecord(parsed)
    for (const api of Object.keys(data)) {
      const models = asRecord(data[api])
      for (const [modelId, rawEntry] of Object.entries(models)) {
        const entry = asRecord(rawEntry)
        if (Object.keys(entry).length === 0) continue
        const input = Array.isArray(entry['input']) ? entry['input'].filter((x): x is string => typeof x === 'string') : []
        const map = asRecord(entry['thinkingLevelMap'])
        const thinking = Object.keys(map).filter((k) => map[k] !== null && map[k] !== undefined)
        details.push({
          id: readString(entry['id']) ?? modelId,
          name: readString(entry['name']) ?? modelId,
          provider: readString(entry['provider']) ?? file.replace(/\.json$/, ''),
          api: readString(entry['api']) ?? api,
          baseUrl: readString(entry['baseUrl']),
          contextWindow: readNumber(entry['contextWindow']),
          maxTokens: readNumber(entry['maxTokens']),
          vision: input.includes('image'),
          video: input.includes('video'),
          reasoning: entry['reasoning'] === true,
          thinkingLevels: thinking,
          source: 'catalog',
          capabilitiesKnown: input.length > 0,
        })
      }
    }
  }
  return details
}

/** 详情索引键：provider + 模型 id。裸 id 建索引会串家（同名模型属不同 provider）。 */
export function detailKey(provider: string, id: string): string {
  return provider + '\u0000' + id
}

/** 一条 route 声明（`llm-pi-ai.providers.<id>.models` 里的一项，或它的字符串简写）。 */
export interface DeclaredModelEntry {
  routeId: string
  entry: unknown
}

/** 一份按 `provider + id` 索引的详情表。 */
export type ModelDetailIndex = Map<string, ModelDetail>

/** 目录详情 → 索引。 */
export function indexDetails(details: readonly ModelDetail[]): ModelDetailIndex {
  const index: ModelDetailIndex = new Map()
  for (const detail of details) index.set(detailKey(detail.provider, detail.id), detail)
  return index
}

/**
 * 把 route 声明的能力盖到目录详情上（链路 1，**优先级最高**）。
 *
 * 声明的 `input` 就是官方 `resolveRouteModels` 里那个 `declaredInput(entry.input) ?? base?.input`：
 * 写了就以它为准。目录里没有的模型 id（自定义 id）在这里新增一条，能力未知的字段留空
 * ——不拿「没写」当「不支持」。
 *
 * @param index - 目录详情索引（就地更新）。
 * @param declared - 各 route 的声明清单。
 */
export function applyDeclaredCapabilities(index: ModelDetailIndex, declared: readonly DeclaredModelEntry[]): void {
  for (const { routeId, entry } of declared) {
    const raw = typeof entry === 'string' ? { id: entry } : asRecord(entry)
    const id = readString(raw['id'])
    if (id === undefined || id === '') continue
    const key = detailKey(routeId, id)
    const previous = index.get(key)
    const input = Array.isArray(raw['input']) ? raw['input'].filter((x): x is string => typeof x === 'string') : []
    const detail: ModelDetail = previous === undefined
      ? {
          id,
          name: readString(raw['name']) ?? id,
          provider: routeId,
          api: '',
          contextWindow: readNumber(raw['contextWindow']),
          maxTokens: readNumber(raw['maxTokens']),
          // 没声明 input 且目录里没有这条：能力不知道，两个 false 只表示「没查到」，界面照 source 说话
          vision: false,
          video: false,
          reasoning: false,
          thinkingLevels: [],
          source: 'route',
          capabilitiesKnown: false,
        }
      : { ...previous, source: 'route' }
    if (input.length > 0) {
      detail.vision = input.includes('image')
      detail.video = input.includes('video')
      detail.capabilitiesKnown = true
    } else if (previous !== undefined) {
      // 声明里没写 input：能力沿用目录那份（resolveEntry 的 `declaredInput(...) ?? base?.input`）
      detail.capabilitiesKnown = previous.capabilitiesKnown === true
    }
    if (detail.contextWindow === undefined) detail.contextWindow = readNumber(raw['contextWindow'])
    if (detail.maxTokens === undefined) detail.maxTokens = readNumber(raw['maxTokens'])
    if (previous !== undefined && readString(raw['name']) !== undefined) detail.name = readString(raw['name']) as string
    index.set(key, detail)
  }
}

/** 能力自报的预算：适配器卡住不能拖死 /provider/models。 */
export interface AdapterCapabilityOptions {
  /** 单次调用的超时（毫秒）。 */
  callTimeoutMs?: number
  /** 整段自报的总预算（毫秒），超了就放弃剩下的。 */
  budgetMs?: number
  /** 每个 provider 最多补多少条（防止一个 adapter 报几千条把响应撑爆）。 */
  maxModelsPerProvider?: number
}

/**
 * 适配器自报（链路 3）：只补前面两条都没覆盖到的 provider。
 *
 * 合成 provider（`modlens-*` 这类）不在 pi-ai 目录里、也不是 llm-pi-ai 路由，模态只有它自己知道。
 * 所以先 `listProviders()` 找已注册路由，跳过索引里已经有它模型的 provider；再 `listModels()`
 * 拿每个模型的 `inputModalities`；`inputModalities` 缺省的（返回 undefined = 未知，跟空数组
 * 不是一回事）才 `resolveModelInfo()` 问一次。带单调用超时与总预算，任何一步失败都只是少几条
 * 详情，不影响其它 provider。
 *
 * @param index - 详情索引（就地补写，**不覆盖**已有的目录/声明条目）。
 * @param llm - llm 服务。
 * @param options - 超时与条数上限。
 * @returns 实际补上的条数。
 */
export async function applyAdapterCapabilities(
  index: ModelDetailIndex,
  llm: LlmService | undefined,
  options: AdapterCapabilityOptions = {},
): Promise<number> {
  if (llm === undefined || typeof llm.listModels !== 'function' || typeof llm.listProviders !== 'function') return 0
  const callTimeoutMs = options.callTimeoutMs ?? 2500
  const budgetMs = options.budgetMs ?? 6000
  const maxModelsPerProvider = options.maxModelsPerProvider ?? 200
  const deadline = Date.now() + budgetMs
  const known = new Set<string>()
  for (const detail of index.values()) known.add(detail.provider)
  let providers: { id: string, name?: string }[] = []
  try {
    const listed = llm.listProviders()
    providers = Array.isArray(listed) ? listed : []
  } catch {
    return 0
  }
  let added = 0
  for (const provider of providers) {
    if (Date.now() > deadline) break
    const id = readString(provider?.id)
    if (id === undefined || id === '' || known.has(id)) continue
    let models: unknown
    try {
      models = await withTimeout(llm.listModels(id), callTimeoutMs)
    } catch {
      continue
    }
    if (!Array.isArray(models)) continue
    let count = 0
    for (const rawModel of models) {
      if (count >= maxModelsPerProvider || Date.now() > deadline) break
      const model = asRecord(rawModel)
      const modelId = readString(model['id'])
      if (modelId === undefined || modelId === '') continue
      count += 1
      const detail: ModelDetail = {
        id: modelId,
        name: readString(model['name']) ?? modelId,
        provider: id,
        api: '',
        vision: false,
        video: false,
        reasoning: false,
        thinkingLevels: [],
        source: 'adapter',
        capabilitiesKnown: false,
      }
      const modalities = readModalities(model['inputModalities'])
      if (modalities !== undefined) {
        applyModalities(detail, modalities)
      } else if (typeof llm.resolveModelInfo === 'function' && Date.now() < deadline) {
        // listModels 没说模态：问一次精确的（适配器自己的 lookup）。
        // 官方这个签名收 signal，所以超时就真的取消掉，别把挂起的调用留在适配器里。
        const controller = new AbortController()
        try {
          const info = await withTimeout(
            llm.resolveModelInfo(id, modelId, controller.signal),
            callTimeoutMs,
            () => { controller.abort() },
          )
          const record = asRecord(info)
          const resolved = readModalities(record['inputModalities'])
          if (resolved !== undefined) applyModalities(detail, resolved)
          const contextWindow = readNumber(asRecord(record['context'] ?? {})['contextWindow'])
          if (contextWindow !== undefined) detail.contextWindow = contextWindow
          const maxTokens = readNumber(record['defaultMaxTokens'])
          if (maxTokens !== undefined) detail.maxTokens = maxTokens
        } catch { /* 单条失败就只少这一条的模态 */ }
      }
      if (!index.has(detailKey(id, modelId))) {
        index.set(detailKey(id, modelId), detail)
        added += 1
      }
    }
  }
  return added
}

/** `inputModalities` → 模态列表；返回 undefined = 上游没报（未知），不是「没有」。 */
function readModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function applyModalities(detail: ModelDetail, modalities: readonly string[]): void {
  detail.vision = modalities.includes('image')
  detail.video = modalities.includes('video')
  detail.capabilitiesKnown = true
}

/**
 * 给一个 promise 套超时（适配器卡住时不能拖死整个响应）。
 * @param promise - 适配器调用。
 * @param ms - 超时毫秒数。
 * @param onTimeout - 超时后的收尾（有 signal 的调用在这里 abort，别把挂起的调用留在适配器里）。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (onTimeout !== undefined) onTimeout()
          reject(new Error('适配器调用超时'))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 默认模型（`agent-default-model` 那一行）不在当前 pi-ai 目录里时的警示（纯函数，离线可测）。
 *
 * 目录里的模型 id 随 pi-ai 版本变（0.85.1 是 `deepseek-v4-flash`、0.99.1 是 `deepseek-flash`），
 * 而默认模型存的是 id 字符串。对不上时新会话一开口就 `UNKNOWN_MODEL`，所以启动时就说清，
 * 别等用户发消息才发现。
 *
 * @param defaultModel - 默认模型那一行的 config（`{provider, model}`）。
 * @param details - 当前目录+声明+适配器合并后的模型详情。
 * @returns 一行警示文案；模型在目录里、或读不到默认模型时返回 undefined。
 */
export function defaultModelWarning(
  defaultModel: { provider?: unknown, model?: unknown } | undefined,
  details: readonly ModelDetail[],
): string | undefined {
  if (defaultModel === undefined) return undefined
  const provider = typeof defaultModel.provider === 'string' ? defaultModel.provider : ''
  const model = typeof defaultModel.model === 'string' ? defaultModel.model : ''
  if (provider === '' || model === '') return undefined
  if (details.some((entry) => entry.provider === provider && entry.id === model)) return undefined
  const sameProvider = details.filter((entry) => entry.provider === provider).map((entry) => entry.id)
  const examples = sameProvider.slice(0, 3)
  return `默认模型 ${provider}/${model} 不在当前 pi-ai 目录里`
    + (examples.length === 0 ? '' : `（这个 provider 下可用：${examples.join('、')}）`)
    + '；新会话会直接报 UNKNOWN_MODEL'
}
