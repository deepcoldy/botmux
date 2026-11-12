# bots.json 配置

`~/.botmux/bots.json` 是机器人的配置文件。文件是一个数组，每一项是一个 bot；每个 bot 由一个独立的 daemon 进程运行。

只填 `larkAppId` 和 `larkAppSecret` 就能跑起来，其余字段都是可选的，按需再加。

## 怎么改配置

三种方式改的是同一份 `bots.json`，按顺手的来：

| 方式 | 适合 | 生效 |
|------|------|------|
| Dashboard「Bot 配置」页 | 日常调整，推荐 | 多数设置保存即生效，个别项（如 CLI、环境变量）对新会话生效 |
| 飞书里发 `/botconfig set <字段> <值>` | 在群里顺手改一项 | 同上；`/botconfig help` 列出能改的字段，`/botconfig get` 查看当前值 |
| 手动编辑文件 | 批量改、写高级字段 | 改完执行 `botmux restart` |

第一次创建 bot 可以用 `botmux setup`，它会交互式地帮你生成这份文件。

> 配置文件位置：先看 `BOTS_CONFIG` 环境变量指定的路径，没设置时用 `~/.botmux/bots.json`。

本页只讲「每个 bot 自己的设置」。自动更新、空闲清理、会话环境变量的全局层这类整台机器共用的开关在 `~/.botmux/config.json`，见[全局设置](/global-settings)。

![Dashboard「Bot 配置」页：常用 / 会话 / 权限与安全 / 消息卡片 / 高级 五个分类](/img/codex-compatible-runtime-dashboard.png)

## 示例

最小配置：

```json
[
  { "larkAppId": "cli_xxx", "larkAppSecret": "xxx" }
]
```

两个 bot，一个跑 Claude Code、一个跑 Codex：

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "lang": "zh",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"],
    "p2pOpen": true,
    "oncallChats": [{ "chatId": "oc_xxx_oncall", "workingDir": "~/projects/foo" }]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work",
    "autoStartOnNewTopic": true
  }
]
```

## 想做 X → 改哪个字段

| 想做的事 | 字段 |
|------|------|
| 换 CLI / 模型 | `cliId`、`model`、`reasoningEffort` |
| 让 bot 走 GLM 或第三方模型服务商 | `env`（见[接入 GLM / 第三方服务商](#glm-provider)） |
| 新话题直接进某个目录，不弹选仓库卡片 | `defaultWorkingDir` |
| 指定谁是管理员 | `allowedUsers` |
| 让整个群都能和 bot 对话 | `allowedChatGroups` 或 `oncallChats` |
| 任何人都能私聊 bot | `p2pOpen` |
| 拉黑某人 | `blockedUsers` |
| 限制 agent 能读写的文件 | `sandbox`（见[文件沙盒](/sandbox)） |
| 嫌实时卡片吵 | `disableStreamingCard`、`hiddenStreamingCardButtons` |
| bot 给别人用，回复里不带开发机路径和本机地址 | `hideLocalAddresses`（见[隐藏开发机地址](#hide-local-addresses)） |
| 一轮只用一张卡显示进度和答复 | `replyCardMode: "unified"` |
| 不 @ 也自动开工 | `autoStartOnNewTopic`、`autoStartOnGroupJoin` |
| 机器人首次上线后私聊主人一句欢迎语 | `welcomeMessage`（见[上线欢迎语](#welcome-message)） |
| 盯住告警群，有告警就自动处理 | 群消息监听（见[群消息监听](#message-listener)） |
| 额度用完自动交给另一个 bot | `quotaFallbackBot` |
| 不让 botmux 往 prompt 里塞任何东西 | `promptInjection: "none"` |
| 控制会话占用的内存 | `maxLiveWorkers`、`idleSuspendMinutes` |
| 统计花费、超预算提醒 | `pricing`、`budget`（见[花费与预算](#budget)） |
| 会话一直等人处理时提醒 owner | `sessionOwnerReminder`（见[等待提醒与无进展提醒](#reminders)） |
| 用国际版 Lark | `brand: "lark"` |

## 必填

| 字段 | 说明 |
|------|------|
| `larkAppId` | 飞书应用的 App ID |
| `larkAppSecret` | 飞书应用的 App Secret |

可选的 `brand` 说明这个应用属于哪个平台：`feishu`（默认，中国版飞书）或 `lark`（国际版 Lark）。接口地址、授权链接都按它来。`botmux setup` 会自动识别并写入；一个 bot 绑定一个租户，要换平台就重新配一个 bot。

## CLI 与模型

| 字段 | 说明 |
|------|------|
| `name` | 进程名后缀，`claude-main` 对应进程 `botmux-claude-main`；不填时是 `botmux-<序号>` |
| `displayName` | Dashboard 里显示的备注名。只影响 Dashboard 展示，不改飞书里的应用名 |
| `cliId` | 用哪个 CLI，默认 `claude-code`。可选值见[多 CLI 适配器](/adapters)。`gemini` 已下线：还写着 `"gemini"` 的 bot 会拒绝启动，并提示改成 `"antigravity"` |
| `model` | 启动 CLI 用的模型名（比如 `claude --model opus`）；不填就用 CLI 自己的默认值。同一种 CLI 的多个 bot 可以跑不同模型。每次启动或恢复会话时都按当前配置取值，所以改完后，没设群级模型的老会话下次恢复时也会用新模型 |
| `reasoningEffort` | 新会话默认的思考强度，取值 `low` / `medium` / `high` / `xhigh` / `max` / `ultra`。支持的 CLI：Claude Code、Codex、Codex App、TraeX、Grok、Kimi、ZCode、`remote-runner`。会按 CLI 和模型的能力校验，不支持的组合会被忽略。例如 Kimi 只在模型是 `kimi-code/k3` 或 `kimi-code/k3-256k` 时生效，且只有 `low` / `high` / `max` 三档；Claude 的 Haiku 模型不支持思考强度 |
| `groupDefaultModels` | 按群设置新话题的默认模型，目前支持 Codex 和 Claude Code。见下方[群级新话题默认模型](#group-default-models) |
| `serviceTier` | 仅 Codex：新会话的速度档位 `default` / `priority` / `ultrafast`；不填沿用 Codex 自己的配置 |
| `codexProfile` | 仅 Codex：使用的 Codex 配置 profile 名，可在 Dashboard 扫描选择 |
| `modelBackendVariant` | 仅 TraeX：后端变体 `standard` / `max`；不填沿用 TraeX 全局配置 |
| `nativeSubagentRuntime` | 仅 TraeX：TraeX 原生子代理用的模型和思考强度。见下方说明 |
| `wrapperCli` | 启动前缀，比如 `"aiden x claude"`。botmux 会把启动命令拼成 `<wrapperCli> <CLI 参数>`，适合企业网关、ccr 这类启动器。见[多 CLI 适配器](/adapters) |
| `cliRuntime` | Codex 兼容发行版的描述。见下方[Codex 兼容发行版](#codex-runtime) |
| `cliPathOverride` | 旧版的 CLI 可执行文件覆盖，继续兼容。新接入的 Codex 兼容发行版请用 `cliRuntime` |
| `cliConfigDir` | 仅 Claude Code：用 `CLAUDE_CONFIG_DIR=<目录>` 启动，设置、登录态和会话记录都来自这个目录。只影响新会话 |
| `disableCliBypass` | 设为 `true` 时不自动追加 `--yolo`、`--dangerously-*` 这类免审批参数 |
| `promptCache` | 仅 Claude Code：提示缓存的有效期和空闲保活，例如 `{"ttl":"1h","keepalive":{"enabled":true}}`。没写的字段沿用全局设置，默认关闭 |
| `skillInjection` | botmux 自带 skill 怎么交给 CLI：`prompt`（按会话注入）、`global`（装进 CLI 全局 skill 目录）、`off`。不填时跟随全局设置，全局默认是 `prompt`。见 [Skill](/skill-cli) |
| `customPassthroughCommands` | 额外允许透传给 CLI 的斜杠命令，例如 `["/export"]`。会和 botmux 自己命令重名的项会被丢掉。用 `/list-slash-command` 看完整放行清单。见[斜杠命令](/slash-commands) |
| `startupCommands` | 会话启动后、第一条消息之前自动发给 CLI 的命令，例如 `["/effort ultracode"]`。每次新启动或恢复都会重发 |
| `quotaFallbackBot` | CLI 额度用完后自动交接给另一个 bot。默认关闭。见下方[额度用完自动交接](#quota-fallback) |
| `codexCapacityRecovery` | 仅 Codex / Codex App：遇到明确的模型容量错误时自动续跑。默认关闭；每个任务最多追加两条续跑输入。普通限流和额度用完不算 |
| `suppressDeliveredFinalFailureNotice` | 实验性，默认关闭。同一轮已经送达最终答复后，再遇到模型服务错误时不再补发「模型连接失败」通知 |
| `turnTimeoutMs` | 仅 dsh / MiniMax：单轮时长限制（毫秒，正整数），默认不设、不限时。dsh：空闲看门狗，超过这么久没有新事件就结束本轮，另有本值 4 倍的硬上限；MiniMax：单轮总执行时长，模型输出和工具进度不会重置它，等人回复的时间不计入。其它 CLI 忽略这个字段 |
| `codexRpcInput` | 实验性，仅 Codex / TraeX：改用 app-server JSON-RPC 发送输入，而不是往终端里打字。`true` 开、`false` 关，不写时跟随 Dashboard 全局开关。这个模式下不支持 `/stop`（改用 `/close`）和 `/fast`。不能和 `existingAppServer` 一起用 |
| `codexAppCleanInput` | 实验性，仅 Codex App：让 Codex App 里显示的用户消息只保留用户原话。见下方说明 |
| `codexBrowser` | 实验性，仅 Codex App：让会话通过本机的 Codex 浏览器插件控制 Chrome / Edge。见下方说明 |

### 群级新话题默认模型 {#group-default-models}

`groupDefaultModels` 让同一个 bot 在不同群里默认用不同模型：

```json
{
  "groupDefaultModels": {
    "oc_team": { "codex": { "model": "your-codex-model", "reasoningEffort": "high" } }
  }
}
```

更推荐在 Dashboard「群组管理 → 新话题默认模型」里按 Bot 设置，保存后不用重启。

- 新话题创建时记下当时的群模型。之后改群配置只影响新话题，老话题重启、恢复时仍用创建时的模型。
- 每种 CLI 单独记，话题换成另一种 CLI 时不会把 Claude 的模型名传给 Codex。
- 优先级：触发时显式指定的模型 > 新话题记下的群模型 > 同 CLI 的 Bot 模型 > CLI 自己的默认。
- 私聊、普通群里整群共用的会话、外部接管（adopt）的会话不用这个设置。

### TraeX 原生子代理（`nativeSubagentRuntime`）

只影响 TraeX 原生 `spawn_agent` 新建的子代理，不改父代理自己。`model` 和 `reasoningEffort` 两项各自可选：

- 不写某一项：沿用子代理请求里的原值。
- 写成 `{ "mode": "custom", "value": "..." }`：固定用这个值。
- 两项都不写：直接删掉整个字段。`inherit` 不是有效模式。

切换到其它 CLI 时会自动删除这个字段。

### 额度用完自动交接 {#quota-fallback}

`quotaFallbackBot` 让 daemon 在当前 CLI 确认额度用完时，在原会话里真实 `@` 一个备用 Bot 接手。它不会再调用已经没额度的主模型，也不改原有的额度提示卡片。

![Dashboard「Bot 配置 → 高级」中的额度耗尽交接配置](/img/quota-fallback-dashboard.png)

```json
{
  "quotaFallbackBot": {
    "enabled": true,
    "targetAppId": "cli_xxx_backup",
    "kinds": ["usage", "rate"],
    "message": "主 Bot 当前额度已耗尽，请接手本会话并结合上下文继续处理。"
  }
}
```

| 字段 | 说明 |
|------|------|
| `enabled` | 只有 `true` 才开启 |
| `targetAppId` | 备用 Bot 的飞书 App ID（`cli_` 开头）。不要填 `ou_xxx`，open_id 只对签发它的应用有效 |
| `kinds` | `usage`（用量上限）、`rate`（速率限制），不填两种都处理 |
| `message` | 交接时说的话，不填用上面示例里的默认文案；最多 1000 字，不能包含 `<at>` 标签 |

几点要知道：

- 备用 Bot 必须是本机配置过、而且当前就在这个群里的 Bot。其它机器上的 Bot、自己、不在群里的 Bot 都会被跳过。
- 普通群会话交接到原群，话题会话交接到原话题；备用 Bot 自己读历史来接上下文。
- 同一个源 Bot、同一种额度类型，5 分钟内只交接一次。daemon 重启时不会补发之前的交接。
- 保存时会检查交接链，拒绝自己交给自己，也拒绝 `A → B → C → A` 这样的环。手改文件引入了环时，`botmux start/restart` 会跳过环里的 Bot，其余照常启动；Dashboard 会标出这些没启动的 Bot，可以直接在「高级 → 额度耗尽交接」里修好。

![Dashboard 标记因交接环路而未启动的 Bot，并直接打开高级修复入口](/img/quota-fallback-cycle-recovery-dashboard.png)

### Codex 兼容发行版 {#codex-runtime}

有些 CLI 是 Codex 的独立发行版：参数、交互、会话恢复和登录方式都和 Codex 一样，只是二进制和版本线不同。这类 CLI 不需要新的 `cliId`，保留 `cliId: "codex"`，再用 `cliRuntime` 说明它是谁：

```json
{
  "cliId": "codex",
  "cliPathOverride": "vendor-codex",
  "cliRuntime": {
    "id": "vendor-codex",
    "displayName": "Vendor Codex",
    "executable": "vendor-codex",
    "update": { "provider": "npm", "packageName": "@vendor/codex" }
  }
}
```

更省事的做法是在 Dashboard「Bot 配置 → 常用 → Agent 配置」里选「自定义兼容版」，填好后保存（就是本页开头那张截图）。

| 字段 | 说明 |
|------|------|
| `id` | 稳定身份，只能用字母、数字、`.`、`_`、`-`，最长 64 字符。改名等于换了一个发行版 |
| `executable` | 可执行文件名或路径，不是 shell 命令，不要在里面拼参数。Dashboard 保存时会跑一次 `--version`，输出里要有 `X.Y.Z` 格式的版本号 |
| `displayName` | 卡片、状态、Dashboard 上显示的名字，不填用 `id` |
| `update.provider` | `auto`：只信任能确切对应到这个二进制的 npm 包，找不到来源就标记「未托管」，不会拿官方 Codex 的版本来比；`self`：用 CLI 自报的版本信息；`npm`：必须同时填 `packageName`；`none`：不检查更新 |

注意：

- `cliRuntime` 目前只支持 `cliId: "codex"`，不能和 `wrapperCli` 一起用。
- 手写配置时要同时写一个和 `executable` 完全相同的 `cliPathOverride`（如上例）。这是给旧版 botmux 降级用的；缺了或不一致会直接校验失败。Dashboard 保存时会自动写好。
- 只有 `cliPathOverride` 的老配置照常能用。Dashboard 会把它显示为只读兼容状态，可以迁移到「自定义兼容版」。
- 会话创建时会记住当时用的发行版。只改模型只影响新会话；切换 CLI、发行版或 wrapper 时，botmux 会关掉还在用旧启动方式的活跃会话，避免它们之后恢复到错误的二进制上。

### 接入 GLM / 第三方服务商 {#glm-provider}

想让一个 bot 跑 GLM Coding Plan（或其它 Anthropic 兼容服务商），另一个 bot 继续跑官方 Claude，给前者配 `env`：

```json
{
  "cliId": "claude-code",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM Coding Plan key"
  }
}
```

- GLM 国内站把地址换成 `https://open.bigmodel.cn/api/anthropic`。
- Codex 这类 OpenAI 协议的 CLI，填 `OPENAI_BASE_URL` / `OPENAI_API_KEY`。
- 每个 bot 的 `env` 只注入到它自己的会话，不会串到别的 bot。
- 值是明文存在 `bots.json` 和进程环境里的，不是密钥保险箱。飞书里查配置会打码，Dashboard 默认打码，只有本机 owner 能点开看原文。
- 改完对新会话生效。

