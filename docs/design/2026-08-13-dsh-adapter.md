# dsh (deepseek-harness) Adapter 实施方案

日期：2026-08-13
状态：已实现（v1）
作者：Monday（AI）

> 2026-08-14 更新：v2 的跨重启 resume/取消经评审回退。dsh SDK server 的 `createSession` 走 `agents.create`，
> 不调用 `agents.resume`；持久化层拒绝用同 ID 覆盖已有日志。稳定 sessionId 会导致重启后首个 prompt 永久失败。
> 跨重启 resume 需要 dsh 上游提供 create-or-resume 能力，列为已知限制。

## 1. 背景与目标

让 botmux 支持把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）作为群机器人的 agent 后端：飞书群 @ 机器人 → dsh 执行 → 结果回群，支持同会话多轮。

dsh 是 DeepSeek 开源的 agent harness（cordis 插件架构，opencode 血统），当前版本 `0.1.0-rc.5`。它**没有 TUI**，shipped 的只有 web/headless 两个 profile，但天生为"被程序驱动"设计，提供 stdio JSON-RPC 接口。

## 2. 调研结论（关键事实）

### 2.1 botmux 侧

- 主流 adapter（kimi/gemini/…）是 PTY 驱动 TUI：打字进 stdin、静默检测判 turn 结束、agent 自己执行 `botmux send` 回消息。**dsh 没有 TUI，这条路不适用。**
- botmux 已有 **runner 型 adapter** 模式（codex-app/mira/mir）：spawn 一个小 Node runner，runner 对 botmux 说输入帧协议 + OSC 控制帧，对真实 agent 说原生协议。thin adapter 仅 ~120 行（`src/adapters/cli/codex-app.ts`），重活在 runner。
- 输入帧协议（`src/adapters/cli/runner-input.ts`）：botmux 写 `::botmux-<id>:<base64(JSON)>\n`，`writeRunnerInput` 负责分块（1024B/块、20ms 节流）、pre-flush、提交重试，返回 `{submitted, submissionDisposition}`。
- 回包通道（`src/adapters/cli/runner-control-channel.ts`）：runner 在 stdout 混 OSC 帧 `\x1b]777;botmux:<kind>:<base64>\x07`。worker 对 `final` 帧有通用投递路径（`src/worker.ts:8401`，mira/mir 走 8483 的 else 分支），`final` 的 `content` 即投递到飞书的最终文本。
- 新 adapter 注册点：`types.ts` CliId、`registry.ts` 三处、`worker.ts` CLI_DISPLAY_NAMES、`card-builder.ts` cliDisplayNames、`bot-config-editor.ts` CLI_ID_CHOICES（只能尾部追加）、`test/cli-adapters.test.ts` ALL_CLI_IDS、README/docs。

### 2.2 dsh 侧

- 有打包好的单文件 runtime **`dsh-jsonrpc-agent`**（`python/sdk-runtime`，wheel 自带，目标机无需 Node），说 **SDK JSON-RPC 协议**（`packages/sdk/protocol/src/types.ts`）：
  - 请求 3 个：`initialize {cwd, provider, model, maxTokens?}` → `{serverInfo}`；`session/prompt {sessionId, contentBlocks}` → `{messageId}`（入队回执，**不是最终结果**）；`shutdown`。
  - 通知 4 个：`session.event {sessionId, event}`（完整事件流）、`session.status {sessionId, status: 'idle'|'running'}`、`subagent.started`、`subagent.finished`。
  - session 语义：`sessionId` 由客户端指定，未知 id 懒创建；**同一连接内**复用 id 即多轮（server 内存 Map 持有 agent）。
- runtime 启动**必须显式给配置**（`$DSH_CORDIS_CONFIG` 或 argv 位置参数）。wheel 默认 `cordis.yml` 含：jsonrpc-server + agent-spine + llm-deepseek + JSONL 持久化 + checkpoint 策略 + 本地 bash + 本地 fs。会话根目录 `$DSH_SESSION_ROOT`（默认进程 cwd 下 `./.sessions`），工作目录 `$DSH_CWD`。
- 模型鉴权：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 环境变量。
- 事件信封（session.event 的 event）：`{type, seq, time, data}`，type 包括 `turn/start`、`turn/end`（data.reason.kind）、`assistant/message`（data.message.content 块：text/reasoning/tool-call，data.usage）、`tool/call`、`tool/result`、`assistant/chunk` 等。
- **SDK 协议没有 cancel**；没有权限请求（权限由配置侧决定）；不支持图片（只收 text 块）。
- ACP server 也存在（`packages/acp`），有 `session/cancel` 和权限请求，但只有 repo 内示例组合、无现成可执行文件，且只给 committed text（无工具可见性）。

