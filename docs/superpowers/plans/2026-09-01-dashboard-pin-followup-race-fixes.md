# Dashboard Pin Follow-up Race Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale group snapshots and stale Manage-dialog operations from overwriting newer Dashboard state or issuing mutations after their owning dialog has gone away.

**Architecture:** Keep request ordering authoritative inside `groups-api.ts`, because the shared cache has multiple consumers and only that module can compare every full-snapshot request. Keep dialog safety local to each mounted `ManageDialog`: Oncall reconciliation stays blocked until the post-write refresh succeeds, and leave/disband continuations check a per-instance liveness fence after every asynchronous boundary.

**Tech Stack:** TypeScript, React, Vitest, react-test-renderer, Bun 1.4.0.

## Global Constraints

- `fetchGroupsSnapshot(options?: FetchGroupsSnapshotOptions): Promise<GroupsSnapshot>` remains source-compatible for all callers.
- Full-snapshot cache ordering is global across every caller: the highest request sequence that succeeds wins; a later-started failure does not suppress an earlier request that subsequently succeeds.
- Oncall PUT/DELETE success remains authoritative even when the forced reload fails; an older snapshot must not visually roll the saved value back.
- A closed, replaced, unmounted, or unavailable Manage dialog must not start another leave/disband mutation or close a replacement dialog.
- No live daemon restart or checkout switch; verification is local only.
- Do not run `bun install` in this worktree.

## Unit list and dependency graph

1. **Global full-snapshot cache ordering** — independently testable and independently revertible.
2. **Manage-dialog async lifetime and Oncall reconciliation** — independently testable and independently revertible after Unit 1.

Dependency edges:

- Unit 1 → Unit 2: **shared file only**, not a runtime dependency. They are serialized solely because both edit `groups-page.tsx`; Unit 2 must start from Unit 1's committed head.

## Shared interface contracts

- `fetchGroupsSnapshot(...)` continues returning only `GroupsSnapshot`; request sequence metadata remains private to `groups-api.ts`.
- `OncallRow.onSaved()` changes from `Promise<void>` to `Promise<GroupsSnapshot>` so the row can reconcile explicitly from the accepted post-write snapshot.
- `ManageDialog` owns a mount-lifetime ref. Every async continuation checks that ref plus the current `available` ref before starting further mutations or invoking `onClose`.

---

### Task 1: Make the shared groups cache obey global latest-success ordering

**Files:**
- Modify: `src/dashboard/web/groups-api.ts`
- Modify: `src/dashboard/web/groups-page.tsx`
- Modify: `src/dashboard/web/groups.ts`
- Modify: `test/dashboard-groups-names-inflight.test.ts`
- Modify: `test/dashboard-streaming-card-pin-toggle.test.ts`

**Interfaces:**
- Consumes: existing `fetchGroupsSnapshot({ force?: boolean })`.
- Produces: unchanged public fetch signature; internal `latestSuccessfulRequestSeq` decides whether a successful response may publish to `cachedSnapshot`.

- [ ] **Step 1: Add failing behavior tests**

