# MiniMax Code（mcode）

Botmux 的 `cliId: "minimax"` 使用官方 MiniMax Code（npm 包 `@minimax-ai/code`，可执行文件 `mcode`），替换原来的纯聊天 mmx-cli。setup 序号 `30` 保持稳定。

## 安装和登录

按 [MiniMax 官网快速开始](https://agent.minimax.cn/docs/cli/quick-start)安装：

```bash
curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash
mcode --version
mcode login                    # 国内账号
# mcode login --region global  # 国际账号
```

官方安装器会准备兼容的 Node.js。手动 npm 安装需 Node 22.19+（22.x）、24.2+、25 或 26。首次登录需要浏览器；Botmux 不复制 mmx 的登录态。也可按[官方配置与模型文档](https://agent.minimax.cn/docs/cli/configuration)配置 MiniMax API Key 或自定义 Provider。

```json
{
  "cliId": "minimax",
  "model": "minimax/MiniMax-M3",
  "env": { "MINIMAX_DATA_DIR": "/absolute/path/to/mcode-data" }
}
```

`model` 可省略，沿用 mcode 默认模型；自定义模型使用原生 `provider/model[#variant]` 格式。旧配置中 `MiniMax-*` 裸模型名会转为 `minimax/<模型名>`。API Key 账号应使用其实际 Provider ID，可由 `mcode provider list --json` 查看。旧 `cliPathOverride` 若指向 mmx，须清除或改为 mcode；不保留 mmx 兼容入口。

数据根默认 `~/.minimax`，`MINIMAX_DATA_DIR` 优先于兼容变量 `MAVIS_DATA_DIR`。目录包含 config.yaml、登录态、SQLite 和会话，文件沙盒会保留整个目录；全局 Skills 位于 `<data-dir>/skills`。不同账号/区域使用独立的绝对路径，并在对应数据目录下分别登录。自定义安装目录需在文件沙盒 policy 中允许读取安装依赖及运行时。

## 执行与恢复

接入使用常驻 Botmux runner，每条消息通过 stdin 交给原生 `mcode exec --output-format stream-json --input -`，保留多行文本，不把用户正文拼进 shell 或命令参数。mcode 仍可读写文件、执行 Shell、加载原生 Skills/插件，并执行 `botmux send`；网页终端展示流式文本和工具进度。

第一轮从原生事件取得 Session ID，后续轮次和重启后的第一轮均指定 `--session <id>`。不使用 `--continue`，避免同目录多个话题串线。缺失精确 ID 时启动新会话并沿用 Botmux 的恢复失败提示。仅收到成功 `exec.completed` 且子进程正常退出后交付最终回复；非零退出、协议不完整和超时均报告失败。Ctrl+C 中断当前任务；runner 退出会回收其原生进程组。会话关闭卡中的 `mcode --session <id>` 可在原数据目录下进入 TUI。

默认使用 `--permission full`，`disableCliBypass: true` 时使用原生 `smart` 策略。mcode headless 无法处理需人工确认的权限面板或问卷；遇到这类请求会明确失败，用户可进入 TUI/ACP 处理后继续。`reasoningEffort` 转为原生 `--effort`，是否支持由目标模型原生校验。当前 exec 入口不支持 Botmux 的会话 fork，明确拒绝此操作。

本次升级影响 `minimax` 的 PTY/tmux 普通话题和恢复会话，并增加 runner 的编译态入口；其余 CLI 的参数与输入方式不变。MiniMax TTS/语音配置不受影响。

原来的 mmx model-only 实现已移除。mcode 的 Agent exec 尚未验证零工具和隔离认证契约，因此 model-only API 明确返回不支持，避免把完整 Agent 当作纯推理调用。

协议依据：[官方 Headless 与 CI](https://agent.minimax.cn/docs/cli/automation)、[官方命令参考](https://agent.minimax.cn/docs/cli/reference)及 [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)。验收版本为 mcode 0.6.5（2026-10-10 官方 npm latest）。

## 验证

```bash
bun x vitest run --project unit test/minimax-runner.test.ts test/cli-adapters.test.ts test/cli-runner-compiled-entries.test.ts test/cli-id-roster-derivation.test.ts test/ipc-constrained-invocation.test.ts test/worker-app-runner-control-wiring.test.ts test/worker-pipe-initial-screen-order.test.ts test/runner-control-channel.test.ts test/constrained-invocation.test.ts test/model-only-print.test.ts
BOTMUX_MCODE_E2E_BIN=/absolute/path/to/mcode bun x vitest run --project e2e test/minimax-mcode.e2e.ts
BOTMUX_MCODE_SANDBOX_E2E=1 BOTMUX_MCODE_E2E_BIN=/absolute/path/to/mcode bun x vitest run --project e2e test/minimax-mcode.e2e.ts
bun run build
```

原生测试使用隔离 HOME/数据目录及本地合成 OpenAI 服务，实际执行 Bash 写文件，检查 Shell owner 身份和第二轮原生历史。Linux 文件沙盒场景用 node-pty 拉起真实 mcode，保持运行超过 90 秒，再验证同一会话恢复。合成服务只验证原生协议和工具闭环，真实 MiniMax 账号、订阅及服务端模型仍需登录后验证；macOS 未作本机运行验收。
