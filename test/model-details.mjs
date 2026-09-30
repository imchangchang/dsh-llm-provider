// 模型能力的多链路合并（issue #5）。
//
// 三条链路，优先级从高到低：route 声明（settings）→ pi-ai 目录 → 适配器自报；都查不到就不写，
// 界面不打徽章。这里盯的是「谁盖谁」和「自报不越权」：越权一次就会把目录里正确的能力改错。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyAdapterCapabilities,
  applyDeclaredCapabilities,
  defaultModelWarning,
  detailKey,
  indexDetails,
  loadModelDetails,
} from '../lib/model-details.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

/** 造一份假 pi-ai 包（只要 providers/data 那几个 json）。 */
function fakePiAi() {
  const root = mkdtempSync(join(tmpdir(), 'model-details-'))
  const dir = join(root, 'dist', 'providers', 'data')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deepseek.json'), JSON.stringify({
    'openai-completions': {
      'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', api: 'openai-completions', input: ['text'], contextWindow: 1000000, maxTokens: 32768, reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } },
      'deepseek-v4-flash-vision-exp': { id: 'deepseek-v4-flash-vision-exp', name: 'Vision', provider: 'deepseek', api: 'openai-completions', input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 },
    },
  }))
  return root
}

// ---- 链路 2：pi-ai 目录 ----
const catalog = loadModelDetails(fakePiAi())
check('目录里读出两条', catalog.length === 2)
check('目录能力来自 input', catalog[1].vision === true && catalog[0].vision === false)
check('目录条目标了 catalog 来源', catalog.every((d) => d.source === 'catalog'))
check('目录里有 input 的条目：能力算查到了', catalog.every((d) => d.capabilitiesKnown === true))

// ---- 链路 1：route 声明盖过目录（自定义 id 的视觉能力就是这么来的）----
const index = indexDetails(catalog)
applyDeclaredCapabilities(index, [
  // 自定义 id：目录里没有 → 新增一条，能力按声明给
  { routeId: 'opencode-go', entry: { id: 'deepseek-flash', name: '自定义 Flash', input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096 } },
  // 目录里有同 id、能力是 false：声明成视觉就要盖过去
  { routeId: 'deepseek', entry: { id: 'deepseek-v4-flash', input: ['text', 'image'] } },
  // 字符串简写（只有 id）：能力沿用目录，不拿「没写」当「不支持」
  { routeId: 'deepseek', entry: 'deepseek-v4-flash-vision-exp' },
])
const custom = index.get(detailKey('opencode-go', 'deepseek-flash'))
check('自定义 id 新增进来了', custom !== undefined)
check('自定义 id 的能力按声明给', custom.vision === true && custom.video === false)
check('自定义 id 的上下文/输出按声明给', custom.contextWindow === 128000 && custom.maxTokens === 4096)
check('自定义 id 标了 route 来源', custom.source === 'route')
check('声明了 input 的自定义 id：能力算查到了', custom.capabilitiesKnown === true)
const overridden = index.get(detailKey('deepseek', 'deepseek-v4-flash'))
check('声明盖过目录（text → text,image）', overridden.vision === true)
check('盖过之后仍标 route 来源', overridden.source === 'route')
check('没声明 input 时保留目录能力', index.get(detailKey('deepseek', 'deepseek-v4-flash-vision-exp')).vision === true)
check('没声明 input 时也标 route（声明过这条）', index.get(detailKey('deepseek', 'deepseek-v4-flash-vision-exp')).source === 'route')
check('没声明 input、目录也没写时的能力注明未知（route 简写指向目录里没有的 id）',
  (() => {
    applyDeclaredCapabilities(index, [{ routeId: 'nowhere', entry: 'ghost-model' }])
    return index.get(detailKey('nowhere', 'ghost-model')).capabilitiesKnown === false
  })())

