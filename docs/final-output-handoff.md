# 最终输出的持久交接

设置 `BOTMUX_FINAL_OUTPUT_HANDOFF=1` 后，所有 worker 的 `final_output` 生产者使用 V2 持久交接。入口位于共用 `send()`，不再按 CLI、后端、卡片模式、正文大小或图片标记筛选。daemon、worker 和会话内的 botmux CLI 应使用匹配构建。

## 通道合同

| 通道 | 持久交接与恢复 | 原有约束 |
| --- | --- | --- |
| Claude、Traex、Codex 及其它 CLI 的结构化或终端转写 | 完整最终 IPC 快照，发出前落盘；恢复重发输出 | 不重发业务 prompt；原会话及 source session 验证 |
| adopt、本地输入、headless、零注入、工作流 | 同一输出入口；保存 kind、userText、replyTurnId、attempt 等字段 | 原生本地输入归属、工作流和任务终态仍由原协议决定 |
| 原生 Codex App | 保存 generation、seq、dispatchId 与完整输出；刷新 requestId 回执地址 | FIFO/exact attempt、原生持久结算及 `codex_app_dispatch_persisted` ACK；通用 ACK 不能替代原生 ACK |
| Mojo、Riff、Remote Runner 的普通最终输出 | 同一输出 journal 与宿主恢复循环 | 后端 task/operation 身份、取消和代际仍由后端验证 |
| Remote Runner outbound、Riff host tools、显式 botmux send | 保留现有 operation receipt、send ledger 与原生结果协议；最终发布和自动转写共用围栏 | unknown 不换 operationId，不绕过原生 owner；附件多步骤仍由原有分块 ledger 记录 |
| HTTP async | 接纳前固定 HTTP sink；严格落盘 completed/usage 后才结算 | 重启恢复结果 store，保持 interrupted/failed 终态和 bot owner 隔离 |
| HTTP wait | 接纳前固定 wait sink；活跃 Promise 接收结果，过期输出留存在宿主记录中 | 不把过期或失去 Promise 的 HTTP 输出发到 IM；native FIFO 仍须结算 |
| 文档评论 | 固定评论目标；每块在实际 provider request 开始时保存 attempting 与已返回回执，重启跳过已完成块 | 无回执块保持 unknown，不盲目重发；目标缺失不降级发群 |
| 私有回复、群/话题、managed/VC、silent | 固定目标和 requester，保留现有权限/原生投递合同 | 私聊接管不使用最新 sender，unknown 不回群；VC 重验 membership；silent 保持静默 |

“所有通道”指输出进入对应的持久 owner 和回执合同；没有 provider 幂等能力的输出不会因重启获得凭空的 exactly-once 保证。自动转写保存完整 `WorkerFinalOutput`；显式附件发送仍使用原有附件/分块机制，图片读取、上传及隔离边界不扩大。

## V2 协议

1. Worker 在独立输出 journal 中 fsync 完整快照，再发送带 `{version:2,id,fingerprint,token}` 的 `final_output`。持久化失败保留内存候选及原转写恢复线索，并重试落盘，禁止先发 IPC。
2. Daemon 验证当前 worker、session 和协商 token，在 SQLite 中固定输出和 sink，再认领投递租约。持久输出扫描不依赖原 worker 存活；恢复使用当前会话的处理器。
3. 对应通道完成其持久结算后，daemon 写最终回执，再发 `final_output_settled`。Worker 只删除与 id/fingerprint/token 精确匹配的恢复副本。
4. 原生 Codex 的通用结算必须有 `codex_app_dispatch_persisted` 的持久证明。重放刷新 requestId，但不改变逻辑内容和 generation/seq/dispatchId。
5. 原业务终态保持原生协议，通用输出 ACK 只结算输出副本。

同 id 的内容冲突会拒绝交接。易变 timing/usage 与原生 ACK 地址不参与逻辑指纹。原生回放可以在显式发送后变成空正文和静默标记；第一份正文始终保留，只刷新回执地址并升级静默状态，其它正文改写仍会冲突。实际输出字段完整留存。

## 持久数据

