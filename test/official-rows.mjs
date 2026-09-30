// 官方行接管（src/official-rows.ts）的离线测试。
//
// 背景：宿主没有遮蔽机制——同一个 configurable provider / 路由注册两次直接抛
// `LlmError: configurable provider "..." is already declared`，而我们这套桥接要接管的
// 官方行（llm-pi-ai / llm-deepseek / ui-model-selection / ui-settings-models）本来靠
// cordis.patch.yml 里 `disabled: !!js` 的守卫关掉。**首次挂载时那个守卫看不到本插件的条目**：
// Loader 的 EntryGroup.update 按列表顺序同步求值每一行的 disabled（Promise.all 的回调同步跑到
// 第一个 await 为止），而本插件的行是 insert 追加的、排在最后。于是官方行照旧挂载，本插件挂
// 桥接时撞车，整个条目激活失败（Desktop 0.2.0-rc.2 实测：界面上「组件启用失败」）。
//
// 所以本插件启动时自己再关一次。这里验的就是这一刀：只关还开着的、关不动不谎报、形状不认识
// 不炸。
//
//   node test/official-rows.mjs
import { OFFICIAL_ROW_IDS, disableOfficialRows, loaderEntries } from '../lib/official-rows.js'

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ok ' : '  FAIL ') + name)
  if (!cond) failures += 1
}

/** 造一行 loader 条目：`disabled` 可以是布尔，也可以是个函数（模拟 `!!js` 表达式的求值）。 */
function row(id, options = {}) {
  const updates = []
  const entry = {
    options: { id, ...(options.name === undefined ? {} : { name: options.name }) },
    updates,
    update(patch) {
      updates.push(patch)
      if (patch.disabled === true) entry.disabledValue = true
      return Promise.resolve()
    },
  }
  let disabled = options.disabled ?? false
  Object.defineProperty(entry, 'disabled', {
    get() {
      return typeof disabled === 'function' ? Boolean(disabled()) : Boolean(disabled)
    },
    set(value) {
      disabled = value
    },
  })
  return entry
}

// ---- 基本：只关还开着的官方行 ----
const piAi = row('llm-pi-ai')
const deepseek = row('llm-deepseek', { disabled: true })
const mine = row('dsh-llm-provider')
const unrelated = row('ui-theme')
const closed = disableOfficialRows([piAi, deepseek, mine, unrelated])
check('只关还开着的官方行', JSON.stringify(closed) === '["llm-pi-ai"]')
check('关的那一行确实收到了 disabled: true', piAi.updates.length === 1 && piAi.updates[0].disabled === true)
check('已经关着的不再动（用户自己关的、或 patch 守卫已生效）', deepseek.updates.length === 0)
check('本插件的条目自己不动', mine.updates.length === 0)
check('别的官方行不动', unrelated.updates.length === 0)

// ---- `!!js` 形状：disabled 是表达式时按求值结果判断 ----
check('disabled 是表达式且求值为真 → 不关', (() => {
  const target = row('llm-pi-ai', { disabled: () => true })
  return disableOfficialRows([target]).length === 0 && target.updates.length === 0
})())
check('disabled 是表达式且求值为假 → 关', (() => {
  const target = row('llm-pi-ai', { disabled: () => false })
  return disableOfficialRows([target]).length === 1 && target.updates.length === 1
})())
check('表达式抛错时按「没关」处理（与 Loader 守卫的 catch 一致）', (() => {
  const target = row('llm-pi-ai', { disabled: () => { throw new Error('boom') } })
  return disableOfficialRows([target]).length === 1
})())

// ---- 四行都要关 ----
check('四处官方行都能关', (() => {
  const rows = OFFICIAL_ROW_IDS.map((id) => row(id))
  const ids = disableOfficialRows(rows)
  return ids.length === OFFICIAL_ROW_IDS.length && rows.every((item) => item.updates.length === 1)
})())

// ---- 形状不认识 / 服务缺席：不炸、不谎报 ----
check('没有 update 方法的行跳过（不谎报关掉了）',
  disableOfficialRows([{ options: { id: 'llm-pi-ai' } }]).length === 0)
check('没有 options 的行跳过', disableOfficialRows([{}, null, 3]).length === 0)
check('id 不是字符串的行跳过', disableOfficialRows([{ options: { id: 42 } }]).length === 0)
check('update 抛错时不谎报', (() => {
  const target = row('llm-pi-ai')
  target.update = () => { throw new Error('nope') }
  return disableOfficialRows([target]).length === 0
})())
check('空列表不炸', disableOfficialRows([]).length === 0)
check('entries 是 iterable（不是数组）也认', (() => {
  const target = row('llm-deepseek')
  return disableOfficialRows(new Set([target]).values()).join(',') === 'llm-deepseek'
})())

// ---- loaderEntries：服务缺席、形状怪、抛错都退化成空数组 ----
check('loader 缺席 → 空数组', loaderEntries(undefined).length === 0)
check('loader 没有 entries → 空数组', loaderEntries({}).length === 0)
check('entries() 抛错 → 空数组', loaderEntries({ entries: () => { throw new Error('boom') } }).length === 0)
check('entries() 返回 iterable → 转成数组', loaderEntries({ entries: () => new Set([1, 2]).values() }).length === 2)
check('entries() 返回数组 → 原样', loaderEntries({ entries: () => [1, 2, 3] }).length === 3)

// ---- 判据用的是 Loader 自己那套（`disabled` getter），不是 options 里的字面量 ----
check('options.disabled 是表达式时以 getter 的求值为准', (() => {
  const target = row('llm-pi-ai')
  target.options.disabled = { __jsExpr: 'true' } // 原始节点还在（Loader 也保留它）
  target.disabled = true // 但 getter（求值后）说已经关了
  return disableOfficialRows([target]).length === 0
})())

console.log(failures === 0 ? 'official-rows: 全部通过' : `official-rows: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
