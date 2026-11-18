# Antigravity 零注入：zmx 与 scratch 支持

目标：让 Antigravity（`agy`）在零注入模式（`promptInjection: 'none'`）下分别支持：

1. `agy + zmx` 后端（非 scratch）。
2. `agy + sandbox: "scratch"`（`pty` 与 `tmux` 后端，覆盖 Linux 全根 COW overlay 与 macOS APFS `clonefile` COW + Seatbelt）。
3. `zmx + scratch` 与 `ACP + zmx` 继续明确拒绝（fail-closed）。

## 1. zmx（非视口权威后端的确定性执行态收敛）

### 根因与边界

- Antigravity 的 `transcript_full.jsonl` / `transcript.jsonl` 中无工具调用的 `PLANNER_RESPONSE` 仅是候选终态（后台任务或同步 `Stop` hook 可能继续唤醒后续轮次）。
- `zmx history` 含滚屏且几何尺寸不受控，`backendScreenEvidenceIsAuthoritativeForMutation()` 刻意保持 `false`；不得信任 `zmx history` 中的 `? for shortcuts` 释放候选终态，也不得放宽其他 CLI 的共用屏幕可信度规则。
- `AGY_BOTMUX_TRANSPORT=acp` 依赖终端 OSC 完成帧，继续在创建后端前拒绝 `zmx`。

### 实现要点

- **原生 SQLite 执行态判定（`src/services/antigravity-execution-state.ts`）**：
  - 只读打开当前会话绑定的 `<geminiCliDir>/conversations/<conversationId>.db` 与 `<geminiCliDir>/conversation_summaries.db`（Protobuf 未知 varint 按最长 10 字节跳过，兼容 64 位时间戳与补码负数）。
  - 按 `idx ASC` 扫描 `executor_metadata`，定位首条满足 `last_step_idx >= candidateStepIndex` 的所属执行轮次：最新轮次额外要求 `last_step_idx >= MAX(steps.idx)` 且 `conversation_summaries` 处于 `CASCADE_RUN_STATUS_IDLE`、`not_fully_idle === 0`（含 `raw_summary` 后台任务计数与运行中子代理标记为 0）及 `step_count >= MAX(steps.idx) + 1`。
  - 若覆盖轮次以 `USER_CANCELED` 或 `ERROR` 终止，判定为 `discard_aborted`：安静轮询、type-ahead 下一轮 `USER_INPUT` 到来以及 `/new` 会话轮转前均丢弃半截候选并以 `turn_aborted` 结算队列与持久化账本，绝不作为已完成回复发出或跨轮重放；完成类终止则要求转写文件 `step_index` 追平 SQLite 后才放行空闲态（`prompt_ready`），杜绝提前冲刷排队消息导致串台。
  - 恢复旧会话后执行 `/new` 原生轮转时，空闲/忙碌探针实时跟随 `--log-file` 最新活跃会话 ID，避免受旧会话状态干扰。
  - 任一数据库缺失、损坏、锁冲突或尚未追平最新 step 时，一律保持 `hold` / `busy: true`（fail-closed）。
- **启动工作区信任与首轮门槛（`src/adapters/cli/antigravity.ts`、`src/core/cli-startup-blocker.ts`）**：
  - 非受限模式（`!disableCliBypass`）且 `agy >= 1.5.0` 时通过会话级 `--settings {"trustedWorkspaces":[...]}` 预信任当前工作目录（macOS scratch 下同步覆盖克隆后的 `chdirInSandbox`），避免新目录卡在信任弹窗。
  - 受限模式保留原生信任弹窗拦截（补充 `agy 1.5.x` 信任框识别规则）。

## 2. scratch（隔离视图与符号链接 fail-closed 解析）

### 根因与边界

- scratch 下 CLI 写入每会话隔离视图（Linux `<merged>`、macOS `<clonedHome>`），宿主侧 worker 与 daemon 所有读取入口（transcript bridge、`history.jsonl` 提交确认、`--log-file` 原生会话流日志、CoT 与模型 runtime、token/cost 统计、热重连与冷恢复）必须指向同一隔离副本，严禁回退宿主 `~/.gemini`。
- 符号链接 `$HOME`（如 `/home/u -> /data00/home/u`）在目标日志尚未创建时不能做整路径 lexical fallback；同时也不能对任意最近存在祖先做宿主 `realpath` 后回退宿主路径（跨 HOME 符号链接会逃逸回宿主）。

### 实现要点

- **严格隔离路径解析（`resolveScratchHomeSubpathStrict`，`src/services/scratch-host-view.ts`）**：
  - 仅对 `$HOME` 本身执行 `realpathSync`，匹配 `ScratchPathMapping[]`（映射缺失或目标根目录不可验证即返回 `null`）。
  - 在隔离根目录内逐段 `lstatSync` 遍历：仅允许已验证真实目录下的尾部 `ENOENT`（供延迟创建的日志使用）；遇到 `EACCES` / `EPERM` / `ELOOP` / `ENOTDIR`、悬空软链或越出隔离根的软链一律返回 `null`（fail-closed）；Linux 全根 overlay 内的绝对软链按 `<merged>` 根内展开，绝不交由宿主内核解析到真实 `/`。
- **macOS APFS clone（`src/adapters/backend/scratch-sandbox-darwin.ts`）**：
  - 将 `.gemini` 加入 `CORE_CLONE_HOME_DIRS`（必需 COW 克隆，失败拒绝启动；若宿主 `~/.gemini` 本身为同卷目录软链则解引用后 COW 克隆，跨卷或损坏软链直接拒绝）。
  - `suspend` 后冷恢复复用既有会话树时保留已物化的 `.gemini` 等副本，避免重复 `cp -cR` 嵌套覆盖会话内状态；`attachMacScratchSession` 与 `worker.ts` 热重连校验克隆目录存在，缺失时拒绝重连。
- **全链路接入与门禁更新**：
  - Worker 在 `buildArgs` 前锁存 scratch 隔离态，`--log-file` 不在宿主创建目录，而在沙盒准备完成后落入隔离视图（含 `wrapperCli` 包装启动场景下的 `--log-file` 与 `trustedWorkspaces` 重写，以及 macOS `sandbox-exec` 内部通过 `/usr/bin/env` 强制注入隔离 `HOME`/`TMPDIR`/`PATH`）。
  - Daemon `transcript-resolver.ts` 与 `cost-calculator.ts` 同时识别会话级 `sandbox === 'scratch'`、持久化 `scratch.json` 与机器级 `BOTMUX_SANDBOX=scratch`，隔离视图缺失时一律返回 `null`（fail-closed）。
  - `zeroPromptInjectionUnsupportedReason` 放行 `antigravity + zmx`（非 scratch）与 `antigravity + scratch`（`pty`/`tmux`），新增 `scratch_unsupported_for_backend` 明确拒绝 `zmx + scratch`。
