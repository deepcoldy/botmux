# Per-Bot Streaming Card Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, per-bot `pinStreamingCard` setting with a per-chat opt-out that keeps the current real `streamCardId` pinned and removes known streaming-card Pins when the card is replaced, transferred, or the session closes, without letting Pin failures affect session behavior.

**Architecture:** Keep `streamCardId` and the existing durable `frozenCards` sidecar as the only card identities; do not add a Pin journal or inspect arbitrary card JSON. Add small Lark Pin/Unpin primitives, centralize best-effort policy and race checks in `worker-pool.ts`, and reuse the existing per-bot card-preference, `/botconfig`, and `/card` command pipelines. The effective policy is the bot-level master switch AND a per-chat negative override, and post-config-write callbacks reconcile already-active sessions without delaying the configuration response.

**Tech Stack:** TypeScript, Bun 1.4.0-compatible source, `@larksuiteoapi/node-sdk` 1.73.0 API surface, React 19 Dashboard, Vitest.

## Global Constraints

- `pinStreamingCard` is per bot and default-off; only literal `true` enables it.
- `noPinStreamingCardChats` is a per-bot list of chat IDs. A listed chat keeps
  streaming cards but suppresses automatic Pin; it never force-enables a bot
  whose master switch is off.
- Only real `streamCardId` values participate. Never Pin `repoCardMessageId`, private `/card` snapshots, final replies, CoT messages, closed cards, or other interactive messages.
- Pin/Unpin is QoL and fail-open: no Pin API outcome may change card publication, session mutation, transfer, resume, close, or configuration results.
- Desired steady state is one Pin for the current `streamCardId` of each active session; API failures may temporarily produce zero or multiple Pins.
- Start Pin only after the publication fence and durable `streamCardId` commit.
  Explicit predecessor Unpin remains conditional on successor Pin success, but
  the primary publication/recall path never waits for Pin; Feishu removes the
  Pin automatically when a recalled predecessor is deleted.
- Close refusal/durable-close failure leaves Pins unchanged. Successful close, including `closed_with_residual`, starts best-effort cleanup.
- Keep destination-sensitive `recallFrozenCards` semantics unchanged; Unpin selection is session-wide because Feishu Pins are chat-wide.
- No `bun install` in a worktree. Before tests, link this worktree's `node_modules` to the canonical checkout only if dependency manifests match exactly.
- Every implementation unit ends in focused tests, full unit tests, `bun run build`, an independent commit, and a push to `fork/feat/pin-streaming-card`.
- The merge request is written in Chinese and explicitly asks whether the setting should become default-on in a future release.
- The post-review per-chat command ships in this PR. Its Dashboard Group Manage
  editor is a follow-up because that requires a separate UI/API/aggregation
  change across the dashboard stack.

---

### Task 0: Prepare and verify the isolated baseline

**Files:**
- Read: `AGENTS.md`
- Read: `package.json`
- No source changes

**Interfaces:**
- Consumes: canonical checkout `/data00/home/wangqiyilang/playground/botmux`
- Produces: verified dependency link and a known-green starting commit

- [ ] **Step 1: Confirm isolation and exact dependency manifests**

Run:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git branch --show-current
cmp package.json /data00/home/wangqiyilang/playground/botmux/package.json
cmp bun.lock /data00/home/wangqiyilang/playground/botmux/bun.lock
```

Expected: Git dir differs from common dir, branch is `feat/pin-streaming-card`, and both `cmp` commands exit 0. If either manifest differs, do not share dependencies and do not run `bun install` in this worktree; stop and resolve dependency provisioning first.

- [ ] **Step 2: Link the canonical dependencies without installing**

Run only when both comparisons passed:

```bash
ln -s /data00/home/wangqiyilang/playground/botmux/node_modules node_modules
test -d node_modules
```

Expected: `node_modules` resolves to the canonical checkout. If the canonical checkout has no dependencies, provision them outside the worktree or use CI; never run `bun install` through this symlink.

- [ ] **Step 3: Verify the baseline**

Run:

```bash
bun run test
bun run build
git status --short --branch
```

Expected: unit tests and build pass, and the worktree is clean with the committed design and implementation-plan documents in branch history. If baseline tests fail, record the exact failures and stop before feature edits.

---

### Task 1: Add the per-bot configuration contract and operator surfaces

**Files:**
- Modify: `src/bot-registry.ts`
- Modify: `src/services/card-prefs-store.ts`
- Modify: `src/services/bot-config-store.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/dashboard/bot-payload.ts`
- Modify: `src/dashboard/web/bot-defaults.ts`
- Modify: `src/dashboard/web/bot-defaults-page.tsx`
- Modify: `src/dashboard/web/i18n.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Test: `test/bot-registry-grant.test.ts`
- Test: `test/card-prefs-auto-start.test.ts`
- Test: `test/bot-config-store.test.ts`
- Test: `test/dashboard-bot-payload.test.ts`
- Test: `test/dashboard-ipc.test.ts`
- Test: `test/dashboard-bot-defaults-cliid.test.ts`

