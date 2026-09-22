# botmux worker/session observe seam (v1) — final report

## Summary
在 botmux 仓库落地 `botmux observe` 只读接口，并把它作为外部消费者观察 daemon 实时 `SessionRow` 投影的**唯一**事实源。实现遵守需求收窄后的边界：

- 不新增状态实体、心跳、phase 推断或平行账本；数据源固定为已有 HMAC loopback IPC `GET /api/sessions[/:sessionId]`（daemon 内部已经用 `composeRowFromActive/composeRowFromPersistedActive/composeRowFromClosed` 归总好 SessionRow）。
- CLI 与 TS 消费者共享同一个 canonical normalizer（`src/services/session-observe.ts`）；`botmux observe` 只是把 façade 结果原样打印。
- 探针失败绝不回退旧缓存；出问题时 envelope 直接给出 `probe.status !== 'ok'` + 空 sessions。
- `phase` 一律为 `'unknown'`，不再企图从 idle-detector 反推 thinking/tool/input。
- `queued` 严格是 `boolean | 'unknown'`；`pendingRepo` 单列，未与 queue 合并。
- `dormant` 与 `queued=true` 映射到 `liveness = 'not_running'`（保留 `rawStatus`），不把尚未启动或已停驻的 worker 冒充为存活；无法判断的一律 `unknown`。

## 文件清单
| 路径 | 作用 |
| --- | --- |
| `src/services/session-observe.ts` | canonical 类型 + `normalizeSessionRow`（schemaVersion=1）。纯函数，任何 CLI/TS 调用都必须过它。|
| `src/services/session-observe-fetch.ts` | 公开薄 façade：只暴露 `larkAppId` / `includeRaw` 产品查询参数。|
| `src/services/session-observe-fetch-implementation.ts` | 内部实现：使用 `fetchDaemonIpc`（HMAC loopback）和固定 timeout；探针失败不回退缓存。|
| `src/services/session-observe-fetch-internal.ts` | 测试 seam：集中提供 discover/fetch/clock 等依赖注入，不由 npm subpath 导出。|
| `src/cli/observe-command.ts` | `botmux observe` 子命令（`--session`/`--lark-app`/`--include-raw`，固定输出 canonical JSON）。|
| `src/cli.ts` | 在 top-level `switch (command)` 中注册 `case 'observe'`。|
| `test/session-observe.test.ts` | 16 用例：normalizer 覆盖 working/idle/starting/dormant/closed/queued/unknown status/partial row/attention/adopt/no-phase/probe failure/cliId=unknown/includeRaw。|
| `test/session-observe-fetch.test.ts` | 15 用例：通过 internal seam 注入 discover + fetch，覆盖 pty/tmux + 至少两种 CLI adapter、unauthorized、请求与响应体超时、malformed body、多 daemon、not_found、daemon_offline、并发 fan-out 与混合失败优先级。|

