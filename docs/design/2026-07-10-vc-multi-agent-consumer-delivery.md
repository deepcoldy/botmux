# 飞书会议多 Agent Consumer：fan-out、幂等投递与副作用闸门设计

> 状态：设计定稿并完成 MA-P0 / MA-P1 实现、交叉评审与隔离测试会议验证
> 实现范围：可靠投递、独立 cursor、action gate、多 Agent fan-out、角色预设、恢复与会后追问路由
> 关联：[`2026-06-30-vc-bot-subscriptions-integration.md`](./2026-06-30-vc-bot-subscriptions-integration.md) 定义会议接入、归一化与单 consumer 基线；[`2026-07-01-vc-bot-realtime-voice.md`](./2026-07-01-vc-bot-realtime-voice.md) 定义实时语音执行链路。

## 1. 一句话决策

保留现有的**单 listener bot / 单 canonical meeting feed**，在消费层增加多个有明确角色的 agent；hub 为每个 agent 签发独立、连续的 `deliverySeq`，每个 agent 独立推进 cursor。所有对人和外部系统的副作用都必须经过 daemon 的确定性 action gate，并由唯一 sink owner 执行。

核心原则是：

> 分析可以有多份，副作用必须是单出口。

本期不引入通用 LLM coordinator，也不引入 SQLite。先把单 agent 的投递耐久性和幂等修好，再打开多 agent fan-out；只有未来出现多个 agent 必须共同写同一 sink 的真实需求时，才增加 proposal / merge / quorum 层。

## 2. 范围与边界

本稿是既有会议设计的**消费层增量设计**，不重写以下已经落地的能力：

- bot 入会 / 离会和会议 ended 生命周期；
- push / polling 事件接入、normalizer 和 transcript stabilization；
- chat / participant / magic share 的 item 去重；
- transcript 按 `sentence_id` latest-wins / revision 更新；
- 监听群同步和实时语音的 WS / protobuf / PCM 管线。

本稿负责：

- 单份 normalized feed 如何 fan-out 给多个 agent；
- 每个 agent 的顺序、cursor、重试、暂停和恢复如何隔离；
- fast lane、定时 flush 和 final flush 如何共用同一条流；
- agent 输出如何经过 capability、sink owner、审批和幂等账本；
- daemon 崩溃、远端 daemon 离线、事件重投和无法回补时的可见语义。

非目标：

- 不承诺“LLM 恰好理解一次”或端到端 exactly-once；
- 不做任意多个 agent 的自由讨论、投票或自动共识；
- 不把会议 feed 建模为 workflow run / node / attempt；
- 不允许多个 listener 同时各自入会和采集同一场会议；
- 不在本期解决 agent 裸调 `lark-cli` / 其它 SDK 绕过 daemon 的强隔离，该路径属于自家 bot 的信任边界。

旧稿记录的 listener group 多 chunk 部分成功 / 重试幂等仍是相邻 backlog；除非该 flush 也接入稳定 action ledger，本稿的 consumer delivery cursor 不会自动修好它。

## 3. 当前实现事实与问题

现有代码已经是 hub-and-spoke，而不是“每个 agent 自己监听会议”：

```text
vc.bot.* push / polling
  -> listener daemon
  -> normalize + meeting state
  -> listener group
  -> selected agent（本地 trigger 或跨 daemon /api/trigger）
```

需要修复的不是拓扑，而是消费协议：

1. `VcMeetingDaemonSession` 只有一份 `selectedAgentAppId`、`consumerPendingItems`、`consumerInjectPromise` 和 transcript revision map；第一个 agent 成功清账后，其它 agent 将无数据可读。
2. consumer request id 和 `dedupKey` 含 `Date.now()`；崩溃重试会换 key。
3. `TriggerRequest.options.dedupKey` 已存在，但 `triggerSessionTurn` 当前不读取它。
4. trigger 返回 `queued` / `delivered` 后才清内存 pending；“投递成功与清账之间崩溃”会重注，“清账后 worker 真正处理前崩溃”又可能丢失。
5. item seen-set、transcript revision、consumer cursor 和 pending 都只在内存；runtime store 只恢复会议元数据。
6. push 路径没有持久化位点回补；停机窗口既可能因平台重投而重复，也可能因平台不重投而永久漏失。
7. `consumerPendingItems` 超限时会静默 `splice` 最旧数据；多 agent 后该问题会按 agent 数量放大。
8. `request-output` 没有可靠的调用 agent、membership epoch、稳定 action id；当前 per-channel pending merge 不是语义幂等。
9. 文本输出的 Lark UUID 来自一次 request id，只能挡同一次调用重发；语音输出没有 provider 级幂等键。
10. runtime store 是 tmp + rename，但 read-modify-write 没有跨进程 file lock；不能让多个 consumer daemon 共同修改 listener 的会议状态。

因此直接把 `selectedAgentAppId` 改成数组只会得到多份重复和更多崩溃窗口，不是可上线方案。

## 4. 对外保证：诚实地定义“去重”

MVP 对外只承诺：

```text
ingest:       at-least-once + item version 去重 / upsert
delivery:     per-agent 有序流 + cursor 去重 + 失败可重放
side effect:  daemon action gate + 稳定 actionId + provider 幂等 / reconcile
```

不承诺：

- Lark push 恰好送达一次；
- agent 的 CLI turn 恰好运行一次；
- 两次自然语言推理一定产生相同文字；
- 不支持幂等查询的 voice provider 在未知结果后可以安全自动重试。

目标是把不可避免的 at-least-once 限制在分析层，阻止它穿透成重复发消息、重复建任务或重复播音。

## 5. 术语与硬不变量

### 5.1 三层身份

| 层 | 稳定身份 | 解决的问题 |
| --- | --- | --- |
| ingest | `itemVersionKey = hash(meetingId, itemKey, revision)` | 同一平台事件重投、字幕修订 |
| delivery | `(meetingId, memberId, epoch, deliverySeq)` | 同一 agent 的有序重放和 cursor |
| effect | `actionId = hash(meetingId, memberId, epoch, sourceKind, sourceKey, sink, slot)` | agent 重试和 provider 副作用去重 |

`batchId` 只是一次 HTTP 信封的观测字段。重试时 batch 边界可能变化，它不能成为幂等锚。

### 5.2 不变量

1. 每个 `(listenerAppId, meetingId)` 同时只能有一个有效 hub owner。
2. 每个 active member 在一场会议中拥有独立的 `epoch + deliverySeq`。receiver 独占推进 `receiverCommittedThrough`，hub 只记录已观察到的 `senderAckedThrough`。
3. `deliverySeq` 由 hub **按 member 独立签发**，不能直接使用共享 `ingestSeq`。角色过滤会让共享 ingest 流产生确定性的洞。
4. 同一 member 的 fast lane、slow lane 和 final marker 必须进入同一条 delivery stream，不能旁路 cursor。
5. transcript 的新 revision 是新的 feed entry 和新的 delivery entry；旧 cursor 不得吞掉迟到修订。
6. 一个 member 的超时、离线和 backpressure 不得阻塞 listener group 或其它 member。
7. 队列超限不能静默删数据；只能暂停、告警，或以显式 gap entry 解决缺口。
8. 同一 `(meeting, sink)` 在 v1 只能有一个 active owner；配置冲突直接拒绝激活。
9. 旧 membership epoch 或旧 sink-owner generation 不能授权新的 effect；命中既有 actionId 的重试只允许回显原状态 / 结果。
10. 所有 provider 副作用必须先写 intent / `attempting`，再调用 provider。

