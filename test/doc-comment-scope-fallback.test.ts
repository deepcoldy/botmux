import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), userToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: vi.fn(), getAllBots: () => [], loadBotConfigs: () => [],
  getBot: () => ({ config: { larkAppId: 'app-test', larkAppSecret: 'test-secret', brand: 'feishu' } }),
  getBotClient: () => ({ request: mocks.tenant }),
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: mocks.userToken }));
vi.mock('../src/services/doc-subs-store.js', async original => ({
  ...await original<Record<string, unknown>>(), getDocSubscription: () => undefined,
}));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { __testOnly_driveApiCall as driveApiCall, getDocComment } from '../src/im/lark/doc-comment.js';

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };
const COMMENT = 'comment-1';
const SCOPE_ERROR = { code: 99991679, msg: 'Required user privileges: [docs:document.comment:read]' };
const COMMENT_RESPONSE = {
  code: 0,
  data: { items: [{ comment_id: COMMENT, reply_list: { replies: [{
    reply_id: 'reply-1', user_id: 'ou_user',
    content: { elements: [{ type: 'text_run', text_run: { text: '请整理插件' } }] },
  }] } }] },
};

function userResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('document comment user-scope fallback', () => {
  beforeEach(() => {
    mocks.userToken.mockReset().mockResolvedValue('test-user-token');
    mocks.tenant.mockReset().mockResolvedValue(COMMENT_RESPONSE);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([400, 200])('reads the triggering comment through tenant identity after HTTP %s / 99991679', async status => {
    const fetch = vi.fn().mockResolvedValue(userResponse(status, SCOPE_ERROR));
    vi.stubGlobal('fetch', fetch);
    const onError = vi.fn();

    const comment = await getDocComment('app-test', FILE, COMMENT, { onError });

    expect(comment?.replies[0]).toMatchObject({ replyId: 'reply-1', text: '请整理插件' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.tenant).toHaveBeenCalledTimes(1);
    expect(mocks.tenant.mock.calls[0][0].url).toContain('/comments/batch_query');
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([400, 500])('keeps unrelated HTTP %s failures and their diagnostic instead of trying another identity', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(userResponse(status, { code: 123, msg: 'provider failure' })));
    const onError = vi.fn();

    await expect(getDocComment('app-test', FILE, COMMENT, { onError })).resolves.toBeNull();
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}: provider failure`));
  });

  it('does not downgrade a user-only write after a missing-scope rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(userResponse(400, SCOPE_ERROR)));
    const notDelivered = vi.fn();
    await expect(driveApiCall('app-test', {
      method: 'POST', path: '/open-apis/drive/v1/files/doc/comments',
      userOnly: true, providerRequestNotDelivered: notDelivered,
    })).rejects.toMatchObject({ larkCode: 99991679, httpStatus: 400 });
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(notDelivered).toHaveBeenCalledTimes(1);
  });

  it('reports the tenant rejection if neither identity can read the comment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(userResponse(400, SCOPE_ERROR)));
    mocks.tenant.mockResolvedValue({ code: 1069303, msg: 'Access denied' });
    const onError = vi.fn();
    await expect(getDocComment('app-test', FILE, COMMENT, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Access denied (code: 1069303)'));
  });

  it('keeps successful user reads on their original identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(userResponse(200, COMMENT_RESPONSE)));
    expect((await getDocComment('app-test', FILE, COMMENT))?.replies).toHaveLength(1);
    expect(mocks.tenant).not.toHaveBeenCalled();
  });

  it('also falls back when fetching replies needed to find the newly mentioned comment', async () => {
    const truncated = structuredClone(COMMENT_RESPONSE);
    Object.assign(truncated.data.items[0], { has_more: true });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(userResponse(200, truncated))
      .mockResolvedValueOnce(userResponse(400, SCOPE_ERROR)));
    mocks.tenant.mockResolvedValue({ code: 0, data: {
      items: [{ reply_id: 'reply-new', content: { elements: [{ text_run: { text: '继续处理' } }] } }],
      has_more: false,
    } });
    const comment = await getDocComment('app-test', FILE, COMMENT);
    expect(comment?.replies.map(reply => reply.replyId)).toContain('reply-new');
    expect(mocks.tenant.mock.calls[0][0].url).toContain(`/comments/${COMMENT}/replies`);
  });

  it('keeps the null-return contract when a diagnostic sink throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    await expect(getDocComment('app-test', FILE, COMMENT, {
      onError: () => { throw new Error('diagnostic unavailable'); },
    })).resolves.toBeNull();
  });
});
