import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
  composeRowFromClosed: vi.fn(),
  composeRowFromPersistedActive: vi.fn(),
}));
vi.mock('../src/core/session-message-preview.js', () => ({ buildSessionMessagePreview: vi.fn(() => ({})) }));

import { raiseDaemonAttention } from '../src/core/session-activity.js';
import { deriveSessionTaskStatus } from '../src/core/session-task-status.js';
import { noteTurnStarted } from '../src/core/turn-outcome.js';
import type { DaemonSession } from '../src/core/types.js';

const T0 = 1_800_000_000_000;

function makeDs(agentAttention?: DaemonSession['agentAttention']): DaemonSession {
  return { session: { sessionId: 's1' }, agentAttention } as unknown as DaemonSession;
}

describe('raiseDaemonAttention', () => {
  it('a delivery retry with the same reason is not a new raise', () => {
    const ds = makeDs();
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0)).toBe(true);
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(false);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 });
  });

  it('a different reason while the daemon hand is still up keeps the original time', () => {
    const ds = makeDs({ kind: 'blocked', reason: 'topic send blocked', at: T0 });
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 });
  });

  it('an agent request is replaced and the daemon raise gets its own time', () => {
    const ds = makeDs({ kind: 'decision', reason: '选方案', at: T0, source: 'agent' });
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 5_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 + 5_000 });
  });

  it('retries inside the turn that raised keep the first time', () => {
    const ds = makeDs();
    noteTurnStarted(ds, 't1', T0);
    raiseDaemonAttention(ds, 'blocked', 'topic send blocked', T0 + 30_000);
    expect(raiseDaemonAttention(ds, 'blocked', 'topic send blocked', T0 + 35_000)).toBe(false);
    expect(raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 40_000)).toBe(true);
    expect(ds.agentAttention).toEqual({ kind: 'blocked', reason: 'final delivery failed', at: T0 + 30_000 });
  });

  it.each([
    ['the same reason', 'final delivery failed'],
    ['a different reason', 'topic send blocked'],
  ])('a failure in a later turn with %s is a new raise the board still shows', (_label, secondReason) => {
    // Bot-only group: nobody replies, so the first raise is never cleared.
    const ds = makeDs();
    noteTurnStarted(ds, 't1', T0);
    raiseDaemonAttention(ds, 'blocked', 'final delivery failed', T0 + 30_000);
    noteTurnStarted(ds, 't2', T0 + 600_000);
    expect(raiseDaemonAttention(ds, 'blocked', secondReason, T0 + 630_000)).toBe(true);
    expect(ds.agentAttention?.at).toBe(T0 + 630_000);
    const status = deriveSessionTaskStatus({
      status: 'idle',
      agentAttention: ds.agentAttention,
      lastMessageAt: T0 + 600_000,
      lastTurn: { turnId: 't2', outcome: 'no_output', at: T0 + 660_000, startedAt: T0 + 600_000 },
    }, T0 + 660_000);
    expect(status).toMatchObject({ kind: 'needs_you', reason: 'interrupted', detail: secondReason });
  });
});
