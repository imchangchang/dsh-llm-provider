/**
 * OAuth 路由的离线测试。
 *
 *   node test/oauth.mjs
 *
 * 模拟宿主授权服务（`ctx.authorization`）与 webServer.register，把 5 条路由摘下来
 * 直接调，验证 begin / respond / cancel / stream 的事件流符合预期。
 *
 * 测试钩（`__oauth_attempt` / `__oauth_reset` / `__oauth_attempt_count`）从
 * /lib/oauth-test-hooks.js 取——那个文件是独立 tsdown entry，见 tsdown.config.ts 的说明。
 */
import { ensureAuthorizationService, flowKeyForProvider, registerOAuthRoutes } from '../lib/oauth.js'
import { hostPackageEntry } from '../lib/bridge.js'
import { __oauth_attempt, __oauth_attempt_count, __oauth_reset } from '../lib/oauth-test-hooks.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) {
    console.log('  期望:', JSON.stringify(expected))
    console.log('  实际:', JSON.stringify(actual))
    failed = true
  }
}
function checkTruthy(name, actual) {
  const ok = Boolean(actual)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) {
    console.log('  实际:', JSON.stringify(actual))
    failed = true
  }
}

function makeWebServer() {
  const handlers = new Map()
  const exact = new Map()
  return {
    exact,
    // 与宿主 dsh-host-webserver 同形：同名 exact 路由重复注册直接抛
    register(route) {
      if (exact.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      exact.set(route.path, route)
      handlers.set(route.path, route.handler)
      return () => {
        exact.delete(route.path)
        handlers.delete(route.path)
      }
    },
    handlers,
  }
}

function makeCtx(flows) {
  const authorization = {
    list: () => flows.map((f) => ({ key: f.key, label: f.label, methods: f.methods, inFlight: false })),
    describe: (key) => {
      const f = flows.find((x) => x.key === key)
      return f === undefined ? undefined : { ...f, inFlight: false }
    },
    begin: undefined,  // 每个测试自己替换
    cancel: () => {},
  }
  const effects = []
  const ctx = {
    get: (name) => (name === 'authorization' ? authorization : undefined),
    authorization: authorization,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    // 宿主 cordis 的 effect：回调立刻执行、返回的 disposer 在 fiber 销毁时调用
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    effects,
  }
  return { ctx, authorization, effects }
}

/** IncomingMessage-like：handlers 用 `data`/`end` 阶段读 body。 */
function makeReq(method, url, body) {
  const listeners = new Map()
  const req = { method, url, on(event, listener) { listeners.set(event, listener) } }
  if (body !== undefined) {
    setImmediate(() => {
      const dataListener = listeners.get('data')
      const endListener = listeners.get('end')
      if (typeof dataListener === 'function') dataListener(body)
      if (typeof endListener === 'function') endListener()
    })
  }
  return req
}

function makeRes() {
  const res = {
    status: 0,
    headers: undefined,
    body: '',
    written: [],
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) { this.written.push(String(chunk)) },
    end(body) {
      this.ended = true
      if (typeof body === 'string') this.body = body
    },
    sseEvents() {
      const events = []
      for (const chunk of this.written) {
        if (chunk.indexOf('data:') !== 0) continue
        const rest = chunk.slice(5).trim()
        if (rest === '') continue
        try { events.push(JSON.parse(rest)) } catch (cause) { /* skip */ }
      }
      return events
    },
  }
  return res
}

/** 等 settle 帧出现在 stream 上 —— 简单 polling，最大 200ms。 */
function waitForSettled(streamRes, status, timeoutMs = 200) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function check() {
      const events = streamRes.sseEvents()
      const settled = events.find((e) => e.kind === 'settled' && (status === undefined || e.status === status))
      if (settled !== undefined) return resolve(settled)
      if (Date.now() > deadline) return reject(new Error('等 settled 超时'))
      setTimeout(check, 10)
    }
    check()
  })
}

