# Runbook — v3 跨节点 revisit 真机 (真 daemon + 真 CLI) smoke

自动化测试覆盖到哪、为什么真 CLI 这步是手动的，以及怎么手动跑一次。

## 自动化已覆盖（CI 安全、确定性）

| 层 | 测试 | 覆盖 |
|---|---|---|
| 引擎/编排 | `v3-runtime` | revisit 识别 → supersede cone → 重生 #002 → A→B→C 端到端 → feedback 三件套 → buildInputs 抗旧实例迟到 → 两级预算 |
| daemon | `v3-revisit-e2e` | **真 `driveV3Run`** + 真 manifest 校验 (`readAndValidateManifest`) + grill 出生/bots 解析 + revisit→预算耗尽→`postRevisitGrantCard`→`requestRevisitGrant` 原子 grant+retry→收敛成功 |
| daemon | `v3-daemon-run` | requestRevisitGrant 守卫 (partial-pair / pair-source-mismatch / stale-attempt / 幂等)、gate stale-card、recovery |
| 飞书卡 | `v3-revisit-grant-card` | grant 卡构建 + handler 点击 grant+retry/stale/权限 |

**注入的是脚本化 worker（不 spawn 真 CLI）**：真 CLI 是否回溯取决于模型决策，不可作确定性断言；且本机无 swap，长 Claude Code 会话有 OOM 史（见 ai-workspace 记忆），不宜在 CI 里 spawn。

## 真 CLI smoke（手动，跑一次确认 worker→goal.txt→result.json→runtime 链路）

前置：`claude` 已登录（`claude --version` 能跑）；开发机内存够（`free -g` 看 available，长跑前先 `atop` 备查）。

1. 起一个带 `revisitTo` 的最小 dag（A→C，C 可回溯 A），通过正常 grill 流程出生 run（或直接喂 dag.json + grill state）。
2. C 的 goal 里明确写“如果上游 A 的产出缺少 X，请用 revisit 退回 A”——让模型有明确触发条件，再把 A 的产出做成缺 X。
3. 起 daemon，`driveV3Run`（或走飞书话题触发）。观察 journal：
   - `nodeRevisitRequested{nodeId:C, toNodeId:A}`
   - `nodeInstanceSuperseded`（A/C 的 #001）
   - A#002/C#002 重新 dispatch
   - C#002 的 `inputs.json` 含 `from:"revisit"` 三件套（reason/source/previous）
4. 连续回溯到 per-pair=1 耗尽 → 飞书应弹 **revisit grant 卡**（橙，标 `C → A` / per-pair）。点「准许回溯 +1」→ 卡转绿冻结 + C 重跑。
5. 让 C 这次满足 → run `succeeded`。

排查：
- 没弹卡 → 看 daemon 日志 `postRevisitGrantCard`；确认 run 真的 `blocked` 且 `nodeBlocked.errorCode=REVISIT_BUDGET_EXHAUSTED`。
- 点卡无反应 → 看 card-handler 是否注册 `v3RevisitGrantDeps`（daemon.ts）+ nonce 是否过期（回溯后旧卡按 attemptId 失效，看最新那张）。
