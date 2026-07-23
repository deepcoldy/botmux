# 飞书会议代理接入 botmux（智能体入会 + 旁听提醒设计 brief）

- 日期：2026-06-30
- 分支：`design/vc-bot-subscriptions`
- 基线：`origin/master @ cfa3d3ac`
- 状态：设计草案，待评审后拆实现任务

## 1. 背景

飞书会议智能体（Bot）接入指南提供了一组面向企业自建应用机器人的会中能力：

- 机器人真实加入 / 离开正在进行的视频会议
- 通过开放平台长连接接收会议智能体事件
- 在会中读取参会人加入 / 离开、实时转写、会中聊天、妙享开始 / 结束等活动
- 可选接入实时音频 WebSocket，让智能体在会议里说话

botmux 目前已经是“Lark 长连接事件 -> daemon -> worker / workflow”的薄编排层，天然适合承接这类事件。但现有事件入口只覆盖 IM、卡片和文档评论，没有 VC bot 会议事件。

本设计的产品目标不是单纯“把会议事件接进 botmux”，而是做一个会议代理闭环：

1. 用户收到会议邀请、进入会议或显式要求旁听时，botmux 能触发 agent 入会。
2. agent 以会议 Bot 身份旁听会议，持续获取实时转写、会中聊天、参会人和共享文档线索。
3. Claude Code / Codex 等 agent 对窗口化会议内容做理解和决策，判断哪些信息需要用户关注。
4. 当会议中有人向用户提问、需要用户表态、出现决策点 / 风险 / 待办时，agent 通过 IM / 目标群提醒用户“现在该发言”，并给出上下文；建议话术作为可选 fast-follow。
5. 后续接入实时音频和语音模型后，再评估让 agent 以会议身份直接发言。

## 2. 现状核对

### 2.1 botmux 当前能力

- `src/im/lark/event-dispatcher.ts` 已使用 `@larksuiteoapi/node-sdk` 的 `Lark.WSClient` 建立每 bot 一个长连接。
- 当前注册事件包括：
  - `im.message.receive_v1`
  - `card.action.trigger`
  - `im.chat.member.bot.added_v1`
  - `drive.notice.comment_add_v1`
  - reaction 事件 no-op
- `EventHandlers` 当前只有消息、卡片、入群、文档评论等 handler，没有会议 handler。
- `src/setup/lark-scopes.json` 和 `src/setup/verify-permissions.ts` 当前没有 `vc:*` 权限。
- Dashboard “接入点（Webhook）”已能把任意外部 JSON 事件投给机器人单轮对话或 workflow，workflow 通过字符串参数 `event` 接收完整 envelope。

### 2.2 lark-cli 当前能力

本机已升级到 `lark-cli 1.0.60`。`event list --json` 里新增了用户态 VC lifecycle 事件：

- `vc.meeting.participant_meeting_started_v1`
- `vc.meeting.participant_meeting_joined_v1`
- `vc.meeting.participant_meeting_ended_v1`
- `vc.note.generated_v1`
- `vc.recording.recording_started_v1`
- `vc.recording.recording_ended_v1`
- `vc.recording.recording_transcript_generated_v1`

但没有指南中的 bot 会中实时事件：

- `vc.bot.meeting_invited_v1`
- `vc.bot.meeting_activity_v1`
- `vc.bot.meeting_ended_v1`

因此，第一版不能依赖 `lark-cli event consume` 直接消费 `vc.bot.*`；应优先复用 botmux 自己已有的 Lark `WSClient`，或先用独立 bridge / polling 命令验证事件链路和 payload 形态。

`lark-cli vc` 当前只暴露这些会中 shortcut：

- `+meeting-join`
- `+meeting-events`
- `+meeting-list-active`
- `+meeting-leave`

没有 `speak` / `audio` / `realtime` 类命令。因此，通过现有 CLI 能完成“入会 + 读取会中事件”，不能把 agent 的文字直接转成会议语音并推流。

### 2.3 Dogfood 事实记录（2026-06-30）

这次实测验证了几个设计假设：

1. **bot 真实入会可用。**
   - `lark-cli vc +meeting-join --as bot --meeting-number <9位会议号>` 成功后，返回 `meeting.id`、`meeting_no`、`topic`、`start_time` 和 `join_user`。
   - 会议事件流里会出现 bot 的 `participant_joined` 事件；bot 用户类型表现为 `user_type=10`。
   - 如果会议侧没有打开“允许智能体加入”，入会会失败，错误含义是会议侧开关关闭，而不是应用 scope 不足。

2. **入会后能拿到的是结构化事件，不是屏幕画面或原始音频。**
   实测通过 `+meeting-events` 能拿到：
   - 会议元信息：`meeting.id`、`meeting_no`、`topic`、`start_time`、`host_user`
   - 参会事件：`participant_joined`，包含参与者、加入时间、用户类型和角色
   - 会中聊天：`chat_received`，包含发送人、发送时间、`message_id`、`message_type`、文本内容；图片等不可展示内容以占位文本出现
   - 实时转写：`transcript_received`，包含发言人、起止时间、`sentence_id`、语言和转写文本
   - 分页信息：`has_more`、`page_token`
   - 文档和妙享事件未在本次样本中出现，但指南和 CLI reference 均表明应支持 `magic_share_started` / `magic_share_ended`