## 6. 总体架构

```text
                         ┌─ role/filter ─> member A delivery stream ─> agent A
push/poll -> normalize ──┼─ role/filter ─> member B delivery stream ─> agent B
             canonical   └─ role/filter ─> member C delivery stream ─> agent C
             item feed

agent A/B/C action intent
             |
             v
daemon action gate
  -> membership/epoch
  -> capability
  -> unique sink owner generation
  -> meeting output policy / approval
  -> actionId + inputHash ledger
  -> provider（listener IM / meeting text / voice / task）
```

listener daemon 是 canonical feed、membership 和 effect ledger 的唯一写者。consumer agent 可以在同一个 daemon，也可以在其它 daemon；两种情况必须走同一个 receiver handler 和相同 cursor 语义，不能保留“本地直接调用无账本、远端才走 HTTP”的两套行为。

### 6.1 为什么 v1 不需要 coordinator agent

角色配置优先在结构上消灭重复：

- minutes agent 只产出纪要；
- action-items agent 只维护任务；
- attention agent 只负责紧急提醒；
- speaker agent 才能申请会中弹幕 / 语音。

它们的 sink 不相同，所以不需要额外 LLM 合并。coordinator 只在多个 agent 必须同时写同一个 sink 时才有价值；那属于条件触发的后续阶段。fast attention lane 尤其不能被 proposal -> merge -> execute 的额外两跳拖慢。

## 7. 数据模型

以下类型表达协议，不要求第一版逐字照搬命名。

### 7.1 Canonical feed metadata

```ts
type MeetingFeedEntryMeta = {
  ingestSeq: number;
  itemKey: string;
  revision: number;
  itemVersionKey: string;
  type: NormalizedVcMeetingItem['type'];
  occurredAtMs?: number;
  source: 'push' | 'polling';
  eventId?: string;
  contentHash: `sha256:${string}`;
};
```

- 对协议上不可变的非 transcript item，`revision` 固定为 `1`；重复 `itemKey + contentHash` 直接丢弃，同 key / 不同 hash 记为 `identity_conflict` 并隔离，不能生成冲突的同名 item version。若未来某类 item 明确支持修订，必须像 transcript 一样引入本地单调 revision。
- transcript 继续按 `sentenceId` 聚合；文本、final 状态或外部 revision 发生有效变化时，本地 revision 单调增加并分配新的 `ingestSeq`。外部 revision 低于已见版本时不得回滚；没有可靠外部 revision 时以持久化 content hash 判重。
- `contentHash` 对规范化后的语义字段计算，排除 `source`、`eventId`、poll page token 等传输字段。
- feed journal 的一个 locked append 同时写 entry metadata 和对应 membership assignment，避免“feed 已持久化、fan-out 尚未分配”之间留下孤儿。

### 7.2 Consumer profile 与 runtime membership

配置描述可选择的 profile，运行态描述本场会议实际激活的 membership：

```ts
type MeetingSink =
  | 'listener_chat'
  | 'listener_notice'
  | 'meeting_text'
  | 'meeting_voice'
  | 'attention_dm'
  | 'task';

type MeetingConsumerProfile = {
  id: string;
  agentAppId: string;
  label?: string;
  role: string;
  filter?: MeetingItemFilter;
  responseMode: 'silent' | 'listener_thread';
  capabilities: string[];
  ownedSinks?: MeetingSink[];
};

type MeetingMember = {
  memberId: string;
  profileId: string;
  agentAppId: string;
  role: string;
  status: 'activating' | 'active' | 'paused' | 'failed' | 'removed';
  epoch: number;
  joinedAtIngestSeq: number;
  filter: MeetingItemFilter;
  responseMode: 'silent' | 'listener_thread';
  capabilities: string[];
  delivery: {
    nextSeq: number;
    senderAckedThrough: number;
    inFlight?: { fromSeq: number; toSeq: number; deliveryKey: string };
  };
  receiverSessionId?: string;
};

type MeetingReceiverStream = {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  ownerEpoch: number;
  receiverSessionId: string;
  receiverCommittedThrough: number;
  activeReceipt?: { deliveryKey: string; fromSeq: number; toSeq: number };
};
```

v1 要求一场会议内 active member 的 `agentAppId` 唯一。若同一个 agent 需要承担多个角色，应合成一个 profile；把两个 role 注入同一个 CLI session 会导致上下文和输出归属混淆。

`listener_notice` 保留给 daemon `system` principal，用于缺口、owner 冲突和数据健康告警，不能配置给 member。其它 sink 才参与 member 的 unique-owner 校验。

activation 必须创建或绑定 `(listenerAppId, meetingId, memberId, epoch)` 专属的 `receiverSessionId`。delivery 以 session id 为主目标，listener chat id 只用于产品输出路由。这样同一个监听群、同一个 agent 同时消费两场会议时也不会折叠进一份 chat-scope 上下文。

### 7.3 Delivery assignment

```ts
type DeliveryAssignment = {
  memberId: string;
  epoch: number;
  deliverySeq: number;
  ingestSeq?: number;
  itemVersionKey?: string;
  contentHash?: string;
  kind: 'item' | 'final' | 'gap' | 'effect_result' | 'control';
  priority: 'fast' | 'normal';
  gap?: {
    occurredFromMs?: number;
    occurredToMs?: number;
    missingItemVersionKey?: string;
    originalContentHash?: string;
    reason:
      | 'retention_expired'
      | 'poll_unavailable'
      | 'recovery_ambiguous'
      | 'backpressure_skipped'
      | 'operator_skip';
  };
  controlKey?: string;
};
```

fast signal 只改变 seal / flush 时机：hub 立即封装该 member 当前待投递的连续前缀，确保较早的 normal item 不被越过。final marker 也在所有已分配会议 delta 之后占用唯一 seq，但它只表示“会议数据输入结束”，不代表 control stream 已关闭；审批 / effect 的 terminal result 仍可以在 finalization deadline 前以 `effect_result` 进入同一条流。

### 7.4 Sink owner 与 effect record

```ts
type SinkOwner = {
  sink: MeetingSink;
  memberId: string;
  memberEpoch: number;
  generation: number;
};

type MeetingEffectRecord = {
  actionId: string;
  actionSlot: string;
  source:
    | { kind: 'delivery'; key: string; deliverySeq: number }
    | { kind: 'im_turn'; key: string; larkMessageId: string };
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  agentAppId: string;
  sink: MeetingSink;
  ownerGeneration: number;
  inputHash: string;
  providerKey: string;
  status:
    | 'requested'
    | 'pendingApproval'
    | 'approved'
    | 'attempting'
    | 'succeeded'
    | 'failed'
    | 'rejected'
    | 'expired'
    | 'unknown';
  canonicalInput: unknown;
  externalRefs?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
```

