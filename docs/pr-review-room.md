# PR Review Room

`botmux pr-room` 把一次 Pull Request 变成一个有生命周期的飞书协作群。作者
agent、显式选定的 Owner/reviewer agent，以及这些 agent 已绑定的人类 Owner 会被
拉进同一个群；群内对话继续走 Botmux 原有的 agent 会话、工作目录和消息路由。

## 在提交 PR 后建群

作者 agent 创建并 push PR 后执行：

```bash
botmux pr-room open https://github.com/acme/service/pull/123 \
  --owner-agent owner-reviewer \
  --working-dir /path/to/service
```

- 作者 agent 默认取当前会话的 `BOTMUX_LARK_APP_ID`，也可用
  `--author-agent <name|larkAppId>` 显式指定。
- `--owner-agent` 可重复。名称不唯一时命令会拒绝猜测，并要求改用
  `larkAppId`。
- PR URL 是 team 内的幂等键；重复执行会返回原 `chatId`，不会重复拉群。
- 建群复用 federation roster 和联邦拉群链路，因此 reviewer agent 在其他
  Botmux 部署上也可以被邀请。远端部署会先确认 reviewer 已入群并写入团队信任，
  再允许作者 agent 发出 @ kickoff；离线或未就绪部署会明确降级，而不会假报成功。
- 建群后 Botmux 会 @ reviewer agent，要求其独立检查 diff、测试、风险和
  可维护性；作者 agent 根据评论修改、验证和 push。
- 建群请求超时或本地连接在提交窗口中断时，Botmux 会把结果标记为“不确定”并阻止自动重试，
  避免远端其实已成功却又创建重复群；找到实际群后用 `pr-room adopt` 接管。若
  确认没有建成，执行 `pr-room finish` 终止该不确定记录，再用 `--reopen` 重试。

## 接管已经创建的群

如果 Owner 已经先建了 review 群，不要再开一个：

```bash
botmux pr-room adopt https://github.com/acme/service/pull/123 \
  --chat-id oc_xxx \
  --owner-agent owner-reviewer \
  --working-dir /path/to/service
```

`adopt` 会把现有群绑定到该 PR。若 PR 已绑定另一个群，它会拒绝覆盖。传入
`--owner-agent` 时会先验证作者/reviewer 都在群中、同步团队信任，再触发 review；
省略时只建立生命周期记录。`--working-dir` 只绑定作者 agent 的工作目录。

## 修复降级 setup

如果建群已经成功，但 reviewer 邀请、远端信任、工作目录或 kickoff 失败，room 会
保留为 `active/degraded`，重复 `open` 不会假报成功，也不会再建群。修复外部原因后
显式重做 setup：

```bash
botmux pr-room repair https://github.com/acme/service/pull/123 \
  --owner-agent owner-reviewer
```

`repair` 只重做尚未完成的群内准备，不创建新群。首次 setup 会持久化 reviewer 和
workdir 意图，所以常规重试不必重复参数；显式传参可替换对应意图。每次 repair 都会
原子领取 attempt，同一 room 的并发命令不会重复发送 kickoff。人类 Owner 未入群或
未绑定会作为独立未完成项保留；确认 Owner 已手动入群后执行：

```bash
botmux pr-room repair https://github.com/acme/service/pull/123 \
  --ack-owner-present
```

旧版本遗留、缺少结构化 setup 意图的 pending 记录不会被直接标成 ready，必须显式
补传 `--owner-agent`、`--working-dir` 或 `--ack-owner-present`。

## 结束

PR 合并、关闭或明确废弃后执行：

```bash
botmux pr-room finish https://github.com/acme/service/pull/123
```

这只把生命周期标记为结束。群、消息和审查记录都会保留，不会自动解散或删除。
若 setup 正在执行，`finish` 会先记录结束请求，由当前 setup attempt 完成后原子结束，
避免在 room 已终结后仍发送 kickoff。
`botmux pr-room list` 可查看当前 team 的活跃及历史记录。

结束后的同一 PR 默认不能覆盖原生命周期；如确需重开，显式传 `--reopen`。幂等
锁当前落在发起命令的 Botmux 部署上，因此团队约定由 PR 作者所在的 hub/主部署
执行 `open`；跨部署同时发起尚不提供分布式唯一性保证。

## 边界

该命令负责 PR 创建后的协作编排，不代替 GitHub/SCM 创建、审批或合并 PR。
当前版本要求创建 PR 的 agent 紧接着调用 `pr-room open`；未来可由 SCM webhook
调用同一套生命周期与联邦建群能力，而不改变群内协作模型。
