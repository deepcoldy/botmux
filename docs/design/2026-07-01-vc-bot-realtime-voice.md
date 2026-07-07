# 飞书会议 bot 实时语音回复 · 接入设计（路径1 realtime audio）

> 状态：设计 + M0 骨架实现中（2026-07-01）。
> 关联：`2026-06-30-vc-bot-subscriptions-integration.md`（P0/P1 事件接入 + 监听群消费层，已落地）。
> 依据：平台侧会议智能体接入资料。

## 1. 背景与目标

P0/P1 已经打通「bot 被邀入会 → 读会中 transcript/chat/参会事件 → 同步监听群 → 会尾收尾」。这条是官方**路径2（入会·无语音）**——bot 只有结构化事件通道，没有音频通道。

用户的新诉求：让 agent 在会议里**直接回复**。拆成两档，本设计覆盖第二档：

- **文本回复（轻，已批准，并行推进）**：bot 往**会中聊天**发文本，参会人当场看到。走公开「高级」权限 `vc:meeting.message:write`，一个 REST 的事，不在本设计主体，见 §6.4。
- **实时语音回复（重，本设计主体）**：让参会人**实时听到** bot 的声音。走官方**路径1（实时音频）**，需要 `vc:meeting.bot.realtime:write` + 会议侧「允许 AI 智能体发言」+ 一条三层协议的实时音频 WebSocket。

### 目标

- 打通「bot 入会 → 拿实时音频 WS → 把合成语音推进会场 → 参会人听到」。
- 复用 P0/P1 已有的事件/入会/会话生命周期地基，不重造。
- 分阶段交付：先 v0 单向播报（bot 念一段文字进会场），后 v1 对话式（听会场→理解→应答）。
- 音频失败可降级到文本回复（`message:write`）/ 监听群消息，不静默失败。

### 非目标

- 不追求会议纪要/总结产品化（那是消费层，另立）。
- 不在本期做多会议大规模并发的资源调度优化；先跑通单会。
- v0 不消费下行音频（不听会场），只上行；下行 + 对话式留给 v1。

## 2. 官方协议链路（来自平台接入资料）

一句话：**订阅"被邀请入会"事件 → 调入会接口 → 拿实时音频长连接 → 收发音频**。

```
vc.bot.meeting_invited_v1 (事件)
  → POST /open-apis/vc/v1/bots/join   { join_type:1, join_identify:{ meeting_no } }  → meeting.id
  → GET  /open-apis/vc/v1/realtime/endpoint?meeting_id=<id>                          → websocket_url
  → connect(websocket_url)  ── 三层协议 ──
        L1  WebSocket 二进制帧
        L2  Frontier Frame (proto2)         : service / method / payload
        L3  ClientEvent / ServerEvent (proto3): 真正的音频帧 + 控制消息
  → 连上先发 session.create（参考实现声明上下行音频格式：PCM s16le，24kHz）
  → 收 ServerEvent 下行音频帧（= 会场声音）
  → 把模型生成的音频帧包成 ClientEvent 上行（= 会场听到 bot 说话）
vc.bot.meeting_ended_v1 (事件)
  → POST /open-apis/vc/v1/bots/leave  { meeting_id }   （必须 app/bot 身份）
```

**关键事实**：
- §3 音频流是文档明确标注的「最重的一块，开发者主要工作量在这」。「把音频帧包成 ClientEvent」只是**上行的最后一步**；前面得先有 Frontier/ClientEvent 的 protobuf 编解码 + 一个能出音频的（实时）语音模型 + 音频分帧/时序。
- 2026-07-01 已拿到实时音频参考协议包（Frontier proto2、meeting_realtime proto3、Python demo）。最大的协议不确定性已退休；Node 侧已补最小手写 protobuf codec，并用 Python pb2 生成的 golden bytes 做逐字节回归。
- `realtime/endpoint` 与实时音频 WS **`lark-cli vc` 不暴露**（现有 shortcut 只有 join/leave/events/detail/recording/search）。这套要**裸调 REST / node-sdk + 自写 WS 客户端**，是净新代码。
- `vc:meeting.bot.realtime:write` 的可用性以开放平台权限配置为准；申请、审批与发版由应用管理员在平台侧完成。

## 3. 我们已有的地基（复用点）

路径1 的**前半段我们已经全接完**——按接入指南 §5「最小接入路径」，step1（文字问答）+ step2（被 call 自动入会）就是我们的 P0/P1。只差 step3 音频流。

