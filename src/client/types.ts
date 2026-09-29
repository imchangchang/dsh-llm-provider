/**
 * 浏览器端类型。
 *
 * 形状都是宿主/自家路由下发的 JSON，按「我们用到的那几样」就地声明，
 * 不引 dsh 的内部类型（理由见 ../types.ts 开头那条原则）。
 */
import type { BalanceRow, QuotaWindow } from '../adapters/shared.js'

/** 一个 provider/model/reasoningEffort 选择：会话投影、目录 current、提交载荷共用。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 模型声明的思考强度档位表：档位 id 列表 + 默认档。 */
export interface CatalogReasoning {
  efforts: string[]
  default: string | undefined
}

/** 目录里的一个模型（当前选择回显、模型面板、模型行都用它）。 */
export interface CatalogModel {
  id: string
  name: string
  contextWindow?: number
  reasoning?: CatalogReasoning
}

/** 目录里的一个 provider 分组。 */
export interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}

/** /provider/models 里的一条模型详情（生效 pi-ai 包的元数据），按模型 id 建索引。 */
export interface ModelDetail {
  id?: string
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  video?: boolean
  reasoning?: boolean
  thinkingLevels?: string[]
}

/** /plan/status 的 accounts 项：额度快照里的一家 provider（宿主在通用字段外还会带几个）。 */
export interface PlanAccount {
  id: string
  displayName?: string
  kind?: string
  authConfigured?: boolean
  baseUrl?: string
  websiteUrl?: string
  keyHint?: string
  deletable?: boolean
  credentialWarning?: string
  api?: string
  apiKeyEnv?: string
  /** 已经通过 OAuth 登录过：卡片显示登录状态，不再摆密钥输入框。 */
  oauthAuthorized?: boolean
  /** 这个地址是配置里钉着的（baseUrl 字段），不是目录默认值——「一键修正」据此决定要不要连地址一起删。 */
  baseUrlPinned?: boolean
  /** 账号实际可用的模型 id（OAuth 登录时 pi-ai 记下的）。列表按它过滤，选不到用不了的模型。 */
  availableModels?: string[]
  error?: unknown
  fetchedAt?: string
  balances?: BalanceRow[]
  windows?: QuotaWindow[]
}

/** 官方目录服务的 snapshot store；subscribe 契约各版本不一，我们只用 getSnapshot。 */
export interface SnapshotStore {
  getSnapshot?: () => unknown
  subscribe?: () => () => void
}

/** 会话 face 上的模型选择投影 cell。 */
export interface ProjectionCell {
  getSnapshot: () => unknown
  subscribe: () => () => void
}

/** sessions 服务：只用到 binding(sessionId).session.projections.faceOf(...)。 */
export interface SessionsFace {
  binding?: (sessionId: string) => {
    session?: { projections?: { faceOf?: (name: string) => ProjectionCell } }
  }
}

/** /provider/presets 里的一个预置供应商。 */
export interface ProviderPreset {
  id: string
  label: string
  baseURL?: string
  api?: string
  /** 目录里这家出现过的协议（去重）：多协议时路由写死一个必然发错一批。 */
  apis?: string[]
  /** 目录里这家出现过的全部端点（含工厂默认）：用来认出「旧版自动填进配置的目录地址」。 */
  baseUrls?: string[]
  apiKeyEnv?: string
  websiteUrl?: string
  configured?: boolean
  /** 路由在、凭据没值：仍算已配置，但下拉里不该禁选（选中就是去补密钥）。 */
  missingKey?: boolean
  custom?: boolean
  /**
   * OAuth 入口：preset 在 ctx.authorization 里也有 flow 才会有这个字段（来自官方 llm-pi-ai bundle）。
   * 有它就在「添加供应商」表单里多一个 "Sign in with ..." 按钮。
   */
  oauth?: {
    /** 完整 credential key（`<scope>/<provider-id>`），begin() 时回传给宿主。 */
    key: string
    label: string
    methods: { id: string, label: string }[]
    inFlight: boolean
  }
  /**
   * OAuth-only：pi-ai 这个 provider 不接受 apiKey，只走 subscription / OAuth。
   * 客户端就不该给密码输入框 fallback——要么 OAuth 登录成功，要么不可用。
   */
  oauthOnly?: boolean
}

/* ---------------------------- OAuth ---------------------------- */

/** 浏览器侧看一条 OAuth flow：flows 接口与 preset.oauth 同形。 */
export interface OauthMethod {
  id: string
  label: string
}

/** flow 推到浏览器的提示（只读一次，不带 secret）。 */
export interface OauthNotice {
  message: string
  url?: string
  code?: string
}

/** 一个 select 选项。 */
export interface OauthPromptOption {
  id: string
  label: string
  description?: string
}

/** flow 推来的提问：按 kind 决定渲染哪种输入。 */
export type OauthPrompt =
  | { kind: 'text', message: string, placeholder?: string }
  | { kind: 'secret', message: string, placeholder?: string }
  | { kind: 'select', message: string, options: readonly OauthPromptOption[] }

/** SSE 推过来的事件帧：kind 决定后续动作（notice 显示、prompt 弹输入、settled 关弹窗）。 */
export type OauthEvent =
  | { kind: 'notice', notice: OauthNotice }
  | { kind: 'prompt', promptId: string, prompt: OauthPrompt }
  | { kind: 'settled', status: 'authorized' | 'cancelled' | 'failed', error?: string }

