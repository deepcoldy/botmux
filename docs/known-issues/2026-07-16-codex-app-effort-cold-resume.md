# Codex App 冷恢复把 `/effort ultra` 误作用户消息

> 状态：代码修复、聚焦单测与 build 已通过；未切换 live daemon，未做真实飞书 E2E。
> 建议 PR：`fix(codex-app): 冷恢复不再把启动命令当用户消息`

## 1. 原始发现与用户可见现象

- 2026-07-16 在复核 Codex App 会话状态问题时发现：配置了
  `startupCommands: ["/effort ultra"]` 的 Bot 在冷恢复（旧 runner 已退出、
  需要新起 runner 并 resume thread）后，会在 Codex App 对话中多出一条内容为
  `/effort ultra` 的 User Message。
- 该项不是用户最初直接描述的前三个状态/权限故障，而是同一轮排查确认的独立兼容性问题；
  用户随后要求它与前三项一样单独 PR、单独文档交付。入口消息：
  `om_x100b6ab261f358a0def9677b41d37bf`。
- 现场临时绕行是从目标 Bot 配置中移除该启动命令。该绕行避免继续污染新 turn，
  但不构成源码修复。

用户可见影响：

1. Codex App 历史里出现用户并未发送的 `/effort ultra`；
2. app-server 会把它作为一次真实 `turn/start`，可能触发无意义的模型回复和 token 消耗；
3. 冷恢复后真正触发恢复的用户消息排在这条伪造 turn 之后，破坏“恢复后第一条消息”的语义；
4. Botmux 日志此前无法区分“设置已应用”和“设置被当成普通消息”。

## 2. 根因

`BotConfig.startupCommands` 的既有契约是：CLI 就绪后，worker 把每一项作为
TUI 文本输入，再单独发送 Enter，以便 CLI 自己的 slash-command parser 处理。

`codex-app` 并不是 Codex CLI TUI。它由 Node runner 接收行协议，并通过
app-server JSON-RPC 创建 turn：

- 带 `::botmux-codex-app:` 前缀的行是 Botmux 编码的正式消息；
- 其他普通文本行被 runner 当作用户输入并加入 turn 队列。

worker 没有表达“某 adapter 是否具备 TUI 启动命令通道”的能力字段，因而在
fresh spawn 和 cold resume 的新 runner 上照常键入 `/effort ultra`。runner 无法把
它解释为 TUI 命令，只能创建普通用户 turn。warm reattach 本来就会跳过启动命令，
所以问题集中暴露在需要新进程的冷恢复路径。

## 3. 方案

1. 在 `CliAdapter` 增加可选能力 `acceptsTuiStartupCommands`；缺省视为 `true`，
   保持现有 TUI adapter 行为不变。
2. `codex-app` 明确声明该能力为 `false`。
3. worker 在决定 fresh spawn 是否重新 armed 启动命令时同时检查该能力；
   对不支持的 adapter 不向 stdin 写任何启动命令，并写一条不含凭据的诊断日志。
4. 保留 runner 对普通文本输入的现有能力，避免破坏 Web Terminal 中人工输入；
   防线放在 worker 的启动命令调度边界，而不是粗暴丢弃 runner 的所有非 framed 输入。

## 4. 修复前后效果

| 场景 | 修复前 | 修复后 |
|---|---|---|
| codex-app fresh spawn + `/effort ultra` | 产生伪造 User Message/turn | 不写入 runner；真实用户首条消息仍是第一 turn |
| codex-app cold resume + `/effort ultra` | resume 后先产生伪造 turn | resume thread 后直接等待/处理真实用户消息 |
| codex-app warm persistent reattach | 既有逻辑已跳过 | 保持跳过 |
| 其他未声明能力的 TUI adapter | 正常执行启动命令 | 行为不变（缺省 `true`） |
| 人工向 codex-app Web Terminal 输入文本 | runner 创建用户 turn | 行为不变 |

## 5. 影响面与非目标

- **CLI**：生产行为只改变 `codex-app`；公共接口增加的是向后兼容的可选字段。
- **backend**：能力判断发生在 adapter/worker 层，不依赖 PTY、tmux 或 zellij 的
  具体按键实现。
- **会话形态**：覆盖 fresh spawn 与 cold resume；warm reattach、adopt 继续沿用原有跳过语义。
- **平台**：纯 TypeScript 状态判断，无 macOS/Linux 路径或 shell 差异。
- **非目标**：本 PR 不把 `/effort ultra` 翻译成 app-server 的原生 reasoning-effort
  参数，也不声称服务端实际使用了某个 effort。若后续支持，应增加协议级配置字段与
  app-server 返回值验证，而不是重新把 TUI 命令写入 runner。

## 6. 验证计划与证据等级

已执行：

```bash
npx --yes pnpm@9.5.0 exec vitest run test/startup-commands.test.ts test/codex-app-runner.integration.test.ts test/runner-input.test.ts
npx --yes pnpm@9.5.0 build
npx --yes pnpm@9.5.0 exec vitest run --project unit --reporter=dot --silent=passed-only
git diff --check
```

结果：聚焦 3 个 test files 为 **34/34 passed**；TypeScript 与 Dashboard build
通过；分支对齐 `origin/master@a09ebcf9` 后，全量 unit 为
**8369 passed / 1 failed / 6 skipped**。唯一失败是
`test/dashboard-monitoring-ui.test.ts` 的既有 CSS 断言；同一 `origin/master@a09ebcf9`
干净 worktree 复跑为 **8366 passed / 1 failed / 6 skipped**，失败用例和
断言完全相同，因此不属于本 PR。`git diff --check` 通过。

聚焦断言：

- fresh TUI adapter 仍运行启动命令；
- persistent reattach 仍跳过；
- 显式不支持 TUI 命令的 adapter 在 fresh/cold spawn 也跳过；
- `codex-app` adapter 确实声明 opt-out；
- worker 的 spawn wiring 把 adapter capability 传给纯策略函数。

证据分级：上述为 **unit / source wiring / build**；未获得维护窗口前不执行
`pnpm switch:here`、`botmux restart`，因此不把结果描述为 live daemon 或真实飞书 E2E。

## 7. 风险、回滚与后续

- 风险：用户原本误以为 `/effort ultra` 已在 codex-app 生效；修复后它被明确跳过，
  但不会再伪造用户消息。诊断日志用于解释该差异。
- 回滚：移除 `codex-app` 的 opt-out 和公共能力判断即可恢复旧行为；无需迁移持久数据。
- 后续：若 Codex app-server 提供稳定、可验证的 reasoning effort 参数，应单独设计
  protocol-native 配置，分别报告请求 effort 与服务端实际 served model/effort，不能
  仅凭本地配置或 rollout 字段认领生效。
- 同类边界：`mira` / `mir` 也由 line-framed runner 承载，但不属于本次已复现的
  Codex App 问题，本 PR 不改变它们的启动命令行为；应另行核验后再决定是否 opt-out，
  避免在缺少各自兼容性证据时扩大本 PR 的生产影响面。
