# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini / OpenCode / Antigravity / Pi）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:restart       # 重启 daemon（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

- 每次修改后需要 `pnpm build` 然后 `pnpm daemon:restart`

### 全局 `botmux` 指向哪个 checkout（多 checkout 切换）

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 这个瘦 wrapper（需 `~/.botmux/bin` 在 PATH 上，一次性写进 shell rc：`export PATH="$HOME/.botmux/bin:$PATH"`）。wrapper 指向哪个 checkout 的 `dist/cli.js`，由「最后写它的人」决定——daemon 启动时会写，本地多 checkout 间切换时用下面命令显式认领：

```bash
pnpm use:here             # 把全局 botmux wrapper 指向「当前 checkout」（仅改指向，不重启 daemon）
pnpm switch:here          # = build + use:here 一步到位
botmux restart            # use:here 后裸命令已解析到本 checkout，daemon 也从这重启
BOTMUX_NO_CLAIM=1 pnpm use:here   # 逃生阀：本次不认领
```

- 故意**没**挂进 `build`——review/验证别人 PR 时纯 `pnpm build` 不会悄悄抢走全局指向
- 实现见 `scripts/claim-botmux-bin.mjs`（与 `daemon.ts` 写的 wrapper 同构、幂等）

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器（参数构建、输入写入、Skill 目录），每种 CLI 一个文件
- `skills/` — 开箱即用的 Skill 定义（`botmux-send`/`botmux-schedule`/`botmux-bots`/`botmux-history`/`botmux-quoted`）+ installer
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## Git 提交 & 发版规范

- **日常提交**：正常 `git commit` + `git push`，不会触发发版
- **发版**：打 `v*` tag 并 push 即可，GitHub Action 自动从 tag 提取版本号写入 `package.json` 后发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段来发版，CI 会自动处理
- **正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`（直接在 master 上打 tag，或在已 rebase 到最新 master 的子分支上打）。落后/分叉的分支打正式版会被拒绝。要从非 master 分支灰度，用 `-canary`/`-beta`/`-rc` 后缀走旁路 dist-tag
- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文
- 发版的 annotated tag message 用中文撰写，CI 会把 tag message 作为 GitHub Release body

### dist-tag 路由（CI 自动判断，不用手动指定）

| tag 格式 | npm dist-tag | GitHub prerelease | 用途 |
| --- | --- | --- | --- |
| `v1.2.3` | `latest` | 否 | 正式发版，默认安装 |
| `v1.2.3-canary.N` | `canary` | 是 | 内测、灰度验证；`npm i botmux@canary` |
| `v1.2.3-beta.N` | `beta` | 是 | beta 预览 |
| `v1.2.3-rc.N` | `rc` | 是 | 发版候选 |
| 其它带 `-` 后缀 | `next` | 是 | 兜底，不污染 latest |

**canary 不会覆盖 latest**，stable 用户依旧拿 stable。要验证 canary：`npm i -g botmux@canary` 或 `npx botmux@canary`。

```bash
# 日常开发
git add <files> && git commit -m "fix(cli): 修复某某问题" && git push

# 正式发版（仅在用户明确要求时执行）
git tag -a v1.x.x -m "中文 changelog 标题

详细改动说明..."
git push origin v1.x.x

# Canary 发版（基于待发正式版号，递增 .N）
git tag -a v1.x.x-canary.0 -m "canary: 加诊断日志排查截图卡死

详细改动说明..."
git push origin v1.x.x-canary.0
```

## 添加新 CLI 适配器

1. `src/adapters/cli/` 下创建新文件，实现 `CliAdapter` 接口
2. `src/adapters/cli/types.ts` 的 `CliId` 联合类型中添加新 ID
3. `src/adapters/cli/registry.ts` 添加 import、switch case、export
4. `src/worker.ts` 的 `CLI_DISPLAY_NAMES` 添加显示名
5. `src/im/lark/card-builder.ts` 的 `cliDisplayNames` 添加显示名
6. `src/setup/bot-config-editor.ts` 的 `CLI_ID_CHOICES`（序号映射）+ `CLI_DISPLAY_LABELS`（dashboard 添加机器人下拉的展示名，缺了会回退显示 id）
7. `src/cli.ts` 的 setup 交互菜单添加选项
8. `README.md`、`README.en.md` 更新 CLI 列表
