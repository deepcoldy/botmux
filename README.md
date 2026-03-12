# botmux

中文 | [English](README.en.md)

飞书话题群与 AI 编程 CLI 的桥接工具。Daemon 监听飞书消息，为每个新话题自动启动一个独立的 CLI 进程（支持 Claude Code、Aiden、CoCo、Codex），提供实时流式卡片和 Web 终端。

## 演示

<video src="https://github.com/user-attachments/assets/840d3bb6-3b98-465a-8662-b4beadeb48ce" width="100%" controls></video>

## 功能特性

- **一个话题 = 一个 AI 编程会话** — 每个飞书话题线程对应一个独立的 CLI 进程
- **多 CLI 支持** — 通过适配器架构支持 Claude Code、Aiden、CoCo、Codex，可扩展
- **实时流式卡片** — 终端输出实时渲染到飞书卡片中，支持 Markdown 格式，每轮对话独立卡片
- **Web 终端 (xterm.js)** — 浏览器查看完整 PTY 输出，按需获取可操作链接
- **会话持久化** — 会话在 Daemon 重启后自动恢复；tmux 后端下 CLI 进程常驻，重启零中断
- **定时任务** — 基于 Cron 的周期性任务，支持中文自然语言配置
- **项目管理** — 交互式仓库选择器，每个会话独立工作目录
- **MCP 集成** — CLI 可通过 MCP 工具回复飞书话题、读取消息历史、添加表情回应
- **权限控制** — 用户白名单、终端 Token 写入权限、卡片按钮操作限制

## 架构

```
飞书 WebSocket 事件
    |
Daemon (daemon.ts → core/ 模块)
    |-- im/lark/event-dispatcher: 飞书事件路由
    |-- im/lark/card-handler: 卡片交互处理
    |-- core/worker-pool: Worker 进程池管理
    |-- core/command-handler: 斜杠命令处理
    |-- core/session-manager: 会话生命周期
    |-- core/scheduler: 定时任务调度
    |
Worker (worker.ts) -- 每个会话 fork 一个子进程
    |-- adapters/cli/*: CLI 适配器 (Claude Code / Aiden / CoCo / Codex)
    |-- adapters/backend: PtyBackend (node-pty) 或 TmuxBackend (tmux + node-pty)
    |-- utils/idle-detector: 空闲检测（静默 + Spinner + 完成标记）
    |-- HTTP + WebSocket: 提供 xterm.js Web 终端
    |-- Headless xterm: 捕获屏幕内容用于流式卡片
    |-- IPC: 与 Daemon 通信
    |
AI 编程 CLI (交互式 TTY 模式)
    |-- MCP Server (stdio): send_to_thread, get_thread_messages, react_to_message
    |
飞书 API
    |-- 回复消息、表情回应、卡片更新、私聊
```

## 前置要求

- **Node.js** >= 20
- **AI 编程 CLI** 已安装并完成认证（`claude`、`aiden`、`coco` 或 `codex` 在 PATH 中）
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
| `botmux setup` | 交互式首次配置 |
| `botmux start` | 启动 daemon（PM2 管理） |
| `botmux stop` | 停止 daemon |
| `botmux restart` | 重启 daemon（自动恢复活跃会话） |
| `botmux logs` | 查看日志（`--lines N`） |
| `botmux status` | 查看 daemon 状态 |
| `botmux upgrade` | 升级到最新版本 |

## 配置

配置文件位于 `~/.botmux/.env`。运行 `botmux setup` 交互式创建，或手动编辑：

### 必填

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 飞书应用 App ID |
| `LARK_APP_SECRET` | 飞书应用 App Secret |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLI_ID` | `claude-code` | CLI 适配器（`claude-code`、`aiden`、`coco`、`codex`） |
| `CLI_PATH` | _(按 CLI_ID 自动检测)_ | CLI 可执行文件路径覆盖 |
| `BACKEND_TYPE` | _(自动检测)_ | 会话后端：有 tmux 则用 `tmux`，否则 `pty` |
| `WORKING_DIR` | `~` | 默认工作目录 |
| `ALLOWED_USERS` | _(空 = 不限制)_ | 允许的用户，邮箱前缀或 open_id，逗号分隔 |
| `PROJECT_SCAN_DIR` | _(工作目录的上级)_ | 扫描 Git 仓库的目录 |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动检测局域网 IP)_ | 终端链接中的外部主机名/IP |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话和队列的存储目录 |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |

## 文件位置

| 路径 | 说明 |
|------|------|
| `~/.botmux/.env` | 配置文件 |
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

### Tmux 会话常驻

安装 tmux 后，botmux 自动使用 tmux 后端（`pty-under-tmux` 架构）。CLI 进程运行在 tmux session 内，daemon 通过 node-pty attach 到 tmux 来捕获输出，现有的流式卡片、空闲检测、Web 终端等功能全部不受影响。

**核心收益：Daemon 重启不中断 CLI。** `botmux restart` 时 worker 进程退出，但 tmux session（及其中的 CLI 进程）保持运行。下次收到消息时 worker 自动 re-attach，无需 `--resume` 重载上下文。

```bash
# 查看活跃的 botmux tmux 会话
tmux list-sessions | grep bmx-

