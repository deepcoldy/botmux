# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm version"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux.svg?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#设计理念">设计理念</a> · <a href="#核心优势">核心优势</a> · <a href="#5-分钟快速接入">快速接入</a> · <a href="https://deepcoldy.github.io/botmux/"><b>📖 文档</b></a> · <a href="https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg"><b>✨ 效果展示</b></a>
</p>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

---

**飞书 + AI 编程 CLI——私聊 / 群聊 / 话题，每个会话一个独立 CLI 进程，实时流式回传。** Daemon 监听飞书消息，为每个新会话自动启动独立 CLI 进程（Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity / GitHub Copilot / Kimi Code / Grok Build / Kiro），提供实时流式卡片和可交互 Web 终端。

> ✨ **先看效果**：[**《5 分钟创建一个真正好用的飞书助理》**](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg) —— 飞书图文 + 视频演示：AI 消息提醒 / 多端同步跨端操作 / 多 Bot 协作 / 多话题并行编排 / 语音总结 + 飞书会议 / Oncall 与个人替身。

> 📖 **完整文档**（命令 / 配置 / 最佳实践 / 排错）：**<https://deepcoldy.github.io/botmux/>** ——本 README 只讲为什么用它和怎么快速上手。

## 演示

| 飞书流式卡片 | Web 终端 | tmux 会话管理 | 多机器人协作 |
|:-:|:-:|:-:|:-:|
| <img src="gif/fold&unfold.gif" width="220" /> | <img src="gif/web_terminal.gif" width="220" /> | <img src="gif/tmux.gif" width="220" /> | <img src="docs/setup/multi-bot-collab.png" width="220" /> |

<details>
<summary>完整演示视频</summary>

