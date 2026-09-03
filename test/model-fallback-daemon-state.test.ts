/**
 * Daemon-side plumbing for the model-fallback notice: the state has to reach
 * the card through the usage snapshot (including for bots that hide usage —
 * this is a warning, not a metric), and it has to survive a daemon restart via
 * the same persisted-stream-card path as usageLimit.
 *
 * Run: npx vitest run --project unit test/model-fallback-daemon-state.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { ModelFallbackState } from '../src/types.js';

const usageDisplay = vi.hoisted(() => ({ mode: 'streaming' as string }));
const updateSession = vi.hoisted(() => vi.fn());

vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/bot-registry.js')>()),
  resolveUsageDisplay: () => usageDisplay.mode,
}));
vi.mock('../src/services/session-store.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/session-store.js')>()),
  updateSession,
}));

const { getDaemonStreamingCardUsageSnapshot } = await import('../src/core/worker-pool.js');
const { persistStreamCardState } = await import('../src/core/session-manager.js');

const FALLBACK: ModelFallbackState = {
  uuid: 'u-refusal',
  kind: 'refusal',
  originalModel: 'claude-fable-5-1[1m]',
  fallbackModel: 'claude-opus-4-8[1m]',
  apiRefusalCategory: 'cyber',
};

function makeSession(modelFallback?: ModelFallbackState): DaemonSession {
  return {
    larkAppId: 'cli_test',
    modelFallback,
    session: { sessionId: 'sess-mfb', model: 'claude-fable-5-1' },
  } as unknown as DaemonSession;
}

beforeEach(() => {
  usageDisplay.mode = 'streaming';
  updateSession.mockClear();
});

describe('getDaemonStreamingCardUsageSnapshot: model fallback', () => {
  it('carries the fallback into the streaming snapshot', () => {
    expect(getDaemonStreamingCardUsageSnapshot(makeSession(FALLBACK)).modelFallback)
      .toEqual(FALLBACK);
  });

  it('still carries it for bots that do not display usage on the card', () => {
    for (const mode of ['off', 'footer']) {
      usageDisplay.mode = mode;
      const snapshot = getDaemonStreamingCardUsageSnapshot(makeSession(FALLBACK));
      expect(snapshot.context, mode).toBeNull();
      expect(snapshot.modelFallback, mode).toEqual(FALLBACK);
    }
  });

  it('omits the key entirely when there is no fallback', () => {
    for (const mode of ['streaming', 'off']) {
      usageDisplay.mode = mode;
      expect(getDaemonStreamingCardUsageSnapshot(makeSession()), mode)
        .not.toHaveProperty('modelFallback');
    }
  });
});

describe('persistStreamCardState: model fallback', () => {
  it('mirrors the fallback onto the persisted Session', () => {
    const ds = makeSession(FALLBACK);
    persistStreamCardState(ds);
    expect(ds.session.modelFallback).toEqual(FALLBACK);
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite the store when the same fallback is re-persisted', () => {
    const ds = makeSession(FALLBACK);
    persistStreamCardState(ds);
    updateSession.mockClear();
    persistStreamCardState(ds);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('clears the persisted fallback once the user switched back', () => {
    const ds = makeSession(FALLBACK);
    persistStreamCardState(ds);
    ds.modelFallback = undefined;
    updateSession.mockClear();
    persistStreamCardState(ds);
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(ds.session.modelFallback).toBeUndefined();
  });

  it('rewrites the store when a different fallback replaces the current one', () => {
    const ds = makeSession(FALLBACK);
    persistStreamCardState(ds);
    updateSession.mockClear();
    ds.modelFallback = { ...FALLBACK, uuid: 'u-second' };
    persistStreamCardState(ds);
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(ds.session.modelFallback?.uuid).toBe('u-second');
  });
});
