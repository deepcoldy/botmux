import { describe, expect, it } from 'vitest';
import { sendCompletionHintKey } from '../src/services/send-completion-hint.js';
import { t } from '../src/i18n/index.js';

describe('post-send completion guidance', () => {
  it.each([false, true])('only acknowledged final delivery permits ending (unified=%s)', unified => {
    for (const locale of ['zh', 'en'] as const) {
      for (const kind of ['progress', 'auxiliary'] as const) {
        const hint = t(sendCompletionHintKey(kind, unified), undefined, locale);
        expect(hint).not.toContain('BOTMUX_NOTHING_TO_SEND');
        expect(hint).not.toBe(sendCompletionHintKey(kind, unified));
      }
      expect(t(sendCompletionHintKey('progress', unified), undefined, locale)).toContain('--response-kind final');
      expect(t(sendCompletionHintKey('final', unified), undefined, locale)).toContain('BOTMUX_NOTHING_TO_SEND');
    }
  });

  it.each(['progress', 'final', 'auxiliary'] as const)('prioritizes a promoted successor after %s', kind => {
    for (const unified of [false, true]) {
      expect(sendCompletionHintKey(kind, unified, 'next-turn')).toBe('ai.send.after_success_steer_advanced');
    }
  });

  it.each(['zh', 'en'] as const)('opening, inline and hook followups carry the same delivery requirement (%s)', locale => {
    for (const key of ['ai.shell.when_to_send', 'ai.followup.reminder', 'ai.followup.reminder_hook',
      'ai.followup.reminder_no_resend', 'ai.routing.no_visible_output_ok', 'ai.shell.no_visible_output_ok'] as const) {
      expect(t(key, undefined, locale)).toContain('--response-kind final');
    }
  });
});
