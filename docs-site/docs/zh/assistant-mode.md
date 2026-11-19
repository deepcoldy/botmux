# 个人助理模式（assistantMode）

一个对全员开放私聊的 bot，默认所有人的会话共用同一个工作目录、同一份 CLI 记忆、同一个沙盒可写面——A 在私聊里说的事，B 的会话里模型能翻到。**个人助理模式**把这个 bot 变成「每个人自己的助理」：每个会话有且只有一个主人（owner），目录、CLI 数据目录（记忆 / 项目历史）、沙盒授权、宿主侧读接口全部按主人收窄。

## 开启

`bots.json` 里给这个 bot 加：

```json
{
  "assistantMode": true,
  "sandbox": true,
  "assistantTemplateDir": "~/assistant-template",
  "assistantLarkBotIdentity": false
}
```

- `assistantMode`：开关。**必须同时开 `sandbox: true`（oncall 白名单沙盒）**，否则会话一律拒绝启动——没有沙盒就没有隔离，退回共享目录正是这个模式要堵的洞。也可用 `/botconfig assistantMode on` 即时切换。
- `assistantTemplateDir`：模板目录（可选，缺省用 bot 的默认工作目录）。每次会话启动前把模板里的文件**覆盖**同步进主人的工作目录（模板没有的文件不删，主人自己的产物保留；不跟符号链接）。管理员维护共享知识 / CLAUDE.md 就放这里。
- `assistantLarkBotIdentity`：是否允许会话里的 `lark-cli` 用 **bot 身份**调飞书接口。缺省 `false`——bot 身份能读它所在的任何群和私聊，等于绕过隔离；只留 `--as user`（主人自己的授权）。

开启前请把 bot 级 `~/.botmux/bots/<appId>/claude/projects/` 里旧的共享记忆归档（它们对助理会话不可见，但仍是明文留在宿主上）。

## 谁是主人

| 会话在哪 | 主人 |
|------|------|
| 私聊 | 发消息的人 |
| `/group` 生成的会话群 | 建群的人（固定，不可改） |
| 普通群 | **把 bot 拉进群的人**（入群事件自动记录） |
| bot 早于开启模式就在的群 / 记录丢失 | 无主：bot 不工作，提示用 `/assistant claim` 认领 |

- `/assistant`：查看本群主人。
- `/assistant claim`：本群还没有主人（或主人已退群）时，发命令的人成为主人。已有主人的群不能被别人抢。
- `/assistant owner @某人`：bot 管理员（`allowedUsers`）指定或更换主人。更换后原主人名下的会话立刻停止，新主人重新发消息开始。
- 主人退群：该群所有会话挂起，群回到「无主」状态。

同一个人在多个群 / 私聊里的会话共用一套记忆和目录（按人分，不按群分）。

## 主人拿到什么

每个主人一个 `USER_HOME = ~/.botmux/bots/<appId>/users/<open_id>/`：

- `work/`：所有会话的工作目录（`/cd` `/repo` 在此模式下禁用）。
- `claude/`：这个人专属的 CLI 数据目录（记忆、项目历史、设置），**凭证副本里的 refreshToken 被替换成无效串**——只带访问令牌干活，永远刷不了共享账号的凭证；中央刷新脚本把新凭证分发到 `bots/*/users/*/claude/.credentials.json` 即可（见 `docs/file-sandbox.md`）。

沙盒里：真正的 `BOT_HOME`、其他主人的目录、角色库、整 bot 的附件桶都不可见；附件落 `attachments/<appId>/u/<open_id>/`。宿主侧 `botmux history --session-id` / `botmux quoted` / `botmux list` 只能触及同一主人的会话和本群消息。

## 不支持的东西

- 角色系统（`/role`、角色切换、按角色目录的定时任务）在此模式下关闭。
- 沙盒里看不到其他会话（`sessions.db` 不授；`botmux list` 在助理会话里为空）。
- 一个群只能有一个主人；多人共用的群请不要开此模式的 bot。
