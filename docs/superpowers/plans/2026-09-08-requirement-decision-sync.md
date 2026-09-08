# Requirement Decision Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably capture human decisions from registered requirement chats, including real thread replies, serialize them through one writer, and settle obligations only after context document, pinned card, and whiteboard readbacks succeed.

**Architecture:** Add a machine-level requirement registry and a durable obligation state machine. Register obligations at the authorized Lark inbound boundary, schedule one writer through the existing trigger-session path, and use turn-terminal only as recovery compensation. Botmux owns delivery reliability; the existing context-sync workflow owns semantic classification, ledger CAS, rendering, and outlet acknowledgements.

**Tech Stack:** TypeScript, Node.js filesystem primitives, existing Botmux Lark dispatcher/session trigger infrastructure, Vitest, JSON persistence.

---

## File Structure

- Create `src/services/requirement-sync-registry.ts`: validate and read requirement-chat registrations.
- Create `src/services/decision-obligation-store.ts`: persist source versions, state transitions, leases, retries, and recovery scans.
- Create `src/services/decision-intake.ts`: filter authorized human messages and atomically register obligations.
- Create `src/services/decision-writer-scheduler.ts`: serialize writer wakeups through existing trigger-session capability.
- Modify `src/im/lark/event-dispatcher.ts`: call intake after existing authorization checks for both top-level and real-thread messages.
- Modify `src/daemon.ts`: wire services and run terminal/restart compensation.
- Modify `src/core/worker-pool.ts`: expose the existing terminal callback context needed by compensation without changing turn semantics.
- Modify `src/global-config.ts`: define feature flag and registry configuration contract.
- Modify `src/core/dashboard-ipc-server.ts`: add owner-only registry read/update endpoints with validation.
- Create focused tests beside existing service/dispatcher/dashboard tests.

### Task 1: Requirement Sync Registry

**Files:**
- Create: `src/services/requirement-sync-registry.ts`
- Modify: `src/global-config.ts`
- Test: `test/requirement-sync-registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover: disabled by default, exact `chatId + requirementId` uniqueness, absolute existing workspace, registered writer app/session, malformed records fail closed, atomic read-after-write, and disabling preserves audit metadata.

```ts
it('returns one enabled registration for an exact chat', () => {
  writeConfig({ requirementDecisionSync: { enabled: true, registrations: [valid] } });
  expect(registry.findEnabled(valid.chatId)).toEqual(valid);
});

