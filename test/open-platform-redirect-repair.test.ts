/**
 * 批量修复开放平台 redirect 白名单（`repairOpenPlatformRedirects`）。
 *
 * Run: pnpm vitest run test/open-platform-redirect-repair.test.ts
 *
 * 注入缝走 `prepareSession` / `clientFactory` / `loadBots` / `collectWanted`，不碰
 * 真实网络与 `~/.botmux`。唯一的例外是「AbortSignal 接到底」那条用例：它必须跑默认
 * 工厂那条真实链路，所以改用注入的 `fetchImpl` + 临时目录里的 session 文件，同样不出网。
 *
 * ⚠️ 409 那一跳（`reason:'in_flight'` → HTTP 409 `repair_in_flight`）**没有**路由层
 * 用例：`src/dashboard.ts` 是入口脚本而不是可导入模块（顶层 `await registry.start()`、
 * `oauthCallbackServer.listen(9768)`、`server.listen`），import 进测试会真的起服务、
 * 抢端口；全仓 40+ 个 `dashboard-*.test.ts` 也没有任何一个 import 它。所以并发保护
 * 本身放在 service 侧做成可测的 `in_flight` 返回值（见下方用例），路由只剩一行把它
 * 翻成 409 的纯映射。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import {
  OpenPlatformApiError,
  writeStoredCookiesToSessionFile,
  type OpenPlatformApiClient,
  type StoredCookie,
} from '../src/setup/open-platform-automation.js';
import {
  isRepairOpenPlatformRedirectsInFlight,
  repairOpenPlatformRedirects,
  type RedirectRepairItem,
} from '../src/setup/open-platform-redirect-repair.js';

const LOOPBACK = 'http://127.0.0.1:9768/callback';
const PLATFORM = 'https://m-abc.example.com/oauth/callback';
const WANTED = [LOOPBACK, PLATFORM];

function bot(larkAppId: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return { larkAppId, larkAppSecret: 'secret', cliId: 'claude', ...overrides } as BotConfig;
}

function cookies(): StoredCookie[] {
  return [{
    name: 'session', value: 'v', domain: '.feishu.cn', path: '/',
    secure: true, httpOnly: true, hostOnly: false, expiresAt: Date.now() + 60_000,
  }];
}

const okSession = async () => ({
  ok: true as const, sessionFile: '/tmp/feishu-session.json', source: 'botmux_cache' as const,
  cookies: cookies(), cookieCount: 1,
});

/**
 * console postJson 桩。`existing[appId]` = 线上现有白名单；`'unreadable'` 让读接口
 * 抛错（走「零写入」分支）。`writeErrors[appId]` 按写入次序消费，用于模拟被拒 / 403。
 */
function makeClient(opts: {
  existing?: Record<string, string[] | 'unreadable'>;
  writeErrors?: Record<string, Array<Error | null>>;
} = {}) {
  const reads: string[] = [];
  const writes: Array<{ appId: string; redirectURL: string[] }> = [];
  const writeCounts = new Map<string, number>();
  const postJson = async (path: string, body?: unknown): Promise<unknown> => {
    const update = path.match(/^\/developers\/v1\/safe_setting\/update\/(.+)$/);
    if (update) {
      const appId = update[1];
      writes.push({ appId, redirectURL: (body as { redirectURL: string[] }).redirectURL });
      const n = writeCounts.get(appId) ?? 0;
      writeCounts.set(appId, n + 1);
      const err = (opts.writeErrors ?? {})[appId]?.[n];
      if (err) throw err;
      return { code: 0 };
    }
    const read = path.match(/^\/developers\/v1\/safe_setting\/(.+)$/);
    if (read) {
      const appId = read[1];
      reads.push(appId);
      const current = (opts.existing ?? {})[appId];
      if (current === 'unreadable') throw new Error('safe_setting read endpoint missing');
      return { code: 0, data: { allowRefreshToken: true, ipWhiteList: [], redirectURL: current ?? [], safeServerDomain: [] } };
    }
    throw new Error(`unexpected console call: ${path}`);
  };
  const client: OpenPlatformApiClient = {
    apiOrigin: 'https://open.feishu.cn',
    postJson,
    postForm: async () => { throw new Error('postForm not used'); },
  };
  return { client, reads, writes, clientFactory: async () => ({ ok: true as const, client }) };
}

