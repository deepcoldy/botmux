# 资源占用优化（perf/resource-optimization）

针对 daemon 长跑场景的一批性能/资源修复：消除几处随时间无限增长的内存表、
削减每条消息的冗余写盘、以及空闲会话每 2 秒一次的无效屏幕快照。

本文记录**改了什么、怎么验证「正确」、怎么验证「真省资源」**，并贴出实测数据。

---

## 1. 改动清单

| # | 问题 | 修复 | 主要文件 | 正确性验证 | 收益验证 |
|---|---|---|---|---|---|
| 1 | 授权状态表 `grant-pending` 永不回收：每个「被拒用户 × 群」留一条 `denied`，daemon 生命周期内不删（代码注释已自承认） | TTL 回收：`isThrottled` 冷却到期即时删除；`openPending*`/`markDenied` 触发每分钟一次全表清扫，回收过期 denied 与废弃 pending | `src/im/lark/grant-pending.ts` | 单测 + 变异测试 | 基准 A（同类） |
| 2 | `restartCounts` Map 永不删除：每个崩溃过的 session 永久占位 | `closeSession` 里 `restartCounts.delete(sessionId)` | `src/core/worker-pool.ts` | 读码 + 不回归 | — |
| 3 | `lastRepoScan` 按 chatId 存整个 `ProjectInfo[]`，永不删 | 改用 `BoundedMap(500)` | `src/daemon.ts` | 单测（BoundedMap） | 基准 A |
| 4 | 三处 chat 缓存只在读时判 TTL、从不淘汰，按 chat 数无限累积 | 改用 `BoundedMap(1000)`（TTL 管新鲜度，cap 管条数） | `src/im/lark/client.ts`、`src/im/lark/event-dispatcher.ts` | 单测（BoundedMap） | 基准 A |
| 5 | `session-store.save()` 每条消息被调多次，很多次序列化后与磁盘逐字节相同却照样 write+rename | 先读盘原文比对，相同则直接 `return`（不写） | `src/services/session-store.ts` | 单测 + 变异测试 | 基准 B |
| 6 | worker 屏幕刷新定时器每 2s 无条件做一次 tmux capture + 新建/销毁一个 xterm-headless，空闲会话也照跑 | 自上次快照以来 PTY 无新输出则跳过整个 capture（屏幕只由 PTY 输出驱动，必经 `onPtyData`）；状态切换仍用缓存内容照常发送 | `src/worker.ts` | 读码（不变式）+ 不回归 | 基准 C |

新增通用工具 `src/utils/bounded-map.ts`：`extends Map`，超容量按插入序淘汰最旧项，对调用方透明（get/set/has/delete 语义不变）。

---

## 2. 怎么验证「改得对」——单测 + 变异测试

光「测试通过」不够，得证明**去掉修复后测试会变红**，否则断言可能恒真。

```bash
npx vitest run test/bounded-map.test.ts test/grant-pending.test.ts test/session-store.test.ts
#  Test Files  3 passed (3)
#       Tests  54 passed (54)
```

- `test/bounded-map.test.ts`（6 个，新增）：容量上限、插入序淘汰最旧、重复 set 不增长只更新值、`instanceof Map`、删除后空位复用、非法容量抛错。
- `test/grant-pending.test.ts`（+4，共 9 个）：用 `vi.useFakeTimers()` 推进时间 + 测试探针 `_tableSizeForTest()` 断言**表真的缩小**——denied 过冷却即时删；1000 个被拒用户不撑爆表；废弃 pending 被周期清扫；**新鲜 pending 不被误删**（防过度回收）。
- `test/session-store.test.ts`（+1，共 39 个）：真临时目录，用 **inode 变化**判定是否真写盘（save = write-tmp + rename，每次真写都换 inode）：无变化 update → inode 不变（跳过）；改字段 → inode 变（写了）。

**变异测试**：临时把三处修复逻辑改坏重跑，5 个用例立刻变红——证明断言确实盯着被改的那行：

```
× skips the disk write when an update produces byte-identical content   (session-store)
× caps entry count and evicts the oldest-inserted key                   (BoundedMap)
× never exceeds the cap no matter how many distinct keys are added       (BoundedMap)
× a flood of denied users does not grow the table without bound         (grant-pending)
× the periodic sweep reclaims abandoned pending cards                   (grant-pending)
```

改回后全绿。

