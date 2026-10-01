#!/bin/bash
# e2e 编排：起沙箱（真 dsh + 被测插件）→ Playwright 协议断言 → 清沙箱。
#
#   scripts/test-e2e.sh                        # 只跑本机 dsh 版本
#   scripts/test-e2e.sh --versions 0.2.0-rc.2  # 版本矩阵，逗号分隔，每版一个沙箱
#
# 沙箱由 scripts/test-sandbox.sh 负责（DSH_HOME 隔离、独立 npm 环境、clean 即焚），
# 本脚本只做编排。断言在 test/e2e/specs/，环境通过 E2E_* 变量传给 Playwright。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$PROJECT_ROOT/test/e2e"

die()  { echo "test-e2e: $*" >&2; exit 1; }
info() { echo "test-e2e: $*"; }

versions=""
while [ $# -gt 0 ]; do
  case "$1" in
    --versions) versions="$2"; shift 2 ;;
    *) die "不认识参数：$1" ;;
  esac
done

# 依赖就位：@playwright/test 装在 test/e2e 自己的 node_modules，不碰根 package.json
if [ ! -d "$E2E_DIR/node_modules/@playwright" ]; then
  info "安装 e2e 依赖（首次较慢）…"
  (cd "$E2E_DIR" && npm install --no-audit --no-fund --loglevel=error)
fi

# 跑一个版本的完整套件。空参数 = 本机已装的 dsh。
run_suite() {
  local ver="$1"
  local slug="e2e-${ver//./-}"
  local args=(up --name "$slug" --no-open)
  [ -n "$ver" ] && args+=(--dsh-version "$ver")
  bash "$SCRIPT_DIR/test-sandbox.sh" "${args[@]}"

  local sandbox="$PROJECT_ROOT/test/sandbox/$slug"
  local port url token dsh_bin
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$sandbox/state.json" | head -1)"
  url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | tail -1)"
  token="${url##*token=}"
  dsh_bin="$(sed -n 's/.*"dsh"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$sandbox/state.json" | head -1)"

  export E2E_BASE_URL="http://127.0.0.1:$port"
  export E2E_TOKEN="$token"
  export E2E_LOG="$sandbox/dsh.log"
  export E2E_DSH_VERSION="${ver:-$("$dsh_bin" --version 2>/dev/null || echo 'unknown')}"

  info "── 版本 ${E2E_DSH_VERSION}：协议断言 ──"
  local ok=1
  (cd "$E2E_DIR" && npx playwright test specs/protocol.spec.mjs) || ok=0

  # 官方行接管检查：组合出来的配置树里，三条官方行必须带着 disabled 出现，插件条目必须在位
  info "── 版本 ${E2E_DSH_VERSION}：dump-config 检查 ──"
  local dump
  dump="$(DSH_HOME="$sandbox/home" "$dsh_bin" --dump-config --profile web 2>/dev/null || true)"
  echo "$dump" | grep -q 'dsh-llm-provider' || { info "dump-config 里没有 dsh-llm-provider"; ok=0; }

  if [ "$ok" = 1 ]; then
    info "── 版本 ${E2E_DSH_VERSION}：通过 ──"
  else
    info "── 版本 ${E2E_DSH_VERSION}：失败（沙箱保留在 $sandbox 供排查，clean --name $slug 可清）──"
    return 1
  fi
  bash "$SCRIPT_DIR/test-sandbox.sh" clean --name "$slug"
}

failures=()
if [ -n "$versions" ]; then
  IFS=',' read -ra list <<< "$versions"
  for ver in "${list[@]}"; do
    run_suite "$ver" || failures+=("$ver")
  done
else
  run_suite "" || failures+=("本机版本")
fi

if [ ${#failures[@]} -gt 0 ]; then
  die "以下版本未通过：${failures[*]}"
fi
info "全部通过"
