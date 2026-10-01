/**
 * 截图 spec：给 README 产出界面图，不是断言套件。
 *
 * 只在 `E2E_CAPTURE=1` 时跑（`scripts/capture-screenshots.sh` 会设），
 * 其余时候整体跳过，不进 CI 的回归范围。产出中英两套：
 * `<名字>.png`（en-US 外壳）与 `<名字>.zh.png`（zh-CN 外壳），默认写进 `docs/images/`。
 *
 * 前置由编排脚本准备：沙箱实例 + 种入的工作区夹具（会话上下文是 composer
 * 模型选择器的必要条件）+ 拷入的宿主凭据。本文件自己在沙箱里补齐截图用的
 * provider 夹具：从 `/provider/presets` 里挑「凭据已在库里」的预设，按
 * `apiKeyEnv` 写进路由，好让卡片有余额/用量窗口、选择器有多个 provider 分组。
 * 改动只落在一次性的沙箱里，脚本 clean 即焚。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, request as playwrightRequest } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL
const TOKEN = process.env.E2E_TOKEN
const CAPTURE = process.env.E2E_CAPTURE === '1'
const OUT_DIR = process.env.E2E_SHOTS_DIR ?? join(process.cwd(), '..', '..', 'docs', 'images')
/** 种进沙箱的工作区标题，composer 夹具按它找「在 <标题> 中新建会话」按钮。 */
const WORKSPACE = process.env.E2E_WORKSPACE ?? 'demo-app'

if (!BASE || !TOKEN) {
  throw new Error('缺 E2E_BASE_URL / E2E_TOKEN——请用 scripts/capture-screenshots.sh 跑，不要直接起 playwright')
}

/** 插件路由的地址（token 走 query，和客户端同样的方式）。 */
const api = (path) => `${BASE}${path}?token=${TOKEN}`

/**
 * 宿主凭据库里真实有值的条目：编排脚本从沙箱的 `.credentials.yaml` 里读出来传进来。
 * `refs` 是密钥名（如 `KIMI_CODING_API_KEY`），`records` 是 OAuth/登录态的记录键
 * （如 `llm-pi-ai/github-copilot`）。**不能用 `/provider/presets` 的 `missingKey` 判断**：
 * 那个字段只在「路由已配置且没值」时为 true，未配置的预设一律 false。
 *
 * 只有 `refs`（密钥）能直接建成路由：OAuth 记录要有卡片得现场走完一次设备码登录，
 * 光写一条空路由不会出现在路由表里（实测两个端点都不认），所以那类只记一行日志。
 */
const CREDENTIAL_REFS = new Set((process.env.E2E_CREDENTIAL_REFS ?? '').split(',').filter(Boolean))
const CREDENTIAL_RECORDS = new Set((process.env.E2E_CREDENTIAL_RECORDS ?? '').split(',').filter(Boolean))

test.beforeAll(async () => {
  test.setTimeout(180_000) // 夹具要写好几十条路由并等宿主回带，默认的 30s 钩子超时不够
  if (!CAPTURE) return
  mkdirSync(OUT_DIR, { recursive: true })
  const ctx = await playwrightRequest.newContext()
  try {
    const presets = (await (await ctx.get(api('/provider/presets'))).json()).presets ?? []
    const wanted = presets
      .filter((preset) => preset.id !== 'deepseek' && CREDENTIAL_REFS.has(preset.apiKeyEnv))
      .map((preset) => ({ id: preset.id, value: { apiKeyEnv: preset.apiKeyEnv } }))
    const oauthOnly = presets
      .filter((preset) => preset.id !== 'deepseek' && !CREDENTIAL_REFS.has(preset.apiKeyEnv))
      .filter((preset) => CREDENTIAL_RECORDS.has(`llm-pi-ai/${preset.id}`))
      .map((preset) => preset.id)
    if (oauthOnly.length > 0) {
      console.log(`[capture] 这几个只有 OAuth 登录态，没有卡片，要现场登录才有：${oauthOnly.join(', ')}`)
    }
    for (const entry of wanted) {
      const res = await ctx.post(api('/provider/mutate'), { data: { op: 'merge', routeId: entry.id, value: entry.value } })
      const body = await res.json().catch(() => ({}))
      if (body.ok !== true) console.log(`[capture] 写路由 ${entry.id} 没成功：${JSON.stringify(body).slice(0, 200)}`)
    }
    const ids = wanted.map((entry) => entry.id)
    const routeIds = async () => {
      const status = await (await ctx.get(api('/provider/status'))).json()
      return (status.routes ?? []).map((route) => route.id)
    }
    const deadline = Date.now() + 30_000
    let have = await routeIds()
    while (Date.now() < deadline && !ids.every((id) => have.includes(id))) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      have = await routeIds()
    }
    const missing = ids.filter((id) => !have.includes(id))
    if (missing.length > 0) console.log(`[capture] 这些 provider 没进路由，截图里不会有：${missing.join(', ')}`)
    if (ids.length === 0) console.log('[capture] 宿主机上没有额外密钥，卡片与选择器只有 DeepSeek')
  } finally {
    await ctx.dispose()
  }
})

/** 打开设置 → 模型服务（插槽注入的插件页）。 */
async function openProviderSettings(page, locale) {
  await page.goto(`${BASE}/?token=${TOKEN}`)
  const settings = page.getByRole('button', { name: locale.startsWith('zh') ? '设置' : 'Settings' })
  await expect(settings).toBeVisible({ timeout: 20_000 })
  await settings.click()
  await page.getByRole('button', { name: locale.startsWith('zh') ? '模型服务' : 'Provider' }).click()
  await expect(page.getByRole('button', { name: /添加供应商|Add Provider/ })).toBeVisible({ timeout: 15_000 })
}

