// e2e 热安装层：**重装插件但不重启 dsh**。
//
// 这是用户真实会踩的形态（本仓库维护者现场踩过一次）：插件管理器/`pnpm add` 把包目录整个换掉，
// `vendor/` 跟着被清空，而 dsh 进程还在跑旧代码、内存里记着旧路径。不核盘的话，读目录数据的
// 三个模块会安静地读出空结果——界面表现是「供应商预设只剩自定义网关、模型徽章全没了」，
// 既不报错也看不出原因（issue #4 的姊妹场景）。
//
// 断言两件事：
//   ① 自愈：目录数据（供应商预设、模型目录）要退回宿主那棵树继续可读，不能一片空白；
//   ② 报出来：状态页要明确说「当前 pi-ai 目录已不在磁盘上，重启 dsh 生效」。
//
// 环境由 scripts/test-e2e.sh 的 install 形态沙箱提供：E2E_BASE_URL / E2E_TOKEN / E2E_PLUGIN_DIR。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL
const TOKEN = process.env.E2E_TOKEN
const PLUGIN_DIR = process.env.E2E_PLUGIN_DIR

if (!BASE || !TOKEN || !PLUGIN_DIR) {
  throw new Error('缺 E2E_BASE_URL / E2E_TOKEN / E2E_PLUGIN_DIR——请用 scripts/test-e2e.sh 跑，不要直接起 playwright')
}

const api = (path) => `${BASE}${path}?token=${TOKEN}`

/** 供应商预设 / 模型目录都要「整份目录」级别的条数，掉盘退化成空时这两条会立刻失败。 */
const MIN_PRESETS = 10
const MIN_MODELS = 100

// 这条用例会**破坏性地**改沙箱状态（把插件包目录整个换掉）。Playwright 在 serial 模式下
// 重试是整组重跑，重跑时环境已经被改过、基线断言必然失败，所以这里显式关掉重试：
// 它测的是「一次重装」这个动作，重试没有意义。
test.describe.configure({ mode: 'serial', retries: 0 })

test('热重装前：目录数据齐、没有漂移提示', async ({ request }) => {
  const presets = await (await request.get(api('/provider/presets'))).json()
  expect((presets.presets ?? []).length).toBeGreaterThan(MIN_PRESETS)
  const models = await (await request.get(api('/provider/models'))).json()
  expect((models.models ?? []).length).toBeGreaterThan(MIN_MODELS)
  const status = await (await request.get(api('/provider/status'))).json()
  expect(status.bridge?.active).toBe(true)
  expect(status.bridge?.piAiDrift).toBeUndefined()
})

test('准备：把当前 pi-ai 落到插件目录里（等价于「下载新版并立即切换」）', async ({ request }) => {
  // 装完没切换过时，跑的是 dsh 自带那份（在宿主树里，不在插件目录）。要构造「重装把它清掉」
  // 这个形态，先得有份在插件目录里的。手工放一份真实 pi-ai 副本再切过去，避免依赖上游有没有
  // 新版本、也避免网络（真实机器上这一步由更新器下载 + 「立即切换」完成）。
  const status = await (await request.get(api('/provider/status'))).json()
  // 幂等：重跑时可能已经在插件目录里那份上了（比如上一轮失败留下的沙箱）
  if (String(status.bridge?.piAiPath ?? '').includes('/vendor/pi-ai/')
    && existsSync(String(status.bridge?.piAiPath))) {
    return
  }
  const hostRoot = String(status.bridge?.piAiPath ?? '')
  expect(hostRoot).not.toBe('')

  // 目录名就是版本号（installedVersions 按目录名枚举），挑一个比宿主大的号，切换时才会选中它。
  const fake = join(PLUGIN_DIR, 'vendor', 'pi-ai', '9.9.9')
  if (!existsSync(fake)) {
    cpSync(hostRoot, fake, { recursive: true })
    // installedVersions() 要求 <版本>/node_modules 在（真实下载档带依赖闭包）；宿主那份可能没有
    mkdirSync(join(fake, 'node_modules'), { recursive: true })
    const pkgPath = join(fake, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.version = '9.9.9'
    writeFileSync(pkgPath, JSON.stringify(pkg))
  }
  const swap = await request.post(api('/provider/swap'))
  expect(swap.status()).toBe(200)
  const swapped = await swap.json()
  expect(swapped.ok).toBe(true)

  const after = await (await request.get(api('/provider/status'))).json()
  const livePath = String(after.bridge?.piAiPath ?? '')
  expect(livePath).toContain('/vendor/pi-ai/')
  expect(existsSync(livePath)).toBe(true)
})

test('重装（包目录整个换掉、vendor 清空）后不重启：目录自愈 + 状态页提示重启', async ({ request }) => {
  // 模拟插件管理器换包目录：新装进来的那份没有 vendor/。进程不重启，跑的还是内存里那份代码。
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-plugin-fresh-'))
  cpSync(PLUGIN_DIR, fresh, {
    recursive: true,
    filter: (src) => !src.includes(`${join('vendor')}`),
  })
  rmSync(PLUGIN_DIR, { recursive: true, force: true })
  cpSync(fresh, PLUGIN_DIR, { recursive: true })
  rmSync(fresh, { recursive: true, force: true })
  expect(existsSync(join(PLUGIN_DIR, 'lib', 'index.js'))).toBe(true)
  expect(existsSync(join(PLUGIN_DIR, 'vendor', 'pi-ai'))).toBe(false)

  // 进程没重启：桥接还挂着（内存里那份），实例还活着
  const status = await (await request.get(api('/provider/status'))).json()
  expect(status.bridge?.active).toBe(true)

  // ① 自愈：预设与模型目录退回宿主那棵树读，而不是一片空白
  const presets = await (await request.get(api('/provider/presets'))).json()
  expect((presets.presets ?? []).length).toBeGreaterThan(MIN_PRESETS)
  const models = await (await request.get(api('/provider/models'))).json()
  expect((models.models ?? []).length).toBeGreaterThan(MIN_MODELS)

  // ② 报出来：运行中那份 pi-ai 的目录已经在盘上消失，重启 dsh 才能恢复一致
  const drift = status.bridge?.piAiDrift
  expect(drift).toBeDefined()
  expect(String(drift.stalePath)).toContain('/vendor/pi-ai/')
  expect(existsSync(String(drift.stalePath))).toBe(false)
  // 退回去读的那份得是真实存在的目录（否则「自愈」只是换了个空目录）
  expect(existsSync(String(drift.livePath))).toBe(true)
})
