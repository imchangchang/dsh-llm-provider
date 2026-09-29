/**
 * 模型清单编辑器（issue #1）：官方 Models 页被 `cordis.patch.yml` 禁用之后，逐模型参数
 * 只能手改 `settings.yaml` 的 `llm-pi-ai.providers.<id>.models`。这里把这份清单做成可编辑面板。
 *
 * 数据来源与写回：
 *   - 读：宿主在 `/provider/status` 的 `routes[].models` 里原样下发自己声明的那份清单；
 *     没声明（缺省或空数组）时，实际生效的是 pi-ai 目录里这家的全部模型（官方
 *     `resolveRouteModels` 的 `configured.length > 0 ? configured : defaults`）。
 *   - 写：`settings/mutate` 的 `set ['providers', id, 'models']`；全部取消勾选 = `unset`，
 *     也就是回到「跟随目录」。其它字段（baseURL / apiKeyEnv / compat / retryPolicy）一个字不动。
 *
 * 校验放在写之前：宿主 `resolveRouteModels` 对清单是 strict 解析，一条坏的（id 空、重名、
 * contextWindow 不是正整数）会让整条路由解析失败——那家 provider 会直接不可用，所以宁可不让保存。
 */
import react from 'react'
import { apiCall, detailOf } from './data.js'
import { formatContext } from './format.js'
import type { AnyRecord } from '../types.js'
import type { CatalogModel, ModelDetail, ModelRow } from './types.js'

/** 思考档位（与 pi-ai 的 THINKING_LEVELS 同序）：off 之外至少声明一个。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** `compat.thinkingFormat` 的可选值（pi-ai 的 SUPPORTED_THINKING_FORMATS）。 */
export const THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const

/**
 * 输入模态：**只有宿主 schema 认的这两种**。
 *
 * 官方 `llm-pi-ai` 的配置 schema 是 `input: z.array(z.union(['text','image']))`，写 `video`
 * 会让整笔 `settings/mutate` 在解析阶段就失败。pi-ai 目录里的 `video` 能力照样读、照样出徽章
 * （那是只读展示），但不写回配置。
 */
export const INPUT_MODALITIES = ['text', 'image'] as const

var rowSeq = 0

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * `reasoningEfforts`（对象映射 level → 线上值）→ 一行文本：`low,high=max`。
 *
 * pi-ai 的形状是 `{ low: "low", high: "max" }`（值是真正发出去的那个字符串），
 * `false` 表示这个模型不推理，缺省表示沿用目录里那份。编辑器用最省事的记法：
 * 纯档位名就是「值同名」，要另给线上值写 `档位=值`。
 * @param value - 配置文件里的 `reasoningEfforts` 原值。
 */
export function formatReasoningEfforts(value: unknown): string {
  if (value === false) return 'false'
  if (Array.isArray(value)) return strings(value).join(',')
  if (value === null || typeof value !== 'object') return ''
  var map = value as AnyRecord
  var parts: string[] = []
  for (var i = 0; i < THINKING_LEVELS.length; i += 1) {
    var level = THINKING_LEVELS[i]
    if (!(level in map)) continue
    var wire = map[level]
    if (typeof wire === 'string' && wire !== '') parts.push(wire === level ? level : level + '=' + wire)
    else parts.push(level)
  }
  return parts.join(',')
}

/**
 * 一行文本 → `reasoningEfforts`。空 = 不声明（沿用目录）；`false`/`off`/`关闭` = 不推理。
 * @param text - 编辑器输入。
 * @returns `value` 是要写进配置的值（undefined 表示不写这个键）；不合法时给 `error`。
 */
export function parseReasoningEfforts(text: unknown): { value?: unknown, error?: string } {
  var raw = textOf(text).trim()
  if (raw === '') return { value: undefined }
  if (/^(false|off|none|关闭|不推理)$/i.test(raw)) return { value: false }
  var tokens = raw.split(/[,，、\s]+/).filter((token) => token !== '')
  var map: Record<string, string | null> = {}
  var beyondOff = 0
  for (var i = 0; i < tokens.length; i += 1) {
    var parts = tokens[i].split(/[=:]/)
    var level = parts[0].trim().toLowerCase()
    var wire = parts.length > 1 ? parts.slice(1).join('=').trim() : level
    if ((THINKING_LEVELS as readonly string[]).indexOf(level) < 0) {
      return { error: '不认识的思考档位「' + level + '」（可用：' + THINKING_LEVELS.join(' / ') + '）' }
    }
    if (level === 'off' && (parts.length === 1 || wire === 'off')) {
      map['off'] = null
      continue
    }
    if (wire === '') return { error: '档位「' + level + '」缺少线上值（写法：' + level + '=值）' }
    map[level] = wire
    beyondOff += 1
  }
  if (beyondOff === 0) return { error: '至少要声明一个 off 之外的档位，或写 false 表示不推理' }
  return { value: map }
}

