// cordis.patch.yml 的防回归检查。
//
// 两件连坐的事：
//   1. patch 禁用了内置 llm-deepseek，DeepSeek 就只剩 pi-ai 的 deepseek 路由一条路，
//      而那条路由必须有人声明。声明**不在 patch 里**了（0.2.x 宿主把我们条目的 config 同时
//      当成界面写配置的落点，默认值和用户写入混在一个键里就没法分优先级），改在
//      src/provider-config.ts 的 BUILTIN_PROVIDERS 里。删掉它，DeepSeek 会从模型列表里
//      静默消失——没人会立刻发现。两者必须同时存在。
//   2. 本插件接管的那几个官方行必须都在禁用名单里。少一个的后果不是报错而是"两套并存"：
//      比如 ui-model-selection 没禁，官方就会再拉一份目录、再推一份 composer 置灰状态，
//      跟我们的状态机打架，而且只表现为偶发的显示不一致，很难追。
//
// 只做文本检查（仓库不引 YAML 依赖，npm test 只跑 node 内置模块）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : 'FAIL ') + name)
  if (!cond) failures += 1
}

/** 某个 id 是否被禁掉（字面 true 或 !!js 守卫表达式都算）。 */
function disabled(id) {
  return new RegExp(`id:\\s*${id}\\s*\\n\\s*disabled:\\s*(true|!!js)`).test(text)
}

/** 某个 id 的禁用是不是带「只在本插件启用时」的守卫。 */
function guarded(id) {
  const block = new RegExp(`id:\\s*${id}\\s*\\n\\s*disabled:\\s*(!!js[^\\n]*)`).exec(text)
  return block !== null && block[1].indexOf('dsh-llm-provider') !== -1 && block[1].indexOf('mine.disabled') !== -1
}

const disablesDeepseek = disabled('llm-deepseek')
const disablesPiAi = disabled('llm-pi-ai')
// 默认路由声明在代码里（同一个仓库，一起做文本检查，保持零依赖）
const source = readFileSync(join(root, 'src', 'provider-config.ts'), 'utf8')
const declaresRoute = /BUILTIN_PROVIDERS[\s\S]{0,200}deepseek:\s*\{/.test(source)

check('禁用了内置 llm-pi-ai（桥接接管，否则路由重名抛 DUPLICATE_ADAPTER）', disablesPiAi)
check('禁用了内置 llm-deepseek（全世界只留 pi-ai 一套 adapter）', disablesDeepseek)
check('禁用 llm-deepseek 时必须自己声明 deepseek 路由', !disablesDeepseek || declaresRoute)
check('deepseek 默认声明在插件代码里（BUILTIN_PROVIDERS）', declaresRoute)
check('路由声明带 apiKeyEnv（复用 DEEPSEEK_API_KEY 凭据）', /deepseek:[\s\S]{0,200}apiKeyEnv:\s*'DEEPSEEK_API_KEY'/.test(source))
check('patch 里不再声明 providers：0.2.x 上那个键是界面写入的落点，默认与写入不能混',
  !/config:\s*\n\s*providers:/.test(text))
check('禁用了官方 ui-model-selection（座位与 /model 整体接管，不留两套状态机）', disabled('ui-model-selection'))
check('禁用了官方 ui-settings-models（官方 Models 页退役）', disabled('ui-settings-models'))
// 四行的禁用都必须带守卫：用户在插件管理里关掉本插件（不卸载）时，那四行要自己恢复，
// 否则「插件关了、官方也被禁着」= 一个模型都没有（用户实测撞到的死角）
for (const id of ['llm-pi-ai', 'llm-deepseek', 'ui-model-selection', 'ui-settings-models']) {
  check(`禁用 ${id} 带「仅本插件启用时」的守卫`, guarded(id))
}
check('守卫表达式按 id 或模块名认本插件那一行', /options\.id === 'dsh-llm-provider'/.test(text) && /@dsh-one\/dsh-llm-provider/.test(text))
check('守卫异常时不禁用官方行（失败时宁可官方可用）', /catch \{ return false \}/.test(text))

console.log(failures === 0 ? '\npatch 层检查通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
