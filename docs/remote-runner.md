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
      "start", "resume", "turn", "cancel", "detach", "reattach", "status",
      "terminal_screen", "terminal_input", "terminal_resize", "outbound_message",
      "session_tool"
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

`handshakeTimeoutMs` 同时约束 `hello` 和后续 `start` / `resume` 到 `ready` 的等待窗口。若 `resumeMode: "rebuild"` 会同步创建并初始化远端资源，部署方应按该路径的实际耗时显式放宽这个有界配置（允许范围 100–300000 ms）；超时会 fail closed，BotMux 不会把未 ready 的 provider 当成已恢复。

`envPolicy.mode: "strict"` 不支持 `remote-runner`：BotMux 可以收窄本机 provider 子进程的环境，但无法证明 provider 背后的远端进程同样满足 strict 环境契约，因此启动会 fail closed。

## 传输与握手

BotMux 启动一个 provider 子进程，通过 stdin 逐行写入命令，通过 stdout 逐行读取事件。每行都是一个完整 JSON 对象，必须携带：

```json
{"protocol":"botmux.remote-runner","version":1,"type":"..."}
```

provider 的 stderr 不参与协议；BotMux 只累计其字节数用于错误摘要，不转发或保存正文。stdout 出现未知事件、非法 JSON、版本不匹配、超过 4 MiB 的单行或无关联响应时，BotMux 会关闭该 provider 并按不确定结果处理在途 turn。

启动顺序固定为：

1. BotMux 发送 `hello`，provider 返回同一 `requestId` 的 `hello`，声明 `provider` 和 capabilities。
2. 新会话发送 `start`；有持久化状态时发送 `resume`。
3. provider 返回同一 `requestId` 的 `ready` 和最新 `state` 后，BotMux 才提交首轮输入；`ready.requestId` 必填。
4. 每个 `turn` 必须先返回同一 `requestId` 的 `status: busy`，该 ACK 才表示 provider 已接受执行。
5. provider 用 `progress` 流式输出，并以 `final` 或带 `turnId` 的 `failure` 结束该轮。

如果 provider 在 `status: busy` 前就能确定该轮失败，应返回携带原 `requestId` 的 `failure`；
`turnId` 可以同时携带，也可以由 BotMux 从原命令精确恢复。这个结果是已关联的明确失败，不会被当作
ACK 超时或未知执行结果，且不会毒化后续 turn。

`resume.resumeMode` 区分两种恢复：缺省或 `reattach` 表示 daemon/worker 重启后接管仍存活的远端资源；
`rebuild` 表示用户显式关闭后重新打开，旧远端资源已被取消，provider 必须创建新资源、推进
`generation`，并在可能时保留 `agentThreadId`。BotMux 会拒绝未推进 generation 的 rebuild `ready`。

`status: busy` 前不得发送 `progress`、`outbound_message`、`session_tool` 或 `final`。ACK 后的终态 `failure`
必须携带 `turnId`；可以同时重复原 turn 的 `requestId`，但该值必须精确匹配。只带 `requestId`
的 post-ACK failure 不足以作为终态关联依据，会被视为协议错误。

`hello.capabilities` 是可扩展字符串集合。BotMux 只检查配置声明的
`requiredCapabilities`，对名称合法但当前版本未知的 provider capability 保持透传和忽略，
使 provider 可以在不破坏旧客户端的情况下增加能力。未知事件类型仍会按协议错误关闭。

`detach` 与 `reattach` 共同构成默认生命周期能力：当持久化阶段失败时，
BotMux 会发送 `reattach`，且只有收到同一 `requestId` 的 `status: ready` 后才重新开放写入。
显式配置旧 capability 子集但缺少 `reattach` 的 provider 会在发送 `detach` 前被拒绝，避免本地恢复后远端仍保持 detached。

