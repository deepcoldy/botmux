/**
 * downloadResources only flags `needLogin` (→ the "/login" prompt) when the
 * User Token is genuinely missing or rejected (UserTokenMissingError) — NOT for
 * an ordinary download failure with a valid token. Regression for the false
 * "缺少 User Token，请 /login" prompt on forwarded card-images / cross-tenant
 * resources, which used to be triggered by a substring match on the error text.
 *
 * Run: pnpm vitest run test/download-resources-needlogin.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define the error class INSIDE the factory to avoid vi.mock hoisting issues;
// session-manager imports UserTokenMissingError from this same mocked module,
// so `instanceof` lines up across the test and the code under test.
vi.mock('../src/im/lark/client.js', () => {
  class UserTokenMissingError extends Error {
    constructor(message: string) { super(message); this.name = 'UserTokenMissingError'; }
  }
  return {
    listChatBotMembers: vi.fn(),
    downloadMessageResource: vi.fn(),
    UserTokenMissingError,
  };
});

import { downloadMessageResource, UserTokenMissingError } from '../src/im/lark/client.js';
import { downloadResources } from '../src/core/session-manager.js';

const img = { type: 'image' as const, key: 'k', name: 'k.jpg' };

describe('downloadResources — needLogin gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets needLogin when the token is genuinely missing/rejected', async () => {
    (downloadMessageResource as any).mockRejectedValue(new (UserTokenMissingError as any)('no token, send /login'));
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(attachments).toEqual([]);
    expect(needLogin).toBe(true);
  });

  it('does NOT set needLogin for a plain download failure with a valid token', async () => {
    // e.g. forwarded card image / cross-tenant resource that 4xx/5xx's even
    // though the token is valid — must NOT trigger a "/login" prompt.
    (downloadMessageResource as any).mockRejectedValue(new Error('Resource download failed: HTTP 403 forbidden'));
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(attachments).toEqual([]);
    expect(needLogin).toBe(false);
  });

  it('collects attachments and leaves needLogin false on success', async () => {
    (downloadMessageResource as any).mockResolvedValue(undefined);
    const { attachments, needLogin } = await downloadResources('app', 'om_1', [img]);
    expect(needLogin).toBe(false);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ type: 'image', name: 'k.jpg' });
  });
});
