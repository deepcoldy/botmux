# Passthrough Turn Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every passthrough command and every pending-repository turn that is actually accepted by a CLI receives the existing Lark received→done reaction lifecycle on its original user message.

**Architecture:** Keep `noteTurnReceived` as the single reaction policy implementation. Invoke it only after the relevant worker/durable acceptance boundary. Expose it to `card-handler.ts` through `CardHandlerDeps`, preserving dependency direction and using the stored `pendingRawTurnId`/`pendingTurnId` rather than the card callback message id.

**Tech Stack:** TypeScript, Bun, Vitest, Lark message reactions, existing daemon/card-handler dependency injection.

---

## File map

- Modify `src/daemon.ts`: register live accepted passthrough turns and wire reaction callbacks into worker-pool/card handling.
- Modify `src/core/worker-pool.ts`: register delayed cold-start raw turns only after `prompt_ready` accepts the `raw_input` IPC.
- Modify `src/im/lark/card-handler.ts`: register ordinary pending-repository turns after a successful fork; leave raw turns to the later worker acceptance boundary.
- Modify `test/transfer-passthrough-gate.test.ts`: prove live passthrough reacts only after worker acceptance.
- Modify `test/card-handler-repo-select.test.ts`: prove ordinary pending-repository turns react against their original user message and raw turns are not acknowledged prematurely.
- Modify `test/worker-ready-display-mode.test.ts`: prove pending raw passthrough turns react when `prompt_ready` actually dispatches them.

### Task 1: Existing-session passthrough reaction

**Files:**
- Modify: `test/transfer-passthrough-gate.test.ts`
- Modify: `src/daemon.ts:17477-17546`

- [ ] **Step 1: Write failing acceptance and rejection tests**

Mock `addReaction` in `test/transfer-passthrough-gate.test.ts`, register a card-off bot, and add two cases around `deliverPassthrough`:

```ts
it('registers the original passthrough message after raw_input is accepted', () => {
  const send = vi.fn(() => true);
  const ds = makeLiveSession(send);

  deliverPassthrough(ds, '/goal', '/goal ship it', 'om_root', ds.larkAppId, {
    messageId: 'om_goal_turn',
    senderOpenId: 'ou_owner',
    senderIsBot: false,
    substitute: false,
  });

  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'raw_input',
    content: '/goal ship it',
    turnId: 'om_goal_turn',
  }));
  expect(mocks.addReaction).toHaveBeenCalledWith(
    'app-transfer-passthrough',
    'om_goal_turn',
    'GoGoGo',
  );
});

it('does not react when the worker rejects raw_input', () => {
  const ds = makeLiveSession(vi.fn(() => false));

  deliverPassthrough(ds, '/goal', '/goal ship it', 'om_root', ds.larkAppId, {
    messageId: 'om_goal_turn',
    senderOpenId: 'ou_owner',
    senderIsBot: false,
    substitute: false,
  });

  expect(mocks.addReaction).not.toHaveBeenCalled();
});
```

Use the test file's existing `DaemonSession` construction rather than introducing production helpers.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
bunx vitest run --project unit test/transfer-passthrough-gate.test.ts
```

Expected: the acceptance test fails because `addReaction` is never called; the rejection test passes.

- [ ] **Step 3: Register the turn after worker acceptance**

In `deliverPassthroughToExistingSession`, immediately after `accepted` is proven and before `beginNewTurn`, add the best-effort registration without delaying raw delivery:

```ts
if (!accepted) {
  logger.warn(`[${anchor.substring(0, 12)}] Passthrough ${cmd} was not accepted by the worker`);
  return;
}
void noteTurnReceived(ds, turn.messageId, commandContent, undefined, turn.messageId);
beginNewTurn(ds, commandContent, turn.messageId);
```

Do not call it before `sendWorkerSessionInput`; rejected raw input must remain reaction-free.

- [ ] **Step 4: Run the focused test and confirm pass**

Run:

```bash
bunx vitest run --project unit test/transfer-passthrough-gate.test.ts
```

Expected: all tests pass, including the existing transfer buffering case.

- [ ] **Step 5: Commit the focused change**

```bash
git add src/daemon.ts test/transfer-passthrough-gate.test.ts
git commit -m "fix(lark): 为已接纳透传指令登记状态表情

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Pending repository card reaction

