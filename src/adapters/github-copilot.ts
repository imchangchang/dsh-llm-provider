/**
 * GitHub Copilot：GET https://api.github.com/copilot_internal/user
 *
 * 没有官方文档，端点由 OpenTokenUsage / CodexBar 等开源项目交叉验证（VS Code 的 Copilot
 * 扩展自己也在用），返回里带配额头与重置日：
 *   - 付费档：`quota_snapshots.{premium_interactions,chat}` 的 entitlement / remaining
 *   - 免费档：`monthly_quotas` vs `limited_user_quotas`
 *
 * 它要的是 **GitHub token**（不是 api.githubcopilot.com 那个 Copilot token）。走 OAuth 登录的
 * provider 没有 apiKeyEnv，凭据在凭据记录的 grant 里，插件层把其中的 GitHub token 作为 key
 * 传进来（见 src/index.ts 的 oauthTokenFor）。
 *
 * 企业版自建实例（GHE）的配额在各自域名的接口上，这里认不出就明说，不猜。
 */
import { account, asIso, authFailed, clampPercent, describeHttpError, fail, getJson, num, percentLeftOf } from './shared.js'
import { asRecord, readString } from '../types.js'
import type { AccountStatus, AdapterQueryInput, BillingAdapter, QuotaWindow } from './shared.js'

/** Copilot 扩展一直在用的那几个头，缺了会被判定成非官方客户端。 */
const COPILOT_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent': 'GitHubCopilotChat/0.35.0',
  'editor-version': 'vscode/1.107.0',
  'editor-plugin-version': 'copilot-chat/0.35.0',
  'x-github-api-version': '2022-11-28',
}

/**
 * 一个配额快照（`quota_snapshots` 的一项）→ 额度窗口。
 *
 * **不限量要单独认**：Copilot 对 chat / completions 返回 `unlimited: true` 且
 * entitlement=0、remaining=0、percent_remaining=100。照 percent 显示成「100%」是错的
 * （看着像"额度全在"，实际是"不计量"），所以这类窗口不给百分比，改成一句说明。
 */
function snapshotWindow(label: string, raw: unknown, resetAt: string | undefined): QuotaWindow | undefined {
  const record = asRecord(raw)
  if (record['unlimited'] === true) return { window: label, note: '不限量' }
  const limit = num(record['entitlement'])
  const remaining = num(record['remaining'])
  if (limit === undefined && remaining === undefined) return undefined
  // 没有上限也没有剩余（entitlement 0 之类）同样当"不计量"处理，别硬套一个百分比。
  if (limit === 0 && remaining === 0) return { window: label, note: '不限量' }
  return {
    window: label,
    limit,
    remaining,
    // 与其它适配器一致：优先自己按 limit/remaining 算，算不出才用上游字段。
    percentLeft: percentLeftOf(limit, remaining) ?? clampPercent(record['percent_remaining']),
    resetAt,
  }
}

/** 免费档：`monthly_quotas` 是上限、`limited_user_quotas` 是剩余。 */
function freeTierWindow(label: string, monthly: unknown, remainingRaw: unknown, resetAt: string | undefined): QuotaWindow | undefined {
  const limit = num(asRecord(monthly)[keyOfFree(label)])
  const remaining = num(asRecord(remainingRaw)[keyOfFree(label)])
  if (limit === undefined && remaining === undefined) return undefined
  return {
    window: label,
    limit,
    remaining,
    percentLeft: percentLeftOf(limit, remaining),
    resetAt,
  }
}

/** 免费档两个字典的键名与展示名不一致，这里对上。 */
function keyOfFree(label: string): string {
  if (label === '代码补全') return 'completions'
  return 'chat'
}

export default {
  id: 'github-copilot',
  label: 'GitHub Copilot',
  match(providerId: string, baseUrl: string | undefined): boolean {
    if (/^github-copilot/i.test(providerId)) return true
    return typeof baseUrl === 'string' && baseUrl.includes('githubcopilot.com')
  },

  async query({ id, displayName, key, baseUrl }: AdapterQueryInput): Promise<AccountStatus> {
    if (key === undefined || key === '') {
      // OAuth 登录过才有 grant，没有就是还没登录——不要报成"查询失败"，这是可修的状态。
      return account(id, displayName, 'unsupported', {
        authConfigured: false,
        note: '还没登录：在「服务商」里点「使用 OAuth 登录」完成 GitHub Copilot 授权后即可查余量',
      })
    }
    if (typeof baseUrl === 'string' && baseUrl !== '' && !baseUrl.includes('githubcopilot.com')) {
      // 企业版自建实例：配额在各自域名的接口上，这里不猜。
      return account(id, displayName, 'unsupported', {
        note: '企业版实例的配额接口在自建域名上，本适配器只认 github.com',
      })
    }

    const { status, body } = await getJson('https://api.github.com/copilot_internal/user', {
      ...COPILOT_HEADERS,
      authorization: `token ${key}`,
    })
    if (status === 401 || status === 403) fail(authFailed(status))
    if (status !== 200) fail(describeHttpError(status, body))

    const record = asRecord(body)
    const plan = readString(record['copilot_plan'])
    const resetAt = asIso(record['quota_reset_date']) ?? asIso(record['limited_user_reset_date'])
    const snapshots = asRecord(record['quota_snapshots'])

    const windows: QuotaWindow[] = []
    const premium = snapshotWindow('高级请求', snapshots['premium_interactions'], resetAt)
    if (premium !== undefined) windows.push(premium)
    const chat = snapshotWindow('对话', snapshots['chat'], resetAt)
    if (chat !== undefined) windows.push(chat)

    // 免费档没有 quota_snapshots，改看 monthly_quotas / limited_user_quotas。
    if (windows.length === 0) {
      const monthly = record['monthly_quotas']
      const left = record['limited_user_quotas']
      if (monthly !== undefined || left !== undefined) {
        const chatFree = freeTierWindow('对话', monthly, left, resetAt)
        if (chatFree !== undefined) windows.push(chatFree)
        const completionFree = freeTierWindow('代码补全', monthly, left, resetAt)
        if (completionFree !== undefined) windows.push(completionFree)
      }
    }

    return account(id, displayName, windows.length > 0 ? 'quota' : 'unsupported', {
      windows,
      membership: plan,
      ...(windows.length === 0 ? { note: '这个账号没有返回配额数据（可能是企业统一结算的席位）' } : {}),
    })
  },
} as BillingAdapter
