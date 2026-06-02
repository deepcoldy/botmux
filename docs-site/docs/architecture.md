# 架构总览

botmux 是一个薄编排层，把"飞书事件"翻译成"CLI 进程的输入/输出"。核心进程与模块：

## 进程模型

```
飞书 (Lark) 长连接事件
        │
        ▼
   ┌──────────┐   每个 bot 一个独立 daemon 进程
   │  daemon  │   监听消息、路由、管理会话生命周期
   └────┬─────┘
        │ 每个话题 spawn 一个
        ▼
   ┌──────────┐   通过适配器拉起 CLI，挂在 PTY / tmux 后端上
   │  worker  │   读终端输出 → 渲染卡片；收飞书消息 → 写入 CLI
   └────┬─────┘
        │
        ▼
   ┌──────────┐
   │ CLI 进程  │   Claude Code / Codex / ...（完整运行时）
   └──────────┘
```

> 生产形态是**一个 bot 一个 daemon 进程**。多机器人 = 多 daemon，进程完全隔离，互不干扰。

## 模块结构

| 模块 | 职责 |
|------|------|
| `daemon.ts` | 薄编排层，组装各模块并启动 |
| `worker.ts` | Worker 子进程，通过适配器管理 CLI + PTY |
| `server.ts` | Web 终端 HTTP 服务（xterm.js） |
| `bot-registry.ts` | 多机器人配置加载 + 状态管理 |
| `adapters/cli/` | CLI 适配器（参数构建、输入写入、Skill 目录），每种 CLI 一个文件 |
| `adapters/backend/` | 会话后端：`PtyBackend`、`TmuxPipeBackend` |
| `im/lark/` | 飞书：事件路由、卡片构建/处理、API client、消息解析 |
| `core/` | `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler` |
| `skills/` | 开箱即用的 Skill（`botmux-send` / `botmux-schedule` / `botmux-bots` / `botmux-history` / `botmux-quoted`） |
| `utils/` | `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger` |

## 数据流

1. 飞书推送 `im.message.receive_v1` → event-dispatcher 解析、判断归属（@mention / 话题 / 群权限）。
2. command-handler 拦截 `/xxx` 斜杠命令；非命令消息交给会话。
3. 新话题 → worker-pool spawn 一个 worker；已有会话 → 复用，把消息写进 CLI stdin。
4. worker 持续读 PTY 输出，经 terminal-renderer 转成 Markdown，更新流式卡片。
5. CLI 通过注入的 `botmux send` 等 Skill / 命令主动往话题发消息。

关键点：**worker 与 CLI 通过后端（PTY 或 tmux）解耦**。tmux 后端下，daemon/worker 重启时 CLI 进程仍在 tmux 里活着，下次消息自动 re-attach，无需 `--resume` 重载上下文。详见 [tmux 会话常驻](/tmux)。
