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

# 浏览器断言需要 chromium；已装过时这条命令秒回
if [ -f "$E2E_DIR/specs/ui.spec.mjs" ]; then
  (cd "$E2E_DIR" && npx playwright install chromium)
fi

# 跑一个版本的完整套件。空参数 = 本机已装的 dsh。
run_suite() {
  local ver="$1"
  # 空版本用 local 后缀（不能留空尾巴，sanitize 会把尾横线剥掉导致路径对不上）
  local slug="e2e-${ver:-local}"
  slug="${slug//./-}"

  # 构建先行：lib/ 不入库，worktree 里第一次跑就是没有的；构建也保证测的是当前源码
  info "构建插件（npm run build）…"
  (cd "$PROJECT_ROOT" && npm run build --silent)

  local args=(up --name "$slug" --no-open)
  [ -n "$ver" ] && args+=(--dsh-version "$ver")
  bash "$SCRIPT_DIR/test-sandbox.sh" "${args[@]}"

  local sandbox="$PROJECT_ROOT/test/sandbox/$slug"
  local port url token dsh_bin
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$sandbox/state.json" | head -1)"
  url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | tail -1)"
  token="${url##*token=}"
  dsh_bin="$(sed -n 's/.*"dsh"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$sandbox/state.json" | head -1)"

  # 夹具：跑一轮真实对话（模型经插件桥接真实回复），会话以正规格式落盘；
  # 浏览器层的模型选择器用例靠它打开会话视图。headless 失败（如 CI 无外网/无凭据）
  # 时置空标记，浏览器层相应用例自动跳过。
  # 前置：等 pi-ai 就绪——全新沙箱首启时 updater 要现场下载，桥接一开始是空的。
  local i bridge_active
  for i in $(seq 1 60); do
    bridge_active="$(curl -s "http://127.0.0.1:$port/provider/status?token=$token" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('bridge',{}).get('active'))" 2>/dev/null || true)"
    [ "$bridge_active" = "True" ] && break
    sleep 2
  done
  mkdir -p /tmp/e2e-ws
  if (cd /tmp/e2e-ws && DSH_HOME="$sandbox/home" "$dsh_bin" headless '请只回复两个字：好的' >/dev/null 2>&1); then
    export E2E_CONVERSATION_READY=1
    info "夹具就绪：真实对话已落盘（/tmp/e2e-ws）"
  else
    unset E2E_CONVERSATION_READY
    info "警告：真实对话夹具失败，浏览器层的对话用例将跳过"
  fi

  export E2E_BASE_URL="http://127.0.0.1:$port"
  export E2E_TOKEN="$token"
  export E2E_LOG="$sandbox/dsh.log"
  export E2E_DSH_VERSION="${ver:-$("$dsh_bin" --version 2>/dev/null || echo 'unknown')}"

  info "── 版本 ${E2E_DSH_VERSION}：协议断言 ──"
  local ok=1
  (cd "$E2E_DIR" && npx playwright test specs/protocol.spec.mjs) || ok=0

  if [ -f "$E2E_DIR/specs/ui.spec.mjs" ]; then
    info "── 版本 ${E2E_DSH_VERSION}：浏览器断言 ──"
    (cd "$E2E_DIR" && npx playwright test specs/ui.spec.mjs) || ok=0
  fi

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

# 热安装套件：**装完之后不重启**这个形态单独跑一遍。
#
# 为什么单独一套：它要的是「用户真实装进来的那份包」——link 形态下插件目录就是仓库，
# 没法模拟「包目录被换掉、vendor 被清空」；所以这里走 install 形态（`npm pack` 出 tarball
# 装进沙箱 profile），断言在 specs/hot-install.spec.mjs：重装后目录数据要能自愈、
# 状态页要提示重启。宿主版本不参与（漂移判定与 dsh 版本无关），跑一次就够。
run_hot_install_suite() {
  local slug="e2e-hot-install"
  info "── 热安装（重装不重启）：构建 + 打包 ──"
  (cd "$PROJECT_ROOT" && npm run build --silent) || return 1

  local tgz_dir tgz
  tgz_dir="$(mktemp -d /tmp/dsh-e2e-pack-XXXXXX)"
  (cd "$PROJECT_ROOT" && npm pack --pack-destination "$tgz_dir" >/dev/null 2>&1) || { rm -rf "$tgz_dir"; return 1; }
  tgz="$(ls "$tgz_dir"/*.tgz 2>/dev/null | head -1)"
  [ -n "$tgz" ] || { info "npm pack 没产出 tarball"; rm -rf "$tgz_dir"; return 1; }

  bash "$SCRIPT_DIR/test-sandbox.sh" up --name "$slug" --no-open --install "$tgz" || { rm -rf "$tgz_dir"; return 1; }

  local sandbox="$PROJECT_ROOT/test/sandbox/$slug"
  local port url token plugin_dir
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$sandbox/state.json" | head -1)"
  url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | tail -1)"
  token="${url##*token=}"
  # pnpm 装的这份是软链，取真身：用例会把整个包目录换掉，软链上操作容易只删到链接
  plugin_dir="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' \
    "$sandbox/home/profiles/web/node_modules/@dsh-one/dsh-llm-provider" 2>/dev/null || true)"
  if [ -z "$plugin_dir" ]; then
    info "找不到沙箱里装好的插件目录，热安装套件跳过"
    bash "$SCRIPT_DIR/test-sandbox.sh" clean --name "$slug" >/dev/null 2>&1 || true
    rm -rf "$tgz_dir"
    return 1
  fi

  export E2E_BASE_URL="http://127.0.0.1:$port"
  export E2E_TOKEN="$token"
  export E2E_PLUGIN_DIR="$plugin_dir"

  local ok=1
  info "── 热安装（重装不重启）：断言 ──"
  (cd "$E2E_DIR" && npx playwright test specs/hot-install.spec.mjs) || ok=0

  if [ "$ok" = 1 ]; then
    info "── 热安装（重装不重启）：通过 ──"
  else
    info "── 热安装（重装不重启）：失败（沙箱保留在 $sandbox 供排查，clean --name $slug 可清）──"
  fi
  if [ "$ok" = 1 ]; then
    bash "$SCRIPT_DIR/test-sandbox.sh" clean --name "$slug"
  fi
  rm -rf "$tgz_dir"
  return $((1 - ok))
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

# 热安装形态：所有 e2e 跑法都带上（用户装完不重启是常态，不能只靠人肉记着）
run_hot_install_suite || failures+=("热安装（重装不重启）")

if [ ${#failures[@]} -gt 0 ]; then
  die "以下未通过：${failures[*]}"
fi
info "全部通过"
