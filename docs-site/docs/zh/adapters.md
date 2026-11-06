# 多 CLI 适配器

botmux 不绑定某一个 AI 编程工具。每个机器人用 `cliId` 指定底层跑哪个 CLI / Agent，适配器负责把飞书消息送进去、把回复带回来。换 CLI 只是改一个字段。

- **本地 CLI**：每个会话都是本机上一个真实进程。默认 tmux 后端下可以 `tmux attach` 进去直接看（pty / zellij / herdr 后端另说）。
- **API / 远端 Agent**：少数适配器（如 Mira App、riff、Remote Runner）不在本机起 CLI 进程，而是调用远端服务。最小配置见 [API / 远端适配器](#remote-agents)。

**这页适合**：想换底层 CLI、接一个新工具，或者想知道某个 CLI 能不能指定模型。
**不需要新适配器的情况**：套一层网关 / 启动器（aiden、ttadk、ccr 等）见 [套 wrapper / 网关接入](#套-wrapper--网关接入)；严格兼容 Codex 的独立发行版见 [Codex 兼容发行版](#codex-兼容发行版)。

## 怎么给机器人换 CLI

先在**跑 botmux daemon 的同一个系统用户**下装好目标 CLI，并在终端里手动跑一次、完成它自己的登录。botmux 不会替你登录。然后任选一种方式：

| 方式 | 怎么做 | 什么时候生效 |
|------|--------|--------------|
| `botmux setup` | 新建或编辑机器人时，在 CLI 菜单里选（同类 CLI 会折成二级菜单，如 Codex / Codex App、TRAE 2.0 / 旧版 Coco） | 保存后 `botmux restart` |
| Dashboard | 「Bot 配置 → 常用 → Agent 配置」里选 CLI 和模型，点「保存 Agent 配置」 | 新会话 |
| `bots.json` | 直接改条目里的 `cliId`，见 [bots.json 配置](/bots-json) | `botmux restart` 后的新会话 |

![Dashboard 的 Agent 配置：选 CLI 与模型](/img/adapters-dashboard-cli-picker.png)

已经在跑的会话不会被中途换掉 CLI：`cliId`、`wrapperCli`、`cliRuntime` 在会话创建时就固定了，改完只影响新会话。

Dashboard 会检测所选 CLI 能不能找到。它会按你的登录 Shell（Zsh / Bash 的 rc 文件）去找命令，所以只在 `.zshrc` 里加了 PATH 的 CLI 也能识别。真的找不到时会给出提示：

![所选 CLI 不可用时的提示](/img/adapters-dashboard-cli-missing.png)

macOS 上用 Codex / Codex App 时，如果 PATH 里找不到 `codex`，botmux 会再找 ChatGPT.app、Codex.app 自带的 `codex`，依次查看：

- `/Applications/ChatGPT.app/Contents/Resources/codex`、`~/Applications/ChatGPT.app/Contents/Resources/codex`
- `/Applications/Codex.app/Contents/Resources/codex`、`~/Applications/Codex.app/Contents/Resources/codex`

所以只装了桌面 App 也能直接用。PATH 里有 `codex` 时优先用 PATH 里的；想固定用某一个，就把 `cliPathOverride` 设成它的绝对路径。Linux 上没有这个回退。

## 支持的 CLI / Agent

下表是当前内置的适配器。「默认命令」是 botmux 默认要在 PATH 上找的可执行文件，可以用 `cliPathOverride` 换成绝对路径。权威列表以 [`src/adapters/cli/registry.ts`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts) 为准。

| `cliId` | CLI / Agent | 默认命令 | 接入方式 | 可指定 `model` |
|---------|-------------|----------|----------|:--:|
| `claude-code` | Claude Code（默认） | `claude` | 本地进程 | ✅ |
| `codex` | Codex CLI | `codex` | 本地进程 | ✅ |
| `codex-app` | Codex App | `codex` | 本地进程（app-server 协议） | ✅ |
| `cursor` | Cursor（cursor-agent） | `cursor-agent` | 本地进程 | ✅ |
| `opencode` | OpenCode | `opencode` | 本地进程 | ✅ |
| `opencode2` | OpenCode 2（beta） | `opencode2` | 本地进程 | |
| `mimocode` | MiMoCode | `mimo` | 本地进程 | ✅ |
| `antigravity` | Antigravity | `agy` | 本地进程 | ✅ |
| `copilot` | GitHub Copilot | `copilot` | 本地进程 | ✅ |
| `grok` | Grok Build | `grok` | 本地进程 | ✅ |
| `kimi` | Kimi Code | `kimi` | 本地进程 | ✅ |
| `kiro-cli` | Kiro | `kiro-cli` | 本地进程 | |
| `reasonix` | Reasonix | `reasonix` | 本地进程 | ✅ |
| `zcode` | ZCode | `zcode` | 本地进程 | ✅ |
| `doubao` | Doubao CLI（见 [Doubao 使用指南](https://github.com/deepcoldy/botmux/blob/master/docs/doubao.md)） | `doubao` | 本地进程 | ✅ |
| `pi` | Pi | `pi` | 本地进程 | ✅ |
| `oh-my-pi` | Oh My Pi（Pi 的分支） | `omp` | 本地进程 | ✅ |
| `aiden` | Aiden（原生 agent） | `aiden` | 本地进程 | |
| `traex` | TRAE CLI 2.0（traex） | `traex` | 本地进程 | ✅ |
| `coco` | TRAE CLI 1.0 / CoCo（旧版，已停止维护；需 ≥ 0.120.32） | `coco` | 本地进程 | ✅ |
| `mtr` | MTR | `mtr` | 本地进程 | |
| `hermes` | Hermes | `hermes` | 本地进程 | |
| `ebsd` | EBSD（需配置文件凭证，见 [配置说明](https://github.com/deepcoldy/botmux/blob/master/docs/ebsd.md)） | `ebsd` | 本地进程 | |
| `codem` | CodeM（见 [CodeM 说明](https://github.com/deepcoldy/botmux/blob/master/docs/codem.md)） | `codem` | 本地进程 | ✅ |
| `minimax` | MiniMax Code / mcode（见 [MiniMax Code 说明](https://github.com/deepcoldy/botmux/blob/master/docs/minimax-code.md)） | `mcode` | 本地进程 | ✅ |
| `genius` | Genius | `genius` | 本地进程 | ✅ |
| `seed` | Seed（Claude Code 分支） | `seed` | 本地进程 | ✅ |
| `relay` | Relay（Seed 新版） | `relay` | 本地进程 | ✅ |
| `dsh` | DeepSeek Harness（见 [下文](#deepseek-harnessdsh)） | `dsh` | 本地进程（SDK JSON-RPC） | ✅ |
| `mir` | Mir CLI（本地 mircli，见 [下文](#mir-cli-与-mcp-bridge)） | `mircli` | 本地进程 | |
| `mira` | Mira App | 无 | API / 远端 | |
| `riff` | riff | 无 | 云 Agent（API） | |
| `mojo` | Mojo | `mojo` | API 驱动（宿主机执行 / 云沙箱） | ✅ |
| `remote-runner` | 通用远端 Runner（见 [协议说明](https://github.com/deepcoldy/botmux/blob/master/docs/remote-runner.md)） | `botmux-remote-runner` | 远端协议 | ✅ |

### 关于 `model` 这一列

- ✅ 表示启动时真的会把模型带给 CLI。这样你可以在 `bots.json` / Dashboard 里给机器人设默认模型，或者在新话题第一条消息里用 `/t … /model <模型>` 临时指定（见 [斜杠命令](/slash-commands)）。
- 没有 ✅ 的 CLI，模型由 CLI 自己的配置或界面决定。这时 `model` 字段会被忽略，话题指令头里的 `/model` 会被直接拒绝，不会悄悄失效。
- riff 例外：它的模型只从机器人的 `riff` 配置块读取，不看 `model`。
- 有些 CLI 支持指定模型，但没有内置候选列表（如 Seed、Relay、Pi），setup 不会弹模型选择，需要时手填，或在 CLI 里用原生 `/model` 切。

### Gemini CLI 已下线

上游已停止维护 Gemini CLI，botmux 移除了 `gemini` 适配器，Dashboard 和 `botmux setup` 不再提供它。替代品是 `antigravity`（Antigravity，命令 `agy`）。

- `bots.json` 里还写着 `cliId: "gemini"` 的机器人会**拒绝启动**，并提示改成 `"antigravity"`。其它机器人照常运行。
- 脚本化 setup 里原来代表 Gemini 的序号 `6` 现在会报错，不会改选成别的 CLI。
- 迁移步骤：
  1. 装好 `agy`，用 Google 账号登录；或者不登录，改用 Gemini API key：在 `~/.gemini/antigravity-cli/settings.json` 里写 `"modelProvider": "gemini"`，并设置 `GEMINI_API_KEY`。
  2. 把 `cliId` 改成 `"antigravity"`（直接改 `bots.json`，或用 `botmux setup` 改这个机器人的 CLI）。
  3. 删掉或重配 Gemini 专属设置：`cliPathOverride` / `wrapperCli`（如 `ttadk gemini`）、Gemini 的 `model` 名、`GEMINI_CLI_HOME`。
  4. `botmux restart`。

  这个机器人没启动时，Dashboard 只能显示原因，不能在那里保存它的配置。

## 套 wrapper / 网关接入

很多时候你不是直接跑原生 CLI，而是套一层网关或启动器（内网代理 + SSO、模型路由等）。这时**不需要新适配器**：`cliId` 仍填底层真实的 CLI（`claude-code`、`codex` …），只改启动入口。适配器的回复回收、恢复会话、hook 等机制照常工作。

### 方式一：`wrapperCli` 启动前缀（推荐）

在机器人配置里写 `wrapperCli`，botmux 启动时会把命令拼成 `<wrapperCli> <CLI 参数>`。不用写脚本，跨系统都能用。

```json
{
  "cliId": "claude-code",
  "wrapperCli": "aiden x claude"
}
```

`botmux setup` 和 Dashboard 的 CLI 菜单已经内置了常见组合，选中即自动填好：

| 菜单项 | `cliId` | `wrapperCli` |
|--------|---------|--------------|
| Aiden × Claude / Aiden × Codex | `claude-code` / `codex` | `aiden x claude` / `aiden x codex` |
| CJADK × Claude / CJADK × Codex | `claude-code` / `codex` | `cjadk claude` / `cjadk codex` |
| TTADK × Claude / Codex / OpenCode / CoCo / Cursor | 对应 CLI | `ttadk claude` 等 |

几点说明：

- 第一个词按 PATH 查找，并取代该 CLI 的默认命令；设了 `wrapperCli` 后 `cliPathOverride` 不再生效。
- `aiden x claude` 不接受 botmux 注入的 `--settings`，botmux 会自动去掉；其它启动器原样透传。
- TTADK 组合的模型取机器人的 `model` 字段，由 botmux 作为 `ttadk -m <模型>` 传入，不填时默认 `glm-5.1`（TTADK × CoCo 不接受模型）。
- 也能承载 `ccr` 等任意启动器。
- `wrapperCli` 不能和 `cliRuntime` 同时用。

### 方式二：自写 wrapper 脚本 + `cliPathOverride`

启动逻辑比较复杂（要改环境变量、剥参数、强套 PTY 等）时，写一个脚本：

1. **先登录网关**（一次性）：用跑 daemon 的同一系统用户完成 SSO 登录。token 过期会弹交互登录卡住终端，注意保持登录态。
2. **写脚本**放到 `~/.botmux/bin/`，把 botmux 传来的参数透传给真实 CLI。有的网关拒收 `--settings`，要在脚本里剥掉。
3. **`chmod +x`**（最容易漏）。没有可执行位会 `EACCES`，CLI 一起来就退出，机器人反复重启。
4. **直接执行脚本验证**：`~/.botmux/bin/xxx --version`。别用 `bash xxx` 测，那样不需要可执行位，会掩盖第 3 步的问题。
5. 在 `bots.json` 里把 `cliPathOverride` 设成脚本的**绝对路径**（别用 `~`），然后 `botmux restart`。

各网关的具体脚本以对应团队发布的文档为准。MTR 是社区贡献，安装命令 `npm i -g @metamove-code/mtr-cli@latest`。

> 排查 wrapper 问题：`botmux logs` 里找 `Spawning fresh CLI:` 那一行，把完整命令复制出来在终端手动跑一遍，基本能定位是权限、参数还是登录态的问题。

## Codex 兼容发行版

如果你用的是**严格兼容 Codex** 的独立发行版，用 `cliId: "codex"` + `cliRuntime`：`cliId` 选 Codex 协议适配器，`cliRuntime` 指定真正运行、独立发版的二进制。这样它能复用模型参数、恢复会话、空闲检测和 Codex RPC，又不会被当成官方 Codex 去检查版本。

「严格兼容」指：接受 botmux 传给 Codex 的参数，交互状态和 rollout / resume 语义相同，认证和 home 目录布局也兼容。如果它改了参数、界面状态机、会话存储或协议，就应该贡献一个真正的适配器。

Dashboard 的「Codex 运行时」可以直接切到「自定义兼容版」，填可执行文件和更新来源：

![Dashboard 配置 Codex 兼容发行版](/img/codex-compatible-runtime-dashboard.png)

完整字段与更新来源见 [bots.json 的 Codex 兼容发行版章节](/bots-json#codex-runtime)。旧的 `cliPathOverride` 写法继续可用，但不会自动开启需要明确兼容声明的 Codex RPC 能力。

## API / 远端适配器 {#remote-agents}

下面四种适配器的 Agent 不跑在本机终端里。`riff`、`mojo`、`remote-runner` 会自动配上同名的会话后端，不用再写 `backendType`。

| `cliId` | 最小配置 | 登录方式 |
|---------|----------|----------|
| `mira` | 只写 `cliId` | 读本机 Mira.app 的登录 Cookie |
| `riff` | `cliId` + `riff.baseUrl` | JWT，或本机 ByteCloud 登录态 |
| `mojo` | 只写 `cliId`，`mojo` 在 PATH 上 | 本机 `mojo auth login`，或注入 JWT |
| `remote-runner` | `cliId`，provider 不叫 `botmux-remote-runner` 时加 `cliPathOverride` | 由 provider 自己负责 |

### Mira App

`botmux setup` 里选 **Mira → Mira App（Web API）**，写成 `cliId: "mira"`。botmux 用内置 runner 调 Mira 的 Web API，不需要装 CLI。

```json
{ "cliId": "mira" }
```

登录：

1. 默认在 macOS 上打开 Mira.app 并登录。botmux 用 `sqlite3` 命令读 `~/Library/Application Support/mira/Cookies` 里的 `mira_session`，所以本机要有 `sqlite3`。
2. 不在 macOS 上，或 Cookie 在别的位置：在 daemon 环境或机器人的 `env` 里设置 `MIRA_COOKIE_HEADER`（完整 Cookie 头）或 `MIRA_SESSION`（只填 `mira_session` 的值），也可以用 `MIRA_COOKIE_DB` 指向 Cookie 库。这些是登录凭据，别发到群里。

找不到 Cookie 时会报「Open Mira.app and sign in」。模型不看 `model` 字段，跟随 Mira 自己的设置。本地 Mir CLI 是另一个适配器，见 [Mir CLI 与 MCP Bridge](#mir-cli-与-mcp-bridge)。

### riff

riff 在云端沙箱里跑 Agent，本机不用装 CLI。`riff.baseUrl` 必填，填你所在环境的 riff 服务地址：

```json
{
  "cliId": "riff",
  "riff": { "baseUrl": "https://riff.example.internal" }
}
```

也可以在 Dashboard 的「Agent 配置」里把 CLI 选成 Riff，在出现的「Riff 后端配置」面板里填。常用的可选字段：

| 字段 | 说明 |
|------|------|
| `model` | 沙箱里用的模型；留空走 riff 默认。机器人顶层的 `model` 对 riff 无效 |
| `reasoningEffort` | `low` / `medium` / `high` / `xhigh`，留空走默认 |
| `sandboxCluster` | 新任务用的沙箱资源池：`boe` 或 `cn` |

登录（每次调用 riff 时按顺序取 JWT）：

1. `riff.jwt` 直接写 token。不推荐：明文保存，而且时效短。
2. `riff.jwtEnv` 指定的环境变量，默认 `RIFF_JWT`。要在 daemon 的启动环境里设置并自己续期。
3. 都不填（推荐）：在跑 daemon 的机器上用同一系统用户登录一次 ByteCloud 系 CLI，botmux 自动读它写在本机的登录态，过期的会跳过。

报 401 时，在 daemon 机器上重新登录一次就行，不用重启。riff 只能在机器人级配置，不能在话题里用 `/t` 临时切过去。

### Mojo

`mojo` 在 PATH 上、并且在本机登录过时，只写 `cliId` 就能用：

```json
{ "cliId": "mojo" }
```

登录二选一：

- 用跑 daemon 的同一系统用户执行 `mojo auth login`。
- 注入 JWT：`mojo.jwt` 直接写 token，或用 `mojo.jwtEnv` 指定读哪个环境变量（默认 `X_JWT_TOKEN`）。注入的 JWT 优先于本机登录态。

工具默认在本机执行；设 `mojo.cloud: true` 改为在云沙箱里执行。模型写在机器人顶层的 `model`。`mojo` 块里不能写 `bin`、`cwd`、`model`、`wrapperCli` 这类字段，会直接报错，要用顶层对应的 `cliPathOverride`、`workingDir`、`model`、`wrapperCli`。

### Remote Runner

Remote Runner 通过 JSONL 协议接任意远端 Agent 平台。botmux 起一个 provider 子进程，provider 负责远端资源和登录：

```json
{
  "cliId": "remote-runner",
  "cliPathOverride": "/opt/example/bin/my-remote-runner"
}
```

- 不写 `cliPathOverride` 时，从 PATH 找 `botmux-remote-runner`。
- 登录凭据由 provider 自己读，用受限权限的文件或部署环境注入，比如在机器人 `env` 里写 token 文件路径。`remoteRunner` 块里不放凭据，写了不认识的字段会被拒绝。
- `remoteRunner` 块是可选的协议预期：

| 字段 | 说明 |
|------|------|
| `expectedProvider` | 握手时核对 provider 名字 |
| `requiredCapabilities` | provider 必须声明的能力，缺了就不启动 |
| `handshakeTimeoutMs` | 握手和 start / resume 等到 ready 的上限，整数，100–300000 毫秒 |
| `operationTimeoutMs` | status / cancel / detach 的上限，整数，100–300000 毫秒 |

`envPolicy.mode: "strict"` 不支持 Remote Runner，启动会失败。协议细节见 [Remote Runner 协议说明](https://github.com/deepcoldy/botmux/blob/master/docs/remote-runner.md)。

## 各 CLI 的补充说明

### 新接入的 CLI 怎么用 {#new-clis}

Grok Build、Reasonix、OpenCode 2、DeepSeek Harness（dsh / dsh-tui）、MiniMax Code（mcode）、MiMoCode、CodeM、ZCode、Doubao 都是内置适配器，不用额外开关。启用步骤和换别的 CLI 一样（见上文[怎么给机器人换 CLI](#怎么给机器人换-cli)）：先在 daemon 的系统用户下装好对应命令并登录，然后把 Bot 的 `cliId` 设成下表的值。

| CLI | `cliId` | 默认命令 |
|---|---|---|
| Grok Build | `grok` | `grok` |
| Reasonix | `reasonix` | `reasonix` |
| OpenCode 2（beta） | `opencode2` | `opencode2` |
| DeepSeek Harness | `dsh` | `dsh`（全屏 TUI 版另设 `dshRuntime: "tui"`，启动 `dsh-tui`，见下文） |
| MiniMax Code | `minimax` | `mcode` |
| MiMoCode | `mimocode` | `mimo` |
| CodeM | `codem` | `codem` |
| ZCode | `zcode` | `zcode` |
| Doubao | `doubao` | `doubao` |

**Forge × TraeX**：想经 Forge 启动 TraeX，在 `botmux setup` 或 Dashboard 的 CLI 菜单里选「Forge x TraeX」，或在 `bots.json` 写 `"cliId": "traex", "cliLaunchMode": "forge-traex"`。botmux 会改用 `forge run --agent traex --agent-args ...` 启动，所以 `forge` 要在 PATH 上。这种启动方式只能配 `cliId: "traex"`，而且不能和 `wrapperCli`、`cliRuntime`、`cliPathOverride`、文件沙盒或 `readIsolation` 一起用，否则配置会被拒绝。

### TraeX 自动模型切换（实验性） {#traex-auto-model}

TraeX 机器人可以把 `model` 设成 `auto`，再给一个有序的模型池。会话从第一个模型开始，遇到排队或额度用完时按顺序换到池里后面的模型。换模型会重启 TraeX 并恢复原会话，不重放已发的输入。

在 Dashboard「Agent 配置」里选 TraeX、勾选「实验功能：自动模型切换」，再排好模型顺序，每个模型可以单独设思考强度和上下文：

![Dashboard 的 TraeX 自动模型切换配置](/img/traex-auto-model-config.png)

对应的 `bots.json`：

```json
{
  "cliId": "traex",
  "model": "auto",
  "traexAutoModel": {
    "enabled": true,
    "models": ["model-a", "model-b"],
    "queueTimeoutMs": 30000
  }
}
```

| 字段 | 说明 |
|------|------|
| `enabled` | 必须是 `true` |
| `models` | 模型池，按顺序。第一个是首选，后面的是备选。只会用这里列出的模型，不能重复，也不能写 `auto` |
| `trigger` | 什么时候换：`capacity`（模型排队，默认）或 `quota`（明确报告额度用完） |
| `queueTimeoutMs` | 持续排队多久才换，5000–300000 毫秒，默认 30000 |
| `switchCooldownMs` | 距上次切换至少隔多久，才会因新的一次排队再换，5000–300000 毫秒，默认 60000 |
| `reselectPerTurn` | 默认 `false`：同一话题后续输入沿用已选模型。设 `true` 时，每条新输入都从首选模型重新开始 |
| `preflightLoadCheck` | 默认 `false`。设 `true` 时，独立的新一轮开始前先查负载，超载就换。只在 `capacity` 模式下可用 |
| `overloadThresholdPercent` | 负载预检的超载阈值，默认 100，负载高于它才算超载 |
| `preflightTimeoutMs` | 负载预检的超时，100–30000 毫秒，默认 8000 |
| `modelSettings` | 按模型单独设置，例如 `{"model-a": {"reasoningEffort": "xhigh", "modelBackendVariant": "max"}}` |

两种切换条件：

- **容量排队（`capacity`）**：持续排队到 `queueTimeoutMs` 后，换到后面第一个负载不超过 100%（或负载未知）的模型。后面的都超过 100% 时，选池里负载最低的一个（同值按池顺序）继续等，不再切换；负载拿不全时依次试到最后，再选排队位置最靠前的那个。
- **额度用完（`quota`）**：只认结构化的额度用完错误，普通 429、排队、网络或认证失败都不会触发。会跳过已知额度用完的模型；全部用完后停止自动重试，下一条独立输入再重新检查。

几点要知道：

- 只对 `cliId: "traex"` 生效。`model` 是 `auto` 但 `traexAutoModel` 缺失或不合法时，botmux 会在日志里告警，并且不给 TraeX 传模型，相当于用 TraeX 自己的默认模型。
- 新话题从首选模型开始。`quota` 模式下，每条新的独立输入都从第一个没用完额度的模型开始，与 `reselectPerTurn` 无关。
- 配置对新启动或重启的会话生效。

### Pi 执行过程气泡

`cliId: "pi"` 的机器人会把 Pi 已写入会话记录的思考、执行说明、工具调用和结果显示在飞书的执行过程气泡里。工具节点显示命令或文件路径，随当前回合收尾；最终答复仍作为回复消息发出。

- 默认开启，沿用 `cotEnabled` 和群里的 `/cot on`、`/cot off`；`/cot show` 显示当前回合已累计的过程。
- 按 Pi 写完整条消息为单位更新：工具调用在执行前出现，结果在工具结束后出现，不逐字显示。
- 历史记录不会重放到新回合的气泡里。

### DeepSeek Harness（dsh）

`cliId: "dsh"` 通过内置 runner 驱动本机的 `dsh` CLI（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)），走 `dsh --profile <name>` 的 SDK JSON-RPC 协议。推理和工具过程会显示在卡片的思考过程里。

**准备工作：**

1. `dsh` 在 PATH 上（或用 `cliPathOverride` 指定）。需要的是 npm 包 `@deepseek-ai/dsh` 提供的 `dsh` 命令；早期版本用的是 Python 包里的 `dsh-jsonrpc-agent`，PATH 上只有旧命令时会报「找不到命令」。
2. 先用原生 `dsh` 完成配置和登录。数据目录是 `$DSH_HOME`，没设时为 `~/.dsh`。
3. profile 默认叫 `botmux`，可用机器人的 `dshProfile` 改，位置是 `$DSH_HOME/profiles/<name>/`。

**profile 不用手工建**：不存在时 botmux 会生成一份最小骨架（`package.json`、空 `cordis.yml`、`cordis.patch.yml`），并调用 `dsh plugin add` 装依赖。默认 patch 会关掉无界面模式下会卡住启动的 Web 相关插件，插入 SDK JSON-RPC 服务；默认的 `botmux` profile 还会装上 `ask_user_question` 提问工具。其余能力沿用 `dsh-base`。

想加社区插件或换模型提供方，直接编辑该 profile 的 `cordis.patch.yml`，botmux 只在文件缺失时创建，不会覆盖。编辑时注意：

- `- insert: [...]` 是**新增**插件；
- 裸的 `- id: X`（没有 `insert`）是覆盖**已存在**插件的配置，id 不存在时会被静默跳过。

**模型怎么选**：先取 profile 组合后的 `agent-default-model`，旧的 `$DSH_HOME/settings.yaml` 里有显式设置时以它为准，都没有时用 `deepseek-official` / `deepseek-v4-flash`。机器人设了 `model` 时只覆盖模型名，提供方仍来自上面的配置。

**其它要点：**

- `DSH_HOME` 只能在 daemon 进程环境里设置；机器人级 `env.DSH_HOME` 会被拒绝，避免 profile 路径分裂。
- 会话记录在 `$DSH_HOME/sessions/botmux/`。同一个 runner 内多轮共享上下文；daemon 重启后开新会话，不续上下文。
- 想用全屏 TUI 而不是 runner：保持 `cliId: "dsh"`，设 `dshRuntime: "tui"`（Dashboard 里也能切）。这时启动的是 `dsh-tui` 命令，模型由 TUI 自己的配置和 `/model` 决定，TUI 自身状态在 `~/.dsh-tui`。
- 模型调用 `ask_user_question` 时会弹飞书问答卡片。TUI 模式下优先用飞书作答，卡片表示不了的问题回退到原生 TUI。要关掉这个桥接，设 `BOTMUX_DSH_ASK_BRIDGE=0` 后重启会话。

### Mir CLI 与 MCP Bridge

`botmux setup` 里选 **Mira → Mir CLI（本地 mircli）**，配置会写成 `cliId: "mir"`（另一项「Mira App（Web API）」是 `cliId: "mira"`）。它在本机执行 `mircli -p --lean`，所以跑 daemon 的同一系统用户要先完成 Mir CLI 的登录和初始化。DevBox、macOS、其它 Linux 规则一样：

- botmux 能找到 `mircli`，或用 `cliPathOverride` 指向它的绝对路径。
- `~/.mira/config.json` 里已有 `device_id`（通常由 `mircli mcp --device-id <id>` 或 Mir CLI 初始化流程写入）。
- `miramcp` 装在 Mir CLI 的标准位置（如 `~/.local/bin/miramcp`），或用 `MIRAMCP_BIN` 指过去。

会话收到消息、调用 `mircli` 之前，botmux 会尽量先拉起 MCP Bridge：

```bash
miramcp run --device-id <device_id>
```

已经在跑（看 `~/.mira/miramcp/miramcp.pid` 和本机 `9801` 端口）就不会重复启动。查看状态：

```bash
mircli mcp status
```

不想自动拉起，二选一：在 `~/.mira/config.json` 里写

```json
{"auto_start_bridge": false}
```

或只对 botmux 进程关闭：

```bash
MIRCLI_AUTO_START_MIRAMCP=0 botmux start
```

### Doubao CLI

`cliId: "doubao"` 桥接本机 Doubao CLI 的交互界面。先在同一系统用户下装好并登录：

```bash
npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org
doubao          # 完成登录，看到输入框后 /exit
botmux setup    # CLI 选 Doubao，再选项目目录
```

`model` 可省略；要指定时填原生 `/model` 里显示的名字。Web 终端里按 **Esc** 可打断当前回合。botmux 默认以 `--permission-mode always_allow` 启动，只给可信用户和项目用。内网安装、限制说明见 [Doubao 使用指南](https://github.com/deepcoldy/botmux/blob/master/docs/doubao.md)。

### Codex App 原生提问

`codex-app` 会话（以及开启了 app-server RPC 的 `codex` 会话）里，模型调用原生 `request_user_input` 时，botmux 会把问题转成飞书问答卡片。你在卡片上选，或在会话里直接文字回复，答案会回到**同一个原生轮次**，不用再发一轮提示。TRAE RPC 也走同一套桥接。

![Codex 原生提问卡片示意](/img/codex-native-user-input-preview.png)

（卡片由真实卡片 JSON 本地渲染，仅作示意。）

**作答规则：**

- 一次请求里的多个问题放在同一张卡里，选项说明随题显示；推荐选项不会自动当答案，要你主动提交。
- 含纯文本题时，整批问题通过会话里的文字回复一次作答。
- 选择题至少要有两个选项；密码类秘密输入题和格式不对的问题会直接失败，不做部分回答。不要在聊天里输入密码等秘密。
- 谁能答沿用现有 Ask 的会话路由和答复权限。

**等待与取消：**

- 最多等一小时。发卡失败、超时、卡片失效或问题表示不了时，会中断原轮次，避免 Agent 拿空答案继续跑。
- 原轮次结束、进程退出或会话关闭后取消等待，迟到的答复不再回传。
- daemon 重启后，这类请求不会自动重试或恢复。

**异步提问（`request_user_input_async`，仅 `codex-app`）：**

- 模型提问后可以继续做别的事；原轮次正常结束后，卡片仍可作答。答案保留原调用 ID 和题号。
- 开启 `codexAppCleanInput`、原轮仍在执行、且支持定向输入时，原提问对象的答复会直接并入原轮；否则在同一线程开新一轮。迟到答案不会并入别的任务。
- 卡片显示「已结束」表示问答已收集完，不代表模型已经读到答案。
- 答复权限：真人发起的轮次，注册时锁定唯一答复人；定时 / 自治轮次允许有发言权限（canTalk）的成员代答，定时任务创建者仍需操作权限（canOperate），静默定时任务不弹卡；文档评论轮次只有原评论人能在私信里答。
- 多张待答卡同时存在时，文字答案要**引用目标卡片**；没引用的消息按普通输入处理，并提示你消歧。
- 待答卡不跨 daemon / runner 重启恢复，也不补发历史提问。

**不走这套桥接的场景**：Workflow 子任务（用 `humanGate` / decision 节点）、没有飞书通道的 API-only 会话、普通终端粘贴模式、App 历史查看服务。原生工具能不能用，最终取决于 Codex 的版本和运行模式。

自测方法：在普通 Codex App 会话里让模型用 `request_user_input` 问一道选择题，确认飞书收到卡片，提交后同一轮继续，并能复述你选的答案。

### Codex App 运行中插话 {#codex-app-steer}

只对 `cliId: "codex-app"` 会话有效，默认可用、飞书侧不用配置：Codex App 正在跑一轮时，你在话题里再发一条消息，它会直接注入**当前这一轮**（Codex 的 turn/steer），而不是排队等这轮做完。插入成功时 Bot 会回一句「收到，引导成功」。适合中途补一句「顺便处理 X」或「别做那个了，改成 Y」。

- 只对真人直接发的消息生效。其它 Bot 发来的消息默认照常排队，要插话得把 `@steer` 写在正文的第一个语义行（可以放在 @ 收件人那一行后面）。
- 插不进去时（比如这一轮刚好在收尾）按普通消息排队，消息不会丢。
- 通过 HTTP API 触发的任务要在 `options` 里显式传 `steer: true`，而且第一轮就要带，见 [API 任务触发](/api-task-trigger)。

### Claude Code 忙闲判定（OSC 7501） {#claude-osc-7501}

自动生效，不用配置。Claude Code 适配器支持 OSC 7501 程序状态协议：CLI 一旦报来第一条合法的状态，「工作中 / 空闲」就以它为准，不再只靠猜终端屏幕内容，卡片状态和「本轮已结束」的判断更准。还没收到状态时仍按屏幕内容判断。Pi、Kimi 适配器也用同一套协议。

## 添加新适配器（贡献者）

1. 在 `src/adapters/cli/` 下新建文件，实现 `CliAdapter` 接口。
2. 在 `src/adapters/cli/types.ts` 的 `CliId` 联合类型里加新 ID。
3. 在 `src/adapters/cli/registry.ts` 加 import、switch case 和 export。
4. 在 `src/adapters/cli/display-names.ts` 的 `CLI_DISPLAY_NAMES` 加显示名（卡片、setup、Dashboard 共用，漏加会编译失败）。
5. 在 `src/setup/bot-config-editor.ts` 的 `CLI_ID_CHOICES` 加序号，**一律追加到末尾**：序号是脚本化 setup 的稳定接口，插队会让老脚本静默选错 CLI。setup 菜单和 Dashboard 下拉会自动跟上。
6. 更新 `README.md` 和 `README.en.md` 的 CLI 列表。

要支持文件沙盒，还要核对 CLI 的状态目录是否正确声明，详见 [`src/adapters/cli/CLAUDE.md`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/CLAUDE.md) 和 [CONTRIBUTING.md](https://github.com/deepcoldy/botmux/blob/master/CONTRIBUTING.md)。
