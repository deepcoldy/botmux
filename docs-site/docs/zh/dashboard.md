# Dashboard 管控面

命令行 `botmux dashboard` 出一个一次性 token URL，浏览器里跨所有 daemon / 机器人统一管控。

```bash
botmux dashboard
# 输出: http://<lan-ip>:7891/?t=<token>
```

> 每次跑都换一个 token，老 URL 立即失效——一次一密的取链方式。

![Dashboard Groups 面板](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups 面板：chat × bot 矩阵，一眼看清哪个群里有哪些机器人</p>

## 功能

- **Sessions**：跨所有 bot 列出活跃 + 已关闭会话，可按 CLI / 状态 / adopt / 文本过滤。点进 detail 可「定位到飞书话题」（机器人在原话题发 📍 标记 + 自动开 chat AppLink）、复制各种 ID、关闭会话；支持多选批量关闭。
- **Schedules**：列出所有定时任务，可 Run now / Pause / Resume。
- **Groups**：一键拉新群、拉 bot 入群、自动转让群主、@ 提醒；解散群聊、bot 退群（关联会话自动清理）。
- **团队 / Roles / Bot Defaults**：团队面板做[跨部署协作](/roles)（邀请别人的部署进团队、跨部署拉群）；Roles 管理各 bot 按群人设；Bot Defaults（Bot 配置）配默认行为（新群 oncall、卡片签名、**默认角色**等）。
- **Workflows 管控面**：Run List 轮询；Run Detail 看 summary / dangling 红区 / node-activity / event timeline / 并发执行 timeline；可直接 cancel run、批准/拒绝 humanGate；Workflow Catalog 列出所有 workflow 并可带参触发。

## 部署细节

dashboard 走单独 pm2 进程 `botmux-dashboard`，跟 daemon 一起起停。每个 daemon 在 `127.0.0.1` 暴露内部 IPC（仅本机），dashboard 进程做反向代理 + HMAC 鉴权（`~/.botmux/.dashboard-secret`，mode 0600，不下发给浏览器）。
