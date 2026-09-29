/**
 * 设置页 Provider 标签：CC Switch 式卡片 + 「添加供应商」面板 + 「pi-ai 桥接」二级标签。
 * 桥接明细行是纯函数（piAiBridgeRows），组件照着渲染——离线可测。
 */
import react from 'react'
import type { AnyRecord } from '../types.js'
import {
  STATUS_UNAVAILABLE,
  apiCall,
  dropPlanAccount,
  findById,
  getJson,
  isSafeBlankPrompt,
  loadModelCatalog,
  loadModelDetailMap,
  loadPlanStatus,
  loadProviderStatus,
  mergePlanAccount,
  onPlanChange,
  postJson,
  startOauthAttempt,
  withKey,
  withKeys,
  detailOf,
} from './data.js'
import { dotClass, formatContext, fuzzyMatch, headlineChips, linkTextOf, modelVisible, refreshable, relativeTime, resetCountdownText, shortName, toneColor, worstPercent } from './format.js'
import { caretSvg } from './icons.js'
import { ModelListEditor } from './model-editor.js'
import { t } from './i18n.js'
import type { AddProviderPanelProps, BridgeRow, CatalogModel, FieldEvent, HeadlineChip, ModelDetail, OauthAttemptClient, OauthEvent, OauthPrompt, PlanAccount, ProviderPreset } from './types.js'

/**
 * 一个预设的认证入口，按 flow 的方法区分。
 *
 * 挂上 authorization 服务之后**每个 provider 都有 flow**，但方法含义不同：`oauth` 是真·订阅
 * 登录（device-code / 浏览器），`api-key` 只是 dsh 把「让你输密钥」也包装成了一次登录。所以
 * 「有 flow 就显示 OAuth 按钮」是错的——DeepSeek / OpenAI / Moonshot 只有 api-key 方法，
 * 给它们显示「使用 OAuth 登录（DeepSeek）」既误导又顶掉了密钥输入框。
 *
 * @param preset - 选中的预设（可能为 undefined）。
 * @returns `oauth`：可用的 OAuth 方法（没有则 undefined）；`onlyApiKey`：只有 api-key 方法。
 */
export function authEntryOf(preset: ProviderPreset | undefined): {
  oauth: { id: string, label: string } | undefined
  onlyApiKey: boolean
} {
  var methods = preset === undefined || preset.oauth === undefined ? [] : preset.oauth.methods
  var oauthMethod
  for (var i = 0; i < methods.length; i += 1) {
    if (methods[i].id === 'oauth') { oauthMethod = { id: methods[i].id, label: methods[i].label }; break }
  }
  return { oauth: oauthMethod, onlyApiKey: methods.length > 0 && oauthMethod === undefined }
}

/**
 * 卡片上「这条路由写死了协议 / 地址」的判定，以及一键修正该删哪些字段。
 *
 * 官方适配器是 `request.api ?? base?.api ?? routeApi`、`request.baseURL ?? base?.baseUrl
 * ?? providerBaseUrl`：路由写了就盖掉每个模型自己的那份。要报的只有两种：
 *   - 目录多协议（Copilot：claude 走 anthropic-messages、gpt-5.x 走 openai-responses）：
 *     写死必然让另一批发错端点、报 400；
 *   - 目录单协议但写死的跟它不一致：那是真配错了。
 * 单协议 + 写对了不报（那种白报只会让用户去点一个没必要的按钮）。
 *
 * 删的字段里要不要带 `baseURL`：只有「配置里钉着、且这个地址就在目录的端点集合里」才带——
 * 那是旧版表单自动写进去的目录地址，同样会盖掉模型自己的端点；用户自己写的地址（企业版
 * 端点、自建网关）不在集合里，一个字都不能动。
 *
 * @param account - 卡片对应的额度账户（读 `api` / `baseUrl` / `baseUrlPinned`）。
 * @param catalogApis - 目录里这家出现过的协议（`preset.apis`）。
 * @param catalogBaseUrls - 目录里这家出现过的端点（`preset.baseUrls`）。
 * @returns `fields` 为空表示不用报；否则是点修正时要 unset 的字段；`multiProtocol` 决定文案。
 */
export function routeRepairOf(
  account: { api?: string, baseUrl?: string, baseUrlPinned?: boolean },
  catalogApis: string[],
  catalogBaseUrls: string[],
): { fields: string[], multiProtocol: boolean } {
  var pinnedApi = typeof account.api === 'string' && account.api !== '' ? account.api : undefined
  if (pinnedApi === undefined) return { fields: [], multiProtocol: false }
  var multiProtocol = catalogApis.length > 1
  var mismatch = catalogApis.length === 1 && catalogApis[0] !== pinnedApi
  if (multiProtocol !== true && mismatch !== true) return { fields: [], multiProtocol: false }
  var fields = ['api']
  var address = account.baseUrlPinned === true ? account.baseUrl : undefined
  if (typeof address === 'string' && address !== '' && catalogBaseUrls.indexOf(address) >= 0) fields.push('baseURL')
  return { fields: fields, multiProtocol: multiProtocol }
}

/**
 * 「添加到列表」写进 settings 的路由配置。
 *
 * **OAuth 授权过的 provider 绝不写 apiKeyEnv**：官方适配器的 resolveApiKey 只要看到
 * `apiKeyEnv` 就只认那个 ref，取不到值直接抛 MISSING_CREDENTIAL（实测报错原文：
 * "its profile resolves GITHUB_COPILOT_API_KEY, which is not set … remove apiKeyEnv only if
 * this provider should authenticate from pi-ai's own environment discovery"）。OAuth 的凭据
 * 存在凭据记录的 grant 里、不在 ref 那个键空间，写上去等于把这条路堵死。留空 apiKeyEnv，
 * pi-ai 才会走自己的凭据解析拿到 grant。
 *
 * **协议和端点都属于 pi-ai 目录，不写**：官方适配器里是
 *   `const api = request.api ?? base?.api ?? routeApi`
 *   `const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl`
 * ——路由上写了就盖掉每个模型自己的那份，而一家可能多协议多端点（Copilot：claude 走
 * anthropic-messages、gpt-5.x 走 openai-responses；OpenRouter/Fireworks/opencode 的
 * anthropic 与 openai 端点还差一个 /v1 后缀）。实测写死 anthropic-messages 让 gpt-5.4 报
 * 400「no model endpoints available given user constraints」。地址留空同理：**不能写空串**，
 * `'' ?? x` 不会回落到目录，那是个空端点。用户显式填了（企业版端点、自建网关）才写。
 *
 * @param form - 表单当前值。
 * @param oauthAuthorized - 这次是否已经走完 OAuth 登录。
 * @param custom - 是不是自建网关（目录里查不到，协议/端点必须落盘）。
 * @returns 写进 `llm-pi-ai.providers.<routeId>` 的对象。
 */
export function routeProfileOf(
  form: { api: string, baseURL: string, apiKeyEnv: string },
  oauthAuthorized: boolean,
  custom: boolean,
): AnyRecord {
  var profile: AnyRecord = {}
  var baseURL = form.baseURL.trim()
  if (baseURL !== '') profile.baseURL = baseURL
  // 自建网关不在目录里，没有可回落的东西，协议必须写（表单里也只有它渲染协议选择框）。
  if (custom === true) profile.api = form.api
  if (oauthAuthorized !== true) profile.apiKeyEnv = form.apiKeyEnv.trim()
  return profile
}

/**
 * 这次写路由时要顺带清掉的字段（与 {@link routeProfileOf} 同源）。
 *
 * 写配置现在是逐字段合并，不是整对象覆盖：省略某个字段没有任何效果。OAuth 授权成功后
 * 我们不再写 `apiKeyEnv`，可用户之前用密钥跑过、配置里那个 ref 还在，官方适配器看到它
 * 就只认它，取不到值直接抛 MISSING_CREDENTIAL——必须显式删。
 *
 * @param oauthAuthorized - 这次是否确实走完了 OAuth 登录。
 * @returns 交给宿主 `/provider/mutate` 的 `unsets`。
 */
export function routeClearedFields(oauthAuthorized: boolean): string[] {
  return oauthAuthorized ? ['apiKeyEnv'] : []
}

/**
 * 组装写路由的请求体（纯函数，离线可测）。
 *
 * 单独抽出来是为了让测试能真的把「界面发出的这个包」喂给宿主的解析函数——
 * 两边对不上（字段名改了、少带了 unsets）是这类跨端接线的典型坏法，
 * 各自测自己那一半都测不出来。
 *
 * @param routeId - 路由 id。
 * @param value - 要合并进去的字段。
 * @param unsets - 顺带要删掉的字段名（空数组就不带这个键）。
 */
export function mergeRequestOf(routeId: string, value: AnyRecord, unsets: string[]): AnyRecord {
  var body: AnyRecord = { routeId: routeId, op: 'merge', value: value }
  if (unsets.length > 0) body.unsets = unsets
  return body
}

/** 当前用的是哪一档 pi-ai。宿主报的 source：版本号 / 'dependency' / 'dsh'。 */
function piAiSourceLabel(source: unknown): string {
  if (source === 'dependency') return '兜底依赖'
  if (source === 'dsh') return 'dsh 自带'
  return '已下载'
}

function piAiSourceHint(source: unknown): string {
  if (source === 'dependency') return '插件 vendor/ 下手动安装的兜底版本（可选档；没装就会落到 dsh 自带那份）'
  if (source === 'dsh') return 'dsh 自己装的那份 pi-ai，版本随 dsh 发布走（不一定比上游旧）'
  return '按需下载并验证过的版本，放在 vendor/pi-ai/<版本>/；换版本需重启 dsh'
}

/**
 * 「pi-ai 桥接」标签页的明细行。纯函数，只返回数据，组件照着渲染——这样能离线测，
 * 也免得一堆拼字符串的逻辑埋在组件里。
 * @param bridge - /provider/status 的 bridge 段（当前加载的那份）。
 * @param update - 同上的 update 段（上游最新 / 待生效 / 体检没过的）。
 * @param oauth - 同上的 oauth 段（authorization 服务在不在、注册了几条 flow）。缺省不渲染这一行。
 * @returns `[{ key, text, value?, title?, warn? }]`；value 是右侧的次要文字。
 */
