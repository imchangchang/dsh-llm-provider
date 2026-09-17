/**
 * 浏览器端的离线冒烟测试：用假 __ModuleLoader__ + 桩 react + 桩 ctx，
 * 验证 apply() 的接线段（注册了哪些槽位、id、组件是不是函数）。
 * 真正的 UI 行为要在浏览器里看。
 *
 *   node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
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
  let commandRegistered = false

  const effect = (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
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
            register() {
              if (commandDuplicate) throw new Error('ui-commands: duplicate contribution for /model')
              commandRegistered = true
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
  const ctx = { effect, slots: scope.slots, inject: scope.inject }
  Object.defineProperty(ctx, 'styles', {
    get() {
      throw new Error('cannot get property "styles" without inject')
    },
  })
  moduleExports.apply(ctx)
  return { registrations, slotInjects, injectedServices, commandRegistered }
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

// ---- 「pi-ai 桥接」标签页的明细行（纯函数，不渲染）----
const { piAiBridgeRows, piAiUpstreamText, reasoningTextOf, defaultEffortOf, normalizeSelection, parseOauthFrame } = moduleExports
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
