# 最佳实践

> 按**使用场景**给推荐配置。基础用法见各功能页；排查类问题见 [常见踩坑](/pitfalls) 与 [FAQ](/faq)。

## 场景一 · Oncall 答疑

值班群 / 跨团队咨询 / 对外答疑——群里任何人都能 @ 机器人提问。

- **用一台干净的专用 Devbox**：给 oncall 单独起一台干净的 Devbox 部署，这样不怕值班/外部人员把你**个人的开发环境**搞乱。
- **配 oncall 机器人的角色**：用 `/role set`（本群）或 `/role team set`（跨群默认）写好人设与边界。可以搞**多个机器人对应不同的开发目录**，各管一摊。
- **把权限/边界写进默认角色**：典型的 oncall 角色 prompt（在群里发 `/role set` 后贴）：

```
你作为「申晗」的 oncall 机器人会收到用户的提问：
- 如果用户只是 @ 了你，请先看群聊历史再回答
- 如果用户反馈的是他自己机器上的问题，不要当成本机问题去排查
- 如果用户的某些要求会暴露隐私或有安全风险，请先让「申晗」确认
- 如果要提 MR，以「申晗」的身份提
```

- **排查用 worktree、收尾要清理**：在独立 git worktree 里排查，排查完记得删掉，别污染主仓库。
- **提 MR 的身份**也可以在默认角色里写死，避免提错人。
- 配 `/oncall bind <项目目录>`，群内即问即答、跳过选仓库。权限分层兜底：群里所有人可问（`canTalk`），`/cd` `/restart` `/close` 等操作仍只有 owner（`allowedUsers`）能动。

> 在 Dashboard 的 **Roles** 面板可以可视化给每个群里的每个 bot 配角色：

![Dashboard Roles 面板](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780057302792_dash-roles.png)

## 场景二 · 报警运维

监控告警 / CI / 工单触发——让外部系统主动把事推给机器人处理。

- **试用 Webhook 接入点**（Dashboard「接入点(beta)」，详见 [接入点（Webhook）](/webhook)）：让外部系统（监控告警、CI、工单…）通过一个 webhook 触发机器人在群里说话或跑工作流。可配：触发的机器人、触发方式（单轮对话 / 工作流）、投递到哪个群、校验方式（**令牌**放进 URL 一条 curl 就能触发 / **HMAC 签名**更安全）、以及**处理指令**（告诉机器人收到事件该做什么）。
- **每个报警自动拉群**：可以配成「每来一个报警自动建一个群、把机器人和**值班人一起拉进去**」；填了去重键就把同类报警合并到同一个群，留空则每条报警一个新群——值班同学直接在群里跟进。
- **不同项目对应不同的报警机器人**：给每个项目一个报警机器人，各自配好带项目背景的默认角色 prompt。
- **不同报警机器人配不同的 oncall 目录**：每个报警机器人 `/oncall bind` 到对应项目目录，报警进来直接在那个仓库里排查。
- 也可叠加[定时任务](/schedule)做**主动巡检播报**：`/schedule 每天9:00 检查昨天的报警趋势并总结`，异常才 @ 人。

![Dashboard 接入点（Webhook）](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780057303071_dash-connector.png)

## 场景三 · 个人研发

一个人，多机器人协作开发。

- **多机器人对应不同 CLI**：建多个 bot 分别绑不同 CLI（Claude Code / Codex / …），按任务挑顺手的。
- **同一个 CLI 也能多机器人互审**：既可以是**不同模型**互相 review，也可以是**同一模型多个机器人**以 sub-agent 的方式互审——多一双眼睛更稳。
- **多用 `/g`(=`/group`) 拉群协作**：一个群拉多个机器人一起开发同一个需求；或者用**话题群「一个话题一个需求」**，上下文天然隔离。
- **给每个机器人设角色分工**：有的负责开发、有的负责 review，配合 `/role` + `/role cap` 能力标签，协作不打架。

![Dashboard 新建群（勾选多个机器人）](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300986_dash-newgroup.png)

## 场景四 · 多人协作

团队里多个人、各自的机器人一起干活。

- **飞书的限制**：不同人名下的机器人**默认互相感知不到**（收不到对方在群里的消息）。
- **方式一 · introduce**：先 `@大家的 bot /introduce` 让它们彼此建立感知（登记 open_id），然后由一个**主机器人**给其他机器人分工协作。
- **方式二 · 团队功能（推荐，免 introduce）**：在 Dashboard「团队」里把多个人名下的 Bot 打上标签、拉到一个团队，**跨部署互相发现**，直接勾选拉群开协作——不用每次都 introduce。

![Dashboard 团队 · 跨部署协作](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301213_dash-team.png)

## 通用建议（各场景适用）

- **三端无缝协同**：装 tmux → 会话常驻、daemon 重启不丢上下文；电脑上的 CLI 用 `/adopt` 接进飞书，手机继续；要动手点「🔑 获取操作链接」拿可写 Web 终端。
- **常开 + 自启**：部署在常开的开发机 / 服务器，配 `botmux autostart enable` 重启自恢复。
- **及时清理**：会话用完顺手 `/close`；积压了用 Dashboard 批量关或 `botmux delete stopped` 清僵尸。