/** helper: 调 JSON handler */
function callJson(handlers, path, body) {
  const handler = handlers.get(path)
  if (typeof handler !== 'function') throw new Error(`未注册的 handler：${path}`)
  return new Promise((resolve) => {
    const res = makeRes()
    handler(makeReq('POST', path, JSON.stringify(body)), res)
    setImmediate(() => {
      const body = res.body === '' ? undefined : JSON.parse(res.body)
      resolve({ status: res.status, body })
    })
  })
}

/** helper: 开 stream — 不阻塞返回，由 waitForSettled 等事件 */
function openStream(handlers, attemptId) {
  const handler = handlers.get('/provider/oauth/stream')
  if (typeof handler !== 'function') throw new Error('stream 未注册')
  const res = makeRes()
  handler(makeReq('GET', '/provider/oauth/stream?attemptId=' + encodeURIComponent(attemptId)), res)
  return res
}

const FLOW_LIST = [
  { key: 'dsh-llm-pi-ai/github-copilot', label: 'GitHub Copilot', methods: [{ id: 'oauth', label: 'Sign in with GitHub' }] },
  { key: 'dsh-llm-pi-ai/openai-codex', label: 'OpenAI Codex', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }] },
]

/* ----------------------------- Test 1 ----------------------------- */
/* begin → 立刻拿到 attemptId；flow 直接 resolve 'authorized'；stream 应在 settled 后 end */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  authorization.begin = function () { return Promise.resolve({ status: 'authorized' }) }

  const beginRes = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  check('T1.begin.ok', beginRes.body.ok, true)
  checkTruthy('T1.attemptId 字符串', typeof beginRes.body.attemptId === 'string')
  check('T1.method 默认第一个', beginRes.body.method, 'oauth')

  // settled 后 stream 拿 settled 帧
  const streamRes = openStream(webServer.handlers, beginRes.body.attemptId)
  const settled = await waitForSettled(streamRes, 'authorized')
  check('T1.settled.status', settled.status, 'authorized')
  checkTruthy('T1.stream.end', streamRes.ended)
})()

