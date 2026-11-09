/**
 * The recovery failure card (buildRecoveryFailedCard) and the error-code →
 * human-cause classification behind it. Asserted against the i18n dictionary
 * (never copied literals) and the button's wire value, which the click handler
 * reads.
 */
import { describe, expect, it } from 'vitest';
import { buildRecoveryFailedCard, type RecoveryFailedCardOpts } from '../src/im/lark/card-builder.js';
import { t } from '../src/i18n/index.js';
import { CODEX_CAPACITY_ERROR_CODE } from '../src/services/codex-transcript.js';
import {
  buildRecoveryRetryContent,
  recoveryCauseI18nKey,
  recoveryOutcomeI18nKey,
  recoveryRetryPermitted,
  userMessageExcerpt,
} from '../src/services/ordinary-recovery-notice.js';

function opts(over: Partial<RecoveryFailedCardOpts> = {}): RecoveryFailedCardOpts {
  return {
    rootId: 'om_root',
    sessionId: 'sess-1',
    cliId: 'claude-code',
    cliName: 'Claude',
    logicalTurnId: 'om_A',
    mentionOpenId: 'ou_asker',
    causeKey: recoveryCauseI18nKey('provider_server_error'),
    outcomeKey: recoveryOutcomeI18nKey({ errorCode: 'recovery_outcome_unverified', recoveryStatus: 'attention_required', continuations: 1 }),
    continuations: 1,
    errorCodes: ['provider_server_error', 'recovery_outcome_unverified'],
    task: '@Bot 私聊回复怎么都放进一个话题？',
    failedAt: new Date('2026-10-31T04:30:50.000Z'),
    retry: { kind: 'available' },
    terminalUrl: 'https://term.example/s/1',
    locale: 'zh',
    ...over,
  };
}

function render(over: Partial<RecoveryFailedCardOpts> = {}) {
  const card = JSON.parse(buildRecoveryFailedCard(opts(over)));
  const markdown = card.body?.elements ?? card.elements;
  const flat = JSON.stringify(card);
  const buttons = (markdown as any[]).filter(e => e.tag === 'action').flatMap(e => e.actions);
  return { card, flat, buttons, markdown: (markdown as any[]).filter(e => e.tag === 'markdown').map(e => e.content) };
}

describe('recovery failure card', () => {
  it('mentions the sender first and explains the cause in words, not raw provider text', () => {
    const { markdown } = render();
    expect(markdown[0].startsWith('<at id=ou_asker></at>')).toBe(true);
    expect(markdown[0]).toContain(t(recoveryCauseI18nKey('provider_server_error'), undefined, 'zh'));
    expect(markdown[0]).toContain('私聊回复怎么都放进一个话题');
  });

  it('pins the retry button to its logical turn and session', () => {
    const { buttons } = render();
    const retry = buttons.find(b => b.value?.action === 'retry_recovery_turn');
    expect(retry?.value).toMatchObject({
      action: 'retry_recovery_turn', logical_turn_id: 'om_A', session_id: 'sess-1', root_id: 'om_root',
    });
    expect(buttons.some(b => b.multi_url || b.url)).toBe(true);
  });

  it('after a retry shows who retried and offers no second button', () => {
    const { buttons, markdown } = render({ retry: { kind: 'retried', byOpenId: 'ou_admin', at: new Date('2026-10-31T10:12:00.000Z') } });
    expect(buttons.some(b => b.value?.action === 'retry_recovery_turn')).toBe(false);
    expect(markdown.join('\n')).toContain('<at id=ou_admin></at>');
  });

  it('without re-delivery material but pinned to the same failed turn keeps the admin continue button', () => {
    const { buttons } = render({ retry: { kind: 'continue_legacy', turnId: 'om_A' } });
    expect(buttons.some(b => b.value?.action === 'retry_recovery_turn')).toBe(false);
    expect(buttons.find(b => b.value?.action === 'retry_turn')?.value).toMatchObject({
      action: 'retry_turn', turn_id: 'om_A', mode: 'continue', session_id: 'sess-1',
    });
  });

  it('offers purge-and-continue for an image-poisoned ordinary recovery notice', () => {
    const { buttons } = render({ retry: { kind: 'purge_images', turnId: 'om_A' } });
    expect(buttons.some(b => b.value?.action === 'retry_recovery_turn')).toBe(false);
    expect(buttons.some(b => b.value?.action === 'retry_turn')).toBe(false);
    expect(buttons.find(b => b.value?.action === 'purge_images_continue')?.value).toMatchObject({
      action: 'purge_images_continue', turn_id: 'om_A', session_id: 'sess-1', root_id: 'om_root',
    });
  });

  it('without re-delivery material offers no retry button', () => {
    for (const reason of ['no_input', 'scheduled', 'unsupported'] as const) {
      const { buttons, markdown } = render({ retry: { kind: 'none', reason } });
      expect(buttons.some(b => b.value?.action === 'retry_recovery_turn')).toBe(false);
      expect(markdown.join('\n')).toContain(t(`card.recovery_failed.no_retry_${reason}`, undefined, 'zh'));
    }
  });
});

