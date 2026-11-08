# 架构总览

<video src="img/video-v9-architecture.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

botmux 做的事情一句话就能说清：**把飞书里的消息，变成 AI 编程 CLI 的输入；再把 CLI 的输出，变回飞书里的卡片。** 这一页讲它由哪些进程组成、一条消息怎么走、重启时会发生什么。日常使用不需要读懂这些，排查问题或参与开发时再来看就行。

## 一张图看懂

![botmux 进程结构：supervisor 拉起每个 bot 的 daemon、Dashboard 和插件服务；daemon 为每个话题起一个 worker，worker 通过 tmux 等会话后端连接 CLI 进程](/img/arch-overview-zh.png)

## 各进程分别做什么

| 进程 | 有几个 | 做什么 |
|------|--------|--------|
| supervisor | 每台机器 1 个 | `botmux start` 起来的就是它。负责启动每个 bot 的 daemon、Dashboard 和插件服务，谁崩了就把谁拉起来 |
| daemon | **每个 bot 1 个** | 连飞书长连接收消息，判断消息该不该处理、归哪个会话，处理斜杠命令，管理会话的创建、恢复和关闭 |
| worker | 每个活跃话题 1 个 | 通过适配器启动 CLI，把飞书消息输入进去，把终端输出整理成流式卡片发回飞书；同时提供该会话的 [Web 终端](/web-terminal) |
| CLI 进程 | 每个话题 1 个 | 真正干活的 AI 编程 CLI，跑在 tmux 等后端里，和你在终端里直接用它一样 |
| dashboard | 每台机器 1 个 | [管理后台](/dashboard)，默认端口 7891 |

几个要点：

- **一个 bot 一个 daemon，进程彼此隔离。** 一个 bot 出问题不会拖垮其它 bot。多机器人见 [多机器人](/multi-bot)。
- **worker 和 CLI 之间隔着一层「会话后端」。** 默认是 tmux：CLI 常驻在 tmux 里，worker 或 daemon 重启都不会打断它。
- 不想接飞书、只想用 HTTP API 驱动 CLI？可以用单进程的 [Core-only 模式](/api-core-only)，它不走 supervisor，也不需要 `bots.json`。

## 一条消息是怎么走的

![一条消息的流程：飞书推送、daemon 过滤、命令分类、找到或创建会话、输出变成卡片](/img/arch-message-flow-zh.png)

以「在话题里 @bot 说一句话」为例：

1. **飞书推送消息给 daemon。** daemon 先判断这条消息要不要处理：是不是 @ 了自己、在不在自己负责的话题里、发消息的人有没有权限。
2. **识别斜杠命令。** 以 `/` 开头的消息先按命令表分类（如 `/close`、`/restart`），由 daemon 直接处理，或转交给 CLI。完整列表见 [斜杠命令](/slash-commands)。
3. **找到或创建会话。** 新话题会启动一个新的 worker 和 CLI；已有会话就直接复用，把消息输入给正在运行的 CLI。
4. **把输出变成卡片。** worker 持续读取 CLI 的输出，转成 Markdown，实时更新飞书里的流式卡片，回合结束时给出最终回复。
5. **CLI 也能主动发消息。** botmux 会给 CLI 注入一组内置 Skill（如 `botmux-send`、`botmux-schedule`、`botmux-history`），CLI 用它们往话题里发消息、建定时任务、读群聊记录等。详见 [Skill 与 CLI 命令](/skill-cli)。

## 重启时会发生什么

![重启时各会话后端的表现：tmux 等常驻后端保留 CLI，pty 后端会重新拉起](/img/arch-restart-zh.png)

`botmux restart` 会重启 daemon 和 worker，CLI 进程是否跟着重启，取决于会话后端：

| 后端 | 怎么开启 | daemon 重启后 |
|------|----------|---------------|
| **tmux**（默认） | 什么都不用配 | CLI 一直活着，下次消息自动重新接上，上下文不丢 |
| zmx / zellij / herdr | `backendType` 或 `BACKEND_TYPE` 显式指定 | 同样常驻，需要装对应工具 |
| pty | `BACKEND_TYPE=pty` 或 `backendType: "pty"` 显式指定 | CLI 跟着退出，重启后重新拉起 |

tmux 不可用时，botmux **不会悄悄降级到 pty**，而是拦下新会话并弹卡提示安装。细节见 [tmux 会话常驻](/tmux) 和 [ZMX 后端](/zmx)。

daemon 启动时会自动恢复之前活跃的会话，所以飞书里的话题重启后可以接着聊。

## 文件放在哪

| 路径 | 内容 |
|------|------|
| `~/.botmux/bots.json` | 机器人配置，见 [bots.json](/bots-json) |
| `~/.botmux/.env` | 全局环境变量，见 [环境变量](/env) |
| `~/.botmux/data/` | 会话数据，每个 bot 一个 SQLite 库（`session-stores/<appId>/sessions.db`） |
| `~/.botmux/logs/` | 日志：`daemon-<序号>-out.log` / `-err.log`、`dashboard-out.log` 等，也可以直接 `botmux logs` |

## 源码地图（给贡献者）

想改代码时，从这几个目录入手：

| 位置 | 职责 |
|------|------|
| `src/cli.ts`、`src/cli/` | `botmux` 命令行入口和各子命令 |
| `src/index-supervisor.ts`、`src/core/fleet-supervisor.ts` | supervisor：拉起并看护 daemon、dashboard、插件服务 |
| `src/daemon.ts` | daemon 的编排层，把各模块组装起来 |
| `src/worker.ts` | worker 进程：管理 CLI、渲染卡片、提供 Web 终端 |
| `src/bot-registry.ts`、`src/config.ts` | 读取 `bots.json` 与全局配置 |
| `src/adapters/cli/` | CLI 适配器，每种 CLI 一个文件（启动参数、输入方式、Skill 目录等） |
| `src/adapters/backend/` | 会话后端：tmux、pty、zmx、zellij、herdr 等 |
| `src/core/` | 会话管理、命令表与路由（`command-schema.ts` / `command-router.ts`）、worker 池、定时任务等 |
| `src/im/lark/` | 飞书相关：事件分发、卡片构建与回调、API 调用、消息解析 |
| `src/skills/` | 注入给 CLI 的内置 Skill |
| `src/dashboard/` | 管理后台 |
| `src/utils/` | 空闲检测、终端截屏渲染、日志等工具 |

新增一种 CLI 的完整步骤见仓库里的 `src/adapters/cli/CLAUDE.md`。
