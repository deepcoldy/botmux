# 指控B（P1）已落码：weak handle 不得凭 clean scan 释放

Owner: WeakHandle
状态: **已落码 + Linux 实测通过**，未 push（等 root agent 确认）
worktree: `/tmp/weakhandle`（基线 c8122d89），本地分支 `wh/weak-handle-residual`，commit `8d764534`
改动文件（全部由我独占写）：
- `src/core/mojo-containment.ts`
- `test/mojo-weak-handle-residual.test.ts`（新增，8 例）
- `test/mojo-containment.test.ts` / `test/mojo-containment-cross-generation.test.ts` /
  `test/mojo-containment-wiring.test.ts`（旧断言正是**在断言漏洞行为**，已改）

## 1. 漏洞链路（reviewer 复现）与切断点

```
weak handle 扫描为空 → proveContainmentQuiescent proven:true
→ releaseContainmentHandle 删 handle → hasUnprovenContainment=false
→ 普通 closed row → device-isolation blocker 消失（而 boundaryProof 一直是 false）
```

切断点：**释放授权与 proven 解耦**。proven 仍表示「按本机能力看不到活人」，
但删 handle 需要 `boundaryProof`，而 `scan-clean` 永远不给 boundaryProof。

## 2. 落码后的契约（mojo-containment.ts 导出）

```ts
export type QuiescenceEvidence =
  | 'cgroup-empty' | 'cgroup-zombie-only' | 'boot-id-changed' | 'scan-clean';

// QuiescenceVerdict 的 proven:true 分支新增可选 evidence?: QuiescenceEvidence
// （可选是为了不破坏既有手工构造点；缺省按 handle.kind 向下取最弱值，绝不向上升级）

export interface ContainmentReleaseDecision {
  boundaryProof: boolean;                     // 唯一把关位
  releaseAuthorised: boolean;                 // = proven && boundaryProof
  evidence: QuiescenceEvidence | 'not-proven';
  residual: { deviceIsolation: boolean; pids?: number[]; reason?: string } | null;
  signalsStopped: boolean;
}

export function containmentReleaseDecision(verdict: QuiescenceVerdict): ContainmentReleaseDecision;
```

真值表（单测逐行钉死）：

| verdict | evidence | boundaryProof | 删 handle | residual |
|---|---|---|---|---|
| proven, cgroup | cgroup-empty | true | 是 | null |
| proven, cgroup | cgroup-zombie-only | true | 是 | null |
| proven, weak | boot-id-changed | true | 是 | null |
| proven, weak | **scan-clean** | **false** | **否** | deviceIsolation:true |
| not proven | n/a | false | 否（且 throw） | deviceIsolation:true |

第 4 行就是本轮修复本体：`signalsStopped:true`（可以停止重复发信号）+
会话可以 closed，但 handle 留在 durable store ⇒ `hasUnprovenContainment` 仍 true
⇒ device-isolation blocker 保留。

为什么 `boot-id-changed` 也算 boundary proof：重启后原树不可能存活，且同用户子进程
无法改写 kernel boot id ——与 cgroup 同属「内核所有、子进程不可伪造」。这一条如果
reviewer 认为过宽，只需删掉 `containmentReleaseDecision` 里的那半个条件即可，
不影响其他结构。

## 3. 行为变更（需要写进回复稿，别漏）

1. `releaseContainmentHandle` 返回值由 `void` 改为 `ContainmentReleaseDecision`。
2. 它在 `scan-clean` 时**不抛错也不删 handle**，只 warn + 返回 residual。
   刻意不抛：抛错会让会话永久 unclosable，这正是本模块此前特意避免的失败模式。
3. `containmentQuiescence` / `sessionContainmentQuiescence` 不再自己按 handle.kind
   推导强度，改为读 `containmentReleaseDecision(...).boundaryProof` —— 于是
   `boundaryProof` 在本模块有了**真实生产消费点**，原先 :818 那条
   「Callers gate the blocker on boundaryProof === true only.」的假声明已改写为
   陈述真实消费位置。`mojo-process-tree.ts:97` 那条不在我手里。
4. 三处旧断言（weak handle 在 clean scan 后被 discharge）已改为断言 residual 保留。
   **这三处旧断言本身就是漏洞的书面证据**，回复稿里值得点名。

## 4. 验证

- `npx tsc --noEmit`：通过。
- 7 个 mojo 套件（containment / cross-generation / wiring / weak-handle-residual /
  process-tree / close-failclosed / cross-boundary）：**150 passed, 0 failed**。
- 平台：**仅 Linux 实测**。新增套件不读真实 /proc、不需要 cgroup（boot id 走
  procRoot seam 的合成目录），因此设计上跨平台，但**无 Darwin 真机，不宣称 macOS 已验证**。
- 全仓 `vitest run test/` 我没跑完：非 mojo 领域存在大量与本改动无关的超时/失败，
  按 BRIEF 的「失败文件集合做差 + 三轮基线」应由 leader 统一跑。

## 5. 给 BoundaryProof 的对接要求（避免第二套语义）

`terminateChildProven` 的结构化返回值里，凡涉及「边界是否被证明 / 是否可释放 /
残留物」的字段**必须直接取自 `containmentReleaseDecision()` 的返回值**，不得自行
从 pid 观测推导第二套结论；`mojo-backend.ts` 不得直接删改 containment handle
（释放决策只在 mojo-containment.ts 做）。
`ok===true && boundaryProven===false` 是合法且常见组合。
