# AGENTS.md

给所有在本仓库干活的 session（人或 AI）的约定。

## 开发流程（pdl 协调）

**main 不开发，只集成与合入。** 规则正本是本文件末尾的「多 session 并行开发规则（agent-worktree）」段与 `.agents/skills/parallel-dev-worktree/`，这里是速查：

- 要改任何文件，先 `.agents/pdl acquire --as <你的名字>`：
  - **拿到锁** → 直接在主检出改；提交用 `.agents/pdl commit -m "..."`（裸 git commit 会被
    pre-commit 钩子拦截）；干活期间定期 `.agents/pdl heartbeat`；收工 `.agents/pdl release`。
  - **拿不到锁** → `.agents/pdl new <主题>` 建 worktree，之后只在 worktree 里改；
    建好后先 `bash scripts/install-deps.sh`（装 typescript / tsdown / @types/node，处理
    `@deepseek-ai` 软链，**别直接 npm install**——会 reify 软链直接 EPERM）；改完自己跑
    `npm test`，再 `.agents/pdl deliver <说明>`。之后不要动该 worktree，分支名报给用户/持锁者。
- **合入**由持锁者征得用户同意后 `.agents/pdl merge <名字>`：merge 前自动跑
  `.agents/checks.sh`（主线干净检查 + `npm test` + e2e；`PDL_SKIP_E2E=1` 可跳过 e2e），
  失败自动回滚——不要手工强合，不要在主检出 `reset --hard`。
- **例外**（不走 worktree，直接在主检出改）：只读分析（不改文件，不需要锁）；改仓库自身
  约定/文档且不涉及代码行为（本文件、`README.md` / `README.zh.md` 纯文档、`scripts/` 里的
  流程脚本）。例外场景同样要先 `acquire`、用 `pdl commit` 提交。
- 两套 worktree 目录的分工：`.agents/worktree/`（pdl `new` 建的，走 deliver/merge）；
  兼容期如遇到旧 `.worktrees/<slug>`（旧 dev-start 流程遗留，已废弃），里面的分支若已并入
  main 可直接删，未并入的先问用户。

## 构建与测试

- **源码在 `src/`（TypeScript），`lib/` 是构建产物、不入库。** 改完要 `npm run build`
  （= `tsdown`）。插件是 profile 里 `link:` 进来的，跑的就是 `lib/`，忘了构建就是跑旧代码。
- 自测 = `npm test`（= `npm run build` + `test/*.mjs` 十五个离线测试，都在 command line 跑、
  不起 dsh）。合入前的 `.agents/checks.sh` 会跑它。
- `npm run typecheck`（= `tsc --noEmit`）是类型检查，`npm test` 不含它——构建不报类型错，
  类型错了要单独跑才看得见。
- 要开界面看效果：`scripts/test-profile.sh`（在 worktree 里跑就是起这个 worktree 的实例，插件目录按脚本位置定位）。这个脚本会写 `~/.dsh/profiles/`、还要开浏览器，**由用户本人在真实终端跑**，代理别在沙箱里试。
- 测试实例默认 3081 端口、`plan-test` profile——**一次只能跑一个**。要并行各起一个：
  `PORT=3082 PROFILE=plan-test-foo LOG=/tmp/dsh-plan-foo.log scripts/test-profile.sh`。
  脚本生成的 profile 还会 link 本机另一条插件 `dsh-sidekick`（`$DSH_HOME/workspaces/dsh-mobile/plugin`），
  没有那份 checkout 的机器上先改脚本里那两行。
- 隔离沙箱实例：`scripts/test-sandbox.sh`（up / url / status / clean）。`DSH_HOME` 重定向到
  `test/sandbox/<名字>/`，不写 `~/.dsh`，`clean` 即焚；端口默认在 10000-19999 自动挑，
  可 `--dsh-version` 指定 dsh 版本。**它不是测试分层的一层**，是下面两层共用的起环境工具。
- 测试分三层。「e2e」是第二、三层的统称，**不带修饰词时默认指第二层（Playwright）**：
  - **自测**：`npm test` 的 15 个离线脚本。开发 session 自己跑，不起 dsh，不算 e2e。
  - **e2e**（默认）：Playwright 对真 dsh 实例 + 无头浏览器跑断言（`test/e2e/`，
    `scripts/test-e2e.sh` 编排）。机器断言、可回归，合入与 CI 必过。
  - **e2e 验收**（也叫「真实浏览器跑 e2e」）：kimi-webbridge 操控真实 Chrome + 真实账号，
    发布前过一遍。无断言，产出是确认和截图。说「验收」或「真浏览器 e2e」都指这层。