3. **事件流会有重叠批次，不能简单按事件去重。**
   实测转写 batch 里存在时间段重叠和语句重复修订。后续 normalizer 需要保留 `sentence_id`，但 transcript 不能当普通 seen-set 去重：同一个 `sentence_id` 后到版本可能修正文本，必须 latest-wins upsert。chat / participant / magic share 才适合 drop-on-seen。

4. **用户身份能读事件，不等于应用身份能读事件。**
   实测同一场会议：
   - 用户身份具备 `vc:meeting.meetingevent:read` 时，可以读取事件流。
   - 应用身份读取时仍可能报 `app_scope_not_applied`，提示 app 没有申请 `vc:meeting.meetingevent:read`。
   - 因此权限自检必须区分 UAT 和 TAT / app scope，不能用用户 token 的 `auth scopes` 结果证明 bot 事件读取已可用。
   - P0 的硬门不是 `+meeting-events --as bot` 返回 200 或 meeting 元信息，而是在真实有人发言 / 发消息的会议中，应用身份能拉回 `transcript_received` 或 `chat_received` item。

5. **当前无法让 agent 直接在会议里开口说话。**
   这需要实时音频链路：`vc:meeting.bot.realtime:write`、会议侧“允许 AI 智能体发言”、音频生成、以及飞书实时音频 WebSocket / protobuf 协议。现有 `lark-cli vc` 没有这个发送音频的 shortcut。

## 3. 目标 / 非目标

### 目标

- 让 botmux 能接收或主动拉取飞书会议智能体 bot 事件。
- 支持会议邀请 / 活跃会议 / 手动会议号触发 agent 入会或提示入会。
- 支持会议回调触发“是否开始监听”的私聊确认卡片；用户确认后再入会、拉起会议监听群，并把会中 transcript/chat/activity 同步到该群。
- 支持把整理后的会议状态发送给指定 agent consumer 处理，用于实时摘要、行动项提取、问题追踪、会后总结和“用户是否需要关注 / 发言”的判断。当前不使用 workflow 承接；workflow 只作为后续产品能力的一种 consumer。
- 当会议需要用户注意时，向用户私聊或目标群发送提醒和上下文摘要；建议回复作为可选能力，不作为 P0/P1 硬验收。
- 支持会议结束事件触发收尾：清理会议状态；最终总结作为 P2+ 能力，需要全量会议输入或 rolling summary 状态，不靠空 final run 触发。
- 复用现有 Lark WS dispatcher、IM 卡片、建群和 bot 会话能力；不把 workflow 作为会议接入前置。

### 非目标

- 本期不实现实时音频说话链路。`vc:meeting.bot.realtime:write` 和音频 WebSocket / protobuf 作为后续阶段。
- 本期不改飞书会议侧产品限制。会议仍必须打开 AI Summary，并在安全设置里允许智能体加入。
- 本期不依赖 `lark-cli event consume` 支持 `vc.bot.*`，除非后续 lark-cli 明确注册这些事件。
- P0 不做完整会议纪要产品，也不让 agent 直接在会上发声；先打通事件接入、归一化、会议状态维护和结构化会议状态输出。
- P0 不实现完整 attention routing。attention routing 是消费层，依赖 P0 输出的结构化会议状态；不能反向污染 P0 ingestion / normalizer / dedup 管道。
- MVP 默认只做“提醒我”，不默认生成“替我说什么”。建议回复 / 实时辅导属于更高信任面的 fast-follow，需要单独开关。

## 4. 飞书侧能力与前置条件

### 4.1 应用权限

至少需要：

| 权限 | Token | 用途 |
| --- | --- | --- |
| `vc:meeting.bot.join:write` | TAT | bot 加入 / 离开会议 |
| `vc:meeting.meetingevent:read` | TAT / UAT | 读取或订阅会议事件 |
| `vc:meeting.bot.realtime:write` | TAT / UAT | 实时音频，后续阶段 |

如果权限需要数据范围，应按指南配置会议归属者范围。

权限检查必须分层：

- **用户身份（UAT）**：用户 token 有 `vc:meeting.meetingevent:read`，只能说明当前用户可以读其可见会议事件。
- **应用身份（TAT）**：bot 读会中事件仍要求 app 自身申请 / 发布 / 安装 `vc:meeting.meetingevent:read`，并配置数据范围。
- **入会权限**：`vc:meeting.bot.join:write` 只保证可调用 BotJoinMeeting，不保证后续能读取事件流。
- **实时音频权限**：`vc:meeting.bot.realtime:write` 只是一项前置权限，仍需要会议侧发言开关和协议实现。

### 4.2 会议侧开关

即使应用权限齐全，会议仍需满足：

- 飞书客户端版本满足指南要求。
- 会议为多人视频会议。
- 会议开启 AI Summary。
- 会议安全设置中打开“允许智能体加入”。
- 若后续支持智能体说话，还需打开“允许 AI 智能体发言”。

如果缺少会议侧开关，入会会失败，典型错误为“allowing agents to join meetings is disabled”。

### 4.3 订阅事件

指南中的 TAT push 事件：

| EventType / SubEventType | 用途 |
| --- | --- |
| `vc.bot.meeting_invited_v1` | bot 被邀请加入会议 |
| `vc.bot.meeting_activity_v1` | 会中综合活动 |
| `vc.bot.meeting_ended_v1` | 会议结束 |

