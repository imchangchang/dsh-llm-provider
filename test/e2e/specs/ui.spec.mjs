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
  // 卡片头部是 role=button、可访问名以 provider 名开头（后面跟官网图标）。这里必须按
  // 「可访问名开头」定位，不能用 getByText('DeepSeek')：0.2.x 的 composer 模型选择器触发器
  // 也是 button，名字里带「deepseek」与「¥…」，getByText 是大小写不敏感的子串匹配，
  // strict 模式下会同时撞上它（实测 3 个元素，0.1.x 上只有 1 个，所以在 0.1.x 上看着是好的）。
  const cardHead = page.getByRole('button', { name: /^DeepSeek/ })
  await expect(cardHead).toBeVisible({ timeout: 20_000 })
  // 额度数字在卡片容器里、不在头部按钮内（头部按钮只包名称行），所以按「包含该按钮的最内层
  // div」取到卡片再找 ¥ 数字——直接 getByText(/¥…/) 同样会撞 composer 触发器上那个余额。
  const card = page.locator('div').filter({ has: cardHead }).last()
  // 额度数字（¥ 开头）出现 = 拷入的凭据 + 额度接口真实调通
  await expect(card.getByText(/¥[\d,.]+/)).toBeVisible({ timeout: 15_000 })
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

test('composer 模型选择器为插件接管版（基于真实对话）', async ({ page }) => {
  if (!process.env.E2E_CONVERSATION_READY) {
    test.skip(true, '真实对话夹具未就绪（headless 会话失败或未跑，常见于 CI）')
  }
  await page.goto(`${BASE}/?token=${TOKEN}`)

  // 搜索那轮夹具对话（headless 落盘的真实会话）并打开
  await page.getByRole('button', { name: '搜索会话' }).click()
  await page.getByRole('textbox', { name: /搜索会话/ }).fill('请只回复两个字')
  const hit = page.getByRole('treeitem', { name: /请只回复两个字/ }).first()
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await hit.click()

  // 会话视图：转录里的用户消息可见
  await expect(page.getByText('请只回复两个字：好的').first()).toBeVisible({ timeout: 20_000 })

  // composer 右下角的模型选择器：当前模型名 + Default
  const selector = page.getByRole('button', { name: /deepseek-\w+\s*Default/ })
  await expect(selector).toBeVisible({ timeout: 20_000 })
  await selector.click()
  // 展开后的弹层是插件自己的菜单：模型目录（org/model 形式，闭态没有这个文本）+ 推理等级子项
  await expect(page.getByText('deepseek/deepseek-flash')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('推理等级')).toBeVisible()
})