`actionId` 由 daemon 派生，不能让 agent 任意填写。`slot` 默认为 `primary`，因此同一 source turn 默认只能对同一 sink 提交一个主要 action；非 primary slot 需要额外 capability，并使用稳定业务键。内容放入 `inputHash`，不放进 action identity：同 `actionId` 不同输入必须返回 409，而不是悄悄执行第二次。

`ownerGeneration` 是授权快照，不是 action identity。某 member 以后重新取得 sink ownership，再提交同一个 source turn / sink / slot 时仍只能得到旧结果，不能借 owner 切换重新执行。

## 8. 配置与兼容迁移

推荐把现有 `agentCandidates` 扩展成 profile，把默认单选扩展为 profile id 列表：

```json
{
  "vcMeetingAgent": {
    "meetingConsumer": {
      "enabled": true,
      "defaultMode": "agents",
      "defaultConsumerIds": ["minutes", "attention"],
      "consumerProfiles": [
        {
          "id": "minutes",
          "agentAppId": "cli_xxx",
          "label": "纪要",
          "role": "minutes",
          "responseMode": "silent",
          "capabilities": ["meeting.read", "listener.output.request"],
          "ownedSinks": ["listener_chat"]
        },
        {
          "id": "attention",
          "agentAppId": "cli_yyy",
          "label": "提醒",
          "role": "attention",
          "responseMode": "silent",
          "capabilities": ["meeting.read", "attention.request"],
          "ownedSinks": ["attention_dm"]
        },
        {
          "id": "speaker",
          "agentAppId": "cli_zzz",
          "label": "会中发言",
          "role": "speaker",
          "responseMode": "silent",
          "capabilities": ["meeting.read", "meeting.output.request"],
          "ownedSinks": ["meeting_text", "meeting_voice"]
        }
      ]
    }
  }
}
```

兼容规则：

- 旧 `defaultMode: "agent" + defaultAgentAppId` 规范化成一个 `legacy-generalist` profile 和一个 active member。
- 旧 `agentCandidates[]` 规范化成 generalist profiles，保留现有单选卡体验。
- 旧配置的 response mode 保持当前 listener group 行为，避免升级后 agent 突然沉默。
- 新配置同时出现两个相同 sink owner、重复 active `agentAppId`、不存在的 default profile 时，在启动 / 卡片确认阶段显式报错，不做 last-write-wins。
- runtime store 增加 `schemaVersion`；读到 v1 singular record 时迁移成单 member，首次成功写回 v2。

精确兼容值：legacy profile 使用 `role=generalist`、`responseMode=listener_thread`、`capabilities=[meeting.read, meeting.output.request]`，并在会议 text / voice policy 允许时成为这两个 sink 的 owner。旧 `agentCandidates` 省略时继续动态展示所有在线且 working dir 可用的 bot，选中后即时生成 legacy profile。若同一配置同时出现 `consumerProfiles` 和旧字段，新字段优先，旧字段只记 deprecation warning，不能混合合并出隐式 owner。

多选卡应显示每个 profile 的 role、输出权限和 activating / active / failed 状态。部分 agent 激活失败时保留成功者，不把整场降级为 listen-only。

## 9. 投递协议

### 9.1 Membership projection 与专属 session

remote receiver 不能只凭 delivery 正文判断“谁是最新 member”。hub 在激活、修改、暂停或移除 member 时，必须先把带 fencing 的 membership projection 同步给 consumer daemon；同 daemon 也调用同一个 handler：

```http
POST /api/vc-meetings/members/register
POST /api/vc-meetings/members/update
```

```ts
type MeetingMemberProjection = {
  schemaVersion: 1;
  meeting: {
    listenerAppId: string;
    meetingId: string;
    ownerBootId: string;
    ownerEpoch: number;
  };
  member: {
    memberId: string;
    agentAppId: string;
    role: string;
    epoch: number;
    membershipGeneration: number;
    status: 'active' | 'paused' | 'removed';
    joinedAtIngestSeq: number;
    responseMode: 'silent' | 'listener_thread';
  };
  outputRoute: { chatId: string };
};
```

register 在 receiver 创建或恢复 `(listenerAppId, meetingId, memberId, epoch)` 专属 CLI session，返回 `receiverSessionId + receiverCommittedThrough`。receiver 持久化每个 member 的 owner epoch / membership generation 高水位；普通 delivery 无权自行抬高这些值。旧 owner、旧 generation 和已 removed epoch 都被拒绝。

当前 endpoint 沿用仓库的同机 loopback-trusted daemon 边界。若未来允许跨主机，projection / delivery 必须增加 daemon-to-daemon 签名，不能信任正文里的身份字段。

### 9.2 local / remote 统一 delivery 与 status

```http
POST /api/vc-meetings/deliver
GET  /api/vc-meetings/deliveries/:deliveryKey
```

```ts
type MeetingDeliveryRequest = {
  schemaVersion: 1;
  meeting: {
    listenerAppId: string;
    meetingId: string;
    ownerBootId: string;
    ownerEpoch: number;
  };
  member: {
    memberId: string;
    agentAppId: string;
    role: string;
    epoch: number;
    membershipGeneration: number;
  };
  stream: {
    fromSeq: number;
    toSeq: number;
    batchId: string;       // 仅观测
    inputHash: string;
    final: boolean;
  };
  entries: Array<{
    deliverySeq: number;
    ingestSeq?: number;
    itemVersionKey?: string;
    contentHash?: string;
    kind: 'item' | 'final' | 'gap' | 'effect_result' | 'control';
    controlKey?: string;
    gap?: DeliveryAssignment['gap'];
    rawText: string;
  }>;
  target: { sessionId: string; chatId: string };
  instructionVersion: string;
};

type MeetingDeliveryReceipt = {
  ok: true;
  status:
    | 'accepted'
    | 'dispatched'
    | 'completed'
    | 'duplicate'
    | 'failed_retryable'
    | 'failed_terminal'
    | 'ambiguous';
  memberEpoch: number;
  receiverCommittedThrough: number;
  deliveryKey: string;
  stableTurnId: string;
  receiverSessionId: string;
  receiverBootId: string;
  workerGeneration: number;
  dispatchAttempt: number;
};
```

POST 只需完成 durable accept 后即可返回；hub 用 GET 查询 terminal receipt。重复 POST 完整相同的 envelope 也必须返回当前 receipt，不能再次 dispatch。长 turn 不占用原始 HTTP 连接。

### 9.3 key、receipt 真源与 batch 冻结

- `inputHash = computeInputHash(canonicalRequest)`，计算时排除 `sentAt`、trace id 和 `inputHash` 自身。
- `deliveryKey = boundedHash(meetingId, memberId, epoch, fromSeq, toSeq, inputHash)`，控制在 Lark UUID 可接受的 50 字符内。
- meeting delivery receipt 是顺序和完成状态的唯一真源；`stableTurnId = deliveryKey`。
- 从 `triggerSessionTurn` 抽出通用 `claimDedup(key, inputHash)` primitive。meeting receiver 与普通 `/api/trigger` 可以共用它，但不能各写一份互相独立的 receipt。`triggerSessionTurn` 接收已 claim 的 stable turn context；同 key / 不同 input hash 返回冲突。
- receiver 的最终顺序锚仍是 `(meetingId, memberId, epoch, deliverySeq)`；`deliveryKey` 解决同一 HTTP delivery 的重复提交，不能代替 cursor。
- 一旦 `[fromSeq, toSeq]` 进入 accepted / dispatched，hub 必须冻结 entries、batch 边界、`inputHash` 和 `instructionVersion`。任何与 active receipt 重叠的另一 envelope 返回 409 `delivery_in_flight` 并携带 active deliveryKey。只有明确证明 receiver 从未 accept，才允许重新组 batch。

