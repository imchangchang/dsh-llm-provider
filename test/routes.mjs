/**
 * provider 路由发现的单元测试。
 *
 *   node test/routes.mjs
 */
import { labelOf, providerRoutes, websiteOf } from '../lib/routes.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) {
    console.log('  期望:', JSON.stringify(expected))
    console.log('  实际:', JSON.stringify(actual))
    failed = true
  }
}

// providers 记录：读取（0.1.x 的 settings 段 / 0.2.x 的条目 config / 合并优先级）在
// test/provider-config.mjs 里测；这里只测「记录 → 路由表」的映射与原生路由那一条来源。
const piAiProviders = {
  'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY', api: 'anthropic-messages' },
  'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
}
// llm 服务：llm-pi-ai 的目录条目 + 原生 deepseek-official
const llm = {
  listConfigurableProviders: () => [
    { provider: 'kimi-coding', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'kimi-coding'], displayName: 'Kimi Coding' },
    { provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], displayName: 'OpenAI' },
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [], displayName: 'DeepSeek' },
  ],
}

const merged = providerRoutes(piAiProviders, llm)
check('配置过的 pi-ai 路由都在', [...merged.keys()].sort(), ['kimi-coding', 'zai-coding-cn', 'deepseek-official'].sort())
check('未配置的 catalog provider 不进面板', merged.has('openai'), false)
check('原生路由用已知默认凭据名', merged.get('deepseek-official').apiKeyEnv, 'DEEPSEEK_API_KEY')
check('原生路由带友好名', merged.get('deepseek-official').label, 'DeepSeek')
check('providers 里的凭据名带上了', merged.get('kimi-coding').apiKeyEnv, 'KIMI_CODING_API_KEY')
check('providers 里的协议带到路由上（卡片展开体要展示）', merged.get('kimi-coding').api, 'anthropic-messages')
check('没写协议就是 undefined，不编造', merged.get('zai-coding-cn').api, undefined)
check('原生路由没有协议', merged.get('deepseek-official').api, undefined)

// 场景：llm 服务不可用（老 dsh）→ 只靠 providers
const noLlm = providerRoutes(piAiProviders, undefined)
check('llm 缺席时不崩，仍给出 pi-ai 路由', [...noLlm.keys()].sort(), ['kimi-coding', 'zai-coding-cn'])

// 场景：老用户配过官方 llm-deepseek，目录里因此多一条 deepseek-official；providers 里
// 已经有 pi-ai 的 deepseek——同一家只留一张卡，不能冒出 deepseek-official
check('pi-ai 已在服务这家时不再补原生那一条',
  [...providerRoutes({ deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', api: 'openai-completions' } }, llm).keys()].sort(), ['deepseek'])
check('没有 pi-ai 那一条时原生路由照旧出来（patch 没生效、或用户删掉了它）',
  [...providerRoutes({}, llm).keys()].sort(), ['deepseek-official'])

// 场景：providers 缺席（读不到任何来源）→ 只剩原生路由
check('providers 缺席时仍能给出原生路由', [...providerRoutes(undefined, llm).keys()], ['deepseek-official'])

// 场景：路由配置形状不认识（null / 字符串）也不能崩
check('坏形状的路由配置不崩',
  [...providerRoutes({ broken: null, 'weird-one': 'oops' }, undefined).keys()].sort(), ['broken', 'weird-one'])

check('labelOf 已知 provider 用 pi-ai 名', labelOf('zai-coding-cn'), 'Z.AI Coding CN')
check('labelOf 未知 provider 按 id 拼', labelOf('my-gateway'), 'My Gateway')

// websiteOf：卡片 ↗ 跳官网的依据。没查到就是 undefined——settings.ts 据此决定不渲染链接。
check('websiteOf 精确匹配：deepseek → platform.deepseek.com', websiteOf('deepseek'), 'https://platform.deepseek.com')
check('websiteOf 精确匹配：deepseek-official 与 deepseek 同址', websiteOf('deepseek-official'), 'https://platform.deepseek.com')
check('websiteOf 精确匹配：kimi-coding → kimi.com/code', websiteOf('kimi-coding'), 'https://www.kimi.com/code')
check('websiteOf 前缀兜底：未列名的 provider 没匹配就 undefined（不跳到 baseUrl）', websiteOf('openai'), undefined)
check('websiteOf 前缀兜底：anthropic 也没匹配到，不该瞎给', websiteOf('anthropic'), undefined)
check('websiteOf 已知 -cn 系列：moonshotai-cn 精确匹配', websiteOf('moonshotai-cn'), 'https://platform.moonshot.cn')
check('websiteOf 前缀兜底：minimax-intl 这类变体回到 minimax-cn 的官网', websiteOf('minimax-intl'), 'https://platform.minimaxi.com')

console.log(failed ? '\n有失败用例' : '\n路由发现测试全部通过')
if (failed) process.exitCode = 1