# 手动 attach 调试（实时观察 CLI 终端）
tmux attach -t bmx-<session-id-前8位>
# Ctrl+B, D 退出 attach，不影响 CLI 继续运行

# 强制回退到纯 pty 模式（不使用 tmux）
BACKEND_TYPE=pty botmux start
```

**tmux 会话命名规则：** `bmx-<sessionId 前 8 位>`，由 session UUID 确定性派生。

**生命周期：**

| 事件 | tmux session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach） |
| `/close` 或关闭按钮 | 销毁 | 终止（SIGHUP） |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（自动重启用新 session） |
| 切换 `CLI_ID` 后重启 | 全部销毁 | 全部终止（防止 pattern 不匹配） |

**注意事项：**
- 切换 `CLI_ID`（如 `claude-code` → `coco`）后重启 daemon，所有旧 tmux session 会被自动清理，因为旧 CLI 的 idle detection pattern 与新适配器不兼容
- 孤儿 tmux session（不在 active session 列表中的）会在 daemon 启动时自动清理
- 如果不需要 tmux 常驻特性，设置 `BACKEND_TYPE=pty` 即可回退

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
cd botmux
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
  cli.ts                    # CLI 入口（setup/start/stop/restart/logs）
  daemon.ts                 # Daemon 编排入口（~400 行，调用各模块）
  worker.ts                 # Worker 进程：使用适配器管理 CLI + PTY
  config.ts                 # 环境变量配置
  server.ts                 # MCP Server
  types.ts                  # IPC 消息类型
  adapters/
    cli/
      types.ts              # CliAdapter 接口、CliId 类型
      registry.ts           # 适配器工厂 + resolveCommand
      claude-code.ts        # Claude Code 适配器
      aiden.ts              # Aiden 适配器
      coco.ts               # CoCo 适配器
      codex.ts              # Codex 适配器
    backend/
      types.ts              # SessionBackend 接口
      pty-backend.ts        # node-pty 后端
      tmux-backend.ts       # tmux 后端（pty-under-tmux，会话常驻）
  core/
    types.ts                # DaemonSession 核心类型
    worker-pool.ts          # Worker 进程池管理
    command-handler.ts      # 斜杠命令处理
    session-manager.ts      # 会话生命周期 + 路径解析
    cost-calculator.ts      # Token 用量 & 费用估算
    scheduler.ts            # 定时任务调度（自然语言解析）
  im/
    types.ts                # ImAdapter 接口定义（多 IM 抽象）
    lark/
      client.ts             # 飞书 API 封装
      event-dispatcher.ts   # 飞书 WebSocket 事件路由
      card-handler.ts       # 飞书卡片交互处理
      card-builder.ts       # 飞书交互卡片构建
      message-parser.ts     # 飞书事件消息解析
  tools/
    index.ts                # MCP 工具注册表
    send-to-thread.ts       # MCP 工具：发送消息
    get-thread-messages.ts  # MCP 工具：读取消息
    react-to-message.ts     # MCP 工具：表情回应
  services/
    session-store.ts        # 会话持久化 (JSON)
    schedule-store.ts       # 定时任务持久化
    message-queue.ts        # 话题消息队列 (JSONL)
    project-scanner.ts      # Git 仓库/Worktree 扫描
  utils/
    idle-detector.ts        # CLI 空闲检测（静默 + Spinner + 完成标记）
    terminal-renderer.ts    # Headless xterm 渲染器（屏幕捕获 & TUI 过滤）
    logger.ts               # 日志工具
```

## 许可证

[MIT](LICENSE)
