# bytedcli configurable operation policy implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audited command catalog data-driven and add versioned host/Bot business execution rules, while preserving actor-only writes and all existing containment/lifecycle guarantees.

**Architecture:** A packaged immutable JSON catalog defines true effects and grammar. A pure versioned policy parser resolves default/global/Bot restrictions. A protected host-file reader freezes a revision per request; host authority and executor separately enforce identity, effect semantics and no redispatch across policy edits. Dashboard edits Bot rules and shows the same effective policy.

**Tech Stack:** TypeScript, existing Bun/Node22 JSON imports, Vitest, existing HTTP/proxy/config store, React and Linux bwrap.

**Spec:** `docs/bytedcli-operation-policy-design.md`

## Global Constraints

- 沿用 bytedcli0.199.0、catalog2026-11-26.1、CN、严格 Linux managed local PTY/Tmux/cold/fs+PID 证明；不扩大 CLI/backend/MCP 矩阵。
- absent 配置保持既有行为；strict 策略只在 enabled+ByteCloud+read-machine-write-actor 生效；保留 Lark/Meego/git/owner/delegation/个人 auth/旧模式合同。
- 所有请求参数仍闭合校验并规范重建；配置不能增加未审核命令/参数、将 write 变 read 或选择机器 write。
- 宿主全局规则只能收紧审核默认，Bot 只能进一步收紧；身份与真实 effect 分离；没有个人授权的 actor-read/write 均不回退机器。
- 排队/取票/派发/返回重新校验策略修订；拒绝同步检查不启动新 verifier；初始异步所有权、重复绑定、关闭/退休 join、合法后继与资源预算不得回退。
- 持久 intent fsync 在实际 write 派发之前；已派发写入不自动重试，策略修订不能清除同执行 requestId 派发记录；actor-read 不使用 write 额度/审计/未知语义。
- 不安装依赖、不修改 package/lock 或共享依赖；完整验证用既有 `/tmp/botmux-rw-validation-src.WNU9iw` 与 staged dependencies，只有控制器推进冻结提交。
- 测试使用临时 HOME、假 provider/CLI；TS 子进程使用 test/helpers/ts-runner.ts；临时探针/变异一律 bun scripts/fenced-run.ts；不碰 live 凭据/业务/daemon/fleet/systemd/tmux/wrapper。
- 提交格式 type(scope): 中文描述；公开源码/提交不含真实人名或部署主机；完成审查与完整验证后更新已授权的同一远端分支；不创建PR/merge/tag/release/deploy。

---

### Task 1: Data catalog and pure versioned configuration

**Files:** create `src/core/bytedcli-operation-catalog.json`, `src/core/bytedcli-operation-catalog.ts`, `src/core/bytedcli-operation-policy-config.ts`; modify `src/core/bytedcli-operation-policy.ts`, `src/services/trigger-user-auth.ts`; create `test/bytedcli-operation-policy-config.test.ts`; amend existing parser/config tests only for real behavior.

**Interfaces:**
- Produces exported `BYTEDCLI_OPERATION_POLICY_SCHEMA = 'botmux.bytedcli-operation-policy.v1'`, `BytedcliOperationRule = 'machine' | 'actor' | 'deny'` and immutable `BytedcliOperationPolicy {schema;cliVersion;catalogVersion;rules:Readonly<Record<string,BytedcliOperationRule>>}`.
- Produces `parseBytedcliOperationPolicy(raw: unknown): BytedcliOperationPolicy | undefined`; undefined/null clear optional Bot config, but a present host file must contain a valid object. Closed keys/version/rules/known business IDs; max64 rules. Never permit machine on write.
- Produces `resolveBytedcliOperationRule(operationId: string, globalPolicy?: BytedcliOperationPolicy, botPolicy?: BytedcliOperationPolicy): {operationId:string;effect:'read'|'write';enabled:boolean;identity:'machine'|'actor'}` with deny>actor>machine, canonical business IDs only, no mutation.
- Produces pure/browser-safe catalog exports for metadata and versions. Existing imports from operation-policy.ts remain compatible re-exports. TriggerUserAuthConfig gains optional `bytedcliOperationPolicy?: BytedcliOperationPolicy`; actual old clients/disabled modes retain it, null clears.
- JSON catalog holds all existing paths, aliases, effect, flag arity/aliases/repetition/validators, required/changes/resource constraints. Declarative validators may use bounded/choice/integer/pattern/branch/relative-resource/composition with a small interpreter; preserve exact current behavior. No arbitrary external runtime catalog or validator source.

