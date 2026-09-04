# Native Subagent Runtime Policy Design

## Context

Botmux can configure the model and reasoning effort used to launch a top-level
TraeCode session, but native `spawn_agent` calls are owned by TraeCode after the
session starts. The parent model may omit child runtime arguments, explicitly
choose different values, or use a built-in role such as `explorer` whose own
defaults differ from the parent. Consequently, a bot configured as
`GPT-5.6-Sol / ultra` can create children using `medium`, `high`, `GPT-5.4`, or
another supported runtime.

The Bot Config page needs a bot-wide policy for native TraeCode subagents. Model
and effort are independent dimensions, and each dimension needs two choices:

- **Pass through request (current behavior):** Botmux does not alter that field in the
  model-generated `spawn_agent` input. An explicit value chosen by the parent is
  preserved; an absent value is resolved by TraeCode and the selected role.
- **Custom:** Botmux replaces that child field with a configured value.

An isolated TraeCode 0.201.6 probe established that a `PreToolUse` hook matching
`spawn_agent` can rewrite the native tool's input. A parent running
`GPT-5.4 / low` produced a child running `GPT-5.6-Sol / high` after the hook
returned `hookSpecificOutput.updatedInput`. The same mechanism works when the
original call uses a full-history fork. A second probe established that built-in
role constraints remain authoritative: forcing `explorer` from its locked
`medium` effort to `high` is rejected explicitly by TraeCode.

## Scope

This release supports native `spawn_agent` calls made by Botmux-managed TraeCode
(`cliId: traex`) sessions. It does not change Botmux workflow `subagent` nodes,
cross-bot dispatch, or other CLI adapters. The policy applies recursively to
nested native subagents because their hooks retain the owning Botmux session
identity.

The release also fixes the related streaming-card bug where
`collab_agent_spawn_end` metadata is mistaken for the parent runtime. Parent
cards must only follow parent runtime records such as `turn_context`.

## Chosen architecture

Use a Botmux-owned, process-scoped TraeCode `PreToolUse` hook plus a private
daemon endpoint. This provides deterministic enforcement without modifying the
user's global TraeCode config or replacing unrelated hooks such as Flux. The
hook is installed through a `-c hooks.PreToolUse=...` launch override for both
plain TraeCode TUI and Botmux's TraeCode app-server process. A live probe proved
that this process layer coexists with the existing global hook and that the
post-tool payload contains the rewritten arguments.

The alternatives are rejected as primary implementations:

- Prompt-only instructions are advisory and cannot guarantee that the model
  supplies or omits the requested fields.
- Native TraeCode configuration would be the cleanest long-term ownership seam,
  but it requires an upstream runtime change and cannot be delivered in the
  Botmux repository alone.

## Configuration contract

Add one optional `nativeSubagentRuntime` object to `BotConfig`. Each missing
dimension means pass-through, preserving the existing behavior and keeping old
`bots.json` files byte-compatible.

```ts
type NativeSubagentModelPolicy = { mode: 'custom'; value: string };

type NativeSubagentEffortPolicy = {
  mode: 'custom';
  value: CodexReasoningEffort;
};

interface NativeSubagentRuntimePolicy {
  model?: NativeSubagentModelPolicy;
  reasoningEffort?: NativeSubagentEffortPolicy;
}

interface BotConfig {
  nativeSubagentRuntime?: NativeSubagentRuntimePolicy;
}
```

Only `custom` is accepted in a configured dimension. The removed legacy
`inherit` mode is invalid; config loading diagnoses it and drops the whole
policy instead of silently applying a different runtime.

The Dashboard expands absence into the visible `passthrough` state. When both
dimensions are pass-through, persistence removes `nativeSubagentRuntime` rather
than writing an empty object. `model_provider` is not exposed as a separate
control in this release: custom model overrides use the current Trae provider
(`trae`) and always write the provider/model pair together.

The Dashboard mutation contract uses field-presence semantics:

- omitted `nativeSubagentRuntime`: preserve the stored policy, allowing old
  Dashboard clients to save unrelated agent settings safely;
- `nativeSubagentRuntime: null`: delete the policy and restore pass-through;
- a valid object: atomically replace the policy.

Switching the bot away from `traex` removes this Trae-specific policy, matching
the existing behavior for unsupported reasoning-effort settings. Cloning a bot
copies the policy because it is behavior configuration, not instance state.
Portable preset export remains unchanged in this release.

## Resolution and rewrite semantics

For each `spawn_agent` call, Botmux starts with the original tool input and
applies each configured dimension independently:

| Policy | Model fields | Effort field |
| --- | --- | --- |
| pass-through | Preserve `model` and `model_provider` exactly | Preserve `reasoning_effort` exactly |
| custom | Set `model` to the configured value and `model_provider` to `trae` | Set `reasoning_effort` to the configured value |

