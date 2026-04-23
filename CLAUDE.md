# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini / OpenCode）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:restart       # 重启 daemon（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

- 每次修改后需要 `pnpm build` 然后 `pnpm daemon:restart`

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器（参数构建、输入写入、Skill 目录），每种 CLI 一个文件
- `skills/` — 开箱即用的 Skill 定义（`botmux-send`/`botmux-schedule`/`botmux-bots`/`botmux-thread-messages`）+ installer
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## Git 提交 & 发版规范

- **日常提交**：正常 `git commit` + `git push`，不会触发发版
- **发版**：打 `v*` tag 并 push 即可，GitHub Action 自动从 tag 提取版本号写入 `package.json` 后发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段来发版，CI 会自动处理
- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文
- 发版的 annotated tag message 用中文撰写，CI 会把 tag message 作为 GitHub Release body

```bash
# 日常开发
git add <files> && git commit -m "fix(cli): 修复某某问题" && git push

# 发版（仅在用户明确要求时执行）
git tag -a v1.x.x -m "中文 changelog 标题

详细改动说明..."
git push origin v1.x.x
```

## 添加新 CLI 适配器

1. `src/adapters/cli/` 下创建新文件，实现 `CliAdapter` 接口
2. `src/adapters/cli/types.ts` 的 `CliId` 联合类型中添加新 ID
3. `src/adapters/cli/registry.ts` 添加 import、switch case、export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES` 添加显示名
5. `src/im/lark/card-builder.ts` 的 `cliDisplayNames` 添加显示名
6. `src/cli.ts` 的 setup 交互菜单添加选项
7. `README.md`、`README.en.md` 更新 CLI 列表
