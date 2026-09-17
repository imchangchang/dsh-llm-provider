/**
 * OAuth 测试钩子：从 src/oauth.ts 拉出 attempt 池与几只工具，让 test/*.mjs 能注入自家 flow，
 * 不必真的 dsh 跑 device code。
 *
 * 这个文件作为额外的 tsdown entry（见 tsdown.config.ts）转译到 lib/oauth-test-hooks.js，
 * 这样测试 import 不需要绕开 tsdown 在 unbundle + tree-shake 下砍未被 entry 链路引用的
 * 顶层 export 的行为。production 代码不会调这些钩。
 */
import { attempts, keyToAttempt } from './oauth.js'

/** 尝试池大小。 */
export function __oauth_attempt_count(): number {
  return attempts.size
}

/** 取一条 attempt 的 settled 状态（强类型简化版）。 */
export function __oauth_attempt(id: string): { settled: undefined | { status: string, error?: string } } | undefined {
  const attempt = attempts.get(id)
  return attempt === undefined ? undefined : { settled: attempt.settled }
}

/** 清空 attempt 池（测试间隔离）。 */
export function __oauth_reset(): void {
  for (const a of attempts.values()) a.controller.abort()
  attempts.clear()
  keyToAttempt.clear()
}