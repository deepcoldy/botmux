# 指控B 变异验证记录

基线 sha: c8122d89，改动 commit: 8d764534（分支 wh/weak-handle-residual，worktree /tmp/weakhandle）
harness 还原校验: src/core/mojo-containment.ts sha256
`66f8b7cc69e4cfbedfaaa0626bbf9495e72577f5c609a0172291ef9f3d46e5bf`
两轮变异前后一致，`git status --short` 空，工作树无残留。

## M1 —— 把 scan-clean 也算成 boundary proof（即还原漏洞本体）

改动（逐标志位最小改动，只翻这一道守卫）：
`: evidence === 'boot-id-changed';` → `: (evidence === 'boot-id-changed' || evidence === 'scan-clean');`

结果：**KILLED**，13 个点名失败 test（红 + 有点名失败 test）：
- labels the clean weak scan scan-clean and refuses to authorise release
- KEEPS the handle in the durable store, so the blocker survives the close
- cannot be laundered into a boundary proof by a hand-built verdict
- an absent evidence field defaults DOWN to scan-clean, never up
- a merely SCAN-CLEAN weak verdict does not drop the session from the blocker set
- a proven WEAK handle is only diagnostic-clean, never a boundary proof
- NO verdict shape can mint boundaryProof through a weak handle
- ONE weak handle downgrades the whole session to diagnostic-clean
- a hand-constructed proven-unprovable verdict never mints a boundary proof
- SIGTERM alone is not proof; only a real kill retires the handle
- kills an inherited live subtree instead of leaving the session unclosable
- lets a workerless close through when the only member left is a zombie
- discharges a handle whose only remaining member is a zombie

意义：这正是 reviewer 复现的那条链路。它现在被 13 个断言同时钉住，
其中 4 个来自旧套件 —— 说明守卫不是只被新写的测试自证。

## M2 —— 摘掉 releaseContainmentHandle 里的释放守卫（另一道守卫，单独翻转）

改动：`if (!decision.releaseAuthorised) {` → `if (false && !decision.releaseAuthorised) {`

结果：**KILLED**，5 个点名失败 test：
- KEEPS the handle in the durable store, so the blocker survives the close
- a merely SCAN-CLEAN weak verdict does not drop the session from the blocker set
- kills an inherited live subtree instead of leaving the session unclosable
- lets a workerless close through when the only member left is a zombie
- discharges a handle whose only remaining member is a zombie

意义：M1 钉的是「谁算 boundary proof」，M2 钉的是「decision 真的被用来拦住删除动作」。
两道守卫分别单独翻转、分别有独立的点名失败集合，不存在一道守卫替另一道背书的情况。

## 未做 / 不宣称
- 无 Darwin 真机，两轮变异均只在 Linux 执行；不宣称 macOS 结论。
- 未跑全仓 vitest（非 mojo 领域存在与本改动无关的大量超时），按 BRIEF 由 leader 统一做
  「失败文件集合做差 + 三轮基线」。
