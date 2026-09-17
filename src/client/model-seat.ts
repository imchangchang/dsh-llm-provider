/**
 * composer 的模型座位（仿官方 ModelSelect 两级层级）：
 *   触发器胶囊（模型名 + 思考强度 + Chevron）→ 根菜单两行（模型 / 推理等级，值右对齐 + ›）
 *   → 模型面板（我们的增强：搜索 + provider 过滤 + 能力徽章，样式走官方 token）
 *   → 推理等级面板（Default + 档位，选中打勾）。
 *
 * 切换模型时强制选档：选了新模型不再立即关菜单，跳到推理等级面板让用户点一档；
 * 点档位时优先沿用上一档 id（直接命中），不在新模型档位表里时按"区间中心"做比例映射。
 * 新模型没有 reasoning 元数据时面板显示空态 +「知道了」按钮提交无档位后关闭。
 */
import react from 'react'
import { accountsById, findModel, loadModelCatalog, loadModelDetailMap, loadPlanStatus, normalizeGroups, onPlanChange, selectionCell, submitSelection, unwrap, usePolledSnapshot } from './data.js'
import { recordDiagnostic } from './diag.js'
import { defaultEffortOf, dotClass, effortLabel, formatContext, fuzzyMatch, modelVisible, quotaShortOf, quotaTipOf, reasoningTextOf, toneColor, worstPercent } from './format.js'
import { caretSvg, checkSvg, chevronRightSvg } from './icons.js'
import type { CatalogGroup, CatalogModel, EffortChoice, FieldEvent, ModelSelection, ModelSwitchSeatProps } from './types.js'

/**
 * 老的 provider id → 现在的路由 id。官方 llm-deepseek 时代的会话里记的是 `deepseek-official`，
 * 那条路由由本插件接管的 pi-ai `deepseek` 顶上（两边服务的是同一批模型）。
 */
export var LEGACY_PROVIDER_ALIASES: Record<string, string> = { 'deepseek-official': 'deepseek' }

/**
 * 把选择里已经不存在的老 provider id 折到现存路由上。
 *
 * 只在「目标 provider 和同一个 model id 都在目录里」时才折——对不上就原样返回，宁可显示
 * 那个死 id，也不能把会话悄悄指到别的模型上。档位只在新模型支持时才带过去（两套适配器的
 * 档位表不一定一致）。
 *
 * @param selection - 会话/目录给出的当前选择。
 * @param groups - 模型目录。
 * @returns 折过之后的选择；不需要折时原样返回。
 */
export function aliasSelection(selection: ModelSelection | undefined, groups: CatalogGroup[] | undefined): ModelSelection | undefined {
  if (selection === undefined || selection === null) return selection
  var mapped = LEGACY_PROVIDER_ALIASES[selection.provider]
  if (mapped === undefined || groups === undefined) return selection
  var target = findModel(groups, mapped, selection.model)
  if (target === undefined) return selection
  var effort = selection.reasoningEffort
  var efforts = target.reasoning === undefined ? undefined : target.reasoning.efforts
  var keepEffort = typeof effort === 'string' && (efforts === undefined || efforts.indexOf(effort) !== -1)
  return keepEffort
    ? { provider: mapped, model: selection.model, reasoningEffort: effort }
    : { provider: mapped, model: selection.model }
}

/**
 * 把老模型的档位索引按区间中心映射到新模型的档位索引：把 [0, oldLen) 的档位中心
 * (oldIdx + 0.5) / oldLen 当成 [0, 1) 内的点，再取反 [0, newLen) 的区间中心
 * (newIdx + 0.5) / newLen。
 *
 * 选"区间中心"而不是 Math.round(oldIdx/(oldLen-1) * (newLen-1)) 是为了避开 0.5 边界
 * 向上舍入的极值偏移——后者会让"老档中段"全部推到新档边界上；区间中心对齐是中段对
 * 中段、边界对边界，不会跳到极值。
 *
 * 例（验证用）：5→3 时 k=0/1/2/3/4 → newIdx=0/0/1/2/2。
 *
 * @param oldIdx - 老档位索引（0..oldLen-1）。
 * @param oldLen - 老档位表长度。
 * @param newLen - 新档位表长度（≥ 1）。
 * @returns 新档位索引（0..newLen-1）。
 */
export function intervalCenterMap(oldIdx: number, oldLen: number, newLen: number): number {
  if (newLen <= 1) return 0
  if (oldLen <= 0) return 0
  var ratio = (oldIdx + 0.5) / oldLen
  var raw = ratio * newLen - 0.5
  var idx = Math.round(raw)
  if (idx < 0) idx = 0
  else if (idx > newLen - 1) idx = newLen - 1
  return idx
}