**Interfaces:**
- Consumes: existing default-false boolean persistence and card-preference routes
- Produces: `BotConfig.pinStreamingCard?: boolean`, `BotCardPrefs.pinStreamingCard: boolean`, Dashboard JSON field `pinStreamingCard: boolean`, and `/botconfig set pinStreamingCard on|off`

- [ ] **Step 1: Write the failing strict-normalization test**

Add to `test/bot-registry-grant.test.ts`:

```ts
it('parses pinStreamingCard only as strict boolean true', () => {
  expect(parseBotConfigsFromText(JSON.stringify([
    { larkAppId: 'pin1', larkAppSecret: 's', pinStreamingCard: true },
  ]))[0].pinStreamingCard).toBe(true);

  for (const bad of [undefined, false, 'true', 1, null]) {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'pin2', larkAppSecret: 's', pinStreamingCard: bad },
    ]));
    expect(cfg.pinStreamingCard).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run the registry test and verify RED**

Run:

```bash
bun run test -- test/bot-registry-grant.test.ts
```

Expected: FAIL because `BotConfig`/normalization has no `pinStreamingCard`.

- [ ] **Step 3: Implement the normalized BotConfig field**

In `BotConfig`, beside `disableStreamingCard`, add:

```ts
/** Pin the current public streaming card. Default false; best-effort only. */
pinStreamingCard?: boolean;
```

In `parseBotConfigsFromText`, normalize it beside other default-off card booleans:

```ts
pinStreamingCard: entry.pinStreamingCard === true || undefined,
```

Re-run the focused registry test and expect PASS.

- [ ] **Step 4: Write failing card-preference round-trip tests**

Extend `test/card-prefs-auto-start.test.ts` to assert:

```ts
expect(store.getBotCardPrefs('app_default').pinStreamingCard).toBe(false);

const on = await store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
expect(on.ok && on.prefs.pinStreamingCard).toBe(true);
expect(readConfig().pinStreamingCard).toBe(true);
expect(registry.getBot('app_default').config.pinStreamingCard).toBe(true);

const off = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
expect(off.ok && off.prefs.pinStreamingCard).toBe(false);
expect(readConfig().pinStreamingCard).toBeUndefined();
expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();
```

Also seed `pinStreamingCard: true`, patch an unrelated preference, and assert the Pin preference remains true on disk, in memory, and in the returned full prefs.

- [ ] **Step 5: Run card-preference tests and verify RED**

Run:

```bash
bun run test -- test/card-prefs-auto-start.test.ts
```

Expected: FAIL because resolved preferences and persistence omit the new field.

- [ ] **Step 6: Implement card-preference persistence**

In `src/services/card-prefs-store.ts`:

```ts
export interface BotCardPrefs {
  // existing fields...
  pinStreamingCard: boolean;
}
```

Add the field to both resolved return objects as `c.pinStreamingCard === true` / `false`, call:

```ts
apply(entry, 'pinStreamingCard', patch.pinStreamingCard);
```

include `pinStreamingCard: entry.pinStreamingCard === true` in the RMW result, synchronize live memory after success:

```ts
if (patch.pinStreamingCard !== undefined) {
  bot.config.pinStreamingCard = patch.pinStreamingCard || undefined;
}
```

and include the resolved value in the existing sanitized log line. Re-run the focused test and expect PASS.

- [ ] **Step 7: Write failing `/botconfig` tests**

In `test/bot-config-store.test.ts`, extend the case-insensitive lookup and add:

```ts
it('pinStreamingCard is an immediate default-off boolean', async () => {
  const { registry, store } = await loaded();
  const spec = store.findConfigField('PINSTREAMINGCARD')!;
  expect(spec).toMatchObject({
    configKey: 'pinStreamingCard',
    kind: 'boolean',
    effect: 'immediate',
    clearable: false,
  });

  const on = await store.applyConfigField('app_default', spec, true);
  expect(on).toMatchObject({ ok: true, oldText: 'off', newText: 'on' });
  expect(readConfig().pinStreamingCard).toBe(true);
  expect(registry.getBot('app_default').config.pinStreamingCard).toBe(true);

  const off = await store.applyConfigField('app_default', spec, false);
  expect(off).toMatchObject({ ok: true, oldText: 'on', newText: 'off' });
  expect(readConfig().pinStreamingCard).toBeUndefined();
  expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();
});
```

Extend snapshot/card-data assertions so the new boolean appears and has the effective off/on value.

- [ ] **Step 8: Run `/botconfig` tests and verify RED**

Run:

```bash
bun run test -- test/bot-config-store.test.ts
```

Expected: FAIL because `findConfigField('pinStreamingCard')` returns undefined.

- [ ] **Step 9: Register the generic `/botconfig` field and labels**

Add to `CONFIG_FIELDS` beside the other card booleans:

```ts
{
  key: 'pinStreamingCard',
  configKey: 'pinStreamingCard',
  kind: 'boolean',
  effect: 'immediate',
  clearable: false,
  hint: '置顶当前公开实时卡片 on|off（失败不影响会话）',
},
```

Add `config.label.pinStreamingCard` to `src/i18n/zh.ts` and `src/i18n/en.ts`. Do not special-case the command handler; the registry-driven path already implements help, coercion, snapshots, config card toggles, and persistence. Re-run the focused test and expect PASS.

- [ ] **Step 10: Write failing Dashboard backend tests**

In `test/dashboard-bot-payload.test.ts`, add `pinStreamingCard` to the exact editable/private payload keys and assert absent/malformed values become false while literal true remains true.

In the card-preference GET/PUT block in `test/dashboard-ipc.test.ts`, assert:

```ts
expect(initial.pinStreamingCard).toBe(false);
// PUT { pinStreamingCard: true } returns true and writes/syncs true.
// An unrelated partial patch preserves true.
// PUT { pinStreamingCard: false } returns false and removes disk/live keys.
// PUT { pinStreamingCard: 'true' } alone returns no_valid_fields.
```

- [ ] **Step 11: Run Dashboard backend tests and verify RED**

Run:

```bash
bun run test -- test/dashboard-bot-payload.test.ts test/dashboard-ipc.test.ts
```

Expected: FAIL because the payload/IPC route omits the field.

- [ ] **Step 12: Implement Dashboard backend plumbing**

Add `pinStreamingCard: j?.pinStreamingCard === true` to `botDefaultsPayload`. Include `cardPrefs.pinStreamingCard` in the private daemon response. Add the unknown request field, typed patch field, and validator:

```ts
if (typeof body.pinStreamingCard === 'boolean') {
  patch.pinStreamingCard = body.pinStreamingCard;
}
```

Re-run the backend tests and expect PASS.

- [ ] **Step 13: Write failing Dashboard UI tests**

In `test/dashboard-bot-defaults-cliid.test.ts`, freeze the selector `data-action="toggle-pin-streaming-card"` and add cases proving:

- absent payload renders unchecked;
- toggling on calls `putCardPref({ pinStreamingCard: true })`;
- request failure restores the prior state and surfaces `write_failed`;
- the new control joins the existing single-flight disabled-control loop.

- [ ] **Step 14: Run the Dashboard UI test and verify RED**

Run:

```bash
bun run test -- test/dashboard-bot-defaults-cliid.test.ts
```

Expected: FAIL because the toggle does not exist.

- [ ] **Step 15: Implement Dashboard type, toggle, and bilingual copy**

Add `pinStreamingCard?: boolean` to `BotDefaultsRow`, add it to `patchCardPrefsFromBody`, and add state/effect wiring in `CardBehaviorSection`. Render a `ToggleRow` in the task-feedback group:

```tsx
<ToggleRow
  checked={pinStreamingCard}
  disabled={busy !== null}
  dataAction="toggle-pin-streaming-card"
  title={tr('botDefaults.pinStreamingCard')}
  description={tr('botDefaults.pinStreamingCardDescription')}
  help={tr('botDefaults.pinStreamingCardHelp')}
  onChange={checked => {
    const previous = pinStreamingCard;
    setPinStreamingCard(checked);
    void savePatch(
      { pinStreamingCard: checked },
      'pin-streaming',
      () => setPinStreamingCard(previous),
    );
  }}
