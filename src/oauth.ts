/**
 * OAuth / device-code 登录桥：把宿主 `ctx.authorization` 服务暴露给浏览器端。
 *
 * 宿主已经有完整的 flow 注册（来自官方 llm-pi-ai bundle 的 `registerPiAiFlows`，覆盖 31 个
 * api-key + 6 个 subscription + Codex-only-OAuth），但官方没有把 notice/prompt 推给浏览器的
 * wire（见 reference/dsh-src/.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md
 * "尚未包含的是界面"那段）。本模块补这一段：五条 HTTP 路由把 begin/notify/prompt/respond/cancel
 * 接出去，浏览器通过 EventSource 拿到实时事件，POST respond 把答案送回去。
 *
 * 设计要点：
 *   - attempt 由 begin() 一次性创建并立刻返回 attemptId；flow 跑在后台，不阻塞 begin 响应。
 *   - attempt 状态全部在内存里（attemptId → Attempt），不持久化：刷新页面会丢，
 *     与 dsh-authorization 的"attempt 不可持久"约束对齐（包 README 明文）。
 *   - 浏览器↔flow 走 SSE（Content-Type: text/event-stream）；event bus 用 Node EventEmitter。
 *   - prompt 响应把 attempt 闭锁续到用户点击；同一 attempt 的 prompt 一个接一个关。
 *   - sweep 每分钟清理 5 分钟没活动的 attempt，避免客户端断开后内存泄漏。
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { hostPackageEntry } from './bridge.js'
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
  type Logger,
  type PluginContext,
  type ServerRequest,
  type ServerResponse,
  type WebServerService,
} from './types.js'

/** 5 分钟未活动 → sweep 干掉 attempt。refresh 页面、问句早关都是这条路径。 */
const ATTEMPT_TTL_MS = 5 * 60 * 1000

/** sweep 周期：60 秒一次。不 unref() 会拦 dsh 关停。 */
const SWEEP_INTERVAL_MS = 60_000

/** 推给浏览器的事件帧。kind 决定渲染路径：notice = 提示，prompt = 提问（要 respond），settled = 结束。 */
export type OAuthAttemptEvent =
  | { kind: 'notice', notice: AuthorizationNotice }
  | { kind: 'prompt', promptId: string, prompt: AuthorizationPrompt }
  | { kind: 'settled', status: 'authorized' | 'cancelled' | 'failed', error?: string }

