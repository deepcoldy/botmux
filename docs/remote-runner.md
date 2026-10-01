# Remote Runner 后端

`RemoteRunnerBackend` 用一个稳定的 JSONL 协议把 BotMux 的消息路由、可信调用者身份和会话生命周期连接到任意远端 Agent 平台。BotMux 不理解云厂商、容器、沙箱或模型运行时；provider 负责这些实现细节，并把可恢复状态作为受限 JSON 返回。

## 配置

```json
{
  "cliId": "remote-runner",
  "backendType": "remote-runner",
  "cliPathOverride": "/opt/example/bin/my-remote-runner",
  "remoteRunner": {
    "expectedProvider": "example-cloud",
    "requiredCapabilities": [
      "start", "resume", "turn", "cancel", "detach", "status",
      "terminal_screen", "terminal_input", "terminal_resize"
    ],
    "handshakeTimeoutMs": 30000,
    "operationTimeoutMs": 20000
  },
  "env": {
    "EXAMPLE_TOKEN_FILE": "/run/secrets/example/token"
  }
}
```

未配置 `cliPathOverride` 时，BotMux 从 `PATH` 查找 `botmux-remote-runner`。`remoteRunner` 只保存协议预期，不应包含 token、cookie 或账号凭据；provider 凭据应通过受限权限文件或部署环境注入。

## 传输与握手

BotMux 启动一个 provider 子进程，通过 stdin 逐行写入命令，通过 stdout 逐行读取事件。每行都是一个完整 JSON 对象，必须携带：

```json
{"protocol":"botmux.remote-runner","version":1,"type":"..."}
```

provider 的 stderr 只用于诊断，不参与协议。stdout 出现未知事件、非法 JSON、版本不匹配、超过 4 MiB 的单行或无关联响应时，BotMux 会关闭该 provider 并按不确定结果处理在途 turn。

启动顺序固定为：

1. BotMux 发送 `hello`，provider 返回同一 `requestId` 的 `hello`，声明 `provider` 和 capabilities。
2. 新会话发送 `start`；有持久化状态时发送 `resume`。
3. provider 返回同一 `requestId` 的 `ready` 和最新 `state` 后，BotMux 才提交首轮输入。
4. 每个 `turn` 必须先返回同一 `requestId` 的 `status: busy`，该 ACK 才表示 provider 已接受执行。
5. provider 用 `progress` 流式输出，并以 `final` 或带 `turnId` 的 `failure` 结束该轮。

### 可选远端终端

provider 可以额外声明三项通用终端能力：

- `terminal_screen`：发送带 `generation`、单调 `sequence`、`cols`、`rows` 的完整 `terminal_screen` 快照。BotMux 会以清屏回原点的方式把快照送入既有终端解析链路，因此飞书流式卡片和本地 CLI 使用同一套 screen renderer。
- `terminal_input`：BotMux 把 Web Terminal 或卡片控制产生的原始终端字节作为 `terminal_input` 命令转发；provider 用同一 `requestId` 的 `status` 确认接收。
- `terminal_resize`：BotMux 把终端列数和行数作为 `terminal_resize` 命令转发；provider 调整远端 PTY/tmux 后以 `status` 确认。

终端能力是显示和人工交互通道，不替代 turn 生命周期。任务是否完成仍必须由 `final` / `failure` 决定；`terminal_screen` 的内容不能被 BotMux 解析成业务终态。每个 screen 都携带远端 compute generation：旧 generation 的迟到画面会被忽略，领先于持久状态的画面会触发 fail-closed。

未配置这些 capability 时，`RemoteRunnerBackend` 保持原来的 headless 行为；默认必需 capability 仍只有 `start`、`resume`、`turn`、`cancel`、`detach` 和 `status`，避免升级 BotMux 后强制旧 provider 同步支持终端。

完整命令与事件联合类型见 [`src/adapters/backend/remote-runner-protocol.ts`](../src/adapters/backend/remote-runner-protocol.ts)。可运行示例见 [`examples/remote-runner/reference-runner.mjs`](../examples/remote-runner/reference-runner.mjs)。

## 持久化状态

```json
{
  "version": 1,
  "provider": "example-cloud",
  "generation": 3,
  "remoteSessionId": "compute-session-42",
  "agentThreadId": "agent-thread-7",
  "providerState": {
    "runtimeSubpath": "sessions/7"
  }
}
```

- `remoteSessionId` 表示当前计算资源，`agentThreadId` 表示 Agent 对话血缘；二者不能合并。计算资源过期后，provider 可以提升 `generation`、更换 `remoteSessionId`，同时保留 `agentThreadId`。
- 同一 generation 不得更换 `remoteSessionId`，generation 不得倒退；BotMux 会拒绝违反单调性的状态。
- `providerState` 是最多 64 KiB、深度受限的普通 JSON。它可以保存恢复定位信息，但不得保存任何凭据。
- provider 可通过 `lineage_changed` 在 turn 执行期间更新状态，也可在 `final`、`ready`、`status` 中附带状态。BotMux 在接受后立即持久化。

## 关闭与进程退出

- 显式关闭使用两阶段流程：BotMux 先发送 `cancel`，收到 `status: closed` 后持久化关闭，再提交本地 worker 退出。取消结果未知时会保持会话和写入门禁，不会伪装成已关闭。
- Daemon 正常退出使用 `detach`：provider 应等待当前 turn 收敛并返回 `status: detached`，不得取消可恢复的远端状态。
- 当前 worker 不存在时，BotMux 不会猜测 provider 的控制面 API，也不会直接把仍为 active 的记录改成 closed；应先恢复同一 provider worker，再执行显式关闭。

## Reference runner

下面的命令可直接观察协议输出；它只回显输入，不访问网络或保存凭据：

```bash
printf '%s\n' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"hello","requestId":"h1","sessionId":"demo","requiredCapabilities":["start","resume","turn","cancel","detach","status"]}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"start","requestId":"s1","sessionId":"demo","cwd":"/tmp"}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"turn","requestId":"t1","turnId":"turn-1","content":"hello"}' \
  | node examples/remote-runner/reference-runner.mjs
```

它用于协议联调和测试，不是生产远端执行器。
