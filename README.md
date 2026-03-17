# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

中文 | [English](README.en.md)

飞书话题群与 AI 编程 CLI 的桥接工具。Daemon 监听飞书消息，为每个新话题自动启动一个独立的 CLI 进程（支持 Claude Code、Aiden、CoCo、Codex、Gemini），提供实时流式卡片和 Web 终端。

## 演示

<p align="center">
  <img src="gif/fold&unfold.gif" alt="飞书卡片交互 — 流式输出展开/折叠" width="600">
</p>

<details>
<summary>📺 完整演示视频</summary>

[演示视频](https://github.com/user-attachments/assets/3ba4c681-0a7e-4a03-89c8-b8d26b544a65)
</details>

## 功能特性

- **一个话题 = 一个 AI 编程会话** — 每个飞书话题线程对应一个独立的 CLI 进程
- **多 CLI 支持** — 通过适配器架构支持 Claude Code、Aiden、CoCo、Codex、Gemini，可扩展
- **实时流式卡片** — 终端输出实时渲染到飞书卡片中，支持 Markdown 格式，每轮对话独立卡片
- **Web 终端 (xterm.js)** — 浏览器查看完整 PTY 输出，移动端快捷键工具栏，按需获取可操作链接
- **会话持久化** — 会话在 Daemon 重启后自动恢复；tmux 后端下 CLI 进程常驻，重启零中断
- **定时任务** — 基于 Cron 的周期性任务，支持中文自然语言配置
- **项目管理** — 交互式仓库选择器，每个会话独立工作目录
- **MCP 集成** — CLI 可通过 MCP 工具回复飞书话题、读取消息历史、添加表情回应
- **权限控制** — 用户白名单、终端 Token 写入权限、卡片按钮操作限制

## 前置要求

- **Node.js** >= 20
- **AI 编程 CLI** 已安装并完成认证（`claude`、`aiden`、`coco`、`codex`、`gemini` 或 `opencode` 在 PATH 中）
- **飞书应用** 具备机器人和消息权限（WebSocket 事件订阅）
- **tmux** >= 3.x（可选，安装后自动启用会话常驻）

## 安装

```bash
npm install -g botmux
```

## 快速开始

```bash
# 1. 交互式配置 — 创建 ~/.botmux/.env
botmux setup

# 2. 启动 daemon
botmux start
```

`setup` 命令会引导你完成：
- 创建飞书应用（列出所需权限）
- 输入 App ID、App Secret、Chat ID
- 可选：Claude 模型、工作目录、权限控制

## CLI 命令

| 命令 | 说明 |
|------|------|
| `botmux setup` | 交互式配置（首次使用 / 添加机器人） |
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

## 配置

通过 `~/.botmux/bots.json` 配置机器人。运行 `botmux setup` 交互式创建，或手动编辑。

支持在同一台机器上运行多个飞书机器人，每个机器人可对应不同的 CLI。同一群聊中的多个机器人通过 @mention 路由消息，仅有一个机器人时自动响应无需 @。

```bash
# 交互式配置
botmux setup
```

**bots.json 格式：**

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "cliId": "claude-code",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "workingDir": "~/work"
  }
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `larkAppId` | 是 | 飞书应用 App ID |
| `larkAppSecret` | 是 | 飞书应用 App Secret |
| `cliId` | 否 | CLI 适配器，默认 `claude-code`（可选：`aiden`、`coco`、`codex`、`gemini`、`opencode`） |
| `cliPathOverride` | 否 | CLI 可执行文件路径覆盖 |
| `backendType` | 否 | 会话后端：`pty` 或 `tmux`（默认自动检测） |
| `workingDir` | 否 | 默认工作目录，支持逗号分隔多个目录 |
| `allowedUsers` | 否 | 允许的用户列表（邮箱前缀或 open_id） |
| `projectScanDir` | 否 | 扫描 Git 仓库的目录 |

