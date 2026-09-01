# 多 CLI 适配器

botmux 通过适配器桥接不同 CLI / Agent，`bots.json` 里用 `cliId` 选择，一键切换。**本地适配器各自运行进程**（默认 tmux 后端下可 `tmux attach` 进真进程；显式 pty/zellij/herdr 后端另说）；也有少数通过 API / 远端接入的 Agent（如 Mira、riff），不是本地进程。

**适用**：想换底层 CLI、或接一个新工具时查 `cliId` 和它是否吃 `model` 参数。
**不适用**：严格兼容 Codex 的独立发行版、或套 wrapper / 网关（ccr、aiden x claude 等）不需要新适配器——分别见下方 [Codex 兼容发行版](#codex-兼容发行版) 与 [套 wrapper / 网关接入](#套-wrapper--网关接入)。

## 支持的 CLI / Agent

下表为当前内置适配器（`cliId` 的**权威事实源**是 [`src/adapters/cli/registry.ts`](https://github.com/deepcoldy/botmux/blob/master/src/adapters/cli/registry.ts)，随版本增减）：

| `cliId` | CLI / Agent | 接入方式 | 支持 `model` |
|---------|-----|-----|:--:|
| `claude-code` | Claude Code（默认） | 本地进程 | ✅ |
| `codex` | Codex CLI | 本地进程 | ✅ |
| `codex-app` | Codex App | 本地进程（app-server 协议） | |
| `gemini` | Gemini | 本地进程 | ✅ |
| `cursor` | Cursor（cursor-agent） | 本地进程 | ✅ |
| `opencode` | OpenCode | 本地进程 | ✅ |
| `opencode2` | OpenCode 2（beta，`opencode2`） | 本地进程 | |
| `antigravity` | Antigravity（agy） | 本地进程 | |
| `copilot` | GitHub Copilot | 本地进程 | ✅ |
| `grok` | Grok（grok-cli） | 本地进程 | ✅ |
| `kimi` | Kimi Code | 本地进程 | ✅ |
| `kiro-cli` | Kiro | 本地进程 | |
| `pi` | Pi | 本地进程 | |
| `oh-my-pi` | Oh-My-Pi（Pi fork） | 本地进程 | ✅ |
| `aiden` | Aiden | 本地进程 | |
| `coco` | CoCo / Trae（需 ≥ 0.120.32） | 本地进程 | ✅ |
| `traex` | TRAE CLI（traex） | 本地进程 | ✅ |
| `mtr` | MTR | 本地进程 | |
| `hermes` | Hermes | 本地进程 | |
| `genius` | Genius | 本地进程 | ✅ |
| `seed` | Seed（Claude Code fork） | 本地进程 | ✅ |
| `relay` | Relay（Seed 新版） | 本地进程 | ✅ |
| `mira` | Mira APP | API / 远端 | |
| `mir` | Mir CLI（本地 mircli + MCP bridge） | 本地进程 | |
| `riff` | riff | 云 Agent（API） | |
| `dsh` | DeepSeek Harness（dsh CLI） | 本地进程（SDK JSON-RPC） | ✅ |

> `model` 字段只对支持模型参数的适配器生效，其它忽略。Mir CLI 的额外前置（登录 / miramcp）见下方专节。

## DeepSeek Harness（dsh）

`cliId: "dsh"` 通过内置 runner 驱动本机的 `dsh` CLI（[deepseek-harness](https://github.com/deepseekai/deepseek-harness)），走 `dsh --profile <name>` 的 SDK JSON-RPC 协议。前置条件：

1. `dsh` 在 PATH 上（或用 `cliPathOverride` 指定路径）。
2. 已通过原生 `dsh` CLI 完成配置（`~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`）。
3. 目标 profile（默认 `botmux`）的 `cordis.patch.yml` 已配置好社区插件和 LLM provider。

runner 读取 `~/.dsh/settings.yaml` 的 `agent-default-model`（provider + model）传给 initialize RPC；插件组合由 profile 的 `cordis.patch.yml` 完全控制，runner 不再生成 cordis.yml。

会话 JSONL 落在 `~/.dsh/sessions/botmux/`；同一 runner 连接内多轮，daemon 重启后开新会话（不续上下文）。

## Mir CLI 与 MCP Bridge

`botmux setup` 里选择 **Mira -> Mir CLI（本地 mircli）** 后，机器人配置会使用 `cliId: "mir"`。这个适配器通过本机 `mircli -p --lean` 执行，因此需要运行 botmux daemon 的同一系统用户已经完成 Mir CLI 登录和初始化。

BotMux 不需要额外的 DevBox 专属配置；在 DevBox、本地 macOS 或其它 Linux 机器上规则相同：

- `mircli` 能被 botmux 找到，或在机器人配置里用 `cliPathOverride` 指向 `mircli` 的绝对路径。
- `~/.mira/config.json` 里已有 `device_id`。首次使用 Mir CLI 时通常通过 `mircli mcp --device-id <id>` 或 Mir CLI 自身初始化流程写入。
- `miramcp` 已安装在 Mir CLI 的标准位置（例如 `~/.local/bin/miramcp`、`~/.local/bin/mira_cli`），或通过 `MIRAMCP_BIN` 指向可执行文件。

当 `cliId: "mir"` 会话启动并收到消息时，BotMux 会在调用 `mircli` 前 best-effort 拉起 MCP Bridge：

```bash
miramcp run --device-id <device_id>
```

它会先检查 `~/.mira/miramcp/miramcp.pid` 和本机 `9801` 端口，已在运行就不会重复启动。要确认状态，可以在运行 botmux daemon 的同一用户下执行：

```bash
mircli mcp status
```

如果你想禁用这个自动拉起行为，可以任选一种方式：

```json
{"auto_start_bridge": false}
```

或只对 BotMux 进程禁用：

```bash
MIRCLI_AUTO_START_MIRAMCP=0 botmux start
```

## Codex 兼容发行版

BotMux 把“协议能力”和“发行版身份”分开：`cliId: "codex"` 选择 Codex 协议适配器，`cliRuntime` 选择真正运行、独立发版的二进制。这样兼容分支可以复用模型参数、resume、空闲检测与受控 RPC，而不会被当成官方 Codex 检查版本。

适合 `cliRuntime` 的 CLI 必须是**严格兼容分支**：接受 BotMux 传给 Codex 的参数，保留相同的交互状态和 rollout / resume 语义，并使用兼容的认证 / home 布局。如果它修改了参数、TUI 状态机、会话存储或协议，就应贡献一个真实适配器，而不是声明兼容。

完整配置与更新 provider 说明见 [`bots.json` 的 Codex 兼容发行版章节](/bots-json#codex-兼容发行版)。Dashboard 的 Bot 默认设置也可以配置并预检 runtime。旧 `cliPathOverride` 继续兼容，但不会自动开启需要明确兼容声明的 Codex RPC 能力。

## 套 wrapper / 网关接入

很多场景下你不是直接跑原生 CLI，而是套一层网关 / 路由（内网代理 + SSO、模型路由等），比如 `ccr`、`ttadk`、`aiden x claude`、`aiden x codex`。这时**不需要新适配器**：`cliId` 仍填底层真实 CLI（`claude-code` / `codex` …），只把启动入口换成一个 **wrapper 脚本**，用 `cliPathOverride` 指过去（`botmux setup` 编辑机器人时的「CLI 可执行文件路径覆盖」就是填它）。

**通用四步：**

1. **先登录网关**（一次性）：用跑 daemon 的**同一系统用户**完成 SSO 登录，token 缓存在该用户家目录。token 过期会弹交互登录卡住 PTY，注意保持登录态。
2. **写 wrapper 脚本** 放 `~/.botmux/bin/`，把 botmux 传入的参数透传给真实 CLI（注意：有的网关拒收 botmux 注入的 `--settings`，要在脚本里剥掉）。
3. **`chmod +x` 加可执行位（最容易漏！）**——botmux 用 node-pty 直接 exec 脚本，没有可执行位会 `EACCES`、CLI 起来即退、bot 崩溃重启。
4. **直接执行脚本验证**（用 `~/.botmux/bin/xxx --version`，别用 `bash xxx` 测——走 bash 不需要可执行位会掩盖第 3 步问题）。然后在 `bots.json` 配 `cliPathOverride`（写**绝对路径**，别用 `~`），`botmux restart` 生效。

各网关的**具体 wrapper 脚本**通常随上游更新，请以对应 CLI / 网关团队发布的文档为准；这里不在公开仓库内放内部文档链接或复制原文。

- **aiden × claude / aiden × codex** — aiden×codex 需用 `script` 强套 PTY
- **ttadk** — 配置时注意 wrapper 参数透传和登录态
- **MTR** — 社区贡献，`npm i -g @metamove-code/mtr-cli@latest`
>
> 排查 wrapper 问题的通用手法：`botmux logs` 找 `Spawning fresh CLI:` 那行，复制完整命令在本地手动跑一遍即可定位（权限 / 参数黑名单 / 登录态）。

## 添加新适配器（贡献者）

1. `src/adapters/cli/` 下新建文件，实现 `CliAdapter` 接口
2. `src/adapters/cli/types.ts` 的 `CliId` 联合类型加新 ID
3. `src/adapters/cli/registry.ts` 加 import / switch case / export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES`、`card-builder.ts` 的 `cliDisplayNames` 加显示名
5. `src/cli.ts` setup 交互菜单加选项
6. 更新 README

详见 [CONTRIBUTING.md](https://github.com/deepcoldy/botmux/blob/master/CONTRIBUTING.md)。
