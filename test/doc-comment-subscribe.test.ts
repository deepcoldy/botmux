import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolveUserToken: vi.fn(),
  tenantRequest: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: vi.fn(),
  getAllBots: vi.fn(() => []),
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app-test',
      larkAppSecret: 'secret-test',
      brand: 'feishu',
    },
  })),
  getBotClient: vi.fn(() => ({ request: mocks.tenantRequest })),
  loadBotConfigs: vi.fn(() => []),
}));

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: mocks.resolveUserToken,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  DocSubscriptionPermissionError,
  subscribeDocFile,
} from '../src/im/lark/doc-comment.js';
import { UserTokenMissingError } from '../src/im/lark/client.js';

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('subscribeDocFile identity fallback', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue('user-token');
    mocks.tenantRequest.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('preserves user code 1069603 when tenant fallback also throws a generic 403', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));
    mocks.tenantRequest.mockRejectedValue({
      response: { status: 403, data: null },
      message: 'Request failed with status code 403',
    });

    let caught: unknown;
    try {
      await subscribeDocFile('app-test', FILE);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DocSubscriptionPermissionError);
    expect(caught).toMatchObject({
      larkCode: 1069603,
      source: 'user',
      details: {
        source: 'user',
        userLarkMessage: 'forbidden',
        tenantHttpStatus: 403,
      },
    });
    expect(caught).not.toBeInstanceOf(UserTokenMissingError);
    expect(mocks.tenantRequest).toHaveBeenCalledOnce();
  });

  it.each([401, 429, 500])(
    'preserves tenant HTTP %s instead of replacing it with user code 1069603',
    async (status) => {
      const tenantError = {
        response: { status, data: null },
        message: `Request failed with status code ${status}`,
      };
      mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));
      mocks.tenantRequest.mockRejectedValue(tenantError);

      await expect(subscribeDocFile('app-test', FILE)).rejects.toBe(tenantError);
    },
  );

  it('preserves a different tenant business error instead of replacing it with user code 1069603', async () => {
    const tenantError = {
      response: { status: 403, data: { code: 99991672, msg: 'tenant credential rejected' } },
      message: 'Request failed with status code 403',
    };
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));
    mocks.tenantRequest.mockRejectedValue(tenantError);

    await expect(subscribeDocFile('app-test', FILE)).rejects.toBe(tenantError);
  });

  it('keeps tenant fallback success when user lacks document management permission', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));
    mocks.tenantRequest.mockResolvedValue({ code: 0, msg: 'success', data: {} });

    await expect(subscribeDocFile('app-test', FILE)).resolves.toBeUndefined();
    expect(mocks.tenantRequest).toHaveBeenCalledOnce();
  });

  it('normalizes a tenant response body with code 1069603', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 99991672, msg: 'user credential rejected' }));
    mocks.tenantRequest.mockResolvedValue({ code: 1069603, msg: 'tenant forbidden' });

    await expect(subscribeDocFile('app-test', FILE)).rejects.toMatchObject({
      name: 'DocSubscriptionPermissionError',
      larkCode: 1069603,
      source: 'tenant',
      details: {
        source: 'tenant',
        userLarkMessage: 'user credential rejected',
        tenantLarkMessage: 'tenant forbidden',
      },
    });
  });

  it('preserves a different tenant response body when user returned code 1069603', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'forbidden' }));
    mocks.tenantRequest.mockResolvedValue({ code: 99991672, msg: 'tenant credential rejected' });

    await expect(subscribeDocFile('app-test', FILE)).rejects.toThrow(
      'tenant credential rejected (code: 99991672)',
    );
  });

  it('normalizes an Axios-shaped tenant error with code 1069603', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { msg: 'user forbidden' }));
    mocks.tenantRequest.mockRejectedValue({
      response: { status: 403, data: { code: 1069603, msg: 'tenant forbidden' } },
    });

    await expect(subscribeDocFile('app-test', FILE)).rejects.toMatchObject({
      name: 'DocSubscriptionPermissionError',
      larkCode: 1069603,
      source: 'tenant',
      details: {
        source: 'tenant',
        userLarkMessage: 'user forbidden',
        tenantLarkMessage: 'tenant forbidden',
        tenantHttpStatus: 403,
      },
    });
  });

  it('records both identities when user and tenant each return code 1069603', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(403, { code: 1069603, msg: 'user forbidden' }));
    mocks.tenantRequest.mockRejectedValue({
      response: { status: 403, data: { code: 1069603, msg: 'tenant forbidden' } },
    });

    await expect(subscribeDocFile('app-test', FILE)).rejects.toMatchObject({
      name: 'DocSubscriptionPermissionError',
      larkCode: 1069603,
      source: 'both',
      details: {
        source: 'both',
        userLarkMessage: 'user forbidden',
        tenantLarkMessage: 'tenant forbidden',
        tenantHttpStatus: 403,
      },
    });
  });

  it('falls back to tenant when user returns code 1069603 in a successful HTTP body', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { code: 1069603, msg: 'user forbidden' }));
    mocks.tenantRequest.mockResolvedValue({ code: 0, msg: 'success', data: {} });

    await expect(subscribeDocFile('app-test', FILE)).resolves.toBeUndefined();
    expect(mocks.tenantRequest).toHaveBeenCalledOnce();
  });

  it('does not hide user network or server failures behind tenant fallback', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(500, { code: 999, msg: 'server error' }));

    await expect(subscribeDocFile('app-test', FILE)).rejects.toThrow('HTTP 500');
    expect(mocks.tenantRequest).not.toHaveBeenCalled();
  });
});
