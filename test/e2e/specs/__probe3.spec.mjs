import { test, expect } from '@playwright/test'
const BASE = process.env.E2E_BASE_URL, TOKEN = process.env.E2E_TOKEN
test('probe 模型下拉结构', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto(`${BASE}/?token=${TOKEN}`)
  await page.getByRole('button', { name: '搜索会话' }).click()
  await page.getByRole('textbox', { name: /搜索会话/ }).fill('请只回复两个字')
  const hit = page.getByRole('treeitem', { name: /请只回复两个字/ }).first()
  await hit.click({ timeout: 15_000 })
  await expect(page.getByText('请只回复两个字：好的').first()).toBeVisible({ timeout: 20_000 })
  const selector = page.getByRole('button', { name: /deepseek-\w+\s*Default/ })
  await selector.click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: '/tmp/probe-dd.png' })
  const texts = await page.evaluate(() => {
    const seen = new Set()
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length === 0) {
        const t = (el.textContent || '').trim()
        if (/^deepseek-[a-z]+$/.test(t)) {
          const r = el.closest('[role]')?.getAttribute('role') || 'norole'
          seen.add(t + ' @' + r + ' .' + String(el.className).slice(0, 30))
        }
      }
    }
    return [...seen]
  })
  console.log('deepseek-* 文本元素:', JSON.stringify(texts, null, 1))
})
