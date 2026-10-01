#!/bin/bash
# 合入门禁（入库正本）。pdl merge 在「合并已暂存、未提交」时调用本脚本，
# 非零退出即自动回滚。注意：此刻工作区合法地带着未提交的合并结果，
# 不要在这里断言「工作区必须干净」。
# 检查项：自测（npm test）→ e2e（scripts/test-e2e.sh；PDL_SKIP_E2E=1 跳过）。
set -uo pipefail
fail=0

echo "checks: npm test（自测）…"
npm test || fail=1

if [ "$fail" = 0 ] && [ "${PDL_SKIP_E2E:-0}" != "1" ]; then
  echo "checks: e2e（scripts/test-e2e.sh）…"
  bash scripts/test-e2e.sh || fail=1
fi

if [ "$fail" = 0 ]; then
  echo "checks: 全部通过"
else
  echo "checks: 未通过"
fi
exit "$fail"