/* ----------------------------- Test 2 ----------------------------- */
/* flow 推 notice + prompt，浏览器 respond 推答案 → prompt 进 signal；UI 应能拿到 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)

  // script：notify → prompt(text) → 等待 respond → notify(2) → 不主动 settle（用 cancel 收尾）
  // setImmediate 包一层模拟真 flow 的异步推送：保证 stream handler 先装 listener。
  // abort 后 resolve cancelled——模拟 dsh seam 收到 abort 后的行为。
  authorization.begin = function (request) {
    return new Promise(function (resolve) {
      setImmediate(function () {
        request.interaction.notify({ message: '在浏览器打开', url: 'https://example.com/device', code: 'ABCD-1234' })
        request.interaction.prompt({ kind: 'text', message: '请输入用户名' }).then(function (name) {
          request.interaction.notify({ message: '欢迎，' + name })
        })
        request.signal.addEventListener('abort', function () { resolve({ status: 'cancelled' }) })
      })
    })
  }

  const beginRes = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[1].key })
  check('T2.begin.ok', beginRes.body.ok, true)
  const attemptId = beginRes.body.attemptId

  const streamRes = openStream(webServer.handlers, attemptId)
  // 等 notice + prompt 帧都进 stream
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 200
    function check() {
      const events = streamRes.sseEvents()
      const hasNotice = events.some((e) => e.kind === 'notice' && e.notice.url === 'https://example.com/device')
      const hasPrompt = events.some((e) => e.kind === 'prompt' && e.prompt.kind === 'text')
      if (hasNotice && hasPrompt) return resolve()
      if (Date.now() > deadline) return reject(new Error('等 notice+prompt 超时'))
      setTimeout(check, 10)
    }
    check()
  })

  const events = streamRes.sseEvents()
  const firstPrompt = events.find((e) => e.kind === 'prompt')
  const firstNotice = events.find((e) => e.kind === 'notice')
  check('T2.notice.url', firstNotice.notice.url, 'https://example.com/device')
  check('T2.notice.code', firstNotice.notice.code, 'ABCD-1234')
  check('T2.prompt.kind', firstPrompt.prompt.kind, 'text')

  // respond
  const resp = await callJson(webServer.handlers, '/provider/oauth/respond', {
    attemptId: attemptId,
    promptId: firstPrompt.promptId,
    value: 'Alice',
  })
  check('T2.respond.ok', resp.body.ok, true)

  // 等 notice(2) 进 stream
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 200
    function check() {
      const evs = streamRes.sseEvents()
      if (evs.filter((e) => e.kind === 'notice').length >= 2) return resolve()
      if (Date.now() > deadline) return reject(new Error('等第二个 notice 超时'))
      setTimeout(check, 10)
    }
    check()
  })
  const secondNotice = streamRes.sseEvents().filter((e) => e.kind === 'notice')[1]
  check('T2.notice(2) 含用户名', secondNotice.notice.message, '欢迎，Alice')

  // 收尾 cancel
  const cancelRes = await callJson(webServer.handlers, '/provider/oauth/cancel', { attemptId: attemptId })
  check('T2.cancel.ok', cancelRes.body.ok, true)
  const settled = await waitForSettled(streamRes, 'cancelled')
  check('T2.settled.cancelled', settled.status, 'cancelled')
  const attempt = __oauth_attempt(attemptId)
  check('T2.attempt.settled.cancelled', attempt.settled.status, 'cancelled')
})()

/* ----------------------------- Test 3 ----------------------------- */
/* cancel 走 controller.abort → attempt.settled = cancelled；seam 的 abort 路径 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)

  // script：abort 后模拟 seam 抛 / resolve cancelled 都行；这里 begin() 永远不主动 settle
  authorization.begin = function (request) {
    return new Promise(function (resolve) {
      setImmediate(function () {
        request.signal.addEventListener('abort', function () { resolve({ status: 'cancelled' }) })
      })
    })
  }

  const beginRes = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  const attemptId = beginRes.body.attemptId
  await callJson(webServer.handlers, '/provider/oauth/cancel', { attemptId: attemptId })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const attempt = __oauth_attempt(attemptId)
  check('T3.attempt.settled.cancelled', attempt.settled.status, 'cancelled')
})()

/* ----------------------------- Test 4 ----------------------------- */
/* 同 key 第二次 begin → **复用**在跑的那个 attempt（不是 409）。
 * 界面刷新 / 关弹窗会丢掉 attemptId，而宿主里的 attempt 还在等用户回答；回 409 等于把用户
 * 锁在外面，复用才是「接着上次继续」。 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  authorization.begin = function () { return new Promise(function () {}) }  // 永不结束

  const a = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  const b = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  check('T4.a.ok', a.body.ok, true)
  check('T4.a 不是复用', a.body.reused, false)
  check('T4.b.ok=true', b.body.ok, true)
  check('T4.b 标成复用', b.body.reused, true)
  check('T4.b 复用同一个 attemptId', b.body.attemptId, a.body.attemptId)
  check('T4.b 带回 method', b.body.method, 'oauth')
})()

/* ----------------------------- Test 5 ----------------------------- */
/* GET flows → 列出全部 mock flow */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  const handler = webServer.handlers.get('/provider/oauth/flows')
  const res = makeRes()
  handler(makeReq('GET', '/provider/oauth/flows', undefined), res)
  await new Promise((resolve) => setImmediate(resolve))
  const body = JSON.parse(res.body)
  check('T5.flows.ok', body.ok, true)
  check('T5.flows.length', body.flows.length, 2)
  check('T5.flows[0].key', body.flows[0].key, FLOW_LIST[0].key)
  check('T5.flows[1].methods[0].id', body.flows[1].methods[0].id, 'oauth')
})()

/* ----------------------------- Test 6 ----------------------------- */
/* 未知 key → begin 回 404；不存在 flow */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  authorization.begin = function () { return Promise.reject(new Error('NO_FLOW')) }
  const r = await callJson(webServer.handlers, '/provider/oauth/begin', { key: 'unknown/key' })
  check('T6.unknown.ok=false', r.body.ok, false)
})()

