import { describe, it, expect } from 'vitest';
import { createTmuxBootGate, TmuxCompetingServerBlockedError } from '../src/adapters/backend/tmux-anti-fork.js';
import type { BootDirective } from '../src/core/tmux-server-guard.js';

describe('createTmuxBootGate.leadingArgs', () => {
  it('reachable + tmux>=3.2 → ["-N"] (attach only, no fork)', () => {
    const gate = createTmuxBootGate('botmux', { resolve: () => ({ mode: 'spawn', noFork: true }) });
    expect(gate.leadingArgs()).toEqual(['-N']);
  });

  it('cold boot → [] (no -N, allowed to start the server)', () => {
    const gate = createTmuxBootGate(undefined, { resolve: () => ({ mode: 'spawn', noFork: false }) });
    expect(gate.leadingArgs()).toEqual([]);
  });

  it('tmux<3.2 reachable → [] (the old client rejects -N)', () => {
    const gate = createTmuxBootGate('botmux', { resolve: () => ({ mode: 'spawn', noFork: false }) });
    expect(gate.leadingArgs()).toEqual([]);
  });

  it('holds through silent-wait polls then returns [] once the listener is gone (cold)', () => {
    let t = 0;
    const dirs: BootDirective[] = [
      { mode: 'wait', reason: 'silent' },
      { mode: 'wait', reason: 'silent' },
      { mode: 'spawn', noFork: false },
    ];
    const gate = createTmuxBootGate('botmux', {
      budgetMs: 1000, pollMs: 100, sleep: ms => { t += ms; }, now: () => t,
      resolve: () => dirs.shift()!,
    });
    expect(gate.leadingArgs()).toEqual([]);
    expect(t).toBe(200);
  });

  it('after SIGUSR1 recreate-socket it re-probes and attaches with -N on recovery', () => {
    let t = 0;
    const dirs: BootDirective[] = [
      { mode: 'recreate-socket', pid: 4101 },
      { mode: 'spawn', noFork: true },
    ];
    const recreated: number[] = [];
    const gate = createTmuxBootGate('botmux', {
      budgetMs: 1000, pollMs: 50, sleep: ms => { t += ms; }, now: () => t,
      resolve: () => dirs.shift()!,
    });
    // recreate is performed inside resolveBootDirective in production; the gate
    // just loops. Assert it waited once then attached.
    expect(gate.leadingArgs()).toEqual(['-N']);
    expect(t).toBe(50);
    expect(recreated).toEqual([]);
  });

  it('throws transient ETIMEDOUT instead of forking when the owner stays silent', () => {
    let t = 0;
    const gate = createTmuxBootGate('botmux', {
      budgetMs: 300, pollMs: 100, sleep: ms => { t += ms; }, now: () => t,
      resolve: () => ({ mode: 'wait', reason: 'pid 4101 silent' }),
    });
    try {
      gate.leadingArgs();
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(TmuxCompetingServerBlockedError);
      expect(e.code).toBe('ETIMEDOUT'); // rides existing transient-startup retry
    }
  });
});