**配置优先级：** `BOTS_CONFIG` 环境变量 → `~/.botmux/bots.json`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOTS_CONFIG` | _(未设置)_ | 指定 bots.json 路径（覆盖默认位置） |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动检测局域网 IP)_ | 终端链接中的外部主机名/IP |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话和队列的存储目录 |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |

## 文件位置

| 路径 | 说明 |
|------|------|
| `~/.botmux/bots.json` | 机器人配置文件 |
| `~/.botmux/data/` | 会话数据、消息队列 |
| `~/.botmux/logs/` | Daemon 日志 |

## 使用

### 使用流程

1. 在飞书话题群中发送消息创建新话题
2. 机器人弹出仓库选择卡片 — 选择项目或点击「直接开启会话」
3. Claude Code 在所选目录下启动
4. 话题中出现实时流式卡片，展示终端输出并支持 Markdown 渲染
5. 每次回复创建新的流式卡片，上一轮卡片冻结在最后状态
6. 点击卡片上的「🔑 获取操作链接」通过私聊获取可写终端链接
7. Claude 通过 MCP 工具在话题中回复

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/repo` | 显示项目选择卡片 |
| `/repo <N>` | 切换到上次扫描的第 N 个项目 |
| `/skip` | 跳过仓库选择，直接开启会话 |
| `/cd <路径>` | 切换工作目录 |
| `/status` | 查看会话信息（运行时间、终端地址等） |
| `/cost` | 查看 Token 用量和费用估算 |
| `/restart` | 重启 Claude 进程 |
| `/close` | 关闭会话并终止 Claude |
| `/clear` | 清除上下文（新会话，同一话题） |
| `/schedule` | 管理定时任务 |
| `/help` | 显示可用命令 |

### 定时任务

用自然语言创建周期性任务：

```
/schedule 每日17:50 帮我看看AI圈有什么新闻
/schedule 工作日每天9:00 检查服务状态
/schedule 每周一10:00 生成周报
```

管理任务：

```
/schedule list
/schedule remove <id>
/schedule enable <id>
/schedule disable <id>
/schedule run <id>
```

### 流式卡片

每轮对话会生成一个实时更新的飞书卡片，展示：

- 实时终端输出（通过 headless xterm 捕获 + 飞书卡片 v2 Markdown 渲染）
- 状态指示：🟡 启动中 → 🔵 工作中 → 🟢 就绪
- 操作按钮：打开终端、获取操作链接、重启 Claude、关闭会话

卡片内容由 headless xterm 终端捕获，自动过滤 TUI 装饰（Logo、状态栏、提示符、框线字符），仅展示 Claude 的实际工作输出。

### Web 终端

<p align="center">
  <img src="gif/web_terminal.gif" alt="Web 终端实时输出" width="600">
</p>

每个会话提供一个 Web 终端，地址为 `http://<WEB_EXTERNAL_HOST>:<端口>`。

- **只读链接** — 展示在群话题的流式卡片上
- **可操作链接** — 按需获取（点击卡片上的「🔑 获取操作链接」通过私聊发送）

特性：xterm.js + fit/unicode11/web-links 插件、TokyoNight 主题、滚动缓冲区。移动端/平板通过悬浮快捷键工具栏提供 Esc、Ctrl+C、Tab、方向键等虚拟键盘缺失的控制键，工具栏自动避让虚拟键盘。

### Tmux 会话常驻

<p align="center">
  <img src="gif/tmux.gif" alt="botmux list — 交互式 tmux 会话管理" width="600">
</p>

安装 tmux 后，botmux 自动使用 tmux 后端。CLI 进程运行在 tmux session 内，daemon 通过 node-pty attach 到 tmux 来捕获输出，流式卡片、空闲检测、Web 终端等功能全部不受影响。

**核心收益：Daemon 重启不中断 CLI。** `botmux restart` 时 worker 进程退出，但 tmux session（及其中的 CLI 进程）保持运行。下次收到消息时 worker 自动 re-attach，无需 `--resume` 重载上下文。

```bash
# 推荐：交互式会话列表 — 选择后直接 attach 到 tmux
npx botmux list

# 也可以手动 attach（会话名 = bmx-<sessionId 前 8 位>）
tmux attach -t bmx-<session-id-前8位>
# Ctrl+B, D 退出 attach，不影响 CLI 继续运行

# 强制降级到纯 pty 模式（不使用 tmux）
BACKEND_TYPE=pty botmux start
```

`botmux list` 提供交互式 TUI，显示所有活跃会话的 ID、标题、工作目录、PID、运行时长和状态，方向键选择后回车即可 attach。也支持 `botmux list --plain` 输出纯文本表格供脚本使用。

**tmux 会话命名规则：** `bmx-<sessionId 前 8 位>`

**生命周期：**

| 事件 | tmux session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach） |
| `/close` 或关闭按钮 | 销毁 | 终止（SIGHUP） |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（自动重启用新 session） |

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