- [ ] Add failing behavior tests for known-policy parse, write→machine/unknown ID/unknown field/version rejection; alias-based parser output uses same operationId; deny and actor floors cannot be loosened; readonly immutable outputs and absent/null clear; disabled/legacy settings remain dormant but preserved.

```ts
const base = { schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: '0.199.0', catalogVersion: '2026-11-26.1' };
const globalPolicy = parseBytedcliOperationPolicy({ ...base, rules: { 'codebase.mr.list': 'actor' } });
const botPolicy = parseBytedcliOperationPolicy({ ...base, rules: { 'codebase.mr.list': 'machine' } });
expect(resolveBytedcliOperationRule('codebase.mr.list', globalPolicy, botPolicy))
  .toMatchObject({ effect: 'read', identity: 'actor', enabled: true });
expect(() => parseBytedcliOperationPolicy({ ...base, rules: { 'codebase.mr.close': 'machine' } })).toThrow();
```

- [ ] Run `bun run test test/bytedcli-operation-policy-config.test.ts test/bytedcli-operation-policy.test.ts test/trigger-user-auth.test.ts`; capture expected RED before source edits.
- [ ] Move grammar declarations into versioned JSON, add a validated/deeply frozen pure catalog module and compile declarative flag validators in the parser. Preserve existing exported catalog/version/types and raw argv reconstruction. Add config parse/normalization and TriggerUserAuthConfig roundtrip. Reject unknown keys/rules and malformed data with bounded safe errors, without importing node fs/auth into browser-shared modules.

```ts
const actual = parseBytedcliOperation(['codebase', 'pr', 'edit', '42', '--repo', 'org/repo', '--title', 'new']);
expect(actual).toMatchObject({ id: 'codebase.mr.update', effect: 'write', cliVersion: '0.199.0' });
```

- [ ] Run covering tests to GREEN plus `test/identity-policy.test.ts` and `test/bytedcli-mode-config.test.ts`. Fenced private-copy mutation allowing write→machine must make the new config behavior fail; removal of global actor floor must expose machine effective identity. Do not modify canonical source for mutations.
- [ ] Self-review default grammar compatibility and pure import boundary; commit scoped changes; write `task-1-report.md` with interfaces, exact commands/output, RED/GREEN/mutation evidence, concerns. Do not start Task2 or spawn reviewers.

### Task 2: Trusted hot policy, authority, effect/identity and replay fences

**Files:** create `src/core/bytedcli-host-operation-policy.ts`, `test/bytedcli-host-operation-policy.test.ts`, `test/bytedcli-operation-policy-runtime.test.ts`; modify `src/core/bytedcli-broker-authority.ts`, `src/core/bytedcli-executor.ts`, `src/core/bytedcli-broker.ts`, `src/core/bytedcli-safe-commands.ts` as required; extend targeted authority/executor/lifecycle/HTTP/kernel tests. TS child coverage may add `test/fixtures/bytedcli-operation-policy-runtime.ts` through the existing helper.

**Interfaces:**
- Consumes Task1 versioned parser and resolver; `TriggerUserAuthConfig.bytedcliOperationPolicy`.
- Produces `createBytedcliHostOperationPolicyReader(privateRoot: string): () => BytedcliHostOperationPolicySnapshot`, where snapshot has immutable `policy?: BytedcliOperationPolicy` and bounded opaque `revision:string`. Fixed child path `policy/operation-policy.json`, maximum32 KiB, safe private directory/file validation and synchronous bounded before/after read. Missing file defaults; invalid/unstable/unsafe file fails closed. Initial safe policy-directory creation precedes first revision, only when strict reader is used.
- Optional `BytedcliAuthorityDependencies.operationPolicy?: () => BytedcliHostOperationPolicySnapshot` enables trusted injection/legacy compatibility. Production always uses reader rooted at frozen layout.privateRoot.
- Optional `BytedcliFrozenAuthority.executionIdentity?: 'machine'|'actor'` is host-owned; production business authority always chooses it. Existing trusted embedders without field retain effect default. Freeze it with hashed policyFingerprint incorporating complete Bot config plus global revision. Current/success rechecks rerun frozen-state checks; no request-signal capture.
- Actual effect remains unchanged and continues quotas/intent/unknown semantics. Add safe wire error codes if useful for policy invalid/disabled; do not change the request schema to accept policy/identity/effect/path.

