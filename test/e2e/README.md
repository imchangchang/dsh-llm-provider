# e2e（第二层）：对真 dsh 实例的自动化断言

跑法：`scripts/test-e2e.sh [--versions <逗号分隔的 dsh 版本>]`。
编排脚本起一次性沙箱（`test-sandbox.sh`：`DSH_HOME` 隔离、独立 npm 环境、`clean` 即焚）、
跑 `specs/` 下的断言、然后清沙箱。任何断言失败，对应沙箱目录会保留供排查。

## 断言清单

**协议层（`specs/protocol.spec.mjs`，不起浏览器）：**

1. 实例可达：web 根路径有响应
2. `/provider/status`：200、`testMode: true`、桥接激活
3. 凭据拷入生效：routes 里有 deepseek，`apiKeyEnv` 为 `DEEPSEEK_API_KEY`
4. `/provider/presets`：非空，条目带 id/label
5. `/provider/models`：200 且为 JSON 对象
6. 写闭环：`mutate`（merge）写入 → 回带的 providers 含新条目 → `unset` → 消失
7. `/provider/test`：对不存在的路由返回结构化 200，不 5xx
8. `/plan/status`：200 且为 JSON
9. 启动日志无官方行撞车（无 `already declared`、无「组件启用失败」）
10. `--dump-config`：组合树里有 `dsh-llm-provider` 条目

**浏览器层（`specs/ui.spec.mjs`，已落地，需 `npx playwright install chromium`，
编排脚本会自动装）：**

1. ✅ 设置面板有「模型服务」标签（插槽注入成功）
2. ✅ 添加供应商表单打开、预设下拉非空
3. ✅ composer 的模型选择器是插件接管版——夹具是编排器跑的一轮 `dsh headless`
   真实对话（等 pi-ai 就绪后执行，会话按 cwd 落盘）；用例经「搜索会话」打开它，
   断言选择器弹层含模型目录路径（`deepseek/deepseek-flash`）与推理等级子项
4. ✅ 全程 console 无未捕获异常
5. ✅ DeepSeek 额度卡出数——CI 里跳过（`CI=1` 时 skip，依赖真实外网接口）

浏览器层约定：`playwright.config.ts` 固定 `locale: 'zh-CN'`——无头浏览器默认 en-US
时 dsh web 渲染英文，中文选择器全部落空；固定后断言与机器/CI 的 locale 无关。
选择器只走可访问名 / 占位符 / 文本，不碰 class hash。

**热安装层（`specs/hot-install.spec.mjs`，install 形态沙箱，`test-e2e.sh` 每次都跑）：**

「装完插件但没重启 dsh」是用户常态，这一层专门盯它。编排器 `npm pack` 出 tarball、
用 `--install` 装进沙箱 profile（不是 link 开发目录——只有真装进来的那份包才能被
「换掉目录、清空 vendor」），把装好的包目录路径通过 `E2E_PLUGIN_DIR` 传给用例：

1. ✅ 基线：预设 > 10 条、模型目录 > 100 条、桥接激活、没有漂移提示
2. ✅ 准备：把当前 pi-ai 落到插件目录里（等价于「下载新版 → 立即切换」；真实机器上由
   更新器完成，用例里手工放一份副本再 `POST /provider/swap`，不依赖网络与上游版本）
3. ✅ 重装不重启：把包目录整个换成「刚装进来」的样子（vendor 清空）后断言
   —— ① 目录自愈：供应商预设与模型目录退回宿主那棵树继续可读，不是一片空白；
   ② 状态页报出 `bridge.piAiDrift`（旧路径已不在盘上、实际读的那份、重启 dsh 生效）

用例是破坏性的（会改沙箱里的包目录），所以 `retries: 0`：serial 模式下的重试是整组重跑，
重跑时环境已经被改过，基线断言必然失败，重试没有意义。

## 截图（`specs/screenshots.spec.mjs`，不是断言）

README 的界面图由这里产出：`scripts/capture-screenshots.sh` 起一次沙箱，跑
`specs/screenshots.spec.mjs`，中文（`*.zh.png`）与英文（`*.png`）两套外壳各八张，
写进 `docs/images/`。spec 只在 `E2E_CAPTURE=1` 时执行，不进 `test-e2e.sh` 的回归范围。

夹具都在一次性的沙箱里：宿主凭据经 `.credentials.yaml` 拷入后，编排脚本把
**凭据库里真实有值的密钥名**读出来传给 spec，spec 照着给对应的 provider 建路由
（`/provider/presets` 的 `missingKey` 不能用来判断这件事：它只在「路由已配置且没值」
时为 true，未配置的预设一律 false）。composer 那张图要有会话上下文，夹具是编排脚本
在启动前写进 `home/storages/workspace.json` 的工作区——路径必须取 `fs.realpath` 过的，
否则宿主挂不上会话（`/tmp` 在 macOS 上是软链，会踩这个）；这与 `ui.spec.mjs` 借编排器
`dsh headless` 真实对话造夹具是两条路，互不影响。

截图自身的口径：设置页裁到 `[role="dialog"]` 的可视区域，composer 那张整屏截
（裁窄会把输入框左边和面板底边切一半）；英文外壳下插件面板仍是中文，只有
`src/client/i18n.ts` 里有英文词条的少数键（导航名、添加供应商、OAuth 文案）跟着切。

## 定稿的设计约束

- **安装类测试一律显式版本号**（如 `@dsh-one/dsh-llm-provider@0.2.1-alpha.10`），不用 dist-tag。
  背景：pnpm 新版（12.5.1 / 12.8.1 实测）把 `@alpha` 解析到旧版本（0.2.1-alpha.6），
  同机 npm CLI 与 pnpm 9/10 都正确，是 pnpm 侧的解析回归；dist-tag 在测试里不可复现。
- **发布检查**：`npm view <包名> dist-tags.latest` 必须等于刚发的稳定版本号；预发布必须带
  `--tag` 发布，避免占走 latest。安装矩阵另有一条「裸包名安装 == 最新稳定版」的用户视角兜底。
- **版本矩阵**：断言按 dsh 版本键控（如 0.2.x 的 `/provider/status` 没有 `bundleVersion`/
  `providers` 字段），不做一刀切。
- Playwright 依赖装在 `test/e2e/` 自己的 node_modules，根 `package.json` 不引入。
