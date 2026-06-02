# Oncall 模式

把机器人拉进 oncall / 值班 / 报警群，一句 `/oncall bind ~/projects/your-service` 就能把这个群锚定到一个项目目录。从此群里**任何成员**都能 @ 机器人提问，无需选仓库、无需开新会话——直接进入这个项目目录开聊。

## 命令

| 命令 | 说明 |
|------|------|
| `/oncall bind <path>` | 绑定当前群到某项目目录，发起人自动成为 owner |
| `/oncall unbind` | 解绑（仅 owner） |
| `/oncall status` | 查看当前绑定 |

## 权限分层

- 群里**所有人**都能跟机器人对话（提问、查日志、读代码）
- 只有 **owner** 能切换会话状态（`/cd`、`/restart`、`/close`、点流式卡片按钮）
- 防止外部群成员误操作把会话搞乱

## 配合定时任务起飞

在 oncall 群里发 `/schedule 每天9:00 检查昨天的报警趋势并总结`，每天定点喂一份报告到群里——人不在岗，机器人替你看着。回复卡片会自动「发送给 @提问者 / cc @owner」，远程也能掌握群内动向。

**典型场景**：值班群、报警群（Argos 报警分析）、跨团队咨询群、Oncall 答疑。

![Oncall 模式](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780419243198_oncall.png)