- [ ] Add RED tests: default read touches machine only; configured actor-read needs verified sender/official personal grant and never machine fallback; actor-read stays read for concurrency/audit/nonzero/timeout results. Global/Bot deny refuses before identity/provider/dispatch. Canonical aliases receive same policy. Write→machine forged host descriptor refuses. Schedule/ownerless/delegated actor-read uses the personal authority gates of write, preserving machine-read behavior.

```ts
const operation = parseBytedcliOperation(['codebase', 'mr', 'list', '--repo', 'org/repo']);
const configured = parseBytedcliOperationPolicy({ schema: BYTEDCLI_OPERATION_POLICY_SCHEMA,
  cliVersion: '0.199.0', catalogVersion: '2026-11-26.1', rules: { 'codebase.mr.list': 'actor' } });
expect(operation.effect).toBe('read');
expect(resolveBytedcliOperationRule(operation.id, configured)).toMatchObject({ effect: 'read', identity: 'actor' });
```

- [ ] Add RED real-component controlled-time tests: edit global policy during queue/mint then no dispatch; edit after actual write then write_outcome_unknown; partial/oversize/symlink/hardlink/private-permission errors reject without last-good fallback; recovery with new valid file permits a new request; absent→create→delete revision is detected. Actual Linux sandbox cannot edit the fixed policy file beneath host-authority; use fake protected roots/providers and ts-runner children.
- [ ] Add RED request-ID fence: lost result after one fake business write; atomically replace/edit global policy; resend same requestId in the same execution; observe exactly1 upstream attempt. Same-execution dispatched write records survive policy stale-cache GC, yet new explicit turn/generation successor executes normally and retained capacity/admission budgets stay bounded. Old cached actor/machine read output cannot be replayed after an identity-policy change.

```ts
const privateRoot = mkdtempSync(join(tmpdir(), 'bytedcli-policy-'));
const reader = createBytedcliHostOperationPolicyReader(privateRoot);
const before = reader();
writeFileSync(join(privateRoot, 'policy', 'operation-policy.json'), JSON.stringify({
  schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: '0.199.0', catalogVersion: '2026-11-26.1',
  rules: { 'codebase.mr.list': 'actor' },
}), { mode: 0o600 });
expect(reader().revision).not.toBe(before.revision);
unlinkSync(join(privateRoot, 'policy', 'operation-policy.json'));
expect(reader().revision).not.toBe(before.revision);
```

- [ ] Run named new/covering host-policy, authority, executor and lifecycle tests RED. Implement fixed private file reader with stable directory/file metadata revision, explicit invalidity and no last-good storage. Only strict requests invoke it, so old-mode startup does not create/change this tree. All paths remain under the existing host-authority deny contract.
- [ ] Resolve policy before any actor lookup; requiresActor = auth/write/configured actor-read. Preserve schedule/delegation/source/epoch/caller checks, now choosing based on identity where privilege is needed. Hash composite policy fingerprint to remain≤256 bytes. Recheck revision after waits and before dispatch/result; preserve sync refusal.current and owned lifecycle.
- [ ] Executor validates host-selected identity independently from effect, uses actor lease for actor-read, includes identity in cache binding and preserves write-only quotas/audit/unknown. Same-execution dispatched requestIds cannot redispatch after policy revision; preserve those entries until the execution ends, without unbounded secondary caches or loosening4096/80/64/output limits.
- [ ] Production supplies shared fixed-root reader; safe help projects configured business identity/disabled state without resolving grants and preserves auth/login/logout. No policy source reaches wire inputs or Agent env. Keep missing unsafe config as explicit refusal, not daemon-wide legacy startup failure.
- [ ] GREEN targeted new tests plus existing `test/bytedcli-executor-lifecycle.test.ts`, `test/bytedcli-final-lifecycle.test.ts`, `test/bytedcli-broker-acceptance.test.ts`, `test/bytedcli-broker-identity-lifecycle.test.ts`, `test/bytedcli-broker-host-provider.test.ts`, `test/bytedcli-linux-containment.test.ts`. Fenced private mutations: force machine lease for actor-read exposes wrong actor; remove revision check dispatches after deny; retire/reuse policy-changed dispatched ID produces second observed write. Each must fail behavior assertions.
- [ ] Self-review root/ABA/error/cleanup/replay semantics; commit; append full `task-2-report.md` with exact final interfaces and behavior tests/mutations. Controller owns frozen native checks, not implementer. Do not spawn reviewers or start Task3.

