# @dsh-one/dsh-llm-provider

**中文说明** · [English](https://github.com/imchangchang/dsh-llm-provider/blob/main/README.md)

给 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）用的插件。它替换 dsh 插件树里的四个条目：pi-ai 适配器（`llm-pi-ai`）、DeepSeek 原生适配器（`llm-deepseek`）、模型选择器（`ui-model-selection`）、官方 Models 设置页（`ui-settings-models`），并在这之上加了额度查询与供应商管理。

四条能力：

1. **pi-ai 版本跟上游走**。dsh 在打包时固定它的 LLM SDK [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)，本插件跑自己维护的那份，上游出了新模型不用等 dsh 发版。
2. **额度查询**。按供应商查余额与用量窗口，数据同时给供应商卡片和模型选择器上的余量指示。
3. **模型选择器**。层级与官方一致（模型 / 推理等级），另加供应商过滤、余量指示、能力徽章和模型详情卡。
4. **供应商设置页**。添加、删除、测试、单卡刷新；写的是官方同一套设置段与凭据存储。

## 目录

- [使用](#使用)：[安装](#安装) · [第一次使用](#第一次使用) · [配置](#配置) · [测试实例](#测试实例) · [命令行跑测](#命令行跑测)
- [实现](#实现)：[pi-ai 桥接](#pi-ai-桥接) · [候选来源](#候选来源) · [兼容性检查](#兼容性检查) · [模型选择器](#模型选择器) · [供应商设置页](#供应商设置页) · [额度适配器](#额度适配器) · [路由发现](#路由发现) · [凭据检查](#凭据检查) · [HTTP 接口](#http-接口) · [构建](#构建)
- [边界](#边界)
- [对模型请求的影响](#对模型请求的影响)
- [已知缺口](#已知缺口)
- [源码布局](#源码布局)

## 使用

### 安装

从 npm 装：

```sh
dsh plugin --profile web add @dsh-one/dsh-llm-provider
dsh web     # 插件树变了，必须重启
```

包名后加 `@<版本>` 就是装指定版本。

需要 dsh 0.1.6-alpha.1 及以上（含 0.2 线）。插件把 `@deepseek-ai/dsh-authorization`
声明为可选 peer；dsh 0.2 起会在安装/启动时拿这个范围跟运行的 dsh 版本校验，
范围不含当前运行时的插件会被直接拒绝并报不兼容。

改本仓库代码时，把 checkout 链接进 profile：

```sh
scripts/install-deps.sh   # 装开发依赖
npm run build             # lib/ 是构建产物，不入库
# 链接 ~/.dsh/profiles/<profile>/node_modules/@dsh-one/dsh-llm-provider -> 本仓库路径
# 并在 profile 的 package.json dependencies 里写 "@dsh-one/dsh-llm-provider": "link:<路径>"
cd vendor && npm install  # 可选：在 checkout 里固定一份 pi-ai
dsh web                   # 插件树变了，必须重启
```

发布出去的包里没有 `vendor/` 和它的 lockfile，那份固定 pi-ai 只在 checkout 里有。装不装都行：没安装的来源会被跳过，落到 dsh 自带那份 pi-ai。目录不在意味着「没装」，不是「不兼容」，界面上不会出现「跳过 X：兼容性检查没通过」这种提示。

### 第一次使用

插件在自己 config 里声明了一条 DeepSeek 路由（`llm-pi-ai.providers.deepseek`，凭据名 `DEEPSEEK_API_KEY`），因为内置的 `llm-deepseek` 条目被禁用了。所以刚装完就有一张没配密钥的 DeepSeek 卡片：

- 在 设置 →「模型服务」→「服务商」里展开这张卡片。没存过凭据时「API 密钥」那行就是输入框，保存后立刻实查一次额度。
- 加别的供应商：「＋ 添加供应商」→ 选预设 → 填密钥与端点（带 OAuth 的供应商会多一个「使用 OAuth 登录」按钮，走 device-code / 订阅流程登录后写入同一套凭据存储）→ 测试通过后保存（目录里有的 provider，这一步只是读目录、不校验密钥，文案会照实说）。
- 之后卡片上就有余额，模型选择器的触发器上是同一个快照。

密钥存在 dsh 自己的凭据服务里，键名是路由的 `apiKeyEnv`，与官方那套读的是同一份，插件不需要自己的配置文件。

### 配置

供应商从 `settings.yaml` 的 `llm-pi-ai.providers` 发现。这一节里没有路由时额度面板是空的——按上面那步在设置页加一条。key 由 dsh 的凭据服务按每条路由的 `apiKeyEnv` 解析。

### 与 dsh 版本的兼容

插件同时伺候两代宿主，**按运行时能力选路，不按版本号分支**：

| 能力 | 0.1.x（如 0.1.6-alpha.2） | 0.2.x（0.2.0-rc.2 起） |
|---|---|---|
| 配置存在哪 | `settings.yaml` 的 `llm-pi-ai` 段 | profile patch 里**本插件条目的 config**（settings 命名空间 = 已加载条目的 id） |
| 读 | `settings.get/section('llm-pi-ai')` | 老段从 loader 的**条目列表**里 id 为 `llm-pi-ai` 那一行读（`options.config`；注意不是 include 条目自己的 `{path,patches}`）；界面写的那份在条目 config 里 |
| 写 | `settings.mutate('llm-pi-ai', ops)` | `ctx.configEditor.edit(条目, change)`（写 profile patch 并让 Loader 重载） |
| 官方 bundle 的 providers | 传入的 config **+ `settings.installSection` 叠上 `llm-pi-ai` 段** | **只认传入的 config**（`config.providers.get()`），不再读 `llm-pi-ai` 段 |

**关闭（不是卸载）本插件时，官方那四条会自己恢复**：patch 里的 `disabled` 写成 `!!js` 表达式（「仅当本插件的条目在场且启用时才禁用官方行」），Loader 每次求值，所以插件开关一拨就跟着变，不会出现「插件关了、官方也被禁着、一个模型都没有」的死角；表达式异常时一律不禁用（宁可官方插件可用）。

合并优先级（低 → 高）：**内置默认**（DeepSeek 那条，在 `src/provider-config.ts` 的 `BUILTIN_PROVIDERS`）→ **老 `llm-pi-ai` 段** → **本插件条目的 config**。后者一旦有内容就整体接管：界面写下去的是整份合并结果，所以老段里的路由会被一次性搬进条目，之后删改都生效，也不会被老段里的同名路由压住。

写配置的两条策略都留着，**按能力挑、失败自动换另一条并记住能走通的那条**（自愈）：宿主升级/降级、条目被禁用、profile patch 被 home patch 覆盖这些变化都不需要改配置。「pi-ai 桥接」标签页有一行「配置写入」写明当前走的哪条路、providers 来自哪里、有没有没清干净的告警。这条写路径只是没装（0.1.x 没有 `configEditor`、0.2.x 的 `settings.mutate` 写不了老命名空间）时不报告警——那是版本差异，不是故障。

写下去的合并是**逐字段合并**：省略某个字段不等于删掉它。要删得显式说出来（HTTP 接口里是 `merge` 的 `unsets`，界面上是卡片里的修正动作）——OAuth 授权成功后清掉配置里的 `apiKeyEnv` 就走这条，那个 ref 留着会让官方适配器只认它，取不到值直接报 `MISSING_CREDENTIAL`，等于把刚走完的登录堵死。

交给官方 bundle 的 providers 是**活值访问器**：0.2.x 上我们条目 config 的变更走 Loader 的 volatile 快路径，插件不会重挂，如果传的是挂载那一刻的快照，官方那边（`config.providers.get()`）就永远停在旧值——界面写完配置得重启 dsh 才生效。所以每次读都重新合并一遍，内容没变（按内容指纹比）才复用同一个对象，官方那套 identity 记忆化照样有效。

pi-ai 更新有两个触发路径：插件启动时后台查一次（6 小时节流，`DSH_PROVIDER_UPDATE=off` 可关），以及设置页上的「检查更新」按钮（`POST /provider/update`）。

两条路径都一样，**两道检查都过才会替换**：tarball 完整性（registry 的 `dist.integrity`）和兼容性检查。过了才标记为待重启，已经在跑的版本不会重复下载——手动点「检查更新」也会先拿当前生效的那份比一次版本。pi-ai 换了版本要重启 dsh 才生效——桥接在进程启动时装载。

下载一份 pi-ai 要占 80 MB 上下，所以插件只保留「比 dsh 自带那份新」的版本：同名或更旧的重复副本在装完后清掉，npm 缓存放系统临时目录（`<tmpdir>/dsh-llm-provider-npm-cache`），不落在插件目录里。「pi-ai 桥接」标签页显示当前占用（`vendor/` 总量 + npm 缓存），旁边的「清理」按钮（`POST /provider/prune`）删掉不会再被选中的旧版本与缓存；正在用的那份、以及「已下载、等重启生效」的那份都不动。

### 测试实例

```sh
scripts/test-profile.sh        # 起 plan-test profile（3081 端口）并打开浏览器
scripts/test-profile.sh stop   # 停掉
```

测试实例用独立 profile，可以并行：`PORT=3082 PROFILE=plan-test-foo LOG=/tmp/dsh-plan-foo.log scripts/test-profile.sh`。启动时带 `DSH_PROVIDER_TEST=1`，浏览器端据此在标题后加 ` · 测试`、给 favicon 盖「测」字角标。脚本生成的 profile 还会 link 本机另一条插件 `dsh-sidekick`（`$DSH_HOME/workspaces/dsh-mobile/plugin`）；机器上没有这份 checkout 时，先改脚本里那两行。

### 命令行跑测

```sh
node lib/adapters/run.js all            # 跑全部额度适配器（key 从环境变量或 ~/.dsh/.credentials.yaml 找）
node lib/adapters/run.js kimi-coding --key sk-xx

npm test                                # 构建 + 十四个离线测试；自测与合入跑的就是这条
npm run typecheck                       # tsc --noEmit（npm test 不含它）
```

十四个测试分别盯：路由发现、凭据检查、patch 层、pi-ai 兼容性检查、目录链清理（摘链不碰链目标）、旧版本清理的保留规则、模型能力的多链路合并、provider 配置的两代宿主兼容与自愈、模型发现的命名空间适配、供应商预设清单、vendor 状态合并、OAuth 路由（含 authorization 服务的挂载与降级）、GitHub Copilot 额度解析、浏览器端接线。开发流程（主线不写代码、全部走 worktree）见 `AGENTS.md`。

## 实现

### pi-ai 桥接

dsh 的模型目录来自它打包时那份 pi-ai。桥接让它跑在插件自己维护的版本上：

- 把已装的 `dsh-llm-pi-ai` bundle 拷到 `vendor/llm-bridge/`，旁边放一条软链指向 `vendor/pi-ai/<版本>/`。Node 按 bare specifier 从这里解析，拷贝副本就接到了新版 pi-ai。
- pi-ai 的模型目录与 wire 协议实现（`api/*.lazy`、`providers/all`）都是懒加载，全部来自新版；dsh 那份 bundle 只提供稳定的转换层。
- 官方 `llm-pi-ai` 条目（插件树里的一行）由 `cordis.patch.yml` 禁用，插件接管它的设置段、模型发现与目录。

用哪份 pi-ai 在**加载之前由[兼容性检查](#兼容性检查)决定**。回滚不用改软链：删掉下载的那份，下次启动自动落到下一个来源。

### 候选来源

`loadBridge()` 按优先级列出候选，逐个检查，取第一个通过的：

| 来源 | 目录 | 何时用到 |
|---|---|---|
| 已下载 | `vendor/pi-ai/<版本>/`（新的在前） | updater 下好并通过检查之后 |
| 兜底依赖（界面上的叫法） | `vendor/node_modules/@earendil-works/pi-ai` | 可选，装了就用（`cd vendor && npm install`） |
| dsh 自带 | 沿官方 bundle 的 `node_modules` 链找到的那份（不写死路径） | 前两个都没装，或检查不通过 |

没安装的来源直接跳过。只有**存在但检查不通过**时才列进「被跳过」并给出原因。dsh 自带那份的版本随 dsh 发布走，不一定比上游旧。

版本相同的重复副本不占热更新档的位置：下载档里版本不高于「本机已有的最好那份」（dsh 自带、兜底依赖）的，排在两个本机来源之后——同样的代码，优先复用本机那份，省掉一份 80 MB 的副本，也免得白重启一次。只有比本机新才排在最前。

后两个来源的目录都不写死。官方 bundle 按这个顺序沿解析链找：profile 的 `node_modules`、dsh 安装树（含嵌在 dsh 包里的 `node_modules`）、最后是本插件。pi-ai 从找到的那份 bundle 位置继续沿解析链找。所以 dsh 换布局（bundle 放进自己的安装目录、依赖提升到别处）不会让某个来源凭空消失。

`vendor/package.json` 锁住兜底依赖的版本，与下载目录互不覆盖：更新只往 `vendor/pi-ai/<新版本>/` 写。两个都放在 `vendor/` 下，是因为桥接副本在 `vendor/llm-bridge/`，向上解析先撞到 `vendor/node_modules`，选中这一来源时不用挂软链。

### 兼容性检查

从桥接副本源码里抠出它对 pi-ai 的 import 需求（子路径 + 具名导出），照着生成一份探针文件，放进插件自己的临时目录、配一条指向候选的软链，再 require 它。解析规则与拷贝完全一致，但模块 URL 不同，所以一个候选失败不影响下一个，也不污染真正的拷贝。

需求解析覆盖具名导入与 re-export、动态 `import()`、副作用与 namespace 导入、`export *`。**必须先检查再加载**：Node 对加载失败的 ESM 会留下半初始化记录，同一个文件再 require 只会报 `not yet fully loaded`，所以「先加载、失败再退回」这条路走不通。

检查不通过的候选列在 `/provider/status` 的 `bridge.rejected` 里。需求压根解析不出来时检查跑不了，被选中的那份按「目录存在」放行，此时报 `probeUnverified: true`。updater 侧一样，只有检查通过才替换。

### 模型选择器

接管输入框（composer）上的 `conversation.input.model` 座位（插件挂载点）与 `/model` 命令（官方 `ui-model-selection` 条目由 `cordis.patch.yml` 禁用）：

- 交互与官方一致：触发器胶囊（`<供应商id>/<模型id>` · 推理等级）→ 根面板「模型 / 推理等级」两行 → 模型面板 → 推理等级面板。选了模型或等级就关菜单。
- 取数与官方同路：目录走 `session/modelCatalog`，切换走 `session/selectModel`，余量走 `/plan/status`；官方 `modelDirectories` 客户端服务在就用它，不在就用自己的 RPC。
- 当前选择优先取会话里记着的那次，没有就用目录默认。默认等级只认目录声明的 `defaultEffort`，目录没声明就显示官方的 `Default` 文案。
- 切换模型后**强制选档**：点了新模型不立即关菜单，跳到推理等级面板让你确认一档（面板里有 `Default` 可选；已勾选的那一档也点得动——它就是确认动作）。初始选中的档位按上一档继承——能直接命中新模型的档位表就沿用，命中不了按「区间中心」做比例映射（5 档第 3 档 → 3 档第 2 档），新模型没有 reasoning 元数据时显示空态 +「知道了」，提交一个无档位的选择。
- 插件接管前记下的会话可能写着官方那条 `deepseek-official` 路由（现在已不存在）。这种选择会折到现路由（`deepseek`）上显示与取余量，座位还会把会话里记的那次改写一次——宿主在记录里的 provider 没有适配器时直接拒绝发送。改写只在目标路由与模型都在目录里时才做。
- 额外做的：供应商过滤 chips（带余量指示点）、跨供应商搜索（子串/缩写/编辑距离）、能力徽章、上下文标注、模型详情卡。能力按 `provider + id` 查（同名模型跨 provider 很常见，裸 id 会串家）；三条链路都查不到就不打徽章，详情卡里注明「能力未知」并给出这条能力是哪来的。
- **按账号可用清单过滤模型**：OAuth 登录时 pi-ai 会把「这个账号能用哪些模型」记进凭据（`availableModelIds`），宿主的 `/plan/status` 把它作为 `availableModels` 下发，列表与卡片都据此过滤。pi-ai 的静态目录与账号权益是两回事——Copilot 目录 28 个模型、某个账号实际只有 6 个能用，选到清单外会拿 400 `model_not_supported`。当前选中的模型即使在清单外也照常显示（否则像凭空消失）。
- 触发器上的余量指示与供应商卡片读同一个快照，显示最紧的那个窗口的百分比；卡片上每个窗口分别列。
- 空间不够时先隐藏供应商段，最后才截断模型名；推理等级和余量不收缩。composer 行宽 ≤760px 时隐藏供应商段，≤620px 时余量只留指示点。胶囊宽度上限 `min(560px, 60cqw)`，全名始终挂在 `title` 上。

### 供应商设置页

设置页新增「模型服务」标签（官方 `ui-settings-models` 条目已禁用），两个二级标签：「服务商」、「pi-ai 桥接」。

- 卡片照官方 PluginCard：状态点 + 名称 + 官网链接，一行余量摘要（`5h: 84% ◷ 3h7m ｜ 7d: 30% ◷ 3d20h`），右侧是刷新时间、单卡刷新、删除。展开体展示路由配置（路由 ID、掩码密钥、凭据名，以及 API 地址 / 协议——协议只在路由真写了时才有，地址没写时摆的是目录默认端点）和该供应商的模型列表（带过滤与详情卡）。
- 添加供应商：选预设 → 填密钥与端点（带 OAuth 的预设可直接走 OAuth 登录，自动写入同一套凭据存储）→ 通过测试才能写入（目录里有的 provider，这一步读的是 pi-ai 目录、不发请求也不校验密钥，密钥要到发第一条消息时才验；只有自建网关那一步是真·实连探测）。写的是 `settings/mutate` 的 `llm-pi-ai.providers` 段与 `credentials/set`，与官方同一套存储。路由**已存在**时只逐字段覆盖表单管的键（`baseURL` / `apiKeyEnv` / 自建网关的 `api`），手写的 `models` / `compat` / `retryPolicy` 不动——整对象 `set` 在 dsh-settings 里是覆盖语义，会把它们一起抹掉。
- 补密钥：路由在、凭据没值时，卡片展开体里那一行就是输入框（官方 Models 页已禁用，这是唯一入口）。存完立刻实查一次额度。这种供应商在添加列表里标「缺密钥」而不是「已配置」，不会被禁选堵住。
- 删除：清路由 + 清凭据。内置原生路由不允许在这里删。确认行单独占一行，并且写明删的是哪条路由、连不连凭据、手写配置不可撤销——原来的确认按钮跟 ✕ 挤在同一格，连点两下第二下正好落在「确认删除」上，等于没确认。
- 模型清单：展开体「模型（N）」下面是逐行可编辑的清单（勾选 / 改字段 / 整份替换 / 恢复跟随目录），保存写回 `llm-pi-ai.providers.<id>.models`；细节与限制见[已知缺口](#已知缺口)。
- 「pi-ai 桥接」标签：当前版本与来源、被跳过的候选及原因、磁盘占用与清理按钮、上游版本与检查更新按钮。

### 额度适配器

一家一个文件（`src/adapters/`），`registry.ts` 注册一行，契约在 `shared.ts`；`node lib/adapters/run.js` 可单独跑。除 qwen 外都发免费 GET，都不依赖浏览器登录态：多数用各家的 API key，github-copilot 用 OAuth 登录拿到的 GitHub token（走 OAuth 的 provider 没有 apiKeyEnv，插件层从凭据记录里取）。

| 适配器 | 数据来源 |
|---|---|
| deepseek | `api.deepseek.com/user/balance` |
| kimi-coding | `api.kimi.com/coding/v1/usages` |
| moonshot | `api.moonshot.cn/v1/users/me/balance`（按 baseURL 走 `.cn` 或 `.ai`；路由没写就用目录默认） |
| glm | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| minimax | `api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（国际站是 `.io`） |
| opencode-go | `opencode.ai/zen/go/v1/usage` |
| zenmux | `baseURL` 本身（响应里是 `quota_5_hour` / `quota_7_day`；这家不在目录里，地址只能用户自己填） |
| openrouter | `openrouter.ai/api/v1/credits` |
| github-copilot | `api.github.com/copilot_internal/user`（付费档 `quota_snapshots`、免费档 `monthly_quotas`；要 GitHub token，不是 api.githubcopilot.com 那个） |
| qwen | 无公开接口：不发请求，卡片给「看控制台」跳转链接 |

数值与展示口径对齐 CC Switch（[farion1231/cc-switch](https://github.com/farion1231/cc-switch)，给编码 CLI 切换供应商配置的桌面工具）：它显示哪些字段就显示哪些，不额外加工。套餐等级字段在下发到浏览器前丢弃；Kimi 充值包余额不显示，因为数值与 CC Switch 不一致，看着也不可靠。

### 路由发现

额度面板和预设清单列哪些供应商，由两处合并决定：

1. `settings.yaml` 的 `llm-pi-ai.providers`——用户配置的 pi-ai 路由。
2. `ctx.llm.listConfigurableProviders()` 里的原生适配器路由（`deepseek-official` 这类）：它们不写设置段也带默认 `apiKeyEnv`，而这个默认值在服务上读不到，所以 `routes.ts` 用一张 `NATIVE_ROUTE_DEFAULTS` 表对上。

显示名优先用路由自己的 `displayName`，没有就取 pi-ai 注册表里 `*Provider()` 工厂给的名字（`pi-ai-names.ts`，带缓存），再没有就按 id 拼一个。pi-ai 目录外只保留一个入口：Custom Gateway。模型 ID 与路由 ID 一律显示原值，与设置里的键对得上。

### 凭据检查

宿主在解析各家 key 时顺手比对，两个供应商用同一把 key 就在界面上报警。dsh 自己不做这个检查，而配置界面拿不到 key 值，所以这个错误在别处只表现为「某个供应商一直查询失败」。key 只在宿主进程内参与比对，不出进程。

### HTTP 接口

| 路由 | 作用 |
|---|---|
| `GET /plan/status` | 各供应商额度快照（60 秒缓存，`?refresh=1` 绕过） |
| `GET /provider/status` | 桥接状态、路由表、更新状态、磁盘占用、测试实例标记 |
| `POST /provider/update` | 手动触发一次上游检查与更新 |
| `POST /provider/prune` | 清理不会再被选中的 pi-ai 旧版本与 npm 缓存（正在用/待生效的不动） |
| `GET /provider/models` | 模型元数据，三条链路合并：route 声明的 `input` → pi-ai 目录 → 适配器自报（`listModels`/`resolveModelInfo`，只补目录里没有的 provider，带单调用超时与总预算）。60 秒缓存（`?fresh=1` 绕开）；详情卡与能力徽章用 |
| `GET /provider/presets` | 可添加的供应商预设清单（含已配置标记） |
| `POST /provider/refresh` | 单卡刷新额度（实查并更新全局快照） |
| `POST /provider/discover` | 草稿探测模型清单（「添加供应商 → 测试」）；按 dsh 版本试命名空间（0.1.x 的 `llm-pi-ai` / 0.2.x 的插件条目 id）并自愈 |
| `POST /provider/mutate` | 写 provider 配置（`merge` / `unset` / `unsetFields`），宿主按 dsh 版本选写入口并自愈。`merge` 是逐字段合并，**省略某个字段不等于删掉它**——要删得在 `unsets` 里列出来（OAuth 授权后清 `apiKeyEnv` 就走这条） |
| `POST /provider/remove` | 删除供应商（清路由 + 清凭据） |
| `POST /provider/test` | 用已存的 key 查一次某家的额度（只读，不动全局快照） |
| `GET /provider/oauth/flows` | 列出 `ctx.authorization` 已注册的 flow（与 `/provider/presets` 的 `preset.oauth` 同源） |
| `POST /provider/oauth/begin` | 发起一次 attempt，立刻返回 attemptId；后台跑 flow、往 SSE 总线推事件 |
| `GET /provider/oauth/stream` | SSE 流：`data: {kind:'notice'\|'prompt'\|'settled',...}`。attempt 不存在回 404，已 settled 立刻回 settled 帧 |
| `POST /provider/oauth/respond` | 浏览器对 prompt 的回应，按 attemptId + promptId 找到 pending resolver |
| `POST /provider/oauth/cancel` | 主动撤 attempt（既 abort 本地 signal，也调 `authorization.cancel(key)` 让 in-flight slot 释放） |

添加供应商的表单不调 `/provider/test`，走的是官方 `llm/discoverModels` 的草稿探测。

这些是自建路由，不是官方的 Typert Remote：那套生成器只认单体仓库布局（`<root>/packages/` 下的包、`@Remote` 的来源必须在已注册的包里），单包插件走不通。代价是没有类型安全的调用点，靠离线测试兜住。

### 构建

```sh
npm run build      # tsdown：宿主端 src/*.ts -> lib/*.js（unbundle）；浏览器端 src/client/index.ts -> lib/client.js（单文件 CJS + window.__ModuleLoader__ 外壳）
npm run watch      # 改代码自动重建
npm run typecheck  # tsc --noEmit
```

宿主端 1:1 转译，产物路径与 package.json 的 exports 对应。浏览器端把 `src/client/` 下的模块内联成一个文件，那三行加载器外壳由构建的 banner/footer/intro 加上，源码里不写。

插件跑的就是 `lib/`——改了源码没构建，跑的还是旧代码。

装依赖走 `scripts/install-deps.sh`，不要直接 `npm install`：`node_modules/@deepseek-ai` 是指向宿主 profile 的软链，npm 会顺链去 reify 里面两百个包并失败。脚本的做法是装前挪开、装完放回。

## 边界

- **不写宿主配置**。dsh 安装目录、凭据一律只读。写只发生在两处：插件自己的 `vendor/`（下载 pi-ai、放桥接副本、写状态文件，其中一部分在加载期就写），以及用户在界面上的显式操作（添加/删除供应商、改模型清单、卡片上的字段修正）——这类写入经宿主自己的配置写入口（0.1.x 的 `settings.mutate` / 0.2.x 的 `configEditor.edit`），不是插件直接改文件。启动期不写任何宿主配置；读到的老 `llm-pi-ai` 段只是合并进内存视图，第一次界面写入时才随整份配置搬进插件条目。
- **不改第三方包文件**。pi-ai 一个字节都不改，哪怕它的模型数据是静态快照、落后于上游——打补丁会让装下来的东西与 registry 的完整性校验对不上，不可复现。
- **不改官方插件文件**。接管一律通过在 `cordis.patch.yml` 里禁用官方条目（`llm-pi-ai`、`llm-deepseek`、`ui-model-selection`、`ui-settings-models`），官方其余行为保持原样。本插件自己的模型座位带 `priority: -10`，那是同一座位上遮蔽占用者的机制。
- **key 值不出宿主进程**。浏览器端只拿结论与元信息（前 3 + 后 4 的掩码）。
- **不需要浏览器登录态（cookie / 已登录会话）**。OAuth 走 device-code：插件把验证页链接与串码交给界面，人在任意设备上完成授权，凭据由 dsh 的凭据服务保管（浏览器侧只拿得到链接与串码，拿不到 token）。
- **webserver 没有鉴权层**（dsh 的设计如此，默认只绑 loopback）。自建路由不做额外校验的前提是「仅本机可达」：把宿主暴露到 `0.0.0.0`，`/plan/status` 会泄露余额与凭据名。Desktop 正式实例在宿主层还要求 token（无 token 一律 403），而 `dsh web --port <端口> --no-open` 起的隔离实例没有这一层——实测同一个端口上 `/plan/status`、`/provider/status`、`/provider/presets` 不带 token 就返回 200，所以「仅本机可达」这条前提在那种启动方式下更宽。

## 对模型请求的影响

插件不改 system prompt、工具 schema 和消息内容。它决定哪些模型可用、各自走哪条 wire 协议，以及推理等级怎么落到请求参数上；后两件由 pi-ai 按模型实现，不在这里。

- 没选等级时（界面显示 `Default`）请求里不带 `reasoning_effort`。是否发 thinking 开关、发什么值，看 pi-ai 对这个模型的实现。
- 选了等级就由 pi-ai 按该供应商映射：有的发 `reasoning_effort` 字段，有的发 `budget_tokens`（按思考预算计费的那类），有的发自适应思考。

额度查询是独立的免费 HTTP 请求，不给模型请求加 token。换 pi-ai 版本会同时换掉模型目录与用量口径。切模型或切供应商会改变请求前缀，KV cache 命中随之从零开始；同模型内切等级只改 thinking 相关参数。插件不改写会话内容，自己的缓存只有上面列的 60 秒额度与模型元数据快照。

## 已知缺口

版本节奏：**0.2.x 只收修复**；下面标了「0.3.x」的两条属于功能补齐，排在 0.3.x。

官方那些条目有、本插件没有的：

- **逐模型清单编辑只有个通用替代（官方式表单排 0.3.x）**。卡片展开体里「模型（N）」下面有「编辑清单」（`src/client/model-editor.ts`）：勾选要暴露的模型、或整份换成自定义清单，行内可改 `id` / `name` / `contextWindow` / `maxTokens` / `input`（文本、图片、视频）/ `reasoningEfforts` / `compat.thinkingFormat`，保存写回 `llm-pi-ai.providers.<id>.models`。与官方那套的差别：官方按 schema 给每类 provider 定制表单，这里是一张通用表格；`reasoningEfforts` 在配置里是 `{档位: 线上值}` 映射，界面上写成 `low,high=max` 这样的文本（留空 = 沿用 pi-ai 目录那份，`false` = 不推理）。保存前先校验（id 空、重名、非正整数、不认识的档位都不让存），因为宿主对清单是 strict 解析，一条坏的会让整条路由不可用。编辑器只对 `llm-pi-ai` 路由显示——原生路由（`deepseek-official` 这类）的模型不写在这套设置里；另外只在「能力查到了」或用户亲手动过勾选时才写 `input`：详情还没到就保存，不会拿一个占位的 `text` 把目录里的视觉能力盖掉。
- **「当前模型不可路由」置灰**。官方 `ui-model-selection` 会在当前模型无法路由时把 composer 置灰；该条目被禁用后，当前供应商没配好时输入框照样能用。
- **官方引导流程**。Models 页带的 DeepSeek 引导没有替代。

如实说明（没验到的、没做的）：

- **0.2.x 上老 `llm-pi-ai` 段会变成残留**。第一次在界面上写配置时，老段里的路由会被搬进插件条目，老段本身（profile patch 里那行 `llm-pi-ai`）删不掉——它的条目被本插件的 patch 禁用着，宿主不让写。之后这行只是历史，生效的是插件条目里那份；要清理得手改 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）。
- **桥接整体不可用时只有局部提示（全局告警排 0.3.x）**。候选全灭（目录坏了、权限问题、上游改导出名）时插件会退回「纯计费模式」，官方那四条条目仍被 patch 禁用，于是模型列表空掉——这时只有「pi-ai 桥接」标签页里一行错误行（`bridge.active === false`），composer 那边没有任何提示。要一眼看懂得再加一条全局告警，目前没做。

- **多端点 / 多协议的 provider 没有实连验证过**。判定按官方回落链推的、离线断言也覆盖了，但 OpenRouter / Fireworks / opencode / opencode-go / Cloudflare / Bedrock 这几家没有可用的 key，没跑过真实发送（Copilot / DeepSeek 这类单端点是实连过的）。
- **可用模型是登录时的快照**。OAuth 登录时 pi-ai 记下 `availableModelIds`，模型列表按它过滤；账号权益变了（放开新模型、升级订阅）要重新登录一次才刷新。
- **已有 OAuth 路由改回密钥路径**：添加表单里两种方式都能选，但卡片上没有「改回密钥」的入口，要改只能删掉路由重建。
- **OAuth 的 token 字段名是 pi-ai 的内部结构**：额度适配器读凭据记录里的 `refresh` / `access`（Copilot 的配额接口要 GitHub 那个长期 token）。上游改名要跟着改——桥接固定的是 pi-ai 版本，升级时 `pi-ai 体检` 那套会发现。

以后可能补的：

- 侧边栏入口与 `shell.overlay` 全局额度徽标。
- 会话内的实时用量与失败归因（读 `llm/stream`、`session/event` 的用量，`llm/retry` 的配额/限流失败码）。额度数据来自轮询端点，回答的是「账户还剩多少」，不是「这次花了多少、为什么失败」。

不做的：

- Kimi 控制台接口要网页登录态的 JWT，不接。
- 不 fork 官方插件源码，也不背单体仓库布局（Typert Remote 因此用不了）。

### OAuth / subscription 登录

dsh 的 `dsh-authorization` seam 自己负责 prompt 协议、`AuthInteraction` 的中继、commit 校验；官方 `llm-pi-ai` 又在 mount 时把 pi-ai catalog 里每个 provider 都注册成 flow（密钥型的、订阅型的、以及只有 OAuth 的 Codex——具体几家随 pi-ai 版本变）。差的本来有两段：**服务没人挂**，以及浏览器端没有 wire。

**第一段：原版 dsh 不挂 authorization 服务。** 两个官方 bundle 的 patch 层（`dsh-base` 86 行、`dsh-web-app` 70 行）都只挂了 `@deepseek-ai/dsh-credentials-local`（凭据存储），没有 `@deepseek-ai/dsh-authorization`。而 `@deepseek-ai/dsh-authorization` 的 package.json 里没有 `dsh.bundle` 字段，所以也不能当 profile bundle 列进去（列了 dsh 直接报 "declares no dsh.bundle"，整个 profile 起不来）。结果是官方 `llm-pi-ai` 里那句 `ctx.inject(['authorization'], …)` 从不触发、`registerPiAiFlows` 一次都不跑，**OAuth flow 一个都没有**——界面上自然也没有 OAuth 入口。

本插件在启动时补这一段：`ensureAuthorizationService()`（`src/oauth.ts`）在服务缺席时，按宿主锚点解析出宿主自己那份 `@deepseek-ai/dsh-authorization`，用 `ctx.plugin()` 挂到当前 fiber 上。cordis 的服务注册写在 root 的 store 上，所以挂完之后官方 `llm-pi-ai` 的 inject 会**响应式地**跑起来，把 catalog 里每个 provider 的登录方式注册齐全——官方插件一行不改。实测链路：服务缺席 → inject 登记 → 我们挂载 → 回调触发 → `registerFlow` 成功。拿不到包、加载失败、`ctx.plugin` 不可用都只降级成「没有 OAuth 入口」，不抛——插件加载失败会让整个 dsh 起不来。解析用宿主那一份、不另装同名包：第三方插件自带一份会引进第二份 cordis 运行时，服务注册就串了。

**第二段：浏览器侧的 wire。** 本插件补这一段（`src/oauth.ts`，路由见 HTTP 接口表）：

- 后台 attempt + 内存事件总线（Node `EventEmitter`），与 `dsh-authorization`「attempt 不可持久」对齐——刷新页面就丢 attempt，不会留下半初始化状态。
- 浏览器↔宿主走 SSE（`Content-Type: text/event-stream`）；flow 推 `notice`（message + URL + code）、`prompt`（text / secret / select 三种 kind）、`finished`。浏览器重启 EventSource 时直接读 SSE 收尾帧，不必重开 attempt。
- 同一个 credential key 同时只允许一个 attempt：seam 自己也会拒（`ALREADY_IN_FLIGHT`），我们这里先发制人给 409。
- 5 分钟未活动的 attempt 被 sweeper 清掉（断网 / 关页后内存不漏）；attempt settled 后保留到 TTL 上限，浏览器重连 SSE 还能拿到结果。
- 客户端在「添加供应商」表单里识别 `preset.oauth`：按钮替代密码输入框，弹窗实时显示 notice 与 prompt（按 kind 渲染 input / select），settled 后通过 `onAdded` 触发卡片刷新。
- **协议和端点都归 pi-ai 目录，路由不写 `api` / `baseURL`**。官方适配器是 `const api = request.api ?? base?.api ?? routeApi`、`const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl`——路由上写了就盖掉**每个模型自己的那份**：40 家里 6 家是多协议（Copilot：claude 系走 `anthropic-messages`、gpt-5.x 走 `openai-responses`、gemini 走 `openai-completions`），其中 5 家的端点还按协议分（Fireworks / opencode / opencode-go / OpenRouter / Cloudflare 的 anthropic 与 openai 端点差一个 `/v1` 之类的后缀——SDK 自己会再拼 `/v1/messages`，写错就是 `.../v1/v1/messages`），Bedrock 更是 us-east-1 与 eu-central-1 两套。实测写死 `anthropic-messages` 让 `gpt-5.4` 报 400 `no model endpoints available given user constraints`。表单里地址栏留空即用目录默认（占位符里显示），用户想覆盖企业版端点、带占位符的网关再自己填——**不能写空串**，`'' ?? x` 不会回落。余额查询和卡片展示要用的端点从目录取（`catalogBaseUrlOf`）；OAuth 路由的端点由凭据决定（`auth.baseUrl` 覆盖模型自己的），卡片不显示目录里那个地址。卡片上的告警按目录里真实的协议集判（预设响应里的 `apis`）：**多协议**的 provider 写死了才报（写死必然发错一批），单协议的写对了不报——那种白报只会让用户去点一个没必要的修正按钮；单协议但写死的跟目录不一致（手填错了）照样报，文案会点名两边各是什么。两种都配「改成按模型协议」的一键修正：它 `unset api`，**并且**在路由地址等于目录端点集合里的某一个时连 `baseURL` 一起删（旧版表单会把目录地址写进路由，那同样盖掉每个模型自己的端点）——用户自己写的企业版端点不在那个集合里，不会被碰。
- **「只有 OAuth」由 pi-ai 元数据判定**：读 provider 工厂的 `auth`，有 `oauth` 且没有 `apiKey` 就是（当前只有 `openai-codex`），新加的自带跟上。例外只有一个 `github-copilot`：元数据里它确实有 `apiKey` 路径，但那只是个手填 token 的框（`Enter GitHub Copilot token`），这种 token 得先登录 GitHub 换、用户手里不会有，所以界面按 OAuth-only 处理（`KEY_PATH_IS_DEAD_END`）。判到 OAuth-only 的界面只留登录这条路：藏掉「API 地址 / 协议 / 凭据名」三行和「测试」按钮，也不渲染「改用 API 密钥」那条切换——那条路在这套界面里走不通（测试按钮被藏了，而「添加到列表」要求测试通过），Copilot 更甚：那种 token 本来就拿不到。
- **一个 provider 的认证方式二选一，按 flow 的方法分**。挂上 authorization 服务后每个 provider 都有 flow，但方法含义不同：`oauth` 是真·订阅登录，`api-key` 只是 dsh 把「让你输密钥」也包装成了一次登录。所以判据是方法 id 而不是「有没有 flow」——DeepSeek / OpenAI / Moonshot 只有 `api-key` 方法，表单照旧给密钥输入框（给它们显示「使用 OAuth 登录（DeepSeek）」既误导又顶掉密钥框）；两者都有的（Anthropic / Kimi Coding / OpenRouter / xAI / Radius）默认走 OAuth，旁边一条「改用 API 密钥」可切回密钥输入——注意 pi-ai 的 flow 也给 Copilot 报 `api-key` 方法，但它被上面那条 OAuth-only 规则挡掉了。
- **两者不能共存于同一条路由**。pi-ai 的优先级是「显式传入的 apiKey > 凭据记录里的 grant > 环境变量」（`auth/resolve.js`，`models.js` 那句 "Explicit request options win per-field" 是同一件事），所以一条路由要么写 `apiKeyEnv`（密钥路径），要么不写（凭据记录路径）。混着写的结果是显式 key 静默胜出、OAuth 那份变成死配置。
- **OAuth 授权的路由不写 `apiKeyEnv`**。官方适配器的 `resolveApiKey` 只要看到 `apiKeyEnv` 就只认那个 ref，取不到值直接抛 `MISSING_CREDENTIAL`——写上它等于把 OAuth 登录堵死（发送时才报错）。留空才会回落到 pi-ai 自己的凭据解析，从凭据记录里取 grant 换 token。早期版本添加的路由带着这个字段时，卡片展开体会给一条「改用 OAuth 认证」的一键修正（`unset apiKeyEnv`）。

边界：

- **attempt 不可持久**——这是 dsh-authorization 的硬限制，刷新页面会丢。中途断网 / 关页要重头来。
- **provider 自带文本 prompt**——比如 Copilot enterprise 的「GitHub Enterprise URL/domain」，kind=text 用普通 input。
- **OAuth 失败不写凭据**——commit 校验要求「attempt 期间观察到的 commit」才算成功；失败 / 取消走的都是 abort signal，seam 自己会没收 in-flight slot。

## 源码布局

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 宿主入口：挂桥接、注册 HTTP 路由 |
| `src/bridge.ts` | 桥接装载：拷 bundle、按检查挑 pi-ai、管理软链；`hostPackageEntry()` 供按宿主锚点解析官方包 |
| `src/updater.ts` | 上游更新器：查 registry、校验 tarball、装依赖、标待重启、清理旧版本与缓存、统计占用 |
| `src/routes.ts` | 路由发现、官网链接、显示名兜底 |
| `src/provider-presets.ts` | 添加供应商的预设清单（pi-ai 目录动态生成 + Custom Gateway） |
| `src/oauth.ts` | OAuth 登录桥：补齐官方没挂的 `authorization` 服务，并把 flow 暴露给浏览器端（5 条 HTTP 路由 + SSE） |
| `src/provider-config.ts` | provider 配置的读写层：两代宿主的多个来源合并、两条写策略的能力探测与自愈 |
| `src/model-discovery.ts` | 草稿探测的命名空间适配：0.1.x 的 `llm-pi-ai` 与 0.2.x 的插件条目 id 都试、记住能用的那条 |
| `src/model-details.ts` | 模型详情与能力：读生效 pi-ai 包的 providers 数据文件，再合并 route 声明的 `input` 与适配器自报的模态（按 `provider + id` 索引） |
| `src/pi-ai-names.ts` | 读 pi-ai 注册表里的名字（显示名的来源之一） |
| `src/credential-check.ts` | 凭据检查 |
| `src/adapters/*.ts` | 额度适配器（一家一个文件 + 注册表 + CLI 跑测器） |
| `src/client/*.ts` | 浏览器端：`index`（入口/座位注册）· `model-seat` · `settings` · `model-editor`（模型清单编辑器）· `command` · `data` · `format` · `styles` · `i18n` · `icons` · `diag` · `types` |
| `cordis.patch.yml` | bundle patch 层：禁用官方条目、插入本插件、声明 DeepSeek 路由 |
| `test/*.mjs` | 十四个离线测试（不进 dsh、不起服务） |
| `scripts/*.sh` | worktree 开发流程、测试实例、装依赖 |
