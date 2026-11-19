# 已有话题登记为项目子任务

项目主控可把本群中已存在的独立话题纳入项目，而无需发送新的派单提示。
登记与任务完成、会话连接状态相互独立；迁出或断开连接不会自动完成任务。

## 命令

```bash
botmux project workstream inspect --root om_root --source-app cli_worker --source-session session-id
botmux project workstream attach --root om_root --source-app cli_worker --source-session session-id --title "具体任务"
botmux project workstream attach --root om_root --source-app cli_worker --source-session session-id --title "具体任务" --claim-owner
botmux project workstream confirm --root om_root --source-app cli_worker --source-session session-id [--title "具体任务"]
botmux project workstream rename --root om_root --title "新的具体标题"
botmux project workstream update --root om_root --status in_progress --content "正在实现"
botmux project workstream status
```

`--session-id` 是执行命令的主控 session，`--source-session` 是被登记的执行者。
主控必须是普通项目群的 chat-scope session；被登记者必须是本群允许的 Worker 的
真实 thread-scope session。标题非空、非“子任务/子项目”、不超过 24 字。

默认仅同一个可验证的人类 owner 能登记。不同 owner 先在来源话题的本人回合执行：

```bash
botmux project workstream grant
```

再由主控使用返回的 grant ID：

```bash
botmux project workstream attach --root om_root --source-app cli_worker --source-session session-id --title "具体任务" --grant grant-id
```

grant 限当前源 session、话题、关联版本、项目群和主控 app，一小时有效，不授权
读取私聊 transcript/终端。bot 触发回合、定时任务回合、未知 caller 不会被推测成人类，
拒绝码明确区分：

- `actor_nonhuman`：当前回合不是真人直接发起（机器人转发、非迁入通知的后台/定时触发等），不可代本人认领或变更归属。
- `source_owner_unknown`：源会话缺少 `ownerOpenId`/`ownerUnionId`（如早期无主会话迁入），不能走 `grant`，需由本人显式认领。
- `source_owner_authorization_required`：源会话已有其他成员的 owner，需原主人在源话题执行 `grant` 后由主控带 `--grant` 登记。

### 无主会话显式认领与迁入话题确认卡

当无主会话迁入项目群时，不能凭机器人转发文字、`lastCaller` 或 relay 占位推断归属，支持两条经宿主鉴权并留存审计日志的显式认领路径：

1. **迁入话题确认卡片（推荐）**：开启迁入通知（见下文「可选迁入通知」）时，宿主在投递迁入通知的同时，直接由主控应用在迁入后的目标话题内回复一张可见的「项目会话迁入」卡片（展示来源 Bot、会话摘要、迁入方式、当前是否已登记看板及未登记原因）；对已迁入的历史会话，主控也可执行 `botmux project workstream confirm` 补发/刷新该卡片。需要本人确认时卡片附带「确认登记」按钮，点击人经飞书回调 `operator` 校验确认为主控会话真人 owner 且具备源 Bot 的人类操作权限后，宿主将无主会话的 `ownerUnionId`（及经 `union_id` 在源应用解析出的 `ownerOpenId`，绝不跨应用复制 `ou_`）补写为本人并完成 `attach`；workflow、会议、监听、周期执行等专属会话一律不可认领（`source_managed_elsewhere`），同步更新项目置顶进度卡与话题卡片，全程记录 `[project-workstream-claim]` 与 `[project-import-card]` 审计日志。
2. **本人真人回合显式认领**：本人在项目群直接 @主控 发话要求认领并登记时，主控可在该真人回合执行 `botmux project workstream attach ... --claim-owner` 完成认领与登记（非真人回合调用一律返回 `actor_nonhuman`；已有其他 owner 的会话一律返回 `source_owner_already_present`，绝不覆盖）。

