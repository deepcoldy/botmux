/**
 * Claude Code writes a `type:"system"` record whenever it automatically
 * switches the session model. These tests cover the parse (including the
 * product's "Fable originals only" scope), the bridge tracker's dedupe /
 * local-scope / serving-model reporting, and the cold-start tail scan.
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
    it('ignores a switch whose original model is not Fable', () => {
      // Opus 5 → Opus 4.8 is a routine safety downgrade; surfacing it would
      // put a warning on sessions that never asked for Fable.
      for (const originalModel of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-4-5']) {
        expect(parseClaudeModelFallbackEvent({
          ...REFUSAL_RECORD,
          originalModel,
        } as TranscriptEvent), originalModel).toBeUndefined();
      }
    });

    it('accepts every Fable spelling', () => {
      for (const originalModel of ['claude-fable-5[1m]', 'claude-fable-5-1', 'Claude-Fable-5-1[1M]']) {
        expect(parseClaudeModelFallbackEvent({
          ...REFUSAL_RECORD,
          originalModel,
        } as TranscriptEvent)?.originalModel, originalModel).toBe(originalModel);
      }
    });
  });
});

describe('modelFallbackStateOf', () => {
  it('drops the transcript-only scope field', () => {
    const rec = parseClaudeModelFallbackEvent(REFUSAL_RECORD as TranscriptEvent)!;
    const state = modelFallbackStateOf(rec);
    expect(state).not.toHaveProperty('scope');
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
  it('reports a new switch record once, without a serving model', () => {
    const tracker = new ClaudeModelFallbackTracker();
    const observed = tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(observed?.fallback).toMatchObject({ uuid: REFUSAL_RECORD.uuid, kind: 'refusal' });
    expect(observed?.fallback).not.toHaveProperty('scope');
    expect(observed).not.toHaveProperty('servingModel');
  });

  it('says nothing on a re-drain of the same record (uuid dedupe)', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();
  });

  it('a re-drained record still drops the replies written before it', () => {
    // A jsonl switch / baseline self-heal rewinds the bridge to offset 0 and
    // replays the WHOLE file in one batch. The switch record is a dup by then,
    // but the replies preceding it are still stale: without a reset on the dup
    // the worker would report the pre-switch model and the daemon would read it
    // as a switch back and clear a notice that is still current.
    const tracker = new ClaudeModelFallbackTracker();
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
    ])).toEqual({ servingModel: 'claude-opus-4-8' });
  });

  it('ignores a sub-agent (scope local) fallback entirely', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([{ ...REFUSAL_RECORD, scope: 'local' } as TranscriptEvent])).toBeNull();
  });

  it('ignores a non-Fable switch entirely (Fable gate)', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([
      { ...REFUSAL_RECORD, originalModel: 'claude-opus-5' } as TranscriptEvent,
    ])).toBeNull();
  });

  it('reports the first serving model it sees, then only on change', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([assistant('claude-fable-5-1')]))
      .toEqual({ servingModel: 'claude-fable-5-1' });
    expect(tracker.observe([assistant('claude-fable-5-1')])).toBeNull();
    expect(tracker.observe([assistant('claude-opus-4-8')]))
      .toEqual({ servingModel: 'claude-opus-4-8' });
    expect(tracker.observe([assistant('claude-opus-4-8')])).toBeNull();
  });

  it('treats a context-suffix difference as the same serving model', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([assistant('claude-opus-4-8')]);
    expect(tracker.observe([assistant('claude-opus-4-8[1m]')])).toBeNull();
  });

  it('drops a reply written BEFORE the switch in the same batch', () => {
    // Otherwise the daemon would see "fallback to opus" + "serving fable" in one
    // message and clear the notice the instant it appeared.
    const tracker = new ClaudeModelFallbackTracker();
    const observed = tracker.observe([
      assistant('claude-fable-5-1'),
      REFUSAL_RECORD as TranscriptEvent,
    ]);
    expect(observed?.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(observed).not.toHaveProperty('servingModel');
  });

  it('reports a reply written AFTER the switch in the same batch', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([
      REFUSAL_RECORD as TranscriptEvent,
      assistant('claude-opus-4-8'),
    ])).toEqual({
      fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      servingModel: 'claude-opus-4-8',
    });
  });

  it('reports the switch-back reply that lets the daemon clear', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    expect(tracker.observe([assistant('claude-fable-5-1')]))
      .toEqual({ servingModel: 'claude-fable-5-1' });
  });

  it('ignores <synthetic>, sidechain and API-error replies', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    expect(tracker.observe([
      assistant('<synthetic>'),
      assistant('claude-fable-5-1', { isSidechain: true }),
      assistant('claude-fable-5-1', { isApiErrorMessage: true }),
    ])).toBeNull();
  });

  it('reports a second, different switch', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([{
      ...REFUSAL_RECORD,
      subtype: 'model_fallback',
      trigger: 'overloaded',
      uuid: 'second-switch',
    } as TranscriptEvent])?.fallback).toMatchObject({ uuid: 'second-switch', kind: 'unavailable' });
  });

  it('reports nothing for an events batch with nothing in it', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([])).toBeNull();
    expect(tracker.observe([{ type: 'user', uuid: 'u1' } as TranscriptEvent])).toBeNull();
  });

  it('seeds from a transcript tail (cold start after --resume)', () => {
    appendLine({ type: 'user', uuid: 'u1' });
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.seed(path)).toEqual({
      fallback: expect.objectContaining({ uuid: REFUSAL_RECORD.uuid }),
      servingModel: 'claude-opus-4-8',
    });
    // Idempotent: a second seed (lazy baseline) and a re-drain of the same
    // line both report nothing new.
    expect(tracker.seed(path)).toBeNull();
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toBeNull();
  });

  it('reports NOTHING when the tail scan finds nothing', () => {
    // The critical invariant: a short window / fresh transcript must never be
    // turned into a message, because any message the daemon receives could only
    // make it drop a notice it is rightly holding.
    writeFileSync(path, '', 'utf8');
    expect(new ClaudeModelFallbackTracker().seed(path)).toBeNull();
    expect(new ClaudeModelFallbackTracker().seed(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('seeds a bare serving model when the window holds no switch record', () => {
    appendLine(assistant('claude-fable-5-1'));
    expect(new ClaudeModelFallbackTracker().seed(path))
      .toEqual({ servingModel: 'claude-fable-5-1' });
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

  it('skips a non-Fable switch and keeps looking for a Fable one', () => {
    appendLine(REFUSAL_RECORD);
    appendLine({ ...REFUSAL_RECORD, originalModel: 'claude-opus-5', uuid: 'opus-downgrade' });
    expect(readLatestClaudeModelFallback(path).fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
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
