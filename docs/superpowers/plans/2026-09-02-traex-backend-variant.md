# TraeX per-Bot backend variant implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-Bot TraeX backend-variant override so Dashboard users can choose inherit, Standard, or Max without changing global TraeX configuration.

**Architecture:** `modelBackendVariant` is an optional TraeX-only Bot configuration field. Missing means that Botmux sends no process override and TraeX inherits its user-global configuration; explicit `standard` and `max` are frozen on new sessions and forwarded only through the TraeX adapter. Dashboard receives and edits the same normalized field, while streaming-card runtime identity reads the frozen session value rather than guessing global configuration.

**Tech Stack:** TypeScript, Bun, Vitest, React Test Renderer, Botmux dashboard IPC, TraeX CLI adapter.

## Global Constraints

- Use exactly `modelBackendVariant?: 'standard' | 'max'`; its absence always means inherit TraeX global configuration.
- Only `cliId === 'traex'` may persist, carry, or launch the field; every other CLI clears it.
- Do not add a static model-to-variant capability catalog. TraeX owns compatibility validation.
- Preserve all existing Bot behavior: an omitted field must not add `model_backend_variant` to a launch command.
- The value is frozen for ordinary newly created sessions and copied by `forkSession`; historical frozen sessions lacking it remain valid and inherit.
- Keep normal model and reasoning-effort semantics unchanged.
- Do not run `bun install` in this worktree; it shares canonical `node_modules` by symlink.
- Each completed task must be independently tested, committed using `type(scope): 中文描述`, and pushed to `fork/feat/traex-backend-variant`.

---

### Task 1: Persist and launch an explicit TraeX backend variant

**Files:**
- Modify: `src/bot-registry.ts: BotConfig declaration and parseBotConfigsFromText normalization`
- Modify: `src/adapters/cli/types.ts: CliAdapter.buildArgs option contract`
- Modify: `src/adapters/cli/traex.ts: createTraexAdapter.buildArgs`
- Modify: `test/codex-default-reasoning.test.ts: normalized Bot config coverage`
- Modify: `test/cli-adapters.test.ts: TraeX argument coverage`

**Interfaces:**
- Produces: `BotConfig.modelBackendVariant?: 'standard' | 'max'`.
- Produces: `CliAdapter.buildArgs({ modelBackendVariant?: 'standard' | 'max' })`.
- Consumed by Task 2 through `Session.modelBackendVariant` and worker init payload.
- Consumed by Task 3 through the Dashboard API and `BotDefaultsRow`.

- [ ] **Step 1: Write failing config-normalization tests**

Add this case to `test/codex-default-reasoning.test.ts`; it names the bug where an invalid/non-TraeX backend variant can survive parsing, or a valid TraeX Max value is lost.

```ts
it('preserves only valid TraeX backend variants', () => {
  const configs = parseBotConfigsFromText(JSON.stringify([
    { larkAppId: 'traex-max', larkAppSecret: 'secret', cliId: 'traex', modelBackendVariant: 'max' },
    { larkAppId: 'traex-standard', larkAppSecret: 'secret', cliId: 'traex', modelBackendVariant: 'standard' },
    { larkAppId: 'traex-invalid', larkAppSecret: 'secret', cliId: 'traex', modelBackendVariant: 'turbo' },
    { larkAppId: 'codex-max', larkAppSecret: 'secret', cliId: 'codex', modelBackendVariant: 'max' },
  ]));

  expect(configs.find(config => config.larkAppId === 'traex-max')?.modelBackendVariant).toBe('max');
  expect(configs.find(config => config.larkAppId === 'traex-standard')?.modelBackendVariant).toBe('standard');
  expect(configs.find(config => config.larkAppId === 'traex-invalid')?.modelBackendVariant).toBeUndefined();
  expect(configs.find(config => config.larkAppId === 'codex-max')?.modelBackendVariant).toBeUndefined();
});
```

- [ ] **Step 2: Run the normalization test and verify it fails**

Run: `bunx vitest run test/codex-default-reasoning.test.ts`

Expected: FAIL because `BotConfig` and parser do not yet preserve `modelBackendVariant`.

- [ ] **Step 3: Write failing TraeX adapter tests**

Add cases beside the existing structured reasoning-effort tests in `test/cli-adapters.test.ts`. These name the bug where an explicit variant is not process-scoped or inheritance accidentally receives an override.