## 契约（v1）
### `ObserveSession`
- `schemaVersion`：数字，本版=1，向前兼容通过新增字段扩展。
- `probe`: `{status: 'ok'|'unauthorized'|'unreachable'|'not_found'|'daemon_offline', source: 'daemon-ipc', larkAppId?, error?}`。
- `identity`：`sessionId`、`larkAppId`、`chatId`、`chatType`、`rootMessageId`、`scope`、`threadId`、`botName`、`feishuChatLink`、`feishuThreadLink`（daemon 已回填）。
- `cli`：`id/runtimeId/runtimeDisplayName/version/instanceId`。`cliId === 'unknown'` 归一化为缺失。
- `backend`：`type/sessionName/adopted/workerPid/adoptCliPid`；探针失败时 `adopted` 为 `'unknown'`。
- `liveness`：`alive`（非 queued 且 daemon status 属于 working/idle/starting/analyzing/limited/stalled/interrupted） `|` `not_running`（dormant 或 queued=true）`|` `closed` `|` `unknown`（daemon 无法给出可识别 status）。
- `turn`：`working|idle|starting|analyzing|limited|stalled|interrupted|unknown`；`closed`/`dormant`/`queued=true` 全部收敛到确定值（closed/dormant → `unknown`，queued=true → `idle` 匹配 daemon 内 composeRowFromActive 语义）。
- `phase`：**恒为 `'unknown'`**。
- `queued`：`boolean | 'unknown'`；`pendingRepo?` 单列布尔。
- `attention?`：仅当 `kind/reason/at` 三字段齐全时暴露。
- `lastActivityAt?` / `workingDirectory?` / `tuiPromptActive?`：直接取 SessionRow。
- `parkedOrSuspended`：`queued === true` 或已识别的 `status === 'dormant'` 时为 `true`；已识别 status 的其它情况为 `false`；status 缺失/未知且 queue 不能证明停驻时为 `'unknown'`。
- `closed`：仅已识别的 SessionRow status 可推导布尔值；status 缺失/未知或探针失败时为 `'unknown'`。
- `rawStatus`：原始 SessionRow.status。诊断用。
- `raw?`：`includeRaw:true` 时挂载整行 SessionRow。

### 顶层结构
- `fetchObserveSnapshot({larkAppId?, includeRaw?})` → `ObserveSnapshot { daemons: ObserveDaemonEnvelope[] }`。每个 daemon 独立一个 envelope，故 A 挂 B 不受影响。指定 `larkAppId` 且该 daemon 离线 → 一个 `daemon_offline` envelope。
- `fetchObserveSession(sessionId, {larkAppId?, includeRaw?})` → `ObserveSession`；无 `larkAppId` 时并发探测所有在线 daemon，并按 discovery 顺序选择第一个 `ok`；全未命中时按 `unauthorized > unreachable > not_found > daemon_offline` 选择失败，返回带 identity 的合成对象。snapshot options 不接受 `sessionId`，避免静默无效的查询参数。

## 复用矩阵（需求约束对照）
| 字段 | 事实源 | 实时/缓存语义 | 失败行为 |
| --- | --- | --- | --- |
| `identity.*` | 存储层 + daemon 补齐（feishuChatLink 等） | 半持久身份；不会因未探到进程消失 | envelope.probe 非 ok 时 identity 仅保留调用方传入的 sessionId |
| `cli.*` / `backend.*` | daemon 内 DaemonSession（active）或 SessionStore（persisted） | daemon 已认定的持久属性 | probe 失败时缺失 |
| `liveness` | daemon `SessionRow.status` 与 queued 分类：queued→not_running；否则 working…interrupted→alive；dormant→not_running；closed→closed；其它→unknown | 实时：daemon 每次 compose 时按内存 pid liveness + activeSessions 决定 | probe 失败时 `unknown`，不套旧缓存 |
| `turn` | 同 SessionRow.status；`queued=true` 覆盖为 idle | 实时 | 未知/失败时 `unknown` |
| `phase` | —— | **总是 unknown**，不再从 idle-detector 反推 | 保持 unknown |
| `queued` | `SessionRow.queued`（daemon 计算） | 实时 bool | 缺失或非 bool 时 `'unknown'` |
| `pendingRepo` | `SessionRow.pendingRepo` | 实时 | 缺失或 probe 非 ok 时省略 |
| `lastActivityAt` | `SessionRow.lastMessageAt` | 历史事实 | 缺失时省略 |
| `workingDirectory` | `SessionRow.workingDir` | 半持久 | 缺失或 probe 非 ok 时省略 |
| `attention` | `SessionRow.agentAttention` | 实时 | 三字段任一缺失或 probe 非 ok 时省略 |
| `parkedOrSuspended` / `closed` | 前者优先采用 queued=true，否则依赖已识别 status；后者仅依赖已识别 status | 实时 | status 未知或 probe 非 ok 时不能推导的值为 `'unknown'` |
| `rawStatus` | `SessionRow.status` 原样 | 诊断字段 | probe 非 ok 时省略 |

