import { describe, expect, it } from 'vitest';
import { describeSendFailure } from '../src/cli/send-dispatch.js';
import {
  LARK_CONTENT_AUDIT_ERROR_CODES,
  contentAuditSendRemediation,
  isLarkContentAuditError,
  larkErrorCode,
} from '../src/im/lark/content-audit.js';

function auditError(code: number, msg = 'contain sensitive data: EMAIL_ADDRESS') {
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: 'Request failed with status code 400',
    config: { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' },
    response: { status: 400, data: { code, msg, log_id: 'log-x' } },
  };
}

describe('lark content audit classification', () => {
  // Literal lock: a self-referential "iterate the set" test stays green if a
  // code is silently removed. Pin the exact membership; changes to the set must
  // touch this list.
  const EXPECTED_AUDIT_CODES = [11248, 11312, 18054, 230028];

  it('pins the exact audit/DLP code set (no silent adds or drops)', () => {
    expect([...LARK_CONTENT_AUDIT_ERROR_CODES].sort((a, b) => a - b))
      .toEqual(EXPECTED_AUDIT_CODES);
  });

  it('classifies every documented audit/DLP code as a permanent rejection', () => {
    for (const code of EXPECTED_AUDIT_CODES) {
      expect(isLarkContentAuditError(auditError(code))).toBe(true);
      expect(larkErrorCode(auditError(code))).toBe(code);
    }
  });

  it('tolerates the code carried directly on the error object', () => {
    expect(isLarkContentAuditError({ code: 230028 })).toBe(true);
  });

  it('recognizes the 2xx-body (code: NNN) message-tail shape', () => {
    // client.ts throws plain Errors with the business code only in the message
    // when HTTP is 200 but res.code !== 0 — no response.data, no .code field.
    const tail = new Error('some api failure (code: 230028)');
    expect(larkErrorCode(tail)).toBe(230028);
    expect(isLarkContentAuditError(tail)).toBe(true);
    expect(larkErrorCode(new Error('unrelated failure'))).toBeUndefined();
    expect(larkErrorCode(new Error('malformed (code: abc)'))).toBeUndefined();
  });

  it('does not misclassify transient or unrelated failures', () => {
    expect(isLarkContentAuditError(auditError(99991663))).toBe(false); // rate limit
    expect(isLarkContentAuditError({
      response: { status: 500, data: {} },
    })).toBe(false);
    expect(isLarkContentAuditError(new Error('network down'))).toBe(false);
    expect(isLarkContentAuditError(undefined)).toBe(false);
    expect(isLarkContentAuditError({ response: { data: { code: '230028' } } })).toBe(false);
  });

  it('gives botmux send an actionable remediation hint instead of the raw code only', () => {
    const described = describeSendFailure(auditError(230028));
    expect(described).toContain('code=230028');
    expect(described).toContain(contentAuditSendRemediation(230028));
    expect(described).toMatch(/不要直接重发|打码/);
  });

  it('leaves ordinary failures without the remediation tail', () => {
    const described = describeSendFailure(new Error('transient 1'));
    expect(described).toBe('transient 1');
    expect(described).not.toContain('内容安全审计');
  });
});

import { t as translate } from '../src/i18n/index.js';

describe('content audit notice i18n', () => {
  it('renders with code interpolation in both locales', () => {
    const zh = translate('worker.final_output_content_audit_blocked', { code: '230028' }, 'zh');
    const en = translate('worker.final_output_content_audit_blocked', { code: '230028' }, 'en');
    expect(zh).toContain('230028');
    expect(zh).not.toContain('{code}');
    expect(en).toContain('230028');
    expect(en).not.toContain('{code}');
    expect(zh).toMatch(/审计/);
    expect(en).toMatch(/audit/i);
  });
});
