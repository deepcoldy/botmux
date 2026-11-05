/**
 * Under transcript delivery a Claude background-task wake turn's final is
 * forwarded to Lark, so the model must learn to stay silent on routine task
 * events. The note rides the only channel that reaches the model
 * (buildBotmuxShellHints) and must not change any other CLI or send mode.
 */
import { describe, expect, it } from 'vitest';
import { buildBotmuxShellHints } from '../src/adapters/cli/shared-hints.js';
import { t } from '../src/i18n/index.js';

describe('Claude background-task note (transcript delivery)', () => {
  it.each(['zh', 'en'] as const)('reaches Claude Code in transcript mode (%s)', locale => {
    const note = t('ai.claude.background_task_note_transcript', undefined, locale);
    const hints = buildBotmuxShellHints(locale, false, 'transcript', 'claude-code');
    expect(hints.some(line => line.includes(note.slice(0, 20)))).toBe(true);
  });

  it('leaves send mode and other CLIs byte-identical', () => {
    expect(buildBotmuxShellHints('zh', false, 'send', 'claude-code'))
      .toEqual(buildBotmuxShellHints('zh', false, 'send'));
    expect(buildBotmuxShellHints('zh', false, 'transcript', 'codex'))
      .toEqual(buildBotmuxShellHints('zh', false, 'transcript'));
  });
});
