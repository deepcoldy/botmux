/**
 * Claude Code writes a `type:"system"` record whenever it automatically
 * switches the session model. These tests cover the parse (every session-scoped
 * record, with the product's "Fable originals only" scope carried as a flag),
 * the bridge tracker's Claude-session binding / dedupe / local-scope /
 * serving-model reporting, and the cold-start tail scan.
 *
 * The tracker reports OBSERVED FACTS only — it never decides whether the
 * notice should still show. That decision lives in the daemon
 * (mergeModelFallbackObservation, covered in model-fallback-daemon-state).
 *
 * Run: npx vitest run --project unit test/claude-model-fallback-transcript.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeModelFallbackTracker,
  isFableModelId,
  modelFallbackStateOf,
  normalizeClaudeModelId,
  parseClaudeModelFallbackEvent,
  readLatestClaudeModelFallback,
  servingModelFromAssistantEvent,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-mfb-'));
  path = join(dir, 'session.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appendLine(obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
}

/** Verbatim shape of a real Claude Code refusal-fallback record. */
const REFUSAL_RECORD = {
  type: 'system',
  subtype: 'model_refusal_fallback',
  content: "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8 (1M context).",
  level: 'warning',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  originalModel: 'claude-fable-5-1[1m]',
  fallbackModel: 'claude-opus-4-8[1m]',
  apiRefusalCategory: 'cyber',
  uuid: '0b5864a0-1111-2222-3333-444444444444',
  timestamp: '2026-09-02T09:23:37.007Z',
  sessionId: 'a9bc732e-0000-0000-0000-000000000000',
};

/** The Claude session id the tracker binds to in these tests (the jsonl's
 *  basename in production; any stable string here). */
const SID = 'a9bc732e-0000-0000-0000-000000000000';
const OTHER_SID = 'b0000000-1111-1111-1111-111111111111';

function assistant(model: string, extra: Record<string, unknown> = {}): TranscriptEvent {
  return {
    type: 'assistant',
    uuid: `a-${model}-${Math.random().toString(36).slice(2)}`,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] },
    ...extra,
  } as TranscriptEvent;
}

describe('isFableModelId', () => {
  it('accepts Fable ids whatever the case or context suffix', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5-1[1m]',
      'claude-fable-5[1m]',
      'CLAUDE-Fable-5-1[1M]',
      '  claude-fable-5-1  ',
    ]) {
      expect(isFableModelId(id), id).toBe(true);
    }
  });

  it('rejects every non-Fable id, including the empty ones', () => {
    for (const id of [
      'claude-opus-5',
      'claude-opus-5[1m]',
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'fable-5-1',
      '',
      '   ',
      undefined,
    ]) {
      expect(isFableModelId(id), String(id)).toBe(false);
    }
  });
});