## 3. 方案选型

| 方案 | 结论 | 理由 |
|---|---|---|
| TUI adapter（kimi 式） | ❌ | dsh 无 TUI |
| headless 一次性 | ❌ | 无多轮、无流式、无事件 |
| ACP + runner | 备选 | 标准化、有 cancel/权限；但无现成二进制、无工具可见性 |
| **SDK JSON-RPC + runner** | ✅ 采用 | 有打包 runtime、事件流完整（工具可见）、协议面极小（3+4） |

## 4. 总体架构

```
飞书消息 → worker → dsh.ts (thin adapter)
  buildArgs: node dsh-runner.js --session-id <id> --dsh-bin dsh-jsonrpc-agent --cwd <dir> ...
  writeInput: ::botmux-dsh:<base64> 帧（writeRunnerInput）
      │
      ▼
dsh-runner.js（长驻 Node 进程）
  ├─ spawn: dsh-jsonrpc-agent --config <cordis.yml>
  │    env: DSH_SESSION_ROOT=~/.botmux/dsh-sessions/<id>, DSH_CWD, DEEPSEEK_API_KEY
  ├─ initialize（握手，provider=deepseek-official, model）
  ├─ 每 turn：session/prompt（固定 sessionId，连接内多轮）
  ├─ session.event → 工具调用渲染成进度行写 stdout（worker 当卡片渲染）
│                → 累积 assistant 文本块
  ├─ session.status=idle → OSC final 帧 {content, usage, replyTurnId}
  └─ 致命错误 → OSC lifecycle {event:'fatal'} 后退出
      │
      ▼
worker 解码 final → 投递飞书
```

## 5. 详细设计

### 5.1 `src/adapters/cli/dsh.ts`（新增，~130 行，照抄 codex-app.ts 形状）

| 成员 | 值/行为 |
|---|---|
| `id` | `'dsh'` |
| `resolvedBin` | `process.execPath`（node 跑 runner） |
| `sandboxExtraExecPaths` | lazy `resolveCommand(pathOverride ?? 'dsh-jsonrpc-agent')` |
| `buildArgs` | `[runnerPath(), '--session-id', sessionId, '--dsh-bin', <resolved>, '--cwd', workingDir, '--bot-name', botName, '--locale', locale, '--model', model?]` |
| `writeInput` | `writeRunnerInput(pty, '::botmux-dsh:', content, undefined, context?.turnId)` |
| `systemHints` | `[]`（runner 模式不走 botmux send 约定） |
| `injectsSessionContext` | `true`（runner 把 bot 身份注入首轮 prompt） |
| `altScreen` | `false` |
| `supportsTypeAhead` | `false`（v1 串行 turn） |
| `readyPattern` | `/›/`（runner 握手完成后打印 `›`） |
| `deferFirstPromptTimeoutUntilReady` | `true` |
| `modelChoices` | `['deepseek-v4-flash', 'deepseek-v4-pro']` |
| `authPaths` | `['~/.botmux/dsh-sessions']` |
| `buildResumeCommand` | `() => null`（v1 不支持） |

### 5.2 `src/dsh-runner.ts`（新增，~450 行）

**argv**：`--session-id`（必填）、`--dsh-bin`（必填）、`--dsh-config`（可选）、`--cwd`、`--bot-name`、`--bot-open-id`、`--locale`、`--model`、`--turn-timeout`（默认 600s）。

**boot**：
1. 解析 config 路径：`--dsh-config` > `$DSH_CORDIS_CONFIG` > botmux 内置 `assets/dsh/cordis.yml`（vendored，见 5.4）。
2. `spawn(dshBin, [configPath], {env: {...process.env, DSH_SESSION_ROOT: ~/.botmux/dsh-sessions/<session-id>, DSH_CWD: cwd}})`。
3. NDJSON 握手：发 `initialize {cwd, provider: 'deepseek-official', model, maxTokens: 49152}`，等 result；超时 30s → lifecycle fatal 退出。
4. 成功后 stdout 打印 `›`（ready 标记）。

