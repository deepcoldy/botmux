# Oncall 模式

把机器人拉进 oncall / 值班 / 报警群，绑定一个项目目录后，群里**任何成员**都能 @ 机器人提问，无需选仓库、无需开新会话——直接进入这个项目目录开聊。特别适合值班群、报警群、跨团队答疑这类「很多人、随时问、都问同一个项目」的场景。

> **拉群本身不等于授权**：bot 被拉进群不会自动放开对话权。群里任何人即问即答是 **oncall 绑定生效之后**才有的效果（或用裸 `/grant` 整群放开）；没绑 oncall、也没授权的限制态 bot，非名单成员 @ 它会被拦并触发授权申请卡。详见[权限与授权 · 入群不等于授权](/permissions#入群不等于授权)。

## 开启方式（三选一）

可以**按群**单独开，也可以在 **Bot 配置里设默认**让所有群自动开。

### 方式一：群里发命令

最快的方式——在群里直接发一句：

```
/oncall bind ~/projects/your-service
```

把**当前 bot** 在本群锚定到该目录。绑定**按 bot 计**——只影响这个 bot；多个 bot 一起绑用 `@bot1 @bot2 /oncall bind <path>`。需要操作权（owner / `allowedUsers`），适合临时拉个群就想立刻用。

### 方式二：按群开启（Dashboard）

进 Dashboard 的「**群组**」页，点某个群的「**管理**」，在弹出的卡片里勾选 **Oncall 模式** 下要开启的 bot、填上工作目录、点「保存」。

> 开启后，群内成员可 @ 机器人；新话题直接使用绑定目录。

只影响**这一个群**，适合给指定的几个群逐个开。

![按群开启 Oncall 模式](https://magic-builder.tos-cn-beijing.volces.com/uploads/oncall-group-card.jpg)

### 方式三：按 bot 默认开启（Dashboard）

进 Dashboard 的「**Bot 配置**」页，打开「**默认进入 oncall 模式**」开关、填一个默认工作目录、点「保存」。

从此该 bot **所有未绑定的群**下次开新话题时，都会自动绑定到这个目录——不用再逐群设置，新拉的群开箱即用。

> - 手动绑定 / 手动解绑过的群**不会**被覆盖。
> - 开关打开**之前**就已存在的老群不受影响（只对之后的新话题生效）。

![Bot 默认开启 Oncall 模式](https://magic-builder.tos-cn-beijing.volces.com/uploads/oncall-bot-default.jpg)

> 对应 `bots.json` 字段 `defaultOncall`，也可手动编辑。见 [bots.json 配置](/bots-json)。

## 命令

| 命令 | 说明 |
|------|------|
| `/oncall bind <path>` | 把当前 bot 在本群绑到某项目目录，需操作权（owner / `allowedUsers`；多 bot：`@bot1 @bot2 /oncall bind`） |
| `/oncall unbind` | 解绑（需操作权） |
| `/oncall status` | 查看当前绑定 |

## 权限分层

- oncall 绑定后，群里**所有人**都能跟机器人对话（提问、查日志、读代码），恒放行、不限额度
- 只有 **owner / 管理员**（`allowedUsers`）能切换会话状态（`/cd`、`/restart`、`/close`、点流式卡片按钮）
- 防止外部群成员误操作把会话搞乱

> 想让半可信成员的**改动也不碰真实仓库**？开 [文件沙盒](/sandbox)——写操作全隔离、owner 审阅 diff 后才落盘。

## 配合定时任务起飞

在 oncall 群里发 `/schedule 每天9:00 检查昨天的报警趋势并总结`，每天定点喂一份报告到群里——人不在岗，机器人替你看着。回复卡片会自动「发送给 @提问者 / cc @owner」，远程也能掌握群内动向。

**典型场景**：值班群、报警群（Argos 报警分析）、跨团队咨询群、Oncall 答疑。

![Oncall 模式效果演示](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243198_oncall.png)
