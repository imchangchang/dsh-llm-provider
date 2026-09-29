// 模型发现的命名空间适配（0.1.x 的 `llm-pi-ai` vs 0.2.x 的插件条目 id）。
//
// 宿主按命名空间找注册的发现器，找不到抛 NO_DISCOVERY。客户端以前把 `llm-pi-ai` 写死，
// 在 0.2.x 上自建网关点「测试」就报 no model discovery。这里盯：候选顺序、记忆、
// 以及「真正的失败不许靠换 ns 掩盖」。
import { discoverModelsVia, discoveryNamespaces, isMissingDiscovery } from '../lib/model-discovery.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

const OWN = 'dsh-llm-provider'
const LEGACY = 'llm-pi-ai'

check('候选顺序：本插件条目在前、老常量在后', discoveryNamespaces(OWN).join(',') === `${OWN},${LEGACY}`)
check('条目 id 就是老常量时不重复', discoveryNamespaces(LEGACY).join(',') === LEGACY)
check('认得出「没注册发现器」', isMissingDiscovery(new Error('no model discovery is registered for "llm-pi-ai"')) === true)
check('认得出错误码写法', isMissingDiscovery(new Error('NO_DISCOVERY: ...')) === true)
check('别的错误不算', isMissingDiscovery(new Error('HTTP 401 unauthorized')) === false)

// 0.2.x：本插件条目 id 上有发现器 → 一次命中
const calls = []
const llm02 = {
  discoverModels: async (ns) => {
    calls.push(ns)
    if (ns !== OWN) throw new Error(`no model discovery is registered for "${ns}"`)
    return [{ id: 'gpt-5.4' }]
  },
}
const state02 = {}
const first = await discoverModelsVia(llm02, { provider: 'my-gateway' }, state02, OWN)
check('0.2.x：用本插件条目 id 命中', first.ns === OWN && calls.join(',') === OWN)
check('0.2.x：结果原样带出', JSON.stringify(first.models) === '[{"id":"gpt-5.4"}]')
check('命中后记住（下次先用它）', state02.ns === OWN)

// 0.1.x：只有老常量上有 → 自动退到它
const calls01 = []
const llm01 = {
  discoverModels: async (ns) => {
    calls01.push(ns)
    if (ns !== LEGACY) throw new Error(`no model discovery is registered for "${ns}"`)
    return [{ id: 'deepseek-v4-flash' }]
  },
}
const state01 = {}
const second = await discoverModelsVia(llm01, { provider: 'x' }, state01, OWN)
check('0.1.x：自动退到老常量', second.ns === LEGACY && calls01.join(',') === `${OWN},${LEGACY}`)
check('退路也记住了', state01.ns === LEGACY)
check('换路的告警留痕', second.warnings.some((w) => w.indexOf('没有注册模型发现器') !== -1))

// 记忆优先：上次成功的是老常量 → 先试它（哪怕本插件条目 id 在前）
const callsRemembered = []
const llmBoth = {
  discoverModels: async (ns) => {
    callsRemembered.push(ns)
    return []
  },
}
await discoverModelsVia(llmBoth, {}, { ns: LEGACY }, OWN)
check('记忆优先于默认顺序', callsRemembered[0] === LEGACY)

// 真正的失败（401/端点不通）不许靠换 ns 掩盖
const callsFail = []
let thrown = ''
try {
  await discoverModelsVia({
    discoverModels: async (ns) => {
      callsFail.push(ns)
      throw new Error('HTTP 401 unauthorized')
    },
  }, {}, {}, OWN)
} catch (error) {
  thrown = error.message
}
check('真实失败立刻抛出去', thrown === 'HTTP 401 unauthorized')
check('真实失败不试第二个 ns（同一个发现器，换了也是白换）', callsFail.length === 1)

// 两条都没有：报错里要列出试过谁、最后一次原因
let bothMissing = ''
try {
  await discoverModelsVia({
    discoverModels: async (ns) => { throw new Error(`no model discovery is registered for "${ns}"`) },
  }, {}, {}, OWN)
} catch (error) {
  bothMissing = error.message
}
check('两条都没注册时报错并列出试过的 ns',
  bothMissing.indexOf('没有可用的模型发现器') !== -1 && bothMissing.indexOf(OWN) !== -1 && bothMissing.indexOf(LEGACY) !== -1)

// 宿主没有这个能力（很老的 dsh）：给一句人话
let noCapability = ''
try {
  await discoverModelsVia(undefined, {}, {}, OWN)
} catch (error) {
  noCapability = error.message
}
check('宿主没有 discoverModels 时说清楚', noCapability.indexOf('不支持草稿探测') !== -1)

console.log(failures === 0 ? 'model-discovery: 全部通过' : `model-discovery: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
