/**
 * OAuth 路由的离线测试。
 *
 *   node test/oauth.mjs
 *
 * 模拟宿主授权服务（`ctx.authorization`）与 webServer.register，把 5 条路由摘下来
 * 直接调，验证 begin / respond / cancel / stream 的事件流符合预期。
 *
 * 测试钩通过 /lib/oauth.js 的 `__testHook` 拿到 attempt 池与 `__oauth_*` 工具，避免私有状态外漏。
 */
import { registerOAuthRoutes } from '../lib/oauth.js'
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
  return {
    register(route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
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
  const ctx = {
    get: (name) => (name === 'authorization' ? authorization : undefined),
    authorization: authorization,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => fn(),
  }
  return { ctx, authorization }
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
/* 同 key 第二次 begin → 409 */

await (async () => {
  __oauth_reset()
  const webServer = makeWebServer()
  const { ctx, authorization } = makeCtx(FLOW_LIST)
  registerOAuthRoutes(ctx, webServer)
  authorization.begin = function () { return new Promise(function () {}) }  // 永不结束

  const a = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  const b = await callJson(webServer.handlers, '/provider/oauth/begin', { key: FLOW_LIST[0].key })
  check('T4.a.ok', a.body.ok, true)
  check('T4.b.ok=false', b.body.ok, false)
  checkTruthy('T4.b.error 非空', typeof b.body.error === 'string')
  checkTruthy('T4.a attempt 在池里', __oauth_attempt(a.body.attemptId) !== undefined)
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

console.log(failed ? '\n有失败用例' : '\nOAuth 测试全部通过')
if (failed) process.exitCode = 1