# Botmux 反馈能力：现阶段实现说明

> 文档状态：基于 `feat/skill-feedback` commit `6d5136fa` 与 schema v7 整理
>
> 对照基线：Botmux 作者反馈能力技术方案 review 稿（revision 7）
>
> 对照日期：2026-08-11
>
> 说明：本文描述当前已提交、已部署能力与已知边界，不是未来设计稿。

## 1. 结论

作者 review 文档确定的主方向已经落地：

- 反馈是 Botmux **核心内置能力**，不是依赖补丁的 Skill 插件。
- Core 负责最终回答识别、反馈 UI、可信身份、回调状态机、幂等、关联、持久化和同卡更新。
- 本地 SQLite 是事实源；事件和 webhook 是标准外发出口。
- 语义固定为 `positive / progress / negative`，业务呈现可配置。
- 策略支持 `team → bot → chat` 分层，优先级为 `chat > bot > team > built-in`。
- Core 统一持久化具备真实 worker terminal 信号且关联到 canonical Lark delivery 的 `turn.completed`；同一 turn 的多条 canonical delivery 通过 correlation discriminator 区分，并分别生成 completion event。
- 主动 `botmux send --response-kind final` 在真实 worker turn 内关联该 turn 并参与 completion reconcile；脱离 worker turn 的主动发送只有 delivery，没有 terminal/completion event。
- 已实现强关联 delivery、durable outbox/webhook 和 Dashboard 分析 API/基础页面。

当前实现已覆盖原方案 M1、M2 和 M3 的主体。仍未实现的主要增强项是：通用 card-action 插件注册表、Agent 交付时的动态反馈选项建议、native assistant message ID、Dashboard webhook secret 写入界面、通用本地事件订阅 API，以及非 Lark 平台适配。

## 2. 与作者 review 文档的逐项对照

| Review 需求 | 当前状态 | 现阶段实现 |
|---|---|---|
| 核心内置 UI、身份、关联、幂等 | 已实现 | Lark 最终卡内置反馈区；使用平台校验后的 operator 身份；SQLite revision 链和 callback key 幂等 |
| 原回答同卡反馈，不额外发消息 | 已实现 | 提交后 patch 原卡；按钮保留；独立展示“已选择”；负向可展开原因和说明 |
| 只评价 canonical final output | 已实现 | daemon `final_output` 正常 Lark 交付路径挂反馈；主动发送只有显式 `--response-kind final` 才挂反馈，未声明和显式 progress 都按非 final 发送 |
| 排除特殊 sink | 已实现 | doc-comment、VC receiver、HTTP wait/async、managed receiver、自定义卡、语音/视频等路径不创建普通 Lark 反馈 delivery |
| 三态统一语义 | 已实现 | 固定 `positive / progress / negative`；默认 key/文案为 `conclusive_usable/结论可用`、`effective_progress/有效推进`、`incorrect/结论有误` |
| 呈现层可配置 | 已实现 | 可配按钮 key、文案、style、顺序、可见语义、负向原因、说明框、是否必填、长度及 `allowReselect` |
| 团队 / bot / 群配置 | Core/API 已实现，Dashboard 基础 UI | local hosted team、bot、bot-scoped chat 三层；显式 `enabled:false` 可关闭继承；Dashboard 以 JSON textarea 编辑 team/bot policy，群下拉可保存覆盖并预览有效策略；尚不支持加载/删除既有 chat layer 的完整 CRUD |
| 策略快照 | 已实现 | 每条 delivery 保存发送时 effective policy；配置热更新在 daemon worker 路径于下一次 session fork/restart 生效，主动 send 按发送时当前配置生成快照 |
| 强回答↔执行↔消息关联 | 已实现 | schema v7 保存 bot/session/turn/native session/platform message/chat/topic/attempt/hash/ref/CLI/model/Skill/workflow/task/status/usage 等；delivery ID 包含 native session，terminal reconcile 使用 bot/session/turn/attempt |
| 默认不存完整回答 | 已实现 | `responses` 只存 hash/ref；卡片快照只保留反馈区和 footer 结构；点击时优先从 Lark 回读原卡正文 |
| worker turn 完成通知 | 已实现但有边界 | 持久化匹配 worker terminal + canonical delivery 的 `turn.completed`，支持 terminal-before-delivery 与 delivery-before-terminal、重复信号幂等；同 turn 多 delivery 各自产生 completion；无真实 worker turn 的主动 `botmux send` 不产生 completion event |
| 标准 webhook 出口 | 已实现 | 已产生的 `turn.completed` 和每条 `feedback.revised` 可进入 durable outbox；HMAC、事件 ID、重试、重启恢复、SSRF 防护；无 destination 时仅落事件表 |
| Dashboard 分析 | API 完整，页面基础 | 私有认证 API 支持覆盖率、正向率、三态趋势、原因、交付/出口失败、过滤与分页下钻；当前页面固定最近 30 天，显示 KPI、positive trend、原因和下钻，尚未暴露全量筛选控件和 progress trend |
| card-off 首期不支持 | 符合建议 | 反馈依赖 interactive card；不会为纯文本模式额外发反馈卡 |
| nativeMessageId P1 | 未实现 | 当前使用 turnId + nativeSessionId + dispatchAttempt + contentHash/ref + platformMessageId；没有原生 assistant row ID |
| 通用 card-action 注册表 | 未实现 | 反馈 handler 已在 core 接入，但分发仍非面向第三方插件的公开注册表 |
| Agent 动态反馈建议 | 未实现 | 反馈选项来自 team/bot/chat 配置快照，Agent 不能逐回答提交动态模板建议 |
| 本地订阅 API | 部分实现 | 本地事实表和事件表已存在；尚无通用、稳定、面向插件的事件订阅/游标读取协议 |

