/**
 * 回归（维护者复审 P1-A）：文档评论轮询熔断必须在 listDocComments 的**真实错误
 * 形态**下触发。doc-comment 的两个错误类没有 axios `response` 包装——HTTP 状态
 * 挂自身 `httpStatus`、业务码挂 `larkCode`，message 用全角括号；提取器若只读
 * response.status，删除/失权会全部判 transient，熔断主功能永不触发（5s 空转到死）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolveUserToken: vi.fn(),
  tenantRequest: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app-test', larkAppSecret: 'secret-test', brand: 'feishu' },
  })),
  getBotClient: vi.fn(() => ({ request: mocks.tenantRequest })),
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: mocks.resolveUserToken }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { listDocComments } from '../src/im/lark/doc-comment.js';
import { classifyLarkError } from '../src/im/lark/error-classify.js';
import { ListenerCircuitBreaker } from '../src/services/listener-circuit-breaker.js';

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

/** 按 daemon pollWatchedDocComments 的接线方式：读列表错误→分类→计永久失败。 */
async function recordReadAttempt(cb: ListenerCircuitBreaker): Promise<'permanent' | 'transient'> {
  try {
    await listDocComments('app-test', FILE);
    cb.recordSuccess('f');
    return 'transient';
  } catch (err) {
    const classified = classifyLarkError(err);
    if (classified.classification === 'permanent') cb.recordPermanent('f');
    return classified.classification;
  }
}

describe('listDocComments real error surfaces open the circuit', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue('user-token');
    mocks.tenantRequest.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterAll(() => vi.unstubAllGlobals());

  it('deleted document: DocProviderRejectedError (custom httpStatus field) is permanent and opens after 3 reads', async () => {
    mocks.tenantRequest.mockRejectedValue({ response: { status: 404, data: { code: 1254404 } } });
    mocks.fetch.mockResolvedValue(jsonResponse(404, { code: 1254404, msg: 'not found' }));
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 3, probeIntervalMs: 1_000_000 });

    let caught: unknown;
    try { await listDocComments('app-test', FILE); } catch (e) { caught = e; }
    expect((caught as Error).name).toBe('DocProviderRejectedError');
    expect(classifyLarkError(caught).classification).toBe('permanent');

    expect(await recordReadAttempt(cb)).toBe('permanent');
    expect(await recordReadAttempt(cb)).toBe('permanent');
    expect(cb.stateFor('f')!.suspended).toBe(false);
    expect(await recordReadAttempt(cb)).toBe('permanent');
    expect(cb.stateFor('f')!.suspended).toBe(true);
  });

  it('revoked permission: UserTokenForbiddenError (larkCode 1069603 + httpStatus 403) is permanent', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 1069603, msg: 'forbidden' });
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));

    let caught: unknown;
    try { await listDocComments('app-test', FILE); } catch (e) { caught = e; }
    expect(classifyLarkError(caught).classification).toBe('permanent');
  });

  it('rate limit on the same read path stays transient and never opens the circuit', async () => {
    // 租户 200-body 限流码 / 用户侧 429 都是瞬时：读不到不代表文档永久失效。
    mocks.tenantRequest.mockResolvedValue({ code: 99991400, msg: 'frequency limited' });
    mocks.fetch.mockResolvedValue(jsonResponse(429, { code: 99991400, msg: 'rate limited' }));
    const cb = new ListenerCircuitBreaker({ permanentThreshold: 3 });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await recordReadAttempt(cb)).toBe('transient');
    }
    expect(cb.stateFor('f')).toBeUndefined();
  });
});
