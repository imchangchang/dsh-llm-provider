#!/bin/bash
# 一次性 dsh 测试沙箱：真 dsh、真浏览器，但不碰 ~/.dsh，用完全部痕迹一删即净。
#
#   scripts/test-sandbox.sh up    [--name <slug>] [--port <n>] [--dsh-version <x>] [--no-open] [--fresh]
#   scripts/test-sandbox.sh url   [--name <slug>]
#   scripts/test-sandbox.sh clean [--name <slug>] [--all] [--deep]
#
# 沙箱目录 test/sandbox/<slug>/（已 gitignore）里是这个实例的全部痕迹：
#   home/      充当 DSH_HOME 的数据目录（profile、settings、凭据都在这里面）
#   cli/       传了 --dsh-version 时 npm 装进来的那份 dsh
#   dsh.log    实例日志（带 token 的访问地址也从这里取）
#   state.json pid / port / 起始时间，clean 靠它停进程
#
# 隔离原理：启动时给 dsh 进程设 DSH_HOME=<沙箱>/home。dsh-home-paths 解析 home 的
# 优先级是「显式配置 > $DSH_HOME > 默认 ~/.dsh」，profile-boot 的注释也写明
# DSH_HOME 就是留给测试/启动器设的——所以 ~/.dsh 一个字节都不会被写。
#
# 宿主配置的拷入策略：.credentials.yaml（API key 与登录态）和 settings.yaml 只在
# 沙箱里还没有时才拷，之后测试期间在沙箱里的改动（比如新登录的凭据）不会被
# 重新 up 覆盖。要完全重来：--fresh（清掉沙箱重建，再拷一份最新的宿主配置）。
#
# --deep 在 clean 时额外删插件 checkout 里的 vendor/ 运行时产物（pi-ai 桥接副本、
# npm 缓存等，见 .gitignore 同名条目，可随时重建；默认保留，重新起实例省一次生成）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_ROOT="$PROJECT_ROOT/test/sandbox"
DEFAULT_PORT=3091
HOST_DSH_HOME="$HOME/.dsh"

die()  { echo "test-sandbox: $*" >&2; exit 1; }
info() { echo "test-sandbox: $*"; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# 名字只留安全字符，防止拼出逃出 test/sandbox/ 的路径
sanitize_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//'
}

# 默认 slug：worktree 里跑取分支名（agent/<slug> 的 <slug>），主线跑就是 main
default_slug() {
  local branch
  branch="$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || true)"
  case "$branch" in
    ''|main|master) printf 'main' ;;
    agent/*)        printf '%s' "${branch#agent/}" ;;
    *)              printf '%s' "$branch" ;;
  esac
}

# 删沙箱前先确认目标确实在 test/sandbox/ 底下
rm_sandbox_dir() {
  local target="$1"
  case "$target" in
    "$SANDBOX_ROOT"/*) rm -rf "$target" ;;
    *) die "拒绝删除 test/sandbox/ 之外的路径：$target" ;;
  esac
}

json_array() {
  local out="[" first=1 item
  for item in "$@"; do
    [ "$first" = 1 ] || out+=","
    out+="\"$item\""
    first=0
  done
  printf '%s]' "$out"
}

read_state_field() { # <sandbox-dir> <字段名>：没有 state.json 或缺字段就返回空（不报错）
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"*\([^\",}]*\)\"*.*/\1/p" "$1/state.json" 2>/dev/null | head -1 || true
}

stop_sandbox() { # <sandbox-dir>
  local dir="$1" pid port pids
  pid="$(read_state_field "$dir" pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  port="$(read_state_field "$dir" port)"
  if [ -n "$port" ]; then
    # 只看 LISTEN：浏览器标签页握着的客户端连接也算在 tcp:$port 上，不能据此判断实例还活着
    pids="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      die "端口 $port 还被进程占着（${pids}），不像本沙箱的实例，请确认后手动处理"
    fi
  fi
}

copy_once() { # <来源> <目的地>：来源存在且目的地还没有才拷
  if [ -f "$1" ] && [ ! -e "$2" ]; then
    cp "$1" "$2"
    info "拷入宿主配置：$(basename "$2")"
  fi
}

# ---------------------------------------------------------------- up

