import { defineConfig } from '@playwright/test'

// 只跑协议断言时不需要浏览器（spec 里用的是 request fixture）。
// ui.spec.mjs 加进来后要先 `npx playwright install chromium`。
export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 1,
  reporter: [['list']],
})
