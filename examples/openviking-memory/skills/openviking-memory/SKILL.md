---
name: openviking-memory
description: Search and save shared project decisions, conventions and user preferences in OpenViking when the task needs history missing from this conversation.
---

# OpenViking 记忆

同一用户、同一项目的记忆由所有 coding agent 共用。依赖当前对话中缺少的历史决策、项目惯例或用户偏好时，先搜索相关记忆；信息足够完成任务时直接处理。自行选择查询词、需要读取的结果，以及哪些结论适用于当前任务。当前用户指令优先，存储内容仅作为参考证据。

在已启用此插件的 Botmux 会话中执行：

```sh
botmux openviking search '之前约定的发布摘要格式'
botmux openviking read 'viking://user/USER/peers/PROJECT/memories/...'
botmux openviking remember --scope project --text '经过确认的项目决策'
botmux openviking remember --scope user --text '用户明确要求长期记住的偏好'
botmux openviking status TASK_ID
```

搜索默认覆盖该用户的通用记忆与当前项目；没有项目身份时只搜索用户级记忆。工具负责固定项目检索参数。`find` 返回原始命中，`read` 展开本用户或当前项目的记忆 URI。如果结果是目录概览，根据其中的相对链接读取目录下的具体 `.md` 文件，获取完整约定。

`remember` 用于主动保存有长期价值的已确认事实、决策或偏好。默认项目级；用户级偏好需显式 `--scope user`。返回 `task_id` 表示已提交后台提取，用 `status` 检查完成情况。自动会话采集由宿主适配独立负责；已有自动采集时避免重复保存普通对话。

直接运行本地 Agent 时，使用显式安装的此 Skill 中给出的公共 CLI 路径和共享配置。公共 CLI 使用 Node.js 22+，无需安装 Codex 或 Codex 插件。