```ts
it('injects an explicit TraeX backend variant as a process config', () => {
  const args = createTraexAdapter('/bin/traex').buildArgs({
    sessionId: 'traex-variant', resume: false, modelBackendVariant: 'max',
  });
  const i = args.indexOf('model_backend_variant="max"');
  expect(i).toBeGreaterThan(0);
  expect(args[i - 1]).toBe('-c');
});

it('omits the TraeX backend-variant config when inheriting', () => {
  const args = createTraexAdapter('/bin/traex').buildArgs({ sessionId: 'traex-variant', resume: false });
  expect(args.join(' ')).not.toContain('model_backend_variant');
});
```

- [ ] **Step 4: Run the adapter tests and verify they fail**

Run: `bunx vitest run test/cli-adapters.test.ts`

Expected: FAIL because `modelBackendVariant` is not accepted or appended.

- [ ] **Step 5: Implement the smallest config and adapter contract**

1. Add the optional union to `BotConfig` in `src/bot-registry.ts`.
2. During parsing, retain `entry.modelBackendVariant` only when `entryCliId === 'traex'` and the value is exactly `standard` or `max`.
3. Add the same optional union to `CliAdapter.buildArgs` in `src/adapters/cli/types.ts`.
4. In `createTraexAdapter().buildArgs`, accept `modelBackendVariant` and append `-c`, `model_backend_variant=${JSON.stringify(modelBackendVariant)}` only when the option is present. Keep it after the optional model and reasoning-effort arguments; do not affect the `remoteWsUrl`/`remoteThreadId` branch.

- [ ] **Step 6: Run targeted tests and type checking**

Run: `bunx vitest run test/codex-default-reasoning.test.ts test/cli-adapters.test.ts && bun run build`

Expected: targeted tests pass and TypeScript compilation exits 0.

- [ ] **Step 7: Commit and push Task 1**

```bash
git add src/bot-registry.ts src/adapters/cli/types.ts src/adapters/cli/traex.ts \
  test/codex-default-reasoning.test.ts test/cli-adapters.test.ts
git commit -m "feat(traex): 支持后端变体启动配置"
git push fork HEAD:feat/traex-backend-variant
```

### Task 2: Freeze the variant through session lifecycle and display it on cards

**Files:**
- Modify: `src/types.ts: Session, SessionCliLaunchSnapshotV1, and daemon-to-worker init message`
- Modify: `src/core/worker-pool.ts: sessionAgentConfig, fork clone, worker init and card usage projection`
- Modify: `src/worker.ts: init config consumption and active-runtime publication`
- Modify: `src/codex-rpc-engine.ts: fresh thread configuration`
- Modify: `src/im/lark/md-card.ts: CardUsageSnapshot and cardUsageRuntimeSegment`
- Modify: `test/fork-session.test.ts: frozen/clone and legacy-session behavior`
- Modify: `test/codex-rpc-engine.test.ts: fresh-thread and resume config coverage`
- Modify: `test/worker-argv-reaction-status.integration.test.ts: worker-to-TraeX argv propagation`
- Modify: `test/md-card.test.ts: runtime text rendering`

**Interfaces:**
- Consumes: `BotConfig.modelBackendVariant` and `CliAdapter.buildArgs` from Task 1.
- Produces: `Session.modelBackendVariant?: 'standard' | 'max'` and `CardUsageSnapshot.modelBackendVariant?: string`.
- Produces: worker init message field `modelBackendVariant?: 'standard' | 'max'`.
- Consumed by Task 3 for response/UI state only; Task 3 never recomputes a session's frozen value.

- [ ] **Step 1: Write failing session-freeze and fork tests**

In `test/fork-session.test.ts`, add a normal TraeX `DaemonSession` with `agentFrozen: false`, then assert the `sessionAgentConfig` result and persisted session retain `max` even if the supplied bot config is later changed to `standard`. Add a fork assertion to the existing frozen-identity test. The tests name the bug where a resumed/forked session silently switches backend variant after its Bot is edited.

```ts
it('freezes a TraeX backend variant for the session launch identity', () => {
  const ds = makeSourceDs({ cliId: 'traex', agentFrozen: false });
  const first = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'max' });
  expect(first.modelBackendVariant).toBe('max');
  expect(ds.session.modelBackendVariant).toBe('max');

  const resumed = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'standard' });
  expect(resumed.modelBackendVariant).toBe('max');
});

it('keeps old frozen sessions without a variant in inherit mode', () => {
  const ds = makeSourceDs({ cliId: 'traex', agentFrozen: true });
  const cfg = sessionAgentConfig(ds, { cliId: 'traex', modelBackendVariant: 'max' });
  expect(cfg.modelBackendVariant).toBeUndefined();
});
```

- [ ] **Step 2: Run the session tests and verify they fail**

Run: `bunx vitest run test/fork-session.test.ts`

Expected: FAIL because no session or launch return field exists.

