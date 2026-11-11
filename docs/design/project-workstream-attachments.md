# 已有话题登记为项目子任务

项目主控可把本群中已存在的独立话题纳入项目，而无需发送新的派单提示。
登记与任务完成、会话连接状态相互独立；迁出或断开连接不会自动完成任务。

## 命令

```bash
botmux project workstream inspect --root om_root --source-app cli_worker --source-session session-id
botmux project workstream attach --root om_root --source-app cli_worker --source-session session-id --title "具体任务"
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
读取私聊 transcript/终端。bot 触发回合、定时任务回合、未知 caller 不会被推测成人类。

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

默认关闭，旧群升级后不增加模型回合。项目主控在本人当前回合显式选择：

```bash
botmux project workstream notifications --mode notify
botmux project workstream notifications --mode ignore
```

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
