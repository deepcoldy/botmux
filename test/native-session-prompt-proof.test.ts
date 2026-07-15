import { describe, expect, it } from 'vitest';
import {
  claudeTranscriptEndsAtPrompt,
  codexTranscriptEndsAtPrompt,
  hasNativeSessionBusyMarker,
  hasNativeSessionIdleComposer,
} from '../src/services/native-session-prompt-proof.js';

describe('native session prompt proof', () => {
  it('proves Claude idle only after the latest meaningful turn duration', () => {
    const completed = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'system', subtype: 'turn_duration' },
    ];
    expect(claudeTranscriptEndsAtPrompt(completed)).toBe(true);
    expect(claudeTranscriptEndsAtPrompt([
      ...completed,
      { type: 'user', message: { role: 'user', content: 'long running turn' } },
    ])).toBe(false);
  });

  it('ignores Claude tool results and sidechain activity as turn starts', () => {
    expect(claudeTranscriptEndsAtPrompt([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'system', subtype: 'turn_duration' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent' } },
    ])).toBe(true);
  });

  it('proves Codex idle only when the normalized rollout ends in assistant_final', () => {
    const user = { uuid: 'u', timestampMs: 1, kind: 'user' as const, text: 'hello' };
    const final = { uuid: 'a', timestampMs: 2, kind: 'assistant_final' as const, text: 'done' };
    expect(codexTranscriptEndsAtPrompt([user])).toBe(false);
    expect(codexTranscriptEndsAtPrompt([user, final])).toBe(true);
  });

  it('vetoes the supported CLIs active-turn status lines', () => {
    expect(hasNativeSessionBusyMarker('Working… esc to interrupt')).toBe(true);
    expect(hasNativeSessionBusyMarker('\x1b[2mCtrl+C: cancel\x1b[0m')).toBe(true);
    expect(hasNativeSessionBusyMarker('100% context left')).toBe(false);
  });

  it('ignores busy-marker text in old viewport history above the active footer', () => {
    const oldHistory = Array.from({ length: 12 }, (_, index) => (
      index === 1 ? 'example output: esc to interrupt' : `historical row ${index}`
    ));
    expect(hasNativeSessionBusyMarker([...oldHistory, 'done', '❯'].join('\n'))).toBe(false);
    expect(hasNativeSessionBusyMarker([...oldHistory, 'Working… esc to interrupt', '❯'].join('\n'))).toBe(true);
  });

  it('does not classify final prose or a composer draft as an active-turn status', () => {
    expect(hasNativeSessionBusyMarker('Assistant answer: press esc to interrupt if needed\n❯')).toBe(false);
    expect(hasNativeSessionBusyMarker('❯ /rename press esc to interrupt safely')).toBe(false);
    expect(hasNativeSessionBusyMarker('› /rename Ctrl+C: cancel behavior')).toBe(false);
  });

  it('requires the supported CLI empty composer as positive keyboard-target proof', () => {
    expect(hasNativeSessionIdleComposer('\x1b[36m❯\x1b[0m  ', 'claude-code')).toBe(true);
    expect(hasNativeSessionIdleComposer('\x1b[36m❯\x1b[0m\u00a0', 'claude-code')).toBe(true);
    expect(hasNativeSessionIdleComposer('status\n  \x1b[36m›\x1b[0m', 'codex')).toBe(true);
    expect(hasNativeSessionIdleComposer(
      '\x1b[1m›\x1b[0m \x1b[2mUse /skills to list available skills\x1b[0m',
      'codex',
    )).toBe(true);
    expect(hasNativeSessionIdleComposer('❯ draft message', 'claude-code')).toBe(false);
    expect(hasNativeSessionIdleComposer('❯\u00a0draft message', 'claude-code')).toBe(false);
    expect(hasNativeSessionIdleComposer('› /rename draft', 'codex')).toBe(false);
    expect(hasNativeSessionIdleComposer('\x1b[1m›\x1b[0m draft text', 'codex')).toBe(false);
    expect(hasNativeSessionIdleComposer('\x1b[1m›\x1b[0m \x1b[2;22mdraft text\x1b[0m', 'codex')).toBe(false);
    expect(hasNativeSessionIdleComposer('› \x1b[38;5;2m[x] activity\x1b[0m', 'codex')).toBe(false);
    expect(hasNativeSessionIdleComposer('› \x1b[38;2;200;200;200mdraft text\x1b[0m', 'codex')).toBe(false);
  });

  it('rejects picker cursors even when an older bare prompt remains on screen', () => {
    expect(hasNativeSessionIdleComposer('❯\nSelect model\n❯ 1. Opus\n  2. Sonnet', 'claude-code')).toBe(false);
    expect(hasNativeSessionIdleComposer('›\nSelect model and effort\n› 1. gpt-5.4\n  2. gpt-5.3', 'codex')).toBe(false);
    expect(hasNativeSessionIdleComposer(
      '›\n\x1b[2m> \x1b[0m\n› [x] activity  Spinner while working',
      'codex',
    )).toBe(false);
    expect(hasNativeSessionIdleComposer(
      'permission modal\nHint: press › \x1b[2mUse /skills to continue\x1b[0m',
      'codex',
    )).toBe(false);
  });
});
