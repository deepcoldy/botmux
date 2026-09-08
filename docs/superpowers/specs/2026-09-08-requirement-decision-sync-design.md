# 需求群人类决策可靠同步设计

## 目标

为已显式注册的需求群增加可靠的“人类决策即时同步”链路：群内任意 Bot 收到真人拍板、纠偏或决定说明后，系统保留原消息证据，交给该需求唯一 writer 串行处理，并从同一公开版本原位更新需求上下文文档、置顶面板和短白板。

只有三个出口均完成回读后，才能报告“已同步”。每日 04:00 的既有任务继续负责补漏；它不是即时路径的替代品。

## 非目标与边界

- 不自动把 Bot 的建议、摘要、ACK、系统消息判定为人类决定。
- 不承诺所有自然语言都能自动归类为确定决定；模糊表达进入待澄清。
- 不对未注册群启用，不扫描所有历史群聊，不新建第二份业务账本。
- 不新建独立服务；复用 Botmux 入站分发、持久存储、触发会话和回合终态接点。
- 不改变现有文档、卡片、白板的资源 ID，不重发置顶面板。
- 网络、权限或上游不可用时承诺持久待办与至少一次重试，不承诺即时成功。

## 注册模型

新增机器级需求同步注册表。每条注册记录至少包含：

- `chatId`：唯一目标需求群。
- `requirementId`：Meego 需求标识。
- `workspaceRealpath`：需求工作区真实路径。
- `writerBotAppId`：唯一发布者 Bot。
- `writerSessionId` 或稳定 writer 会话定位。
- `enabled`、协议版本和创建时间。

注册表按 `chatId + requirementId` 唯一。新需求 kickoff 创建每日任务时同时幂等注册；整项需求进入已核验终态时禁用注册并清理未执行唤醒，但保留审计与上下文资产。

注册表读取失败时 fail closed：不在未知群登记决策义务。

## 持久 Obligation

真人消息通过群、发送者和权限校验后，在普通会话路由前登记持久 obligation。该接点必须覆盖顶层消息与真实话题回复，不能复用当前会排除话题回复的 `messageListeners`。

### 来源键

逻辑去重键：

```text
(requirementId, sourcePlatform, sourceChatId, sourceMessageId)
```

转发 Bot、接收应用和 relay message ID 不参与来源键。消息版本独立保存：优先使用真实 revision/update time，并保存规范化原文 hash。相同来源的同版本只登记一次；新版本追加 amendment；旧版本迟到不覆盖当前版本。

### 状态机

```text
received -> classifying -> queued -> processing -> committed -> publishing -> complete
                    \-> clarification_required
                                \-> pending_retry
```

- `received`：原始定位已持久化，尚未承诺已入账。
- `clarification_required`：无法可靠判断是否为决定，保留原文并等待澄清。
- `committed`：已通过现有 state CAS 入账，可仍有公开出口 pending。
- `complete`：文档、原卡片/pin、短白板均回读成功。
- `pending_retry`：保存阶段、错误和下次重试信息，不丢弃 obligation。

持久写使用原子替换和进程级锁；同一 requirement 的消费使用租约/fencing，避免多个进程同时成为 writer。

## 判定与安全规则

运行时只负责可靠登记与调度，不直接用关键词改业务状态。固定 writer 必须回读当前原消息及必要上下文，再区分：

1. 明确拍板或纠偏：生成小批 state 变更。
2. 明确撤回或替代：核验范围后使用业务 `supersedes`。
3. 模糊、条件不完整或来源暂不可读：标记待澄清。
4. Bot、自身应用、系统或自动 ACK：忽略为人类决定来源，避免回声。

发送者身份必须沿用现有授权校验。跨应用 `open_id` 不作为通用身份；obligation 保存接收应用与已核验的人类身份投影。

## Writer 调度

登记成功后，通过现有受管 trigger/session 能力唤醒注册的 writer：

- 同一 requirement 串行；已有活跃 writer 时只入队，不启动第二发布者。
- 调度携带 obligation ID，不复制整段群聊到命令参数。
- 触发失败保留 `pending_retry`，使用有上限的指数退避。
- daemon 重启后扫描未结算 obligation 并恢复调度。
- `onTurnTerminal` 只做 pending 补偿和重新唤醒，不作为唯一入站事件来源。

## State 与三出口发布

