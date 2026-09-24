import { describe, expect, it, vi } from 'vitest';
import { createLazyTopicLinkBackfill } from '../src/dashboard/lazy-topic-link-backfill.js';

const row = (sessionId: string, patch: Record<string, unknown> = {}) => ({
  sessionId,
  larkAppId: 'cli_owner',
  scope: 'thread' as const,
  rootMessageId: `om_${sessionId}`,
  ...patch,
});

describe('lazy native topic link backfill', () => {
  it('filters ineligible rows and routes eligible work by owning app id', async () => {
    const resolve = vi.fn(async () => true);
    const backfill = createLazyTopicLinkBackfill({ resolve });
    backfill.trigger([
      row('good'),
      row('chat', { scope: 'chat' }),
      row('known', { feishuThreadLink: 'https://topic' }),
      row('bad-root', { rootMessageId: 'cm_bad' }),
    ]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(resolve).toHaveBeenCalledWith('cli_owner', 'good');
  });

  it('does not block callers, deduplicates overlapping refreshes, and observes the concurrency cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const resolve = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return true;
    });
    const backfill = createLazyTopicLinkBackfill({ resolve, concurrency: 2 });
    expect(backfill.trigger([row('one'), row('two'), row('three')])).toBeUndefined();
    backfill.trigger([row('one'), row('two')]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);
    release();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
  });

  it('applies a cooldown after failed resolution', async () => {
    let now = 1_000;
    const resolve = vi.fn(async () => false);
    const backfill = createLazyTopicLinkBackfill({ resolve, now: () => now, cooldownMs: 100 });
    backfill.trigger([row('one')]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    backfill.trigger([row('one')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resolve).toHaveBeenCalledTimes(1);
    now += 101;
    backfill.trigger([row('one')]);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  });
});
