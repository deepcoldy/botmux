import { describe, expect, it } from 'vitest';
import {
  BOTMUX_REDIRECT_URL,
  createOpenPlatformApiClient,
  writeRedirectWhitelist,
  type StoredCookie,
} from '../src/setup/open-platform-automation.js';

const APP_ID = 'cli_redirect_recovery';
const PLATFORM = 'https://m-fixture.example.com/oauth/callback';
const CUSTOM = 'https://custom.example.com/callback';
const WANTED = [BOTMUX_REDIRECT_URL, PLATFORM];

interface ConsoleState {
  urls: string[];
  writes: string[][];
  reads: number;
}

function consoleFixture(
  onWrite?: (state: ConsoleState, signal?: AbortSignal | null) => Response | Promise<Response> | undefined,
  onRead?: (state: ConsoleState) => Response | undefined,
) {
  const state = { urls: [CUSTOM], writes: [] as string[][], reads: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/app') return new Response('<script>window.csrfToken="fixture-csrf";</script>');
    if (path === `/developers/v1/safe_setting/${APP_ID}`) {
      state.reads++;
      const response = onRead?.(state);
      if (response) return response;
      return Response.json({ code: 0, data: { redirectURL: [...state.urls] } });
    }
    if (path === `/developers/v1/safe_setting/update/${APP_ID}`) {
      state.writes.push(JSON.parse(String(init?.body)).redirectURL);
      const response = await onWrite?.(state, init?.signal);
      if (response) return response;
      state.urls = [...state.writes.at(-1)!];
      return Response.json({ code: 0 });
    }
    throw new Error(`Unexpected console endpoint: ${path}`);
  }) as typeof fetch;
  const cookies: StoredCookie[] = [{
    name: 'session', value: 'fixture-only', domain: '.feishu.cn', path: '/',
    secure: true, httpOnly: true, hostOnly: false, expiresAt: Date.now() + 60_000,
  }];
  const client = async () => {
    const result = await createOpenPlatformApiClient(cookies, { fetchImpl });
    if (!result.ok) throw new Error(result.message);
    return result.client;
  };
  return { state, client };
}

