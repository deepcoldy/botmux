# Native Subagent Runtime Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bot-level, independently configurable model and effort policies for TraeCode native subagents, enforce them through a process-scoped hook, and prevent child runtime metadata from changing the parent streaming card.

**Architecture:** A pure `native-subagent-runtime-policy` module owns validation and rewrite semantics. The Dashboard persists an optional bot policy through the existing private Agent endpoint; every Botmux-managed TraeCode process receives a narrow `PreToolUse(spawn_agent)` hook that fetches the current policy over authenticated loopback IPC and rewrites only model/provider/effort fields. The transcript reader independently accepts runtime identity only from `turn_context`.

**Tech Stack:** TypeScript, React 19, Node/Bun, Vitest, TraeCode hook protocol, Botmux daemon IPC.

## Global Constraints

- Scope is native TraeCode `spawn_agent` only; do not change Workflow subagents, cross-bot dispatch, or non-Trae adapters.
- Model and effort modes are independent: pass-through or custom.
- Legacy `inherit` values are invalid and the config loader drops the whole policy.
- Missing policy preserves current behavior byte-for-byte and does not close live sessions.
- Model override always treats `model_provider: "trae"` and `model` as an atomic pair.
- Preserve every unrelated spawn field. Do not rewrite role, prompt, history/fork mode, service tier, or background mode.
- Built-in role conflicts must remain explicit TraeCode errors; never silently downgrade, remove a policy, or change the role.
- The hook must compose with existing global/project hooks and must not mutate `~/.trae/hooks.json`.
- Hook transport failures and malformed stored state fail open with diagnostics, except that an explicit authenticated daemon `429` overload response must deny the spawn.
- Never send the managed-origin capability; use it only as a local HMAC key for the sandbox request proof, and authenticate sandbox responses through the daemon-written exact-response proof.
- Bound the response body to 16 KiB and the complete hook request to two seconds.
- Bound preauth admission, nonce replay storage, and outstanding response-proof issuance so overload returns `429` rather than silently bypassing policy.
- Host response HMAC must bind challenge, method, path, port, status, exact bytes, session, app, and boot identity.
- Sandboxed callers must prefer the protected read-only per-channel claim's IPC port over mutable discovery data.
- Runtime-policy lookup must use a separate session-lifetime `policyCapability`; turn terminal and intentional restart revoke only the live send capability, while worker-generation turnover revokes both.
- Persistent sandboxed panes must treat isolation-policy digest drift as a cold-spawn boundary; no inherit mode exists anywhere in this feature.
- Use the shared worktree `node_modules` symlink; never run `bun install` in a worktree.
- Every implementation unit follows RED-GREEN, is committed, and is pushed before the next unit begins.

---

### Task 1: Freeze the policy and rewrite contract

**Files:**
- Create: `src/services/native-subagent-runtime-policy.ts`
- Modify: `src/bot-registry.ts`
- Test: `test/native-subagent-runtime-policy.test.ts`
- Test: `test/bot-registry.test.ts`

**Interfaces:**
- Produces `NativeSubagentRuntimePolicy`, `normalizeNativeSubagentRuntimePolicy(raw)`, and `rewriteNativeSubagentSpawnInput(input, policy)`.
- The normalizer returns `{ ok: true, value?: policy }` or `{ ok: false, error }`; an absent/empty policy is a valid `undefined`, while malformed persisted state remains diagnosable.
- The rewriter returns `{ kind: 'unchanged', input }` or `{ kind: 'rewritten', input }`.

- [ ] **Step 1: Write failing pure-contract tests**

Cover valid independent modes, trimmed custom model, invalid modes/values/extra keys (including the removed legacy mode), empty-object canonicalization, immutable input handling, all four mode combinations, atomic model/provider replacement, and unrelated-field preservation.

- [ ] **Step 2: Verify RED**

Run:

```bash
bunx vitest run --project unit test/native-subagent-runtime-policy.test.ts test/bot-registry.test.ts
```

Expected: failures identify the missing module/type and absent parser behavior.

- [ ] **Step 3: Implement the minimal pure module and config loader integration**

Use these shapes exactly:

```ts
type NativeSubagentModelPolicy = { mode: 'custom'; value: string };
type NativeSubagentEffortPolicy = {
  mode: 'custom';
  value: CodexReasoningEffort;
};
type NativeSubagentRuntimePolicy = {
  model?: NativeSubagentModelPolicy;
  reasoningEffort?: NativeSubagentEffortPolicy;
};
```

`rewriteNativeSubagentSpawnInput` must clone the top-level input, preserve an
existing provider/model pair in pass-through mode, write provider/model together
for custom mode, and change `reasoning_effort` only when its policy says so.

- [ ] **Step 4: Verify GREEN and commit**