cmd_up() {
  local slug="" port="$DEFAULT_PORT" version="" open=1 fresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)        slug="$2"; shift 2 ;;
      --port)        port="$2"; shift 2 ;;
      --dsh-version) version="$2"; shift 2 ;;
      --no-open)     open=0; shift ;;
      --fresh)       fresh=1; shift ;;
      *) die "up 不认识参数：${1}（见 $0 无参用法）" ;;
    esac
  done
  [ -n "$slug" ] || slug="$(default_slug)"
  slug="$(sanitize_slug "$slug")"
  [ -n "$slug" ] || die "沙箱名字是空的，用 --name 指定一个"

  local sandbox="$SANDBOX_ROOT/$slug"
  local sandbox_home="$sandbox/home"
  local profile_dir="$sandbox_home/profiles/web"

  if [ "$fresh" = 1 ] && [ -d "$sandbox" ]; then
    stop_sandbox "$sandbox"
    rm_sandbox_dir "$sandbox"
    info "--fresh：已清掉旧沙箱 $slug"
  fi

  # 重启语义（跟 test-profile.sh 一致）：保证拿到新令牌、加载刚构建的 lib/
  stop_sandbox "$sandbox"

  # 选 dsh 可执行：指定版本就装进沙箱 cli/，否则用 PATH 上那份
  local dsh_bin
  if [ -n "$version" ]; then
    local cli_dir="$sandbox/cli"
    dsh_bin="$cli_dir/node_modules/.bin/dsh"
    if [ ! -x "$dsh_bin" ] || [ "$("$dsh_bin" --version 2>/dev/null)" != "$version" ]; then
      command -v npm >/dev/null 2>&1 || die "npm 不在 PATH 上，装不了 dsh@$version"
      info "安装 dsh@$version 进沙箱 cli/…"
      mkdir -p "$cli_dir"
      npm install --prefix "$cli_dir" --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@$version"
    fi
  else
    dsh_bin="$(command -v dsh || true)"
    [ -n "$dsh_bin" ] || die "PATH 上找不到 dsh，也没传 --dsh-version"
  fi

  mkdir -p "$profile_dir/node_modules/@dsh-one"

  # 宿主模型配置拷入：凭据（API key/登录态）优先，settings.yaml 有就带上
  copy_once "$HOST_DSH_HOME/.credentials.yaml" "$sandbox_home/.credentials.yaml"
  copy_once "$HOST_DSH_HOME/settings.yaml"     "$sandbox_home/settings.yaml"

  # profile 三件套，形状与 test-profile.sh 生成的 plan-test 一致
  if [ ! -f "$profile_dir/cordis.yml" ]; then
    if [ -f "$HOST_DSH_HOME/profiles/web/cordis.yml" ]; then
      cp "$HOST_DSH_HOME/profiles/web/cordis.yml" "$profile_dir/cordis.yml"
    else
      printf '[]\n' > "$profile_dir/cordis.yml"
    fi
  fi

  # dsh-sidekick 是本机另一条插件：宿主有就带上，没有就不进 bundles
  # （test-profile.sh 是无条件写进 bundles、没有 checkout 的机器要手改两行；这里自动化掉）
  local sidekick_src="$HOST_DSH_HOME/workspaces/dsh-mobile/plugin"
  local deps_json="\"@dsh-one/dsh-llm-provider\": \"link:$PROJECT_ROOT\""
  local bundles=("@deepseek-ai/dsh-base" "@deepseek-ai/dsh-web-app")
  if [ -d "$sidekick_src" ]; then
    deps_json+=", \"dsh-sidekick\": \"link:$sidekick_src\""
    bundles+=("dsh-sidekick")
    ln -sfn "$sidekick_src" "$profile_dir/node_modules/dsh-sidekick"
  fi
  bundles+=("@dsh-one/dsh-llm-provider")
  ln -sfn "$PROJECT_ROOT" "$profile_dir/node_modules/@dsh-one/dsh-llm-provider"

  cat > "$profile_dir/package.json" <<EOF
{
  "name": "dsh-profile-sandbox-$slug",
  "private": true,
  "dependencies": { $deps_json },
  "dsh": { "profile": { "bundles": $(json_array "${bundles[@]}") } }
}
EOF

  # 与 plan-test 相同的 patch 层：官方模型管理三件套禁用，由本插件接管
  cat > "$profile_dir/cordis.patch.yml" <<'EOF'
# 测试沙箱 profile 的 patch 层，形状同 scripts/test-profile.sh 的 plan-test。
# 官方模型管理三件套全禁，模型座位由 dsh-llm-provider 独立接管；
# llm-pi-ai 再禁一次是为了摘掉插件看裸基线时官方行也不回来。
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-query.sqlite')
    openAt: first-search
