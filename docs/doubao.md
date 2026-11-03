# Doubao CLI：安装、配置与使用

[English](doubao.en.md) · [返回 README](../README.md)

Botmux 的 `cliId: "doubao"` 桥接本机 **Doubao CLI 的交互式 TUI**，不是直接调用模型 API，也不使用 `-p` 作为日常会话入口。模型、工具、登录态与原生会话由 Doubao CLI 管理；Botmux 负责消息输入、终端展示、最终回复回收和精确续聊。

> 需要包含 Doubao 适配器的 Botmux 构建。若 `botmux setup` 没有 Doubao，或 `/cli doubao` 提示未知 CLI，请先安装包含本次改动的版本；仅安装 Doubao CLI 不会给旧 Botmux 增加适配器。本次实机验收为 macOS 上的 Doubao CLI 2.31.0，不承诺未验证版本的兼容性。

## 1. 安装与首次登录

Botmux 自包含二进制不要求本机 Node；**Doubao CLI 的 npm 安装和 npm launcher 仍需要 Node/npm**，两者不要混淆。先确认 `node --version`、`npm --version` 可运行，再选择一种安装来源，不要同时安装两个包来竞争同一个 `doubao` 命令。

外网安装：

```bash
npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org
```

企业内网安装：先按企业安装说明设置 `DOUBAO_NPM_REGISTRY` 为实际内网 registry URL，再执行。该变量是此安装示例的 shell 输入，**不是 Botmux 或 Doubao 的运行时配置项**；公开仓库不硬编码私有部署域名。

```bash
npm install -g '@bytedance-dev/doubao-cli' \
  --registry="${DOUBAO_NPM_REGISTRY:?请先设置企业内网 npm registry URL}"
```

安装后，在将运行 Botmux 的同一台机器、同一系统用户下检查并登录：

```bash
command -v doubao
doubao --version
doubao --help
doubao
```

在原生终端完成二维码/账号登录，直到出现 `Ask Doubao to do anything` 输入框。先发一个简单问题确认可用，再通过原生 `/exit` 退出。不要把登录凭证或会话目录复制到公开仓库。未登录时 CLI 会停在登录页面，Botmux 不会代替用户完成登录。

## 2. 配置飞书 / Lark Bot

### 新建 Bot（推荐）

```bash
botmux setup
# 在 CLI 选择中选 Doubao，再选择实际项目目录
botmux start
```