| 已有件 | 位置 | 在路径1 的角色 |
| --- | --- | --- |
| per-bot Lark `WSClient` 事件总线 | `im/lark/event-dispatcher.ts` | 已收 `vc.bot.meeting_invited_v1` / `meeting_ended_v1`，直接触发音频链路起停 |
| `handleVcMeetingPush` / `startVcMeetingMonitoring` / `closeVcMeetingDaemonSession` | `daemon.ts` | 会话生命周期骨架；音频 pipe 挂在同一 `vcMeetingSession` 上 |
| bot 入会 | 现走 `lark-cli vc +meeting-join --as bot`；已拿到长 `meeting.id` | 复用；`realtime/endpoint` 用这个 `meeting.id` |
| `services/voice`（sami/openai → PCM → opus） | `services/voice/{sami,openai,audio}.ts` | **PCM 那一段可复用为音频源**（v0 上行）；注意它是**一次性文件**不是流式 |
| 会话状态 / tombstone / 单 flusher | `daemon.ts` `vcMeetingSessions` | 音频 session 与监听群 session 同源，避免双份状态 |

**要新建的**：realtime-audio 子系统本身（WS 客户端 + 两层 protobuf 编解码 + session 握手 + 音频分帧/时序 + 语音模型对接）。其中两层 protobuf 编解码、session.created 握手 gate、最小下行读循环、100ms pacer、真实 WS transport（incoming queue + one binary message = one Frontier frame + bufferedAmount backpressure）已在 `src/vc-agent/realtime/` 落地。

## 4. 架构设计

### 4.1 模块划分（新增 `src/vc-agent/realtime/`）

```
src/vc-agent/realtime/
  endpoint.ts     拿 websocket_url（GET /vc/v1/realtime/endpoint，裸 REST + profile）
  frontier.ts     L2 Frontier Frame (proto2) 编解码（已按 reference golden bytes 锁定）
  events.ts       L3 ClientEvent/ServerEvent (proto3) 编解码（已按 reference golden bytes 锁定）
  transport.ts    WebSocket transport：send/receive queue、close、bufferedAmount backpressure
  session.ts      session.create 握手 + 收发循环 + 重连
  audio-source.ts 文字→PCM 帧流（v0 复用 services/voice；v1 换实时模型）
  pacer.ts        上行按 wall-clock 实时节奏发帧（不能一次性灌）
  index.ts        RealtimeVoiceSession：对外 start/stop/speak(text)/onDownlink
```

### 4.2 生命周期（挂在 daemon 的 vcMeetingSession 上）

- 触发：与监听群同源。当一个会被判定要「语音在场」时（invited 自动 / 或配置开关 / 或 agent 决策），在 `startVcMeetingMonitoring` 里额外拉起 `RealtimeVoiceSession`。
- 起：`endpoint.ts` 拿 wsUrl → `session.ts` 连 WS → 发 `session.create` → 等 `session.created` ACK 后才开始推音频。
- 止：`meeting_ended` / `closeVcMeetingDaemonSession` 时 `RealtimeVoiceSession.stop()` + `POST /bots/leave`。复用现有 tombstone 防迟到事件复活。
- 单一 owner：音频 session 句柄挂在 `vcMeetingSession` 上，和 listener/flush 状态并列，daemon 统一管起停，不另开生命周期。

### 4.3 音频管线

**v0（单向上行，先做）**
```
触发要说的文字（LLM 决策 / 固定话术 / 会中被点名）
  → services/voice 合成 PCM（s16le, 24k）           ← 复用现有引擎，仅取 PCM 中间产物
  → pacer 按帧（参考实现：100ms/帧，4800B）实时节奏
  → events.ts 包 ClientEvent(audio) → frontier.ts 包 Frontier → WS 上行
  → 会场听到
（不连下行，不听会场）
```
- v0 关键工程点：**上行必须按 wall-clock 节奏喂帧**（一次性 dump 会被判非法或播放错乱）；`session.create` 的格式要和合成 PCM 对齐（采样率/位深/声道/帧长）。2026-07-01 参考实现校准：realtime 服务侧 `session.create` 上下行都用 `audio/pcm` + `s16le` + `24000`，上行 `audio.upstream.append` 按 4800B（24kHz mono s16le 的 100ms）切块。

**v1（全双工对话，后做）**
```
ServerEvent 下行音频帧（会场声）
  → 实时语音模型（一体 ASR+LLM+TTS 流式模型）
     或 自组 ASR→LLM→TTS 流水
  → 模型输出音频帧 → ClientEvent 上行
+ turn-taking / barge-in（用户开口时打断 bot）/ 回声隔离（别把自己上行的音又当下行听）
```
- v1 是完整实时 agent 环，延迟预算、打断、回声是主要难点；建议 v0 打通后单独立项。

### 4.4 进程/资源模型（待定，见开放问题）

