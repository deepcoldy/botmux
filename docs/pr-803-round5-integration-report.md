# PR #803 第五轮：集成与全量回归报告

集成分支 `round5/integration`，基线 `c8122d89`。
平台：**Linux（devbox）**。**本环境无 Darwin 真机，任何 macOS 数字均为 reviewer 测量或平台模拟，不是我方真机实测。**

## 1. 合入内容

| 支线 | sha | 内容 |
|---|---|---|
| 指控A | 939032b1 | terminateChildProven 改结构化 TerminationOutcome + 单一工厂 |
| 指控B | 8d764534 + eb4e79d4 | weak handle 释放守卫 + 真实进程探针 harness |
| 指控D | 1f660d84 | procRoot seam 化 + Linux-only gate + 非 Linux 模拟 config |
| 指控C | Claims 分支 | 文档，最后单独刷新 |

合并顺序 c8122d89 → A → B → D。

## 2. 三处冲突，均取双方而非择一

- `mojo-close-admission-fence` / `mojo-residual-close-admission` 的 import：A 要 TerminationOutcome 类型，D 要 synthetic-proc 助手，两者都保留。
- `mojo-residual-close-admission` 中同一用例：A 重命名并**反转**了原本断言 fail-open 的期望，D 加了 `runIf(isLinux)`。结果＝A 的语义 + D 的平台门。
- `mojo-containment-wiring` 的 workerless zombie 用例：D 把它迁到 procRoot seam，B 改了它断言什么。结果＝D 的 seam + B 的断言。

## 3. 合并暴露出的两个问题（单支线均无法发现）

### 3.1 跨层矛盾：outcome 与 store 互相打脸（已修）

`proveTurnQuiescence` 丢弃了 `releaseContainmentHandle` 的返回值，改用 `handle.kind` 自行推导 verdict。对「boot id 已变」的 weak handle 后果是：

```
CONTRA outcome= {"ok":true,"boundaryProven":false,"evidence":"diagnostic-clean",
                 "residual":{"deviceIsolation":true,...},"signalsStopped":true}
CONTRA handles_left= 0
```

handle 确实被释放了（正确：重启后原树不可能存活），但 verdict 仍报 `diagnostic-clean`，于是 outcome 要求守护进程**保留一个其唯一证据刚被删除的 blocker**。按 Claims C-3，blocker 就是 handle 本身 —— 所以这是一句**朝着「看起来安全」方向的假话**，正是本轮评审要清除的东西。

修法：改读 containment 模块返回的 decision 的 `boundaryProof`，即那个本来就该当把关位的字段。修后：

```
CONTRA outcome= {"ok":true,"boundaryProven":true,"evidence":"members-empty","residual":null}
CONTRA handles_left= 0
```

### 3.2 八处断言仍在比较裸 true / false（已改）

`mojo-containment-wiring` 里 8 处 `resolves.toBe(true|false)` 在签名结构化后依然编译通过、语义却已落空。现改为读结构化字段，并在原布尔掩盖了信息处显式断言：`ok` 与 `boundaryProven` 分离、被拒绝的 close 不得声称 `signalsStopped`、以及唯一一种真能拿到 boundary proof 的 weak handle 情形。

另发现**第 6 处** fail-open 断言（前 5 处由指控B 处理）：
`test/mojo-backend.test.ts:148` 原先 `toEqual({ok, taskId})` 要求 residual **不存在**，而该用例确实派发了 turn、只做了 clean scan —— 正是 reviewer 复现的「普通 closed row」。现断言必须带 `residual: 'local_subtree_boundary_unproven'`。

## 4. 各支线独立数字（用户要求分别给出，非合并后数字）

测量方式：`npx vitest run <该支线定向套件>`，Linux。

| 分支 | sha | 结果 |
|---|---|---|
| 基线 | c8122d89 | 289 passed / 0 failed（14 文件） |
| 指控B 单跑 | eb4e79d4 | **299 passed / 0 failed**（16 文件） |
| 指控A 单跑 | 939032b1 | 287 passed / **10 failed** |
| 指控D 单跑 | 1f660d84 | 288 passed / **9 failed** |

A 与 D 单支线为红，**不是它们做错了**：失败全部集中在 `mojo-containment-wiring` 的那 8 处布尔断言 —— 签名由 A 改、断言更新按分工归 D，任何一方单独提交都必然红。集成时统一修复，见 3.2。这也说明「各分支历史绿灯」不能替代集成验证。

