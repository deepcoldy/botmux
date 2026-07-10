# Skill + CLI 交互

CLI 进入 botmux 会话时，自动获得 `~/.botmux/bin` 在 PATH 中，以及一组开箱即用的 Skill。这是 CLI agent **主动**与飞书话题交互的通道。

## 开箱即用的能力

| 命令 / Skill | 作用 |
|------|------|
| `botmux send` | 向当前话题发消息（文本 / 图片 / 文件 / interactive 卡片 JSON / @mention） |
| `botmux history` | 读当前会话历史消息（话题群拉话题内，普通群拉整群） |
| `botmux quoted <message_id>` | 读取被引用的那条消息（用户用引用 UI @ 机器人时） |
| `botmux bots list` | 查当前群里的机器人及 open_id（供 `--mention`） |
| `botmux schedule` | 增删改查定时任务 |

这些能力通过 `--append-system-prompt` 注入 + Skill 描述自动引导 agent 使用。

## 为什么是 Skill + CLI，而不是 MCP

相比 Anthropic 官方那套基于 MCP 的方案，Skill + CLI 组合：

- CLI 启动**不用做 MCP 握手**，不占用工具列表 token
- 对 Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity **通用**——只要 CLI 能读 system prompt、能跑 shell 命令就行，不依赖任何 MCP 协议支持

## wrapper 机制

会话内命令依赖 `~/.botmux/bin/botmux` 这个 wrapper 脚本，daemon 启动时自动写入并加入 worker 的 PATH，**版本始终与 daemon 一致**（不需要单独 `npm i -g`）。session 信息通过祖先进程标记自动推断，agent 无需手动传 session id。