- [ ] **Step 3: Write the failing card-runtime test**

Extend `test/md-card.test.ts` with a literal expected string. This names the bug where a selected backend variant disappears from the session card or is ordered ambiguously.

```ts
it('renders a backend variant between the model and reasoning effort', () => {
  expect(cardUsageRuntimeSegment(
    { context: null, tokens: null, model: 'GPT-5.6-Terra', modelBackendVariant: 'max', reasoningEffort: 'xhigh' },
    true,
  )).toBe('**GPT-5.6-Terra** Max · xhigh');
});
```

- [ ] **Step 4: Run the card test and verify it fails**

Run: `bunx vitest run test/md-card.test.ts`

Expected: FAIL because `CardUsageSnapshot` and its formatter do not recognize the field.

- [ ] **Step 5: Implement the minimal session and card propagation**

1. Add the optional `modelBackendVariant` union to `Session`, `SessionCliLaunchSnapshotV1`, and `DaemonToWorker.init` in `src/types.ts`. New `/cli` snapshots set it to `null`; do not borrow the live bot value for a cross-CLI `/cli` selection.
2. Extend `sessionAgentConfig` input/result and freeze logic. For a newly frozen normal TraeX session, persist `botCfg.modelBackendVariant`; for a frozen historic session with no field, leave it absent (inherit), even if the current Bot now has an explicit value. Clear it when the frozen CLI is not TraeX.
3. Include the field in `forkSession` cloning, worker init, and `worker.ts` adapter launch options. Pass it to `CodexRpcEngine` for a fresh TraeX `thread/start`; the engine must omit it from `thread/resume`, just as it omits model and reasoning effort. Add a worker integration test that starts a fake TraeX process and asserts the observed spawn argv contains `model_backend_variant="max"`.
4. The card projection reads `ds.session.modelBackendVariant` directly; do not invent a dynamic runtime report or make a global-config inference. Extend `CardUsageSnapshot` and `cardUsageRuntimeSegment` to render a title-cased variant between model and effort. Existing model-only and model-plus-effort output must remain byte-for-byte unchanged.

- [ ] **Step 6: Run targeted lifecycle and card tests plus build**

Run: `bunx vitest run test/fork-session.test.ts test/md-card.test.ts && bun run build`

Expected: all selected tests pass and the build exits 0.

- [ ] **Step 7: Commit and push Task 2**

```bash
git add src/types.ts src/core/types.ts src/core/worker-pool.ts src/worker.ts src/im/lark/md-card.ts \
  src/core/command-handler.ts test/fork-session.test.ts test/md-card.test.ts
git commit -m "feat(session): 冻结并展示 TraeX 后端变体"
git push fork HEAD:feat/traex-backend-variant
```

### Task 3: Expose and validate the per-Bot override in Dashboard

**Files:**
- Modify: `src/core/dashboard-ipc-server.ts: Bot Defaults DTO and PUT /api/bot-agent`
- Modify: `src/dashboard/web/bot-defaults.ts: BotDefaultsRow`
- Modify: `src/dashboard/web/bot-defaults-page.tsx: BotAgentSection state, save payload, TraeX-only dropdown`
- Modify: `src/dashboard/web/i18n.ts: Chinese and English labels/help`
- Modify: `test/dashboard-ipc.test.ts: API persistence and invalid input`
- Modify: `test/dashboard-bot-defaults-cliid.test.ts: UI visibility, payload, and local patch state`

**Interfaces:**
- Consumes: `BotConfig.modelBackendVariant` from Task 1 and frozen-session semantics from Task 2.
- Produces: private Bot Defaults field `modelBackendVariant?: 'standard' | 'max' | null`.
- Produces: agent API body field `modelBackendVariant?: 'standard' | 'max' | ''`.

- [ ] **Step 1: Write failing Dashboard IPC tests**

Add an isolated `traex` bot fixture in `test/dashboard-ipc.test.ts`. The test names the bug where the Dashboard accepts a field but fails to persist, clear, or reject it correctly.

```ts
const max = await fetch(`${base}/api/bot-agent`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cliId: 'traex', model: 'GPT-5.6-Terra', modelBackendVariant: 'max' }),
});
expect(max.status).toBe(200);
expect(await max.json()).toMatchObject({ modelBackendVariant: 'max' });
expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({ modelBackendVariant: 'max' });

const invalid = await fetch(`${base}/api/bot-agent`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cliId: 'traex', model: 'GPT-5.6-Terra', modelBackendVariant: 'turbo' }),
});
expect(invalid.status).toBe(400);
expect(await invalid.json()).toMatchObject({ error: 'invalid_model_backend_variant' });

const clear = await fetch(`${base}/api/bot-agent`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cliId: 'traex', model: 'GPT-5.6-Terra', modelBackendVariant: '' }),
});
expect(clear.status).toBe(200);
expect(await clear.json()).toMatchObject({ modelBackendVariant: null });
expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].modelBackendVariant).toBeUndefined();
```

