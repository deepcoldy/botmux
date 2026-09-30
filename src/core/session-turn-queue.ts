/**
 * Per-session turn serialization — the "turn" leg of the session terminal
 * state (docs/design/2026-08-12-session-restage-store-first.md §1, §3 Stage 3).
 *
 * JavaScript's single thread does not serialize a command that `await`s:
 * between a turn's arrival and its durable admission, another arrival or the
 * worker's ACK for the opening it is queued behind can run and observe a
 * half-applied session. `runSessionTurn` runs the commands aimed at one
 * `sessionId` one at a time, in the order they were enqueued, across their own
 * awaits. It is a Promise chain per session and nothing more: no mailbox type,
 * no actor object, and the chain is dropped as soon as it drains.
 *
 * What belongs on the queue is the section that must not interleave with other
 * commands on the same session — a follower's prompt build + tail admission,
 * the opening ACK's release of the route. A human-paced wait (a repo picker)
 * is session STATE, never a queued command: nothing may hold the queue while
 * waiting for a person.
 *
 * A command must not call `runSessionTurn` for its own session from inside
 * itself — it would wait on itself. Run the nested step inline instead.
 */

type Chain = { tail: Promise<void>; pending: number };

const chains = new Map<string, Chain>();

/** Run `command` once every command enqueued earlier for `sessionId` has
 *  settled. Resolves/rejects with the command's own outcome; a rejected
 *  predecessor never blocks later commands. */
export function runSessionTurn<T>(sessionId: string, command: () => T | Promise<T>): Promise<T> {
  const chain = chains.get(sessionId) ?? { tail: Promise.resolve(), pending: 0 };
  chain.pending += 1;
  chains.set(sessionId, chain);
  const run = chain.tail.then(command);
  const settle = (): void => {
    chain.pending -= 1;
    if (chain.pending === 0 && chains.get(sessionId) === chain) chains.delete(sessionId);
  };
  chain.tail = run.then(settle, settle);
  return run;
}

/** True while a command for `sessionId` is running or waiting to run. Ingress
 *  that must not overtake such a command (an ordinary live-worker turn arriving
 *  behind a follower still being built) checks this instead of keeping its own
 *  outstanding counter. */
export function hasPendingSessionTurns(sessionId: string): boolean {
  return (chains.get(sessionId)?.pending ?? 0) > 0;
}

export function __testOnly_resetSessionTurnQueues(): void {
  chains.clear();
}