在宿主投递的 `project-import` 通知回合中，仅对当前通知绑定的 `(rootMessageId, sourceLarkAppId, sourceSessionId)` 放行 `inspect`、`confirm`、同主人会话的 `attach` 与该话题的 `rename`（使同主人会话能立即写入项目置顶进度卡并把话题卡更新为「已登记看板」）；其它源会话、`--claim-owner`、`--grant`、`notifications`、`update`、`status`、`grant` 一律返回 `actor_nonhuman`。通知回合的身份就是主控会话由真人建立的 owner，宿主不会因为一次迁入去设定或改写主控 owner。不放开静默回合的模型自由群发，避免提示词注入或后台重试噪音污染主群时间线。

## 安全与恢复

- `inspect` 仅返回授权后的元数据；不读取旧 transcript、cwd 或 raw terminal。
- 宿主拒绝目录保存来源、目标和登记版本，项目卡/派单 registry 只是可恢复投影。
- pending 登记不能 report；active imported binding 签源 app/session/owner/routeRevision。
- 每次 report 对宿主 journal 和当前 source/项目/主控重核，旧有效签名不能复活旧版本。
- 同 root 重启不新增行；换源会话/关联版本需要显式 `--revision` 比较更新。
- workflow、会议、监听和周期执行的专属会话不会被普通项目登记抢占。
- 外部 adopt 仅手工跟踪，不能假定其已获得 botmux prompt 或回报 capability。
- rename 不发送新 prompt，修改项目行与任务树标题，不更改完成状态。
- `attach` 与 `status` 须由主控会话的 owner 本人在当前回合执行；其它成员或无 owner 的
  主控会话直接拒绝（`project_coordinator_owner_required`），因为回报校验绑定主控会话 owner。
  owner 归一化前后以及后续队列/文件锁等待期间都校验宿主身份快照；owner 改变时拒绝旧操作，
  不自动把旧关联转交给新 owner。
- 来源 worker 空闲挂起或被回收不改变关联：登记和 status 不把一时未就绪当成失去回报能力；
  回报时仍要求来源 CLI 已就绪。

新任务要借旧上下文时，使用受支持的 native `/fork` 得到新话题后登记新的 root；
不支持或源忙时，新建 dispatch 并明确传递摘要/产物。第一期仍一个 root 一项任务。

## 可选迁入通知

默认关闭，旧群升级后不增加模型回合、不多发消息。群级开关 `importedSessionPolicy`
在 Dashboard「群组 → 项目模式 → 迁入会话时通知主控」配置（项目未初始化时也可开），
项目已初始化后，主控也可在本人当前回合显式切换：

```bash
botmux project workstream notifications --mode notify
botmux project workstream notifications --mode ignore
```

开启后：已初始化的项目里，迁入会话会让主控跑一轮静默通知回合（只可登记同主人会话），
并由宿主在迁入话题发一张登记卡；项目尚未初始化时，宿主只在话题发「等待项目初始化」卡，
通知留在 pending，等真人初始化项目后再投递给主控，并刷新卡片。

只通知明确 relay/bind/adopt/import/fork 的项目 Worker 独立话题，非项目群不发。
通知只含 app/session/root/source/revision，不附标题、cwd、transcript 或终端内容。
通知不是认领许可；主控不能从无真人 sender 的通知回合推测 owner 身份。

来源提交时保存 pending 标记，宿主每 30 秒有界补投；持久 outbox 用同一
关联版本的确定性 ID 去重。目标主控唯一且存在才投递；离线保留 pending，
没有主控时不自动建会话。源或项目模式改变会取消陈旧事件。

重复发送沿用相同 trigger idempotency key；只有宿主 input-commit 回执才能确认
已通知。未知结果保留 pending，不能为了改投新主控而盲目重复运行模型。

设置开关时，等待文件锁期间的当前回合授权、项目版本和主控替换会被重新校验。
若提交后响应失败，失败不代表设置已回滚：应读回群的 `importedSessionPolicy`，
不要自动反向写入。显式重试同一目标值可以安全收敛。