## 注意点

- 非交互场景跑 git 一律带 `GIT_EDITOR=true`（rebase、commit）。否则 git 会用 `core.editor`（常配 `code --wait`）拉起编辑器阻塞，命令挂死、窗口莫名弹到桌面上。
- 合入后主线测试挂了：能从最新 main 开新 worktree 修就修（走完整流程）；主线不可用（插件起不来/核心功能挂）就先 `git revert -m 1 <merge commit>` 恢复，再另开 worktree 排查。
- worktree 是「拉分支那一刻」的快照：**worktree 里的 `scripts/` 可能是旧版**，要用新脚本就写主工作区的绝对路径、cwd 留在 worktree 内。
- worktree 里没有的东西：`node_modules/`、`reference/` 完全不进；`vendor/` 只有 `package.json` 和 lockfile 入库会跟着进，`vendor/pi-ai/`、`vendor/llm-bridge/`、`vendor/node_modules/` 不进。跑测试实例时 `vendor/`（bridge 副本 + pi-ai）会由插件自己在该 worktree 里生成，属正常。
- 临时产物（复现样例、diff、临时脚本、截图）写到 `/tmp`，不要落在仓库里——落在仓库里既弄脏工作区，也可能和合入进来的同名文件冲突。

<!-- agent-worktree-rules -->
# 多 session 并行开发规则（agent-worktree）

本仓库可能同时有多个 DSH session 一起工作。约定：

- **主文件夹**（本仓库根目录）是唯一合入点；**合入目标 = 主检出当前所在分支**，不一定是 git 的 main。要基于某条分支做并行开发，先把主检出切到那条分支。
- 协调数据都在仓库内 `.agents/`：`main.lock`（主检出编辑锁）、`worktree/`（工作树）、`worktree_status/`（每个 worktree 的状态）。辅助命令是 `.agents/pdl`。

## 先判断你要做什么
- **只回答问题、不改任何文件** → 什么都不用做，直接回答。
- **要改文件** → 先 `.agents/pdl acquire`，按结果走下面两条路径之一。

## 路径一：acquire 成功（拿到锁，可以直接改主文件夹）
1. 干活期间定期 `.agents/pdl heartbeat` 刷新心跳，防止锁被判过期。
2. 提交必须用 `.agents/pdl commit -m "..."`（裸 git commit 会被钩子拦截）。
3. 结束前：`.agents/pdl status` 看有没有「可合入」的 worktree → 有就问用户是否合入 → 然后 `.agents/pdl release`。

## 路径二：acquire 失败（锁被别的会话持有）
1. `.agents/pdl new <主题>` 建 worktree，**之后所有编辑只发生在它输出的 worktree 目录里**。
2. 改完在 worktree 里跑检查、`git commit`，然后 `.agents/pdl deliver <说明>` 标记「可合入」。
3. deliver 之后不要再动这个 worktree；要继续改，改完再 deliver 一次。
4. 不要自己 merge，也不要等锁。到此为止，把分支名报给用户/持锁者即可。

## 合入（必须先征得用户同意）
- 原则上由**当前持锁的会话**负责：完成后看 `pdl status`，对「可合入」的 worktree 问用户，同意后 `.agents/pdl merge <名字> --as <持有者名>`。
- 锁空闲时，任何会话在结束对话前发现「可合入」的 worktree，也可以问用户是否合入；`merge` 会自动临时拿锁、用完自动释放。
- 冲突或 `.agents/checks.sh` 失败时脚本会自动回滚并报告——不要手工强合，不要在主检出 `reset --hard`。

## 切分支（一律用 `.agents/pdl switch`，不要裸 checkout 主检出）
- 有未处理 worktree 且其基分支 ≠ 目标分支时，脚本会拒绝并列出选项：`--merge`（合入）/ `--abandon`（放弃）/ `--leave-all`（暂不管：目录移除、分支与状态保留并记录基分支，之后可 `restore`）。**先问用户选哪种**。
- 原则：切走后 `.agents/worktree/` 不留目录；已提交的内容在分支上，不会丢。
- 基分支 == 目标分支的 worktree 不拦，切过去之后再合入。

## 禁止
- 未持锁直接编辑主文件夹里的文件。
- 动其他会话的 worktree 目录、`.agents/worktree_status/` 里别人的记录、`main.lock`。
- 丢弃主检出的未提交改动（reset --hard / checkout --）——发现主检出脏了先问用户。
