import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalEffortChoiceTracker, readClaudeEffortCommandReceipt, type TerminalEffortCli } from '../src/services/terminal-effort-choice.js';

const NOW = 1_799_000_000_000;
let directory: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); directory = mkdtempSync(join(tmpdir(), 'terminal-effort-choice-')); });
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
function fixture(cliId: TerminalEffortCli = 'claude-code') {
  const tracker = new TerminalEffortChoiceTracker();
  const binding = { cliId, nativeSessionId: 'native', cliSpawnGeneration: 1 };
  const client = {};
  tracker.observe({ binding, effort: 'high', model: 'model', atMs: NOW - 1 }, true, 'native-footer');
  return { tracker, binding, client };
}

describe('confirmed terminal effort intent', () => {
  it.each(['claude-code', 'codex', 'traex', 'grok'] as const)('%s confirms a user command only after a fresh matching native observation', cliId => {
    const { tracker, binding, client } = fixture(cliId);
    tracker.input(client, '/effort medium\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'low', model: 'model', atMs: NOW }, true, 'native-footer')).toBeUndefined();
    vi.setSystemTime(NOW + 1);
    const value = tracker.observe({ binding, effort: 'medium', model: 'model', atMs: NOW + 1 }, true,
      cliId === 'grok' ? 'native-summary' : cliId === 'claude-code' ? 'statusline' : 'native-settings');
    expect(value).toMatchObject({ cliId, nativeSessionId: 'native', requestedEffort: 'medium', source: 'terminal-input' });
    expect(tracker.observe({ binding, effort: 'medium', model: 'model', atMs: NOW + 1 }, true, 'native-settings')).toBeUndefined();
  });

  it('does not persist startup defaults, environment-selected effort or automatic downgrades without a user intent', () => {
    const { tracker, binding } = fixture();
    for (const effort of ['medium', 'low', 'high'] as const) {
      expect(tracker.observe({ binding, effort, model: 'model', atMs: NOW }, true, 'statusline')).toBeUndefined();
    }
  });

  it('disabled or unready input never supplies a choice, including after enabling', () => {
    for (const options of [{ enabled: false, ready: true }, { enabled: true, ready: false }]) {
      const { tracker, binding, client } = fixture();
      tracker.input(client, '/effort medium\r', binding, options);
      expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    }
  });

  it('rejects foreign native sessions, replaced CLI processes, model changes, delayed receipts and reset lifetimes', () => {
    for (const changed of [{ nativeSessionId: 'other' }, { cliSpawnGeneration: 2 }]) {
      const { tracker, binding, client } = fixture();
      tracker.input(client, '/effort medium\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
      expect(tracker.observe({ binding: { ...binding, ...changed }, effort: 'medium', model: 'model', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    }
    const { tracker, binding, client } = fixture();
    tracker.input(client, '/effort medium\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', model: 'other-model', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    tracker.input(client, '/effort medium\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    vi.setSystemTime(NOW + 61_000);
    expect(tracker.observe({ binding, effort: 'medium', model: 'model', atMs: NOW + 61_000 }, true, 'native-settings')).toBeUndefined();
    tracker.reset();
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW + 61_000 }, true, 'native-settings')).toBeUndefined();
  });

  it('does not confuse refreshed launch values with a successful same-value command', () => {
    const { tracker, binding, client } = fixture();
    tracker.input(client, '/effort high\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'high', atMs: NOW }, true, 'statusline')).toBeUndefined();
  });

  it('requires a native selection cursor and confirmation after opening an effort menu', () => {
    const { tracker, binding, client } = fixture('codex');
    tracker.input(client, '/effort\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    tracker.input(client, '\x1b[B', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    tracker.input(client, '\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]',
      screen: 'Select Reasoning Level for GPT\n  1. Low\n› 2. Medium\n  enter select · esc back' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toMatchObject({ requestedEffort: 'medium' });
  });

  it('follows the real /model picker into its effort menu without treating the model row as an effort', () => {
    const { tracker, binding, client } = fixture('codex');
    const options = { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' };
    tracker.input(client, '/model\r', binding, options);
    tracker.input(client, '\r', binding, { ...options,
      screen: 'Select Model and Effort\n› 1. GPT\n  enter select · esc back' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    tracker.input(client, '\r', binding, { ...options,
      screen: 'Select Reasoning Level for GPT\n  1. Low\n› 2. Medium\n  enter select · esc back' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toMatchObject({ requestedEffort: 'medium' });
  });

  it('drops a request whose enable epoch changed between input and confirmation', () => {
    const { tracker, binding, client } = fixture('codex');
    tracker.input(client, '/effort medium\r', binding, { enabled: true, ready: true,
      enableEpoch: 1, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings', 3)).toBeUndefined();
  });

  it.each([
    ['traex', 'Select Reasoning Level for GPT\n  1. Low\n❯ 2. Medium\n  enter confirm | esc go back', 'native-settings'],
    ['grok', '│ Reasoning Effort │\n│ > Medium │\n│   High │\n│ enter select · esc back │', 'native-summary'],
  ] as const)('confirms the current %s native effort menu even without a preceding command buffer', (cliId, screen, source) => {
    const { tracker, binding, client } = fixture(cliId);
    tracker.input(client, '\r', binding, { enabled: true, ready: false, screen,
      readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, source)).toMatchObject({ requestedEffort: 'medium' });
  });

  it('does not treat an effort dialog in old output above a fresh composer as a current choice', () => {
    const { tracker, binding, client } = fixture('traex');
    tracker.input(client, '\r', binding, { enabled: true, ready: true,
      screen: 'Select Reasoning Level for GPT\n❯ 2. Medium\nenter confirm | esc go back\n❯ Ask anything',
      readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
  });

  it.each(['❯', '›'])('rejects old menu output above a fresh empty %s composer', cursor => {
    const { tracker, binding, client } = fixture('codex');
    tracker.input(client, '\r', binding, { enabled: true, ready: true,
      screen: `Select Reasoning Level for GPT\n› 2. Medium\nenter select · esc back\n${cursor}`,
      readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
  });

  it('keeps separate clients, cancellation, multiline prose and bracketed paste out of the intent path', () => {
    const { tracker, binding, client } = fixture();
    tracker.input(client, '/effort med', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    tracker.input({}, 'ium\r', binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
    expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    for (const input of ['/effort medium\r\x03', 'quoted /effort medium\r', '\x1b[200~/effort medium\x1b[201~\r', '/effort medium\nmore\n']) {
      tracker.reset(); tracker.observe({ binding, effort: 'high', atMs: NOW }, true, 'native-footer');
      tracker.input(client, input, binding, { enabled: true, ready: true, readPreference: () => '["high",null,null,null]' });
      expect(tracker.observe({ binding, effort: 'medium', atMs: NOW }, true, 'native-settings')).toBeUndefined();
    }
  });
});

describe('Claude native effort success receipts', () => {
  function native(content: string, extra: object = {}) {
    return { type: 'user', sessionId: 'native', timestamp: new Date(NOW).toISOString(), uuid: content.slice(0, 40), message: { content }, ...extra };
  }
  const command = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>';
  const success = '<local-command-stdout>Set effort level to medium (saved as your default for new sessions): Balanced</local-command-stdout>';
  it('accepts an actual local command and matching success receipt, including direct local TUI input', () => {
    const file = join(directory, 'native.jsonl');
    writeFileSync(file, [native(command), native(success)].map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(readClaudeEffortCommandReceipt(file, 'native', NOW - 1)).toMatchObject({ effort: 'medium', atMs: NOW });
  });
  it.each([
    [native(command), native('<local-command-stdout>Failed to set effort level</local-command-stdout>')],
    [native(command), native(success, { type: 'assistant' })],
    [native(command), native(success, { sessionId: 'other' })],
    [native('Example: ' + command), native(success)],
    [native(command), native('<local-command-stdout>CLAUDE_CODE_EFFORT_LEVEL overrides this session</local-command-stdout>')],
    [native(command), native(success.replace(/medium/g, 'high'))],
  ].map(records => ({ records })))('ignores failed, quoted, foreign or mismatched receipts (%j)', ({ records }) => {
    const file = join(directory, 'native.jsonl'); writeFileSync(file, records.map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(readClaudeEffortCommandReceipt(file, 'native', NOW - 1)).toBeUndefined();
  });
  it('does not replay a successful command from before the current CLI launch', () => {
    const file = join(directory, 'native.jsonl'); writeFileSync(file, [native(command), native(success)].map(x => JSON.stringify(x)).join('\n') + '\n');
    expect(readClaudeEffortCommandReceipt(file, 'native', NOW + 1)).toBeUndefined();
  });
});
