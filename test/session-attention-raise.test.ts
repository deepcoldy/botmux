import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
  composeRowFromClosed: vi.fn(),
  composeRowFromPersistedActive: vi.fn(),
}));
vi.mock('../src/core/session-message-preview.js', () => ({ buildSessionMessagePreview: vi.fn(() => ({})) }));

import { raiseDaemonAttention } from '../src/core/session-activity.js';
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
});