## 3. 产品语义与默认配置

### 3.1 固定语义

Core 只接受三种语义：

- `positive`：结论可用、采纳、准确等。
- `progress`：有效推进、部分采纳、部分达成等。
- `negative`：结论有误、不采纳、未达成等。

按钮文案不是语义。每个按钮必须有稳定 `key`，并映射到一个固定 semantic。回调不会信任客户端自报 semantic，而是从 delivery 的策略快照中反查。

### 3.2 默认按钮

```json
[
  { "key": "conclusive_usable", "label": "结论可用", "semantic": "positive", "style": "primary" },
  { "key": "effective_progress", "label": "有效推进", "semantic": "progress", "style": "default" },
  { "key": "incorrect", "label": "结论有误", "semantic": "negative", "style": "danger" }
]
```

### 3.3 默认行为

- 总开关默认关闭。
- `apiOnly` bot 不展示反馈。
- `audience` 默认 `requester`：鉴权主体固定为 delivery 中保存的 requester subject。正常 final 路径优先使用精确 turn sender；当该身份不可得时，当前实现会退化到已确认的 session owner/footer recipient，因此不是所有路径都能保证等同于“本次消息发送者”。
- `audience: "reviewers"` 用于 bot 触发的自动分析场景（如 Oncall/告警监听，本次 turn 的发送者是另一个 bot、没有单一真人 owner）：改由发送时冻结的 `reviewers` 名单鉴权，名单里任一可信真人身份点击即放行，与是否存在真人 requester 无关。名单可填写 `ou_`、`on_` 或完整邮箱；邮箱会在发卡时解析为当前应用的 `open_id`，回调仍保持零网络鉴权。名单为空时仍展示反馈按钮，但所有点击都会被拒绝。
- `audience: "everyone"` 允许任意具有平台核验 operator 身份的点击者反馈，不要求 requester，也不需要 `reviewers` 名单。该模式会扩大反馈写入范围，应只用于群成员都可信的场景。
- `allowReselect` 默认 `false`；只有显式设置 `true` 才允许改选。
- 说明框默认开启、非必填，默认最大 1000 字。
- 负向原因默认可为空，由业务配置。
- 新配置立即影响后续新卡，旧卡继续使用发送时快照（`reviewers` 名单同样随 delivery 快照冻结）。

### 3.4 约束