writer 复用 context-sync 的现有批次契约：

1. 读取最新 state revision、同来源历史版本和已有 publication pending。
2. 先持久登记 obligation，再 dry-run，并按 expected revision CAS apply。
3. CAS 冲突时重新读取和合并，不手工覆盖 state。
4. 从同一 public revision 渲染所有视图。
5. 原位更新现有详细文档、置顶卡片和短白板。
6. 分别回读并记录：文档 revision/块映射，原 card message ID、内容和 pin 状态，白板版本与内容。
7. 全部成功后把 obligation 标为 `complete`；部分失败只重试失败出口。

API 超时或结果未知时先读现状再决定是否补写。writer 输出及 ACK 不会再次登记为新的人类决定。

## 夜间补漏与生命周期

每日 04:00 任务优先处理 obligation 与 publication pending，再按来源水位补采遗漏消息和资料变化。即时路径和夜间任务共享同一 requirement 发布锁与来源键。

需求整体终态仍只认已核验的 Meego 项目/类型 live 状态。节点完成、需求评审完成、MR/Bits 完成均不触发注销。确认整项“已完成”或“已终止”后：

1. 完成最后一次 pending 处理。
2. 禁用即时同步注册。
3. 只删除回执指向的自身夜间任务。
4. 回查任务不存在后记录删除成功。
5. 保留文档、群、工作区、obligation 审计与最终上下文。

## 代码边界

建议拆为四个独立模块，避免继续扩张 daemon 编排文件：

- `services/requirement-sync-registry.ts`：注册表读写与群范围判断。
- `services/decision-obligation-store.ts`：来源版本、状态机、租约与恢复。
- `services/decision-intake.ts`：在已授权 Lark 入站消息上做登记与过滤。
- `services/decision-writer-scheduler.ts`：复用 trigger-session 串行唤醒 writer。

`im/lark/event-dispatcher.ts` 只在现有权限校验后的共同入站边界调用 intake；`daemon.ts` 的 `onTurnTerminal` 只调用补偿调度。context-sync 继续负责语义 state、渲染和三出口 ACK，不在 Botmux 内复制业务规则。

## 失败处理

- 注册表未知或损坏：不登记、不触发，记录可诊断错误。
- obligation 写失败：不把消息标成已受理；告警并由夜间补采。
- 原消息读取失败：保留定位，进入 `clarification_required` 或 retry，不生成 confirmed。
- writer 不在线：持久 pending，恢复后重试。
- apply 前崩溃：obligation 仍为 queued/processing，租约过期后恢复。
- apply 成功、发布失败：保留 committed revision 与逐出口 pending，只补失败出口。
- 多 Bot 同时收到同一消息：跨应用来源键合并为同一 obligation。

## 测试与验收

### 单元与集成测试

- 未注册群不产生 obligation。
- 顶层真人消息和真实话题回复都登记。
- Bot、自身应用、系统消息不登记。
- 多 Bot 接收同一原消息只生成一条逻辑 obligation。
- 相同版本幂等；新编辑追加 amendment；旧版本迟到不回退。
- register/queue/apply/publish 各阶段崩溃后可恢复。
- 同 requirement 只有一个 writer 租约；不同 requirement 可并行。
- 文档成功、卡片失败时只重试卡片，不能声称 complete。
- writer 输出与 ACK 不形成触发回声。
- daemon 重启后恢复未结算 obligation。
- 终态注销只影响对应注册与自身任务。

### 真实群演练

在已注册测试需求群执行：

1. 顶层明确决定，验证 obligation、state revision 和三出口 ACK。
2. 话题内明确纠偏，验证不会被 listener 边界漏掉。
3. 两个 Bot 同时接收同一消息，验证只处理一次。
4. 编辑原消息后发送旧版本转交，验证当前版本不回退。
5. 人为制造一个出口失败，验证 pending 与恢复补写。
6. 重启 writer/daemon，验证 obligation 恢复。

验收以持久记录、真实远端 readback 和原消息 ID 为证据；提示词存在、发送成功或本地测试通过都不足以宣称全自动生效。

## 上线策略

先以 feature flag 仅启用一个已注册需求群。通过真实群演练后再让 kickoff 为新需求群默认注册。任何异常可关闭该群注册，夜间任务继续补漏；无需删除业务资产或回滚上下文版本。