每个语音会 = 一条常驻 WS + 持续音频编解码/合成，CPU/内存不轻。两个选项：
- **A. daemon 内**：省进程管理，但音频循环别阻塞 daemon 事件 loop（要 worker_threads 或严格异步分帧）。
- **B. 专用 worker 进程**（类比现有 CLI worker，每语音会一个）：隔离音频处理、崩溃不拖垮 daemon，符合现有 worker 架构。**倾向 B**，但 v0 spike 阶段可先在 daemon 内跑通再抽。

## 5. 里程碑

| 里程碑 | 内容 | 出口标准 | 依赖 |
| --- | --- | --- | --- |
| **M0 去风险 spike** | 申请 `realtime:write` 发版；发 session.create、等 session.created；把一段 **canned PCM / 测试 TTS** 灌进真会 | **真会里参会人能听到那段预录音频** | 🟡 会议侧允许 AI 发言 + 真会验证 |
| **M1 v0 单向播报（产品化）** | 把 M0 接进 botmux：`RealtimeVoiceSession` + 复用 services/voice 合成 + pacer；触发一段文字念进会场；失败降级文本 | 会中触发一句 → 会场听到 bot 念出来；会尾干净 leave | M0 通 |
| **M2 v1 对话式** | 下行 ServerEvent 消费 + 实时语音模型 + turn-taking/barge-in/回声隔离 | bot 能听会场提问并语音应答 | M1 通 + 选定实时语音模型 |
| **并行·会中文本回复** | `vc:meeting.message:write`：bot 往会中聊天发文本（权限已确认） | 会中触发 → 参会人在会中聊天看到 bot 文本 | 确认 send endpoint |

**关键路径**：proto/demo 已拿到，真实 WS transport 已接；`realtime:write` 已配置到应用身份权限。M0 现在卡在 **会议侧允许 AI 智能体发言 + 真会验证**。

## 6. 关键风险与开放问题

1. ✅ **proto 契约来源**：Frontier(proto2) + ClientEvent/ServerEvent(proto3) 的 `.proto` 定义已拿到；Node codec 已用 Python pb2 golden bytes 锁定。
2. ✅ **scope 审批 + 发版**：`vc:meeting.bot.realtime:write` 以开放平台配置为准；2026-07-02 已确认配置到应用身份权限。
3. 🟡 **音频时序/节奏**：上行必须实时节奏喂帧；`session.create` 格式对齐；帧长/采样率错会静默播不出或杂音。
4. 🟡 **现有 TTS 是一次性不是流式**：v0 可用（先合成完再按帧喂）；v1 若要低延迟对话，得换流式语音模型，`services/voice` 只能贡献引擎凭证/风格。
5. 🟡 **实时语音模型选型（v1）**：一体流式语音模型 vs 自组 ASR→LLM→TTS（可控但要自己拼延迟）。延迟预算是选型主轴。
6. 🟡 **回声与打断（v1）**：bot 自己上行的音会不会从下行回来当"会场声"？协议/demo 需澄清；barge-in 策略。
7. 🟡 **进程/资源模型**：daemon 内 vs 专用 worker（§4.4）；多会并发时更明显。
8. 🟢 **产品层：何时开口、说什么、什么人设**：v0 的触发源（agent 决策 / 被点名 / 手动）、声音人设——产品决策，随 M1 定，不阻塞 M0。

## 7. 权限与前置配置

| 权限 | Token | 用途 | 状态 |
| --- | --- | --- | --- |
| `vc:meeting.bot.join:write` | TAT | 入会/离会 | 已有 |
| `vc:meeting.meetingevent:read` | TAT | 读会中事件 | 已有 |
| `vc:meeting.bot.realtime:write` | TAT | 实时音频流 | 已加，待真会验证 |
| `vc:meeting.message:write` | App+User | 会中发文本（并行路径） | 待申请（公开高级权限） |

会议侧开关：AI Summary 开、允许智能体加入、**允许 AI 智能体发言**（语音必需）。

## 8. 建议的推进顺序

1. **并行推进外部依赖**：会议侧「允许 AI 智能体发言」（决定 M0 真会能否播出）。
2. **并行上会中文本回复**：`message:write` 确认 endpoint → 接一个「往会中聊天发文本」路径（快、独立，先给到「在会议里回复」的即时价值）。
3. **代码侧补齐 M0 触发/验证入口**：transport/protocol/session 已接好；`realtimeVoice.testSpeakOnStartText` 可在 dogfood 时配置为入会后念一句测试文本。
4. **M0 → M1 → M2** 按上表推进；v0 打通「会场能听到 bot」后再评估 v1 对话式是否值得。