export function piAiBridgeRows(bridge: unknown, update: unknown, oauth?: unknown, store?: unknown): BridgeRow[] {
  var rows: BridgeRow[] = []
  if (bridge === undefined || bridge === null) return rows
  var bridgeRecord = bridge as AnyRecord
  if (bridgeRecord.active !== true) {
    rows.push({ key: 'err', text: String(bridgeRecord.error), bad: true })
    return rows
  }
  rows.push({
    key: 'pi',
    text: '当前 pi-ai 版本',
    value: String(bridgeRecord.piAiVersion) + '（' + piAiSourceLabel(bridgeRecord.source) + '）',
    title: piAiSourceHint(bridgeRecord.source),
  })
  // 体检没执行（bundle 的 import 需求解析不出）：这份 pi-ai 是靠「目录存在」放行的，没验证过
  if (bridgeRecord.probeUnverified === true) {
    rows.push({
      key: 'unverified',
      text: '当前这份 pi-ai 没做过兼容性体检',
      value: '看原因',
      title: '解析不出桥接副本的 import 需求（上游改了打包格式），按目录存在放行。建议关注 pi-ai 发版说明',
      warn: true,
    })
  }
  // 体检没过的候选：为什么没用上更新的那版
  var rejected = Array.isArray(bridgeRecord.rejected) ? bridgeRecord.rejected : []
  for (var i = 0; i < rejected.length; i += 1) {
    var skipped = rejected[i] as AnyRecord
    rows.push({
      key: 'skip-' + i,
      text: '跳过 ' + String(skipped.version) + '：兼容性检查没通过',
      value: '看原因',
      title: String(skipped.error),
      warn: true,
    })
  }
  // OAuth 体检：服务不在 = OAuth 入口整块不会有；服务在但 0 条 flow = 官方 llm-pi-ai 的
  // inject 还没跑（或 catalog 里没有可登录的 provider）。两种情况给的动作不一样，分开说。
  if (oauth !== undefined && oauth !== null) {
    var oauthRecord = oauth as AnyRecord
    var flows = typeof oauthRecord.flows === 'number' ? oauthRecord.flows : 0
    if (oauthRecord.available !== true) {
      rows.push({
        key: 'oauth-off',
        text: 'OAuth 登录不可用：authorization 服务没挂上',
        value: '看原因',
        title: '原版 dsh 的 bundle 不挂 @deepseek-ai/dsh-authorization，本插件会在启动时补挂。这里为 false 说明补挂失败（宿主里找不到这个包，或加载报错）——看 dsh 启动日志里的 provider 告警',
        warn: true,
      })
    } else if (flows === 0) {
      rows.push({
        key: 'oauth-empty',
        text: 'OAuth 登录：服务在，但没有已注册的登录方式',
        value: '看原因',
        title: 'authorization 服务已就位，但没有 flow。官方 llm-pi-ai 会在服务出现后按 pi-ai 目录注册，若长时间为 0 说明这一步没跑起来（provider 列不出登录方式）',
        warn: true,
      })
    } else {
      rows.push({ key: 'oauth-ok', text: 'OAuth 登录可用', value: String(flows) + ' 个登录方式' })
    }
  }
  // provider 配置的读写现状：0.1.x 写 settings 的 llm-pi-ai 段、0.2.x 写 profile patch 里
  // 本插件的 config；两条路都试过才成功（自愈）也要说出来
  if (store !== undefined && store !== null) {
    var storeRecord = store as AnyRecord
    var via = storeRecord['via']
    var mode = String(storeRecord['mode'] === undefined ? '' : storeRecord['mode'])
    var modeText = mode === 'own'
      ? '本插件条目'
      : mode === 'legacy'
        ? '老 ' + String(storeRecord['legacyNs'] === undefined ? 'llm-pi-ai' : storeRecord['legacyNs']) + ' 段'
        : '内置默认'
    var viaText = via === 'config-editor'
      ? 'configEditor（profile patch）'
      : via === 'settings-mutate'
        ? 'settings.mutate（settings 段）'
        : '还没写过'
    var counts = '自带条目 ' + String(storeRecord['ownCount']) + ' / 老段 ' + String(storeRecord['legacyCount'])
    rows.push({
      key: 'store',
      text: '配置写入',
      value: viaText,
      title: '当前 providers 来自' + modeText + '（' + counts + '）。'
        + '0.2.x 宿主只认插件条目里的 config，0.1.x 宿主读 settings 的 llm-pi-ai 段——'
        + '两条路都会试，能走通的那条会记住。',
    })
    var storeWarnings = Array.isArray(storeRecord['warnings']) ? storeRecord['warnings'] : []
    if (typeof storeRecord['lastError'] === 'string' && storeRecord['lastError'] !== '') {
      rows.push({
        key: 'store-err',
        text: '上一次写配置失败',
        value: '看原因',
        title: String(storeRecord['lastError']),
        warn: true,
      })
    }
    for (var sw = 0; sw < storeWarnings.length; sw += 1) {
      rows.push({
        key: 'store-warn-' + sw,
        text: '配置来源有告警',
        value: '看原因',
        title: String(storeWarnings[sw]),
        warn: true,
      })
    }
  }
  // 最近一次检查更新的结论
  if (update !== undefined && update !== null) {
    var updateRecord = update as AnyRecord
    if (updateRecord.pending !== undefined) {
      rows.push({ key: 'pending', text: '已下载 ' + String(updateRecord.pending) + '，验证通过（完整性 + 兼容性），重启 dsh 后生效', warn: true })
    }
    if (updateRecord.rejected !== undefined && updateRecord.rejected !== null) {
      var rejectedLatest = updateRecord.rejected as AnyRecord
      rows.push({
        key: 'rejected',
        text: String(rejectedLatest.version) + ' 验证没通过，已跳过（不会切过去）',
        value: '看原因',
        title: String(rejectedLatest.error),
        warn: true,
      })
    }
  }
  return rows
}

/** 上游那一行的文字（右侧按钮由组件补）。 */
export function piAiUpstreamText(update: unknown): string {
  if (update === undefined || update === null) return '上游 未检查'
  var updateRecord = update as AnyRecord
  if (updateRecord.latest === undefined) return '上游 未检查'
  var when = updateRecord.lastCheck === undefined ? '' : '（检查于 ' + relativeTime(updateRecord.lastCheck) + '）'
  return '上游 ' + String(updateRecord.latest) + when
}

/**
 * 删除确认行的代价说明（issue #3）：说清删的是哪条路由、连不连凭据、什么不可恢复。
 * 宿主侧 `/provider/remove` 做的是 `unset providers.<id>` 加 `credentials.unset(apiKeyEnv)`，
 * 也就是整段 route 一起没——手写的 `models` / `compat.thinkingFormat` / `retryPolicy` 都在里面。
 * @param account - 额度账户（也用同一套 route id）。
 */
export function deleteConfirmText(account: unknown): string {
  var record = account === null || account === undefined ? {} : account as AnyRecord
  var id = String(record['id'] === undefined ? '' : record['id'])
  var keyEnv = typeof record['apiKeyEnv'] === 'string' ? record['apiKeyEnv'] : ''
  return '将删除路由 ' + id
    + (keyEnv === '' ? '' : ' 与其凭据 ' + keyEnv)
    + '：整段配置（手写的模型清单 / compat / retryPolicy）一并消失，不可撤销。'
}