- 可见语义为 1–3 个；每个可见语义至少有一个按钮。
- 按钮 2–4 个，key 唯一，只允许 `[a-z0-9_-]+`。
- 负向原因最多 6 个。
- 说明最大长度 1–2000。
- `audience` 仅接受 `requester` / `reviewers` / `everyone`。`reviewers` 名单每项必须是 `ou_`（app 内 open_id）、`on_`（跨 app union_id）或完整邮箱，最多 50 项且不重复。邮箱在发送时用当前 bot 凭证解析为 `ou_` 后才写入策略快照；解析不到时丢弃该项，全部无法解析时保留空名单和反馈按钮，但点击鉴权仍 fail closed。跨 app 场景应优先使用 `on_`（`ou_` 是 app-scoped、不可跨 app 复制）。
- `audience: "reviewers"` 允许缺省或清空 `reviewers`，此时按钮可见但没有任何用户能提交反馈；`requester` / `everyone` audience 带非空名单仍会被判为无效策略。
- 不允许配置任意 Lark card JSON；配置仅包含受约束的领域字段。

## 4. 分层配置模型

### 4.1 优先级

```text
built-in defaults
  < local hosted team policy
  < bot policy
  < bot-scoped chat policy
```

- 数组字段（例如按钮、原因）整体替换。
- `negativeFollowup.comment` 按命名字段合并。
- 更具体层级的 `enabled:false` 显式关闭继承。
- partial layer 不会在落盘时展开默认值，避免重启后把继承值错误固化为 bot/chat 自有值。
- 一个群若显式绑定多个本地团队，解析 fail-closed，不展示反馈。
- 不把普通 Lark chat、租户或远端 federation team 静默推断为本地团队。

### 4.2 配置入口

- `bots.json`：bot policy、bot-scoped chat override、webhook destination reference。
- 本地 `teams.json`：local hosted team policy。
- `/botconfig` / bot config store：热更新 bot 与 chat policy。
- Dashboard：
  - 团队反馈策略编辑器；
  - Bot 最终回答反馈设置；
  - 群选择与 chat override；
  - effective policy 预览，显示 team/bot/chat 来源及禁用原因。

### 4.3 当前运行示例

```json
{
  "feedback": {
    "enabled": true,
    "visibleSemantics": ["positive", "progress", "negative"],
    "buttons": [
      { "key": "conclusive_usable", "label": "结论可用", "semantic": "positive", "style": "primary" },
      { "key": "effective_progress", "label": "有效推进", "semantic": "progress", "style": "default" },
      { "key": "incorrect", "label": "结论有误", "semantic": "negative", "style": "danger" }
    ],
    "negativeFollowup": {
      "reasons": [
        { "key": "missing_context", "label": "缺少关键信息" },
        { "key": "not_completed", "label": "没有实际完成" },
        { "key": "wrong_result", "label": "结论或结果错误" }
      ],
      "comment": {
        "enabled": true,
        "required": false,
        "placeholder": "可以补充哪里需要改进",
        "maxLength": 1000
      }
    },
    "allowReselect": false
  }
}
```

### 4.4 reviewers audience 示例

用于 bot 触发的自动分析（本次 turn 发送者是另一个 bot、没有单一真人 owner），把可反馈人固定为一份可信名单：

```json
{
  "feedback": {
    "enabled": true,
    "audience": "reviewers",
    "reviewers": ["on_cross_app_reviewer", "oncall@example.com"],
    "allowReselect": true
  }
}
```

- 名单项为 `ou_`（app 内 open_id）、`on_`（跨 app union_id）或完整邮箱；跨 app 优先用 `on_`。邮箱在发卡时解析为当前应用的 `ou_`，未解析成功的项不会写入快照。
- 名单随 delivery 快照冻结：后续改名单只影响新卡，旧卡仍按发送时名单鉴权。
- `audience` 与 `reviewers` 可分散在不同层（team/bot/chat）提供，合并后按整体校验；`reviewers` audience 缺名单时仍展示按钮，但所有点击都会 fail closed。

### 4.5 everyone audience 示例

用于明确希望群内任意可识别成员都能点击反馈的场景：

```json
{
  "feedback": {
    "enabled": true,
    "audience": "everyone"
  }
}
```

