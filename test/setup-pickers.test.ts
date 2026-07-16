import { describe, expect, it } from 'vitest';
import { computeViewportTop, pickChoice, truncateToWidth } from '../src/setup/interactive-select.js';
import {
  createOpenPlatformAppWithClient,
  listOpenPlatformApps,
  fetchOpenPlatformAppSecret,
  nextAppVersion,
  OpenPlatformApiError,
  type OpenPlatformApiClient,
} from '../src/setup/open-platform-automation.js';

/** 假 readline：按队列吐答案，队列空了回空串（模拟 stdin 关闭 / EIO 兜底）。 */
function fakeRl(answers: string[]) {
  return {
    question(_q: string, cb: (answer: string) => void) {
      cb(answers.shift() ?? '');
    },
  } as any;
}

// vitest 进程的 stdin/stdout 不是 TTY，pickChoice 走「序号文本输入」回退分支。
describe('pickChoice non-TTY fallback', () => {
  const ITEMS = [{ label: '甲' }, { label: '乙', hint: 'b' }, { label: '丙' }];

  it('returns the default index on empty input', async () => {
    expect(await pickChoice(fakeRl(['']), { title: 't', items: ITEMS, defaultIndex: 1 })).toBe(1);
  });

  it('returns null on empty input without a default', async () => {
    expect(await pickChoice(fakeRl(['']), { title: 't', items: ITEMS })).toBe(null);
  });

  it('parses a 1-based number into a 0-based index', async () => {
    expect(await pickChoice(fakeRl(['3']), { title: 't', items: ITEMS, defaultIndex: 0 })).toBe(2);
  });

  it('re-asks on invalid input until a valid pick, and falls back to default when input dries up', async () => {
    expect(await pickChoice(fakeRl(['9', 'abc', '2']), { title: 't', items: ITEMS, defaultIndex: 0 })).toBe(1);
    // 无效输入后 stdin 干涸（后续恒空串）→ 回默认值而不是死循环
    expect(await pickChoice(fakeRl(['9']), { title: 't', items: ITEMS, defaultIndex: 2 })).toBe(2);
  });

  it('returns null for an empty item list', async () => {
    expect(await pickChoice(fakeRl(['1']), { title: 't', items: [] })).toBe(null);
  });
});

describe('computeViewportTop (长列表视口滚动)', () => {
  it('keeps everything at 0 when the list fits', () => {
    expect(computeViewportTop(5, 0, 8, 10)).toBe(0);
    expect(computeViewportTop(7, 3, 8, 10)).toBe(0);
  });

  it('scrolls down to keep the cursor visible and clamps at the end', () => {
    expect(computeViewportTop(0, 0, 40, 10)).toBe(0);
    expect(computeViewportTop(10, 0, 40, 10)).toBe(1);   // 光标越过窗口底部 → 下移一行
    expect(computeViewportTop(39, 25, 40, 10)).toBe(30); // 尾部 clamp
  });

  it('scrolls up when the cursor wraps back above the window', () => {
    expect(computeViewportTop(0, 30, 40, 10)).toBe(0);   // 底部 wrap 回顶部
    expect(computeViewportTop(29, 30, 40, 10)).toBe(29);
  });
});

describe('truncateToWidth', () => {
  it('keeps short strings and truncates long ones with an ellipsis', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc');
    expect(truncateToWidth('abcdefghij', 6)).toBe('abcde…');
  });

  it('counts CJK as double width', () => {
    expect(truncateToWidth('机器人列表', 10)).toBe('机器人列表'); // 宽 10 恰好放下
    expect(truncateToWidth('机器人列表很长', 8)).toBe('机器人…');
  });
});

function stubClient(responses: unknown[] | ((path: string, body: unknown) => unknown)): OpenPlatformApiClient & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  // 镜像真实 client:业务错误码(code!==0)会抛 OpenPlatformApiError,而不是把
  // 错误响应当正常返回值——否则 catch 分支永远测不到。
  const throwIfError = (resp: unknown) => {
    const r = resp as { code?: unknown; msg?: unknown };
    if (r && typeof r === 'object' && typeof r.code === 'number' && r.code !== 0) {
      throw new OpenPlatformApiError(`code=${r.code} msg=${r.msg ?? ''}`, resp);
    }
    return resp;
  };
  return {
    apiOrigin: 'https://open.feishu.cn',
    calls,
    async postJson(path: string, body?: unknown) {
      calls.push({ path, body });
      return throwIfError(queue ? queue.shift() : (responses as (p: string, b: unknown) => unknown)(path, body));
    },
    async postForm(path: string, body: FormData) {
      calls.push({ path, body });
      return throwIfError(queue ? queue.shift() : (responses as (p: string, b: unknown) => unknown)(path, body));
    },
  };
}