All unrelated input fields, including task, role, fork/history mode, service
tier, and background behavior, remain byte-for-byte equivalent at the JSON
value level. A model policy always treats `model` and `model_provider` as one
atomic pair so a stale provider cannot be paired with the selected model.

Botmux validates a custom effort against a custom model at save time when both
are known. Combinations involving pass-through values are validated at call time
by TraeCode. Built-in agent-role locks also remain TraeCode's authority. A
conflict fails the spawn and is surfaced to the parent; Botmux does not silently
drop or downgrade the configured value.

## Runtime flow

1. A Botmux-managed TraeCode process starts with a process-scoped
   `PreToolUse` hook matching only `spawn_agent`. Existing global/project hooks
   continue to run.
2. TraeCode sends the hook payload, including `session_id` and original
   `tool_input`, to the Botmux hook command.
3. The hook requires the managed `BOTMUX_SESSION_ID` and
   `BOTMUX_LARK_APP_ID`. Non-Botmux sessions return no output.
4. The hook requests only the current bot policy from the owning daemon over the
   existing authenticated loopback channel. Reading the policy at call time
   makes Dashboard changes effective for subsequent spawns in already-running
   managed sessions whose process contains the hook.
5. A pure policy function rewrites only the configured dimensions and emits a
   TraeCode `PreToolUse` allow directive with the complete `updatedInput`. With
   no configured dimensions it emits no directive.
6. TraeCode performs its normal schema, model-catalog, fork, and role validation
   and either starts the child or reports the conflict to the parent.

The hook transport is fail-open for transport, parsing, and ordinary policy
lookup failures: daemon unavailability, malformed hook input, malformed daemon
payloads, failed response authentication, or an invalid stored policy all emit a
bounded diagnostic and then allow the spawn. This preserves Botmux's existing
hook resilience: a daemon outage must not make an otherwise usable local
TraeCode session unable to spawn children. The only intentional fail-closed case
is an explicit `429` overload response from the selected trusted/protected daemon
destination, which denies `spawn_agent` so quota pressure cannot bypass a
configured runtime policy. No diagnostic contains credentials or the rest of the
bot configuration.

For sandboxed/read-isolated callers, runtime-policy lookup authority is
session-lifetime and intentionally distinct from the live turn send capability.
The worker publishes a stable `policyCapability` for the current worker
generation while the ordinary managed-origin `capability` continues to rotate
per turn. Turn terminal and intentional CLI restart revoke only the live send
capability; runtime-policy lookup survives those edges and is revoked only when
the worker generation itself ends or is replaced. This keeps protected runtime
policy fetches available for long-lived panes after live send authority has been
cleared, without widening any route that still requires the live send token.

The daemon serves the policy from one authoritative in-memory per-bot state:
absent, valid, or invalid. It never rereads `bots.json` on the spawn hot path.
An invalid state is reported as a fixed flag without returning the raw value.

Sessions created after this feature is installed always contain the process hook.
Policy edits therefore apply to their next spawn without restarting the parent.
The hook command is rendered through the dedicated stable daemon-updated
`botmux-native-subagent-runtime-hook` entrypoint rather than a checkout-local
`dist/cli.js` path or the generic `botmux` wrapper, so long-lived panes pick up
the current Node or standalone build automatically without coupling sandbox
relay overlay to the native hook path. For persistent sandboxed panes,
warm reattach remains gated by the daemon-managed isolation marker and its policy
digest: install-root or native-hook protocol drift invalidates warm reattach and
forces a cold spawn under the current policy instead of inheriting stale runtime
state. A TraeCode process that survived an upgrade from an older Botmux build may
still need one session restart because it started before the process-scoped hook
existed.

## Dashboard behavior

The Agent section gains a `Native subagent runtime` subsection for `traex` bots.
It contains two independent controls:

- `Subagent model`: `Pass through request`, `Custom`.
- `Subagent effort`: `Pass through request`, `Custom`.

Selecting Custom reveals the existing model picker or a model-aware effort
picker. The effort choices use the existing Trae model capability catalog. Help
text explains that pass-through preserves parent-generated arguments and role
locks can reject a custom override.

The fields use touched/presence tracking so an older or partially loaded page
cannot erase a policy while saving another Agent setting. The save response is
authoritative and rehydrates both controls. No active sessions are closed merely
because this policy changes.

## Streaming-card correction

`runtimeFromTraexEntry` currently accepts any rollout record containing
`payload.model` or `payload.reasoning_effort`. Native
`collab_agent_spawn_end` records contain the child's values, so the parent
streaming card adopts them until another parent `turn_context` appears. Runtime
extraction will be restricted to `turn_context` records. Both the incremental
drain and backward bootstrap scan share that function, so one predicate fixes
live updates and resume-time reconstruction.

## Error handling and security

- The hook matches exactly `spawn_agent`; all other tool calls are no-ops.
- Hook stdin is size-bounded and parsed as an object. Malformed input produces no
  rewrite and a debug diagnostic.