/>
```

Add the three keys to both locale maps in `src/dashboard/web/i18n.ts`. Copy must say that only the current public live-status card participates, the default is off, and failures do not interrupt sessions. No CSS change is expected.

- [ ] **Step 16: Verify, commit, and push Unit 1**

Run:

```bash
bun run test -- test/bot-registry-grant.test.ts test/card-prefs-auto-start.test.ts test/bot-config-store.test.ts
bun run test -- test/dashboard-bot-payload.test.ts test/dashboard-ipc.test.ts test/dashboard-bot-defaults-cliid.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0. Then:

```bash
git add src/bot-registry.ts src/services/card-prefs-store.ts src/services/bot-config-store.ts \
  src/core/dashboard-ipc-server.ts src/dashboard/bot-payload.ts \
  src/dashboard/web/bot-defaults.ts src/dashboard/web/bot-defaults-page.tsx \
  src/dashboard/web/i18n.ts src/i18n/en.ts src/i18n/zh.ts \
  test/bot-registry-grant.test.ts test/card-prefs-auto-start.test.ts \
  test/bot-config-store.test.ts test/dashboard-bot-payload.test.ts \
  test/dashboard-ipc.test.ts test/dashboard-bot-defaults-cliid.test.ts
git commit -m "feat(card): 添加实时卡片置顶配置入口"
git push fork feat/pin-streaming-card
```

---

### Task 2: Add fail-open Lark Pin and Unpin primitives

**Files:**
- Modify: `src/im/lark/client.ts`
- Create: `test/lark-pin-message.test.ts`
- Modify: `test/lark-transport-boundary.test.ts`

**Interfaces:**
- Consumes: `getBotClient`, `assertLarkTransport`, `formatLarkError`, and the SDK `im.v1.pin` resource
- Produces: `pinMessage(larkAppId, messageId): Promise<boolean>` and `unpinMessage(larkAppId, messageId): Promise<boolean>`

- [ ] **Step 1: Write the failing transport tests**

Create `test/lark-pin-message.test.ts` following `test/delete-message.test.ts`. Register a bot and inject:

```ts
getBot(appId).client = {
  im: { v1: { pin: { create: pinCreateMock, delete: pinDeleteMock } } },
} as any;
```