- Worker：`<SESSION_DATA_DIR>/worker-final-outputs/<appId>/<sessionId>/<id>.json`，原子替换并 fsync；不驱逐未结算输出。
- Daemon：`<SESSION_DATA_DIR>/output-delivery-journals/<appId>.db`，SQLite WAL / synchronous FULL；保存输出、冻结 sink、租约、最终回执和文档逐块 effect 记录。
- 渲染正文：legacy IM 将首次渲染 transport 持久保存；图片降级和拒绝通知使用独立阶段，重试保持原正文及 UUID。统一卡片和 managed 输出复用其现有 canonical store。
- 发布围栏：复用 `turn-send-ledger/<sessionId>/` 的锁及 per-turn marker。worker 接收/提交输入即启用 marker；自动 IM 回复先获取发布锁，再进入卡片锁，与显式发送保持一致顺序。
- V1 兼容：旧 `turn-marks/*.json` 的 pendingFinal 和 `final-output-handoffs/*.db` 继续恢复，不将它们改写为不兼容的快照。

requester 与引用作者分别保存。原 IM 目标、chat/type、私聊策略或权限变更会阻止新投递。已返回的真实外部回执仍需落盘对账，不因后续 UI/通知失败重发正文。

## 故障边界

- IPC、daemon ACK 或清理失败：保存副本，精确重放或复用已有回执。
- 平台明确拒绝正文：回执记录正文被抑制与拒绝原因，独立 UUID 的通知不替代原正文。
- IM 结果未知：保留 publication，只在原 provider UUID 的去重窗口内重试；窗口过期保持待核对，不换 UUID。
- 文档部分成功：保存各块证据，跳过已完成块；已请求但没有回执的块不自动重发。token 获取不算请求开始，身份回退每次写入前重验归属；明确的 HTTP/business 拒绝只清除对应 attempt 标记，授权恢复后可以重试。
- HTTP completion 写失败：内存结果不晋升完成，宿主不发 ACK，恢复记录继续保留。
- HTTP wait 过期、doc target 缺失、native managed/suppressed sink：继续对应原生结算，不 fallback 到普通群消息。
- 恢复扫描：每轮固定插入上水位并轮转，旧的等待项、后续新流入或晚到的旧时间戳不会阻止到期租约和后面的 ready 输出被重新访问。
- 租约过期或取消：旧 owner 不能开始下一项 effect 或结算新 owner 的记录；已有返回回执可作为对账证据保存。
- 投递结果三态：
  - **可恢复（blocked，5s 冷却后重投）**：平台 5xx/网络抖动、transfer 或 worker 换代中途丢权（`isStillOwned()` 翻转）、HTTP completion 落盘失败（内存结果不晋升、宿主不发 ACK、恢复记录保留）、文档分块中途丢权、图片准备失败、provider UUID 去重窗口内的未知、以及权限评估为「未解析」（`reason:'none'`：启动期 allowlist/grant sidecar 还在异步加载）。这些都不是正文「不会到达」，下一轮 pump 自愈。
  - **终态 rejected（不再重投、不 ACK worker，行留存待人工核对）**：冻结的原 chat/type 或私聊策略结构性变更、HTTP async owner 永久消失、provider UUID 去重窗口过期（结果永久未知）、治理黑名单撤销（`evaluateTalk().reason === 'blocked'`）、session/Hermes 绑定不匹配的确定性丢弃。注意「权限未解析」与「黑名单」分开：前者可恢复，后者不可逆。
  - **settled**：真实回执落盘，ACK worker 并在本会话无其它未决/终态输出时清除 attention。
  - codex native 未拿到 `codex_app_dispatch_persisted` 视为在途（blocked），不进终态。

关开关停止新 V2 输出准入，匹配版本继续恢复已有副本；切回旧构建前先处理未结算的 V2 输出。旧构建没有 V2 恢复合同。

交接或存储失败产生 attention，并记录具体诊断。IM publication 可用 `botmux turn-send-ledger inspect` 检查；其它 sink 的宿主 journal 目前作为本地持久诊断记录，没有统一的人工 resolve CLI。

## 验证

```bash
bun run test -- test/universal-output-handoff.test.ts test/final-output-handoff.test.ts test/final-output-handoff-store.test.ts test/turn-send-ledger.test.ts test/bridge-final-output-retry.test.ts test/codex-adopt-recovery.test.ts test/async-trigger-store.test.ts test/private-reply.test.ts test/remote-runner-outbound-send.test.ts test/riff-host-tools.test.ts
bun run build
```

测试和独立故障探针覆盖真实生产函数、worker journal、SQLite 重开库、shared publication/card 锁、原生 ACK 地址和拒绝回执、HTTP 严格落盘、doc 分块失败、取消与租约交叠。守卫变异应使对应行为测试报错。
