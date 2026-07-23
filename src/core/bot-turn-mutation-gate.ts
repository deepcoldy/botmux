/**
 * Per-bot admission/drain gate for mutations that replace every live worker
 * generation (currently read-isolation). JavaScript's single thread makes the
 * check+increment and close+publish edges atomic, while the waiters cover all
 * intervening awaits in inbound/HTTP turn preparation.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type GateState = {
  activeAdmissions: number;
  mutating: boolean;
  openWaiters: Array<GateWaiter>;
  drainWaiters: Array<GateWaiter>;
};

type GateWaiter = { wake: () => void };

const gates = new Map<string, GateState>();
type AdmissionLease = { active: boolean; ownerFinished: boolean };
type MutationLease = { active: boolean };
const admissionContext = new AsyncLocalStorage<ReadonlyMap<string, AdmissionLease>>();
const mutationContext = new AsyncLocalStorage<ReadonlyMap<string, MutationLease>>();

function stateFor(larkAppId: string): GateState {
  let state = gates.get(larkAppId);
  if (!state) {
    state = { activeAdmissions: 0, mutating: false, openWaiters: [], drainWaiters: [] };
    gates.set(larkAppId, state);
  }
  return state;
}

function waitUntilOpen(state: GateState): Promise<void> {
  return state.mutating
    ? new Promise(resolve => state.openWaiters.push({ wake: resolve }))
    : Promise.resolve();
}

function waitUntilDrained(state: GateState): Promise<void> {
  return state.activeAdmissions > 0
    ? new Promise(resolve => state.drainWaiters.push({ wake: resolve }))
    : Promise.resolve();
}

function wakeAll(waiters: GateWaiter[]): void {
  const pending = waiters.splice(0);
  for (const waiter of pending) waiter.wake();
}

/** Cancellable condition wait used only by bounded acquisition. Timeout
 * removes the exact waiter, so it cannot resume later and run a stale shutdown
 * after its caller already reported refusal. */
function waitUntilBefore(
  waiters: GateWaiter[],
  ready: () => boolean,
  deadlineMs: number,
): Promise<boolean> {
  if (Date.now() >= deadlineMs) return Promise.resolve(false);
  if (ready()) return Promise.resolve(true);
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const waiter: GateWaiter = {
      wake: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Date.now() < deadlineMs);
      },
    };
    waiters.push(waiter);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(false);
    }, remaining);
  });
}

export async function withBotTurnAdmission<T>(
  larkAppId: string,
  action: () => Promise<T> | T,
): Promise<T> {
  // A mutation already owns the bot exclusively. Re-entering an admission
  // boundary from that mutation must not wait for the gate it owns.
  const inheritedMutation = mutationContext.getStore()?.get(larkAppId);
  if (inheritedMutation?.active) return action();
  const inherited = admissionContext.getStore();
  // Some admitted event paths delegate to triggerSessionTurn, which is also a
  // public admission boundary. Treat that nested call as part of the outer
  // lease; otherwise a mutation that closed the gate while the outer handler
  // awaited would make the handler wait on itself and deadlock the drain.
  const inheritedLease = inherited?.get(larkAppId);
  if (inheritedLease?.active) return action();
  const state = stateFor(larkAppId);
  // A mutation may finish and another queued mutation may close the gate again
  // before this continuation runs, so re-check after every wake.
  while (state.mutating) await waitUntilOpen(state);
  state.activeAdmissions++;
  const lease: AdmissionLease = { active: true, ownerFinished: false };
  try {
    const next = new Map(inherited ?? []);
    next.set(larkAppId, lease);
    return await admissionContext.run(next, action);
  } finally {
    // AsyncLocalStorage descendants can outlive the awaited action when code
    // starts fire-and-forget work. They retain this object, so revoke it before
    // decrementing the drain count; a detached continuation must acquire a new
    // admission instead of impersonating a still-live nested call.
    // An admitted handler may upgrade itself to a mutation. The upgrade
    // temporarily releases and later reacquires this exact lease; only the
    // still-active owner decrements it here.
    lease.ownerFinished = true;
    if (lease.active) {
      lease.active = false;
      state.activeAdmissions--;
      if (state.activeAdmissions === 0) {
        wakeAll(state.drainWaiters);
      }
    }
  }
}

export async function withBotTurnMutation<T>(
  larkAppId: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const inheritedMutation = mutationContext.getStore()?.get(larkAppId);
  if (inheritedMutation?.active) return action();
  const state = stateFor(larkAppId);
  const inheritedAdmission = admissionContext.getStore()?.get(larkAppId);

  // Explicit abandon actions are discovered inside already-admitted message
  // and card handlers. Upgrade that admission instead of nesting and
  // deadlocking: release only this handler's lease, drain every other turn,
  // perform the mutation, then atomically reacquire the outer lease before the
  // gate is reopened. The caller may safely finish delivery/logging under its
  // original admission after the exclusive state change.
  const upgrading = inheritedAdmission?.active === true;
  if (upgrading) {
    inheritedAdmission.active = false;
    state.activeAdmissions--;
    if (state.activeAdmissions === 0) {
      wakeAll(state.drainWaiters);
    }
  }

  while (state.mutating) await waitUntilOpen(state);
  state.mutating = true;
  await waitUntilDrained(state);
  const mutationLease: MutationLease = { active: true };
  try {
    const next = new Map(mutationContext.getStore() ?? []);
    next.set(larkAppId, mutationLease);
    return await mutationContext.run(next, action);
  } finally {
    // Detached descendants retain the AsyncLocalStorage map. Revoke the
    // mutable lease before reopening the gate so they cannot impersonate the
    // completed mutation later.
    mutationLease.active = false;
    // Reacquire before waking queued admissions/mutations. This keeps the
    // remainder of an upgraded outer handler inside the admission lifetime and
    // prevents its finally block from double-decrementing the gate.
    if (upgrading && !inheritedAdmission.ownerFinished) {
      state.activeAdmissions++;
      inheritedAdmission.active = true;
    }
    state.mutating = false;
    wakeAll(state.openWaiters);
    // Keep the state object stable. Resolved admission waiters resume in later
    // promise jobs and still hold this object; deleting it here would let a new
    // caller create a second gate and bypass those about-to-reacquire waiters.
    // The key space is bounded by configured bot ids.
  }
}

export type BoundedBotTurnMutationResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: 'timeout' | 'upgrade_conflict' };

/** Acquire one exact mutation lease within a single absolute deadline.
 *
 * Unlike Promise.race around `withBotTurnMutation`, this removes a timed-out
 * waiter and rolls back a gate already closed while admissions were draining.
 * Therefore `action` can never run after `{ acquired:false }` was returned.
 *
 * A same-bot admission may upgrade only when no other mutation already owns
 * the gate. Returning `upgrade_conflict` leaves that admission untouched; this
 * keeps the bounded path safe without resuming an admission concurrently with
 * a mutation it had temporarily released for. */
export async function tryWithBotTurnMutation<T>(
  larkAppId: string,
  acquireTimeoutMs: number,
  action: () => Promise<T> | T,
): Promise<BoundedBotTurnMutationResult<T>> {
  const inheritedMutation = mutationContext.getStore()?.get(larkAppId);
  if (inheritedMutation?.active) {
    return { acquired: true, value: await action() };
  }
  const state = stateFor(larkAppId);
  const inheritedAdmission = admissionContext.getStore()?.get(larkAppId);
  const upgrading = inheritedAdmission?.active === true;
  if (upgrading && state.mutating) {
    return { acquired: false, reason: 'upgrade_conflict' };
  }

  const deadlineMs = Date.now() + Math.max(0, acquireTimeoutMs);
  if (upgrading) {
    inheritedAdmission.active = false;
    state.activeAdmissions--;
    if (state.activeAdmissions === 0) wakeAll(state.drainWaiters);
  } else {
    while (state.mutating) {
      if (!await waitUntilBefore(state.openWaiters, () => !state.mutating, deadlineMs)) {
        return { acquired: false, reason: 'timeout' };
      }
    }
  }

  if (Date.now() >= deadlineMs) {
    if (upgrading && !inheritedAdmission.ownerFinished) {
      state.activeAdmissions++;
      inheritedAdmission.active = true;
    }
    return { acquired: false, reason: 'timeout' };
  }

  state.mutating = true;
  const drained = await waitUntilBefore(
    state.drainWaiters,
    () => state.activeAdmissions === 0,
    deadlineMs,
  );
  if (!drained || Date.now() >= deadlineMs) {
    if (upgrading && !inheritedAdmission.ownerFinished) {
      state.activeAdmissions++;
      inheritedAdmission.active = true;
    }
    state.mutating = false;
    wakeAll(state.openWaiters);
    return { acquired: false, reason: 'timeout' };
  }

  const mutationLease: MutationLease = { active: true };
  try {
    const next = new Map(mutationContext.getStore() ?? []);
    next.set(larkAppId, mutationLease);
    if (Date.now() >= deadlineMs) {
      return { acquired: false, reason: 'timeout' };
    }
    const value = await mutationContext.run(next, action);
    return { acquired: true, value };
  } finally {
    mutationLease.active = false;
    if (upgrading && !inheritedAdmission.ownerFinished) {
      state.activeAdmissions++;
      inheritedAdmission.active = true;
    }
    state.mutating = false;
    wakeAll(state.openWaiters);
  }
}

/**
 * Start an independent admission branch from fire-and-forget code. Normal
 * same-bot nesting is intentionally reentrant and MUST be awaited by its
 * caller; JavaScript cannot infer whether a returned Promise was floated.
 * Detached callers clear both contexts and acquire a fresh counted root lease.
 */
export function runDetachedBotTurnAdmission<T>(
  larkAppId: string,
  action: () => Promise<T> | T,
): Promise<T> {
  return admissionContext.run(new Map(), () =>
    mutationContext.run(new Map(), () => withBotTurnAdmission(larkAppId, action)));
}

/** Fire-and-forget counterpart for exclusive lifecycle mutations. A detached
 * mutation inside an admission waits for that admission to drain; one inside a
 * mutation waits for the parent mutation to reopen the gate. Do not await this
 * helper from the parent scope whose lease it must wait on. */
export function runDetachedBotTurnMutation<T>(
  larkAppId: string,
  action: () => Promise<T> | T,
): Promise<T> {
  return admissionContext.run(new Map(), () =>
    mutationContext.run(new Map(), () => withBotTurnMutation(larkAppId, action)));
}

export function __testOnly_resetBotTurnMutationGates(): void {
  gates.clear();
}