该模式不校验 requester 或名单，但仍要求回调携带飞书平台核验的 operator 身份；无法验证来源的回调继续 fail closed。

## 5. 最终卡交互协议

### 5.1 展示边界

反馈只出现在有清晰结论的最终回答卡上，不出现在：

- progress/streaming 状态卡；
- 自定义卡；
- 通知、语音、纯视频；
- doc-comment、VC receiver、HTTP wait/async 等特殊 sink；
- 无法证明 requester 身份的卡（仅 `requester` audience 需要；`reviewers` 由冻结名单鉴权，`everyone` 由平台 operator 身份鉴权，两者都允许无真人 requester 的 bot 触发会话展示反馈）；
- `apiOnly` bot；
- card-off 纯文本模式。

主动 `botmux send` 可显式声明：

```bash
botmux send --response-kind progress ...
botmux send --response-kind final ...
```

未声明 `--response-kind` 时默认按 `progress` / 非 final 处理，消息仍正常发送且不挂反馈；只有显式 `final` 才进入反馈卡和 delivery 索引路径。

### 5.2 提交流程

1. 用户点击一级按钮。
2. Core 校验平台消息、app、可信 operator、身份鉴权（`requester` 走 requester-only，`reviewers` 走冻结名单，`everyone` 接受任意可验证 operator）和策略快照。
3. SQLite 事务写入 immutable feedback revision；重复 callback key 幂等返回已有记录。
4. 积极/推进选择直接返回同卡状态。
5. 负向选择先同步 ACK，再异步 `message.patch` 原消息，避免复杂 form 在 callback response 中触发 Lark 错误。
6. 原按钮组件保留，并显示“已选择：xxx”。
7. 负向卡展开二级原因和说明表单。
8. 默认锁定一级选择；`allowReselect:true` 时允许 A→B→A，并形成 revision 链。

### 5.3 负向二级交互

- 原因必须来自策略快照中的稳定 `reason_key`。
- 说明文本受 required/maxLength 校验。
- 自由文本写入本地事实表，但不会回显到群卡。
- 原因/说明更新形成新 revision，并通过 `supersedes_feedback_id` 连接上一版。

## 6. SQLite v7 数据模型

数据文件：`botmux-feedback.sqlite`。SQLite 开启 WAL、foreign keys 和 busy timeout，并支持 v1/v2 事务迁移到 v7。

### 6.1 interactions / responses

- `interactions`：运行时无关的 interaction 标识与上下文。
- `responses`：只保存 `content_hash` 和可选 `content_ref`，不保存完整回答。

### 6.2 deliveries

关键字段：

- `delivery_id`：由 bot/session/turn/nativeSession/dispatchAttempt 形成稳定 ID；内容变化不会让同一交付尝试换 ID。
- `bot_app_id`、`session_id`、`turn_id`、`native_session_id`。
- `platform`、`platform_app_id`、`platform_message_id`。
- `chat_id`、`topic_root_id`、`scope`、team context。
- `workflow_id`、`task_id`、`parent_task_id`。
- `cli_id`、`cli_version`、`model`、`reasoning_effort`。
- `skill_name`、`skill_version`、`card_mode`。
- `status`、`duration_ms`、`usage_json`、`completed_at`。
- `policy_snapshot_json`、requester、webhook destination snapshot。

同一个 canonical correlation 不能绑定多个平台消息；同一个平台消息也不能重绑定到另一个 turn。

### 6.3 隐私边界

- 不保存 prompt、完整回答、隐藏推理、terminal output、env、token、连接串或未脱敏附件路径。
- `base_card_json` 只保留反馈区和稳定 footer 模板，不保存回答正文。
- 回调时优先从 Lark 权限域回读原卡，再将反馈状态合并进去；回读失败时退化到无正文结构模板。

### 6.4 feedback_revisions

每次有效变化追加一条 immutable revision：

- `feedback_id`、`delivery_id`、可信 `operator_subject_id`；
- `revision`；
- `result`（即稳定 verdict key）；
- `semantic`；
- `reason_key`、`comment_text`；
- `callback_key`；
- `supersedes_feedback_id`；
- `created_at`。