## 未覆盖 / 仍是 unknown 的能力
1. **`phase`（thinking/tool/input）**：daemon 目前只发布 screen-derived working/idle 边沿，reliable 的模型 turn 阶段没有事实源；本次不引入启发式，保留 unknown。若后续 botmux 侧新增 park/close 明确信号，可在 schema 加 `parkReason`/`closeReason` 而不破坏 v1。
2. **精确 queue 数量**：daemon 未持久化队列长度；`queued: boolean` 是当前唯一可靠事实，不假装暴露 `count`。
3. **不同 daemon 之间的时钟漂移**：`observedAt` 是 façade 自己取的墙钟时间；对时间敏感的消费方需要自行考虑与 daemon `lastHeartbeat` 的差值。
4. **未在 registry 里的 daemon**：`listOnlineDaemons` 已按 `DAEMON_HEARTBEAT_STALE_MS` (90s) 排除。descriptor 尚在但 heartbeat 陈旧 → `daemon_offline`。

## 验证证据
- `bun test test/session-observe.test.ts test/session-observe-fetch.test.ts test/observe-command.test.ts test/observe-command.integration.test.ts` → 39/39 passed（16 normalizer + 15 façade behavior + 7 CLI 参数 + 1 真实 HMAC IPC）。
- 本 review worktree 缺少 `node_modules`，`bun run build` 在 `tsc: command not found` 处停止；仓库约束禁止在 worktree 内安装依赖，完整声明生成与发布包检查留给后续 build gate。
- `bun run test`（全量单测）**在同一工作树、切换到未修改的 master 时的失败集与包含本次改动时完全一致**：`session-store-sqlite-poisoned-recovery`（期望 `bunVersion==='1.4.2'`，本机 1.4.0）、`worker-codex-app-turn-routing.integration`、`schedule-store-dashboard-watch`、`statusline-cli`、`session-store-sqlite-bun-import`、`plugin-mcp-sandbox`、`sandbox-session-data-dir`、`native-subagent-runtime-hook` 等。这些失败与 observe seam 无关（对照 stash 前后同一 vitest 输出）。故不视为本任务回归；不修复不属于任务范围。
- `botmux observe --help` 在编译产物上返回正确 usage。
- 未启动/重启 live daemon；未合并 PR；未推 tag。

## CLI/TS 使用示例
```bash
# 全部在线 daemon（固定输出 canonical JSON）
botmux observe

# 指定 daemon
botmux observe --lark-app cli_agent

# 单会话（不带 larkAppId 会 fan-out 到所有 daemon）
botmux observe --session s_alpha_1 --include-raw

```
```ts
import { fetchObserveSnapshot, fetchObserveSession } from 'botmux/services/session-observe-fetch';
import type { ObserveSession } from 'botmux/services/session-observe';

const snap = await fetchObserveSnapshot({ larkAppId });
const s: ObserveSession = await fetchObserveSession(sessionId, { larkAppId });
```
以上两个稳定 subpath 由 npm 包显式导出；现有 `bun run build` 同步生成 `public-api/` 下的 bundle、类型声明和 source map，完整 `dist/` 继续排除在 tarball 外。

## 边界与放弃项
- 未新增 `session list --json`：既有 `botmux session list --json` 只列 headless automation session（`src/cli/session-command.ts` 中的定义），不覆盖普通 SessionRow；沿用它的 JSON 会让语义更混乱，所以另开 `observe` 子命令。
- 未把 `composeDashboardSessionRows` 或 IPC 路由改成"公共契约"：那两者仍是 daemon-internal（含 dashboard-only 字段、鉴权 host-only），公开只能通过 façade 转译。
- 未实现 park/close 主动接口：明确列入"后续 Botmux 补充"，本任务只观察不控制。

