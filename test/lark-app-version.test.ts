import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeMissingUserScopes,
  lookupAppVersionReview,
  parseLatestAppVersionReview,
  reviewHoldsScopes,
} from '../src/utils/lark-app-version.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// 形状取自真实应用的 `app_versions?order=0` 只读响应（字段裁剪过）：最新一条是
// 「Scope Authorization」自动生成、停在审核中（status=3）的版本。
const IN_REVIEW_PAYLOAD = {
  code: 0,
  msg: 'success',
  data: {
    has_more: true,
    page_token: 'next',
    items: [{
      app_id: 'cli_review', version: '1.0.11', version_id: 'oav_pending', status: 3,
      create_time: '1795410691', remark: { update_remark: 'Scope Authorization' },
      scopes: [{ scope: 'im:resource', token_types: ['user', 'tenant'] }],
    }],
  },
};

describe('parseLatestAppVersionReview', () => {
  it('reports the latest version as in review with its x.y.z version', () => {
    expect(parseLatestAppVersionReview(IN_REVIEW_PAYLOAD)).toEqual({
      state: 'in_review', version: '1.0.11', versionId: 'oav_pending', userScopes: ['im:resource'],
    });
  });

  it.each([
    [1, 'online'],
    [2, 'rejected'],
    [4, 'draft'],
  ])('does not call status %s (%s) a pending review', status => {
    const payload = { code: 0, data: { items: [{ version: '1.0.10', status }] } };
    expect(parseLatestAppVersionReview(payload)).toEqual({ state: 'not_in_review', version: '1.0.10', status });
  });

  it('only looks at the newest version', () => {
    const payload = { code: 0, data: { items: [{ version: '1.0.12', status: 1 }, { version: '1.0.11', status: 3 }] } };
    expect(parseLatestAppVersionReview(payload).state).toBe('not_in_review');
  });

  it('keeps only user-identity scopes of the pending version (untyped entries count as both)', () => {
    const payload = { code: 0, data: { items: [{ version: '1.0.11', status: 3, scopes: [
      { scope: 'im:resource', token_types: ['tenant'] },
      { scope: 'docx:document:create', token_types: ['user', 'tenant'] },
      { scope: 'im:feed.flag:read' },
    ] }] } };
    expect(parseLatestAppVersionReview(payload)).toMatchObject({ userScopes: ['docx:document:create', 'im:feed.flag:read'] });
    // 接口没给权限列表：无从核对，不臆造空列表。
    expect(parseLatestAppVersionReview({ code: 0, data: { items: [{ version: '1.0.11', status: 3 }] } }))
      .not.toHaveProperty('userScopes');
  });

  it('treats an app without versions as not in review', () => {
    expect(parseLatestAppVersionReview({ code: 0, data: { items: [] } })).toEqual({ state: 'not_in_review' });
  });

  it.each([
    [{ code: 99991672, msg: 'scope not applied' }],
    [{ code: 0, data: {} }],
    [{ code: 0, data: { items: [{ version: '1.0.1' }] } }],
    [null],
  ])('returns unknown for an unusable response %#', payload => {
    expect(parseLatestAppVersionReview(payload).state).toBe('unknown');
  });
});

describe('lookupAppVersionReview', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the newest version with the app\'s own tenant token', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        expect(JSON.parse(String(init?.body))).toEqual({ app_id: 'cli_review', app_secret: 'secret' });
        return json({ code: 0, tenant_access_token: 't-token' });
      }
      return json(IN_REVIEW_PAYLOAD);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookupAppVersionReview('cli_review', 'secret', 'lark')).resolves.toMatchObject({
      state: 'in_review', version: '1.0.11',
    });
    const [versionsUrl, versionsInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const url = new URL(versionsUrl);
    expect(url.origin).toBe('https://open.larksuite.com');
    expect(url.pathname).toBe('/open-apis/application/v6/applications/cli_review/app_versions');
    // order=0 = 按创建时间倒序：第一条才是最新版本。
    expect(url.searchParams.get('order')).toBe('0');
    expect((versionsInit.headers as Record<string, string>).Authorization).toBe('Bearer t-token');
  });

  it.each([
    ['tenant token refused', async () => json({ code: 10003, msg: 'invalid app' })],
    ['network failure', async () => { throw new TypeError('fetch failed'); }],
  ])('never throws: %s → unknown', async (_label, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    await expect(lookupAppVersionReview('cli_review', 'secret', 'feishu')).resolves.toMatchObject({ state: 'unknown' });
  });

  it('gives up within its budget instead of holding the caller', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    await expect(lookupAppVersionReview('cli_review', 'secret', 'feishu', { budgetMs: 10 }))
      .resolves.toEqual({ state: 'unknown', reason: 'timeout' });
  });
});

describe('reviewHoldsScopes', () => {
  const review = { state: 'in_review', version: '1.0.11', userScopes: ['im:feed.flag:read'] } as const;
  it('only blames the review when the pending version carries a missing scope', () => {
    expect(reviewHoldsScopes(review, ['im:feed.flag:read', 'docx:document:create'])).toBe(true);
    expect(reviewHoldsScopes(review, ['docx:document:create'])).toBe(false);
    expect(reviewHoldsScopes({ state: 'in_review', version: '1.0.11' }, ['docx:document:create'])).toBe(true);
    expect(reviewHoldsScopes({ state: 'not_in_review' }, ['docx:document:create'])).toBe(false);
  });
});

describe('describeMissingUserScopes', () => {
  const missing = ['docs:document.comment:delete', 'im:feed.flag:read'];

  it.each(['zh', 'en'] as const)('names every missing scope and the version under review (%s)', locale => {
    const text = describeMissingUserScopes(missing, { state: 'in_review', version: '1.0.11' }, locale);
    for (const scope of missing) expect(text).toContain(scope);
    expect(text).toContain('1.0.11');
  });

  it('falls back to just the missing scopes when the version state is unknown', () => {
    const inReview = describeMissingUserScopes(missing, { state: 'in_review', version: '1.0.11' }, 'zh');
    const plain = describeMissingUserScopes(missing, undefined, 'zh');
    for (const scope of missing) expect(plain).toContain(scope);
    // 查不到版本状态 / 确认不在审核中时，都只列缺失权限，不能沿用「在审核中」那句说明。
    expect(plain).not.toBe(inReview);
    for (const review of [{ state: 'unknown', reason: 'x' } as const, { state: 'not_in_review', version: '1.0.10' } as const]) {
      expect(describeMissingUserScopes(missing, review, 'zh')).toBe(plain);
    }
  });

  it('does not blame a pending version that has nothing to do with the missing scopes', () => {
    const plain = describeMissingUserScopes(missing, undefined, 'zh');
    const unrelated = { state: 'in_review', version: '1.0.11', userScopes: ['contact:user.base:readonly'] } as const;
    expect(describeMissingUserScopes(missing, unrelated, 'zh')).toBe(plain);
  });

  it('points out missing scopes that approval would still not grant', () => {
    const partial = { state: 'in_review', version: '1.0.11', userScopes: ['im:feed.flag:read'] } as const;
    const full = { state: 'in_review', version: '1.0.11', userScopes: missing } as const;
    const partialText = describeMissingUserScopes(missing, partial, 'zh');
    const fullText = describeMissingUserScopes(missing, full, 'zh');
    expect(partialText).toContain('1.0.11');
    expect(partialText.startsWith(fullText)).toBe(true);
    expect(partialText.slice(fullText.length)).toContain('docs:document.comment:delete');
    expect(partialText.slice(fullText.length)).not.toContain('im:feed.flag:read');
  });
});
