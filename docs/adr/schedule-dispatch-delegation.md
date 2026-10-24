# 跨机器人 Schedule 委托

状态：Implemented

## 决定

跨机器人创建定时任务使用独立的 `schedule:create` capability，不恢复 session owner 或环境变量 fallback。来源 daemon 仅在当前回合由真人管理员直接触发、宿主 `scheduleDelegation.createEnabled` 已开启，且 dispatch 显式请求该能力或命中受管来源 Bot 默认策略时签发 v2 委托。

目标 daemon 将精确消息绑定的 v2 委托兑换为当前目标 dispatch turn 的创建权。首版严格单跳；同一 live turn 可以创建多个不同任务，turn 结束即失效，不使用固定墙钟 TTL。仅允许目标 Bot 在原群顶层或当前 dispatch 话题执行，不支持多群、`new-topic`、`follow-active` 或继续转委托。真实 current actor 仍是发消息的 Bot，不冒充原真人。

宿主可显式允许 delegated task 在未来运行时使用粗粒度 `bytedcli` scope。该 scope 只有在来源 dispatch 同时携带即时 `bytedcli` 委托、来源/目标宿主策略都允许、且目标 Bot 对 `lark-cli` 与 `bytedcli` 均启用 `triggerUserAuth` wrapper 时才能落盘。每次触发重新解析控制者身份并检查管理员与群成员资格，再为精确 scheduled turn 发布凭据；不会恢复通用 current actor。

## 持久边界

`schedule-authority.sqlite` 是 task 定义、控制主体、grant 消费、启停/完成状态和 run claim 的权威源；每个目标 app 首次升级时只登记当时已有的任务清单一次。`schedules.json` 只作 UI/兼容投影：修改 `enabled` / `nextRunAt` / repeat、删除标记、复制或换 task id 都不会取得执行权。删除任务在权威库留下 tombstone，不能靠恢复旧 JSON 复活。

委托 grant 的 canonical request 与任务在同一个 SQLite 事务中提交。任务 id 由 grant + canonical request 确定性派生：提交前回合或 generation 变化即拒绝；提交后响应丢失时，同请求返回原 task id；同一 live turn 的不同 canonical request 创建不同任务。未提交的事务不会被 scheduler 看见。

## 身份与撤权

控制主体与运行身份分离。v1 只支持即时 `lark-cli/bytedcli`；v2 的 `schedule:create` 不从 inherited authority 签发。持久 `runScopes` 只支持显式配置的 `bytedcli`；未配置时为空。无论是否授予该 scope，scheduled turn 都不成为真人 current actor，且 `lark-cli` 始终不随任务持久化。

为避免复用会话继承历史凭据，委托任务仅在目标 Bot 开启 `triggerUserAuth` wrapper 时运行；wrapper 依赖精确 turn 绑定拒绝陈旧身份。每次进入 worker 前重新检查：

- host `scheduleDelegation.runEnabled` 未关闭；
- 控制者仍是目标 Bot 管理员；
- union_id 仍能解析为记录中的目标-app open_id；
- 控制者仍是目标群成员；
- 持久 runScopes 仍受当前版本支持。

查询失败一律拒绝，不回退机器或 session owner 身份。撤权保证在下一次 admission/恢复/身份注入前生效，不承诺中止已经发出的外部命令。

## 管理动作

`schedule:create` 只允许初始 dispatch turn 执行 `add`。真人当前回合创建的 direct task 天然携带同 Bot、同群的控制者记录；它自己的 scheduled turn 可用 `schedule pause self` / `schedule remove self` 管理当前 task。跨 Bot delegated task 仍必须由宿主额外启用固定的 self-management 能力。两类 self-management 都只允许 pause/remove 当前精确 task，不能管理其他 task，也不能 update prompt/目标、resume、force-run 或创建后继任务；每次执行仍重新校验控制者是目标 Bot 管理员和目标群成员。其他管理动作继续通过独立 daemon route 验证当前真人管理员；delegated task 的 canonical update 仍拒绝，等待后续显式 rebind 协议。

需要“发送最终结果并结束任务”时使用单个 `botmux send --response-kind final --schedule-remove-self`。CLI 只能从当前受认证的 `schedule:<taskId>:<runId>` 推导 task ID，不接受调用方指定；final 投递成功并写入幂等账本后，通过 owning daemon 删除该精确 task，再推进长驻 CLI 的排队 turn。删除失败不得创建或改写另一条 final，结果以结构化 `scheduleSelfCleanup` 返回；原样重试同一命令会复用已投递的 final，只补做自删，已撤销的精确 task 视为幂等成功。

## 兼容与信任假设