`meeting_activity` 内通过 `activity_event_type` 区分：

| activity_event_type | payload items |
| --- | --- |
| `participant_joined` | `participant_joined_items` |
| `participant_left` | `participant_left_items` |
| `transcript_received` | `transcript_received_items` |
| `chat_received` | `chat_received_items` |
| `magic_share_started` | `magic_share_started_items` |
| `magic_share_ended` | `magic_share_ended_items` |

注意点：

- 高频事件会按约 5 秒或 100 条聚合。
- 时间戳是 Unix epoch milliseconds。
- schema 必须严格匹配后端字段。指南中特别说明历史 typo 字段 `meeting_actitivty_items` 必须照写，否则 broker 可能丢字段，导致 `event` 为空。
- 已确认开放平台控制台最终事件名为 `vc.bot.meeting_invited_v1`，实现和订阅均按该 key 配置。

## 5. 推荐架构

### 5.1 方案 A：Polling Bridge MVP（最快验证）

先做一个独立 polling bridge 进程：

```
会议触发源（手动会议号 / 活跃会议查询 / 后续 invite 事件）
  -> BotJoinMeeting / lark-cli vc +meeting-join
  -> meeting_id
  -> lark-cli vc +meeting-events（page_token / 时间窗轮询）
  -> normalize event
  -> stabilize transcript + item-level dedup / upsert
  -> 输出结构化 meeting-state JSON / 写入同一份 meeting session
  -> debug 日志 / 目标群同步 / agent consumer（后续）
```

优点：

- 不改 botmux daemon 主链路，适合先离线验证 lark-cli 读事件能力和真实事件形态。
- 适合先验证 TAT 应用身份是否能读真实 transcript / chat、真实事件形态、page_token 语义、频率、会议开关、权限范围。
- 后续 native push 接入时可以复用同一套 normalizer / item dedup / transcript stabilization 纯模块。

缺点：

- 会议生命周期状态在 bridge 里，不能代表最终 daemon 产品体验。
- 入会调用、轮询 cursor、结束检测和 debug 输出分散在 bridge 里。
- backpressure、retry、cursor、ended 检测需要 bridge 自己先处理。

适用场景：一周内打通 dogfood，先确认应用身份能读 transcript / chat、事件形态可归一化、去重 / upsert 正确；不作为最终产品入口。

`vc.bot.*` push 订阅仍然是最终形态之一，但不作为 P0 bridge 的前置。P0 只依赖已经 dogfood 过的 `+meeting-join` / `+meeting-events` 路径。

### 5.2 方案 B：Native Integration（最终形态）

把 VC bot / VC lifecycle 事件接进 botmux 自身 Lark dispatcher：

```
Lark WSClient in botmux daemon
  -> 用户会议邀请 / 活跃会议信号
  -> vc.bot.meeting_invited_v1
  -> vc.bot.meeting_activity_v1
  -> vc.bot.meeting_ended_v1
  -> VcMeetingService
  -> meeting session / confirm cards / listener group / agent consumer
```

新增模块建议：

| 模块 | 职责 |
| --- | --- |
| `src/vc-agent/push-source.ts` | 原始 VC bot 事件 key、push context 解析、dedup anchor |
| daemon-owned `vcMeetingSessions` | P1 内存态会议 session；后续可下沉为 `src/services/vc-meeting-store.ts` 落盘 |
| daemon `handleVcMeetingPush` | event -> state ingest -> confirm card / listener group / agent consumer routing |
| `src/setup/vc-meeting-permissions.ts` | VC 权限和事件订阅提示 / 深链 |

扩展现有模块：

- `src/im/lark/event-dispatcher.ts`
  - 注册 `vc.bot.meeting_invited_v1`
  - 注册 `vc.bot.meeting_activity_v1`
  - 注册 `vc.bot.meeting_ended_v1`
  - 复用 `scheduleAckSafeEvent` 做 ACK-safe 异步处理
- `EventHandlers`
  - 新增 `handleVcMeetingPush(ctx)`，ctx.kind 区分 invited / activity / ended
- `src/setup/lark-scopes.json`
  - 增加 VC scope 声明
- `src/setup/verify-permissions.ts`
  - 增加可选的 VC feature scopes，不纳入核心 IM critical scopes

## 6. 数据模型

### 6.1 Meeting session

```ts
interface VcMeetingSession {
  meetingId: string;
  meetingNo?: string;
  topic?: string;
  status: 'invited' | 'joining' | 'active' | 'ended' | 'failed';
  larkAppId: string;
  /** 被代理 / 被提醒的用户。open_id 按当前 bot app 视角存储。 */
  attentionTargetOpenId?: string;
  /** 提醒用户的私聊或群聊。P0 可用固定目标；后续可按会议 / 用户动态解析。 */
  notificationChatId?: string;
  targetChatId?: string;
  agentConsumer?: {
    mode: 'none' | 'bot-session' | 'mention-agent' | 'workflow';
    targetBotId?: string;
  };
  joinedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  lastSeqId?: string;
  ingestion?: {
    source: 'polling' | 'push';
    pageToken?: string;
    lastSeenEventTime?: number;
    lastPollAt?: number;
    emptyPollCount?: number;
  };
  dedup: {
    recentEventIds: string[];
    /** drop-on-seen 类 item：chat / participant / magic share。 */
    seenItemIds: string[];
    /** transcript 不能 seen-set 丢弃；同 sentence_id 后到版本覆盖前版。 */
    transcriptBySentenceId: Record<string, {
      sentenceId: string;
      text: string;
      speakerId?: string;
      speakerName?: string;
      startTimeMs?: number;
      endTimeMs?: number;
      language?: string;
      revision: number;
      updatedAt: number;
      stable: boolean;
      lastChangedAt: number;
    }>;
  };
}
```

