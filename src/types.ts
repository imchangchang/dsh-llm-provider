/**
 * 插件用到的类型。
 *
 * 一条原则：**不引 dsh 的内部类型**。cordis 上下文、各项服务、settings 文档都按"我们用到
 * 的那几样"在这里就地声明，形状宽到能容下宿主的实际实现——第三方插件 import 宿主的内部类型，
 * 等于把宿主升级变成自己的编译期故障。
 *
 * 动态边界（settings 段、HTTP 载荷、适配器返回的第三方 JSON）一律走 `AnyRecord`，
 * 用 `readString` / `readNumber` 这类小工具收口，别到处 cast。
 */

/** 任意 JSON 形状的记录：settings 段、请求载荷、上游返回的 JSON。 */
export type AnyRecord = Record<string, unknown>

/** 宿主日志器（只要用到的方法）。 */
export interface Logger {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/* ------------------------------ HTTP ------------------------------ */

/** 我们只用到的请求面。 */
export interface ServerRequest {
  method?: string
  url?: string
  /**
   * `data` / `end`：HTTP body 的两个阶段。`close`：SSE 长连接被浏览器断网 / 关页时触发，
   * 用来清掉事件总线上的 listener，避免后续帧往死 socket 写。
   */
  on: (event: 'data' | 'end' | 'close', listener: (chunk?: unknown) => void) => void
}

/** 我们只用到的响应面。 */
export interface ServerResponse {
  writeHead: (status: number, headers?: Record<string, string>) => void
  /** 多帧发送：SSE / 长轮询响应都得靠它。Node 的 ServerResponse 实际签名是 `(chunk, encoding?, cb?)`，这里只用到前两个参数。 */
  write: (chunk: string, encoding?: BufferEncoding) => void
  end: (body?: string) => void
  /** Node 的 ServerResponse.headersSent：headers 已发再 writeHead 抛 ERR_STREAM_WRITE_AFTER_ENDT，写 SSE 时要检查。 */
  headersSent?: boolean
}

export interface ExactRoute {
  kind: 'exact'
  path: string
  handler: (req: ServerRequest, res: ServerResponse) => void
}

export interface WebServerService {
  register: (route: ExactRoute) => () => void
}

/* ---------------------------- 宿主服务 ---------------------------- */

/** llm 服务目录里的一条（原生适配器路由）。 */
export interface LlmDirectoryEntry {
  provider?: string
  displayName?: string
  settingsNs?: string
  settingsPath?: readonly string[]
  declared?: boolean
}

export interface LlmService {
  listConfigurableProviders?: () => LlmDirectoryEntry[]
  /** 已注册的路由（provider id + 显示名）。能力自报那条链路从它挑 provider。 */
  listProviders?: () => { id: string, name?: string }[]
  /**
   * 一条路由自己报的模型清单（适配器实现，进程内调用）。
   * `inputModalities` 缺省 = 未知；显式给了就照它算（「没有 image」是阴性能力，不是未知）。
   */
  listModels?: (provider: string) => Promise<{ id: string, name?: string, inputModalities?: readonly string[] }[]>
  /**
   * 注册在某个命名空间下的「草稿探测」：给一条还没落盘的路由问出模型清单。
   *
   * 命名空间两代宿主不同（0.1.x 是常量 `llm-pi-ai`，0.2.x 是插件条目 id），
   * 见 src/model-discovery.ts——那里按候选顺序试并记住能用的那个。
   */
  discoverModels?: (settingsNs: string, request: unknown) => Promise<unknown>
  /** 精确一条 route 的模型信息：模态、上下文、输出上限都可能在这（能力自报的兜底）。 */
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{
    id?: string
    inputModalities?: readonly string[]
    context?: { contextWindow?: number }
    defaultMaxTokens?: number
    reasoning?: unknown
  }>
}

/** settings 的一次写操作（跟宿主 mutate 的入参形状一致）。 */
export interface SettingsOp {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

export interface SettingsService {
  get?: (namespace: string) => AnyRecord | undefined
  /**
   * 直读 settings 文档里那一节的原始内容，**不要求命名空间已注册**。
   *
   * 跟 get() 的区别：get() 给的是"解析后"的值（schema 默认 + 插件 config + 用户配置），
   * 但要求命名空间已注册；section() 读的是文档原文，命名空间还没注册时也拿得到。
   *
   * 0.2.x 起这两个方法都没了（settings 服务的命名空间 = 已加载插件条目的 id，
   * 配置读写走 configEditor）——所以它们都是可选的，见 src/provider-config.ts。
   */
  section?: (namespace: string) => AnyRecord | undefined
  mutate?: (namespace: string, ops: readonly SettingsOp[]) => Promise<void>
}

/**
 * 0.2.x 的配置编辑器（`ctx.configEditor`）：把插件条目的完整 config 写进 profile patch，
 * 并由 Loader 立即重载。0.1.x 没有这个服务。
 */
export interface ConfigEditorService {
  /** 可寻址的插件条目（只有 profile 根 include 下、id 唯一且已加载的条目）。 */
  entries?: () => unknown[]
  /**
   * 校验并持久化一条条目的下一版 config。
   * @param entry - {@link entries} 里的条目对象。
   * @param change - 由当前 config 与继承层推导出下一版 config（完整替换，不是补丁）。
   */
  edit?: (entry: unknown, change: (current: unknown, inherited: unknown) => unknown) => Promise<void>
  /** profile patch 文件路径（诊断用）。 */
  documentPath?: string
}

/** Loader 服务：0.2.x 上从根 include 条目读 profile patch 的原始行（老 `llm-pi-ai` 段在那）。 */
export interface LoaderService {
  entries?: () => unknown[]
  /** 等这棵树的挂载/注销任务落定（Loader 的 `await()`）。 */
  await?: () => Promise<unknown>
}

export interface CredentialsService {
  resolve?: (ref: string) => Promise<unknown>
  unset?: (ref: string) => Promise<void>
  /**
   * 读一条凭据记录（OAuth 那些是 `kind: 'grant'`）。用来判断某个走 OAuth 的 provider
   * 是不是已经登录过——API key 走的是 ref，两套键空间互不相干。
   */
  readRecord?: (key: string) => Promise<unknown>
}

/* ---------------------------- Authorization ---------------------------- */

/**
 * 宿主 `authorization` 服务（dsh 的 OAuth / device-code 登录注册中心）的就地声明。
 *
 * 每个 flow 负责一条凭据记录，由官方 llm-pi-ai bundle 在 mount 时按 pi-ai catalog 注册；
 * 浏览器通过我们新增的 HTTP 路由间接调它（`ctx.authorization` 不直接暴露 RPC）——
 * 见 src/index.ts 的 `registerOAuthRoutes`。
 *
 * 凭据记录的 key 形状是 `<scope>/<id>`：scope 是拥有记录的插件名，id 是 provider id。
 * 这里只用到字符串字段，不导入 dsh 的 `CredentialKey` 类型，免得宿主升级变成本插件编译期故障。
 */

/** 一条 flow 给出的登录方式（多数优先法选自）。 */
export interface AuthorizationMethod {
  /** flow 自己的 id，begin() 时回传以指明走哪一路。 */
  id: string
  /** 按钮上的文案。 */
  label: string
}

/** 一条 flow 在列表里的视图。 */
export interface AuthorizationEntry {
  /** 凭据记录 key（`<scope>/<provider-id>`）。 */
  key: string
  /** 用户看到的大标题，例如 `GitHub Copilot`。 */
  label: string
  /** 该 flow 提供的登录方式，多数优先。 */
  methods: readonly AuthorizationMethod[]
  /** 同一 key 已有 attempt 在跑：按钮置灰。 */
  inFlight: boolean
}

/** flow 推到浏览器的提示（一次性看完即丢）。不带 secret。 */
export interface AuthorizationNotice {
  message: string
  /** 用户要打开的页面。 */
  url?: string
  /** 用户要在页面上输入的短码（device-code flow 才有）。 */
  code?: string
}

/** 一个 select prompt 的一个选项。 */
export interface AuthorizationPromptOption {
  id: string
  label: string
  description?: string
}

/**
 * flow 推到浏览器的提问，浏览器需要回 `respond`。
 *
 * 形状对应 dsh 的 `AuthorizationPrompt`：text / secret / select 三种 kind，各自的字段集互不相交。
 */
export type AuthorizationPrompt = {
  /** 只撤回这一个 prompt；attempt 本身继续。 */
  signal?: AbortSignal
} & ({
  kind: 'text'
  message: string
  placeholder?: string
} | {
  kind: 'secret'
  message: string
  placeholder?: string
} | {
  kind: 'select'
  message: string
  options: readonly AuthorizationPromptOption[]
})

/** resolve 后写入的 prompt 答案：secret → 用户输入；text → 用户输入；select → 选项 id。 */
export type AuthorizationResponse =
  | { kind: 'text' | 'secret'; value: string }
  | { kind: 'select'; value: string }

/**
 * 浏览器↔flow 之间的桥（attempt 开始时由我们实现并交给 `begin()`）。它在内存里把
 * notice / prompt 推到 SSE 流，并阻塞 await `prompt()` 等到浏览器 respond。
 *
 * 关键约束：每个 attemptId 只能挂一次 `interaction.begin()`；同一个 attemptId 二次 begin
 * 直接报 `ALREADY_IN_FLIGHT`（seed 之前：seam 会拒绝）。
 */
export interface AuthorizationInteraction {
  notify(notice: AuthorizationNotice): void
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

export interface AuthorizationRequest {
  /** 凭据记录的 key。 */
  key: string
  /** 走哪条 method；不传就用 flow 第一个。 */
  method?: string
  interaction: AuthorizationInteraction
  /** 浏览器取消 attempt 时 abort 这个 signal，seam 会顺手收回 in-flight slot。 */
  signal?: AbortSignal
}

/** attempt 结算状态——`failed` 只出现在事件流里，调用方看到的是抛错。 */
export type AuthorizationOutcome = 'authorized' | 'cancelled'

export interface AuthorizationService {
  list?: () => readonly AuthorizationEntry[]
  describe?: (key: string) => AuthorizationEntry | undefined
  begin?: (request: AuthorizationRequest) => Promise<{ status: AuthorizationOutcome }>
  cancel?: (key: string) => void
}

/* ---------------------------- 插件上下文 ---------------------------- */

/**
 * cordis 上下文。只声明我们用到的方法，其余走索引签名。
 *
 * 拿服务一律走 `get`：`ctx.<name>` 那种属性访问在 cordis 严格模式下要求 inject 列表里声明过
 * `<name>`，否则抛 "cannot get property … without inject"。代码里用 `service()` 统一收口。
 */
export interface PluginContext {
  get?: (name: string) => unknown
  effect: (fn: () => unknown, label?: string) => void
  inject?: (names: readonly string[], callback: (scope: PluginContext) => void) => void
  /**
   * 在当前 fiber 下挂一个子插件（函数 / 类 / `{ apply }` 对象）。返回的 fiber 是 thenable，
   * await 它等于等这个插件加载完。我们用它把宿主缺的 authorization 服务挂上。
   */
  plugin?: (plugin: unknown, config?: unknown) => Promise<unknown>
  logger?: Logger | ((name: string) => Logger)
  [key: string]: unknown
}

/** cordis 插件模块的形状。 */
export interface PluginModule {
  name?: string
  inject?: readonly string[]
  apply: (ctx: PluginContext, config: unknown) => void
}

/* --------------------------- 小工具 --------------------------- */

/** JSON 对象 → 记录；不是对象就给空记录。 */
export function asRecord(value: unknown): AnyRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as AnyRecord
}

/** 读字符串字段，空的/非字符串一律 undefined。 */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 读数字字段（数字字符串也认）。 */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
