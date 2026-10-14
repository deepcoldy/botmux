import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexHistorySidIsOwned,
  readLatestCodexRuntime,
  readLatestRolloutRuntime,
  rolloutAbortErrorCode,
  runtimeFromTurnContext,
} from '../src/services/codex-transcript.js';
import { readLatestTraexRuntime, traexHistorySidIsOwned } from '../src/services/traex-transcript.js';

// Codex and TRAE write the same `turn_context` record, so one implementation
// serves both readers. These pin the shared pieces both sides now rely on.

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bmx-rollout-shared-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const turnContext = (payload: unknown) => JSON.stringify({ type: 'turn_context', payload });

describe('rolloutAbortErrorCode', () => {
  it('namespaces with the caller prefix and normalises the reason', () => {
    expect(rolloutAbortErrorCode('codex_turn_aborted', 'Interrupted')).toBe('codex_turn_aborted:interrupted');
    expect(rolloutAbortErrorCode('traex_turn_aborted', '  User Cancel!! ')).toBe('traex_turn_aborted:user_cancel');
    expect(rolloutAbortErrorCode('traex_turn_aborted', 42)).toBe('traex_turn_aborted:unknown');
    expect(rolloutAbortErrorCode('codex_turn_aborted', '!!!')).toBe('codex_turn_aborted:unknown');
    expect(rolloutAbortErrorCode('codex_turn_aborted', 'x'.repeat(100))).toBe(`codex_turn_aborted:${'x'.repeat(64)}`);
  });
});

describe('runtimeFromTurnContext', () => {
  it('reads model / effort from the payload with collaboration_mode.settings as fallback', () => {
    expect(runtimeFromTurnContext({ type: 'turn_context', payload: { model: ' gpt-5 ', effort: 'high' } }))
      .toEqual({ model: 'gpt-5', reasoningEffort: 'high' });
    expect(runtimeFromTurnContext({
      type: 'turn_context',
      payload: { collaboration_mode: { settings: { model: 'm', reasoning_effort: 'low' } } },
    })).toEqual({ model: 'm', reasoningEffort: 'low' });
    expect(runtimeFromTurnContext({ type: 'turn_context', payload: { model: 'm', reasoning_effort: 'a', effort: 'b' } }))
      .toEqual({ model: 'm', reasoningEffort: 'a' });
  });

  it('returns undefined for other record types and non-object / empty payloads', () => {
    for (const value of [
      null, undefined, 'x', { type: 'event_msg', payload: { model: 'm' } },
      { type: 'turn_context' }, { type: 'turn_context', payload: 'str' }, { type: 'turn_context', payload: 7 },
      { type: 'turn_context', payload: { model: '  ', effort: '' } },
    ]) {
      expect(runtimeFromTurnContext(value)).toBeUndefined();
    }
  });
});

describe('readLatestRolloutRuntime (codex + TRAE readers)', () => {
  it('gives both CLIs the same newest-wins answer from the same rollout', () => {
    const path = join(dir, 'rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl');
    writeFileSync(path, [
      turnContext({ model: 'old', effort: 'low' }),
      turnContext({ model: 'new' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'noise' } }),
      '',
    ].join('\n'));
    const expected = { model: 'new', reasoningEffort: 'low' };
    expect(readLatestCodexRuntime(path)).toEqual(expected);
    expect(readLatestTraexRuntime(path)).toEqual(expected);
    expect(readLatestRolloutRuntime(path, 4 * 1024 * 1024)).toEqual(expected);
  });

  it('drops the truncated leading fragment at the byte cap but keeps a complete first record', () => {
    const path = join(dir, 'r.jsonl');
    const first = turnContext({ model: 'first-record' });
    writeFileSync(path, `${first}\n${turnContext({ effort: 'high' })}\n`);
    const cap = Buffer.byteLength(turnContext({ effort: 'high' })) + 5; // window starts inside the FIRST line
    expect(readLatestRolloutRuntime(path, cap)).toEqual({ reasoningEffort: 'high' });
    expect(readLatestRolloutRuntime(path, 1 << 20)).toEqual({ model: 'first-record', reasoningEffort: 'high' });
  });

  it('ignores a half-written trailing line and a missing file', () => {
    const path = join(dir, 'r.jsonl');
    writeFileSync(path, `${turnContext({ model: 'done' })}\n{"type":"turn_context","payload":{"model":"par`);
    expect(readLatestTraexRuntime(path)).toEqual({ model: 'done' });
    expect(readLatestCodexRuntime(join(dir, 'absent.jsonl'))).toEqual({});
  });
});

describe('traexHistorySidIsOwned', () => {
  it('is the codex predicate (one fail-closed implementation)', () => {
    const owned = new Set(['sid-a']);
    for (const [sid, set] of [['sid-a', owned], ['sid-b', owned], ['sid-a', undefined], ['', owned]] as const) {
      expect(traexHistorySidIsOwned(sid, set)).toBe(codexHistorySidIsOwned(sid, set));
    }
  });
});
