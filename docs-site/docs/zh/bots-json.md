# bots.json 配置

通过 `~/.botmux/bots.json` 配置机器人。运行 `botmux setup` 交互式创建，或手动编辑。文件是一个数组，每个元素是一个 bot（生产环境一个 bot 对应一个独立 daemon 进程）。

> **多数字段可选**——只填 `larkAppId` / `larkAppSecret` 就能跑起来，其余按需增配。**适用**：想手动调 CLI / 模型 / 工作目录 / 权限 / 沙箱等；日常配置更推荐用 dashboard 的 Bot 配置页（改的是同一份 `bots.json`）。改完 `botmux restart` 生效。

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

字段较多，按用途分组列出，绝大多数都是**可选**的——只填 `larkAppId` / `larkAppSecret` 就能跑起来，其余按需增配。

## 必填

| 字段 | 说明 |
|------|------|
| `larkAppId` | 飞书应用 App ID |
| `larkAppSecret` | 飞书应用 App Secret |

## CLI 与模型

| 字段 | 说明 |
|------|------|
| `name` | 进程名后缀，如 `claude-main` → `botmux-claude-main`；留空默认 `botmux-<序号>` |
| `cliId` | CLI 适配器，默认 `claude-code`。见 [多 CLI 适配器](/adapters) |
| `model` | 启动 CLI 用的模型名（如 `claude --model opus`）；留空走 CLI 默认。同一 `cliId` 的多个 bot 可跑不同模型。各适配器的 `modelChoices` 是 `botmux setup` 里给出的候选。**每次启动 CLI 时都按当前配置解析**（含 resume）：改完（dashboard 或本文件）对**存量会话**也生效，在它下一次启动/恢复时应用；与 `cliId` / `cliRuntime` / `wrapperCli` 不同——那几个在会话创建时冻结，避免中途换掉底层运行时 |
| `reasoningEffort` | 新会话默认思考强度。仅对 `codex` / `codex-app` / `traex` / `grok` 这类有结构化思考强度控制的 CLI 生效；按 CLI 与模型能力校验，不支持或未声明支持的组合会被拒绝或忽略 |
| `cliRuntime` | Codex 兼容发行版的结构化运行时描述：`{ id, displayName?, executable, update? }`。它复用 `codex` 适配器，但版本、更新源和会话身份都属于该发行版。见 [Codex 兼容发行版](/adapters#codex-兼容发行版) |
| `cliPathOverride` | 旧版 CLI 入口覆盖，继续兼容 wrapper / router 和存量自定义二进制。新接入的 Codex 兼容发行版优先用 `cliRuntime`。为支持降级到旧版 BotMux，写入端会同时保存一个与 `cliRuntime.executable` 完全相同的兼容影子；不要手工配置不一致的两者 |
| `disableCliBypass` | `true` 时不自动追加 CLI 的免审批 / 沙箱绕过参数（`--yolo`、`--dangerously-*`）；缺省 / `false` 保持原行为 |
| `backendType` | 会话后端，可选 `pty` / `tmux` / `herdr` / `zellij`。**留空默认 `tmux`**（PTY 已退役自动回落）：tmux/herdr/zellij 这类持久后端在本机不可用时**硬拦截**、弹卡提示安装，**不再静默降级 pty**（`zellij` 需 ≥ 0.44）。`pty` 仅作显式兜底（`backendType:"pty"` 或 `BACKEND_TYPE=pty`）——直连进程、**不跨 daemon 重启存活**。见 [tmux 后端](/tmux) |
| `launchShell` | 启动 CLI 用的 shell，覆盖 daemon 的 `$SHELL`：填 shell 名（`zsh` / `bash` / `fish` / `sh`）或绝对路径（如 `/usr/bin/zsh`）。用于登录 `$SHELL`（如 bash）的 rc 文件里有 `exec zsh` 之类跳转、在 botmux 的 `bash -i` 启动里把 CLI 顶掉、导致会话起不来（裸壳里 `parse error`）的场景——指定后直接用它启动、绕开被跳过的 rc。**注意**：PATH / nvm / pnpm 等要放进所选 shell 的 rc（如 `.zshrc` / `.zprofile`，fish 用户写 `~/.config/fish/config.fish`）。fish 是一等启动 shell：`launchShell: "fish"` 和 fish 绝对路径（如 `/usr/bin/fish`）都支持，`$SHELL` 为 fish 时桌面 PATH 探测也会读 fish，所以 fish 用户无需把 PATH / 环境变量回填到 `.bashrc` / `.zshrc`。下个会话对需要 shell 包装的持久后端（`tmux` / `zellij` / `zmx`）生效；`pty` 直接 exec CLI，本就不受影响。也可在 dashboard「机器人默认设置 → 启动 Shell」或 `/config launchShell <值>` 配置 |
| `lang` | 该 bot 的界面语言 `zh` / `en`；留空回落 `BOTMUX_LANG` / `LANG` 环境变量 |
| `customPassthroughCommands` | 在固定透传白名单和当前 CLI adapter 默认放行命令之上，额外放行透传给底层 CLI 的 slash 命令，如 `["/export"]`（Claude Code / Codex 的 `/goal` 已默认放行）。自动归一化（缺失的 `/` 自动补、转小写、仅留 `[a-z0-9:_-]`、去重）；会遮蔽 botmux daemon 命令（如 `/status`）的项会被丢弃，配了也不生效。用 `/list-slash-command` 查看完整放行清单。见 [斜杠命令](/slash-commands) |
| `env` | 该 bot 的进程环境变量 `{ "KEY": "值" }`，注入到这个 bot 的 CLI 进程。最常见用途：让某个 bot 跑 GLM / 第三方 Anthropic·OpenAI 兼容服务商（见下方示例），也可设 `HTTPS_PROXY` 或 CLI 专属开关。值支持字符串 / 数字 / 布尔；`BOTMUX_` / `LARK_APP_` 等 botmux 保留键会被忽略。按**会话**注入（下个新会话生效），不写入共享 tmux server 全局、不会串到别的 bot。也可在 dashboard「机器人默认设置 → 环境变量」配置 |
| `codexAppCleanInput` | **实验性**，且仅对 Botmux 托管、实际运行 `codex-app` 的 session 生效。设为 `true` 后，Codex App 的可见 / 持久化文本 `UserMessage` 只保留用户原始输入，消息级 Botmux 上下文主要改走 `additionalContext`；默认关闭，从下一次 turn 派发生效，不改已有历史。详见下方说明 |
| `codexBrowser` | **实验性、默认关闭**。仅支持 `cliId: "codex-app"`。设为 `true` 后，新会话可通过本机已安装的 Codex Chrome 插件控制 Chrome；对象形式可指定 `{ "enabled": true, "family": "chrome" | "edge", "pluginRoot"?: "/绝对路径" }`。详见下方说明 |

### Codex 兼容发行版

如果一个独立发行的 CLI 完整保留 Codex 的参数、交互、rollout / resume 和认证语义，不需要为它新增 `cliId`。保留协议适配器 `cliId: "codex"`，再声明具体运行时：

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

- `id` 是稳定身份，只能使用字母、数字、`.`、`_`、`-`，最长 64 个字符；改名会被视为切换发行版。
- `executable` 是一个可执行文件名或路径，不是 shell 命令；不要在里面拼参数。Dashboard 保存时会执行只读的 `--version` 预检，输出需包含可识别的 `X.Y.Z` 版本号。
- `displayName` 只影响卡片、状态与 Dashboard 展示，省略时使用 `id`。
- `update.provider` 可选 `auto`、`self`、`npm`、`none`。`auto` 只信任可精确追溯到该二进制的唯一 npm 包；无法确定来源时标记为“未托管”，**绝不拿官方 Codex 的版本号比较**。`self` 才会使用 CLI 自报的结构化 doctor 信息，并要求其中的当前版本与 `--version` 一致；`npm` 必须同时给自己的 `packageName`；`none` 关闭该运行时的更新检查。
- `cliRuntime` 目前只支持 `cliId: "codex"`，不能和 `wrapperCli` 同时使用。BotMux 写入配置时会生成一个与 `executable` 完全相同的 `cliPathOverride` 降级影子；新版本以 `cliRuntime` 为准，旧版本仍能从影子启动同一二进制。手工配置时也必须像上例一样同时写入这个等值影子；缺失或不相等都会直接校验失败，避免出现只能升级、不能安全降级的配置。wrapper / 网关仍走下面的旧入口覆盖机制。
- 旧 `cliPathOverride` 配置不会失效；BotMux 会继续启动它，并对更新探测采取同样的安全 `auto` 策略。Dashboard 会把它显示为只读兼容态：只改模型会保留旧入口，显式选择 Official Codex 才会清除，也可选择“自定义兼容版”迁移到 `cliRuntime`。由于旧字段无法证明完整兼容契约，Codex RPC 等增强能力仍保持关闭。

会话创建时会冻结自己的 runtime 快照。只修改模型仅影响新会话；切换 CLI、runtime 或 wrapper 时，BotMux 会立即关闭仍使用旧启动身份的活跃会话，避免它们之后 lazy resume 到错误的发行版。存量会话不会被静默换用另一 runtime。

### 接入 GLM / 第三方服务商（per-bot env）

让某个 bot 跑 GLM Coding Plan（或其它 Anthropic 兼容服务商），另一个 bot 仍跑官方 Claude——给前者配 `env`：

```json
{
  "cliId": "claude-code",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM Coding Plan key"
  }
}
```

- GLM 国内站把 `ANTHROPIC_BASE_URL` 换成 `https://open.bigmodel.cn/api/anthropic`。
- 给 Codex 这类 OpenAI 协议 CLI 接入时，填 `OPENAI_BASE_URL` / `OPENAI_API_KEY`（服务商的 OpenAI 兼容端点）而非 `ANTHROPIC_*`。
- **隔离**：env 按会话注入到 CLI 进程，全后端一致（tmux / zellij 经每个 pane 注入，绝不写共享 server 全局），所以一个 bot 的服务商配置不会串到别的 bot。
- **安全**：值以明文存在 `bots.json` 与进程环境，不是密钥保险箱；`/config get` 等聊天面会脱敏显示（dashboard 编辑器 owner 鉴权后显示原值）。
- 改完下个**新会话**生效。

### Codex App 纯净输入（实验性）

`codexAppCleanInput` 用于清理 Codex App 中显示的用户消息，同时保留 Botmux 调用模型所需的上下文。默认值为 `false` / `off`，关闭时完全沿用原来的组合 prompt 行为。

可由 owner / `allowedUsers` 通过 `/botconfig` 热更新，无需重启 daemon：

```text
/botconfig set codexAppCleanInput on
/botconfig set codexAppCleanInput off
```

也可直接写进对应 bot 的配置（手改 `bots.json` 后仍按本文末尾说明重启）：

```json
{
  "cliId": "codex-app",
  "codexAppCleanInput": true
}
```

- 仅 Botmux 托管且 session 实际 CLI 为 `codex-app` 时使用此开关；其它 CLI 和 `/adopt` 外部桥接 session 不受影响。session 已冻结的 CLI 优先于后来修改的 bot 默认 CLI。
- 开启后，用户发起的 turn 以用户原文作为 Codex App 的文本 `UserMessage`；Botmux 自己发起的 external trigger、文档预热等合成 turn 使用简短可读标签。sender、mentions、附件路径、引用、role、whiteboard、Skills 和合成 turn 的内部指令等上下文主要通过隐藏的 `additionalContext` 提供。可读的绝对路径图片还会作为 `localImage` 输入；缺失、相对或不可读图片会跳过原生图片项并记录提示，但附件路径仍留在上下文中。
- 可识别的 Codex CLI `>= 0.135` 才启用纯净文本和 `additionalContext`；`>= 0.136` 时还会附带独立的 `clientUserMessageId`。版本过旧或无法识别时直接使用 legacy 组合 prompt。
- 只有 app-server 在 `turn/started` 前明确拒绝 `additionalContext` / `clientUserMessageId` 实验字段时，runner 才用 legacy prompt **重试一次**，并在该 runner 生命周期内关闭纯净模式。网络、超时、模型或一般 turn 错误不会自动重试，以免重复执行。
- `/botconfig` 切换在**下一次派发给 Codex worker**时采样；普通 live 消息通常就是下一条消息，等待 repo 选择的首轮则在 repo commit 时采样。已排队或正在执行的 turn 不会被中途改写，也不会回填既有历史。
- `additionalContext` 不出现在 Codex App 的普通用户消息气泡中，但仍可能保存在原始 rollout / 诊断记录里。开启时 Botmux 自身也会保留 legacy prompt 与结构化 sidecar 以支持兼容降级和 `retry_last_task`。此功能只解决 App 展示与普通历史阅读的整洁度，**不是**隐私擦除或安全脱敏机制。

### Codex App 浏览器桥接（实验性）

此能力只解决 Botmux 以 app-server 协议运行 Codex 时无法继承 Codex App 内置 Chrome 工具的问题。它是 Botmux 自身的可选适配层，不依赖任何业务仓库、Harness 或本地代理工程。

```json
{
  "cliId": "codex-app",
  "codexBrowser": true
}
```

- 需要先在同一 OS 用户的 Chrome / Edge 中安装并启用 Codex 浏览器扩展；Botmux 默认从 `CODEX_HOME`（或 `~/.codex`）的官方插件缓存中选择最新完整版本。只有维护自定义插件目录时才填写绝对路径 `pluginRoot`。
- 开启后仅给新建的 Codex App thread 注册一个 `botmux_browser` 动态工具。旧 thread 不会被原地改写，请新开一个飞书话题 / 会话验证。
- 工具只暴露标签页、可访问性树交互、导航和截图等高层操作，不暴露任意 JavaScript、raw CDP、cookie、local storage、浏览历史、剪贴板或文件传输。
- 每个 Botmux runner 独立持有浏览器会话状态；默认关闭，未配置的 bot 启动参数和行为完全不变。
- 当前不支持与 `existingAppServer`、`sandbox` 或 `readIsolation` 组合，配置冲突会在启动时直接报错，避免以不完整隔离边界运行。

## 工作目录

| 字段 | 说明 |
|------|------|
| `workingDir` | 默认工作目录，支持逗号分隔多个。从该目录**向下**递归找 git 仓库（最多 3 层），不向上扫 |
| `workingDirs` | 工作目录数组写法（`["~/a", "~/b"]`）；显式配置时优先于 `workingDir` 的逗号分隔形式 |
| `defaultWorkingDir` | 单仓库默认目录：无 oncall / 无同群兄弟 session 时直接进入，跳过 repo 选择卡片。`/cd` 仍可中途切换。纯运行时回落，不写状态、不改权限模型 |

## 权限与授权

| 字段 | 说明 |
|------|------|
| `allowedUsers` | 操作权名单。推荐使用**完整邮箱**、手机号或 `on_xxx`；`ou_xxx` 只能用于签发它的同一应用，禁止跨 Bot 复制。配了 `allowedChatGroups` 时至少要有一个作为 owner |
| `allowedChatGroups` | 可对话群（`oc_xxx`）。群内任何成员可对话（仅 `canTalk`），敏感操作仍由 `allowedUsers` 控制 |
| `p2pOpen` | `true` 时允许飞书应用可用范围内的任何用户私聊该 bot（仅 `canTalk`）；群聊不受影响，敏感操作仍只认 `allowedUsers`。建议始终同时配置至少一个 `allowedUsers` owner |
| `oncallChats` | oncall 绑定，`[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`。见 [oncall](/oncall) |
| `defaultOncall` | 该 bot 的默认：新群聊首条新话题自动绑定 oncall。`{ "enabled": true, "workingDir": "~/foo", "since": <epoch ms> }`；`since` 之前已存在的老群不受影响 |
| `globalGrants` | 全局可对话名单（`ou_xxx`，人或 bot）。任意群可对话，仅 `canTalk` |
| `chatGrants` | 按群的 per-user 授权 `{ "oc_xxx": ["ou_yyy"] }`，仅放行 `canTalk`。一般由 `/grant` 卡片写入，也可手配 |
| `messageQuota` | 消息额度覆盖 `{ "defaultLimit": N }`：配了正整数后，新授权卡与 Oncall 都使用 N 条额度；未配置时，新授权卡默认每人 3 条，Oncall 不设额度。显式 `/grant @用户 N` 始终使用 N。仅约束 talk 授权，不影响 `canOperate` |
| `restrictGrantCommands` | `true` 时，仅靠 per-user 授权（`chatGrants` / `globalGrants`）放行的人禁用**所有斜杠命令**，只能普通对话；owner / `allowedUsers` / oncall / 整群成员不受影响。默认 `false` |
| `autoGrantRequestCards` | 默认开启。显式设为 `false` 时，群里未授权的人或外部 bot @ 本 bot 但被对话权限闸挡住时，不再自动给 owner 发 `/grant` 申请卡，改为静默丢弃 |

## 文件沙盒

| 字段 | 说明 |
|------|------|
| `sandbox` | `true` 时，新会话在 Linux 文件沙盒中启动。写入被隔离，需要通过 `/land` 审阅落盘 |
| `sandboxHidePaths` | 在沙盒内用空目录 / 空文件遮罩的路径，避免机器人读取，例如 `["~/.ssh", "~/.botmux/bots.json"]` |
| `sandboxReadonlyPaths` | 在沙盒内额外只读挂载的已存在路径，适合共享源码快照、参考仓库或生成文档等只允许查看、不允许修改的输入 |
| `sandboxNetwork` | 沙盒会话的网络策略。缺省 / `true` 保留当前网络和代理访问；`false` 添加 `--unshare-net`，阻断普通网络出口 |

> ZMX 无法执行文件沙盒或实际生效的读隔离，开启这些边界的配置组合会 fail closed，详见 [ZMX 后端边界](/zmx#不支持的组合)。

## 卡片与终端

| 字段 | 说明 |
|------|------|
| `brandLabel` | 卡片底部品牌文案。`undefined`=默认 `botmux` 链接；`""`=隐藏；其它字符串=原样渲染（支持 markdown）。纯样式，不影响路由 / 权限 |
| `showUsageInCardFooter` | 回复卡片页脚是否展示 Agent CLI 原生提供的 Context / Token 用量。缺省 / `true`=展示，`false`=同时隐藏两项；单项数据缺失时仍只省略缺失项。仅控制卡片展示，不停止 Usage Ledger 或其它统计 |
| `disableStreamingCard` | `true` 时彻底不发实时流式 session 卡片（web 终端仍跑、最终答复仍经 `botmux send` 到达，只是没有自动刷新的状态卡）。给嫌实时卡吵的用户 |
| `pinStreamingCard` | `true` 时为该 bot **置顶当前公开的实时状态卡片**；默认关闭，只有显式 `true` 才开启。只认当前公开 live-status 的真实 `streamCardId`，repo 选择卡、私有 `/card`、最终回复卡、CoT、关闭卡、以及其它交互卡都不参与。开关支持热更新：通过 dashboard 或 `/botconfig set pinStreamingCard on/off` 成功写盘且有效值发生变化后，会对这个 bot 的**现有活跃会话**做 best-effort 热重算；配置响应**不等待**飞书 Pin/Unpin 完成。失败不会中断发卡、转移、恢复、关闭或配置本身；异常期间可能暂时出现 0 个或多个 Pin。该功能**不维护持久重试日志，也不会全量扫描整群 Pin 状态**：显式从 on 切到 off 时会清理当前会话已知的实时卡 ID；若配置已经是 off 且进程丢失了来源记录，后续关闭或转移不会冒险移除可能由人工创建的 Pin |
| `noPinStreamingCardChats` | 一个 `chatId` 数组，表示即使 bot 已开启 `pinStreamingCard`，这些群里也**不要自动置顶**流式卡片。它就是 `/card pin off|on` 背后的 negative set。实时流式卡片本身仍照常发送，只是当前群不再触发 Pin 副作用；为空或缺省表示没有按群关闭 |
| `silentTurnReactions` | `true` 时，无卡片会话不再给触发消息添加 GoGoGo / DONE reaction。只影响 `disableStreamingCard` 或 `noCardChats` 关闭实时卡片后的轻量状态提示；默认 `false` |
| `receivedReactionEmoji` | 无卡片会话「已收到」reaction 的飞书 emoji_type；`undefined`=默认 `GoGoGo`（冲!）。自由字符串，填错只是静默不加表情（best-effort） |
| `doneReactionEmoji` | 无卡片会话「已完成」reaction 的飞书 emoji_type；`undefined`=默认 `DONE`（✅）。设成与 `receivedReactionEmoji` 相同值可让完成态不翻脸——适合 idle 判定可能提前触发的 CLI（如 Pi），避免过早出现误导性的 ✅ |
| `writableTerminalLinkInCard` | `true` 时卡片正文直接内嵌**可写**终端链接（带 token，看得到卡片的人都能操作）；默认藏在「获取写权限」按钮后私发给点击者。`disableStreamingCard` 开启时无意义 |
| `privateCard` | `true` 时 `/card` 走 ephemeral 私有卡片，仅 `allowedUsers` 可见（talk 授权与裸触发者收不到），仅普通 `group` 聊天有效，且不能 live 更新。只作用于 `/card` 命令本身 |

## Prompt 注入

| 字段 | 说明 |
|------|------|
| `senderTag` | 布尔，默认 `true`（开）。每轮转发给 CLI 的消息是否附带一个 `<sender type="user\|bot" open_id="ou_…" name="…" email="…" />` 标签，告诉模型这句话是谁说的。只有显式 `false` 会写盘并关闭；缺省或 `true` 都保持注入，prompt 与历史行为逐字节一致 |

关掉后模型看不到发言人身份：多人会话里无法区分谁说的、也无法按人称呼。适合模型会把标签内容抄进回复正文的 CLI（如 cursor，见 `<sender_note>` 反抄写提示——标签关掉后该提示也一并消失），或不希望把每条消息的身份写进 CLI 记录的场景。

可由 owner / `allowedUsers` 通过 `/botconfig` 热更新，无需重启 daemon：

```text
/botconfig set senderTag off
/botconfig set senderTag on
```

也可直接写进对应 bot 的配置：

```json
{
  "senderTag": false
}
```

- **`botmux send --mention-back` 不受影响**：它读的是 daemon 侧独立记录的本轮触发者（`replyTargets[turnId].senderOpenId`），与 prompt 里的这个标签是两条链路。
- 关闭有两项**可观测性代价**：① `/adopt` 少一条识别「本 bot 自产会话」的指纹（其余结构判据仍覆盖现有 prompt 形态，不会因此把自产会话当外部会话列出）；② dashboard 会话洞察无法再从标签判断发言人类型与 A2A 对方名字，只能靠 `[来自 … 的 @mention]` 交棒文本标记兜底，没有该标记时该轮不显示来源。
- 立即生效（下一轮起），不改写已排队或正在执行的 turn，也不回填既有历史。
- dashboard「发言人标签」开关保存的就是这个字段。

## 主动开工

| 字段 | 说明 |
|------|------|
| `autoStartOnGroupJoin` | `true` 时，被拉入含至少一名 `allowedUsers` 的新群即自动开工（不必 @）。需在飞书后台为该应用订阅 `im.chat.member.bot.added_v1` 事件 |
| `autoStartOnGroupJoinPrompt` | 配合上面：自动开工的首轮 prompt；留空 / 空白则空消息开场，让 bot 自己读群上下文。`autoStartOnGroupJoin` 关闭时无意义 |
| `autoStartOnNewTopic` | `true` 时，话题群里每个新话题的首条消息无需 @ 也自动开工（普通群无效）。默认被动（仅 @ 触发） |

## 群消息监听

让 Bot **主动盯住某个群**：命中条件的群消息无需 @ 就自动拉起一个会话去处理。典型用途是**报警运维**——监控/告警系统本来就有自己的飞书机器人在往群里发告警，把这个 Bot 拉进那个群、开启监听，每条告警自动开工排查，不必额外配 [Webhook 接入点](/webhook)。

推荐在 **Dashboard「角色 → 消息监听」** 里按群配置（可**预览**最近 24h 命中的消息、**试运行**验证效果）；也可直接写 `bots.json` 的 `messageListeners`（键为 `chat_id`，值为下表配置）：

| 字段 | 说明 |
|------|------|
| `enabled` | 是否启用该群的监听。启用时 `prompt` 必填，否则整条配置被忽略 |
| `prompt` | 监听提示词：告诉 Bot 哪些消息要处理、怎么回复。命中消息会在其**下方新建话题**回复 |
| `name` | 监听名称（可选），如「告警监听」，用于 Dashboard 展示 |
| `replyCardTitle` | 回复卡片标题（可选），留空用默认 |
| `workingDir` | 该监听拉起会话的工作目录（可选），留空用 Bot 默认工作目录 |
| `senderPolicy.mode` | `all_except_excluded`（黑名单，默认）：处理所有匹配发送者类型、仅排除指定项；`include_only`（白名单）：只处理 `includeSenderOpenIds` 里的发送者 |
| `senderPolicy.includeSenderTypes` | 监听的发送者类型：`["user"]` / `["bot"]` / 两者。**监听第三方告警机器人必须含 `"bot"`** |
| `senderPolicy.includeSenderOpenIds` / `excludeSenderOpenIds` | 按 `open_id` 精确白名单 / 黑名单 |
| `senderPolicy.excludeSelf` | 默认 `true`，始终排除当前 Bot 自己发的消息（防自触发） |
| `messagePolicy.includeMsgTypes` | 监听的消息类型，默认文本 + 富文本（`post`） |

```json
{
  "messageListeners": {
    "oc_xxxxxxxxxxxxxxxx": {
      "enabled": true,
      "name": "告警监听",
      "prompt": "群里每条告警都是线上事件。定位受影响服务、给出初步排查方向；确认是误报就说明理由。",
      "senderPolicy": { "mode": "all_except_excluded", "includeSenderTypes": ["bot"] }
    }
  }
}
```

约定与边界（V1）:

- **只处理群聊顶层消息**：已有话题里的普通回复不处理；显式 @ 本 Bot 的消息仍走普通 @ 路由（不重复触发）。
- **每条命中消息各拉起一个会话**，回复到该消息下方的新话题。
- **触达方式**：实时事件路径覆盖飞书推送到的消息；**其他机器人发的、以及未 @ 的消息，靠约 30s 一次的历史轮询补齐**（即最长约 30s 延迟）。所以监听第三方告警机器人时用黑名单模式（`all_except_excluded` + 含 `"bot"`）最稳——白名单按 `open_id` 匹配，而历史接口里第三方机器人按 `app_id` 上报、可能解析不出 `open_id` 从而命中不到。

## 总结命令

| 字段 | 说明 |
|------|------|
| `summaryRange` | 显式总结命令 `@机器人 /summary` 使用的历史读取范围。`limit` 表示普通群最近 N 条消息，默认 50；`sinceHours` 表示普通群最近 N 小时，默认 24。任一字段设为 `0` 表示该维度不限制。话题群始终读取当前话题/thread 历史，再按总结窗口过滤 |
| `summaryMemory` | 布尔，默认 `false`（关）。开启后 `@机器人 /summary` 会把本次总结整理成中文「问题解决记录」，追加写入下方 `summaryMemoryPath` 指定的记忆文件，并要求 agent 只写这一个文件、把实际写入的 Markdown 原样回传确认；同时会往后续会话注入一段 `<summary_memory>` 复用提示，让后续问题只有在 PSM、环境、任务 ID、节点、错误现象等关键条件全部完全一致时才直接复用历史结论，否则只当排查参考 |
| `summaryMemoryPath` | 记忆文件路径，默认 `summary.md`。相对路径由 agent 按「当前项目根目录」解析，绝对路径按原样使用。留空 / 不设时回落到 `summary.md`。仅在 `summaryMemory` 为 `true` 时生效 |

示例：

```json
{
  "summaryRange": {
    "limit": 50,
    "sinceHours": 24
  },
  "summaryMemory": true,
  "summaryMemoryPath": "docs/summary.md"
}
```

- 只有显式 `@机器人 /summary` 会触发总结；不 @ 机器人时仍按普通群/话题的既有路由规则处理，不会因为关键词自动唤醒。
- dashboard 的「/summary 总结范围」保存的就是 `summaryRange`；「开启记忆」开关与「记忆文件路径」输入框分别保存 `summaryMemory` 与 `summaryMemoryPath`。
- 如果本次触发前存在上一条 `@同一机器人 /summary`，总结窗口只包含上一条之后到本次触发为止的消息；找不到上一条时回退到 `limit` / `sinceHours`。
- `limit` 与 `sinceHours` 是默认（无显式边界）总结窗口的安全上限；两者都为 `0` 时表示不做该维度限制。**显式边界按设计优先于该上限**：当 `summaryMemory` 开启且 `/summary` 带了边界文字时，botmux 尊重用户「从这条起」的明确意图，从命中的边界消息起全部纳入——普通群里 `limit` 仍约束扫描量，但比 `sinceHours` 更早的边界、以及话题群里任意早的边界都会被接受，可能超出默认配置范围。若不希望某个 bot 读入过旧内容，最可靠的做法是不要带边界文字；普通群还可以调低 `limit` 约束扫描量（但 `sinceHours`、以及话题群里的边界都不受配置范围约束）。
- **仅当 `summaryMemory` 开启时**，`/summary` 命令后跟随的文字会被当作「硬边界」：在触发前的历史里定位**最近一条**包含该文字的消息，只总结从这条到本次触发为止的内容；如果扫描到的历史里找不到该边界，则不回退到更宽范围，而是把「未找到边界」错误与空历史一起交给 agent（此时记忆写入指令仍会执行）。`summaryMemory` 关闭时，`/summary` 后的文字仅作为对本次总结的侧重提示，历史窗口仍按 `summaryRange` 读取。
- 记忆文件由 agent 在其工作目录内写入。如果 bot 开启了 sandbox，且 `summaryMemoryPath` 指向工作目录之外（绝对路径，或用 `../` 逃出工作目录的相对路径），请把该文件**已存在的父目录**加进 `sandboxPaths.readWrite`；worker 在 spawn 时会过滤掉尚不存在的路径，而新记忆文件通常还不存在，所以只加文件本身会被丢弃（除非文件已预先创建）。否则写入可能被沙盒拒绝。

## 旧内容触发配置

| 字段 | 说明 |
|------|------|
| `contentTriggers` | **Legacy / 不再生效。** 旧版本曾用于关键词 / 正则免 @ 触发，但当前消息路由不会再根据 `contentTriggers` 唤醒 bot。保留该字段解析仅用于兼容旧 `bots.json`：如果存在名为 `dashboard-default-summary-trigger` 的旧 dashboard 配置，botmux 会尽量从其中迁移/读取 `limit` 与 `sinceHours` 作为 `summaryRange` 的兜底值。新配置请使用 `summaryRange` |

## 语音

| 字段 | 说明 |
|------|------|
| `voice` | 该 bot 的语音引擎覆盖，按字段合并到 `~/.botmux/config.json` 的全局 `voice` 块之上（per-bot 优先）。有可用语音凭据时，回复卡片会出现「🔊 语音总结」按钮。见 [语音总结](/voice) |

## 会议监听角色与群内输出形式

`vcMeetingAgent.meetingConsumer.consumerProfiles` 可以定义通用的会议监听角色。`responseMode` 与 `listenerDelivery.placement` 是两个独立维度：

Dashboard 的“会议角色预设”提供本地内置模板库，当前包含“会议重要信息同步”“会议纪要与行动项”“会议主持”“方案评审与风险挑战”“访谈与需求洞察”。点击“使用此模板”会复制出一个普通、可完整编辑的 profile；之后修改模板不会改写用户配置。模板目录带稳定的 `templateId`、版本和来源，未来可以在同一模型上接入社区源。本期不联网、不上传模板使用情况，因此不提供热度或使用量排行。

- `responseMode: "silent"`：自动模型输出不可见；适合只做内部处理或通过受管会议能力执行动作。
- `responseMode: "listener_thread"`：允许把自动模型输出发到会议监听群，需要 `listener.output.request` capability。
- `listenerDelivery.placement: "auto"`：兼容旧行为，沿用当前会话的群/话题路由；省略该字段等同于 `auto`。
- `listenerDelivery.placement: "chat"`：每次同步都作为群顶层消息发送。
- `listenerDelivery.placement: "topic"`：首条有效同步作为固定话题根消息，后续同步都回复到同一话题；移除并重新启用该 profile 后会开启新话题。

`listener_thread` 的自动输出使用 botmux 内部的 `skip | publish` 控制协议：Agent 判断当前是否值得发布，botmux 只在 `publish` 时把消息正文发到飞书，控制 JSON 本身不会出现在群里。该协议不做语义指纹去重，也不提供 debounce/interval 配置；是否为新信息、是否继续观察以及何时发布，都由 Agent 根据 profile prompt 和完整会议上下文判断。格式异常会 fail closed，不会把模型原始控制文本发到群里。显式人工消息仍按原引用关系回复，不走此协议。

下面是一个“会议重要信息同步”预设。它不包含事故专用结构，只通过 prompt 定义“什么值得同步”，因此也适用于项目评审、发布协调等会议：

```json
{
  "id": "important-sync",
  "agentAppId": "cli_your_agent_app_id",
  "label": "会议重要信息同步",
  "role": "important-information-sync",
  "instructions": "持续监听会议，只发布对群内协作者有实际价值的新信息：已确认的结论或决定、状态变化、明确阻塞或风险、需要群内人员知晓或行动的事项。讨论尚未形成明确变化时先不发布；是否继续观察以及何时发布，由你根据会议语义自行判断。忽略讨论过程、重复表述、寒暄和未经确认的猜测。每次只发布相对上次的新内容，使用简洁中文；有负责人、截止时间或影响范围时一并写明。此前信息的时间、负责人、范围、状态或结论发生修正时，必须作为新信息发布，不能因为其他内容大部分一致而忽略。字幕发生修订时重新判断，但不要重复发布未发生变化的事项。",
  "filter": {
    "activityTypes": ["transcript_received", "chat_received"]
  },
  "responseMode": "listener_thread",
  "listenerDelivery": {
    "placement": "topic"
  },
  "capabilities": ["listener.output.request", "meeting.read"]
}
```

`agentAppId` 是实际执行该角色的 bot App ID。把 profile id 加入 `defaultConsumerIds`，并将 `defaultMode` 设为 `agents`，可让它在监听开始时默认启用；否则可在会中消费者选择卡片里手动启用。

## 运行时状态（自动维护，勿手改）

下列字段由 botmux 自身写入并随授权 / 开关一起持久化进 `bots.json`，列出仅为说明，**不要手动编辑**：

| 字段 | 说明 |
|------|------|
| `defaultOncallAutoboundChats` | `defaultOncall` 已自动绑过的 chat_id（append-only）。一旦记录，即使后续解绑也不会再次自动绑 |
| `quotaState` | scope 级消息额度计数 `{ "chat:<cid>:<oid>" \| "global:<oid>": { limit, used } }`；用满自动收回对应 scope 授权 |
| `noCardChats` | `/card off\|on` 写入的「该群不发流式卡片」名单 |

> **配置优先级**：`BOTS_CONFIG` 环境变量 → `~/.botmux/bots.json`。改完跑 `botmux restart` 生效。
