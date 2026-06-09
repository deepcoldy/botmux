# botmux

<p class="lead">把飞书话题群变成 AI 编程 CLI 的遥控器。一条消息，启动一个独立的编程会话。</p>

botmux 是一座桥：一个常驻 **daemon** 监听飞书消息，为每个新话题自动启动一个独立的 AI 编程 CLI 进程（Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity 等），把终端输出实时渲染成飞书**流式卡片**，并提供一个可交互的 **Web 终端**。手机、电脑、飞书三端同步——人在哪儿，编程会话就跟到哪儿。

> 项目地址：<https://github.com/deepcoldy/botmux> ｜ npm：`npm install -g botmux`

## 设计理念：不做 SDK wrapper，直接桥接 CLI

botmux **不重新实现** Agent 能力，而是直接桥接已有的 AI 编程 CLI。记忆、上下文管理、工具调用、权限体系、plan mode、`/` 命令、MCP 生态——这些能力 CLI 本身都在飞速迭代，botmux 选择**站在这个进化之上**，而不是平行重造一套。CLI 每次升级，botmux 零适配自动受益。

同时，botmux 在 daemon 里用 **结构化 prompt 注入**（XML 标签）把用户内容和系统指令隔开后再喂给 CLI——这是模型公认最稳的提示词格式，但日常用户无需也不该手写 XML，你照常发人话即可，封装由 botmux 替你完成。

## 核心优势

与 OpenClaw 等"基于 Agent SDK 重新构建"的方案相比：

| 特性 | botmux | 基于 SDK 的方案 |
|------|--------|----------------|
| 底层架构 | 直接桥接**完整 CLI 进程** | 基于 Agent SDK 重新构建 |
| CLI 能力 | 完整运行时（hooks / memory / plan mode / Skill / `/` 命令 / MCP） | SDK API 子集，缺失功能需手动补 |
| CLI 升级 | 零适配自动受益 | 需跟进 SDK 版本变更 |
| 记忆 / 上下文 | 直接复用 CLI 内建记忆，随 CLI 迭代增强 | 需自建，与 CLI 原生能力重复 |
| 多 CLI | 6+ 种一键切换 | 绑定单一 SDK |
| Web 终端 | 可交互完整终端，三端同步 | 通常仅只读输出 |
| 多机器人协作 | 多 bot 同群 @mention 路由，进程隔离 | 通常单机器人 |
| 终端直连 | `tmux attach` 进入进程，与本地一致 | 无法操作底层终端 |

## 亮点功能

- **实时流式卡片** — 每轮对话一张实时更新的飞书卡片，终端输出渲染为 Markdown
- **可交互 Web 终端** — 不只是看，还能在浏览器里直接操作 CLI；移动端有悬浮快捷键工具栏
- **多机器人协作** — 同群放多个不同 CLI 的机器人，@谁谁干活，让 Claude Code 和 Codex 一起 review 代码
- **tmux 会话常驻** — daemon 重启不中断 CLI 进程
- **会话接管（Adopt）** — 把本地 tmux 里跑着的 CLI 一键接进飞书，换设备继续
- **定时任务** — 自然语言配置周期任务，到点在原话题续跑
- **Oncall 模式** — 把群锚定到一个项目，值班群任何人 @ 即问即答

➡️ 下一步：[5 分钟快速接入](/quickstart)
