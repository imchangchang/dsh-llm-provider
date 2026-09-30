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
import { asRecord, readString, type AnyRecord, type LoaderService } from './types.js'

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

/** 一行官方行现在的状态。 */
export interface OfficialRowState {
  /** 这次真的被要求关掉的行 id。 */
  closed: string[]
  /** 其中当时确实挂着插件的（fiber 有 uid）——注销要等任务落定，调用方据此决定要不要等。 */
  running: string[]
}

/**
 * 把官方行关掉（只在本进程里，不写回文件）。
 *
 * **不能只看 `disabled` 就跳过**：那个 getter 会重新求值 patch 里的 `!!js` 守卫，而我们
 * 在这一刻已经把本插件的条目建出来了（它排在最后，所以只有我们能看到全部行），于是守卫
 * 这时会回答「该关」——可 Loader 只在挂载决策时按这个值动作，插件其实还挂着、注册还在。
 * 照 `disabled` 跳过就会正好漏掉要关的那些（0.2.x 的 loader 实测过：跳过 → 挂桥接照旧撞
 * 「already declared」）。所以判据是「真的还挂着没有」，不是「守卫说没说该关」。
 *
 * 已经关着且没挂着的（用户自己关的）不动；形状不认识、`update` 抛错的跳过——
 * 不谎报，调用方会在挂载失败时把原因报到界面上。
 *
 * @param entries - loader 的条目列表（{@link loaderEntries} 的结果）。
 * @param ids - 要关的行 id，默认 {@link OFFICIAL_ROW_IDS}。
 */
export function disableOfficialRows(
  entries: Iterable<unknown>,
  ids: readonly string[] = OFFICIAL_ROW_IDS,
): OfficialRowState {
  const closed: string[] = []
  const running: string[] = []
  for (const row of entries) {
    const id = rowIdOf(row)
    if (id === undefined || !ids.includes(id)) continue
    const record = asRecord(row)
    const active = rowIsRunning(record)
    if (!active && rowSaysDisabled(record)) continue
    const update = record['update']
    if (typeof update !== 'function') continue
    try {
      void (update as (options: { disabled: boolean }) => unknown).call(row, { disabled: true })
      closed.push(id)
      if (active) running.push(id)
    } catch {
      /* 关不掉：调用方会在挂载时报错（不再让整个插件失活） */
    }
  }
  return { closed, running }
}

/** 这一行的插件是不是真的挂着（cordis 的 Fiber：dispose 之后 uid 会被清成 null）。 */
function rowIsRunning(record: AnyRecord): boolean {
  try {
    const fiber = asRecord(record['fiber'])
    const uid = fiber['uid']
    return uid !== undefined && uid !== null
  } catch {
    return false
  }
}

/** Loader 的 `disabled` 判据（`!!js` 表达式在这一刻求值）；表达式抛错按 Loader 的 catch 处理成 false。 */
function rowSaysDisabled(record: AnyRecord): boolean {
  try {
    return record['disabled'] === true
  } catch {
    return false
  }
}
