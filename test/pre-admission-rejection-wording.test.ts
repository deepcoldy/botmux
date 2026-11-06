import { describe, expect, it } from 'vitest';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';

/**
 * 一条进队列之前就被拒收的消息，结局是**确定**的：它没有执行、没有副作用。
 * 这里只钉「机器消费」的接缝，不 pin 整段措辞：
 *   - key 在 zh/en 两份字典都存在；
 *   - worker-pool 传给 tr() 的插值参数（{turnId}/{reason}）在模板里仍存在；
 *   - 文案不再把一个确定结局说成「无法确认」，也不再叫用户别重发。
 */

const KEY = 'worker.input_rejected_before_admission';

const PARAMS = ['{turnId}', '{reason}'] as const;

const UNKNOWN_OUTCOME_PHRASES = [
  '无法确认',
  'could not confirm',
] as const;

const DO_NOT_RESEND_PHRASES = [
  '不要直接重发',
  'do not resend',
] as const;

describe('pre-admission rejection wording seam', () => {
  it('both locales define the key', () => {
    expect(Object.prototype.hasOwnProperty.call(zhMessages, KEY)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(enMessages, KEY)).toBe(true);
    expect(zhMessages[KEY]).toBeTruthy();
    expect(enMessages[KEY]).toBeTruthy();
  });

  it('keeps every interpolation param worker-pool passes', () => {
    for (const param of PARAMS) {
      expect(zhMessages[KEY]).toContain(param);
      expect(enMessages[KEY]).toContain(param);
    }
  });

  it('states a known outcome rather than an unconfirmed one', () => {
    for (const phrase of UNKNOWN_OUTCOME_PHRASES) {
      expect(zhMessages[KEY]).not.toContain(phrase);
      expect(enMessages[KEY]).not.toContain(phrase);
    }
  });

  it('does not tell the user to avoid resending a turn that provably never ran', () => {
    for (const phrase of DO_NOT_RESEND_PHRASES) {
      expect(zhMessages[KEY]).not.toContain(phrase);
      expect(enMessages[KEY]).not.toContain(phrase);
    }
  });

  it('the English value does not leak CJK', () => {
    expect(enMessages[KEY]).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('the ambiguous delivery-failure notice keeps its own wording', () => {
    // Guards against "fixing" this by softening the generic notice: a real
    // unconfirmed delivery must still say it cannot confirm the outcome.
    expect(zhMessages['worker.input_delivery_failed']).toContain('无法确认');
    expect(enMessages['worker.input_delivery_failed']).toContain('could not confirm');
  });
});
