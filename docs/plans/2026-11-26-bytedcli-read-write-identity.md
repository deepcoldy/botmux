# ByteCloud read/write identity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute audited bytedcli reads as the machine and writes as the verified current actor, without exporting either credential to the Agent.

**Architecture:** A deterministic version-pinned operation policy rebuilds canonical argv. A host broker freezes the peer-proven execution and policy, leases credentials, durably audits writes, and runs a finite subprocess in a private HOME. Existing credential exports close and actual Linux filesystem/PID isolation gates admission.

**Tech Stack:** TypeScript, Bun, existing HTTP IPC, Vitest, Linux bwrap and existing worker provenance.

**Spec:** `docs/bytedcli-read-write-identity-design.md` (approved by the user's implementation instruction).

## Global Constraints

- `bytecloudExecution`: absent / `trigger-user` retains existing behavior; `read-machine-write-actor` active only with enabled ByteCloud capability.
- Preserve per-capability `credentialSource`, Lark, Meego and old-mode contracts. Local is the actor's private login, never machine fallback.
- Support exactly audited CLI `0.199.0`; unknown operations/options/releases fail closed. Rebuild canonical argv, never execute validated raw argv.
- Reads do not resolve actor grants, await identity publication or initiate login. Writes require official provider identity matching a verified person.
- `identityTurnId ?? turnId` supplies execution identity; peer proof alone does not grant business permission. No implicit owner, no `BOTMUX_AS` in strict mode.
- Both identities execute in request-private empty HOME/cwd, trusted absolute executable, fixed PATH, shell=false. No caller host paths/config/hooks.
- No ByteCloud export to Agent through identity files, Codebase/Bits/git/background/renewal/Meego paths in strict mode.
- Admission requires Linux managed local PTY/Tmux, proven generation, actual allowlist filesystem and PID isolation. Reject unsupported/degraded combinations.
- Protocol `botmux.bytedcli-exec.v1`, route `POST /api/bytedcli-exec`; request accepts no identity fields.
- argv ≤256 entries/64 KiB; decoded inputs ≤2 MiB, HTTP body ≤3 MiB; combined output ≤16 MiB; execution default60s/max120s.
- Per session4 reads/1 write; daemon16 executions/max4 writes;64 waiters,5s queue timeout;128 MiB global output budget.
- Recheck execution/policy/auth epoch/binding/delegation after waits and before dispatch/result. Write intent fsync before dispatch. Uncertain post-dispatch failure means `write_outcome_unknown`; never automatically retry writes.
- Tests use temporary HOME and fake CLI/providers, never production credentials/business writes/live systemd/tmux. TS child tests use `test/helpers/ts-runner.ts`; independent probes use `bun scripts/fenced-run.ts -- ...`.
- Use installed dependencies; no install, live restart, wrapper claim, push or release. Commit format `type(scope): 中文描述`; public sources contain no deployment hostnames/real people.

### Task 1: Configuration, protocol and audited command policy

**Files:** Modify `src/services/trigger-user-auth.ts`, `src/core/identity-policy.ts`; create `src/core/bytedcli-operation-policy.ts`, `src/cli/bytedcli-exec-protocol.ts`, operation audit documentation and focused tests.

**Interfaces:** Produce `bytecloudBrokerEnabled(config): boolean`; new config enum. Produce `parseBytedcliOperation(argv, inputs?)` returning canonical operation descriptor (id, effect read/write/auth/help, argv, region, resources, staged input requirements). Export typed broker request/response and strict validation. Later tasks consume these exports; document exact final types in report.

- [ ] Write failing tests for enum roundtrip/inert mode/legacy per-capability sources, safe read and write classification, aliases/flags/equals/repetition/`--`/optional boolean grammar, hostile identity overrides anywhere, and input limits.
- [ ] Run `bun run test -- test/trigger-user-auth.test.ts test/identity-policy.test.ts test/bytedcli-operation-policy.test.ts test/bytedcli-exec-protocol.test.ts`; confirm expected red evidence before production edits.
- [ ] Audit installed `0.199.0` command and handler source. Record allowed argument schemas and upstream effects, and open only reviewed subsets of the design's candidate catalog. Unknown fields, raw bodies, `--push`, local branch/hooks, attachments, auth token/AK/SK, `--jq`, arbitrary site/profile/proxy/trace reject. Implement parser with schema validation and canonical rebuild, no prefix/name-based effect guess.
  ```ts
  // Expected contract; final descriptor type is recorded in the report.
  const op = parseBytedcliOperation(['codebase', 'repo', 'get', '--repo', 'team/service']);
  // op.effect === 'read'; op.argv contains only canonical reviewed flags.
  ```
- [ ] Run focused tests to green and `bun run typecheck`; mutation proof should demonstrate removing a policy guard accepts an otherwise denied operation.
- [ ] Commit config/policy/protocol with `feat(bytedcli): 增加读写身份模式和审核命令目录`; report exact exports, tests, audited supported operations and excluded candidates.

### Task 2: Host credentials, bounded executor and durable audit

**Files:** Create `src/core/bytedcli-executor.ts`, `src/core/bytedcli-broker-audit.ts`, `src/core/bytedcli-broker-credentials.ts`, tests; modify `src/services/bytedcli-auth.ts` only to extract reusable credential/official-userinfo seams. Add machine profile parser/config in `src/config.ts` if applicable.

**Interfaces:** Consume Task1 operation/protocol. Produce dependency-injectable `BytedcliExecutor`/execution function accepting operation, frozen authority and lease resolver; lease returns short-lived JWT, safe official account fingerprint, source and `stillCurrent` callback. Machine leases from trusted daemon HOME/profile; actor leases reuse local/platform APIs. Produce audit intent/result append with nofollow, private permissions, fsync and safe metadata. Record final callable types for Task3.

- [ ] Failing behavioral tests: read succeeds with unauthed actor without consulting actor provider; write without actor/auth never spawns; wrong official account and missing region never spawn; cwd/env cannot inherit malicious repo/HOME/profile/plugin; timeout/output/intent audit failure/late revocation/repeated id/concurrency.
- [ ] Run new executor/credentials/audit tests and capture reds.
- [ ] Implement trusted CLI discovery/version check, serialized trusted credential leases, official userinfo validation against the verified enterprise account (not JWT decode alone), local/platform/auto matrix and epoch/region fences. Execute in fresh private HOME/cwd with minimal trusted env and request JWT. Support no arbitrary host files; accept bounded immutable snapshots only, staged after operation schema validation. Clear active and shaped credentials from returned output. Implement resource quotas, queue deadline, cancellation/child cleanup, dedup frozen tuple+input digest, bounded buffers. Persist write intent before dispatch; any uncertainty after dispatch/audit result failure yields unknown.
  ```ts
  // Dependency seam tests must observe dispatch, not internal constants.
  const dispatches: string[][] = [];
  // denied write => dispatches.length === 0
  // allowed read => only machine resolver touched
  ```
- [ ] Verify red/green, mutation guards and focused existing auth/region/epoch tests; typecheck.
- [ ] Commit with `feat(bytedcli): 实现宿主凭据租用执行和审计`; report integration API and remaining runtime integration requirements.

### Task 3: Peer authority, broker IPC and credential-free client

**Files:** Create `src/core/bytedcli-broker-authority.ts`, `src/core/bytedcli-broker.ts`, `src/cli/bytedcli-exec.ts`; modify `src/core/dashboard-ipc-server.ts`, `src/cli.ts`, `src/core/self-spawn.ts`, binary entry registrations and tests.

**Interfaces:** Consume operation/executor and `resolveDaemonCurrentExecution`. Produce broker handler dependency seam resolving trusted peer→frozen authority plus current-policy reader; routes never trust request identity. Produce credential-free client invoked by wrapper via `resolveEntrySpawn` / self-reexec. Containment record contract is consumed and populated in Task4: generation-bound protocol, filesystem allowlist, protected roots and PID namespace proof; absent report refuses.

- [ ] Failing real HTTP broker tests: body/identity fields/foreign peer refused; A execution uses identityTurn while B message arrives; reads require conversation permission but not actor authorization; actor required for writes, verified delegation/explicit runAs allowed, implicit owner denied; change policy/worker/auth/delegation while waiting rejects. Client preserves output/exit code and never retries unknown writes.
- [ ] Run tests red before production changes.
- [ ] Extract/reuse current actor/permission/delegation and epoch seams rather than duplicating identity publication logic. Freeze tuple and policy/binding/task authority, check throughout executor flow. Add bounded peer-authorized route with outer IPC exemption plus independent handler checks. Close old identity/background exports when live or frozen mode is strict; recheck live policy after async old-route waits. Request parsing must not mint or publish credentials. Client snapshots permitted files/stdin within Agent sandbox and sends no HOME/PID/token. Route is disabled until actual containment record is present.
  ```ts
  const identityTurnId = execution.identityTurnId ?? execution.turnId;
  // actor comes from daemon turn/delegation records, not body/environment.
  ```
- [ ] Run targeted route/client/authority and current-execution/delegation regression tests plus typecheck. Mutation: remove before-dispatch authority guard and confirm fake upstream write becomes observable and test fails.
- [ ] Commit `feat(bytedcli): 接入执行主体校验和无凭据代理协议`; report required wrapper and worker wiring.

### Task 4: Close credential exports and enforce runtime containment

**Files:** Modify `src/core/cli-identity.ts`, `src/core/turn-cli-identity.ts`, `src/core/bytedcli-identity-renewal.ts`, `src/worker.ts`, `src/core/worker-pool.ts`, `src/core/types.ts`, `src/types.ts`, `src/adapters/cli/fs-policy.ts`, `src/adapters/cli/read-isolation.ts`, `src/utils/child-env.ts`, `src/core/env-policy.ts`; focused helper module and tests as necessary.

**Interfaces:** Consume Task3 containment contract and client entry. Worker sends generation-bound actual isolation report after verified cold spawn. Daemon validates report with actual worker/current-generation process provenance; broker consumes it. Policy snapshot remains sticky strict for old sessions so disabling config cannot expose credentials. Existing publication/renewal paths check mode across waits and never mint/export strict ByteCloud material.

- [ ] Failing tests: strict wrapper goes exclusively to client; Codebase/Bits/git askpass cannot export; Meego branch no ByteCloud escape; reads never trigger turn-grant publication; stale async mint/renew/old IPC cannot recreate exports after change; protected roots cannot be reopened by readonly/readwrite grants; unsupported backend/platform/adopt/models/PID degradation refuse.
- [ ] Run focused tests red.
- [ ] Replace strict bytedcli wrapper with no-credential client, deny standalone credential tools and `BOTMUX_AS`, preserve local git and commit identity. Clear prior artifacts before a fresh strict session; never reuse a previously token-exposed worker. Protect default SDK stores/all profiles/personal homes/platform/broker roots/config override sources and installation tree, including future files and parent grants. Use actual Linux allowlist+PID namespace; reject Seed/Relay/shared authentication and unsupported matrix cells. Publish honest report bound to cold-spawn generation; no report inferred only from configured sandbox mode. Normalize child env without caller credential overrides; old mode remains unchanged.
  ```ts
  if (bytecloudBrokerEnabled(policy)) {
    // Publish no ByteCloud credential, including companion mirrors.
    // Wrapper requires host broker; containment failure refuses launch.
  }
  ```
- [ ] Verify behavioral sandbox credential visibility and process probes through fenced helpers, publication/renewal, another CLI and Lark/Meego/old Codebase/Bits/git regression tests; typecheck. Do not touch live fleet.
- [ ] Commit `feat(bytedcli): 封闭凭据旁路并强制隔离执行`; report any support restriction precisely.

### Task 5: Dashboard, compatibility and end-to-end acceptance

**Files:** Modify `src/services/bot-config-store.ts`, `src/bot-registry.ts`, `src/dashboard/web/bot-defaults.ts`, `bot-defaults-page.tsx`, `i18n.ts`, public usage/release documentation, acceptance tests; narrow integration corrections required by acceptance.

**Interfaces:** Consume new config parser and runtime strict predicate. All save/load/merge/defaults/reset routes preserve execution enum and per-capability/owner/delegation/git fields. Display supported CLI/containment/catalog restrictions honestly.

- [ ] Failing save/roundtrip/UI model tests including old/new clients and invalid enum; complete fake-provider HTTP+client+executor tests for read without actor grant and actor-only writes, A/B overlap, policy/epoch changes, unknown outcomes.
- [ ] Run red, implement mode editor and config preservation, show mode only active when enabled and ByteCloud selected, document machine profile and terminate/rebuild rollout/reversion. Add actual supported catalog/help output and safe personal auth adapter projection if not already wired. Do not show auth tokens/device completion codes in UI/client outputs.
  ```json
  {"triggerUserAuth":{"enabled":true,"capabilities":["bytecloud"],"credentialSource":{"bytecloud":"local"},"bytecloudExecution":"read-machine-write-actor"}}
  ```
- [ ] Run acceptance plus impacted config/UI/identity/isolation regressions, `bun run typecheck`, `bun run build`, binary client self-reexec smoke with temporary HOME. Record local Bun version warning separately from pass/fail.
- [ ] Commit `feat(bytedcli): 完成模式配置和读写分离验收`; final independent whole-branch adversarial review must cover persistent audit, mid-flight intervention, partial writes and long operation overlap. Fix reviewed issues with separate tested commits, then deliver branch and exact tests/limitations, without live deployment.