落盘位置建议：

```
$BOTMUX_DATA_DIR/vc-meetings/<larkAppId>/<meetingId>.json
```

### 6.2 Normalized event

Bridge 和 native 共用同一个归一化结构，减少后续迁移成本。

```ts
type NormalizedVcMeetingEvent =
  | {
      type: 'meeting_invited';
      eventId: string;
      eventTime: number;
      meetingId?: string;
      meetingNo: string;
      raw: unknown;
    }
  | {
      type: 'meeting_activity';
      eventId: string;
      eventTime: number;
      meetingId: string;
      activities: NormalizedVcMeetingActivity[];
      raw: unknown;
    }
  | {
      type: 'meeting_ended';
      eventId: string;
      eventTime: number;
      meetingId: string;
      raw: unknown;
    };
```

`raw` 必须保留，方便 schema 漏字段时回放和排查。

## 7. 事件处理语义

### 7.1 Entry Triggers

推荐默认策略：

1. `vc.bot.meeting_invited_v1` 表示用户已经在会议里手动邀请 bot，这是显式授权；daemon 不再发二次确认卡，直接调用 BotJoinMeeting，创建或复用会议监听群，并开始同步会中内容。
2. `vc.meeting.participant_meeting_joined_v1` 表示目标用户本人进入会议，这是“是否拉 bot 旁听”的候选信号；daemon 私聊 `attentionTargetOpenId` / owner 发送交互卡片。
3. 用户确认后，创建或复用会议监听群，把用户、bot、后续指定 agent 拉入群。
4. 调用 BotJoinMeeting；入会成功后记录 `meetingId`，建立 `VcMeetingSession`。
5. 在监听群发状态卡：“智能体已加入会议 / 正在监听事件”。
6. 如果 participant joined 事件缺少 9 位 `meeting_no`，daemon 不发送点击后必失败的确认卡，只记录 warning；真机确认后再决定是否用 active-meeting 查询补偿 meeting_no。
7. 如果入会失败，向私聊和监听群报告失败原因和会议侧前置开关提示。

### 7.2 Activity

处理原则：

- participant / magic share 事件可以立即投递。
- transcript / chat 高频事件需要按会议维度缓冲；监听群面向人读，默认按约 30 秒聚合一次，agent consumer 可按自身实时性要求配置更短窗口。
- dedup 分两类：chat / participant / magic share 用 drop-on-seen；transcript 用 `sentence_id` latest-wins upsert，后到版本覆盖前一版文本。只有缺少 `sentence_id` 时才 fallback 到 speaker + time range + text hash。
- transcript 输出到慢 lane / 总结 lane 时只发送“已稳定”的句子：优先使用事件里的 final / interim 标志；如果事件没有稳定标志，同一个 `sentence_id` 至少延后一轮 polling window，确认下一轮不再变化后再进入稳定输出。
- page / event 级 key 只用于幂等和日志；真正同步到监听群或 agent consumer 前必须按 item key 去重或 upsert，不能只依赖 `header.event_id`。
- agent consumer 输入不直接拼 prompt，而是结构化 JSON，并明确标记为“不可信会议数据”。

实现约束：

- dedup / upsert 模块不能暴露一个默认的 `dedup(items)` 入口，避免 transcript 被误塞进 drop-on-seen 路径。
- 调用方必须按 item 类型分流，或显式传入无默认值的 mode：`drop-on-seen` 用于 chat / participant / magic share，`upsert-latest` 用于 transcript。
- transcript 回归锁：同一个 `sentence_id` 喂两版文本时，最终保留后到修订版本，且不能被当作重复丢弃。

推荐 activity -> agent consumer 的最小输入：

```json
{
  "source": "lark.vc.bot",
  "meetingId": "...",
  "eventId": "...",
  "window": {
    "from": 1780000000000,
    "to": 1780000005000
  },
  "participants": [],
  "transcripts": [],
  "chats": [],
  "magicShare": []
}
```

实测 event item 字段建议保留：

| 类型 | 必留字段 | 说明 |
| --- | --- | --- |
| participant | `participant.id`、`participant.user_name`、`user_type`、`user_role`、`join_time` / `leave_time` | 用于“谁在会里”和 bot 自身入会检测 |
| chat | `message_id`、`message_type`、`operator`、`send_time`、`content` | 图片等媒体可能只有占位文本；不要假设能拿到图片二进制 |
| transcript | `sentence_id`、`speaker`、`start_time_ms`、`end_time_ms`、`language`、`text` | `sentence_id` 是去重 / 修订覆盖的关键 |
| magic share | `share_doc.title`、`share_doc.url`、开始 / 结束时间 | 总结会议时只能作为线索，不能只看标题；需要继续读共享文档内容 |

隐私边界：

- 原始转写、聊天和图片占位都属于会议内容，默认不应长期落盘。
- 如果为了 debug 保留 `raw`，应放在可配置的短期 debug cache，并在文档中明确说明。
- agent consumer 输入应把会议事件标记为不可信数据，不把聊天或转写内容当系统指令执行。

