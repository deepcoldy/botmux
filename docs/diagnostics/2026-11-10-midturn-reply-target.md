# 中途消息的回复位置与轮次归属

## 根因

普通 live 会话的后续消息在 `src/daemon.ts:30557` 经
`buildFollowUpCliInput` 包装，在 `src/daemon.ts:30651` 经
`sendWorkerInput` 进入 worker。`src/core/session-manager.ts:1961` 附近的
follow-up 构建在 inline 模式添加 `user_message` 外壳，在 hook 模式使用正文；
两种形式均未附消息编号和话题根编号。`turnId` 已传给包装函数，但用于 sidecar
精确绑定，并未成为可供模型选择回复位置的消息上下文。

`src/worker.ts:21387` 判断当前输入是不是 type-ahead；符合条件时，
`src/worker.ts:21421` 把其消息编号加入 `queuedTypeAheadTurns`，保留正在执行的
`currentBotmuxTurnId`。`src/worker.ts:21464` 记录输入已写入，随后发布 PID marker。
这个队列保存的是回复轮次归属，不能仅凭队列存在认定输入被重复提交。

`src/cli.ts:11925` 的 `botmux send` 以 `currentTurnId` 调用
`pickTurnReplyTarget`。`src/core/reply-target.ts:321` 的查找刻意只允许该轮的记录，
不借用后来消息覆盖的最新槽位。因此 A 在话题内启动、B 在主聊天中途到来时，
执行身份仍是 A，默认回复位置也仍是 A。

`src/cli.ts:11839` 等位置通过 `advanceAncestorSessionTurn` 推进已发 final 的
排队轮次；`src/core/session-marker.ts:352` 取队首更新轮次 marker。
这解释了 final 后提示切换排队轮次的现象：归属队列推进，不是这里重新发送用户正文。
本次调查不改变这项用户可见行为。

## 实现边界

应把用于发送位置的消息选择与执行身份拆开：只有实际注入输入后才更新默认回复消息，
不能直接读取 daemon 最新接收消息（该消息可能尚未注入）。最终回复账本、任务回报、
鉴权和排队推进继续使用原执行身份。显式选择消息必须从当前会话已接收的权威记录解析，
不能凭模型提供的任意编号跨群借用上下文。

`--mention-back` 的发送者应来自所选回复消息，同时保留现有多参与者歧义门禁。
`--quote`、`--top-level`、`--chat-id`、`--into` 的既有显式路由，以及冻结的任务输出
来源，不应被新的默认位置覆盖。hook 和 inline 共用 follow-up 构建处均需加入位置元数据。

影响面包括本地 Claude Code/Codex 的 PTY 与 tmux、远端 runner、sandbox relay、
话题/主聊天会话与恢复会话；不能只改 CLI 中的单个查找点便认定这些路径一致。

## 验证环境

任务目录与 canonical 均未安装依赖；本机找到的另一套依赖对应较旧清单，缺少当前
`pg`、`@base-ui/react`、`typescript-native` 等依赖，SDK 与 node-pty 版本也不一致。
不满足仓库关于共享依赖必须一致的条件。仓库禁止在任务副本内 install，任务同时禁止
修改副本外文件，因此需先由环境维护侧提供与当前锁文件一致的依赖目录，再继续实现验证。

项目记忆检查另报告 `AGENTS.md` 为指向 `CLAUDE.md` 的符号链接，与检查器要求的真实
文件形态冲突；未改动这项仓库既有结构。