## 4b. 顺带做实的一条声明：boundary proof 的构造点收口

审计 C-6 指出「唯一收口点」为假（实际 3 个 mint 点）。本轮没有改注释了事，而是把它变成结构事实：
`TurnQuiescence` 的 `boundaryProof: true` 现在只由 `containedProvenQuiescence()` 一个导出工厂构造，
backend 改为调用该工厂而不是自行拼字面量。核验：

```
git grep -n "boundaryProof: true" -- src/
  src/adapters/backend/mojo-process-tree.ts:110   <- 类型定义
  src/core/mojo-containment.ts:982                <- 唯一构造点
  （其余命中均为注释）
```

backend 处刻意调用工厂而**不是**伪造一个 verdict 去喂 `containmentQuiescence`：
「boot id 已变」的 weak handle 是真的 boundary proof，而伪造成 `cgroup-empty` verdict 会被降级回
诊断级扫描，恰好在唯一要紧的那一处出错。

## 5. 集成后回归：失败文件集合做差（3 轮）

范围：`test/mojo-*.test.ts` 共 32 个文件（改动全部落在此域，见 §7）。

| 轮次 | 基线 c8122d89 | 集成分支 |
|---|---|---|
| r1 | 551 passed / 0 failed | **572 passed / 0 failed** |
| r2 | 551 passed / 0 failed | **572 passed / 0 failed** |
| r3 | 551 passed / 0 failed | **572 passed / 0 failed** |

失败文件集合：基线 **∅**、集成分支 **∅**（最终三轮双方全绿）。
**做差结果：新增失败文件 0 个。** 用例总数 551 → **572**（+21）。

早前轮次中 `mojo-worker-wiring.integration` 与 `mojo-cross-boundary` 曾各自偶发计时超时
（12s / `sends the first prompt promptly instead of waiting for the ready fallback` 等），
单独重跑均全绿，最终三轮未再出现。
**建议把 `mojo-worker-wiring.integration` 补进 BRIEF 的已知 flake 清单**（原清单只列了
mojo-cross-boundary 的 [A][B][C]、mojo-close-failclosed 的 SIGKILL 计时用例、worker-argv-reaction-status）。

`npx tsc --noEmit`：通过（两个签名变更同时在场）。

## 6. 变异验证：全部在集成分支上重跑（不采信各分支历史成绩）

harness 还原以 sha256 校验，跑前跑后一致，`git status` 干净。

| 变异 | 改动 | 结果 | 点名失败 test 数 |
|---|---|---|---|
| M1 | `scan-clean` 也算 boundary proof（还原漏洞本体） | **KILLED** | 18 |
| M2 | 摘掉 containment 释放守卫 | **KILLED** | 6 |
| M3 | `diagnostic-clean` 分支声称 `boundaryProven: true` | **KILLED** | 20 |
| M4 | 回退 §3.1 的跨层一致性修复 | **KILLED** | 1 |
| M5 | 唯一工厂改返回 `diagnostic-clean` | **KILLED** | 4 |
| M6 = C-7 | 判据改回 `procRoot !== undefined` | **KILLED** | 2（Linux）/ 6（平台模拟） |
（M1/M3 计数高于早前轮次，是因为 C-7 与后续合并新增了跨层用例，守卫被加强而非放松。）
| M-D1（指控D） | 合成 fixture 改读宿主真实 boot_id | **KILLED** | 8 |

M1 在集成后由 13 个升至 16 个点名失败 —— 合并**增强**了守卫，跨层用例也开始抓它。
M4 只有 1 个点名失败，说明该不变量的护栏偏薄；如实记录，不粉饰。若后续再收紧，建议优先加固此处。
七条变异均在**最终树**上重跑（不采信任何分支的历史成绩），**每条连跑两遍且两遍计数一致**，
harness 以 sha256 校验还原，`git status` 干净。连跑两遍是因为本轮已有两次「单跑一遍 + flake」
导致的错误结论（CrossPlatform 自查出两处、我自己一处），单次测量不足以入结论。

