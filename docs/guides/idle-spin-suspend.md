# 空闲自旋回收（idle-spin suspend）

## 背景

TRAE CLI 0.214.x 会在 `~/.trae/skills` 下持有数千个 inotify watch，并把 skill 目录的
`IN_OPEN` 事件当成需要重新扫描的信号。打开 skill 目录又会产生新事件，形成自激循环。
2026-11-10 在 32 核开发机上实测：55 个 traex 进程、load 约 33，其中约 53 个会话已空闲，
但空闲会话合计仍消耗约 17.5 个逻辑核；真正工作的会话只有约 0.76 核。

TRAE CLI 本身无法修改，所以修复落在 BotMux 的会话生命周期：把“空闲但持续烧 CPU”的
worker 挂起，保留会话与历史，下一条消息冷恢复。

## 两层策略

### Layer 1：空闲自旋识别（默认开启）

每个 daemon 只采样**本 bot 的严格候选 session**：

- 采样对象是 worker 进程子树 + CLI attestation 的 `cliPid` / `enginePid` 子树；
  tmux 后端下 CLI 不是 worker 子进程，必须靠 attestation 的 pane/CLI pid 归属。
- `localProcessAttestation` 优先；只有 attestation 完全缺失时才用
  `.botmux-cli-pids/<pid>` marker 兜底。marker 必须通过 `procStart` 校验。
- 同一 pid 被多个 session 声明、attestation 的 `workerGeneration`/`procStart` 不一致、
  或进程树超过 512 pid / 256 线程时，该会话 fail-closed 跳过，绝不截断后低估。
- CPU 单位是**单核百分比**：`20` 表示约 0.2 个逻辑核，不是整机 CPU 百分比。
- 默认连续 3 个 30s 采样周期超过 20%，且会话已连续空闲 ≥5 分钟，才挂起。
- 挂起前现读一次 CLI 进程（attestation 的 `cliPid` / `enginePid`）的全部线程 `children`：
  只要还有存活子进程（TRAE `background_shell` 后台任务、dev server、构建、watcher、MCP 服务等）
  就不挂起并清零连续计数。实测 TRAE 0.214.1 的后台任务在本轮结束、屏幕回到空闲后仍挂在
  traex 进程下（`sleep ← zsh ← traex ← tmux server`），而 TRAE 不上报后台任务数，严格 guard
  看不到这类工作；挂起会连同子进程一起销毁。读不到（根进程消失/被复用、task 目录不可读、
  超线程上限）一律视为有子进程，fail-closed。
- 命中后走现有 `suspendWorker`（reason `idle_spin`）：保留 `session.status=active`、
  写 `suspendedColdResume`、下条消息冷恢复；不新增强杀路径。

### Layer 2：宿主过载兜底（默认开启）

- load / 内存 / swap 阈值复用现有 `hostOverloadAlert` 的解析器
  （`resolveOverloadThresholds()`，含 `BOTMUX_OVERLOAD_*` env 覆盖）；即使告警本身没开启，
  也会使用同一套默认阈值。
- 新增整机 CPU 维度（默认进入 85%、退出 70%），由 `evaluateOverload` 的同一套滞回状态机处理。
- 连续 3 个采样周期处于过载才第一次回收；同一 episode 内每个采样周期继续回收，直到没有
  合格候选或压力退出；单轮最多 16 个；只有“episode 结束”或“某一轮 0 候选”才进入
  10 分钟冷却。
- 只回收 **Layer 1 自己可以动的那批会话**：严格候选（同一个 `selectIdleSuspendCandidates`）
  ∩ `cliIds` ∩ traex 身份为 `current` ∩ CLI 进程无存活子进程。Layer 2 只是去掉“单会话 CPU
  超阈值”这一条，不扩大 CLI 范围——默认 `cliIds: ["traex"]` 时，整机过载**不会**挂起
  Claude Code、Codex 等其它 CLI 的空闲会话；要让它们参与需在 `cliIds` 里显式加入。
- 每个 daemon 本地判定、只回收自己的 idle worker；per-daemon 归属天然避免多 bot 重复回收，
  也不依赖 notifier daemon 在线。通知仍由 `hostOverloadAlert` 的边沿卡负责，卡上补一行
  “本 bot 已自动挂起 X 个”；不新增 DM。

## 严格 guard

两层共用 `selectIdleSuspendCandidates` 的严格集合，再叠加 `cliIds`、traex 身份与“CLI 无存活子进程”三条：

- 基础：live worker、`session.status=active`、`workerReady`、`lastScreenStatus=idle`、
  非 adopted、非 locked、后端可恢复（tmux/herdr/zellij/zmx；pty/riff/mojo 不参与）。