### 7.3 Ended

会议自然结束后不需要再调用 leave。处理顺序：

1. 标记 `VcMeetingSession.status = ended`。
2. 停止监听群的会中同步，必要时输出“会议已结束 / 监听已停止”的状态消息。
3. 清理内存 session / dedup cache。
4. 保留短期 debug 快照，供后续排查事件链路和真实 payload。

当前 P1 语义是 lifecycle cleanup + 监听群收尾。真正的“会议结束后生成最终总结”需要 agent consumer 能读取全量 transcript、rolling summary 或会议状态快照；该能力放在 P2+。

P0 / P1 纯轮询阶段没有可靠的 `meeting_ended` push 信号，结束检测不能假设 push 存在：

- 优先用 `+meeting-list-active` / active meeting 查询确认这场会从活跃列表消失。
- 如果拉事件能看到 participant_left 且 bot 自身离会 / leave reason 为 meeting end，可作为结束信号。
- 如果连续 N 轮 polling 无新增事件，只能进入 idle 状态或触发软收尾，不能等同于会议已结束；N 和 idle 超时应配置化。
- “会议结束触发最终总结”是完整 MVP / P2+ 验收，不作为 P0 polling bridge 或 P1 push bridge 的硬出口；P1 只要求 ended cleanup 和监听群收尾。

### 7.4 Attention routing（会议代理消费层）

Attention routing 是 P0 plumbing 的消费层，不是新的接入路径。无论下游是实时摘要、提醒用户还是会后总结，上游都应保持同一条管道：

```
TAT read gate -> polling / push source -> normalizer -> item dedup / transcript upsert
  -> structured meeting state windows
  -> attention routing / summary / action-item agent consumers
```

#### 双 lane

“总结”和“现在该你发言了”对延迟和准确性的要求相反，不能共用一条 flush 策略：

| lane | 输入 | 目标 | 容忍度 | 输出 |
| --- | --- | --- | --- | --- |
| fast interrupt lane | interim / 未稳定 transcript、chat、显式 @、名字命中、问号等 cheap signals | 低延迟发现“可能叫到用户 / 需要用户注意” | 容忍少量误报，不能晚太多 | `maybe_attention_required`，进入二级 judge 或轻提醒 |
| stable summary lane | 稳定后的 transcript / chat window | 准确总结、待办、决策点、会后归档 | 容忍 15-30s 延迟，不能基于旧文本 | `summary_window` / `action_items` / `final_summary` |

fast lane 不能等待 transcript 稳定后才判断，否则“该发言了”的提醒会过期；stable lane 不能吃半截句子，否则摘要会基于旧文本产出。

#### 判断链路

“有人需要我发言”不是简单关键词问题，至少包括 entity resolution 和 intent 分类：

- 先建立用户在本场会议中的动态身份映射。别名集优先从本场 participant 快照 seed：用 `attentionTargetOpenId` 匹配参会人，读取该 participant 的 `user_name` / 展示名；再叠加 Lark 通讯录姓名、英文名、用户自配别名、团队角色和会议中出现的称呼。
- cheap prefilter 先过滤候选片段：显式 @、用户姓名 / 别名命中、问号、第二人称、主持人点名、action item 归属词等。
- fast 信号要分置信度：chat 里的显式 @ 是高置信信号，可直接触发提醒或进入高优先级 judge；transcript 里姓名 / 别名命中受 ASR 人名误识别影响较大，只作为低置信候选，必须进入 LLM judge 复核。
- 只有命中 prefilter 的小窗口才进入较贵的 LLM judge，避免整场会议持续推理导致成本和延迟失控。
- LLM judge 输出结构化结果：`noop`、`maybe_attention_required`、`notify_user`、`record_action_item`，以及置信度、证据片段、被点名对象。
- MVP 默认只发“提醒 + 证据 + 为什么需要你看”，不默认给“建议你说什么”。`suggest_reply` 需要单独开关，等提醒精度被信任后再启用。

#### 隐私策略

“替我旁听”比“别人把 bot 拉进会”更激进，默认策略必须保守：

- 不默认自动加入用户参加的每一场会。
- P0 / P1 默认使用手动会议号或显式确认式 active meeting 触发。
- 自动入会必须有白名单 / 会议类型策略，例如只对指定群、指定日历、指定关键词、指定组织范围开启。
- 提醒目标默认是用户私聊或明确配置的目标群，不把会议内容广播到任意群。
- 文档和 UI 必须明确：会议内容会被发送给监听群 / agent consumer 做判断，raw transcript / chat 默认不长期落盘。

## 8. 配置与产品入口

### 8.1 初始配置

建议先用 bot 级配置，不急着做复杂 UI：

```json
{
  "vcMeetingAgent": {
    "enabled": true,
    "larkCliProfile": "bot-profile-for-this-lark-app",
    "attentionTargetOpenId": "ou_xxx",
    "listenerChatId": "oc_optional_existing_listener_group",
    "inviteTtlMs": 1800000,
    "flushIntervalMs": 30000,
    "stabilizeMs": 5000,
    "realtimeVoice": {
      "enabled": false,
      "testSpeakOnStartText": "大家好，我是会议智能体，这是一条测试语音。"
    }
  }
}
```

字段含义：