receipt / tombstone 的保留时间不得短于 `max(hub assignment TTL, meeting runtime TTL, sender retry horizon) + clock-skew margin`。GET 404 只有在该保留承诺仍有效、seq 高于 receiver cursor 且 membership projection 未换代时，才能作为 never-accept 证据；超过保留期一律按 ambiguous 处理，不能据此改写 assignment。

### 9.4 receiver 与 sender 规则

1. receiver 校验目标 app、membership projection、owner boot / epoch、membership generation 和专属 session 绑定。
2. entries 必须逐项覆盖 `[fromSeq, toSeq]`，每个 seq 由 item / final / gap / effect_result / control 中恰好一个 entry 终结；gap 不授权 cursor 跳号。
3. `toSeq <= receiverCommittedThrough` 时返回 duplicate，不再注入 CLI。
4. `fromSeq !== receiverCommittedThrough + 1` 时返回 409。特别是 `fromSeq <= receiverCommittedThrough < toSeq` 必须返回 `delivery_partial_overlap`，不能只裁掉已 commit 的前缀：整个 batch 共用一份 instruction / inputHash，裁剪后已经不是原 turn。hub 先结算旧 receipt，再从 `receiverCommittedThrough + 1` 组新 batch。
5. 若存在 active receipt，只有相同 deliveryKey 可读取状态；重叠的新 key 返回 `delivery_in_flight`。
6. receiver 先写 durable accepted receipt，再以 stable turn id 调用 `triggerSessionTurn`；同一 member 同时只允许一个 in-flight turn。
7. 收到可靠 `turn_terminal(completed)` 后，receiver 原子写 completed receipt 和 `receiverCommittedThrough=toSeq`。
8. hub 观察 terminal receipt 后才持久化 `senderAckedThrough`；hub 只能 compact 到该值。ACK 丢失时查询相同 key，不能猜测 receiver 进度。
9. retryable / ambiguous / turn-level terminal failure 都保持两个 cursor 不动，并以相同 key 按预算退避重派；达到预算后按 poison batch 策略暂停该 member。协议校验类 terminal failure 可立即暂停。人工可以 retry、移除或显式 abandon，但不能静默越过。
10. 旧 `consumer-catch-up` 只允许 wake / retry 当前 stream head，不能再 force inject 一条旁路 turn。

分析型 member 的 final output 由 daemon capture / discard，不自动发到 listener group；`listener_thread` profile 才允许 fallback reply。所有 daemon -> consumer 的审批结果、策略更新和关闭通知也走同一 stream，使用稳定 `controlKey`，不能直接调用一次随机 key 的 trigger。

### 9.5 可靠 turn terminal 与无法原子的窗口

当前 bridge 的非空 `final_output` 不是可靠完成合同：silent / 空回答、agent 已主动 `botmux send`、worker error / exit 都可能没有可用于结算的 final text。MA-P0 必须新增与展示文本解耦的 worker -> daemon 事件：

```ts
type TurnTerminal = {
  type: 'turn_terminal';
  turnId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
};
```

每个 meeting turn 即使输出为空、被 capture、已走显式 send，也必须产生一次 terminal。worker error / exit 要按 turn id 结算当前和排队 turn。CLI adapter 只有声明并通过 `reliableTurnTerminal` contract test 后，才能被激活为 meeting consumer；首批至少覆盖 Claude Code 和 Codex。

receipt 记录 receiver boot id、worker generation 和 dispatch attempt；每次实际派发由 `(stableTurnId, workerGeneration, dispatchAttempt)` 唯一标识，而 action identity 继续绑定 stable delivery key。daemon / worker 重启后，旧 generation 中没有 terminal 的 dispatched receipt 转成 `ambiguous`，允许使用**同一个 deliveryKey / stableTurnId** 重派；每次都增加 ambiguous audit 计数。retryable / failed terminal 按配置退避 N 次，仍失败则把 member 置为 paused 并告警，作为 poison batch 等待人工 retry / abandon。这样 ambiguous 和 failed 都有显式出口，不会永久卡住 stream head。

`worker.send()` 与 receipt / cursor 文件仍不可能做分布式原子提交：

```text
durable accepted -> worker dispatch -> terminal signal -> durable receiver cursor -> hub observed ACK
```

若 receiver 在 worker 已接收、terminal / cursor 尚未持久化时崩溃，恢复后同一 turn 可能再次执行。系统记录 `ambiguous_replay` 并暂停或按策略重放，但不能假装 agent exactly-once。该窗口内产生的任何受管外部动作必须由 MA-P0 action gate 去重。

### 9.6 监听群追问与 IM turn

专属 receiver session 不能让用户丢失“在监听群追问时沿用会议上下文”的体验。runtime index 从原来的单记录改为：

```text
(listenerChatId, agentAppId) -> active meeting memberships[]
```

监听群内授权用户 `@agent` 时按以下规则路由：

1. 恰好一个 active membership：先请求 hub seal / wake 当前 meeting stream head，再把用户消息作为 `im_turn` 注入该 membership 的 `receiverSessionId`。
2. 多个 active membership：若 reply / quote 所属 listener message 或正文中的 meeting id 能唯一定位，则路由到对应 session；否则返回会议选择卡，要求用户显式消歧，不能静默取“最近一场”。
3. 没有 active membership：按普通群聊规则进入 chat-scope session。

meeting delivery 与 `im_turn` 共用 receiver session 的 turn arbiter，不能并发写同一个 CLI。已 accepted 的 meeting delivery 先执行；catch-up 在有界时间内无法完成时，IM 回复必须明确标记 `meetingContextMayLag=true`，而不是假装上下文最新。

`im_turn` 不占用 meeting deliverySeq，但使用同一个 durable dedup / terminal primitive：

```text
sourceKind = im_turn
sourceKey  = hash(receiverSessionId, larkMessageId)
stableTurnId = sourceKey
```

同一 Lark message 重投只执行一个逻辑 IM turn。`responseMode=silent` 只抑制自动 meeting delivery 的 fallback 输出；授权用户显式追问仍可按普通 IM policy 回复到原消息 / thread。

IM reply 本身也要用 `sourceKey + assistant_reply` 派生稳定 provider UUID，并在 receipt 中锁定首个 terminal output hash；ambiguous replay 产生不同文本时记录 mismatch、沿用首个已提交结果，不能向用户再发第二条答案。

## 10. 状态机

### 10.1 Membership

```text
activating -> active <-> paused
     |          |          |
     v          v          v
   failed     failed     removed
```

- pause / resume 不改变 epoch，也不丢 pending。
- remove 后旧 epoch 永久失效。
- 重新添加、切换 agent app、改变 role / filter 等会改变流语义的操作必须 `epoch++`，新流从 seq 1 开始。
- 单纯 daemon restart 不改变 epoch，从 durable cursor 继续。

### 10.2 Hub delivery