// ---- 链路 3：适配器自报，只补目录/声明都没覆盖的 provider ----
const calls = []
const llm = {
  listProviders: () => [{ id: 'modlens-opencode-go', name: 'Modlens' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'plain-adapter', name: 'Plain' }],
  listModels: async (provider) => {
    calls.push('list:' + provider)
    if (provider === 'modlens-opencode-go') {
      return [
        { id: 'deepseek-v4-flash', name: 'Modlens Vision', inputModalities: ['text', 'image'] },
        { id: 'no-modalities', name: 'No modalities' },
      ]
    }
    if (provider === 'plain-adapter') return [{ id: 'mystery' }]
    return [{ id: 'should-not-be-asked' }]
  },
  resolveModelInfo: async (provider, model) => {
    calls.push('resolve:' + provider + '/' + model)
    // 这条连 resolveModelInfo 也问不出模态：自报照样列出模型，只是没有徽章（不猜）
    if (provider === 'plain-adapter') return {}
    return { inputModalities: ['text', 'image'], context: { contextWindow: 256000 }, defaultMaxTokens: 8192 }
  },
}
const added = await applyAdapterCapabilities(index, llm)
check('只为目录里没有的 provider 问 listModels', calls.filter((c) => c.startsWith('list:')).join(',') === 'list:modlens-opencode-go,list:plain-adapter')
check('已经有详情的 provider 不再问', !calls.includes('list:deepseek'))
check('自报补了几条', added === 3)
const adapterVision = index.get(detailKey('modlens-opencode-go', 'deepseek-v4-flash'))
check('自报的模态变成视觉能力', adapterVision.vision === true)
check('自报条目标 adapter 来源', adapterVision.source === 'adapter')
check('自报的模态算查到了', adapterVision.capabilitiesKnown === true)
check('同名模型不串家：目录那份没被动', index.get(detailKey('deepseek', 'deepseek-v4-flash')).source === 'route')
const resolved = index.get(detailKey('modlens-opencode-go', 'no-modalities'))
check('listModels 没报模态时问 resolveModelInfo', calls.includes('resolve:modlens-opencode-go/no-modalities'))
check('resolveModelInfo 的模态也认', resolved.vision === true)
check('resolveModelInfo 的上下文/输出一并带上', resolved.contextWindow === 256000 && resolved.maxTokens === 8192)
const plain = index.get(detailKey('plain-adapter', 'mystery'))
check('没模态信息的自报照旧列出来（只是不打徽章）', plain !== undefined && plain.vision === false)
check('没模态信息的自报标成「能力未知」', plain.capabilitiesKnown === false)

// ---- 适配器卡住不能拖死响应 ----
const started = Date.now()
const hanging = {
  listProviders: () => [{ id: 'hangs', name: 'Hangs' }],
  listModels: () => new Promise(() => {}),
}
const addedWhenHanging = await applyAdapterCapabilities(indexDetails([]), hanging, { callTimeoutMs: 30, budgetMs: 200 })
check('适配器不返回时按超时放弃', addedWhenHanging === 0 && Date.now() - started < 2000)

// ---- 没装 llm 服务时什么都不做 ----
check('没有 llm 服务时返回 0', (await applyAdapterCapabilities(indexDetails([]), undefined)) === 0)
check('没有 listModels 的 llm 也返回 0', (await applyAdapterCapabilities(indexDetails([]), { listProviders: () => [] })) === 0)

console.log(failures === 0 ? 'model-details: 全部通过' : `model-details: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

// ---- 默认模型（agent-default-model）与当前目录对不上的警示 ----
check('默认模型在目录里 → 不警示',
  defaultModelWarning({ provider: 'deepseek', model: 'deepseek-v4-flash' }, [
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
  ]) === undefined)
check('默认模型不在目录里 → 报警并给出可用的 id', (() => {
  const text = defaultModelWarning({ provider: 'deepseek', model: 'deepseek-flash' }, [
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
    { provider: 'deepseek', id: 'deepseek-v4-pro' },
    { provider: 'kimi-coding', id: 'kimi-k2' },
  ])
  return typeof text === 'string' && text.indexOf('deepseek/deepseek-flash') !== -1
    && text.indexOf('deepseek-v4-flash') !== -1 && text.indexOf('kimi-coding') === -1
})())
check('该 provider 一个模型都没有 → 照样报警，只是不给例子', (() => {
  const text = defaultModelWarning({ provider: 'ghost', model: 'm' }, [{ provider: 'deepseek', id: 'x' }])
  return typeof text === 'string' && text.indexOf('ghost/m') !== -1 && text.indexOf('可用') === -1
})())
check('读不到默认模型（undefined）→ 不警示', defaultModelWarning(undefined, [{ provider: 'a', id: 'b' }]) === undefined)
check('默认模型字段不是字符串 → 不警示',
  defaultModelWarning({ provider: 1, model: null }, [{ provider: 'a', id: 'b' }]) === undefined)