**输入循环**：逐字节读 stdin，遇换行解析 `::botmux-dsh:<base64>` → JSON `{type:'message', content, replyTurnId}`：
- 首轮 content 前插身份 preamble（见 5.5）。
- 发 `session/prompt {sessionId: 固定值（runner 启动时生成）, contentBlocks: [{type:'text', text: content}]}`，得 `{messageId}`。
- v1 同一时刻只允许一个 in-flight prompt（worker 侧 `supportsTypeAhead: false` 已保证；runner 再 assert 一层，冲突时 fatal）。

**事件循环**（解析 dsh stdout 的 NDJSON）：
- `session.event`：按 sessionId 过滤；
  - `tool/call` → stdout 进度行 `🔧 ${name} ${truncate(args, 200)}`
  - `tool/result` → `✓ ${name}`（isError 时 `✗`）
  - `assistant/message` → 把 content 中 `type:'text'` 块追加到本轮缓冲；记录 usage
  - `subagent.started/finished` → `↳ 子任务 ${status}`
- `session.status`：`running` 置忙、`idle` 且有 in-flight → 发 `final` marker `{content: 缓冲文本, usage, startedAtMs, completedAtMs, replyTurnId}`，清空缓冲。缓冲为空则 content 给 `''`（worker 有 pure-silence 抑制逻辑）。
- JSON-RPC error response → `final` 带错误文本。

**看门狗**：turn 超过 `--turn-timeout` → 杀 dsh 子进程、发 lifecycle fatal、退出非零（worker 重拉 runner；会话上下文丢失，日志明示）。

**子进程崩溃**：exit 事件先于 final → lifecycle fatal 退出。

**关闭**：stdin EOF → 发 `shutdown` → 2s grace 后 kill。

### 5.3 协议规格

botmux→runner 输入帧（复用 runner-input.ts，不改）：
```
::botmux-dsh:<base64({"type":"message","content":"...","replyTurnId":"..."})>\n
```

runner→botmux OSC 帧（复用 RunnerControlWriter）：
```
\x1b]777;botmux:final:<base64({"content":"...","usage":{...},"startedAtMs":..,"completedAtMs":..,"replyTurnId":"..."})>\x07
\x1b]777;botmux:lifecycle:<base64({"event":"fatal","reason":"..."})>\x07
```

runner→dsh（SDK JSON-RPC，NDJSON over stdio）：见 2.2。

### 5.4 配置与注册点

- **vendored 配置**：`assets/dsh/cordis.yml`，内容取自 dsh `python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml`（含 jsonrpc-server/agent-spine/llm-deepseek/jsonl/checkpoint/bash/fs），随 botmux 版本 pin dsh 协议版本。
- **bots.json**：`"cliId": "dsh"`，`"env": {"DEEPSEEK_API_KEY": "..."}`，可选 `"model": "deepseek-v4-pro"`、`"workingDir"`。
- **注册点**（照 `src/adapters/cli/CLAUDE.md`）：
  1. `src/adapters/cli/types.ts` CliId 加 `'dsh'`
  2. `src/adapters/cli/registry.ts`：import + `RAW_CLI_EXECUTABLES['dsh-jsonrpc-agent']` + switch case
  3. `src/worker.ts` CLI_DISPLAY_NAMES、`src/im/lark/card-builder.ts` cliDisplayNames
  4. `src/setup/bot-config-editor.ts`：CLI_ID_CHOICES **尾部追加** + labels
  5. `test/cli-adapters.test.ts`：ALL_CLI_IDS + dsh describe 段
  6. README.md / README.en.md / docs-site/docs/{zh,en}/adapters.md

### 5.5 身份 preamble（首轮注入）

runner 在首轮用户消息前插入（后续轮不插）：

```
<botmux_identity>
你是飞书群机器人「<botName>」，通过 deepseek-harness 运行。
- 你的最终回复文本会被自动捕获并发送到群里，**不要**执行 botmux send 或任何发消息命令。
- 工作目录：<cwd>。语言：<locale>。
</botmux_identity>
```

必须显式禁止 `botmux send`：dsh 的 bash 工具是 runner 的子进程，能看到 botmux 的 pid marker，不禁止会双发。

## 6. Turn 端到端生命周期

