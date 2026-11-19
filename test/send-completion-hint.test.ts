import { describe, expect, it } from 'vitest';
import { sendCompletionHintKey } from '../src/services/send-completion-hint.js';
import { t } from '../src/i18n/index.js';

describe('post-send completion guidance', () => {
  it.each(['zh', 'en'] as const)('every non-steer receipt resolves to its own catalog text (%s)', locale => {
    for (const unified of [false, true]) {
      for (const kind of ['progress', 'final', 'auxiliary'] as const) {
        const key = sendCompletionHintKey(kind, unified);
        expect(t(key, undefined, locale)).not.toBe(key);
      }
    }
  });

  it.each(['zh', 'en'] as const)('a plain progress receipt offers final delivery and a no-resend ending (%s)', locale => {
    // A plain send that already carried the full answer must be able to end
    // without a duplicate final; an acknowledgement must still be pointed at
    // --response-kind final.
    const hint = t(sendCompletionHintKey('progress', false), undefined, locale);
    expect(hint).toContain('--response-kind final');
    expect(hint).toContain('BOTMUX_NOTHING_TO_SEND');
  });

  it.each(['zh', 'en'] as const)('a supplement alone never invites ending; a final does (%s)', locale => {
    for (const unified of [false, true]) {
      expect(t(sendCompletionHintKey('auxiliary', unified), undefined, locale)).not.toContain('BOTMUX_NOTHING_TO_SEND');
      expect(t(sendCompletionHintKey('final', unified), undefined, locale)).toContain('BOTMUX_NOTHING_TO_SEND');
    }
  });

  it('progress on a unified reply card keeps the card receipt, distinct from a plain progress send', () => {
    expect(sendCompletionHintKey('progress', true)).toBe('ai.send.after_success_unified');
    expect(sendCompletionHintKey('progress', false)).toBe('ai.send.after_success_progress');
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
