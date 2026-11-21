import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  automateOpenPlatformSetup,
  BOT_BASELINE_APP_EVENTS,
  BOT_BASELINE_CALLBACKS,
  BOT_OPTIONAL_APP_EVENTS,
  BOTMUX_REDIRECT_URL,
  VC_MEETING_APP_EVENTS,
  VC_MEETING_USER_EVENTS,
  createOpenPlatformApiClient,
  openPlatformUnderReview,
  writeRedirectWhitelist,
  writeStoredCookiesToSessionFile,
  type StoredCookie,
} from '../src/setup/open-platform-automation.js';
import { isRepairOpenPlatformRedirectsInFlight, repairOpenPlatformRedirects } from '../src/setup/open-platform-redirect-repair.js';
import type { BotConfig } from '../src/bot-registry.js';

const appId = 'cli_recovery_guards';
const custom = 'https://custom.example.com/callback';
const platform = 'https://platform.example.com/oauth/callback';
const wanted = [BOTMUX_REDIRECT_URL, platform];
const cookies = (): StoredCookie[] => [{
  name: 'session', value: 'fixture-only', domain: '.feishu.cn', path: '/',
  secure: true, httpOnly: true, hostOnly: false, expiresAt: Date.now() + 60_000,
}];
const resetError = () => new TypeError('fetch failed', {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
});

async function client(fetchImpl: typeof fetch) {
  const result = await createOpenPlatformApiClient(cookies(), { fetchImpl });
  if (!result.ok) throw new Error(result.message);
  return result.client;
}

