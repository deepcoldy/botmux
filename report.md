# Botmux dispatch launch spec 交付报告

## 结果

已为新话题 `botmux dispatch` 增加结构化 Worker 启动规格，并创建 GitHub PR：

- https://github.com/deepcoldy/botmux/pull/1485
- 标题：`feat(dispatch): 支持新话题指定模型与推理强度`
- 状态：open，未合并；未 force-push、未改写历史。

## 公共接口

```bash
botmux dispatch \
  --title <任务标题> \
  --bot-app <target-app[:role]> \
  [--bot <target-open-id[:name[:role]]> --repo <absolute-path> --standby] \
  --model <catalog-id> \
  --reasoning-effort <low|medium|high|xhigh|max|ultra>
```

约束：

- launch spec 只允许新 topic，和 `--into` 同用会在 transport、授权、seed 等外部副作用前拒绝。
- 只允许一个稳定 `--bot-app` 目标；若同时传 `--bot`，必须解析到同一个 Worker。
- `standby + repo` 保留现有 open-id `/repo` operate 授权入口；`--bot-app` 的 talk-only grant 不升级成 operate。
- 无新 flags 的旧 dispatch、legacy `--bot`、普通 topic/chat session 行为保持兼容。

成功回执增加：

```json
{
  "requestedLaunch": { "model": "gpt-6-astra", "reasoningEffort": "high" },
  "effectiveRuntime": { "model": "gpt-6-astra", "reasoningEffort": "high", "observed": false }
}
```

只读 `botmux list --json` 和 daemon session rows 同时暴露 `requestedLaunch` / `effectiveRuntime`。Worker 上报实际运行时后 `observed=true`，并包含 `workerGeneration`、`observedAt`。

## 持久状态与恢复

实现复用了 master 已有的 dispatch-launch contract，并合入目标端 transport/recovery 链路：

- source/target operation 以 `dispatchId` 持久化，CAS 推进 prepare/start/awaiting-proof/terminal。
- target admission 冻结 source app/session/turn、chat、target app、workingDir、policy digest、effective override 与 launch identity。
- 同机 IPC 使用绑定 target app、实际 port、boot instance、method/path/body 的 HMAC，并有 timestamp/nonce/body limit。
- provider root、session、worker generation 分 checkpoint 幂等恢复；quota receipt exactly-once。
- standby `/repo` 兼容入口另以 exact `targetLarkAppId + chatId + rootMessageId` 建 10 分钟消费绑定；同规格重复登记幂等、冲突规格拒绝、一个 session 认领后其他 session 不能消费。
- dispatch-created Session 持久化 requested/effective launch spec。`resolveSessionLaunchModel` 让其优先于之后变化的 Bot 默认；reasoning effort 同样冻结。daemon 重启、Worker crash/refork/resume 仍使用同一规格。

## 授权边界

- v1 target-authoritative 路径只接受官方 Codex TUI、本机目标 daemon、单目标。
- target daemon 独立校验策略、群成员、bot-talk、配额、工作目录、容量、CLI/runtime/backend identity。
- app-scoped `ou_` 不跨应用搬运；目标 daemon 在自己的 app 视角解析 source Bot open_id。
- Firstmate 决定显式 profile/策略；Botmux 只验证与执行，不增加 GPT-6 自动选择逻辑。

## 真实 catalog 验证

本机 `codex-cli 0.155.0` 执行 `codex debug models`：

- catalog id：`gpt-6-astra`
- display name：`GPT-6-Astra`
- supported reasoning levels：`low, medium, high, xhigh, max, ultra`
- 本交付确认并测试 `gpt-6-astra + high`；用户明确不要 `ultra`，实现没有自动选择 `ultra`。

## 验证结果

- 针对性测试：13 文件、96 项，全通过。
- 扩展 dispatch-launch 底座测试：15 文件、149 项，全通过。
- 全量 `bun run test`：24,410 项通过，33 项失败。失败证据均为环境/既有 fixture：当前 Bun 1.4.0 与仓库固定 1.4.2 不一致、临时盘 ENOSPC、tmux/worker fixture 超时；相关新增测试均通过。
- TypeScript：本改动无类型错误；共享 canonical `node_modules` 缺 lockfile 已声明的 `@types/proxy-from-env`，留下一个与本改动无关的依赖错误。遵守 worktree 铁律，没有运行 `bun install`。
- Build：同样被上述共享依赖缺失阻断在 `tsc`；没有重启 live daemon，因为未达到完整 build gate，避免让 fleet 运行未经完整构建的 checkout。
- no-mistakes：按 delivery contract 启动；其配置固定 push upstream，当前 GitHub 身份对 `deepcoldy/botmux` 无写权限，push gate 两次在任何 review/test gate 前失败。随后按安全 fork 流程 push `haozhenfei/botmux` 并创建 upstream PR。没有绕过或伪报 no-mistakes 结果。
- GitHub PR 当前显示未配置 CI checks（0 passed / 0 failed）。

## 影响范围

- 平台：使用 Node/Bun 共用 TypeScript 路径；持久文件、原子写、文件锁无 shell/path 平台分支。
- CLI：公开能力严格限 Codex v1；其他 20+ CLI 的无 flags 路径不变。
- 后端：target-authoritative identity 支持现有本地 pty/tmux/herdr/zellij/zmx，恢复通过统一 launch resolver；Riff/远端与 Codex App/RPC 明确拒绝。
- 会话：新 topic dispatch-created session 获得冻结规格；普通 topic、chat-scope、adopt、existing `--into` 不改变。
