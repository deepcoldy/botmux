# 跨机器人 Schedule 委托

状态：Implemented

## 决定

跨机器人创建定时任务使用独立的 `schedule:create` capability，不恢复 session owner 或环境变量 fallback。来源 daemon 仅在当前回合由真人管理员直接触发、宿主 `scheduleDelegation.createEnabled` 已开启，且 dispatch 显式请求该能力或命中受管来源 Bot 默认策略时签发 v2 委托。

目标 daemon 将精确消息绑定的 v2 委托兑换为当前目标 dispatch turn 的创建权。首版严格单跳；同一 live turn 可以创建多个不同任务，turn 结束即失效，不使用固定墙钟 TTL。仅允许目标 Bot 在原群顶层或当前 dispatch 话题执行，不支持多群、`new-topic`、`follow-active` 或继续转委托。真实 current actor 仍是发消息的 Bot，不冒充原真人。

## 持久边界

`schedule-authority.sqlite` 是 task 定义、控制主体、grant 消费、启停/完成状态和 run claim 的权威源；每个目标 app 首次升级时只登记当时已有的任务清单一次。`schedules.json` 只作 UI/兼容投影：修改 `enabled` / `nextRunAt` / repeat、删除标记、复制或换 task id 都不会取得执行权。删除任务在权威库留下 tombstone，不能靠恢复旧 JSON 复活。

委托 grant 的 canonical request 与任务在同一个 SQLite 事务中提交。任务 id 由 grant + canonical request 确定性派生：提交前回合或 generation 变化即拒绝；提交后响应丢失时，同请求返回原 task id；同一 live turn 的不同 canonical request 创建不同任务。未提交的事务不会被 scheduler 看见。

## 身份与撤权

控制主体与运行身份分离。v1 只支持即时 `lark-cli/bytedcli`；v2 的 `schedule:create` 不从 inherited authority 签发。首版持久 `runScopes` 固定为空，因此任务可执行普通 Agent 工作，但 scheduled turn 不成为真人 current actor，也不能使用真人工具身份。

为避免复用会话继承历史凭据，委托任务仅在目标 Bot 开启 `triggerUserAuth` wrapper 时运行；wrapper 依赖精确 turn 绑定拒绝陈旧身份。每次进入 worker 前重新检查：

- host `scheduleDelegation.runEnabled` 未关闭；
- 控制者仍是目标 Bot 管理员；
- union_id 仍能解析为记录中的目标-app open_id；
- 控制者仍是目标群成员；
- 持久 runScopes 仍受当前版本支持。

查询失败一律拒绝，不回退机器或 session owner 身份。撤权保证在下一次 admission/恢复/身份注入前生效，不承诺中止已经发出的外部命令。

## 管理动作

`schedule:create` 只允许 `add`。`update/remove/pause/resume/run` 通过独立 daemon route 验证当前真人管理员；Bot 派发回合不能复用 create grant。delegated task 的 canonical update 首版拒绝，等待后续显式 rebind 协议；pause/remove/resume/run 仍分别更新 host 权威状态。

## 兼容与信任假设

- v1 委托永远没有 schedule 权限。
- 显式请求发送给旧 daemon 时必须明确失败，不能静默创建 ownerless task。
- 所有 CLI 写操作都必须经所属 Bot daemon 提交到权威库；daemon 或权威库不可用时明确失败，不回退为只写 `schedules.json`。
- 首次升级迁移是一次性的宿主信任边界，后续未知 JSON 行不会被识别为 legacy。
- 非沙箱测试只证明受管入口遵守协议。本设计不抵御与 daemon 同 UID、可任意读取或改写宿主密钥和 SQLite 权威库的进程；那属于操作系统隔离边界。
- `scheduleDelegation.defaultOnDispatchFromBotAppIds` 可让指定来源 orchestrator 的每次受管 dispatch 默认请求该能力；`--no-delegate schedule:create` 可对单次派发降权。
- v2 capability 没有独立的墙钟 TTL：它的寿命严格等于目标 Bot 的同一个 live dispatch turn。新 turn、worker generation 变化或来源记录不再匹配都会拒绝兑换；很长的 turn 会在其整个生命周期内保留创建权。
- 一个 turn 可以创建多个不同任务，但最多为 `scheduleDelegation.maxTasksPerTurn`（默认 64，宿主可在 1–1024 间配置）。相同 canonical request 返回同一任务回执且不重复计数，超过上限明确拒绝。