setup 的脚本化 CLI 序号为 `35`；日常使用优先按名称选择，不需要手工填写序号。飞书应用、权限与可操作用户按[快速接入指南](https://deepcoldy.github.io/botmux/quickstart)配置。Doubao CLI 账号与飞书应用凭证是两套独立身份。

### 修改已有 Bot

在 Dashboard 的 Bot 配置中选择 Doubao，或修改已有 `bots.json` 条目。默认配置文件为 `~/.botmux/bots.json`；若设置 `BOTS_CONFIG`，以其指向的文件为准。下面是**合并到已有条目的配置片段**，不是可直接替换整个 `bots.json` 的文件；保留原有应用凭证、权限和其他 Bot 条目。

```json
{
  "cliId": "doubao",
  "workingDir": "/absolute/path/to/your/project",
  "model": "Auto"
}
```

把 `workingDir` 替换为已存在、希望 Agent 操作的实际项目绝对路径。`model` 可省略，沿用 Doubao 默认模型；指定时使用原生 `/model` 中当前账号实际可用的**完整显示名**，不是其他 CLI 的模型 ID。模型权限和配额由 Doubao 账号决定。

如 daemon 找不到 `doubao`，可在该条目设置 `cliPathOverride` 为 `command -v doubao` 返回的可执行文件绝对路径。该字段是兼容路径覆盖；不要填写安装命令、额外参数或其他 CLI 的 wrapper。

保存后重启 daemon，使新建会话使用配置：

```bash
botmux restart
```

重启会影响该部署的 Bot，会话配置也不一定改写已启动 CLI 的参数；需要验证新模型/新 CLI 时请新建会话。若运行的是源码 checkout，遵循[仓库运行规范](../AGENTS.md)，不要把另一安装位置的 `botmux` 当成当前 checkout。

## 3. 日常对话、打断与续聊

- 私聊 Bot，或在已配置群/话题中 @ Bot，发送自然语言任务；在同一会话追问即可沿用上下文。
- 多行需求作为一次粘贴提交，不会把每一行拆成独立任务。原生 TUI 的 `Enter` 发送、`Ctrl+J` 换行；大段内容可能显示为 `[Pasted text ...]`，提交时仍会展开原文。
- 在 Web 终端中，物理 **Esc** 确实是 Doubao 的中断键（底部出现 `esc to interrupt` 时按下即停止当前任务并返回输入框），不用 Ctrl+C 替代；中断不撤销已经完成的文件写入或外部操作。**但要让 Botmux 可靠地停止这一轮，优先用卡片上的 ⏹ 停止按钮或发送 `/stop`**（见下条）：Web 终端里手按的物理 Esc 只把按键字节发给 TUI，不经过 Botmux 的停止通道，Botmux 不会把该轮从回复队列中结算，后续快回合的回答可能错挂到被打断的轮。
- 明确「停止这一轮」请用卡片上的 **⏹ 停止按钮**（或发送 `/stop`、卡片快捷键 **^C**）；这些入口既向 TUI 发送中断键，又会把该轮按已停止结算并释放后续消息队列，是推荐的停止方式。卡片快捷键 **Esc** 与 Web 终端的物理 **Esc** 一样，只把 Esc 字节发给 TUI、不经过 Botmux 的停止通道：它用于关闭 `/model` 之类弹窗时不影响任何轮次；但若在**轮次运行中**按下，Doubao 会真的中断任务，而 Botmux 不会结算该轮（与上一条 Web 物理 Esc 的情形相同），需要按下面的补救步骤同步。
- **绕过停止通道的中断（Web 终端物理 Esc、轮次运行中按卡片 Esc 快捷键）后，请在发送下一条消息之前**点一次卡片 **⏹ 停止按钮**（或发 `/stop`）让 Botmux 结算该轮、对齐队列。Botmux 的停止只能结算「当前正在运行的那一轮」：若你已经先发出了下一条消息再补点，结算会落到新的那一轮上，反而丢掉新轮的回答；这时请直接继续对话，不要重复停止。
- 中断语义：经明确停止入口结算的轮次，Doubao 不会写出终态记录，Botmux 也不会把随后落盘的内容当作该轮回复发到飞书。若模型在停止生效前后几乎同时写出了终态回答，那条迟到文本不会补发到飞书（可在 Web 终端回看原生日志，或重新提问）；这与其它结构化桥接 CLI「轮次退休后无主终态不再投递」的行为一致。
- 原生 `/model` 等菜单请在 Web/本机终端操作。飞书中的 `/...` 由 Botmux 路由，不能假定它们都与原生 CLI 同名同义。对尚未启动的会话可用 `/cli doubao` 选择适配器。
- Botmux 自动捕获首次提交对应的原生数字 Session ID，重启后按精确 ID 执行 `doubao --resume`。无 ID、ID 非法、本地记录缺失或提交匹配有歧义时，不会猜测“最近会话”；可能退为新会话并提示恢复失败。
- 在本机手动续聊，使用 Botmux 提供的原生恢复命令（`doubao --resume` 后接原生数字 ID）。**Botmux 会话 UUID 和 Doubao 数字 ID 不是同一回事**，不能互换；不要通过原生 `/new` 等命令绕过 Botmux 的会话管理来轮换当前会话。

## 4. 最终回复、权限与 Skills

### 回复回收

最终文本自动来自 Doubao 的本地原生日志：`assignment.md` 中的用户需求与 `trajectory.jsonl` 中的终态 assistant 回答。工具结果和带 `tool_calls` 的中间旁白不当作最终回答。**不要求模型执行 `botmux send` 才能收到结果**，HTTP wait 模式也通过同一 bridge 返回 `output.content`。

这是依赖原生落盘格式的桥接，不是官方稳定的 transcript API。不要在运行中删除/移动这些日志。Doubao 升级若改变格式，适配器可能需要跟进；中断、异常退出等终态覆盖尚不完整，不能保证每种失败都能返回结构化原因。

### 权限

默认传 `--permission-mode always_allow`，减少远程任务被逐工具审批弹窗阻塞。**这允许 Agent 在所选目录和其获准环境中执行工具**，仅应接入可信用户和项目。Botmux 不额外传 `--dangerously-bypass-approvals-and-sandbox`，也不声称消除 Doubao 自身的安全限制。

`disableCliBypass: true` 时不传上述 `always_allow` 参数，沿用 CLI 自身配置；若 CLI 要求确认，应在 Web/原生终端处理。当前没有为 Doubao 原生审批/问卷专门接入飞书选择卡。

Botmux 注入 `DOUBAO_CLI_NO_UPDATE_CHECK=1`，避免 npm launcher 的更新询问吃掉首条任务。这不等于更新 CLI；升级请在普通终端使用所选来源的安装命令，完成后重新验证。

### Skills 与数据目录

全局原生 Skills 目录为 `~/Doubao/skills`，每个技能放在独立目录的 `SKILL.md` 中。不要把其他 CLI 的 `~/.agents/skills` 目录当成 Doubao 的已验证加载路径。

日志根目录：macOS 为 `~/Library/Application Support/doubao_cli`；Linux 为 `${XDG_DATA_HOME:-$HOME/.local/share}/doubao_cli`。会话位于 `agent_mode/<account>/workspace/.sessions/<native-session-id>/agents/<agent-id>/system/`。其中可能包含完整任务正文和工具输出，应按敏感项目资料保护。登录态和目录路径必须对运行 Botmux 的系统用户可用。

## 5. 不依赖飞书的本机 HTTP 试用

先完成原生登录。用包含本次适配器的 Botmux，在终端 A 前台启动**单独的 loopback-only 服务**；路径替换为实际项目和专用状态目录。此命令不修改现有 `bots.json`，不是公开网络部署示例。

```bash
botmux serve --api-only --port 17891 --bot local_doubao --cli doubao \
  --backend pty --working-dir "$HOME/work/your-project" \
  --state-dir "$HOME/.botmux-doubao-trial"
```

终端 B 检查健康并发起任务：

```bash
curl --fail-with-body http://127.0.0.1:17891/healthz
curl --fail-with-body --max-time 200 \
  http://127.0.0.1:17891/api/trigger \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "source": { "type": "ui", "requestId": "doubao-trial" },
  "target": { "kind": "turn", "botId": "local_doubao" },
  "envelope": {
    "format": "botmux.ui.v1",
    "sourceName": "doubao-trial",
    "trusted": false,
    "payload": {}
  },
  "instruction": "请运行 pwd，并简短回复当前工作目录。",
  "options": { "waitForFinalOutput": true, "timeoutMs": 180000 }
}
JSON
```

成功时检查响应的 `ok: true`、`action: "completed"` 和 `output.content`；**进程已启动或 `/healthz` 成功不等于任务已完成**。继续对话时，将首次响应的 `target.sessionId` 加入下一次请求的 `target`（保持 `kind` 和 `botId`），这是 Botmux 会话 ID，不是 Doubao 原生 ID。保留状态目录，在停止并重新启动同一服务后仍可按该 ID 请求恢复。

示例的 `timeoutMs: 180000` 是调用方等待预算，不是整轮任务上限。遇到 `wait_timeout` 先检查终端/日志：任务可能仍在执行，不要盲目重发会修改文件的任务。停止试用时在终端 A 结束这个前台服务，不要按进程名称批量杀掉其他 Botmux 实例。

## 6. 排错与当前边界

- **找不到 CLI**：核对安装用户、daemon 的 PATH、`command -v doubao` 与 `cliPathOverride`，不要把安装命令当可执行路径。
- **卡在登录页**：在同用户的原生终端完成登录；确认登录的是有可用模型权限的账号。
- **模型启动报错**：在原生 `/model` 确认可用显示名；移除 `model` 验证默认模型。自动模型探测失败时可能退回静态候选，候选不代表账号一定有权限。
- **终端答完但 HTTP 没结果**：检查是不是旧 Botmux 构建，原生日志是否可读、Session ID 是否捕获、CLI 是否改变了落盘格式。不要通过手工改写日志来伪造完成。
- **无法恢复**：核对账号、原生记录与 ID；换机器/换 HOME/删记录后不保证恢复。新建会话比猜测其他会话 ID 更安全。
- **思考等级**：适配器内部接受 `low/medium/high/xhigh/max`，但当前 Bot 配置加载和 `/effort` 能力登记未开放 Doubao；不要依赖 `bots.json.reasoningEffort` 生效。`ultra` 无映射，原生 `none/minimal` 也未暴露为 Bot 配置选项。
- **停止后没收到回答 / 回答串到下一轮**：经卡片 ⏹ 或 `/stop` 停止时，与打断几乎同时写出的迟到终态不会补发，可在 Web 终端查看或重新提问，不属于丢消息。若是用 **Web 终端物理 Esc**、或在**轮次运行中按卡片 Esc 快捷键**打断后出现回答错位（这两个按键不经过 Botmux 停止通道），请在**发送下一条消息之前**补点一次卡片 ⏹ 或发 `/stop` 对齐队列；若已经发出下一条消息，就不要再补点（会结算到新轮），直接继续对话即可。
- **未声明支持**：既有终端 `/adopt` 的 Doubao 专用转写桥接、会话 fork、纯模型零工具（model-only）接口，以及所有原生审批/异常终态。原生 `-p` 会运行 Agent，不等于 model-only。
- **验证范围**：已实测 macOS 的 PTY/tmux 输入、Esc 打断、精确恢复、真实 worker IPC 和 core-only HTTP 最终回复/重启续聊。Linux 路径逻辑有覆盖，但 Linux 原生运行与 bwrap 文件沙箱未实机验收；飞书客户端实际卡片/点击体验不能由本机 HTTP 测试替代。

## 7. 开发者回归验证

使用仓库 `package.json` 钉住的 Bun 版本，在已有正确安装依赖的 checkout 中运行：

```bash
bun run test -- test/doubao-adapter.test.ts test/doubao-transcript.test.ts \
  test/structured-bridge-clis.test.ts test/structured-bridge-spec.test.ts \
  test/cli-id-roster-derivation.test.ts test/local-cli-opener.test.ts
bun run build
BOTMUX_DOUBAO_E2E=1 bun run test:e2e -- \
  test/doubao-input.e2e.ts test/doubao-worker.e2e.ts
```

真机 E2E 需要安装并登录 `doubao`、可用模型额度，以及可运行的 PTY/tmux。测试会执行真实模型/工具任务并创建原生会话记录，不是无副作用 dry-run；不要在生产账号上未经评估就运行。未设置 `BOTMUX_DOUBAO_E2E=1` 时真机用例跳过，不得将“跳过”写成“通过”。构建/单测不等于所有平台的全量验收。
