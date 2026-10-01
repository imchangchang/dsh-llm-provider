#!/bin/bash
# 截图编排：构建 → 起沙箱 → 种工作区夹具 → 跑 test/e2e/specs/screenshots.spec.mjs → 清沙箱。
#
#   scripts/capture-screenshots.sh              # 中英两套，写进 docs/images/
#   scripts/capture-screenshots.sh --keep       # 保留沙箱，方便反复调构图
#   scripts/capture-screenshots.sh --name foo   # 换沙箱名（并行跑多个时用）
#
# 与 scripts/test-e2e.sh 同一套沙箱：DSH_HOME 隔离在 test/sandbox/<名字>/，clean 即焚。
# 截图不是断言，不进 CI；本脚本只在人要更新 README 配图时手动跑。
# 夹具（都是沙箱里的一次性状态）：
#   1. 宿主 ~/.dsh/.credentials.yaml 由沙箱拷入 → 有凭据的 provider 全被加进路由；
#   2. 工作区 + 会话上下文：storage 在启动时读，所以在 up 之前写好 workspace.json。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$PROJECT_ROOT/test/e2e"

die()  { echo "capture-screenshots: $*" >&2; exit 1; }
info() { echo "capture-screenshots: $*"; }

slug="shots"
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=1; shift ;;
    --name) slug="$2"; shift 2 ;;
    *) die "不认识参数：$1（见 $0 头部用法）" ;;
  esac
done
slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
[ -n "$slug" ] || die "沙箱名字是空的"

sandbox="$PROJECT_ROOT/test/sandbox/$slug"
workspace_title="demo-app"

# 停掉上一个实例。test-sandbox 的 stop 靠 `ps` 认领进程，某些受限环境里 ps 不可用，
# 所以这里先按 pid 文件停一次，再交给 test-sandbox clean 收尾。
stop_sandbox() {
  local pid=""
  [ -f "$sandbox/dsh.pid" ] && pid="$(cat "$sandbox/dsh.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    info "停掉上一个沙箱实例（pid ${pid}）"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  bash "$SCRIPT_DIR/test-sandbox.sh" clean --name "$slug" >/dev/null 2>&1 || true
}

# 依赖就位：@playwright/test 装在 test/e2e 自己的 node_modules，不碰根 package.json
if [ ! -d "$E2E_DIR/node_modules/@playwright" ]; then
  info "安装 e2e 依赖（首次较慢）…"
  (cd "$E2E_DIR" && npm install --no-audit --no-fund --loglevel=error)
fi
(cd "$E2E_DIR" && npx playwright install chromium)

info "构建插件（npm run build）…"
(cd "$PROJECT_ROOT" && npm run build --silent)

stop_sandbox
[ -d "$sandbox" ] && die "沙箱目录没清干净：$sandbox"

# 工作区夹具：storage 只在启动时读一遍，所以要先落盘再 up。
mkdir -p "$sandbox/home/storages" "$sandbox/workspace"
cat > "$sandbox/home/storages/workspace.json" <<EOF
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["ws-capture"],
    "archivedSessionIds": []
  },
  "tables": {
    "workspaces": {
      "ws-capture": {
        "path": "$sandbox/workspace",
        "title": "$workspace_title",
        "sessionIds": [],
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
      }
    }
  }
}
EOF

info "起沙箱 ${slug}…"
bash "$SCRIPT_DIR/test-sandbox.sh" up --name "$slug" --no-open

port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$sandbox/state.json" | head -1)"
url="$(grep -o "http://127.0.0.1:$port/?token=[A-Za-z0-9_-]*" "$sandbox/dsh.log" | tail -1)"
token="${url##*token=}"
[ -n "$token" ] || die "没从 $sandbox/dsh.log 里拿到访问令牌"

export E2E_BASE_URL="http://127.0.0.1:$port"
export E2E_TOKEN="$token"
export E2E_CAPTURE=1
export E2E_SHOTS_DIR="$PROJECT_ROOT/docs/images"
export E2E_WORKSPACE="$workspace_title"

# 宿主机凭据库里真实有值的条目名（只读名字，不碰值），交给 spec 决定给哪些 provider 建路由。
# `refs` 是密钥名，`records` 里的 `llm-pi-ai/<id>` 是 OAuth 登录态。
credential_entries="$(python3 - "$sandbox/home/.credentials.yaml" <<'PY'
import re, sys
try:
    lines = open(sys.argv[1], encoding='utf-8').read().splitlines()
except OSError:
    lines = []
section = None
for line in lines:
    if re.match(r'^[A-Za-z]', line):
        section = line.split(':', 1)[0]
        continue
    match = re.match(r'^  ([A-Za-z0-9_.\-/]+):', line)
    if match and section in ('refs', 'records'):
        print(f'{section}\t{match.group(1)}')
PY
)"
export E2E_CREDENTIAL_REFS="$(printf '%s\n' "$credential_entries" | awk -F'\t' '$1=="refs"{printf "%s%s", sep, $2; sep=","}')"
export E2E_CREDENTIAL_RECORDS="$(printf '%s\n' "$credential_entries" | awk -F'\t' '$1=="records"{printf "%s%s", sep, $2; sep=","}')"
info "宿主机凭据：refs=${E2E_CREDENTIAL_REFS:-（无）}"
info "宿主机凭据：records=${E2E_CREDENTIAL_RECORDS:-（无）}"

info "跑截图 spec（中英各一套）…"
ok=1
(cd "$E2E_DIR" && npx playwright test specs/screenshots.spec.mjs) || ok=0

info "产出："
ls -la "$PROJECT_ROOT/docs/images" 2>/dev/null | tail -n +2 || true

if [ "$keep" = 1 ]; then
  info "保留沙箱：${sandbox}（clean --name $slug 可清）"
else
  stop_sandbox
fi

[ "$ok" = 1 ] || die "截图套件有失败用例，见上面的 Playwright 输出"
info "完成"