describe('listOpenPlatformApps', () => {
  it('parses apps with lenient field names and drops non-cli_ entries', async () => {
    const client = stubClient([{
      code: 0,
      data: {
        apps: [
          { clientId: 'cli_a', name: 'Bot A', description: 'desc' },
          { appId: 'cli_b', appName: 'Bot B' },
          { clientId: 'xx_bad', name: 'nope' },
          { name: 'no-id' },
        ],
        totalCount: 4,
      },
    }]);
    const apps = await listOpenPlatformApps(client);
    expect(apps).toEqual([
      { clientId: 'cli_a', name: 'Bot A', description: 'desc' },
      { clientId: 'cli_b', name: 'Bot B' },
    ]);
    expect(client.calls[0]).toEqual({
      path: '/developers/v1/app/list',
      body: { Count: 100, Cursor: 0, QueryFilter: {} },
    });
  });

  it('pages with Cursor until totalCount is covered', async () => {
    const client = stubClient([
      { code: 0, data: { apps: [{ clientId: 'cli_1', name: '1' }, { clientId: 'cli_2', name: '2' }], totalCount: 3 } },
      { code: 0, data: { apps: [{ clientId: 'cli_3', name: '3' }], totalCount: 3 } },
    ]);
    const apps = await listOpenPlatformApps(client, { pageSize: 2 });
    expect(apps.map(a => a.clientId)).toEqual(['cli_1', 'cli_2', 'cli_3']);
    expect(client.calls.map(c => (c.body as any).Cursor)).toEqual([0, 2]);
  });

  it('stops on a short page even without totalCount', async () => {
    const client = stubClient([
      { code: 0, data: { apps: [{ clientId: 'cli_1', name: '1' }] } },
    ]);
    const apps = await listOpenPlatformApps(client, { pageSize: 2 });
    expect(apps).toHaveLength(1);
    expect(client.calls).toHaveLength(1);
  });
});

describe('fetchOpenPlatformAppSecret', () => {
  it('reads data.secret via the read-only secret endpoint', async () => {
    const client = stubClient([{ code: 0, data: { secret: 's3cret' } }]);
    await expect(fetchOpenPlatformAppSecret(client, 'cli_a')).resolves.toBe('s3cret');
    expect(client.calls[0].path).toBe('/developers/v1/secret/cli_a');
  });

  it('throws when the response has no secret field', async () => {
    const client = stubClient([{ code: 0, data: {} }]);
    await expect(fetchOpenPlatformAppSecret(client, 'cli_a')).rejects.toThrow(/secret/);
  });
});

