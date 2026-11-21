/**
 * Under transcript delivery a Claude background-task wake turn's final is
 * forwarded to Lark, so the model must learn to stay silent on routine task
 * events. Claude Code is an injectsSessionContext adapter: its routing rules
 * reach the model only through `--append-system-prompt`, so that is where the
 * note is asserted. No other producer of the same system prompt, and no
 * shell-hints CLI, may change.
 */
import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createGeniusAdapter } from '../src/adapters/cli/genius.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createOhMyPiAdapter } from '../src/adapters/cli/oh-my-pi.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { t } from '../src/i18n/index.js';

function claudeSystemPrompt(locale: 'zh' | 'en', replyDelivery: 'send' | 'transcript'): string {
  const args = createClaudeCodeAdapter().buildArgs({
    sessionId: 's', resume: false, locale, botName: 'Bot', botOpenId: 'ou_x', replyDelivery, solo: false,
  });
  const at = args.indexOf('--append-system-prompt');
  expect(at).toBeGreaterThan(-1);
  return args[at + 1];
}

describe('Claude background-task note (transcript delivery)', () => {
  it.each(['zh', 'en'] as const)('reaches Claude Code through its real system prompt in transcript mode (%s)', locale => {
    const note = t('ai.claude.background_task_note_transcript', undefined, locale);
    expect(claudeSystemPrompt(locale, 'transcript')).toContain(note);
  });

  it.each(['zh', 'en'] as const)('is absent from Claude Code\'s send-mode system prompt (%s)', locale => {
    const note = t('ai.claude.background_task_note_transcript', undefined, locale);
    expect(claudeSystemPrompt(locale, 'send')).not.toContain(note);
  });

  // genius / grok / pi / oh-my-pi build the same system prompt text: none of
  // them may pick up the Claude-only line, in either delivery mode. Read from
  // what each adapter really hands its CLI.
  const base = { sessionId: 's', resume: false, botName: 'Bot', botOpenId: 'ou_x', solo: false };
  const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const OTHER_ADAPTERS: Array<[string, (opts: Record<string, unknown>) => string]> = [
    ['genius', opts => flagValue(createGeniusAdapter('/bin/genius').buildArgs({ ...base, ...opts } as any), '--append-system-prompt')],
    ['grok', opts => flagValue(createGrokAdapter('/bin/grok').buildArgs({ ...base, ...opts } as any), '--rules')],
    ['pi', opts => {
      const env: Record<string, string> = {};
      createPiAdapter('/bin/pi', () => '/tmp/boundary.js').buildArgs({ ...base, ...opts, env } as any);
      return env.BOTMUX_APPEND_SYSTEM_PROMPT;
    }],
    ['oh-my-pi', opts => {
      const env: Record<string, string> = {};
      createOhMyPiAdapter('/bin/omp', () => '/tmp/boundary.js').buildArgs({ ...base, ...opts, env } as any);
      return env.BOTMUX_APPEND_SYSTEM_PROMPT;
    }],
  ];
  for (const [name, systemPrompt] of OTHER_ADAPTERS) {
    it(`${name}'s real system prompt never carries the Claude-only note`, () => {
      for (const locale of ['zh', 'en'] as const) {
        for (const replyDelivery of ['send', 'transcript'] as const) {
          const prompt = systemPrompt({ locale, replyDelivery });
          expect(prompt).toContain('<botmux_routing>');
          expect(prompt).not.toContain(t('ai.claude.background_task_note_transcript', undefined, locale));
        }
      }
    });
  }

  const OTHER_PRODUCERS: CliId[] = ['genius', 'grok', 'pi', 'oh-my-pi'];
  for (const cliId of OTHER_PRODUCERS) {
    for (const replyDelivery of ['send', 'transcript'] as const) {
      it(`${cliId} (${replyDelivery}) renders the same system prompt as without a CLI-specific line`, () => {
        for (const locale of ['zh', 'en'] as const) {
          const opts = { locale, botName: 'Bot', botOpenId: 'ou_x', replyDelivery, solo: false };
          expect(buildBotmuxSystemPromptText({ ...opts, cliId }))
            .toBe(buildBotmuxSystemPromptText({ ...opts, cliId: undefined }));
        }
      });
    }
  }

  it('leaves the shell-hints path byte-identical for every CLI and mode', () => {
    for (const cliId of ['claude-code', 'codex'] as const) {
      for (const replyDelivery of ['send', 'transcript'] as const) {
        expect(buildBotmuxShellHints('zh', false, replyDelivery, cliId))
          .toEqual(buildBotmuxShellHints('zh', false, replyDelivery));
      }
    }
  });
});