- Host requests retain the route-and-port-bound dashboard-secret request HMAC
  and add a random nonce challenge. The daemon signs the exact status and
  response bytes with that challenge, method, path, port, session, app, and
  daemon boot identity.
- Sandboxed callers use the rotating managed-origin capability only as a local
  HMAC key; the raw capability is never transmitted. The request proof binds a
  protected read-only per-channel claim to timestamp, nonce, method, path, port,
  session, app, boot, turn, and dispatch attempt, and the hook prefers that
  protected claim's IPC port over mutable discovery data.
- Native subagent runtime policy fetches do not key request authentication from
  the live turn capability. They use the stable per-generation
  `policyCapability`, so the route remains callable after turn terminal clears
  the live send token, but any future generation rotation immediately invalidates
  the old policy authority.
- Sandboxed response authenticity does not reuse the capability HMAC. Instead the
  daemon writes a short-lived read-only exact-response proof keyed by the managed
  origin channel, and the hook accepts the response only when that proof matches
  the exact response bytes plus status, method, path, port, session, app, boot,
  turn, and dispatch attempt.
- Nonces are replay-protected, timestamps allow at most 30 seconds of skew, and
  the preauth, nonce-store, and outstanding-proof paths are all explicitly
  bounded; an exhausted preauth/nonce/proof quota returns `429`.
- The endpoint returns only normalized policy data; it never returns credentials
  or arbitrary bot configuration.
- Response reads have a two-second deadline and a streaming 16 KiB cap; overflow
  or timeout cancels the reader before parsing.
- The hook does not read transcript files or infer the parent runtime.
- Model strings are trimmed, non-empty, and bounded. Effort values reuse the
  existing canonical effort union and model compatibility helpers.
- The hook never changes role, prompt, history selection, task name, or worktree
  settings.
- An explicit TraeCode role/model/effort incompatibility remains a visible spawn
  error. There is no silent fallback.

## Verification

Automated coverage will prove:

- old/missing config normalizes to pass-through; malformed policies are dropped;
- all four independent model/effort mode combinations rewrite only the intended
  fields;
- custom model writes `model_provider: trae`; pass-through preserves an existing
  cross-provider pair;
- unsupported legacy modes are dropped at config load; daemon unavailability
  remains fail-open;
- sandbox policy lookup survives turn terminal / intentional restart, while the
  old live send capability is rejected and rotated-out `policyCapability`
  generations are rejected;
- explicit daemon overload (`429`) denies the spawn while other IPC/auth/parse
  failures still fail open, and unauthenticated/forged `429` responses do not
  deny the spawn;
- process hook arguments are present in plain TUI and app-server launches and do
  not remove unrelated hooks;
- host responses bind challenge/method/path/port/status/exact bytes/session/app/boot,
  while sandbox responses require the daemon-written exact-response proof rather
  than a capability-HMAC response;
- Dashboard GET/PUT preserves, replaces, clears, validates, and renders the policy;
- clone retains the policy while public bot summaries and current preset export do
  not expose it;
- `collab_agent_spawn_end` no longer changes parent runtime while later
  `turn_context` records still do;
- the dedicated daemon-written `botmux-native-subagent-runtime-hook` entrypoint is used for the hook command, and persistent
  sandboxed panes cold-spawn when the isolation policy digest drifts instead of
  inheriting stale hook/runtime assumptions;
- build, focused suites, the full unit suite, and a real isolated TraeCode spawn
  smoke all pass.

The live smoke must cover pass-through and custom behavior. It must also
confirm that an incompatible built-in role produces a clear failure rather than a
downgrade.

## Implementation units and dependency graph

1. **Policy contract and rewrite engine** — types, normalization, validation,
   pure rewrite behavior, private daemon API, and hook CLI protocol. Independently
   testable and committed first.
2. **Runtime hook wiring** — process-scoped hook arguments for plain TUI and RPC
   app-server launches. True dependency on Unit 1's command/protocol.
3. **Dashboard and persistence UI** — private payload, GET/PUT, React controls,
   i18n, docs, and clone behavior. Depends only on Unit 1's persisted schema; it
   shares an interface but not runtime behavior with Unit 2.
4. **Streaming-card isolation fix** — restrict Trae runtime extraction to parent
   `turn_context`. Independent of Units 1–3 and safe to implement in parallel.
5. **Integrated verification** — merge Units 2–4 into the single integration
   branch, run build/unit/live smoke, then push the verified branch. True
   dependency on all implementation units.

After Unit 1 freezes the shared contract, Units 2, 3, and 4 have disjoint write
scopes and can run in parallel worktrees. Every unit is independently reviewed,
committed, and pushed before integration.

## Out of scope

- Botmux workflow `subagent` nodes and cross-bot dispatch.
- Per-role overrides; this release defines one bot-wide policy.
- Selecting a provider independently of the model.
- Configuring `model_backend_variant` for children.
- Silently changing `agent_type` to make an override acceptable.
- Persisting this policy in portable preset export/import.
- Upstream TraeCode changes.