## 交付路径变更纪要（2026-09-22）
### Captain 决定：放弃 no-mistakes，直接 rebase master
- 背景：no-mistakes pipeline 上一轮 push 后 PR `#1499` 的 GitHub `bun-test` 一直失败，根因是 `test/worker-kimi-effort.integration.test.ts` 依赖 vitest-only `expect.poll`，在 bun 腿下 `expect.poll is not a function`。同一问题已在 master `#1510`（commit `773ff53b`）用 runner-agnostic 15s deadline loop + AST 守卫（`test/bun-runner-selectors.test.ts`）修好；分支只是没吸收。
- Captain 明确指令：停止 no-mistakes，改在同一 task/worktree/PR 上把分支 rebase 到最新 `origin/master`；不合并 PR，不裸 force-push，只允许精确 `--force-with-lease=<branch>:<old-remote-sha>`；任何 custody 未释放、远端漂移、lease 不匹配或冲突不明立即停下。
- 保留的原任务范围（未变）：本次交付仍是 observe seam v1 契约，本节仅记录交付路径重整；未新增/修改产品接口，未夹带无关改动。

### 执行过程与证据
1. **释放 pipeline custody**
   - `no-mistakes axi abort --run 01M33KT67C8HYAAMEAQ4BRPDP1` → `aborted=true, run_status=cancelled`；随后 `01M31N3MA9P3XSVKM6735ZA5B1` 自启为 watch，再次 abort → `cancelled`。
   - `no-mistakes axi status` 复核：`run.status=cancelled`、无 `active_steps`、无 `awaiting_agent`；outcome=cancelled。
2. **fetch + 记录 SHA + 建可恢复锚点（仅本地 refs，未动分支/未 push）**
   - `git fetch origin master` + `git fetch fork fm/botmux-worker-runtime-observe`。
   - fetch 后 SHA（`ls-remote` 复核一致）：
     - local HEAD = `25fc3ccc1e511f9fd91814b3efcf453980596060`
     - fork PR head = `5fdf116f91149dc83fd502aac900798b01aad6c0`（lease 基线）
     - origin/master = `6ab79c78020f1eda362592dd0c558c2b0b8773fc`（含 `#1510` = `773ff53b`）
   - 恢复锚点（`git update-ref`）：
     - `refs/heads/recovery/botmux-worker-runtime-observe-local-25fc3ccc-prerebase` → `25fc3ccc…`
     - `refs/heads/recovery/botmux-worker-runtime-observe-fork-5fdf116f-prerebase` → `5fdf116f…`
     - `refs/heads/recovery/botmux-worker-runtime-observe-origin-master-6ab79c78-prerebase` → `6ab79c78…`
     - 保留既有 `refs/heads/recovery/botmux-worker-runtime-observe-dcfe08f6` → `dcfe08f6…`
3. **对齐 authoritative + rebase master**
   - `git reset --hard 5fdf116f…`（把本地分支精确对齐 PR authoritative head，含 pipeline 已推 fix commits）。
   - `git rebase 6ab79c78…`（14/14 commits replay 成功，**无冲突**）。
   - rebase 后 HEAD = `fd043325d6158fc634cb65457b4175553d73b7ab`；`git status --porcelain` 空。
   - `git diff --shortstat 5fdf116f…fd043325` = `4 files changed, 224 insertions(+), 10 deletions(-)`，差异全部来自 rebase 吸收进来的 master 提交：
     - `src/services/bridge-fallback-gate.ts` + `test/bridge-fallback-gate.test.ts`（master 侧新增）
     - `test/bun-runner-selectors.test.ts`（`#1510` 引入的 AST 守卫）
     - `test/worker-kimi-effort.integration.test.ts`（`#1510` 把 vitest-only `expect.poll` 改为 runner-agnostic 15s deadline loop）
   - observe 相关文件未在 rebase 中被触动；未恢复被 `#1494` 取代的 statusline 提交。