describe('redirect whitelist recovery', () => {
  it('recovers from 10008 and preserves entries added after the first attempt', async () => {
    const added = 'https://added.example.com/callback';
    const fixture = consoleFixture(state => {
      if (state.writes.length !== 1) return;
      state.urls.push(added);
      return Response.json({ code: 10008, msg: '服务器内部错误' });
    });
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED);

    expect(result.status).toBe('updated');
    expect(fixture.state.writes).toHaveLength(2);
    expect(fixture.state.urls).toEqual([BOTMUX_REDIRECT_URL, CUSTOM, added, PLATFORM]);
    expect(result.redirectUrls).toEqual(fixture.state.urls);
  });

  it('reads back an ambiguous committed write instead of sending it twice', async () => {
    const fixture = consoleFixture(state => {
      state.urls = [...state.writes.at(-1)!];
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    });
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED);

    expect(result.status).toBe('updated');
    expect(result.redirectUrls).toEqual([BOTMUX_REDIRECT_URL, CUSTOM, PLATFORM]);
    expect(fixture.state.writes).toHaveLength(1);
  });

  it('does not retry a permission rejection', async () => {
    const fixture = consoleFixture(() => Response.json({ code: 10003, msg: 'not owned' }, { status: 403 }));
    const client = await fixture.client();

    await expect(writeRedirectWhitelist(client.postJson, APP_ID, WANTED)).rejects.toThrow('HTTP 403');

    expect(fixture.state.writes).toHaveLength(1);
  });

  it('verifies successful writes against the persisted whitelist', async () => {
    const fixture = consoleFixture();
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED);

    expect(fixture.state.reads).toBe(2);
    expect(result.redirectUrls).toEqual(fixture.state.urls);
  });

  it('recovers from a temporary HTTP 503', async () => {
    const fixture = consoleFixture(state => state.writes.length === 1
      ? Response.json({ code: 10008, msg: 'unavailable' }, { status: 503 })
      : undefined);
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED);

    expect(result.redirectUrls).toEqual([BOTMUX_REDIRECT_URL, CUSTOM, PLATFORM]);
    expect(fixture.state.writes).toHaveLength(2);
  });

  it('stops after three writes when the service keeps rejecting with 10008', async () => {
    const fixture = consoleFixture(() => Response.json({ code: 10008, msg: '服务器内部错误' }));
    const client = await fixture.client();

    await expect(writeRedirectWhitelist(client.postJson, APP_ID, WANTED)).rejects.toThrow('10008');

    expect(fixture.state.writes).toHaveLength(3);
    expect(fixture.state.urls).toEqual([CUSTOM]);
  });

  it('does not report a successful response as persisted when readback is incomplete', async () => {
    const fixture = consoleFixture(() => Response.json({ code: 0 }));
    const client = await fixture.client();

    await expect(writeRedirectWhitelist(client.postJson, APP_ID, WANTED)).rejects.toThrow('回读仍缺少地址');

    expect(fixture.state.writes).toHaveLength(3);
    expect(fixture.state.urls).toEqual([CUSTOM]);
  });

  it('does not blind-write during recovery when current entries cannot be read', async () => {
    const fixture = consoleFixture(
      () => Response.json({ code: 10008, msg: '服务器内部错误' }),
      state => state.reads > 1 ? Response.json({ code: 0, data: {} }) : undefined,
    );
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { allowBlindWrite: true });

    expect(result.status).toBe('skipped_unreadable');
    expect(fixture.state.writes).toHaveLength(1);
    expect(fixture.state.urls).toEqual([CUSTOM]);
  });

  const readReset = () => new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });

  it('re-reads after a transient read failure and merges with the entries it then sees (#2700)', async () => {
    const fixture = consoleFixture(undefined, state => {
      if (state.reads === 1) throw readReset();
      return undefined;
    });
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 4_000 });

    expect(result.status).toBe('updated');
    expect(fixture.state.writes).toEqual([[BOTMUX_REDIRECT_URL, CUSTOM, PLATFORM]]);
    expect(fixture.state.reads).toBe(3);
  });

  it('keeps zero writes when every read within the budget fails transiently', async () => {
    const fixture = consoleFixture(undefined, () => { throw readReset(); });
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 4_000 });

    expect(result).toMatchObject({ status: 'skipped_unreadable', redirectUrls: [] });
    expect(result).not.toHaveProperty('mutationSubmitted');
    expect(result.warning).toContain('本次未写入');
    expect(fixture.state.reads).toBe(3);
    expect(fixture.state.writes).toHaveLength(0);
  });

  it('returns the zero-write result instead of a timeout when the budget ends between re-reads', async () => {
    const fixture = consoleFixture(undefined, () => { throw readReset(); });
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 100 });

    expect(result.status).toBe('skipped_unreadable');
    expect(fixture.state.reads).toBe(1);
    expect(fixture.state.writes).toHaveLength(0);
  });

  it('does not re-read after a permission rejection on the read', async () => {
    const fixture = consoleFixture(undefined, () => Response.json({ code: 10003, msg: 'not owned' }, { status: 403 }));
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 4_000 });

    expect(result.status).toBe('skipped_unreadable');
    expect(fixture.state.reads).toBe(1);
    expect(fixture.state.writes).toHaveLength(0);
  });

  it('cancels a pending request at the deadline without scheduling another write', async () => {
    const fixture = consoleFixture((_state, signal) => new Promise<Response>((_resolve, reject) => {
      if (!signal) throw new Error('Expected a request cancellation signal');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const client = await fixture.client();

    await expect(writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 20 })).rejects.toThrow('超时');

    expect(fixture.state.writes).toHaveLength(1);
  });

  it('keeps reporting a write submitted after a re-read when the deadline hits while that write is in flight (#2700)', async () => {
    // 首轮读瞬态失败 → 退避后重读成功 → 合并写在途时 deadline 触发。
    // 已提交/结果未知的写绝不能被首轮缓存的「零写入」结果覆盖掉报告。
    const fixture = consoleFixture(
      (_state, signal) => new Promise<Response>((_resolve, reject) => {
        if (!signal) throw new Error('Expected a request cancellation signal');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      state => {
        if (state.reads === 1) throw readReset();
        return undefined;
      },
    );
    const client = await fixture.client();

    await expect(
      writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 600 }),
    ).rejects.toThrow('超时');

    expect(fixture.state.reads).toBe(2);
    expect(fixture.state.writes).toHaveLength(1);
  });

  it('stops retrying reads once a write has been submitted, keeping the submitted warning (#2700)', async () => {
    // 首轮读成功、写 ACK 因连接重置丢失（服务端已落地）→ 恢复轮读又遇瞬态失败。
    // 此时必须立即返回带 mutationSubmitted 的 skipped（再读没有信息增益），
    // 绝不能报成零写入，也不能再退避一轮去重读。
    const fixture = consoleFixture(
      state => {
        state.urls = [...state.writes.at(-1)!];
        throw readReset();
      },
      state => {
        if (state.reads >= 2) throw readReset();
        return undefined;
      },
    );
    const client = await fixture.client();

    const result = await writeRedirectWhitelist(client.postJson, APP_ID, WANTED, { timeoutMs: 4_000 });

    expect(result).toMatchObject({ status: 'skipped_unreadable', mutationSubmitted: true });
    expect(result.warning).toContain('已提交');
    expect(fixture.state.reads).toBe(2);
    expect(fixture.state.writes).toHaveLength(1);
  });
});