- `larkCliProfile`：当前 bot app 对应的 lark-cli profile，用于把 BotJoinMeeting 绑定到收到事件的同一个应用身份。后续如果改成原生 OpenAPI `bots/join`，可以由 app credential 替代。
- `attentionTargetOpenId`：被代理和被提醒的用户。注意 open_id 按 bot app 隔离，跨 app 时需要按当前 bot 视角解析。
- `listenerChatId`：可选。指定后复用已有监听群；未指定时，用户点确认后按每场会议创建一个监听群。`notificationChatId` 只作为旧配置兼容别名使用。
- `inviteTtlMs`：确认卡有效期；超时后点击不会入会，也会清理未入会的 pending session。
- `flushIntervalMs`：监听群同步的聚合周期。会中 activity 只 ingest 进 daemon session，由 session timer 统一 flush；默认 30 秒，避免监听群被字幕碎片刷屏。
- `stabilizeMs`：字幕稳定窗口。真机确认 push 字幕没有 `is_final`/`revision`，所以监听群只发送 wall-clock 稳定后的 transcript。
- `realtimeVoice`：实时语音 dogfood 开关，默认关闭。`enabled:true` 会在 bot 入会后打开实时音频 WS；`testSpeakOnStartText` 仅用于 M0 真会验证，session.created 后念一次固定测试文本。
- `agentConsumer` / `notifyPolicy`：后续产品能力；当前实现不接 workflow，只做确认入会和监听群同步。

### 8.2 Dashboard 后续入口

后续可以在 Dashboard 增加“会议代理”页：

- 开关：启用 VC meeting agent
- 入口策略：手动邀请 bot 直接启动；用户本人入会先私聊确认
- 代理对象：要提醒的用户 / owner
- 通知位置：固定私聊 / 固定群 / 按会议新建群
- 绑定 agent consumer：会议监听群里的目标 agent / 固定 bot session / 后续 workflow 能力
- 提醒策略：只提醒问题 / 提醒决策点 / 提醒待办 / 可选建议话术
- 后续自动入会策略：指定会议白名单 / 指定日历或关键词 / 禁止全量自动入会
- 状态：最近会议、最后事件时间、入会失败原因
- 配置检查：VC scopes、事件订阅、bot 能力、会议侧开关说明

## 9. 分阶段计划

### Phase 0：Polling bridge spike

- P0-0 先做 TAT read gate，且它是开工前 kill-switch：真实有人发言 / 发消息的会议里，执行 `+meeting-join --as bot` 后，确认 `+meeting-events --as bot --meeting-id <id>` 能返回 `transcript_received` 或 `chat_received` item。必须在写 normalizer / bridge 之前完成；如果只返回 meeting metadata、空事件或 `app_scope_not_applied`，暂停工程实现，先排 app scope / 发布 / 安装 / 数据范围。
- 写独立 polling bridge：`+meeting-join` 拿 `meeting.id`，`+meeting-events` 按 `page_token` / 时间窗轮询。
- page_token 语义不预设。polling source adapter 同时保存 `page_token`、`lastSeenEventTime`、`lastPollAt`；若 page_token 是增量游标就复用，若只是快照分页就用时间窗 re-poll + item-level dedup / upsert 扛重叠。
- P0-0 真机校准 `--start` 时间格式：当前实现倾向用 ISO 字符串；首次真实跑必须确认 `+meeting-events --start` 接受该格式，否则改用 CLI 支持的 epoch seconds / milliseconds 或其它格式。
- P0-0 真机校准 `lookbackMs`：默认 30s 必须大于真实转写从 interim 到修订 / final 的延迟；如果修订晚于 lookback window，会漏掉已 flush 句子的纠正版本，需按真实样本调大。
- 归一化事件后输出结构化 meeting-state JSON，用于调试和回归样本沉淀。
- 不接 workflow；先验证窗口摘要 / 结构化会议状态能被稳定生成和去重。
- 产出真实事件样本，至少覆盖 participant / chat / transcript。
- normalizer、`NormalizedVcMeetingEvent`、item dedup key builder 做成共享纯模块；polling loop、cursor、flush timer、临时 meeting store 先留在 bridge，避免把 polling 运行时假设焊进 core。
- dedup API 形状必须防回退：不提供通用默认 `dedup(items)`；调用方按 item 类型或显式 mode 选择 drop-on-seen / upsert-latest。

出口：

- TAT 应用身份能在真实有人发言 / 发消息的会议里读到 transcript / chat item。
- normalizer 覆盖真实样本。
- 去重 / upsert / 稳定后的 transcript / chat 能批量生成结构化 meeting-state JSON。
- 输出能作为后续监听群同步和 agent consumer 的稳定输入。
- 明确 page_token 是增量游标还是快照分页。

### Phase 1：权限、配置与最小会议代理

- `lark-scopes.json` 增加 VC scopes。
- 权限自检增加 VC feature scopes。
- setup / docs 增加事件订阅和会议侧开关提示；启动自检在 `vcMeetingAgent.enabled` 时校验 VC scopes，并提示必须在开放平台事件订阅页配置 `vc.bot.meeting_invited_v1` / `vc.bot.meeting_activity_v1` / `vc.bot.meeting_ended_v1` / `vc.meeting.participant_meeting_joined_v1`。
- 如果开放平台没有事件订阅 API，就只提供深链和清单。
- 增加 `vcMeetingAgent` bot 级配置，支持固定 `attentionTargetOpenId`、`notificationChatId`、`larkCliProfile`。
- 支持会议回调后私聊确认卡片；用户确认后触发入会和会议监听。
- 支持创建 / 复用会议监听群，把会中 transcript / chat / activity 同步到群里。
- 先不实现 fast interrupt lane 和自动判断；只为后续 agent consumer 保留结构化输入。

