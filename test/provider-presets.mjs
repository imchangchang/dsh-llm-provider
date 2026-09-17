// 供应商候选清单的顺序与标记。
//
// 清单从 pi-ai 目录动态生成，按名字排、Custom Gateway 固定最后，这个测试盯住它。
import { presetsWithMeta } from '../lib/provider-presets.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

const presets = presetsWithMeta(new Set())

// 清单主体来自 pi-ai 的目录数据，没装 pi-ai 的机器上会只剩自定义那一项——
// 断言写成对长度不敏感，两种环境都跑得过。
check('至少有自定义网关这一项', presets.length > 0)

const last = presets[presets.length - 1]
check('自定义网关固定排最后', last !== undefined && last.id === 'custom-gateway')
check('自定义网关只出现一次', presets.filter((p) => p.custom === true).length === 1)

const named = presets.slice(0, -1)
let ascending = true
for (let i = 1; i < named.length; i += 1) {
  if (named[i - 1].label.localeCompare(named[i].label, 'en') > 0) ascending = false
}
check('其余按名字升序', ascending)

check('每项都有名字', presets.every((p) => typeof p.label === 'string' && p.label !== ''))
check('每项 id 都是 kebab-case', presets.every((p) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(p.id)))

// 协议归 pi-ai：目录里每个模型自带 api，路由上写一个会盖掉其余模型（Copilot / OpenRouter
// 这类一家多协议），所以预设不替目录 provider 挑协议；只有自建网关没目录可回落，才要用户指定。
check('自定义网关带协议', last.api === 'openai-completions')
check('目录 provider 一律不带协议', named.every((p) => p.api === undefined))

// 但目录里这家到底有几种协议要报出来（`apis`）：界面靠它决定「路由写死了协议」要不要报警——
// 单协议写对是白报（用户会去点一个没必要的修正按钮），多协议或跟目录不一致才是真问题。
const presetOf = (id) => presets.find((p) => p.id === id)
check('自建网关没有目录协议（apis 空）', Array.isArray(last.apis) && last.apis.length === 0)
if (presetOf('deepseek') !== undefined) {
  check('deepseek 单协议（apis 只有一个）', presetOf('deepseek').apis.length === 1)
}
if (presetOf('github-copilot') !== undefined) {
  check('github-copilot 多协议（apis 不止一个）', presetOf('github-copilot').apis.length > 1)
}
if (presetOf('openrouter') !== undefined) {
  check('openrouter 多协议', presetOf('openrouter').apis.length > 1)
}

// OAuth-only 判定来自 pi-ai 元数据（有 oauth、没有 apiKey），只留一条有理由的例外：
// Copilot 的 apiKey 路径是个手填 token 的框，那种 token 用户拿不到，界面上当 OAuth-only。
if (presetOf('openai-codex') !== undefined) {
  check('openai-codex（元数据只有 oauth）是 OAuth-only', presetOf('openai-codex').oauthOnly === true)
}
if (presetOf('anthropic') !== undefined) {
  check('anthropic（oauth + apiKey 都有）不是 OAuth-only', presetOf('anthropic').oauthOnly === false)
}
if (presetOf('github-copilot') !== undefined) {
  check('github-copilot 按 OAuth-only 处理（密钥路径拿不到 token）', presetOf('github-copilot').oauthOnly === true)
}
if (presetOf('deepseek') !== undefined) {
  check('纯密钥 provider 不是 OAuth-only', presetOf('deepseek').oauthOnly === false)
}

// billing 标记 = 这一家有没有余额查询适配器（没有也能添加，只是卡片不显示余量）
check('自定义网关没有余额适配器', last.billing === false)
if (presets.some((p) => p.id === 'kimi-coding')) {
  check('kimi-coding 有余额适配器', presets.find((p) => p.id === 'kimi-coding').billing === true)
}

// 已配置标记：走 providerRoutes 的 id；原生路由按 NATIVE_EQUIVALENTS 折算
const configured = presetsWithMeta(new Set(['deepseek-official']))
if (configured.some((p) => p.id === 'deepseek')) {
  check('原生 deepseek-official 已配置 → 目录里的 deepseek 也标已配置',
    configured.find((p) => p.id === 'deepseek').configured === true)
}
check('没配过的时候不标已配置', presets.every((p) => p.configured === false))

// 路由在、凭据没值：插件自己的 config 就声明了 deepseek，这种"配了一半"的状态必须报出来，
// 否则界面把它当"已配置"禁选，用户既加不了它、卡片上也没有补密钥的地方。
check('没配过的时候不标缺密钥', presets.every((p) => p.missingKey === false))

const keyless = presetsWithMeta(new Set(['deepseek']), new Set(['deepseek']))
if (keyless.some((p) => p.id === 'deepseek')) {
  const deepseek = keyless.find((p) => p.id === 'deepseek')
  check('缺密钥的那家仍算已配置', deepseek.configured === true)
  check('缺密钥的那家单列 missingKey', deepseek.missingKey === true)
}
const keyed = presetsWithMeta(new Set(['deepseek']), new Set())
if (keyed.some((p) => p.id === 'deepseek')) {
  check('有密钥的不标 missingKey', keyed.find((p) => p.id === 'deepseek').missingKey === false)
}
const nativeKeyless = presetsWithMeta(new Set(['deepseek-official']), new Set(['deepseek-official']))
if (nativeKeyless.some((p) => p.id === 'deepseek')) {
  check('原生路由缺密钥也算在目录同名项上',
    nativeKeyless.find((p) => p.id === 'deepseek').missingKey === true)
}

console.log(failures === 0 ? '\n供应商清单测试全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
