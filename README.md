# botmux

<p align="center">
  <img src="cover.svg" alt="botmux" width="760">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/binary-no%20Node%20required-brightgreen.svg" alt="self-contained binary, no Node required">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux.svg?style=social" alt="Stars"></a>
</p>

<p align="center"><b>在飞书里遥控你的 AI 编程 CLI。</b>一条消息启动一个会话，每个会话一个独立 CLI 进程，实时流式回传——手机、电脑、终端三端同步。</p>

<p align="center">
  <a href="https://deepcoldy.github.io/botmux/"><b>📖 文档</b></a> ·
  <a href="#5-分钟接入"><b>🚀 快速接入</b></a> ·
  <a href="https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg"><b>✨ 效果展示</b></a> ·
  <a href="README.en.md">English</a>
</p>

https://github.com/user-attachments/assets/2cd97623-6b92-42ea-a9e9-75c6f5434db6

---

Daemon 监听飞书消息，为每个新会话自动 spawn 一个独立的会话进程，把 AI 编程 CLI / Agent 的输出实时流式回传成飞书卡片，并提供可交互的 Web 终端。它**不重造 Agent 能力**，而是直接桥接你已经在用的工具（**20+ CLI / Agent 适配器**，见 [支持的 CLI / Agent](#支持的-cli--agent)）。

## 它解决什么

- **Agent 收不到通知、手机控不了** — CLI 跑在开发机上，人在手机上。botmux 把每轮输出推成飞书卡片，随时随地查看 / 追问 / 打断，还能开可写 Web 终端直接操作。
- **CLI 不感知飞书上下文** — 把机器人拉进话题群 / oncall 群，@ 一句就在你本机的代码库里开跑；会话可以用 `/relay` 原样搬到另一个群，上下文一点不丢。
- **单个 Agent 不够用** — 同一个群里放多个不同 CLI 的机器人，@ 谁谁干活，让 Claude Code 和 Codex 一起 review 同一个 MR、各自独立分析、观点不同自动互怼。

## 5 分钟接入

> 一次飞书扫码即可连续建好应用、配全权限并自动发版（手动创建 / 粘贴凭证也是 setup 中的可选路径）。

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup                 # 一次扫码建应用 → 选 CLI → 选工作目录（自动配权限 + 发版）
botmux start                 # 启动 daemon（botmux autostart enable 设开机自启）
```

- **自包含单文件二进制**：运行时与 PTY 已内嵌，**安装和运行都不依赖本机 Node**。支持 Linux / macOS（x64 / arm64，macOS 正式版提供稳定 Apple Developer ID 签名），Windows 用户请在 WSL2 中使用。
- **平滑升级**：执行 `botmux upgrade` 或重跑上述 curl 命令即可原地安全更新。
- **完整指南**：包含 Lark 国际版、手动配置权限与排查，见 [5 分钟快速接入文档](https://deepcoldy.github.io/botmux/quickstart)。

<details>
<summary>习惯使用 Node / npm 生态？也可以通过 npm 安装（内嵌同一份二进制）</summary>

```bash
npm install -g botmux        # 需要 Node >= 22 执行安装本身
```

npm 包内包含相同的自包含二进制，安装后命令与行为完全一致。升级同样建议重跑 curl 命令或 `botmux upgrade`。

</details>

然后私聊机器人、或 `botmux dashboard` 拉个群即可开始对话。

## 核心场景

- **[实时流式卡片](https://deepcoldy.github.io/botmux/cards)** — 每轮对话一张实时刷新的卡片，终端画面原样截图回传；一键显示/隐藏输出、翻屏、重启/关闭/接管会话。
- **[多机器人协作](https://deepcoldy.github.io/botmux/multi-bot)** — 同群多 bot @mention 路由，不同 CLI 背后不同模型，天然多样性；方案评审 / 代码 review / 技术选型让它们互相挑刺。
- **[零注入模式](https://bytedance.larkoffice.com/docx/IECddVsSFotuuXx8gf3cQdKqnCd)** — 跳过框架注入的 prompt / 角色 / 技能，纯净任务直达 CLI，转写自动回传；适合 lead-bot 派活、sub-bot 专注执行。
- **[群内真人独立 lane](docs/principal-lanes.md)** — 可复用 Dashboard 的「跨身份打断隔离（XPI）」开关，让同一群里的真人各用独立 CLI 上下文和 git worktree；消息仍公开可见，引用别人的任务仍可走建议/确认协作。
- **[多话题并行编排](https://deepcoldy.github.io/botmux/multi-topic)** — 给编排者一个大任务，它自动在群里种话题、拉各 bot 起独立会话跑流水线，飞书任务面板一眼看完所有子任务进度。
- **[可交互 Web 终端](https://deepcoldy.github.io/botmux/web-terminal)** — 不只是看输出，浏览器 / 手机直接操作 CLI，移动端带悬浮快捷键栏（Esc、Ctrl+C、方向键）。
- **[Orca 原生会话](docs/orca-managed-sessions.md)** — 选择 Orca · Codex / Claude Code 后，Bot 新会话自动进入 Orca 对应项目；在飞书与桌面继续同一段对话，无需逐个 `/adopt`。
- **[会话接入 & 接力](https://deepcoldy.github.io/botmux/adopt)** — tmux / Zellij / Herdr / Orca（实验性）里跑到一半，手机 `/adopt` 接入；`/relay` 把整个会话（原进程、原记忆）搬进团队群继续。
- **[定时任务](https://deepcoldy.github.io/botmux/schedule) & [外部触发](https://deepcoldy.github.io/botmux/webhook)** — 自然语言配周期任务（报警分析 / 群总结）；从外部系统编程式触发用 [Webhook](https://deepcoldy.github.io/botmux/webhook) 或 [API 任务触发](https://deepcoldy.github.io/botmux/api-task-trigger)。
- **[Oncall 模式](https://deepcoldy.github.io/botmux/oncall) & [语音总结](https://deepcoldy.github.io/botmux/voice)** — 拉进 oncall 群，任何成员 @ 即在项目目录排查；配好 TTS 后每张卡片页脚会多一个 🔊 语音总结按钮，让模型「说人话」。

更多特性：[角色与团队](https://deepcoldy.github.io/botmux/roles) · [文件沙盒](https://deepcoldy.github.io/botmux/sandbox) · [最终回答三态反馈](docs/feedback-capability-current-implementation.md) · [Dashboard 管控面](https://deepcoldy.github.io/botmux/dashboard) · [tmux 会话常驻](https://deepcoldy.github.io/botmux/tmux) · [飞书会议智能体展示](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)。

## 按 Bot 设置零注入

适合 lead-bot 派活、sub-bot 专注执行的多 Agent 流水线。开启后，botmux 仅传递纯净的任务正文与附件，跳过所有框架级系统提示、逐轮提醒、身份信封、角色描述和技能目录注入，由底层 CLI 转写自动采集回传最终回答。

- ✨ **效果展示与配置指南**：[飞书文档图文演示](https://bytedance.larkoffice.com/docx/IECddVsSFotuuXx8gf3cQdKqnCd)
- 📑 **技术实现与兼容矩阵**：[零注入模式规范文档](docs/zero-prompt-injection.md)

**开启方式**：
- **Dashboard**：「Bot 配置」→ 选中 Bot →「高级」开启「零注入」（或在「Agent 配置」中开启分组统一管理）；
- **`bots.json`**：在对应条目中设置 `"promptInjection": "none"`（设为 `"default"` 或移除该字段恢复原状）。

## 支持的 CLI / Agent

通过 `bots.json` 里的 `cliId` 一键切换。内置 **20+ 适配器**，覆盖本地 CLI（独立进程隔离，`tmux attach` 可直接接入调试）以及 API / 云 Agent：

`claude-code` · `codex` · `gemini` · `cursor` · `opencode` · `opencode2` · `mimocode` · `antigravity` · `copilot` · `grok` · `kimi` · `codem` ([CodeM 说明](docs/codem.md)) · `kiro-cli` · `reasonix` · `dsh` · `aiden` · `coco` (TRAE) · `traex` · `mtr` · `hermes` · `ebsd` ([配置说明](docs/ebsd.md)) · `mira` · `riff` (云 Agent) · `mojo` · `remote-runner` ([通用远端 Runner 协议](docs/remote-runner.md)) · `minimax` ([MiniMax Code 说明](docs/minimax-code.md)) …

- **会话级 CLI 切换**：会话尚未启动前，可通过 `/cli <cliId>` 为当前会话临时指定已注册的 CLI。
- **Codex 多账号与实例池**：同一 Bot 支持通过 [会话级 Codex 实例](docs/codex-instances.md) 配置多登录目录与分配策略。
- **兼容发行版**：Codex 衍生版和 Kimi TUI 衍生版可直接保留原 `cliId` 并通过 `cliRuntime` 声明独立身份，详见 [Codex 兼容发行版](https://deepcoldy.github.io/botmux/adapters#codex-兼容发行版)。
- **共享记忆（可选）**：通过 [OpenViking 共享记忆示例](examples/openviking-memory/README.md) 让多个本地 Agent 共享用户与项目级长期记忆。

完整 `cliId` 列表与网关 / wrapper 详细配置见 [多 CLI 适配器文档](https://deepcoldy.github.io/botmux/adapters)。

## 设计理念：直接桥接 CLI，不做 SDK wrapper

botmux 不重新实现记忆、上下文管理、工具调用、权限体系——**多数 CLI 原生能力无需 botmux 重造，CLI 升级通常直接受益**（接口 / 参数 / 输出格式 / resume 语义有变时，adapter 仍可能要跟进）。用户照常发人话，daemon 在后台把上下文封装成结构化 prompt 再喂给 CLI。基于 Agent SDK 的方案则相反：能力取决于 SDK 暴露的接口面与你自己的集成实现。

下表只对比**可核验的集成边界**，不对其它方案下「必然缺失」的结论：

| 集成边界 | botmux | 基于 Agent SDK 的方案 |
|------|--------|----------------------|
| 桥接对象 | 完整 CLI 进程（含 hooks / memory / plan mode / MCP / `/` 命令等 CLI 自带运行时） | SDK 暴露的接口面 |
| CLI 升级 | 多数直接受益；接口 / resume 有变时 adapter 跟进 | 取决于 SDK 版本与集成实现 |
| 记忆 / 上下文 | 直接复用 CLI 内建 | 取决于 SDK / 自建 |
| 多 CLI / Agent | 20+ 适配器一键切换 | 取决于 SDK 覆盖面 |
| 多机器人 | 同群多 bot @mention 路由 | 取决于实现 |
| 终端直连 | 本地 CLI 可 `tmux attach` 进真进程 | 取决于实现 |

## 进阶集成

- **[可信建群服务的默认免 @](docs/signed-chat-defaults.md)** — 自助建群服务可通过签名绑定为普通群声明默认 `ambient` 免 @ 模式，在保持权限隔离的同时简化群交互。
- **[模型透明代理模式](docs/model-proxy.md)** — 外部系统（如 [OpenCodeReview](https://github.com/alibaba/open-code-review)）可通过有鉴权的本地 Chat Completions 入口直接复用 CLI 的模型能力，结合 [受约束执行接口](docs/constrained-invocations.md) 实现任务幂等与状态查询。

## 文档 · 社区 · 贡献

- 📖 **完整文档**（命令 / 配置 / 最佳实践 / 排错）：**<https://deepcoldy.github.io/botmux/>**
- ✨ **效果展示**（图文 + 视频演示）：[《5 分钟创建一个真正好用的飞书助理》](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- ❓ **常见问题 / 排错**：[FAQ](https://deepcoldy.github.io/botmux/faq) · [常见踩坑](https://deepcoldy.github.io/botmux/pitfalls)
- 💬 **交流群**：[关于 & 资源](https://deepcoldy.github.io/botmux/about) 页有内部 / 外部「Botmux 交流群」的扫码入群入口。
- 🤝 **贡献**：欢迎 issue / PR。新增适配器见 [多 CLI 适配器](https://deepcoldy.github.io/botmux/adapters)。
- 📄 **License**：[MIT](LICENSE)

## 贡献者

botmux 或许是目前专为飞书（Feishu/Lark）打造的开源项目中贡献者最多的一个——这离不开每一位参与者。感谢所有提交过代码、文档，以及提出 issue 的朋友：

<a href="https://github.com/deepcoldy/botmux/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=deepcoldy/botmux" alt="contributors" />
</a>

<p align="center">好用的话，顺手点个 ⭐ Star 吧 → <a href="https://github.com/deepcoldy/botmux">deepcoldy/botmux</a></p>