Add one API test that starts forced request A, starts forced request B, rejects B, resolves A, then proves a non-forced call reuses A without issuing request C. Add one GroupsPage/cross-consumer test that starts page request A, starts external forced request B, resolves B before A, then proves the shared cache remains B after A is accepted locally.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
mise exec bun@1.4.0 -- bun x vitest run test/dashboard-groups-names-inflight.test.ts test/dashboard-streaming-card-pin-toggle.test.ts
```

Expected: the older successful request is not cached after a later failure, and/or the page's unconditional cache commit regresses the cross-consumer cache.

- [ ] **Step 3: Implement the minimal cache fix**

Replace `latestRequestSeq` with `latestSuccessfulRequestSeq`. On each successful full response, publish only when `seq > latestSuccessfulRequestSeq`, then advance that successful sequence. Remove `commitGroupsSnapshotCache` and both GroupsPage calls; the API layer now owns all cache ordering. Keep `primeGroupsSnapshotCache` for existing explicit test/setup use.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command and confirm zero failures.

- [ ] **Step 5: Commit and push**

```bash
git add src/dashboard/web/groups-api.ts src/dashboard/web/groups-page.tsx src/dashboard/web/groups.ts test/dashboard-groups-names-inflight.test.ts test/dashboard-streaming-card-pin-toggle.test.ts docs/superpowers/plans/2026-09-01-dashboard-pin-followup-race-fixes.md
git commit -m "fix(dashboard): 统一群组快照缓存顺序"
git push fork fix/dashboard-pin-followups
```

### Task 2: Fence Manage-dialog continuations and preserve saved Oncall state

**Files:**
- Modify: `src/dashboard/web/groups-page.tsx`
- Modify: `test/dashboard-streaming-card-pin-toggle.test.ts`

**Interfaces:**
- Consumes: `ManageDialog.onReloadGroups(...): Promise<GroupsSnapshot>`.
- Produces: `OncallRow.onSaved(): Promise<GroupsSnapshot>` and a dialog-instance liveness predicate used after each confirm/fetch/reload boundary.

- [ ] **Step 1: Add failing behavior tests**

Add regressions for all three observable breaks:

1. PUT succeeds, an older member snapshot arrives while forced reload is pending, forced reload fails, and the Oncall input still shows the saved draft.
2. Disband's first bot request is pending, the Manage dialog unmounts, that request fails, and no second bot request is sent.
3. Leave is pending, the old Manage dialog unmounts and a replacement mounts, then old completion does not invoke the stale `onClose` or remove the replacement.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
mise exec bun@1.4.0 -- bun x vitest run test/dashboard-streaming-card-pin-toggle.test.ts
```

Expected: each new regression fails on the current continuation/snapshot behavior.

- [ ] **Step 3: Implement the minimal lifecycle fix**

Keep Oncall dirty while the forced reload is pending. On reload success, reconcile from the returned `GroupsSnapshot` and then clear dirty; on reload failure, retain the submitted local value as dirty. Add a mount-lifetime ref to `ManageDialog`, invalidate it on cleanup, and check `mounted && available` after every awaited confirm/fetch/reload before another mutation or `onClose`. Key ManageDialog by captured chat id so direct dialog replacement cannot reuse the old component instance.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command and confirm zero failures.

- [ ] **Step 5: Commit and push**

```bash
git add src/dashboard/web/groups-page.tsx test/dashboard-streaming-card-pin-toggle.test.ts
git commit -m "fix(dashboard): 隔离群管理弹窗异步操作"
git push fork fix/dashboard-pin-followups
```

### Task 3: Final integration verification and review

**Files:**
- Verify only; edit only if a review finding requires a new fix commit.

**Interfaces:**
- Consumes: Tasks 1-2 commits.
- Produces: a clean branch head suitable for PR #1183.

- [ ] **Step 1: Run the focused Dashboard matrix**

```bash
mise exec bun@1.4.0 -- bun x vitest run test/dashboard-streaming-card-pin-toggle.test.ts test/dashboard-chat-pin-route.integration.test.ts test/dashboard-chat-pin-route-auth.integration.test.ts test/dashboard-groups-names-inflight.test.ts test/dashboard-groups-names-view.test.ts test/dashboard-whiteboard-cli.test.ts
```

- [ ] **Step 2: Run build and diff checks**

```bash
mise exec bun@1.4.0 -- bun run build
git diff --check origin/master...HEAD
```

- [ ] **Step 3: Review Standards and Spec independently**

Review the final diff against `origin/master` and this plan. Any Critical or Important finding requires one scoped fix and re-review before completion.

- [ ] **Step 4: Push any review fix and refresh PR status**

Confirm PR #1183 points at the final branch head, then refresh review comments and CI.
