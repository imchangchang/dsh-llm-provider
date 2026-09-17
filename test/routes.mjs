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

const piAiSettings = {
  get: (ns) => (ns === 'llm-pi-ai'
    ? { providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY', api: 'anthropic-messages' }, 'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } } }
    : undefined),
}
// llm 服务：llm-pi-ai 的目录条目 + 原生 deepseek-official
const llm = {
  listConfigurableProviders: () => [
    { provider: 'kimi-coding', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'kimi-coding'], displayName: 'Kimi Coding' },
    { provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], displayName: 'OpenAI' },
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [], displayName: 'DeepSeek' },
  ],
}

const merged = providerRoutes(piAiSettings, llm)
check('配置过的 pi-ai 路由都在', [...merged.keys()].sort(), ['kimi-coding', 'zai-coding-cn', 'deepseek-official'].sort())
check('未配置的 catalog provider 不进面板', merged.has('openai'), false)
check('原生路由用已知默认凭据名', merged.get('deepseek-official').apiKeyEnv, 'DEEPSEEK_API_KEY')
check('原生路由带友好名', merged.get('deepseek-official').label, 'DeepSeek')
check('get() 给出的凭据名带上了', merged.get('kimi-coding').apiKeyEnv, 'KIMI_CODING_API_KEY')
check('settings 里的协议带到路由上（卡片展开体要展示）', merged.get('kimi-coding').api, 'anthropic-messages')
check('settings 没写协议就是 undefined，不编造', merged.get('zai-coding-cn').api, undefined)
check('原生路由没有协议', merged.get('deepseek-official').api, undefined)

// 场景：llm 服务不可用（老 dsh）→ 只靠 settings
const noLlm = providerRoutes(piAiSettings, undefined)
check('llm 缺席时不崩，仍给出 pi-ai 路由', [...noLlm.keys()].sort(), ['kimi-coding', 'zai-coding-cn'])

// 场景：老用户配过官方 llm-deepseek，目录里因此多一条 deepseek-official；插件的 config
// 已经声明了 pi-ai 的 deepseek——同一家只留一张卡，不能冒出 deepseek-official
const withPiAiDeepseek = {
  get: () => ({ providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', api: 'openai-completions' } } }),
}
check('pi-ai 已在服务这家时不再补原生那一条',
  [...providerRoutes(withPiAiDeepseek, llm).keys()].sort(), ['deepseek'])
check('没有 pi-ai 那一条时原生路由照旧出来（patch 没生效、或用户删掉了它）',
  [...providerRoutes({ get: () => ({ providers: {} }) }, llm).keys()].sort(), ['deepseek-official'])

// 场景：命名空间没注册（get() 取不到）→ 退回 section()，它直接读 dsh 解析好的文档
const documentOnly = {
  get: () => undefined,
  section: (ns) => (ns === 'llm-pi-ai' ? { providers: { 'moonshotai-cn': { apiKeyEnv: 'MOONSHOTAI_CN_API_KEY' } } } : undefined),
}
check('命名空间没注册时退回 section()', [...providerRoutes(documentOnly, llm).keys()].sort(), ['moonshotai-cn', 'deepseek-official'].sort())

// 场景：get() 有值就用它——它是合并后的结果，含插件 config base 层那条 deepseek，
// 而 section() 只有用户写过的那些，拿它当首选会漏掉 DeepSeek
const bothWays = {
  get: () => ({ providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }),
  section: () => ({ providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } } }),
}
check('get() 优先于 section()', [...providerRoutes(bothWays, undefined).keys()], ['deepseek'])

// 场景：两条路都拿不到 → 只剩原生路由
check('两条路都空时仍能给出原生路由', [...providerRoutes(undefined, llm).keys()], ['deepseek-official'])

// 场景：get() 和 section() 都抛（section 对非对象节会抛 TypeError）
const throwing = { get: () => { throw new Error('boom') }, section: () => { throw new TypeError('must be an object') } }
check('两条路抛错都被吞掉且不影响原生路由', [...providerRoutes(throwing, llm).keys()], ['deepseek-official'])

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