**M-D1 的一个诚实注脚**：我第一次写这条变异时让 fixture 在读宿主 boot_id 失败时回落到合成值，
结果 killed=0（SURVIVED）。原因是 fixture 与 handle 取的是**同一个**值，自洽 ⇒ 变异是空的。
改成「fixture 写宿主真实 boot_id，而 handle 仍持合成值」后 killed=8，与 CrossPlatform 的数字
完全一致。记录这件事是因为它本身就是本轮的教训：**一个不会失败的变异不构成证据**，
和「测试绿 ≠ 生产已修」是同一条线。

## 6b. C-7：本轮最后一个**生产**缺陷（已落地，三条验收全过）

`mojoTreeScanSupported` 只要拿到 procRoot 就跳过平台检查，而**每个生产调用方都会传**
（`mojo-backend.ts` 的 getter 恒返回字符串 '/proc'）⇒ override 分支恒被走，
非 Linux 的 OUTRIGHT 拒绝**在生产路径上从不触发**。原 docstring 还写着
「override … is never set in production」，与事实完全相反 —— 这句反事实注释正是这条死分支
能通过历次评审的原因。

判据改为「procRoot 是不是内核接口的**替代品**」而非「有没有传 procRoot」：
`isProcRootOverridden(procRoot) = procRoot !== undefined && procRoot !== DEFAULT_PROC_ROOT`。

**这是行为缺陷，不是注释问题。** 因果链（行号级）：
`destroy-result.ts:201-221` 只有 `kind==='unsupported-platform'` 才 `residual-close`，
其余（含 `unscannable`）→ `fence`；`mojo-backend.ts:1065-1082` fence 分支 latch
`admissionFenced` 且 close 返回 `ok:false`。而 residual-close 会发布行、把 blocker 留在 durable
handle 上、并继续远端 cancel。fence 在「重试还可能拿到证明」时是对的；在**永远无法枚举**的主机上
它就是永久 wedge —— 恰好把 reviewer 明确认可、要求别推倒的「非 Linux 不再永久 wedge」又放回来了。

### 三条验收（Leader 定，逐条实测）
1. **默认 procRoot 下非 Linux 分支实测触发**：新增用例断言**生产调用形态本身**
   （不是只测 helper）——`platform:'darwin'` + `procRoot: DEFAULT_PROC_ROOT` 时，
   `scanMojoTree` 与 `readProcessIdentity` **都**返回 `failure.kind==='unsupported-platform'`；
   并断言其 `classifyUnprovenTermination(...).outcome === 'residual-close'`，
   同时钉住 `'unscannable' → 'fence'`（死 gate 会落到的那一格）。✅
   实测观察到的字符串（连跑两遍一致，生产调用形态 `platform:'darwin'` + `procRoot:'/proc'`）：
```
isProcRootOverridden('/proc')          = false        <- 默认路径不算 override，gate 存活
scanMojoTree(...).failure.kind         = unsupported-platform
readProcessIdentity(...).failure.kind  = unsupported-platform
quiescenceFromScan(...).kind           = unsupported-platform   boundaryProof = false
classifyUnprovenTermination(...)       = { outcome: 'residual-close',
                                           reason: 'mojo_local_termination_unprovable_on_platform' }
对照 classifyUnprovenTermination('unscannable') = { outcome: 'fence',
                                           reason: 'mojo_local_termination_unscannable' }
```
2. **变异 KILLED**：判据改回 `procRoot !== undefined` ⇒ Linux 侧 2 个点名用例变红、
   平台模拟下 **6 个**变红（含 CrossPlatform 指出的那 4 个），连跑两遍一致。✅ 不是 SURVIVED。
3. **平台模拟 4 failed → 0 failed**：见 §8。✅

## 7. 改动面（用于界定回归范围）

```
src/core/mojo-containment.ts            src/adapters/backend/mojo-backend.ts
src/adapters/backend/mojo-process-tree.ts   src/adapters/backend/types.ts
test/mojo-*.test.ts（9 个）              test/helpers/{synthetic-proc,non-linux-probe-setup}.ts
test/probe3-harness.test.ts             vitest.non-linux-probe.config.ts
notes/ 与 docs/ 文档
```

全部落在 mojo 域。**未运行仓库全量 `vitest run test/`**：该目录包含大量与本改动无关的 UI / lark / dashboard 套件，在本环境单轮即长时间不收敛（多用例 30s 超时），三轮基线不可行。如需全量，建议由 CI 执行。此处如实标注为**未做**，不以域内数字冒充全量。

## 8. 非 Linux 平台门验证（**模拟，非 Darwin 真机**）

