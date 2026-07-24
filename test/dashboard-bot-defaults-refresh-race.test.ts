import { describe, it, expect } from 'vitest';
import { createRefreshGate } from '../src/dashboard/web/bot-defaults.js';

// Deferred promise helper: lets the test resolve two overlapping "requests"
// in an arbitrary order to reproduce 后发先回 (a slow earlier request that
// returns AFTER a newer one).
function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('createRefreshGate (bot-defaults latest-wins)', () => {
  it('lets a single request commit', async () => {
    const gate = createRefreshGate();
    const req = gate.begin();
    expect(req.commit()).toBe(true);
  });

  it('invalidates an earlier request once a newer one begins', () => {
    const gate = createRefreshGate();
    const first = gate.begin();
    const second = gate.begin();
    // second is now newest — first must no longer commit, second may.
    expect(first.commit()).toBe(false);
    expect(second.commit()).toBe(true);
  });

  it('drops the stale (后发先回) response and keeps the newest roster', async () => {
    const gate = createRefreshGate();

    // Request A = initial mount refresh (returns the OLD single-bot roster).
    // Request B = bots.changed refresh (returns the NEW two-bot roster).
    const aResp = defer<string[]>();
    const bResp = defer<string[]>();

    let committed: string[] | null = null;
    const runA = (async () => {
      const req = gate.begin();
      const roster = await aResp.promise;
      if (req.commit()) committed = roster;
    })();
    const runB = (async () => {
      const req = gate.begin();
      const roster = await bResp.promise;
      if (req.commit()) committed = roster;
    })();

    // Newest (B) returns FIRST with the fresh roster and commits.
    bResp.resolve(['botA', 'botB']);
    await runB;
    expect(committed).toEqual(['botA', 'botB']);

    // Stale (A) returns LATE with the old roster — must be dropped, not clobber.
    aResp.resolve(['botA']);
    await runA;
    expect(committed).toEqual(['botA', 'botB']);
  });

  it('commit() re-checks live, so a request invalidated mid-flight cannot flip loading off', () => {
    const gate = createRefreshGate();
    const first = gate.begin();
    expect(first.commit()).toBe(true); // still newest before B starts
    gate.begin();                      // B begins → first is now stale
    expect(first.commit()).toBe(false); // both the state write AND loading gate see false
  });
});