/* ----------------------------- Test 7 ----------------------------- */
/* 回归：cordis 严格模式下 ctx.get('authorization') 抛错（真实日志 `cannot get property
 * "authorization" without inject`）时 registerOAuthRoutes 不能把插件带崩。
 * 五条路由照挂，handler 回 503 JSON——**不能**不挂路由：那会让请求落到 SPA fallback，
 * 客户端拿到空 body，报的是 "Unexpected end of JSON input"（实测踩过）。 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const ctx = {
    get: (name) => {
      if (name === 'authorization') throw new Error('cannot get property "authorization" without inject')
      return undefined
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => fn(),
  }
  let threw = null
  try { registerOAuthRoutes(ctx, webServer) }
  catch (cause) { threw = cause }
  check('T7.cordis 抛错时不崩', threw === null, true)
  check('T7.照挂 flows', webServer.handlers.has('/provider/oauth/flows'), true)
  check('T7.照挂 begin', webServer.handlers.has('/provider/oauth/begin'), true)
  check('T7.照挂 stream', webServer.handlers.has('/provider/oauth/stream'), true)
  check('T7.照挂 respond', webServer.handlers.has('/provider/oauth/respond'), true)
  check('T7.照挂 cancel', webServer.handlers.has('/provider/oauth/cancel'), true)
  // handler 层：服务读不到 → 503 + JSON（不是空 body）
  const r = await callJson(webServer.handlers, '/provider/oauth/begin', { key: 'any/key' })
  check('T7.服务读不到时 begin 回 503', r.status, 503)
  check('T7.503 带 JSON error', typeof r.body.error === 'string' && r.body.error.length > 0, true)
})()

/* ----------------------------- Test 8 ----------------------------- */
/* ctx.get 返回 undefined：authorization 服务未注册——同一套契约（路由在、回 503）。 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const ctx = {
    get: () => undefined,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => fn(),
  }
  let threw = null
  try { registerOAuthRoutes(ctx, webServer) }
  catch (cause) { threw = cause }
  check('T8.未挂载时不崩', threw === null, true)
  check('T8.照挂 flows', webServer.handlers.has('/provider/oauth/flows'), true)
  check('T8.照挂 begin', webServer.handlers.has('/provider/oauth/begin'), true)
  // GET flows 也得回 JSON 而不是空 body
  const res = makeRes()
  webServer.handlers.get('/provider/oauth/flows')(makeReq('GET', '/provider/oauth/flows', undefined), res)
  await new Promise((resolve) => setImmediate(resolve))
  check('T8.flows 回 503', res.status, 503)
  check('T8.flows body 是 JSON', JSON.parse(res.body).ok, false)
})()

/* ----------------------------- Test 9 ----------------------------- */
/* 回归：src/index.ts 的 service<T>(name) 内部实现也踩了同样的 cordis 坑——`ctx.get(name)
 * ?? ctx[name]` 在未注册服务时走属性访问抛错。这次 /provider/presets handler 调
 * service<AuthorizationService>('authorization') 在没装 credentials 包的 dsh 里 500，
 * 客户端 fallback 到「宿主端状态不可用」。
 *
 * 测试这个：通过 service() 拿不存在的服务，cordis 严格模式下 ctx.get 返回 undefined
 * 也好、抛错也好，service() 都不能抛，得让调用方拿到 undefined 然后走降级。 */