/** 设置对话框的可视区域，截图裁到它 + 8px 边距。 */
async function dialogClip(page) {
  const box = await page.locator('[role="dialog"]').first().boundingBox()
  if (box === null) throw new Error('找不到设置对话框')
  return { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 }
}

/** 文件名：英文 README 用 `<名字>.png`，中文 README 用 `<名字>.zh.png`。 */
function shotPath(name, locale) {
  return join(OUT_DIR, `${name}${locale.startsWith('zh') ? '.zh' : ''}.png`)
}

async function shoot(page, name, locale, clip) {
  await page.screenshot({ path: shotPath(name, locale), clip: clip === undefined ? undefined : await clip() })
}

/** 新建一个带工作区上下文的新会话，等 composer 的模型选择器就位。 */
async function openComposer(page, locale) {
  await page.goto(`${BASE}/?token=${TOKEN}`)
  const row = page.getByText(WORKSPACE, { exact: true }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.hover()
  await page
    .getByRole('button', { name: new RegExp(`${WORKSPACE}.*(新建会话|New session)|(新建会话|New session).*${WORKSPACE}`) })
    .click()
  await expect(page.locator('.ms_trigger').first()).toBeVisible({ timeout: 30_000 })
}

/** 一个外壳语言下的四组截图。 */
function captureSuite(locale) {
  test('服务商页、卡片明细、模型详情卡、模型清单编辑器', async ({ page }) => {
    test.skip(!CAPTURE, 'E2E_CAPTURE=1 才产出截图')
    await openProviderSettings(page, locale)
    // 额度是打开页面时现拉的，等第一张卡片出数再截
    await expect(page.getByRole('button', { name: /^DeepSeek/ })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    await shoot(page, 'providers', locale, () => dialogClip(page))

    await page.getByRole('button', { name: /^DeepSeek/ }).click()
    await expect(page.getByText(/^模型（\d+）$/)).toBeVisible({ timeout: 10_000 })
    await page.getByText(/^模型（\d+）$/).click()
    await expect(page.locator('.pv_mRow').first()).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    await shoot(page, 'provider-card', locale, () => dialogClip(page))

    // Cherry 式详情卡：悬浮模型行才出现
    await page.locator('.pv_mRow').first().hover()
    await expect(page.locator('.pv_tip').first()).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await shoot(page, 'model-detail', locale, () => dialogClip(page))

    await page.getByRole('button', { name: '编辑清单' }).click()
    await expect(page.getByText(/个模型已勾选|模型已勾选/)).toBeVisible({ timeout: 10_000 })
    // 编辑器在卡片底部，先滚到它，不然设置对话框的视口只截到上面那半
    await page.locator('.pv_me').scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await shoot(page, 'model-editor', locale, () => dialogClip(page))
  })

  test('添加供应商表单与 OAuth 登录', async ({ page }) => {
    test.skip(!CAPTURE, 'E2E_CAPTURE=1 才产出截图')
    await openProviderSettings(page, locale)
    await page.getByRole('button', { name: /添加供应商|Add Provider/ }).click()
    await page.locator('[placeholder*="选择供应商"], button:has-text("选择供应商")').first().click()
    await expect(page.getByText('Amazon Bedrock')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await shoot(page, 'add-provider', locale, () => dialogClip(page))

    await page.getByText('GitHub Copilot', { exact: true }).click()
    // 导航名、添加按钮、OAuth 按钮这几个键在 src/client/i18n.ts 里有英文词条，
    // 英文外壳下走英文文案；插件其余文案是硬编码中文，两个外壳下都按中文找。
    const oauth = page.getByRole('button', { name: /使用 OAuth 登录|Sign in with OAuth/ })
    await expect(oauth).toBeVisible({ timeout: 10_000 })
    await oauth.click()
    // 设备码要等 GitHub 那一跳回来，出现串码才算就位
    await expect(page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(400)
    await shoot(page, 'oauth-login', locale, () => dialogClip(page))
    // 截图后立刻取消这次登录：设备码只在页面轮询期间有效，不留下悬着的授权
    await page.getByRole('button', { name: /取消|Cancel/ }).last().click()
  })

  test('pi-ai 桥接页', async ({ page }) => {
    test.skip(!CAPTURE, 'E2E_CAPTURE=1 才产出截图')
    await openProviderSettings(page, locale)
    await page.getByRole('button', { name: 'pi-ai 桥接' }).click()
    await expect(page.getByText(/当前 pi-ai 版本|现用 pi-ai/)).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(800)
    await shoot(page, 'pi-ai-bridge', locale, () => dialogClip(page))
  })

  test('会话输入框里的模型选择器', async ({ page }) => {
    test.skip(!CAPTURE, 'E2E_CAPTURE=1 才产出截图')
    await openComposer(page, locale)
    await page.locator('.ms_trigger').first().click()
    await page.getByRole('button', { name: /^模型/ }).first().click()
    await expect(page.locator('.mp_search')).toBeVisible({ timeout: 15_000 })
    // 模型元数据（能力徽章/上下文）要等目录与详情回来
    await expect(page.locator('.ms_group').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1200)
    // 整屏截：模型按钮在输入框右侧、面板开在它上方，裁窄了会把输入框左边和面板底边切一半。
    // 整屏能看到会话、工作区与插件接管的输入框，读者一眼知道这个选择器在哪。
    await shoot(page, 'model-selector', locale)
  })
}

test.describe('截图：中文外壳', () => {
  test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  captureSuite('zh-CN')
})

test.describe('截图：英文外壳', () => {
  test.use({ locale: 'en-US', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  captureSuite('en-US')
})