```text
UNASSIGNED
  -> PENDING（assignment 已持久化）
  -> ACTIVE_RECEIPT（deliveryKey / frozen envelope 已持久化）
  -> RECEIVER_COMPLETED（远端事实，尚未必被 hub 持久化）
  -> ACKED（hub.senderAckedThrough 已推进）
```

- offline / timeout / 5xx 回到 PENDING，使用相同 assignment 和 key 重试。
- epoch / input conflict 进入 PAUSED_CONFLICT 并告警，禁止自动吞掉。
- member A 卡死只停 A 的 stream head；B/C 继续推进。

### 10.3 Receiver receipt

```text
EMPTY -> ACCEPTED -> DISPATCHED -> COMPLETED(receiver cursor advanced)
                    |      |
                    |      -> FAILED_TERMINAL
                    -> lease expired / restart -> AMBIGUOUS

AMBIGUOUS --same key, retry budget--> DISPATCHED
FAILED_RETRYABLE --same key, backoff--> DISPATCHED
FAILED_TERMINAL --same key, bounded retry--> DISPATCHED
budget exhausted -> MEMBER_PAUSED -> manual retry | abandon
```

同 key / 同 hash 的重复请求返回已有状态；同 key / 不同 hash 永远是冲突。manual abandon 必须生成耐久 `AbandonedStream` 和用户可见审计，退休旧 epoch 后以新 epoch / from-now 继续，不能直接篡改旧 cursor；只有 receiver 明确证明从未 accept 的 seq，才允许把原 assignment 耐久 resolve 成同 seq 的 gap。

### 10.4 Meeting close

会议按 sink 分阶段关闭：

1. `active -> data_closing`：停止普通新 ingest，立即关闭 `meeting_text / meeting_voice`，其待审批 action 过期；保留迟到事件短窗口。
2. 做一次 polling catch-up 和 transcript final stabilization。
3. 向每个 active member 的**同一 delivery stream**追加一个唯一 final marker；spool 此时 seal，不再写入。
4. `data_closing -> finalizing`：`listener_chat / attention_dm / task` 可按配置继续到 finalization deadline；审批 / effect terminal result 继续以 `effect_result` 入流。
5. 等待各 member ACK、显式 abandon 或 deadline。超时选择隐私优先清理前，把 receiver 未 accept 的 assignment resolve 为同 seq gap；accepted / ambiguous 流写 AbandonedStream 并退休 epoch，同时通知用户。
6. `finalizing -> closed`：terminal / expiry 已结算后关闭 stream、离会、写 ended tombstone，删除 content spool，只保留短期 metadata / effect audit。

fast signal、timer tick、catch-up 和 ended 必须争用 member 级 stream lock，不能各自创建旁路 turn。

## 11. Side-effect action gate

### 11.1 校验顺序

daemon 接到 action intent 时按固定顺序校验：

1. 验证内部 caller daemon、receiver session 和 source turn 绑定，派生 actionId / inputHash。
2. **先查既有 action ledger**：同 id / 同 hash 已 terminal 时，即使当前 member epoch 已 stale，也回显原 terminal 结果并审计 stale replay；同 id / 不同 hash 返回 409，响应明确写“该 delivery 已有 action，视为已处理，禁止换 slot 重交”。
3. 对一个需要新执行的 action，再检查 meeting 是否仍处于允许该 sink 的 phase。
4. origin agent / member / member epoch 匹配 active membership。
5. source 属于该 member：delivery receipt 未被 gap / 新 epoch 废弃，或 IM turn 的 receiver session / Lark message binding 有效。
6. member 具备 sink 所需 capability。
7. 当前 sink owner 是该 member，且 owner generation 匹配。
8. 会议级 text / voice policy 与审批条件允许。
9. 若同一 `(sourceKind, sourceKey, sink)` 已有另一个 actionId，记录 `slot_proliferation`，强制转审批；不能自动执行。
10. 先写 `attempting` ledger，再调用 provider，最后写 `succeeded`、确定性 `failed` 或 `unknown`。

analysis-only member 的任何 sink action 都被拒绝并写审计日志。

### 11.2 request-output 契约

现有 `request-output` 改成两跳。CLI 先请求**自己所在的 consumer daemon**；consumer daemon 由 session binding 和当前 stable turn id 查到 delivery receipt，补齐可信 origin 后再转发给 listener / hub daemon。模型提供的 app id、member id、epoch 或 seq 只可作为显示信息，不能作为授权依据。

内部请求使用按 sink 区分的 payload：

```ts
type MeetingActionPayload =
  | { sink: 'listener_chat'; content: string }
  | { sink: 'meeting_text'; content: string }
  | { sink: 'meeting_voice'; content: string; fallbackText?: string }
  | { sink: 'attention_dm'; recipientOpenId: string; content: string }
  | {
      sink: 'task';
      mode: 'sync';
      items: Array<{
        summary: string;
        description?: string;
        assigneeOpenIds?: string[];
        dueAt?: string;
      }>;
    };

type MeetingActionRequest = {
  listenerAppId: string;
  meetingId: string;
  agentAppId: string;
  memberId: string;
  memberEpoch: number;
  ownerGeneration: number;
  source:
    | { kind: 'delivery'; key: string; deliverySeq: number; turnId: string }
    | { kind: 'im_turn'; key: string; larkMessageId: string; turnId: string };
  slot?: string; // daemon 默认 primary；非 primary 需要额外 capability
  action: MeetingActionPayload;
  reason?: string;
};
```

hub 验证 consumer daemon 转发的 session / turn / receipt 映射后，按 `(meetingId, memberId, memberEpoch, sourceKind, sourceKey, sink, slot)` 派生 action id。delivery 的 sourceKey 是 deliveryKey；IM turn 的 sourceKey 是 `(receiverSessionId, larkMessageId)` 的稳定 hash。v1 每个 sink 的 slot 是配置枚举，默认只有 `primary`；开放其它 slot 需要显式 capability，agent 不能用自由字符串绕过 409。跨 daemon action 始终回到 listener / hub daemon执行；consumer daemon 不直接调用会议或 IM provider。若后续跨主机，内部转发与 membership projection 使用同一 daemon-to-daemon 签名。

delivery instruction 必须明确：同 action 的 terminal / pending 回显视为请求已经受理；`input_mismatch` 或 `slot_proliferation` 不能通过改 slot、改措辞再次提交，只有人类批准的新业务 action 才能使用另一个允许的 slot。

上述 identity 只保证 epoch 内稳定。member re-add / epoch 切换默认 **from-now，不回放历史**。若以后显式开启历史回放，task / minutes 等持久 sink 必须再用业务语义账本（例如 rolling task ledger + diff sync）去重；`meeting_text / meeting_voice` 在新 epoch 的首个 action 强制审批。不能把 delivery actionId 误当跨 epoch 的语义去重。

当前“同 channel pending request 自动合并”需要调整：同一个 action 可以更新审批展示，但不能原地改变已记录 action 的 canonical input。多个 action 若要合并，应产生一个引用 parent action ids 的新 action；v1 可以先不自动 merge。

### 11.3 provider 差异