await (async () => {
  __oauth_reset()
  // 模拟两个 cordis 行为：1) get 返回 undefined（服务不在）；2) get 抛错（严格模式）。
  const cases = [
    { name: 'T9a', getImpl: () => undefined },
    { name: 'T9b', getImpl: () => { throw new Error('cannot get property "authorization" without inject') } },
  ]
  for (const c of cases) {
    const ctx = {
      get: c.getImpl,
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (fn) => fn(),
    }
    // 复刻 src/index.ts service() 的形状
    const service = (name) => {
      try {
        const value = ctx.get(name)
        return value === null || value === undefined ? undefined : value
      } catch (cause) {
        return undefined
      }
    }
    let threw = null
    let result
    try { result = service('authorization') }
    catch (cause) { threw = cause }
    check(c.name + '.service() 不抛', threw === null, true)
    check(c.name + '.service() 返回 undefined', result, undefined)
  }
})()

/* ----------------------------- Test 10 ----------------------------- */
/* ensureAuthorizationService：原版 dsh 的 bundle 都不挂 authorization 服务，插件得自己补。
 * 四条路径——服务已在（不动）、缺席（挂上）、加载失败（降级）、ctx.plugin 不可用（降级）。
 * 用注入的 loader 替身，不依赖本机装没装 dsh。 */

await (async () => {
  const makeCtx = (options) => {
    const mounted = []
    const warnings = []
    return {
      mounted,
      warnings,
      ctx: {
        // 服务缺席 / 在场由 options.hasService 决定
        get: (name) => (name === 'authorization' && options.hasService === true ? { list: () => [] } : undefined),
        effect: (fn) => fn(),
        ...(options.hasPlugin === false ? {} : { plugin: async (service) => { mounted.push(service) } }),
        logger: () => ({ info() {}, warn: (m) => warnings.push(String(m)), error() {} }),
      },
    }
  }

  // a) 服务已在 → 不重复挂
  {
    const h = makeCtx({ hasService: true })
    await ensureAuthorizationService(h.ctx, h.ctx.logger(), async () => ({ default: class {} }))
    check('T10a.服务已在时不挂', h.mounted.length, 0)
  }

  // b) 缺席 → 挂上 default 导出
  {
    class FakeService {}
    const h = makeCtx({ hasService: false })
    await ensureAuthorizationService(h.ctx, h.ctx.logger(), async () => ({ default: FakeService }))
    check('T10b.缺席时挂上 default', h.mounted.length, 1)
    check('T10b.挂的是那个服务类', h.mounted[0], FakeService)
  }

  // c) 没有 default（CJS 风格命名导出）→ 用模块本身兜底
  {
    const mod = { AuthorizationService: class {} }
    const h = makeCtx({ hasService: false })
    await ensureAuthorizationService(h.ctx, h.ctx.logger(), async () => mod)
    check('T10c.没有 default 时用模块本身', h.mounted.length, 1)
    check('T10c.挂的是模块对象', h.mounted[0], mod)
  }

  // d) 加载失败 → 只 warn，不抛
  {
    const h = makeCtx({ hasService: false })
    let threw = null
    try {
      await ensureAuthorizationService(h.ctx, h.ctx.logger(), async () => { throw new Error('包里没有这个模块') })
    } catch (cause) { threw = cause }
    check('T10d.加载失败不抛', threw === null, true)
    check('T10d.没挂任何东西', h.mounted.length, 0)
    check('T10d.留了一条 warn', h.warnings.length, 1)
  }

  // e) ctx.plugin 不可用 → 只 warn，不抛
  {
    const h = makeCtx({ hasService: false, hasPlugin: false })
    let threw = null
    try {
      await ensureAuthorizationService(h.ctx, h.ctx.logger(), async () => ({ default: class {} }))
    } catch (cause) { threw = cause }
    check('T10e.没有 ctx.plugin 不抛', threw === null, true)
    check('T10e.没挂任何东西', h.mounted.length, 0)
    check('T10e.留了一条 warn', h.warnings.length, 1)
  }

  // f) 真解析器：本机装了 dsh 就给路径、没装给 undefined，两种都不许抛
  {
    let entry
    let threw = null
    try { entry = hostPackageEntry('@deepseek-ai/dsh-authorization') }
    catch (cause) { threw = cause }
    check('T10f.hostPackageEntry 不抛', threw === null, true)
    check('T10f.结果要么 undefined 要么是 lib/index.js', entry === undefined || entry.endsWith('lib/index.js'), true)
  }
})()