/**
 * 推理档位面板里，某一档的行该不该置灰（不可点）。
 *
 * 普通换档流程里"点的就是当前那一档"是空操作，置灰即可；**强制选档流程里它恰恰是确认动作**
 * ——用户选完新模型跳到这个面板，继承下来的那一档已经被打上勾，如果它点不动，用户想「就用
 * 这一档」就没有出口（只能去点别的档再点回来，或者关掉菜单重来）。所以那种情况下必须可点。
 *
 * @param busy - 正在提交，整面板都不可点。
 * @param isCurrent - 这一行就是当前（或强制流程里预选）的那一档。
 * @param forcedPick - 是否处于「选完新模型、强制确认档位」的流程。
 * @returns true = 置灰不可点。
 */
export function effortRowDisabled(busy: boolean, isCurrent: boolean, forcedPick: boolean): boolean {
  if (busy === true) return true
  return isCurrent === true && forcedPick !== true
}

/**
 * 切换模型时算"上一档"应该带过去的继承档位：
 *   1. 新模型没有 reasoning 元数据 → undefined（面板走空态）。
 *   2. 上一档是 undefined：
 *      - 老模型也不存在（首次选模型）→ 新模型 defaultEffort（再否则 undefined）。
 *      - 老模型存在（用户之前没指定档位）→ undefined（保留"无档"偏好）。
 *   3. 上一档直接落在新模型档位表里 → 原样返回。
 *   4. 老模型档位表拿不到或上一档不在里面（脏数据）→ 新模型 defaultEffort。
 *   5. 否则按区间中心把上一档在老档位表里的索引转投到新档位表里。
 *
 * 设计意图：用户已经显式选过的档位偏好应该跟着走，除非新模型不支持——和会话迁
 * 移里 aliasSelection 的"档位在新模型支持时带过去、不支持时丢掉"同口径（见
 * `model-seat.ts:31-43`）。
 *
 * @param priorEffort - 当前会话的 reasoningEffort（可能 undefined）。
 * @param priorModel - 老模型在目录里的 CatalogModel（可迁，老数据通过）。
 * @param newModel - 新模型在目录里的 CatalogModel（可迁，新数据通过）。
 * @returns 应当作为新模型初始选中档位的 id，或 undefined（让面板走"Default"/空态）。
 */
export function resolveInheritedEffort(
  priorEffort: string | undefined,
  priorModel: CatalogModel | undefined,
  newModel: CatalogModel | undefined,
): string | undefined {
  // 1. 新模型没 reasoning → undefined
  if (newModel === undefined || newModel.reasoning === undefined) return undefined
  var newEfforts = newModel.reasoning.efforts
  var newDefault = newModel.reasoning.default
  if (newEfforts.length === 0) return undefined

  // 2. 上一档是 undefined：分"首次选"和"老档是关闭"两种
  if (priorEffort === undefined) {
    return priorModel === undefined ? newDefault : undefined
  }

  // 3. 直接命中
  if (newEfforts.indexOf(priorEffort) !== -1) return priorEffort

  // 4. 老档位表拿不到 / priorEffort 不在里面
  var priorEfforts = priorModel !== undefined && priorModel.reasoning !== undefined
    ? priorModel.reasoning.efforts
    : undefined
  if (priorEfforts === undefined || priorEfforts.length === 0) return newDefault
  var oldIdx = priorEfforts.indexOf(priorEffort)
  if (oldIdx === -1) return newDefault

  // 5. 按区间中心映射
  return newEfforts[intervalCenterMap(oldIdx, priorEfforts.length, newEfforts.length)]
}