```bash
bunx vitest run --project unit test/native-subagent-runtime-policy.test.ts test/bot-registry.test.ts
bunx tsc --noEmit --pretty false
git diff --check
git add src/services/native-subagent-runtime-policy.ts src/bot-registry.ts test/native-subagent-runtime-policy.test.ts test/bot-registry.test.ts
git commit -m "feat(subagent): 定义运行时策略契约"
git push fork feat/subagent-runtime-policy
```

### Task 2: Add authenticated policy lookup and hook CLI

**Files:**
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/adapters/hook-command.ts`
- Modify: `src/cli.ts`
- Test: `test/dashboard-ipc.test.ts`
- Test: `test/hook-command.test.ts`
- Test: `test/hook-command-compiled-form.test.ts`
- Create: `test/native-subagent-runtime-hook.test.ts`

**Interfaces:**
- Produces `POST /api/sessions/:sessionId/native-subagent-runtime`, returning only `{ ok: true, policy? }` or `{ ok: true, invalidPolicy: true }`.
- Produces `nativeSubagentRuntimeHookCommand()` and CLI command `native-subagent-runtime-hook`.
- Consumes Task 1's normalizer and rewrite function.

- [ ] **Step 1: Write failing daemon-route tests**

Test trusted-host challenge request/response HMAC, managed-origin capability-keyed request/response HMAC, nonce replay, timestamp skew, exact path/port/session/turn/attempt binding, cross-session rejection, stale/missing capability rejection, absent policy, valid policy, and invalid persisted policy. Assert the route derives the bot from the authenticated session and never accepts a caller-supplied bot ID.

- [ ] **Step 2: Write failing hook-command tests**

Test Node and standalone-binary command rendering. Test hook stdin bounds, a two-second deadline, streaming rejection above 16 KiB, missing/tampered response signatures, and these cases: non-`spawn_agent` no-op; malformed input fail-open; daemon failure fail-open; pass-through no directive; successful rewrite emits only valid hook JSON on stdout; stderr contains bounded diagnostics only.

- [ ] **Step 3: Verify RED**

```bash
bunx vitest run --project unit \
  test/dashboard-ipc.test.ts \
  test/hook-command.test.ts \
  test/hook-command-compiled-form.test.ts \
  test/native-subagent-runtime-hook.test.ts
```

- [ ] **Step 4: Implement the route and CLI protocol**

Host callers keep the route-and-port-bound dashboard-secret request HMAC and add
a random 32-byte response challenge. The host response HMAC must bind challenge,
method, exact path, actual port, status, exact response bytes, session, app, and
daemon boot identity. Sandboxed callers prefer the protected read-only
per-channel claim's IPC port and use the session-lifetime `policyCapability`
only as a local HMAC key, never as a transmitted bearer; the ordinary live send
capability remains reserved for turn-bound send/ask routes. The sandbox request
proof binds timestamp, nonce, method, exact path, actual port, session, app,
boot, current turn, and dispatch attempt. Sandbox response authenticity is not
another capability HMAC: the daemon writes a short-lived read-only
exact-response proof, and the hook must verify that proof before JSON parsing.
Preauth admission, nonce replay, and outstanding proof issuance are all bounded;
an exhausted bound returns `429`, and the hook intentionally denies
`spawn_agent` only for an authenticated overload response while other
transport/protocol/authentication failures, including forged `429` responses,
remain fail-open. The daemon serves one authoritative in-memory
absent/valid/invalid policy state without rereading `bots.json`. The hook
cancels a stream that exceeds 16 KiB or the two-second deadline. It does not
read the transcript. No valid policy means empty stdout and exit 0.

- [ ] **Step 5: Verify GREEN, commit, and push**

```bash
bunx vitest run --project unit \
  test/native-subagent-runtime-policy.test.ts \
  test/dashboard-ipc.test.ts \
  test/hook-command.test.ts \
  test/hook-command-compiled-form.test.ts \
  test/native-subagent-runtime-hook.test.ts