/**
 * 编辑器初始行。
 *
 * 有自己声明的清单就以它为准（这是「当前生效」的那份），否则拿 pi-ai 目录里这家的模型铺开
 * ——两边的行都标 `source`，界面上能一眼看出清单是自定义的还是跟随目录。
 * @param declared - `routes[].models`（自己声明的清单）。
 * @param catalog - 该 provider 的目录模型。
 * @param detailsById - `/provider/models` 的详情表（补上下文/最大输出/能力）。
 */
export function editorRowsOf(
  declared: unknown,
  catalog: readonly CatalogModel[],
  detailsById?: Record<string, ModelDetail> | null,
  provider?: string,
): ModelRow[] {
  var rows: ModelRow[] = []
  if (Array.isArray(declared) && declared.length > 0) {
    for (var i = 0; i < declared.length; i += 1) {
      var raw = declared[i]
      var entry: AnyRecord = typeof raw === 'string' ? { id: raw } : (raw === null || typeof raw !== 'object' ? {} : raw as AnyRecord)
      var compat = entry['compat'] === null || typeof entry['compat'] !== 'object' ? {} : entry['compat'] as AnyRecord
      var declaredInput = strings(entry['input']).filter((item) => (INPUT_MODALITIES as readonly string[]).indexOf(item) >= 0)
      // 详情按 provider + id 查：同名模型跨 provider 很常见，裸 id 会串家（issue #5）
      var declaredDetail = detailOf(detailsById, provider === undefined ? '' : provider, entry['id'])
      var declaredKnown = declaredInput.length > 0 || (declaredDetail !== undefined && declaredDetail.capabilitiesKnown === true)
      rowSeq += 1
      rows.push({
        key: 'declared-' + String(rowSeq),
        id: textOf(entry['id']),
        name: textOf(entry['name']),
        contextWindow: numberText(entry['contextWindow']),
        maxTokens: numberText(entry['maxTokens']),
        // 清单没写 input 时，实际生效的是目录里那份（resolveEntry 的 `?? base?.input`）
        input: declaredInput.length > 0 ? declaredInput : (declaredKnown ? modalityList(declaredDetail) : ['text']),
        // 这条行的 input 是不是「查到的」：没查到就不该在保存时把它写成显式声明——
        // 那等于拿一个占位的 ['text'] 盖掉 pi-ai 目录里的视觉能力
        inputKnown: declaredKnown,
        inputTouched: false,
        reasoning: formatReasoningEfforts(entry['reasoningEfforts']),
        thinkingFormat: textOf(compat['thinkingFormat']),
        enabled: true,
        source: 'declared',
      })
    }
    return rows
  }
  for (var c = 0; c < catalog.length; c += 1) {
    var model = catalog[c]
    var detail = detailOf(detailsById, provider === undefined ? '' : provider, model.id)
    var known = detail !== undefined && detail.capabilitiesKnown === true
    rowSeq += 1
    rows.push({
      key: 'catalog-' + String(rowSeq),
      id: textOf(model.id),
      name: textOf(model.name),
      contextWindow: numberText(model.contextWindow),
      maxTokens: detail === undefined ? '' : numberText(detail.maxTokens),
      input: known ? modalityList(detail) : ['text'],
      inputKnown: known,
      inputTouched: false,
      reasoning: '',
      thinkingFormat: '',
      enabled: true,
      source: 'catalog',
    })
  }
  return rows
}

/** 目录详情 → 输入模态列表（只列 schema 认的那两种；video 只用于只读徽章）。 */
function modalityList(detail: ModelDetail | undefined): string[] {
  var list = ['text']
  if (detail !== undefined && detail.vision === true) list.push('image')
  return list
}