> #2（`restartCounts.delete`）与 #6（worker 屏幕门控）没有新增独立单测：前者是 close 时从 Map 删一个 key，走真 `closeSession` 需 mock ~15 个模块、不成比例；后者正确性在一条不变式上（「屏幕内容只由 PTY 输出驱动，而 PTY 输出必经 `onPtyData`，它同时更新 `lastPtyActivityAtMs` 并喂 renderer」），靠读码 + 现有 streaming/display-mode 测试不回归保证。`changed`/`send` 判定一字未改。

---

## 3. 怎么验证「真省资源」——基准

```bash
pnpm bench:resource          # 三项，A 的堆数字需 --expose-gc（脚本已带）
pnpm bench:resource --json   # 末尾附机器可读 JSON
```

脚本：`scripts/bench-resource.ts`。每项在同一进程里构造**「修复前」「修复后」两条等价路径**对比，
只测被改动那一段（read/parse 等两条路径都做的工作不计入差值）。

### 实测数据（Node v24，本地 macOS；规模/绝对值与机器相关）

```
=== A. 无界 Map（修复前）vs BoundedMap（修复后） ===
  插入 200,000 个不同 key（cap=1000）：
    修复前(裸 Map):     保留 200,000 条, 堆 +25.31 MB  ← 永不回收
    修复后(BoundedMap): 保留 1,000 条, 堆 +154.6 KB
    → 堆占用约 168× 更省，且封顶不随时间增长

=== B. session-store 冗余 save：写盘(修复前) vs 读+比对跳过(修复后) ===
  文件含 50 个会话，2000 次内容不变的 save：
    修复前: 820 ms  (2000 次 write+rename)
    修复后: 169 ms  (跳过 2000/2000 次写, 0 次 rename)
    → 单次冗余 save 提速 4.9×，磁盘写入 2000→0
  文件含 200 个会话，2000 次内容不变的 save：
    修复前: 1959 ms  (2000 次 write+rename)
    修复后: 657 ms  (跳过 2000/2000 次写, 0 次 rename)
    → 单次冗余 save 提速 3.0×，磁盘写入 2000→0

=== C. worker 屏幕刷新：每个空闲 tick 的 capture 成本（修复后跳过） ===
  单次 capture(new Terminal + write + readViewport + dispose): 1.44 ms
  修复前: 每个空闲会话 30 次/分 = 43 ms/分钟 CPU（PTY 没动也照跑）
  修复后: PTY 静默时 0 次
  → 10 个空闲会话省 0.43 s/分钟；100 个省 4.3 s/分钟（下限，未含 tmux 子进程）
```

### 解读

- **A（内存）**：模拟长跑 daemon 见过的 chat/session 规模。裸 `Map` 把 20 万条全留住、25 MB 永不回收；`BoundedMap` 封顶在 1000 条。代表 #3 `lastRepoScan` 与 #4 三处 chat 缓存的修复，收益随 chat 数放大。#1 grant-pending 的封顶由 fake-timer 单测证明（denied 洪峰 1000→1）。
- **B（磁盘）**：每次内容不变的 save 省掉一次「全量序列化 + 写临时文件 + rename(fsync)」。**注意**：① 只有内容没变的 save 受益，每条消息里有几次冗余取决于负载，真实收益 = 冗余次数 × 单次节省；② 读盘+merge 两条路径都做（没省），省的是 write+rename 与 SSD 写损耗。
- **C（CPU）**：每个空闲会话原本每分钟 43ms 无效 capture，修复后 PTY 静默即 0。这是**下限**——真实 capture 还含一次 tmux `capture-pane` 子进程/socket 往返，比 1.44ms 更贵。收益随并发空闲会话数放大。

---

## 4. 边界与局限

- 以上是**受控微基准 + 建模**，不是端到端 daemon profiling。要拿真实负载下的总收益，需把 daemon 挂上 IM 流量用 `--prof` / `clinic` 采样（需可连飞书的环境）。
- B 的「×倍」是**单次冗余 save** 口径，不是整体吞吐。
- A、C 的收益随规模（chat 数 / 并发会话数）放大——这正是这类资源问题的特征。

---

## 5. 未改动（建议后续）

- worker 的 Claude bridge 每秒走一遍 `/proc/<pid>/fd`（仅 Linux adopt 模式）——可节流，但行为敏感、平台相关。
- `event-dispatcher` 每条消息把 `message.content` 反复 `JSON.parse` 3–5 次——可 memoize。
- session-store 每消息多次写入的**彻底**合并需要带崩溃安全的批写机制（本次只做了零风险的「相同即跳过」）。
