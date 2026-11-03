/**
 * Unit tests for the brand-aware OAuth authorize URL built by user-token.ts.
 *
 * generateAuthUrl is pure (no network) — it only assembles the authorize URL
 * and stashes pending state — so we can assert the host switches by brand.
 *
 * Run:  pnpm vitest run test/user-token-brand.test.ts
 */
import { describe, it, expect } from 'vitest';
import { generateAuthUrl, DOC_COMMENT_OAUTH_SCOPES } from '../src/utils/user-token.js';

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

describe('generateAuthUrl — 按需申请权限', () => {
  const baseScopes = ['im:message:readonly', 'im:resource', 'offline_access'];

  it.each(['feishu', 'lark'] as const)('%s 基础授权不依赖云文档权限', (brand) => {
    const { authUrl } = generateAuthUrl('cli_chat_only', 'secret', brand, [], 'ou_alice');
    // 应用只开通消息/资源权限时，任何额外文档 scope 都会让整个授权请求被拒绝。
    expect(new URL(authUrl).searchParams.get('scope')?.split(' ')).toEqual(baseScopes);
  });

  it.each(['docx:document:readonly', 'drive:drive.search:readonly'])('只追加显式请求的 %s', (scope) => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'feishu', [scope, scope, 'im:resource'], 'ou_alice');
    expect(new URL(authUrl).searchParams.get('scope')?.split(' ')).toEqual([...baseScopes, scope]);
  });

  it('文档订阅仍申请自己的专项权限，不附带云盘搜索或表格权限', () => {
    const { authUrl } = generateAuthUrl('cli_app', 'secret', 'feishu', DOC_COMMENT_OAUTH_SCOPES, 'ou_alice');
    expect(new URL(authUrl).searchParams.get('scope')?.split(' ')).toEqual([...baseScopes, ...DOC_COMMENT_OAUTH_SCOPES]);
  });
});
