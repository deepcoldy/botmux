import { AsyncLocalStorage } from 'node:async_hooks';

interface MessageReadContext {
  active: number;
  concurrency: number;
  waiting: Array<() => void>;
  reads: Map<string, Promise<unknown>>;
  settled: Set<string>;
}

const contexts = new AsyncLocalStorage<MessageReadContext>();

/** One CLI invocation is one read snapshot. No cache survives the invocation. */
export function withMessageReadContext<T>(work: () => Promise<T>, concurrency = 4): Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid message read concurrency');
  return contexts.run({ active: 0, concurrency, waiting: [], reads: new Map(), settled: new Set() }, work);
}

async function limited<T>(context: MessageReadContext, read: () => Promise<T>): Promise<T> {
  if (context.active >= context.concurrency) await new Promise<void>(resolve => context.waiting.push(resolve));
  else context.active++;
  try { return await read(); }
  finally {
    const next = context.waiting.shift();
    if (next) next(); // Transfer the occupied slot to the waiter.
    else context.active--;
  }
}

/** The key includes the app and representation. Abortable reads are not cached. */
export async function readMessageWithinContext<T>(key: string | undefined, read: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context) return read();
  let pending = key === undefined ? undefined : context.reads.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = limited(context, read);
    if (key !== undefined) {
      context.reads.set(key, pending);
      const current = pending;
      void pending.then(() => {
        context.settled.add(key);
        // Bound retained successes, without evicting an in-flight request.
        for (const settled of context.settled) {
          if (context.reads.size <= 128) break;
          context.reads.delete(settled);
          context.settled.delete(settled);
        }
      }, () => {
        if (context.reads.get(key) === current) context.reads.delete(key);
      });
    }
  }
  // Forward expansion mutates message bodies; every consumer gets its own copy.
  return structuredClone(await pending);
}
