/**
 * deleteMessage 的 boolean 契约：只有 Lark 确认成功才返回 true；
 * SDK 抛错或非 0 code 返回 false（grant 撤回兜底依赖这个真实行为）。
 * Run: pnpm vitest run test/delete-message.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { deleteMessage } from '../src/im/lark/client.js';

function setDeleteImpl(appId: string, impl: () => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { message: { delete: impl } } } } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('deleteMessage boolean contract', () => {
  it('returns true when Lark confirms (code 0)', async () => {
    setDeleteImpl('d1', async () => ({ code: 0, msg: 'success' }));
    expect(await deleteMessage('d1', 'om_x')).toBe(true);
  });

  it('returns true when response has no code field (treated as success)', async () => {
    setDeleteImpl('d1b', async () => ({}));
    expect(await deleteMessage('d1b', 'om_x')).toBe(true);
  });

  it('returns false on non-zero code (e.g. recall window passed)', async () => {
    setDeleteImpl('d2', async () => ({ code: 230002, msg: 'cannot recall' }));
    expect(await deleteMessage('d2', 'om_x')).toBe(false);
  });

  it('returns false when the SDK throws', async () => {
    setDeleteImpl('d3', async () => { throw new Error('network'); });
    expect(await deleteMessage('d3', 'om_x')).toBe(false);
  });
});
