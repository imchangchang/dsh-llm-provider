import { defineConfig } from '@playwright/test'

// 只跑协议断言时不需要浏览器（spec 里用的是 request fixture）。
// ui.spec.mjs 加进来后要先 `npx playwright install chromium`。
export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 1,
  reporter: [['list']],
  use: {
    // 固定中文：无头浏览器默认 en-US 时 dsh web 渲染英文，中文选择器全部落空。
    // 固定之后断言与机器/CI 的 locale 无关。
    locale: 'zh-CN',
  },
})
