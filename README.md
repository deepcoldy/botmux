# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20">
  <a href="https://www.npmjs.com/package/botmux"><img src="https://img.shields.io/npm/v/botmux.svg" alt="npm version"></a>
  <a href="https://github.com/deepcoldy/botmux"><img src="https://img.shields.io/github/stars/deepcoldy/botmux.svg?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#设计理念">设计理念</a> · <a href="#核心优势">核心优势</a> · <a href="#5-分钟快速接入">快速接入</a> · <a href="#使用指南">使用指南</a> · <a href="#配置">配置</a>
</p>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

---

**飞书话题群 + AI 编程 CLI，一条消息启动编程会话。** Daemon 监听飞书消息，为每个新话题自动启动独立 CLI 进程（Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity），提供实时流式卡片和可交互 Web 终端。

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

botmux 不重新实现 Agent 能力，而是直接桥接已有的 AI 编程 CLI（Claude Code、Codex、Cursor、Gemini、OpenCode、Antigravity）。记忆、上下文管理、工具调用、权限体系——这些能力 CLI 本身都在快速迭代，botmux 选择站在这个进化之上，而不是平行重造一套。CLI 的每次升级，botmux 零适配自动受益。

### 核心优势

与 OpenClaw 等基于 Agent SDK 构建的方案相比：

| 特性 | botmux | OpenClaw 类方案 |
|------|--------|----------------|
| 底层架构 | 直接桥接完整 CLI 进程 | 基于 Agent SDK 重新构建 |
| CLI 能力 | 完整运行时（hooks、memory、plan mode、Skill、`/` 命令） | SDK API 子集，需手动实现缺失功能 |
| CLI 升级 | 零适配自动受益 | 需要跟进 SDK 版本变更 |
| 记忆 / 上下文 | 直接复用 CLI 内建的记忆系统，随 CLI 迭代自动增强 | 需自建记忆系统，与 CLI 原生能力重复 |
| 多 CLI 支持 | 6 种 CLI 一键切换（Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity） | 绑定单一 SDK，无法切换 CLI |
| Web 终端 | 可交互的完整终端，移动端快捷键工具栏，手机/电脑/飞书三端同步 | 通常仅 Web 聊天界面或只读输出 |
| 多机器人协作 | 多 bot 同群 @mention 路由，独立进程隔离，不同 CLI 赛博斗蛐蛐 | 通常单机器人 |
| 终端直连 | tmux attach 直接进入 CLI 进程，和本地开发体验一致 | 无法直接操作底层终端 |
| 安装部署 | `npm install -g botmux`，5 分钟飞书配置即可使用 | 安装简单，但配置项较多 |

---

## 功能特性

### 实时流式卡片

每轮对话生成一个实时更新的飞书卡片：

- 终端输出实时渲染为 Markdown，自动过滤 TUI 装饰，仅展示实际工作输出
- 状态指示：🟡 启动中 → 🔵 工作中 → 🟢 就绪
- 操作按钮：打开终端、获取操作链接、重启 CLI、关闭会话
- 每次回复创建新的流式卡片，上一轮卡片冻结在最后状态

### Web 终端（可交互）

每个会话提供一个 Web 终端，地址为 `http://<WEB_EXTERNAL_HOST>:<端口>`。

- **只读链接** — 展示在群话题的流式卡片上，随时查看进度
- **可操作链接** — 按需获取（点击卡片上的「🔑 获取操作链接」通过私聊发送），可直接在浏览器中操作 CLI
- 移动端/平板提供悬浮快捷键工具栏（Esc、Ctrl+C、Tab、方向键等），手机上也能流畅操作

### 多机器人协作