/** 403 + code=10003：console 对「不是该应用协作者」的判定信号。 */
function ownerDenied(appId: string): OpenPlatformApiError {
  return new OpenPlatformApiError(
    `HTTP 403 /developers/v1/safe_setting/update/${appId}: code=10003`,
    { code: 10003, msg: 'no permission' },
    403,
  );
}

function byAppId(results: RedirectRepairItem[]): Record<string, RedirectRepairItem> {
  return Object.fromEntries(results.map(item => [item.appId, item]));
}

describe('repairOpenPlatformRedirects', () => {
  it('修一批 bot：缺的补上、已齐的幂等短路，一次 session + 一个 client 打完整批', async () => {
    const stub = makeClient({
      existing: {
        // 用户自己配过一条，必须原样留着（历史全量覆盖会把它清掉）。
        cli_a: ['https://console.example.com/my-own-callback'],
        // 想要的两条线上全有 → 不该发写请求。
        cli_b: [LOOPBACK, PLATFORM, 'https://extra/cb'],
      },
    });
    let sessionCalls = 0;
    let clientCalls = 0;
    let wantedCalls = 0;

    const out = await repairOpenPlatformRedirects({
      prepareSession: async () => { sessionCalls += 1; return okSession(); },
      clientFactory: async () => { clientCalls += 1; return stub.clientFactory(); },
      loadBots: () => [bot('cli_a'), bot('cli_b')],
      collectWanted: () => { wantedCalls += 1; return WANTED; },
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.wanted).toEqual(WANTED);
    const map = byAppId(out.results);
    expect(map.cli_a.status).toBe('fixed');
    expect(map.cli_b.status).toBe('unchanged');

    // 整批共用一份登录态 / client / wanted —— 逐 bot 重算既浪费也可能不一致。
    expect(sessionCalls).toBe(1);
    expect(clientCalls).toBe(1);
    expect(wantedCalls).toBe(1);

    // cli_a：合并写，用户那条不许丢；cli_b：零写请求。
    expect(stub.writes).toEqual([{
      appId: 'cli_a',
      redirectURL: [LOOPBACK, 'https://console.example.com/my-own-callback', PLATFORM],
    }]);
    expect(stub.reads).toEqual(['cli_a', 'cli_b']);
  });

  it('没有可用登录态 → login_required（且不去碰 console）', async () => {
    let clientCalls = 0;
    const out = await repairOpenPlatformRedirects({
      prepareSession: async () => ({
        ok: false, reason: 'invalid_session',
        message: '没有可复用的 Feishu Web session；为避免意外出现第二个二维码，已停止自动登录',
        sessionFile: '/tmp/feishu-session.json',
      }),
      clientFactory: async () => { clientCalls += 1; throw new Error('unreachable'); },
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    expect(out).toMatchObject({ ok: false, reason: 'login_required' });
    expect(clientCalls).toBe(0);
  });

  it('cookie 还在但开放平台侧已失效（missing_csrf）同样归到 login_required', async () => {
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: async () => ({ ok: false, reason: 'missing_csrf', message: '开放平台页面没有返回 window.csrfToken' }),
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    // 处置动作与「没登录」完全一样（重新扫码），不该让前端分两种提示。
    expect(out).toMatchObject({ ok: false, reason: 'login_required' });
  });

  it('拿 console 页面就失败 → network（可重试，不必重新扫码）', async () => {
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: async () => ({ ok: false, reason: 'network', message: '读取开放平台页面失败: fetch failed' }),
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    expect(out).toMatchObject({ ok: false, reason: 'network' });
  });

  it('某个 app 不属于当前账号 → 只把它记成 not_owned，整批继续', async () => {
    const stub = makeClient({
      existing: { cli_own: [], cli_other: [] },
      writeErrors: { cli_other: [ownerDenied('cli_other')] },
    });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_other'), bot('cli_own')],
      // 单条 wanted：最小集与被拒全集相同，writeRedirectWhitelist 原样抛出
      // OpenPlatformApiError，不走兜底重试。
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const map = byAppId(out.results);
    expect(map.cli_other.status).toBe('not_owned');
    expect(map.cli_other.message).toContain('换成该应用的开发者账号');
    // 前一个 app 被拒不能拖垮整批 —— 多租户混挂时这是常态。
    expect(map.cli_own.status).toBe('fixed');
  });

  it('403 写失败只发一次写请求：鉴权问题不该触发最小集兜底，仍判 not_owned', async () => {
    // wanted 不止一条 → 历史实现会在全集被拒后用最小集再写一次；403 属于鉴权失败，
    // 改小再写只会再被拒一次，白白多打一次 console，还把 not_owned 的判定藏进 cause 链。
    const stub = makeClient({
      existing: { cli_other: ['https://console.example.com/my-own-callback'] },
      writeErrors: { cli_other: [ownerDenied('cli_other'), ownerDenied('cli_other')] },
    });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_other')],
      collectWanted: () => WANTED,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(stub.writes).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ appId: 'cli_other', status: 'not_owned' });
  });

  it('403 但 code 不是 10003 → 归 failed，不能报「换个账号扫码」', async () => {
    // 限流 / CSRF 失效 / 租户策略拦截都可能是 403。把它们说成「你不是协作者」，
    // 用户照着换账号扫一遍照样修不好，还看不到真实原因。
    const throttled = new OpenPlatformApiError(
      'HTTP 403 /developers/v1/safe_setting/update/cli_a: code=1254043 msg=rate limited',
      { code: 1254043, msg: 'rate limited' },
      403,
    );
    const stub = makeClient({ existing: { cli_a: [] }, writeErrors: { cli_a: [throttled] } });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results[0].status).toBe('failed');
    expect(out.results[0].message).toContain('rate limited');
  });

  it('读不到线上白名单 → 零写入并记 failed（绝不盲写覆盖用户自己配的回调）', async () => {
    const stub = makeClient({ existing: { cli_a: 'unreadable' } });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(stub.writes).toEqual([]);
    expect(out.results[0].status).toBe('failed');
    expect(out.results[0].message).toContain('未写入');
  });

  it('普通写失败记 failed 并带上原因，不误判成 not_owned', async () => {
    const stub = makeClient({
      existing: { cli_a: [] },
      writeErrors: { cli_a: [new OpenPlatformApiError('code=1 msg=invalid redirect url', { code: 1 }, 200)] },
    });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results[0].status).toBe('failed');
    expect(out.results[0].message).toContain('invalid redirect url');
  });

  it('全集被拒、最小集写成功但 wanted 没写全 → partial，并列出缺了哪几条', async () => {
    const stub = makeClient({
      existing: { cli_a: ['https://console.example.com/my-own-callback'] },
      writeErrors: { cli_a: [new Error('code=1 msg=invalid redirect url'), null] },
    });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 兜底集 = 线上现值 ∪ 本机回调，PLATFORM 那条根本没落地 —— 用户接下来要用的
    // 恰恰可能是它，报 fixed 等于把「还是会 20029」藏起来。
    expect(out.results[0].status).toBe('partial');
    expect(out.results[0].missingRedirectUrls).toEqual([PLATFORM]);
    expect(out.results[0].message).toContain(PLATFORM);
    expect(out.results[0].message).toContain('最小集');
    // 兜底集仍然不删用户那条。
    expect(stub.writes[1].redirectURL).toEqual([LOOPBACK, 'https://console.example.com/my-own-callback']);
  });

  it('wanted 全部落地才算 fixed：不带缺失列表、也不夹带兜底说明（partial 的反例）', async () => {
    const stub = makeClient({ existing: { cli_a: ['https://console.example.com/my-own-callback'] } });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => WANTED,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results[0].status).toBe('fixed');
    expect(out.results[0].missingRedirectUrls).toBeUndefined();
    expect(out.results[0].message).toBeUndefined();
    // 落盘的白名单确实含 wanted 的每一条，用户那条也还在。
    expect(out.results[0].redirectUrls).toEqual([LOOPBACK, 'https://console.example.com/my-own-callback', PLATFORM]);
  });

  it('目标集只含 !apiOnly 且 brand=feishu 的 bot（brand 缺省视为 feishu）', async () => {
    const stub = makeClient({ existing: { cli_legacy: [], cli_feishu: [] } });
    const out = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [
        bot('cli_legacy'),                              // 旧 bots.json 无 brand → feishu
        bot('cli_feishu', { brand: 'feishu' }),
        bot('cli_lark', { brand: 'lark' }),             // 国际版没有这套 console 自动化
        bot('local_riff', { apiOnly: true }),           // core-only：压根没有飞书应用
      ],
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map(item => item.appId)).toEqual(['cli_legacy', 'cli_feishu']);
    expect(stub.writes.map(w => w.appId)).toEqual(['cli_legacy', 'cli_feishu']);
  });

  it('传了 appIds 就取交集；点名却修不了的 appId 单独回一条 failed 而不是静默丢掉', async () => {
    const stub = makeClient({ existing: { cli_a: [] } });
    const out = await repairOpenPlatformRedirects({
      appIds: ['cli_a', 'cli_lark', 'local_riff', 'cli_nope'],
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [
        bot('cli_a'),
        bot('cli_b'),                                   // 没点名 → 不该被动
        bot('cli_lark', { brand: 'lark' }),
        bot('local_riff', { apiOnly: true }),
      ],
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const map = byAppId(out.results);
    expect(map.cli_a.status).toBe('fixed');
    expect(map.cli_b).toBeUndefined();
    // 用户点名要修 X，就得听到 X 的回音——否则「点了没反应」和「修好了」长得一样。
    expect(map.cli_lark).toMatchObject({ status: 'failed' });
    expect(map.cli_lark.message).toContain('feishu.cn');
    expect(map.local_riff).toMatchObject({ status: 'failed' });
    expect(map.local_riff.message).toContain('apiOnly');
    expect(map.cli_nope).toMatchObject({ status: 'failed' });
    expect(map.cli_nope.message).toContain('不在 bots.json 里');
    expect(stub.writes.map(w => w.appId)).toEqual(['cli_a']);
  });

  it('appIds 传空数组 = 一个都不修，绝不当成「修全部」', async () => {
    const stub = makeClient({ existing: { cli_a: [], cli_b: [] } });
    const out = await repairOpenPlatformRedirects({
      appIds: [],
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a'), bot('cli_b')],
      collectWanted: () => WANTED,
    });

    // 前端一个「空选中态也发请求」的 bug 不该把整个 fleet 的白名单改写一遍。
    expect(out).toMatchObject({ ok: true, results: [] });
    expect(stub.writes).toEqual([]);
  });

  it('没有可修的 bot 时不去动登录态（不该白白弹「请扫码」）', async () => {
    let sessionCalls = 0;
    const out = await repairOpenPlatformRedirects({
      prepareSession: async () => { sessionCalls += 1; return okSession(); },
      clientFactory: async () => { throw new Error('unreachable'); },
      loadBots: () => [bot('local_riff', { apiOnly: true })],
      collectWanted: () => WANTED,
    });

    expect(out).toMatchObject({ ok: true, results: [], wanted: [] });
    expect(sessionCalls).toBe(0);
  });

  it('single-flight：第二次调用直接回 in_flight，不抢同一份 session/csrf', async () => {
    const stub = makeClient({ existing: { cli_a: [] } });
    let releaseSession: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseSession = resolve; });
    let sessionCalls = 0;

    const first = repairOpenPlatformRedirects({
      prepareSession: async () => { sessionCalls += 1; await gate; return okSession(); },
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });
    // 让第一批真正跑进 prepareSession 再发第二次请求。
    await Promise.resolve();
    expect(isRepairOpenPlatformRedirectsInFlight()).toBe(true);

    const second = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });
    // 路由把这一条翻成 HTTP 409 { errorCode: 'repair_in_flight' }。
    expect(second).toMatchObject({ ok: false, reason: 'in_flight' });
    // 第二次连登录态都没碰。
    expect(sessionCalls).toBe(1);

    releaseSession?.();
    expect((await first).ok).toBe(true);

    // 跑完即释放：下一次点击必须能正常开始。
    expect(isRepairOpenPlatformRedirectsInFlight()).toBe(false);
    const third = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });
    expect(third.ok).toBe(true);
  });

  it('single-flight 在整批抛错后也要释放（否则一次意外把入口永久锁死）', async () => {
    await expect(repairOpenPlatformRedirects({
      prepareSession: async () => { throw new Error('boom'); },
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    })).rejects.toThrow('boom');

    expect(isRepairOpenPlatformRedirectsInFlight()).toBe(false);
  });

  it('下游永不 settle 时按截止时间返回 timeout，且下一批能正常开始（不再吃 409）', async () => {
    const stub = makeClient({ existing: { cli_a: [] } });
    const out = await repairOpenPlatformRedirects({
      deadlineMs: 20,
      // 挂死在 client 工厂上：没有服务端 deadline 时 inFlight 会永远留着，
      // 之后每次点「修复配置」都只会拿到 409，只能重启 daemon 才能自愈。
      clientFactory: () => new Promise(() => {}),
      prepareSession: okSession,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });

    expect(out).toMatchObject({ ok: false, reason: 'timeout' });
    expect(isRepairOpenPlatformRedirectsInFlight()).toBe(false);

    const next = await repairOpenPlatformRedirects({
      prepareSession: okSession,
      clientFactory: stub.clientFactory,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });
    expect(next.ok).toBe(true);
    expect(stub.writes.map(w => w.appId)).toEqual(['cli_a']);
  });

  it('整批 deadline 的 AbortSignal 真的接进下游 fetch（登录态校验 / console 取页 / 每次 postJson）', async () => {
    // 这条用例刻意**不注入** prepareSession / clientFactory，跑的正是默认工厂那条真实
    // 链路——只有信号真接到底，超时才等于「下游当场断开」，而不是「上层不等了、下游
    // 还在后台偷偷写」。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-redirect-repair-signal-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, cookies());

    const seen: Array<{ url: string; hasSignal: boolean }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      seen.push({ url: href, hasSignal: init?.signal instanceof AbortSignal });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') {
        return new Response('<script>window.csrfToken="csrf_repair"</script>', { status: 200 });
      }
      if (href.includes('/safe_setting/update/')) return Response.json({ code: 0 });
      if (href.includes('/safe_setting/')) return Response.json({ code: 0, data: { redirectURL: [] } });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const out = await repairOpenPlatformRedirects({
      fetchImpl,
      sessionFilePath: sessionFile,
      loadBots: () => [bot('cli_a')],
      collectWanted: () => [LOOPBACK],
    });

    expect(out.ok).toBe(true);
    // 登录态校验 + console 取页 + 白名单读 + 白名单写，一次都不能漏。
    expect(seen.map(call => call.url)).toEqual([
      'https://ask.feishu.cn/',
      'https://open.feishu.cn/app',
      'https://open.feishu.cn/developers/v1/safe_setting/cli_a',
      'https://open.feishu.cn/developers/v1/safe_setting/update/cli_a',
    ]);
    expect(seen.every(call => call.hasSignal)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('超时批次即使之后自己活过来，也一个写请求都提交不出去（代际 fence）', async () => {
    const stub = makeClient({ existing: { cli_a: [], cli_b: [] } });
    let releaseClient: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseClient = resolve; });

    const timedOut = await repairOpenPlatformRedirects({
      deadlineMs: 20,
      prepareSession: okSession,
      // 注入的依赖收不到 AbortSignal —— 正是「只靠 Promise.race 清 inFlight」会翻车
      // 的那类下游：超时后它还活着，稍后 resolve 就会继续往 console 写。
      clientFactory: async () => { await gate; return stub.clientFactory(); },
      loadBots: () => [bot('cli_a'), bot('cli_b')],
      collectWanted: () => [LOOPBACK],
    });
    expect(timedOut).toMatchObject({ ok: false, reason: 'timeout' });

    // 让旧批醒过来，并给它足够的事件循环轮次去尝试写。
    releaseClient?.();
    for (let i = 0; i < 32; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    // 代际 fence 的硬断言：超时批次在超时之后的 update 调用数为 0。
    expect(stub.writes).toEqual([]);
    expect(isRepairOpenPlatformRedirectsInFlight()).toBe(false);
  });
});