**Files:**
- Modify: `src/im/lark/card-handler.ts:131-168,510-700`
- Modify: `src/daemon.ts:5692-5756`
- Modify: `test/card-handler-repo-select.test.ts`

- [ ] **Step 1: Add failing card-handler tests**

Extend `makeDeps` with a mockable `noteTurnReceived` dependency and add one ordinary and one passthrough case:

```ts
it('reacts on the original pending turn after repo selection starts the CLI', async () => {
  const ds = makeDs({
    pendingRepo: true,
    pendingPrompt: 'implement feature',
    pendingTurnId: 'om_original_turn',
    worker: null,
  });
  const { deps, noteTurnReceived } = makeDeps(ds);

  await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

  expect(noteTurnReceived).toHaveBeenCalledWith(ds, 'om_original_turn');
});

it('does not acknowledge a raw passthrough before prompt_ready dispatches it', async () => {
  const ds = makeDs({
    pendingRepo: true,
    pendingPrompt: '',
    pendingRawInput: '/goal ship it',
    pendingRawTurnId: 'om_goal_turn',
    worker: null,
  });
  const { deps, noteTurnReceived } = makeDeps(ds);

  await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

  expect(noteTurnReceived).not.toHaveBeenCalled();
  expect(ds.pendingRawTurnId).toBe('om_goal_turn');
});
```

Also add a fork-failure assertion using the existing failure setup:

```ts
expect(noteTurnReceived).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
bunx vitest run --project unit test/card-handler-repo-select.test.ts
```

Expected: TypeScript/runtime assertions fail because `CardHandlerDeps` has no reaction callback and the success path never invokes one.

- [ ] **Step 3: Add the narrow injected dependency**

Add this optional dependency to `CardHandlerDeps`:

```ts
/** Register the original Lark turn after a pending repo selection starts its CLI. */
noteTurnReceived?: (ds: DaemonSession, messageId: string) => Promise<void>;
```

In the successful pending-repo commit, the ordinary prompt is accepted synchronously by `forkWorker`, while raw passthrough bytes are intentionally deferred until `prompt_ready`. After `forkWorker(...)` returns successfully and before clearing `pendingTurnId`, acknowledge only the ordinary case:

```ts
if (!pendingRawInput && pendingTurnId) {
  void deps.noteTurnReceived?.(ds, pendingTurnId);
}
```

The raw case keeps `pendingRawTurnId` intact and is handled by Task 3 at its real `sendWorkerSessionInput` acceptance boundary.

Wire daemon's existing policy function:

```ts
const cardDeps: CardHandlerDeps = {
  activeSessions,
  sessionReply,
  lastRepoScan,
  noteTurnReceived: (ds, messageId) => noteTurnReceived(ds, messageId),
  // existing dependencies...
};
```

Do not react to the card callback's `open_message_id`; the original user message id is the lifecycle key.

- [ ] **Step 4: Run card-handler tests and confirm pass**

Run:

```bash
bunx vitest run --project unit test/card-handler-repo-select.test.ts
```

Expected: all repo-select tests pass; the ordinary turn uses its original message id, while the raw turn remains unacknowledged and retains its id until worker-ready delivery.

- [ ] **Step 5: Commit the card path**

```bash
git add src/im/lark/card-handler.ts src/daemon.ts test/card-handler-repo-select.test.ts
git commit -m "fix(lark): 项目选择后补登记原始轮次状态

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Delayed cold-start passthrough reaction

**Files:**
- Modify: `src/core/worker-pool.ts:669-753,12096-12133`
- Modify: `src/daemon.ts` at the `initWorkerPool(...)` callback wiring
- Modify: `test/worker-ready-display-mode.test.ts`

- [ ] **Step 1: Add failing worker-ready acceptance tests**

In the existing `prompt_ready` test setup, inject an `onRawInputAccepted` callback and add:

```ts
it('registers the original pending raw turn after prompt_ready accepts raw_input', async () => {
  const ds = makeDs({
    pendingRawInput: '/goal ship it',
    pendingRawTurnId: 'om_goal_turn',
  });

  await emitPromptReady(ds);

  expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'raw_input',
    content: '/goal ship it',
    turnId: 'om_goal_turn',
  }));
  expect(callbacks.onRawInputAccepted).toHaveBeenCalledWith(ds, 'om_goal_turn');
});