这与 review 初稿中的“同键 upsert”有所不同：当前采用 append-only revision chain，既保持当前有效反馈唯一可导出，也保留改选历史，审计能力更强。

## 7. 统一 turn.completed

### 7.1 事件生成边界

Core 将真实 worker terminal 信号和真实成功 canonical delivery 持久化后进行 reconcile：

- terminal 先到、delivery 后到：后到时补发事件；
- delivery 先到、terminal 后到：terminal 到达时生成事件；
- 重复信号幂等；
- 冲突 terminal 状态拒绝覆盖；
- 没有 canonical Lark delivery 的特殊 sink 不伪装成 Lark 完成事件。
- 主动 `botmux send --response-kind final` 在存在真实 `currentTurnId` 时保存真实 turn 关联并参与 worker terminal reconcile；同 turn 多条 delivery 由独立 discriminator 区分。
- 脱离 worker turn 的主动 final 使用 `send:<messageId>`，没有匹配 terminal，因此不生成 `turn.completed`。

### 7.2 状态

支持：

- `completed`
- `failed`
- `cancelled`
- `ambiguous`

### 7.3 载荷

事件包含稳定 event ID、version/time/status、delivery ID、content hash/ref、平台消息/app/chat/topic、session/turn/native session/attempt、duration/usage，以及实际可得的 CLI/model/Skill/workflow/task 元数据。不会伪造缺失字段，也不包含完整回答正文。

## 8. 事件与 webhook 出口

### 8.1 本地事件

当前生成两类 durable event：

- `turn.completed`
- `feedback.revised`

事件与对应业务事实、outbox obligation 在同一 SQLite 事务中写入。

### 8.2 Outbox

`feedback_outbox` 包含：

- stable outbox ID；
- event ID + destination ID 唯一约束；
- destination 冻结快照；
- `pending / inflight / delivered / failed`；
- attempts、next attempt、claim token、HTTP 状态、错误和 delivered time。

daemon 启动时恢复 stale claims，运行中也周期恢复；claim/settle 使用 token fencing，防止旧 worker 错误结算新 claim。

### 8.3 Webhook 安全和可靠性

- 默认只允许 HTTPS。
- 禁止 URL credentials 和 fragment。
- DNS 解析后阻断 loopback、link-local、private、reserved 等地址；连接固定到校验过的 IP，降低 DNS rebinding 风险。
- 当前 daemon 未暴露允许私网 destination 的配置入口，运行时始终阻断 private/link-local/loopback/reserved 地址；dispatcher 的 `allowPrivateNetworks` 仅是未接生产配置的底层选项。
- 禁止 redirect。
- 请求体上限 256 KiB，超时限制 100 ms–30 s。
- HMAC-SHA256 签名覆盖精确 event bytes 和 timestamp。
- Header 包含 event ID、event type、timestamp、signature，可供接收方幂等。
- 2xx 成功；408/429/5xx 与网络错误重试；其他 4xx 永久失败。
- 支持 Retry-After、指数退避上限和 jitter。
- secret 只以 `secretRef` 出现在配置/outbox；实际 secret 存在本机 0600 原子文件，不进入事件、Dashboard payload 或日志。

### 8.4 当前边界

- 已完成 bot 级 destination 解析、delivery 快照、feedback revision 继承与 daemon dispatcher。
- 当前没有已配置 destination 时，事件会正常落本地表，但 outbox 为空，这是预期行为。
- 尚未提供完整的 Dashboard webhook secret 写入/轮换 UI。
- 尚未提供稳定的通用本地事件订阅/游标读取协议；当前可直接读取本地事实表，正式插件 API 仍属后续增强。

## 9. Dashboard

### 9.1 配置面

- local hosted team 反馈策略 JSON 编辑。
- bot 反馈开关和高级 JSON。
- 从 bot 已加入的群中选择 chat，将当前 JSON 保存为 bot-scoped chat override，并预览 effective policy。
- 当前 chat UI 尚不加载已有 override 供独立编辑，也未提供删除 override 的完整 CRUD。
- effective policy 预览显示 team/bot/chat layers、字段来源和 `enabled/disabled/api_only/ambiguous_team` 原因。
- 远端/platform team 只读，不把它当作本地策略 owner。

