/**
 * Element-level CardKit writes to one sent card, shared by every feature that
 * adds rows to a turn's last reply card after it was sent (the「下一步」row,
 * the「本轮回顾」panel).
 *
 * CardKit requires a strictly increasing sequence per card across ALL of its
 * element writes, whoever makes them. The footer receipt uses 1; a seconds
 * clock keeps later writes above it and increasing across daemon restarts,
 * and the in-memory floor separates writes within the same second. Writes to
 * one card also run one at a time, with the sequence taken inside that turn,
 * so a later-numbered write can never land first and get an earlier one
 * rejected as out of order.
 */
const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
const lastSequences = new Map<string, number>();
const LAST_SEQUENCES_MAX = 512;
const queues = new Map<string, Promise<unknown>>();

export function nextCardSequence(messageId: string, now: number): number {
  const clock = Math.max(2, Math.floor((now - SEQUENCE_EPOCH_MS) / 1000));
  const sequence = Math.max(clock, (lastSequences.get(messageId) ?? 0) + 1);
  lastSequences.delete(messageId);
  lastSequences.set(messageId, sequence);
  while (lastSequences.size > LAST_SEQUENCES_MAX) lastSequences.delete(lastSequences.keys().next().value!);
  return sequence;
}

/** Run `task` on `messageId` after every earlier one settled. A task that
 * reads the card before writing sees every earlier write in place. */
export function withCardWriteLock<T>(messageId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(messageId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const settled = run.catch(() => undefined);
  queues.set(messageId, settled);
  void settled.then(() => { if (queues.get(messageId) === settled) queues.delete(messageId); });
  return run;
}

/** Run one element write on `messageId` after every earlier one settled; the
 * write receives the sequence it must use. */
export function serializeCardWrite<T>(
  messageId: string,
  now: () => number,
  write: (sequence: number) => Promise<T>,
): Promise<T> {
  return withCardWriteLock(messageId, () => write(nextCardSequence(messageId, now())));
}
