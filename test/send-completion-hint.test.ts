import { describe, expect, it } from 'vitest';
import { REPLY_DELIVERY_ENV, replyDeliveryFromEnv, sendCompletionHintKey } from '../src/services/send-completion-hint.js';
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

  describe('transcript sessions (final reply forwarded by botmux)', () => {
    it.each(['zh', 'en'] as const)('every receipt resolves to catalog text (%s)', locale => {
      for (const unified of [false, true]) {
        for (const kind of ['progress', 'final', 'auxiliary'] as const) {
          for (const advanced of [undefined, 'next-turn']) {
            const key = sendCompletionHintKey(kind, unified, advanced, 'transcript');
            expect(t(key, undefined, locale)).not.toBe(key);
          }
        }
      }
    });

    it.each(['zh', 'en'] as const)('a progress receipt points back at the final reply instead of another final send (%s)', locale => {
      for (const unified of [false, true]) {
        const hint = t(sendCompletionHintKey('progress', unified, undefined, 'transcript'), undefined, locale);
        expect(hint).not.toContain('--response-kind final');
        expect(sendCompletionHintKey('progress', unified, undefined, 'transcript'))
          .not.toBe(sendCompletionHintKey('progress', unified));
      }
      // A plain send that already carried the whole answer must be able to end
      // without the transcript final posting it a second time.
      expect(t(sendCompletionHintKey('progress', false, undefined, 'transcript'), undefined, locale))
        .toContain('BOTMUX_NOTHING_TO_SEND');
    });

    it.each(['zh', 'en'] as const)('a supplement still never invites ending (%s)', locale => {
      for (const unified of [false, true]) {
        expect(t(sendCompletionHintKey('auxiliary', unified, undefined, 'transcript'), undefined, locale))
          .not.toContain('BOTMUX_NOTHING_TO_SEND');
      }
    });

    it('a declared final keeps the shared receipt: its marker retires the transcript final in both modes', () => {
      for (const unified of [false, true]) {
        expect(sendCompletionHintKey('final', unified, undefined, 'transcript')).toBe('ai.send.after_success_hint');
      }
    });

    it.each(['progress', 'final', 'auxiliary'] as const)('a promoted successor after %s is answered in the final reply', kind => {
      expect(sendCompletionHintKey(kind, false, 'next-turn', 'transcript')).toBe('ai.send.after_success_steer_advanced_transcript');
    });

    it('reads the spawn snapshot strictly: only an exact transcript value switches the wording', () => {
      expect(replyDeliveryFromEnv({ [REPLY_DELIVERY_ENV]: 'transcript' })).toBe('transcript');
      for (const value of [undefined, '', 'send', 'TRANSCRIPT', 'transcript ']) {
        expect(replyDeliveryFromEnv(value === undefined ? {} : { [REPLY_DELIVERY_ENV]: value })).toBe('send');
      }
    });
  });

  it.each(['zh', 'en'] as const)('opening, inline and hook followups carry the same delivery requirement (%s)', locale => {
    for (const key of ['ai.shell.when_to_send', 'ai.followup.reminder', 'ai.followup.reminder_hook',
      'ai.followup.reminder_no_resend', 'ai.routing.no_visible_output_ok', 'ai.shell.no_visible_output_ok'] as const) {
      expect(t(key, undefined, locale)).toContain('--response-kind final');
    }
  });
});
