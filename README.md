# @dsh-one/dsh-llm-provider

[中文说明](https://github.com/imchangchang/dsh-llm-provider/blob/main/README.zh.md) · **English**

A plugin for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness). It replaces four entries of dsh's plugin tree — the pi-ai adapter (`llm-pi-ai`), the native DeepSeek adapter (`llm-deepseek`), the model selector (`ui-model-selection`) and the official Models settings page (`ui-settings-models`) — and adds quota lookups and provider management on top.

What you get:

1. **pi-ai version follows upstream.** dsh pins its LLM SDK, [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), at build time; this plugin runs a copy it maintains itself, so new upstream models don't wait for a dsh release.
2. **Quota lookups.** Balance and usage windows per provider, feeding the provider cards and the quota indicator in the model selector.
3. **Model selector.** The official two-level structure (model / reasoning effort) plus provider filtering, quota indicator, capability badges and a model detail card.
4. **Provider settings page.** Add, remove, test and refresh providers; writes to the same settings section and credential store the official page uses.

The UI strings are Chinese; the plugin ships no English UI yet.

## Contents

- [Usage](#usage): [Install](#install) · [First run](#first-run) · [Configuration](#configuration) · [Test instance](#test-instance) · [Command-line checks](#command-line-checks)
- [Implementation](#implementation): [pi-ai bridge](#pi-ai-bridge) · [Candidate sources](#candidate-sources) · [Compatibility check](#compatibility-check) · [Model selector](#model-selector) · [Provider settings page](#provider-settings-page) · [Quota adapters](#quota-adapters) · [Route discovery](#route-discovery) · [Credential check](#credential-check) · [HTTP endpoints](#http-endpoints) · [Build](#build)
- [Boundaries](#boundaries)
- [Effect on model requests](#effect-on-model-requests)
- [Known gaps](#known-gaps)
- [Source layout](#source-layout)

## Usage

### Install

From npm:

```sh
dsh plugin --profile web add @dsh-one/dsh-llm-provider
dsh web     # restart required: the plugin tree changed
```

Add `@<version>` to the package name to install one specific version.

Requires dsh 0.1.6-alpha.1 or newer, including the 0.2 line. The plugin declares
`@deepseek-ai/dsh-authorization` as an optional peer, and dsh 0.2 checks that range
against the running dsh version at install/boot — a plugin whose range excludes the
runtime is refused with an incompatibility error.

To work on this repository, link the checkout into the profile instead:

```sh
scripts/install-deps.sh   # install dev dependencies
npm run build             # lib/ is build output and is not committed
# link ~/.dsh/profiles/<profile>/node_modules/@dsh-one/dsh-llm-provider -> this checkout
# and set "@dsh-one/dsh-llm-provider": "link:<path>" in the profile's package.json dependencies
cd vendor && npm install  # optional: a pinned pi-ai kept in the checkout
dsh web                   # restart required: the plugin tree changed
```

Published packages ship neither `vendor/` nor its lockfile, so the pinned pi-ai only exists in a checkout. It is optional either way: a source that isn't installed is skipped and the plugin falls back to the pi-ai that ships with dsh. A missing directory means "not installed", not "incompatible", so nothing about it appears in the UI.

### First run

The plugin declares a DeepSeek route in its own config (`llm-pi-ai.providers.deepseek`, credential name `DEEPSEEK_API_KEY`), because the built-in `llm-deepseek` entry is disabled. A new install therefore shows a DeepSeek card with no key:

- Expand the card in Settings → 「模型服务」 → 「服务商」; the "API 密钥" row is an input field when no credential is stored. Saving it runs a quota query right away.
- For any other provider: 「＋ 添加供应商」, pick a preset, fill in key and endpoint, pass the test, save.
- The card then shows the balance, and the model selector shows the same snapshot on the current provider.

Keys are stored through dsh's own credential service under the route's `apiKeyEnv`, so they are the same credentials the official stack reads. Nothing here needs a plugin config file.

### Configuration

Providers come from `llm-pi-ai.providers` in `settings.yaml`. With no route there, the quota panel is empty — add one from the settings page as above. Keys are resolved by dsh's credentials service through each route's `apiKeyEnv`.

### Compatibility with dsh versions

One plugin serves both host generations, choosing its path from **runtime capabilities, never from a version number**:

| Capability | 0.1.x (e.g. 0.1.6-alpha.2) | 0.2.x (0.2.0-rc.2 onward) |
|---|---|---|
| Where configuration lives | the `llm-pi-ai` section of `settings.yaml` | the **plugin's own entry config** in the profile patch (a settings namespace is the id of a loaded entry) |
| Read | `settings.get/section('llm-pi-ai')` | the legacy section is read from the **loader entry list** (the row whose id is `llm-pi-ai`, via `options.config`; not the include entry's own `{path, patches}`); UI writes live in the entry config |
| Write | `settings.mutate('llm-pi-ai', ops)` | `ctx.configEditor.edit(entry, change)` (writes the profile patch and lets Loader reload) |
| Providers the official bundle sees | the config passed in **plus `settings.installSection` layering the `llm-pi-ai` section on top** | **only the config passed in** (`config.providers.get()`); it no longer reads the `llm-pi-ai` section |

**Disabling the plugin (rather than uninstalling it) brings the four official entries back**: the `disabled` flags in the patch are `!!js` expressions ("disable the official row only while this plugin's entry is present and enabled"), evaluated by the Loader on every check, so flipping the plugin toggle propagates. There is no "plugin off, official disabled, no models at all" dead end; when the expression fails it never disables the official row (official plugins stay usable).

Merge order (low → high): **built-in defaults** (the DeepSeek route, in `BUILTIN_PROVIDERS` in `src/provider-config.ts`) → **legacy `llm-pi-ai` section** → **this plugin's entry config**. Once the last one has content it takes over completely: the UI writes the whole merged set, so routes from the legacy section are migrated into the entry on the first write, after which edits and deletions work and no same-id route in the legacy section can shadow them.

Both write strategies stay in place and are **chosen by capability, with an automatic switch to the other one and a memory of which works** (self-healing): host upgrades or downgrades, a disabled entry, or a profile patch overridden by a home patch need no configuration change. A "configuration writes" row in the pi-ai bridge tab names the path in use, where providers came from, and any warning that did not clear.

pi-ai updates are triggered two ways: once in the background at plugin startup (throttled to 6 hours, `DSH_PROVIDER_UPDATE=off` disables it) and by the 「检查更新」 button on the provider page (`POST /provider/update`).

Either way, **nothing is replaced before it passes both checks**: the tarball integrity from the registry (`dist.integrity`) and the compatibility check. Only then is the new version marked as pending a restart, and a version you already run is not downloaded again — the manual "check for updates" button compares against the version in use first. pi-ai versions take effect only after a dsh restart, because the bridge is loaded at process start.

A downloaded pi-ai costs around 80 MB, so only versions **newer than the one dsh ships with** are kept: a duplicate at the same version or older is removed after an install, and the npm cache lives in the system temp directory (`<tmpdir>/dsh-llm-provider-npm-cache`) instead of the plugin directory. The "pi-ai bridge" tab shows the current footprint (`vendor/` total plus npm cache) next to a "clean up" button (`POST /provider/prune`) that removes versions that can no longer be selected and the cache; the version in use and any version already downloaded and waiting for a restart are left alone.

### Test instance

```sh
scripts/test-profile.sh        # start the plan-test profile (port 3081) and open a browser
scripts/test-profile.sh stop   # stop it
```

The test instance uses a separate profile, so instances can run side by side: `PORT=3082 PROFILE=plan-test-foo LOG=/tmp/dsh-plan-foo.log scripts/test-profile.sh`. It sets `DSH_PROVIDER_TEST=1`, which makes the browser half append ` · 测试` to the page title and stamp 「测」 on the favicon. The generated profile also links a second local plugin, `dsh-sidekick` (`$DSH_HOME/workspaces/dsh-mobile/plugin`); edit those lines in the script on a machine that doesn't have that checkout.

### Command-line checks

```sh
node lib/adapters/run.js all            # run every quota adapter (keys from env or ~/.dsh/.credentials.yaml)
node lib/adapters/run.js kimi-coding --key sk-xx

npm test                                # build + 13 offline tests; this is what finishing and merging run
npm run typecheck                       # tsc --noEmit (npm test does not include it)
```

The 13 tests cover route discovery, the credential check, the patch layer, the pi-ai compatibility check, directory-link removal (unlinking must not touch the target), the retention rule for pruning old versions, the multi-source merge of model capabilities, provider configuration across both host generations (including self-healing), the provider preset list, the vendor state merge, the OAuth routes (including mounting and degrading the authorization service), the GitHub Copilot quota parsing, and the browser half's wiring. `AGENTS.md` describes the development workflow (no coding on main, everything in a worktree).

## Implementation

### pi-ai bridge

dsh's model catalog comes from the pi-ai version it was built with. The bridge makes it run on a version the plugin maintains:

- The installed `dsh-llm-pi-ai` bundle is copied to `vendor/llm-bridge/`, with a link next to it pointing at `vendor/pi-ai/<version>/`. Node resolves bare specifiers from there, so the copy picks up the newer pi-ai.
- pi-ai's model catalog and wire protocol implementations (`api/*.lazy`, `providers/all`) are lazy imports and all come from the new version; the dsh bundle copy only provides the stable glue.
- The official `llm-pi-ai` entry is disabled in `cordis.patch.yml`; the plugin takes over its settings section, model discovery and catalog.

Which pi-ai gets used is decided by the [compatibility check](#compatibility-check) before anything is loaded. Rolling back needs no link edit: delete the downloaded version and the next start falls back to the next source.

### Candidate sources

`loadBridge()` lists candidates in priority order, checks each one and takes the first that passes:

| Source | Directory | Used when |
|---|---|---|
| Downloaded | `vendor/pi-ai/<version>/` (newest first) | the updater downloaded it and it passed the check |
| Pinned dependency | `vendor/node_modules/@earendil-works/pi-ai` | optional; used when installed (`cd vendor && npm install`) |
| Bundled with dsh | found along the official bundle's `node_modules` chain (no hardcoded path) | neither of the above is installed, or fails the check |

Sources that are not installed are skipped silently. A source is only listed as skipped, with a reason, when it exists but fails the compatibility check. The pi-ai that ships with dsh follows dsh's own release cycle and is not necessarily older than upstream.

A duplicate at the same version never takes the hot-update slot: a downloaded version that is not newer than the best local source (dsh's own copy, the pinned dependency) is ordered after both local sources — it is the same code, so the local copy is reused and the 80 MB duplicate plus a needless restart are avoided. Only a strictly newer version sorts first.

Neither of the last two directories is hardcoded. The official bundle is resolved along the module resolution chain in this order: the profile's `node_modules`, the dsh installation tree (including the `node_modules` nested inside the dsh package), then this plugin. pi-ai is resolved the same way, starting from the bundle that was found. A different dsh layout (bundle inside its own install directory, dependencies hoisted elsewhere) therefore does not make a source disappear.

`vendor/package.json` pins the version of the optional dependency, and the two do not overwrite each other: updates only ever write to `vendor/pi-ai/<new version>/`. Both live under `vendor/` because the bridge copy at `vendor/llm-bridge/` resolves upwards into `vendor/node_modules` first, so choosing that source needs no link.

### Compatibility check

The bridge copy's imports of pi-ai (subpaths and named exports) are extracted from its source, a probe file is generated from them in the plugin's own temporary directory with a link to the candidate, and that file is required. The resolution rules match the copy exactly, but the module URL differs, so one failing candidate does not affect the next and does not pollute the real copy.

The extraction covers named imports and re-exports, dynamic `import()`, side-effect and namespace imports, and `export *`. **Checking before loading is required**: Node keeps a half-initialized record for an ESM file that failed to load, and requiring it again only reports `not yet fully loaded`. There is no "load first and fall back on failure" path.

Candidates that fail the check are listed in `bridge.rejected` from `/provider/status`. When the imports cannot be extracted at all the check cannot run, and the chosen source is accepted on the grounds that its directory exists — that case is reported as `probeUnverified: true`. The updater likewise only replaces a version that passes the check.

### Model selector

Takes over the composer's `conversation.input.model` slot and the `/model` command (the official `ui-model-selection` entry is disabled in `cordis.patch.yml`):

- Interaction matches the official one: trigger pill (`<provider-id>/<model-id>` · reasoning effort) → root panel with 「模型」 and 「推理等级」 rows → model panel → effort panel. Choosing a model or an effort closes the menu.
- Same data path as the official one: the catalog comes from `session/modelCatalog`, switching from `session/selectModel`, quota from `/plan/status`. The official `modelDirectories` client service is used when it is present, and the plugin's own RPC otherwise.
- The current selection is the session's own record when there is one, and the catalog default otherwise. The default effort is the `defaultEffort` the catalog declares; when it declares none, the official `Default` label is shown.
- Switching models **forces a level pick**: choosing a new model no longer closes the menu — it jumps to the effort panel so you confirm a level (with `Default` among the choices; the already-checked level is clickable too — that click *is* the confirmation). The initially selected level is inherited from the previous one: a direct hit on the new model's level table reuses it, otherwise the index is mapped proportionally through interval centres (5-level #3 → 3-level #2). A new model without reasoning metadata shows an empty state with an "OK" button that submits a level-less selection.
- A session recorded before this plugin may name the official `deepseek-official` route, which no longer exists. That selection is mapped to its current route (`deepseek`) for display and quota, and the seat rewrites the session's record once — the host refuses to send a prompt while the recorded provider has no adapter. The rewrite only happens when the target route and model are both in the catalog.
- Extras: provider filter chips with quota dots, cross-provider search (substring, acronym, edit distance), capability badges, context labels, and a model detail card. Details are looked up by `provider + id` (the same model id belongs to several providers and a bare-id index mixes them up); when none of the three sources has an answer no badge is shown, the detail card says the capability is unknown and names the source it did use.
- **Models are filtered by the account's entitlement list.** Pi-ai records which models an account may use in the credential at sign-in (`availableModelIds`); the host exposes it as `availableModels` on `/plan/status` and both the picker and the card filter by it. The static catalog and the entitlement are different things — the Copilot catalog lists 28 models while one account may only use 6, and picking outside the list earns a 400 `model_not_supported`. The currently selected model stays listed even when it falls outside, so it never looks like it vanished.
- The quota indicator on the trigger reads the same snapshot as the provider cards and shows the tightest window's percentage; the card lists every window separately.
- When space runs out, the provider segment is hidden first and the model name is truncated last; effort and quota never shrink. Below a composer width of 760px the provider segment is hidden, below 620px the quota drops to a dot. The pill is capped at `min(560px, 60cqw)`, and the full name is always in its `title`.

### Provider settings page

Adds a 「模型服务」 tab to the settings page (the official `ui-settings-models` entry is disabled), with two sub-tabs: 「服务商」 and 「pi-ai 桥接」.

- Cards follow the official PluginCard: status dot, name, website link, one line of quota summary (`5h: 84% ◷ 3h7m ｜ 7d: 30% ◷ 3d20h`), and refresh time, per-card refresh and delete on the right. The expanded body shows the route configuration (route ID, masked key, credential name, plus the API base URL and protocol — the protocol appears only when the route declares one, while an empty address shows the catalog default endpoint) and that provider's model list with filtering and a detail card.
- Adding a provider: pick a preset → enter key and endpoint (presets that ship an OAuth flow offer a sign-in button instead, writing to the same credential store) → a live test must pass before it is written. Writes go to `llm-pi-ai.providers` via `settings/mutate` and to the credential store via `credentials/set`, the same storage the official page uses. When the route **already exists**, only the fields the form owns are written (`baseURL`, `apiKeyEnv`, and `api` for a custom gateway); hand-written `models`, `compat` and `retryPolicy` are left alone, because a whole-object `set` in dsh-settings replaces the entry.
- Adding a key: when a route exists but has no credential, that row in the card body is an input field (the official Models page is disabled, so this is the only place to enter it). Saving it runs a live quota query immediately. Such providers are labelled 「缺密钥」 in the add-provider list rather than 「已配置」, so they stay selectable.
- Removing: clears the route and the credential. Built-in native routes cannot be removed here. The confirmation is its own row and spells out which route goes, whether the credential goes with it, and that hand-written configuration is not recoverable — the button used to share the ✕ slot, so a double click landed the second click on the freshly rendered "confirm".
- Model list: under 「模型（N）」 in an expanded card, each row can be edited (tick, change fields, replace the whole list, or go back to following the catalog) and saved to `llm-pi-ai.providers.<id>.models`; details and limits are in [Known gaps](#known-gaps).
- The 「pi-ai 桥接」 sub-tab shows the current version and source, skipped candidates with reasons, the disk footprint with a clean-up button, the upstream version and the update button.

### Quota adapters

One file per provider under `src/adapters/`, one registration line in `registry.ts`, the contract in `shared.ts`; `node lib/adapters/run.js` runs them standalone. Every adapter except qwen issues a free GET; none needs a browser session. Most use the provider's API key, while github-copilot uses the GitHub token obtained through OAuth sign-in (OAuth providers have no apiKeyEnv, so the plugin reads it from the credential record).

| Adapter | Data source |
|---|---|
| deepseek | `api.deepseek.com/user/balance` |
| kimi-coding | `api.kimi.com/coding/v1/usages` |
| moonshot | `api.moonshot.cn/v1/users/me/balance` (`.cn` or `.ai`, following the base URL; the catalog default applies when the route declares none) |
| glm | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| minimax | `api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (`.io` on the international site) |
| opencode-go | `opencode.ai/zen/go/v1/usage` |
| zenmux | the `baseURL` itself (`quota_5_hour` / `quota_7_day` in the response; this provider is not in the catalog, so only the user can supply an address) |
| openrouter | `openrouter.ai/api/v1/credits` |
| github-copilot | `api.github.com/copilot_internal/user` (`quota_snapshots` on paid plans, `monthly_quotas` on free; wants the GitHub token, not the api.githubcopilot.com one) |
| qwen | no public endpoint: no request is sent, the card shows a 「看控制台」 link |

Numbers and presentation follow CC Switch ([farion1231/cc-switch](https://github.com/farion1231/cc-switch), a desktop tool that switches provider configs for coding CLIs): the fields it shows, and no others. Plan tier fields are dropped before they reach the browser, and the Kimi top-up balance is not shown because the figure disagrees with CC Switch and looks unreliable.

### Route discovery

Which providers appear in the quota panel and in the preset list comes from two sources:

1. `llm-pi-ai.providers` in `settings.yaml` — the pi-ai routes the user configured.
2. Native adapter routes from `ctx.llm.listConfigurableProviders()` (such as `deepseek-official`): they carry a default `apiKeyEnv` without a settings entry, and that default is not readable through the service, so `routes.ts` matches them against a `NATIVE_ROUTE_DEFAULTS` table.

A display name is the route's own `displayName` when it has one, otherwise the name from the `*Provider()` factory in the pi-ai registry (`pi-ai-names.ts`, cached), otherwise built from the id. Outside that registry only one entry is kept: Custom Gateway. Model IDs and route IDs are always shown as they are, matching the keys in settings.

### Credential check

The host compares keys while resolving them for each provider and warns in the UI when two providers use the same key. dsh itself does not do this, and the configuration UI never sees key values, so elsewhere this mistake only shows up as one provider that keeps failing. Key values are compared in-process and never leave it.

### HTTP endpoints

| Route | Purpose |
|---|---|
| `GET /plan/status` | quota snapshot for every provider (60s cache, `?refresh=1` bypasses it) |
| `GET /provider/status` | bridge status, route table, update status, disk footprint, test-instance flag |
| `POST /provider/update` | trigger one upstream check and update |
| `POST /provider/prune` | remove pi-ai versions that can no longer be selected and the npm cache (the one in use or pending a restart is untouched) |
| `GET /provider/models` | model metadata merged from three sources: `input` declared by the route → the pi-ai catalog → adapter self-report (`listModels`/`resolveModelInfo`, only for providers the catalog does not cover, with per-call and total timeouts). 60s cache (`?fresh=1` bypasses it); used by detail cards and capability badges |
| `GET /provider/presets` | provider presets available for adding (with configured flags) |
| `POST /provider/refresh` | refresh one card's quota (live query, updates the global snapshot) |
| `POST /provider/mutate` | write provider configuration (`merge` / `unset` / `unsetFields`); the host picks the write path for the dsh version and self-heals |
| `POST /provider/remove` | remove a provider (route and credential) |
| `POST /provider/test` | query one provider's quota with the stored key (read-only, does not update the snapshot) |
| `GET /provider/oauth/flows` | list the flows registered on `ctx.authorization` (same source as `preset.oauth` on `/provider/presets`) |
| `POST /provider/oauth/begin` | start one attempt and return its attemptId immediately; the flow runs in the background and pushes events onto the SSE bus |
| `GET /provider/oauth/stream` | SSE stream: `data: {kind:'notice'|'prompt'|'settled',...}`. 404 for an unknown attempt; an already-settled attempt gets its settled frame at once |
| `POST /provider/oauth/respond` | the browser's answer to a prompt, routed to the pending resolver by attemptId + promptId |
| `POST /provider/oauth/cancel` | withdraw an attempt (aborts the local signal and calls `authorization.cancel(key)` so the in-flight slot is released) |

The add-provider form does not call `/provider/test`; it runs the official `llm/discoverModels` draft probe instead.

These are plain routes rather than official Typert Remotes: that generator only understands the monorepo layout (packages under `<root>/packages/`, `@Remote` sources inside registered packages), which does not fit a single-package plugin. That leaves no type-safe call sites, so the offline tests cover the routes.

### Build

```sh
npm run build      # tsdown: host src/*.ts -> lib/*.js (unbundled); browser src/client/index.ts -> lib/client.js (single CJS file with the window.__ModuleLoader__ wrapper)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
```

The host half is translated file by file, and the output paths match the package.json exports. The browser half inlines everything under `src/client/` into one file; the three loader lines are added by the build's banner/footer/intro and are not in the source.

The plugin runs from `lib/`, so a source change without a build runs the old code.

Dependencies are installed with `scripts/install-deps.sh`, not `npm install` directly: `node_modules/@deepseek-ai` is a link into the host profile, and npm would follow it, try to reify the two hundred packages inside and fail. The script moves it aside, installs, and puts it back.

## Boundaries

- **Never writes host configuration.** The dsh installation and credentials are read-only. Writes happen in two places only: the plugin's own `vendor/` (downloaded pi-ai, bridge copy, status files, some of which are written at load time) and explicit user actions in the UI (adding or removing a provider, editing a model list, fixing fields on a card) — and those go through the host's own configuration write path (`settings.mutate` on 0.1.x, `configEditor.edit` on 0.2.x), never by editing files directly. Nothing host-side is written at startup; a legacy `llm-pi-ai` section is only merged into the in-memory view and moves into the plugin entry with the first UI write.
- **Never modifies third-party files.** Not a byte of pi-ai is patched, even when its model data is a static snapshot that lags behind upstream — patching would break the registry integrity check and make installs unreproducible.
- **Never modifies official plugins.** Takeover happens by disabling official entries in `cordis.patch.yml` (`llm-pi-ai`, `llm-deepseek`, `ui-model-selection`, `ui-settings-models`); everything else official is untouched. The plugin's own model seat registers with `priority: -10`, which is what would shadow an official occupant at the same slot.
- **Key values never leave the host process.** The browser half receives conclusions and metadata only (a mask of the first 3 and last 4 characters).
- **No browser session (cookies) is required.** OAuth runs a device-code flow: the plugin hands the verification URL and code to the UI, the human authorises on any device, and the credential stays in dsh's credential store — the browser half never sees a token.
- **The web server has no authentication** (dsh's design; it binds to loopback by default). These routes assume loopback-only reachability: exposing the host on `0.0.0.0` exposes balances and credential names through `/plan/status`. A production Desktop instance additionally requires a token at the host layer (403 without one), while an isolated instance started with `dsh web --port <port> --no-open` has no such layer — measured on the same port, `/plan/status`, `/provider/status` and `/provider/presets` answer 200 without a token, so "loopback only" is a weaker assumption under that startup mode.

## Effect on model requests

The plugin changes neither the system prompt, the tool schemas nor the message content. It decides which models are available, which wire protocol each one uses, and how the reasoning effort setting maps onto request parameters; the last two are implemented per model in pi-ai's wire code, not here.

- With no effort selected (the UI shows `Default`) no `reasoning_effort` is sent. Whether a thinking switch is sent, and with what value, follows pi-ai's implementation for that model.
- With an effort selected, pi-ai maps it for that provider — a `reasoning_effort` field for some, a `budget_tokens` value for providers that bill thinking by budget, adaptive thinking for others.

Quota lookups are separate free HTTP calls and add no tokens to model requests. Switching pi-ai versions swaps the model catalog and the usage figures with it. Switching model or provider changes the request prefix, so KV cache hits start from zero; switching effort within the same model only changes thinking parameters. The plugin does not rewrite session content; its own caches are the 60-second quota and model-metadata snapshots listed above.

## Known gaps

Release cadence: **0.2.x carries fixes only**; the two items marked "0.3.x" are feature work scheduled for 0.3.x.

Honest notes (not verified / not implemented):

- **Multi-endpoint and multi-protocol providers have no live verification.** The decision logic follows the official fallback chain and offline assertions cover it, but no key was available for OpenRouter / Fireworks / opencode / opencode-go / Cloudflare / Bedrock, so no real request was ever sent through them (single-endpoint ones like Copilot and DeepSeek were exercised live).
- **The available-model list is a login-time snapshot.** pi-ai records `availableModelIds` when an OAuth sign-in completes and the model list is filtered by it; entitlement changes (a newly opened model, an upgraded plan) only show up after signing in again.
- **Switching an existing OAuth route back to an API key**: the add form offers both paths, but the card has no "switch back to a key" action — that requires deleting and re-adding the route.
- **The OAuth token field names are pi-ai internals**: the quota adapters read `refresh` / `access` out of the credential record (the Copilot quota endpoint wants the long-lived GitHub token). A rename upstream has to be followed here — the bridge pins the pi-ai version, and the pi-ai health check surfaces upgrades.

Capabilities the official entries have that this plugin does not:

- **Per-model list editing has a generic replacement only (official-style forms scheduled for 0.3.x).** Under 「模型（N）」 in an expanded card there is an "edit list" panel (`src/client/model-editor.ts`): tick the models to expose, or replace the whole list with a custom one, editing `id` / `name` / `contextWindow` / `maxTokens` / `input` (text, image, video) / `reasoningEfforts` / `compat.thinkingFormat` per row and saving back to `llm-pi-ai.providers.<id>.models`. Differences from the official editor: the official one builds per-provider forms from a schema, this is one generic table; in configuration `reasoningEfforts` is a `{level: wire value}` map, written here as text such as `low,high=max` (empty = inherit the installed pi-ai catalog, `false` = no reasoning). Rows are validated before saving (empty ids, duplicates, non-positive integers and unknown levels are refused), because the host parses the list strictly and one bad entry makes the whole route unusable. The panel shows up for `llm-pi-ai` routes only — a native route's models do not live in that settings section — and `input` is written only when the capability was actually resolved or the user touched the checkbox, so saving before the details arrive cannot pin a placeholder `text` over the catalog's vision capability.
- **"Current model not routable" greying.** The official `ui-model-selection` greys out the composer when the current model cannot be routed. With that entry disabled, the input stays active even when the current provider is not configured.
- **Official onboarding.** The DeepSeek onboarding flow of the Models page has no replacement.

Not implemented yet:

- **On 0.2.x the old `llm-pi-ai` section becomes a leftover.** The first UI write migrates its routes into the plugin entry, but the section itself (the `llm-pi-ai` row in the profile patch) cannot be removed — its entry is disabled by this plugin's patch, so the host refuses to write it. It is history from then on; what takes effect is the plugin entry's copy. Cleaning it up means editing the profile patch by hand (`~/.dsh/profiles/<profile>/cordis.patch.yml`).
- **A dead bridge is only reported locally (a global banner is scheduled for 0.3.x).** When every candidate fails (corrupt directory, permissions, an upstream export rename) the plugin falls back to "billing only", the four official entries stay disabled by the patch and the model list goes empty; the only signal is one error row in the "pi-ai bridge" tab (`bridge.active === false`), with nothing near the composer. A global banner would make this obvious at a glance; it is not implemented.

- A sidebar entry and a global quota badge via `shell.overlay`.
- Live usage and failure attribution inside a session (reading usage from `llm/stream` and `session/event`, and quota/rate-limit failure codes from `llm/retry`). Quota data is polled from endpoints, which answers "how much is left on the account", not "what did this request cost and why did it fail".

Out of scope:

- The Kimi console API, which needs a web-session JWT.
- Forking the official plugin sources, or taking on the monorepo layout (which Typert Remote would require).

### OAuth / subscription sign-in

The `dsh-authorization` seam owns the prompt vocabulary, the `AuthInteraction` relay and the commit check; the official `llm-pi-ai` registers a flow for every provider in the pi-ai catalog (key-based, subscription-based, and OAuth-only Codex — the exact split moves with the pi-ai version). Two pieces were missing: **nobody mounted the service**, and there was no browser-side wire.

**Piece one: stock dsh does not mount the authorization service.** The patch layer of both official bundles (`dsh-base`, 86 rows; `dsh-web-app`, 70 rows) mounts `@deepseek-ai/dsh-credentials-local` (the credential store) and not `@deepseek-ai/dsh-authorization`. The latter declares no `dsh.bundle` field, so it cannot be listed as a profile bundle either — doing so makes dsh fail with "declares no dsh.bundle" and the whole profile refuses to start. The consequence: the official `ctx.inject(['authorization'], …)` inside `llm-pi-ai` never fires, `registerPiAiFlows` never runs, and **no OAuth flow exists at all**, so no sign-in entry appears in the UI.

The plugin fills this at startup: `ensureAuthorizationService()` in `src/oauth.ts` resolves the host's own copy of `@deepseek-ai/dsh-authorization` through the host anchors and mounts it with `ctx.plugin()`. Cordis registers services in the root store, so once it is up the official inject fires reactively and registers every catalog provider's sign-in methods — without touching a line of the official plugin. The observed chain is: service absent → inject registered → we mount → callback fires → `registerFlow` succeeds. A missing package, a failed load or an absent `ctx.plugin` all degrade to "no OAuth entry" instead of throwing, because a plugin that fails to load takes the whole dsh process with it. Resolution deliberately uses the host's copy: shipping a second copy inside a third-party plugin would pull in a second cordis runtime and cross-wire service registration.

**Piece two: the browser-side wire.** That is what this plugin adds (`src/oauth.ts`, routes in the HTTP table below):

- A background attempt plus an in-memory event bus (Node `EventEmitter`), aligned with `dsh-authorization`'s "attempts are not persisted" rule — a page refresh drops the attempt rather than leaving half-initialized state.
- The browser talks to the host over SSE (`Content-Type: text/event-stream`); the flow pushes `notice` (message + URL + code), `prompt` (text / secret / select) and the final `settled` frame. A browser that reopens the EventSource reads the closing frame instead of restarting the attempt.
- One attempt per credential key: the seam refuses a second one (`ALREADY_IN_FLIGHT`) and the route answers 409 first.
- Attempts idle for five minutes are swept (no leak after a dropped connection); a settled attempt stays until that TTL so a reconnect still sees the result.
- The client recognises `preset.oauth` in the add-provider form: the button replaces the API-key input, the dialog renders notices and prompts by kind (input or select), and a successful sign-in refreshes the cards through `onAdded`.
- **Protocol and endpoint both belong to the pi-ai catalog, so a route writes neither `api` nor `baseURL`.** The official adapter resolves `const api = request.api ?? base?.api ?? routeApi` and `const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl`, so a route-level value overrides **each model's own**: 6 of the 40 providers are multi-protocol (Copilot: claude models speak `anthropic-messages`, gpt-5.x speaks `openai-responses`, gemini speaks `openai-completions`), and 5 of those also split endpoints by protocol (Fireworks / opencode / opencode-go / OpenRouter / Cloudflare differ by a `/v1`-style suffix — the SDK appends `/v1/messages` itself, so the wrong pick becomes `.../v1/v1/messages`), while Bedrock ships us-east-1 and eu-central-1 side by side. Pinning `anthropic-messages` made `gpt-5.4` answer 400 `no model endpoints available given user constraints`. Leaving the address field empty in the form means "use the catalog default" (shown as its placeholder); type one to override an enterprise endpoint or a gateway with placeholders — an **empty string must not be written**, since `'' ?? x` does not fall back. Billing queries and the card take the endpoint from the catalog (`catalogBaseUrlOf`); an OAuth route's endpoint comes from the credential (`auth.baseUrl` overrides the model's), so the card shows no catalog address for it. The card's warning is decided by the catalog's real protocol set (`apis` in the presets response): a pin on a **multi-protocol** provider is always reported (it must break one batch), a correct pin on a single-protocol one is not — that would only send the user to a pointless fix button — while a single-protocol provider pinned to something the catalog does not use (a hand-typed mistake) is still reported, and the text names both sides. Either case offers the one-click "follow each model's protocol" fix: it unsets `api` **and**, when the route's address is one of the catalog's endpoints, unsets `baseURL` too (older forms wrote the catalog address into the route, which overrides each model's own endpoint just the same) — an address the user typed (an enterprise endpoint) is not in that set and is left alone.
- **"OAuth only" is decided from pi-ai metadata**: read the provider factory's `auth` — `oauth` without `apiKey` means OAuth-only (currently only `openai-codex`), and new ones follow automatically. There is exactly one exception, `github-copilot`: its metadata does offer an `apiKey` path, but that path is a bare "Enter GitHub Copilot token" box, and such a token can only be obtained by signing in to GitHub first, so the UI treats it as OAuth-only (`KEY_PATH_IS_DEAD_END`). An OAuth-only provider keeps the sign-in path only: the "API base URL / protocol / credential name" rows and the "test" button are hidden, and so is the "use an API key instead" switch — that path cannot be completed here (the test button is gone while "add to list" requires a passing test), and for Copilot the token is unobtainable anyway.
- **One provider route picks one credential mechanism, decided by the flow's method id.** Once the authorization seam is mounted every provider has a flow, but the methods mean different things: `oauth` is a real subscription sign-in, while `api-key` is just dsh wrapping "type your key" as a login. So the test is the method id, not "has a flow": DeepSeek / OpenAI / Moonshot expose only `api-key` and keep the plain key input (offering them a "sign in with OAuth" button both misleads and hides the key field), while providers with both (Anthropic, Kimi Coding, OpenRouter, xAI, Radius) default to OAuth with a "use an API key instead" switch beside it — note pi-ai's flow also reports an `api-key` method for Copilot, which the OAuth-only rule above filters out.
- **The two cannot coexist on one route.** pi-ai's precedence is explicit request apiKey > stored credential grant > ambient environment (`auth/resolve.js`; `models.js` says "Explicit request options win per-field"), so a route either carries `apiKeyEnv` (key path) or does not (credential-record path). Writing both means the explicit key silently wins and the OAuth grant becomes dead configuration.
- **A route authorised through OAuth carries no `apiKeyEnv`.** The official adapter's `resolveApiKey` honours that field above everything else and throws `MISSING_CREDENTIAL` when it resolves to nothing, so writing it kills the OAuth path (the failure only shows up when a prompt is sent). Leaving it out lets pi-ai fall back to its own credential resolution and pick up the grant. Routes added by earlier versions still carrying the field get a one-click "use OAuth" fix in the card body (it unsets `apiKeyEnv`).

Boundaries:

- **Attempts are not durable** — a hard limit of `dsh-authorization`: refreshing the page loses the attempt, and an interrupted sign-in has to be redone.
- **Provider-side text prompts** — for example Copilot enterprise's "GitHub Enterprise URL/domain" arrives as `kind: text` and renders as a plain input.
- **A failed OAuth attempt writes no credential** — the commit check requires a write observed during that attempt; failures and cancellations travel as an abort signal and the seam reclaims the in-flight slot itself.

## Source layout

| Path | Purpose |
|---|---|
| `src/index.ts` | host entry: mounts the bridge, registers the HTTP routes |
| `src/bridge.ts` | bridge loading: copy the bundle, pick pi-ai through the check, manage links; `hostPackageEntry()` resolves official packages through the host anchors |
| `src/updater.ts` | upstream updater: check the registry, verify the tarball, install, mark pending, prune old versions and caches, report disk usage |
| `src/routes.ts` | route discovery, website links, display name fallback |
| `src/provider-presets.ts` | preset list for adding a provider (generated from the pi-ai catalog plus Custom Gateway); marks OAuth-only providers |
| `src/oauth.ts` | OAuth sign-in bridge: mounts the `authorization` service the official bundles never mount, and exposes its flows to the browser (5 HTTP routes + SSE) |
| `src/provider-config.ts` | provider configuration layer: multi-source merge and capability-probing, self-healing write strategies for both host generations |
| `src/model-details.ts` | model details and capabilities: read the providers data files of the active pi-ai package, then merge the route's declared `input` and the adapter's self-reported modalities (indexed by `provider + id`) |
| `src/pi-ai-names.ts` | read names from the pi-ai registry (the source of display names) |
| `src/credential-check.ts` | credential check |
| `src/adapters/*.ts` | quota adapters (one file per provider, plus registry and CLI runner) |
| `src/client/*.ts` | browser half: `index` (entry, slot registration) · `model-seat` · `settings` · `model-editor` (model list editor) · `command` · `data` · `format` · `styles` · `i18n` · `icons` · `diag` · `types` |
| `cordis.patch.yml` | bundle patch layer: disable official entries, insert this plugin, declare the DeepSeek route |
| `test/*.mjs` | 13 offline tests (no dsh, no services) |
| `scripts/*.sh` | worktree workflow, test instance, dependency install |
