/**
 * Daemon-side ownership of the model-fallback notice. The daemon — not the
 * worker — holds this state: it outlives every worker generation, while a
 * worker only ever sees a bounded tail of the transcript. Covered here:
 *
 *   - the merge rules that turn a worker's observation into state;
 *   - the state reaching the card through the usage snapshot (including for
 *     bots that hide usage — this is a warning, not a metric);
 *   - surviving a daemon restart via the same persisted-stream-card path as
 *     usageLimit.
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

const { getDaemonStreamingCardUsageSnapshot, mergeModelFallbackObservation } = await import('../src/core/worker-pool.js');
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

describe('mergeModelFallbackObservation', () => {
  it('(b) takes a switch record with a new uuid', () => {
    expect(mergeModelFallbackObservation(undefined, { fallback: FALLBACK }))
      .toEqual({ next: FALLBACK, changed: true });
    const second = { ...FALLBACK, uuid: 'u-second', fallbackModel: 'claude-sonnet-4-5' };
    expect(mergeModelFallbackObservation(FALLBACK, { fallback: second }))
      .toEqual({ next: second, changed: true });
  });

  it('(c) clears once a reply is served by a different model', () => {
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-fable-5-1' }))
      .toEqual({ next: undefined, changed: true });
  });

  it('(d) reports no change when the same record arrives again', () => {
    expect(mergeModelFallbackObservation(FALLBACK, { fallback: { ...FALLBACK } }))
      .toEqual({ next: FALLBACK, changed: false });
  });

  it('(e) reports no change for an observation carrying nothing', () => {
    expect(mergeModelFallbackObservation(FALLBACK, {}))
      .toEqual({ next: FALLBACK, changed: false });
    expect(mergeModelFallbackObservation(undefined, {}))
      .toEqual({ next: undefined, changed: false });
  });

  it('keeps the notice while the fallback model is still serving', () => {
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-opus-4-8' }))
      .toEqual({ next: FALLBACK, changed: false });
  });

  it('compares serving models across the [1m] context suffix', () => {
    // FALLBACK.fallbackModel is `claude-opus-4-8[1m]`; the assistant record
    // writes the bare id. Without normalisation every reply would look like a
    // switch back and the notice would vanish after one round.
    for (const servingModel of ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'CLAUDE-OPUS-4-8']) {
      expect(mergeModelFallbackObservation(FALLBACK, { servingModel }), servingModel)
        .toEqual({ next: FALLBACK, changed: false });
    }
  });

  it('applies the new record before judging the serving model in one message', () => {
    // The worker only ever attaches a servingModel it observed AFTER the record
    // in the same batch, so (b) then (c) is the correct order.
    const same = mergeModelFallbackObservation(undefined, {
      fallback: FALLBACK,
      servingModel: 'claude-opus-4-8',
    });
    expect(same).toEqual({ next: FALLBACK, changed: true });
    const switchedBack = mergeModelFallbackObservation(undefined, {
      fallback: FALLBACK,
      servingModel: 'claude-fable-5-1',
    });
    expect(switchedBack).toEqual({ next: undefined, changed: true });
  });

  it('never clears on a serving model when no record is held', () => {
    expect(mergeModelFallbackObservation(undefined, { servingModel: 'claude-fable-5-1' }))
      .toEqual({ next: undefined, changed: false });
  });

  it('holds the notice through anything short of a different serving model', () => {
    // The requirement in one test: the notice stays across rounds, and NOTHING
    // — an empty observation, a re-report of the same record, an unreadable
    // serving model — is allowed to drop it.
    let state = mergeModelFallbackObservation(undefined, { fallback: FALLBACK }).next;
    for (const msg of [
      {},
      { fallback: { ...FALLBACK } },
      { servingModel: 'claude-opus-4-8' },
      { servingModel: '   ' },
      {},
    ]) {
      state = mergeModelFallbackObservation(state, msg).next;
      expect(state).toEqual(FALLBACK);
    }
    expect(mergeModelFallbackObservation(state, { servingModel: 'claude-fable-5-1' }).next)
      .toBeUndefined();
  });
});