describe('createOpenPlatformAppWithClient', () => {
  it('uploads the icon, creates via template, publishes an enabling version, then reads its secret', async () => {
    const client = stubClient([
      { code: 0, data: { url: 'https://cdn.example/botmux.png' } }, // upload/image
      { code: 0, data: { ClientID: 'cli_new' } },                  // upsert_by_template
      { code: 0 },                                                 // robot/switch
      { code: 0 },                                                 // event/switch
      { code: 0, data: { versionId: 'v-init' } },                  // app_version/create（启用发布）
      { code: 0 },                                                 // publish/commit
      { code: 0, data: { secret: 'new-secret' } },                 // secret
    ]);

    await expect(createOpenPlatformAppWithClient(client, { name: 'botmux-2', creatorUserId: 'u_creator' })).resolves.toEqual({
      appId: 'cli_new',
      appSecret: 'new-secret',
    });

    expect(client.calls.map(call => call.path)).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/robot/switch/cli_new',
      '/developers/v1/event/switch/cli_new',
      '/developers/v1/app_version/create/cli_new',
      '/developers/v1/publish/commit/cli_new/v-init',
      '/developers/v1/secret/cli_new',
    ]);
    const upload = client.calls[0].body as FormData;
    expect(upload.get('uploadType')).toBe('4');
    expect(upload.get('isIsv')).toBe('false');
    expect(upload.get('scale')).toBe(JSON.stringify({ width: 512, height: 512 }));
    expect(client.calls[1].body).toMatchObject({
      appManifestTemplateID: 'developer_console',
      createAppUserCustomField: {
        i18n: { zh_cn: { name: 'botmux-2' } },
        avatar: 'https://cdn.example/botmux.png',
        primaryLang: 'zh_cn',
      },
    });
    expect(client.calls[2].body).toEqual({ clientId: 'cli_new', enable: true });
    expect(client.calls[3].body).toEqual({ clientId: 'cli_new', eventMode: 4 });
    // 启用发布用极简版本 payload,可见成员含创建者(否则发布后不自动上架启用)
    expect(client.calls[4].body).toMatchObject({
      appVersion: '1.0.0',
      visibleSuggest: { members: ['u_creator'], isAll: 0 },
      pcDefaultAbility: 'bot',
      mobileDefaultAbility: 'bot',
    });
    expect(client.calls[4].body).not.toHaveProperty('applyReasonConfig');
    expect(client.calls[5].body).toEqual({ clientId: 'cli_new' });
  });

  it('fails closed (with appId) when the enabling publish commit fails — no silent orphan', async () => {
    const client = stubClient([
      { code: 0, data: { url: 'https://cdn.example/botmux.png' } },
      { code: 0, data: { ClientID: 'cli_commit_fail' } },
      { code: 0 },
      { code: 0 },
      { code: 0, data: { versionId: 'v-init' } }, // 版本创建成功
      { code: 1, msg: 'publish commit rejected' }, // commit 失败 → 抛
    ]);
    await expect(createOpenPlatformAppWithClient(client, { name: 'botmux-cf', creatorUserId: 'u_creator' }))
      .rejects.toMatchObject({ appId: 'cli_commit_fail' });
    // 不再有 soft 兜底:走到 publish/commit 就抛,不读 secret
    expect(client.calls.map(c => c.path)).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/robot/switch/cli_commit_fail',
      '/developers/v1/event/switch/cli_commit_fail',
      '/developers/v1/app_version/create/cli_commit_fail',
      '/developers/v1/publish/commit/cli_commit_fail/v-init',
    ]);
  });

  it('fails closed (with appId) when the enabling version create returns no versionId (outcome unknown)', async () => {
    const client = stubClient([
      { code: 0, data: { url: 'https://cdn.example/botmux.png' } },
      { code: 0, data: { ClientID: 'cli_noverid' } },
      { code: 0 },
      { code: 0 },
      { code: 0, data: {} }, // code=0 但没 versionId → 可能留下未发布草稿
    ]);
    await expect(createOpenPlatformAppWithClient(client, { name: 'botmux-nv', creatorUserId: 'u_creator' }))
      .rejects.toMatchObject({ appId: 'cli_noverid' });
    // 没 versionId → 不 commit、不读 secret
    expect(client.calls.some(c => c.path.includes('/publish/commit/'))).toBe(false);
    expect(client.calls.some(c => c.path.includes('/secret/'))).toBe(false);
  });

  it('retains the created app id in the error when secret reading fails', async () => {
    const client = stubClient([
      { code: 0, data: { url: 'https://cdn.example/botmux.png' } },
      { code: 0, data: { ClientID: 'cli_orphan_guard' } },
      { code: 0 },
      { code: 0 },
      { code: 0, data: { versionId: 'v-init' } },
      { code: 0 },
      { code: 0, data: {} }, // secret 缺失
    ]);
    await expect(createOpenPlatformAppWithClient(client, { name: 'botmux-3', creatorUserId: 'u_creator' }))
      .rejects.toThrow(/cli_orphan_guard.*AppSecret/);
  });
});

describe('nextAppVersion', () => {
  it('increments the patch of the highest PUBLISHED version', () => {
    expect(nextAppVersion({ data: { versions: [
      { appVersion: '1.0.0', versionStatus: 2 },
      { appVersion: '1.0.1', versionStatus: 2 },
    ] } })).toBe('1.0.2');
  });

  it('starts at 0.0.1 when there are no versions', () => {
    expect(nextAppVersion({ data: { versions: [] } })).toBe('0.0.1');
  });

  it('accounts for UNPUBLISHED draft versions so the next number never collides', () => {
    // 上架启用发布若留下未发布草稿 1.0.0(status 1),二次发版必须算 1.0.1 而非
    // 0.0.1——否则平台按「版本号未递增」拒掉,应用永远停在未启用。
    expect(nextAppVersion({ data: { versions: [
      { appVersion: '1.0.0', versionStatus: 1 },
    ] } })).toBe('1.0.1');
    expect(nextAppVersion({ data: { versions: [
      { appVersion: '2.3.4', versionStatus: 1 },
      { appVersion: '1.0.0', versionStatus: 2 },
    ] } })).toBe('2.3.5');
  });
});
