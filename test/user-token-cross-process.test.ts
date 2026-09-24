import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('user-token pending OAuth state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of ['user-token-cli_cross_process.json', 'user-token-cli_cross_process-ou_cross_process.json']) {
      try { unlinkSync(join(homedir(), '.botmux', 'data', name)); } catch { /* absent */ }
    }
  });

  it('can finish a Dashboard-created flow from a fresh daemon module instance', async () => {
    const first = await import('../src/utils/user-token.js');
    const { authUrl } = first.generateAuthUrl('cli_cross_process', 'secret', 'feishu', ['im:feed_group_v1:read']);
    const authorize = new URL(authUrl);
    const state = authorize.searchParams.get('state');
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    vi.resetModules();
    // Two upstream calls now: the code→token exchange, then a user_info read-back
    // that establishes WHOSE token this is. The second call is what lets storage
    // be keyed per person; without it a token has no provable owner.
    const stubbedFetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/authen/v1/user_info')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { open_id: 'ou_cross_process', name: '跨进程测试用户' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        access_token: 'u-cross-process',
        refresh_token: 'r-cross-process',
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_token_expires_in: 2_592_000,
        scope: 'im:feed_group_v1:read offline_access',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stubbedFetch);

    const fresh = await import('../src/utils/user-token.js');
    await expect(fresh.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=test-code&state=${state}`))
      .resolves.toContain('授权成功');
    expect(stubbedFetch).toHaveBeenCalledTimes(2);
  });
});