describe('parseClaudeModelFallbackEvent', () => {
  it('parses a real refusal-fallback record', () => {
    expect(parseClaudeModelFallbackEvent(REFUSAL_RECORD as TranscriptEvent)).toEqual({
      uuid: REFUSAL_RECORD.uuid,
      kind: 'refusal',
      originalModel: 'claude-fable-5-1[1m]',
      fallbackModel: 'claude-opus-4-8[1m]',
      scope: 'session',
      fable: true,
      neutralizedByFork: false,
      trigger: 'refusal',
      apiRefusalCategory: 'cyber',
      observedAt: REFUSAL_RECORD.timestamp,
    });
  });

  it('maps all three subtypes to a kind', () => {
    const kinds = (['model_refusal_fallback', 'model_fallback', 'model_consent_fallback'] as const)
      .map(subtype => parseClaudeModelFallbackEvent({
        ...REFUSAL_RECORD,
        subtype,
      } as TranscriptEvent)?.kind);
    expect(kinds).toEqual(['refusal', 'unavailable', 'consent']);
  });

  it('keeps the raw trigger of a model_fallback record', () => {
    const rec = parseClaudeModelFallbackEvent({
      type: 'system',
      subtype: 'model_fallback',
      trigger: 'overloaded',
      originalModel: 'claude-fable-5-1[1m]',
      fallbackModel: 'claude-opus-4-8[1m]',
      uuid: 'u-overloaded',
    } as TranscriptEvent);
    expect(rec).toMatchObject({ kind: 'unavailable', trigger: 'overloaded', scope: 'session' });
  });

  it('reads a record with no scope field (older Claude Code) as session scope', () => {
    const { scope, ...withoutScope } = REFUSAL_RECORD;
    expect(scope).toBe('session');
    expect(parseClaudeModelFallbackEvent(withoutScope as TranscriptEvent)?.scope).toBe('session');
  });

  it('marks a sub-agent fallback as local scope', () => {
    expect(parseClaudeModelFallbackEvent({
      ...REFUSAL_RECORD,
      scope: 'local',
    } as TranscriptEvent)?.scope).toBe('local');
  });

  it('rejects a record missing the uuid or either model id (fail-closed)', () => {
    for (const missing of ['uuid', 'originalModel', 'fallbackModel'] as const) {
      const partial: any = { ...REFUSAL_RECORD };
      delete partial[missing];
      expect(parseClaudeModelFallbackEvent(partial as TranscriptEvent)).toBeUndefined();
    }
  });

  it('ignores non-fallback events', () => {
    expect(parseClaudeModelFallbackEvent(assistant('claude-opus-5'))).toBeUndefined();
    expect(parseClaudeModelFallbackEvent({ type: 'user', uuid: 'u1' } as TranscriptEvent)).toBeUndefined();
    expect(parseClaudeModelFallbackEvent({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'u2',
    } as TranscriptEvent)).toBeUndefined();
  });

  describe('Fable gate (product scope)', () => {
    it('P2-2: parses a non-Fable switch, flagged fable:false rather than dropped', () => {
      // Opus 5 → Opus 4.8 is a routine safety downgrade; surfacing it would put
      // a warning on sessions that never asked for Fable. But DROPPING it at
      // parse time let the backward tail scan walk straight past it and
      // resurrect an older Fable record — a notice the session had already left
      // behind. The record must survive the parse so it can stop the scan.
      for (const originalModel of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-4-5']) {
        expect(parseClaudeModelFallbackEvent({
          ...REFUSAL_RECORD,
          originalModel,
        } as TranscriptEvent), originalModel).toMatchObject({
          uuid: REFUSAL_RECORD.uuid,
          scope: 'session',
          fable: false,
        });
      }
    });

    it('accepts every Fable spelling', () => {
      for (const originalModel of ['claude-fable-5[1m]', 'claude-fable-5-1', 'Claude-Fable-5-1[1M]']) {
        const rec = parseClaudeModelFallbackEvent({
          ...REFUSAL_RECORD,
          originalModel,
        } as TranscriptEvent);
        expect(rec?.originalModel, originalModel).toBe(originalModel);
        expect(rec?.fable, originalModel).toBe(true);
      }
    });
  });

  describe('P2-2: neutralizedByFork', () => {
    it('flags a record a fork copied over', () => {
      expect(parseClaudeModelFallbackEvent({
        ...REFUSAL_RECORD,
        neutralizedByFork: true,
      } as TranscriptEvent)).toMatchObject({ fable: true, neutralizedByFork: true });
    });

    it('reads a missing flag as not neutralised', () => {
      expect(parseClaudeModelFallbackEvent(REFUSAL_RECORD as TranscriptEvent)?.neutralizedByFork)
        .toBe(false);
    });
  });
});

describe('modelFallbackStateOf', () => {
  it('drops the transcript-only parse bookkeeping', () => {
    const rec = parseClaudeModelFallbackEvent(REFUSAL_RECORD as TranscriptEvent)!;
    const state = modelFallbackStateOf(rec);
    expect(state).not.toHaveProperty('scope');
    expect(state).not.toHaveProperty('fable');
    expect(state).not.toHaveProperty('neutralizedByFork');
    expect(state).toMatchObject({ uuid: REFUSAL_RECORD.uuid, kind: 'refusal' });
  });
});

