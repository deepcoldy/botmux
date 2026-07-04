import { describe, expect, it } from 'vitest';
import { computeViewportTop, pickChoice, truncateToWidth } from '../src/setup/interactive-select.js';
import {
  listOpenPlatformApps,
  fetchOpenPlatformAppSecret,
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
  return {
    apiOrigin: 'https://open.feishu.cn',
    calls,
    async postJson(path: string, body?: unknown) {
      calls.push({ path, body });
      return queue ? queue.shift() : (responses as (p: string, b: unknown) => unknown)(path, body);
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
