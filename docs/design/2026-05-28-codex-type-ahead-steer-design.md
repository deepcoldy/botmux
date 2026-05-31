# Codex type-ahead steer-aware 归因 — 设计

日期：2026-05-28　分支：`worktree-codex-type-ahead`

## 背景

botmux 此前对 codex 强制串行（忙时消息排队、等 idle 才逐条发），原因是 fallback 桥的 `CodexBridgeQueue` 单 `collecting` 指针归因没在 type-ahead 的 back-to-back user_message 排序下验证过。

申晗要求支持 codex type-ahead。第一版「直接摘 gate + 置 `supportsTypeAhead`」被 Codex review 否决并经实测推翻：

- codex 0.134.0 的忙时投递是 **active-turn steer**（消息进 pending_steers → steer_input 注入当前 active turn 的 pending_input，下一个采样边界 drain），**不是** CoCo 那种"等当前 turn 完整结束再处理下一轮"。

## 实测的两种 rollout 形态（codex-cli 0.134.0）

1. **无 tool_call**（msg1=数到300）：`user1 → asstFinal1 → user2 → asstFinal2`（分开两 turn，各自一条 final）。
2. **有 tool_call / steer-merge**（msg1=`sleep 18` shell）：`user1 → user2 → assistant_final`（msg2 在 tool 完成后 steer 进同一 turn，**合并成一个 turn、只产出一条合并 final**）。

形态 2 打破单 `collecting` 假设：user2 把 collecting 切到 t2 → assistant_final 关闭 t2 → t1 留队首且无 finalText → `drainEmittable()` 在队首永久阻塞 → 整个 fallback 队列楔死。

## 方案 A（采纳）：移植 Claude 的 HOL-block-drop

Claude 的 `BridgeTurnQueue.handleTurnStart`（bridge-turn-queue.ts:268）已解决同类问题：新 turn-start 到来时，若正在 collecting 的旧 turn 没产出任何 assistant 文本，就丢弃旧 turn（模型已 move on）。

把等价逻辑移植到 `CodexBridgeQueue.ingest` 的 `user` 分支：

> 处理一个 `user` 事件时，先用既有的 tooOld / fingerprint / adopt-local 判定算出它是否会**真的启动一个 turn**（`willStartNext` 命中 next pending，或 `willSynthLocal` 合成 local turn）。**仅当其一成立**且存在 `collecting` 且其 `finalText === undefined` 时，从 queue 移除该 collecting turn 并清空 `collecting`，然后照常起新 turn / 合成 local。

> 把 HOL-drop 和实际 turn-start 统一到同一套判定（而非给 HOL 单独一条 freshness 规则），让 5s-skew 容忍、fingerprint、adopt-local 三个入口共用一个不变量：重放历史事件 tooOld → 不启动 turn → 不会误丢；非匹配 stray user（非 adopt）被忽略而非当作 turn 边界。
>
> （早期 v2 曾用独立的 `ev.timestampMs >= collecting.markTimeMs` 做 HOL 新鲜度，但 turn-start 容忍 5s skew 且 `markTimeMs` 经 `Math.max` 不回退，导致早于 mark 几秒的合法 live 事件不触发 HOL-drop → 楔死。v3 统一判定后此 P1 消失。）

### 各形态行为

- **形态 1（分开）**：user2 到来时 t1 已有 finalText（asstFinal1 已关闭、collecting 已是 null）→ 不触发 drop → t1、t2 都正常发。**与现状一致。**
- **形态 2（merge）**：user2 到来时 collecting=t1 无 finalText → 丢弃 t1 → t2 起、合并 final 归 t2 → 发一次、不楔死。msg1 不单独出 fallback——但 codex 本就合并成一条回复，合并 final 已覆盖 msg1。
- **N 条连续 steer**（user1→user2→user3→asstFinal）：每来一个新 user 丢弃前一个无 final 的 collecting turn → 只有 t3 发合并 final。

### 关键正确性点

- 丢弃的是已 `started` 的 collecting turn；`queue.find(t => !t.started)` 本就跳过它，故 drop **不影响**新 turn 的匹配，只是解除队首阻塞。
- 起始的 `<environment_context>`（role=user）：fingerprint 不命中、非 adopt 不合成 local → `willStartNext/willSynthLocal` 均 false → 不 drop（且 collecting 此时本就为 null），安全。
- 重放安全：ingest 对 uuid 幂等（seen 集合），已见 user2 不会二次 drop。
- 历史保护：复用 turn-start 的 tooOld 判定——旧的重放 user 事件 tooOld → 不启动 turn → 不触发 HOL-drop，不会误丢正在 collecting 的实时 turn（与 v2 的独立 markTimeMs gate 不同，这里和 turn-start 共用同一 5s-skew 不变量，避免两套规则不一致）。
- suppression window：t1 被丢后只 drain t2，t2 的窗口锚定 user2 的 dequeue 时间戳（既有 markTimeMs override），合并回复的 botmux send 落在 t2 窗口内 → 正确抑制。

## 方案 B（不采纳）

coalesce 把 t1+t2 合并成一个发射单元、单条 final 发一次但 suppression window 同时记两个 turn。更"账目清楚"但要动 suppression 逻辑，且只有一条回复、收益不大。

## 测试（回归）

在 `test/codex-bridge-queue.test.ts` 增补：

1. **steer-merge**：mark t1,t2；ingest `user1 → user2 → assistant_final`（user2 在 asstFinal 之前、无 intervening final）→ t1 被丢、t2 拿合并 final、`drainEmittable()` 返回 [t2] 不楔死。（不加 HOL-drop 时此测试应失败——先红后绿）
2. **分开形态**：`user1 → asstFinal1 → user2 → asstFinal2` → 两 turn 都发，HOL-drop 不触发。
3. **N-steer**：`user1 → user2 → user3 → asstFinal` → 只 t3 发。
4. **历史保护**：collecting 中来一个早于 markTimeMs 的 user 事件 → 不丢 collecting。
5. **env_context 兜底**：collecting 为 null 时来 user 事件 → 不报错、不误丢。
6. suppression-window describe 块补一个 merge 情形的抑制判定。

## 改动面

- `src/services/codex-bridge-queue.ts`：ingest user 分支加 HOL-drop。
- `test/codex-bridge-queue.test.ts`：上述用例。
- worker.ts / codex.ts / coco.ts / types.ts 注释：把"出队时写 rollout→交错安全"修正为"active-turn steer + HOL-drop 归因"。

## 验收

- 新增 + 既有 codex-bridge-queue / write-input 测试全绿。
- 端到端：tool_call steer-merge 与无-tool 分开两种实测路径，fallback 都能正确发、不楔死、不误报发送失败。
- 重新交 Codex review。