describe('servingModelFromAssistantEvent', () => {
  it('returns the model of a normal assistant record', () => {
    expect(servingModelFromAssistantEvent(assistant('claude-opus-4-8'))).toBe('claude-opus-4-8');
  });

  it('ignores the <synthetic> API-error placeholder', () => {
    expect(servingModelFromAssistantEvent(assistant('<synthetic>'))).toBeUndefined();
  });

  it('ignores sub-agent (sidechain) and API-error records', () => {
    expect(servingModelFromAssistantEvent(assistant('claude-opus-5', { isSidechain: true }))).toBeUndefined();
    expect(servingModelFromAssistantEvent(assistant('claude-opus-5', { isApiErrorMessage: true }))).toBeUndefined();
  });

  it('ignores non-assistant records', () => {
    expect(servingModelFromAssistantEvent(REFUSAL_RECORD as TranscriptEvent)).toBeUndefined();
  });
});

describe('normalizeClaudeModelId', () => {
  it('makes a context-suffixed id comparable with a bare one', () => {
    expect(normalizeClaudeModelId('claude-fable-5-1[1m]'))
      .toBe(normalizeClaudeModelId('claude-fable-5-1'));
    expect(normalizeClaudeModelId('CLAUDE-Opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeClaudeModelId('  ')).toBeUndefined();
    expect(normalizeClaudeModelId(undefined)).toBeUndefined();
  });
});

describe('ClaudeModelFallbackTracker', () => {
  /** A tracker already bound to a Claude session — every observe() below
   *  reports against it, exactly as the worker's router leaves it. */
  function bound(claudeSessionId = SID): ClaudeModelFallbackTracker {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.bind(claudeSessionId);
    return tracker;
  }

  it('reports a new switch record once, without a serving model', () => {
    const tracker = bound();
    const observed = tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(observed?.fallback).toMatchObject({ uuid: REFUSAL_RECORD.uuid, kind: 'refusal' });
    expect(observed?.fallback).not.toHaveProperty('scope');
    expect(observed?.fallback).not.toHaveProperty('fable');
    expect(observed).not.toHaveProperty('servingModel');
  });

  it('stamps every observation with the bound Claude session', () => {
    const tracker = bound();
    expect(tracker.boundClaudeSessionId).toBe(SID);
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])?.claudeSessionId).toBe(SID);
    expect(tracker.observe([assistant('claude-opus-4-8')])?.claudeSessionId).toBe(SID);
  });

  it('says nothing on a re-drain of the same record (uuid dedupe)', () => {
    const tracker = bound();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();
  });

  it('a re-drained record still drops the replies written before it', () => {
    // A jsonl switch / baseline self-heal rewinds the bridge to offset 0 and
    // replays the WHOLE file in one batch. The switch record is a dup by then,
    // but the replies preceding it are still stale: without a reset on the dup
    // the worker would report the pre-switch model and the daemon would read it
    // as a switch back and clear a notice that is still current.
    const tracker = bound();
    tracker.observe([assistant('claude-fable-5-1'), REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([
      assistant('claude-fable-5-1'),
      REFUSAL_RECORD as TranscriptEvent,
    ])).toBeNull();
    // …and the post-switch reply in the same replay is still reported.
    expect(tracker.observe([
      assistant('claude-fable-5-1'),
      REFUSAL_RECORD as TranscriptEvent,
      assistant('claude-opus-4-8'),
    ])).toEqual({ claudeSessionId: SID, servingModel: 'claude-opus-4-8' });
  });

  it('ignores a sub-agent (scope local) fallback entirely', () => {
    const tracker = bound();
    expect(tracker.observe([{ ...REFUSAL_RECORD, scope: 'local' } as TranscriptEvent])).toBeNull();
  });

  it('P2-2: reports a non-Fable switch as fallback:null, not silence', () => {
    // "The newest session-scoped record is not a Fable fallback" is POSITIVE
    // evidence that no notice applies — the shape that lets the daemon drop an
    // older Fable notice the user has already moved past.
    const tracker = bound();
    expect(tracker.observe([
      { ...REFUSAL_RECORD, originalModel: 'claude-opus-5' } as TranscriptEvent,
    ])).toEqual({ claudeSessionId: SID, fallback: null });
    // Deduped like any other record: the same one re-drained says nothing.
    expect(tracker.observe([
      { ...REFUSAL_RECORD, originalModel: 'claude-opus-5' } as TranscriptEvent,
    ])).toBeNull();
  });

  it('P2-2: reports a fork-neutralised record as fallback:null', () => {
    const tracker = bound();
    expect(tracker.observe([
      { ...REFUSAL_RECORD, neutralizedByFork: true } as TranscriptEvent,
    ])).toEqual({ claudeSessionId: SID, fallback: null });
  });

  it('P2-2: a newer non-Fable switch supersedes a live Fable notice', () => {
    const tracker = bound();
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])?.fallback)
      .toMatchObject({ uuid: REFUSAL_RECORD.uuid });
    expect(tracker.observe([{
      ...REFUSAL_RECORD,
      uuid: 'opus-downgrade',
      originalModel: 'claude-opus-5',
    } as TranscriptEvent])).toEqual({ claudeSessionId: SID, fallback: null });
  });

  describe('P2-2: the NEWEST record in the batch decides, even when deduped', () => {
    // A drain from offset 0 (a fingerprint/rotation switch onto this file, or
    // drainTranscript's truncation re-read) replays the WHOLE file. The newest
    // switch record in it is routinely one we already reported, while an older
    // one that predates this worker's baseline has never been seen. Letting the
    // unseen older record win would resurrect exactly the notice the newest one
    // retired — the P2-2 bug, back through the P1-2 drains.
    const DOWNGRADE = {
      ...REFUSAL_RECORD,
      uuid: 'opus-downgrade',
      originalModel: 'claude-opus-5',
      fallbackModel: 'claude-opus-4-8',
    } as TranscriptEvent;

    it('an already-reported non-Fable record still buries an older unseen Fable one', () => {
      const tracker = bound();
      expect(tracker.observe([DOWNGRADE])).toEqual({ claudeSessionId: SID, fallback: null });
      // The replay: older Fable record first, the deduped newest one last.
      expect(tracker.observe([
        REFUSAL_RECORD as TranscriptEvent,
        assistant('claude-opus-4-8'),
        DOWNGRADE,
      ])?.fallback ?? undefined).toBeUndefined();
    });

    it('an already-reported Fable record is not replaced by an older one', () => {
      const older = { ...REFUSAL_RECORD, uuid: 'older-fable' } as TranscriptEvent;
      const tracker = bound();
      expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])?.fallback)
        .toMatchObject({ uuid: REFUSAL_RECORD.uuid });
      expect(tracker.observe([older, REFUSAL_RECORD as TranscriptEvent])?.fallback ?? undefined)
        .toBeUndefined();
    });

    it('a switch-path replay after the seed reports no stale record', () => {
      // Exactly what bridgeApplyFingerprintSwitch / performRotationSwitch do:
      // seed the new path's tail first, then fold the same file's events in
      // from offset 0.
      appendLine(REFUSAL_RECORD);
      appendLine(assistant('claude-opus-4-8'));
      appendLine({ ...REFUSAL_RECORD, uuid: 'newer-fable' });
      const tracker = new ClaudeModelFallbackTracker();
      expect(tracker.seed(path, SID).fallback).toMatchObject({ uuid: 'newer-fable' });
      const replay = tracker.observe([
        REFUSAL_RECORD as TranscriptEvent,
        assistant('claude-opus-4-8'),
        { ...REFUSAL_RECORD, uuid: 'newer-fable' } as TranscriptEvent,
      ]);
      expect(replay?.fallback ?? undefined).toBeUndefined();
    });
  });

  it('reports the first serving model it sees, then only on change', () => {
    const tracker = bound();
    expect(tracker.observe([assistant('claude-fable-5-1')]))
      .toEqual({ claudeSessionId: SID, servingModel: 'claude-fable-5-1' });
    expect(tracker.observe([assistant('claude-fable-5-1')])).toBeNull();
    expect(tracker.observe([assistant('claude-opus-4-8')]))
      .toEqual({ claudeSessionId: SID, servingModel: 'claude-opus-4-8' });
    expect(tracker.observe([assistant('claude-opus-4-8')])).toBeNull();
  });

  it('treats a context-suffix difference as the same serving model', () => {
    const tracker = bound();
    tracker.observe([assistant('claude-opus-4-8')]);
    expect(tracker.observe([assistant('claude-opus-4-8[1m]')])).toBeNull();
  });

  it('drops a reply written BEFORE the switch in the same batch', () => {
    // Otherwise the daemon would see "fallback to opus" + "serving fable" in one
    // message and clear the notice the instant it appeared.
    const tracker = bound();
    const observed = tracker.observe([
      assistant('claude-fable-5-1'),
      REFUSAL_RECORD as TranscriptEvent,
    ]);
    expect(observed?.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(observed).not.toHaveProperty('servingModel');
  });

  it('reports a reply written AFTER the switch in the same batch', () => {
    const tracker = bound();
    expect(tracker.observe([
      REFUSAL_RECORD as TranscriptEvent,
      assistant('claude-opus-4-8'),
    ])).toEqual({
      claudeSessionId: SID,
      fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      servingModel: 'claude-opus-4-8',
    });
  });

  it('reports the switch-back reply that lets the daemon clear', () => {
    const tracker = bound();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    expect(tracker.observe([assistant('claude-fable-5-1')]))
      .toEqual({ claudeSessionId: SID, servingModel: 'claude-fable-5-1' });
  });

  describe('P1-1: a switch resets the serving-model dedupe', () => {
    it('reports the switch-back reply even when one drain carries the whole story', () => {
      // The bug: Fable was already the reported serving model, so when a single
      // drain carried "fell off Fable → Opus answered → user switched back →
      // Fable answered", the batch's closing Fable read as "unchanged" and was
      // swallowed. The daemon then got the fallback with NO clearing evidence
      // and the notice hung forever.
      const tracker = bound();
      expect(tracker.observe([assistant('claude-fable-5-1')]))
        .toEqual({ claudeSessionId: SID, servingModel: 'claude-fable-5-1' });
      expect(tracker.observe([
        REFUSAL_RECORD as TranscriptEvent,
        assistant('claude-opus-4-8'),
        assistant('claude-fable-5-1'),
      ])).toEqual({
        claudeSessionId: SID,
        fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
        servingModel: 'claude-fable-5-1',
      });
    });

    it('re-reports an unchanged serving model right after a switch', () => {
      // Narrower form of the same rule: the first serving model observed AFTER
      // a switch always ships, even when its value is old news.
      const tracker = bound();
      tracker.observe([assistant('claude-opus-4-8')]);
      expect(tracker.observe([
        { ...REFUSAL_RECORD, fallbackModel: 'claude-opus-4-8[1m]' } as TranscriptEvent,
        assistant('claude-opus-4-8'),
      ])).toMatchObject({ servingModel: 'claude-opus-4-8' });
    });

    it('resets the dedupe for a fallback:null record too', () => {
      const tracker = bound();
      tracker.observe([assistant('claude-fable-5-1')]);
      expect(tracker.observe([
        { ...REFUSAL_RECORD, uuid: 'opus-downgrade', originalModel: 'claude-opus-5' } as TranscriptEvent,
        assistant('claude-fable-5-1'),
      ])).toEqual({
        claudeSessionId: SID,
        fallback: null,
        servingModel: 'claude-fable-5-1',
      });
    });
  });

  describe('P1-3: binding to a Claude session', () => {
    it('drops uuid dedupe and serving-model memory when the session changes', () => {
      const tracker = bound();
      tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
      expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();

      expect(tracker.bind(OTHER_SID)).toBe(true);
      expect(tracker.boundClaudeSessionId).toBe(OTHER_SID);
      // Same record, new conversation: reported again, under the new session.
      expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toEqual({
        claudeSessionId: OTHER_SID,
        fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      });
      // …and so is a serving model identical to the one the old session had.
      expect(tracker.observe([assistant('claude-opus-4-8')]))
        .toEqual({ claudeSessionId: OTHER_SID, servingModel: 'claude-opus-4-8' });
    });

    it('is a no-op when the same session is re-bound', () => {
      const tracker = bound();
      tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
      expect(tracker.bind(SID)).toBe(false);
      expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();
    });

    it('seed binds and ALWAYS publishes, even on an empty scan', () => {
      // The empty message is how the daemon learns which Claude session the
      // worker moved to — the only way state belonging to a different one can
      // be dropped. It is never a claim that a notice is stale.
      writeFileSync(path, '', 'utf8');
      const tracker = bound();
      expect(tracker.seed(path, OTHER_SID)).toEqual({ claudeSessionId: OTHER_SID });
      expect(tracker.boundClaudeSessionId).toBe(OTHER_SID);
      expect(tracker.seed(join(dir, 'nope.jsonl'), OTHER_SID))
        .toEqual({ claudeSessionId: OTHER_SID });
    });

    it('seed re-finds a record already deduped under another session', () => {
      // A → B → resume A: the tail scan is what restores A's notice, and it can
      // only do that because binding back to A cleared B's dedupe state.
      appendLine(REFUSAL_RECORD);
      const tracker = bound();
      expect(tracker.seed(path, SID)?.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
      expect(tracker.seed(path, SID)).toEqual({ claudeSessionId: SID }); // deduped
      tracker.bind(OTHER_SID);
      expect(tracker.seed(path, SID)).toEqual({
        claudeSessionId: SID,
        fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      });
    });
  });

  it('ignores <synthetic>, sidechain and API-error replies', () => {
    const tracker = bound();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    expect(tracker.observe([
      assistant('<synthetic>'),
      assistant('claude-fable-5-1', { isSidechain: true }),
      assistant('claude-fable-5-1', { isApiErrorMessage: true }),
    ])).toBeNull();
  });

  it('reports a second, different switch', () => {
    const tracker = bound();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([{
      ...REFUSAL_RECORD,
      subtype: 'model_fallback',
      trigger: 'overloaded',
      uuid: 'second-switch',
    } as TranscriptEvent])?.fallback).toMatchObject({ uuid: 'second-switch', kind: 'unavailable' });
  });

  it('reports nothing for an events batch with nothing in it', () => {
    const tracker = bound();
    expect(tracker.observe([])).toBeNull();
    expect(tracker.observe([{ type: 'user', uuid: 'u1' } as TranscriptEvent])).toBeNull();
  });

  it('seeds from a transcript tail (cold start after --resume)', () => {
    appendLine({ type: 'user', uuid: 'u1' });
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    const tracker = bound();
    expect(tracker.seed(path, SID)).toEqual({
      claudeSessionId: SID,
      fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      servingModel: 'claude-opus-4-8',
    });
    // Idempotent: a second seed (lazy baseline) and a re-drain of the same
    // line both report nothing new beyond the session id.
    expect(tracker.seed(path, SID)).toEqual({ claudeSessionId: SID });
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();
  });

  it('carries no fallback / servingModel when the tail scan finds nothing', () => {
    // The critical invariant is unchanged: a short window / fresh transcript
    // must never produce a shape the daemon can read as "cleared". It publishes
    // the session id and NOTHING else, and the daemon leaves same-session state
    // alone.
    writeFileSync(path, '', 'utf8');
    for (const p of [path, join(dir, 'nope.jsonl')]) {
      const seeded = bound().seed(p, SID);
      expect(seeded, p).toEqual({ claudeSessionId: SID });
      expect(seeded, p).not.toHaveProperty('fallback');
    }
  });

  it('seeds a bare serving model when the window holds no switch record', () => {
    appendLine(assistant('claude-fable-5-1'));
    expect(bound().seed(path, SID))
      .toEqual({ claudeSessionId: SID, servingModel: 'claude-fable-5-1' });
  });

  it('P2-2: seeds fallback:null when the newest record is not a Fable fallback', () => {
    appendLine(REFUSAL_RECORD);
    appendLine({ ...REFUSAL_RECORD, uuid: 'opus-downgrade', originalModel: 'claude-opus-5' });
    expect(bound().seed(path, SID)).toEqual({ claudeSessionId: SID, fallback: null });
  });
});