describe('cause classification', () => {
  it('gives distinct provider failures distinct human causes, and every key resolves in both locales', () => {
    const codes = [
      'provider_server_error', 'provider_unexpected_eof', 'provider_no_model_reply', 'provider_rate_limited',
      'provider_authentication_failed', 'provider_invalid_request', CODEX_CAPACITY_ERROR_CODE,
      'provider_image_too_small', 'recovery_outcome_unverified', 'recovery_restart_unverified', 'recovery_enqueue_failed',
      'recovery_persist_failed', 'recovery_disabled', 'something_new', undefined,
    ];
    const keys = codes.map(code => recoveryCauseI18nKey(code));
    for (const key of keys) {
      for (const locale of ['zh', 'en'] as const) expect(t(key, undefined, locale)).not.toBe(key);
    }
    // Network/DNS-type failures and quota are told apart from each other.
    expect(new Set(keys.slice(0, 8)).size).toBe(8);
    // An unknown code falls back to the generic sentence, never echoes itself.
    expect(t(recoveryCauseI18nKey('something_new'), undefined, 'zh')).not.toContain('something_new');
  });
});

describe('re-delivery content and permission', () => {
  it('prefixes the original envelope once, even when a retry is retried', () => {
    const envelope = '<user_message>\n@Bot 问题\n</user_message>';
    const once = buildRecoveryRetryContent(envelope);
    const twice = buildRecoveryRetryContent(once);
    expect(once.endsWith(envelope)).toBe(true);
    expect(twice).toBe(once);
    expect(userMessageExcerpt(once)).toBe('@Bot 问题');
  });

  // #2716: bare（transcript + solo）续轮没有 <user_message> 壳，恢复失败卡片
  // 走标签剥离兜底时，追加在正文后的格式提示块（含块体）不能出现在任务行。
  it('bare 续轮的 <botmux_formatting> 块体不进恢复卡片任务行', () => {
    const bare = '继续看一下这个 PR\n\n<botmux_formatting>短进度优先纯文本；强调仅包短词或无中文标点的短语，标点和后文放在 `**` 外。</botmux_formatting>';
    expect(userMessageExcerpt(bare)).toBe('继续看一下这个 PR');
  });

  it('allows the sender (while allowed to talk) and admins only', () => {
    const base = { operatorOpenId: 'ou_asker', initiatorOpenId: 'ou_asker', operatorIsAdmin: false, operatorCanTalk: true };
    expect(recoveryRetryPermitted(base)).toBe(true);
    expect(recoveryRetryPermitted({ ...base, operatorCanTalk: false })).toBe(false);
    expect(recoveryRetryPermitted({ ...base, operatorOpenId: 'ou_other' })).toBe(false);
    expect(recoveryRetryPermitted({ ...base, operatorOpenId: 'ou_admin', operatorIsAdmin: true, operatorCanTalk: false })).toBe(true);
    expect(recoveryRetryPermitted({ ...base, operatorOpenId: undefined })).toBe(false);
    expect(recoveryRetryPermitted({ ...base, initiatorOpenId: undefined })).toBe(false);
  });
});
