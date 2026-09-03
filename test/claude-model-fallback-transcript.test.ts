/**
 * Claude Code writes a `type:"system"` record whenever it automatically
 * switches the session model. These tests cover the parse, the "is it still in
 * effect" rule (serving model vs. fallback model), the bridge tracker's dedupe /
 * local-scope / clearing behaviour, and the cold-start tail scan.
 *
 * Run: npx vitest run --project unit test/claude-model-fallback-transcript.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeModelFallbackTracker,
  normalizeClaudeModelId,
  parseClaudeModelFallbackEvent,
  readLatestClaudeModelFallback,
  resolveActiveModelFallback,
  servingModelFromAssistantEvent,
  type ClaudeModelFallbackRecord,
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

describe('resolveActiveModelFallback', () => {
  const fallback = parseClaudeModelFallbackEvent(REFUSAL_RECORD as TranscriptEvent)!;

  it('keeps the state while the fallback model is still serving', () => {
    const state = resolveActiveModelFallback({ fallback, servingModel: 'claude-opus-4-8' });
    expect(state).toMatchObject({ kind: 'refusal', fallbackModel: 'claude-opus-4-8[1m]' });
    expect(state).not.toHaveProperty('scope');
  });

  it('clears once the user switched back to the original model', () => {
    expect(resolveActiveModelFallback({ fallback, servingModel: 'claude-fable-5-1' })).toBeNull();
  });

  it('keeps the state when no reply has been served since the switch', () => {
    expect(resolveActiveModelFallback({ fallback, servingModel: undefined })).not.toBeNull();
  });

  it('returns null with no record, or a local-scope one', () => {
    expect(resolveActiveModelFallback({})).toBeNull();
    expect(resolveActiveModelFallback({
      fallback: { ...fallback, scope: 'local' } as ClaudeModelFallbackRecord,
    })).toBeNull();
  });
});

describe('ClaudeModelFallbackTracker', () => {
  it('accepts a switch once and reports it as active', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toHaveLength(1);
    expect(tracker.current()).toMatchObject({ uuid: REFUSAL_RECORD.uuid, kind: 'refusal' });
  });

  it('ignores the same record on a re-drain (uuid dedupe)', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toEqual([]);
    expect(tracker.current()).not.toBeNull();
  });

  it('ignores a sub-agent (scope local) fallback entirely', () => {
    const tracker = new ClaudeModelFallbackTracker();
    expect(tracker.observe([{ ...REFUSAL_RECORD, scope: 'local' } as TranscriptEvent])).toEqual([]);
    expect(tracker.current()).toBeNull();
  });

  it('does not clear on a reply written before the switch', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([assistant('claude-fable-5-1'), REFUSAL_RECORD as TranscriptEvent]);
    expect(tracker.current()).not.toBeNull();
  });

  it('clears after the user switches back with /model', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    expect(tracker.current()).not.toBeNull();
    tracker.observe([assistant('claude-fable-5-1')]);
    expect(tracker.current()).toBeNull();
  });

  it('ignores <synthetic> and sidechain replies when deciding to clear', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-opus-4-8')]);
    tracker.observe([
      assistant('<synthetic>'),
      assistant('claude-fable-5-1', { isSidechain: true }),
      assistant('claude-fable-5-1', { isApiErrorMessage: true }),
    ]);
    expect(tracker.current()).not.toBeNull();
  });

  it('re-arms on a second, different switch', () => {
    const tracker = new ClaudeModelFallbackTracker();
    tracker.observe([REFUSAL_RECORD as TranscriptEvent, assistant('claude-fable-5-1')]);
    expect(tracker.current()).toBeNull();
    tracker.observe([{
      ...REFUSAL_RECORD,
      subtype: 'model_fallback',
      trigger: 'overloaded',
      uuid: 'second-switch',
    } as TranscriptEvent]);
    expect(tracker.current()).toMatchObject({ uuid: 'second-switch', kind: 'unavailable' });
  });

  it('seeds from a transcript tail (cold start after --resume)', () => {
    appendLine({ type: 'user', uuid: 'u1' });
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    const tracker = new ClaudeModelFallbackTracker();
    tracker.seed(path);
    expect(tracker.current()).toMatchObject({ uuid: REFUSAL_RECORD.uuid });
    // A seeded record must not be re-accepted when the same line is drained.
    expect(tracker.observe([REFUSAL_RECORD as TranscriptEvent])).toEqual([]);
  });
});

describe('readLatestClaudeModelFallback', () => {
  it('returns the newest switch plus the model serving since it', () => {
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    const r = readLatestClaudeModelFallback(path);
    expect(r.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(r.servingModel).toBe('claude-opus-4-8');
    expect(resolveActiveModelFallback(r)).not.toBeNull();
  });

  it('reports the original model once the user switched back', () => {
    appendLine(REFUSAL_RECORD);
    appendLine(assistant('claude-opus-4-8'));
    appendLine(assistant('claude-fable-5-1'));
    const r = readLatestClaudeModelFallback(path);
    expect(r.servingModel).toBe('claude-fable-5-1');
    expect(resolveActiveModelFallback(r)).toBeNull();
  });

  it('does not read a reply from before the switch as the serving model', () => {
    appendLine(assistant('claude-fable-5-1'));
    appendLine(REFUSAL_RECORD);
    const r = readLatestClaudeModelFallback(path);
    expect(r.fallback?.uuid).toBe(REFUSAL_RECORD.uuid);
    expect(r.servingModel).toBeUndefined();
    expect(resolveActiveModelFallback(r)).not.toBeNull();
  });

  it('skips a local-scope record and keeps looking for a session one', () => {
    appendLine(REFUSAL_RECORD);
    appendLine({ ...REFUSAL_RECORD, scope: 'local', uuid: 'sub-agent-uuid' });
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