- v1 委托永远没有 schedule 权限。
- 显式请求发送给旧 daemon 时必须明确失败，不能静默创建 ownerless task。
- 所有 CLI 写操作都必须经所属 Bot daemon 提交到权威库；daemon 或权威库不可用时明确失败，不回退为只写 `schedules.json`。
- 首次升级迁移是一次性的宿主信任边界，后续未知 JSON 行不会被识别为 legacy。
- 早期 authority schema 的 `UNIQUE(grant_id)` 在启动时通过 `BEGIN IMMEDIATE` table rebuild 原子迁移为 `UNIQUE(grant_id, request_hash)`；迁移保留完整任务行与 `(app_id, task_id)` 主键，历史库升级后同一 turn 才能安全创建多个任务。
- 非沙箱测试只证明受管入口遵守协议。本设计不抵御与 daemon 同 UID、可任意读取或改写宿主密钥和 SQLite 权威库的进程；那属于操作系统隔离边界。
- `scheduleDelegation.defaultOnDispatchFromBotAppIds` 可让指定来源 orchestrator 的每次受管 dispatch 默认请求该能力；`--no-delegate schedule:create` 可对单次派发降权。
- v2 capability 没有独立的墙钟 TTL：它的寿命严格等于目标 Bot 的同一个 live dispatch turn。新 turn、worker generation 变化或来源记录不再匹配都会拒绝兑换；很长的 turn 会在其整个生命周期内保留创建权。
- 一个 turn 可以创建多个不同任务，但最多为 `scheduleDelegation.maxTasksPerTurn`（默认 64，宿主可在 1–1024 间配置）。相同 canonical request 返回同一任务回执且不重复计数，超过上限明确拒绝。
- `scheduleDelegation.runScopes: ["bytedcli"]` 与 `selfManageEnabled: true` 都是显式 opt-in；关闭或收窄后，后续 trigger/self-management 立即 fail closed。旧 v2 记录缺少这些字段时按空 scope、不可自管理解释。

## 显式机器人服务授权（可选）

上述真人直接签发路径保持不变。需要“触发机器人 → 主控 → 阶段机器人”及 report
续跑时，可以由管理员在共享宿主配置 `scheduleDelegation.botGrants`。这是一项独立的
服务授权，不是继承或伪造真人 current actor；普通 chatGrant 仍只授对话权。

```json
{
  "scheduleDelegation": {
    "createEnabled": true,
    "selfManageEnabled": true,
    "botGrants": [{
      "id": "team-polling",
      "sourceAppId": "cli_controller",
      "targetAppIds": ["cli_generation", "cli_risk", "cli_decision", "cli_release"],
      "chatIds": ["oc_team"],
      "controllerUnionId": "on_accountable_admin"
    }]
  }
}
```

- 配置中的 app、群和 union_id 均须替换为已核验的真实身份；不使用跨应用复制的
  open_id。控制管理员仍须在来源、目标应用有管理权限，并满足目标群成员检查。
- `--bot-app` 受管派单命中唯一授权时自动签发，无需每次添加 `--delegate`；
  `--no-delegate schedule:create` 仍可单次禁用。只允许配置的来源、全部目标和群；
  重叠授权、无效字段及重复 id 不会产生可用授权。
- 来源仍必须是宿主认证的 live turn，并遵守输出位置、协作准入及实际消息签名绑定。
  不要求该 turn 是人发起；主控的外部事件、机器人派单或 report 轮次均可命中。
  管理员授予的是来源机器人本身的调度能力，所以其可接受输入的对话/触发策略也应配置妥当。
- 新能力不传递控制管理员的即时工具身份，`tools` 与持久 `runScopes` 均为空。
  它只解决 BotMux 调度；需要个人 API 凭据的查询仍按原工具身份策略单独授权，
  不会自动获得审批、合并或生产部署权限。
- 每次目标兑换、定时 admission 和自管理重新检查当前 grant。删除 grant、修改其
  来源/目标/群/控制管理员，或关闭 createEnabled，会撤销该服务授权后续准入；
  runEnabled=false 仍是所有委托任务的执行急停开关。已发出的外部调用不承诺中止。
- 权威任务记录的 grant_id 保存 `bot-policy` 来源和策略标识。后续派单使用主控自己
  当前的配置重新签发，不把上游 capability 当作可无限转授的凭证。
- 开启 selfManageEnabled 后，服务授权任务可在自己的定时轮次中 pause/remove；
  同一目标机器人还可在原群、原话题的后续轮次中 pause/remove 自己的此类任务，
  包括已暂停任务。跨话题、旧任务、update/resume/run 均不因此放权。
- 已有 direct/legacy/旧 delegated 任务不自动升级，旧任务清理仍按其原授权处理。

配置仅属于同一宿主信任域；跨部署不共享签名存储时不适用。PR 不修改实际团队授权
或重启服务。上线时应先在隔离测试群验证机器人触发、report 后再次派单、精确清理和撤权。