it('fails closed when duplicate chat registrations exist', () => {
  writeConfig({ requirementDecisionSync: { enabled: true, registrations: [valid, { ...valid }] } });
  expect(() => registry.list()).toThrow(/duplicate chatId/);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `bunx vitest run --project unit test/requirement-sync-registry.test.ts`
Expected: FAIL because the registry module/config type does not exist.

- [ ] **Step 3: Implement the registry and config types**

Define:

```ts
export interface RequirementSyncRegistration {
  chatId: string;
  requirementId: string;
  workspaceRealpath: string;
  writerBotAppId: string;
  writerSessionId: string;
  enabled: boolean;
  protocolVersion: 1;
  createdAt: string;
  disabledAt?: string;
}
```

Use the existing global config cache for reads and existing atomic merge path for writes. Validation must reject non-`oc_` chats, blank IDs, non-absolute/nonexistent workspaces, duplicate enabled chats, and unknown writer apps.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --project unit test/requirement-sync-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/global-config.ts src/services/requirement-sync-registry.ts test/requirement-sync-registry.test.ts
git commit -m "feat(context): 增加需求决策同步注册表"
```

### Task 2: Durable Obligation Store

**Files:**
- Create: `src/services/decision-obligation-store.ts`
- Test: `test/decision-obligation-store.test.ts`

- [ ] **Step 1: Write failing state-machine tests**

Cover source-key dedupe across apps, identical-version idempotency, amendment append, stale version rejection, atomic transition checks, lease fencing, lease expiry, retry metadata, and restart recovery.

```ts
const first = store.receive({
  requirementId: '7365887038', sourcePlatform: 'lark', sourceChatId: 'oc_req',
  sourceMessageId: 'om_decision', sourceUpdatedAt: '2026-09-08T10:00:00Z',
  contentHash: 'sha256:a', receiverAppId: 'cli_a',
});
const duplicate = store.receive({ ...first.input, receiverAppId: 'cli_b' });
expect(duplicate.obligationId).toBe(first.obligationId);
expect(store.list()).toHaveLength(1);
```

- [ ] **Step 2: Verify tests fail**

Run: `bunx vitest run --project unit test/decision-obligation-store.test.ts`
Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement JSON persistence and transitions**

Persist under `~/.botmux/data/requirement-decision-obligations.json` using lock + temp file + rename. Define states:

```ts
type ObligationState =
  | 'received' | 'classifying' | 'clarification_required' | 'queued'
  | 'processing' | 'committed' | 'publishing' | 'pending_retry' | 'complete';
```

Every transition accepts `expectedState` and optional `leaseToken`; stale transitions fail without writing. Store versions as immutable amendments and maintain `currentVersion` by verified update time plus content hash.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --project unit test/decision-obligation-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/decision-obligation-store.ts test/decision-obligation-store.test.ts
git commit -m "feat(context): 持久化决策同步义务"
```

### Task 3: Authorized Lark Intake Including Threads

**Files:**
- Create: `src/services/decision-intake.ts`
- Modify: `src/im/lark/event-dispatcher.ts`
- Test: `test/decision-intake.test.ts`
- Test: `test/event-dispatcher-decision-intake.test.ts`

- [ ] **Step 1: Write failing intake tests**

Cover registered vs unregistered chat, human vs bot/system/self sender, top-level and real-thread message metadata, authorization rejection, canonical text hashing, and persistence failure behavior.

```ts
it('registers a real-thread human message after authorization', async () => {
  await intake.handle({ ...humanMessage, chatId: 'oc_req', rootId: 'om_root', threadId: 'omt_topic' });
  expect(store.receive).toHaveBeenCalledWith(expect.objectContaining({
    sourceMessageId: humanMessage.messageId,
    sourceChatId: 'oc_req',
    sourceThreadId: 'omt_topic',
  }));
});
```

- [ ] **Step 2: Verify tests fail**

Run: `bunx vitest run --project unit test/decision-intake.test.ts test/event-dispatcher-decision-intake.test.ts`
Expected: FAIL because intake is not wired.

- [ ] **Step 3: Implement intake service**

The service receives already-authorized normalized inbound metadata, resolves registration by exact chat, rejects non-human/self/system messages, hashes normalized original content, and calls `store.receive`. It returns `ignored | received | duplicate | failed`; it never mutates context state.

- [ ] **Step 4: Wire the common dispatcher boundary**

Call intake after existing talk/source authorization and before routing branches that distinguish top-level from thread replies. Do not call through `messageListeners`, and do not treat the per-app seen store as settlement.

- [ ] **Step 5: Run focused tests**

Run: `bunx vitest run --project unit test/decision-intake.test.ts test/event-dispatcher-decision-intake.test.ts`
Expected: PASS for both top-level and real-thread cases.

- [ ] **Step 6: Commit**

```bash
git add src/services/decision-intake.ts src/im/lark/event-dispatcher.ts test/decision-intake.test.ts test/event-dispatcher-decision-intake.test.ts
git commit -m "feat(context): 接入真人决策入站登记"
```

### Task 4: Serialized Writer Scheduler

**Files:**
- Create: `src/services/decision-writer-scheduler.ts`
- Modify: `src/core/trigger-session.ts`
- Test: `test/decision-writer-scheduler.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Cover one lease per requirement, reuse of registered writer session, queued second obligation, trigger idempotency key, offline writer retry, and independent requirements running concurrently.

```ts
await Promise.all([scheduler.wake('ob_1'), scheduler.wake('ob_2')]);
expect(triggerSession).toHaveBeenCalledTimes(1);
expect(triggerSession).toHaveBeenCalledWith(expect.objectContaining({
  sessionId: valid.writerSessionId,
  idempotencyKey: expect.stringMatching(/^decision-sync:7365887038:/),
}));
```

- [ ] **Step 2: Verify tests fail**

Run: `bunx vitest run --project unit test/decision-writer-scheduler.test.ts`
Expected: FAIL because scheduler API does not exist.

- [ ] **Step 3: Implement minimal scheduler**

Acquire the obligation store lease, build a compact prompt containing only obligation ID and workspace path, invoke existing trigger-session with a stable idempotency key, and persist retry details on failure. Never include full chat content in argv/prompt.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --project unit test/decision-writer-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/decision-writer-scheduler.ts src/core/trigger-session.ts test/decision-writer-scheduler.test.ts
git commit -m "feat(context): 串行调度需求上下文发布者"
```

### Task 5: Runtime Wiring and Recovery Compensation

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/worker-pool.ts`
- Test: `test/decision-sync-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Cover daemon startup recovery, intake immediately scheduling a received obligation, terminal success rescheduling remaining pending items, terminal failure retaining obligations, and feature-off behavior.

- [ ] **Step 2: Verify tests fail**

Run: `bunx vitest run --project unit test/decision-sync-runtime.test.ts`
Expected: FAIL because runtime composition is absent.

- [ ] **Step 3: Wire services in daemon composition**

Instantiate registry/store/intake/scheduler once per daemon. On startup, scan nonterminal obligations whose leases are absent/expired. After successful intake, request a writer wake. Extend the existing `onTurnTerminal` callback input only with stable session identity required to check the corresponding registration; do not alter terminal ordering.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --project unit test/decision-sync-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts src/core/worker-pool.ts test/decision-sync-runtime.test.ts
git commit -m "feat(context): 接线决策同步恢复与补偿"
```

### Task 6: Owner-Only Registry API

**Files:**
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/dashboard.ts`
- Test: `test/dashboard-ipc-requirement-sync.test.ts`

- [ ] **Step 1: Write failing API tests**

Cover owner-only GET/PUT, exact schema validation, nonexistent workspace, unknown writer app/session, conflict-safe update, and secret-free response.

- [ ] **Step 2: Verify tests fail**

Run: `bunx vitest run --project unit test/dashboard-ipc-requirement-sync.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Implement internal API**

Add:

```text
GET /api/requirement-decision-sync
PUT /api/requirement-decision-sync/:chatId
```

Use existing dashboard owner authentication and daemon IPC forwarding. PUT accepts one complete registration plus expected config version; responses exclude credentials and obligation message content.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --project unit test/dashboard-ipc-requirement-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/dashboard-ipc-server.ts src/dashboard.ts test/dashboard-ipc-requirement-sync.test.ts
git commit -m "feat(context): 增加需求同步注册管理接口"
```

### Task 7: Context-Sync Settlement Contract

**Files:**
- Modify: `source/skills/context-sync/references/decision-sync.md` in `/data00/home/zhongweijie.x/aikit`
- Create: `source/skills/context-sync/references/decision-obligation-schema.json` in `/data00/home/zhongweijie.x/aikit`
- Test: `test/context-sync.test.js` in `/data00/home/zhongweijie.x/aikit`

- [ ] **Step 1: Write failing contract tests**

Assert the skill reference specifies obligation lookup by ID, original-message readback, allowed transitions, committed revision fields, per-outlet receipts, and complete-only-after-three-ACK behavior. Validate the JSON schema with representative complete and pending receipts.

- [ ] **Step 2: Verify tests fail**

Run from Aikit: `node --test test/context-sync.test.js`
Expected: FAIL because the schema/settlement contract is absent.

- [ ] **Step 3: Add the schema and writer instructions**

Define receipt fields for obligation/source version, state/public revision, doc revision/block map, card message/pin readback, whiteboard version, pending outlets, and completed timestamp. Require atomic obligation transition through the Botmux store API/CLI rather than direct JSON edits.

- [ ] **Step 4: Run context-sync tests and sync skills**

Run:

```bash
node --test test/context-sync.test.js
aikit skills sync
```

Expected: tests PASS; sync reports managed links updated/skipped without replacing non-aikit directories.

- [ ] **Step 5: Commit only task files in Aikit**

```bash
git add source/skills/context-sync/references/decision-sync.md \
  source/skills/context-sync/references/decision-obligation-schema.json \
  test/context-sync.test.js
git commit -m "feat(context-sync): 定义即时决策结算协议"
```

### Task 8: Full Verification and Single-Group Canary

**Files:**
- Modify: `~/.botmux/config.json` through the owner-only API (runtime state, not git)
- Evidence: `~/temp/requirement-decision-sync-canary/`

- [ ] **Step 1: Run all focused tests**

Run:

```bash
bunx vitest run --project unit \
  test/requirement-sync-registry.test.ts \
  test/decision-obligation-store.test.ts \
  test/decision-intake.test.ts \
  test/event-dispatcher-decision-intake.test.ts \
  test/decision-writer-scheduler.test.ts \
  test/decision-sync-runtime.test.ts \
  test/dashboard-ipc-requirement-sync.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run repository verification**

Run:

```bash
bun run build
bun run test
```

Expected: build and complete unit project PASS; source tree audit remains clean except intended commits.

- [ ] **Step 3: Deploy the current live checkout**

Run:

```bash
bun run switch:here
bun run daemon:restart
botmux status
```

Expected: every configured worker and Dashboard online with restart count 0; global shim still targets this live checkout.

- [ ] **Step 4: Register only requirement 7365887038 as canary**

Use the owner-only registry API with chat `oc_64a5874fdd98cd32bcabfd39a80cc5df`, workspace `/data00/home/zhongweijie.x/dev/workspaces/7365887038-ai-preaudit`, and the existing fixed writer. Read back the exact registration before sending a canary message.

- [ ] **Step 5: Exercise the real acceptance matrix**

Capture obligation IDs, state revisions, outlet receipts, and remote readbacks for: top-level decision, thread correction, duplicate delivery through two bots, edited source with stale replay, one injected outlet failure/recovery, and daemon restart recovery. Keep business decisions clearly marked as test fixtures or use a dedicated harmless canary statement approved for the test.

- [ ] **Step 6: Verify boundaries**

Confirm an unregistered chat produces no obligation; Bot/ACK output does not recurse; existing daily task `992e9bd9` remains enabled at 04:00; no new document/card/whiteboard resources were created.

- [ ] **Step 7: Record evidence and request user acceptance**

Write a concise evidence index under `~/temp/requirement-decision-sync-canary/README.md` with commands, obligation IDs, hashes, and readback locations. Report capabilities and remaining limits without exposing message content or credentials.

- [ ] **Step 8: Final implementation commit if verification required fixes**

Stage only files changed by those fixes and use a scoped Chinese commit message ending with the required co-author trailer.