/** 编辑器行 → 写进配置的 models 数组，并在写之前把宿主会拒绝的错误挑出来。 */
export function editorToModels(rows: readonly ModelRow[]): { models: AnyRecord[], errors: string[] } {
  var models: AnyRecord[] = []
  var errors: string[] = []
  var seen: Record<string, boolean> = {}
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i]
    if (row.enabled !== true) continue
    var id = row.id.trim()
    var where = id === '' ? '第 ' + String(i + 1) + ' 行' : id
    if (id === '') {
      errors.push('第 ' + String(i + 1) + ' 行的模型 ID 是空的')
      continue
    }
    if (seen[id] === true) {
      errors.push('模型 ID 重复：' + id)
      continue
    }
    seen[id] = true
    var entry: AnyRecord = { id: id }
    if (row.name.trim() !== '') entry['name'] = row.name.trim()
    var contextWindow = positiveInteger(row.contextWindow)
    if (row.contextWindow.trim() !== '' && contextWindow === undefined) {
      errors.push(where + ' 的上下文窗口要写正整数')
    } else if (contextWindow !== undefined) {
      entry['contextWindow'] = contextWindow
    }
    var maxTokens = positiveInteger(row.maxTokens)
    if (row.maxTokens.trim() !== '' && maxTokens === undefined) {
      errors.push(where + ' 的最大输出要写正整数')
    } else if (maxTokens !== undefined) {
      entry['maxTokens'] = maxTokens
    }
    // input 只在「能力查到了」或「用户在界面上动过」时写：否则一个占位的 ['text'] 会被
    // 官方 `declaredInput(entry.input) ?? base?.input` 当成声明，把目录里的视觉能力盖掉
    var input = row.input.filter((item: string) => (INPUT_MODALITIES as readonly string[]).indexOf(item) >= 0)
    if (row.inputTouched === true && input.length === 0) {
      // 宿主把「空数组」和「没写」当同一回事（都表示沿用目录），所以这里没有「一种都不要」的表达：
      // 与其静默写一个 ['text'] 把视觉模型钉成纯文本，不如让用户改用「恢复跟随目录」
      errors.push(where + ' 的输入模态至少选一种（两种都不要 = 沿用目录，请用「恢复跟随目录」或「还原」）')
    } else if (row.inputKnown === true || row.inputTouched === true) {
      entry['input'] = input
    }
    var reasoning = parseReasoningEfforts(row.reasoning)
    if (reasoning.error !== undefined) errors.push(where + '：' + reasoning.error)
    else if (reasoning.value !== undefined) entry['reasoningEfforts'] = reasoning.value
    var format = row.thinkingFormat.trim()
    if (format !== '') entry['compat'] = { thinkingFormat: format }
    models.push(entry)
  }
  return { models: models, errors: errors }
}