/** 字节数人性化：1.2 GB / 82 MB / 512 KB。 */
export function formatBytes(value: unknown): string {
  var n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

/**
 * 「pi-ai 桥接」标签页里的磁盘占用行（issue #4：代码 220 KB，运行副本 260 MB，界面上得看得见、
 * 清得掉）。
 * @param storage - /provider/status 的 storage 段（见宿主 updater 的 vendorUsage）。
 */
export function piAiStorageRows(storage: unknown): BridgeRow[] {
  if (storage === undefined || storage === null) return []
  var record = storage as AnyRecord
  var downloads = Array.isArray(record.downloads) ? record.downloads : []
  var parts = []
  for (var i = 0; i < downloads.length; i += 1) {
    var entry = downloads[i] as AnyRecord
    parts.push(String(entry.version) + ' ' + formatBytes(entry.bytes))
  }
  var rows: BridgeRow[] = [
    {
      key: 'disk',
      text: '插件目录占用',
      value: formatBytes(record.vendorBytes),
      title: (parts.length > 0 ? '已下载的 pi-ai：' + parts.join('、') : '没有已下载的 pi-ai 版本，跑的是 dsh 自带或用兜底依赖那份')
        + '。清理只删「不会再被选中」的重复副本与旧版本，正在用的那份一个字节不动。',
    },
  ]
  var cacheBytes = (typeof record.cacheBytes === 'number' ? record.cacheBytes : 0)
    + (typeof record.legacyCacheBytes === 'number' ? record.legacyCacheBytes : 0)
  if (cacheBytes > 0) {
    rows.push({
      key: 'disk-cache',
      text: 'npm 缓存',
      value: formatBytes(cacheBytes),
      title: '更新依赖时用的 npm 缓存（系统临时目录）。清理掉只影响下次装依赖的速度，不影响已装好的版本。',
    })
  }
  return rows
}

/** 单个摘要 chip：「5h余量:90% 34min后重置」；余额类无标签只显示金额；sep 为组间分割线。 */
function headlineChip(chip: HeadlineChip, key: number) {
  if (chip.sep === true) {
    return react.createElement('span', { key: 'sep' + String(key), className: 'pv_chipSep' })
  }
  if (chip.label === undefined || chip.label === null) {
    // 余额类（API 按量）：无窗口标签，直接显示金额
    return react.createElement(
      'span',
      { key: String(key), className: 'pv_chipItem' },
      react.createElement('span', { key: 't', style: { color: toneColor(chip.percent) } }, chip.text),
    )
  }
  var parts = [
    react.createElement('span', { key: 'l', className: 'pv_chipLabel' }, chip.label + ':'),
    react.createElement('span', { key: 't', style: { color: toneColor(chip.percent) } }, chip.text),
  ]
  if (chip.reset !== undefined && chip.reset !== '') {
    parts.push(react.createElement('span', { key: 'r', className: 'pv_chipReset' }, ' ◷ ' + resetCountdownText(chip.reset)))
  }
  return react.createElement('span', { key: String(key), className: 'pv_chipItem' }, parts)
}

/** 模型行：名称 + 能力徽章（视觉/推理/视频）+ 上下文标签，悬浮出 Cherry 式详情卡。 */
function modelRow(model: CatalogModel, account: PlanAccount, detailsById: Record<string, ModelDetail> | undefined | null) {
  var detail = detailOf(detailsById, account.id, model.id)
  var cw = detail !== undefined && detail.contextWindow !== undefined ? detail.contextWindow : model.contextWindow
  var ctx = formatContext(cw)
  var caps = []
  if (detail !== undefined) {
    if (detail.vision === true) caps.push(react.createElement('span', { key: 'v', className: 'pv_capMini pv_capVision' }, '视觉'))
    if (detail.reasoning === true) caps.push(react.createElement('span', { key: 'r', className: 'pv_capMini pv_capReason' }, '推理'))
    if (detail.video === true) caps.push(react.createElement('span', { key: 't', className: 'pv_capMini pv_capVideo' }, '视频'))
  }
  return react.createElement(
    'div',
    { className: 'pv_mRow', key: 'm-' + model.id },
    react.createElement('span', { className: 'pv_mId', title: model.id }, model.id),
    react.createElement('span', { className: 'pv_mName', title: model.name }, model.name),
    react.createElement('span', { className: 'pv_mCaps' }, caps),
    react.createElement('span', { className: 'pv_mCtx' }, ctx === undefined ? '' : ctx),
    modelTip(model, account, detail),
  )
}

/**
 * 能力来源的显示名（issue #5 的四条链路）。
 * @param source - 详情里的 source 字段。
 */
export function detailSourceLabel(source: unknown): string | undefined {
  if (source === 'route') return '路由声明（settings.yaml）'
  if (source === 'catalog') return 'pi-ai 目录'
  if (source === 'adapter') return '适配器自报'
  return undefined
}

/** Cherry 式模型详情卡：服务商 / 模型 ID / 能力标记 / 上下文 / 最大输出 / 思维链。 */
function modelTip(model: CatalogModel, account: PlanAccount, detail: ModelDetail | undefined) {
  var rows = [react.createElement('div', { className: 'pv_tipTitle', key: 't' }, model.name)]
  rows.push(tipLine('服务商', shortName(account), 'p'))
  rows.push(tipLine('模型 ID', model.id, 'id'))
  if (detail !== undefined) {
    var caps = []
    if (detail.vision === true) caps.push(tipCap('视觉', 'pv_capVision'))
    if (detail.video === true) caps.push(tipCap('视频', 'pv_capVideo'))
    if (detail.reasoning === true) caps.push(tipCap('推理', 'pv_capReason'))
    if (caps.length > 0) rows.push(react.createElement('div', { className: 'pv_tipCaps', key: 'c' }, caps))
    else if (detail.capabilitiesKnown === false) {
      // 能力字段一个都没查到：说清「不知道」，别让人以为这是「都没有」
      rows.push(react.createElement('div', { className: 'pv_tipDim', key: 'nocap' }, '能力未知：三条链路（路由声明 / pi-ai 目录 / 适配器）都没报，所以不打徽章'))
    }
    if (detail.contextWindow !== undefined) rows.push(tipLine('上下文窗口', detail.contextWindow.toLocaleString('en-US'), 'cw'))
    if (detail.maxTokens !== undefined) rows.push(tipLine('最大输出', detail.maxTokens.toLocaleString('en-US'), 'mt'))
    rows.push(tipLine('思维链', detail.reasoning === true
      ? (Array.isArray(detail.thinkingLevels) && detail.thinkingLevels.length > 0 ? detail.thinkingLevels.join('、') : '自动')
      : '关闭', 'tk'))
    var sourceLabel = detailSourceLabel(detail.source)
    if (sourceLabel !== undefined) rows.push(tipLine('能力来源', sourceLabel, 'src'))
  } else {
    rows.push(react.createElement('div', { className: 'pv_tipDim', key: 'dim' }, '该模型没有本地元数据：能力未知，不打徽章（不猜）'))
  }
  return react.createElement('div', { className: 'pv_tip' }, rows)
}

function tipLine(label: unknown, value: unknown, key: unknown) {
  return react.createElement(
    'div',
    { className: 'pv_tipRow', key: String(key) },
    react.createElement('span', { className: 'pv_tipLabel' }, label),
    react.createElement('span', null, String(value)),
  )
}

function tipCap(text: unknown, cls: string) {
  return react.createElement('span', { className: 'pv_cap ' + cls }, text)
}

/**
 * 「添加供应商」下拉里一项的状态：已配置**且密钥在**才禁选。
 * 路由配好了但还没密钥（插件自带 config 就声明了 deepseek 这种）仍可选中——选中它就是走一遍
 * 表单把密钥存进去，否则用户既加不了新的、也补不了那一条缺的 key。
 */
export function presetPickState(preset: ProviderPreset): { disabled: boolean; tag: string | null } {
  if (preset.configured !== true) return { disabled: false, tag: null }
  if (preset.missingKey === true) return { disabled: false, tag: '缺密钥' }
  return { disabled: true, tag: '已配置' }
}

/**
 * 「刷新余量 / 保存密钥」之后的结果判定：成功返回 undefined，失败给出原因。
 *
 * 宿主这两条路由一律回 200，成败看 body 的 ok；凭据没值时 ok=false，原因挂在 account.error
 * 上（"DEEPSEEK_API_KEY 没有值"）。只判 account 在不在会在没配 key 时弹一句"✓ 余量已刷新"，
 * 跟卡片上那句"未配置 key"直接打架。
 */
export function refreshFailure(result: unknown): string | undefined {
  var record = result === null || result === undefined ? {} : (result as AnyRecord)
  if (record.ok === true) return undefined
  var account = record.account
  if (account !== null && typeof account === 'object') {
    var reason = (account as AnyRecord).error
    if (reason !== undefined && reason !== null && String(reason) !== '') return String(reason)
  }
  if (record.error !== undefined && record.error !== null) return String(record.error)
  return '未知错误'
}

/**
 * 添加 provider：选预设 → 填密钥/端点 → 测试 → 通过才能添加。
 * 测试走官方 llm/discoverModels 草稿探测（不落盘）；写入走官方同一套控制器
 * （settings/mutate 写 llm-pi-ai.providers 段 + credentials/set 存密钥），
 * 与官方 Models 页的存储完全同源。
 */
function AddProviderPanel(props: AddProviderPanelProps) {
  var presets: ProviderPreset[] = Array.isArray(props.presets) ? props.presets : []
  var openState = react.useState(false)
  var open = openState[0]
  var setOpen = openState[1]
  var formState = react.useState({ routeId: '', key: '', baseURL: '', api: '', apiKeyEnv: '', websiteUrl: undefined })
  var form = formState[0]
  var setForm = formState[1]
  var testState = react.useState({ phase: 'idle', message: '' })
  var test = testState[0]
  var setTest = testState[1]
  var busyState = react.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var noteState = react.useState(null)
  var note = noteState[0]
  var setNote = noteState[1]
  // OAuth 登录流：尝试态独立于表单，attempt 一旦 settled 也清掉，授权后回到添加流程。
  // react 是 default export，TS 推不出 useState 的签名；整 tuple `as` cast 让 setOauth 的
  // prev 类型是 OAuthFlowState | null，不要让回调里漏成隐式 any。
  type OAuthFlowState = {
    attempt: OauthAttemptClient | undefined,
    notices: { message: string, url?: string, code?: string }[],
    prompt: { promptId: string, prompt: OauthPrompt } | undefined,
    pendingValue: string,
    pendingSelect: string,
    pendingBusy: boolean,
    /** 刚复制的是哪一项：对应按钮文案临时变成「已复制」（1.5 秒后自己变回来）。 */
    copied: '' | 'link' | 'code',
    /** 用户是不是选了 GitHub Enterprise：true 才把「企业域名」那个提问显示出来。 */
    enterprise: boolean,
    /** 这次流程里自动替用户答过「留空即默认」的提问（弹窗里据此给一行说明 + 切换入口）。 */
    autoBlanked: boolean,
    done: undefined | { status: 'authorized' | 'cancelled' | 'failed', error?: string },
  }
  type OAuthFlowSetter = (next: OAuthFlowState | null | ((prev: OAuthFlowState | null) => OAuthFlowState | null)) => void
  // 「改用 API 密钥」：两者都支持的 provider 上，用户可以在 OAuth 与密钥之间切。
  // 默认按 flow 的方法定：只有 api-key 方法的（DeepSeek / OpenAI 这类）就是密钥型。
  var useKeyState = react.useState(null) as [boolean | null, (next: boolean | null) => void]
  var useKeyInsteadChoice = useKeyState[0]
  var setUseKeyInsteadChoice = useKeyState[1]
  var oauthState = react.useState(null) as [OAuthFlowState | null, OAuthFlowSetter]
  var oauth = oauthState[0]
  var setOauth = oauthState[1]
  var pickRef = react.useRef(null)
  var pickOpenState = react.useState(false)
  var pickOpen = pickOpenState[0]
  var setPickOpen = pickOpenState[1]
  var pickFilterState = react.useState('')
  var pickFilter = pickFilterState[0]
  var setPickFilter = pickFilterState[1]

  // 供应商下拉：点外部关闭
  react.useEffect(
    function () {
      if (pickOpen !== true) return undefined
      function onPointerDown(event: PointerEvent) {
        if (pickRef.current !== null && pickRef.current.contains(event.target) === false) {
          setPickOpen(false)
        }
      }
      document.addEventListener('pointerdown', onPointerDown)
      return function () {
        document.removeEventListener('pointerdown', onPointerDown)
      }
    },
    [pickOpen],
  )

  function patchForm(patch: AnyRecord) {
    setForm(function (prev: AnyRecord) {
      return withKeys(prev, patch)
    })
  }
  function pickPreset(id: string) {
    var preset = findById(presets, id)
    if (preset === undefined) return
    // 换了供应商就回到该方法下的默认入口（密钥型默认密钥，有 OAuth 的默认 OAuth）；
    // 上一个 provider 的登录流要撤掉——它的 attempt 是那个 provider 的凭据键。
    setUseKeyInsteadChoice(null)
    abandonOauth()
    patchForm({
      routeId: preset.id,
      // 地址不预填：目录 provider 的端点由 pi-ai 按模型决定（一家可能多端点，比如
      // fireworks 的 anthropic 用 /inference、openai 用 /inference/v1），写进路由会盖掉。
      // preset.baseURL 只当占位提示；用户想覆盖（企业版端点、带占位符的网关）再自己填。
      baseURL: '',
      api: preset.api,
      apiKeyEnv: preset.apiKeyEnv,
      websiteUrl: preset.websiteUrl,
      key: '',
    })
    setTest({ phase: 'idle', message: '' })
    setNote(null)
  }
  function runTest() {
    // 目录里的 provider 不需要地址（目录自带）；自建网关没有目录，必须填。
    if (form.routeId.trim() === '' || form.key.trim() === '' || (customPicked && form.baseURL.trim() === '')) {
      setTest({ phase: 'fail', message: customPicked ? '路由 ID / API 地址 / API 密钥都要填' : '路由 ID 和 API 密钥都要填' })
      return
    }
    // 目录 provider 带不带密钥、地址填得对不对，这一步都验不出来：官方的 discoverModels 对有
    // 目录的 provider 直接返回目录，不发请求也不看密钥。所以文案要照实说，别让用户以为
    // 「✓ 连通」等于密钥可用（错密钥会在发第一条消息时才报 401）。
    var catalogLookup = findById(presets, form.routeId.trim())
    var catalogProvider = catalogLookup !== undefined && catalogLookup.custom !== true
    setTest({
      phase: 'run',
      message: catalogProvider ? '正在读 pi-ai 目录里这家的模型…' : '正在用这把密钥实连供应商探测模型…',
    })
    // api/baseURL 只有自建网关才带（目录 provider 的是 undefined/空）：没有目录的才靠它们
    // 决定往哪发请求。
    postJson('/provider/discover', {
      request: {
        provider: form.routeId.trim(),
        baseURL: form.baseURL.trim() === '' ? undefined : form.baseURL.trim(),
        api: form.api,
        apiKey: form.key.trim(),
      },
    })
      .then(function (value: AnyRecord) {
        // 宿主自己按两代宿主试命名空间（0.1.x 的 llm-pi-ai / 0.2.x 的插件条目 id），
        // 客户端不再写死；失败时把宿主给的诊断带出来
        if (value === null || value === undefined || value.ok !== true) {
          throw new Error(String((value && value.error) || '探测失败'))
        }
        var raw: unknown = value.models
        var rawRecord = raw === null || typeof raw !== 'object' ? undefined : raw as AnyRecord
        var models = Array.isArray(raw) ? raw : (rawRecord !== undefined && Array.isArray(rawRecord['models']) ? rawRecord['models'] as unknown[] : [])
        var names = []
        for (var i = 0; i < models.length && i < 3; i += 1) {
          var m = models[i]
          names.push(typeof m === 'string' ? m : String((m && (m.name || m.id)) || '?'))
        }
        var list = names.length > 0 ? '：' + names.join('、') + (models.length > 3 ? ' …' : '') : ''
        setTest({
          phase: 'ok',
          message: catalogProvider
            ? '✓ 目录里有 ' + String(models.length) + ' 个模型' + list + '（密钥要到发第一条消息时才校验）'
            : '✓ 连通，发现 ' + String(models.length) + ' 个模型' + list,
        })
      })
      .catch(function (cause) {
        setTest({ phase: 'fail', message: '✗ ' + String(cause && cause.message ? cause.message : cause) })
      })
  }
  function add() {
    setBusy(true)
    setNote(null)
    // 只有「这次确实走完 OAuth 登录」才不写 apiKeyEnv；选了密钥路径就照旧写。
    var profile = routeProfileOf(form, oauthAuthorized && useKeyInstead !== true, customPicked)
    // set 是整个对象覆盖：这条路由原来钉了地址（企业版端点这类，用户自己写的）而这次表单里
    // 没填（字段是空的、只显示占位符），别把它静默抹掉。
    var existingAddress = props.addressOf === undefined ? undefined : props.addressOf(form.routeId.trim())
    if (profile.baseURL === undefined && typeof existingAddress === 'string' && existingAddress !== '') {
      profile.baseURL = existingAddress
    }
    var typedKey = form.key.trim()
    var routeId = form.routeId.trim()
    // 配置怎么写由宿主决定（0.1.x 写 settings 的 llm-pi-ai 段，0.2.x 写 profile patch 里本插件
    // 条目的 config）；merge 是逐字段合并，手写的 models / compat / retryPolicy 一个字不动。
    var cleared = routeClearedFields(oauthAuthorized && useKeyInstead !== true)
    postJson('/provider/mutate', mergeRequestOf(routeId, profile, cleared))
      .then(function (result: AnyRecord) {
        if (result === null || result === undefined || result.ok !== true) {
          throw new Error(String((result && result.error) || '写配置失败'))
        }
      })
      .then(function () {
        // 只有手填了密钥才写凭据：OAuth 登录已经把凭据提交到凭据记录里（key 是
        // `llm-pi-ai/<provider>`，与这里的 apiKeyEnv 是两个键空间），拿空字符串去 set
        // 只会留下一条没用的空 ref。
        if (typedKey === '') return undefined
        return apiCall('credentials/set', { ref: form.apiKeyEnv.trim(), value: typedKey })
      })
      .then(function () {
        // 加完就收起面板：下面新出现的卡片才是结果，留着一个填完的表单只是干扰。
        // 失败仍然留着面板并把原因写在 note 里（好让用户改完重试）。
        setTest({ phase: 'idle', message: '' })
        patchForm({ key: '' })
        setOauth(null)
        setNote(null)
        setOpen(false)
        if (typeof props.onAdded === 'function') props.onAdded()
      })
      .catch(function (cause) {
        setNote('添加失败：' + String(cause && cause.message ? cause.message : cause)
          + '（配置可能已写入、仅密钥未存，检查后可重试）')
      })
      .then(function () {
        setBusy(false)
      })
  }

  // ---- OAuth 流：把官方 bundle 的 flow 暴露给浏览器，弹窗收 notice / prompt，settled 触发 onAdded ----
  /**
   * 起一次登录。
   * @param options.enterprise - true 时把 GitHub Copilot 的「企业域名」提问显示出来；
   *   默认 false：那一步留空即 github.com，替用户答掉（上游每次登录都要问一遍，绝大多数人用不上）。
   * @param options.fresh - true 时让宿主撤掉在跑的 attempt 重开（切换 Enterprise 要重走流程）。
   */
  function startOauth(options?: { enterprise?: boolean, fresh?: boolean }) {
    var oauthInfo = pickedPreset === undefined ? undefined : pickedPreset.oauth
    if (oauthInfo === undefined || oauthInfo.key === '') return
    var wantEnterprise = options !== undefined && options.enterprise === true
    setOauth({
      attempt: undefined,
      notices: [],
      prompt: undefined,
      pendingValue: '',
      pendingSelect: oauthInfo.methods[0]?.id ?? '',
      pendingBusy: true,
      copied: '',
      enterprise: wantEnterprise,
      autoBlanked: false,
      done: undefined,
    })
    startOauthAttempt(oauthInfo.key, oauthInfo.methods[0]?.id, function (event: OauthEvent) {
      // 返回字符串 = 替用户回答这个 prompt。只对「留空即默认」的那条（Copilot 的企业域名）生效，
      // 别的提问一律照常显示——粘贴回调 URL 那种自动答空串会直接搞坏登录。
      if (event.kind === 'prompt' && wantEnterprise !== true && isSafeBlankPrompt(event.prompt)) {
        setOauth(function (prev) {
          return prev === null ? null : { ...prev, autoBlanked: true }
        })
        return ''
      }
      setOauth(function (prev) {
        if (prev === null) return null
        var next = { ...prev }
        if (event.kind === 'notice') {
          next.notices = prev.notices.concat([event.notice])
          return next
        }
        if (event.kind === 'prompt') {
          next.prompt = { promptId: event.promptId, prompt: event.prompt }
          // 默认值：text/secret 空；select 用 options[0]
          next.pendingValue = ''
          next.pendingSelect = event.prompt.kind === 'select' && event.prompt.options.length > 0
            ? (event.prompt.options[0]?.id ?? '')
            : ''
          next.pendingBusy = false
          return next
        }
        if (event.kind === 'settled') {
          next.done = { status: event.status, error: event.error }
          next.pendingBusy = false
          // 授权成功后：提示下一步（OAuth 只解决凭据，路由还得写进配置），并刷新卡片。
          if (event.status === 'authorized') {
            setNote('OAuth 登录成功，凭据已保存。点「添加到列表」把 '
              + form.routeId.trim() + ' 写进配置即可使用。')
            if (typeof props.onAdded === 'function') {
              // setTimeout 把 onAdded 挪出 setOauth，避免在 setState 内触发外部 setState
              setTimeout(function () { props.onAdded!() }, 0)
            }
          }
          return next
        }
        return prev
      })
      return undefined
    }, options !== undefined && options.fresh === true)
      .then(function (attempt) {
        setOauth(function (prev) {
          if (prev === null) return null
          return { ...prev, attempt: attempt, pendingBusy: false }
        })
      })
      .catch(function (cause) {
        setOauth(function (prev) {
          if (prev === null) return null
          return { ...prev, done: { status: 'failed', error: String(cause && cause.message ? cause.message : cause) }, pendingBusy: false }
        })
      })
  }
  /**
   * 复制链接或串码：链接打不开（浏览器拦了新窗口、或想换台设备打开）时至少能自己粘；串码要在
   * 另一个页面里手输，能复制就不用对着屏幕敲。
   * 剪贴板 API 不可用或被拒时什么都不做——文本本身可选中，不弹错误打扰用户。
   * @param text - 要复制的文本。
   * @param what - 标记是哪一项，按钮据此显示「已复制」。
   */
  function copyOauthText(text: string, what: 'link' | 'code') {
    try {
      var clipboard = navigator === undefined ? undefined : navigator.clipboard
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
      clipboard.writeText(text).then(function () {
        setOauth(function (prev) { return prev === null ? null : { ...prev, copied: what } })
        setTimeout(function () {
          setOauth(function (prev) { return prev === null ? null : { ...prev, copied: '' } })
        }, 1500)
      }, function () { /* 被拒：文本本身可选中，不打扰 */ })
    } catch (cause) { /* 没有剪贴板 API：同上 */ }
  }
  /**
   * 改用 GitHub Enterprise 重新登录：当前那次已经替用户答过「企业域名」了，没法回头改，
   * 只能撤掉重开（fresh 让宿主先撤在跑的 attempt，不复用）。
   */
  function useEnterpriseOauth() {
    var current = oauth
    if (current !== null && current.attempt !== undefined) current.attempt.cancel()
    // 让 cancel 先送达宿主（abort → settle），再起新的；fresh 也会兜一层。
    setTimeout(function () { startOauth({ enterprise: true, fresh: true }) }, 50)
  }
  function cancelOauth() {
    setOauth(function (prev) {
      if (prev === null || prev.attempt === undefined) return prev
      prev.attempt.cancel()
      return { ...prev, pendingBusy: true }
    })
  }
  function closeOauth() {
    setOauth(function (prev) {
      if (prev !== null && prev.attempt !== undefined) prev.attempt.close()
      return null
    })
  }
  /**
   * 放弃这次登录：撤掉宿主上在跑的 attempt、关掉 SSE、清空弹窗状态。
   *
   * 「改用 API 密钥」和「换一个供应商」都走这里。**不能只 `setOauth(null)`**：SSE 不关会漏
   * 连接，宿主的 attempt 还在跑，等它 settle 成 authorized 时回调里 `prev === null` 会把真
   * 结果丢掉——界面既不提示成功、`oauthAuthorized` 也永远是 false，用户卡在「添加」灰着的
   * 状态里（授权其实已经写进凭据记录了）。
   */
  function abandonOauth() {
    setOauth(function (prev) {
      if (prev === null) return null
      if (prev.attempt !== undefined) {
        prev.attempt.cancel()
        prev.attempt.close()
      }
      return null
    })
  }
  function submitOAuth() {
    setOauth(function (prev) {
      if (prev === null || prev.attempt === undefined || prev.prompt === undefined) return prev
      var prompt = prev.prompt
      var value: string
      if (prompt.prompt.kind === 'select') value = prev.pendingSelect
      else value = prev.pendingValue
      // 空字符串是合法答案（Copilot 的「企业域名，留空即 github.com」），不该在这里拦；
      // secret 那种空提交没意义，由提交按钮的 disabled 兜住。
      prev.attempt.respond(prompt.promptId, value)
        .then(function () {
          setOauth(function (latest) {
            if (latest === null) return null
            return { ...latest, prompt: undefined, pendingBusy: true, pendingValue: '', pendingSelect: '' }
          })
        })
        .catch(function (cause) {
          setOauth(function (latest) {
            if (latest === null) return null
            return { ...latest, done: { status: 'failed', error: String(cause && cause.message ? cause.message : cause) }, pendingBusy: false }
          })
        })
      return { ...prev, pendingBusy: true }
    })
  }

  if (!open) {
    return react.createElement(
      'button',
      { type: 'button', className: 'pv_addBtn', onClick: function () { setOpen(true) } },
      t('addProvider'),
    )
  }

  // 供应商可过滤下拉：fuzzyMatch 复用模型过滤那套（缩写/错拼都行）
  var pickedPreset = findById(presets, form.routeId)
  var pickedLabel = pickedPreset === undefined ? form.routeId : pickedPreset.label
  var customPicked = pickedPreset !== undefined && pickedPreset.custom === true
  // 这次登录是否已授权：授权过就不必再走「填密钥 → 测试」那条路（OAuth 没有密钥可填）。
  var oauthAuthorized = oauth !== null && oauth.done !== undefined && oauth.done.status === 'authorized'
  // OAuth-only 供应商：界面只留「供应商 / 路由 ID / 登录方式」。地址和协议都是目录里带着的
  // 东西，用户不需要看见；也没有可测的密钥。
  var oauthOnlyPicked = pickedPreset !== undefined && pickedPreset.oauthOnly === true
  // 认证入口按 flow 的方法分（见 authEntryOf 的注释）：没显式选过就让默认值决定。
  var authEntry = authEntryOf(pickedPreset)
  var useKeyInstead = useKeyInsteadChoice === null || useKeyInsteadChoice === undefined
    ? authEntry.oauth === undefined
    : useKeyInsteadChoice === true
  function setUseKeyInstead(next: boolean) {
    setUseKeyInsteadChoice(next)
    if (next === true) abandonOauth()
  }
  var pickItems = []
  for (var pk = 0; pk < presets.length; pk += 1) {
    ;(function (preset) {
      if (pickFilter.trim() !== '' && fuzzyMatch(pickFilter, preset.label + ' ' + preset.id) !== true) return
      var pick = presetPickState(preset)
      pickItems.push(
        react.createElement(
          'button',
          {
            key: preset.id,
            type: 'button',
            className: 'pv_pickItem',
            disabled: pick.disabled,
            onClick: function () {
              pickPreset(preset.id)
              setPickOpen(false)
            },
          },
          preset.label,
          pick.tag === null
            ? null
            : react.createElement('span', { className: 'plan_tag', style: { marginLeft: '6px' } }, pick.tag),
        ),
      )
    })(presets[pk])
  }
  if (pickItems.length === 0) {
    pickItems.push(react.createElement('div', { className: 'pv_pickEmpty', key: 'empty' }, '没有匹配的供应商'))
  }

  return react.createElement(
    'div',
    { className: 'pv_pc' },
    react.createElement('div', { className: 'pv_pcBody', style: { borderTop: '0', paddingTop: '10px', gap: '6px' } },
      react.createElement(
        'div',
        { className: 'pv_line pv_row' },
        react.createElement('span', null, '供应商'),
        react.createElement(
          'span',
          { className: 'pv_pick', ref: pickRef },
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'pv_field pv_pickBtn',
              onClick: function () {
                setPickOpen(!pickOpen)
                setPickFilter('')
              },
            },
            react.createElement('span', null, form.routeId === '' ? '选择供应商…' : pickedLabel),
            react.createElement('span', { className: 'pv_pcCaret' }, pickOpen ? '▾' : '▸'),
          ),
          pickOpen === false
            ? null
            : react.createElement(
                'div',
                { className: 'pv_pickMenu' },
                react.createElement('input', {
                  className: 'pv_mFilter',
                  style: { width: '100%' },
                  type: 'text',
                  placeholder: '过滤供应商',
                  value: pickFilter,
                  autoFocus: true,
                  onChange: function (event: FieldEvent) { setPickFilter(event.target.value) },
                }),
                react.createElement('div', { className: 'pv_pickList' }, pickItems),
              ),
        ),
      ),
      react.createElement(
        'div',
        { className: 'pv_line pv_row' },
        react.createElement('span', null, '路由 ID'),
        react.createElement('input', {
          className: customPicked ? 'pv_field pv_key' : 'pv_field pv_ro',
          value: form.routeId,
          readOnly: customPicked !== true,
          title: customPicked ? '给这个网关起个名字（kebab-case）' : '由所选供应商决定',
          onChange: function (event: FieldEvent) {
            if (customPicked !== true) return
            patchForm({ routeId: event.target.value, apiKeyEnv: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY' })
          },
        }),
      ),
      // API 地址 / 协议：OAuth-only 的供应商不渲染这两行——都是目录里带着的东西，用户既不需要
      // 填也不需要核对；界面上只留「供应商 / 路由 ID / 登录方式」。
      oauthOnlyPicked
        ? null
        : react.createElement(
            'div',
            { className: 'pv_line pv_row' },
            react.createElement('span', null, 'API 地址'),
            react.createElement('input', {
              className: 'pv_field',
              value: form.baseURL,
              placeholder: pickedPreset !== undefined && pickedPreset.baseURL !== '' ? pickedPreset.baseURL : 'https://…',
              title: customPicked
                ? '自建网关必须自己填端点'
                : '留空＝用 pi-ai 目录里这家的默认端点（按模型各自的地址发）',
              onChange: function (event: FieldEvent) { patchForm({ baseURL: event.target.value }) },
            }),
          ),
      // 协议只有自建网关要选：目录里的 provider 由 pi-ai 按模型决定协议（同一家可能多协议，
      // 比如 Copilot 的 claude 走 anthropic-messages、gpt-5.x 走 openai-responses），路由上写
      // 一个就会盖掉其余模型。所以目录 provider 这一行只留一句说明，不给选择框。
      oauthOnlyPicked
        ? null
        : react.createElement(
            'div',
            { className: 'pv_line pv_row' },
            react.createElement('span', null, '协议'),
            customPicked
              ? react.createElement(
                  'select',
                  {
                    className: 'pv_field',
                    value: form.api,
                    onChange: function (event: FieldEvent) { patchForm({ api: event.target.value }) },
                  },
                  react.createElement('option', { value: 'openai-completions' }, 'OpenAI'),
                  react.createElement('option', { value: 'anthropic-messages' }, 'Anthropic'),
                )
              : react.createElement('span', { className: 'pv_hint' }, '由 pi-ai 按模型决定'),
          ),
      // 「登录方式」三态（按 flow 的方法分，不按「有没有 flow」）：
      //   1) flow 有 oauth 方法：渲染 OAuth 按钮；用「改用 API 密钥」可切到密钥输入。
      //   2) 只有 api-key 方法（DeepSeek / OpenAI / Moonshot 这类）：常规密钥输入框——
      //      那条 flow 的全部意义就是「让你输密钥」，不是订阅登录。
      //   3) OAuth-only 但 OAuth 服务没挂上：红字说明，不给密钥框（这个 provider 不接受 apiKey）。
      pickedPreset !== undefined && authEntry.oauth !== undefined && useKeyInstead !== true
        ? react.createElement(
            'div',
            { className: 'pv_line pv_row' },
            react.createElement('span', null, '登录方式'),
            react.createElement(
              'div',
              { className: 'pv_loginRow' },
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'pv_action',
                  disabled: oauth !== null && oauth.done === undefined,
                  title: oauth !== null && oauth.done === undefined ? t('oauthInFlight') : '',
                  onClick: function () {
                    if (oauth !== null && oauth.done === undefined) return
                    startOauth()
                  },
                },
                oauth !== null && oauth.done === undefined
                  ? t('oauthInFlight')
                  : (oauth !== null && oauth.done !== undefined && oauth.done.status === 'authorized'
                    ? '✓ ' + authEntry.oauth.label + ' · 重新登录'
                    : t('oauthSignInMethod').replace('{label}', authEntry.oauth.label)),
              ),
              // 两者都支持的 provider 才给换回密钥的路（否则用户一旦登录就再也回不去）。
              // OAuth-only 的不给：那种 provider 的密钥路径在这套界面里走不通——地址/协议行和
              // 「测试」按钮都被 oauthOnlyPicked 藏着，而「添加到列表」要求测试通过，用户输完
              // key 会卡在一个没有任何解释的死路上（Copilot 更甚：那种 token 本来就拿不到）。
              authEntry.onlyApiKey === true || oauthOnlyPicked === true
                ? null
                : react.createElement(
                    'button',
                    { type: 'button', className: 'pv_pcLink pv_action', onClick: function () { setUseKeyInstead(true) } },
                    '改用 API 密钥',
                  ),
              form.websiteUrl === undefined
                ? null
                : react.createElement('a', { className: 'pv_pcLink', href: form.websiteUrl, target: '_blank', rel: 'noreferrer' }, '获取密钥 ↗'),
            ),
          )
        : pickedPreset !== undefined && pickedPreset.oauthOnly === true && authEntry.oauth === undefined
          ? react.createElement(
              'div',
              { className: 'pv_line pv_row' },
              react.createElement('span', null, '登录方式'),
              react.createElement(
                'span',
                { className: 'plan_note plan_badText' },
                pickedPreset.label + ' 只走 OAuth / 订阅登录，但本机读不到它的登录方式（OAuth 服务没挂上）。重启 dsh 让插件补挂 @deepseek-ai/dsh-authorization 后再试。',
              ),
            )
          : react.createElement(
              'div',
              { className: 'pv_line pv_row' },
              react.createElement('span', null, 'API 密钥'),
              react.createElement('input', {
                className: 'pv_field pv_key',
                type: 'password',
                placeholder: 'sk-…',
                value: form.key,
                onChange: function (event: FieldEvent) { patchForm({ key: event.target.value }) },
              }),
              authEntry.oauth !== undefined
                ? react.createElement(
                    'button',
                    { type: 'button', className: 'pv_pcLink pv_action', onClick: function () { setUseKeyInstead(false) } },
                    '改用 OAuth 登录',
                  )
                : null,
              form.websiteUrl === undefined
                ? null
                : react.createElement('a', { className: 'pv_pcLink', href: form.websiteUrl, target: '_blank', rel: 'noreferrer', style: { marginLeft: '8px' } }, '获取密钥 ↗'),
            ),
      // 凭据名：单独一行小字，不挤在协议行右侧。OAuth-only 走的不是 apiKeyEnv 那个键空间，
      // 写这句反而误导，索性不显示。
      oauthOnlyPicked
        ? null
        : react.createElement(
            'div',
            { className: 'pv_line pv_row' },
            react.createElement('span', null, ''),
            react.createElement('span', { className: 'pv_hint' }, '密钥存为 ' + form.apiKeyEnv),
          ),
      // OAuth 弹窗放在按钮行**上面**：登录是这一步的主事件，按钮是它的后继动作，
      // 摆在下面对不上阅读顺序（用户实测反馈）。
      oauth === null ? null : renderOauthDialog(oauth, pickedPreset, cancelOauth, closeOauth, submitOAuth, copyOauthText, useEnterpriseOauth,
        function (event: FieldEvent) { setOauth(function (prev) { return prev === null ? null : { ...prev, pendingValue: event.target.value } }) },
        function (event: FieldEvent) { setOauth(function (prev) { return prev === null ? null : { ...prev, pendingSelect: event.target.value } }) },
      ),
      react.createElement(
        'div',
        { className: 'pv_actRow' },
        // 「测试」是拿密钥做草稿探测：OAuth-only 没有密钥可填，这个按钮没有意义。
        oauthOnlyPicked
          ? null
          : react.createElement('button', { type: 'button', className: 'pv_action', style: { marginLeft: '0' }, disabled: test.phase === 'run', onClick: runTest },
              test.phase === 'run' ? '测试中…' : '测试'),
        react.createElement('button', {
          type: 'button',
          className: 'pv_action',
          // OAuth 授权过的不用再测：登录那一步已经实连过（拉过模型列表），而「测试」是拿密钥
          // 做草稿探测，OAuth 这条路本来就没有密钥可填。
          disabled: busy || (test.phase !== 'ok' && oauthAuthorized !== true),
          title: test.phase === 'ok' || oauthAuthorized === true ? '' : '先通过测试（或先完成 OAuth 登录）才能添加',
          onClick: add,
        }, busy ? '添加中…' : '添加到列表'),
        react.createElement('button', { type: 'button', className: 'pv_action', style: { marginLeft: 'auto' }, onClick: function () { setOpen(false); setTest({ phase: 'idle', message: '' }); setNote(null) } }, '取消'),
      ),
      test.message === ''
        ? null
        : react.createElement('div', { className: 'plan_note' + (test.phase === 'fail' ? ' plan_badText' : '') }, test.message),
      note === null ? null : react.createElement('div', { className: 'plan_note' }, note),
    ),
  )
}

