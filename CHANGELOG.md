# 变更记录

## 待发布

- 脚本、Webhook、平台派发、没有创建人的定时任务这类没有真人发起的回合（以及签名派发里发起人是主人的 bot 消息）里，`lark-cli --as user` 默认改用 bot 主人自己的飞书授权，不再报 `No current requesting user`；主人没授权时授权链接私聊发给主人。真人发起的回合仍只用发起人自己的授权，本轮有其他人插话时也不用主人的。按触发人鉴权已覆盖「飞书用户身份」的 bot 不受影响。可在 Dashboard、`/botconfig` 或 `/config set larkUserOwnerFallback off` 关闭。
- 飞书机器人创建与权限自愈新增官方注册清单兜底：默认仍沿用网页登录态（有效登录态下添加机器人免扫码、启动时静默补权）。交互式 setup 网页创建失败时可改用飞书确认链接，随确认页申请权限、事件和卡片回调并分桶回读，疑似未开启灰度时对同一应用降级补配；Lark 创建同样使用注册清单。启动自检缺关键权限且本机没有可用登录态时，私信 owner 一条增量确认链接，代替逐项开通的深链。
- `actor: "owner"` 续轮时，管理员名单只有一个人的 bot 不必再配 `ownerOpenId`，默认这个人就是主人；多人名单仍需显式指定（新增 `ownerUnionId`，可按 `on_` 指定）。请求可附带 `actorUnionId`，与该 bot 的主人不是同一人时返回 403 `owner_mismatch`；会话 turns 的 `capabilities` 新增 `ownerUnionId` 供客户端探测。
- Dashboard 管理员可在 `/api/trigger` 使用 `actor: "owner"`，以显式配置的 bot 主人身份续轮。个人凭据需单独启用。
- 新增管理员令牌专用的 `GET /api/sessions/:sessionId/turns`，按游标读取结构化会话输入和发送回执。

- 修复飞书长连接经过无响应代理时 daemon 仍在线、却长期收不到事件的问题。连接尝试现在有总超时，网络恢复后自动重连。长时间无入站会重建连接，反复重建仍失败则由 supervisor 重启 daemon。
- `botmux status` 和 Dashboard 监控页现在展示飞书连接状态、重连开始时间、尝试次数与最近入站时间。