4. **本地验证（vitest + bun test）**
   - `bun run build` 通过（tsc 主 build / scripts / test-mocks / dashboard 全部 OK；`public-api/session-observe*.js` 与其 `.map` 产物在位；`[build-audit]`、`[audit-embed]` 无告警）。
   - `bun run test -- --run` 目标集：`session-observe.test.ts` (16) / `session-observe-fetch.test.ts` (15) / `observe-command.test.ts` (7) / `observe-command.integration.test.ts` (1) / `zellij-observe-backend.test.ts` (15) / `observed-bots-store.test.ts` (16) / `bridge-fallback-gate.test.ts` (90) / `bun-runner-selectors.test.ts` (40) / `npm-binary-distribution.test.ts` (37) → **9 files / 237 tests passed，用时 12.66s**。含消费者 runtime import + 独立 type-resolution 用例 `"the packed public observe subpaths load and type-check for consumers"` 与完整 dist 排除守卫 `"the PUBLISHED tarball ships no runnable Node form"`。
   - 原 CI 失败路径复现：`bun test test/worker-kimi-effort.integration.test.ts` → 1 pass / 0 fail（1.85s），`expect.poll` 不再报错；`bun test test/bun-runner-selectors.test.ts` → 40 pass / 0 fail（3.98s）。
5. **精确 force-with-lease 推送 + 复核**
   - push 前 `git ls-remote fork` 再次核验 remote head = `5fdf116f…`（lease 基线未漂移）。
   - `git push fork fm/botmux-worker-runtime-observe --force-with-lease=fm/botmux-worker-runtime-observe:5fdf116f91149dc83fd502aac900798b01aad6c0`
   - 推送输出：`+ 5fdf116f...fd043325 fm/botmux-worker-runtime-observe -> fm/botmux-worker-runtime-observe (forced update)`。
   - `git ls-remote fork` 复核 = `fd043325…`；`gh pr view 1499` `headRefOid` = `fd043325…`。
6. **PR #1499 GitHub CI 终态（run `35696121680`）**
   - 状态：`status=completed`、`conclusion=success`。
   - 9 check 全部 SUCCESS：`build`、`test (1/3)`、`test (2/3)`、`test (3/3)`、`bun-test`（原失败项，现绿）、`bun-binary`、`bun-binary-musl`、`bun-binary-darwin`、`test`（require-every-shard）。
   - PR 元数据：`state=OPEN`，`isDraft=false`（rebase 完成后 GitHub 侧因新 push 触发 status 更新为 Ready），`mergeable=MERGEABLE`，`mergeStateStatus=BLOCKED`（`reviewDecision=REVIEW_REQUIRED`，等待人工 review），未合并、未 tag。

### 最终快照
- PR: <https://github.com/deepcoldy/botmux/pull/1499>
- authoritative head: `fd043325d6158fc634cb65457b4175553d73b7ab`（fork/PR 一致）
- base: `deepcoldy/botmux:master @ 6ab79c78020f1eda362592dd0c558c2b0b8773fc`（含 `#1510` `773ff53b`）
- CI run: <https://github.com/deepcoldy/botmux/actions/runs/35696121680> — 全 SUCCESS
- 未运行 no-mistakes、未合并 PR、未裸 force-push、未夹带无关改动。

### 已识别但不修的旁路（后续可提独立 PR，不属本任务范围）
- 维护者旧评论中的 `refusing to mark PR ready: intent skipped` seam 缺陷：no-mistakes 在 `--only push,pr` 场景下会把已 Ready 的 PR 降为 Draft，再因 `intent skipped` 拒绝提升，且无跨 run same-head evidence reuse seam。这次是通过 rebase + 精确 force-with-lease 绕开该 seam，最终 PR 恢复为 Ready 由 GitHub 侧根据新 head 与 review 需求驱动。
- 若后续需要 CLI/TS 消费者观测更细的 `phase` / `queue count` / `parkReason`，仍需 Botmux 侧新增 durable 事实源；本 seam 已保留 schema 扩展空间。