/**
 * OAuth 弹窗：实时渲染 notice / prompt / settled，attempt 不在时返回 null。
 *
 * 拆成独立函数而不是嵌套组件——`AddProviderPanel` 内已经装满 useState，再开一个会让 hook 顺序
 * 跟表单字段耦合，调试更累。状态全在父组件里通过 props 暴露。
 */
function renderOauthDialog(
  state: NonNullable<{
    attempt: OauthAttemptClient | undefined,
    notices: { message: string, url?: string, code?: string }[],
    prompt: { promptId: string, prompt: OauthPrompt } | undefined,
    pendingValue: string,
    pendingSelect: string,
    pendingBusy: boolean,
    copied: '' | 'link' | 'code',
    enterprise: boolean,
    autoBlanked: boolean,
    done: undefined | { status: 'authorized' | 'cancelled' | 'failed', error?: string },
  }>,
  preset: ProviderPreset | undefined,
  onCancel: () => void,
  onClose: () => void,
  onSubmit: () => void,
  onCopy: (text: string, what: 'link' | 'code') => void,
  onUseEnterprise: () => void,
  onValueChange: (event: FieldEvent) => void,
  onSelectChange: (event: FieldEvent) => void,
) {
  // 末帧 notice 是 device-code flow 的 URL + code；老帧留作上下文。
  var lastNotice = state.notices.length > 0 ? state.notices[state.notices.length - 1] : undefined
  // 单独提出来：闭包里读 lastNotice.url 会丢掉 undefined 收窄（TS 不跨闭包保留收窄）。
  var noticeUrl = lastNotice === undefined ? undefined : lastNotice.url
  var noticeCode = lastNotice === undefined ? undefined : lastNotice.code
  var dialogTitle = preset === undefined || preset.oauth === undefined
    ? t('oauthDialogTitle').replace('{label}', 'OAuth')
    : t('oauthDialogTitle').replace('{label}', preset.oauth.label)
  /**
   * 一行「标签 + 值 + 复制」：标签定宽、值占满并允许折行、复制按钮钉在右边。
   * 两行共用它，按钮因此对齐；按钮给固定最小宽，从「复制」变「已复制」时不会把布局顶动。
   */
  function copyRow(
    label: string,
    valueEl: unknown,
    text: string | undefined,
    what: 'link' | 'code',
    title: string,
  ) {
    if (valueEl === null || text === undefined) return null
    return react.createElement(
      'div',
      { className: 'pv_oauthRow' },
      react.createElement('span', { className: 'pv_oauthLabel' }, label),
      react.createElement('span', { className: 'pv_oauthValue' }, valueEl),
      react.createElement(
        'button',
        {
          type: 'button',
          className: 'pv_action pv_oauthCopy',
          title: title,
          onClick: function () { onCopy(text, what) },
        },
        state.copied === what ? t('oauthCopied') : t('oauthCopyLink'),
      ),
    )
  }
  return react.createElement(
    'div',
    { className: 'pv_oauth' },
    react.createElement('div', { className: 'pv_oauthHead' },
      react.createElement('span', { className: 'pv_oauthTitle' }, dialogTitle),
      state.done !== undefined
        ? react.createElement('button', { type: 'button', className: 'pv_action', onClick: onClose }, '×')
        : react.createElement('button', { type: 'button', className: 'pv_action', onClick: onCancel }, t('oauthCancel')),
    ),
    state.autoBlanked === true
      ? react.createElement(
          'div',
          { className: 'pv_oauthNote' },
          react.createElement('span', null, t('oauthGithubCom')),
          react.createElement('button', { type: 'button', className: 'pv_action', onClick: onUseEnterprise }, t('oauthUseEnterprise')),
        )
      : null,
    lastNotice === undefined
      ? react.createElement('div', { className: 'plan_note' }, state.attempt === undefined ? '正在打开浏览器…' : t('oauthInFlight'))
      : react.createElement(
          'div',
          { className: 'plan_note' },
          react.createElement('div', null, lastNotice.message),
          // 链接给两种用法：点得开就点（新窗口打开），点不开/想在别的设备上打开就复制走。
          // 地址原样当链接文字显示，不加装饰后缀，选中复制出来是干净的。
          // 两行同一套栅格：标签固定宽 + 值占满 + 复制按钮靠右。之前按钮跟在值后面，
          // 链接长、串码短，两个按钮左边缘对不齐，看着乱。
          copyRow('验证页', noticeUrl === undefined ? null :
            react.createElement(
              'a',
              { href: noticeUrl, target: '_blank', rel: 'noreferrer' },
              noticeUrl,
            ), noticeUrl, 'link', '复制链接'),
          noticeCode === undefined
            ? null
            : react.createElement(
                'div',
                null,
                copyRow('串码', react.createElement('span', { className: 'pv_oauthCode' }, noticeCode),
                  noticeCode, 'code', '复制串码'),
                react.createElement('div', { className: 'pv_oauthHint' }, '在打开的页面里输入这串码完成授权'),
              ),
        ),
    state.prompt === undefined
      ? null
      : react.createElement(
          'div',
          { className: 'pv_oauthPrompt' },
          react.createElement('div', null, state.prompt.prompt.kind === 'secret' ? '🔒 ' : '', state.prompt.prompt.message),
          state.prompt.prompt.kind === 'select'
            ? react.createElement(
                'select',
                {
                  className: 'pv_oauthField',
                  value: state.pendingSelect,
                  onChange: onSelectChange,
                  disabled: state.pendingBusy,
                },
                react.createElement('option', { value: '' }, t('oauthSelectPlaceholder')),
                state.prompt.prompt.options.map(function (option) {
                  return react.createElement('option', { key: option.id, value: option.id }, option.label)
                }),
              )
            : react.createElement('input', {
                className: 'pv_oauthField',
                type: state.prompt.prompt.kind === 'secret' ? 'password' : 'text',
                placeholder: state.prompt.prompt.placeholder,
                value: state.pendingValue,
                onChange: onValueChange,
                disabled: state.pendingBusy,
                autoFocus: true,
              }),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'pv_action pv_oauthSubmit',
              disabled: state.pendingBusy || (state.prompt.prompt.kind === 'secret' && state.pendingValue === ''),
              onClick: onSubmit,
            },
            t('oauthSubmit'),
          ),
        ),
    state.done === undefined
      ? null
      : state.done.status === 'authorized'
        ? react.createElement('div', { className: 'pv_oauthDone pv_oauthDone_ok' }, '✓ ' + t('oauthAuthorized'))
        : state.done.status === 'cancelled'
          ? react.createElement('div', { className: 'pv_oauthDone' }, t('oauthCancelled'))
          : react.createElement('div', { className: 'pv_oauthDone pv_oauthDone_bad' }, t('oauthFailed').replace('{error}', state.done.error ?? '')),
  )
}