- meeting text / Lark IM：从 `actionId` 稳定派生 provider UUID；仅在 provider 幂等窗口内安全重试。窗口外且无 lookup 时同样标记 `unknown / manual`，不能无条件宣称 exactly-once。
- task 等支持 client token 的 provider：使用同一个 `providerKey`。
- meeting voice：当前没有可靠 idempotency / lookup。若在 `attempting` 后、terminal 前崩溃，状态必须变为 `unknown`，交给人判断；绝不自动重说。

action gate 是 daemon 里的确定性服务，不是一个 executor agent。实时音频的 `RealtimeVoiceSession` 仍由 daemon 单一 owner 管生命周期；speaker agent 只能提交 speak intent。

### 11.4 跨 delivery 的语义重复

`actionId` 解决同一个 delivery 的重试，不会把两个独立 delivery 中“含义相似”的自然语言自动判成同一任务。v1 不做通用语义去重；每个持久 sink 使用更可验证的业务策略：

- minutes / document：维护一份 rolling desired state，按 document id 更新，不逐 turn 新建文档；
- task：member 用一个 `mode=sync` action 输出完整 action-item ledger，daemon 对规范化 summary / assignee / due 与既有 external refs 做 diff / upsert，再调用 task provider；
- attention_dm：按会议、风险类型、对象和时间窗生成 alert fingerprint，并配置 cooldown；
- meeting_text / meeting_voice：依赖唯一 speaker owner、rate limit、epoch 首次审批和高风险审批；无法可靠判断语义相同时不宣称 exactly-once。

因此“sink 单 owner”消除的是多 agent 竞争，“effect actionId”消除的是协议重放，“sink-specific reconciler”才处理跨 turn 的业务重复；三者不能互相替代。

### 11.5 silent 的可执行边界

botmux 能控制的 choke point：

- trigger final output 是否发到 listener group；
- `botmux send` 的 CLI session-policy gate，以及 sandbox relay 经过 daemon 时的二次校验；
- `request-output` 的 membership / capability / sink-owner 校验。

非 sandbox 下现有 `botmux send` 可能由 CLI 直调 Lark，因此实现时 CLI gate 和 relay gate 都要补，不能只改 daemon。如果可信 agent 裸调 `lark-cli`、直接 SDK 或外网 API，v1 仍无法从技术上拦截。验收文案只能写“botmux 受管出口被拒”，不能写“agent 绝不可能发声”。

## 12. 持久化、恢复与隐私

### 12.1 默认：耐久化位置和身份，不长期落会议正文

默认持久化：

- meeting owner / owner epoch / heartbeat；
- `itemKey + revision + ingestSeq + contentHash + occurredAt`；
- membership、epoch、filter、sink owner generation；
- per-member assignment、next seq、cursor 和 receipt metadata；
- polling cursor / last seen time；
- action intent、input hash、provider key 和 terminal status。

默认不持久化 transcript / chat 正文。`raw` 只在内存存在，或进入显式开启的短期 debug / content spool；这与旧稿中“normalizer 保留 raw 便于调试”并不等于允许长期落盘。

这里的默认承诺严格指 botmux 的 feed / receipt / session metadata 存储：durable delivery 不得把正文写进 `Session.lastUserPrompt / lastCliInput`。Agent CLI 为保持会话上下文而生成的自身 transcript 仍会包含已消费正文，这是独立的保留边界，不能伪装成“完全不落盘”；专属 receiver session 在 meeting seal 后应关闭，并按所选 CLI 的 retention / 删除能力执行清理。MA-P0 若尚未实现 CLI transcript 清理，产品文案必须明确这一残余边界。

恢复时：

1. 读取 metadata journal 和 per-member cursor；
2. 以 `lastSeen - lookback` 调用已有 `fetchMeetingEventsAsBot`，分页拉取最近事件；
3. 用持久化的 item version / content hash 去重并重建尚未 ACK 的正文；render 必须是 item data + 固定 instruction version + 固定时区 / 格式的纯函数，并用 golden test 锁定，否则同一 item 恢复后可能产生不同 inputHash；
4. 并发到来的 push 和 polling 都进入同一个 ingest lock；
5. 恢复每个 member 的 stream head，逐个重试，不做全局 barrier。

### 12.2 恢复保证的上限

不落正文时，恢复首先受 `+meeting-events` 是否可用约束；在可用前提下，可回补时长不超过平台最短事件保留窗，并进一步受 ended 后访问窗口限制。

因此不能同时承诺“永不落正文”和“任意崩溃都绝不丢”。如果 polling 超窗、ended 后不可查询或 hash 对不上，系统必须：

- 由 daemon `system` principal 通过独立的 `listener_notice` sink 发出 `同步存在缺口 [t1, t2]`；notice 使用确定性 action key，不与 member-owned `listener_chat` 冲突；
- 向所有受影响 member 的 delivery stream 写入相同 gap control entry；
- 让后续总结明确知道输入不完整；
- 不静默推进 cursor。

gap 是一条普通、连续的 delivery entry，只终结自己的一个 seq，不授权 cursor jump：

- 对“平台时间窗内可能存在但 hub 从未观测到的事件”，先在后续正文之前签发一个 synthetic gap entry，描述 `[t1,t2]`；不存在需要跳过的已分配 seq。
- 对“assignment 已签发但正文无法重建”，只有 receiver 明确证明从未 accept 时，hub 才能用耐久 resolution record 把**同一个 seq**改为 gap，并保留原 `itemVersionKey / contentHash` 供审计。
- 对已 accepted / dispatched / ambiguous 的 seq，不能换 inputHash 伪装成 gap；自动恢复继续用同 key 重派，人工放弃则退休整个旧 epoch，写 `AbandonedStream` 并从新 epoch / from-now 继续。

因此 receiver 的每个 seq 都由 item / final / gap / effect_result / control 中恰好一个 entry 终结，`receiverCommittedThrough` 从不跳号。

### 12.3 可选：短 TTL content spool

需要更强恢复保证时可开启 write-ahead content spool：

- 注入前落盘，而不是失败后补写；
- 文件权限 `0600`，优先加密；
- 短 TTL；meeting ended 时 seal，所有 member ACK / 明确 abandon 或达到 hard TTL 后才删；
- 产品卡片 / 文档明确告知开启状态和保留时长；
- 默认关闭。

effect outbox 与原始会议 content spool 分开：action 是即将对外执行的规范化意图，pending / attempting 阶段必须以 `0600`（优先加密）短期 write-ahead 持久化，才能 retry / reconcile。terminal 或 TTL 后清除 payload，只保留 inputHash、状态和 external refs。

### 12.4 存储实现

不引 SQLite。沿用仓库已有跨平台原语：

- canonical JSON / `computeInputHash` / 有界 hash key；
- JSONL append + per-log mutex + `withFileLock`；
- JSON snapshot 的 tmp + rename；
- effect-before-provider + restart reconcile 的协议形状。

可抽取通用 primitive，但会议 journal 使用 meeting / member / delivery 词汇；不能把高频、带 revision 的 feed 硬套成 workflow run / node / attempt。

## 13. Ownership、跨 daemon 与 fencing

runtime store 增加：

```ts
type MeetingOwner = {
  daemonBootId: string;
  ownerEpoch: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
};
```