/* ----------------------------- Test 11 ----------------------------- */
/* 空字符串是合法 prompt 答案：Copilot 的第一个 prompt 是「GitHub Enterprise URL/domain
 * (blank for github.com)」。宿主端曾用 readString 解析 value，'' 被当成没传 → 400。 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  let received = null
  let markReady
  const ready = new Promise((resolve) => { markReady = resolve })
  authorization.begin = function (request) {
    return new Promise(function (resolve) {
      setImmediate(function () {
        request.interaction.prompt({ kind: 'text', message: 'Enterprise URL/domain (blank for github.com)' })
          .then(function (answer) { received = answer; markReady(); resolve({ status: 'authorized' }) })
        request.signal.addEventListener('abort', function () { resolve({ status: 'cancelled' }) })
      })
    })
  }
  const beginRes = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  const attemptId = beginRes.body.attemptId
  const streamRes = openStream(webServer.handlers, attemptId)
  // 等 prompt 帧
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 200
    const tick = () => {
      if (streamRes.sseEvents().some((e) => e.kind === 'prompt')) return resolve()
      if (Date.now() > deadline) return reject(new Error('等 prompt 超时'))
      setTimeout(tick, 10)
    }
    tick()
  })
  const promptFrame = streamRes.sseEvents().find((e) => e.kind === 'prompt')
  const resp = await callJson(webServer.handlers, '/provider/oauth/respond', {
    attemptId: attemptId, promptId: promptFrame.promptId, value: '',
  })
  check('T11.空答案被接受', resp.body.ok, true)
  await ready
  check('T11.flow 收到空字符串（不是 undefined）', received === '', true)
  await new Promise((r) => setTimeout(r, 30))
  const settled = streamRes.sseEvents().find((e) => e.kind === 'settled')
  check('T11.之后照常结算 authorized', settled && settled.status, 'authorized')
})()

/* ----------------------------- Test 12 ----------------------------- */
/* SSE 回放：flow 在浏览器连上 EventSource 之前就推了 notice / prompt（正常时序就是这样：
 * 先 POST begin 拿 id，再开 SSE）。后连上的流必须先把已发生的事件补上，否则弹窗永远停在
 * 「已在登录…」——这就是用户实测到的那个现象。 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  let answer = null
  authorization.begin = function (request) {
    return new Promise(function (resolve) {
      setImmediate(function () {
        // 先推事件，再等回答——模拟 Copilot 的「先问企业域名」。
        request.interaction.notify({ message: '准备登录', url: 'https://github.com/login/device', code: 'WXYZ-1234' })
        request.interaction.prompt({ kind: 'text', message: 'Enterprise URL/domain' }).then(function (v) {
          answer = v
          resolve({ status: 'authorized' })
        })
        request.signal.addEventListener('abort', function () { resolve({ status: 'cancelled' }) })
      })
    })
  }
  const beginRes = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  const attemptId = beginRes.body.attemptId
  // 关键：**等事件都发生完**，之后才开流
  await new Promise((r) => setTimeout(r, 60))
  const streamRes = openStream(webServer.handlers, attemptId)
  await new Promise((r) => setTimeout(r, 30))
  const events = streamRes.sseEvents()
  check('T12.回放了 notice', events.some((e) => e.kind === 'notice' && e.notice.code === 'WXYZ-1234'), true)
  const promptFrame = events.find((e) => e.kind === 'prompt')
  check('T12.回放了 prompt', promptFrame !== undefined, true)
  // 回放出来的 promptId 仍然可回答
  const resp = await callJson(webServer.handlers, '/provider/oauth/respond', {
    attemptId: attemptId, promptId: promptFrame.promptId, value: 'ghe.example.com',
  })
  check('T12.回放的 prompt 还能回答', resp.body.ok, true)
  await new Promise((r) => setTimeout(r, 50))
  check('T12.flow 收到答案', answer, 'ghe.example.com')
  const settled = streamRes.sseEvents().find((e) => e.kind === 'settled')
  check('T12.实时帧照常到达（settled）', settled && settled.status, 'authorized')
})()

/* ----------------------------- Test 13 ----------------------------- */
/* provider → OAuth 凭据记录 key 的匹配。卡片状态（显示「已通过 OAuth 登录」还是「未配置 key」）
 * 全靠它：记录键是 `<scope>/<provider-id>`，scope 是拥有 flow 的插件名，别写死。 */

