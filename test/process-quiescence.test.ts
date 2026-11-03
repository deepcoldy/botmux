import { describe, expect, it } from 'vitest';
import { waitForProcessQuiescence } from '../src/services/process-quiescence.js';

function fakeScheduler(goneAt: number | undefined) {
  let now = 0;
  const events: string[] = [];
  return {
    events,
    scheduler: {
      now: () => now,
      wait: async (ms: number) => { events.push(`wait:${ms}`); now += ms; },
      provablyGone: (_pid: number) => goneAt !== undefined && now >= goneAt,
    },
  };
}

describe('waitForProcessQuiescence', () => {
  it('does not release destructive maintenance until delayed process death is proven', async () => {
    const { scheduler, events } = fakeScheduler(150);
    await waitForProcessQuiescence(4242, scheduler, { timeoutMs: 500, pollMs: 25 });
    events.push('purge');
    expect(events.at(-1)).toBe('purge');
    expect(events.filter(e => e === 'wait:25')).toHaveLength(6);
  });

  it('waits for delayed descendant writers after the root process exits', async () => {
    let now = 0;
    const events: string[] = [];
    await waitForProcessQuiescence(100, {
      now: () => now,
      wait: async ms => { events.push(`wait:${ms}`); now += ms; },
      provablyGone: pid => pid === 100 ? now >= 25 : now >= 150,
    }, { timeoutMs: 500, pollMs: 25, ownedPids: [100, 101, 102] });
    events.push('purge');
    expect(events.at(-1)).toBe('purge');
    expect(events.filter(e => e === 'wait:25')).toHaveLength(6);
  });

  it('fails closed on timeout instead of permitting an active-writer purge', async () => {
    const { scheduler, events } = fakeScheduler(undefined);
    await expect(waitForProcessQuiescence(4242, scheduler, {
      timeoutMs: 100,
      pollMs: 25,
    })).rejects.toThrow('did not exit before purge');
    expect(events).toHaveLength(4);
  });

  it('requires a positive pid identity', async () => {
    const { scheduler } = fakeScheduler(0);
    await expect(waitForProcessQuiescence(undefined, scheduler)).rejects.toThrow('valid pid');
  });
});