function positiveInteger(text: string): number | undefined {
  var raw = text.trim()
  if (raw === '') return undefined
  var value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** 编辑器里那一行的说明文字（保存后提示用了多少模型、有多大）。 */
export function editorSummary(rows: readonly ModelRow[]): string {
  var enabled = 0
  for (var i = 0; i < rows.length; i += 1) if (rows[i].enabled === true) enabled += 1
  return String(enabled) + '/' + String(rows.length) + ' 个模型已勾选'
}

/** 目录模型的一行摘要（详情卡里那句话，界面上放在「目录」那一栏）。 */
export function catalogHintOf(model: CatalogModel | undefined, detail: ModelDetail | undefined): string {
  if (model === undefined) return ''
  var parts: string[] = []
  var context = formatContext(detail !== undefined && detail.contextWindow !== undefined ? detail.contextWindow : model.contextWindow)
  if (context !== undefined) parts.push(context)
  if (detail !== undefined && detail.vision === true) parts.push('视觉')
  if (detail !== undefined && detail.reasoning === true) parts.push('推理')
  return parts.join(' · ')
}

/** 编辑器面板的属性。 */
export interface ModelListEditorProps {
  /** 路由 id（settings 里 `llm-pi-ai.providers` 的键）。 */
  routeId: string
  /** 宿主下发的自己声明的清单；没有就是跟随目录。 */
  declared?: unknown
  /** 该 provider 的目录模型。 */
  catalog?: readonly CatalogModel[]
  /** /provider/models 的详情表。 */
  detailsById?: Record<string, ModelDetail> | null
  /** 保存成功后通知外层刷新（额度卡片与模型列表都吃同一份快照）。 */
  onSaved?: () => void
  /** 初次渲染就展开面板（离线测试要跑到展开分支；界面上默认收起）。 */
  defaultOpen?: boolean
}

/**
 * 模型清单编辑面板。
 *
 * 交互只有三件事：勾选/取消、改字段、保存；底部固定给「恢复跟随目录」的出口，
 * 因为「一份都不勾」在宿主语义里等于回到目录，不能让它变成一个别扭的中间态。
 */
export function ModelListEditor(props: ModelListEditorProps) {
  var declaredCount = Array.isArray(props.declared) ? props.declared.length : 0
  var openState = react.useState(props.defaultOpen === true)
  var open = openState[0] === true
  var setOpen = openState[1]
  // react 是 any（见 src/react.d.ts）：显式 cast 出 tuple，回调里才不至于隐式 any
  var rowsState = react.useState(
    editorRowsOf(props.declared, props.catalog === undefined ? [] : props.catalog, props.detailsById, props.routeId),
  ) as [ModelRow[], (next: ModelRow[] | ((prev: ModelRow[]) => ModelRow[])) => void]
  var rows = rowsState[0]
  var setRows = rowsState[1]
  var noteState = react.useState('')
  var note = noteState[0]
  var setNote = noteState[1]
  var busyState = react.useState(false)
  var busy = busyState[0] === true
  var setBusy = busyState[1]
  // 宿主那份清单、或目录/详情晚到（/provider/models 要等适配器自报，最坏几秒）时重置草稿：
  // 不然第一帧的空详情会被当成「能力就是 text」，一保存就把 route 的视觉能力钉死。
  // 依赖用 declared 的序列化签名（每次渲染都是新对象，直接依赖会每帧重置）。
  // 用户已经动过的草稿不重置（`dirtyRef`），免得编辑到一半被刷新冲掉。
  var dirtyRef = react.useRef(false)
  var declaredSignature = JSON.stringify(props.declared === undefined ? null : props.declared)
  react.useEffect(function () {
    if (dirtyRef.current === true) return
    setRows(editorRowsOf(props.declared, props.catalog === undefined ? [] : props.catalog, props.detailsById, props.routeId))
  }, [declaredSignature, props.catalog, props.detailsById])

  /** 改一行里的某个字段（一改就标成「草稿」，晚到的目录/详情不再覆盖它）。 */
  function patchRow(key: string, patch: Partial<ModelRow>) {
    dirtyRef.current = true
    setRows(function (prev: ModelRow[]) {
      var next: ModelRow[] = []
      for (var i = 0; i < prev.length; i += 1) {
        if (prev[i].key !== key) {
          next.push(prev[i])
          continue
        }
        var merged: AnyRecord = {}
        for (var field in prev[i]) merged[field] = (prev[i] as unknown as AnyRecord)[field]
        for (var changed in patch) merged[changed] = (patch as AnyRecord)[changed]
        next.push(merged as unknown as ModelRow)
      }
      return next
    })
  }

  var planned = editorToModels(rows)
  var blocked = planned.errors.length > 0

  function save() {
    if (blocked) return
    setBusy(true)
    setNote('')
    // 全部取消勾选 = 回到「跟随目录」：宿主对空清单的语义就是整份目录，不能写一个空数组
    // 假装「没有模型」（那会被 resolveRouteModels 当成没声明）。
    var ops = planned.models.length === 0
      ? [{ op: 'unset', path: ['providers', props.routeId, 'models'] }]
      : [{ op: 'set', path: ['providers', props.routeId, 'models'], value: planned.models }]
    apiCall('settings/mutate', { ns: 'llm-pi-ai', ops }, '保存模型清单失败')
      .then(function () {
        // 存完就不是草稿了：宿主那份清单回来时照常重置（也能接住宿主做的规范化）
        dirtyRef.current = false
        setNote(planned.models.length === 0
          ? '已恢复「跟随目录」：这条路由不再声明清单，模型目录说了算'
          : '已保存 ' + String(planned.models.length) + ' 个模型到 settings.yaml')
        if (typeof props.onSaved === 'function') props.onSaved()
      })
      .catch(function (cause: unknown) {
        setNote('保存失败：' + String(cause !== null && cause !== undefined && (cause as AnyRecord)['message'] ? (cause as AnyRecord)['message'] : cause))
      })
      .then(function () {
        setBusy(false)
      })
  }

  function input(props2: AnyRecord, key: string, value: string, onChange: (next: string) => void, className: string, placeholder: string) {
    return react.createElement('input', {
      ...props2,
      key: key,
      className: className,
      type: 'text',
      value: value,
      placeholder: placeholder,
      onChange: function (event: AnyRecord) {
        onChange(String((event['target'] as AnyRecord)['value']))
      },
    })
  }

  var bar = react.createElement(
    'div',
    { className: 'pv_meBar', key: 'me-bar' },
    react.createElement(
      'span',
      { className: 'pv_meState', key: 'me-state' },
      declaredCount > 0
        ? '模型清单：自己声明的 ' + String(declaredCount) + ' 个'
        : '模型清单：跟随目录（' + String(props.catalog === undefined ? 0 : props.catalog.length) + ' 个）',
    ),
    react.createElement(
      'button',
      {
        type: 'button',
        className: 'pv_action',
        key: 'me-toggle',
        onClick: function () { setOpen(open !== true) },
      },
      open ? '收起清单' : '编辑清单',
    ),
  )
  if (!open) return react.createElement('div', { className: 'pv_me', key: 'me' }, bar)

  var rowEls = []
  for (var i = 0; i < rows.length; i += 1) {
    ;(function (row: ModelRow) {
      var children = [
        react.createElement('input', {
          key: 'on',
          className: 'pv_meOn',
          type: 'checkbox',
          checked: row.enabled === true,
          title: row.enabled === true ? '取消勾选 = 这条不写进清单' : '勾选 = 写进清单',
          onChange: function () { patchRow(row.key, { enabled: row.enabled !== true }) },
        }),
        input({}, 'id', row.id, function (next) { patchRow(row.key, { id: next }) }, 'pv_meId', '模型 ID'),
        input({}, 'name', row.name, function (next) { patchRow(row.key, { name: next }) }, 'pv_meName', '显示名（可空）'),
        input({}, 'cw', row.contextWindow, function (next) { patchRow(row.key, { contextWindow: next }) }, 'pv_meNum', '上下文'),
        input({}, 'mt', row.maxTokens, function (next) { patchRow(row.key, { maxTokens: next }) }, 'pv_meNum', '最大输出'),
      ]
      var modalityEls = []
      for (var mi = 0; mi < INPUT_MODALITIES.length; mi += 1) {
        ;(function (modality: string) {
          modalityEls.push(react.createElement(
            'label',
            { key: 'mod-' + modality, className: 'pv_meMod', title: '这个模型收不收 ' + modality },
            react.createElement('input', {
              type: 'checkbox',
              checked: row.input.indexOf(modality) >= 0,
              onChange: function () {
                var next = row.input.slice()
                var at = next.indexOf(modality)
                if (at >= 0) next.splice(at, 1)
                else next.push(modality)
                patchRow(row.key, { input: next, inputTouched: true })
              },
            }),
            modality === 'text' ? '文本' : modality === 'image' ? '图片' : '视频',
          ))
        })(INPUT_MODALITIES[mi])
      }
      children.push(react.createElement('span', { key: 'mods', className: 'pv_meMods' }, modalityEls))
      children.push(input({}, 'reason', row.reasoning, function (next) { patchRow(row.key, { reasoning: next }) }, 'pv_meReason', '思考档位 low,high'))
      var formatOptions = [react.createElement('option', { key: 'none', value: '' }, '（不声明）')]
      for (var fi = 0; fi < THINKING_FORMATS.length; fi += 1) {
        formatOptions.push(react.createElement('option', { key: THINKING_FORMATS[fi], value: THINKING_FORMATS[fi] }, THINKING_FORMATS[fi]))
      }
      children.push(react.createElement(
        'select',
        {
          key: 'fmt',
          className: 'pv_meFmt',
          title: 'compat.thinkingFormat：这个模型按哪种 thinking 协议发参数',
          value: row.thinkingFormat,
          onChange: function (event: AnyRecord) {
            patchRow(row.key, { thinkingFormat: String((event['target'] as AnyRecord)['value']) })
          },
        },
        formatOptions,
      ))
      if (declaredCount === 0 && row.source === 'catalog') {
        children.push(react.createElement('span', { key: 'src', className: 'pv_meSrc', title: '这行来自 pi-ai 目录' }, '目录'))
      }
      children.push(react.createElement(
        'button',
        {
          key: 'del',
          type: 'button',
          className: 'pv_iconBtn',
          title: '从清单里去掉这一行',
          onClick: function () {
            dirtyRef.current = true
            setRows(function (prev: ModelRow[]) {
              return prev.filter((item) => item.key !== row.key)
            })
          },
        },
        '×',
      ))
      rowEls.push(react.createElement('div', { className: 'pv_meRow' + (row.enabled === true ? '' : ' pv_meRowOff'), key: row.key }, children))
    })(rows[i])
  }

  var actions: unknown[] = [
    react.createElement(
      'button',
      {
        key: 'add',
        type: 'button',
        className: 'pv_action',
        onClick: function () {
          rowSeq += 1
          dirtyRef.current = true
          setRows(function (prev: ModelRow[]) {
            var next = prev.slice()
            next.push({
              key: 'custom-' + String(rowSeq),
              id: '',
              name: '',
              contextWindow: '',
              maxTokens: '',
              input: ['text'],
              inputKnown: false,
              inputTouched: true,
              reasoning: '',
              thinkingFormat: '',
              enabled: true,
              source: 'declared',
            })
            return next
          })
        },
      },
      '＋ 添加一行',
    ),
    react.createElement(
      'button',
      {
        key: 'save',
        type: 'button',
        className: 'pv_action pv_actionPrimary',
        disabled: busy || blocked,
        title: blocked ? planned.errors.join('；') : '写回 settings.yaml 的 llm-pi-ai.providers.' + props.routeId + '.models',
        onClick: save,
      },
      busy ? '保存中 ...' : '保存',
    ),
    react.createElement(
      'button',
      {
        key: 'reset',
        type: 'button',
        className: 'pv_action',
        disabled: busy,
        onClick: function () {
          dirtyRef.current = false
          setRows(editorRowsOf(props.declared, props.catalog === undefined ? [] : props.catalog, props.detailsById, props.routeId))
          setNote('已经还原成打开时的内容')
        },
      },
      '还原',
    ),
  ]
  if (declaredCount > 0) {
    actions.push(react.createElement(
      'button',
      {
        key: 'follow',
        type: 'button',
        className: 'pv_action',
        disabled: busy,
        title: '删掉这条路由的 models 字段，回到「整份 pi-ai 目录」',
        onClick: function () {
          dirtyRef.current = true
          setRows(editorRowsOf(undefined, props.catalog === undefined ? [] : props.catalog, props.detailsById, props.routeId))
          setNote('已切到「跟随目录」草稿：保存后生效')
        },
      },
      '恢复跟随目录',
    ))
  }

  return react.createElement(
    'div',
    { className: 'pv_me', key: 'me' },
    bar,
    react.createElement(
      'div',
      { className: 'pv_mePanel', key: 'me-panel' },
      react.createElement(
        'div',
        { className: 'pv_meHint', key: 'me-hint' },
        (declaredCount === 0
          ? '这条路由现在跟随 pi-ai 目录：保存会把当前勾选的模型写成显式清单（此后目录新增的模型不再自动出现）；一份都不勾 = 保持跟随目录。'
          : '勾选要暴露给这条路由的模型，改完点保存；一份都不勾 = 恢复「跟随目录」。')
        + '字段留空表示沿用 pi-ai 目录里那份（目录里没有的自定义 id 没得沿用，请把上下文与最大输出填全）。',
      ),
      react.createElement('div', { className: 'pv_meRows', key: 'me-rows' }, rowEls),
      react.createElement('div', { className: 'pv_meActs', key: 'me-acts' }, actions),
      react.createElement('div', { className: 'pv_meCount', key: 'me-count' }, editorSummary(rows)),
      planned.errors.length === 0
        ? null
        : react.createElement('div', { className: 'pv_meErr', key: 'me-err' }, '保存前先修好：' + planned.errors.join('；')),
      note === ''
        ? null
        : react.createElement('div', { className: 'pv_meNote', key: 'me-note' }, note),
    ),
  )
}