/**
 * Provider 标签：CC Switch 式卡片。
 * 每个 provider 一张分割明显的卡片，头部一行直给最关键信息（coding plan 的
 * 5小时/订阅余量、API 的余额），点卡片展开看窗口进度与明细；有报警/错误的卡片
 * 默认展开。pi-ai 桥接沉底且默认折叠（次要信息）。
 */
export function ProviderSettingsSection() {
  var statusState = react.useState(null)
  var status = statusState[0]
  var setStatus = statusState[1]
  var planState = react.useState(null)
  var plan = planState[0]
  var setPlan = planState[1]
  var noteState = react.useState(null)
  var note = noteState[0]
  var setNote = noteState[1]
  var busyState = react.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var tabState = react.useState('providers')
  var tab = tabState[0]
  var setTab = tabState[1]
  var groupsState = react.useState([])
  var catalogGroups = groupsState[0]
  var setCatalogGroups = groupsState[1]
  var detailsState = react.useState({})
  var detailsById = detailsState[0]
  var setDetailsById = detailsState[1]
  var filtersState = react.useState({})
  var filters = filtersState[0]
  var setFilters = filtersState[1]
  var presetsState = react.useState([])
  var presets = presetsState[0]
  var setPresets = presetsState[1]
  var catTickState = react.useState(0)
  var setCatTick = catTickState[1]
  // 模型清单保存后 +1：详情表要重新拉（而且要绕开宿主那 60 秒缓存），徽章/详情卡立刻跟着变
  var detailsTickState = react.useState(0)
  var detailsTick = detailsTickState[0]
  var setDetailsTick = detailsTickState[1]
  var delState = react.useState({})
  var delConfirm = delState[0]
  var setDelConfirm = delState[1]
  var refreshingState = react.useState({})
  var setRefreshing = refreshingState[1]
  // 卡片里"补密钥"的输入草稿与保存中标记（都按 provider id 存）
  var keyDraftState = react.useState({})
  var keyDrafts = keyDraftState[0]
  var setKeyDrafts = keyDraftState[1]
  var savingKeyState = react.useState({})
  var savingKey = savingKeyState[0]
  var setSavingKey = savingKeyState[1]
  var toastState = react.useState(null)
  var toast = toastState[0]
  var setToast = toastState[1]
  var toastTimer: ReturnType<typeof setTimeout> | null = null
  // 相对时间每 30 秒跳一次，让「N 分钟前」自己往前走
  var nowTickState = react.useState(0)
  var setNowTick = nowTickState[1]
  react.useEffect(
    function () {
      var timer = setInterval(function () {
        setNowTick(function (n: number) { return n + 1 })
      }, 30000)
      return function () {
        clearInterval(timer)
      }
    },
    [],
  )
  var openState = react.useState({})
  var openMap = openState[0]
  var setOpenMap = openState[1]

  var refresh = react.useCallback(function (force: boolean) {
    loadProviderStatus()
      .then(function (payload) {
        setStatus(payload)
      })
      .catch(function () {
        setStatus(STATUS_UNAVAILABLE)
      })
    loadPlanStatus(force)
      .then(function (payload) {
        setPlan(payload)
      })
      .catch(function (cause) {
        setNote(cause && cause.message ? String(cause.message) : String(cause))
      })
  }, [])

  // 卡片跟着共享额度快照走：座位那边的轮询、别的入口触发的重拉，都会经由这条广播到达这里。
  // 不订阅的话，卡片会停在"自己上次拉的"那一份上，跟触发器显示的数字不一致。
  react.useEffect(
    function () {
      return onPlanChange(function (payload) {
        setPlan(payload)
      })
    },
    [],
  )

  react.useEffect(
    function () {
      refresh(false)
    },
    [refresh],
  )

  // 展开区要显示的模型列表：模型目录走官方同一条 RPC（catTick 触发重载，添加 provider 后用）
  react.useEffect(
    function () {
      var cancelled = false
      loadModelCatalog()
        .then(function (next) {
          if (!cancelled) setCatalogGroups(next.groups)
        })
        .catch(function () { /* 模型列表拿不到就留空，卡片头部信息不受影响 */ })
      return function () {
        cancelled = true
      }
    },
    [catTickState[0]],
  )

  // 可添加的供应商预设清单
  react.useEffect(
    function () {
      reloadPresets()
    },
    [],
  )

  // 预设清单重载（添加/删除后都要：勾选状态变化）
  function reloadPresets() {
    getJson('/provider/presets')
      .then(function (payload) {
        if (payload !== null && Array.isArray(payload.presets)) setPresets(payload.presets)
      })
      .catch(function () { /* 下次刷新会带上 */ })
  }

  // 添加 provider 成功后的收尾：强制刷余额（新 provider 不在缓存里）+ 预设 + 模型目录
  function onProviderAdded() {
    refresh(true)
    setCatTick(function (t: number) { return t + 1 })
    reloadPresets()
  }

  // 删除 provider 的收尾：不打上游（余量没变），只本地移除 + 重载预设/目录。
  // 本组件的 plan 状态由 onPlanChange 那条广播更新，这里不用再自己算一遍。
  function onProviderRemoved(account: PlanAccount) {
    dropPlanAccount(account.id)
    setCatTick(function (t: number) { return t + 1 })
    reloadPresets()
  }

  // 模型详情（悬浮卡元数据）：来自生效 pi-ai 包的数据文件
  react.useEffect(
    function () {
      var cancelled = false
      loadModelDetailMap(detailsTick > 0)
        .then(function (map) {
          if (!cancelled) setDetailsById(map)
        })
        .catch(function () { /* 详情拿不到就只显示目录基础信息 */ })
      return function () {
        cancelled = true
      }
    },
    [detailsTick],
  )

  // 刷新单个 provider 的余量（卡片上的 ↻ 按钮）：宿主实查并回传新账户，本地替换。
  // 等待时按钮旋转，完成弹一条成功/失败提示（2.6 秒后自动消失）。
  function setRefreshingFlag(id: string, value: boolean) {
    setRefreshing(function (prev: AnyRecord) {
      return withKey(prev, id, value)
    })
  }
  function showToast(text: string, ok: boolean) {
    setToast({ text: text, ok: ok })
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      setToast(null)
      toastTimer = null
    }, 2600)
  }
  function refreshSummary(account: PlanAccount) {
    var percent = worstPercent(account)
    if (percent !== undefined) return '（余 ' + String(percent) + '%）'
    if (Array.isArray(account.balances) && account.balances.length > 0) return '（' + account.balances[0].value + '）'
    return ''
  }
  /**
   * 把某条路由的几个字段从配置里删掉（卡片上的修正动作）。
   * 只删配置里的字段，不动凭据：万一用户之前真存过同名 ref，那也不该由我们顺手清掉。
   * @param account - 卡片对应的额度账户。
   * @param fields - 要删的字段名（`apiKeyEnv` / `api` / `baseURL`）。
   * @param done - 成功提示文案。
   */
  function dropRouteFields(account: PlanAccount, fields: string[], done: string) {
    setSavingKey(function (prev: AnyRecord) { return withKey(prev, account.id, true) })
    postJson('/provider/mutate', { routeId: account.id, op: 'unsetFields', fields: fields })
      .then(function (result: AnyRecord) {
        if (result === null || result === undefined || result.ok !== true) {
          throw new Error(String((result && result.error) || '写配置失败'))
        }
        showToast(done, true)
        setCatTick(function (n: number) { return n + 1 })
        refresh(true)
      })
      .catch(function (cause) {
        showToast('修改失败：' + String(cause && cause.message ? cause.message : cause), false)
      })
      .then(function () {
        setSavingKey(function (prev: AnyRecord) { return withKey(prev, account.id, false) })
      })
  }
  function refreshAccount(account: PlanAccount) {
    setRefreshingFlag(account.id, true)
    postJson('/provider/refresh', { providerId: account.id })
      .then(function (res) {
        if (res !== null && res !== undefined && res.account !== undefined) {
          // 并进共享快照：广播会把新值同时送到本组件、座位指示器与 /model 命令。
          mergePlanAccount(res.account)
        }
        var failure = refreshFailure(res)
        if (failure === undefined) {
          showToast('✓ ' + shortName(account) + ' 余量已刷新' + refreshSummary(res.account), true)
        } else {
          showToast('✗ ' + shortName(account) + ' 刷新失败：' + failure, false)
        }
      })
      .catch(function (cause) {
        showToast('✗ ' + shortName(account) + ' 刷新失败：' + String(cause && cause.message ? cause.message : cause), false)
      })
      .then(function () {
        setRefreshingFlag(account.id, false)
      })
  }

  /**
   * 卡片里直接补密钥：路由已经在了（插件自己的 config 就声明了 deepseek），缺的只是凭据。
   * 存进官方同一个凭据仓库（credentials/set，与添加面板同一条 RPC），随后立刻实测一次余量。
   */
  function saveKey(account: PlanAccount) {
    var ref = account.apiKeyEnv === undefined ? '' : String(account.apiKeyEnv)
    var draft = keyDrafts[account.id]
    var value = draft === undefined ? '' : String(draft).trim()
    if (ref === '') {
      showToast('✗ ' + shortName(account) + ' 这条路由没有凭据名，无法存密钥', false)
      return
    }
    if (value === '') {
      showToast('✗ ' + shortName(account) + ' 先填密钥', false)
      return
    }
    setSavingKey(function (prev: AnyRecord) { return withKey(prev, account.id, true) })
    apiCall('credentials/set', { ref: ref, value: value })
      .then(function () {
        setKeyDrafts(function (prev: AnyRecord) { return withKey(prev, account.id, '') })
        return postJson('/provider/refresh', { providerId: account.id })
      })
      .then(function (res) {
        if (res !== null && res !== undefined && res.account !== undefined) mergePlanAccount(res.account)
        var failure = refreshFailure(res)
        if (failure === undefined) {
          showToast('✓ ' + shortName(account) + ' 密钥已保存，' + refreshSummary(res.account), true)
        } else {
          showToast('✓ 密钥已保存，但余量没查通：' + failure, false)
        }
        // 预设清单里这一家的「缺密钥」标记要跟着消失
        reloadPresets()
      })
      .catch(function (cause) {
        var message = String(cause && cause.message ? cause.message : cause)
        // 配置已经在了、只存凭据也可能失败：分开报，免得用户以为整家都没配上
        showToast('✗ 密钥保存失败：' + message, false)
      })
      .then(function () {
        setSavingKey(function (prev: AnyRecord) { return withKey(prev, account.id, false) })
      })
  }

  // 删除 provider（✕ → 二次确认）：配置与密钥一起清掉
  function removeProvider(account: PlanAccount) {
    postJson('/provider/remove', { providerId: account.id })
      .then(function (res) {
        setDelConfirm(function (prev: AnyRecord) {
          return withKey(prev, account.id, false)
        })
        if (res === null || res === undefined || res.ok !== true) {
          setNote('删除失败：' + String((res && res.error) || '未知错误'))
          return
        }
        onProviderRemoved(account)
      })
      .catch(function (cause) {
        setNote('删除失败：' + String(cause && cause.message ? cause.message : cause))
      })
  }

  function checkUpdate() {
    setBusy(true)
    setNote('正在检查上游 ...')
    postJson('/provider/update')
      .then(function (result) {
        if (result.error !== undefined) {
          setNote('更新失败：' + String(result.error))
        } else if (result.applied === true) {
          setNote('已下载 ' + String(result.latest) + '，验证通过（完整性 + 兼容性），重启 dsh 后生效')
        } else if (result.compatible === false) {
          setNote(String(result.latest) + ' 验证没通过，已跳过（不会切过去）')
        } else {
          setNote('已是最新（' + String(result.latest) + '）')
        }
        refresh(true)
      })
      .catch(function (cause) {
        setNote('更新失败：' + String(cause && cause.message ? cause.message : cause))
      })
      .then(function () {
        setBusy(false)
      })
  }

  /** 清理旧 pi-ai 副本与 npm 缓存（宿主侧按保留规则判断，正在用的那份不动）。 */
  function prune() {
    setBusy(true)
    setNote('正在清理 ...')
    postJson('/provider/prune')
      .then(function (result) {
        if (result.ok !== true) {
          setNote('清理失败：' + String((result && result.error) || '未知错误'))
        } else {
          var count = Array.isArray(result.removed) ? result.removed.length : 0
          // 没清掉的（缓存权限这类）也要说出来：只进宿主日志等于用户点了没反应
          var warnings = Array.isArray(result.warnings) && result.warnings.length > 0
            ? '；' + result.warnings.join('；')
            : ''
          setNote((count > 0
            ? '已删除 ' + String(count) + ' 份旧版本，释放 ' + formatBytes(result.freedBytes)
            : '没有可清理的版本（释放 ' + formatBytes(result.freedBytes) + '）') + warnings)
        }
        refresh(true)
      })
      .catch(function (cause) {
        setNote('清理失败：' + String(cause && cause.message ? cause.message : cause))
      })
      .then(function () {
        setBusy(false)
      })
  }

  /** 折叠态记忆：undefined 时回落到默认值（报警/错误的卡片默认展开）。 */
  function isOpen(key: string, dflt: boolean) {
    return openMap[key] === undefined ? dflt : openMap[key]
  }
  function toggle(key: string, dflt: boolean) {
    setOpenMap(function (prev: AnyRecord) {
      return withKey(prev, key, isOpen(key, dflt) !== true)
    })
  }
  /** 模型列表过滤词（按模型 ID 或名称匹配）。 */
  function setFilter(id: string, value: string) {
    setFilters(function (prev: AnyRecord) {
      return withKey(prev, id, value)
    })
  }

  var bridge = status === null || status.bridge === undefined ? undefined : status.bridge
  var update = status === null || status.update === undefined ? undefined : status.update
  var oauthStatus = status === null || status.oauth === undefined ? undefined : status.oauth
  var storage = status === null || status.storage === undefined ? undefined : status.storage
  var providerStore = status === null || status.providerStore === undefined ? undefined : status.providerStore
  // 桥接明细：放在「pi-ai 桥接」二级标签页里展示。行的内容由 piAiBridgeRows 给（纯函数，离线可测）
  var bridgeRows = piAiBridgeRows(bridge, update, oauthStatus, providerStore)
  // 磁盘占用行（issue #4）：不是「桥接状态」而是「它占了多少盘」，排在明细之后、动作按钮之前
  var storageRows = piAiStorageRows(storage)
  var bridgeLines = []
  /** 一行明细：文本 + 右侧次要文字（title 挂在次要文字上）。 */
  function detailLine(row: BridgeRow) {
    var children = [row.text]
    if (row.value !== undefined) {
      children.push(react.createElement(
        'span',
        { className: 'plan_tag pv_push', title: row.title === undefined ? '' : row.title, key: 'value' },
        row.value,
      ))
    }
    return react.createElement(
      'div',
      { className: 'pv_line' + (row.bad === true ? ' plan_badText' : row.warn === true ? ' plan_warnText' : ''), key: row.key },
      children,
    )
  }
  for (var bi = 0; bi < bridgeRows.length; bi += 1) bridgeLines.push(detailLine(bridgeRows[bi]))
  for (var si = 0; si < storageRows.length; si += 1) bridgeLines.push(detailLine(storageRows[si]))
  if (storageRows.length > 0) {
    bridgeLines.push(react.createElement(
      'div',
      { className: 'pv_line', key: 'prune' },
      '清理只删不会再被选中的旧版本与 npm 缓存，正在用的那份不动',
      react.createElement(
        'button',
        { type: 'button', className: 'pv_action pv_push', disabled: busy, onClick: prune },
        busy ? '处理中 ...' : '清理',
      ),
    ))
  }
  // 上游那一行右侧跟按钮：检查更新（宿主先校验下载内容、再做兼容性体检，都过了才等重启生效）
  bridgeLines.push(
    react.createElement(
      'div',
      { className: 'pv_line', key: 'action' },
      piAiUpstreamText(update),
      react.createElement(
        'button',
        { type: 'button', className: 'pv_action pv_push', disabled: busy, onClick: checkUpdate },
        busy ? '检查中 ...' : '检查更新',
      ),
    ),
  )
  var accounts = plan !== null && Array.isArray(plan.accounts) ? plan.accounts : []
  /**
   * 目录里这家出现过哪些协议（预设响应里的 `apis`）。空数组 = 目录里没这家或没有协议信息。
   * @param routeId - 路由 id。
   */
  function apisOfRoute(routeId: string): string[] {
    for (var pi = 0; pi < presets.length; pi += 1) {
      if (presets[pi].id === routeId) {
        var list = presets[pi].apis
        return Array.isArray(list) ? list : []
      }
    }
    return []
  }
  /**
   * 目录里这家出现过哪些端点。配置里钉着的地址若在这个集合里，说明它是目录带来的（旧版表单会
   * 自动填），跟着「一键修正」一起删是安全的；不在集合里的才是用户自己写的（企业版端点这类），
   * 一个字都不能动。
   * @param routeId - 路由 id。
   */
  function baseUrlsOfRoute(routeId: string): string[] {
    for (var pi = 0; pi < presets.length; pi += 1) {
      if (presets[pi].id === routeId) {
        var list = presets[pi].baseUrls
        return Array.isArray(list) ? list : []
      }
    }
    return []
  }
  /** 路由配置里钉着的地址是不是目录带来的（不是用户自己写的）。 */
  function addressFromCatalog(routeId: string, address: string): boolean {
    return baseUrlsOfRoute(routeId).indexOf(address) >= 0
  }
  var modelsByProvider: Record<string, CatalogModel[]> = {}
  for (var gi = 0; gi < catalogGroups.length; gi += 1) {
    modelsByProvider[catalogGroups[gi].id] = catalogGroups[gi].models
  }
  // 每条路由自己声明的模型清单（没声明就没有这个键 = 跟随 pi-ai 目录）：模型清单编辑器用它回显。
  // 同时记下哪些是 llm-pi-ai 路由：清单只能写进 settings 的 llm-pi-ai 段，原生路由（llm-deepseek
  // 这类）渲染编辑器只会让用户白编辑一场（保存必然被宿主拒掉）。
  var declaredByRoute: Record<string, unknown> = {}
  var piAiRoutes: Record<string, boolean> = {}
  var statusRecord = status === null || status === undefined ? undefined : status as AnyRecord
  // 路由表拿到了吗（没拿到就不对「这条是什么路由」「这条路由在不在」下结论）
  var statusLoaded = statusRecord !== undefined && Array.isArray(statusRecord['routes'])
  var statusRoutes = statusRecord !== undefined && Array.isArray(statusRecord['routes']) ? statusRecord['routes'] as unknown[] : []
  for (var ri = 0; ri < statusRoutes.length; ri += 1) {
    var routeEntry = statusRoutes[ri] as AnyRecord
    if (typeof routeEntry['id'] !== 'string') continue
    if (routeEntry['source'] === 'llm-pi-ai') piAiRoutes[routeEntry['id']] = true
    if (routeEntry['models'] !== undefined) declaredByRoute[routeEntry['id']] = routeEntry['models']
  }
  var cards = []
  for (var i = 0; i < accounts.length; i += 1) {
    ;(function (account: PlanAccount) {
      var chips = headlineChips(account)
      // 「OAuth 已授权，但配置里还写着 apiKeyEnv」这种冲突必须默认展开：修正在展开体里，
      // 藏在折叠区里用户根本发现不了（他就是这么卡住的：发送时才发现 MISSING_CREDENTIAL）。
      var apiKeyEnvConflict = account.oauthAuthorized === true
        && typeof account.apiKeyEnv === 'string' && account.apiKeyEnv !== ''
      // 协议写死的告警同理：修正按钮就在展开体里，折叠着等于没有。
      var apiConflict = routeRepairOf(account, apisOfRoute(account.id), baseUrlsOfRoute(account.id)).fields.length > 0
      var dflt = account.error !== undefined || typeof account.credentialWarning === 'string'
        || apiKeyEnvConflict || apiConflict
      var expanded = isOpen(account.id, dflt)

      var chipEls = []
      for (var c = 0; c < chips.length; c += 1) chipEls.push(headlineChip(chips[c], c))

      var bodyRows = []
      if (expanded) {
        // 路由 ID：和「添加供应商」表单里的同一个值（settings 的 llm-pi-ai.providers 键）
        bodyRows.push(
          react.createElement(
            'div',
            { className: 'pv_line pv_row', key: 'id' },
            react.createElement('span', null, '路由 ID'),
            react.createElement('span', { className: 'pv_field' }, String(account.id)),
          ),
        )
        // API 密钥行：配好了显示掩码提示（宿主派生前3+后4，值不出宿主）；
        // 只有路由、还没密钥时这里就是唯一能补 key 的地方（官方 Models 页已被本插件的
        // cordis.patch.yml 禁用，别处没有入口）。原生路由（source: native）也走同一条
        // credentials/set：凭据名就是它的 apiKeyEnv。
        // OAuth 授权过的 provider 没有 apiKeyEnv 那个键空间里的东西，摆密钥框只会误导；
        // 这类卡片改显示登录方式一行（值在凭据记录里，浏览器拿不到也不需要）。
        var oauthLoggedIn = account.oauthAuthorized === true
        if (oauthLoggedIn) {
          bodyRows.push(
            react.createElement(
              'div',
              { className: 'pv_line pv_row', key: 'auth' },
              react.createElement('span', null, '登录方式'),
              react.createElement('span', { className: 'pv_field' }, 'OAuth（已授权）'),
            ),
          )
          // 早期版本（或手改配置）会给 OAuth 路由也写 apiKeyEnv，官方适配器看到它就只认那个
          // ref、取不到值直接报 MISSING_CREDENTIAL——OAuth 登录等于白做。这里给一条一键修正：
          // 把 apiKeyEnv 从这条路由的配置里删掉，pi-ai 就会回落到自己的凭据解析（拿到 grant）。
          if (typeof account.apiKeyEnv === 'string' && account.apiKeyEnv !== '') {
            bodyRows.push(
              react.createElement(
                'div',
                { className: 'plan_note plan_warnText', key: 'apikeyenv-conflict' },
                '这条路由写了 apiKeyEnv（' + String(account.apiKeyEnv) + '），官方适配器会只认它，'
                + '导致 OAuth 登录用不上（发送时报 MISSING_CREDENTIAL）。',
                react.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'pv_action',
                    style: { marginLeft: '8px' },
                    disabled: savingKey[account.id] === true,
                    onClick: function () { dropRouteFields(account, ['apiKeyEnv'], '已把 ' + shortName(account) + ' 改成走 OAuth 认证') },
                  },
                  '改用 OAuth 认证',
                ),
              ),
            )
          }
        }
        var keyless = !oauthLoggedIn && account.authConfigured === false && typeof account.apiKeyEnv === 'string' && account.apiKeyEnv !== ''
        if (!oauthLoggedIn) bodyRows.push(
          react.createElement(
            'div',
            { className: 'pv_line pv_row', key: 'key' },
            react.createElement('span', null, 'API 密钥'),
            keyless
              ? react.createElement(
                  'span',
                  { className: 'pv_pick', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' } },
                  react.createElement('input', {
                    className: 'pv_field pv_key',
                    style: { flex: '1 1 auto' },
                    type: 'password',
                    placeholder: 'sk-…',
                    value: keyDrafts[account.id] === undefined ? '' : String(keyDrafts[account.id]),
                    disabled: savingKey[account.id] === true,
                    onChange: function (event: FieldEvent) {
                      var next = event.target.value
                      setKeyDrafts(function (prev: AnyRecord) { return withKey(prev, account.id, next) })
                    },
                  }),
                  react.createElement('button', {
                    type: 'button',
                    className: 'pv_action',
                    style: { marginLeft: '0', flex: '0 0 auto' },
                    disabled: savingKey[account.id] === true,
                    title: '存进 ' + String(account.apiKeyEnv) + ' 并立刻实测一次余量',
                    onClick: function () { saveKey(account) },
                  }, savingKey[account.id] === true ? '保存中…' : '保存'),
                )
              : react.createElement(
                  'span',
                  { className: 'pv_field' },
                  account.keyHint !== undefined ? account.keyHint : '已配置',
                ),
          ),
        )
        if (account.baseUrl !== undefined) {
          bodyRows.push(
            react.createElement(
              'div',
              { className: 'pv_line pv_row', key: 'url' },
              react.createElement('span', null, 'API 地址'),
              react.createElement('span', { className: 'pv_field' }, String(account.baseUrl)),
            ),
          )
        }
        // 协议 / 凭据名：原生适配器路由（deepseek-official 这类）不写 settings 段，可能只有其中一个
        if (account.api !== undefined) {
          bodyRows.push(
            react.createElement(
              'div',
              { className: 'pv_line pv_row', key: 'api' },
              react.createElement('span', null, '协议'),
              react.createElement('span', { className: 'pv_field' }, String(account.api)),
            ),
          )
        }
        if (account.apiKeyEnv !== undefined && !oauthLoggedIn) {
          bodyRows.push(
            react.createElement(
              'div',
              { className: 'pv_line pv_row', key: 'ref' },
              react.createElement('span', null, ''),
              react.createElement('span', { className: 'pv_hint' }, '密钥存为 ' + String(account.apiKeyEnv)),
            ),
          )
        }
        // 模型列表：目录（服务端）为骨架，pi-ai 详情补元数据；悬浮显示 Cherry 式详情卡
        // 账号声明的可用模型（OAuth 登录时 pi-ai 记下的）：卡片列的是 pi-ai 静态目录，
        // 与实际权益不是一回事（Copilot 目录 28 个、账号只有 6 个能用），按清单过滤一次，
        // 免得卡片吹的模型数跟选择器里能选的对不上。
        // 路由写死 api 的告警：官方适配器里 `request.api ?? base?.api ?? routeApi`，路由的 api
        // 覆盖每个模型自己的协议。分两种情况，别一律报警（DeepSeek 这类单协议 provider 写对了
        // 是白报，用户会去点一个没必要的修正按钮）：
        //   - 目录多协议（Copilot：claude 走 anthropic、gpt-5.x 走 responses）：写死必然让另一
        //     批发错端点、报 400。
        //   - 目录单协议但写死的跟它不一致：那是真配错了，照样发错。
        var pinnedApi = typeof account.api === 'string' && account.api !== '' ? account.api : undefined
        var catalogApis = apisOfRoute(account.id)
        var repair = routeRepairOf(account, catalogApis, baseUrlsOfRoute(account.id))
        var dropAddressToo = repair.fields.indexOf('baseURL') >= 0
        if (repair.fields.length > 0) {
          bodyRows.push(
            react.createElement(
              'div',
              { className: 'plan_note plan_warnText', key: 'api-pinned' },
              repair.multiProtocol
                ? '这条路由写死了协议（' + String(pinnedApi) + '），会覆盖每个模型自己的协议；'
                  + '这家目录是多协议的（' + catalogApis.join(' / ') + '），写死会让一部分模型发出 400。'
                  + (dropAddressToo ? '地址也是旧版写进配置的目录端点，会一起删掉。' : '')
                : '这条路由写死的协议（' + String(pinnedApi) + '）跟目录里的（' + catalogApis[0] + '）不一致，'
                  + '发送会走错协议。',
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'pv_action',
                  style: { marginLeft: '8px' },
                  disabled: savingKey[account.id] === true,
                  onClick: function () {
                    dropRouteFields(account, repair.fields, '已让 ' + shortName(account) + ' 按模型各自的协议发送'
                      + (dropAddressToo ? '，并删掉旧版写进去的地址' : ''))
                  },
                },
                '改成按模型协议',
              ),
            ),
          )
        }
        var allModels = modelsByProvider[account.id]
        var available = account.availableModels
        var models = allModels === undefined
          ? undefined
          : allModels.filter(function (m) { return modelVisible(available, m.id, false) })
        // 自己声明的清单：目录里没有这家（自建网关）时，模型区也得在——那份清单是唯一的信息源
        var declared = declaredByRoute[account.id]
        var declaredCount = Array.isArray(declared) ? declared.length : 0
        if (models === undefined) {
          bodyRows.push(react.createElement('div', { className: 'pv_line', key: 'm-load' }, '模型目录加载中…'))
        } else if (models.length === 0 && declaredCount === 0) {
          bodyRows.push(react.createElement('div', { className: 'pv_line', key: 'm-none' }, '目录里没有这个 provider 的模型'))
        } else {
          // 模型区（带外框）独立折叠：卡片展开时默认收起，点「模型（N）」头展开
          var modelsOpen = isOpen(account.id + ':models', false)
          // 过滤：模糊匹配模型 ID 或名称（子串 / 缩写子序列 / 编辑距离容错）
          var filterText = filters[account.id] === undefined ? '' : String(filters[account.id])
          var needle = filterText.trim().toLowerCase()
          var filtered = []
          for (var fi = 0; fi < models.length; fi += 1) {
            if (fuzzyMatch(filterText, models[fi].id + ' ' + models[fi].name)) {
              filtered.push(models[fi])
            }
          }
          var mBoxRows = []
          // 模型区头部（仿父卡片范式）：标题左；展开时过滤器靠右；最右 Chevron 旋转切换
          var mTopChildren = [
            react.createElement(
              'button',
              { type: 'button', className: 'pv_mHead', key: 'm-head', onClick: function () { toggle(account.id + ':models', false) } },
              react.createElement('span', null, '模型（' + (needle === '' ? String(models.length) : String(filtered.length) + '/' + String(models.length)) + '）'),
            ),
          ]
          if (modelsOpen) {
            mTopChildren.push(
              react.createElement(
                'span',
                { className: 'pv_fbox', key: 'm-filter' },
                react.createElement('input', {
                  className: 'pv_mFilter',
                  type: 'text',
                  placeholder: '过滤',
                  value: filterText,
                  onChange: function (event: FieldEvent) {
                    setFilter(account.id, event.target.value)
                  },
                }),
                filterText === ''
                  ? null
                  : react.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'pv_fclear',
                        title: '清除',
                        onClick: function () { setFilter(account.id, '') },
                      },
                      '×',
                    ),
              ),
            )
          }
          mTopChildren.push(
            react.createElement(
              'div',
              {
                className: 'pv_mCaretCol',
                key: 'm-caret',
                title: modelsOpen ? '收起' : '展开',
                onClick: function () { toggle(account.id + ':models', false) },
              },
              caretSvg(modelsOpen),
            ),
          )
          mBoxRows.push(react.createElement('div', { className: 'pv_mTop', key: 'm-top' }, mTopChildren))
          if (modelsOpen) {
            var mListRows = []
            if (models.length === 0) {
              mListRows.push(react.createElement(
                'div',
                { className: 'pv_line', key: 'm-nodefault' },
                '目录里没有这家 provider：模型清单由下面自己声明（自定义 id 记得填上下文与最大输出）',
              ))
            } else {
            // 列标题：与模型行同一套列宽类，保证严格对齐
            mListRows.push(
              react.createElement(
                'div',
                { className: 'pv_mHeadRow', key: 'm-colhead' },
                react.createElement('span', { className: 'pv_mId', style: { fontFamily: 'inherit' } }, '模型 ID'),
                react.createElement('span', { className: 'pv_mName' }, '名称'),
                react.createElement('span', { className: 'pv_mCaps' }, '能力'),
                react.createElement('span', { className: 'pv_mCtx' }, '上下文'),
              ),
            )
            if (filtered.length === 0) {
              mListRows.push(react.createElement('div', { className: 'pv_line', key: 'm-empty' }, '没有匹配「' + filterText + '」的模型'))
            } else {
              for (var m = 0; m < filtered.length; m += 1) {
                mListRows.push(modelRow(filtered[m], account, detailsById))
              }
            }
            }
            // 列表区：分割线上边缘贯穿模型框
            mBoxRows.push(react.createElement('div', { className: 'pv_mList', key: 'm-list' }, mListRows))
            // 模型清单编辑器（issue #1）：官方 Models 页被禁用后，逐模型参数只能手改 settings.yaml，
            // 这里给一条界面上的路：勾选/替换清单、改字段、写回 llm-pi-ai.providers.<id>.models。
            // 只给 llm-pi-ai 路由：原生路由（deepseek-official 这类）不在这个设置段里，写了也不生效。
            mBoxRows.push(piAiRoutes[account.id] === true
              ? react.createElement(ModelListEditor, {
                  key: 'm-editor',
                  routeId: account.id,
                  declared: declared,
                  catalog: allModels === undefined ? [] : allModels,
                  detailsById: detailsById,
                  onSaved: function () {
                    onProviderAdded()
                    // 清单改了，能力详情也跟着变：重拉一次并绕开宿主缓存
                    setDetailsTick(function (prev: number) { return prev + 1 })
                  },
                })
              : statusLoaded !== true
                // 路由表还没回来（/provider/status 失败或首次加载中）：不猜是哪种路由，
                // 免得给一条 llm-pi-ai 路由挂上「这是内置原生路由」的错话
                ? null
                : react.createElement(
                    'div',
                    { className: 'pv_line pv_meNative', key: 'm-editor' },
                    '这条是内置原生路由：模型清单不写在这套设置里，编辑清单只对 llm-pi-ai 路由有效',
                  ))
          }
          bodyRows.push(react.createElement('div', { className: 'pv_mBox', key: 'mbox' }, mBoxRows))
        }
        if (account.error !== undefined) {
          bodyRows.push(react.createElement('div', { className: 'plan_note plan_badText', key: 'err' }, String(account.error)))
        }
        // 凭据体检结论：多个 provider 共用同一把 key（值本身不会下发到浏览器）
        if (typeof account.credentialWarning === 'string') {
          bodyRows.push(react.createElement('div', { className: 'plan_note plan_badText', key: 'warn' }, account.credentialWarning))
        }
      }

      // 没有官网链接就不显示 ↗：baseUrl 是 API 端点，跳过去没用
      var linkUrl = typeof account.websiteUrl === 'string' && account.websiteUrl !== '' ? account.websiteUrl : undefined

      cards.push(
        react.createElement(
          'div',
          { className: 'pv_pc' + (expanded ? ' pv_pcOpen' : ''), key: account.id },
          react.createElement(
            'div',
            { className: 'pv_pcTop' },
            react.createElement(
              'div',
              { className: 'pv_pcMain' },
            // 第一行：绿点 + 名称 + 等级 + 网页图标——对齐官方插件卡头部
            react.createElement(
              'div',
              {
                className: 'pv_pcHead',
                role: 'button',
                tabIndex: 0,
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: function () { toggle(account.id, dflt) },
                onKeyDown: function (ev: KeyboardEvent) {
                  if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
                    if (typeof ev.preventDefault === 'function') ev.preventDefault()
                    toggle(account.id, dflt)
                  }
                },
              },
              react.createElement(
                'span',
                { className: 'pv_pcLead' },
                react.createElement(
                  'span',
                  { className: 'pv_pcLeadRow' },
                  react.createElement('span', { className: dotClass(account) }),
                  react.createElement('span', { className: 'pv_pcName' }, shortName(account)),
                  linkUrl === undefined
                    ? null
                    : react.createElement('a', {
                        className: 'pv_pcWeb',
                        href: linkUrl,
                        target: '_blank',
                        rel: 'noreferrer',
                        title: '打开官网 ' + linkTextOf(linkUrl),
                        onClick: function (event: MouseEvent) {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                        },
                      }, '↗'),
                ),
              ),
            ),
            // 第二行：余量摘要左对齐；右侧 刷新时间｜刷新｜删除
            react.createElement(
              'div',
              { className: 'pv_pcMeta' },
              chipEls,
              react.createElement(
                'span',
                { className: 'pv_metaActs' },
                // 没有额度接口的 provider：刷新时间与刷新按钮都不摆——刷了也没有新信息，
                // 摆着就是个假的可操作项。
                refreshable(account) !== true
                  ? null
                  : account.fetchedAt === undefined
                    ? null
                    : react.createElement(
                        'span',
                        { className: 'pv_fresh', title: '上次刷新 ' + String(account.fetchedAt).slice(11, 19) },
                        '◷ ' + relativeTime(account.fetchedAt),
                      ),
                refreshable(account) !== true
                  ? null
                  : react.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'pv_iconBtn' + (refreshingState[0][account.id] === true ? ' pv_spin' : ''),
                        disabled: refreshingState[0][account.id] === true,
                        title: refreshingState[0][account.id] === true ? '刷新中…' : '刷新余量' + (account.fetchedAt !== undefined ? '（上次 ' + String(account.fetchedAt).slice(11, 19) + '）' : ''),
                        onClick: function () { refreshAccount(account) },
                      },
                      '↻',
                    ),
                account.deletable === true
                  ? react.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'pv_iconBtn',
                        title: '删除这个 provider（清掉路由与凭据，需要再确认一次）',
                        onClick: function () {
                          setDelConfirm(function (prev: AnyRecord) {
                            return withKey(prev, account.id, true)
                          })
                        },
                      },
                      '✕',
                    )
                  : null,
              ),
            ),
            // 删除确认：**不与 ✕ 同位置**（连点两下第二下正好落在刚变成「确认删除」的那一格，
            // 等于没有确认），改成卡片里单独一行，并把代价写清楚——整段 route 连带手写的
            // models / compat / retryPolicy 一起没，凭据也一起清（issue #3）。
            account.deletable === true && delConfirm[account.id] === true
              ? react.createElement(
                  'div',
                  { className: 'pv_delConfirm', role: 'alert' },
                  react.createElement(
                    'span',
                    { className: 'pv_delWarn' },
                    deleteConfirmText(account),
                  ),
                  react.createElement(
                    'button',
                    { type: 'button', className: 'pv_delYes', onClick: function () { removeProvider(account) } },
                    '确认删除',
                  ),
                  react.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'pv_delNo',
                      onClick: function () {
                        setDelConfirm(function (prev: AnyRecord) {
                          return withKey(prev, account.id, false)
                        })
                      },
                    },
                    '取消',
                  ),
                )
              : null,
            ),
            // 箭头列：只在「标题+余量」区域垂直居中（分割线上方），点击展开/收起
            react.createElement(
              'div',
              {
                className: 'pv_pcCaretCol',
                title: expanded ? '收起' : '展开',
                onClick: function () { toggle(account.id, dflt) },
              },
              caretSvg(expanded),
            ),
          ),
          // 展开体：分割线上边缘贯穿整卡
          expanded ? react.createElement('div', { className: 'pv_pcBody' }, bodyRows) : null,
        ),
      )
    })(accounts[i])
  }
  if (cards.length === 0) {
    cards.push(
      react.createElement('div', { className: 'pv_line', key: '__none' }, String(plan !== null && plan.error !== undefined ? plan.error : '暂无 provider 额度数据')),
    )
  }

  // 页内二级标签：Provider（配置的 provider 卡片）/ pi-ai 桥接
  var tabProviders = react.createElement(
    'button',
    { type: 'button', className: 'pv_tab' + (tab === 'providers' ? ' pv_tabOn' : ''), onClick: function () { setTab('providers') } },
    t('tabProviders'),
  )
  var tabBridge = react.createElement(
    'button',
    { type: 'button', className: 'pv_tab' + (tab === 'bridge' ? ' pv_tabOn' : ''), onClick: function () { setTab('bridge') } },
    'pi-ai 桥接',
  )
  return react.createElement(
    'div',
    { className: 'pv_stack' },
    react.createElement('div', { className: 'pv_tabs' }, tabProviders, tabBridge),
    tab === 'bridge'
      ? react.createElement(
          'div',
          { className: 'pv_pc' },
          react.createElement('div', { className: 'pv_pcBody', style: { borderTop: '0', paddingTop: '8px' } },
            bridgeLines,
            note === null ? null : react.createElement('div', { className: 'plan_note' }, note)),
        )
      : react.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          react.createElement(AddProviderPanel, {
            presets: presets,
            onAdded: onProviderAdded,
            // 只在「配置里真的钉了地址」时回填（baseUrlPinned 由宿主给）：卡片上的地址可能只是
            // 目录默认值，那种不该被当成用户的选择存进配置。
            addressOf: function (routeId: string) {
              for (var ai = 0; ai < accounts.length; ai += 1) {
                if (accounts[ai].id !== routeId) continue
                var address = accounts[ai].baseUrl
                if (accounts[ai].baseUrlPinned !== true || typeof address !== 'string' || address === '') return undefined
                // 目录带来的地址不算用户的选择（旧版表单自动填的），那种删掉才对
                return addressFromCatalog(routeId, address) ? undefined : address
              }
              return undefined
            },
            // 这条 route 是不是已经在配置里：已存在时只逐字段写（保住手写的 models / compat /
            // retryPolicy），不存在才整条新建。
            // 三个来源都要查——只认额度快照时，/plan/status 拉不到（或自建路由不在预设列表里）
            // 就会退回整条 set，把用户手写的配置一次抹掉（issue #1 那条提醒的原始形态）。
          }),
          cards,
        ),
    toast === null
      ? null
      : react.createElement(
          'div',
          { className: 'pv_toast ' + (toast.ok === true ? 'pv_toastOk' : 'pv_toastFail') },
          toast.text,
        ),
  )
}
