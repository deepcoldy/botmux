export const LAZY_TOPIC_LINK_COOLDOWN_MS = 5 * 60_000;

export type LazyTopicLinkRow = {
  sessionId: string;
  larkAppId?: string;
  scope?: 'thread' | 'chat';
  rootMessageId?: string;
  feishuThreadLink?: string;
};

export function createLazyTopicLinkBackfill(deps: {
  resolve: (larkAppId: string, sessionId: string) => Promise<boolean>;
  now?: () => number;
  cooldownMs?: number;
  concurrency?: number;
}) {
  const inFlight = new Set<string>();
  const failedUntil = new Map<string, number>();
  const queue: LazyTopicLinkRow[] = [];
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? LAZY_TOPIC_LINK_COOLDOWN_MS;
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  let running = 0;

  const eligible = (row: unknown): row is LazyTopicLinkRow => !!row && typeof row === 'object'
    && typeof (row as LazyTopicLinkRow).sessionId === 'string'
    && (row as LazyTopicLinkRow).scope === 'thread'
    && !(row as LazyTopicLinkRow).feishuThreadLink
    && typeof (row as LazyTopicLinkRow).larkAppId === 'string' && (row as LazyTopicLinkRow).larkAppId!.length > 0
    && typeof (row as LazyTopicLinkRow).rootMessageId === 'string' && /^om_[A-Za-z0-9_-]+$/.test((row as LazyTopicLinkRow).rootMessageId!);

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const row = queue.shift()!;
      running += 1;
      void deps.resolve(row.larkAppId!, row.sessionId).then(ok => {
        if (!ok) failedUntil.set(row.sessionId, now() + cooldownMs);
      }).catch(() => {
        failedUntil.set(row.sessionId, now() + cooldownMs);
      }).finally(() => {
        inFlight.delete(row.sessionId);
        running -= 1;
        pump();
      });
    }
  }

  /** Starts background work and deliberately never waits for it. */
  function trigger(rows: readonly unknown[]): void {
    for (const row of rows) {
      if (!eligible(row) || inFlight.has(row.sessionId) || (failedUntil.get(row.sessionId) ?? 0) > now()) continue;
      inFlight.add(row.sessionId);
      queue.push(row);
    }
    pump();
  }

  return { trigger };
}
