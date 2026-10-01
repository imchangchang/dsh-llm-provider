// e2e 浏览器层断言：真 dsh web UI 上的插件行为。需要 chromium（npx playwright install chromium）。
// 前置同协议层：scripts/test-e2e.sh 设置 E2E_BASE_URL / E2E_TOKEN。
// 选择器全部走可访问名 / 占位符 / 文本，不依赖 class hash，UI 改版不易碎。
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL
const TOKEN = process.env.E2E_TOKEN
if (!BASE || !TOKEN) {
  throw new Error('缺 E2E_BASE_URL / E2E_TOKEN——请用 scripts/test-e2e.sh 跑，不要直接起 playwright')
}

test.describe.configure({ mode: 'serial' })

/** 打开首页并进入「模型服务」设置页。 */
async function openModelServices(page) {
  await page.goto(`${BASE}/?token=${TOKEN}`)
  const settings = page.getByRole('button', { name: '设置' })
  await expect(settings).toBeVisible({ timeout: 20_000 })
  await settings.click()
  await page.getByRole('button', { name: '模型服务' }).click()
  await expect(page.getByText('pi-ai 桥接')).toBeVisible()
}

test('设置面板有「模型服务」标签（插槽注入成功）', async ({ page }) => {
  await openModelServices(page)
})

test('添加供应商表单打开、预设下拉非空', async ({ page }) => {
  await openModelServices(page)
  await page.getByText('添加供应商').click()
  // 下拉触发器是带占位符/文本「选择供应商」的组合框；预设列表由 /provider/presets 渲染
  await page.locator('[placeholder*="选择供应商"], button:has-text("选择供应商")').first().click()
  await expect(page.getByText('Amazon Bedrock')).toBeVisible({ timeout: 10_000 })
})

test('DeepSeek 额度卡出数（依赖真实外网，CI 跳过）', async ({ page }) => {
  test.skip(process.env.CI === '1', '额度走真实 DeepSeek 接口，CI 无凭据语义，跳过')
  await openModelServices(page)
  await expect(page.getByText('DeepSeek')).toBeVisible({ timeout: 20_000 })
  // 额度数字（¥ 开头）出现 = 拷入的凭据 + 额度接口真实调通
  await expect(page.getByText(/¥[\d,.]+/)).toBeVisible({ timeout: 15_000 })
})

test('全程无未捕获异常与 console 错误', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await openModelServices(page)
  await page.getByText('添加供应商').click()
  await page.locator('[placeholder*="选择供应商"], button:has-text("选择供应商")').first().click()
  await expect(page.getByText('Amazon Bedrock')).toBeVisible({ timeout: 10_000 })

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('composer 模型选择器为插件接管版', async ({ page }) => {
  test.skip(true, '待夹具：模型选择器需要选中的工作区会话上下文，沙箱里还没有可选工作区')
  await openModelServices(page)
})