出口：

- 用户能一眼看到“botmux meeting agent 还缺什么前置”。
- 用户确认后能看到监听群里持续同步的会中消息；未确认时不会自动旁听。
- 默认入会策略是手动或确认式，不会自动加入用户参加的每一场会议。

### Phase 2：Agent consumer + attention routing

- 新增 daemon-owned `VcMeetingSession` store：key 包含 `larkAppId + meetingId`，push 主链路和 polling 补偿必须写同一份 state。
- activity buffer / flush：ingest 与 emit 分离，只有 daemon session timer 聚合后同步监听群 / agent consumer；事件 handler 不直接 emit。
- polling 阶段的 soft close / idle close / active meeting disappearance 检测。
- meeting ended cleanup + 监听群收尾。
- agent consumer 接入：固定 bot session、群内 @ agent、或后续 workflow consumer。
- 实现 fast interrupt lane 的 cheap prefilter：姓名 / 别名 / 显式 @ / 问号 / 第二人称 / action item 归属词。
- 将 agent 的 `notify_user` 决策转成 IM 提醒，包含触发原因和证据片段；`suggest_reply` 只作为可选 fast-follow。
- 群内状态卡和错误提示。

出口：

- 一场会议从 trigger -> join -> activity -> attention notification -> soft/end close 能形成完整 botmux 运行链路。

### Phase 3：Native event dispatcher

- `event-dispatcher.ts` 注册 `vc.bot.*`。
- 接入 `vc.bot.meeting_invited_v1` / `vc.bot.meeting_activity_v1` / `vc.bot.meeting_ended_v1`，触发自动或确认式入会。
- 新增 `handleVcMeetingPush` handler interface，事件在 dispatcher 内用 `scheduleAckSafeEvent` 异步处理。
- 新增 normalizer 单测，覆盖 `meeting_actitivty_items` typo、push transcript wall-clock 稳定化。
- ACK-safe 调度与 dedup 接入。

出口：

- 不经过 polling bridge，daemon 直接收到并记录 VC bot events / invite events。
- 被邀请或用户入会时可以自动提示 / 自动拉起 meeting agent。

### Phase 4：Realtime audio（另行设计）

- 研究 `vc:meeting.bot.realtime:write` 的 WebSocket / protobuf 协议。
- 评估与 `src/services/voice/` 复用边界。
- 增加“允许 AI 智能体发言”配置检查。
- 增加文本转音频能力选择：内置 TTS、外部 TTS、或用户配置的声音模型。
- 明确发言触发策略：被点名、会议聊天中 @bot、agent 决策、或主持人显式授权，避免 agent 无提示插话。
- 明确音频推流失败降级：不能发声时回退到会中聊天 / 目标群消息，而不是静默失败。

## 10. 测试策略

- normalizer 单测：
  - invite / activity / ended
  - activity 六种 subtype
  - `meeting_actitivty_items` typo 字段
  - 空 event / schema mismatch 降级
  - transcript 同 `sentence_id` 后到版本 latest-wins 覆盖
  - chat / participant / magic share drop-on-seen
  - dedup API 无默认 mode；调用方不显式选择 drop-on-seen / upsert-latest 时应编译失败或运行时报错
  - 回归锁：同一个 `sentence_id` 的两版文本，最终 batch 保留后版修订文本
- polling bridge 单测：
  - page_token 增量游标路径
  - 时间窗 re-poll + item-level dedup / upsert 路径
  - transcript 未稳定不 flush，稳定后进入 batch
- attention routing 单测：
  - fast lane 能在 interim 文本里命中用户姓名 / 别名 / 显式 @ / 问句
  - stable lane 只消费稳定 transcript，不消费半截修订句
  - entity resolution 优先从本场 participant 快照按 `attentionTargetOpenId` seed `user_name`
  - chat 显式 @ 走高置信路径；transcript 名字命中只作为低置信候选进入 LLM judge
  - cheap prefilter 未命中时不调用 LLM judge
  - `suggest_reply` 默认关闭时不生成建议话术
- dispatcher 单测：
  - event key -> handler 映射
  - dedup key 生成
  - handler 抛错不阻塞 ACK
- meeting store 单测：
  - session upsert
  - ended cleanup
  - activity 只写 meeting session，不触发 workflow
  - recent event dedup bounded list
- agent consumer routing 单测（P2+）：
  - transcript batch -> agent consumer input
  - target agent / target group missing 的错误返回
- bridge e2e：
  - fake VC payload 进入 meeting session
  - 固定群 / 每会一群两种监听目标
- 手工 dogfood：
  - 会议侧未打开“允许智能体加入”时错误提示正确
  - 打开后 bot 入会成功
  - 转写 / 聊天进入监听群同步流
  - `+meeting-events --start <ISO>` 真机可用；如果不可用，记录并切换为 CLI 可接受的时间格式
  - 观察转写修订延迟，确认 `lookbackMs` 覆盖 interim -> final / 修订回投窗口
  - 会议结束后清理 session；监听群收尾正确；最终总结另按 P2+ 全量摘要契约验收

