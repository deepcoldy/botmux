# claude-code-robot

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Aiden / CoCo / Codex）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:start         # pm2 启动 daemon（生产）
pnpm daemon:stop          # 停止
pnpm daemon:restart       # 重启（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

## 注意事项
- 每次修改后需要重新编译（`pnpm build`）然后再重启 daemon（`pnpm daemon:restart`）

## 模块结构

- `daemon.ts` — 薄编排层（~400 行），组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `adapters/cli/` — CLI 适配器：每种 CLI 的参数构建、输入写入、MCP 配置。通过 `CLI_ID` 环境变量选择
- `adapters/backend/` — 会话后端：`PtyBackend`（node-pty）、`TmuxBackend`（stub）
- `core/` — 核心逻辑：`worker-pool`（进程池）、`command-handler`（斜杠命令）、`session-manager`（会话生命周期）、`cost-calculator`、`scheduler`
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `im/lark/` — 飞书专属：事件路由、卡片交互、API 封装、消息解析
- `im/types.ts` — `ImAdapter` 接口定义（多 IM 抽象，预留）
- `utils/idle-detector.ts` — CLI 空闲检测（静默 + Spinner + 完成标记）

## 添加新 CLI 适配器

1. 在 `src/adapters/cli/` 下创建新文件，实现 `CliAdapter` 接口
2. 在 `src/adapters/cli/types.ts` 的 `CliId` 类型中添加新 ID
3. 在 `src/adapters/cli/registry.ts` 的 switch 中添加 case
4. 设置 `CLI_ID=<new-id>` 环境变量即可使用