bunx tsc --noEmit --pretty false
git diff --check
git add src/core/dashboard-ipc-server.ts src/adapters/hook-command.ts src/cli.ts test/dashboard-ipc.test.ts test/hook-command.test.ts test/hook-command-compiled-form.test.ts test/native-subagent-runtime-hook.test.ts
git commit -m "feat(subagent): 接入运行时策略钩子"
git push fork feat/subagent-runtime-policy
```

### Task 3: Wire the process-scoped Trae hook

**Files:**
- Modify: `src/adapters/cli/types.ts`
- Modify: `src/adapters/cli/traex.ts`
- Modify: `src/codex-rpc-engine.ts`
- Modify: `src/worker.ts`
- Test: `test/cli-adapters.test.ts`
- Test: `test/codex-rpc-engine.test.ts`
- Test: `test/traex-worker-bridge-wiring.test.ts`
- Create: `test/traex-native-subagent-hook-wiring.test.ts`

**Interfaces:**
- Consumes `nativeSubagentRuntimeHookCommand()` from Task 2.
- Produces one Trae `-c hooks.PreToolUse=[...]` override for the actual model-owning process.

- [ ] **Step 1: Write failing launch-wiring tests**

Assert ordinary fresh/resume Trae launches receive exactly one hook override;
Codex and other adapters do not; the remote viewer remains unchanged; the Trae
app-server process receives the override; existing global/project hooks still
fire beside the process hook; and required session/auth environment is present.
Use `test/helpers/ts-runner.ts` for TypeScript child processes.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run --project unit \
  test/cli-adapters.test.ts \
  test/codex-rpc-engine.test.ts \
  test/traex-worker-bridge-wiring.test.ts \
  test/traex-native-subagent-hook-wiring.test.ts
```

- [ ] **Step 3: Implement process-scoped wiring**

Add one optional adapter build argument for the hook command, render its TOML
override in a pure helper, and add a generic app-server spawn-config argument to
`CodexRpcEngine`. Pass it only for `cliId === 'traex'`. Always install the hook
for managed Trae sessions—even when the current policy is absent—so a Dashboard
change can affect the next spawn without restarting a newly created session. The
rendered command must go through the dedicated daemon-written
`botmux-native-subagent-runtime-hook` entrypoint rather than a checkout-local
entrypoint or the generic `botmux` wrapper, so long-lived panes pick up the
current Node or standalone build without exempting the hook path inside sandbox
overlay selection. Persistent sandboxed panes still warm-reattach only when the
daemon-managed isolation marker and policy digest match; install-root or
native-hook protocol drift forces a cold spawn under the current policy.

- [ ] **Step 4: Verify GREEN, commit, and push**

```bash
bunx vitest run --project unit \
  test/cli-adapters.test.ts \
  test/codex-rpc-engine.test.ts \
  test/traex-worker-bridge-wiring.test.ts \
  test/traex-native-subagent-hook-wiring.test.ts
bunx tsc --noEmit --pretty false
git diff --check
git add src/adapters/cli/types.ts src/adapters/cli/traex.ts src/codex-rpc-engine.ts src/worker.ts test/cli-adapters.test.ts test/codex-rpc-engine.test.ts test/traex-worker-bridge-wiring.test.ts test/traex-native-subagent-hook-wiring.test.ts
git commit -m "feat(traex): 强制原生子代理运行时策略"
git push fork feat/subagent-runtime-policy
```

### Task 4: Add Dashboard persistence and controls

**Files:**
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/bot-payload.ts`
- Modify: `src/dashboard/web/bot-defaults.ts`
- Modify: `src/dashboard/web/bot-defaults-page.tsx`
- Modify: `src/dashboard/web/i18n.ts`
- Modify: `bots.json.example`
- Modify: `docs-site/docs/zh/bots-json.md`
- Modify: `docs-site/docs/en/bots-json.md`
- Test: `test/dashboard-ipc.test.ts`
- Test: `test/dashboard-bot-payload.test.ts`
- Test: `test/dashboard-bot-defaults-cliid.test.ts`
- Test: `test/dashboard-clone-prefill.test.ts`
- Test: `test/agent-preset.test.ts`

**Interfaces:**
- `PUT /api/bot-agent`: absent policy preserves, `null` clears, valid object replaces, empty policy canonicalizes to deletion, invalid input returns HTTP 400.
- Private Bot Defaults payload includes the policy; public bot summary and portable preset exclude it.

- [ ] **Step 1: Write failing API/payload tests**

Cover GET projection, PUT preserve/replace/clear, invalid shapes, custom
model-effort compatibility, switch-away cleanup, live registry mirroring, clone
copying, and private/public payload boundaries.

- [ ] **Step 2: Write failing React tests**

Cover Trae-only visibility, independent two-state controls, conditional custom
pickers, rehydration, untouched-field omission, all-pass-through `null`,
authoritative response patching, and switching away from Trae.

- [ ] **Step 3: Verify RED**

```bash
bunx vitest run --project unit \
  test/dashboard-ipc.test.ts \
  test/dashboard-bot-payload.test.ts \
  test/dashboard-bot-defaults-cliid.test.ts \
  test/dashboard-clone-prefill.test.ts \
  test/agent-preset.test.ts
