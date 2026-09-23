import { afterEach, describe, expect, it } from 'vitest';

import { setDefaultLocale } from '../src/i18n/index.js';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import {
  terminalStatusHtml,
  type TerminalStatusKind,
} from '../src/core/terminal-status-page.js';

const STATUS_KINDS: TerminalStatusKind[] = [
  'starting',
  'closed',
  'not-found',
  'forbidden',
  'unavailable',
];

const STATUS_KEYS = [
  'terminal.status.starting.title',
  'terminal.status.starting.detail',
  'terminal.status.closed.title',
  'terminal.status.closed.detail',
  'terminal.status.not_found.title',
  'terminal.status.not_found.detail',
  'terminal.status.forbidden.title',
  'terminal.status.forbidden.detail',
  'terminal.status.unavailable.title',
  'terminal.status.unavailable.detail',
];

afterEach(() => {
  setDefaultLocale('zh');
});

describe('terminalStatusHtml', () => {
  it('defines every terminal status key in both shipped dictionaries', () => {
    for (const key of STATUS_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(zhMessages, key), `missing zh key: ${key}`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(enMessages, key), `missing en key: ${key}`).toBe(true);
      expect(enMessages[key]).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('[defect-probing] renders every status in English when the worker locale is en', () => {
    setDefaultLocale('en');

    for (const kind of STATUS_KINDS) {
      const html = terminalStatusHtml(kind);
      expect(html).toContain('<html lang="en">');
      expect(html).not.toMatch(/[\u3400-\u9fff]/);
      expect(html).not.toContain('<button');
    }

    expect(terminalStatusHtml('forbidden')).toContain('Terminal link expired');
  });

  it('keeps the existing Chinese status copy and document language', () => {
    setDefaultLocale('zh');

    const html = terminalStatusHtml('forbidden');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('终端链接已失效');
    expect(html).not.toContain('<button');
  });

  it('leaves retry control to the user without polling the daemon', () => {
    setDefaultLocale('zh');
    const html = terminalStatusHtml('starting');

    expect(html).toContain('请稍后刷新页面或从最新卡片重新打开 Web 终端。');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('location.reload');
    expect(html).not.toContain('setTimeout');
  });
});