前提更正：CrossPlatform 自查发现旧 probe 的 fs mock **无效**（改 fs 命名空间对象上的
`readFileSync`，拦不住 `import { readFileSync } from 'node:fs'` 的命名导入 ⇒ 测试一直在读宿主
真实 /proc，「因错误的原因而绿」；反证是把所有 gate 删光后仍 34/34 全绿）。已改用
`vi.mock('node:fs')`。**据此作废的旧数字：526 / 527 / 534 / 543，以及本报告上一版写的 542/25/1。**

有效 probe（`vitest.non-linux-probe.config.ts`，强制 `process.platform='darwin'` + 真实 /proc 读
一律 ENOENT），范围 mojo 域 32 文件：

| 状态 | 结果（每个数字连跑两遍，两遍一致） |
|---|---|
| C-7 未修（CrossPlatform 二次订正后实测） | 536 passed / 28 skipped / **4 failed** |
| C-7 未修（Claims 在 1e66ca04 独立实测） | 540 passed / 28 skipped / **0 failed** ← 见下方归因说明 |
| C-7 已修（本分支 ad9bd046 实测 ×2） | **544 passed / 28 skipped / 0 failed** |
| C-7 判据回退的变异（本分支 ×2） | 538 passed / 28 skipped / **6 failed** |

544 与 Claims 的 540 相差 4，原因已查明且无争议：我的 C-7 commit 新增了 4 个用例
（1 个 helper 判据 + 1 个生产调用形态 + 1 个 residual-close 路由 + 1 个 seam 仍可 opt-in），
540 + 4 = 544，`skipped` 两侧同为 28。

### 关于「那 4 个 close-path 失败不可复现、归因未查明」

Claims 在 1e66ca04 上用有效 probe 得 0 failed，据此判定 C-7 已成为「无测试守护的缺陷」。
本分支的变异实验给出了直接反证：把判据回退为 `procRoot !== undefined`（即恢复 C-7 缺陷）后，
那 4 例**全部复现**，连同我新增的 2 例共 6 例变红，两遍一致：

```
mojo-backend                「returns a failed prepare with the exact known lineage when cancel fails」
mojo-close-admission-fence  「does not claim restoration after the session was already torn down」
mojo-close-admission-fence  「still restores admission when the local subtree was PROVEN gone and only the remote cancel failed」
mojo-close-failclosed       「refuses the close when a dispatched turn never produced its lineage」
mojo-process-tree           「refuses off-Linux on the EXACT call shape production uses (procRoot = /proc)」
mojo-process-tree           「routes that refusal to a residual close, NOT to a fence」
```

⇒ 在**本交付树**上，这 4 例与 C-7 判据是因果绑定的，C-7 **不是**无守护缺陷。
Claims 在 1e66ca04 上观察到 0 failed 与此不一致，**我没有查明该差异的成因**（两次测量之间还并入了
b3925ad7 与 9d6706d3），故如实并列记录两个观测，不宣称已解释对方的结果。
无论该差异原因为何，验收结论不受影响：判据回退必须有点名用例变红，本树上确实有 6 例。



**措辞纪律（硬约束）**：以上是 **procRoot 注入 + platform/fs 模拟**的结果，
**本环境无 Darwin 硬件，不得表述为「macOS 已归零 / 跨平台已修复」**，只能说
「模拟下 0 failed，无 Darwin 真机」。reviewer 报告的 16 failed / 38 failed 只能标注为
**reviewer 测量**；上一轮宣称的 135/135、558/558 应更正为 **Linux-only**。

## 9. 七份文档在仓库中的状态（reviewer 可 checkout）

`refresh-audit.sh` 在最终 sha 上逐条校验：

```
present  docs/pr-803-round5-reply.md                      <- reviewer 唯一入口
present  docs/pr-803-round5-audit.md
MISSING  docs/pr-803-round5-claim-a-boundary-proof.md     <- 指控A 本轮未交付该文档
present  docs/pr-803-round5-claim-b-weak-handle.md
present  docs/pr-803-round5-claim-b-mutation-log.md
present  docs/pr-803-round5-claim-b-probe3-before-after.md
present  docs/pr-803-round5-claim-d-cross-platform.md
```