`start` / `resume` 可选携带 `model`、`modelBackendVariant`（`standard|max`）和
`reasoningEffort`。这些字段是 Bot 默认值或新 Session 启动覆盖，provider 应只在
底层运行时明确支持时使用；缺省时保持 provider 自身默认。三项都是 v1 additive
字段，旧 provider 可以忽略。

Remote Runner 的 reasoning 选择使用 BotMux 通用的 `low|medium|high|xhigh|max|ultra`
词表，不套用某个本地 CLI 的模型表；provider 负责接受、忽略或用结构化 `failure` 拒绝不支持的组合。

### 可选远端终端

provider 可以额外声明三项通用终端能力：

- `terminal_screen`：发送带 `generation`、单调 `sequence`、`cols`、`rows` 的完整 `terminal_screen` 快照。BotMux 将它作为有界的当前 viewport 替换，而不是追加到 Web Terminal scrollback；因此刷新和滚动不会堆叠重复 TUI 帧，刷新成本也不随 Session 历史增长。飞书流式卡片和本地 CLI 继续使用同一套 screen renderer。
- 只读 Web Terminal 是远端屏幕的 follower：BotMux 按 provider 上报的 `cols` / `rows` 固定其本地网格，并忽略它发来的 resize，避免仅查看页面就改变共享远端 TUI 和后续卡片截图。持有写 capability 的终端仍保留本地 BotMux 一致的响应式 resize 语义。
- `terminal_input`：BotMux 把 Web Terminal 或卡片控制产生的原始终端字节与当前 `generation` 作为 `terminal_input` 命令转发；provider 只接受与当前 compute generation 相同的输入，并用同一 `requestId` 的 `status` 确认接收。
- `terminal_resize`：BotMux 把终端列数、行数和当前 `generation` 作为 `terminal_resize` 命令转发；provider 只调整同一 generation 的远端 PTY/tmux，再以 `status` 确认。

终端能力是显示和人工交互通道，不替代 turn 生命周期。任务是否完成仍必须由 `final` / `failure` 决定；`terminal_screen` 的内容不能被 BotMux 解析成业务终态。每个 screen 都携带远端 compute generation：旧 generation 的迟到画面会被忽略，领先于持久状态的画面会触发 fail-closed。

未配置这些 capability 时，`RemoteRunnerBackend` 保持原来的 headless 行为；默认必需 capability 为 `start`、`resume`、`turn`、`cancel`、`detach`、`reattach` 和 `status`，避免升级 BotMux 后强制旧 provider 同步支持终端。

完整命令与事件联合类型见 [`src/adapters/backend/remote-runner-protocol.ts`](../src/adapters/backend/remote-runner-protocol.ts)。可运行示例见 [`examples/remote-runner/reference-runner.mjs`](../examples/remote-runner/reference-runner.mjs)。

### 可选主动消息

声明 `outbound_message` 后，provider 可以在一个仍为 active 的 turn 内请求 BotMux 向该 turn 的当前会话位置发送非终态正文。该能力只表达内容和寻址意图，不接受 chat、topic root、Bot 身份或任意用户 ID；真实路由、mention 门禁、卡片渲染、hook 和平台调用继续由 BotMux 的普通 `send` 链路负责。

```json
{
  "type": "outbound_message",
  "operationId": "progress-1",
  "turnId": "turn-1",
  "generation": 3,
  "content": "已完成依赖检查，继续执行验证。",
  "responseKind": "progress",
  "mention": "none"
}
```

- `content` 使用 BotMux Markdown；普通文本是其子集，单条最多 32 KiB。
- `responseKind` 仅允许 `progress|auxiliary`，不能借此声明 turn 最终完成；`final|failure` 仍是唯一终态。
- `mention` 仅允许 `none|requester`。`requester` 仍要通过当前 turn 的精确回复对象与多参与者门禁，provider 不能提供 open_id。
- `turnId` 必须等于 active turn，`generation` 必须等于当前 backend state；迟到或跨代事件会 fail-closed。
- `operationId` 在单 turn 内幂等：同 key 同 payload 复用第一次结果，同 key 不同 payload 被拒绝；每 turn 最多接受 10 个不同 operation。