### 9.2 分析页

新增私有认证的反馈页与 API。分析 API 默认被页面以最近 30 天调用，支持：

- delivered turns；
- rated deliveries / ratings；
- rating coverage；
- positive rate；
- positive/progress/negative 趋势数据；
- 负向原因分布；
- delivery failures；
- outbox failures；
- redacted delivery drill-down 和 cursor pagination。

API 可过滤 time、team、bot、chat/topic、semantic、verdict、reason、model、CLI/version、Skill/version、workflow/task、status。SQL 使用参数绑定、限制最大时间范围，并通过 v7 索引支持常见维度。

当前页面只暴露固定最近 30 天视图，展示 KPI、positive trend、原因、失败和分页下钻；尚未暴露 API 的全量筛选控件，也未可视化 progress/negative trend。

未认证分析请求返回 401；下钻不返回完整回答、operator ID、comment、base card 或 secret。

## 10. 运行与验证状态

当前分支：`feat/skill-feedback`，实现 commit `6d5136fa`，PR #830。能力已构建并部署到本机 daemon，旧 `skill-feedback` 插件进程已移除，只运行 core built-in。

已完成的验证包括：

- 策略、卡片、回调、SQLite migration、delivery、turn.completed、outbox/webhook、Dashboard、CLI/daemon 路径专项测试；
- TypeScript 检查、`git diff --check`、完整 build、Dashboard bundle、domain/dist audit；
- 真实数据库副本迁移到 v7，`integrity_check=ok`，foreign key check 无错误；
- 未认证 Dashboard 分析 API 返回 401，认证 API 返回真实统计；
- 真实 Lark 三态卡和负向二级交互；
- 实际点击记录已验证写入 feedback revision 和 `feedback.revised` event，semantic 与 verdict key 一致；
- 多轮独立代码、安全和规格审查，最终结论 PASS。

全仓测试中的剩余失败为既有不稳定集成用例（Codex runner timeout、worker argv reaction 时序），与反馈功能无关；本次新增的 Desktop feedback 导航回归已修复。

## 11. 与初稿相比的实现演进

### 11.1 超出初稿的部分

- 不只 team/bot，增加了 bot-scoped chat override 和有效策略来源预览。
- feedback 不是覆盖更新，而是 immutable revision chain。
- SQLite 从两张概念表演进为 schema v7 的 interaction/response/delivery/revision/completion event/event/outbox 体系。
- card 回调使用 ACK 后异步 patch，解决复杂 Lark form 的真实客户端错误。
- webhook 增加 DNS pinning、token-fenced claim 和周期 stale recovery。
- 分析支持 delivered 与 rated 两种分母，避免把未评分回答误当负向。

### 11.2 尚未实现的初稿增强

1. **通用 card-action 注册表**：当前反馈是 core handler，但还未把所有 action 分发抽成公开插件注册机制。
2. **Agent 动态反馈建议**：尚不支持逐回答由 Agent 建议一套受约束按钮；当前只读 team/bot/chat 配置。
3. **nativeMessageId**：没有原生 assistant message row ID；仍采用 review 认可的 P0 组合锚点。
4. **Webhook 管理 UI**：没有完整的 destination + write-only secret 管理面。
5. **本地事件订阅 API**：事实表存在，但没有稳定订阅协议。
6. **非 Lark 平台**：领域模型是 runtime-neutral 的，但当前 UI/callback adapter 只实现 Lark。
7. **card-off**：按初稿建议明确不支持，不额外发送反馈卡。
8. **业务离线迭代**：Skill 归因、问题聚类、bad-case 路径比较、候选生成与自动评测仍属于外部系统，不在 Botmux core 内。

### 11.3 为什么这三项暂缓

#### 通用 card-action 注册表

当前反馈点击已经完整可用，但采用 core 内置 handler。将其进一步开放为第三方注册表，不只是改造一段分发代码，还需要形成长期兼容的公共协议：handler 命名和冲突规则、版本协商、Core 与插件的身份校验责任、同步 ACK 与异步 patch/toast 的返回契约、插件加载和卸载、超时/崩溃隔离，以及插件可访问的 bot/chat/operator 数据范围。