- id: llm-pi-ai
  disabled: true
- id: ui-model-selection
  disabled: true
- id: ui-settings-models
  disabled: true
EOF

  # 端口被非本沙箱进程占着就直接报错，不误杀
  local occupied
  # 同 stop_sandbox：只看 LISTEN，浏览器握着的客户端连接不算占用
  occupied="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$occupied" ] || die "端口 $port 已被进程占用（${occupied}），换 --port 或先清掉占用者"

  : > "$sandbox/dsh.log"
  info "启动沙箱 ${slug}（dsh: ${dsh_bin}）…"
  DSH_HOME="$sandbox_home" DSH_PROVIDER_TEST=1 \
    nohup "$dsh_bin" --profile web --port "$port" --no-open >> "$sandbox/dsh.log" 2>&1 &
  local pid=$!

  cat > "$sandbox/state.json" <<EOF
{
  "slug": "$slug",
  "port": $port,
  "pid": "$pid",
  "dsh": "$dsh_bin",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

  # 等 token URL 出现在日志（跟 test-profile.sh 同款 grep），进程死了提前收工
  local url="" i
  for i in $(seq 1 30); do
    url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | head -1 || true)"
    [ -n "$url" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$url" ]; then
    echo "启动失败，最后日志（$sandbox/dsh.log）：" >&2
    tail -20 "$sandbox/dsh.log" >&2 || true
    exit 1
  fi

  info "沙箱实例: $url"
  info "痕迹目录: ${sandbox}（clean 即焚）"
  if [ "$open" = 1 ] && command -v open >/dev/null 2>&1; then
    open "$url"
  fi
}

# ---------------------------------------------------------------- url

cmd_url() {
  local slug=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) slug="$2"; shift 2 ;;
      *) die "url 不认识参数：$1" ;;
    esac
  done
  [ -n "$slug" ] || slug="$(default_slug)"
  slug="$(sanitize_slug "$slug")"
  local sandbox="$SANDBOX_ROOT/$slug"
  [ -d "$sandbox" ] || die "沙箱 $slug 不存在（${sandbox}）"
  local port
  port="$(read_state_field "$sandbox" port)"
  [ -n "$port" ] || die "沙箱 $slug 没有 state.json，不知道端口；重新 up 一次"
  local url
  url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | tail -1 || true)"
  [ -n "$url" ] || die "没在 $sandbox/dsh.log 里找到访问地址，实例可能没起来"
  printf '%s\n' "$url"
}

# ---------------------------------------------------------------- clean

cmd_clean() {
  local slug="" all=0 deep=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) slug="$2"; shift 2 ;;
      --all)  all=1; shift ;;
      --deep) deep=1; shift ;;
      *) die "clean 不认识参数：$1" ;;
    esac
  done
  [ -n "$slug" ] || slug="$(default_slug)"
  slug="$(sanitize_slug "$slug")"

  local targets=()
  if [ "$all" = 1 ]; then
    local d
    for d in "$SANDBOX_ROOT"/*/; do
      if [ -d "$d" ]; then targets+=("${d%/}"); fi
    done
    [ ${#targets[@]} -gt 0 ] || { info "test/sandbox/ 下没有沙箱可清"; return 0; }
  else
    targets+=("$SANDBOX_ROOT/$slug")
  fi

  local t
  for t in "${targets[@]}"; do
    [ -d "$t" ] || continue
    info "清理 $t"
    stop_sandbox "$t"
    rm_sandbox_dir "$t"
  done

  if [ "$deep" = 1 ]; then
    info "删除插件 checkout 的 vendor/ 运行时产物"
    rm -rf "$PROJECT_ROOT/vendor/pi-ai" \
           "$PROJECT_ROOT/vendor/llm-bridge" \
           "$PROJECT_ROOT/vendor/.npm-cache" \
           "$PROJECT_ROOT/vendor/node_modules" \
           "$PROJECT_ROOT/vendor/status.json" \
           "$PROJECT_ROOT/vendor/updater-state.json"
  fi
  info "完成"
}

# ---------------------------------------------------------------- 入口

case "${1:-}" in
  up)    shift; cmd_up "$@" ;;
  url)   shift; cmd_url "$@" ;;
  clean) shift; cmd_clean "$@" ;;
  ''|-h|--help) usage ;;
  *) die "不认识的子命令：${1}（up / url / clean）" ;;
esac
