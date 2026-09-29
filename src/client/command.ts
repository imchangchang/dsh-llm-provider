/**
 * /model 命令：按 provider 过滤 / 搜索模型 / 显示余额。
 * commandUi 对同名是「重复即抛」，没有 priority 遮蔽——官方 ui-model-selection 行还在时
 * 注册会抛，调用方静默让位；官方行被禁用后这里接管。
 */
import { accountsById, loadModelCatalog, loadPlanStatus, submitSelection } from './data.js'
import { quotaTextOf } from './format.js'
import type { ClientScope, CommandSession } from './types.js'

/**
 * 这次调用是不是落在「寻址到子代理」的会话里。
 *
 * 官方 ui-model-selection 把 /model 在那种会话里判为不可用（切换模型是 Agent 绑定的 RPC），
 * 我们照同一条口径过滤；sessions 服务缺席或形状不认识时按「可用」处理——宁可让用户点进去
 * 看到失败提示，也不能把一个本来能用的命令藏掉。
 * @param sessions - 客户端 sessions 服务（形状不认识就当没有）。
 * @param session - 命令回调收到的会话上下文。
 */
function addressedSubagent(sessions: unknown, session: CommandSession | null | undefined): boolean {
  if (sessions === null || sessions === undefined) return false
  var service = sessions as { subagentAddress?: (id: string) => unknown }
  if (typeof service.subagentAddress !== 'function') return false
  var sessionId = session === null || session === undefined ? undefined : session.sessionId
  if (typeof sessionId !== 'string') return false
  try {
    return service.subagentAddress(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * 注册 /model 命令。
 * @param scope - commandUi 的 inject 面。
 * @param sessions - 客户端 sessions 服务，用来判断「寻址到子代理」的会话（见 addressedSubagent）。
 */
export function registerModelCommand(scope: ClientScope, sessions?: unknown): void {
  var commandUi = scope.commandUi
  if (commandUi === undefined || typeof commandUi.register !== 'function') return
  scope.effect(
    function () {
      try {
        return commandUi!.register({
          name: 'model',
          label: function () {
            return '切换模型'
          },
          description: function () {
            return '按 provider 过滤 / 搜索模型 / 显示余额'
          },
          // 官方契约必填，且 candidates() 对**每一条**贡献都直接调它：漏了就是 TypeError，
          // 整个 `/` 候选列表（含 composer 的「＋」按钮）一起挂掉（issue #7）。
          available: function (session) {
            return !addressedSubagent(sessions, session)
          },
          ui: {
            kind: 'popupSelect',
            options: function (session) {
              if (addressedSubagent(sessions, session)) {
                throw new Error('子代理会话不支持切换模型（官方同款限制）')
              }
              return Promise.all([loadModelCatalog(), loadPlanStatus(false)])
                .then(function (both) {
                  var groups = both[0].groups
                  var accounts = accountsById(both[1])
                  var rows = []
                  for (var i = 0; i < groups.length; i += 1) {
                    var group = groups[i]
                    var quota = quotaTextOf(accounts[group.id])
                    for (var j = 0; j < group.models.length; j += 1) {
                      rows.push({
                        id: group.id + '/' + group.models[j].id,
                        label: group.models[j].id,
                        detail: group.id + (quota === undefined ? '' : ' · ' + quota),
                      })
                    }
                  }
                  return rows
                })
            },
            onSelect: function (option, session) {
              var parts = String(option.id).split('/')
              var provider = parts.shift()
              var model = parts.join('/')
              if (provider === undefined || provider === '' || model === '') {
                throw new Error('无法解析这个模型行')
              }
              var sessionId = session !== null && session !== undefined ? session.sessionId : undefined
              if (typeof sessionId !== 'string') throw new Error('当前没有会话，无法切换模型')
              return submitSelection(sessionId, provider, model, undefined)
            },
          },
        })
      } catch (cause) {
        // 同名命令已存在（官方 /model 还在）：让位，其余功能不受影响
        return function () {}
      }
    },
    'dsh-llm-provider: /model contribution',
  )
}