如果没有单独的安全和兼容设计就开放，会把当前经过验证的卡片回调安全边界变成任意插件可触达的入口。作者 review 文档本身也把“是否一并建设 card-action 扩展点”列为待拍板问题，而不是反馈闭环的前置条件。因此本阶段只将官方反馈 handler 内置到 core，不承诺未成熟的公共插件 API。

#### Agent 动态反馈建议

固定三态与 team/bot/chat 配置已能覆盖主要团队差异。允许 Agent 逐回答提交动态反馈模板会引入额外的非确定性和信任边界：需要严格 schema 和语义白名单；需要定义它与 team/bot/chat policy 的合并优先级；delivery 快照要记录建议来源和 Core 最终裁决；还必须防止 prompt injection 借动态建议生成自由 action、敏感文案或破坏跨回答分析口径。

它属于动态呈现增强，不是 UI → 可信回调 → 落库 → 事件 → 出口闭环的必要条件。本阶段先以配置保证行为可预测、统计口径稳定；后续若实现，应定义受约束的 `feedbackSuggestion` 协议，由 Core 校验并裁决，而不是让 Agent 直接生成卡片 action。

#### 本地订阅 API

底层数据能力已经存在：schema v7 包含 durable `feedback_events`、`turn_completion_events` 和 outbox，webhook 也支持可靠投递。但一个稳定的本地订阅 API 仍需明确 pull 或 stream/SSE 模式、cursor 和保留期、ack/重放、多 consumer 消费进度隔离、daemon IPC 认证与脱敏，以及事件 schema/version 的兼容承诺。

在这些协议未拍板前直接鼓励插件读取 SQLite，会把内部表结构事实化为公共 API，阻碍未来迁移。因此当前提供本地事实表和 durable webhook，但暂不宣布稳定订阅协议。若继续建设扩展平台，建议按“本地订阅 API → Agent 受约束建议 → 通用 card-action 注册表”的顺序推进；越靠后的能力安全与兼容承诺越大。

## 12. 后续建议

按优先级建议：

1. 对当前 PR 按 policy/config、store/migration、card/callback、events/outbox、Dashboard、docs 分模块 review；实现当前保持单个 feature commit。
2. 补 Dashboard webhook destination 与 write-only secret 管理，并支持轮换/禁用/测试投递。
3. 定义本地事件订阅/游标读取协议，供官方插件或离线任务消费，而不是直读 SQLite 内部表。
4. 再评估通用 card-action 注册表；这是未来第三方卡片交互扩展的基础设施，不是当前反馈闭环的阻塞项。
5. 与 Hermes/各 CLI 协作补 nativeMessageId，增强精确审计，但不改变当前 delivery 主键与平台消息关联。
6. 将团队级 webhook destination 合并规则和远端 federation policy ownership 作为单独设计议题处理，避免静默跨部署继承。

## 13. 事实源与关键代码

- 作者 review 文档：`HvKtdKrEhoI9XSx8oufcNDhGndf` revision 7。
- 策略：`src/services/feedback-policy.ts`
- 分层解析：`src/services/feedback-policy-resolver.ts`
- 卡片与回调：`src/im/lark/skill-feedback-card.ts`
- 回调入口：`src/im/lark/card-handler.ts`、`src/im/lark/event-dispatcher.ts`
- SQLite v6：`src/services/skill-feedback-store.ts`
- turn 完成事件：`src/services/turn-completion-events.ts`
- outbox/webhook：`src/services/feedback-outbox.ts`、`src/services/feedback-webhook-dispatcher.ts`
- daemon final：`src/core/worker-pool.ts`
- 主动 send：`src/cli.ts`
- Dashboard analytics：`src/services/feedback-analytics.ts`、`src/dashboard/feedback-analytics-api.ts`、`src/dashboard/web/feedback-page.tsx`
- 配置 UI/API：`src/services/bot-config-store.ts`、`src/core/dashboard-ipc-server.ts`、`src/dashboard/federation-spoke-api.ts`、Dashboard team/bot 页面。
