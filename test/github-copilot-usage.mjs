/**
 * GitHub Copilot 额度适配器的离线测试（不起 dsh、不打网络：stub 掉 globalThis.fetch）。
 *
 *   node test/github-copilot-usage.mjs
 *
 * 覆盖三档返回（付费档 quota_snapshots / 免费档 monthly+limited / 无配额），以及
 * 「没登录」「企业版实例」两个不猜的降级路径。
 */
import copilot from '../lib/adapters/github-copilot.js'

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

/** 让 getJson 拿到指定响应体；记下请求头，事后断言。 */
let lastRequest = null
function stubFetch(status, body) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), headers: init === undefined ? {} : init.headers }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const base = { id: 'github-copilot', displayName: 'GitHub Copilot', baseUrl: undefined, extras: {} }

/* ---- 付费档：quota_snapshots ---- */
stubFetch(200, {
  copilot_plan: 'pro',
  quota_reset_date: '2025-02-15T00:00:00Z',
  quota_snapshots: {
    premium_interactions: { percent_remaining: 80, entitlement: 300, remaining: 240, quota_id: 'premium' },
    chat: { percent_remaining: 95, entitlement: 1000, remaining: 950, quota_id: 'chat' },
  },
})
const paid = await copilot.query({ ...base, key: 'gho_token' })
check('付费档 kind=quota', paid.kind, 'quota')
check('付费档套餐等级进 membership', paid.membership, 'pro')
check('付费档两个窗口', paid.windows.map((w) => w.window), ['高级请求', '对话'])
check('高级请求 剩余/上限', [paid.windows[0].remaining, paid.windows[0].limit], [240, 300])
check('高级请求 百分比自己算（240/300）', paid.windows[0].percentLeft, 80)
check('窗口带重置日', paid.windows[0].resetAt, '2025-02-15T00:00:00Z')
check('请求打到 copilot_internal/user', lastRequest.url, 'https://api.github.com/copilot_internal/user')
check('用 GitHub token 认证（token 前缀，不是 Bearer）', lastRequest.headers.authorization, 'token gho_token')
check('带 Copilot 客户端头', lastRequest.headers['editor-version'], 'vscode/1.107.0')

/* ---- 免费档：monthly_quotas / limited_user_quotas ---- */
stubFetch(200, {
  copilot_plan: 'individual',
  access_type_sku: 'free_limited_copilot',
  limited_user_quotas: { chat: 410, completions: 4000 },
  monthly_quotas: { chat: 500, completions: 4000 },
  limited_user_reset_date: '2025-02-11',
})
const free = await copilot.query({ ...base, key: 'gho_token' })
check('免费档两个窗口', free.windows.map((w) => w.window), ['对话', '代码补全'])
check('免费档对话 剩余/上限', [free.windows[0].remaining, free.windows[0].limit], [410, 500])
check('免费档补全剩余', free.windows[1].remaining, 4000)
check('免费档重置日用 limited_user_reset_date', free.windows[0].resetAt, '2025-02-11')

/* ---- 有响应但没有配额（企业统一结算的席位）---- */
stubFetch(200, { copilot_plan: 'business' })
const none = await copilot.query({ ...base, key: 'gho_token' })
check('没配额数据时 kind=unsupported', none.kind, 'unsupported')
check('没配额数据时给出说明', typeof none.note === 'string' && none.note.length > 0, true)

/* ---- 没登录：不报"查询失败"，是可修状态 ---- */
let threw = null
let noKey
try { noKey = await copilot.query({ ...base, key: undefined }) }
catch (cause) { threw = cause }
check('没 key 不抛', threw === null, true)
check('没 key 时 authConfigured=false', noKey.authConfigured, false)
check('没 key 时提示去登录', noKey.note.includes('OAuth 登录'), true)

/* ---- 企业版自建实例：不猜端点 ---- */
stubFetch(200, { quota_snapshots: {} })
const ghe = await copilot.query({ ...base, key: 'gho_token', baseUrl: 'https://copilot-api.company.ghe.com' })
check('企业版不猜端点', ghe.kind, 'unsupported')
check('企业版给出说明', ghe.note.includes('企业版'), true)

/* ---- 凭据失效：401 报成凭据问题，不是网络问题 ---- */
stubFetch(401, { message: 'Bad credentials' })
let authError = null
try { await copilot.query({ ...base, key: 'bad' }) } catch (cause) { authError = cause }
check('401 抛错', authError !== null, true)
check('401 文案指向凭据', authError.message.includes('凭据'), true)

/* ---- match：认 id，也认 githubcopilot.com 的 baseURL ---- */
check('match 认 provider id', copilot.match('github-copilot', undefined), true)
check('match 认 baseURL', copilot.match('some-route', 'https://api.individual.githubcopilot.com'), true)
check('match 不误伤别的 provider', copilot.match('openai', 'https://api.openai.com'), false)

console.log(failed ? '\n有失败用例' : '\nGitHub Copilot 额度适配器测试全部通过')
if (failed) process.exitCode = 1
