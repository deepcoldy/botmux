import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGrokRuntimeObservation } from '../src/services/grok-runtime-observer.js';
import { readNativeReasoningFooter } from '../src/utils/native-reasoning-footer.js';
import { appliedReasoningSelectionFromRecord } from '../src/services/native-reasoning-observation.js';

const NOW = 1_799_000_000_000;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-readers-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function file(name: string, value: unknown, time = NOW) {
  const dir = join(root, 'native'); mkdirSync(dir, { recursive: true });
  const path = join(dir, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  utimesSync(path, new Date(time), new Date(time)); return dir;
}

describe('Grok native runtime snapshots', () => {
  it('prefers newer summary model over an older signals model', () => {
    file('signals.json', { primaryModelId: 'old' }, NOW - 100);
    const dir = file('summary.json', { current_model_id: 'new', reasoning_effort: 'medium' });
    expect(readGrokRuntimeObservation(dir, 'native', NOW)).toMatchObject({ model: 'new', reasoningEffort: 'medium' });
  });
  it('uses signals-only model without inventing effort', () => {
    const dir = file('signals.json', { primaryModelId: 'native-model' });
    expect(readGrokRuntimeObservation(dir, 'native', NOW)).toMatchObject({ model: 'native-model', reasoningEffort: null });
  });
  it.each(['bogus', null, undefined])('does not guess effort from %s', level => {
    const dir = file('summary.json', { current_model_id: 'native-model', reasoning_effort: level });
    expect(readGrokRuntimeObservation(dir, 'native', NOW).reasoningEffort).toBeNull();
  });
  it('rejects future metadata', () => {
    const dir = file('summary.json', { current_model_id: 'bad-model', reasoning_effort: 'high' }, NOW + 10_000);
    expect(readGrokRuntimeObservation(dir, 'native', NOW)).not.toHaveProperty('model');
  });
  it('keeps an idle session\'s own summary however long ago its last turn ended', () => {
    // Grok does not refresh summary.json on a timer. An idle card must not lose
    // the effort the same process reported an hour ago.
    const dir = file('summary.json', { current_model_id: 'grok-4.7', reasoning_effort: 'xhigh' }, NOW - 3_600_000);
    expect(readGrokRuntimeObservation(dir, 'native', NOW, NOW - 7_200_000))
      .toMatchObject({ model: 'grok-4.7', reasoningEffort: 'xhigh', observedAtMs: NOW - 3_600_000 });
  });
  it('does not reuse an earlier native process snapshot', () => {
    const dir = file('summary.json', { reasoning_effort: 'high' }, NOW - 1000);
    expect(readGrokRuntimeObservation(dir, 'native', NOW, NOW - 1).reasoningEffort).toBeNull();
  });
  it('rejects foreign session identity and handles malformed JSON', () => {
    let dir = file('summary.json', { session_id: 'foreign', current_model_id: 'bad', reasoning_effort: 'high' });
    expect(readGrokRuntimeObservation(dir, 'native', NOW).reasoningEffort).toBeNull();
    dir = file('summary.json', '{broken');
    expect(readGrokRuntimeObservation(dir, 'native', NOW).reasoningEffort).toBeNull();
    expect(readGrokRuntimeObservation(dir, 'foreign', NOW)).not.toHaveProperty('model');
  });
});

describe('passive reasoning footer', () => {
  it('does not take menu hover or quoted historical output as a saved setting', () => {
    expect(readNativeReasoningFooter('codex', 'Select Reasoning Level\n› 2. Medium\nenter select')).toBeUndefined();
    expect(readNativeReasoningFooter('codex', '› \n gpt-6.1-sol medium · 98% context left\n› actual draft')).toBeUndefined();
    expect(readNativeReasoningFooter('codex', 'gpt-6.1-sol medium · 98% context left\n› ')).toBeUndefined();
    expect(readNativeReasoningFooter('codex', 'Working (esc to interrupt)\n› \n gpt-6.1-sol high · 98% context left')).toBeUndefined();
  });
  it('keeps native MAX model variant separate from Trae effort', () => {
    const rule = '─'.repeat(80);
    expect(readNativeReasoningFooter('traex', `${rule}\n❯ Explain this codebase\n${rule}\n  GPT-6.1-Sol (MAX) medium · /fixture · Context 98% left\n  ? for shortcuts`)).toBe('medium');
  });
  it('reads nested collaboration settings and explicit default without inventing a level', () => {
    const record = (raw: unknown) => ({ type: 'event_msg', timestamp: new Date(NOW).toISOString(),
      payload: { type: 'thread_settings_applied', thread_settings: raw } });
    expect(appliedReasoningSelectionFromRecord(record({ collaboration_mode: { settings: { reasoning_effort: 'medium' } } }))?.reasoningEffort).toBe('medium');
    expect(appliedReasoningSelectionFromRecord(record({ reasoning_effort: 'default' }))?.reasoningEffort).toBeNull();
  });
});
