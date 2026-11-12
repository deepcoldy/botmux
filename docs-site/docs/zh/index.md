# botmux

<video src="img/video-v0-overview.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

<p class="lead">在飞书里遥控你的 AI 编程 CLI。一条消息启动一个会话，每个会话一个独立 CLI 进程。</p>

botmux 是一座桥。它在你的开发机上常驻一个后台服务（**daemon**），负责监听飞书消息：

- 每开一个新话题，就为它启动一个独立的 AI 编程 CLI（Claude Code、Codex、Cursor、OpenCode、Antigravity 等 30 多种）
- CLI 每一轮的输出，实时刷新到飞书里的一张**流式卡片**上
- 想直接动手时，点卡片上的按钮打开 **Web 终端**，在浏览器或手机里操作同一个 CLI

人在手机上、电脑前还是终端里，看到的都是同一个会话。

## 5 分钟上手

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup     # 扫码建飞书应用 → 选 CLI → 选工作目录（自动配权限并发版）
botmux start     # 启动 daemon；想开机自启用 botmux autostart enable
```

然后私聊机器人，或用 `botmux dashboard` 打开管理页拉个群，就能开始对话。

- 安装的是**自包含单文件二进制**，不依赖本机 Node，支持 Linux / macOS（x64 / arm64）；Windows 请在 WSL2 中使用
- 习惯 npm 也可以 `npm i -g botmux`，包里是同一份二进制
- 在 Mac 上也可以装 [macOS 桌面版](/desktop)，在 App 里点一下启停服务、看 Dashboard 和日志
- 以后升级：`botmux update`，或重跑上面的 curl 命令（v3.18.0 之前的老版本只用 curl），然后 `botmux restart`

完整步骤（含 Lark 国际版、手动配置权限、排错）见 [快速接入](/quickstart)。

## 它解决什么问题

| 你的困扰 | botmux 怎么做 |
|---|---|
| CLI 跑在开发机上，人不在电脑前就没法看、没法管 | 每轮输出推成飞书卡片，手机上随时查看、追问、打断；需要时开 Web 终端直接操作 |
| CLI 不知道飞书里发生了什么 | 把机器人拉进群，@ 一句就在你本机的代码库里开工；`/relay` 能把正在跑的会话（同一个 CLI 进程、同一份 AI 记忆）搬到另一个群接着聊 |
| 一个 Agent 不够用 | 同一个群里放多个接不同 CLI 的机器人，@ 谁谁干活，比如让 Claude Code 和 Codex 一起 review 同一个改动 |

## 常用功能

| 想做什么 | 看这里 |
|---|---|
| 看懂飞书里那张实时刷新的卡片和按钮 | [流式卡片](/cards) |
| 在浏览器 / 手机里直接操作 CLI | [Web 终端](/web-terminal) |
| 同一个群放多个机器人分工协作 | [多机器人协作](/multi-bot) |
| 把一个大任务拆成多个话题并行跑 | [多话题协作](/multi-topic) |
| 在群里置顶一张卡，跟踪项目的目标、待办和子任务 | [项目进度卡](/project-card) |
| 把开发任务交给管家，要你拍板的事集中到一处 | [决策看板与管家](/decision-board) |
| 把本地终端里跑到一半的 CLI 接进飞书 | [会话接管（/adopt）](/adopt) |
| 把会话搬到另一个群继续 | [会话接力（/relay）](/relay) |
| 定期自动跑任务（报警分析、群总结等） | [定时任务](/schedule) |
| 从外部系统触发任务 | [Webhook](/webhook) · [API 任务触发](/api-task-trigger) |
| 在脚本或 CI 里跑会话，不进飞书群 | [无群自动化会话](/headless-session) |
| 在飞书文档评论里直接问 AI | [文档评论监听](/doc-comment) |
| 让值班群里任何人 @ 都能问 | [Oncall 模式](/oncall) |
| 换一个 CLI，或给会话临时指定 CLI | [多 CLI 适配器](/adapters) |
| 在网页上管理机器人、会话和配置 | [Dashboard](/dashboard) · [全局设置](/global-settings) |
| 同时盯多个会话的进度和终端 | [驾驶舱](/workbench) |
| 在一个网站里管好几台机器、在外网打开 Dashboard 和终端、和团队协作 | [中心化平台（开源）](/platform) |

更多：[角色与团队](/roles) · [文件沙盒](/sandbox) · [语音总结](/voice) · [本地白板](/whiteboard) · [tmux 会话常驻](/tmux) · [反馈数据存储](/feedback-storage) · [模型协议代理（实验）](/model-proxy) · [斜杠命令一览](/slash-commands) · [CLI 命令](/cli-commands) · [架构概览](/architecture) · [最佳实践](/best-practices)

## 设计理念：直接桥接 CLI，不重造 Agent

botmux **不重新实现** Agent 能力。记忆、上下文管理、工具调用、权限、plan mode、`/` 命令、MCP 这些，交给 CLI 自己做。CLI 升级后，大多数新能力在 botmux 里直接就能用（CLI 的参数、输出格式或续聊方式变了时，对应的适配器才需要跟进）。

你照常发人话就行。daemon 会在后台把你的消息和系统指令用结构化格式（XML 标签）分开包好，再交给 CLI，你不需要自己写任何格式。

和「基于 Agent SDK 重新搭建」的方案比，区别主要在集成方式上：

| 对比项 | botmux | 基于 Agent SDK 的方案 |
|---|---|---|
| 桥接的是什么 | 完整的 CLI 进程，CLI 自带的 hooks / 记忆 / plan mode / MCP / `/` 命令都在 | SDK 暴露出来的接口 |
| CLI 升级 | 多数能力直接受益 | 取决于 SDK 版本和你的集成 |
| 记忆 / 上下文 | 直接用 CLI 内建的 | 取决于 SDK 或自建 |
| 多种 CLI | 30 多种适配器，在配置里一键切换 | 取决于 SDK 覆盖面 |
| 多机器人 | 同群多个 bot，按 @ 分派 | 取决于实现 |
| 直连终端 | 用 tmux 后端时，可以 `tmux attach` 进真实的 CLI 进程 | 取决于实现 |

➡️ 下一步：[快速接入](/quickstart)

> 项目地址：<https://github.com/deepcoldy/botmux>