it('does not register a reaction when raw_input is not accepted', async () => {
  worker.send.mockImplementation(() => false);
  const ds = makeDs({
    pendingRawInput: '/goal ship it',
    pendingRawTurnId: 'om_goal_turn',
  });

  await emitPromptReady(ds);

  expect(callbacks.onRawInputAccepted).not.toHaveBeenCalled();
});
```

Adapt the second assertion to the actual boolean return exposed by `sendWorkerSessionInput`; if the worker-ready path currently ignores it, first pin that behavior with the failing test rather than inventing a second acceptance definition.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
bunx vitest run --project unit test/worker-ready-display-mode.test.ts
```

Expected: the accepted raw turn never invokes an acceptance callback.

- [ ] **Step 3: Add a worker-pool acceptance callback**

Extend `WorkerPoolCallbacks`:

```ts
/** A delayed cold-start raw input crossed the worker IPC acceptance boundary. */
onRawInputAccepted?: (ds: DaemonSession, turnId: string) => void | Promise<void>;
```

In `prompt_ready`, preserve `rawTurnId`, check the existing send result, and notify only after acceptance:

```ts
const accepted = sendWorkerSessionInput(ds, {
  type: 'raw_input',
  content: rawInput,
  // existing fields
});
if (accepted && rawTurnId) {
  void requireCallbacks().onRawInputAccepted?.(ds, rawTurnId);
}
```

Wire the daemon callback to the existing policy:

```ts
onRawInputAccepted: (ds, turnId) => noteTurnReceived(ds, turnId),
```

Preserve `pendingRawInput` and `pendingRawTurnId` until the send is known to be accepted. If the current code clears them before sending, move the clear immediately after successful acceptance so a rejected write remains retryable.

- [ ] **Step 4: Run worker-ready and card tests**

Run:

```bash
bunx vitest run --project unit \
  test/worker-ready-display-mode.test.ts \
  test/card-handler-repo-select.test.ts
```

Expected: all tests pass; direct cold starts and card-delayed raw starts share the same worker-ready acceptance callback.

- [ ] **Step 5: Commit the delayed raw path**

```bash
git add src/core/worker-pool.ts src/daemon.ts test/worker-ready-display-mode.test.ts
git commit -m "fix(lark): 冷启动透传接纳后补状态表情

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: Regression verification

**Files:**
- Verify only; modify files only if a test exposes a real defect.

- [ ] **Step 1: Run focused reaction and passthrough suites**

```bash
bunx vitest run --project unit \
  test/turn-reactions.test.ts \
  test/transfer-passthrough-gate.test.ts \
  test/card-handler-repo-select.test.ts \
  test/worker-ready-display-mode.test.ts \
  test/command-handler.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run the complete unit suite**

```bash
bun run test
```

Expected: unit suite passes with zero failures.

- [ ] **Step 3: Run the production build**

```bash
bun run build
```

Expected: TypeScript compilation, dashboard bundle, and audits all complete successfully.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff HEAD~3 --check
git status --short
git log -4 --oneline
```

Expected: no whitespace errors; only the design, plan, reaction implementation, and focused tests are changed; worktree is clean after commits.

- [ ] **Step 5: Optional live verification when safe to switch the shared daemon**

Only after automated verification and explicit authorization to affect all bots:

```bash
bun run switch:here
bun run daemon:restart
```

Then verify in Lark:

1. Send a configured passthrough command such as `/goal test reaction` in a card-off session.
2. If prompted, select a project card.
3. Confirm the original command message receives the configured received reaction after CLI acceptance.
4. Confirm it changes to `DONE` after the worker returns idle.
5. Send a pure daemon management command and confirm it does not gain an execution reaction.

Record the live result in the PR description; restore the canonical checkout after testing.
