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
import { ClaudeModelFallbackTracker, type TranscriptEvent } from '../src/services/claude-transcript.js';

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

const SID = 'a9bc732e-0000-0000-0000-000000000000';
const OTHER_SID = 'b0000000-1111-1111-1111-111111111111';

const FALLBACK: ModelFallbackState = {
  uuid: 'u-refusal',
  kind: 'refusal',
  originalModel: 'claude-fable-5-1[1m]',
  fallbackModel: 'claude-opus-4-8[1m]',
  apiRefusalCategory: 'cyber',
};

/** The same record as it looks once bound to a Claude session. */
const BOUND: ModelFallbackState = { ...FALLBACK, claudeSessionId: SID };

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

  it('P1-4: the usage line shows the serving model, not the launch config', () => {
    // Claude never emits `active_runtime`, so ds.activeModel used to stay empty
    // and the usage line rendered ds.session.model (`claude-fable-5-1`) even
    // while a fallback was answering. The model_fallback handler now writes the
    // observed serving model there; this is the half the user actually sees.
    const ds = makeSession(BOUND);
    expect(getDaemonStreamingCardUsageSnapshot(ds).model).toBe('claude-fable-5-1');
    ds.activeModel = 'claude-opus-4-8';
    expect(getDaemonStreamingCardUsageSnapshot(ds).model).toBe('claude-opus-4-8');
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

  it('P1-3: rewrites the store when only the Claude session changed', () => {
    // Same record, different conversation (and the pre-binding upgrade path,
    // where the id is stamped onto state that had none). Comparing uuids alone
    // would leave the persisted mirror unbound forever.
    const ds = makeSession(FALLBACK);
    persistStreamCardState(ds);
    updateSession.mockClear();
    ds.modelFallback = BOUND;
    persistStreamCardState(ds);
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(ds.session.modelFallback?.claudeSessionId).toBe(SID);
  });

  it('P1-3: persists the Claude session id so it survives a daemon restart', () => {
    const ds = makeSession(BOUND);
    persistStreamCardState(ds);
    expect(ds.session.modelFallback).toEqual(BOUND);
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

  it('F1: keeps the notice when the serving model drifts to a THIRD non-Fable model', () => {
    // Real transcript (be6da26c): fable-5 → opus-5 fallback, then across a
    // resume the session silently drifted opus-5 → opus-4-8 with NO new switch
    // record. The session is still off Fable, so "serving differs from the
    // fallback model" must NOT clear — only a Fable serving model does.
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-opus-5' }))
      .toEqual({ next: FALLBACK, changed: false });
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-sonnet-4-5' }))
      .toEqual({ next: FALLBACK, changed: false });
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-haiku-4-5' }))
      .toEqual({ next: FALLBACK, changed: false });
  });

  it('F1: clears once the serving model is back on a (different) Fable variant', () => {
    // A manual /model onto another Fable variant still ends the fall-off-Fable
    // condition, so the notice clears — not only on the exact original model.
    expect(mergeModelFallbackObservation(FALLBACK, { servingModel: 'claude-fable-5' }))
      .toEqual({ next: undefined, changed: true });
  });

  it('F1: the full tracker→merge pipeline keeps the notice through a third-model drift', () => {
    // Mirrors the real be6da26c transcript: one fable→opus switch, then the
    // session silently drifts onto another non-Fable model with no new record.
    const tracker = new ClaudeModelFallbackTracker();
    tracker.bind(SID);
    const switchEvent: TranscriptEvent = {
      type: 'system', subtype: 'model_consent_fallback', uuid: 'u-drift',
      sessionId: SID, originalModel: 'claude-fable-5[1m]', fallbackModel: 'claude-opus-5[1m]',
      timestamp: '2026-08-16T10:44:00.126Z',
    };
    const reply = (model: string, uuid: string): TranscriptEvent => ({
      type: 'assistant', uuid,
      message: { role: 'assistant', model, content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' },
    });
    let state: ModelFallbackState | undefined;
    // Batch 1: the switch plus the first fallback-model reply.
    const obs1 = tracker.observe([switchEvent, reply('claude-opus-5', 'a1')]);
    if (obs1) state = mergeModelFallbackObservation(state, { ...obs1, claudeSessionId: SID }).next;
    expect(state?.uuid).toBe('u-drift');
    // Batch 2: the silent drift onto a THIRD non-Fable model.
    const obs2 = tracker.observe([reply('claude-opus-4-8', 'a2')]);
    if (obs2) state = mergeModelFallbackObservation(state, { ...obs2, claudeSessionId: SID }).next;
    expect(state?.uuid, 'notice survives the third-model drift').toBe('u-drift');
    // Batch 3: the user switches back to Fable — only now does it clear.
    const obs3 = tracker.observe([reply('claude-fable-5', 'a3')]);
    if (obs3) state = mergeModelFallbackObservation(state, { ...obs3, claudeSessionId: SID }).next;
    expect(state).toBeUndefined();
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
    const switchedBack = mergeModelFallbackObservation(FALLBACK, {
      fallback: { ...FALLBACK, uuid: 'u-second', fallbackModel: 'claude-sonnet-4-5' },
      servingModel: 'claude-fable-5-1',
    });
    expect(switchedBack).toEqual({ next: undefined, changed: true });
  });

  it('reports no change when both rules fire but the state lands where it began', () => {
    // Cold start on a session the user already switched back: the tail scan
    // finds the record AND a newer reply on another model, so (b) then (c) run
    // and we end on "no notice" — exactly what we held. Reporting `changed`
    // here would cost a wasted card patch on every worker start.
    expect(mergeModelFallbackObservation(undefined, {
      fallback: FALLBACK,
      servingModel: 'claude-fable-5-1',
    })).toEqual({ next: undefined, changed: false });
  });

  it('never clears on a serving model when no record is held', () => {
    expect(mergeModelFallbackObservation(undefined, { servingModel: 'claude-fable-5-1' }))
      .toEqual({ next: undefined, changed: false });
  });

  describe('P1-3: state is bound to one Claude session', () => {
    it('stamps the incoming record with the message Claude session', () => {
      expect(mergeModelFallbackObservation(undefined, {
        claudeSessionId: SID,
        fallback: FALLBACK,
      })).toEqual({ next: BOUND, changed: true });
    });

    it('drops state from another Claude session before anything else', () => {
      // /repo, /adopt and a resume onto another native session all replace the
      // Claude conversation. Carrying the old record across shows a warning
      // about a conversation the user has left.
      expect(mergeModelFallbackObservation(BOUND, { claudeSessionId: OTHER_SID }))
        .toEqual({ next: undefined, changed: true });
    });

    it('drops it even when the empty message carries no evidence at all', () => {
      // The mandatory seed after a rebind is usually empty — that IS the
      // evidence: "the bridge is on a different conversation now".
      const merged = mergeModelFallbackObservation(BOUND, { claudeSessionId: OTHER_SID });
      expect(merged.next).toBeUndefined();
      expect(merged.changed).toBe(true);
    });

    it('leaves the state alone for an empty message on the SAME session', () => {
      // A plain worker restart re-seeds and finds nothing; that must not clear.
      expect(mergeModelFallbackObservation(BOUND, { claudeSessionId: SID }))
        .toEqual({ next: BOUND, changed: false });
    });

    it('replaces old-session state with the record in the same message', () => {
      // A→B→resume A: the seed for A carries both the session id and the record
      // its tail scan recovered.
      const other = { ...FALLBACK, uuid: 'u-other', claudeSessionId: OTHER_SID };
      expect(mergeModelFallbackObservation(other, {
        claudeSessionId: SID,
        fallback: FALLBACK,
      })).toEqual({ next: BOUND, changed: true });
    });

    it('does not clear on a serving model from a different session', () => {
      // Rule (a) runs first, so the stale record is gone before rule (c) could
      // read a foreign session reply as a switch back.
      expect(mergeModelFallbackObservation(BOUND, {
        claudeSessionId: OTHER_SID,
        servingModel: 'claude-opus-4-8',
      })).toEqual({ next: undefined, changed: true });
    });

    it('stamps the session onto pre-binding state and persists that once', () => {
      // Upgrade path: state persisted before the binding existed carries no
      // session id, so it cannot be shown to belong here — but the same
      // message's own record re-establishes it, and `changed` must report the
      // stamping so the mirror on disk is rewritten.
      const merged = mergeModelFallbackObservation(FALLBACK, {
        claudeSessionId: SID,
        fallback: FALLBACK,
      });
      expect(merged).toEqual({ next: BOUND, changed: true });
    });
  });

  describe('P2-2: fallback:null is positive "no notice" evidence', () => {
    it('clears the held record', () => {
      expect(mergeModelFallbackObservation(BOUND, { claudeSessionId: SID, fallback: null }))
        .toEqual({ next: undefined, changed: true });
    });

    it('costs nothing when there is no notice to clear', () => {
      expect(mergeModelFallbackObservation(undefined, { claudeSessionId: SID, fallback: null }))
        .toEqual({ next: undefined, changed: false });
    });

    it('is not the same as an absent fallback, which changes nothing', () => {
      expect(mergeModelFallbackObservation(BOUND, { claudeSessionId: SID, fallback: undefined }))
        .toEqual({ next: BOUND, changed: false });
    });
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
