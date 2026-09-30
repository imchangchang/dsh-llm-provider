// 官方那几行的接管：本插件要把 llm-pi-ai / llm-deepseek / ui-model-selection /
// ui-settings-models 换成自己的实现，而宿主**没有遮蔽机制**（同一个 provider/路由注册两次
// 直接抛错），所以那几行必须先关掉。
//
// 关掉这件事本来写在 cordis.patch.yml 的 `disabled: !!js` 守卫里，但守卫在**首次挂载**时
// 看不到本插件的条目：Loader 的 EntryGroup.update 按列表顺序同步求值每一行的 `disabled`
// （`Promise.all` 的回调同步跑到第一个 await 为止），而本插件的行是 bundle patch 用
// `insert` 追加的，排在最后。于是首次挂载时守卫一律返回 false（「没找到自己」），官方行照旧
// 挂载，等本插件挂桥接时就撞上：
//
//   LlmError: configurable provider "amazon-bedrock" is already declared
//
// 结果整个插件条目激活失败（界面上「组件启用失败」），连设置页都进不去。
//
// 所以这里补一刀：本插件启动时如果发现官方行还开着，就在**本进程里**把它们关掉
// （`entry.update({ disabled: true })` 会 dispose 那个 fiber，它注册的 provider/适配器
// 随 fiber 一起注销），等注销落定再挂桥接。这一刀不写回任何文件——用户自己的 patch 层不动；
// 用户把本插件关掉时本插件不运行，patch 里的守卫此时已经能看到那一行（重载时会重新求值），
// 官方行会自动恢复。
import { asRecord, readString, type LoaderService } from './types.js'

/** 本插件要接管的官方行 id（与 cordis.patch.yml 里那四处 `disabled` 一一对应）。 */
export const OFFICIAL_ROW_IDS: readonly string[] = [
  'llm-pi-ai',
  'llm-deepseek',
  'ui-model-selection',
  'ui-settings-models',
]

/** `loader.entries()` 的容错读法：拿不到就给空数组（旧宿主、树还没建好都不该炸）。 */
export function loaderEntries(loader: LoaderService | undefined): unknown[] {
  if (loader === undefined || typeof loader.entries !== 'function') return []
  try {
    const listed = loader.entries()
    return Array.isArray(listed) ? listed : [...(listed as Iterable<unknown>)]
  } catch {
    return []
  }
}

/** 一行 loader 条目的 id（形状不认识就给 undefined）。 */
function rowIdOf(row: unknown): string | undefined {
  return readString(asRecord(asRecord(row)['options'])['id'])
}

/**
 * 把还启用着的官方行关掉（只在本进程里，不写回文件），返回真关掉的 id。
 *
 * 已经关着的不动（用户自己关的、或 patch 的守卫已经生效），形状不认识的跳过，
 * 关的过程中抛错也算没关成——调用方会据此等注销落定并重试挂载。
 *
 * @param entries - loader 的条目列表（{@link loaderEntries} 的结果）。
 * @param ids - 要关的行 id，默认 {@link OFFICIAL_ROW_IDS}。
 */
export function disableOfficialRows(
  entries: Iterable<unknown>,
  ids: readonly string[] = OFFICIAL_ROW_IDS,
): string[] {
  const closed: string[] = []
  for (const row of entries) {
    const id = rowIdOf(row)
    if (id === undefined || !ids.includes(id)) continue
    const record = asRecord(row)
    // `disabled` 是 getter：`!!js` 表达式在这一刻求值，正是 Loader 自己的判据
    let disabled = false
    try {
      disabled = record['disabled'] === true
    } catch {
      // 表达式抛错时 Loader 那边也算「不禁用」（它的守卫里就是 catch 返 false），照关
      disabled = false
    }
    if (disabled) continue
    const update = record['update']
    if (typeof update !== 'function') continue
    try {
      void (update as (options: { disabled: boolean }) => unknown).call(row, { disabled: true })
      closed.push(id)
    } catch {
      /* 关不掉：调用方会等注销落定，还不行就在挂载时报错（不再让整个插件失活） */
    }
  }
  return closed
}