MA-P0 / MA-P1 的 file-lock lease 假设所有 daemon 在同一台主机并共享同一个 dataDir，这与当前 daemon discovery / loopback 路由一致。跨主机多 daemon 不在本期范围；支持它之前必须换成真正的分布式 lease 与认证传输。

- 正常情况下 listener bot 的唯一 daemon 是 owner。
- takeover 只能在 lease 过期后通过 file lock 获取，并递增 `ownerEpoch`。
- delivery / action 请求都携带 owner epoch；receiver / gate 拒绝较旧 epoch。
- 若两个 daemon 因误配都认为自己是 listener，必须产生日志、健康指标和监听群告警，不能继续 last-write-wins。
- authoritative membership 只由 hub 写；remote consumer 保存 fenced projection，并且是本地 receipt / `receiverCommittedThrough` 的唯一写者。hub 只保存观察到的 `senderAckedThrough`。
- 现有 `(listenerChatId, selectedAgentAppId) -> 最新会议` 索引改为 membership-aware；一个共享监听群同时存在多场会议时，必须显式 meeting id 或返回列表，不能静默取 `updatedAt` 最新一场。

## 14. Backpressure 与成本

多 agent 成本近似随 member 数线性增长。v1 需要：

- per-member `maxPendingItems / maxPendingBytes / maxLagMs`；
- 达阈值后暂停该 member，并向监听群 / dashboard 发健康告警；
- 提供 resume backlog、从当前开始、从最近 lookback 重放三种恢复策略；默认 re-add / 新 epoch 为 from-now。选择“从当前开始”时，未 accept 的旧范围先写 `backpressure_skipped / operator_skip` gap；存在 accepted / ambiguous turn 时退休旧 epoch 并写 AbandonedStream，不能直接跳 cursor；
- 不允许 `splice` 静默丢最旧项；
- 监控每个 member 的 cursor lag、in-flight age、retry count、token / turn 数；
- final close timeout 按 member 记录，慢 member 不阻塞整个会议无限期结束。

fast signal 仍受“一个 CLI 同时只能可靠处理一个 turn”的物理约束。它可以立即 seal / 排队，但如果该 member 已在处理长 turn，不能承诺绕过正在运行的 turn；需要更低延迟时应分配专用 attention member，而不是给同一 CLI 开旁路。

paused / poison-batch member 的 `effect_result` 也不会越过堵塞的 stream head；审批卡 / 用户侧状态是这段时间的权威结果。member 恢复后按序看到 control；若旧 epoch 被 abandon，则结果留在审计中，并可在新 epoch bootstrap summary 里提示，但不伪造旧 cursor 已完成。

## 15. 观测与审计

结构化日志和指标至少带：

```text
listenerAppId meetingId ownerEpoch
memberId agentAppId memberEpoch role
ingestSeq itemVersionKey deliverySeq deliveryKey
fromSeq toSeq receiverCommittedThrough senderAckedThrough inputHash
actionId sink ownerGeneration effectStatus providerKey
```

关键指标：

- ingest duplicate / revision / polling recovered / gap count；
- member cursor lag、pending bytes、in-flight age、retry / conflict count；
- trigger duplicate / ambiguous replay / input mismatch；
- action rejected by capability / owner / epoch；
- effect succeeded / failed / unknown；
- owner lease conflict；
- meeting close 时未 commit member 数量。

日志默认不打印 transcript/chat 正文和 action 内容，只打印 hash、长度和标识。

## 16. 分阶段实现

### MA-P0：单 member 先走新协议

目标：不增加产品可见的多选，先修今天的单 agent 崩溃和去重弱点。

1. 引入 feed metadata journal、`itemVersionKey` 和持久化 latest revision map。
2. 从数据模型第一天起使用 `members` map，即使只有一个 member。
3. 单 member 使用专属 receiver session、`deliverySeq / epoch / senderAckedThrough / receiverCommittedThrough` 和 member 级 stream lock。
4. local / remote 统一走 membership projection + meeting delivery receiver。
5. 建立唯一 delivery receipt、stable turn id、status GET 和共享 `claimDedup` primitive。
6. 新增可靠 `turn_terminal` 与 adapter capability contract。
7. restore 时 polling catch-up；补不齐时生成 gap marker。
8. 同时落最小 action gate：legacy member 的隐式 capability / sink owner、稳定 actionId / inputHash、effect ledger、text provider key 和 voice unknown/manual。
9. 去掉 consumer pending 超限静默删除。

出口标准：分析 turn 在极端窗口仍可能 ambiguous replay，但最终可以重派并推进 cursor；任何受管副作用不会因此自动重复；无法恢复时显式暴露缺口。

### MA-P1：打开多 membership 与显式 capability

1. 配置 / 卡片支持多个 role profile；逐 member 激活和部分失败。
2. role filter、per-member queue / cursor / backpressure 并行 fan-out。
3. fast / slow / final 共用单流。
4. 把 P0 legacy 隐式授权扩展为显式 capability、unique sink owner 和 generation fencing。
5. 审批结果 / control 回注原始 member 的同一 delivery stream。
6. 为 minutes / task / attention 实现 rolling state、diff/upsert 或 fingerprint cooldown 等 sink-specific reconciler。
7. `silent` / `listener_thread` response mode 和受管 IM 出口策略。
8. runtime store v1 -> v2 migration、membership-aware catch-up 索引。

出口标准：一个 agent 卡死不影响其它 agent；重复分析不能穿透成重复副作用；旧 epoch / 旧 owner 的迟到请求被拒。

### MA-P2：有真实同 sink 需求时再做

仅当产品确认多个 agent 必须共同写同一 sink，再评估：

- proposal store；
- deterministic merge 或人审；
- quorum / deadline；
- coordinator failover。

MA-P2 不是 MA-P0 / MA-P1 的前置。

## 17. 影响面

### 代码模块

- `src/daemon.ts`：meeting session、ingest/fan-out、restore、close、output gate。
- `src/core/session-manager.ts` / IM routing：meeting member 专属 session、listener @mention 消歧和 IM-turn arbiter。
- `src/vc-agent/meeting-state.ts` / `normalizer.ts`：稳定 item version / revision metadata。
- `src/services/vc-meeting-runtime-store.ts`：schema v2、members、owner、cursor 和索引。
- `src/core/trigger-session.ts` / `src/services/trigger-types.ts`：dedup receipt、stable turn id、result/status。
- `src/worker.ts` / `src/core/worker-pool.ts` / CLI adapters：可靠 `turn_terminal`、worker generation 与 capability contract。
- `src/bot-registry.ts`：consumer profiles、capability、sink owner 配置校验和旧配置迁移。
- `src/vc-agent/cards.ts`：多 profile 选择和部分激活状态。
- `src/cli/vc-agent.ts`：request-output 先到 consumer daemon，再由 session / turn receipt 补齐可信 action origin。
- `src/workflows/events/*`、`src/utils/file-lock.ts`：只抽通用 hash / locked append / effect protocol primitive，不复用 workflow schema。

### 横向回归面