### Task 3: Dashboard configuration and complete acceptance

**Files:** create `test/bytedcli-operation-policy-dashboard.test.ts`; modify `src/dashboard/web/bot-defaults.ts`, `src/dashboard/web/bot-defaults-page.tsx`, `src/dashboard/web/i18n.ts`, `src/core/dashboard-ipc-server.ts`, `src/services/bot-config-store.ts`/payload/proxy seam only where required and `test/bytedcli-broker-acceptance.test.ts`; update `docs/bytedcli-read-write-identity.md` and `docs/bytedcli-operation-audit.md`; add fake-data screenshot.

**Interfaces:**
- Consumes Task1 pure catalog/config/resolver, Task2 host policy reader and identity-aware authority/executor.
- Existing `/api/bot-trigger-user-auth-status` and Dashboard proxy `/api/bots/:app/trigger-user-auth-status` return optional sanitized `bytedcliOperationPolicy` summary: versions/catalog, global rules/revision or safe invalid status, current Bot rules/effective entries. No credentials/auth subject/raw host path/error payload. State uses exact runtime resolver.
- Existing trigger-user-auth PUT persists full policy, old-client omission preserves rules, explicit `bytedcliOperationPolicy:null` clears them, disabling retains valid rules. Global policy is administered through documented fixed host file; UI edits Bot rules only and cannot loosen global restrictions.

- [ ] RED behavioral UI/config tests for per-command inheritance/actor/deny, machine option absent for writes, global floor visibility, partial/old-client update preservation, explicit null clear, dormant save and invalid config atomic refusal. Fake GET/PUT responses use actual parser/resolver data; no literal copy of internal code or documentation assertions.

```ts
const policy = { schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: '0.199.0', catalogVersion: '2026-11-26.1',
  rules: { 'codebase.mr.list': 'actor' } };
const parsed = parseTriggerUserAuthConfig({ enabled: false, capabilities: ['bytecloud'],
  bytecloudExecution: 'read-machine-write-actor', bytedcliOperationPolicy: policy });
expect(parsed?.bytedcliOperationPolicy?.rules['codebase.mr.list']).toBe('actor');
expect(parseTriggerUserAuthConfig({ ...parsed, bytedcliOperationPolicy: null })?.bytedcliOperationPolicy).toBeUndefined();
```

- [ ] Run targeted new UI/config tests RED. Add command-table component with meaningful product labels for true effect, override and effective state; preserve complete policy in toggles/source edits. Obtain sanitized host/global summary from existing status route, keep errors actionable and legacy behavior unaffected. API unknown rules/versions/write-machine return rejection without disk mutation; UI clear uses explicit null semantics.
- [ ] Extend actual HTTP/authority/lease/executor/client acceptance for actor-read/no-grant, deny/no-lookup, global floor vs Bot machine, global edits during mint/result, write unknown repeated-ID fence, new explicit turn and old mode/default regressions. Test source and actual compiled client via existing `BOTMUX_BYTEDCLI_ACCEPTANCE_BINARY` seam; controller rebuilds binary from committed source before final compiled run.
- [ ] Update operator documentation with both JSON examples, fixed host path, catalog-file maintenance vs runtime rules, canonical IDs/aliases, allowed machine/actor/deny semantics and global→Bot restrictions, hot-revision failure/recovery/replay behavior, existing cold rollout/CLI/kernel matrix and no automatic retry. Capture actual React UI using temporary HOME/fake server and installed browser tools; add screenshot under `docs/assets/bytedcli-read-write-identity/`.
- [ ] GREEN config/UI/status/acceptance plus relevant existing policy/global/identity/audit/runtime lifecycle tests; source-independent private mutations must catch dropping stored rules, write machine selection, global-floor removal, and repeated write dispatch. Run only necessary coverage and hygiene; no installation/live changes.
- [ ] Self-review and commit; save `task-3-report.md` with final source commands/output, screenshot path, API payload and compiled-input distinction. Controller does full staged native typecheck/build/complete standalone/compiled acceptance and final independent adversarial review (manual policy intervention, partial config recovery, long overlap/replay), then scoped fix gate if needed, then authorized push of same branch.
