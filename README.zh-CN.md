# claude-code-robot

[English](README.md) | 中文

飞书话题群与 Claude Code 的桥接工具。Daemon 监听飞书消息，为每个新话题自动启动一个独立的 Claude Code 进程，提供实时流式卡片和 Web 终端。

## 功能特性

- **一个话题 = 一个 Claude Code 会话** — 每个飞书话题线程对应一个独立的 Claude Code 进程
- **实时流式卡片** — 终端输出实时渲染到飞书卡片中，支持 Markdown 格式，每轮对话独立卡片
- **Web 终端 (xterm.js)** — 浏览器查看完整 PTY 输出，按需获取可操作链接
- **会话持久化** — 会话在 Daemon 重启后自动恢复
- **定时任务** — 基于 Cron 的周期性任务，支持中文自然语言配置
- **项目管理** — 交互式仓库选择器，每个会话独立工作目录
- **MCP 集成** — Claude Code 可通过 MCP 工具回复飞书话题、读取消息历史、添加表情回应
- **权限控制** — 用户白名单、终端 Token 写入权限、卡片按钮操作限制

## 架构

```
飞书 WebSocket 事件
    |
Daemon (daemon.ts)
    |-- 事件: im.message.receive_v1 (新话题 & 话题回复)
    |-- 事件: card.action.trigger (选择仓库、重启、关闭)
    |-- 定时任务调度器
    |
Worker (worker.ts) -- 每个会话 fork 一个子进程
    |-- node-pty: 在伪终端中启动 Claude Code CLI
    |-- HTTP + WebSocket: 提供 xterm.js Web 终端
    |-- Headless xterm: 捕获屏幕内容用于流式卡片
    |-- IPC: 与 Daemon 通信
    |
Claude Code CLI (交互式 TTY 模式)
    |-- MCP Server (stdio): send_to_thread, get_thread_messages, react_to_message
    |
飞书 API
    |-- 回复消息、表情回应、卡片更新、私聊
```

## 前置要求

- **Node.js** >= 20
- **Claude Code CLI** 已安装并完成认证（`claude` 在 PATH 中）
- **飞书应用** 具备机器人和消息权限（WebSocket 事件订阅）

## 安装

```bash
npm install -g @byted/claude-code-robot
```

## 快速开始

```bash
# 1. 交互式配置 — 创建 ~/.claude-code-robot/.env
claude-code-robot setup

# 2. 启动 daemon
claude-code-robot start
```

`setup` 命令会引导你完成：
- 创建飞书应用（列出所需权限）
- 输入 App ID、App Secret、Chat ID
- 可选：Claude 模型、工作目录、权限控制

## CLI 命令

| 命令 | 说明 |
|------|------|
| `claude-code-robot setup` | 交互式首次配置 |
| `claude-code-robot start` | 启动 daemon（PM2 管理） |
| `claude-code-robot stop` | 停止 daemon |
| `claude-code-robot restart` | 重启 daemon（自动恢复活跃会话） |
| `claude-code-robot logs` | 查看日志（`--lines N`） |
| `claude-code-robot status` | 查看 daemon 状态 |
| `claude-code-robot upgrade` | 升级到最新版本 |

## 配置

配置文件位于 `~/.claude-code-robot/.env`。运行 `claude-code-robot setup` 交互式创建，或手动编辑：

### 必填

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 飞书应用 App ID |
| `LARK_APP_SECRET` | 飞书应用 App Secret |
| `LARK_DEFAULT_CHAT_ID` | 话题群的 Chat ID |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_BRIDGE_MODEL` | `opus` | Claude 模型（`opus`、`sonnet`、`haiku`） |
| `LARK_BRIDGE_MAX_TURNS` | `500` | 每个会话的最大对话轮数 |
| `CLAUDE_PATH` | `claude` | Claude Code CLI 路径 |
| `CLAUDE_WORKING_DIR` | `~` | 默认工作目录 |
| `ALLOWED_USERS` | _(空 = 不限制)_ | 允许的飞书用户 open_id，逗号分隔 |
| `PROJECT_SCAN_DIR` | _(工作目录的上级)_ | 扫描 Git 仓库的目录 |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动检测局域网 IP)_ | 终端链接中的外部主机名/IP |
| `SESSION_DATA_DIR` | `~/.claude-code-robot/data` | 会话和队列的存储目录 |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |

## 文件位置

| 路径 | 说明 |
|------|------|
| `~/.claude-code-robot/.env` | 配置文件 |
| `~/.claude-code-robot/data/` | 会话数据、消息队列 |
| `~/.claude-code-robot/logs/` | Daemon 日志 |

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

每个会话提供一个 Web 终端，地址为 `http://<WEB_EXTERNAL_HOST>:<端口>`。

- **只读链接** — 展示在群话题的流式卡片上
- **可操作链接** — 按需获取（点击卡片上的「🔑 获取操作链接」通过私聊发送）

特性：xterm.js + fit/unicode11/web-links 插件、TokyoNight 主题、滚动缓冲区、移动端适配。

## MCP 工具

Claude Code 可使用三个 MCP 工具与飞书交互：

| 工具 | 说明 |
|------|------|
| `send_to_thread` | 向飞书话题发送消息（纯文本或富文本） |
| `get_thread_messages` | 获取话题的消息历史 |
| `react_to_message` | 添加或移除消息的表情回应 |

## 开发

```bash
git clone <repo-url>
cd claude-code-robot
pnpm install
pnpm build

# 直接运行（不经 PM2）
pnpm daemon

# 或使用 PM2
pnpm daemon:start
pnpm daemon:logs
```

## 项目结构

```
src/
  cli.ts                 # CLI 入口（setup/start/stop/restart/logs）
  daemon.ts              # 主进程：事件处理、会话生命周期、命令
  worker.ts              # Worker 进程：PTY、HTTP/WS 服务、Prompt 检测
  scheduler.ts           # 定时任务调度（自然语言解析）
  config.ts              # 环境变量配置
  server.ts              # MCP Server
  types.ts               # IPC 消息类型
  services/
    lark-client.ts       # 飞书 API 封装
    session-store.ts     # 会话持久化 (JSON)
    schedule-store.ts    # 定时任务持久化
    message-queue.ts     # 话题消息队列 (JSONL)
    project-scanner.ts   # Git 仓库/Worktree 扫描
  tools/
    send-to-thread.ts    # MCP 工具：发送消息
    get-thread-messages.ts # MCP 工具：读取消息
    react-to-message.ts  # MCP 工具：表情回应
  utils/
    card-builder.ts      # 飞书交互卡片构建（会话卡片、流式卡片、仓库选择卡片）
    terminal-renderer.ts # Headless xterm 渲染器（屏幕捕获 & TUI 过滤）
    message-parser.ts    # 飞书事件消息解析
    logger.ts            # 日志工具
```

## 许可证

[MIT](LICENSE)