- `/api/trigger` 是公共层：webhook、schedule、workflow、doc comment 等 source 必须保持旧行为；只有显式提供 dedup contract 的请求进入 receipt 逻辑。
- consumer CLI 可以是 Claude Code、Codex 或其它适配器；terminal signal / turn id 合同至少覆盖两个 CLI。
- PTY / Tmux 后端、已有会话 / 新建会话、restore / adopt、sandbox on/off 都要核对 stable turn context。
- local / remote daemon 必须跑同一份 contract test。
- JSONL、file lock、rename、路径和 `0600` 行为要在 Linux 与 macOS 验证；不增加 native dependency。
- 普通群 chat-scope、话题 session 和共享 listener chat 的路由不能串场。
- v3 workflow event log 不应因抽 primitive 改变现有 schema 或回放结果。

## 18. Crash / 并发测试矩阵

| 编号 | 注入点 / 场景 | 预期 |
| --- | --- | --- |
| A1 | feed journal 前 kill | polling / push 重投后重新 ingest，一份 item version |
| A2 | feed journal 后、内存 queue 前 kill | 从 journal + polling 重建，不签发重复 seq |
| A3 | assignment 落盘后、deliver 前 kill | 使用相同 member epoch / deliverySeq 重发 |
| A4 | target 已完成、hub 持久化 ACK 前 kill / HTTP 响应丢失 | status 返回 duplicate + receiverCommittedThrough，不重注 CLI |
| A5 | target `worker.send` 后、receiver cursor commit 前 kill | 同 deliveryKey ambiguous 重派并审计；外部 action 不重复；cursor 最终推进 |
| A6 | receiver cursor commit 后 ACK 丢失 | 同 A4；hub 查询后推进 senderAckedThrough |
| A7 | `fromSeq <= receiverCommittedThrough < toSeq` partial overlap | strict 409，不裁剪 batch，不重复注入 |
| A8 | silent / 空答 / agent 已显式 send | 仍产生唯一 turn_terminal 并结算 receipt |
| B1 | transcript r1 已 commit，迟到 r2 | 新 ingestSeq + 新 deliverySeq，不被旧 cursor 吞掉 |
| B2 | push 与 restore polling 同时收到同 item | 共享 ingest lock 去重，仅一份 assignment |
| B3 | polling 超保留窗 / ended 后不可拉 | 监听群和所有受影响 member 都收到 `[t1,t2]` gap |
| B4 | metadata 恢复后重 render | 固定 instruction / 时区 / 格式生成相同 inputHash |
| B5 | 不可变 item 同 key / 不同 contentHash | identity_conflict 隔离，不产生冲突 itemVersionKey |
| C1 | A 的 CLI 挂死 / 远端 daemon 离线 | B/C cursor 正常推进，A 单独告警 / 重试 |
| C2 | role filter 在共享 ingestSeq 上造成洞 | 各 member deliverySeq 仍从 1 连续推进 |
| C3 | fast signal × timer tick × ended final 并发 | 每 member 单 stream；final 唯一且排在已分配 meeting delta 后；effect_result 可在 finalization 期续流 |
| C4 | pending 达上限 | member 暂停并显式告警，不静默 splice |
| C5 | close timeout 时 member 尚未 ACK | seal + gap/AbandonedStream + audit，按隐私策略清理，不静默丢 |
| D1 | 旧 member epoch 重放 delivery / 新 action | stale 拒绝，不影响新 epoch cursor |
| D2 | 两个配置声明同一 sink owner | 激活失败并报告冲突，不 last-write-wins |
| D3 | analysis-only agent request-output / 受管 send | 拒绝并记录 capability audit |
| D4 | 同 actionId / 同 hash 重试（含 stale epoch） | 先回显已有审批卡或 terminal 结果，不引导重铸 key |
| D5 | 同 actionId / 不同 hash | 409 input mismatch + “禁止换 slot 重交”指令 |
| D6 | 同 delivery / sink 换 slot 二次提交 | 非枚举 slot 拒绝；允许的第二 slot 也强制审批并审计 |
| D7 | owner generation 切换后旧的新 action 到达 | stale owner 拒绝 |
| D8 | member re-add / 新 epoch | 默认 from-now，不回放历史 action；meeting text/voice 首次 action 强制审批 |
| D9 | 两个不同 delivery 重复识别同一行动项 | task ledger diff/upsert，不创建两条任务；记录 semantic coalesce |
| E1 | effect ledger `attempting` 前 kill | 无 provider 副作用，可安全重新请求 |
| E2 | `attempting` 后、text provider terminal 前 kill | provider 幂等窗口内同 UUID retry / reconcile；窗口外 unknown/manual |
| E3 | `attempting` 后、voice terminal 前 kill | 标记 unknown / manual，不自动重播 |
| F1 | 旧 singular config / runtime record | 无损迁移为单 member，现有单 agent 体验不变 |
| F2 | local 与 remote consumer | 相同 cursor、冲突、duplicate 和恢复结果 |
| F3 | 同监听群 / 同 agent 并发两场会议 | 两个专属 receiverSessionId，上下文和 action origin 不串场 |
| F4 | 单场活跃会议时用户在监听群 @agent 追问并要求建任务 | 路由同一 receiverSessionId；沿用会议上下文；同 larkMessageId 重试只产生一个 task sync action |
| F5 | 同监听群 / agent 有多场活跃会议且用户未指明 | 返回显式消歧卡，不静默路由最近会议 |

## 19. 验收标准

- 可以为同一场会议激活至少两个不同 agent profile，并观察到独立、连续的 receiver cursor 与 sender ACK 水位。
- 任一 agent 离线或长时间运行不会阻塞 listener group 或其它 agent。
- 同一 item version 重投不会重复进入同一 member；新 transcript revision 会进入。
- fast / slow / final / effect_result 没有旁路，final 对每个 member 只出现一次。
- 单场会议的监听群追问继续进入同一 receiver session；多场并发时显式消歧。
- daemon 重启后能从 metadata + polling 恢复；无法回补时用户和 agent 都能看见缺口。
- `dedupKey` 不再含当前时间，receiver 会持久化消费并校验 `inputHash`。
- analysis-only agent 的受管副作用被拒；每个 sink 只有一个有效 owner。
- text action 仅在 provider 幂等窗口内自动 retry / reconcile；窗口外与 voice unknown 都不自动重试。
- 旧单 agent 配置无需立即修改，升级后行为不回退。
- 没有引入 SQLite / native dependency，也没有把 meeting feed 塞进 workflow run schema。

## 20. 开放问题与真机校准

以下两项必须在受控测试会议中先测，再决定恢复承诺文案：

1. `lark-cli vc +meeting-events` 会中回补的实际保留窗、最大翻页深度和 page token 稳定性。
2. `vc.bot.meeting_ended_v1` 之后是否仍能用 bot 身份读取该会议事件，以及能读多久。

它们可以和下一次 realtime voice M0 验证复用同一场会议。

已定默认：member 会中加入、re-add 或新 epoch 都从“现在”开始，不回放历史；历史回放只能显式开启，并同时启用对应 sink 的业务语义去重。

仍需产品确认：

- optional content spool 是否需要，以及 TTL / 加密 / 用户可见说明；
- minutes 的最终内容是发 listener thread、写文档还是仅供其它 agent 读取；
- final close 等待每个 member 的默认 timeout；
- sink owner 在会中切换时，旧 pending approval 是作废还是转交新 owner。

在两项真机校准完成前，恢复能力统一表述为 **best-effort catch-up + explicit gap**，不写“崩溃绝不丢”。