export function ModelSwitchSeat(props: ModelSwitchSeatProps) {
  var sessionId = props.sessionId
  var sessions = props.sessions

  var openState = react.useState(false)
  var open = openState[0]
  var setOpen = openState[1]
  var paneState = react.useState('root')
  var pane = paneState[0]
  var setPane = paneState[1]
  var queryState = react.useState('')
  var query = queryState[0]
  var setQuery = queryState[1]
  var filterState = react.useState(null)
  var providerFilter = filterState[0]
  var setProviderFilter = filterState[1]
  var groupsState = react.useState([])
  var httpGroups = groupsState[0]
  var setGroups = groupsState[1]
  // 同一次目录 RPC 里的宿主默认选择：会话还没选过模型时的落点（官方口径）
  var httpDefaultState = react.useState(undefined)
  var httpDefault = httpDefaultState[0]
  var setHttpDefault = httpDefaultState[1]
  var errorState = react.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var busyState = react.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var accountsState = react.useState({})
  var accounts = accountsState[0]
  var setAccounts = accountsState[1]
  var detailsState = react.useState({})
  var detailsById = detailsState[0]
  var setDetailsById = detailsState[1]
  // 强制选档流程暂存：用户从模型面板点了新模型之后，菜单不立即关，跳到档位面板
  // 让用户点一档才提交。effortHint 由 resolveInheritedEffort 算出来，作为档位面板
  // 的初始打勾行（沿用上一档偏好）。提交 / 关闭 / 退回根面板时清掉。
  var pendingPickState = react.useState(null)
  var pendingPick = pendingPickState[0]
  var setPendingPick = pendingPickState[1]
  var rootRef = react.useRef(null)
  var searchRef = react.useRef(null)

  // 官方目录服务（inject 面给过来的那个 store）——首选数据源
  var directorySnapshot = usePolledSnapshot(props.directory, 2000)
  recordDiagnostic('seat', {
    hasInjectFace: props.directory !== undefined,
    status: directorySnapshot === undefined ? null : directorySnapshot.status,
    current: directorySnapshot === undefined ? null : directorySnapshot.current,
    groupCount: directorySnapshot === undefined || !Array.isArray(directorySnapshot.groups)
      ? null
      : directorySnapshot.groups.length,
    error: directorySnapshot === undefined ? null : directorySnapshot.error,
  })
  var directoryGroups = directorySnapshot !== undefined && Array.isArray(directorySnapshot.groups)
    ? normalizeGroups(directorySnapshot.groups)
    : undefined
  var groups = directoryGroups !== undefined && directoryGroups.length > 0 ? directoryGroups : httpGroups
  var directoryCurrent = directorySnapshot !== undefined ? (directorySnapshot.current as ModelSelection | undefined) : undefined
  var directoryError = directorySnapshot !== undefined ? directorySnapshot.error : undefined

  // 兜底：没有官方服务时用会话投影读当前选择
  var selectionCellRef = react.useMemo(
    function () {
      return selectionCell(sessions, sessionId)
    },
    [sessions, sessionId],
  )
  var selectionState = react.useState(undefined)
  var projectionSelection = selectionState[0]
  var setSelection = selectionState[1]
  // 乐观选择：提交成功后立即生效，不等投影/目录回传（plan-test 无目录服务时投影可能滞后或不回传）
  var lastSelState = react.useState(null)
  var lastSel = lastSelState[0]
  var setLastSel = lastSelState[1]
  // 当前选择：有目录服务时以它为准（官方那边 store.current 就是
  // `projected.next ?? catalog.default`，已经算好默认落点）；
  // 没有目录服务（plan-test）时按官方同一口径拼：本地乐观值 → 会话投影 → 宿主默认
  var rawSelection: ModelSelection | undefined = directoryCurrent !== undefined && directoryCurrent !== null
    ? directoryCurrent
    : (lastSel ?? projectionSelection ?? httpDefault)
  // 老会话里记的可能是已经被接管掉的那条路由（deepseek-official），折到现路由上显示与取数
  var selection = aliasSelection(rawSelection, groups)

  // 折过之后还要把会话记录也改过来：宿主在 prompt() 里校验 `routeServed(provider)`，
  // 记着死 id 的会话连消息都发不出去（no adapter serves provider …）。只在映射目标确实
  // 存在时做一次，失败也不打扰用户（下次读投影还会再试）。
  var migratedRef = react.useRef('')
  react.useEffect(
    function () {
      if (rawSelection === undefined || rawSelection === null) return
      if (selection === undefined || selection === null) return
      if (rawSelection.provider === selection.provider && rawSelection.model === selection.model) return
      var key = rawSelection.provider + '|' + rawSelection.model + '>' + selection.provider + '|' + selection.model
      if (migratedRef.current === key) return
      migratedRef.current = key
      var request: ModelSelection = selection.reasoningEffort === undefined
        ? { provider: selection.provider, model: selection.model }
        : { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
      var call = typeof props.select === 'function'
        ? props.select(request)
        : submitSelection(sessionId, request.provider, request.model, request.reasoningEffort)
      call
        .then(function (ok) {
          if (ok !== false) setLastSel(request)
        })
        .catch(function () {
          migratedRef.current = '' /* 这次没成，下次读投影时再试 */
        })
    },
    [rawSelection === undefined || rawSelection === null ? '' : rawSelection.provider + '/' + rawSelection.model,
      selection === undefined || selection === null ? '' : selection.provider + '/' + selection.model],
  )

  react.useEffect(
    function () {
      function read() {
        var next: ModelSelection | undefined
        try {
          next = unwrap(selectionCellRef.getSnapshot())
        } catch (cause) {
          next = undefined /* 投影读不到就当作没有当前选择 */
        }
        setSelection(next)
        // 投影追上本地乐观值（同一个 provider/model）就交棒：官方那边没有本地乐观值，
        // 一切以投影为准；不交棒的话 lastSel 会一直压着投影，宿主改了什么也显示不出来
        setLastSel(function (prev: ModelSelection | null | undefined) {
          if (prev === null || prev === undefined || next === undefined) return prev
          return prev.provider === next.provider && prev.model === next.model ? null : prev
        })
      }
      read()
      var timer = setInterval(read, 5000)
      return function () {
        clearInterval(timer)
      }
    },
    [selectionCellRef],
  )

  // 共享额度快照一变就跟着换（设置页单卡刷新、删掉某家 provider）——不用等自己那 60 秒轮询，
  // 否则同一份余量在设置页和触发器上会各自显示不同的值。
  react.useEffect(
    function () {
      return onPlanChange(function (payload) {
        setAccounts(accountsById(payload))
      })
    },
    [],
  )

  /**
   * 拉一次目录。官方目录服务缺席（补位形态，profile 禁用了官方 ui-model-selection）时，
   * 这是我们唯一的数据源，宿主那边是每次 RPC 实时构建的（`listProviders()` 按已配置路由报）。
   * @param alive - 可选；返回 false 表示组件已卸载，丢弃结果。
   */
  function pullCatalog(alive?: () => boolean): void {
    void loadModelCatalog()
      .then(function (next) {
        if (alive !== undefined && !alive()) return
        setGroups(next.groups)
        setHttpDefault(next.default)
      })
      .catch(function (cause) {
        if (alive !== undefined && !alive()) return
        setError(cause && cause.message ? String(cause.message) : String(cause))
      })
  }

  react.useEffect(
    function () {
      var cancelled = false
      if (typeof props.load === 'function') props.load()
      else pullCatalog(function () { return !cancelled })
      // 能力徽章/上下文标注的数据源：生效 pi-ai 包的模型详情
      loadModelDetailMap()
        .then(function (map) {
          if (!cancelled) setDetailsById(map)
        })
        .catch(function () { /* 详情拿不到就只显示名称 */ })
      return function () {
        cancelled = true
      }
    },
    [props.load],
  )

  // 触发器上的供应商余量：不等菜单打开就先拉一次额度（客户端 60 秒缓存兜住，
  // 和宿主端缓存同拍），之后每分钟补一次——长时间开着页面，余量也自己往前走。
  react.useEffect(
    function () {
      var cancelled = false
      function pull() {
        loadPlanStatus(false)
          .then(function (payload) {
            if (!cancelled) setAccounts(accountsById(payload))
          })
          .catch(function () { /* 额度拿不到就不显示余量，不影响选模型 */ })
      }
      pull()
      var timer = setInterval(pull, 60000)
      return function () {
        cancelled = true
        clearInterval(timer)
      }
    },
    [],
  )

  // 打开时刷新目录、聚焦搜索框；点外部 / Escape 关闭（Escape 先退回根面板）
  react.useEffect(
    function () {
      if (!open) return undefined
      // 目录每次都重拉：官方服务在时它自己订阅了 settings/document-updated，
      // 会跟着设置变更失效；官方服务缺席时只有下面这一拉——不拉的话，在设置页删掉
      // provider 后再打开菜单，列表里还挂着已经删掉的供应商（宿主那边其实已经不报了）。
      if (typeof props.load === 'function') props.load()
      else pullCatalog()
      if (pane === 'model' && searchRef.current !== null && searchRef.current !== undefined) {
        try {
          searchRef.current.focus()
        } catch (cause) { /* 聚焦失败无所谓 */ }
      }
      function onPointerDown(event: PointerEvent) {
        if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
      }
      function onKeyDown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
          if (pane !== 'root') setPane('root')
          else setOpen(false)
        }
      }
      document.addEventListener('pointerdown', onPointerDown)
      document.addEventListener('keydown', onKeyDown)
      // provider chips 的余量指示器：打开菜单时顺手拉一次额度
      loadPlanStatus(false)
        .then(function (payload) {
          setAccounts(accountsById(payload))
        })
        .catch(function () { /* 额度拿不到就不显示指示器 */ })
      return function () {
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('keydown', onKeyDown)
      }
    },
    [open, pane, props.load],
  )

  function show() {
    setPane('root')
    setProviderFilter(null)
    setQuery('')
    setPendingPick(null)
    setOpen(true)
  }

  /** 当前选择对应的 model 与思考强度信息。 */
  var currentModel: CatalogModel | undefined = undefined
  if (selection !== undefined && selection !== null) {
    currentModel = findModel(groups, selection.provider, selection.model)
  }
  var reasoning = currentModel !== undefined ? currentModel.reasoning : undefined
  // 会话已经定下的档位单独拿出来：目录里没有这个模型时（拿不到 reasoning）
  // 也要按它显示，否则整个思考强度会被吞掉，只剩下模型名
  var chosenEffort = selection !== undefined && selection !== null
    && typeof selection.reasoningEffort === 'string'
    ? selection.reasoningEffort
    : undefined
  var effectiveEffort = chosenEffort !== undefined
    ? chosenEffort
    : (reasoning !== undefined ? defaultEffortOf(currentModel) : undefined)
  var effortText = reasoningTextOf(chosenEffort, reasoning, defaultEffortOf(currentModel))

  // 强制选档面板的派生值：用户从模型面板点了新模型之后，菜单不立即关，
  // 而是切到档位面板让用户点一档。面板要展示新模型的 reasoning 表与
  // 继承下来的初始选中档位（pendingPick.effortHint）。
  // 触发器胶囊仍按旧 selection 显示（提交前会话选择不变），所以不替换
  // 上面的 currentModel/reasoning/effortText 派生。
  var pendingModel: CatalogModel | undefined = undefined
  var pendingReasoning = undefined as CatalogModel['reasoning']
  var pendingEffectiveEffort: string | undefined = undefined
  if (pendingPick !== null) {
    pendingModel = findModel(groups, pendingPick.provider, pendingPick.model)
    if (pendingModel !== undefined && pendingModel.reasoning !== undefined) {
      pendingReasoning = pendingModel.reasoning
    }
    pendingEffectiveEffort = pendingPick.effortHint
  }

  function submit(selectionRequest: ModelSelection): Promise<boolean> {
    if (busy) return Promise.resolve(false)
    setBusy(true)
    var request = typeof props.select === 'function'
      ? props.select(selectionRequest)
      : submitSelection(sessionId, selectionRequest.provider, selectionRequest.model, selectionRequest.reasoningEffort)
    return request
      .then(function (ok) {
        if (ok === false) throw new Error('宿主拒绝了这次切换')
        setError(null)
        setLastSel(selectionRequest)
        setOpen(false)
        setPane('root')
        return true
      })
      .catch(function (cause) {
        setError(cause && cause.message ? String(cause.message) : String(cause))
        return false
      })
      .then(function (ok) {
        setBusy(false)
        return ok
      })
  }

  function chooseModel(groupId: string, modelId: string) {
    if (selection !== undefined && selection !== null
      && selection.provider === groupId && selection.model === modelId) {
      // 点的还是当前模型：直接收起（官方行为：选中项再点一次 = 确认并关闭）
      setOpen(false)
      setPane('root')
      setPendingPick(null)
      return
    }
    // 选了新模型：算一次"上一档应该带过去"的值（区间中心映射），
    // 跳到档位面板让用户点一档才提交——避免官方那种"切完模型立刻变 Default"
    // 的体验，让用户至少看一眼推理强度面板（这是反向官方口径的产品决策）。
    // 新模型没有 reasoning 元数据时面板走空态兜底（「知道了」按钮）。
    var priorModel = selection !== undefined && selection !== null
      ? findModel(groups, selection.provider, selection.model)
      : undefined
    var newModel = findModel(groups, groupId, modelId)
    var hint = resolveInheritedEffort(chosenEffort, priorModel, newModel)
    setPendingPick({ provider: groupId, model: modelId, effortHint: hint })
    setPane('effort')
  }

  function chooseEffort(effort: string | undefined) {
    // 强制选档流程：从 pendingPick 取 provider/model，档位取调用值；不
    // 走"同档即关"那条路——提交一次才算数（用户没真按一行就不算确认）。
    if (pendingPick !== null) {
      var req: ModelSelection = { provider: pendingPick.provider, model: pendingPick.model }
      if (effort !== undefined) req.reasoningEffort = effort
      setPendingPick(null)
      void submit(req)
      return
    }
    // 普通换档流程（用户主动打开菜单换档，不经"选新模型"）：保留原行为——
    // 点的就是当前那一档就只关闭不提交。
    if (selection === undefined || selection === null) return
    if (effort === effectiveEffort) {
      setOpen(false)
      return
    }
    var req2: ModelSelection = { provider: selection.provider, model: selection.model }
    if (effort !== undefined) req2.reasoningEffort = effort
    void submit(req2)
  }

  /**
   * 强制选档流程里"该模型没有可用档位"分支的收尾：用户在空态面板上点了
   * 「知道了」，提交无 effort 的新模型选择后关闭（让宿主 resolve；没有
   * defaultEffort 时 reasoningEffort 留 undefined）。
   */
  function dismissPendingPick() {
    if (pendingPick === null) return
    var req: ModelSelection = { provider: pendingPick.provider, model: pendingPick.model }
    setPendingPick(null)
    void submit(req)
  }

  var waiting = (selection === undefined || selection === null) && directorySnapshot !== undefined && directorySnapshot.status === 'loading'
  // 模型一律显示 供应商id/模型id：和展开后的 provider chips、分组标题、模型行同一套 id
  var modelLabel = waiting
    ? '加载中…'
    : (selection === undefined || selection === null
        ? '选择模型'
        : String(selection.provider) + '/' + String(selection.model))
  var triggerText = effortText === undefined ? modelLabel : modelLabel + ' · ' + effortText

  // 供应商那段的余量指示：跟模型面板里的 provider chip 同一套取数与配色——
  // 最紧窗口百分比（没窗口就钱包余额），点按 10%/30% 分红黄绿；悬浮显示各窗口明细。
  // 当前 provider 的账户还没拿到（或这个 provider 查不了）时不显示，不影响别的内容。
  var currentAccount = selection === undefined || selection === null ? undefined : accounts[selection.provider]
  var currentQuotaText = quotaShortOf(currentAccount)
  var triggerQuota = currentAccount === undefined
    ? null
    : react.createElement(
        'span',
        { className: 'ms_tQuota', title: quotaTipOf(currentAccount), key: 'q' },
        react.createElement('span', { className: dotClass(currentAccount) }),
        currentQuotaText === undefined
          ? null
          : react.createElement(
              'span',
              { className: 'ms_tQuotaText', style: { color: toneColor(worstPercent(currentAccount)) } },
              currentQuotaText,
            ),
      )
  // 有当前选择时按「供应商 余量 / 模型」分段（余量紧跟在供应商后面），没有选择
  // （加载中 / 选择模型）时还是一段文案。分段也是为了窄屏能按段降级：
  // 空间不够先丢余量数字、再丢 provider，模型名与档位保住（见 styles.ts 的断点）。
  var triggerLabel = selection === undefined || selection === null
    ? [react.createElement('span', { className: 'ms_tLabel', key: 'all' }, modelLabel)]
    : [
        react.createElement('span', { className: 'ms_tProvider', key: 'p' }, String(selection.provider)),
        triggerQuota,
        react.createElement('span', { className: 'ms_tSlash', key: 's' }, '/ '),
        react.createElement('span', { className: 'ms_tModel', key: 'm' }, String(selection.model)),
      ]

  var trigger = react.createElement(
    'button',
    {
      type: 'button',
      className: 'ms_trigger',
      'aria-expanded': open ? 'true' : 'false',
      title: triggerText,
      onClick: function () {
        if (open) setOpen(false)
        else show()
      },
    },
    triggerLabel,
    effortText === undefined ? null : react.createElement('span', { className: 'ms_tEffort' }, effortText),
    react.createElement('span', { className: 'ms_chev' + (open ? ' ms_chevOpen' : '') }, caretSvg(open)),
  )

  if (!open) return react.createElement('div', { className: 'plan_root', ref: rootRef }, trigger)

  // ---- 根面板：模型 / 推理等级 两行（值右对齐 + ›）----
  var rootPane = react.createElement(
    'button',
    { type: 'button', className: 'ms_cell', onClick: function () { setPane('model') } },
    react.createElement('span', { className: 'ms_cellLabel' }, '模型'),
    react.createElement('span', { className: 'ms_cellValue' }, modelLabel),
    react.createElement('span', { className: 'ms_cellChev' }, chevronRightSvg()),
  )
  // 档位面板要靠目录里的档位表才能列出可选项：目录没有这个模型时只读显示会话已定的档位
  var canPickEffort = reasoning !== undefined && effortText !== undefined
  var effortCell = react.createElement(
    'button',
    {
      type: 'button',
      className: 'ms_cell',
      disabled: !canPickEffort,
      style: canPickEffort ? undefined : { cursor: 'default', opacity: 0.55 },
      title: reasoning === undefined && effortText !== undefined
        ? '当前模型不在模型目录里，只能显示会话已定的档位'
        : undefined,
      onClick: canPickEffort ? function () { setPane('effort') } : undefined,
    },
    react.createElement('span', { className: 'ms_cellLabel' }, '推理等级'),
    react.createElement('span', { className: 'ms_cellValue' }, effortText === undefined ? '选择模型后可用' : effortText),
    react.createElement('span', { className: 'ms_cellChev' }, chevronRightSvg()),
  )

  // ---- 模型面板：搜索 + provider 过滤 + 分组列表（能力徽章/上下文，选中打勾）----
  var needle = query.trim().toLowerCase()
  var modelPane = null
  if (pane === 'model') {
    var chips = [
      react.createElement(
        'button',
        {
          key: '__all',
          type: 'button',
          className: 'mp_chip',
          'data-on': providerFilter === null ? '1' : '0',
          onClick: function () { setProviderFilter(null) },
        },
        '全部 ' + String(groups.length),
      ),
    ]
    for (var ck = 0; ck < groups.length; ck += 1) {
      ;(function (g) {
        var acc = accounts[g.id]
        var quotaText = quotaShortOf(acc)
        chips.push(
          react.createElement(
            'button',
            {
              key: g.id,
              type: 'button',
              className: 'mp_chip',
              'data-on': providerFilter === g.id ? '1' : '0',
              title: quotaTipOf(acc) ?? g.id,
              onClick: function () { setProviderFilter(providerFilter === g.id ? null : g.id) },
            },
            react.createElement('span', { className: dotClass(acc) }),
            g.id,
            quotaText === undefined
              ? null
              : react.createElement('span', { style: { color: toneColor(worstPercent(acc)) } }, ' ' + quotaText),
          ),
        )
      })(groups[ck])
    }
    var groupSections = []
    for (var gs = 0; gs < groups.length; gs += 1) {
      ;(function (g) {
        if (providerFilter !== null && g.id !== providerFilter) return
        var sectionRows = []
        // 账号声明的可用模型（OAuth 登录时 pi-ai 记下的 availableModelIds）：不在里面的不列。
        // pi-ai 的静态目录与账号权益是两回事——Copilot 目录 28 个、账号只有 6 个能用，
        // 选到别的会拿 400 model_not_supported。当前选中的那个照常显示（否则用户会以为丢了）。
        var avail = accounts[g.id] === undefined ? undefined : accounts[g.id].availableModels
        for (var gm = 0; gm < g.models.length; gm += 1) {
          ;(function (model) {
            if (needle !== '' && fuzzyMatch(query, model.id + ' ' + model.name + ' ' + g.name + ' ' + g.id) !== true) return
            var isCurrent = selection !== undefined && selection !== null
              && selection.provider === g.id && selection.model === model.id
            if (modelVisible(avail, model.id, isCurrent) !== true) return
            var detail = detailsById[model.id]
            var caps = []
            if (detail !== undefined) {
              if (detail.vision === true) caps.push(react.createElement('span', { key: 'v', className: 'pv_capMini pv_capVision' }, '视觉'))
              if (detail.reasoning === true) caps.push(react.createElement('span', { key: 'r', className: 'pv_capMini pv_capReason' }, '推理'))
            }
            var ctx = formatContext(detail !== undefined && detail.contextWindow !== undefined ? detail.contextWindow : model.contextWindow)
            sectionRows.push(
              react.createElement(
                'button',
                {
                  key: g.id + '/' + model.id,
                  type: 'button',
                  className: 'ms_option',
                  disabled: busy || isCurrent,
                  title: g.id + '/' + model.id,
                  onClick: function () { chooseModel(g.id, model.id) },
                },
                react.createElement('span', { className: 'ms_name' }, model.id),
                react.createElement('span', { className: 'ms_capsCol' }, caps),
                react.createElement('span', { className: 'ms_ctxCol' }, ctx === undefined ? '' : ctx),
                react.createElement('span', { className: 'ms_check' }, isCurrent ? checkSvg() : null),
              ),
            )
          })(g.models[gm])
        }
        if (sectionRows.length === 0) return
        groupSections.push(
          react.createElement(
            'div',
            { className: 'ms_group', key: g.id },
            react.createElement('div', { className: 'ms_groupTitle' }, g.id),
            sectionRows,
          ),
        )
      })(groups[gs])
    }
    modelPane = react.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
      react.createElement('input', {
        ref: searchRef,
        className: 'mp_search',
        type: 'text',
        placeholder: '搜索模型或 provider',
        value: query,
        onChange: function (event: FieldEvent) { setQuery(event.target.value) },
      }),
      groups.length > 1 ? react.createElement('div', { className: 'mp_chips' }, chips) : null,
      directoryError !== undefined && directoryError !== null && typeof directoryError === 'string'
        ? react.createElement('div', { className: 'ms_status' }, String(directoryError))
        : null,
      react.createElement(
        'div',
        { className: 'ms_scroll' },
        groupSections,
        groupSections.length === 0
          ? react.createElement('div', { className: 'ms_status' }, needle === '' ? '没有可选模型' : '没有匹配「' + query + '」的模型')
          : null,
      ),
    )
  }

  // ---- 推理等级面板：Default + 档位，选中打勾 ----
  // 强制选档流程（pendingPick 非空）：面板里的 reasoning / 当前档位 / Default 行
  // 是否出现都按 pendingModel 算。普通换档流程（pendingPick 为空）：按当前 selection
  // 的 currentModel 算。
  // 顶部加一行小提示"已切换到 <新模型 id>，请选择推理强度"，让用户清楚是换模型
  // 流程（而不是改当前模型的档位）。
  var effortPane = null
  if (pane === 'effort') {
    if (pendingPick !== null && pendingReasoning === undefined) {
      // 空态：新模型没有 reasoning 元数据，用户点了「知道了」就以无 effort 提交。
      effortPane = react.createElement(
        'div',
        { className: 'ms_scroll' },
        react.createElement('div', { className: 'ms_status' }, '该模型没有可用的推理档位'),
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'ms_option',
            disabled: busy,
            onClick: dismissPendingPick,
          },
          react.createElement('span', { className: 'ms_name' }, '知道了'),
          react.createElement('span', { className: 'ms_check' }),
        ),
      )
    } else if (pendingPick !== null || reasoning !== undefined) {
      var pModel = pendingPick !== null ? pendingModel : currentModel
      var pReasoning = pendingPick !== null ? pendingReasoning : reasoning
      var pEffective = pendingPick !== null ? pendingEffectiveEffort : effectiveEffort
      var headerNote = pendingPick !== null
        ? '已选 ' + String(pendingPick.provider) + '/' + String(pendingPick.model) + '，请确认推理强度（点一档即确认，含已勾选那档）'
        : null
      var choices: EffortChoice[] = []
      if (defaultEffortOf(pModel) === undefined) {
        choices.push({ effort: undefined, label: 'Default' })
      }
      var effList = pReasoning !== undefined ? pReasoning.efforts : []
      for (var ec = 0; ec < effList.length; ec += 1) {
        choices.push({ effort: effList[ec], label: effortLabel(effList[ec]) ?? effList[ec] })
      }
      var effortRows = choices.map(function (level) {
        var isCur = pEffective === level.effort
        return react.createElement(
          'button',
          {
            key: level.label,
            type: 'button',
            className: 'ms_option',
            disabled: effortRowDisabled(busy, isCur, pendingPick !== null),
            onClick: function () { chooseEffort(level.effort) },
          },
          react.createElement('span', { className: 'ms_name' }, level.label),
          react.createElement('span', { className: 'ms_check' }, isCur ? checkSvg() : null),
        )
      })
      effortPane = react.createElement(
        'div',
        { className: 'ms_scroll' },
        headerNote === null
          ? null
          : react.createElement('div', { className: 'ms_status' }, headerNote),
        effortRows,
        effortRows.length === 0
          ? react.createElement('div', { className: 'ms_status' }, '没有可用的推理档位')
          : null,
      )
    }
  }

  var menuBody = pane === 'model' ? modelPane : pane === 'effort' ? effortPane : react.createElement('div', { style: { display: 'flex', flexDirection: 'column' } }, rootPane, effortCell)

  var menu = react.createElement(
    'div',
    { className: 'ms_menu' },
    menuBody,
    error === null ? null : react.createElement('div', { className: 'plan_note plan_badText' }, error),
  )

  return react.createElement('div', { className: 'plan_root', ref: rootRef }, trigger, menu)
}
