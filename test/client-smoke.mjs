/**
 * 浏览器端的离线冒烟测试：用假 __ModuleLoader__ + 桩 react + 桩 ctx，
 * 验证 apply() 的接线段（注册了哪些槽位、id、组件是不是函数）。
 * 真正的 UI 行为要在浏览器里看。
 *
 *   node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { applyProviderOp as hostApplyProviderOp, parseProviderOp as hostParseProviderOp, providerStoreStatus } from '../lib/provider-config.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      captured = config
    },
  },
}

// 桩 react：组件定义阶段只会引用这些名字，不真的渲染
const reactStub = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'createElement') return (type, props, ...children) => ({ type, props, children })
    if (prop === 'useState') return (initial) => [initial, () => {}]
    if (prop === 'useRef') return () => ({ current: null })
    if (prop === 'useMemo') return (fn) => fn()
    if (prop === 'useCallback') return (fn) => fn
    return () => {}
  },
})

// 执行脚本本体（它自己调 window.__ModuleLoader__.load）
new Function('window', 'document', 'fetch', 'setInterval', source)(
  globalThis.window,
  { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
  () => Promise.reject(new Error('smoke test 不发请求')),
  () => 0,
)

const moduleExports = captured.factory((name) => (name === 'react' ? reactStub : {}))

/** 跑一次 apply，可用 commandDuplicate 模拟「官方 /model 命令还在」的场景。 */
function runApply(commandDuplicate) {
  const registrations = []
  const slotInjects = []
  const injectedServices = []
  const contributions = []
  let commandRegistered = false

  const effect = (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  }
  // 桩：sessions 服务。只有一个会话是「寻址到子代理」的，用来验 /model 的 available 过滤。
  const sessions = {
    subagentAddress(id) {
      return id === 'subagent-1' ? { parentId: 'root-1' } : undefined
    },
  }
  const scope = {
    effect,
    slots: {
      inject(name, callback) {
        slotInjects.push(name)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    inject(names, callback) {
      injectedServices.push(names.join(','))
      if (names.includes('commandUi')) {
        callback({
          commandUi: {
            register(contribution) {
              if (commandDuplicate) throw new Error('ui-commands: duplicate contribution for /model')
              commandRegistered = true
              contributions.push(contribution)
              return () => {}
            },
          },
          effect,
        })
      }
      if (names.includes('modelDirectories')) {
        // 桩：官方目录服务。组件不在这里渲染，只要求注册期拿得到 directoryFor 形状。
        callback({
          modelDirectories: {
            directoryFor: () => ({
              store: { getSnapshot: () => ({ current: null, groups: [], status: 'idle' }) },
              load: () => Promise.resolve(),
              select: () => Promise.resolve(),
            }),
          },
          slots: scope.slots,
          effect,
        })
      }
    },
  }
  // 真机上的 ctx 是 cordis 代理：取没 inject 的服务属性直接抛
  // （"cannot get property \"styles\" without inject"）。桩必须照这个行为来，否则
  // 「把 ctx.styles 的读取挪到 try 外面」这种改动测不出来——那一抛会让整个插件加载失败。
  const ctx = { effect, slots: scope.slots, inject: scope.inject, sessions }
  Object.defineProperty(ctx, 'styles', {
    get() {
      throw new Error('cannot get property "styles" without inject')
    },
  })
  moduleExports.apply(ctx)
  return { registrations, slotInjects, injectedServices, commandRegistered, contributions }
}

// 场景 1：官方 /model 还在（同名注册会抛）——插件必须静默让位，其余座位照常
const duplicated = runApply(true)
// 场景 2：官方行被禁用（名字空出来）——我们的 /model 应该注册成功
const free = runApply(false)

const registrations = duplicated.registrations
const slotInjects = duplicated.slotInjects
const injectedServices = duplicated.injectedServices

console.log('loader id:', captured.id)
console.log('exports:', Object.keys(moduleExports).join(', '))
console.log('inject:', JSON.stringify(moduleExports.inject))
console.log('slots.inject 调用:', slotInjects.join(' | '))
console.log('ctx.inject 调用:', injectedServices.join(' | '))
console.log('注册的座位:')
for (const registration of registrations) {
  const { name, id, order, priority, label } = registration.options
  console.log(`  - ${name} (id=${String(id)}, order=${String(order)}, priority=${String(priority)}, label=${typeof label === 'function' ? label() : String(label)}) component=${typeof registration.component}`)
  if (typeof registration.component !== 'function') throw new Error(`${name} 的组件不是函数`)
}

const expected = ['conversation.input.model', 'settings.section']
for (const name of expected) {
  if (!registrations.some((r) => r.options.name === name)) {
    throw new Error(`没有注册预期的座位：${name}`)
  }
}
const seat = registrations.find((r) => r.options.name === 'conversation.input.model')
if (typeof seat.component !== 'function') throw new Error('模型座位组件不可用')
// 座位靠 priority 遮蔽官方占用者（官方用默认 0），必须是负值
if (!(typeof seat.options.priority === 'number' && seat.options.priority < 0)) {
  throw new Error(`模型座位没有设置遮蔽用的负 priority：${String(seat.options.priority)}`)
}

// 命令注册的两条路径
if (duplicated.commandRegistered) throw new Error('官方 /model 还在时不该抢注册')
if (!free.commandRegistered) throw new Error('官方行禁用后我们的 /model 应该注册成功')

// 命令贡献必须带官方契约必填的 available（issue #7）：CommandUiRuntime.candidates() 对注册表里
// 每一条贡献都直接调它，漏了就是 TypeError，整个 `/` 候选列表（含 composer 的「＋」按钮）一起挂。
const contribution = free.contributions[0]
if (contribution === undefined) throw new Error('没有捕获到 /model 命令贡献')
console.log('命令贡献:', JSON.stringify({
  name: contribution.name,
  hasAvailable: typeof contribution.available === 'function',
  uiKind: contribution.ui && contribution.ui.kind,
}))
if (typeof contribution.available !== 'function') throw new Error('命令贡献缺 available（官方契约必填，漏了整个 / 菜单会挂）')
if (contribution.available({ sessionId: 'session-1' }) !== true) throw new Error('普通会话里 /model 应当可用')
if (contribution.available({ sessionId: 'subagent-1' }) !== false) throw new Error('寻址到子代理的会话里 /model 应当不可用')
if (contribution.available(undefined) !== true) throw new Error('没有会话上下文时不该把 /model 藏掉（照可用处理）')

// ---- 「pi-ai 桥接」标签页的明细行（纯函数，不渲染）----
const { mergeRequestOf, routeClearedFields, routeProfileOf, routeRepairOf, authEntryOf, piAiBridgeRows, piAiUpstreamText, reasoningTextOf, defaultEffortOf, normalizeSelection, effortRowDisabled, parseOauthFrame, isSafeBlankPrompt, dotClass, refreshable, headlineChips, resetCountdownText, modelVisible } = moduleExports
let failures = 0
function rowsCheck(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

const healthy = piAiBridgeRows(
  { active: true, piAiVersion: '0.85.1', source: 'dependency', rejected: [] },
  { latest: '0.85.1', lastCheck: new Date().toISOString() },
)
rowsCheck('健康的桥接只出一行版本', healthy.length === 1)
rowsCheck('版本行带来源档位', healthy[0].value === '0.85.1（兜底依赖）')
rowsCheck('版本行带来源说明', typeof healthy[0].title === 'string' && healthy[0].title.length > 0)

const fellBack = piAiBridgeRows(
  { active: true, piAiVersion: '0.85.1', source: 'dependency', rejected: [{ version: '0.86.0', error: '不提供导出 createModels' }] },
  { latest: '0.86.0' },
)
const skipRow = fellBack.find((r) => r.key === 'skip-0')
rowsCheck('被跳过的版本单列一行', skipRow !== undefined)
rowsCheck('跳过行带警告色', skipRow.warn === true)
rowsCheck('跳过行把原因挂在 title 上', skipRow.title === '不提供导出 createModels')

const pending = piAiBridgeRows(
  { active: true, piAiVersion: '0.85.1', source: '0.85.1' },
  { latest: '0.86.0', pending: '0.86.0' },
)
rowsCheck('待生效版本提示重启', pending.some((r) => r.key === 'pending' && r.text.indexOf('重启 dsh') !== -1))
rowsCheck('已下载档标成「已下载」', pending[0].value === '0.85.1（已下载）')

const rejectedByUpdater = piAiBridgeRows(
  { active: true, piAiVersion: '0.85.1', source: '0.85.1' },
  { latest: '0.87.0', rejected: { version: '0.87.0', error: '子路径没了' } },
)
rowsCheck('体检没过的那版也列出来', rejectedByUpdater.some((r) => r.key === 'rejected' && r.title === '子路径没了'))

const broken = piAiBridgeRows({ active: false, error: '没有能用的 pi-ai：…' }, undefined)
rowsCheck('桥接挂掉时只报错误行', broken.length === 1 && broken[0].bad === true)
rowsCheck('没有 bridge 时不出行', piAiBridgeRows(undefined, undefined).length === 0)

// ---- OAuth 体检行（原版 dsh 不挂 authorization 服务，这行是用来看「为什么没有 OAuth 入口」的）----
const oauthOk = piAiBridgeRows({ active: true, piAiVersion: '0.85.1', source: 'dsh' }, undefined, { available: true, flows: 38 })
rowsCheck('OAuth 可用时报条数', oauthOk.some((r) => r.key === 'oauth-ok' && r.value === '38 个登录方式'))
const oauthOff = piAiBridgeRows({ active: true, piAiVersion: '0.85.1', source: 'dsh' }, undefined, { available: false, flows: 0 })
const offRow = oauthOff.find((r) => r.key === 'oauth-off')
rowsCheck('服务没挂上时报警告行', offRow !== undefined && offRow.warn === true)
rowsCheck('服务没挂上时给原因', offRow !== undefined && typeof offRow.title === 'string' && offRow.title.indexOf('dsh-authorization') !== -1)
const oauthEmpty = piAiBridgeRows({ active: true, piAiVersion: '0.85.1', source: 'dsh' }, undefined, { available: true, flows: 0 })
rowsCheck('服务在但没 flow 时另说一种原因', oauthEmpty.some((r) => r.key === 'oauth-empty' && r.warn === true))
rowsCheck('不给 oauth 段就不出行', healthy.every((r) => String(r.key).indexOf('oauth') !== 0))

// ---- 配置写入现状（两代宿主的写入口不同，出问题先看这一行）----
const storeRow = (store) => piAiBridgeRows({ active: true, piAiVersion: '0.86.0', source: '0.86.0' }, undefined, undefined, store)
const editorStore = storeRow({ mode: 'own', ownCount: 3, legacyCount: 5, via: 'config-editor', lastError: null, warnings: [], legacyNs: 'llm-pi-ai' })
const storeLine = editorStore.find((r) => r.key === 'store')
rowsCheck('出配置写入那一行', storeLine !== undefined)
rowsCheck('写出走的是哪条路（0.2.x → configEditor）', storeLine.value.indexOf('configEditor') !== -1)
rowsCheck('写出来源与条数', String(storeLine.title).indexOf('本插件条目') !== -1 && String(storeLine.title).indexOf('自带条目 3') !== -1)
rowsCheck('0.1.x 的形状也认（settings.mutate）',
  storeRow({ mode: 'legacy', ownCount: 0, legacyCount: 5, via: 'settings-mutate' }).find((r) => r.key === 'store').value.indexOf('settings.mutate') !== -1)
rowsCheck('还没写过时不硬说走了哪条',
  storeRow({ mode: 'builtin', ownCount: 0, legacyCount: 0, via: null }).find((r) => r.key === 'store').value === '还没写过')
rowsCheck('上次写失败要报警告行',
  storeRow({ mode: 'legacy', ownCount: 0, legacyCount: 1, via: null, lastError: '两条路都不通' }).some((r) => r.key === 'store-err' && r.warn === true))
rowsCheck('读来源的告警也列出来',
  storeRow({ mode: 'builtin', ownCount: 0, legacyCount: 0, warnings: ['settings.get 读失败'] }).some((r) => String(r.key).indexOf('store-warn') === 0))
rowsCheck('不给 providerStore 段就不出这行',
  piAiBridgeRows({ active: true, piAiVersion: '0.86.0', source: '0.86.0' }, undefined).every((r) => r.key !== 'store'))
// 上面的 store 是测试自己捏的。真正断过一次的是「宿主 payload 里没有这个字段」：
// 客户端读 status.providerStore，宿主 /provider/status 却没拼它，两边各自的测试都过得去。
// 所以这里拿宿主真正产出的那份（providerStoreStatus）喂进来。
const hostStore = providerStoreStatus(
  { providers: {}, ownCount: 4, legacyCount: 6, builtinCount: 1, mode: 'own', legacySource: 'loader', warnings: [] },
  { via: 'config-editor' },
  'dsh-llm-provider',
)
const hostRow = storeRow(hostStore).find((r) => r.key === 'store')
rowsCheck('宿主真产出的 providerStore 能渲染出这一行', hostRow !== undefined)
rowsCheck('宿主真产出的那份也读得出走的是哪条路', hostRow !== undefined && hostRow.value.indexOf('configEditor') !== -1)
// 桥接胶水层那一行：跑的是哪份官方 bundle（app.asar / CLI 安装树 / profile），版本可能不同、
// 模型 id 也跟着不同——这是排查「模型怎么突然对不上」的第一眼信息
const glueRows = piAiBridgeRows({ active: true, piAiVersion: '0.87.1', source: 'dsh', bundleVersion: '0.2.0-rc.2', bundleTree: 'app.asar' }, undefined)
const glueLine = glueRows.find((r) => r.key === 'glue')
rowsCheck('报出桥接胶水层那一行', glueLine !== undefined)
rowsCheck('胶水层带上版本与来自哪棵树',
  glueLine !== undefined && glueLine.value.indexOf('0.2.0-rc.2') !== -1 && glueLine.value.indexOf('app.asar') !== -1)
rowsCheck('没有胶水层字段时不出这行（老宿主/读不到）',
  piAiBridgeRows({ active: true, piAiVersion: '0.86.0', source: '0.86.0' }, undefined).every((r) => r.key !== 'glue'))
rowsCheck('宿主真产出的那份也读得出条数',
  hostRow !== undefined && String(hostRow.title).indexOf('自带条目 4') !== -1 && String(hostRow.title).indexOf('老段 6') !== -1)

// ---- 写路由的请求体：界面发出的包必须被宿主认出来 ----
// 界面与宿主各测各的一半时，字段名对不上（少带 unsets、op 拼错）两边都是绿的。
const mergeBody = mergeRequestOf('github-copilot', { api: 'openai-responses' }, [])
rowsCheck('不带要删的字段时 body 里就没有 unsets', mergeBody.op === 'merge' && mergeBody.unsets === undefined)
const oauthBody = mergeRequestOf('github-copilot', {}, routeClearedFields(true))
rowsCheck('OAuth 走完要显式删 apiKeyEnv（逐字段合并下省略不等于删）',
  JSON.stringify(oauthBody.unsets) === '["apiKeyEnv"]')
rowsCheck('走密钥那条路不带 unsets', mergeRequestOf('x', { apiKeyEnv: 'K' }, routeClearedFields(false)).unsets === undefined)
// 真把界面这个包喂给宿主的解析 + 应用：老配置里的 apiKeyEnv 必须消失，其它字段一个不动
const hostOp = hostParseProviderOp(oauthBody)
rowsCheck('宿主解析得了界面发来的包', hostOp !== undefined && hostOp.op === 'merge')
const applied = hostApplyProviderOp({ 'github-copilot': { apiKeyEnv: 'GITHUB_COPILOT_API_KEY', retryPolicy: { maxRetries: 3 } } }, hostOp)
rowsCheck('合并后老 apiKeyEnv 被删掉', applied['github-copilot'].apiKeyEnv === undefined)
rowsCheck('同一条路由的其它字段留着', applied['github-copilot'].retryPolicy.maxRetries === 3)

// ---- 不带百分比的窗口（Copilot 的「不限量」）也要出 chip，不能整条消失 ----
const unlimitedChips = headlineChips({
  id: 'github-copilot', displayName: 'GitHub Copilot', kind: 'quota', authConfigured: true,
  balances: [], windows: [
    { window: '高级请求', limit: 300, remaining: 300, percentLeft: 100, resetAt: '2026-10-01' },
    { window: '对话', note: '不限量' },
  ],
})
rowsCheck('不限量窗口出 chip', unlimitedChips.some((c) => c.label === '对话' && c.text === '不限量'))
rowsCheck('不限量 chip 不带百分比（不参与配色）', unlimitedChips.find((c) => c.label === '对话').percent === undefined)
rowsCheck('真额度窗口照旧带百分比', unlimitedChips.some((c) => c.label === '高级请求' && c.text === '100%'))

// ---- 三档窗口：短名与分割线（issue #2 把月窗显示成第二个 7d，#8 三档只画一条线）----
const { shortWindowLabel, windowTier, quotaTipOf } = moduleExports
rowsCheck('5 小时窗口 → 5h', shortWindowLabel('5 小时滚动窗口') === '5h')
rowsCheck('每周窗口 → 7d', shortWindowLabel('每周窗口') === '7d')
rowsCheck('每月窗口 → 30d（不再被裸「每」吞进 7d）', shortWindowLabel('每月窗口') === '30d')
rowsCheck('月度限额 → 30d', shortWindowLabel('月度限额') === '30d')
rowsCheck('30 天窗口 → 30d（kimi 的按天口径）', shortWindowLabel('30 天窗口') === '30d')
rowsCheck('每天窗口不算 30d', shortWindowLabel('每天窗口') !== '30d')
// 适配器的窗口名是拼出来的（kimi `${n} 天窗口`、GLM `${n} 小时窗口`）：时长要读进去，
// 否则这些全落进「认不出」那一档，7 天窗口会被排到 30 天窗口后面（复查抓到的回归）
rowsCheck('7 天窗口 → 7d 档、短名 7d', windowTier('7 天窗口') === '7d' && shortWindowLabel('7 天窗口') === '7d')
rowsCheck('7 小时窗口归短窗档，但短名照抄时长（7h）', windowTier('7 小时窗口') === '5h' && shortWindowLabel('7 小时窗口') === '7h')
rowsCheck('24 小时窗口不塞进周档，短名 24h', windowTier('24 小时窗口') === 'other' && shortWindowLabel('24 小时窗口') === '24h')
rowsCheck('3 天窗口 → 7d 档', windowTier('3 天窗口') === '7d')
rowsCheck('认不出的窗口名（unit= 那种）不误判', windowTier('窗口 unit=3 n=7') === 'other')
const kimiChips = headlineChips({
  id: 'kimi-coding', kind: 'quota', windows: [
    { window: '5 小时窗口', percentLeft: 50 },
    { window: '7 天窗口', percentLeft: 49 },
    { window: '30 天窗口', percentLeft: 48 },
  ],
})
rowsCheck('kimi 的 5h/7天/30天 按档排序、两条线',
  kimiChips.map((c) => (c.sep === true ? '|' : c.label)).join(' ') === '5h | 7d | 30d')
rowsCheck('Monthly → 30d', shortWindowLabel('Monthly window') === '30d')
rowsCheck('Weekly → 7d', shortWindowLabel('Weekly window') === '7d')
rowsCheck('认不出的窗口名保持原样（截 4 字）', shortWindowLabel('高级请求') === '高级请求')
rowsCheck('空名字给「窗口」', shortWindowLabel('') === '窗口')
rowsCheck('档位函数与短名一致', windowTier('每月窗口') === '30d' && windowTier('每周窗口') === '7d')

const threeTier = headlineChips({
  id: 'opencode-go', displayName: 'OpenCode Go', kind: 'quota', authConfigured: true,
  balances: [], windows: [
    { window: '5 小时滚动窗口', percentLeft: 100, resetAt: '2026-10-01T00:00:00Z' },
    { window: '每周窗口', percentLeft: 65, resetAt: '2026-10-04T00:00:00Z' },
    { window: '每月窗口', percentLeft: 8, resetAt: '2026-10-07T00:00:00Z' },
  ],
})
rowsCheck('三档窗口出三枚 chip + 两条分割线',
  threeTier.filter((c) => c.sep !== true).length === 3 && threeTier.filter((c) => c.sep === true).length === 2)
rowsCheck('chips 顺序固定为 5h → 7d → 30d',
  threeTier.filter((c) => c.sep !== true).map((c) => c.label).join(',') === '5h,7d,30d')
rowsCheck('分割线插在档与档之间（不是末尾）',
  threeTier.map((c) => (c.sep === true ? '|' : c.label)).join(' ') === '5h | 7d | 30d')
rowsCheck('月窗的 tooltip 也是 30d', String(quotaTipOf({
  id: 'opencode-go', kind: 'quota', windows: [{ window: '每月窗口', percentLeft: 8, resetAt: '2026-10-07T00:00:00Z' }],
})).indexOf('30d余量 8%') === 0)

// 上游把月窗排在前面时，显示顺序要按档位规整，分割线位置不跟着跳
const shuffled = headlineChips({
  id: 'opencode-go', kind: 'quota', windows: [
    { window: '每月窗口', percentLeft: 8 },
    { window: '5 小时滚动窗口', percentLeft: 100 },
    { window: '每周窗口', percentLeft: 65 },
  ],
})
rowsCheck('乱序返回也规整成 5h → 7d → 30d',
  shuffled.map((c) => (c.sep === true ? '|' : c.label)).join(' ') === '5h | 7d | 30d')

// 只有两档时仍是一条线（保持视觉不变）
const twoTier = headlineChips({
  id: 'deepseek', kind: 'quota', windows: [
    { window: '5 小时滚动窗口', percentLeft: 90 },
    { window: '每周窗口', percentLeft: 40 },
  ],
})
rowsCheck('两档窗口仍是一条分割线', twoTier.filter((c) => c.sep === true).length === 1)
rowsCheck('只有一档时不画线', headlineChips({
  id: 'deepseek', kind: 'quota', windows: [{ window: '每周窗口', percentLeft: 40 }],
}).filter((c) => c.sep === true).length === 0)

// ---- 磁盘占用行（issue #4：代码 220 KB、运行副本 260 MB，界面得看得见、清得掉）----
const { piAiStorageRows, formatBytes } = moduleExports
rowsCheck('字节人性化：MB', formatBytes(82 * 1024 * 1024) === '82 MB')
rowsCheck('字节人性化：GB', formatBytes(1.5 * 1024 * 1024 * 1024) === '1.5 GB')
rowsCheck('0 字节不显示成 0 B', formatBytes(0) === '0 MB')
const storageRows = piAiStorageRows({
  vendorBytes: 260 * 1024 * 1024,
  downloads: [{ version: '0.85.1', bytes: 82 * 1024 * 1024 }],
  cacheBytes: 178 * 1024 * 1024,
  legacyCacheBytes: 0,
})
rowsCheck('占用行给总量', storageRows[0].key === 'disk' && storageRows[0].value === '260 MB')
rowsCheck('占用行的 title 列出已下载版本', String(storageRows[0].title).indexOf('0.85.1 82 MB') !== -1)
rowsCheck('缓存行单列', storageRows.some((r) => r.key === 'disk-cache' && r.value === '178 MB'))
rowsCheck('没有缓存就不出缓存行',
  piAiStorageRows({ vendorBytes: 1024, downloads: [], cacheBytes: 0, legacyCacheBytes: 0 }).length === 1)
rowsCheck('老缓存（插件目录里那份）也算进缓存行',
  piAiStorageRows({ vendorBytes: 1024, downloads: [], cacheBytes: 0, legacyCacheBytes: 5 * 1024 * 1024 })[1].value === '5 MB')
rowsCheck('拿不到 storage 段就不出占用行', piAiStorageRows(undefined).length === 0)
rowsCheck('上游行文字', piAiUpstreamText({ latest: '0.86.0' }).indexOf('上游 0.86.0') === 0)

// ---- 删除确认的代价说明（issue #3：整段 route + 凭据一起没，且不可撤销）----
const { deleteConfirmText } = moduleExports
const delText = deleteConfirmText({ id: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY' })
rowsCheck('确认文案点名路由', delText.indexOf('路由 opencode-go') !== -1)
rowsCheck('确认文案点名凭据', delText.indexOf('OPENCODE_GO_API_KEY') !== -1)
rowsCheck('确认文案说明不可撤销', delText.indexOf('不可撤销') !== -1)
rowsCheck('确认文案提到手写配置会消失', delText.indexOf('retryPolicy') !== -1)
rowsCheck('没有凭据名时不硬凑', deleteConfirmText({ id: 'deepseek' }).indexOf('凭据') === -1)

// ---- 添加供应商的「别整段覆盖」保证已搬到宿主（src/provider-config.ts 的 applyProviderOp）----
// 客户端现在只发 { routeId, op: 'merge', value }，逐字段合并由宿主做；测试见 test/provider-config.mjs

// ---- 模型清单编辑器（issue #1：官方 Models 页禁用后，逐模型参数得有条界面上的路）----
const { editorRowsOf, editorToModels, parseReasoningEfforts, formatReasoningEfforts, buildDetailMap } = moduleExports
const catalogFixture = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', contextWindow: 200000 },
]
// 详情表按 `provider + id` 建（真实的客户端就是这么拿的）：用裸 id 当 fixture 会把
// 「同名模型跨 provider」这类问题掩盖掉（复查抓到过这一点）
const detailFixture = buildDetailMap([
  { id: 'deepseek-v4-flash', provider: 'deepseek', contextWindow: 1000000, maxTokens: 32768, vision: false, reasoning: true, thinkingLevels: ['low', 'high'], capabilitiesKnown: true },
  { id: 'deepseek-v4-flash-vision-exp', provider: 'deepseek', contextWindow: 200000, maxTokens: 8192, vision: true, reasoning: false, thinkingLevels: [], capabilitiesKnown: true },
])
const catalogRows = editorRowsOf(undefined, catalogFixture, detailFixture, 'deepseek')
rowsCheck('没声明清单时铺开目录里的模型', catalogRows.length === 2 && catalogRows.every((r) => r.source === 'catalog' && r.enabled === true))
rowsCheck('目录行的上下文从目录带出来', catalogRows[0].contextWindow === '1000000')
rowsCheck('目录行的最大输出从详情带出来', catalogRows[0].maxTokens === '32768')
rowsCheck('目录行的输入模态按视觉能力填', catalogRows[1].input.join(',') === 'text,image')
rowsCheck('目录行的推理字段留空（表示沿用目录）', catalogRows[0].reasoning === '')
rowsCheck('目录行标成「能力查到了」', catalogRows.every((r) => r.inputKnown === true))
// 详情晚到/查不到时不能把占位的 ['text'] 当结论写进配置
const unknownRows = editorRowsOf(undefined, catalogFixture, undefined, 'deepseek')
rowsCheck('没有详情时目录行标成「能力未知」', unknownRows.every((r) => r.inputKnown === false))
const unknownBuilt = editorToModels(unknownRows)
rowsCheck('能力未知的目录行不写 input（免得盖掉目录里的视觉能力）',
  unknownBuilt.models.every((m) => m.input === undefined))
const knownBuilt = editorToModels(catalogRows)
rowsCheck('能力查到的目录行照常写 input', knownBuilt.models[1].input.join(',') === 'text,image')

const declaredFixture = [
  { id: 'deepseek-flash', name: '自定义 Flash', contextWindow: 128000, maxTokens: 4096, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'max' }, compat: { thinkingFormat: 'deepseek' } },
  'plain-id',
]
const declaredRows = editorRowsOf(declaredFixture, catalogFixture, detailFixture, 'opencode-go')
rowsCheck('声明了清单就以它为准', declaredRows.length === 2 && declaredRows.every((r) => r.source === 'declared'))
rowsCheck('声明行的字段原样回显', declaredRows[0].id === 'deepseek-flash' && declaredRows[0].contextWindow === '128000' && declaredRows[0].thinkingFormat === 'deepseek')
rowsCheck('reasoningEfforts 对象映射成文本记法', declaredRows[0].reasoning === 'low,high=max')
rowsCheck('字符串条目也认（等价于只有 id）', declaredRows[1].id === 'plain-id')
rowsCheck('声明行没写 input 时回落到目录那份', declaredRows[1].input.join(',') === 'text')
rowsCheck('目录里没有的自定义 id 输入模态兜底 text', declaredRows[0].input.join(',') === 'text,image')
rowsCheck('声明行不许出现 video（宿主 schema 只认 text/image）',
  editorRowsOf([{ id: 'x', input: ['text', 'video'] }], [], undefined, 'r')[0].input.join(',') === 'text')

const reasoningCases = [
  ['', undefined, undefined],
  ['false', false, undefined],
  ['关闭', false, undefined],
  ['low', { low: 'low' }, undefined],
  ['low,high=max', { low: 'low', high: 'max' }, undefined],
  ['off,low', { off: null, low: 'low' }, undefined],
  ['bogus', undefined, 'error'],
  ['off', false, undefined],
  ['high=', undefined, 'error'],
]
for (const [text, value, error] of reasoningCases) {
  const parsed = parseReasoningEfforts(text)
  rowsCheck('思考档位解析「' + text + '」',
    (error === 'error' ? typeof parsed.error === 'string' : JSON.stringify(parsed.value) === JSON.stringify(value)))
}
rowsCheck('反向：对象映射 → 文本', formatReasoningEfforts({ low: 'low', high: 'max' }) === 'low,high=max')
rowsCheck('反向：false → false', formatReasoningEfforts(false) === 'false')
rowsCheck('反向：缺省 → 空', formatReasoningEfforts(undefined) === '')

const built = editorToModels([
  { key: 'a', id: 'deepseek-flash', name: 'Flash', contextWindow: '128000', maxTokens: '4096', input: ['text', 'image'], inputKnown: true, inputTouched: false, reasoning: 'low,high=max', thinkingFormat: 'deepseek', enabled: true, source: 'declared' },
  { key: 'b', id: 'unchecked', name: '', contextWindow: '', maxTokens: '', input: ['text'], inputKnown: true, inputTouched: false, reasoning: '', thinkingFormat: '', enabled: false, source: 'catalog' },
])
rowsCheck('只写勾选的行', built.models.length === 1 && built.models[0].id === 'deepseek-flash')
rowsCheck('写出的数字是数字', built.models[0].contextWindow === 128000 && built.models[0].maxTokens === 4096)
rowsCheck('写出的 input 是数组', built.models[0].input.join(',') === 'text,image')
rowsCheck('写出的 thinkingFormat 在 compat 里', built.models[0].compat.thinkingFormat === 'deepseek')
rowsCheck('勾选行没有错误', built.errors.length === 0)
rowsCheck('用户动过勾选就按用户的写（即使能力没查到）',
  editorToModels([{ key: 'a', id: 'x', name: '', contextWindow: '', maxTokens: '', input: ['text'], inputKnown: false, inputTouched: true, reasoning: '', thinkingFormat: '', enabled: true, source: 'declared' }]).models[0].input.join(',') === 'text')
// 两种模态都取消：宿主把空数组当「沿用目录」，不能静默写一个 ['text'] 把视觉能力钉死
const noneInput = editorToModels([{ key: 'a', id: 'x', name: '', contextWindow: '', maxTokens: '', input: [], inputKnown: true, inputTouched: true, reasoning: '', thinkingFormat: '', enabled: true, source: 'declared' }])
rowsCheck('模态一个都不选时报错而不是写 text', noneInput.errors.some((e) => e.indexOf('输入模态') !== -1))
rowsCheck('报错时不产出 input 字段', noneInput.models[0].input === undefined)

const badRows = editorToModels([
  { key: 'a', id: '', name: '', contextWindow: '', maxTokens: '', input: ['text'], inputKnown: true, inputTouched: false, reasoning: '', thinkingFormat: '', enabled: true, source: 'declared' },
  { key: 'b', id: 'dup', name: '', contextWindow: 'x', maxTokens: '', input: ['text'], inputKnown: true, inputTouched: false, reasoning: 'nope', thinkingFormat: '', enabled: true, source: 'declared' },
  { key: 'c', id: 'dup', name: '', contextWindow: '', maxTokens: '', input: ['text'], inputKnown: true, inputTouched: false, reasoning: '', thinkingFormat: '', enabled: true, source: 'declared' },
])
rowsCheck('空 id 报错', badRows.errors.some((e) => e.indexOf('模型 ID 是空的') !== -1))
rowsCheck('非正整数报错', badRows.errors.some((e) => e.indexOf('正整数') !== -1))
rowsCheck('坏档位报错', badRows.errors.some((e) => e.indexOf('思考档位') !== -1))
rowsCheck('重名报错', badRows.errors.some((e) => e.indexOf('重复') !== -1))

// 面板本体：直接当函数组件调一次（桩 react 的 createElement 只组装树），把展开分支也跑到
const { ModelListEditor } = moduleExports
function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node === 'object') {
    // 输入框的内容挂在 props.value 上（不是 children），测试要能一起看到
    const own = typeof node.props?.value === 'string' ? node.props.value + ' ' : ''
    return own + (node.children === undefined ? '' : collectText(node.children))
  }
  return ''
}
const closedEditor = collectText(ModelListEditor({ routeId: 'deepseek', catalog: catalogFixture, detailsById: detailFixture }))
rowsCheck('编辑器收起时只出一行状态 + 按钮', closedEditor.indexOf('跟随目录（2 个）') !== -1 && closedEditor.indexOf('编辑清单') !== -1)
const openEditor = collectText(ModelListEditor({ routeId: 'deepseek', catalog: catalogFixture, detailsById: detailFixture, defaultOpen: true }))
rowsCheck('展开后给出保存/还原/添加', openEditor.indexOf('保存') !== -1 && openEditor.indexOf('还原') !== -1 && openEditor.indexOf('添加一行') !== -1)
rowsCheck('展开后回显目录模型', openEditor.indexOf('deepseek-v4-flash') !== -1)
rowsCheck('展开后显示勾选计数', openEditor.indexOf('2/2 个模型已勾选') !== -1)
const declaredEditor = collectText(ModelListEditor({ routeId: 'opencode-go', declared: declaredFixture, catalog: catalogFixture, detailsById: detailFixture, defaultOpen: true }))
rowsCheck('声明过清单时给「恢复跟随目录」出口', declaredEditor.indexOf('恢复跟随目录') !== -1)
rowsCheck('声明过清单时状态行说是自己声明的', declaredEditor.indexOf('自己声明的 2 个') !== -1)
rowsCheck('声明行的字段出现在面板里', declaredEditor.indexOf('deepseek-flash') !== -1 && declaredEditor.indexOf('low,high=max') !== -1)

// ---- 能力详情按 provider + id 建索引（issue #5：裸 id 会让同名模型串家）----
const { detailOf, detailSourceLabel } = moduleExports
const detailPayload = [
  { id: 'claude-opus-5', provider: 'anthropic', vision: true, source: 'catalog' },
  { id: 'claude-opus-5', provider: 'cloudflare-ai-gateway', vision: false, source: 'catalog' },
  { id: 'deepseek-flash', provider: 'opencode-go', vision: true, source: 'route' },
  { id: 'only-here', provider: 'solo', vision: true, source: 'adapter' },
]
const detailMap = buildDetailMap(detailPayload)
rowsCheck('同名模型按 provider 各查各的',
  detailOf(detailMap, 'anthropic', 'claude-opus-5').vision === true
  && detailOf(detailMap, 'cloudflare-ai-gateway', 'claude-opus-5').vision === false)
rowsCheck('自定义 id 在 route 那一份上查得到', detailOf(detailMap, 'opencode-go', 'deepseek-flash').vision === true)
rowsCheck('跨 provider 的同名 id 不互相兜底', detailOf(detailMap, 'opencode-go', 'claude-opus-5') === undefined)
rowsCheck('全局唯一的 id 允许裸兜底', detailOf(detailMap, 'unknown-route', 'only-here').vision === true)
rowsCheck('空表返回 undefined', detailOf(undefined, 'x', 'y') === undefined)
rowsCheck('来源文案三档', detailSourceLabel('route').indexOf('路由声明') === 0
  && detailSourceLabel('catalog') === 'pi-ai 目录'
  && detailSourceLabel('adapter') === '适配器自报')
rowsCheck('认不出的来源不硬编', detailSourceLabel('whatever') === undefined)

// ---- 无额度接口的卡片：状态点不能是黄灯、刷新按钮不该摆 ----
rowsCheck('OAuth 已授权的无额度 provider 用绿灯',
  dotClass({ id: 'github-copilot', authConfigured: true, oauthAuthorized: true, kind: 'unknown-provider' }) === 'plan_dot plan_dot_ok')
rowsCheck('未授权的无额度 provider 仍是黄灯',
  dotClass({ id: 'x', authConfigured: true, kind: 'unknown-provider' }) === 'plan_dot plan_dot_warn')
rowsCheck('没配 key 依旧是黄灯',
  dotClass({ id: 'x', authConfigured: false, kind: 'quota' }) === 'plan_dot plan_dot_warn')
rowsCheck('查询失败是红灯',
  dotClass({ id: 'x', authConfigured: true, kind: 'quota', error: 'boom' }) === 'plan_dot plan_dot_bad')
rowsCheck('无额度接口的 provider 不摆刷新',
  refreshable({ id: 'github-copilot', kind: 'unknown-provider' }) === false)
rowsCheck('qwen 那种看控制台的也不摆刷新',
  refreshable({ id: 'qwen', kind: 'unsupported' }) === false)
rowsCheck('有适配器的摆刷新', refreshable({ id: 'deepseek', kind: 'quota' }) === true)
rowsCheck('查询失败也摆刷新（重试有意义）',
  refreshable({ id: 'deepseek', kind: 'quota', error: 'boom' }) === true)

// ---- 「留空即默认」的提问识别（Copilot 的企业域名；别的提问绝不能自动答）----
rowsCheck('识别 Copilot 企业域名提问（placeholder）',
  isSafeBlankPrompt({ kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)', placeholder: 'company.ghe.com' }) === true)
rowsCheck('识别 Copilot 企业域名提问（只靠文案也能认）',
  isSafeBlankPrompt({ kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' }) === true)
rowsCheck('粘贴回调 URL 的提问不自动答',
  isSafeBlankPrompt({ kind: 'text', message: 'Complete login in your browser, or paste the authorization code / redirect URL here:', placeholder: 'http://127.0.0.1:1455/callback' }) === false)
rowsCheck('select 提问不自动答',
  isSafeBlankPrompt({ kind: 'select', message: 'Select OpenAI Codex login method:', options: [] }) === false)
rowsCheck('secret 提问不自动答',
  isSafeBlankPrompt({ kind: 'secret', message: 'Enter token' }) === false)

// ---- 账号可用清单过滤（Copilot 目录 28 个、账号只有 6 个，选到别处会 400）----
const availFixture = ['gpt-5.4', 'gpt-5-mini']
rowsCheck('清单内的模型可列', modelVisible(availFixture, 'gpt-5.4', false) === true)
rowsCheck('清单外的不列', modelVisible(availFixture, 'gpt-5.6-sol', false) === false)
rowsCheck('当前选中的即使在清单外也列（否则像丢了）', modelVisible(availFixture, 'gpt-5.6-sol', true) === true)
rowsCheck('没有清单时一律可列（api-key 类路由）', modelVisible(undefined, 'any-model', false) === true)
rowsCheck('空清单同样视为不过滤', modelVisible([], 'any-model', false) === true)

// ---- 强制选档：已经勾选的那一档也要能点（它是确认动作，不是空操作）----
rowsCheck('强制选档时勾选那档可点', effortRowDisabled(false, true, true) === false)
rowsCheck('普通换档时勾选那档置灰（点了也是空操作）', effortRowDisabled(false, true, false) === true)
rowsCheck('提交中整面板不可点', effortRowDisabled(true, false, true) === true)
rowsCheck('强制选档时其它档照常可点', effortRowDisabled(false, false, true) === false)

// ---- 认证入口按 flow 的方法分（挂上 authorization 服务后每个 provider 都有 flow）----
// 只有 api-key 方法的 provider（DeepSeek / OpenAI / Moonshot）必须回到密钥输入框：
// dsh 把「让你输密钥」也包装成了一次登录，照「有 flow 就显示 OAuth 按钮」会顶掉密钥框。
const deepseekPreset = { id: 'deepseek', label: 'DeepSeek', oauth: { key: 'llm-pi-ai/deepseek', label: 'DeepSeek', methods: [{ id: 'api-key', label: 'DeepSeek API key' }], inFlight: false } }
const anthropicPreset = { id: 'anthropic', label: 'Anthropic', oauth: { key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }, { id: 'api-key', label: 'Anthropic API key' }], inFlight: false } }
const codexPreset = { id: 'openai-codex', label: 'OpenAI Codex', oauthOnly: true, oauth: { key: 'llm-pi-ai/openai-codex', label: 'OpenAI Codex', methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }], inFlight: false } }
rowsCheck('只有 api-key 方法 → 没有 OAuth 入口', authEntryOf(deepseekPreset).oauth === undefined)
rowsCheck('只有 api-key 方法 → 标记为密钥型', authEntryOf(deepseekPreset).onlyApiKey === true)
rowsCheck('两者都有 → 认出 OAuth 方法', authEntryOf(anthropicPreset).oauth.id === 'oauth')
rowsCheck('OAuth 入口用方法自己的标签（不是 provider 名）', authEntryOf(anthropicPreset).oauth.label === 'Anthropic (Claude Pro/Max)')
rowsCheck('两者都有 → 不算密钥型', authEntryOf(anthropicPreset).onlyApiKey === false)
// 只有 oauth 方法 → onlyApiKey 为 false（这个字段的含义是「只有 api-key 方法」，不是
// 「显示密钥框」）。界面上这条 provider 靠 oauthOnly 藏掉「改用 API 密钥」那条切换：
// 光看 onlyApiKey 会渲染一个点了走不通的死路（测试按钮被 oauthOnly 藏着，添加又要求测试通过）。
rowsCheck('只有 oauth 方法 → 不算密钥型', authEntryOf(codexPreset).onlyApiKey === false)
rowsCheck('没有 flow → 也不是密钥型', authEntryOf({ id: 'x', label: 'X' }).onlyApiKey === false && authEntryOf({ id: 'x', label: 'X' }).oauth === undefined)
rowsCheck('预设为空也不炸', authEntryOf(undefined).oauth === undefined)

// ---- 写进 settings 的路由配置：OAuth 授权过的不带 apiKeyEnv ----
// 官方适配器看到 apiKeyEnv 就只认那个 ref，取不到值直接抛 MISSING_CREDENTIAL——
// 给 OAuth 路由写上它，等于把 OAuth 登录堵死（线上实测踩到）。
const formFixture = { api: 'anthropic-messages', baseURL: ' https://api.individual.githubcopilot.com ', apiKeyEnv: 'GITHUB_COPILOT_API_KEY' }
const oauthProfile = routeProfileOf(formFixture, true, false)
rowsCheck('OAuth 路由不写 apiKeyEnv', oauthProfile.apiKeyEnv === undefined)
rowsCheck('目录里的 provider 不写 api（否则覆盖每个模型的协议）', oauthProfile.api === undefined)
rowsCheck('用户填了地址才写（企业版端点这类覆盖）', oauthProfile.baseURL === 'https://api.individual.githubcopilot.com')
rowsCheck('地址留空就不写 baseURL——写空串等于把端点定成空，回落不到目录',
  routeProfileOf({ ...formFixture, baseURL: '  ' }, false, false).baseURL === undefined)
const keyProfile = routeProfileOf(formFixture, false, false)
rowsCheck('非 OAuth 路由照旧写 apiKeyEnv', keyProfile.apiKeyEnv === 'GITHUB_COPILOT_API_KEY')
rowsCheck('非 OAuth 的目录 provider 也不写 api', keyProfile.api === undefined)
const customProfile = routeProfileOf(formFixture, false, true)
rowsCheck('Custom Gateway 必须写 api（目录里查不到）', customProfile.api === 'anthropic-messages')

// ---- 卡片上「协议/地址写死了」的判定 + 一键修正删哪些字段 ----
// 官方适配器里路由的 api / baseURL 都盖掉每个模型自己的那份；但只有「多协议」或「跟目录不一致」
// 才值得报，别对单协议写对的 provider 白报（用户会去点一个没必要的修正按钮）。
const multi = ['anthropic-messages', 'openai-completions', 'openai-responses']
const single = ['openai-completions']
const catalogUrls = ['https://openrouter.ai/api', 'https://openrouter.ai/api/v1']
rowsCheck('单协议 + 写对了 → 不报', routeRepairOf({ api: 'openai-completions' }, single, ['https://api.deepseek.com']).fields.length === 0)
rowsCheck('没写协议 → 不报', routeRepairOf({}, multi, catalogUrls).fields.length === 0)
rowsCheck('多协议写死了 → 报，先删 api', JSON.stringify(routeRepairOf({ api: 'anthropic-messages' }, multi, catalogUrls).fields) === '["api"]')
rowsCheck('多协议 → 文案走「多协议」那套', routeRepairOf({ api: 'anthropic-messages' }, multi, catalogUrls).multiProtocol === true)
rowsCheck('单协议但写错了 → 报', JSON.stringify(routeRepairOf({ api: 'anthropic-messages' }, single, []).fields) === '["api"]')
rowsCheck('单协议写错 → 文案不说「多协议」', routeRepairOf({ api: 'anthropic-messages' }, single, []).multiProtocol === false)
// 旧版表单会把目录地址写进路由，它同样盖掉模型自己的端点 —— 修正要连它一起删
rowsCheck('配置里的地址是目录端点 → 连 baseURL 一起删',
  JSON.stringify(routeRepairOf({ api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api', baseUrlPinned: true }, multi, catalogUrls).fields) === '["api","baseURL"]')
rowsCheck('用户自己写的地址（企业版端点）→ 只删 api，不动地址',
  JSON.stringify(routeRepairOf({ api: 'anthropic-messages', baseUrl: 'https://api.enterprise.githubcopilot.com', baseUrlPinned: true }, multi, ['https://api.individual.githubcopilot.com']).fields) === '["api"]')
rowsCheck('卡片上那个地址只是目录默认（没钉）→ 不算配置，不用删',
  JSON.stringify(routeRepairOf({ api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api', baseUrlPinned: false }, multi, catalogUrls).fields) === '["api"]')

// ---- 重置倒计时：天数到两位数就只留天数（卡片头部最挤的一段）----
const inFuture = (ms) => new Date(Date.now() + ms).toISOString()
const HOUR = 3600000
rowsCheck('17d10h 只显示天数', resetCountdownText(inFuture(17 * 24 * HOUR + 10 * HOUR)) === '17d')
rowsCheck('10d 出头也只显示天数', resetCountdownText(inFuture(10 * 24 * HOUR + 5 * HOUR)) === '10d')
rowsCheck('9d10h 仍给两个单位', resetCountdownText(inFuture(9 * 24 * HOUR + 10 * HOUR)) === '9d10h')
rowsCheck('4d2h 给两个单位', resetCountdownText(inFuture(4 * 24 * HOUR + 2 * HOUR)) === '4d2h')
rowsCheck('5h33m 给小时+分钟', resetCountdownText(inFuture(5 * HOUR + 33 * 60000)) === '5h33m')
rowsCheck('34m 给分钟', resetCountdownText(inFuture(34 * 60000)) === '34m')
rowsCheck('已过期说即将重置', resetCountdownText(inFuture(-60000)) === '即将重置')
rowsCheck('坏时间不给文案', resetCountdownText('nonsense') === '')

// ---- OAuth SSE 帧解析（EventSource 会剥掉 `data:` 前缀，这里是最容易踩的一处）----
const promptJson = JSON.stringify({ kind: 'prompt', promptId: 'p1', prompt: { kind: 'text', message: 'Enterprise URL/domain' } })
const asGiven = parseOauthFrame(promptJson)
rowsCheck('纯 JSON（onmessage 的实际形态）能解析', asGiven !== undefined && asGiven.kind === 'prompt')
rowsCheck('解析出的 promptId 保留', asGiven !== undefined && asGiven.promptId === 'p1')
rowsCheck('解析出的 prompt 内容保留', asGiven !== undefined && asGiven.prompt.kind === 'text')
const rawFrame = parseOauthFrame('data: ' + promptJson)
rowsCheck('带 data: 前缀的原始帧也认', rawFrame !== undefined && rawFrame.kind === 'prompt')
rowsCheck('retry 指令不是事件', parseOauthFrame('retry: 10000') === undefined)
rowsCheck('注释行不是事件', parseOauthFrame(': keepalive') === undefined)
rowsCheck('空串不是事件', parseOauthFrame('') === undefined)
rowsCheck('坏 JSON 不是事件', parseOauthFrame('{oops') === undefined)
const noticeJson = JSON.stringify({ kind: 'notice', notice: { message: 'go', url: 'https://x/y', code: 'ABCD' } })
const notice = parseOauthFrame(noticeJson)
rowsCheck('notice 解析出 url + code', notice !== undefined && notice.notice.url === 'https://x/y' && notice.notice.code === 'ABCD')
const settledJson = JSON.stringify({ kind: 'settled', status: 'authorized' })
rowsCheck('settled 解析出状态', parseOauthFrame(settledJson) !== undefined && parseOauthFrame(settledJson).status === 'authorized')

rowsCheck('没检查过上游时说「未检查」', piAiUpstreamText(undefined) === '上游 未检查')
rowsCheck('检查过就报版本号', piAiUpstreamText({ latest: '0.86.0', lastCheck: new Date().toISOString() }).indexOf('0.86.0') !== -1)

// ---- 推理等级文案（纯函数，不渲染）----
// 目录收录的是 listProviders 报上来的路由，会话里存着的 provider 可能不在其中（原生路由缺席、
// 模型下线的历史会话）：这时档位表拿不到，但会话已经定下的档位必须照显示，否则整段强度会是空的。
const efforts = { efforts: ['low', 'high', 'max'], default: 'high' }
rowsCheck('会话定了档位就显示该档位', reasoningTextOf('max', efforts, 'high') === 'Max')
rowsCheck('会话没定档位时落目录默认档', reasoningTextOf(undefined, efforts, 'high') === 'High')
rowsCheck('目录没默认档也没档位表时给「Default」', reasoningTextOf(undefined, { efforts: [] }, undefined) === 'Default')
rowsCheck('目录里没有这个模型时照会话档位显示', reasoningTextOf('max', undefined, undefined) === 'Max')
rowsCheck('档位表是 null 也照会话档位显示', reasoningTextOf('low', null, undefined) === 'Low')
rowsCheck('目录里没有这个模型、会话也没定档位时不显示', reasoningTextOf(undefined, undefined, undefined) === undefined)

// ---- 默认档位与目录默认选择（纯函数，不渲染）----
// 官方口径：`current.reasoningEffort ?? reasoning.defaultEffort`——目录没声明默认档就显示
// 「Default」（官方 zh/en 字典里都是这个字面值），不能拿档位表首档顶替（那等于替用户选了一个他没选过的档位）。
rowsCheck('目录声明了默认档就用它', defaultEffortOf({ reasoning: { efforts: ['low', 'high'], default: 'high' } }) === 'high')
rowsCheck('目录没声明默认档时不用首档兜底', defaultEffortOf({ reasoning: { efforts: ['low', 'high'] } }) === undefined)
rowsCheck('没有档位表就没有默认档', defaultEffortOf({ reasoning: undefined }) === undefined)
rowsCheck('模型不存在时没有默认档', defaultEffortOf(undefined) === undefined)

// 目录 RPC 里的宿主默认选择：没有目录服务的实例靠它兜底（官方 current 的另一半）
rowsCheck('目录默认选择原样读出', normalizeSelection({ provider: 'deepseek', model: 'v4', reasoningEffort: 'max' }).reasoningEffort === 'max')
rowsCheck('默认选择没档位时就是没有档位', normalizeSelection({ provider: 'deepseek', model: 'v4' }).reasoningEffort === undefined)
rowsCheck('默认选择形状不对当作没有', normalizeSelection({ provider: 'deepseek' }) === undefined)
rowsCheck('默认选择为空当作没有', normalizeSelection(null) === undefined)

// ---- 共享额度快照的广播（设置页刷新/删除后，座位指示器与 /model 命令要立刻跟上）----
const { onPlanChange, mergePlanAccount, dropPlanAccount } = moduleExports
const broadcasts = []
const stopListening = onPlanChange((payload) => { broadcasts.push(payload) })

mergePlanAccount({ id: 'kimi-coding', balances: [{ label: '余额', value: '¥1.00' }], windows: [], fetchedAt: 'a' })
rowsCheck('单卡刷新会广播新快照', broadcasts.length === 1)
rowsCheck('快照里没有这一家时补上（不是丢掉）', Array.isArray(broadcasts[0].accounts) && broadcasts[0].accounts.some((a) => a.id === 'kimi-coding'))

mergePlanAccount({ id: 'kimi-coding', balances: [{ label: '余额', value: '¥2.00' }], windows: [], fetchedAt: 'b' })
const same = broadcasts[1].accounts.filter((a) => a.id === 'kimi-coding')
rowsCheck('同一家再刷是原地覆盖', broadcasts.length === 2 && same.length === 1 && same[0].balances[0].value === '¥2.00')

dropPlanAccount('kimi-coding')
rowsCheck('删除某家也会广播且把它剔掉', broadcasts.length === 3 && broadcasts[2].accounts.every((a) => a.id !== 'kimi-coding'))

stopListening()
mergePlanAccount({ id: 'deepseek', balances: [], windows: [], fetchedAt: 'c' })
rowsCheck('退订之后不再收到', broadcasts.length === 3)

// ---- 「添加供应商」下拉的选中状态 / 刷新结果判定（纯函数，不渲染）----
// 路由配好了但没密钥（deepseek 由插件 config 声明，天生就是这个样子）时不能禁选：
// 禁选之后用户既加不了新的，卡片上也没地方补 key。
const { presetPickState, refreshFailure } = moduleExports
const fresh = presetPickState({ id: 'kimi-coding', label: 'Kimi' })
rowsCheck('没配过的预设可选、无标记', fresh.disabled === false && fresh.tag === null)
const donePick = presetPickState({ id: 'kimi-coding', label: 'Kimi', configured: true })
rowsCheck('配好且密钥在 → 禁选并标已配置', donePick.disabled === true && donePick.tag === '已配置')
const keylessPick = presetPickState({ id: 'deepseek', label: 'DeepSeek', configured: true, missingKey: true })
rowsCheck('配了但缺密钥 → 可选并标缺密钥', keylessPick.disabled === false && keylessPick.tag === '缺密钥')

// 宿主 refresh/test 一律回 200，成败看 body 的 ok：没配 key 时 ok=false、原因在 account.error。
// 只判 account 在不在，就会在"未配置 key"的卡片上弹一句"✓ 余量已刷新"。
rowsCheck('ok:true 算成功', refreshFailure({ ok: true, account: { id: 'deepseek' } }) === undefined)
rowsCheck('没密钥时把原因带出来',
  refreshFailure({ ok: false, account: { error: 'DEEPSEEK_API_KEY 没有值' } }) === 'DEEPSEEK_API_KEY 没有值')
rowsCheck('缺 ok 但有 account.error 也算失败', refreshFailure({ account: { error: '解析失败' } }) === '解析失败')
rowsCheck('既没 ok 也没原因时给兜底文案', refreshFailure(undefined) === '未知错误')

// ---- 老 provider id 的别名（会话里记着 deepseek-official 的那些）----
// 官方 llm-deepseek 时代的会话记的是 deepseek-official，那条路由已经被本插件接管掉了：
// 不折的话宿主 prompt() 会直接拒（no adapter serves provider …），连消息都发不出去。
const { aliasSelection, intervalCenterMap, resolveInheritedEffort } = moduleExports
const catalog = [
  { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: { efforts: ['low', 'high', 'max'], default: 'high' } }] },
]
rowsCheck('老 id + 模型都在目录里 → 折到现在的路由',
  JSON.stringify(aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, catalog))
    === JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-flash' }))
rowsCheck('档位在新模型支持时带过去',
  aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, catalog).reasoningEffort === 'max')
rowsCheck('档位在新模型没有时丢掉（两套适配器档位表不一定一致）',
  aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'minimal' }, catalog).reasoningEffort === undefined)
rowsCheck('目标 provider 不在目录里 → 原样返回，不乱指',
  aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, [{ id: 'kimi-coding', name: 'Kimi', models: [] }]).provider === 'deepseek-official')
rowsCheck('模型对不上 → 原样返回',
  aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v2' }, catalog).provider === 'deepseek-official')
rowsCheck('目录还没加载时不折', aliasSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, undefined).provider === 'deepseek-official')
rowsCheck('不是别名的原样返回',
  aliasSelection({ provider: 'kimi-coding', model: 'kimi-k2' }, catalog).provider === 'kimi-coding')
rowsCheck('没有选择时还是 undefined', aliasSelection(undefined, catalog) === undefined)

// ---- 按区间中心映射档位索引（force-effort-pick 流程的档位面板初始选中档位计算）----
// 5→3 验证：k=0/1/2/3/4 → newIdx=0/0/1/2/2（中段对中段，边界对边界，不会跳到极值）。
rowsCheck('5档第 1 档 → 3档第 1 档', intervalCenterMap(0, 5, 3) === 0)
rowsCheck('5档第 2 档 → 3档第 1 档', intervalCenterMap(1, 5, 3) === 0)
rowsCheck('5档第 3 档 → 3档第 2 档（用户原例）', intervalCenterMap(2, 5, 3) === 1)
rowsCheck('5档第 4 档 → 3档第 3 档', intervalCenterMap(3, 5, 3) === 2)
rowsCheck('5档第 5 档 → 3档第 3 档', intervalCenterMap(4, 5, 3) === 2)
// 5→5 一一对应：区间中心对齐后每档对每档（边界不算）。
rowsCheck('5→5 全部一一对应', JSON.stringify([0, 1, 2, 3, 4].map((k) => intervalCenterMap(k, 5, 5))) === JSON.stringify([0, 1, 2, 3, 4]))
// 5→4：k=0/1/2/3/4 → newIdx=0/1/2/2/3（区间中心 (0.1, 0.3, 0.5, 0.7, 0.9)*4-0.5=-0.1/0.7/1.5/2.3/3.1 → round → 0/1/2/2/3）。
rowsCheck('5档第 3 档 → 4档第 2 档', intervalCenterMap(2, 5, 4) === 2)
rowsCheck('5档第 5 档 → 4档第 3 档', intervalCenterMap(4, 5, 4) === 3)
// 边界：单档入多档 → 中间那一档；单档入单档 → 0。
rowsCheck('1档 → 1档', intervalCenterMap(0, 1, 1) === 0)
rowsCheck('1档 → 3档落到中间', intervalCenterMap(0, 1, 3) === 1)

// ---- resolveInheritedEffort：切换模型时档位面板的初始选中档位 ----
// 复用 aliasSelection 那条目录再加几个对照：5 档（low/high/max）、3 档（low/high/max）、
// 不带 reasoning 的对照组（empty-no-effort-group）。
const fiveCatalog = [
  { id: 'a', name: 'A', models: [{ id: 'a5', name: 'A5', reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' } }] },
]
const threeCatalog = [
  { id: 'b', name: 'B', models: [{ id: 'b3', name: 'B3', reasoning: { efforts: ['low', 'high', 'max'], default: 'low' } }] },
]
const noReasoningCatalog = [
  { id: 'c', name: 'C', models: [{ id: 'c0', name: 'C0' }] },
]
const five = fiveCatalog[0].models[0]
const three = threeCatalog[0].models[0]
const noReasoning = noReasoningCatalog[0].models[0]

// 1) priorEffort 在新模型档位表里 → 直接命中（最常见的快速路径）
rowsCheck('priorEffort 直接命中 → 原样返回',
  resolveInheritedEffort('max', five, three) === 'max')
rowsCheck('priorEffort 直接命中（小写）',
  resolveInheritedEffort('low', three, five) === 'low')

// 2) priorEffort 不在新模型档位表里 → 按区间中心映射；用户原例验证
rowsCheck('5档第2档「medium」→ 3档第1档「low」（区间中心）',
  resolveInheritedEffort('medium', five, three) === 'low')
rowsCheck('5档第3档「high」→ 3档第2档「high」（用户原例）',
  resolveInheritedEffort('high', five, three) === 'high')
rowsCheck('5档第4档「xhigh」→ 3档第3档「max」（区间中心）',
  resolveInheritedEffort('xhigh', five, three) === 'max')

// 3) priorEffort === undefined：分首次选模型 vs 老档是关闭
rowsCheck('priorEffort undefined + 老模型不存在 → 新模型 defaultEffort',
  resolveInheritedEffort(undefined, undefined, three) === 'low')
rowsCheck('priorEffort undefined + 老模型存在 → 保留 undefined（老档是关闭）',
  resolveInheritedEffort(undefined, five, three) === undefined)
const threeNoDefault = [{ id: 'd', name: 'D', models: [{ id: 'd0', name: 'D0', reasoning: { efforts: ['low', 'high'], default: undefined } }] }][0].models[0]
rowsCheck('priorEffort undefined + 老模型不存在 + 新模型无 defaultEffort → undefined',
  resolveInheritedEffort(undefined, undefined, threeNoDefault) === undefined)

// 4) 新模型没有 reasoning → undefined（空态兜底）
rowsCheck('新模型没有 reasoning → undefined',
  resolveInheritedEffort('max', five, noReasoning) === undefined)
rowsCheck('新模型没有 reasoning + 老档 undefined → undefined',
  resolveInheritedEffort(undefined, five, noReasoning) === undefined)
const emptyEffortsModel = [{ id: 'e', name: 'E', models: [{ id: 'e0', name: 'E0', reasoning: { efforts: [], default: undefined } }] }][0].models[0]
rowsCheck('新模型 reasoning.efforts 空 → undefined',
  resolveInheritedEffort('max', five, emptyEffortsModel) === undefined)

// 5) 老模型档位表拿不到 / priorEffort 不在里面（脏数据）→ 新模型 defaultEffort
const orphanPrior = [{ id: 'x', name: 'X', models: [{ id: 'x0', name: 'X0', reasoning: { efforts: ['low', 'high'], default: 'high' } }] }][0].models[0]
rowsCheck('老模型档位表拿不到（脏数据：priorEffort 不在老档位表里）→ 新模型 defaultEffort',
  resolveInheritedEffort('medium', orphanPrior, three) === 'low')
rowsCheck('老模型没有 reasoning + priorEffort 不在新档位表里 → 新模型 defaultEffort',
  resolveInheritedEffort('medium', noReasoning, three) === 'low')

// 6) 选择就是关闭兜底：priorEffort undefined 且老模型存在 + 新模型也没有 reasoning
// → 仍然 undefined（用户已经显式选了"不指定档"，不要替他们改成别的）。
rowsCheck('老档关闭 + 新模型也无 reasoning → undefined',
  resolveInheritedEffort(undefined, five, noReasoning) === undefined)

if (failures > 0) throw new Error(`桥接明细有 ${failures} 条断言没过`)

console.log('\n冒烟通过：模型座位 + 设置页标签两个座位已注册，模型座位用负 priority 遮蔽官方占用者；' +
  '/model 在官方占用时让位、空闲时接管；pi-ai 桥接明细按版本/来源/跳过原因出正确的行；' +
  '推理等级在目录缺该模型时仍按会话已定的档位显示，默认档只认目录声明的那个')