describe('redirect recovery persistence guards', () => {
  it('retains submitted mutation metadata when recovery cannot read current state', async () => {
    let reads = 0;
    let writes = 0;
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        return Response.json({ code: 0 });
      }
      if (path.includes('/safe_setting/')) {
        reads++;
        if (reads === 1) return Response.json({ code: 0, data: { redirectURL: [custom] } });
        if (reads === 2) throw resetError();
        return Response.json({ code: 0, data: {} });
      }
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    const result = await writeRedirectWhitelist(api.postJson, appId, wanted);
    expect(result).toMatchObject({ status: 'skipped_unreadable', mutationSubmitted: true });
    expect(result.warning).not.toContain('本次未写入');
    expect(writes).toBe(1);
  });

  it('never carries the new-app blind-write grant into internal recovery attempts', async () => {
    let reads = 0;
    let writes = 0;
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        // ACK 丢失：可能已落地。随后每一轮恢复都必须重新读现值；读不回就零写入，
        // 绝不能把「本次刚建应用」的盲写许可延伸到第二次写入。
        throw resetError();
      }
      if (path.includes('/safe_setting/')) {
        reads++;
        throw resetError();
      }
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    const result = await writeRedirectWhitelist(api.postJson, appId, wanted, { allowBlindWrite: true });
    expect(result).toMatchObject({ status: 'skipped_unreadable', mutationSubmitted: true });
    expect(writes).toBe(1);
    expect(reads).toBe(2);
  });

  it('does not confirm success or rewrite when readback lost an original custom URL', async () => {
    let writes = 0;
    let reads = 0;
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        return Response.json({ code: 0 });
      }
      if (path.includes('/safe_setting/')) {
        return Response.json({ code: 0, data: { redirectURL: ++reads === 1 ? [custom] : wanted } });
      }
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    await expect(writeRedirectWhitelist(api.postJson, appId, wanted)).rejects.toThrow('自定义地址');
    expect(writes).toBe(1);
  });

  it('recovers a transient failure of the minimal fallback while preserving custom URLs', async () => {
    let urls = [custom];
    let fallbackAttempts = 0;
    let writes = 0;
    const api = await client((async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        const requested = JSON.parse(String(init?.body)).redirectURL as string[];
        if (requested.includes(platform)) return Response.json({ code: 1, msg: 'invalid redirect url' });
        if (++fallbackAttempts === 1) throw resetError();
        urls = [...requested];
        return Response.json({ code: 0 });
      }
      if (path.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: urls } });
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    const result = await writeRedirectWhitelist(api.postJson, appId, wanted);
    expect(result).toMatchObject({ status: 'updated_fallback', mutationSubmitted: true });
    expect(result.redirectUrls).toEqual(expect.arrayContaining([custom, BOTMUX_REDIRECT_URL]));
    expect(writes).toBe(4);
  });

  it('preserves the review-lock classification of a rejected minimal fallback', async () => {
    let writes = 0;
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        return ++writes === 1
          ? Response.json({ code: 1, msg: 'invalid redirect url' })
          : Response.json({ code: 10046, msg: '审核中, 请刷新' });
      }
      if (path.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [custom] } });
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    let error: unknown;
    try { await writeRedirectWhitelist(api.postJson, appId, wanted); } catch (err) { error = err; }
    expect(openPlatformUnderReview(error)).toBe(true);
    expect(writes).toBe(2);
  });

  it('honors the per-app deadline inside the batch and releases single-flight', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'redirect-app-deadline-'));
    const sessionFile = join(dir, 'session.json');
    writeStoredCookiesToSessionFile(sessionFile, cookies());
    let signal: AbortSignal | null | undefined;
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const fetchImpl = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (String(input) === 'https://ask.feishu.cn/') return new Response('ask home');
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        signal = init?.signal;
        reached();
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        });
      }
      if (path.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [custom] } });
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch;
    try {
      const pending = repairOpenPlatformRedirects({
        fetchImpl, sessionFilePath: sessionFile, collectWanted: () => wanted,
        loadBots: () => [{ larkAppId: appId, larkAppSecret: 'fixture', cliId: 'claude-code' } as BotConfig],
      });
      await started;
      await vi.advanceTimersByTimeAsync(15_100);
      const result = await pending;
      expect(signal?.aborted).toBe(true);
      expect(result).toMatchObject({ ok: true, results: [{ appId, status: 'failed' }] });
      expect(isRepairOpenPlatformRedirectsInFlight()).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rethrows preservation loss detected by a later recovery read', async () => {
    let reads = 0;
    let writes = 0;
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        return Response.json({ code: 0 });
      }
      if (path.includes('/safe_setting/')) {
        reads++;
        if (reads === 1) return Response.json({ code: 0, data: { redirectURL: [custom] } });
        if (reads === 2) throw resetError();
        return Response.json({ code: 0, data: { redirectURL: wanted } });
      }
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    await expect(writeRedirectWhitelist(api.postJson, appId, wanted)).rejects.toThrow('自定义地址');
    expect(writes).toBe(1);
  });

  it('batch cancellation stops an in-flight app write before its own later deadline', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'redirect-batch-cancel-'));
    const sessionFile = join(dir, 'session.json');
    writeStoredCookiesToSessionFile(sessionFile, cookies());
    let commits = 0;
    let signal: AbortSignal | null | undefined;
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const fetchImpl = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (String(input) === 'https://ask.feishu.cn/') return new Response('ask home');
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        signal = init?.signal;
        reached();
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => { commits++; resolve(Response.json({ code: 0 })); }, 100);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal?.reason); }, { once: true });
        });
      }
      if (path.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [custom] } });
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch;
    try {
      const pending = repairOpenPlatformRedirects({
        deadlineMs: 40, fetchImpl, sessionFilePath: sessionFile, collectWanted: () => wanted,
        loadBots: () => [{ larkAppId: appId, larkAppSecret: 'fixture', cliId: 'claude-code' } as BotConfig],
      });
      await started;
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(commits).toBe(0);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the total deadline also interrupts inner transport retry backoff', async () => {
    vi.useFakeTimers();
    let writes = 0;
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const api = await client((async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app') return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        writes++;
        reached();
        return new Promise<Response>((_resolve, reject) => setTimeout(() => reject(Object.assign(
          new Error('Client network socket disconnected before secure TLS connection was established'),
          { code: 'ECONNRESET' },
        )), 14_900));
      }
      if (path.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [custom] } });
      throw new Error('Unexpected fixture endpoint');
    }) as typeof fetch);
    let settled = false;
    const pending = writeRedirectWhitelist(api.postJson, appId, wanted).then(
      () => { settled = true; return null; },
      error => { settled = true; return error as Error; },
    );
    try {
      await started;
      // Bun's async timer shim drains one microtask turn, not the full fetch/catch chain.
      // Enter the retry backoff before crossing its enclosing deadline on either runtime.
      await vi.advanceTimersByTimeAsync(14_900);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(101);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(settled).toBe(true);
      expect((await pending)?.message).toContain('超时');
      expect(writes).toBe(1);
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
    }
  });

  it.each(['unreadable', 'exception'] as const)('a submitted mutation is published even after %s confirmation', async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'redirect-submission-publish-'));
    const sessionFile = join(dir, 'session.json');
    writeStoredCookiesToSessionFile(sessionFile, cookies());
    let urls = [custom];
    let reads = 0;
    let fault = true;
    let created = 0;
    let committed = false;
    const appEvents = [...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS, ...VC_MEETING_APP_EVENTS];
    const fetchImpl = (async (input, init) => {
      const href = String(input);
      const path = new URL(href).pathname;
      if (href === 'https://ask.feishu.cn/') return new Response('ask home');
      if (path.endsWith('/auth')) return new Response('<script>window.csrfToken="fixture"</script>');
      if (path.includes('/safe_setting/update/')) {
        urls = [...JSON.parse(String(init?.body)).redirectURL];
        return Response.json({ code: 0 });
      }
      if (path.includes('/safe_setting/')) {
        reads++;
        if (fault && reads === 2) throw mode === 'unreadable' ? resetError() : new Error('confirmation unavailable');
        if (fault && reads === 3 && mode === 'unreadable') return Response.json({ code: 0, data: {} });
        return Response.json({ code: 0, data: { redirectURL: urls } });
      }
      if (path.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (path.endsWith(`/event/${appId}`)) return Response.json({ code: 0, data: {
        eventMode: 4, events: [...appEvents, ...VC_MEETING_USER_EVENTS],
        appEventDetails: [{ items: appEvents.map(id => ({ id })) }],
        userEventDetails: [{ items: VC_MEETING_USER_EVENTS.map(id => ({ id })) }],
      } });
      if (path.endsWith(`/callback/${appId}`)) return Response.json({ code: 0, data: { callbackMode: 4, callbacks: [...BOT_BASELINE_CALLBACKS] } });
      if (path.includes('/visible/online/')) return Response.json({ code: 0, data: {
        whiteList: { departments: [], members: [], groups: [], isAll: 1 },
        blackList: { departments: [], members: [], groups: [], isAll: 0 },
      } });
      if (path.includes('/app_version/list/')) return Response.json({ code: 0, data: { versions: [
        { appVersion: '1.0.0', versionId: 'live', versionStatus: 2 },
        ...(created ? [{ appVersion: '1.0.1', versionId: 'created', versionStatus: committed ? 2 : 0 }] : []),
      ] } });
      if (path.includes('/app_version/create/')) {
        created++;
        return Response.json({ code: 0, data: { versionId: 'created' } });
      }
      if (path.includes('/publish/commit/')) committed = true;
      return Response.json({ code: 0 });
    }) as typeof fetch;
    const options = { appId, sessionFilePath: sessionFile, fetchImpl, disableQrLogin: true, disableBytedcliFallback: true,
      scopeManifest: { scopes: { tenant: [] as string[], user: [] as string[] } } };
    try {
      const first = await automateOpenPlatformSetup(options);
      expect(first.ok).toBe(true);
      expect(first.redirectConfigured).toBe(false);
      expect(first.ok && first.publishSkipped).not.toBe(true);
      expect(created).toBe(1);
      fault = false;
      const next = await automateOpenPlatformSetup(options);
      expect(next).toMatchObject({ ok: true, redirectConfigured: true, publishSkipped: true });
      expect(created).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
