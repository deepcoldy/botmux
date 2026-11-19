import { describe, expect, it } from 'vitest';
import { classifyLarkError, extractLarkErrorShape } from '../src/im/lark/error-classify.js';

describe('classifyLarkError', () => {
  it('classifies axios HTTP 400 with response.data.code 230002 as permanent (the 19-day incident)', () => {
    const err = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { code: 230002, msg: 'Bot/User can NOT be out of the chat.' } },
    };
    const e = classifyLarkError(err);
    expect(e.classification).toBe('permanent');
    expect(e.larkCode).toBe(230002);
    expect(e.httpStatus).toBe(400);
  });

  it('classifies business-error Error with code in message text', () => {
    const e = classifyLarkError(new Error('Failed to list chat messages: bad (code: 230002)'));
    expect(e.classification).toBe('permanent');
    expect(e.larkCode).toBe(230002);
  });

  it('treats 429/5xx as transient', () => {
    expect(classifyLarkError({ response: { status: 429 } }).classification).toBe('transient');
    expect(classifyLarkError({ response: { status: 503, data: {} } }).classification).toBe('transient');
  });

  it('classifies 403/404/410 as permanent but 401 as transient (app-level credential, not per-target)', () => {
    expect(classifyLarkError({ response: { status: 403 } }).classification).toBe('permanent');
    expect(classifyLarkError({ response: { status: 404 } }).classification).toBe('permanent');
    expect(classifyLarkError({ response: { status: 410 } }).classification).toBe('permanent');
    expect(classifyLarkError({ response: { status: 401 } }).classification).toBe('transient');
  });

  it('never treats the repo-established rate-limit codes as permanent (regression: they were mis-copied into the permanent table)', () => {
    // 230020 = LARK_CODE_CHAT_RATE_LIMITED, 99991400 = LARK_CODE_FREQUENCY_LIMITED
    for (const code of [230020, 99991400]) {
      expect(classifyLarkError(new Error(`rate limited (code: ${code})`)).classification).toBe('transient');
      expect(classifyLarkError({ response: { status: 400, data: { code } } }).classification).toBe('transient');
    }
    // 99991663 is context-sensitive (rate limit / credential) — never per-target permanent
    expect(classifyLarkError(new Error('(code: 99991663)')).classification).toBe('transient');
    // 其它瞬时代码
    for (const code of [99991661, 99991662, 99991401, 99991500]) {
      expect(classifyLarkError(new Error(`(code: ${code})`)).classification).toBe('transient');
    }
  });

  it('treats unknown errors as transient (fail-safe, never over-circuits)', () => {
    expect(classifyLarkError(new Error('ECONNRESET weird thing')).classification).toBe('transient');
    expect(classifyLarkError({ response: { status: 400, data: {} } }).classification).toBe('transient');
  });

  it('reads junk input without throwing', () => {
    expect(extractLarkErrorShape(null).message).toBe('null');
    expect(extractLarkErrorShape('string error').message).toBe('string error');
  });
});

/**
 * doc-comment 真实错误类形态（字段定义见 src/im/lark/doc-comment.ts）：
 * 它们没有 axios 的 `response` 包装——HTTP 状态挂在自身 `httpStatus`、业务码
 * 挂在 `larkCode`，且 message 用全角括号（ASCII 正则提不到）。
 * 历史缺陷：提取器只读 response.status，导致文档删除/失权在熔断分类里全部
 * 被判 transient，文档轮询熔断主功能永不触发。
 */
describe('classifyLarkError on doc-comment real error shapes', () => {
  it('DocProviderRejectedError-shaped (deleted doc, custom httpStatus field) is permanent', () => {
    const err = {
      name: 'DocProviderRejectedError',
      message: 'drive API /open-apis/drive/v1/files/x/comments HTTP 404: not found',
      httpStatus: 404,
    };
    const shape = extractLarkErrorShape(err);
    expect(shape.httpStatus).toBe(404);
    expect(classifyLarkError(err).classification).toBe('permanent');
  });

  it('DocProviderRejectedError-shaped HTTP 403 (revoked) is permanent', () => {
    const err = { name: 'DocProviderRejectedError', message: 'HTTP 403', httpStatus: 403 };
    expect(classifyLarkError(err).classification).toBe('permanent');
  });

  it('UserTokenForbiddenError-shaped (larkCode field, full-width parens in message) is permanent via 1069603', () => {
    const err = {
      name: 'UserTokenForbiddenError',
      message: 'User Token 无权访问该文档（HTTP 403, code: 1069603）。',
      httpStatus: 403,
      larkCode: 1069603,
    };
    const shape = extractLarkErrorShape(err);
    expect(shape.larkCode).toBe(1069603);
    expect(shape.httpStatus).toBe(403);
    expect(classifyLarkError(err).classification).toBe('permanent');
  });

  it('DocSubscriptionPermissionError-shaped (larkCode 1069603 without httpStatus) is permanent by code', () => {
    const err = {
      name: 'DocSubscriptionPermissionError',
      message: '订阅文档被飞书拒绝（code: 1069603, source: both）。',
      larkCode: 1069603,
    };
    expect(extractLarkErrorShape(err).larkCode).toBe(1069603);
    expect(classifyLarkError(err).classification).toBe('permanent');
  });

  it('DocProviderRejectedError-shaped HTTP 500 stays transient', () => {
    const err = { name: 'DocProviderRejectedError', message: 'HTTP 500', httpStatus: 500 };
    expect(classifyLarkError(err).classification).toBe('transient');
  });
});
