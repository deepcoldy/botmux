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

数据根默认 `~/.minimax`，`MINIMAX_DATA_DIR` 优先于兼容变量 `MAVIS_DATA_DIR`。目录包含 config.yaml、登录态、SQLite 和会话，文件沙盒会保留整个目录；全局 Skills 位于 `<data-dir>/skills`。不同账号/区域使用独立的绝对路径，并在对应数据目录下分别登录。

文件沙盒自动识别两种安装布局：官方安装器的 `install.json` 根目录，以及 npm 全局安装中真实可执行文件所属的 `@minimax-ai/code` 包根（通过最近的 `package.json` 校验）。官方安装根或 npm 包及其内部依赖只读挂载，不扩大到整个全局 npm 目录；仅数据目录和官方 `.mcode-active` 标记目录可写。官方安装器若复用安装根外的 Node，还会按 `install.json` 的 `nodeExecutable` 加入运行时可执行目录的只读覆盖。npm 布局则解析当前/机器人配置 PATH 中的 Node 并传给 runner，在沙盒内使用同一个真实运行时；Bun 启动 Botmux 时也仍需安装兼容的 Node。未知的自定义包装布局需自行在文件沙盒 policy 中允许读取安装依赖及运行时。

适配器的 `buildArgs` 同时承担启动准备：在 worker 对沙盒 bind 源进行存在性过滤前，预建数据目录与官方 `.mcode-active`。这是首次启动持久化所需的顺序，不能延迟到沙盒内的 runner；准备步骤幂等，不覆盖既有会话数据。

## 执行与恢复

接入使用常驻 Botmux runner，每条消息通过 stdin 交给原生 `mcode exec --output-format stream-json --input -`，保留多行文本，不把用户正文拼进 shell 或命令参数。mcode 仍可读写文件、执行 Shell、加载原生 Skills/插件，并执行 `botmux send`；网页终端展示流式文本和工具进度。

第一轮从原生事件取得 Session ID，后续轮次和重启后的第一轮均指定 `--session <id>`。不使用 `--continue`，避免同目录多个话题串线。缺失精确 ID 时启动新会话并沿用 Botmux 的恢复失败提示。仅收到成功 `exec.completed` 且子进程正常退出后交付最终回复；非零退出、协议不完整和超时均报告失败。Ctrl+C 中断当前任务；runner 退出会回收其原生进程组。会话关闭卡中的 `mcode --session <id>` 可在原数据目录下进入 TUI。

默认使用 `--permission full`，`disableCliBypass: true` 时使用原生 `smart` 策略。mcode headless 无法处理需人工确认的权限面板或问卷；遇到这类请求会明确失败，用户可进入 TUI/ACP 处理后继续。`reasoningEffort` 转为原生 `--effort`，是否支持由目标模型原生校验。当前 exec 入口不支持 Botmux 的会话 fork，明确拒绝此操作。

runner 忽略坏帧及非协议输入，后续合法消息仍可执行。输入缓冲区超过 `4 * 1024 * 1024` 字符时报告错误并关闭 runner；SIGTERM 也会关闭 runner，两者均清空待执行队列并中断当前原生进程，不发送成功 final。

本次升级影响 `minimax` 的 PTY/tmux 普通话题和恢复会话，并增加 runner 的编译态入口；其余 CLI 的参数与输入方式不变。MiniMax TTS/语音配置不受影响。

原来的 mmx model-only 实现已移除。mcode 的 Agent exec 尚未验证零工具和隔离认证契约，因此 model-only API 明确返回不支持，避免把完整 Agent 当作纯推理调用。

协议依据：[官方 Headless 与 CI](https://agent.minimax.cn/docs/cli/automation)、[官方命令参考](https://agent.minimax.cn/docs/cli/reference)及 [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)。验收版本为 mcode 0.6.5（2026-10-10 官方 npm latest）。

## 验证

```bash
bun x vitest run --project unit test/minimax-runner.test.ts test/cli-adapters.test.ts test/cli-runner-compiled-entries.test.ts test/cli-id-roster-derivation.test.ts test/ipc-constrained-invocation.test.ts test/worker-app-runner-control-wiring.test.ts test/worker-pipe-initial-screen-order.test.ts test/runner-control-channel.test.ts test/constrained-invocation.test.ts test/model-only-print.test.ts
BOTMUX_MCODE_E2E_BIN=/absolute/path/to/mcode bun x vitest run --project e2e test/minimax-mcode.e2e.ts
BOTMUX_MCODE_SANDBOX_E2E=1 BOTMUX_MCODE_E2E_BIN=/absolute/path/to/mcode bun x vitest run --project e2e test/minimax-mcode.e2e.ts
BOTMUX_MCODE_TMUX_E2E=1 BOTMUX_MCODE_E2E_BIN=/absolute/path/to/mcode bun run test:e2e -- test/minimax-tmux.e2e.ts
bun run test -- test/pty-reader-compat.test.ts
bun run build
```

原生测试使用隔离 HOME/数据目录及本地合成 OpenAI 服务，实际执行 Bash 写文件，检查 Shell owner 身份和第二轮原生历史。Linux 文件沙盒场景用真实 PTY 拉起 mcode，保持运行超过 90 秒，再验证同一会话恢复；Node 和 Bun 直接驱动均已通过。tmux 测试通过 daemon 使用的 `TmuxPipeBackend` 验证工具、owner、用量回传以及销毁并重建 runner 后按精确 ID 恢复历史，Node 和 Bun 均已通过。该测试仅销毁自己创建的唯一命名会话，不操作共享 tmux server 或其它会话。

Bun 的 `tty.ReadStream` 会将非阻塞 PTY 暂时无数据产生的 `EAGAIN` 当作读失败，关闭 master 并导致子进程收到 SIGHUP。公共 `utils/pty.ts` 仅为 Bun Unix 的单个 reader 重试 `EAGAIN`/`EWOULDBLOCK`/`EINTR`，保留 node-pty 的编码、输入、resize、暂停/恢复与退出逻辑；Node 和 Windows 沿用原始 reader。回归测试在 Node/Bun 下覆盖空闲间隔、跨块 UTF-8、交互输入、resize、主动中断和大块输出暂停/恢复。

Linux 上已使用登录的真实 MiniMax OAuth 账号验证服务端 `MiniMax-M3.1-Flash-Preview`：两轮 Shell 文件工具执行、原生精确 ID 恢复和用量回传通过。真实服务的 tmux 完整流程也已通过：首轮工具写文件及 owner 透传，销毁旧 runner 并确认新 runner 的 PID 改变，再指定同一原生 ID 恢复；第二轮不读取验证文件，仅从会话历史回忆首轮随机标识并写出相同结果，两轮 final 的 turnId 和用量回传均正确。macOS 未作实机运行验收。
