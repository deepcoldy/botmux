/**
 * Strict per-lane ingress admission.
 *
 * The legacy Lark anchor serializer deliberately lets a follower pass after a
 * five-second cap. That is correct for the legacy chat/thread path, but unsafe
 * while a principal lane is being materialized: a follower could overtake the
 * first message and create a second worktree/session. This queue has no timeout
 * escape. One failed operation does not poison its successor, and distinct
 * lane keys remain concurrent.
 *
 * This module only defines the admission boundary. The live event dispatcher
 * does not call it until the later principal-lane wiring commit.
 */

const admissionQueues = new Map<string, Promise<void>>();
const admissionAliases = new Map<string, string>();

function canonicalAdmissionKey(key: string): string {
  let current = key;
  const seen = new Set<string>();
  while (admissionAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = admissionAliases.get(current)!;
  }
  return current;
}

function encodedParts(parts: readonly string[]): string {
  // Length-prefixing avoids delimiter ambiguity without normalizing trusted
  // principal/routing identities. The same evidence always yields the exact
  // same key across concurrent handlers in this daemon.
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

/** Admission key for a lane that has already passed durable validation. */
export function principalLaneRuntimeAdmissionKey(input: {
  larkAppId: string;
  routingAnchor: string;
}): string {
  return `\u0000principal-lane:runtime:${encodedParts([
    input.larkAppId,
    input.routingAnchor,
  ])}`;
}

/** Deterministic pre-materialization key. Two first messages from the same
 * principal/source serialize before either can publish a lane; different
 * principals do not share this key. */
export function principalLanePendingAdmissionKey(input: {
  larkAppId: string;
  sourceSessionId: string;
  principalKey: string;
}): string {
  return `\u0000principal-lane:pending:${encodedParts([
    input.larkAppId,
    input.sourceSessionId,
    input.principalKey,
  ])}`;
}

/** Run one operation in strict FIFO order for its stable lane admission key. */
export async function withPrincipalLaneAdmission<T>(
  key: string,
  action: () => Promise<T> | T,
): Promise<T> {
  key = canonicalAdmissionKey(key);
  const previous = admissionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => { /* predecessor reports its own error */ }).then(() => hold);
  admissionQueues.set(key, tail);
  await previous.catch(() => { /* a failed turn must not poison the lane */ });
  try {
    return await action();
  } finally {
    release();
    if (admissionQueues.get(key) === tail) admissionQueues.delete(key);
  }
}

/** Join the post-publication runtime key to the deterministic pending queue.
 * The binding is installed before the materializing turn releases admission,
 * so a follower that already observes the durable lane cannot overtake it. */
export function bindPrincipalLaneAdmissionKeys(
  pendingKey: string,
  runtimeKey: string,
): void {
  const canonicalPending = canonicalAdmissionKey(pendingKey);
  const canonicalRuntime = canonicalAdmissionKey(runtimeKey);
  if (canonicalRuntime !== runtimeKey && canonicalRuntime !== canonicalPending) {
    throw new Error('principal-lane admission key is already bound to another queue');
  }
  admissionAliases.set(runtimeKey, canonicalPending);
}

/** True only when both observed keys currently resolve to the same FIFO. Live
 * ingress uses this after its in-lock authority re-read; a changed target must
 * release the old queue and re-enter the final one. */
export function samePrincipalLaneAdmissionQueue(left: string, right: string): boolean {
  return canonicalAdmissionKey(left) === canonicalAdmissionKey(right);
}

/** Run an ingress operation only under the queue selected by its latest
 * authority read. Returning another key releases the currently-held queue
 * before joining the new one, avoiding cross-lane lock inversion. */
export async function withRevalidatedPrincipalLaneAdmission(
  initialKey: string,
  action: (heldKey: string) => Promise<string | undefined>,
  maxRedirects = 3,
): Promise<void> {
  let heldKey = initialKey;
  for (let redirects = 0; redirects < maxRedirects; redirects += 1) {
    const nextKey = await withPrincipalLaneAdmission(heldKey, () => action(heldKey));
    if (!nextKey) return;
    heldKey = nextKey;
  }
  throw new Error('principal-lane admission target did not stabilize');
}

/** Test-only: clear all idle queues between cases. Active callers must settle
 * before invoking this helper. */
export function __resetPrincipalLaneAdmissions(): void {
  admissionQueues.clear();
  admissionAliases.clear();
}
