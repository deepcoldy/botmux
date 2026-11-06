import type { DaemonSession } from './types.js';

// Cosmetic ordering only. A worker never waits for this promise. Include a
// predecessor POST: its completion may synchronously start the next turn's
// pending card, and thinking must not jump ahead of that follow-up POST.
const posts = new WeakMap<DaemonSession, Set<Promise<void>>>();

export function trackStartingCardPublication<T>(ds: DaemonSession, post: Promise<T>): Promise<T> {
  const pending = posts.get(ds) ?? new Set<Promise<void>>();
  posts.set(ds, pending);
  const settled = post.then(() => {}, () => {});
  pending.add(settled);
  void settled.then(() => {
    pending.delete(settled);
    if (!pending.size && posts.get(ds) === pending) posts.delete(ds);
  });
  return post;
}

/** No extra microtask for sessions with no starting card. Disabled cards and
 * non-Lark sessions retain their existing independent thinking policy. */
export function pendingStartingCardPublication(ds: DaemonSession): Promise<void> | undefined {
  if (!posts.get(ds)?.size) return undefined;
  return (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (posts.get(ds)?.size) await Promise.all([...posts.get(ds)!]);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('starting card publication timed out')), 15_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
}