/**
 * 一次 OAuth 登录的客户端句柄：连接 SSE、转发 respond / cancel。
 *
 * 注意 `begin` 之后才存在 attempt；列表 / 探查走独立 API（loadOauthFlows）。
 */
export interface OauthAttemptClient {
  attemptId: string
  /** 关掉 SSE 连接（attempt 本身保留，5 分钟内可重连拿 settled 帧）。 */
  close(): void
  /** 用户对 prompt 的答案：服务端按 promptId 找回对应 pending resolver。 */
  respond(promptId: string, value: string): Promise<void>
  /** 主动撤 attempt（用户点「取消」按钮）。 */
  cancel(): Promise<void>
}

/** 「pi-ai 桥接」明细行：piAiBridgeRows 的产出，组件照着渲染。 */
export interface BridgeRow {
  key: string
  text: string
  value?: string
  title?: string
  bad?: boolean
  warn?: boolean
}

/** 卡片头部摘要 chip：窗口余量（label+text+percent）、钱包余额（只有 text）或组间分割线（sep）。 */
export interface HeadlineChip {
  sep?: boolean
  label?: string
  text?: string
  percent?: number | undefined
  reset?: string | undefined
}

/** createElement 里 input/select 的 onChange 事件对象：只读得到 target.value。 */
export interface FieldEvent {
  target: { value: string }
}

/** conversation.input.model 座位的注入面：会话 + 官方目录 store + 两个动作（见 directoryFace）。 */
export interface ModelSwitchSeatProps {
  sessionId: string
  sessions?: SessionsFace | undefined
  directory?: SnapshotStore
  load?: () => unknown
  select?: (selection: ModelSelection) => Promise<boolean>
}

/** 推理等级面板里的一行：Default（effort 为 undefined）或目录声明的某个档位。 */
export interface EffortChoice {
  effort?: string
  label: string
}

/** 添加 provider 面板的注入面。 */
export interface AddProviderPanelProps {
  presets?: unknown
  onAdded?: () => void
  /**
   * 这条路由在配置里钉着的地址（用户自己写的企业版端点之类），没钉返回 undefined。
   */
  addressOf?: (routeId: string) => string | undefined
  /**
   * 这条路由是不是已经在配置里。
   *
   * 已存在时「添加」只能逐字段写：dsh-settings 的 `set` 是整对象覆盖，对已有 route 用它会把
   * 用户手写的 `models` / `compat.thinkingFormat` / `retryPolicy` 一起抹掉（issue #1）。
   */
  existsOf?: (routeId: string) => boolean
}

/** 座位注册表：inject(name, factory) + register(描述符, 组件)。 */
export interface SlotsService {
  inject: (name: string, factory: () => unknown) => unknown
  register: (descriptor: SlotDescriptor, component: unknown) => unknown
}

/** 座位描述符：两个座位用到的字段合集（inject 是「按会话产出注入面」的工厂）。 */
export interface SlotDescriptor {
  name: string
  id: string
  priority?: number
  order?: number
  label?: () => unknown
  inject?: (sessionId: string) => unknown
}

/** 官方 ui-model-selection 的客户端服务：按会话给一个目录。 */
export interface ModelDirectory {
  store: SnapshotStore
  load: () => Promise<unknown>
  select: (selection: ModelSelection) => Promise<unknown>
}

export interface ModelDirectoriesService {
  directoryFor?: (sessionId: string) => ModelDirectory
}

/** /model 命令的一条可选项。 */
export interface CommandOption {
  id: string
  label: string
  detail: string
}

/** 命令回调收到的会话上下文（官方 ClientSessionContext 里我们用到的那一个字段）。 */
export interface CommandSession {
  sessionId?: string
}

export interface CommandContribution {
  name: string
  label: () => string
  description: () => string
  /**
   * 官方契约里的**必填**项（`CommandContribution.available(session): boolean`，没有问号）。
   * 官方的 CommandUiRuntime.candidates() 对注册表里每一条贡献都直接调它，缺了就是 TypeError，
   * 会把整个 `/` 候选列表打挂——所以这里不给可选。
   */
  available: (session: CommandSession | null | undefined) => boolean
  ui: {
    kind: string
    options: (session: CommandSession | null | undefined) => Promise<CommandOption[]>
    onSelect: (option: CommandOption, session: CommandSession | null | undefined) => unknown
  }
}

export interface CommandUiService {
  register: (contribution: CommandContribution) => unknown
}

export interface LocaleService {
  register?: (namespace: string, dict: unknown) => void
  bind?: (namespace: string) => (key: string) => string
}

export interface StylesService {
  insert?: (css: string) => unknown
}

/** 客户端插件上下文：只声明我们 inject 到的那几样（其余走索引签名）。 */
export interface ClientContext {
  slots: SlotsService
  inject: (names: readonly string[], callback: (scope: ClientScope) => void) => void
  effect: (fn: () => unknown, label?: string) => void
  locale?: LocaleService
  styles?: StylesService
  sessions?: unknown
  [key: string]: unknown
}

/** inject 面里认得出的服务（谁 inject 谁才有）。 */
export interface ClientScope extends ClientContext {
  modelDirectories?: ModelDirectoriesService
  commandUi?: CommandUiService
}
