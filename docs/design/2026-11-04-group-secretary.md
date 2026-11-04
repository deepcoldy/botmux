# 群秘书（/secretary）设计

## 目标
一个 bot 被设为某群的秘书后，持续感知群内动态，决定静默、派活、传话、催办或向 leader（开启人）汇报；并跟进群里 bot 正在做的任务，发现卡点及时处理。

## 结构
- **规则层（daemon，无模型）**：`services/group-secretary-engine.ts`（纯逻辑，可注入时钟）+ `group-secretary-runtime.ts`（接线）。
- **模型层**：事件打包成静默回合，经 `deliverOwnerBatchTurn({ silent: true })` 送进秘书 bot 在该群的 chat 级会话（与日常对话共用，保留全群上下文）。静默回合不出流式卡片、不注入「至少回应一次」提醒（`omitReminder`）。

## 叫醒来源
| 事件 | 触发 | 说明 |
|---|---|---|
| new_messages | 群里任何新消息（自己发的、状态卡等噪音除外） | 安静 5s 或最长攒 10s 后投递；秘书忙时继续攒，最长 3 分钟 |
| check_in | 跟进清单到期 | bot 开工自动入清单；回访间隔 5→10→20 分钟；`botmux secretary watch` 手动加盯 |
| turn_ended / stuck / attention / stopped | 本机会话状态变化（每 10s 轮询 observe） | 收尾检查；每会话每小时最多 3 个（check_in 不计） |
| unaddressed_task | 顶层无 @ 的真人消息 20–35s 无 bot 接话 | 宽限按 bot 错开，跨机器秘书靠引用回复互相让开 |

投递前按最新快照复核（会话已恢复工作 / 举手解除 / 超过 10 分钟的事件丢弃）。

## 上下文
- 开了 Context Sharing 的群：投递前用 `prepareGroupContextForTurn({ scope: 'all' })` 为秘书回合准备整群增量，与 @ 秘书的普通回合共用同一条已投递记录，不重复；摘要里不再内联新消息。
- 未开 Context Sharing：摘要内联本批新消息。
- 摘要另附：本机各 bot 在本群的在跑会话（含话题根）、秘书自己最近发的消息、每个话题里自最近一条真人消息以来秘书已发条数、会话最近几句脱敏对话（insight）。

## 行动约束
- 秘书回合里每条 `botmux send` 必须带 `--secretary-action`（nudge / ask / dispatch / deliver / alert），否则 CLI 拒发。
- 不得自行修改系统与配置；传话用 `dispatch --into <话题>` 发进对方所在话题。
- 同一话题自最近一条真人消息后已发 ≥2 条：只能向 leader 告警。

## 开关
`/secretary on | off | takeover | status`。当前登记在本机共享数据目录（同机唯一）。

## 下一步：全群唯一 + 跨机器
- 登记改写进群描述标记（所有机器可读），`takeover` 改写标记。
- 秘书所在 daemon 经 federation（hub/spoke 的 delegationToken / syncToken）拉取其它机器上 bot 在本群的会话状态与对话片段，与本机会话一起进入判定引擎。