describe('readLatestClaudeModelFallback', () => {
  it('returns the newest switch plus the model serving since it', () => {
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    const r = readLatestClaudeModelFallback(path);
    expect(r.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(r.servingModel).toBe('claude-opus-4-8');
  });

  it('reports the original model once the user switched back', () => {
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    appendLine(assistant('claude-fable-5-1'));
    const r = readLatestClaudeModelFallback(path);
    expect(r.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(r.servingModel).toBe('claude-fable-5-1');
  });

  it('does not read a reply from before the switch as the serving model', () => {
    appendLine(assistant('claude-fable-5-1'));
    appendLine(REFUSAL_RECORD);
    const r = readLatestClaudeModelFallback(path);
    expect(r.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(r.servingModel).toBeUndefined();
  });

  it('returns the serving model alone when the window holds no switch record', () => {
    // The long-session case: the switch scrolled past the scan cap. The serving
    // model is still worth reporting — the daemon compares it with the record
    // IT persisted, which is the only copy that survived.
    appendLine({ type: 'user', uuid: 'u1' });
    appendLine(assistant('claude-opus-4-8'));
    expect(readLatestClaudeModelFallback(path)).toEqual({ servingModel: 'claude-opus-4-8' });
  });

  it('skips a local-scope record and keeps looking for a session one', () => {
    appendLine(REFUSAL_RECORD);
    appendLine({ ...REFUSAL_RECORD, scope: 'local', uuid: 'sub-agent-uuid' });
    expect(readLatestClaudeModelFallback(path).fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
  });

  it('P2-2: stops at a newer non-Fable switch and reports null, not the older Fable one', () => {
    // Walking past it (the old behaviour) resurrected a notice the session had
    // already left behind: the user switched off Fable, Claude recorded a
    // routine Opus 5 → Opus 4.8 downgrade, and the scan reached back over it to
    // the stale Fable record.
    appendLine(REFUSAL_RECORD);
    appendLine({ ...REFUSAL_RECORD, originalModel: 'claude-opus-5', uuid: 'opus-downgrade' });
    expect(readLatestClaudeModelFallback(path)).toEqual({ fallback: null });
  });

  it('P2-2: stops at a fork-neutralised record and reports null', () => {
    // 2.1.259+ copies the parent's refusal record into the fork with
    // neutralizedByFork:true. It applies to the parent, never here.
    appendLine({ ...REFUSAL_RECORD, neutralizedByFork: true });
    expect(readLatestClaudeModelFallback(path)).toEqual({ fallback: null });
  });

  it('P2-2: still reports the record when it is the newest and genuinely live', () => {
    appendLine({ ...REFUSAL_RECORD, originalModel: 'claude-opus-5', uuid: 'opus-downgrade' });
    appendLine(REFUSAL_RECORD);
    expect(readLatestClaudeModelFallback(path).fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
  });

  it('P2-2: distinguishes "no evidence" from "positive no-notice"', () => {
    // Absent vs null is the whole point: absent leaves the daemon's state
    // alone, null clears it.
    appendLine({ type: 'user', uuid: 'u1' });
    expect(readLatestClaudeModelFallback(path)).not.toHaveProperty('fallback');
  });

  it('returns nothing for a missing, empty, or fallback-free transcript', () => {
    expect(readLatestClaudeModelFallback(join(dir, 'nope.jsonl'))).toEqual({});
    writeFileSync(path, '', 'utf8');
    expect(readLatestClaudeModelFallback(path)).toEqual({});
    appendLine({ type: 'user', uuid: 'u1' });
    expect(readLatestClaudeModelFallback(path).fallback).toBeUndefined();
  });

  it('ignores a half-written trailing line', () => {
    appendLine({ type: 'user', uuid: 'u1' });
    appendFileSync(path, JSON.stringify(REFUSAL_RECORD), 'utf8'); // no trailing newline
    expect(readLatestClaudeModelFallback(path).fallback).toBeUndefined();
  });

  it('finds a switch that is further back than one 64KiB chunk', () => {
    appendLine(REFUSAL_RECORD);
    for (let i = 0; i < 200; i++) {
      appendLine({ type: 'user', uuid: `pad-${i}`, message: { role: 'user', content: 'x'.repeat(1000) } });
    }
    expect(readLatestClaudeModelFallback(path).fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
  });
});
