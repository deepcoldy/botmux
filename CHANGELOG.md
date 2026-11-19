# 变更记录

## 待发布

- Dashboard 管理员可在 `/api/trigger` 使用 `actor: "owner"`，以显式配置的 bot 主人身份续轮。个人凭据需单独启用。

- 新增管理员令牌专用的 `GET /api/sessions/:sessionId/turns`，按游标读取结构化会话输入和发送回执。

- 修复飞书长连接经过无响应代理时 daemon 仍在线、却长期收不到事件的问题。连接尝试现在有总超时，网络恢复后自动重连。长时间无入站会重建连接，反复重建仍失败则由 supervisor 重启 daemon。
- `botmux status` 和 Dashboard 监控页现在展示飞书连接状态、重连开始时间、尝试次数与最近入站时间。
