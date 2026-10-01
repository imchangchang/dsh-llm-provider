// e2e 协议层断言：不起浏览器，直接打插件在真 dsh 实例里注册的 HTTP 路由。
// 环境由 scripts/test-e2e.sh 设置：E2E_BASE_URL / E2E_TOKEN / E2E_LOG / E2E_DSH_VERSION。
// 沙箱是全新的（DSH_HOME 隔离），断言只依赖沙箱自己拷入的凭据和插件自身的行为。
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL
const TOKEN = process.env.E2E_TOKEN
const LOG = process.env.E2E_LOG ?? ''

if (!BASE || !TOKEN) {
  throw new Error('缺 E2E_BASE_URL / E2E_TOKEN——请用 scripts/test-e2e.sh 跑，不要直接起 playwright')
}

/** 插件路由的地址（token 走 query，和客户端同样的方式）。 */
const api = (path) => `${BASE}${path}?token=${TOKEN}`

test.describe.configure({ mode: 'serial' })

test('实例可达：web 根路径有响应', async ({ request }) => {
  const res = await request.get(`${BASE}/?token=${TOKEN}`, { maxRedirects: 0 })
  expect([200, 302, 303]).toContain(res.status())
})

test('/provider/status：200、testMode、桥接激活', async ({ request }) => {
  const res = await request.get(api('/provider/status'))
  expect(res.status()).toBe(200)
  const data = await res.json()
  expect(data.testMode).toBe(true)
  expect(data.bridge?.active).toBe(true)
})

test('凭据拷入生效：deepseek 路由带 DEEPSEEK_API_KEY', async ({ request }) => {
  const res = await request.get(api('/provider/status'))
  expect(res.status()).toBe(200)
  const data = await res.json()
  const deepseek = (data.routes ?? []).find((r) => r.id === 'deepseek')
  expect(deepseek).toBeDefined()
  expect(deepseek.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
})

test('/provider/presets：非空且形状完整', async ({ request }) => {
  const res = await request.get(api('/provider/presets'))
  expect(res.status()).toBe(200)
  const data = await res.json()
  expect(Array.isArray(data.presets)).toBe(true)
  expect(data.presets.length).toBeGreaterThan(0)
  for (const preset of data.presets) {
    expect(typeof preset.id).toBe('string')
    expect(typeof preset.label).toBe('string')
  }
})

test('/provider/models：200 且是 JSON 对象', async ({ request }) => {
  const res = await request.get(api('/provider/models'))
  expect(res.status()).toBe(200)
  const data = await res.json()
  expect(typeof data).toBe('object')
})

test('写闭环：merge 写入 → 回带 providers 含新条目 → unset 移除 → 消失', async ({ request }) => {
  const routeId = `e2e-probe-${Date.now()}`
  const merge = await request.post(api('/provider/mutate'), {
    data: {
      op: 'merge',
      routeId,
      // models[].id 必填（两代 profile schema 都这样），模型/路由要带 api（线协议），
      // 否则宿主校验拒绝写入（resolves no models / needs an api）
      value: {
        baseURL: 'https://e2e.invalid',
        apiKey: 'sk-e2e-probe',
        api: 'openai-completions',
        models: [{ id: 'e2e-probe-model', api: 'openai-completions' }],
      },
    },
  })
  expect(merge.status()).toBe(200)
  const mergeBody = await merge.json()
  expect(mergeBody.ok).toBe(true)
  expect(mergeBody.providers?.[routeId]).toBeDefined()

  const unset = await request.post(api('/provider/mutate'), {
    data: { op: 'unset', routeId },
  })
  expect(unset.status()).toBe(200)
  const unsetBody = await unset.json()
  expect(unsetBody.ok).toBe(true)
  expect(unsetBody.providers?.[routeId]).toBeUndefined()
})

test('/provider/test：对不存在的路由返回结构化结果而不是 5xx', async ({ request }) => {
  const res = await request.post(api('/provider/test'), {
    data: { routeId: 'e2e-not-exist' },
  })
  // 不存在的路由 404 也是结构化行为；崩了才会 5xx
  expect([200, 404]).toContain(res.status())
  if (res.status() === 200) {
    const data = await res.json()
    expect(typeof data.ok).toBe('boolean')
    expect('account' in data).toBe(true)
  }
})

test('/plan/status：200 且是 JSON', async ({ request }) => {
  const res = await request.get(api('/plan/status'))
  expect(res.status()).toBe(200)
  const data = await res.json()
  expect(typeof data).toBe('object')
})

test('启动日志无官方行撞车', async () => {
  const log = readFileSync(LOG, 'utf8')
  expect(log).not.toContain('already declared')
  expect(log).not.toContain('组件启用失败')
})
