/**
 * Unit tests for formatLarkError — condensing the Lark SDK's raw AxiosError into
 * a single triage line (status + code/msg/log_id) without leaking the bearer
 * token or dumping the stack/config blob.
 *
 * Run:  pnpm vitest run test/lark-error-format.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// bot-registry imports the Lark SDK at module load — stub it so the test needn't
// open real connections.
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {}, LoggerLevel: { error: 0 } }));

import { formatLarkError } from '../src/bot-registry.js';

describe('formatLarkError', () => {
  it('condenses an AxiosError with a Lark business error body to one line', () => {
    const err = {
      name: 'AxiosError',
      message: 'Request failed with status code 400',
      stack: 'AxiosError: ...long stack...',
      config: {
        method: 'patch',
        url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_xxx',
        headers: { Authorization: 'Bearer t-secretToken' },
      },
      status: 400,
      response: {
        status: 400,
        data: { code: 99991400, msg: 'request trigger frequency limit', log_id: 'LOG123' },
      },
    };
    const line = formatLarkError(err);
    expect(line).toBe('PATCH im/v1/messages/om_xxx → 400 code=99991400 "request trigger frequency limit" log_id=LOG123');
  });

  it('never leaks the bearer token or stack', () => {
    const err = {
      name: 'AxiosError',
      config: { method: 'get', url: 'https://open.feishu.cn/open-apis/contact/v3/users/ou_x', headers: { Authorization: 'Bearer t-leakme' } },
      status: 400,
      stack: 'secret stack frames',
    };
    const line = formatLarkError(err) ?? '';
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain('t-leakme');
    expect(line).not.toContain('secret stack');
    expect(line).toBe('GET contact/v3/users/ou_x → 400');
  });

  it('handles a status-only failure with no response body', () => {
    const err = {
      name: 'AxiosError',
      config: { method: 'get', url: 'https://open.feishu.cn/open-apis/contact/v3/users/ou_x' },
      status: 400,
    };
    expect(formatLarkError(err)).toBe('GET contact/v3/users/ou_x → 400');
  });

  it('detects axios shape via config+response even without name', () => {
    const err = {
      config: { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' },
      response: { status: 403, data: { code: 230002, msg: 'bot not in chat' } },
    };
    expect(formatLarkError(err)).toBe('POST im/v1/messages → 403 code=230002 "bot not in chat"');
  });

  it('returns null for non-axios values so callers fall back', () => {
    expect(formatLarkError('plain string')).toBeNull();
    expect(formatLarkError({ hello: 'world' })).toBeNull();
    expect(formatLarkError(null)).toBeNull();
    expect(formatLarkError(42)).toBeNull();
  });

  it('falls back gracefully when url is absent', () => {
    const err = { name: 'AxiosError', status: 500, response: { status: 500, data: { code: 1, msg: 'boom' } } };
    expect(formatLarkError(err)).toBe('→ 500 code=1 "boom"');
  });
});