Test both wrappers for:

- exact create payload `{ data: { message_id: 'om_pin' } }`;
- exact delete payload `{ path: { message_id: 'om_pin' } }`;
- `code: 0` returns true;
- non-zero and missing `code` return false;
- SDK throw returns false and the sanitized warning excludes a fake authorization token;
- two successful Unpin calls both return true, proving the local wrapper is idempotent/stateless.

Extend `test/lark-transport-boundary.test.ts` with Pin spies and assertions that both wrappers reject with `LarkTransportDisabledError` for `apiOnly` and make zero SDK calls.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun run test -- test/lark-pin-message.test.ts test/lark-transport-boundary.test.ts
```

Expected: FAIL on missing exports, not on malformed mocks.

- [ ] **Step 3: Implement the minimal wrappers**

Add immediately before `deleteMessage` in `client.ts`:

```ts
export async function pinMessage(larkAppId: string, messageId: string): Promise<boolean> {
  assertLarkTransport(larkAppId, 'pinMessage');
  const client = getBotClient(larkAppId);
  try {
    const res: any = await client.im.v1.pin.create({ data: { message_id: messageId } });
    if (res?.code !== 0) {
      logger.warn(`[pin:${larkAppId}] failed message=${messageId} code=${res?.code ?? 'missing'}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[pin:${larkAppId}] failed message=${messageId}: ${formatLarkError(err) ?? (err instanceof Error ? err.message : 'unknown error')}`);
    return false;
  }
}
```

Implement `unpinMessage` symmetrically with `client.im.v1.pin.delete`. Keep `assertLarkTransport` outside `try`, so transport-disabled misuse stays a typed rejection rather than being converted to false. Do not change generic send/reply helpers.

- [ ] **Step 4: Verify GREEN, refactor only local duplication, then verify the unit**

Run:

```bash
bun run test -- test/lark-pin-message.test.ts test/lark-transport-boundary.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0. A private helper inside `client.ts` may remove duplicated logging, but no new module or behavior belongs in this commit.

- [ ] **Step 5: Commit and push Unit 2**

```bash
git add src/im/lark/client.ts test/lark-pin-message.test.ts test/lark-transport-boundary.test.ts
git commit -m "feat(lark): 添加消息 Pin 传输封装"
git push fork feat/pin-streaming-card
```

---

### Task 3: Centralize streaming-card Pin policy

**Files:**
- Modify: `src/core/worker-pool.ts`
- Create: `test/streaming-card-pinning.test.ts`
- Modify: `test/recall-frozen-cards.test.ts`

**Interfaces:**
- Consumes: Task 1 `BotConfig.pinStreamingCard`; Task 2 `pinMessage`/`unpinMessage`; existing `streamCardId`, `frozenCards`, active-session registry and `replyTargetKey` rules
- Produces: `pinStreamingCardIfEnabled`, `reconcileStreamingCardPins`, and `reconcileBotStreamingCardPins`

- [ ] **Step 1: Write failing helper and reconciliation tests**

Mock `pinMessage` and `unpinMessage` in a new `test/streaming-card-pinning.test.ts`. Add cases proving:

```text
default/false config     -> no calls, false
empty/sentinel ID        -> no calls, false
inactive/transferring    -> no calls, false
lost registry ownership  -> no calls, false
changed current ID       -> no calls, false
valid enabled session    -> Pin current, true
state changes during Pin -> compensating Unpin(captured ID), false
Pin/compensation failure -> never throws
```

For `reconcileStreamingCardPins`, assert enable ordering `pin(current)` then `unpin(all frozen IDs)`, failed Pin skips frozen Unpin, disable Unpins current plus all deduplicated frozen IDs, and cross-topic frozen IDs are included. Extend `test/recall-frozen-cards.test.ts` to prove `recallFrozenCards` remains destination-sensitive after this new session-wide Unpin helper exists.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts
```

Expected: FAIL because the exported policy helpers are missing.

- [ ] **Step 3: Implement the policy helpers beside `parkStreamCard`**

Use these exact public signatures:

```ts
export async function pinStreamingCardIfEnabled(
  ds: DaemonSession,
  messageId: string,
): Promise<boolean>;

export async function reconcileStreamingCardPins(
  ds: DaemonSession,
  enabled: boolean,
): Promise<void>;

export function reconcileBotStreamingCardPins(
  larkAppId: string,
  enabled: boolean,
): void;
```

Add private helpers to validate real IDs, snapshot/deduplicate current and frozen IDs before awaiting, verify `session.status`, app ID, route key ownership, non-transfer/non-retirement state, session-object identity and current card identity, and compensate a stale successful Pin with Unpin. `reconcileBotStreamingCardPins` snapshots unique active sessions for the target bot and starts independent promises without awaiting them. Catch every failure inside the policy layer.

- [ ] **Step 4: Verify GREEN and Unit 3A checkpoint**

Run:

```bash
bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0. Do not commit yet; Tasks 3-5 form the single lifecycle unit.

---

### Task 4: Wire publication, recovery, and resume paths

**Files:**
- Modify: `src/core/worker-pool.ts`
- Modify: `src/im/lark/card-handler.ts`
- Modify: `test/recall-frozen-cards.test.ts`
- Modify: `test/worker-ready-display-mode.test.ts`
- Modify: `test/card-integration.test.ts`

**Interfaces:**
- Consumes: Task 3 policy helpers
- Produces: fenced Pin behavior at every path that commits or reuses a real `streamCardId`

- [ ] **Step 1: Write failing publication-order and failure-isolation tests**

Extend the existing harnesses to cover all of these paths:

```text
postTurnStartingCard
postFreshStreamingCard (/card)
worker-ready persisted-card reuse
worker-ready fresh POST
screen_update fallback POST
card-button resume repost
```

For each fresh POST, assert `POST → commit/persist`, then that the detached
`Pin(new) → Unpin(frozen)` chain starts without delaying existing recall or
successor scheduling. Add deferred POST/Pin cases proving a closed, transferred,
retired, registry-replaced, or newer-card session deletes the stale result,
never Pins it, and never overwrites its successor. Assert Pin false/rejection
keeps the new `streamCardId`, preserves the path's success result, and does not
suppress existing recall. Default-off must produce zero Pin/Unpin calls.
Persisted-card reuse must perform idempotent reconciliation without posting a
new card.

- [ ] **Step 2: Run the focused suites and verify RED**

Run:

```bash
bun run test -- test/recall-frozen-cards.test.ts test/worker-ready-display-mode.test.ts test/card-integration.test.ts
```

Expected: new ordering/call assertions fail.

- [ ] **Step 3: Wire the existing fully fenced turn-start path**

In `postTurnStartingCard`, after the real message ID is committed and persisted,
start `continuePublishedStreamingCardPinChain(ds, messageId, predecessorIds)`
without awaiting it. Continue the unchanged `recallFrozenCards(ds)` and
pending-generation scheduling immediately. The helper Pins the successor and
only then explicitly Unpins captured predecessors.

- [ ] **Step 4: Add missing publication fences before adding Pin side effects**

For `postFreshStreamingCard`, worker-ready fresh POST, and screen-update fresh POST, capture the session object, app ID, anchor/registry key, nonce/generation and prior identity before awaiting. After POST, require the same active route owner, non-transfer/non-retirement state and sentinel/nonce ownership before committing. Delete stale results and restore prior identity only when that invocation still owns the sentinel. Then persist, start the detached conditional Pin/Unpin chain, and continue normal recall and scheduling without awaiting Pin.

For worker-ready persisted-card reuse, recheck ownership after PATCH, then reconcile the existing ID before recall.

- [ ] **Step 5: Fence and wire the resume-button repost**

In `card-handler.ts`, capture the resumed session object, app ID, route key and current-card identity before POST. After POST, recheck active status, registry ownership, route/transfer state and unchanged prior card identity before assigning the returned ID. Delete stale results with no Pin. For a valid result, persist it, start `continuePublishedStreamingCardPinChain` without awaiting it, then keep the existing best-effort deletion of the clicked closed card and delivery of the resume receipt. Pin failure or latency must not change resume success or suppress deletion/receipt.

- [ ] **Step 6: Verify the publication and resume matrix**

Run:

```bash
bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts \
  test/worker-ready-display-mode.test.ts test/card-integration.test.ts \
  test/card-handler-resume-receipt.test.ts
bun run build
git diff --check
```

Expected: all commands exit 0.

---

### Task 5: Clean streaming-card Pins on transfer and close

**Files:**
- Modify: `src/core/worker-pool.ts`
- Modify: `test/transfer-session.test.ts`
- Modify: `test/session-delete-close-barrier.test.ts`
- Modify: `test/mojo-explicit-close.test.ts`
- Modify: `test/close-stream-card-untouched.test.ts`

**Interfaces:**
- Consumes: Task 3 capture/dedup and best-effort Unpin helpers
- Produces: post-commit source cleanup for transfer and post-close cleanup for every authoritative close consumer

- [ ] **Step 1: Write failing transfer cleanup tests**

Assert that transfer snapshots current plus all cross-topic frozen streaming-card IDs, makes no Unpin call on pre-commit refusal, and after a successful routing commit starts Unpin for each captured ID. Verify Unpin rejection does not alter `{ ok: true }`, and source cleanup never targets a newly published target card.

- [ ] **Step 2: Write failing close cleanup tests**

Create live and workerless stored-row fixtures whose current card and frozen sidecar IDs are known. Assert:

- normal close and `closed_with_residual` start Unpin after durable close;
- teardown refusal and durable save failure make no Unpin call;
- slow/rejected Unpin does not delay `awaitWorkerExit: false` or change `CloseSessionResult`;
- `closeSession` still never recalls/deletes the live message, preserving `test/close-stream-card-untouched.test.ts`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
bun run test -- test/transfer-session.test.ts test/session-delete-close-barrier.test.ts \
  test/mojo-explicit-close.test.ts test/close-stream-card-untouched.test.ts
```

Expected: new Unpin assertions fail.

- [ ] **Step 4: Implement transfer cleanup at the committed boundary**

Before clearing source-bound state, snapshot/deduplicate the real source `streamCardId` and every frozen message ID. After the durable route and registry ownership commit succeeds, launch best-effort Unpins using only those captured IDs. Preserve the existing inert source-card PATCH and target fork behavior.

- [ ] **Step 5: Implement close cleanup after successful durable close**

Before `sessionStore.closeSession` removes the frozen sidecar, snapshot live/stored real `streamCardId` and load/capture frozen IDs. After durable close succeeds, launch best-effort Unpins regardless of the current setting. Do not await them in the close result path. Do not clean on refusal or save failure.

- [ ] **Step 6: Verify, commit, and push the lifecycle unit**

Run:

```bash
bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts \
  test/worker-ready-display-mode.test.ts test/card-integration.test.ts \
  test/card-handler-resume-receipt.test.ts test/transfer-session.test.ts \
  test/session-delete-close-barrier.test.ts test/mojo-explicit-close.test.ts \
  test/close-stream-card-untouched.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0. Then:

```bash
git add src/core/worker-pool.ts src/im/lark/card-handler.ts \
  test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts \
  test/worker-ready-display-mode.test.ts test/card-integration.test.ts \
  test/card-handler-resume-receipt.test.ts test/transfer-session.test.ts \
  test/session-delete-close-barrier.test.ts test/mojo-explicit-close.test.ts \
  test/close-stream-card-untouched.test.ts
git commit -m "feat(card): 接入实时卡片 Pin 生命周期"
git push fork feat/pin-streaming-card
```

---

### Task 6: Reconcile active sessions after hot setting changes

**Files:**
- Create: `src/services/pin-streaming-card-change.ts`
- Modify: `src/services/bot-config-store.ts`
- Modify: `src/services/card-prefs-store.ts`
- Modify: `src/daemon.ts`
- Create: `test/pin-streaming-card-change.test.ts`
- Modify: `test/bot-config-store.test.ts`
- Modify: `test/card-prefs-auto-start.test.ts`
- Modify: `test/command-handler.test.ts`
- Modify: `test/dashboard-ipc.test.ts`

**Interfaces:**
- Consumes: Task 3 `reconcileBotStreamingCardPins(larkAppId, enabled): void`
- Produces: one post-write notification seam shared by Dashboard and `/botconfig`

- [ ] **Step 1: Write failing notification seam tests**

Create `test/pin-streaming-card-change.test.ts` for:

```ts
export type PinStreamingCardChangeHandler =
  (larkAppId: string, enabled: boolean) => void;

export function registerPinStreamingCardChangeHandler(
  handler: PinStreamingCardChangeHandler,
): () => void;

export function notifyPinStreamingCardChanged(
  larkAppId: string,
  enabled: boolean,
): void;
```

Test registration, disposal, replacement/duplicate registration policy, and that a throwing handler is swallowed and logged.

- [ ] **Step 2: Run the seam test and verify RED**

Run:

```bash
bun run test -- test/pin-streaming-card-change.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the callback module**

Implement one process-local handler with an unregister closure. `notifyPinStreamingCardChanged` catches handler errors and never throws. Keep the module independent of worker-pool to avoid a services-to-core cycle.

- [ ] **Step 4: Write failing store-timing and operator-path tests**

Extend both config stores so tests register a handler and assert it observes the already-updated disk and live config. Failed writes must emit nothing. Add `/botconfig` and Dashboard endpoint integration tests proving the visible mutation response completes even when reconciliation throws or returns pending work.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```bash
bun run test -- test/pin-streaming-card-change.test.ts test/bot-config-store.test.ts \
  test/card-prefs-auto-start.test.ts test/command-handler.test.ts test/dashboard-ipc.test.ts
```

Expected: callback observations are absent.

- [ ] **Step 6: Notify only after successful Pin-setting writes**

In `applyConfigField`, after disk and live memory are synchronized, call the notifier only when `spec.configKey === 'pinStreamingCard'`, with effective `value === true`. In `updateBotCardPrefs`, notify only when `patch.pinStreamingCard !== undefined`, after memory synchronization. Do not notify on unrelated partial patches or failed writes.

- [ ] **Step 7: Register reconciliation after active-session registry setup**

In daemon startup, immediately after `setActiveSessionsRegistry(activeSessions)`, register:

```ts
registerPinStreamingCardChangeHandler(reconcileBotStreamingCardPins);
```

Do not await reconciliation from the notification path. Add a multi-session test showing it snapshots all active sessions for the matching bot, ignores other bots, and isolates one session's failure from the rest.

- [ ] **Step 8: Verify the hot-toggle unit**

Run:

```bash
bun run test -- test/pin-streaming-card-change.test.ts test/bot-config-store.test.ts \
  test/card-prefs-auto-start.test.ts test/command-handler.test.ts test/dashboard-ipc.test.ts \
  test/streaming-card-pinning.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0. Do not commit until Task 7 adds the same unit's documentation.

---

### Task 7: Document the setting and checkpoint hot reconciliation

**Files:**
- Modify: `docs-site/docs/zh/bots-json.md`
- Modify: `docs-site/docs/en/bots-json.md`
- Modify: `docs-site/docs/zh/cards.md`
- Modify: `docs-site/docs/en/cards.md`
- Modify: `src/services/pin-streaming-card-change.ts`
- Modify: `src/services/bot-config-store.ts`
- Modify: `src/services/card-prefs-store.ts`
- Modify: `src/daemon.ts`
- Modify: `test/pin-streaming-card-change.test.ts`
- Modify: `test/bot-config-store.test.ts`
- Modify: `test/card-prefs-auto-start.test.ts`
- Modify: `test/command-handler.test.ts`
- Modify: `test/dashboard-ipc.test.ts`

**Interfaces:**
- Consumes: final config and lifecycle semantics
- Produces: user-facing configuration/failure documentation and MR discussion text

- [ ] **Step 1: Add the bilingual documentation**

Document all of these exact points in both languages:

- per-bot `pinStreamingCard`, opt-in, default off;
- only the current public live-status `streamCardId` participates;
- hot on/off reconciliation for existing active sessions;
- repo picker, private `/card`, final reply, CoT, closed, and other cards remain unpinned;
- failures never interrupt publication, transfer, resume, close, or configuration;
- temporary zero/multiple Pins are possible;
- there is no durable retry journal or full-chat Pin audit, so an exceptional crash can leave a stale Pin.

- [ ] **Step 2: Run documentation and full verification**

Run:

```bash
bun run test -- test/pin-streaming-card-change.test.ts test/bot-config-store.test.ts \
  test/card-prefs-auto-start.test.ts test/command-handler.test.ts test/dashboard-ipc.test.ts \
  test/streaming-card-pinning.test.ts
bun run test
bun run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit and push Unit 4**

```bash
git add src/services/pin-streaming-card-change.ts src/services/bot-config-store.ts \
  src/services/card-prefs-store.ts src/daemon.ts \
  test/pin-streaming-card-change.test.ts test/bot-config-store.test.ts \
  test/card-prefs-auto-start.test.ts test/command-handler.test.ts test/dashboard-ipc.test.ts \
  docs-site/docs/zh/bots-json.md docs-site/docs/en/bots-json.md \
  docs-site/docs/zh/cards.md docs-site/docs/en/cards.md
git commit -m "feat(card): 支持实时卡片 Pin 热重算"
git push fork feat/pin-streaming-card
```

---

### Task 8: Integration verification, live acceptance, and merge request

**Files:**
- Verify: all changed files
- Create externally: GitHub pull request from `TWT233:feat/pin-streaming-card` to `deepcoldy:master`

**Interfaces:**
- Consumes: the four verified implementation commits
- Produces: pushed integration branch and reviewable Chinese MR

- [ ] **Step 1: Review the complete commit series and diff**

Run:

```bash
git log --oneline origin/master..HEAD
git diff --check origin/master...HEAD
git diff --stat origin/master...HEAD
git status --short --branch
```

Expected: design + four implementation commits, no whitespace errors, and a clean worktree.

- [ ] **Step 2: Run fresh full verification**

Run:

```bash
bun run test
bun run build
```

Expected: both exit 0 in this step; do not reuse earlier output for the completion claim.

- [ ] **Step 3: Deploy the feature checkout for manual Feishu acceptance**

Run from this worktree:

```bash
bun run switch:here
bun run daemon:restart
```

Verify on a dedicated test bot, not a production-sensitive bot:

```text
1. Existing active session + switch on -> current streamCardId becomes pinned.
2. New turn -> successor becomes pinned; predecessor is no longer pinned.
3. Close -> Pin disappears and session still closes.
4. Switch off with an active session -> current/known frozen Pins disappear.
5. Setting absent on another bot -> no Pin API traffic and existing behavior is unchanged.
6. Cross-topic chat-scope session -> old topic card remains visible but is unpinned.
```

Capture a screenshot showing the pinned live card and a second screenshot after close/Unpin for the MR. Do not expose secrets or private conversation contents.

- [ ] **Step 4: Restore the canonical checkout after live acceptance**

Run from `/data00/home/wangqiyilang/playground/botmux`:

```bash
bun run switch:here
bun run daemon:restart
```

Expected: global `botmux` and all daemons again run from the canonical checkout, so deleting the feature worktree later cannot break the fleet.

- [ ] **Step 5: Push and create the Chinese merge request**

Run:

```bash
git push fork feat/pin-streaming-card
gh pr create \
  --repo deepcoldy/botmux \
  --head TWT233:feat/pin-streaming-card \
  --base master \
  --title "feat(card): 支持按 Bot 置顶当前实时卡片" \
  --body-file /tmp/botmux-pin-streaming-card-pr.md
```

The Chinese body must include: what changed, why, affected platforms/CLIs/session types, exact automated commands/results, live acceptance results/screenshots, fail-open and no-journal limitations, and this explicit discussion item:

> 是否应在观察 API 流量与失败率后，将 `pinStreamingCard` 改为默认开启？本 MR 为保持兼容性，刻意采用按 Bot 显式开启、默认关闭。

---

### Task 9: Add the per-chat Pin opt-out

**Files:**
- Modify: `src/bot-registry.ts`
- Create: `src/services/pin-streaming-card-mode-store.ts`
- Modify: `src/services/pin-streaming-card-change.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/core/command-handler.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `docs-site/docs/en/cards.md`
- Modify: `docs-site/docs/zh/cards.md`
- Modify: `docs-site/docs/en/bots-json.md`
- Modify: `docs-site/docs/zh/bots-json.md`
- Test: `test/bot-registry-grant.test.ts`
- Create: `test/pin-streaming-card-mode-store.test.ts`
- Modify: `test/pin-streaming-card-change.test.ts`
- Modify: `test/streaming-card-pinning.test.ts`
- Modify: `test/command-handler.test.ts`

**Interfaces:**
- Consumes: the bot-level `pinStreamingCard` master, per-bot mutation
  serialization, active-session registry, and Pin reconciliation helpers
- Produces: `BotConfig.noPinStreamingCardChats?: string[]`,
  `setChatStreamingCardPin(larkAppId, chatId, enabled)`, and
  `/card pin off|on|status`

- [ ] **Step 1: Write and run failing config/store tests**

Cover strict trimmed/deduplicated normalization; absent/all-invalid input;
off adding a chat ID; on removing it and deleting the empty top-level key;
idempotent writes; disk/live-memory synchronization; and cross-app isolation.

Run:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts
```

Expected: RED because the field and store do not exist.

- [ ] **Step 2: Implement the negative-set store**

Add `noPinStreamingCardChats?: string[]` beside `noCardChats` / `noCotChats`,
normalize it in `parseBotConfigsFromText`, and implement:

```ts
export async function setChatStreamingCardPin(
  larkAppId: string,
  chatId: string,
  enabled: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }>;
```

Run the whole disk mutation through
`serializePinStreamingCardConfigChange(larkAppId, ...)`, use `rmwBotEntry`,
update the live registry only after success, delete an empty list, and notify
only when the effective chat policy changes. Verify GREEN.

- [ ] **Step 3: Write and run failing policy/reconciliation tests**

Cover global on + chat off zero Pin, another chat remaining enabled, immediate
chat opt-out cleanup, opt-in under global on, opt-in under global off, failed
Unpin provenance retention, no-transport zero-call behavior, and rapid mixed
bot/chat writes converging in order.

Expected: RED because policy reads only the bot-level flag and the current
queue carries one bot-wide boolean.

- [ ] **Step 4: Make policy and one per-bot queue chat-aware**

Resolve the effective policy from `(larkAppId, chatId)` at every pre/post Pin
check and lifecycle cleanup-capture decision. Keep one queue per `larkAppId`;
enqueue ordered bot-wide or chat-scoped reconcile requests carrying whether the
specific transition has authoritative cleanup permission. Process active
sessions in batches of at most 20 and recompute each session's effective state
from live config. Keep all reconciliation fire-and-forget and fail-open. Verify
GREEN.

- [ ] **Step 5: Write and run failing command tests**

Cover the existing operator gate plus `/card pin status`, `/card pin off`, and
`/card pin on`; verify these work without a live session, do not call
`setCardMode`, and never mutate `streamingCardForced`.

- [ ] **Step 6: Implement the `/card pin` command and bilingual copy**

Parse the nested Pin subcommands before the existing `/card off|on|show` cases.
Use the shared store and report master-off, chat-opted-out, and effective-on
states distinctly. Keep the current `/card` command token and routing tables
unchanged. Verify GREEN.

- [ ] **Step 7: Document, verify, commit, and push**

Document that Pin is chat-wide; each active session remains independently
pinned; same-chat topics/bots therefore add multiple group-level entries; and
`/card pin off` is the escape hatch for a noisy chat while retaining live
cards. Add `noPinStreamingCardChats` to both `bots-json.md` references. Run:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts \
  test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts \
  test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Then commit and push as one independently reviewable per-chat unit.

### Follow-up: Dashboard Group Manage control

Do not implement this in PR #1067. Track a follow-up that adds the effective
Pin state to group-member aggregation, daemon/public Dashboard mutation routes,
and a localized toggle in the Group Manage dialog. It spans at least
`dashboard-ipc-server.ts`, `dashboard.ts`, `groups-action-helpers.ts`,
`groups-api.ts`, `groups-page.tsx`, and Dashboard tests, so it should be
reviewed independently from the lifecycle feature.

### Follow-up: restart-safe Pin provenance

Add a paginated `GET /im/v1/pins` wrapper and recover only entries whose
`operator_id_type === 'app_id'` and `operator_id` equals the current bot app ID.
Never infer ownership from message authorship, because one bot can Pin or Unpin
another bot's messages.

---

### Task 10: Final verification after post-review changes

- [ ] **Step 1: Run fresh full verification**

Run the focused per-chat matrix from Task 9, then:

```bash
mise exec bun@1.4.0 -- bun run test
mise exec bun@1.4.0 -- bun run build
git diff --check origin/master...HEAD
```

- [ ] **Step 2: Verify remote state**

Run:

```bash
gh pr view --repo deepcoldy/botmux --json number,url,title,headRefName,baseRefName,state
git ls-remote --heads fork feat/pin-streaming-card
```

Expected: open MR targets `master`, head is the pushed feature branch, and remote SHA equals local `HEAD`. Keep the integration worktree until the MR is reviewed and merged.