[演示视频](https://github.com/user-attachments/assets/3ba4c681-0a7e-4a03-89c8-b8d26b544a65)
</details>

---

## 为什么选择 botmux

### 设计理念

**不做 SDK wrapper，直接桥接 CLI。**

botmux 不重新实现 Agent 能力，而是直接桥接已有的 AI 编程 CLI（Claude Code、Codex、Cursor、Gemini、OpenCode、Antigravity、GitHub Copilot、Kimi Code、Kiro）。记忆、上下文管理、工具调用、权限体系——这些能力 CLI 本身都在快速迭代，botmux 选择站在这个进化之上，而不是平行重造一套。CLI 的每次升级，botmux 零适配自动受益。

### 核心优势

与 OpenClaw 等基于 Agent SDK 构建的方案相比：

| 特性 | botmux | OpenClaw 类方案 |
|------|--------|----------------|
| 底层架构 | 直接桥接完整 CLI 进程 | 基于 Agent SDK 重新构建 |
| CLI 能力 | 完整运行时（hooks、memory、plan mode、Skill、`/` 命令） | SDK API 子集，需手动实现缺失功能 |
| CLI 升级 | 零适配自动受益 | 需要跟进 SDK 版本变更 |
| 记忆 / 上下文 | 直接复用 CLI 内建的记忆系统，随 CLI 迭代自动增强 | 需自建记忆系统，与 CLI 原生能力重复 |
| 多 CLI 支持 | 多种 CLI 一键切换（Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity / GitHub Copilot / Kimi Code / Grok Build / Kiro 等） | 绑定单一 SDK，无法切换 CLI |
| Web 终端 | 可交互的完整终端，移动端快捷键工具栏，手机/电脑/飞书三端同步 | 通常仅 Web 聊天界面或只读输出 |
| 多机器人协作 | 多 bot 同群 @mention 路由，独立进程隔离，不同 CLI 赛博斗蛐蛐 | 通常单机器人 |
| 多话题协作模式 | 主 bot 自动拆任务、开多话题、派多 bot 并行协作（coder+reviewer），飞书任务清单当共享进度板 | 通常需人工逐个分派、无统一进度板 |
| 终端直连 | tmux attach 直接进入 CLI 进程，和本地开发体验一致 | 无法直接操作底层终端 |
| 安装部署 | `npm install -g botmux`，5 分钟飞书配置即可使用 | 安装简单，但配置项较多 |

---

## 功能特性

### Skill 管理

botmux 可以管理 CLI 无关的自定义 Skill Registry，并按 bot 配置在会话启动时优先披露指定 skill；未配置时完全保持 Claude / Codex 等 CLI 自己的默认 skill 行为。安装、bot 级策略、Claude scoped plugin 和 Codex prompt delivery 说明见 [Skill 管理](docs/setup/skills.md)。

### 实时流式卡片

每轮对话一张实时更新的飞书卡片，是你在手机/飞书上感知并操控 CLI 的主窗口：

- **终端画面实时截图刷新到卡片**（xterm 无头渲染成图，原样还原 CLI 的 TUI）；可一键「显示 / 隐藏输出」「导出文字」「上下翻屏」
- **状态实时指示**：启动中 → 正在分析 → 工作中 / 执行中 → 等待输入；额度用满会标「限额已达 · 可重试」
- **卡片上直接操作**：打开（可写）终端、🔑 取操作链接、重启 / 关闭 / 接管会话、重发上一条任务
- **每轮一张新卡片**，上一轮冻结存档；会话用 `/relay` 搬到别的群后，原卡片自动冻结为存档
- **关闭给「可恢复」卡片**（附 CLI 原生 resume 命令），随时点回来继续

### Web 终端（可交互）

每个会话提供一个 Web 终端，地址为 `http://<WEB_EXTERNAL_HOST>:<端口>`。

- **只读链接** — 展示在群话题的流式卡片上，随时查看进度
- **可操作链接** — 按需获取（点击卡片上的「🔑 获取操作链接」通过私聊发送），可直接在浏览器中操作 CLI
- 移动端/平板提供悬浮快捷键工具栏（Esc、Ctrl+C、Tab、方向键等），手机上也能流畅操作

### 多机器人协作

同一台机器上可运行多个飞书机器人，每个机器人可对应不同的 CLI。同一群聊中通过 @mention 路由消息，仅「你 + 1 个机器人」的 1v1 群无需 @ 自动响应，多人群默认必须 @（可通过「群聊 @ 策略」配置话题内免 @ / 全群免 @）；多机器人时 `@<bot1> @<bot2> /t xxx` 可让每个被 @ 的机器人在同一条消息上各自独立开新话题。先发一次 `@<bot1> @<bot2> /introduce` 让它们互相登记 open_id，之后各 bot 就能在自己的会话里显式 @mention 对方协作（命令详见 [📖 文档 · 斜杠命令](https://deepcoldy.github.io/botmux/slash-commands)）。

### 多话题协作模式

「多机器人协作」的升级版：主 bot（**编排者**）把一个大任务拆成多个**子项目**，在群里**自动开多条话题**，每条话题派一组 bot 并行推进（常见「一个写代码 + 一个 review」），用一张**飞书任务清单**当所有人共享的进度板，最后由主 bot 收齐汇总。一个普通群就是一个并行工作台，你在飞书任务面板一眼看完成度。

**怎么跑** —— `botmux-orchestrate` skill 教编排者走完整流程：

> 拆子项目 → 提一版「子项目 ↔ bot」分配 → 发给你**一次审批**（可用卡片确认） → 建飞书任务清单 → 逐个开话题派活 → 收齐回报 → 汇总

底层派活靠 `botmux dispatch`：在群里种一条话题、把指定 bot @ 进去各起独立会话。

```bash
botmux dispatch --title "实现登录模块" \
  --bot "ou_xxx:Alice:coder" --bot "ou_yyy:Bob:reviewer" \
  --repo /path/to/repo --brief-file /tmp/brief.md
```

- `--repo <目录>` —— 预设子 bot 的工作目录（绝对路径，需在子 bot 所在机器上存在），起会话直接进去、**免手点「选仓库」卡**。
- `--standby` —— **必须配 `--repo`**（且不能与 `--into` 同用）：只发一次 `/repo` 把 bot 拉起到指定目录待命、不派简报，之后用 `--into ... --brief(-file)` 激活派活。
- `--into <话题root>` —— 回到已有话题追加一条（激活待命的 bot / 追加协调）；仍需 `--bot`，且非 standby 时必须带 `--brief` 或 `--brief-file`。

**协作边界**：

- **同部署的「自家」bot 之间互信** —— 编排者能直接对它们跑 `/repo` 等 operate 级命令（与自家 bot 的对话权限一致）。外部 bot 的授权分两层：`/grant @bot` 只给「对话 / 被 chat-scope 拉起」的权限（talk-only，不碰 `allowedUsers`、跑不了 operate 级命令）；要让外部 bot 跑 `/repo` 等 operate 级命令，需把它列进 `allowedUsers`（或后续 operate 级授权）。`/introduce` 只负责发现 / 登记 open_id，**不授予任何权限**。
- 子 bot 须已在群里、可被 @（具备 `im:message.group_at_msg.include_bot` 权限）。
- 一条话题可放多个 bot，它们在话题内互相 @ 协作（如 coder 写完 @ reviewer 审）。

### Tmux 会话常驻

安装 tmux 后自动启用。CLI 进程常驻在 tmux session 内，所有功能不受影响。

**核心收益：Daemon 重启不中断 CLI。** `botmux restart` 时 worker 进程退出，但 tmux session（及其中的 CLI 进程）保持运行。下次收到消息时 worker 自动 re-attach，无需 `--resume` 重载上下文。

| 事件 | tmux session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach） |
| `/close` 或关闭按钮 | 销毁 | 终止（SIGHUP） |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（自动重启用新 session） |

```bash
# 交互式会话列表 — 选择后直接 attach 到 tmux（见 § CLI 命令）
botmux list

# 也可以手动 attach（会话名 = bmx-<sessionId 前 8 位>）
tmux attach -t bmx-<session-id-前8位>
# Ctrl+B, D 退出 attach，不影响 CLI 继续运行

# 强制降级到纯 pty 模式（不使用 tmux）
BACKEND_TYPE=pty botmux start
```

### 会话接入（Adopt）

将已在 tmux 中运行的 CLI 进程无缝接入 Botmux，在手机上通过飞书查看进度和交互。

```
/adopt              # 弹出选择卡片：① 接管运行中的会话 ② 从磁盘 resume 导入历史会话
/adopt 0:2.0        # 直接接入指定 tmux pane（或传历史会话 id 直接 resume 导入）
```

- **历史会话导入** — 卡片第二栏列出本机该 CLI 的历史会话（claude-code / seed / codex / traex / antigravity / genius），选中即以 `--resume` 在原工作目录重建为标准 Botmux 会话，无需进程仍在运行、也不用先迁进 tmux
- **共享模式** — Botmux 接入后，iTerm2 和飞书双向同步：流式卡片实时显示终端输出，飞书聊天框输入直接透传到终端
- **一键接管** — 点击流式卡片上的「🔄 接管」按钮，Botmux 以 `--resume` 重建会话，转为标准 Botmux 会话
- **安全断开** — 点击「⏏ 断开」，Botmux 退出观察，原 CLI 不受影响

### 定时任务

支持三种调度类型 + 中文自然语言，支持原话题延续（到点在同一话题内继续，不另开 thread）。

**两种创建方式**：
- **斜杠命令**（快捷）：`/schedule 每日17:50 帮我看看AI圈有什么新闻`
- **对话触发**（灵活）：直接跟 agent 说「帮我加个每天 18:00 检查部署的定时任务」，自动触发 `botmux-schedule` Skill

支持的调度格式：
- 中文自然语言：`每日17:50` / `每周一10:00` / `30分钟后` / `明天9:00`
- 英文 duration/interval：`30m` / `2h` / `every 30m` / `every 2h`
- Cron 表达式：`0 9 * * *`
- ISO 时间戳：`2026-05-01T10:00`

### 与飞书话题的交互（Skill + CLI）

CLI 进入 botmux 会话时自动获得 `~/.botmux/bin` 在 PATH 中，以及一组开箱即用的 Skill：

- `botmux send` — 向当前话题发消息（支持文本、图片、文件、interactive 卡片 JSON、@mention）
- `botmux history` — 读取当前会话历史消息（话题/thread 会话拉话题内，普通群 chat-scope 会话拉整群）
- `botmux quoted <message_id>` — 用户用引用 UI @ 机器人时，按需读取被引用的那条消息
- `botmux bots list` — 查询当前群聊的机器人及 open_id
- `botmux schedule` — 增删改查定时任务
- `botmux-workflow` — 用自然语言或 `/workflow` 编排有界多步任务；成功 run 可保存为 Saved Workflow 并复用

这些能力通过 `--append-system-prompt` 注入和 Skill 描述自动引导 agent 使用。Skill + CLI 的组合相比 Anthropic 官方 Telegram channel 那套 MCP 方案：CLI 启动不用做 MCP 握手、不占用工具列表 token，且对 Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity / GitHub Copilot 通用 —— 只要 CLI 能读 system prompt 跑 shell 命令就行，不依赖任何 MCP 协议支持。

### Dashboard 管控面

> 命令行 `botmux dashboard` 出一次性 token URL，浏览器里跨所有 daemon/机器人管控

- 一键定位回飞书话题 / 跳 Web 终端 / 多选批量关闭会话
- 添加机器人对齐 Feishu 单次扫码主路径：名称可选且全程冻结，支持 AI CLI / 工作目录选择、管理员 fail-closed 补填与显式兼容模式
- 拉新群、自动转让群主、@ 提醒
- 解散群聊、bot 退群（关联会话自动清理）
- **会话洞察**（owner-only，只读）：解析各会话 transcript，看动作 span / 工作时序 / 上下文曲线 / 失败聚合 + 诊断建议；聊天里发 `/insight` 可取当前会话摘要卡
- **Workflows 管控面**：
  - v3 Run List 与 Run Detail 展示 DAG、节点状态、决策记录和 attempt 终端日志，到 terminal 自动停轮询
  - **Dashboard 内可直接 cancel v3 run**；humanGate / retry / grant 继续通过绑定话题里的可信飞书卡片处理
  - 新流程统一在飞书用自然语言或 `/workflow` 创建、运行、保存和复用；v2 Dashboard/Catalog 已下线

<img src="docs/dashboard.png" alt="botmux dashboard" width="800" />

---

## 前置要求

- **Node.js** >= 22
- **AI 编程 CLI / 本地 Agent 应用** 已安装并完成认证（`claude`、`codex`、`coco`、`cursor-agent`、`gemini`、`genius`、`opencode`、`hermes`、`seed`（Seed CLI，Claude Code 衍生）、`relay`（Relay CLI，Seed 新版）、`pi`、`omp`（oh-my-pi，Pi 衍生）、`copilot`（GitHub Copilot CLI）、`traex`（TRAE CLI）、`mircli`（Mir CLI）、`agy`（Antigravity）、`kimi`（Kimi Code）、`grok`（Grok Build）或 `kiro-cli`（Kiro）在 PATH 中）
  - **CoCo 最低版本 `0.120.32`**：type-ahead（会话忙时即可发新消息，由 CoCo 自己的消息队列接住）依赖 0.120.32+ 的行为；更早版本忙时输入可能丢失或串行，请升级后再用
- **tmux** >= 3.x（可选，安装后自动启用会话常驻）
- **CJK 字体**（用于截图渲染中文/emoji）：
  - macOS 自带 PingFang/Hiragino，无需配置
  - Debian/Ubuntu：daemon 启动时若检测到缺字体会后台 `apt-get install fonts-noto-cjk fonts-noto-color-emoji`（需免密 sudo 或以 root 运行；装完重启 daemon 生效）
  - 其他 Linux 发行版请手动安装 Noto CJK + Noto Color Emoji（包名视发行版而定）

## 5 分钟快速接入

> 💡 **TL;DR**：`npm i -g botmux` → `botmux setup`，飞书租户**扫一次码**就能建好一个可用机器人 → `botmux start`。这次扫码拿到的 Web 登录态会连续完成：按 `botmux-N`（可自定义）命名并创建应用、读取 AppID/AppSecret、导入权限、配置重定向 URL、创建并提交发布版本。整个开放平台配置都由 setup 默认完成；加 `--no-open-platform-auto` 可跳过应用创建后的权限/发版自动配置。

### 1. 安装 botmux

```bash
npm install -g botmux
# 或：pnpm add -g botmux
# 或：bun add -g botmux
```

botmux 的手动/定时更新会识别当前全局安装归属，并继续使用同一个 npm、pnpm 或 Bun 安装位置；无法安全识别的安装方式不会自动回退到 npm。

> 要求 **Node.js ≥ 22**，且本地已装好并登录至少一种 AI 编程 CLI（`claude` / `codex` / `cursor-agent` / `gemini` / `opencode` / `coco` / `agy` / `grok` / `kiro-cli` 等在 PATH 中）。推荐顺手装 **tmux**（装了自动启用会话常驻）。

### 2. 创建应用并配置（`botmux setup`）

跑 `botmux setup`，全程交互式选择（↑/↓ 选择、输入即搜索、⏎ 确认、Esc 取消；非交互终端自动回退为序号输入）：

1. **操作**：首次安装直接进入创建流程；已有配置时先选「添加新机器人 / 重新配置 / 编辑现有机器人 / 删除机器人」。
2. **飞书应用来源**：三选一——
   - **一次扫码创建新应用（推荐）**：可填写机器人名称；留空自动使用 `botmux-0`、`botmux-1`……。首次扫码拿到 Web 登录态后，botmux 自动上传默认图标、创建企业自建应用、读取 AppID/AppSecret，并复用同一登录态继续配置权限与发版；后续添加会先显示当前账号与企业供确认，有效期内免扫码。Web 自动创建不可用或使用 Lark 国际版时，可由用户明确选择 `@larksuiteoapi/node-sdk` 兼容模式；兼容模式可能需要额外扫码，且应用名称由平台决定。
   - **选择已有应用**：复用（或扫码获取）飞书 Web 登录态，列出你在开放平台创建过的应用，选中后**自动读取 AppID/AppSecret**——换机器重配、复用旧应用不用再去后台翻 Secret（仅飞书租户）。
   - **手动输入 AppID/Secret**：见文末折叠的「手动创建应用」。
3. **选择 CLI**：选本次要接入的 CLI（可搜索，如输入 `cla` 过滤出 Claude）。
4. **新话题工作目录**：二选一——
   - **固定默认目录（推荐）**：新话题直接在指定目录启动、**不弹卡片**（落 `defaultWorkingDir` 字段，之后可用 `/config` 或 `botmux setup edit` 修改）。想让机器人"直接进目录干活"选这个。
   - **仓库选择卡片**：新话题先弹卡片，从扫描到的 git 仓库里选一个再启动，适合经常在多个仓库间切换。下一问填**仓库扫描根目录**，通常是 git 项目的**父级目录**（如 `~/projects`，支持逗号分隔多个），卡片从该目录**向下**查找 git 仓库（最多 3 层）；尽量别填 `~`（要遍历太多文件夹）。

应用创建后会直接复用同一份 Web 登录态，自动导入权限、配置 `http://127.0.0.1:9768/callback` 重定向 URL、创建并提交发布版本。Feishu 主路径是**首次最多扫码一次、后续有效期内免扫**；缓存账号/企业会在创建前展示并用同一份 cookie 再次比对，登录态失效时先提示，不会静默弹码。只有用户主动「更换账号」或明确选择 SDK 兼容模式时才会重新扫码。

> ✅ **飞书 (feishu.cn) 与 Lark 国际版 (larksuite.com) 均支持**。飞书走单次 Web 扫码；用户明确选择 SDK 兼容模式后，会自动识别并记住 Lark 国际版租户。手动粘 AppID/Secret 时会让你选一次租户类型。每个机器人按所属版本独立连对应域名，同一台机器可同时跑飞书 + Lark 机器人，登录凭证按应用隔离、互不干扰。

setup 末尾会用 `tenant_access_token` 校验凭证（通过才落盘 `bots.json`），并把完整权限 JSON 写到 `~/.botmux/lark-scopes.json` 备查。

<details>
<summary><b>脚本化（非 TUI）setup</b> —— 给 coding agent / 自动化脚本用的字段级子命令，不依赖交互问答顺序</summary>

```bash
botmux setup list --json                     # 列出机器人（secret 脱敏）
botmux setup add --create-app \
  --app-name 研发助手 \
  --allowed-users alice@example.com          # 首次扫码；后续有效登录态下免扫
botmux setup add --create-app --switch-account \
  --allowed-users alice@example.com          # 明确更换账号并覆盖本机登录态
botmux setup configure botmux-1              # partial 后重跑开放平台配置并上线
botmux setup add \
  --app-id cli_xxx --app-secret xxx \
  --allowed-users alice@example.com \
  --cli codex --working-dir ~/projects       # 添加（写盘前照样校验凭证）
botmux setup edit botmux-0 --cli claude-code \
  --default-working-dir /data/proj           # 按字段修改；值传 - 清空
botmux setup remove botmux-1 --yes           # 非交互删除必须 --yes
botmux setup help                            # 完整 flag 列表
```

- `--working-dir` 是仓库选择卡片的扫描根；`--default-working-dir` 是固定默认目录（新话题直接启动、不弹卡），对应 TUI 里工作目录模式的两个选项。
- `--create-app` 默认先复用并在 stderr 显示已确认的账号/企业；无缓存时首次扫码。`--switch-account` 强制重新扫码并覆盖本机登录态。`--json` 不会在缺少有效缓存时自行弹码，需显式加 `--switch-account`。
- 成功 JSON 会把 `openPlatform.status` 明确标成 `ready` / `ready_with_warnings` / `manual` / `skipped`。应用和本地配置已创建、但 Feishu 权限/事件/回调等关键配置失败时，命令返回非零退出码与 `partial: true`，不会自动启动新 Bot，并给出可继续执行的 `botmux setup configure <bot>` 命令；会话失效时命令自动带 `--switch-account`，Lark 手工配置则不会给出无效的循环重试。partial Bot 仍保留在 `bots.json` 以便重试，整组 `botmux start/restart` 仍会启动它，建议先 configure 成功再重启 fleet。
- 已有凭证模式的开放平台自动配置默认跳过，需要时显式加 `--open-platform-auto`。`--compatibility-mode` 必须显式选择，可能需要额外扫码且不支持 `--app-name`。
- 以前对交互问答「管道喂数字」的脚本请迁移到这些子命令：问答序列一变（本版本就新增了工作目录模式一问），喂数字会静默错位。

</details>

### 3. 启动

```bash
botmux start
```

> start 前再校验一次凭证；权限未配齐不会阻塞 daemon，只 WARN。如果之后需要确认事件订阅，飞书后台会要求 daemon 已在跑才能识别长连接。

### 4. 建群开聊

1. 飞书中创建一个**话题群**
2. 进入群设置 → 群机器人 → 添加刚创建的机器人
3. 在群里发消息，机器人自动响应

![添加机器人到群](docs/setup/add-bot-to-group.png)

### 5. 开机自启（推荐）

确认机器人能正常收发消息之后，跑一次：

```bash
botmux autostart enable
```

<details>
<summary><b>手动配置开放平台：建应用 / 权限 / 重定向 / 发版（备用）</b> —— 默认由 botmux setup 使用同一次登录态自动完成，仅在自动配置失败、或想手动核对时展开</summary>

<br>

**手动创建应用**：去 [飞书开放平台](https://open.larkoffice.com/app) 建「企业自建应用」，在「凭证与基础信息」复制 **App ID / App Secret**，在 `botmux setup` 的「飞书应用来源」步骤选「手动输入 AppID/Secret」粘贴回来。

![创建应用](docs/setup/create-app.png)

**添加权限**：按 terminal 提示的一键复制命令把权限 JSON 复制到剪贴板，进入「权限管理」→「批量导入/导出权限」粘贴 → 提交审批。可用性范围选「仅自己可见」会自动通过：

![权限管理](docs/setup/permissions.png)

完整 JSON 已经写到 `~/.botmux/lark-scopes.json`，源仓库版本在 [src/setup/lark-scopes.json](src/setup/lark-scopes.json)（与本仓库内部 wiki 文档同步，覆盖 tenant + user 双套域 ≈ 290 项）。

```bash
# macOS 本地
cat ~/.botmux/lark-scopes.json | pbcopy
# Linux 桌面 (本地有 X 服务器)
cat ~/.botmux/lark-scopes.json | xclip -selection clipboard
# SSH / 无 DISPLAY：直接 cat, 在本地 terminal 鼠标选中即写本地剪贴板
cat ~/.botmux/lark-scopes.json
# SSH 上 OSC 52 直接写本地剪贴板 (iTerm2 / kitty / WezTerm / Alacritty / tmux 1.5+)
base64 -w0 < ~/.botmux/lark-scopes.json | awk 'BEGIN{printf "\033]52;c;"}{printf "%s",$0}END{printf "\a"}'
```

**添加重定向 URL（按需）**：如果之后要在飞书里 `/login` 让 botmux 以你的身份调云文档/日历/Wiki 等 API，进入「安全设置」→「重定向 URL」填入 `http://127.0.0.1:9768/callback`。只用 bot 收发消息的话这一步可以跳过。

**发版**：进入「版本管理与发布」，点击「创建版本」并发布。可用性范围选择「仅自己可见」即可自动通过审核。

![发版](docs/setup/publish.png)

</details>

<details>
<summary><b>机器人收不到消息时的自查</b></summary>

<br>

botmux 会自动开启机器人能力、长连接事件模式并订阅基础事件，正常情况下不用动。如果按上面步骤走完 bot **完全收不到任何消息**（连私聊都不回），分别确认这两项：

- **事件订阅**：开放平台 → 你的应用 → 事件与回调 → 应当订阅 `im.message.receive_v1` + `card.action.trigger`（默认已订阅，如缺失就手动添加）。订阅方式必须是「使用长连接接收事件」(WebSocket)，且 botmux daemon 已经在跑。
- **机器人能力**：开放平台 → 你的应用 → 应用功能 → 机器人 应当已开通（默认开通），名字/头像可以改。

确认后重启 daemon：`botmux restart`。

</details>

---

## 使用指南

### 使用流程

1. 在飞书话题群中发送消息创建新话题；或在普通群中发 `/t <prompt>` 主动开新话题；也可在 Dashboard 为单个 bot 开启普通群回复开话题
2. 机器人弹出仓库选择卡片 — 选择项目或点击「直接开启会话」（被 `/oncall bind` 绑过的 bot 会跳过此步；绑定按 bot 计）
3. CLI 在所选目录下启动
4. 话题中出现实时流式卡片，展示终端输出并支持 Markdown 渲染
5. 每次回复创建新的流式卡片，上一轮卡片冻结在最后状态
6. 点击卡片上的「🔑 获取操作链接」通过私聊获取可写终端链接
7. CLI 通过 `botmux send` 命令在话题中回复（由 `botmux-send` Skill 自动引导）

---

### 多步 Workflow（v3）

- 直接用自然语言说“调研三家竞品并出报告”“把 A/B/C 串起来自动做”，bot 会先轻确认是否切换到 Workflow，再澄清、编排并执行有界 DAG。
- 明确要编排时可发 `/workflow <目标>`；查看/取消 run 用 `/workflow list|show|cancel`。
- 成功 run 可用 `/workflow save last 周报` 固化；之后 `/workflow run 周报 region=sg` 复用，缺少的必填参数会单独补问。
- v2 runtime 已下线。旧定义与历史 run 只保留 `botmux template migrate-v3` / `archive-runs` 离线迁移归档入口。

---

### Bot 级环境变量（接入 GLM / 第三方服务商）

每个 `bots.json` 条目都可以配置独立的 `env` 对象，注入到**该 bot 的 CLI 进程**。典型用途：让某个 bot 跑 GLM Coding Plan / 第三方 Anthropic·OpenAI 兼容服务商，另一个 bot 仍跑官方 Claude——只需给前者填上服务商的端点和 key：

```json
{
  "cliId": "claude-code",
  "workingDir": "~/projects",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM Coding Plan key"
  }
}
```

> GLM 国内站把 `ANTHROPIC_BASE_URL` 换成 `https://open.bigmodel.cn/api/anthropic`。给 Codex 这类 OpenAI 协议 CLI 接入时，填 `OPENAI_BASE_URL` / `OPENAI_API_KEY`（指向服务商的 OpenAI 兼容端点）而非 `ANTHROPIC_*`。也可用于设 `HTTPS_PROXY`、CLI 专属开关等。

要点：

- `env` 只接受合法环境变量名，值支持字符串、数字、布尔值；`BOTMUX_` / `LARK_APP_` 等 botmux 保留键会被忽略（防止串改会话路由/凭证）。
- 按**会话**注入到 CLI 进程（下个新会话起效）。tmux/zellij 后端经每个 pane 的 `/usr/bin/env` 注入，**不写入共享 server 全局 env**，所以一个 bot 的服务商配置不会串到别的 bot。
- 也可在 dashboard 的「机器人默认设置 → 环境变量」里填写（owner 鉴权），或用 `/config set env '{...}'`。
- 不要把它当成安全密钥库：值以明文存在 `bots.json` 与进程环境中，可能被本机诊断工具看到。

---

## 📖 完整文档

命令、配置、最佳实践、排错的完整内容都在文档站，这里不再重复 ——

### 👉 https://deepcoldy.github.io/botmux/

| 主题 | 文档 |
|------|------|
| 斜杠命令 / CLI 命令 / 会话内子命令 | [命令参考](https://deepcoldy.github.io/botmux/slash-commands) |
| `bots.json` 字段 / 环境变量 / 文件位置 | [配置参考](https://deepcoldy.github.io/botmux/bots-json) |
| 多 CLI 适配器（含 wrapper / 网关接入） | [适配器](https://deepcoldy.github.io/botmux/adapters) |
| 按场景的最佳实践（Oncall / 报警运维 / 个人研发 / 多人协作） | [最佳实践](https://deepcoldy.github.io/botmux/best-practices) |
| 常见踩坑 / FAQ 排错 | [踩坑](https://deepcoldy.github.io/botmux/pitfalls) · [FAQ](https://deepcoldy.github.io/botmux/faq) |
| 功能详解：定时任务 / Oncall / Dashboard / 多机器人协作 / 会话接力 | [定时](https://deepcoldy.github.io/botmux/schedule) · [Oncall](https://deepcoldy.github.io/botmux/oncall) · [Dashboard](https://deepcoldy.github.io/botmux/dashboard) · [多 bot](https://deepcoldy.github.io/botmux/multi-bot) · [接力](https://deepcoldy.github.io/botmux/relay) |

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