BotMux 完成宿主侧尝试后会写回 `outbound_message_result` 命令：

```json
{
  "type": "outbound_message_result",
  "requestId": "outbound-message-result:...",
  "operationId": "progress-1",
  "turnId": "turn-1",
  "generation": 3,
  "result": { "outcome": "delivered", "messageId": "om_xxx" }
}
```

结果为 `delivered|rejected|unknown`。`unknown` 表示平台可能已经接受消息但 BotMux 无法证明结果，provider 必须把它交给调用方且不得自动重放。结果命令本身是一次宿主到 provider 的结算通知，不要求 provider 再发 ACK；provider 无法把结果交给远端调用方时，应以当前 turn 的 `failure` 明确收口。

主动消息写入独立的非终态发送标记，不会代替或抑制随后正常到达的 turn `final/failure`。该 capability 同样不属于默认必需集合，只有显式配置它的部署才会在握手时要求 provider 支持。
成功 `final` 必须等待当前 turn 的所有 `outbound_message_result` 和 `session_tool_result` 写回；失败终态立即收口，迟到结果不会影响后续 turn。

### 可选只读 Session 工具

声明 `session_tool` 后，provider 可以在 active turn 内请求 BotMux 宿主执行一组固定的只读 Session helper。provider 不能传 argv、环境变量、可执行文件、Session ID、Chat、Topic 或 Bot；BotMux 把结构化请求翻译为当前 worker/turn 绑定的本机构建 CLI，并继续复用原有 transport、权限和审计门禁。

当前 allowlist：

- `history`：`limit` 限制为 `1..100`，`scope` 只允许 `session|thread|chat|ambient`，可选 `withCardJson`。
- `quoted`：只接受合法 `om_` message id 和可选 `raw`；下载的附件经宿主 attachments 根校验后，以最多 8 个、合计最多 512 KiB 的有界 payload 回传。
- `bots.list`：固定为当前群 `chat` scope，不开放跨团队发现或邀请。
- `skill.list|show|read|resources`：沿用当前 Session 的 skill manifest 和内置技能；resource path 必须是无 `.` / `..` 的安全相对路径。

不属于 allowlist 的 schedule、ask、handoff、workflow、改名、管理或其他写操作在协议层无法表达。provider 也不能通过该能力扩大 `outbound_message` 的寻址、附件、加急、attention 或 final 能力。

```json
{
  "type": "session_tool",
  "operationId": "history-1",
  "turnId": "turn-1",
  "generation": 3,
  "request": {
    "tool": "history",
    "limit": 20,
    "scope": "thread",
    "withCardJson": true
  }
}
```

宿主完成后写回 `session_tool_result`：

```json
{
  "type": "session_tool_result",
  "requestId": "session-tool-result:...",
  "operationId": "history-1",
  "turnId": "turn-1",
  "generation": 3,
  "result": {
    "outcome": "completed",
    "exitCode": 0,
    "stdout": "{\"total\":1}\n",
    "stderr": ""
  }
}
```

`completed` 保留 CLI 的确定性 `exitCode/stdout/stderr`；宿主执行器启动失败、超时或无法证明结果时返回 `unknown`，安全门禁拒绝则返回 `rejected`。同一 turn 最多执行 30 个不同 operation；同 operation id 同 payload 复用首次结果，不同 payload 被拒绝。`turnId`、`generation` 和成功 `final` 的结算顺序与 `outbound_message` 使用同一套 fencing。

### 可选运行用量

provider 可以在 `final` 事件上附带可选 `usage`，把远端运行时已经确认的上下文、累计 token、单轮 token 和实际模型交给 BotMux：

