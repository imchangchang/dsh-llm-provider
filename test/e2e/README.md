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
3. ⏳ composer 的模型选择器是插件接管版——**待夹具**：选择器需要选中的工作区会话
   上下文，沙箱还没有可选工作区；用例已写好、标 skip，夹具就位后去掉 skip
4. ✅ 全程 console 无未捕获异常
5. ✅ DeepSeek 额度卡出数——CI 里跳过（`CI=1` 时 skip，依赖真实外网接口）

浏览器层约定：`playwright.config.ts` 固定 `locale: 'zh-CN'`——无头浏览器默认 en-US
时 dsh web 渲染英文，中文选择器全部落空；固定后断言与机器/CI 的 locale 无关。
选择器只走可访问名 / 占位符 / 文本，不碰 class hash。

## 定稿的设计约束

- **安装类测试一律显式版本号**（如 `@dsh-one/dsh-llm-provider@0.2.1-alpha.10`），不用 dist-tag。
  背景：pnpm 新版（12.5.1 / 12.8.1 实测）把 `@alpha` 解析到旧版本（0.2.1-alpha.6），
  同机 npm CLI 与 pnpm 9/10 都正确，是 pnpm 侧的解析回归；dist-tag 在测试里不可复现。
- **发布检查**：`npm view <包名> dist-tags.latest` 必须等于刚发的稳定版本号；预发布必须带
  `--tag` 发布，避免占走 latest。安装矩阵另有一条「裸包名安装 == 最新稳定版」的用户视角兜底。
- **版本矩阵**：断言按 dsh 版本键控（如 0.2.x 的 `/provider/status` 没有 `bundleVersion`/
  `providers` 字段），不做一刀切。
- Playwright 依赖装在 `test/e2e/` 自己的 node_modules，根 `package.json` 不引入。