/** 一条 flow 的 interaction 闭包：pendingPrompts 持有 prompt 的 resolver，browser respond 时取出来。 */
interface PendingPrompt {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

/** 一个 attempt 的全部状态。 */
interface OAuthAttempt {
  id: string
  key: string
  method: string
  controller: AbortController
  bus: EventEmitter
  pendingPrompts: Map<string, PendingPrompt>
  settled: undefined | { status: 'authorized' | 'cancelled' | 'failed', error?: string }
  createdAt: number
  /**
   * 已经推给总线的全部事件（含 settled）。SSE 连上来时先回放这一段再挂监听。
   *
   * **为什么必须有**：浏览器是「先 POST begin 拿 attemptId、再开 EventSource」两步，
   * 而 flow 的第一步（比如 Copilot 问企业域名）往往在两步之间就 emit 了。没有回放时
   * 那条 prompt 永远到不了界面，弹窗就停在「已在登录…」。页面中途刷新重连同理。
   */
  events: OAuthAttemptEvent[]
}

const attempts = new Map<string, OAuthAttempt>()

/** 同一个 key 同时只允许一个 attempt。seam 本身也会拒（ALREADY_IN_FLIGHT），我们这里只是先发制人。 */
const keyToAttempt = new Map<string, string>()

/** 供 src/oauth-test-hooks.ts 读取的私有池；production 不引用（见文件末尾的说明段）。 */
export { attempts, keyToAttempt }

/**
 * 把 attempt 状态推给事件总线（bus）。SSE handler 监听这一条把帧写到 socket。
 * 幂等：bus 已 emit 过同一事件的，attempts 已 settled 时不再 emit。
 */
function push(attempt: OAuthAttempt, event: OAuthAttemptEvent): void {
  attempt.events.push(event)
  attempt.bus.emit('event', event)
}

/**
 * 给 attempt 一个终局：写 settled、把还在等的 prompt 都 reject 掉、发 settled 帧、关事件总线。
 * 同一 attempt 多次 settle 是 no-op（seam 上层不会重发，promise settle 后我们也不再动）。
 */
function settle(attempt: OAuthAttempt, status: 'authorized' | 'cancelled' | 'failed', error?: string): void {
  if (attempt.settled !== undefined) return
  attempt.settled = { status, error }
  for (const [promptId, pending] of attempt.pendingPrompts) {
    pending.reject(new Error(`attempt 已结算（${status}${error === undefined ? '' : '：' + error}）`))
    attempt.pendingPrompts.delete(promptId)
  }
  push(attempt, { kind: 'settled', status, error })
  attempt.bus.emit('closed')
}

/** 构建 AuthorizationInteraction：notify 直接转发，prompt 推到 bus 上等浏览器 respond。 */
function interactionOf(attempt: OAuthAttempt): AuthorizationInteraction {
  return {
    notify(notice: AuthorizationNotice): void {
      push(attempt, { kind: 'notice', notice })
    },
    async prompt(prompt: AuthorizationPrompt): Promise<string> {
      // signal：flow 端撤回本条 prompt（保留 attempt）。signal 一旦 abort，pending 不 resolve，
      // 但下面 await 拿到的 promise 会转 reject，由 seam / dsh prompt 类型保证。
      const promptId = randomUUID()
      return await new Promise<string>((resolve, reject) => {
        const onAbort = (): void => {
          attempt.pendingPrompts.delete(promptId)
          reject(new Error('prompt 已被撤回'))
        }
        if (prompt.signal?.aborted === true) {
          onAbort()
          return
        }
        attempt.pendingPrompts.set(promptId, { resolve, reject })
        prompt.signal?.addEventListener('abort', onAbort, { once: true })
        push(attempt, { kind: 'prompt', promptId, prompt })
      })
    },
  }
}

/** 拿到宿主 authorization 服务（不直引它的类型，按 dsh 暴露的形状就地取）。 */
function authorizationOf(ctx: PluginContext): AuthorizationService | undefined {
  // 只走 ctx.get：cordis 严格模式下 `ctx.authorization` 这种属性访问要求 inject 列表里
  // 声明 'authorization'。本插件 inject 列表只有 ['llm', 'webServer']——任何 dsh 组合
  // （含 credentials 包未装的 headless）都不会引这一行；services 找不到就当 undefined，
  // registerOAuthRoutes 早期 return，**不会**让插件加载失败。
  //
  // 老代码用 `ctx.get?.(name) ?? ctx[name]` 做兜底，属性访问在 cordis proxy 下抛
  // "cannot get property \"authorization\" without inject"，把整个插件挂掉——见
  // /tmp/dsh-plan-test.log 那次挂掉日志。换成纯 ctx.get + try/catch 即可。
  try {
    const candidate = ctx.get?.('authorization')
    if (candidate === null || typeof candidate !== 'object') return undefined
    return candidate as AuthorizationService
  } catch (cause) {
    // ctx.get 抛错（dsh 内部 mock / 反序列化异常）——同属性访问一样的处理：当作未挂载。
    return undefined
  }
}

/** 加载一个宿主服务插件（默认走 {@link hostPackageEntry} 找宿主那一份）。测试可注入替身。 */
export type HostServiceLoader = (specifier: string) => Promise<unknown>

const loadHostService: HostServiceLoader = async (specifier: string) => {
  const entry = hostPackageEntry(specifier)
  if (entry === undefined) throw new Error(`宿主安装树里找不到 ${specifier}`)
  return await import(pathToFileURL(entry).href)
}

/**
 * 确保 `ctx.authorization` 在场：缺席就自己把宿主的 authorization seam 挂上。
 *
 * **为什么插件要做这件事**：原版 dsh 的两个 bundle（`dsh-base` 86 行、`dsh-web-app` 70 行）
 * 都没有挂 `@deepseek-ai/dsh-authorization`——凭据侧只挂了 `dsh-credentials-local`。于是
 * 官方 `llm-pi-ai` 里那句 `ctx.inject(['authorization'], …)` 从不触发、`registerPiAiFlows`
 * 一次都不跑，OAuth flow 一个都没有：界面上的 OAuth 入口自然也就不存在。挂上这个服务之后
 * 那段 inject 会按 cordis 的依赖响应式地跑起来，全部 catalog provider 的登录方式自动就位。
 *
 * 安全性：服务缺席时挂、在场时不动；拿不到包、加载失败、`ctx.plugin` 不可用都只降级成
 * 「没有 OAuth 入口」，绝不抛出去——插件加载失败会让整个 dsh 起不来（踩过一次）。
 *
 * @param ctx - 插件上下文（要能取到 authorization 与 plugin 两个面）。
 * @param logger - 宿主日志器，记录挂载结果。
 * @param load - 宿主服务加载器；默认 {@link loadHostService}，测试注入替身。
 */
export async function ensureAuthorizationService(
  ctx: PluginContext,
  logger: Logger | undefined,
  load: HostServiceLoader = loadHostService,
): Promise<void> {
  if (authorizationOf(ctx) !== undefined) return
  const mount = ctx.plugin
  if (typeof mount !== 'function') {
    logger?.warn?.('宿主没有 ctx.plugin，authorization 服务无法挂载；OAuth 登录入口不可用')
    return
  }
  try {
    const mod = await load('@deepseek-ai/dsh-authorization')
    const service = asRecord(mod)['default'] ?? mod
    // 服务类经 ctx.plugin 挂进当前 fiber；cordis 的服务注册写在 root 的 store 上，
    // 所以 llm-pi-ai 那边的 inject 也能看到它。
    await mount.call(ctx, service)
    logger?.info?.('已挂载 @deepseek-ai/dsh-authorization（原版 profile 没有这一行）')
  } catch (error) {
    logger?.warn?.(
      `authorization 服务挂载失败，OAuth 登录入口不显示：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 从 flow 的凭据记录 key 列表里找出某个 provider 的 key。
 *
 * 记录的键是 `<scope>/<provider-id>`，scope 是拥有这条 flow 的插件名（现在是 `llm-pi-ai`）。
 * 按「最后一个斜杠之后」比对，所以 scope 改名（官方换插件名）也照样对得上。
 * @param keys - `authorization.list()` 里各条 flow 的 key。
 * @param providerId - 路由 id（`github-copilot` 这种）。
 * @returns 匹配到的记录 key；没有返回 undefined。
 */
export function flowKeyForProvider(keys: readonly string[], providerId: string): string | undefined {
  for (const key of keys) {
    const slash = key.lastIndexOf('/')
    const id = slash < 0 ? key : key.slice(slash + 1)
    if (id === providerId) return key
  }
  return undefined
}

/**
 * 按请求解析 authorization 服务；不在就回 503 JSON 并返回 undefined。
 *
 * **为什么按请求解析而不是注册时解析一次**：`ctx.get()` 默认是 strict 的——提供服务的那条
 * fiber 没到 active 状态就返回 undefined。`ensureAuthorizationService()` 刚把服务挂上时，
 * 子 fiber 还在加载，此刻读就是 undefined；注册时读一次会把五条路由全部跳掉（实测：挂载成功、
 * flows 39 条，但 /provider/oauth/begin 落到 SPA fallback 回 405 空 body，浏览器端表现为
 * "Unexpected end of JSON input"）。按请求读没有这个竞态。
 */
function requireAuthorization(
  ctx: PluginContext,
  res: ServerResponse,
): AuthorizationService | undefined {
  const service = authorizationOf(ctx)
  if (service === undefined) {
    jsonResponse(res, 503, { ok: false, error: '宿主 authorization 服务暂不可用（OAuth 登录暂时不可用）' })
    return undefined
  }
  return service
}

/** SSE 帧编码：data: <json>\n\n；retry 在第一帧发，告诉 EventSource 多久后重连。 */
function sseFrame(event: OAuthAttemptEvent | 'retry'): string {
  if (event === 'retry') return 'retry: 10000\n\n'
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * GET /provider/oauth/stream?attemptId=<id> —— SSE 流，推 notice / prompt 等事件。
 *
 * **连上先回放 attempt.events，再挂实时监听**：浏览器分两步（POST begin 拿 id → 开
 * EventSource），flow 的第一个 prompt 常常在两步之间就 emit 了，不回放的话它永远到不了界面
 * （弹窗停在「已在登录…」）。已 settled 的 attempt 回放完直接 end。
 */
function streamHandler(logger: Logger | undefined): (req: ServerRequest, res: ServerResponse) => void {
  return (req, res) => {
    const query = readString(asRecord(parseQuery(req.url))['attemptId'])
    if (query === undefined) {
      res.writeHead(400)
      res.end()
      return
    }
    const attempt = attempts.get(query)
    if (attempt === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    res.write(sseFrame('retry'))
    // 回放：先挂监听再回放，否则回放期间新到的事件会漏掉（两次 emit 之间没有 await，
    // 但 res.write 可能触发 backpressure 的回调边界，宁可把顺序写死）。
    const buffered = attempt.events.slice()
    const onEvent = (event: OAuthAttemptEvent): void => {
      try { res.write(sseFrame(event)) } catch { /* socket closed mid-write */ }
    }
    if (attempt.settled !== undefined) {
      for (const event of buffered) onEvent(event)
      res.end()
      return
    }
    attempt.bus.on('event', onEvent)
    for (const event of buffered) onEvent(event)
    const onClosed = (): void => {
      try { res.end() } catch { /* already ended */ }
    }
    attempt.bus.once('closed', onClosed)
    // 浏览器断网 / 关页：清掉 listener，别再往死 socket 写。**不**撤 attempt——
    // 用户可能只是切到另一个窗口看 device code，回来了继续。
    const cleanup = (): void => {
      attempt.bus.off('event', onEvent)
      attempt.bus.off('closed', onClosed)
    }
    req.on('end', cleanup)
    req.on('close', cleanup)
  }
}

/**
 * 起一个 attempt：创建状态、注册 interaction、后台跑 begin()。
 *
 * 流：
 *   1. 检查同 key 是否已有 attempt：有就 409。
 *   2. 写 attempt 入 maps，立即返回 attemptId。
 *   3. 后台 `authorization.begin({ key, method, interaction, signal })`：success → settle 'authorized'，
 *      catch：controller.signal.aborted → 'cancelled'，否则 → 'failed'。
 *
 * 错误时 attempt 仍写到 maps（前端可以 stream 拿到 settled），begin 响应只放尝试开始这一步的成功/失败。
 */
function beginHandler(
  ctx: PluginContext,
): (req: ServerRequest, res: ServerResponse) => void {
  return (req, res) => {
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
          const authorization = requireAuthorization(ctx, res)
          if (authorization === undefined) return
          const parsed = asRecord(JSON.parse(body === '' ? '{}' : body))
          const key = readString(parsed['key'])
          const method = readString(parsed['method'])
          if (key === undefined) {
            jsonResponse(res, 400, { ok: false, error: '缺少 key' })
            return
          }
          if (typeof authorization.begin !== 'function') {
            jsonResponse(res, 503, { ok: false, error: '宿主 authorization 服务不提供 begin()' })
            return
          }
          // 同 key 已有 attempt：**复用**它，而不是回 409。
          // 界面刷新、弹窗被关掉、切了个标签页都会让浏览器丢掉 attemptId，而 attempt 还在
          // 宿主里pending（等用户回答 prompt）。这时回 409 等于把用户锁在外面五分钟；
          // 复用则是「接着上一次继续」——SSE 会回放已经发生的事件，弹窗一开就是当前状态。
          const fresh = parsed['fresh'] === true
          const existingId = keyToAttempt.get(key)
          const existing = existingId === undefined ? undefined : attempts.get(existingId)
          // fresh：调用方明确要求「重走一遍流程」（比如用户从 github.com 切到 GitHub Enterprise），
          // 那就先撤掉在跑的那个再建新的，不能复用——复用会让流程停在已经答过的域名上。
          if (fresh && existing !== undefined && existing.settled === undefined) {
            existing.controller.abort()
            settle(existing, 'cancelled', '被新的登录尝试取代')
            keyToAttempt.delete(key)
          }
          if (!fresh && existing !== undefined && existing.settled === undefined) {
            jsonResponse(res, 200, {
              ok: true,
              attemptId: existing.id,
              method: existing.method,
              reused: true,
            })
            return
          }
          // 先问 dsh 拿一个 entry；begin 不存在的 key 它会抛 NO_FLOW，错误信息更准。
          const entry = typeof authorization.describe === 'function' ? authorization.describe(key) : undefined
          if (entry === undefined) {
            jsonResponse(res, 404, { ok: false, error: `没有为 ${key} 注册的 OAuth flow` })
            return
          }
          const chosen = method === undefined
            ? (entry.methods[0]?.id)
            : (entry.methods.find((m) => m.id === method)?.id ?? method)
          const attempt: OAuthAttempt = {
            id: randomUUID(),
            key,
            method: chosen,
            controller: new AbortController(),
            bus: new EventEmitter(),
            pendingPrompts: new Map(),
            settled: undefined,
            events: [],
            createdAt: Date.now(),
          }
          attempts.set(attempt.id, attempt)
          keyToAttempt.set(key, attempt.id)
          jsonResponse(res, 200, { ok: true, attemptId: attempt.id, method: chosen, methods: entry.methods, reused: false })
          // 后台开跑。**不要 await** —— respond 已经在上面发了，再 await 会卡住下一次 req。
          runAttempt(ctx, authorization, attempt).catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            settle(attempt, 'failed', message)
          })
        } catch (error) {
          jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
  }
}

/** attempt 后台主体：调 begin、settle、清掉 maps。runAttempt 由 beginHandler 调。 */
async function runAttempt(
  ctx: PluginContext,
  authorization: AuthorizationService,
  attempt: OAuthAttempt,
): Promise<void> {
  const logger = ctx.logger
  try {
    const outcome = await authorization.begin!({
      key: attempt.key,
      method: attempt.method,
      interaction: interactionOf(attempt),
      signal: attempt.controller.signal,
    })
    settle(attempt, outcome.status)
  } catch (cause) {
    const cancelled = attempt.controller.signal.aborted
    const message = cause instanceof Error ? cause.message : String(cause)
    if (typeof logger === 'function') {
      const log = logger('provider')
      log[cancelled ? 'info' : 'warn']?.(
        `${cancelled ? 'cancelled' : 'failed'}: ${attempt.key} — ${message}`,
      )
    }
    settle(attempt, cancelled ? 'cancelled' : 'failed', message)
  } finally {
    // 让 begin 的下一次请求可以重开 attempt；不清 EventEmitter 引用会随 attempt 一起被 GC。
    keyToAttempt.delete(attempt.key)
    // settled 已写，attempts 留给 SSE handler 追一条 settled 帧用：通常 SSE 会立刻看到 closed，
    // 5 分钟 TTL 后 sweep 会把 attempts 里这条删掉。保留到 TTL 是为了浏览器刷新页面能拿到结论。
  }
}

/** POST /provider/oauth/respond body { attemptId, promptId, value } —— 浏览器对 prompt 的回应。 */
function respondHandler(): (req: ServerRequest, res: ServerResponse) => void {
  return (req, res) => {
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
          const attemptId = readString(parsed['attemptId'])
          const promptId = readString(parsed['promptId'])
          // 空字符串是**合法答案**，不能用 readString（它把 '' 当没传）：Copilot 的第一个
          // prompt 就是「GitHub Enterprise URL/domain（blank for github.com）」。
          const rawValue = parsed['value']
          if (attemptId === undefined || promptId === undefined || typeof rawValue !== 'string') {
            jsonResponse(res, 400, { ok: false, error: '缺少 attemptId / promptId / value' })
            return
          }
          const value = rawValue
          const attempt = attempts.get(attemptId)
          if (attempt === undefined) {
            jsonResponse(res, 404, { ok: false, error: `attempt 不存在或已结束` })
            return
          }
          const pending = attempt.pendingPrompts.get(promptId)
          if (pending === undefined) {
            jsonResponse(res, 409, { ok: false, error: 'prompt 不在等待中（已结算 / 已撤回）' })
            return
          }
          attempt.pendingPrompts.delete(promptId)
          pending.resolve(value)
          jsonResponse(res, 200, { ok: true })
        } catch (error) {
          jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
  }
}

/** POST /provider/oauth/cancel body { attemptId } —— 浏览器点「取消」撤 attempt。 */
function cancelHandler(
  ctx: PluginContext,
): (req: ServerRequest, res: ServerResponse) => void {
  return (req, res) => {
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
          // cancel 只在服务在时有意义；不在就按「attempt 撤销失败」告诉调用方，别假装成功。
          const authorization = requireAuthorization(ctx, res)
          if (authorization === undefined) return
          const parsed = asRecord(JSON.parse(body === '' ? '{}' : body))
          const attemptId = readString(parsed['attemptId'])
          if (attemptId === undefined) {
            jsonResponse(res, 400, { ok: false, error: '缺少 attemptId' })
            return
          }
          const attempt = attempts.get(attemptId)
          if (attempt === undefined) {
            jsonResponse(res, 404, { ok: false, error: `attempt 不存在` })
            return
          }
          if (attempt.settled !== undefined) {
            jsonResponse(res, 200, { ok: true, already: attempt.settled.status })
            return
          }
          // 优先走 authorization.cancel(key)：seam 主动清掉 in-flight slot，比单纯 abort signal 更干净。
          if (typeof authorization.cancel === 'function') {
            try { authorization.cancel(attempt.key) } catch { /* fallback 到 abort */ }
          }
          attempt.controller.abort()
          jsonResponse(res, 200, { ok: true })
        } catch (error) {
          jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
  }
}

/** GET /provider/oauth/flows —— 列所有已注册的 flow，浏览器勾选 OAuth provider 用。 */
function listHandler(ctx: PluginContext): (req: ServerRequest, res: ServerResponse) => void {
  return (_req, res) => {
    try {
      const authorization = requireAuthorization(ctx, res)
      if (authorization === undefined) return
      const list: readonly AuthorizationEntry[] = typeof authorization.list === 'function'
        ? authorization.list()
        : []
      const flows = list.map((entry) => ({
        key: entry.key,
        label: entry.label,
        methods: entry.methods,
        inFlight: entry.inFlight,
      }))
      jsonResponse(res, 200, { ok: true, flows })
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** 简化的 URL query 解析：只要 attemptId 这一项，其它不要。 */
function parseQuery(url: string | undefined): AnyRecord {
  if (typeof url !== 'string') return {}
  const qIndex = url.indexOf('?')
  if (qIndex < 0) return {}
  const search = url.slice(qIndex + 1)
  const out: AnyRecord = {}
  for (const segment of search.split('&')) {
    if (segment === '') continue
    const eq = segment.indexOf('=')
    if (eq < 0) out[decodeURIComponent(segment)] = ''
    else out[decodeURIComponent(segment.slice(0, eq))] = decodeURIComponent(segment.slice(eq + 1))
  }
  return out
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent !== true) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  }
  res.end(JSON.stringify(body))
}

/* ------------------------------------------------------------------ *
 * 测试钩住在 src/oauth-test-hooks.ts（它作为独立的 tsdown entry 转译，见 tsdown.config.ts）。
 * 这里只把两个私有池给它用——**不被 production 代码引用**，两个 export 存在的意义就是把
 * attempt 池喂给那个文件；任何 production 用法都是误用。
 * ------------------------------------------------------------------ */

/**
 * 注册全部 OAuth 路由。
 *
 * **五条路由无条件注册**，authorization 服务由各 handler 按请求解析（见
 * {@link requireAuthorization}）：注册时读一次会被 ctx.get 的 strict 语义坑到——服务刚挂上、
 * fiber 还没 active，读出来是 undefined，五条路由就全没了。服务真不在时 handler 回 503 JSON，
 * 客户端能显示出原因，而不是让请求落到 SPA fallback 拿一个空 body。
 *
 * @param ctx - 插件上下文，用来读 authorization 与 logger。
 * @param webServer - 宿主 webserver 服务，路由挂在它上面。
 */
export function registerOAuthRoutes(ctx: PluginContext, webServer: WebServerService): void {
  const logger = ctx.logger
  const log = typeof logger === 'function' ? logger('provider') : undefined
  // 这里**不**报告服务在不在：本函数在 apply 里排在补服务之前（见 index.ts 的顺序注释），
  // 此刻读不到是常态，报了就是每次都误报。真正的判据在 /provider/status 的 oauth 段。
  // sweep 周期清理 TTL 到期的 attempt，不阻塞 dsh 关停。
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ATTEMPT_TTL_MS
    for (const [id, attempt] of attempts) {
      if (attempt.createdAt < cutoff) {
        attempt.controller.abort()
        if (attempt.settled === undefined) settle(attempt, 'cancelled', 'attempt 超时未活动')
        attempts.delete(id)
      }
    }
  }, SWEEP_INTERVAL_MS)
  sweeper.unref?.()

  webServer.register({ kind: 'exact', path: '/provider/oauth/flows', handler: listHandler(ctx) })
  webServer.register({ kind: 'exact', path: '/provider/oauth/begin', handler: beginHandler(ctx) })
  webServer.register({ kind: 'exact', path: '/provider/oauth/stream', handler: streamHandler(log) })
  webServer.register({ kind: 'exact', path: '/provider/oauth/respond', handler: respondHandler() })
  webServer.register({ kind: 'exact', path: '/provider/oauth/cancel', handler: cancelHandler(ctx) })
  log?.info?.('oauth 路由已挂载（flows / begin / stream / respond / cancel）')
}