- 未结算工作：pending repo / raw input / follow-up / cascade、TUI prompt、agent attention、
  usage limit、background task、final output delivery、未接受的 CLI 输入、已接受但未终止的
  turn、pending suspend、remote close/shutdown。
- 激活/定时任务：`session.queued`、`queuedActivationPending`、`queuedActivationTail`、
  `initialStartPending`、`pendingPrompt`/`pendingTurnId`、`deferredScheduleRun`、
  `deferredScheduleUndeliveredTurnId`/`deferredScheduleUnconfirmedTurnId`。
- 现有功能保护：`promptCacheKeepalive`、`idleAutoCompactArm`、
  `idleAutoCompactWarmSince`、`idleAutoCompactPendingNotice`、
  `idleAutoCompactDispatchedTurnId`。
- 身份：traex 必须 `observeTraexInstall` 为 `current`（`not-traex` 不适用）；固定旧版本
  (`stale`) 或身份不明确 (`unknown`) 一律不自动回收（两层都适用）。
- 后台工作：CLI 进程下有存活子进程（后台任务、工具 shell、MCP 服务……）不自动回收（两层都适用）。
  配了常驻 MCP 服务的 TRAE 会话因此不会被自动挂起，与本改动之前的行为相同。

重启后：连续计数不持久化；restored 会话如果没有 `idleSinceAt`，使用
`conservativeIdleActivityAt`（持久化 lastMessageAt / 运行时 lastMessageAt / spawnedAt 取 max）
作为保守空闲起点。若 restore 后 `lastScreenStatus` 还是 undefined，则等 worker re-attach 的
第一次 screen update，不把未知状态当 idle。

## 配置

per-bot `idleSpinSuspend`（`bots.json` 或 `botmux config set idleSpinSuspend '{...}'`）：

```json
{
  "enabled": true,
  "cliIds": ["traex"],
  "cpuPercent": 20,
  "consecutiveSamples": 3,
  "sampleIntervalSeconds": 30,
  "minIdleMinutes": 5,
  "maxSuspendsPerSample": 8,
  "hostPressure": {
    "enabled": true,
    "afterSamples": 3,
    "cooldownMinutes": 10,
    "maxSuspendsPerPass": 16,
    "enterCpuPercent": 85,
    "exitCpuPercent": 70
  }
}
```

- `cpuPercent`：**单核百分比**，`20` = 0.2 核。
- `minIdleMinutes`：最小 1（0 会让严格选择器直接返回空集，等于静默关闭 Layer 1）。
- `cliIds`：两层的作用范围，默认只对 `traex` 生效。其他 CLI（如 claude-code 的
  prompt-cache keepalive / idle auto-compact）需要显式 opt-in。
- `enabled: false` 或 `cliIds: []` 关闭两层；`hostPressure.enabled: false` 只关 Layer 2。
- 配置每 tick 重新读取，热加载，无需重启。
- kill switch：`BOTMUX_IDLE_SPIN_SUSPEND=0`（两层都关）、
  `BOTMUX_HOST_PRESSURE_RECLAIM=0`（只关 Layer 2）。

## 非 Linux

进程 CPU 归属依赖 Linux procfs。darwin 上 detector 默认 disabled 并只记一次日志；
不自动回收。现有手动过载卡仍可用。

## 开销

采样只遍历候选 session 的子树，并缓存 pid 集合：

- 30 个候选 / daemon：平均约 3.5ms/采样，p95 约 19–27ms（全树刷新那一轮）。
- 50 daemon × 2 次/分钟外推约 0.6% 单核平均；daemon 定时器带 ±20% jitter，
  避免 fleet 同步扫 `/proc`。
- 不读 `cmdline`、不读 `smaps_rollup`，不做 `--version` 探测。
- “CLI 是否有存活子进程”只在真要挂起前（Layer 1 连续计数达标、Layer 2 回收轮）对相关会话
  做一次全线程 `children` 读取，平时采样不增加开销。

## 与 #3252 / #3273 的关系

- #3252 缓解的是“安装切换后旧进程不退出”，本改动不碰 install-change 回收路径。
- #3273 的跨 bot runtime 交接尚未进入 master；本改动只在严格 guard 里补
  `deferredScheduleRun` 等字段，保证不打断 deferred/held 契约，与交接代码正交。
  合入后按 master 重新 rebase 即可。

## 验证

```bash
bun x vitest run --project unit \
  test/idle-spin-config.test.ts \
  test/idle-spin-sampler.test.ts \
  test/idle-spin-detector.test.ts \
  test/host-pressure-reclaim.test.ts \
  test/idle-worker-sweeper.test.ts \
  test/host-overload-alert.test.ts

bun scripts/bench-idle-spin-fleet.ts 20
```
