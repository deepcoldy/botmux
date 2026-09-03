import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import { t } from '../src/i18n/index.js';

/**
 * submit_unconfirmed 文案只钉「机器消费」的接缝：
 *   - key 在 zh/en 两份字典都存在；
 *   - worker 传给 t() 的插值参数（{cliName}/{transcriptLabel}/{preview}）
 *     在模板里必须仍然存在——参数被抽掉会在渲染时泄漏出裸 {param}；
 *   - 文案不再断言「没有到达模型的证据」（自动确认失败 ≠ 一定没执行）；
 *   - 文案与 worker 传入的 transcriptLabel 不再声称 JSONL 存储（OpenCode 查的是 SQLite）。
 * 不 pin 整段措辞。
 */

const UNCONFIRMED_KEYS = ['worker.submit_unconfirmed', 'worker.submit_unconfirmed_zmx'] as const;

const WORKER_PASSED_PARAMS = ['{cliName}', '{transcriptLabel}', '{preview}'] as const;

const OVERCLAIM_PHRASES = [
  '尚无请求到达模型的证据',
  'no evidence that the request reached the model',
  'There is no evidence that the request reached the model',
] as const;

describe('submit_unconfirmed wording seam', () => {
  it.each(UNCONFIRMED_KEYS)('both locales define %s', (key) => {
    expect(Object.prototype.hasOwnProperty.call(zhMessages, key)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(enMessages, key)).toBe(true);
    expect(zhMessages[key]).toBeTruthy();
    expect(enMessages[key]).toBeTruthy();
  });

  it.each(UNCONFIRMED_KEYS)('%s keeps every interpolation param the worker passes', (key) => {
    const zh = zhMessages[key];
    const en = enMessages[key];
    for (const param of WORKER_PASSED_PARAMS) {
      expect(zh).toContain(param);
      expect(en).toContain(param);
    }
  });

  it.each(UNCONFIRMED_KEYS)('%s no longer overclaims that the model never saw the message', (key) => {
    const zh = zhMessages[key];
    const en = enMessages[key];
    for (const phrase of OVERCLAIM_PHRASES) {
      expect(zh).not.toContain(phrase);
      expect(en).not.toContain(phrase);
    }
  });

  it.each(UNCONFIRMED_KEYS)('%s does not claim JSONL storage', (key) => {
    expect(zhMessages[key]).not.toContain('JSONL');
    expect(zhMessages[key]).not.toContain('jsonl');
    expect(enMessages[key]).not.toContain('JSONL');
    expect(enMessages[key]).not.toContain('jsonl');
  });

  it.each(UNCONFIRMED_KEYS)('%s does not assert elapsed time or a specific retry action', (key) => {
    expect(zhMessages[key]).not.toContain('{secs}');
    expect(enMessages[key]).not.toContain('{secs}');
    expect(zhMessages[key]).not.toContain('重试 Enter');
    expect(enMessages[key]).not.toContain('retried Enter');
  });

  it('worker passes a storage-agnostic transcriptLabel instead of 会话 JSONL', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain("'会话 JSONL'");
  });

  it('worker.transcriptLabel exists in both locales and is locale-appropriate', () => {
    expect(Object.prototype.hasOwnProperty.call(zhMessages, 'worker.transcriptLabel')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(enMessages, 'worker.transcriptLabel')).toBe(true);
    expect(zhMessages['worker.transcriptLabel']).toBeTruthy();
    expect(enMessages['worker.transcriptLabel']).toBeTruthy();
    // The English value must not leak CJK characters into the en template.
    expect(enMessages['worker.transcriptLabel']).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('renders en submit_unconfirmed templates without CJK when the label is localized', () => {
    const enLabel = t('worker.transcriptLabel', {}, 'en');
    for (const key of UNCONFIRMED_KEYS) {
      const rendered = t(key, { cliName: 'OpenCode', transcriptLabel: enLabel, preview: 'p' }, 'en');
      expect(rendered).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('renders zh submit_unconfirmed templates with the localized Chinese label', () => {
    const zhLabel = t('worker.transcriptLabel', {}, 'zh');
    expect(zhLabel).toContain('会话存储');
    for (const key of UNCONFIRMED_KEYS) {
      const rendered = t(key, { cliName: 'OpenCode', transcriptLabel: zhLabel, preview: 'p' }, 'zh');
      expect(rendered).toContain('会话存储');
    }
  });

  it('worker passes the localized transcriptLabel instead of hardcoded literals', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    // All four call sites must route through the i18n key rather than embedding
    // '会话存储' (zh) or 'submit history' (en) literals that bleed into the other
    // locale's template.
    expect(worker).not.toContain("'会话存储'");
    expect(worker).not.toContain("'submit history'");
    expect(worker).toContain("t('worker.transcriptLabel')");
  });
});