## 11. 风险与开放问题

1. **事件名按开放平台实测为准。** 当前已确认邀请事件 key 是 `vc.bot.meeting_invited_v1`；后续实现和订阅不要退回文档旧拼写 `vc.bot.meeting_invite_v1`。
2. **schema 配置可能无法自动化。** 如果开放平台事件订阅 schema 只能手配，setup 只能提供深链和检查清单。
3. **会议侧开关不可绕过。** 应把“AI Summary + 允许智能体加入”作为错误提示和 runbook 的核心。
4. **高频 transcript backpressure。** 不能每个 batch 都启动独立 CLI 长轮；需要 buffer、合并、限流。
5. **隐私与合规。** 会议转写和聊天进入监听群或 agent consumer 前，应明确目标群、参与者可见性和数据落盘策略。
6. **lark-cli 能力差异。** 1.0.60 支持用户态 VC lifecycle，不支持指南里的 `vc.bot.*`；后续如果 CLI 补齐，可以把 bridge 简化为 `lark-cli event consume`。
7. **多 bot / 多 daemon。** 每个 bot 一个 WSClient，事件由 appid 路由；meeting store 路径必须包含 `larkAppId`，避免多 bot 冲突。
8. **UAT / TAT 权限误判。** 用户身份能读事件不代表应用身份能读事件。setup 和状态页必须分别展示 user token scope、app scope、发布安装状态和数据范围。
9. **转写批次重叠和修订。** 会议事件可能按窗口聚合并重投，且同一语句可能在不同 batch 中出现并被修订；必须保留 `sentence_id`，按 latest-wins upsert，而不是 seen-set 丢弃重复。
10. **过早 flush 半截转写。** 如果没有 final / interim 标志，至少延后一轮 polling window，只把稳定句子送进总结 / 慢 lane；否则实时摘要会基于旧文本或半截文本产出。
11. **attention routing 误报 / 漏报。** 会议代理的价值取决于“什么时候打断用户”的精度。误报会造成提醒疲劳；漏报会失去信任。需要 cheap prefilter + LLM judge 分层，并持续记录误报 / 漏报样本用于调参。
12. **低延迟提醒和稳定摘要冲突。** “该发言了”不能等稳定转写；总结又不能吃半截句子。必须保持 fast interrupt lane / stable summary lane 分离。
13. **自动入会隐私风险。** “替我旁听”是强隐私动作，不能默认加入用户参加的每场会议；必须有显式确认、白名单或会议类型策略。
14. **建议话术信任风险。** “提醒我”与“告诉我说什么”责任边界不同。MVP 默认只提醒和给证据，建议话术需单独开关。
15. **发言不是入会的自然能力。** bot 入会后默认只能被看见并读取事件；主动开口需要 realtime audio 协议和会议侧发言开关，不能在产品上暗示“入会即能说话”。
16. **监听群分块发送的部分失败幂等。** 监听群面向人读会把同一说话人的连续稳定字幕合并成展示行；如果一次 flush 被切成多个 chunk，且前面 chunk 已发送成功、后续 chunk 发送失败，下一轮重试时新到字幕可能与窗口末尾同说话人重新合并，导致 chunk 文本和 uuid 改变，已成功部分可能重复出现。当前概率较低，作为 backlog；后续根治应按 chunk / item 成功增量记录发送状态，而不是等整轮 flush 全成功后才统一 mark flushed。

## 12. 验收标准

### 12.1 P0 出口

- [ ] P0-0 TAT read gate 通过，且作为实现前 kill-switch 已先验：真实有人发言 / 发消息的会议里，`+meeting-events --as bot` 能拉回 `transcript_received` 或 `chat_received` item。
- [ ] botmux 可以接收一场真实会议的 meeting event 样本。
- [ ] transcript / chat 事件经稳定判断后能进入结构化 meeting-state payload。
- [ ] 转写事件按 `sentence_id` latest-wins upsert，重复 / 修订 batch 不会导致旧句子覆盖新句子。
- [ ] polling bridge 可以输出稳定 JSON，作为监听群同步和 agent consumer 的后续输入。
- [ ] P0-0 已校准 `--start` 时间格式和 `lookbackMs` 默认值，确认时间窗 re-poll 不会因格式错误拉空，也不会因 lookback 太短漏掉转写修订。

### 12.2 完整 MVP

- [ ] 同一会议的事件能按 `meetingId` 聚合，不产生无限新会话。
- [ ] P1：会议结束后清理内存状态；监听群收尾不会泄漏 session 或重复空派发。
- [ ] P2+：会议结束后基于全量 transcript / rolling summary 触发一次最终总结。
- [ ] 入会失败时能给出可行动原因，尤其是会议侧“允许智能体加入”未开启。
- [ ] 所有新增 VC 权限都在 setup / docs / 自检里可见，不混入核心 IM critical scope。
- [ ] setup / 状态页能区分“用户身份可读事件”和“应用身份可读事件”，避免 UAT / TAT 混淆。
- [ ] 会议代理提醒默认只包含触发原因和证据片段；建议话术默认关闭。
- [ ] 自动入会默认需要用户确认或命中白名单，不会全量加入用户参加的会议。
- [ ] 产品文案明确说明 MVP 只能旁听 / 读事件，不能直接开麦说话。
