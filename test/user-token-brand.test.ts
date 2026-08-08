/**
 * Unit tests for the brand-aware OAuth authorize URL built by user-token.ts.
 *
 * generateAuthUrl is pure (no network) — it only assembles the authorize URL
 * and stashes pending state — so we can assert the host switches by brand.
 *
 * Run:  pnpm vitest run test/user-token-brand.test.ts
 */
import { describe, it, expect } from 'vitest';
import { generateAuthUrl } from '../src/utils/user-token.js';

describe('generateAuthUrl — brand-aware authorize host', () => {
  it('defaults to the feishu accounts host', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret');
    expect(authUrl.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?')).toBe(true);
    expect(authUrl).toContain('client_id=cli_app');
  });

  it('uses the lark accounts host for international tenants', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'lark');
    expect(authUrl.startsWith('https://accounts.larksuite.com/open-apis/authen/v1/authorize?')).toBe(true);
    expect(authUrl).toContain('client_id=cli_app');
  });

  it('still uses the feishu host when brand is explicitly feishu', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'feishu');
    expect(authUrl).toContain('accounts.feishu.cn');
    expect(authUrl).not.toContain('larksuite.com');
  });

  it('keeps feed-group scopes out of the generic login URL', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'lark');
    const scopes = new URL(authUrl).searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).not.toContain('im:feed_group_v1:read');
    expect(scopes).not.toContain('im:feed_group_v1:write');
  });

  it('includes feed-group scopes when the caller explicitly requests them', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'feishu', [
      'im:feed_group_v1:read',
      'im:feed_group_v1:write',
    ]);
    const scopes = new URL(authUrl).searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).toContain('im:feed_group_v1:read');
    expect(scopes).toContain('im:feed_group_v1:write');
  });
});