更多环境变量的玩法（全局层、去掉某个变量、严格继承）见下方[会话环境变量](#session-env)。

### Codex App 纯净输入（实验性）

默认情况下，botmux 会把发言人、附件路径等上下文和用户原话拼在一起发给 Codex App，所以 App 里看到的用户消息比较杂。开启 `codexAppCleanInput` 后，App 里的用户消息只保留原话，上下文改走隐藏的 `additionalContext`。

```text
/botconfig set codexAppCleanInput on
/botconfig set codexAppCleanInput off
```

或写进配置：

```json
{ "cliId": "codex-app", "codexAppCleanInput": true }
```

- 只对 botmux 管理、实际跑 `codex-app` 的会话生效；`/adopt` 接管的外部会话不受影响。
- 需要 Codex CLI `>= 0.135`；版本太旧或识别不出时，自动用原来的拼接方式。
- 如果 Codex App 明确拒绝这些实验字段，botmux 会用原来的方式重试一次，并在这次运行期间关掉纯净模式。网络、超时等普通错误不会自动重试，避免重复执行。
- 从下一条派发给 Codex 的消息开始生效，不改写已经排队或正在执行的消息，也不改历史。
- 这只是让 App 里看起来整洁，不是隐私擦除：上下文仍可能留在原始会话记录里。

### Codex App 浏览器桥接（实验性）

botmux 用 app-server 协议运行 Codex 时，拿不到 Codex App 内置的 Chrome 工具。`codexBrowser` 补上这一块：开启后，新会话可以通过本机已安装的 Codex 浏览器插件操作 Chrome / Edge。可以在 Dashboard「Bot 配置 → 高级 → Codex App」里开关。

```json
{ "cliId": "codex-app", "codexBrowser": true }
```

完整写法：

```json
{ "codexBrowser": { "enabled": true, "family": "chrome", "autoApproveOrigins": true } }
```

| 字段 | 说明 |
|------|------|
| `family` | `chrome` 或 `edge` |
| `pluginRoot` | 自定义插件目录（绝对路径），填了就只用这一份。一般不用填，默认在 `CODEX_HOME`（或 `~/.codex`）的官方插件缓存和 Codex / ChatGPT 桌面端自带的插件里，选版本最新且文件完整的一份 |
| `autoApproveOrigins` | 访问 HTTP/HTTPS 站点时不再逐站弹授权卡。默认关闭；登录凭据、上传下载、浏览历史和完整开发者工具不在自动授权范围内，也不会写入「始终允许」 |

使用前提和边界：

- 同一个系统用户的 Chrome / Edge 里要装好并启用 Codex 浏览器扩展，还要装 Codex 桌面端附带的浏览器运行时。运行时装在非默认位置时，用环境变量 `BOTMUX_CODEX_NODE_REPL_PATH` 指定。
- 站点访问、上传、下载等需要确认的操作会变成飞书授权卡，只有能和 bot 对话的人能点「本会话允许 / 始终允许 / 拒绝」。拒绝、超时或 daemon 不可达都按拒绝处理。
- 工具不开放任意 JavaScript、raw CDP、cookie、local storage、浏览历史或剪贴板。需要输入密码的安全登录流程不会降级成普通飞书卡片。
- 已经在跑的会话要重启或重新恢复才会加载新的工具。
- 不能和 `existingAppServer`、`sandbox`、`readIsolation` 一起用，冲突时启动直接报错。

## 工作目录

| 字段 | 说明 |
|------|------|
| `workingDir` | 默认工作目录，可以用逗号分隔多个。botmux 从这里往下找 git 仓库（最多 3 层），不往上找 |
| `workingDirs` | 数组写法，如 `["~/a", "~/b"]`；写了它就优先于 `workingDir` |
| `defaultWorkingDir` | 新话题直接进这个目录，跳过选仓库卡片（有 oncall 绑定或同群其它 bot 已在某目录工作时除外）。中途仍可用 `/cd` 切换 |
| `defaultWorkingDirAutoWorktree` | 配合 `defaultWorkingDir`（须是 git 仓库）：每个新会话先基于远端默认分支建一个独立 worktree 再启动。建失败时直接用 `defaultWorkingDir` |
| `botToBotSameDir` | 默认开启：被 @ 进一个已经有其它 bot 在工作的话题时，沿用对方的目录，不再弹选仓库卡片。设 `false` 关闭 |

## 会话与运行

| 字段 | 说明 |
|------|------|
| `backendType` | 会话后端：`tmux`（默认）、`zellij`（≥ 0.44）、`herdr`、`zmx`、`pty`。tmux 这类持久后端在本机不可用时，会弹卡提示安装，不会悄悄降级成 pty。`pty` 只在显式指定时使用，daemon 重启后会话不保留。见 [tmux 后端](/tmux)、[ZMX 后端](/zmx) |
| `launchShell` | 启动 CLI 用的 shell，覆盖 daemon 的 `$SHELL`。填 `zsh` / `bash` / `fish` / `sh` 或绝对路径。用在登录 shell 的 rc 文件里有 `exec zsh` 之类跳转、导致会话起不来（终端里出现 `parse error`）的情况。指定后，PATH、nvm 等要写在所选 shell 的 rc 文件里（fish 是 `~/.config/fish/config.fish`）。对 tmux / zellij / zmx 的新会话生效 |
| `lang` | 界面语言 `zh` / `en`；不填时看 `BOTMUX_LANG` / `LANG` 环境变量 |
| `p2pMode` | 私聊模式：`chat`（默认，一个连续会话）、`thread`（每条私聊消息开一个独立会话）、`group`（每条私聊消息自动建一个专属会话群）。见[群聊模式](/group) |
| `regularGroupReplyMode` | 普通群 @bot 后的默认回复形态：`chat-topic`（默认，群里顶层 @ 共用一个连续会话，群里开的原生话题各自是独立会话）、`chat`（整群共用一个会话，原生话题也并进这个会话）、`new-topic`（每次 @ 开一个话题）、`shared`（回复进话题但共用一个会话）。单个群可用 `/reply-mode` 覆盖。见[斜杠命令](/slash-commands) |
| `regularGroupMentionMode` | 什么时候必须 @ 才回：`always`（默认）、`topic`、`never`、`ambient`。单个群可用 `/mention-mode` 覆盖。见 [@ 策略](/mention-mode) |
| `maxLiveWorkers` | 同时常驻的会话数上限，默认 30。超过后最久没用的会话自动休眠（结束后台进程回收内存，下条消息再恢复） |
| `idleSuspendMinutes` | 会话连续空闲多少分钟后自动休眠。默认不设，即空闲不超时 |
| `env` | 注入到这个 bot 会话的环境变量 `{ "KEY": "值" }`。见上方[接入 GLM / 第三方服务商](#glm-provider)和下方[会话环境变量](#session-env) |
| `envUnset` | 在这个 bot 的会话里去掉的继承变量名，如 `["HTTPS_PROXY"]`。`PATH` / `HOME` 和 botmux 保留变量不能去掉 |
| `envPolicy` | 进程环境继承策略，默认继承宿主环境；`strict` 只保留基础变量和你列出的名字。见下方[严格进程环境继承](#strict-env) |
| `sessionOwnerReminder` | 话题会话一直停在「等人处理」的状态时，定时在话题里 @ 会话 owner。默认关闭。见下方说明 |
| `noProgressNotify` | 一轮任务长时间没有可确认的新进展时，在飞书里提醒。Codex App 默认开启、90 秒；Codex CLI 要显式开启。见下方说明 |

### 等待提醒与无进展提醒 {#reminders}

**`longTaskReminder`**：任务实际执行超过指定时长仍未结束时，在原群聊或话题发送独立提醒卡片。Dashboard「Bot 配置 → 消息卡片 → 长任务卡片提醒」提供开关和保存按钮，保存后立即生效。

```json
{
  "longTaskReminder": {
    "enabled": true,
    "thresholdMinutes": 10,
    "intervalMinutes": 10
  }
}
```

- 默认关闭；首次提醒阈值和后续间隔分别默认 10 分钟，均支持 1–10080 的整数分钟。
- 从 CLI 实际接收任务并开始执行的时间计时，排队和空闲时间不计入；后续消息和正常进度不会重置已运行任务的计时。
- 每 30 秒检查一次；首次达到阈值后提醒，之后从上次成功投递起按间隔提醒，不补发错过的周期。发送失败一分钟后重试，同一未确认通知复用投递 ID。
- 任务完成、取消、worker 停止或会话关闭后停止提醒。每轮任务独立计时；支持普通群、私聊和话题，文档评论和无 IM 会话不发送。
- 保持静默任务、会议驱动任务和已抑制执行轮次的辅助卡片限制；提醒不会触发普通回答的 `outbound.send` hook。
- 偏好会持久保存，执行计时只使用当前存活 worker 的真实观测，不从旧会话或历史日志猜测。daemon 重启后，没有重新观测到执行开始的旧任务不会提醒。

**`sessionOwnerReminder`**：会话停在某个需要人处理的状态、而且一直没变化时，每隔一段时间在原话题里 @ 一次会话 owner。

```json
{
  "sessionOwnerReminder": {
    "enabled": true,
    "intervalMinutes": 30,
    "text": "该会话已等待处理，请继续跟进。",
    "states": ["idle", "dormant", "pending_repo", "tui_prompt", "agent_attention", "limited"]
  }
}
```

| 字段 | 说明 |
|------|------|
| `enabled` | 是否开启，默认关闭 |
| `intervalMinutes` | 提醒间隔（分钟），默认 30，范围 1–10080 |
| `text` | 提醒文字，最多 500 字，不能包含 `<at>` 标签 |
| `states` | 哪些状态要提醒：`idle`（CLI 空闲）、`dormant`（会话已休眠）、`pending_repo`（等选仓库）、`tui_prompt`（等终端里的选项）、`agent_attention`（agent 请求人处理）、`limited`（额度受限）。开启时至少选一个 |

- 只对按话题划分的会话生效（话题群、普通群里的话题、`p2pMode: "thread"` 的私聊）；整群或整个私聊共用一个会话时不提醒。会话要有 owner。
- 状态一直不变时，每隔 `intervalMinutes` 提醒一次；状态变化或会话里有新消息时重新计时。
- 手写时四个字段都要写全，缺一个或写错都会当作未配置（也就是关闭）。

**`noProgressNotify`**：一轮任务长时间没有可确认的新进展时，发一条提醒卡片。它只是提醒，不会重启、中断或重试任务。

| 字段 | 说明 |
|------|------|
| `enabled` | 默认 `true`。设 `false` 只关掉飞书提醒，Dashboard 上的卡住状态和 `session.requires_attention` [Hook](/hooks) 照常有 |
| `cliEnabled` | 仅 Codex CLI：设 `true` 才开启提醒，默认关闭。开启后先在 `timeoutMs`（默认 5 分钟）提醒一次，到 15 分钟（或 `timeoutMs` 的 3 倍，取大的）再提醒一次 |
| `timeoutMs` | 第一次提醒的阈值（毫秒），整数，范围 10000–3600000。Codex App 默认 90000（90 秒） |

- Codex App 不用配就默认开启；Codex CLI 要写 `{"cliEnabled": true}`。其它 CLI 不受影响。
- `timeoutMs` 从下一个 worker 进程起生效。会话在等人回复（问答卡、终端选项、agent 请求处理）时，Codex CLI 的提醒会暂停计时。

## 权限与授权

完整的权限模型见[权限与授权](/permissions)。

| 字段 | 说明 |
|------|------|
| `allowedUsers` | 管理员名单，能执行管理命令、点卡片按钮。推荐写完整邮箱、手机号或 `on_xxx`；`ou_xxx` 只对签发它的那个应用有效，不能从别的 bot 复制过来。配了 `allowedChatGroups` 时至少要有一个管理员 |
| `ownerOpenId` | 显式指定主管理员 `ou_xxx`。只有它仍在 `allowedUsers` 里时才算数；不填时取 `allowedUsers` 里第一个人 |
| `allowedChatGroups` | 可对话的群（`oc_xxx`）。群里任何人都能和 bot 对话，管理操作仍只认 `allowedUsers` |
| `p2pOpen` | `true` 时飞书应用可用范围内的任何人都能私聊 bot（只能对话）。群聊不受影响 |
| `oncallChats` | oncall 绑定：`[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`。见 [oncall](/oncall) |
| `defaultOncall` | 新群里第一个新话题自动绑定 oncall：`{ "enabled": true, "workingDir": "~/foo", "since": <毫秒时间戳> }`。`since` 之前就有的老群不受影响 |
| `blockedUsers` | 黑名单（写法同 `allowedUsers`）。群聊、私聊都拦，优先于所有放行规则；被拦的人不会触发授权申请卡。管理员不能被拉黑 |
| `globalGrants` / `chatGrants` | 单人对话授权（全局 / 按群）。一般由 `/grant` 卡片写入，存在授权库里，见下方[授权库](#grant-store) |
| `messageQuota` | `{ "defaultLimit": N }`：授权卡放进来的访客默认能发几条消息，不配时是 3 条。oncall 群不限额；`/grant @用户 N` 总是用 N |
| `grantDefaultDurationMs` | 新授权卡的默认有效期（毫秒），不配时是 1 小时 |
| `restrictGrantCommands` | `true` 时，只靠单人授权放进来的人不能用任何斜杠命令，只能普通对话 |
| `canTalkDaemonCommands` | 把列出的 botmux 命令（如 `/status`）放开给「能对话」的人用，默认这些命令只有管理员能用。见[斜杠命令](/slash-commands) |
| `autoGrantRequestCards` | 默认开启：没权限的人 @ bot 时，自动给管理员发授权申请卡。设 `false` 改为静默忽略 |
| `grantRequestToOwnerDm` | 默认关闭。设 `true` 后，会话里没有能点申请卡的管理员时（比如管理员不在群里，或私聊被挡），申请卡改发到主管理员私聊 |
| `trustSameOwnerBots` | 默认开启：本机上管理员相同的其它 bot 可以执行管理命令，它 @ 本 bot 时点名的人自动获得本群对话授权。设 `false` 后同机 bot 只能对话 |
| `grantDelegateBots` | 额外信任的外部 bot 名单（`ou_` 或 `cli_`）。名单里的 bot @ 本 bot 时，同一条消息里被点名的人自动获得本群对话授权（只能对话）。默认为空 |
| `acceptSlashFromBots` | 默认开启：接受其它 bot 通过 `botmux send --slash` 发来的斜杠命令。设 `false` 后这类消息当普通文字处理。不影响真人 |
| `allowArbitraryMention` | 默认关闭。开启后模型可以用 `botmux send --mention` @ 群里任意成员（会核对对方确实在群里），而不只是本轮发消息的人 |
| `autoInviteOwnerOnGroupAdd` | 默认开启：bot 被拉进新群时，自动把主管理员也拉进来。告警平台批量拉群这类场景可以设 `false` |

## 文件沙盒与凭据

详细说明见[文件沙盒](/sandbox)。

| 字段 | 说明 |
|------|------|
| `sandbox` | `"oncall"`（或 `true`）：白名单隔离，agent 只能读写项目目录和自己的家目录；`"scratch"`：一次性草稿，能读整台机器，但所有写入都丢到临时层；`false` / `"off"`：不隔离 |
| `sandboxPaths` | 白名单隔离下额外放行的路径：`{ "readWrite": [...], "readOnly": [...], "deny": [...] }`。旧字段 `sandboxHidePaths`、`sandboxReadonlyPaths` 仍能读，启动时自动迁移过来 |
| `scratchStorage` | 仅 `scratch`：`"tmpfs"`（默认，放内存，重启即清空）或 `"disk"`（放磁盘，daemon 重启后能续跑） |
| `scratchTmpfsSizeMb` | 仅 `scratch` + tmpfs：容量上限（MB），默认 `0` 表示用内核默认值（约一半内存） |
| `scratchDenyPaths` | 仅 `scratch`：额外遮住的路径。botmux 自己的凭证总是遮住的 |
| `sandboxNetwork` | 默认 `true` 保留网络；`false` 断开普通网络出口 |
| `sandboxNetworkPolicy` | 按公网 / 内网分别过滤目标 IP 的高级网络策略 |
| `credentialsSourceDir` | 沙盒 bot 每次启动时从这个目录复制 CLI 登录凭证，而不是用本机共享的登录。适合一台机器多个账号 |
| `codexAuthSync` | Codex 登录策略：`shared`（默认）沿用全局登录；`isolated` 始终用这个 bot 自己的 `CODEX_HOME`，不读也不复制全局凭证 |
| `triggerUserAuth` | 默认关闭。开启后，会话里的 `lark-cli` 等工具以「发这条消息的人」自己的授权调用；没授权的人会收到授权链接 |
| `larkToolBinding` | 默认开启：会话里的 `lark-cli` 默认用当前 bot 的应用身份调用，可用 `--as user`、`--profile` 切换。设 `false` 完全不注入 bot 凭据 |

> ZMX 后端没法执行文件沙盒，开着沙盒的配置组合会直接拒绝启动，见 [ZMX 后端](/zmx)。

### 受保护的本地 MCP 能力

本地 stdio MCP 服务可以在插件私有的 `mcp/index.json` 中申请一个可选受保护能力。能力 ID 对 Botmux 是不透明数据；通用说明使用非业务 fixture：

```json
{
  "transport": "stdio",
  "command": ["node", "./mcp/server.js"],
  "protectedCapability": "fixture.secret.v1"
}
```

Streamable HTTP MCP 服务不能申请 `protectedCapability`，同时声明两者的插件描述会被拒绝。插件描述不提供密钥来源、主体策略或隔离规则；这些绑定只来自机器级配置。

在 `bots.json` 中，`plugins` 数组只负责为当前 Bot 启用已安装插件：

```json
{
  "plugins": ["fixture-plugin"]
}
```

不要在 `bots.json` 中保存受保护能力绑定、密钥来源、密钥值或灰度状态。运维人员在机器级 `~/.botmux/config.json` 中绑定不透明能力 ID：

```json
{
  "protectedMcpCapabilities": {
    "fixture.secret.v1": {
      "enabled": false,
      "allowedPluginIds": ["fixture-plugin"],
      "secret": {
        "source": "file",
        "path": ".botmux/secrets/fixture-protected-secret"
      },
      "principal": "verified-human-email",
      "containmentProfile": "local-stdio-secret-v1",
      "isolation": {
        "protectedHomePaths": [".fixture-credential"],
        "redactEnv": ["FIXTURE_AUTH_TOKEN"]
      }
    }
  }
}
```

省略 `enabled` 时默认关闭，JSON 布尔值 `true` 启用绑定，布尔值 `false` 关闭绑定。字符串 `"true"`、数字 `1` 等非布尔值会使整条能力记录被拒绝。secret 只支持 `{ "source": "file", "path": "<Home 相对路径>" }`；路径以 daemon 账户的可信 Home 为根，不接受绝对路径、`.`、`..` 或软链。运维人员预先创建当前用户拥有、精确权限为 `0600` 的非空普通文件，文件大小最多 64 KiB。Botmux 不会修复不安全文件，也不会在 daemon 启动时捕获或缓存密钥；每次新 worker fork 前现读文件，并逐级固定目录 fd 后以 no-follow 打开，拒绝中间路径或叶子的软链及替换竞态重定向。

密钥只经一次性 fd 通道提供给获准 MCP，不进入 argv、通用环境或日志。文件轮换对下一次 worker fork 生效，已运行 MCP 保留本次启动获得的密钥，需重建该会话才能更新。每个有效配置的 secret 文件自动加入所有相关会话的沙箱 deny，即使 Bot 未启用匹配插件或能力关闭；额外 `protectedHomePaths` 仍按匹配插件生效。`redactEnv` 以及无效旧 `source: "env"` 记录中可辨识的合法变量名会按当前配置从 worker、模型和插件通用环境清除；旧环境来源不会授权写能力。修改机器配置沿用全局配置的短缓存刷新规则。

MCP 进程启动时，如果能力已关闭或未 provision、插件不在 `allowedPluginIds` 中、配置的隔离前提不满足，或 daemon 无法提供一次性通道，Botmux 会改用不带受保护密钥文件描述符的普通 stdio transport 启动服务。服务仍可启动并提供只读工具；该连接上的 `tools/call` 不会收到 `botmuxTrustedPrincipal` 或 `botmuxGrantedCapabilities`，插件必须对受保护写入失败关闭。

`principal` 是每次 `tools/call` 的授权条件，不是 MCP 进程启动条件。如果全局绑定、插件 allowlist、隔离前提和 daemon 通道在启动时均已成功，长驻 MCP 进程可能已持有一次性密钥，即使后续某次调用缺少所需的已验证真人主体或其它调用级授权条件。Botmux 会在该次调用中省略 `botmuxTrustedPrincipal` 和 `botmuxGrantedCapabilities`，插件必须拒绝受保护写入。插件必须在**每一次**受保护写操作中重新校验 `botmuxTrustedPrincipal` 以及 `botmuxGrantedCapabilities` 是否包含当前能力 ID，不得把上一轮主体、能力或授权结果缓存到进程级状态后复用；任一字段缺失、不匹配或过期都必须失败关闭。只要匹配的插件已启用，即使能力本身关闭，配置的隔离路径和环境变量清理仍然生效。

迁移旧环境密钥时，先把密钥写入上述安全文件并将配置改为 `source: "file"`，再从 daemon 启动源移除旧变量并重启 daemon；仅 `delete process.env` 不能擦除旧进程的 `/proc/<pid>/environ`。新增或改变密钥文件路径前，须先结束并重建旧 CLI 会话，使新的文件 deny 生效；不要仅靠热更新撤回旧进程访问。建议固定路径后以安全文件原子替换轮换。存在受保护文件或其它需隔离的身份配置时，裸宿主 one-shot 自动标题生成会跳过并保留占位标题，不影响会话正文的读取能力。

同一个 stdio MCP 子进程重启后，一次性密钥通道目前不会再次交付，受保护工具会退回只读；需重建会话恢复。不同出站策略收集入口的用户错误提示尚待统一。

### 按触发人身份调用 CLI（`triggerUserAuth`） {#trigger-user-auth}

**默认关闭。** 打开后，这个 Bot 会话里的 `lark-cli` / `bytedcli` 用「发这条消息的人」自己的授权调用，而不是本机的登录态。适合多人共用一个 Bot：谁发的消息，就以谁的身份读文档、查日程、调内部平台。

三种开法任选一种，**新会话生效**（已有会话 `/restart` 后生效）：

- **Dashboard**：「Bot 配置 → 权限与安全 → 按触发人鉴权」，打开「按触发人身份调用 CLI」，勾选要覆盖的工具。
- **飞书里**（管理员）：`/botconfig set triggerUserAuth {"enabled":true,"tools":["lark-cli","bytedcli"]}`；关闭用 `/botconfig unset triggerUserAuth`。
- **bots.json**：

```json
"triggerUserAuth": { "enabled": true, "tools": ["lark-cli", "bytedcli"] }
```

规则：

- 只有 `enabled` 写成 `true` 才算开。`tools` 不写表示覆盖全部工具；写了不认识的工具名会直接报错，不会悄悄降级。
- 没授权过的人调用时，命令会被拒绝，拒绝信息里附带授权链接。AI 也会自己用 `botmux auth request` 把链接发给这个人（见 [Agent 自助发起授权](/cli-commands#agent-auth-request)），或者让他在话题里发 `/login`。授权完成后重试即可。
- 绝不会退回到 Bot 或其他人的身份代跑。`bytedcli` 没有 Bot 身份，没授权就是失败。
- 可选字段：`credentialSource`（`auto` 默认 / `platform` 只用[中心化平台](/platform) / `local` 只用本机扫码）、`delegateOnMention`（默认 `true`，见 [@ 交接带上发起人身份](/permissions#delegate-on-mention)）、`gitHost`（让该代码平台的 git 推送也按当轮身份鉴权）。

#### 升级注意：旧格式授权要重新 `/login` {#legacy-user-token}

v3.20 起，botmux 自己保存的飞书用户授权按「应用 + 授权人」分文件存（`~/.botmux/data/user-token-<appId>-<openId>.json`）。之前的旧文件（`user-token-<appId>.json`、`user-token.json`）看不出是谁授权的，凡是需要「以某个具体的人」调用飞书接口的地方都不再使用它。

只剩旧格式授权的 Bot，这些用户身份能力会失效。**由本人在话题里重新发一次 `/login`** 即可恢复。注意 `/login` 只是补上授权文件，按触发人身份调用 CLI 仍要按上面的方法单独打开。

## 卡片与终端

卡片长什么样、每个开关的效果见[实时流式卡片](/cards)。

| 字段 | 说明 |
|------|------|
| `replyCardMode` | `legacy`（默认）：进度和答复分开发；`unified`：同一轮的进度、工具调用和最终答复都更新在一张卡里。支持未开沙盒的 Claude Code / Codex / Grok / TraeX / Pi / Kimi 普通会话，从下一轮生效 |
| `replyCardShowTools` | 仅 `unified`：设 `false` 隐藏卡里的工具调用，思考摘要和进度照常显示 |
| `disableStreamingCard` | `true` 时不发实时终端状态卡。Web 终端照常运行，最终答复照常发送 |
| `hiddenStreamingCardButtons` | 隐藏实时卡上的按钮，可选 `output`、`terminal`、`writeLink`、`compact`、`stop`、`close`。例如 `["terminal", "writeLink", "close"]`。也可用 `/botconfig set hiddenStreamingCardButtons terminal,close` |
| `pinStreamingCard` | `true` 时自动置顶当前的实时状态卡，默认关闭。置顶失败不影响其它功能。单个群可以用 `/card pin off` 关掉 |
| `cotEnabled` | 默认开启：用飞书原生「思考过程」消息实时展示模型的思考和工具调用。单个群可用 `/cot off` 关掉 |
| `usageDisplay` | Context / Token 用量显示在哪：`streaming`（默认，实时卡正文）、`footer`（答复卡页脚）、`off`（不显示）。只影响显示，不影响用量统计。旧字段 `showUsageInCardFooter: false` 等同 `off` |
| `cardFooterExtension` | 在用量后面追加几段自定义文字，内容来自你配置的命令：`{"command": "<命令>", "refreshSeconds": 60}`。命令交给 `/bin/sh -c` 执行，每个 bot 跑一份；`refreshSeconds` 默认 60，范围 10–3600。输出按行（或 `{"segments": [...]}`）取最多 4 段，每段最多 40 字。命令超过 3 秒算失败，失败时沿用上次结果，连续 10 分钟没成功就不显示。见[实时流式卡片](/cards) |
| `brandLabel` | 卡片底部签名。不填显示默认的 `botmux` 链接；`""` 隐藏；其它文字原样显示（支持 markdown）。Dashboard「全局设置 → 飞书卡片」里的总开关关掉时，所有 bot 都不显示签名 |
| `replyCardActions` | 普通答复卡上显示一个紧凑的操作菜单（打开终端 / 切换模型 / 关闭会话）。默认关闭 |
| `askOptionLayout` | `botmux ask` 选项按钮的排布：`compact`（默认，自动换行）或 `vertical`（每行一个，长选项更好读） |
| `writableTerminalLinkInCard` | `true` 时卡片里直接放可写终端链接（看得到卡片的人都能操作终端）。默认藏在「获取写权限」按钮后面，只私发给点击的人 |
| `privateCard` | `true` 时 `/card` 只发给管理员可见的私有卡片，只在普通群有效，且不会实时刷新 |
| `silentTurnReactions` | `true` 时，关了实时卡的会话不再给消息贴「冲!」/ ✅ 表情 |
| `receivedReactionEmoji` / `doneReactionEmoji` | 换掉「已收到」/「已完成」表情（飞书 emoji_type），默认 `GoGoGo` / `DONE`。把两者设成一样，可以避免 CLI 提前判定空闲时过早出现 ✅ |
| `feedback` | 在最终答复卡上收集「结论可用 / 有效推进 / 结论有误」反馈，默认关闭。见下方[最终答复反馈](#feedback) |

Dashboard 的「Bot 配置 → 消息卡片 → 实时卡片按钮」可以直接勾选要显示的按钮：

![实时卡片按钮配置](/img/streaming-card-button-settings.png)

### 答复卡页脚

页脚是答复卡底部那一行小字：签名、模型、用量、发送给谁、语音按钮等。每一块都能单独开关，可以在 Dashboard「Bot 配置 → 消息卡片」里设置，也可以用 `/botconfig set <字段> on|off`。

![Dashboard 中的回复卡片页脚设置](/img/reply-footer-settings.png)

| 字段 | 默认 | 控制什么 |
| --- | --- | --- |
| `replyFooterEnabled` | 开 | 整个页脚（含分隔线和语音按钮）的总开关 |
| `replyFooterBrand` | 开 | 品牌签名，仍受 `brandLabel` 和全局签名开关约束 |
| `replyFooterModel` | 开 | 模型名、思考强度和后端规格 |
| `replyFooterUsage` | 开 | 页脚里的用量，只在 `usageDisplay: "footer"` 时显示 |
| `replyFooterRecipients` | 开 | 「发送给」以及对应的 @ 通知；正文里的 @ 不受影响 |
| `replyFooterVoice` | 开 | 配了语音服务时的「语音总结」按钮 |
| `showReplyTiming` | 关 | 等待和执行耗时；缺少可靠计时时不显示 |

- 关掉总开关不会清空各项设置，重新打开后恢复原样。所有块都关了或没内容时，整个页脚和分隔线都会省略。
- 修改对之后的新答复生效，已发出的卡片不变。手改 `bots.json` 后要重启 daemon。

### 最终答复反馈 {#feedback}

`feedback.enabled: true` 后，最终答复卡上会出现三个按钮（默认是「结论可用 / 有效推进 / 结论有误」），对应三种固定含义 `positive / progress / negative`。按钮文字、样式、顺序、点「有误」后的原因选项和说明框都能自定义。

```json
{
  "feedback": {
    "enabled": true,
    "visibleSemantics": ["positive", "progress", "negative"],
    "buttons": [
      { "key": "conclusive_usable", "label": "结论可用", "semantic": "positive", "style": "primary" },
      { "key": "effective_progress", "label": "有效推进", "semantic": "progress", "style": "default" },
      { "key": "incorrect", "label": "结论有误", "semantic": "negative", "style": "danger" }
    ],
    "negativeFollowup": {
      "reasons": [{ "key": "wrong_result", "label": "结论或结果错误" }],
      "comment": { "enabled": true, "required": false, "maxLength": 1000 }
    }
  }
}
```

可以在 Dashboard「Bot 配置 → 消息卡片 → 最终回答反馈」里可视化编辑，或用 `/botconfig set feedback '<json>'`。反馈数据默认存在本机的 `botmux-feedback.sqlite`，Dashboard「反馈分析」页可以查看；想换成 PostgreSQL 或迁移数据，见[反馈数据存储与迁移](/feedback-storage)。实现细节见 [`docs/feedback-capability-current-implementation.md`](https://github.com/deepcoldy/botmux/blob/master/docs/feedback-capability-current-implementation.md)。

## 回复投递与 Prompt 注入

| 字段 | 说明 |
|------|------|
| `replyDelivery` | 最终答复怎么送到飞书。`send`（除 Doubao 外所有 CLI 的默认）：模型自己执行 `botmux send`；`transcript`：botmux 从 CLI 的会话记录里自动取本轮最后的回答发出去。见下方说明 |
| `senderTag` | 默认开启：每条转给 CLI 的消息都带一个 `<sender ... />` 标签，告诉模型是谁在说话。只有写 `false` 才关闭 |
| `senderTagHideEmail` | 默认关闭。开启后 `<sender>` 标签里不带邮箱，姓名和 ID 保留 |
| `hideLocalAddresses` | 默认关闭：模型回复原样发到飞书。开启后把开发机路径和本机服务地址挡在回复外。见下方[隐藏开发机地址](#hide-local-addresses) |
| `promptInjection` | `"default"`（默认）或 `"none"`。`none` 是零注入模式：botmux 不加任何系统提示和提醒，只传任务原文和附件，并自动回传最终答复。见下方说明 |
| `envelopeInjection` | 仅 Claude Code：`auto` 时把每轮的提醒内容改由 hook 注入，终端输入框里只剩消息本身；默认 `off` 保持原样 |
| `topicUnavailablePolicy` | 原话题被删除或不可用时怎么办。见[原话题不可用策略](/topic-unavailable-policy) |
| `turnResults` | 提供每一轮的结构化结果，供外部系统读取。见[单轮结果](/turn-results) |

### 转写回复（`replyDelivery: "transcript"`）

Doubao 默认就是 `transcript`（它的工具命令跑在账号级常驻进程里，模型自己 `botmux send` 容易发错话题，详见[多 CLI 适配器](/adapters)）。其它 CLI 默认 `send`，模型要自己执行 `botmux send` 才能把答复发到飞书。改成 `transcript` 后，botmux 自动从 CLI 的会话记录里取本轮最后一段回答发出去，模型直接作答就行。

开启后有三个变化：

1. 系统提示里不再教模型用 `botmux send`。确实需要发附件、跨 bot @ 时，模型可以通过内置的 `botmux-send` skill 自己找到用法。
2. 每轮不再附带 `<botmux_reminder>` 提醒。
3. 私聊，或只有管理员和这个 bot 的 1 对 1 群里，消息不再包 `<user_message>` 壳和 `<sender/>` 标签，模型看到的就是原文。

支持的 CLI：Claude Code、Codex、TraeX、CoCo、Hermes、MTR、Pi、Oh My Pi、ebsd、Grok、Cursor、Doubao。Antigravity 只在零注入模式下采集回答，显式设置会被拒绝；如果写好后又把 CLI 换成不支持的，运行时自动回到 `send`，不会丢答复。Cursor 和 Doubao 在 `sandbox: "scratch"` 下不支持 transcript（设置被拒，默认值运行时回到 `send`）；oncall 沙盒不受影响。

```text
/botconfig set replyDelivery transcript   # 开启
/botconfig set replyDelivery send         # 显式用回 botmux send（Doubao 不推荐）
/botconfig unset replyDelivery            # 回到默认
```

- 每轮的提醒和外壳从下一轮起变化；系统提示是会话启动时定的，已经在跑的会话要 `/restart` 才换。
- 代价：1 对 1 会话没有了 `<user_message>` / `<sender>` 结构，`/adopt` 不再把它认作 botmux 自己的会话。
- Dashboard 里「转写回复模式」开关改的就是这个字段，当前 CLI 不支持时开关是灰的。

### 关掉发言人标签（`senderTag: false`）

关掉后模型就不知道是谁在说话了：多人会话里分不清发言人，也没法按人称呼。适合会把标签内容抄进回复的 CLI，或不想把每条消息的身份写进 CLI 记录的场景。

```text
/botconfig set senderTag off
/botconfig set senderTag on
```

- 从下一轮生效，不改已排队的消息和历史。
- `botmux send --mention-back`（@ 回本轮发消息的人）不受影响，它用的是 daemon 自己记录的触发人。
- 代价：Dashboard 的会话洞察没法再从标签判断发言人类型，`/adopt` 识别 botmux 会话时少了一条线索。
- Dashboard 里「发言人标签」开关改的就是这个字段。

### 隐藏开发机地址（`hideLocalAddresses`） {#hide-local-addresses}

飞书用户在自己的客户端里看回复，打不开开发机上的文件和本机服务。bot 给别人用时可以打开这个开关；只给自己用、需要在回复里看到排障路径的保持默认关闭。

```text
/botconfig set hideLocalAddresses on
/botconfig set hideLocalAddresses off
```

默认关闭时，回复和卡片原样发出，提示里也不加相关规则。开启后：

- 模型的回复（`botmux send`、自动转发的最终答复、动态单卡、思考过程消息、文档评论回复）发到飞书前，开发机上的绝对路径、`file://` 这类本地协议和本机服务地址会被替换：工作目录里的源码换成仓库相对路径，其它换成「【内部文件】」；技能链接只保留名称。`/dev/null`、`/proc` 这类不指向用户文件的系统路径保留。
- 系统提示里加一条完整规则（每个会话一次），每轮提醒里加一句，要求模型不放这类地址，文件改用附件或真实可访问的链接。
- 卡片按钮或链接指向本机地址时整条拒发，模型会收到 `LOCAL_ADDRESS_OUTBOUND_REJECTED`；botmux 自己生成的 Web 终端、Dashboard 链接照常发送。
- 回复处理和每轮提醒立即生效；系统提示里的完整规则从下一个新会话起生效。
- Dashboard「Bot 配置 → 消息卡片 → 开发机地址」里的开关改的就是这个字段。

### 零注入模式（`promptInjection: "none"`）

适合「主 bot 派活、子 bot 专心执行」的多 Agent 流水线，或者你就是不想让 botmux 往 prompt 里加任何东西。

开启方式：

1. Dashboard：「Bot 配置 → 高级」里开启「零注入」。
2. `bots.json`：在对应 bot 上写 `"promptInjection": "none"`；改回 `"default"` 或删掉字段就恢复。

开启后：

- **只传任务原文和附件**：不加 botmux 的系统提示、每轮提醒、身份信息、角色、白板、记忆和技能目录。CLI 自己的系统提示和项目里的 `AGENTS.md` 照常由 CLI 处理。
- **自动回传答复**：从 CLI 的会话记录里取最终答复发回飞书，默认 @ 本轮发任务的人；答复里点名群里其它 bot（如 `@Reviewer`）会自动换成真正的飞书 @。
- **支持的 CLI**：Claude Code、Codex、TraeX、CoCo、Hermes、MTR、Pi、Oh My Pi、ebsd、Grok、Cursor、Doubao、Antigravity。后端限本机的 tmux / pty / zellij / herdr / zmx（Antigravity 不支持 zmx）；Cursor、Antigravity 不支持 `scratch` 沙盒。暂不支持远端后端和 v3 工作流。

技术细节见 [`docs/zero-prompt-injection.md`](https://github.com/deepcoldy/botmux/blob/master/docs/zero-prompt-injection.md)。

## 主动开工

默认 bot 只在被 @ 时才开工。下面这些字段让它主动一点，都可以在 Dashboard「Bot 配置 → 常用 → 默认工作目录」下的「主动开工」里设置。

| 字段 | 说明 |
|------|------|
| `autoStartOnNewTopic` | `true` 时，话题群里每个新话题的第一条消息不用 @ 也自动开工（普通群无效） |
| `autoStartOnGroupJoin` | `true` 时，bot 被拉进一个有管理员在的新群就自动开工。需要在飞书开放平台给应用订阅 `im.chat.member.bot.added_v1` 事件 |
| `autoStartOnGroupJoinPrompt` | 入群自动开工时的第一轮任务。不填时，bot 会先看看群里的上下文；没人派活就报告自己已就绪 |
| `autoStartOnGroupJoinSeed` | 入群时先发的那条开场消息的文字，不填用内置文案 |
| `autoStartOnGroupJoinGateRequired` | `true` 时，入群自动开工还必须有一条匹配的 `chat.bot_added` 同步 [Hook](/hooks) 明确放行，否则静默不开工。适合只让特定的群自动开工 |
| `autoStartOnGroupJoinAnchor` | 普通群里入群会话挂在哪。默认 `"reply-mode"`，跟随群的回复模式；`"latest-message"` 时不发开场消息，直接在群里最新一条已有消息（跳过系统消息、已撤回消息和本 bot 自己的消息）的话题里开会话，适合外部平台先发一条上下文消息再拉 bot 的群。没有可用消息或读取失败时按默认处理。话题群和 `new-topic` 模式不受影响。若要锚定其他机器人发的消息（如平台卡片），还需授权 `im:message.group_msg.include_bot:read`，否则列表里只有用户消息 |
| `autoStartExcludedChats` | 这些群里不自动开工（入群和新话题都算），被 @ 时照常响应 |
| `groupJoinCommandEnabled` / `groupJoinCommand` | 被拉进任意群时，直接在本机执行一条命令，不起会话、不经过模型。和 `autoStartOnGroupJoin` 互不影响，也不要求群里有管理员。同样需要订阅 `im.chat.member.bot.added_v1` |

`groupJoinCommand` 的执行方式和 [Hooks](/hooks) 一样：

- 不经过 shell，要用管道、重定向就写成 `bash -c '…'`；只带最少的环境变量（不含应用密钥）。
- stdin 收到 JSON：`{event:"chat.bot_added", larkAppId, chatId, operatorOpenId, emittedAt}`；也可以读环境变量 `BOTMUX_JOIN_CHAT_ID` / `BOTMUX_JOIN_LARK_APP_ID` / `BOTMUX_JOIN_OPERATOR_OPEN_ID`。
- 10 分钟没结束会被强制结束。

### 上线欢迎语（`welcomeMessage`） {#welcome-message}

填一段文字，机器人首次成功上线后会私聊主管理员（见 `ownerOpenId`）一次。用 `botmux setup add` / `botmux setup edit` 的 `--welcome-message "…"` 或 `--welcome-message-file <文件>` 设置，edit 传 `--welcome-message -` 清空；Dashboard 里暂时不能改。`--welcome-message` 的值始终按原文发送，以 `@` 开头也不会当成文件路径。

- 发送记录在 daemon 数据目录的 `welcome-sent/<AppID>.json`，发过之后重启不再发，改欢迎语内容也不会重发。删掉这个文件可以让它重发，但距上次发送不到 1 小时的会被飞书去重。
- 发送失败、还解析不到主管理员时不影响启动，下次启动重试。
- core-only（`apiOnly`）bot 和多副本部署（`BOTMUX_COORDINATION_MODE=primary`，各副本不共享发送记录）不发送，daemon 日志里会写明原因。

## 群消息监听 {#message-listener}

让 bot 盯住群里的消息：符合条件的消息不用 @ 也会自动拉起一个会话去处理。典型用途是**告警处理**：监控系统本来就有自己的机器人往群里发告警，把 bot 拉进这个群、开启监听，每条告警都会自动开工排查，不用另外接 [Webhook](/webhook)。

推荐在 Dashboard「消息监听」页配置：

- **全局监听设置**：一套规则，默认应用到这个 bot 加入的所有群，以后新加入的群也自动生效。
- **群聊监听设置**：每个群可以选「使用全局设置」「关闭消息监听」或「自定义消息设置」。
- 可以**预览**最近 24 小时会命中哪些消息，也可以**试运行**（会在群里真实回复）。

对应 `bots.json` 里的两个字段：

| 字段 | 说明 |
|------|------|
| `globalMessageListener` | 全局规则，内容是下面的监听配置 |
| `groupMessageListenerOverrides` | 按群的例外，键是 `chat_id`。值为 `{ "mode": "disabled" }`（这个群不监听）或 `{ "mode": "custom", "listener": { ...监听配置 } }`（这个群用自己的规则） |

旧字段 `messageListeners`（键为 `chat_id`）仍能读，会被当作按群的自定义规则。

一条监听配置包括：

| 字段 | 说明 |
|------|------|
| `enabled` | 是否启用。启用时 `prompt` 必填 |
| `prompt` | 告诉 bot 哪些消息要处理、怎么回复 |
| `name` | 监听名称（可选），在 Dashboard 里显示 |
| `replyCardTitle` | 回复卡片标题（可选） |
| `workingDir` | 拉起的会话用哪个目录（可选），不填用 bot 默认目录 |
| `replyPolicy.mode` | `thread`（默认）：在命中消息下面开话题回复；`chat`：直接回在群里 |
| `autoCloseAfterCompletion` | `true` 时任务成功完成后自动关闭这个会话 |
| `senderPolicy.mode` | `all_except_excluded`（默认）：处理所有发送者，只排除指定的人；`include_only`：只处理 `includeSenderOpenIds` 里的人 |
| `senderPolicy.includeSenderTypes` | 监听哪类发送者：`["user"]`、`["bot"]` 或两者都要。**监听告警机器人一定要包含 `"bot"`** |
| `senderPolicy.includeSenderOpenIds` / `excludeSenderOpenIds` | 按 `open_id` 精确指定要 / 不要的发送者 |
| `senderPolicy.excludeSelf` | 默认 `true`，总是忽略 bot 自己发的消息，防止自己触发自己 |
| `messagePolicy.includeMsgTypes` | 监听哪些消息类型，默认文本和富文本（`post`） |
| `contentPolicy.includeKeywords` | 关键词过滤，不区分大小写的子串匹配 |
| `contentPolicy.includeMentionedOpenIds` | 按消息里真实 @ 了谁来匹配（`ou_xxx`，本应用视角的 open_id） |
| `contentPolicy.matchMode` | `any`（默认）任一条件命中即可；`all` 要求全部命中 |
| `contentPolicy.resolveDocumentTitles` | 默认 `false`。关键词没命中时，再用 bot 身份查一下消息里飞书文档链接的**标题**来匹配（不读正文） |

```json
{
  "globalMessageListener": {
    "enabled": true,
    "name": "告警监听",
    "prompt": "群里每条告警都是线上事件。定位受影响服务、给出初步排查方向；确认是误报就说明理由。",
    "senderPolicy": { "mode": "all_except_excluded", "includeSenderTypes": ["bot"] }
  },
  "groupMessageListenerOverrides": {
    "oc_xxx_chat": { "mode": "disabled" }
  }
}
```

要知道的几点：

- **只看群里的顶层消息**：已有话题里的回复不处理；直接 @ bot 的消息走普通 @ 流程，不会重复触发。
- **每条命中的消息各拉起一个会话**。
- **最长约 30 秒延迟**：飞书会实时推送一部分消息；其它机器人发的、以及没 @ bot 的消息，靠每 30 秒一次的历史轮询补上。所以监听第三方告警机器人时，用默认的 `all_except_excluded` + 包含 `"bot"` 最稳：历史接口里第三方机器人可能拿不到 `open_id`，按 `open_id` 精确匹配会漏。
- **按文档标题匹配**：只支持 HTTPS 的 `docx` / `wiki` 链接。需要应用开通并发布 `drive:drive.metadata:readonly`（读文档标题）和 `wiki:node:read`（或 `wiki:wiki:readonly`）权限。没权限或 bot 看不到这篇文档时，只按消息原文判断。

## 总结命令

| 字段 | 说明 |
|------|------|
| `summaryRange` | `@机器人 /summary` 读多少历史。`limit`：普通群最近 N 条，默认 50；`sinceHours`：普通群最近 N 小时，默认 24。设 `0` 表示这一项不限。话题群总是读当前话题 |
| `summaryMemory` | 默认关闭。开启后，`/summary` 会把总结整理成「问题解决记录」追加到记忆文件里；之后的会话遇到关键条件完全一致的问题时，可以直接复用之前的结论 |
| `summaryMemoryPath` | 记忆文件路径，默认 `summary.md`。相对路径按当前项目根目录算 |

```json
{
  "summaryRange": { "limit": 50, "sinceHours": 24 },
  "summaryMemory": true,
  "summaryMemoryPath": "docs/summary.md"
}
```

- 只有显式 `@机器人 /summary` 才会总结，不会因为关键词自动触发。Dashboard 的「/summary 总结范围」改的就是这几个字段。
- 如果之前有过一次 `@同一机器人 /summary`，这次只总结上次之后的消息。
- 开启 `summaryMemory` 时，`/summary` 后面跟的文字会被当作起点：从最近一条包含这段文字的消息开始总结；找不到就报错，不会退回更大的范围。这种显式起点可以比 `sinceHours` 更早，不想读到太旧的内容就别带起点文字。没开 `summaryMemory` 时，后面的文字只是告诉模型总结的侧重点。
- 开着沙盒、而记忆文件又在工作目录外时，要把它**已存在的父目录**加进 `sandboxPaths.readWrite`，否则写入会被沙盒拦下。

> `contentTriggers`（旧版关键词 / 正则免 @ 触发）已经不再生效，只为兼容旧文件保留解析。新配置请用 `summaryRange`。

## 花费与预算 {#budget}

botmux 可以按 token 用量估算每个 bot 的花费（人民币），并在月度花费越过预算线时私信提醒。

```json
{
  "pricing": {
    "usdCny": 7.2,
    "models": {
      "my-gateway-model": { "input": 3, "output": 15, "cacheRead": 0.3 }
    }
  },
  "budget": {
    "monthlyCny": 500,
    "alertThresholdPercent": [50, 80, 100]
  }
}
```

**`pricing`：怎么算钱**

| 字段 | 说明 |
|------|------|
| `usdCny` | 美元兑人民币汇率，默认 7.2 |
| `models` | 自己补充或覆盖的模型单价，键是模型名或模型族前缀（如 `claude-sonnet-4`）。值的单位是**美元 / 百万 token**：`input`、`output` 必填，`cacheRead`、`cacheWrite` 可选，不填时按 `input` 价算 |

- 只有配了 `pricing` 才会算钱，写 `{ "usdCny": 7.2 }` 就能用内置价格表（Claude、GPT、Gemini 常见模型）。
- 内置表和 `models` 里都找不到的模型不计价，不会猜一个价格。
- 统计从开启后开始累加，不回溯以前的用量。

**`budget`：月度预算**

| 字段 | 说明 |
|------|------|
| `monthlyCny` | 每月预算（元），必须是正数，不填或填错时整个预算功能关闭 |
| `alertThresholdPercent` | 提醒线（百分比），默认 `[80]`。每条线每月最多提醒一次；一次越过多条线时只发一条，按最高的那条 |
| `hardStop` | 默认 `false`。设 `true` 目前只是额外加一条 100% 提醒线，**不会拦截新任务**，超支后要自己暂停会话 |

- 提醒私信发给 `ownerOpenId` 指定的主管理员；没配 `ownerOpenId` 时只写日志。
- 按自然月（UTC）统计，每月 1 日重置。
- 预算依赖 `pricing` 算出的金额：没配 `pricing` 时花费一直是 0，不会触发提醒。

## 语音

| 字段 | 说明 |
|------|------|
| `voice` | 这个 bot 的语音引擎配置，会按字段覆盖 `~/.botmux/config.json` 里的全局 `voice`。有可用的语音凭据时，答复卡上会出现「🔊 语音总结」按钮。见[语音总结](/voice) |

## 飞书会议智能体 {#vc-meeting-agent}

连着飞书的 Bot **默认就能被拉进视频会议**（core-only 的 `apiOnly` Bot 除外），旁听会议、同步转写，按会议角色在会中发文字或说话。

**准备**：应用要开通 `vc:meeting.bot.join:write`（入会 / 离会）、`vc:meeting.meetingevent:read`（读会中事件）、`vc:meeting.message:write`（会中发文字），实时语音另需 `vc:meeting.bot.realtime:write`；事件订阅里要有 `vc.bot.meeting_invited_v1`、`vc.bot.meeting_activity_v1`、`vc.bot.meeting_ended_v1`、`vc.meeting.participant_meeting_joined_v1`。权限缺了，daemon 启动时会在日志里报错并私聊通知管理员；事件订阅飞书没有接口可查，daemon 只会提醒你核对，缺事件时只是收不到会议推送、不会报错。

**怎么用**：

1. 在飞书视频会议里邀请这个 Bot 入会。
2. Bot 私聊给 owner（配了 `vcMeetingAgent.attentionTargetOpenId` 时发给这个人）发一张确认卡，默认 30 分钟内有效（`inviteTtlMs` 可调）。
3. 确认后 Bot 入会，自动建一个会议监听群同步转写；想用现有群就配 `vcMeetingAgent.listenerChatId`。
4. 会中做什么由会议角色决定，见下一节。会议监听期间要临时让某人能给 Bot 下指令，用 `/vc-auth @成员`（`/vc-auth revoke @成员` 撤销，`/vc-auth list` 查看）。
5. 想提前准备：在普通群发 `/vc prepare <会议链接或会议号>`，把这个群设成会议准备群，可以先补背景、预读文档，开会后复用同一个 Agent 会话（见[斜杠命令](/slash-commands)）。

**会中发言**：

- 文字和语音默认**直接发出，不逐条审批**。想逐条审批，在 `vcMeetingAgent.meetingConsumer` 里把 `textOutputPolicy` / `voiceOutputPolicy` 设成 `approval`；设成 `deny` 则禁止。
- 实时语音默认开着，但只在 Bot 真要说话时才建连；关掉用 `vcMeetingAgent.realtimeVoice.enabled: false`。说话还需要上面的实时权限和会中的 AI 发言权限，缺了会明确报错、不会发出声音。
- 语音用[语音总结](/voice)里配置的引擎合成（MiniMax、火山引擎 / 豆包等）。

**关闭**：

- 单个 Bot：`bots.json` 里写 `"vcMeetingAgent": { "enabled": false }`，或在「全局设置 → 会议 Agent → 会议监听 → 会议角色预设 → 按 Bot 的会议开关」里关掉这个 Bot 的「接收会议事件」。
- 整台机器：Dashboard「全局设置 → 会议 Agent → 会议监听」关掉「允许本机使用会议监听能力」（`config.json` 的 `vcMeetingAgent.enabled: false`）。已经在开的会通常会自然结束。

## 会议角色

bot 被拉进飞书视频会议后，可以按「会议角色」去做事，比如同步重要信息、记纪要、主持。推荐在 Dashboard「全局设置 → 会议角色预设」里管理：

- 预设由所有 bot 共享：谁被拉进会议，就由谁执行选中的角色，预设里不用指定执行的 bot。
- 内置模板：会议重要信息同步、会议纪要与行动项、会议主持、方案评审与风险挑战、访谈与需求洞察。点「使用此模板」会复制一份可以随意修改的预设，之后模板更新不会改到你的副本。
- 「按 Bot 的会议开关」里可以给每个 bot 关掉会议事件、挑一个默认角色。

角色里有两个独立的输出设置：

| 设置 | 取值 |
|------|------|
| `responseMode` | `silent`：自动输出不发到群里；`listener_thread`：可以发到会议监听群（需要 `listener.output.request` 能力） |
| `listenerDelivery.placement` | `auto`（默认）：沿用当前会话的群 / 话题；`chat`：每次都发成群里的顶层消息；`topic`：第一条发成固定话题，之后都回复在这个话题里 |

`listener_thread` 模式下，由 Agent 自己判断现在有没有值得发的新内容，botmux 只把它决定发布的正文发到飞书；格式异常时不发。

也可以在单个 bot 的 `vcMeetingAgent.meetingConsumer.consumerProfiles` 里手写角色，写了就不再用共享预设。手写时需要用 `agentAppId` 指明由哪个 bot 执行：

```json
{
  "id": "important-sync",
  "agentAppId": "cli_your_agent_app_id",
  "label": "会议重要信息同步",
  "role": "important-information-sync",
  "instructions": "持续监听会议，只发布对群内协作者有实际价值的新信息：已确认的结论或决定、状态变化、明确阻塞或风险、需要群内人员知晓或行动的事项。忽略讨论过程、重复表述和未经确认的猜测。每次只发布相对上次的新内容。",
  "filter": { "activityTypes": ["transcript_received", "chat_received"] },
  "responseMode": "listener_thread",
  "listenerDelivery": { "placement": "topic" },
  "capabilities": ["listener.output.request", "meeting.read"]
}
```

把角色 id 加进 `defaultConsumerIds`、`defaultMode` 设为 `agents`，开会时就默认启用；否则可以在会中弹出的选择卡片里手动启用。

## 会话环境变量（全局 / Bot 两层） {#session-env}

![Dashboard 会话环境变量示意](/img/session-env-dashboard.png)

会话拿到的环境变量按这个顺序一层层叠上去，后面的覆盖前面的：

| 顺序 | 层 | 存在哪 | 说明 |
| --- | --- | --- | --- |
| 1 | 继承基线 | — | daemon 自己的进程环境，先去掉敏感项（飞书应用凭证、`GITHUB_TOKEN` 等）并按 `envPolicy` 过滤 |
| 2 | 全局层 | `~/.botmux/config.json` 的 `sessionEnv: { "set": {…}, "unset": […] }` | 对所有 bot 生效 |
| 3 | Bot 层 | 本 bot 的 `env`（设置）和 `envUnset`（去掉） | 覆盖全局层 |
| 4 | botmux 保留 | 固定名单 | `BOTMUX*`、`LARK_APP_*`、`SESSION_DATA_DIR`、`TMPDIR` / `TMP` / `TEMP` 等，最后注入，哪一层都改不了 |

**在 Dashboard 里管理**：全局层在「全局设置 → 会话环境变量」，Bot 层在「Bot 配置 → 高级 → 启动环境 → 会话环境变量」。表格列出变量名、生效值和来源（宿主继承 / 全局 / 本 Bot），可以设置、覆盖、去掉、恢复继承，也能批量粘贴。默认只列本层改过的变量，继承来的收成一行「继承 N 条，展开」。凭据类的值默认打码，只有本机 owner 能点开看原文。

**生效时机**：改完对新会话生效，不用重启 daemon。正在跑的会话保留启动时的环境，页面会列出「仍在使用旧环境」的会话，重启这些会话即可。想看某个运行中会话实际拿到的环境，在会话抽屉里点「更多 → 查看会话环境」（只读、打码，仅 Linux）。

规则：

- 每一层里，一个变量要么「设置」要么「去掉」。「恢复继承」就是删掉本层的条目，值回落到下一层。
- `PATH`、`HOME` 可以覆盖，不能去掉。
- 每一层的「设置」和「去掉」加起来不超过 4 KB（tmux 单条命令有长度上限）。超出时保存会被拒绝；已经超出的老配置，往小了改总是允许的。
- 对 tmux / zellij / zmx 会话，「去掉」在会话启动的最后一步执行，所以 tmux server 全局环境和 shell 启动文件带进来的同名变量也会被去掉。
- 开着 lark-cli 应用绑定时，`ZDOTDIR` / `BASH_ENV` 由 botmux 接管；开着按触发人鉴权时，`GIT_ASKPASS` / `GIT_CONFIG_*` 也由它接管，这些变量在这个 bot 上不能设置或去掉。
- 老配置不用迁移：`env` 就是 Bot 层的「设置」；没写 `envUnset` / `sessionEnv` 时一切和以前一样。
- riff / mojo 后端的会话不在本机运行，只会带上本 bot 的 `env`，全局层和「去掉」对它们不生效。
- CLI 自己配置文件里的 env（例如 Claude 的 `~/.claude/settings.json`）由 CLI 启动后自己注入，不受「去掉」影响。

**tmux server 的全局环境**：tmux server 启动时会冻结一份全局环境，之后新建的窗格都会继承它。「全局设置 → 会话环境变量」下方会列出默认 server 和托管会话专用的 `tmux -L botmux` server。本机 owner 可以把某个变量从 server 全局环境里移除（要二次确认），只影响之后新建的窗格；想长期去掉，还是用上面的「去掉」。

### 严格进程环境继承（需显式开启） {#strict-env}

默认（不写 `envPolicy`，或写 `{ "mode": "inherit" }`）会继承宿主环境，只过滤掉已知的敏感项。严格模式只放行一份精确的变量名白名单：

```json
{
  "envPolicy": {
    "mode": "strict",
    "inherit": ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "TOOLCHAIN_ROOT"]
  },
  "env": { "OPENAI_API_KEY": "<本 bot 的模型凭证>" }
}
```

| 层 | 规则 |
| --- | --- |
| 系统基线 | `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、临时目录、locale、终端和 XDG 路径等，完整列表见 `src/core/env-policy.ts` |
| 额外继承 | `inherit` 里只能写精确的变量名，不支持通配符。代理、CA、工具链、模型认证要在这里列出，或写进本 bot 的 `env` |
| 本 bot 注入 | `env` 覆盖同名的继承值，只进这个 bot 的会话 |
| 内部身份 | botmux 最后注入会话、owner 等内部变量；`BOTMUX*`、`__OWNER_OPEN_ID`、`CODEX_HOME` 等不能通过 `env` 或 `inherit` 伪造 |

`TRAE_HOME`、`CLI_EXTRA_ARGS` 这类适配器变量在严格模式下也不会自动继承，需要的话要在 `inherit` 里列出或写进 `env`。

怎么设置：

- Dashboard：「Bot 配置 → 高级 → 启动环境 → 会话环境变量」上方的「继承宿主环境」。
- 命令行：`botmux env-policy set '{"mode":"strict","inherit":["HTTPS_PROXY"]}'`（用 `--bot` 选 bot），`unset` 恢复默认。
- 飞书：`/botconfig set envPolicy {"mode":"strict"}`。

格式错误、未知字段、保留变量名都会直接拒绝，不会悄悄降级。

**什么时候生效**：下次会话冷启动时生效；命令行离线修改只改文件，daemon 下次启动时读取。daemon 重启恢复会话时，如果旧会话的策略和现在不一致，会先关掉旧会话再重新启动，确认不了就拒绝启动。CLI 已经读到的环境没法热撤回。

**覆盖范围**：严格模式覆盖 botmux 自己启动的 PTY、tmux、zellij、zmx 会话，以及本机 Codex / TraeX App Server 和标题生成等子进程。tmux / zellij 不再加载 `launchShell` 的启动文件，而是用干净环境直接启动 CLI，所以 PATH、nvm、mise 等要靠基线或你显式配置提供。没有 `TERM` 时默认用 `xterm-256color`。

**不支持的情况**：Herdr、Riff、Mojo、Forge 启动模式、adopt 外部进程和外部 App Server 还做不到同样的隔离，开严格模式会拒绝这些路径。CLI 自己读取的配置和凭证文件、文件权限、云端账号也不在这个策略的隔离范围内。

**和网络策略一起用**：如果同时配了 `sandboxNetworkPolicy`，代理变量（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 及小写同名）还要满足下表。严格继承只决定变量能不能传到 CLI，不等于网络放行。

| 网络配置 | 代理变量 |
| --- | --- |
| 没配网络策略；或 `proxyMode` 不填且公网、内网都是 `allow` | 不因网络策略拒绝；严格模式下仍要在 `inherit` 或 `env` 里写明 |
| `proxyMode` 不填，且任一区域是 `block` / `allowlist` / `denylist` | 有非空代理值就拒绝启动 |
| `proxyMode: "reject"` | 有非空代理值就拒绝启动 |
| `proxyMode: "trusted-egress"` | 可以保留显式放行的代理；网络规则要允许连到代理的 IP 和端口，最终访问哪些目标由代理自己的 ACL 控制 |

上表的通用代理委托只适用于普通会话。插件已冻结受保护 HTTP 出站策略时，`trusted-egress` 与任务代理变量均会明确拒绝，不能反复添加该配置消除报错；模型连接使用受保护模型桥，目前仅支持 Codex。详见[网络沙盒文档](sandbox.md)。

`trusted-egress` 不创建代理、不自动授权环境变量、不保证 CLI 会使用代理；允许代理出口不等于限制代理后的业务目标。若模型依赖代理，不能只删掉 `inherit` 中的代理名称来让配置通过：应显式选择可信出口并配置出口规则与部署层 ACL，或先准备可直连的模型认证、获准目标 CIDR / 端口和 DNS，再移除代理授权。tmux 等持久后端、adopt 和外部 App Server 的拒绝门禁不会因 `trusted-egress` 或 `envPolicy` 放开。

网络策略本身要求 Linux、本地 PTY 后端和 `sandbox: "oncall"`，详见[文件与网络沙盒](/sandbox)。

## 自动维护的字段（不要手改）

下面这些字段由 botmux 自己写入，列出来只是方便你看懂文件：

| 字段 | 说明 |
|------|------|
| `defaultOncallAutoboundChats` | `defaultOncall` 已经自动绑过的群。记录过的群即使后来解绑，也不会再被自动绑 |
| `noCardChats` | `/card off` 写入的「这个群不发实时卡」名单 |
| `noPinStreamingCardChats` | `/card pin off` 写入的「这个群不置顶实时卡」名单 |
| `noCotChats` | `/cot off` 写入的「这个群不显示思考过程」名单 |
| `chatReplyModes` / `chatMentionModes` | `/reply-mode`、`/mention-mode` 写入的按群设置 |

### 授权库（`grants.sqlite`） {#grant-store}

单人对话授权不放在 `bots.json` 里，而是存在 `<数据目录>/grants.sqlite`（默认 `~/.botmux/data/grants.sqlite`）：包括 `chatGrants`、`globalGrants`，以及它们的消息额度和有效期。这样多 bot 建群时 `bots.json` 不会越写越大。

- daemon 启动时，如果 `bots.json` 里还有这些字段（升级前留下的、或手工写的），会并入授权库后从 `bots.json` 删掉；库里已有的同一条以库为准。第一次删除前，整份 `bots.json` 会备份成 `bots.json.bak-grants-v1`。
- 授权只在**过期**时自动回收：daemon 启动时和之后每小时清理一次。要提前撤销用 `/revoke` 或授权卡。
- 多副本模式（`BOTMUX_COORDINATION_MODE=primary`）下，授权仍保存在 `bots.json` 里。不要在两种模式之间来回切换：切到 primary 后，授权库里的授权不会被读取。