await (async () => {
  const keys = ['llm-pi-ai/github-copilot', 'llm-pi-ai/openai-codex', 'llm-pi-ai/anthropic', 'noslash']
  check('T13.命中 copilot', flowKeyForProvider(keys, 'github-copilot'), 'llm-pi-ai/github-copilot')
  check('T13.命中 codex', flowKeyForProvider(keys, 'openai-codex'), 'llm-pi-ai/openai-codex')
  check('T13.没有的 provider → undefined', flowKeyForProvider(keys, 'moonshot'), undefined)
  check('T13.空列表 → undefined', flowKeyForProvider([], 'github-copilot'), undefined)
  check('T13.没有斜杠的键按整串比', flowKeyForProvider(keys, 'noslash'), 'noslash')
  check('T13.scope 改名也认（不写死 llm-pi-ai）',
    flowKeyForProvider(['dsh-llm-pi-ai/github-copilot'], 'github-copilot'), 'dsh-llm-pi-ai/github-copilot')
  check('T13.不误配同名前缀', flowKeyForProvider(['llm-pi-ai/github-copilot-enterprise'], 'github-copilot'), undefined)
})()

/* ----------------------------- 路由必须跟着 fiber 走 ----------------------------- */
// alpha.8 在桌面端实测的故障：这五条路由原来是直接 webServer.register、没接 disposer，
// 插件热重载（装新版本/开关插件）时旧实例的路由留在表里，新实例一注册就抛
// `webserver: duplicate exact route "/provider/oauth/flows"`，整个插件激活失败。
await (async () => {
  const paths = ['/provider/oauth/begin', '/provider/oauth/cancel', '/provider/oauth/flows', '/provider/oauth/respond', '/provider/oauth/stream']
  const first = makeWebServer()
  const one = makeCtx(FLOW_LIST)
  registerOAuthRoutes(one.ctx, first)
  check('T14.挂载后五条路由都在', [...first.handlers.keys()].sort(), paths)

  // 模拟 fiber 销毁：把这些 effect 的 disposer 执行掉
  for (const dispose of one.effects) dispose()
  check('T14.卸载后路由被摘干净（不再泄漏）', first.handlers.size, 0)

  // 再挂一次（就是热重载那一步）：不该再撞重复
  const two = makeCtx(FLOW_LIST)
  let reloadThrew = null
  try {
    registerOAuthRoutes(two.ctx, first)
  } catch (error) {
    reloadThrew = error instanceof Error ? error.message : String(error)
  }
  check('T14.热重载重新挂载不撞重复路由', reloadThrew, null)
  check('T14.重载后路由仍在', [...first.handlers.keys()].sort(), paths)

  // 旧版本留下的残留（没有 disposer 可摘）：应当被清掉并换成我们的
  const stale = makeWebServer()
  stale.exact.set('/provider/oauth/flows', { kind: 'exact', path: '/provider/oauth/flows', handler: () => {} })
  const three = makeCtx(FLOW_LIST)
  let staleThrew = null
  try {
    registerOAuthRoutes(three.ctx, stale)
  } catch (error) {
    staleThrew = error instanceof Error ? error.message : String(error)
  }
  check('T14.旧版本残留会被清掉而不是让插件激活失败', staleThrew, null)
  check('T14.残留位置换成了我们的 handler', typeof stale.handlers.get('/provider/oauth/flows'), 'function')
})()

console.log(failed ? '\n有失败用例' : '\nOAuth 测试全部通过')
if (failed) process.exitCode = 1