import { AsyncSerialQueue } from '../utils/async-serial-queue.js';

export interface AdoptQueuedWriteSequence<T> {
  queue: AsyncSerialQueue;
  /** Rechecked at the actual dequeue/execution point, not at IPC receipt. */
  isCurrent: () => boolean;
  write: () => Promise<T>;
  /** Requeue the exact untouched input when its captured backend generation
   *  became stale before the task ever started writing. */
  onStale: () => void | Promise<void>;
}

export type AdoptQueuedWriteResult<T> =
  | { status: 'ran'; value: T }
  | { status: 'stale-before-write' };

/** Fence a process-lifetime serial queue task to the backend generation that
 * accepted it. AsyncSerialQueue intentionally survives CLI restarts; without
 * this dequeue-time check an old task can mark with backend=null or write into
 * a replacement CLI before its prompt is ready. */
export function runAdoptQueuedWriteSequence<T>(
  input: AdoptQueuedWriteSequence<T>,
): Promise<AdoptQueuedWriteResult<T>> {
  return input.queue.run(async () => {
    if (!input.isCurrent()) {
      await input.onStale();
      return { status: 'stale-before-write' };
    }
    return { status: 'ran', value: await input.write() };
  });
}

export interface AdoptRawInputSequence {
  queue: AsyncSerialQueue;
  /** Resolves true only after the literal command's submit key has landed. */
  writeRawInput: () => Promise<boolean>;
  /** Resolves only after the bundled follow-up's complete adapter lifecycle. */
  writeFollowUp?: () => Promise<void>;
  /** Same generation/backend fence used by ordinary adopt writes. */
  isCurrent?: () => boolean;
  onStaleBeforeWrite?: () => void | Promise<void>;
  onStaleBeforeFollowUp?: () => void | Promise<void>;
}

/**
 * Keep an adopt slash command and its bundled follow-up in one serial-queue
 * transaction. The follow-up callback must cover the complete adapter write,
 * history verification and lifecycle settlement; awaiting it here prevents a
 * later process-message listener from sharing or overwriting the TUI composer.
 */
export function runAdoptRawInputSequence(input: AdoptRawInputSequence): Promise<void> {
  return input.queue.run(async () => {
    if (input.isCurrent && !input.isCurrent()) {
      await input.onStaleBeforeWrite?.();
      return;
    }
    const rawInputSent = await input.writeRawInput();
    if (!rawInputSent) return;
    if (input.writeFollowUp) {
      if (input.isCurrent && !input.isCurrent()) {
        await input.onStaleBeforeFollowUp?.();
        return;
      }
      await input.writeFollowUp();
    }
  });
}

export interface AdoptSessionRenameSequence {
  queue: AsyncSerialQueue;
  /** Rechecked after every earlier adopt composer write has settled. */
  isPromptReady: () => boolean;
  /** Resolves only after the rename command's literal text and Enter land. */
  writeRename: () => Promise<void>;
}

/** Serialize native rename with every adopt composer write. A readiness check
 *  made before waiting on the queue can become stale when an earlier adopt
 *  message starts first, so recheck inside the queue and let the worker retry
 *  the rename at the next genuine prompt instead of steering it into a turn. */
export function runAdoptSessionRenameSequence(input: AdoptSessionRenameSequence): Promise<boolean> {
  return input.queue.run(async () => {
    if (!input.isPromptReady()) return false;
    await input.writeRename();
    return true;
  });
}
