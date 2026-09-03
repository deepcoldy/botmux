# Skill + CLI 交互

CLI 进入 botmux 会话时，自动获得 `~/.botmux/bin` 在 PATH 中，以及一组开箱即用的能力。这是 CLI agent **主动**与飞书话题交互的通道——「终端有输出但没发飞书」的根因往往就是模型没走这个通道（见 [FAQ · C](/faq#c-终端有输出但没发飞书)）。

## 开箱即用的能力

会话内可直接调这些 `botmux` 子命令（session 信息自动推断，无需传 id）：

| 命令 | 作用 |
|------|------|
| `botmux send` | 向当前话题发消息（文本 / 图片 / 文件 / interactive 卡片 JSON / @mention） |
| `botmux history` | 读当前会话历史消息（话题群拉话题内，普通群拉整群） |
| `botmux quoted <message_id>` | 读取被引用的那条消息 |
| `botmux bots list` | 查当前群里的机器人及 open_id（供 `--mention`） |
| `botmux schedule` | 增删改查定时任务 |

> 这些是最常用的一组；实际可用命令更多（如 `botmux ask` 交互提问、workflow / goal / dispatch 编排入口等），以 `botmux --help` 与注入的 Skill 目录为准。交棒 / 编排另有 `botmux-handoff` / `botmux-orchestrate` 等 **Skill**（是 Skill、不是可执行子命令）。

### `botmux send` 的 @ 决策硬门

`botmux send` **必须带一个 @ 决策**，否则拒发：`--mention <openId>`（点名）/ `--mention-back`（@ 回触发者）/ `--no-mention`（不 @）。其中 `--no-mention` 与前两者互斥。仅显式 `--top-level` 旗标（或全局关闭硬门）豁免——**普通话题 / 引用回复照样要三选一**。这道门确保「该 @ 的没漏、不该 @ 的不炸群」。

## wrapper 机制

会话内命令依赖 `~/.botmux/bin/botmux`——**daemon 启动时自动维护**并加入 worker 的 PATH，所以**版本永远跟 daemon 一致**，不需要单独装一份。它指向什么取决于 daemon 自己是怎么跑的：curl 安装时这个路径**就是那个自包含二进制本身**（daemon 识别出来后跳过改写，不会把自己覆盖成脚本）；npm 安装时是一行 `exec "<平台子包里的二进制>"` 的极薄 shim；源码开发态则是 `exec node <本 daemon 的 dist/cli.js>`。（`bun run use:here` 之类是开发期手动改指向，与启动写入同内容、幂等。）

session 信息通过**祖先进程标记**自动推断：worker 启动 CLI 时按子进程 PID 写一份标记（含 sessionId / turnId），agent 侧的命令沿进程树向上找到最近的标记即知道自己属于哪个会话——所以 agent 无需手动传 session id。进程树被打断（detached / `setsid` / 深层嵌套）时回落到 `BOTMUX_SESSION_ID` 环境变量兜底。

## 注入机制（按 CLI 而异）

路由指引与 Skill 目录**注入的通道随 CLI 不同**，不是一刀切：

- **Claude 家族（claude-code / seed / relay）**：路由 / 身份走 `--append-system-prompt`；Skill 走 `--plugin-dir`（不是塞进 system prompt）。
- **genius**：路由 + Skill 目录都走 `--append-system-prompt`；**grok** 用它的等价开关 `--rules`。
- **其余大多数 CLI**（codex / gemini / opencode / cursor / coco / traex 等）：默认 `skillInjection=prompt` 模式下，路由与 Skill 目录**内联进首条 prompt**，不占任何 system-prompt 旗标。

> Skill catalog 的注入受 per-bot `skillInjection` 模式影响（genius/grok 同样）：`prompt`（默认）内联精简目录进 prompt、按需 `botmux skill show <name>` 拉全文；`global` 把 skill 文件装进 CLI 共享 skills 目录（你手跑的 CLI 也会看到）；`off` 则不装目录、只留路由指引 + `botmux --help`。配过 `global`/`off` 的机制与上面「内联」不同。
>
> 注入指引按当前 locale 动态生成，因此会尊重你设的语言。

## 为什么是 Skill + CLI，而不是 MCP

相比基于 MCP 的方案，Skill + CLI 组合：

- CLI 启动**不用做 MCP 握手**，核心的 `botmux send` / `history` 等通道零 MCP 依赖，也不占用工具列表 token（仅当 adapter 显式开启且插件真的贡献了 MCP server 时才起网关）。
- **shell / 路由这一层通用**——只要 CLI 能读 system prompt、能跑 shell 命令，`~/.botmux/bin/botmux` + PATH 就能用，覆盖 Claude Code / Codex / Cursor / Gemini / OpenCode 等。

> ⚠️ 但**开箱 Skill 这一层并非对所有 CLI 均等**：少数 CLI（如 Antigravity，只认插件包内的 SKILL.md、不认扁平 `skills/` 目录）只拿到路由指引、不装 Skill 目录。所以「通用」对 shell/路由通道成立，对 Skill 目录是「大多数」而非「全部」。