Also test an explicit switch from TraeX to Codex deletes an already stored variant and returns `null`.

- [ ] **Step 2: Run the IPC test and verify it fails**

Run: `bunx vitest run test/dashboard-ipc.test.ts`

Expected: FAIL because the API body and response do not recognize the field.

- [ ] **Step 3: Write failing Dashboard component tests**

In `test/dashboard-bot-defaults-cliid.test.ts`, add a TraeX bot with `modelBackendVariant: 'max'`; assert the dropdown exists, has exactly `''`, `standard`, and `max`, and its initial value is `max`. Change it to `standard`, save, and assert this exact payload:

```ts
{
  cliId: 'traex',
  model: 'GPT-5.6-Terra',
  reasoningEffort: 'xhigh',
  modelBackendVariant: 'standard',
}
```

Render a Codex bot and assert no `dataInput: 'agentModelBackendVariant'` control exists.

- [ ] **Step 4: Run the component test and verify it fails**

Run: `bunx vitest run test/dashboard-bot-defaults-cliid.test.ts`

Expected: FAIL because the control and payload field do not exist.

- [ ] **Step 5: Implement the Dashboard API and UI**

1. Add the normalized field to the private Bot Defaults response in `src/core/dashboard-ipc-server.ts` and to `BotDefaultsRow`.
2. In `PUT /api/bot-agent`, parse `modelBackendVariant` with present/absent semantics matching `reasoningEffort`: absent preserves only when staying on TraeX; empty/null clears; exact `standard|max` writes; all other non-empty values return `{ error: 'invalid_model_backend_variant' }` with HTTP 400. Non-TraeX selections delete the stored value. Mirror the result to in-memory Bot config and return it as `null` when inheriting.
3. In `BotAgentSection`, add variant state synced from the server, reset it when switching away from TraeX, send it only for TraeX, and patch the server-normalized response into local state. Render the TraeX-only dropdown immediately after Model with the inherit/Standard/Max options.
4. Add short Chinese and English strings that call it `后端变体` / `Backend variant`, say it affects new sessions, and distinguish inherit from reasoning effort.

- [ ] **Step 6: Run Dashboard tests, type checking, and production build**

Run: `bunx vitest run test/dashboard-ipc.test.ts test/dashboard-bot-defaults-cliid.test.ts && bun run build`

Expected: Dashboard API/component tests pass and build exits 0.

- [ ] **Step 7: Commit and push Task 3**

```bash
git add src/core/dashboard-ipc-server.ts src/dashboard/web/bot-defaults.ts \
  src/dashboard/web/bot-defaults-page.tsx src/dashboard/web/i18n.ts \
  test/dashboard-ipc.test.ts test/dashboard-bot-defaults-cliid.test.ts
git commit -m "feat(dashboard): 配置 TraeX 后端变体"
git push fork HEAD:feat/traex-backend-variant
```

### Task 4: End-to-end verification and manual Dashboard handoff

**Files:**
- Verify only: all Task 1-3 files and `docs/superpowers/specs/2026-09-02-traex-backend-variant-design.md`

**Interfaces:**
- Consumes all completed Task 1-3 contracts.
- Produces a verified branch and live-test handoff; no additional source behavior.

- [ ] **Step 1: Run the feature-focused test suite**

Run:

```bash
bunx vitest run \
  test/codex-default-reasoning.test.ts \
  test/cli-adapters.test.ts \
  test/fork-session.test.ts \
  test/md-card.test.ts \
  test/dashboard-ipc.test.ts \
  test/dashboard-bot-defaults-cliid.test.ts
```

Expected: every listed test file passes.

- [ ] **Step 2: Run full build verification**

Run: `bun run build && git diff --check && git status --short --branch`

Expected: build exits 0, diff check is clean, and the branch contains only the committed specification, plan, and feature commits.

- [ ] **Step 3: Push final branch state**

Run: `git push fork HEAD:feat/traex-backend-variant`

Expected: remote branch includes every commit.

- [ ] **Step 4: Hand off live Dashboard verification**

After the code verification is green, report that manual live validation requires the intentionally global action:

```bash
bun run switch:here && bun run daemon:restart
```

This switches every bot to the worktree build. Do not execute it until the user explicitly asks to deploy this checkout for manual Dashboard testing.
