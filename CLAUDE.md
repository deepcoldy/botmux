# claude-code-robot

  飞书话题群 ↔ Claude Code 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 Claude Code 进程。

  ## 构建 & 运行

  ```bash
  pnpm build                # tsc 编译
  pnpm daemon:start         # pm2 启动 daemon（生产）
  pnpm daemon:stop          # 停止
  pnpm daemon:restart       # 重启（自动恢复 active sessions）
  pnpm daemon:logs          # 查看日志

  ## 注意事项
  - 每次修改后需要重新编译（`pnpm build`）然后再重启 daemon（`pnpm daemon:restart`）