1. worker spawn runner → runner spawn dsh → initialize 完成 → 打印 `›`
2. worker 见 readyPattern → 把群消息组成 `::botmux-dsh:` 帧写入（首轮带 preamble）
3. runner 发 session/prompt → dsh 执行（工具调用实时以进度行上屏）
4. `session.status=idle` → runner 发 final 帧 → worker 投递飞书，turn 结束
5. 下一条群消息 → 同 sessionId 再 prompt（多轮）
6. worker 重启 → runner 重拉 → 新 sessionId（v1 不续上下文）

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| dsh 二进制不存在 | resolveCommand 失败，setup/启动期报错（同其他 adapter） |
| initialize 超时/失败 | lifecycle fatal，runner 退出非零，worker 展示失败 |
| prompt JSON-RPC error | final 带错误文本，turn 正常收尾 |
| turn 超时（默认 10min） | 杀 dsh + fatal 退出，worker 重拉（丢上下文，明示） |
| dsh 中途崩溃 | lifecycle fatal 退出 |
| 空回复（只调工具无文本） | final content='' → worker 抑制投递（已有逻辑） |
| 图片消息 | v1 转文本提示"暂不支持图片" |
| stdout 纯净 | runner 的 display 行不含 ESC；OSC 帧由 RunnerControlWriter 统一转义 |

## 8. 测试计划

- **单测** `test/cli-adapters.test.ts`：buildArgs 各 flag 组合、lazy bin、readyPattern、writeInput（fake PtyHandle 断言帧内容）。
- **runner 单测** `test/dsh-runner.test.ts`（新增）：fixture 假 dsh server（Node 脚本说 SDK 协议）覆盖：握手成功/超时、prompt→事件→final 帧内容、错误响应、超时看门狗、stdin EOF 关闭。
- **e2e**（手动，不进 CI）：真 dsh binary + DEEPSEEK_API_KEY，群里 @ 验证多轮。
- 运行：`pnpm vitest run test/cli-adapters.test.ts test/dsh-runner.test.ts`

## 9. 任务拆解

| # | 任务 | 估时 |
|---|---|---|
| T0 | spike：假 server 打通 worker↔runner↔dsh 帧通路（throwaway 脚本验证假设） | 0.25d |
| T1 | dsh.ts + 全部注册点 + bots.json 配置 | 0.5d |
| T2 | dsh-runner.ts 主体（boot/输入/事件/final/看门狗/关闭） | 1d |
| T3 | 单测（adapter + runner + 假 server fixture） | 0.5d |
| T4 | 文档（README、adapters.md、本设计文档定稿） | 0.25d |
| | **合计** | **~2.5d** |

## 10. 风险与未决项

1. **无 cancel**：SDK 协议没有中断。v1"停止生成"= 杀进程重开（丢上下文）。硬需求则 v2 评估 ACP（有 session/cancel，但要自己 bundle 且丢工具可见性）。
2. **跨重启 resume 未验证**：server session 是内存 Map；同 sessionId 新连接是否从 JSONL load 历史待验证（大概率不支持）。v2 调研 `session-persistence-jsonl` 的 load 能力。
3. **协议漂移**：dsh 还是 rc（0.1.0-rc.5），协议可能变。对策：pin 版本 + fixture 测试锁定 wire 格式。
4. **双重沙箱**：默认 cordis.yml 不含 landlock 沙箱插件，v1 靠 botmux 沙箱兜底，无冲突。
5. **密钥**：DEEPSEEK_API_KEY 走 bots.json env 注入，不进配置文件、不落盘。

## 11. 已知限制（v2 backlog）

- **跨重启 resume**：dsh SDK server 无 create-or-resume；`agents.create` 不 resume，持久化层拒绝同 ID 覆盖。runner 重启后开新会话（随机 sessionId）。需要 dsh 上游支持。
- **中断/取消**：SDK 协议无 cancel；worker 杀 runner 重拉即取消，但会丢当前会话上下文（配合上一条，无法 resume）。
- 工具调用卡片化展示（替代纯文本进度行）：worker/渲染层工作，另开。
- 权限请求桥接群内人工确认：SDK 协议无权限请求语义。
- 图片消息：协议只收 text；botmux 已有的附件提示会把文件路径写进 prompt，dsh 工具可读取。
- 多 session 并发：botmux 本来就是一个 bot 会话一个 runner，无实际场景。