```json
{
  "type": "final",
  "turnId": "turn-1",
  "content": "done",
  "usage": {
    "generation": 3,
    "snapshot": {
      "context": { "usedTokens": 7274, "windowTokens": 258400, "percentUsed": 3 },
      "tokens": { "in": 7230, "out": 44 },
      "turnTokens": { "in": 7230, "out": 44 },
      "model": "example-model",
      "reasoningEffort": "high"
    }
  }
}
```

- `generation` 必须等于当前远端 compute generation；旧 generation 的快照会被拒绝。
- `context` 和 `tokens` 必须显式为对象或 `null`。缺失指标保持缺失，不得由 provider 估算。
- BotMux 严格校验非负整数、上下文百分比和运行时标签，然后把快照交给普通卡片的同一套 usage renderer。
- 这是 v1 的可选 additive 字段：旧 provider 不上报时行为不变，旧 BotMux 会忽略该字段，因此无需增加 capability 或升级协议版本。
- 最近一次通过校验的快照会随 Session 持久化；远端 generation 前进时自动清除，避免恢复后显示旧计算资源的数据。

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
- 普通 daemon/worker 重启发送 `resumeMode: "reattach"`（省略时同义），允许接管仍存活的远端资源；用户显式关闭后点击恢复发送 `resumeMode: "rebuild"`，provider 必须新建远端资源并在 `ready` 中推进 `generation`。Node worker 或其 Remote Runner backend 在新的 ready state 落盘前退出时，BotMux 会在远端 lineage 未变化的前提下把逻辑 Session 恢复为 closed，并回收仅剩的本地 worker；若 lineage 已变化则保持保护状态并要求显式对账，不能伪装成恢复成功。

## 关闭与进程退出

- 显式关闭使用两阶段流程：BotMux 先发送 `cancel`，收到 `status: closed` 后持久化关闭，再提交本地 worker 退出。取消结果未知时会保持会话和写入门禁，不会伪装成已关闭。
- Daemon 正常退出使用 `detach`：provider 应等待当前 turn 收敛并返回 `status: detached`，不得取消可恢复的远端状态。
- 默认最多等待 active remote turn 12 秒。运行长任务的部署可以设置 provider-neutral 的 `BOTMUX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS`（12,000 到 86,400,000 毫秒）；BotMux 会把同一 drain deadline 传给 Remote Runner backend，并同步派生 daemon、fleet supervisor 和 CLI 的外层等待预算，避免普通 provider operation timeout 或任一外层 supervisor 提前截断 active turn。provider 发出 `final` 只表示模型执行完成，daemon 还会在提交 detach 前等待对应的用户可见最终回复完成投递；这段固定 20 秒的 delivery drain 预算同样包含在全部外层预算中，避免 worker 退出后首个发送尝试才发现原 generation 已失效。该配置只控制正常退出的 active-turn 等待时间，不改变 turn 自身超时，也不会把取消作为超时后的兜底行为。进程编排层的 termination grace 必须大于派生出的 fleet hard-stop 预算。
- 如果 shutdown 在持久化阶段失败，BotMux 使用 `reattach` 回滚已经确认的 `detach`；回滚没有得到
  `status: ready` 时继续保持写入门禁，不把未知状态伪装成已恢复。
- 当前 worker 不存在时，BotMux 不会猜测 provider 的控制面 API，也不会直接把仍为 active 的记录改成 closed；应先恢复同一 provider worker，再执行显式关闭。

## Reference runner

下面的命令可直接观察协议输出；它只回显输入，不访问网络或保存凭据：

```bash
printf '%s\n' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"hello","requestId":"h1","sessionId":"demo","requiredCapabilities":["start","resume","turn","cancel","detach","reattach","status"]}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"start","requestId":"s1","sessionId":"demo","cwd":"/tmp"}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"turn","requestId":"t1","turnId":"turn-1","content":"hello"}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"detach","requestId":"d1"}' \
  '{"protocol":"botmux.remote-runner","version":1,"type":"reattach","requestId":"r1"}' \
  | node examples/remote-runner/reference-runner.mjs
```

它用于协议联调和测试，不是生产远端执行器。