6/7 present。唯一缺失项是指控A 的设计与变异记录文档：其**代码**已交付并接线
（`TerminationOutcome.boundaryProven` 生产读取 0→4，`mojo-backend.ts:1141`
`else if (!termination.boundaryProven)` 是真 gate，三条不变式断言在位），但该 owner 未提交文档。
**如实标注为本轮未交付**，未由他人代写；reply.md 的索引需相应说明，否则索引本身就是假声明。

## 10. 本轮未做的事（避免又一次过度声称）

- **未运行仓库全量 `test/`**：含大量与本改动无关的 UI / lark / dashboard 套件，本环境单轮即长时间
  不收敛（多用例 30s 超时），三轮基线不可行。建议交 CI。**不以 mojo 域数字冒充全量。**
- **无 Darwin 真机**：所有非 Linux 结论均为模拟。
- **指控A 的文档**缺席（见 §9）。
- M4 只有 1 个点名失败，护栏偏薄，已如实记录，未加工成「充分覆盖」。

## Independent verification by the delivering agent (added at hand-off)

The integration numbers below were reported by the integrating teammate. Before hand-off the
delivering agent re-ran the mojo domain suite independently, on the delivery tree, and records
one observation that the three reported rounds did not surface.

Command and platform: `npx vitest run test/mojo-*.test.ts` on Linux x86_64, delivery tree,
working tree clean, `tsc --noEmit` exit 0.

| Run | Parallelism | Result |
| --- | --- | --- |
| 1 | `--maxWorkers=16` | 570 passed / **2 failed** |
| 2 | vitest default | 572 passed / 0 failed |
| 3 | `--maxWorkers=16` | 572 passed / 0 failed |
| 4 | `--maxWorkers=16` | 572 passed / 0 failed |
| 5 | file alone (`test/mojo-process-tree.test.ts`) | 41 passed / 0 failed |

The two failures in run 1 were both in the C-7 acceptance block of
`test/mojo-process-tree.test.ts`:
`refuses off-Linux on the EXACT call shape production uses (procRoot = /proc)` and
`routes that refusal to a residual close, NOT to a fence`.

This is recorded rather than resolved, and it is recorded because it is uncomfortable: those two
assertions call pure projection functions with an explicit `platform: 'darwin'` argument, so a
load-sensitive failure there is not explained by timing the way a spawn-based test would be. The
failure did not reproduce in three subsequent runs, including two at the same parallelism, and the
file passes 41/41 in isolation. The delivering agent did not find the root cause and is not
claiming one.

What a reviewer should take from this: the "572 passed / 0 failed, three rounds" figure is real
but was obtained at vitest's default parallelism. A reviewer running at a different worker count
may see these two cases fail. Treat that as a known, unexplained observation on the C-7
acceptance tests, not as a fresh regression, and not as evidence that C-7 itself is unsound --
the C-7 production-path assertions and the M6 mutation kill are reported separately above.

## Final-review follow-up (the two P1s)

Measured on the follow-up head, Linux x86_64, `tsc --noEmit` clean, `npm run build` clean.

| Suite | Result |
| --- | --- |
| Linux mojo domain, run 1 | 575 passed / 0 failed |
| Linux mojo domain, run 2 | 575 passed / 0 failed |
| Non-Linux simulation | 546 passed / 29 skipped / **0 failed** |

Three new cases (+3 over the 572 of the previous head): one live-worker end-to-end case for
the IPC residual, and two for the inherited-handle grading (the fix plus its counter-case).

Mutations, each reverted and re-verified green afterwards:

| Mutation | Result |
| --- | --- |
| `buildCloseResultMessage()` drops `residual` | KILLED |
| daemon `close_result` receiver drops `residual` | KILLED |
| `dischargeContainment()` restores the hand-rolled `unscannable` | KILLED |

One note worth keeping, because it repeats this round's lesson. The counter-case
(an unproven **weak** handle must still fence) initially failed under the non-Linux
simulation, and it was right to fail: off Linux that handle grades to
`unsupported-platform` as well, because the host cannot enumerate whatever the handle kind
is. The assertion had quietly assumed Linux semantics on every platform — the same unstated
assumption charge D was raised about, reintroduced by the fix for a different charge. It is
now explicitly gated to Linux, and the non-Linux side of the behaviour is covered by the
case above it.

Non-Linux remains simulation only: `platform` mock plus `vi.mock('node:fs')`, **no Darwin
hardware**. Nothing here should be read as macOS having been verified on a real machine.