```

- [ ] **Step 4: Implement Dashboard and persistence**

Reuse `ModelPickerField`, `DropdownField`, detected Trae model candidates,
reasoning-effort capability helpers, and the existing atomic `rmwBotEntry` path.
The model/effort policy selectors use `passthrough | custom` as UI state; only
`custom` is persisted. Add matching Chinese and English
labels/help and document the JSON shape. Do not add the policy to portable
presets in this release.

- [ ] **Step 5: Verify GREEN, commit, and push**

```bash
bunx vitest run --project unit \
  test/dashboard-ipc.test.ts \
  test/dashboard-bot-payload.test.ts \
  test/dashboard-bot-defaults-cliid.test.ts \
  test/dashboard-clone-prefill.test.ts \
  test/agent-preset.test.ts \
  test/dashboard-i18n.test.ts \
  test/dashboard-i18n-c5.test.ts
bunx tsc --noEmit --pretty false
git diff --check
git add src/core/dashboard-ipc-server.ts src/dashboard.ts src/dashboard/bot-payload.ts src/dashboard/web/bot-defaults.ts src/dashboard/web/bot-defaults-page.tsx src/dashboard/web/i18n.ts bots.json.example docs-site/docs/zh/bots-json.md docs-site/docs/en/bots-json.md test/dashboard-ipc.test.ts test/dashboard-bot-payload.test.ts test/dashboard-bot-defaults-cliid.test.ts test/dashboard-clone-prefill.test.ts test/agent-preset.test.ts
git commit -m "feat(dashboard): 配置子代理模型与强度"
git push fork feat/subagent-runtime-policy
```

### Task 5: Isolate parent streaming-card runtime metadata

**Files:**
- Modify: `src/services/traex-transcript.ts`
- Test: `test/traex-transcript.test.ts`

**Interfaces:**
- Runtime extraction accepts `turn_context` records only.
- Incremental drain and backward bootstrap scan retain independent latest-wins model/effort behavior across valid parent `turn_context` records.

- [ ] **Step 1: Write failing regressions**

Append `collab_agent_spawn_end` fixtures carrying a different model/effort after
a valid parent `turn_context`. Assert both `drainTraexRollout` and
`readLatestTraexRuntime` retain the parent values. Add another non-runtime event
with model-like fields to enforce the whitelist.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run --project unit test/traex-transcript.test.ts
```

- [ ] **Step 3: Implement the minimal predicate and verify GREEN**

Make `runtimeFromTraexEntry` return `undefined` unless
`entry.type === 'turn_context'`; keep existing field fallback within valid
turn-context records.

```bash
bunx vitest run --project unit test/traex-transcript.test.ts test/traex-worker-bridge-wiring.test.ts
bunx tsc --noEmit --pretty false
git diff --check
git add src/services/traex-transcript.ts test/traex-transcript.test.ts
git commit -m "fix(traex): 隔离子代理运行时元数据"
git push fork feat/subagent-runtime-policy
```

### Task 6: Integrated verification and live acceptance

**Files:**
- Modify only if a verified defect requires a focused TDD fix.
- Create screenshots under `docs/assets/` only after the UI is running.

- [ ] **Step 1: Run focused contract and integration suites**

```bash
bunx vitest run --project unit \
  test/native-subagent-runtime-policy.test.ts \
  test/native-subagent-runtime-hook.test.ts \
  test/hook-command.test.ts \
  test/hook-command-compiled-form.test.ts \
  test/cli-adapters.test.ts \
  test/codex-rpc-engine.test.ts \
  test/traex-worker-bridge-wiring.test.ts \
  test/traex-transcript.test.ts \
  test/dashboard-ipc.test.ts \
  test/dashboard-bot-payload.test.ts \
  test/dashboard-bot-defaults-cliid.test.ts \
  test/dashboard-clone-prefill.test.ts \
  test/agent-preset.test.ts
```

- [ ] **Step 2: Run static/build gates**

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run build:bun
bun run verify:binary
git diff --check
```

- [ ] **Step 3: Run broad suites with baseline comparison**

```bash
bun run test
bun run test:all
bun run test:bun
```

Compare failures against the pre-change baseline. Re-run any timing-sensitive
integration failure in isolation before classifying it.

- [ ] **Step 4: Deploy the feature checkout temporarily and perform live smoke**

Record the current global Botmux target and hashes of `~/.trae/hooks.json` and
project hooks, then run:

```bash
bun run switch:here
bun run daemon:restart
```

In an isolated Botmux/Trae session verify pass-through, custom, nested child
spawn, hook coexistence, role-conflict failure, streaming-card isolation, and
policy update without session closure. Capture the Dashboard's
pass-through/custom and non-Trae-hidden states. Restore the
recorded canonical checkout with its own `bun run switch:here && bun run
daemon:restart`, then verify `command -v botmux`, daemon version, and hook hashes.

- [ ] **Step 5: Final review, fixes, commit, and push**

Run a specification review and code-quality review against the integration diff.
For each confirmed defect, add a failing regression before the fix. Then rerun
the relevant focused suite and all final gates. Commit screenshots or any
test-backed corrections as independently reviewable commits and push after each.
