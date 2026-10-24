# 有状态定时任务：执行账本 + 「直到完成」

## 背景

Agent 常说「等 X 发生后我再做 Y」（等 PR 合入、等某天之后清理、等有人触发一次再验证）。目前只能为每件事手写一个定时任务，把「怎么判断、做完怎么停」全写进提示词里，问题有三：

1. **执行情况不可见**。任务只记最近一次 `lastStatus`；错过执行窗口（daemon 停机、上一轮超时）时 tick 直接把 `nextRunAt` 快进到下一次，只留一行日志，不进任何状态。
2. **失败即终止**。one-shot 任务无论成败跑一次就 `enabled=false`；daemon 重启打断的那一轮也被记成失败并停用。「到某天去做 Y」只要那一刻出错就再也不会做。
3. **没有终点**。任务不知道自己「做完没有」，只能靠提示词里约定 `--schedule-remove-self` 删除自己；没做完就无限期跑下去，或者被人忘掉。

## 目标

- 每个定时任务都有**执行账本**：执行、跳过、失败、错过准点各多少次，连续失败几次。没执行的也要留下记录。
- 新增**「直到完成」模式**（`--until-done`）：任务带「做完没有」的状态。没做完就按计划继续执行，出错和错过都会自己补上，直到 Agent 显式标记完成，或到截止时间做最后一次收尾。
- **通知按需**（`--notify`），默认不打扰人。
- 不另起一套机制：复用现有定时执行、权威存储（SQLite authority + JSON 投影）、会话投递与 scheduled turn 自管理链路。

非目标：前置条件（Bash gate）仍只在 Dashboard 配置；Dashboard 界面本期不改（任务 JSON 已带新字段）；bot 代为创建（delegated）的任务本期不支持「直到完成」。

## 数据模型

`ScheduledTask` 新增三个可选字段，旧任务缺省即旧行为：

```ts
runStats?: {
  dispatched: number;          // 模型 turn 已投递（不代表 turn 已结束）
  skipped: number;             // 前置条件 / 工作日历跳过
  failed: number;              // 投递前或投递中失败（含 daemon 重启打断）
  missed: number;              // 没有在准点执行的计划次数
  consecutiveFailures: number; // 自上次成功投递以来连续失败次数
  lastMissedAt?: string;
  failingNotifiedAt?: string;  // 本轮连续失败已通知过（成功后清空）
};
untilDone?: {
  status: 'open' | 'done' | 'expired';
  deadline?: string;           // ISO；到点做最后一次执行
  retryMinutes?: number;       // 仅 one-shot：没做完时隔多久再执行（默认 1 天）
  attempts: number;            // 「直到完成」期间已投递的次数
  finalRunId?: string;         // 正在进行的截止收尾执行
  finalFailures?: number;
  finalRetryAt?: string;
  doneAt?: string; doneNote?: string; expiredAt?: string;
};
notify?: Array<'failing' | 'expired'>;
```

`untilDone` 的配置部分（deadline / retryMinutes）与 `notify` 进入 `canonicalScheduleInput`；运行态字段不进，旧任务的 canonical hash 不变。

## 状态与执行规则

| 情况 | 普通任务 | 「直到完成」任务（status=open） |
|---|---|---|
| 正常投递 | `dispatched+1` | 同左，`attempts+1`；one-shot 不停用，`nextRunAt = 现在 + retryMinutes` |
| 投递失败 / 重启打断 | `failed+1`；one-shot 停用 | 同左计数；**不停用**，one-shot 在 `min(retryMinutes, 60 分钟)` 后重试，循环任务等下一次 |
| 错过准点（超出补跑窗口） | `missed+1`，照旧快进到下一次 | `missed+1`，**立即补跑一次**（多次错过合并为一次），再接上正常节奏 |
| 前置条件 / 日历跳过 | `skipped+1` | 同左 |
| 到达 deadline | — | 立即做**最后一次执行**（提示词注明是收尾），投递后 `status=expired` 并停用；收尾本身失败按 60 分钟重试，累计 3 次仍失败也置为 expired |
| Agent 运行 `botmux schedule done` | 不适用（报错） | `status=done`，记录 `doneAt/doneNote`，停用，不再执行 |

关闭（done / expired）的任务 `disabledReason='once_completed'`，authority 状态为 `completed`；已在进行中的那一轮 scheduled turn 与「已完成的 one-shot」享有同样的收尾权限（继续 `botmux send` 等）。关闭后的任务不能 `resume`，需要重新创建。

每次执行时 daemon 在提示词末尾追加一段运行上下文：任务 id、第几次执行、截止时间，以及「完成后运行 `botmux schedule done self --note …`；没完成直接结束本轮，系统会按计划再来」。截止收尾那一轮改为「这是最后一次执行，按现状收尾」。所以创建任务的人只写「要等什么、要做什么」，不用在提示词里自己维护循环和停止逻辑。

## 命令

```bash
# 创建：等条件成立后做事，每天 10:07 检查，最晚 11/20
botmux schedule add "7 10 * * *" "PR #2195 合入后把集群切回 upstream" --until-done --deadline 2026-11-20

# 创建：某天之后去做，没做成每 6 小时再试
botmux schedule add "2026-10-30T10:00" "删除升级前备份" --until-done --retry-every 6h

# 标记完成（在任务自己的 scheduled turn 里；人或管理员也可以指定 id）
botmux schedule done self --note "已切回 upstream，worktree 已清理"

# 查看：每个任务多一行状态与账本
botmux schedule list
#   状态: 直到完成 · 进行中 · 已执行 3 次 · 截止 2026/11/20 00:00
#   账本: 执行 3 · 跳过 0 · 失败 1 · 错过 1（最近 2026/10/26 10:07）
```

`--notify failing,expired`（可选，默认不通知）：连续失败 3 次时（每轮连续失败只通知一次）、截止收尾发起时，@ 任务创建人。通知始终由任务所属的 bot 发送（`ownerOpenId` 只在这个应用下有效）：创建时用的也是这个 bot，就发到创建任务的话题 / 群；否则发到执行群。

## 权限

`done` 走现有 `SCHEDULE_MANAGED_MUTATE_ROUTE`：
- 任务自己的 scheduled turn 可以对自己执行 `done`（与 `pause` / `remove` 自管理同一套校验，delegated 任务仍需 `selfManage`）；
- 当前真人管理员、宿主终端管理员可以对任意任务执行 `done`。

创建时 `untilDone` / `notify` 只在 direct（真人 turn）与宿主终端路径接受；bot 代为创建的 delegated 路径直接拒绝，不扩大现有授权面。

## 影响面

- `core/scheduler.ts`：tick（截止判定、错过补跑与计数）、run 结算、enable/resume、新增 `completeTask`、通知回调。
- `services/schedule-store.ts`：JSON 投影的字段迁移、legacy 结算路径同步计数与「直到完成」规则。
- `daemon.ts`：执行回调追加运行上下文；`done` 动作；创建路由接收新字段；通知投递。
- `cli.ts`：`schedule add` 新参数、`schedule done`、`schedule list` 状态行；内置 skill 文档。
- 旧任务、Dashboard、前置条件、工作日历、多群任务行为不变；新字段全部可选。