同一台机器上可运行多个飞书机器人，每个机器人可对应不同的 CLI。同一群聊中通过 @mention 路由消息，仅有一个机器人时无需 @ 自动响应；多机器人时 `@<bot1> @<bot2> /t xxx` 可让每个被 @ 的机器人在同一条消息上各自独立开新话题。先发一次 `@<bot1> @<bot2> /introduce` 让它们互相登记 open_id，之后各 bot 就能在自己的会话里显式 @mention 对方协作（见 [§ 斜杠命令](#斜杠命令)）。

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
/adopt              # 扫描 tmux，弹出选择卡片
/adopt 0:2.0        # 直接接入指定 tmux pane
```

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

- `botmux send` — 向当前话题发消息（支持文本、图片、文件、@mention）
- `botmux history` — 读取当前会话历史消息（话题群拉话题内、普通群拉整群）
- `botmux quoted <message_id>` — 用户用引用 UI @ 机器人时，按需读取被引用的那条消息
- `botmux bots list` — 查询当前群聊的机器人及 open_id
- `botmux schedule` — 增删改查定时任务

这些能力通过 `--append-system-prompt` 注入和 Skill 描述自动引导 agent 使用。Skill + CLI 的组合相比 Anthropic 官方 Telegram channel 那套 MCP 方案：CLI 启动不用做 MCP 握手、不占用工具列表 token，且对 Claude Code / Codex / Cursor / Gemini / OpenCode / Antigravity 通用 —— 只要 CLI 能读 system prompt 跑 shell 命令就行，不依赖任何 MCP 协议支持。

### Dashboard 管控面

> 命令行 `botmux dashboard` 出一次性 token URL，浏览器里跨所有 daemon/机器人管控

- 一键定位回飞书话题 / 跳 Web 终端 / 多选批量关闭会话
- 拉新群、自动转让群主、@ 提醒
- 解散群聊、bot 退群（关联会话自动清理）
- **Workflows 管控面**：
  - Run List 5s 轮询；Run Detail 看 summary / dangling 红区 / node-activity 表 / event timeline / **并发执行 timeline**（attempt 级时序），到 terminal 自动停轮询
  - **Dashboard 内可直接 cancel run**、批准/拒绝 humanGate（approve/reject + 评论）
  - **Workflow Catalog**：列所有 `~/.botmux/workflows/` 下的 workflow，点进去看 schema / 依赖图，直接在 UI 触发 run（带 params 输入）
  - IM 卡片（cancel / approve / reject）仍可用；CLI 子命令也保留

<img src="docs/dashboard.png" alt="botmux dashboard" width="800" />

---

## 前置要求

- **Node.js** >= 20
- **AI 编程 CLI / 本地 Agent 应用** 已安装并完成认证（`claude`、`codex`、`coco`、`cursor-agent`、`gemini`、`opencode`、`hermes` 或 `agy`（Antigravity）在 PATH 中）
  - **CoCo 最低版本 `0.120.32`**：type-ahead（会话忙时即可发新消息，由 CoCo 自己的消息队列接住）依赖 0.120.32+ 的行为；更早版本忙时输入可能丢失或串行，请升级后再用
- **tmux** >= 3.x（可选，安装后自动启用会话常驻）
- **CJK 字体**（用于截图渲染中文/emoji）：
  - macOS 自带 PingFang/Hiragino，无需配置
  - Debian/Ubuntu：daemon 启动时若检测到缺字体会后台 `apt-get install fonts-noto-cjk fonts-noto-color-emoji`（需免密 sudo 或以 root 运行；装完重启 daemon 生效）
  - 其他 Linux 发行版请手动安装 Noto CJK + Noto Color Emoji（包名视发行版而定）

## 5 分钟快速接入

> 💡 **TL;DR**：跑 `botmux setup` 选「扫码建应用」一步完成 Step 1+2（拿 AppID/AppSecret）。PersonalAgent 应用建出来时事件订阅和 bot 能力都已默认配好，只剩 Step 4 权限申请 + Step 5（按需）重定向 URL + Step 6 发版三步要在浏览器手动点；setup 完成后会自动写 JSON 文件 + 打印一键复制命令 + 各步骤的深链。

### Step 1: 创建飞书应用

**推荐路径**：`botmux setup` 选「1) 扫码建应用」，飞书扫码完成后自动落盘 AppID/AppSecret，无需手动浏览器创建。底层走 `@larksuiteoapi/node-sdk` 的官方 device flow。

> ⚠️ **目前仅支持飞书 (feishu.cn) 租户**。扫码检测到 Lark 国际版 (larksuite.com) 会中止 setup —— daemon runtime (Lark Client/WSClient/event-dispatcher 等) 需要一并接入 lark 域，会在单独 PR 跟进。

**手动路径**：打开 [飞书开放平台](https://open.larkoffice.com/app)，点击「创建企业自建应用」。

![创建应用](docs/setup/create-app.png)

### Step 2: 获取凭证

> 扫码路径自动完成此步，可直接跳到 Step 3。

进入应用详情 →「凭证与基础信息」，复制 **App ID** 和 **App Secret**。

![获取凭证](docs/setup/credentials.png)

### Step 3: 安装 & 启动 botmux

```bash
# 安装
npm install -g botmux

# 交互式配置 — 选「1) 扫码建应用」或「2) 手动粘 AppID/Secret」
# 凭证拿到后自动取一次 tenant_access_token 校验，通过才落盘 bots.json
# setup 末尾会把完整权限 JSON 写到 ~/.botmux/lark-scopes.json 并打印一键复制命令
botmux setup

# 启动（如果之后需要确认事件订阅，飞书后台会要求 daemon 已在跑才能识别长连接）
# start 前再校验一次凭证；权限未配齐不会阻塞 daemon，只 WARN
botmux start
```

### Step 4: 添加权限

setup 完成后，按 terminal 提示的一键复制命令把权限 JSON 复制到剪贴板，进入「权限管理」→「批量导入/导出权限」粘贴 → 提交审批。可用性范围选「仅自己可见」会自动通过：

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

> 扫码建出来的 PersonalAgent 应用，botmux 维护者实测默认已订阅 `im.message.receive_v1` + `card.action.trigger` 并开通 bot 能力，所以主线流程不再要求手动配。但飞书没在公开文档里承诺这是稳定行为，**如果配好后机器人完全收不到消息**，参见下方「Step 8: 机器人收不到消息时的自查」。

### Step 5: 添加重定向 URL（按需）

如果之后要在飞书里 `/login` 让 botmux 以你的身份调云文档/日历/Wiki 等 API，进入「安全设置」→「重定向 URL」填入：

```
http://127.0.0.1:9768/callback
```

只用 bot 收发消息的话这一步可以跳过。

### Step 6: 发版

进入「版本管理与发布」，点击「创建版本」并发布。可用性范围选择「仅自己可见」即可自动通过审核。

![发版](docs/setup/publish.png)

### Step 7: 建群开聊

1. 飞书中创建一个**话题群**
2. 进入群设置 → 群机器人 → 添加刚创建的机器人
3. 在群里发消息，机器人自动响应

![添加机器人到群](docs/setup/add-bot-to-group.png)

### Step 8: 机器人收不到消息时的自查（fallback）

PersonalAgent 默认配好事件订阅 + bot 能力，正常情况下不用动。如果按上面步骤走完 bot **完全收不到任何消息**（连私聊都不回），分别确认这两项：

- **事件订阅**：开放平台 → 你的应用 → 事件与回调 → 应当订阅 `im.message.receive_v1` + `card.action.trigger`（默认已订阅，如缺失就手动添加）。订阅方式必须是「使用长连接接收事件」(WebSocket)，且 botmux daemon 已经在跑。
- **机器人能力**：开放平台 → 你的应用 → 应用功能 → 机器人 应当已开通（默认开通），名字/头像可以改。

确认后重启 daemon：`botmux restart`。

### Step 9: 开机自启（推荐）

确认机器人能正常收发消息之后，跑一次：

```bash
botmux autostart enable
```

把 daemon 注册到当前用户的 init 系统（macOS launchd / Linux user systemd），**不需要 sudo**。重启机器自动起来。详见下方 [CLI 命令 § 开机自启](#开机自启)。

---

## 使用指南

### 使用流程

1. 在飞书话题群中发送消息创建新话题；或在普通群中发 `/t <prompt>` 主动开新话题
2. 机器人弹出仓库选择卡片 — 选择项目或点击「直接开启会话」（`/oncall bind` 过的群会跳过此步）
3. CLI 在所选目录下启动
4. 话题中出现实时流式卡片，展示终端输出并支持 Markdown 渲染
5. 每次回复创建新的流式卡片，上一轮卡片冻结在最后状态
6. 点击卡片上的「🔑 获取操作链接」通过私聊获取可写终端链接
7. CLI 通过 `botmux send` 命令在话题中回复（由 `botmux-send` Skill 自动引导）

### 斜杠命令

在话题里直接发这些命令即可，由 daemon 拦截处理（与底层 CLI 自身的 slash 命令互不冲突——botmux 不认识的 `/xxx` 会原样透传给 CLI）。随时发 `/help` 可在话题内查看同一份清单。

**📌 会话管理**

| 命令 | 说明 |
|------|------|
| `/repo` | 仓库待选时直接用默认 workingDir 启动会话；会话进行中则弹出项目选择卡片（交互式下拉 + 文本列表） |
| `/repo <N>` | 切换到上次扫描的第 N 个项目 |
| `/repo <路径\|项目名>` | 跳过选择卡片，直接指定路径（相对/绝对）或 workingDir 下的一级项目名 |
| `/cd <路径>` | 切换工作目录并重启 CLI 进程 |
| `/status` | 查看会话信息（运行时间、终端地址等） |
| `/restart` | 重启 CLI 进程（保留 session 上下文） |
| `/close` | 关闭会话并发送可恢复卡片（含 CLI 自身 resume 命令） |
| `/t <prompt>` / `/topic <prompt>` | 普通群内强制开新话题（弹仓库选择卡片）；prompt 留空时也可在选完仓库后再补 |

**🔀 透传给底层 CLI**

| 命令 | 说明 |
|------|------|
| `/compact` `/model` `/clear` `/plugin` `/usage` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` | 字面送达底层 CLI，交给它的内置 slash 命令处理（例如 Claude Code 的 `/compact`、`/context`，Codex 的 `/diff`、`/btw`） |

**⏰ 定时任务**（语法与示例详见 [§ 定时任务管理](#定时任务管理)）

| 命令 | 说明 |
|------|------|
| `/schedule <自然语言/cron>` | 创建定时任务，如 `/schedule 每日17:50 看AI新闻` |
| `/schedule list` | 查看所有定时任务 |
| `/schedule remove\|enable\|disable\|run <id>` | 删除 / 启用 / 禁用 / 立即执行一次 |

**📡 会话接入**

| 命令 | 说明 |
|------|------|
| `/adopt` | 扫描本机 tmux，弹卡片选择要接入的已运行 CLI 会话 |
| `/adopt <tmux_pane>` | 直接接入指定 tmux pane（如 `/adopt 0:2.0`） |

**🔐 用户授权**

| 命令 | 说明 |
|------|------|
| `/login` | 飞书用户授权，授权后可下载第三方卡片图片、以你的身份调云文档/日历等 API |
| `/login status` | 查看当前授权状态 |

**🛎️ Oncall 模式（群聊）**

| 命令 | 说明 |
|------|------|
| `/oncall bind <path>` | 将当前群绑定到项目目录，跳过仓库选择卡片（群内任何成员可 @ 提问，按钮/命令仍走 `allowedUsers`） |
| `/oncall unbind` | 解绑当前群 |
| `/oncall status` | 查看当前群的 oncall 绑定 |

**🔑 使用授权（owner 专用）**

| 命令 | 说明 |
|------|------|
| `@机器人 /grant @某人` | 弹授权卡片，把对方加进「本群使用」或「全局」白名单；无权限者 @ 机器人时也会自动弹这张卡并 @owner |
| `@机器人 /revoke @某人` | 撤销对方的本群 + 全局授权 |

**🆕 一键新建会话群**

| 命令 | 说明 |
|------|------|
| `/group <群名>` (别名 `/g`) | 自动新建一个飞书群、邀请你进群、转让群主，整个群作为一个独立 CLI 会话（chat-scope）。空群名时用时间戳兜底。建好后**不自动开会话**——进群直接找机器人开聊即可。命令里 @ 的机器人会被一并拉进新群（由第一个被 @ 的机器人负责建群）。 |

**👥 多机器人协作**

| 命令 | 说明 |
|------|------|
| `@botA @botB /t <prompt>` | 多机器人时，让每个被 @ 的机器人在同一条消息上各自独立开新话题 |
| `@botA @botB /introduce` | 互相登记彼此的 open_id，便于后续跨 bot 显式 @mention 协作（@ 顺序任意，可带额外文本） |

**❓ 帮助**

| 命令 | 说明 |
|------|------|
| `/help` | 在话题内显示以上完整命令清单 |

### 定时任务管理

两种创建方式见上方「[定时任务](#定时任务)」小节，下面只列斜杠命令的语法和管理命令。

```bash
# 中文自然语言
/schedule 每日17:50 帮我看看AI圈有什么新闻
/schedule 工作日每天9:00 检查服务状态
/schedule 每周一10:00 生成周报

# 一次性任务
/schedule 30分钟后 检查部署状态
/schedule 明天9:00 发早会提醒

# 英文 / cron
/schedule every 2h 巡检服务
/schedule 30m 提醒我喝水
/schedule 0 9 * * * 早安问候

# 管理任务
/schedule list
/schedule remove|enable|disable|run <id>
```

**任务执行行为**：到点会在**创建任务的原话题**内续一条消息并执行，不会另开 thread。工作目录与创建时一致。如果原话题的会话还活着，prompt 直接注入现有会话（不另起 worker）。

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `botmux setup` | 交互式配置（首次使用 / 添加 / 编辑 / 删除机器人） |
| `botmux start` | 启动 daemon（PM2 管理） |
| `botmux stop` | 停止 daemon |
| `botmux restart` | 重启 daemon（自动恢复活跃会话） |
| `botmux logs` | 查看日志（`--lines N`） |
| `botmux status` | 查看 daemon 状态 |
| `botmux upgrade` | 升级到最新版本 |
| `botmux list` | 列出所有活跃会话（别名 `ls`） |
| `botmux delete <id>` | 关闭指定会话，支持 ID 前缀匹配（别名 `del`/`rm`） |
| `botmux delete all` | 关闭所有活跃会话 |
| `botmux delete stopped` | 清理所有进程已退出的僵尸会话 |
| `botmux autostart enable` | 注册开机自启（macOS launchd / Linux user systemd，无需 sudo） |
| `botmux autostart disable` | 注销开机自启 |
| `botmux autostart status` | 查看自启状态 |
| `botmux dashboard` | 输出一次 Web Dashboard URL（每次刷 token，旧链接立即失效） |

### Workflow 子命令（实验性运维）

`botmux workflow` 把工作流 run 的状态当一等公民暴露出来——查看哪些 run 在跑、读事件流、从崩溃 / awaiting 恢复或取消。所有命令读写 `BOTMUX_WORKFLOW_RUNS_DIR`（默认 `~/.botmux/workflow-runs`），不需要 daemon 在线。

| 命令 | 说明 |
|------|------|
| `botmux workflow run <id> [--param k=v ...]` | 离线驱动 workflow（stub spawn）；humanGate 节点跑到 awaiting-wait 退出 |
| `botmux workflow resume <runId>` | 从磁盘 runDir 冷恢复一个已有 run；R0 recovery 先收 dangling effect，再走 orchestrator |
| `botmux workflow cancel <runId> [--reason <text>]` | 写 run-level cancelRequested 并驱动 cancel recovery；terminal run 直接 no-op |
| `botmux workflow ls [--all] [--status running,failed] [--wide] [--json]` | 列 runsDir 下所有 run；默认仅 non-terminal；`dEf/dAct/dWait` 三列分别是 dangling effects / non-effect activities / waits |
| `botmux workflow tail <runId> [--from N] [--follow] [--json]` | 打印事件简表；默认 history-only，`--follow` 才轮询 events.ndjson 增量 |
| `botmux workflow show <runId>` | replay 当前 run 的事件，打 Snapshot 摘要 JSON |

典型运维流程：

```bash
# 看哪些 run 在跑
botmux workflow ls

# 进一个 run 看事件
botmux workflow tail wf-abc-123

# run 卡住或 daemon 重启过 → 冷恢复
botmux workflow resume wf-abc-123

# 实在跑不动 → 取消
botmux workflow cancel wf-abc-123 --reason '依赖外部超时'
```

完整端到端 dogfood（run → ls → tail → resume → cancel）参见 `scripts/dogfood-o1.sh`，跑在临时 runsDir 里，不碰真实环境。

---

### 开机自启

`botmux autostart enable` 把 daemon 注册到当前用户的 init 系统，重启机器后自动起来：

- **macOS**：写 `~/Library/LaunchAgents/com.botmux.daemon.plist`，用 `launchctl bootstrap` 加载，**不需要 sudo**。
- **Linux**：写 `~/.config/systemd/user/botmux.service`，用 `systemctl --user enable --now` 启用，**不需要 sudo**。
  - 服务器/无桌面环境下，登出会话后 user systemd 默认会停服务。需要跨登出常驻请额外跑 `sudo loginctl enable-linger <你的用户名>`，autostart enable 会在 linger 未启用时提示。
  - 容器或 SSH-only 没有 user DBus 的环境会回退到打印手动指令。
- 单元文件里的 `node` / `cli.js` 路径来自当前 `process.execPath`，nvm/fnm 切版本后跑一次 `botmux autostart enable` 重写即可。`botmux start`/`restart` 也会自动检测路径变化、原地刷新单元文件，无需手动操作。
- `enable` / `disable` **只管开机自启钩子，不动正在跑的 daemon**。需要立即启动跑 `botmux start`，需要停跑 `botmux stop`。这样就不会"我只是想关掉自启，结果服务也被一起干掉了"。
- 想用 systemd 管 daemon 生命周期（`systemctl --user start/stop botmux`）也行——unit 里写了 ExecStop 调用 `botmux stop`，是干净的关停路径。

### 会话内子命令（给 CLI agent 用）

会话内的 agent 可以直接调用这些命令，session 信息通过祖先进程标记自动推断：

| 命令 | 说明 |
|------|------|
| `botmux send [content]` | 向当前话题发消息。支持 stdin / heredoc / `--content-file` 传内容，`--images`/`--files`/`--mention` 附加资源 |
| `botmux bots list` | 列出当前群聊中的机器人（含 open_id，供 `--mention` 使用） |
| `botmux history [--limit N]` | 拉取当前会话的消息历史（JSON）；话题群 → 话题内，普通群 → 整群 |
| `botmux quoted <message_id>` | 拉取被引用的单条消息（JSON），ID 取自 daemon 注入的 `[用户引用了消息 用 botmux quoted om_xxx 查看]` 提示行 |
| `botmux schedule add <schedule> <prompt>` | 创建定时任务（自动绑定当前话题） |
| `botmux schedule list/remove/pause/resume/run` | 管理定时任务 |

这些命令依赖 `~/.botmux/bin/botmux` 这个 wrapper 脚本，daemon 启动时自动写入并加入 worker 的 PATH，版本始终与 daemon 一致（不需要 `npm i -g`）。

---

## Web Dashboard

botmux 启动后会自带一个 Web Dashboard 用来管理所有会话和定时任务。

```bash
botmux dashboard
# 输出: http://<lan-ip>:7891/?t=<token>
```

每次跑 `botmux dashboard` 都会换一个 token，老 URL 立即失效——这是有意为之，符合一次一密的取链方式。

页面功能（v1）：
- **Sessions**：跨所有 bot 列出活跃和已关闭会话，支持按 CLI / 状态 / adopt / 文本搜索过滤。点进 detail drawer 后可以「定位到飞书话题」（机器人在原话题发一条 📍 标记 + 浏览器自动开 chat AppLink，规避飞书没有公开 topic deep-link 的限制）、复制各种 ID、关闭会话。
- **Schedules**：列出所有定时任务，可以 Run now / Pause / Resume。

环境变量（写在 `~/.botmux/.env`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | dashboard HTTP 绑定地址 |
| `BOTMUX_DASHBOARD_PORT` | `7891` | dashboard HTTP 端口 |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` 或 LAN IP 自动探测 | CLI 输出 URL 用的 host |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | 每个 daemon 的 IPC 端口 = base + botIndex |

dashboard 走单独 pm2 进程 `botmux-dashboard`，跟着 `pnpm daemon:restart` 一起起停。每个 daemon 在 127.0.0.1 暴露内部 IPC（仅本机），dashboard 进程做反向代理 + 鉴权。`.dashboard-secret` 在首次启动时生成（`~/.botmux/.dashboard-secret`，mode 0600），仅用于 `botmux dashboard` 命令的 HMAC 鉴权，不下发给浏览器。

---

## 配置

通过 `~/.botmux/bots.json` 配置机器人。运行 `botmux setup` 交互式创建，或手动编辑。

```bash
# 交互式配置
botmux setup
```

已有 `~/.botmux/bots.json` 时，`botmux setup` 支持添加新机器人、重新配置、编辑现有机器人，以及删除机器人配置。编辑或删除时用 `botmux status` 里的进程名（如 `botmux-1` 或自定义的 `botmux-claude-main`）或 `larkAppId` 选择目标；字段留空表示保留当前值，`name`、`model`、`cliPathOverride`、`backendType`、`workingDir`、`allowedUsers` 等可选字段输入 `-` 表示清空。修改 `larkAppId` 会提示确认，因为旧 appId 下的历史会话和群聊状态数据不会自动迁移。删除机器人只移除本机 `bots.json` 中的一项，不删除飞书开放平台应用、历史消息或本地会话数据；修改完成后运行 `botmux restart` 生效。

**bots.json 格式：**

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "name": "claude-main",
    "cliId": "claude-code",
    "model": "sonnet",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"],
    "allowedChatGroups": ["oc_xxx_team"]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "model": "gpt-5-codex",
    "workingDir": "~/work"
  }
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `larkAppId` | 是 | 飞书应用 App ID |
| `larkAppSecret` | 是 | 飞书应用 App Secret |
| `name` | 否 | `botmux status` 中的进程名后缀；例如 `claude-main` 会显示为 `botmux-claude-main`，留空默认 `botmux-<序号>` |
| `cliId` | 否 | CLI 适配器，默认 `claude-code`（可选：`aiden`、`coco`、`codex`、`codex-app`、`cursor`、`gemini`、`opencode`、`antigravity`、`hermes`） |
| `model` | 否 | 启动 CLI 时使用的模型名；留空走 CLI 默认。当前会注入到支持模型参数的适配器：`claude-code` / `codex` / `coco` / `cursor` / `gemini` / `opencode`；其它适配器会忽略该字段 |
| `cliPathOverride` | 否 | CLI 入口的绝对路径，用于套 wrapper / router；典型场景：ccr、claude-w、aiden-x-claude 等自定义入口 |
| `backendType` | 否 | 会话后端：`pty` 或 `tmux`（默认自动检测） |
| `workingDir` | 否 | 默认工作目录，支持逗号分隔多个目录。新话题的 repo 选择卡片会**从该目录自身向下**递归查找 git 仓库（最多 3 层），不再向上扫父目录：指向仓库集合根目录（如 `~/projects`）即列出其下所有仓库，指向单个仓库则只列该仓库（及其 linked worktrees） |
| `defaultWorkingDir` | 否 | 单仓库默认目录：新话题在无 oncall 绑定 / 无同群兄弟 session 时直接进入该目录，跳过 repo 选择卡片。`/cd <path>` 仍可临时切换；下一个新话题回到该默认值。**与 `defaultOncall` 的区别**：不写 `oncallChats`、不修改 `canTalk`/`canOperate` 权限模型 |
| `allowedUsers` | 否 | 允许的用户列表（**完整邮箱**如 `alice@example.com`，或 open_id `ou_xxx`）。邮箱前缀无法解析、会被丢弃。配置了 `allowedChatGroups` 时此项必须至少有一个条目作为 owner |
| `allowedChatGroups` | 否 | 可对话群列表（飞书 `chat_id`，如 `oc_xxx`）。**在这些群里**任何成员都能与机器人对话（按消息所在群判断，新人进群即生效、退群即失权，无需重启）；仅授对话权（`canTalk`），敏感操作仍由 `allowedUsers` 控制。等价于 owner 在该群发 `/grant`（不带 @）。 |
| `globalGrants` | 否 | 全局可对话名单（`open_id` 列表，如 `ou_xxx`；人或 bot 均可）。名单内的对象可在**任意群**与机器人对话；仅授对话权（`canTalk`），敏感操作仍由 `allowedUsers` 控制。通常由 owner 在授权卡上点「全局授权对话」写入，也可在此手动配置。 |
| `oncallChats` | 否 | oncall 绑定（`/oncall bind` 写入），形如 `[{ "chatId": "oc_xxx", "workingDir": "~/projects/foo" }]`，群内任何成员可 @ 提问 |

**配置优先级：** `BOTS_CONFIG` 环境变量 → `~/.botmux/bots.json`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOTS_CONFIG` | _(未设置)_ | 指定 bots.json 路径（覆盖默认位置） |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动检测局域网 IP)_ | 终端链接中的外部主机名/IP |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话和队列的存储目录 |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |

### 文件位置

| 路径 | 说明 |
|------|------|
| `~/.botmux/bots.json` | 机器人配置文件 |
| `~/.botmux/data/` | 会话数据、消息队列 |
| `~/.botmux/logs/` | Daemon 日志 |

---

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
