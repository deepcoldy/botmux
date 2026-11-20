import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as realSetImmediate } from 'node:timers';
import type * as NoticeModule from '../src/core/botmux-update-notify.js';
import { readGlobalConfig, mergeMaintenanceConfig } from '../src/global-config.js';
import { withFileLock } from '../src/utils/file-lock.js';

const sdk = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: sdk.request, im: { v1: { message: { create: sdk.create } } } }),
  getBotUploadClient: () => ({ request: sdk.request }),
  getBot: () => ({ config: { larkAppId: 'cli_review', allowedUsers: ['ou_review'], apiOnly: false } }),
  getAllBots: () => [],
  loadBotConfigs: () => [],
  formatLarkError: (error: unknown) => String(error),
  LARK_REQUEST_TIMEOUT_MS: 15_000,
  LarkTransportDisabledError: class extends Error {},
}));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import { sendUserMessage } from '../src/im/lark/client.js';
import { __testOnly_resetLarkGate, executeWithLarkGate } from '../src/im/lark/api-gate.js';

// A mutation copy can be selected without changing production files or these probes.
const modulePath = process.env.REVIEW_VERSION_NOTICE_MODULE;
const notice: typeof NoticeModule = modulePath
  ? await import(/* @vite-ignore */ modulePath)
  : await import('../src/core/botmux-update-notify.js');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function ioUntil(check: () => boolean) {
  for (let i = 0; i < 4000; i++) {
    if (check()) return;
    await new Promise<void>(r => realSetImmediate(r));
  }
  throw new Error('I/O condition did not settle');
}

describe('botmux version reminder delivery', () => {
  let dir: string;
  let enabled: boolean;
  let owner: string | undefined;
  let current: string;
  let latest: string | null;
  let deps: NoticeModule.BotmuxUpdateNotifyDeps;
  let deliveries: { owner: string; uuid: string; time: number }[];
  let uuidSeen: Map<string, number>;
  const controllers: ReturnType<typeof notice.createBotmuxUpdateNotifier>[] = [];
  const controller = () => {
    const c = notice.createBotmuxUpdateNotifier(deps);
    controllers.push(c);
    return c;
  };
  const statePath = () => join(deps.dataDir, 'botmux-update-notify.json');
  const ledger = () => notice.readBotmuxUpdateNotifyState(statePath());
  const state = () => ledger().entries[JSON.stringify([deps.larkAppId, owner])] ?? {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-version-notice-'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(dir, 'config.json'));
    vi.stubEnv('BOTMUX_LARK_QPS', '15');
    vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '3');
    __testOnly_resetLarkGate();
    enabled = true; owner = 'ou_review'; current = '1.0.0'; latest = '1.1.0';
    deliveries = []; uuidSeen = new Map();
    sdk.request.mockReset().mockImplementation(async (input: { data: { receive_id: string; uuid: string } }) => {
      const seenAt = uuidSeen.get(input.data.uuid);
      if (seenAt === undefined || Date.now() - seenAt >= 60 * 60_000) {
        uuidSeen.set(input.data.uuid, Date.now());
        deliveries.push({ owner: input.data.receive_id, uuid: input.data.uuid, time: Date.now() });
      }
      return { code: 0, data: { message_id: `om_review_${uuidSeen.size}` } };
    });
    sdk.create.mockReset();
    deps = {
      dataDir: join(dir, 'data'), larkAppId: 'cli_review',
      enabled: () => enabled, ownerOpenId: () => owner,
      currentVersion: () => current,
      fetchLatest: vi.fn(async () => latest),
      send: async (n, beforeWrite) => {
        await sendUserMessage('cli_review', n.ownerOpenId,
          notice.buildBotmuxUpdateNoticeCard(n, { locale: 'en' }),
          'interactive', n.uuid, { timeoutMs: 15_000 }, { beforeWrite });
      },
      log: vi.fn(),
    };
  });
  afterEach(() => {
    controllers.splice(0).forEach(c => c.stop());
    __testOnly_resetLarkGate();
    vi.useRealTimers(); vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('default-off real config does no checks, creates no ledger, and enabling is live', async () => {
    deps.enabled = () => readGlobalConfig().maintenance?.notifyOnNewVersion === true;
    const c = controller(); c.start();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    expect(sdk.request).not.toHaveBeenCalled();
    expect(existsSync(deps.dataDir)).toBe(false);
    mergeMaintenanceConfig({ notifyOnNewVersion: true });
    await c.tick();
    expect(deliveries).toHaveLength(1);
    expect(readGlobalConfig().maintenance?.autoUpdate).toBeUndefined();
    mergeMaintenanceConfig({ notifyOnNewVersion: false });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
  });

  it.each(['true', 1, null])('non-boolean persisted config stays off: %s', value => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maintenance: { notifyOnNewVersion: value } }));
    deps.enabled = () => readGlobalConfig().maintenance?.notifyOnNewVersion === true;
    return controller().tick().then(() => {
      expect(deps.fetchLatest).not.toHaveBeenCalled();
      expect(sdk.request).not.toHaveBeenCalled();
    });
  });

  it.each(['disable', 'owner', 'upgrade', 'stop'])('periodic ticks overlap a slow probe; live intervention prevents stale send: %s', async action => {
    const entered = deferred(), answer = deferred<string | null>();
    deps.fetchLatest = vi.fn(async () => { entered.resolve(); return answer.promise; });
    const c = controller(); c.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    if (action === 'disable') enabled = false;
    if (action === 'owner') owner = 'ou_new_review';
    if (action === 'upgrade') current = '1.1.0';
    if (action === 'stop') c.stop();
    answer.resolve('1.1.0');
    await ioUntil(() => vi.mocked(deps.log).mock.calls.length > 0 || !existsSync(statePath() + '.lock'));
    expect(deliveries).toHaveLength(0);
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('the real rate-limit wait rechecks the switch before the SDK write', async () => {
    vi.stubEnv('BOTMUX_LARK_QPS', '1');
    await executeWithLarkGate('cli_review', 'exhaust-burst', async () => {});
    const c = controller(); const run = c.tick();
    await ioUntil(() => existsSync(statePath()));
    await ioUntil(() => vi.getTimerCount() > 0);
    enabled = false;
    await vi.advanceTimersByTimeAsync(1000); await run;
    expect(sdk.request).not.toHaveBeenCalled();
    expect(state().pending?.version).toBe('1.1.0');
    expect(state().lastNotifiedVersion).toBeUndefined();
    await c.tick(); enabled = true;
    const resumed = c.tick();
    await ioUntil(() => vi.getTimerCount() > 0);
    await vi.advanceTimersByTimeAsync(1000); await resumed;
    expect(deliveries).toHaveLength(1);
  });

  it.each(['disable', 'owner', 'upgrade', 'stop'])('the real 429 retry rechecks applicability: %s', async action => {
    const reached = deferred();
    sdk.request.mockImplementationOnce(async () => {
      reached.resolve();
      throw Object.assign(new Error('rate limited'), { isAxiosError: true, response: { status: 429 } });
    });
    const c = controller(); const run = c.tick();
    await reached.promise;
    await ioUntil(() => vi.getTimerCount() > 0);
    if (action === 'disable') enabled = false;
    if (action === 'owner') owner = 'ou_new_review';
    if (action === 'upgrade') current = '1.1.0';
    if (action === 'stop') c.stop();
    await vi.advanceTimersByTimeAsync(500); await run;
    expect(sdk.request).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(0);
    expect(state().lastNotifiedVersion).toBeUndefined();
  });

  it('an initial durable write failure prevents real transport egress', async () => {
    deps.writeState = () => { throw new Error('prepare disk full'); };
    await controller().tick();
    expect(sdk.request).not.toHaveBeenCalled();
    expect(existsSync(statePath())).toBe(false);
  });

  it.each(['disable', 'owner', 'stop'])('a slow unavailable lookup writes no stale state after intervention: %s', async action => {
    const reached = deferred(), answer = deferred<string | null>();
    deps.fetchLatest = vi.fn(async () => { reached.resolve(); return answer.promise; });
    const c = controller(), run = c.tick(); await reached.promise;
    if (action === 'disable') enabled = false;
    if (action === 'owner') owner = 'ou_new_review';
    if (action === 'stop') c.stop();
    answer.resolve(null); await run;
    expect(existsSync(statePath())).toBe(false);
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it('exceptional lookups back off across periodic attempts and then recover', async () => {
    deps.fetchLatest = vi.fn(async () => { throw new Error('lookup exploded'); });
    const c = controller(); await c.tick();
    await vi.advanceTimersByTimeAsync(60_000); await c.tick();
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    deps.fetchLatest = vi.fn(async () => '1.1.0'); await c.tick();
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
  });

  it('successful delivery remains deduped after the hourly check and a controller restart', async () => {
    const c = controller(); await c.tick();
    await vi.advanceTimersByTimeAsync(60 * 60_000); await c.tick();
    await controller().tick();
    expect(deliveries).toHaveLength(1);
    latest = '1.2.0'; await vi.advanceTimersByTimeAsync(60 * 60_000); await c.tick();
    expect(deliveries).toHaveLength(2);
    expect(state().lastNotifiedVersion).toBe('1.2.0');
  });

  it('a corrupt ledger stays intact and suppresses even the version probe', async () => {
    mkdirSync(deps.dataDir); writeFileSync(statePath(), '{broken');
    await controller().tick();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    expect(sdk.request).not.toHaveBeenCalled();
    expect(readFileSync(statePath(), 'utf8')).toBe('{broken');
  });

  it('final write failure is retried with the same UUID across restart inside the dedupe window', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    await controller().tick();
    const pendingUuid = state().pending?.uuid;
    await controller().tick();
    expect(sdk.request).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(1);
    expect(sdk.request.mock.calls[1][0].data.uuid).toBe(pendingUuid);
    expect(state().lastNotifiedVersion).toBe('1.1.0');
    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
  });

  it('unavailable lookup after successful egress and failed final write preserves one logical delivery', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    const first = state();
    latest = null; await vi.advanceTimersByTimeAsync(5 * 60_000); await c.tick();
    const unavailable = state();
    latest = '1.1.0'; await vi.advanceTimersByTimeAsync(5 * 60_000); await c.tick();
    console.log('REVIEW_HALF_WRITE_LOOKUP', JSON.stringify({ first, unavailable, final: state(), deliveries }));
    expect(deliveries).toHaveLength(1);
  });

  it('same-version retries do not create a second message when the final-write outage exceeds the UUID window', async () => {
    deps.writeState = (p, s) => {
      if (Object.values(s.entries).some(entry => entry.lastNotifiedVersion)) throw new Error('completion unavailable');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60_000); await c.tick();
    }
    console.log('REVIEW_UUID_WINDOW', JSON.stringify({ requests: sdk.request.mock.calls.length, state: state(), deliveries }));
    expect(deliveries).toHaveLength(1);
  });

  it('the uncertainty cutoff is rechecked after the real token wait crosses its boundary', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    await vi.advanceTimersByTimeAsync(notice.BOTMUX_UPDATE_DEDUPE_MS - 500);
    __testOnly_resetLarkGate(); vi.stubEnv('BOTMUX_LARK_QPS', '1');
    await executeWithLarkGate('cli_review', 'exhaust-burst', async () => {});
    const run = c.tick();
    await ioUntil(() => vi.getTimerCount() > 0);
    await vi.advanceTimersByTimeAsync(1000); await run;
    expect(sdk.request).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(state().pending?.uuid).toBe(deliveries[0].uuid);
  });

  it('a suspended uncertain older delivery still permits one later higher release', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000); await c.tick();
    expect(sdk.request).toHaveBeenCalledTimes(1);
    latest = '1.2.0'; await controller().tick();
    expect(deliveries).toHaveLength(2);
    expect(state().lastNotifiedVersion).toBe('1.2.0');
    expect(state().pending).toBeUndefined();
  });

  it('a final atomic write that commits before throwing still stays deduped after restart', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      notice.writeBotmuxUpdateNotifyState(p, s);
      if (++writes === 2) throw new Error('directory fsync acknowledgement lost');
    };
    await controller().tick(); await controller().tick();
    expect(deliveries).toHaveLength(1);
    expect(sdk.request).toHaveBeenCalledTimes(1);
    expect(state().lastNotifiedVersion).toBe('1.1.0');
  });

  it('returning to a previous owner does not re-notify that owner of the same version', async () => {
    const c = controller(); await c.tick();
    owner = 'ou_new_review'; await c.tick();
    owner = 'ou_review'; await c.tick();
    console.log('REVIEW_OWNER_RETURN', JSON.stringify({ deliveries, state: state() }));
    expect(deliveries.filter(d => d.owner === 'ou_review')).toHaveLength(1);
  });

  it('upgrading and reverting while final delivery settlement is unresolved preserves dedupe identity', async () => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    current = '1.1.0'; await vi.advanceTimersByTimeAsync(5 * 60_000); await c.tick();
    current = '1.0.0'; await controller().tick();
    expect(deliveries).toHaveLength(1);
    expect(state().lastNotifiedVersion).toBe('1.1.0');
  });

  it.each(['1.0.0', '1.0.5'])('a regressed lookup after successful send and failed final write preserves the original UUID: %s', async regressed => {
    let writes = 0;
    deps.writeState = (p, s) => {
      if (++writes === 2) throw new Error('completion disk full');
      notice.writeBotmuxUpdateNotifyState(p, s);
    };
    const c = controller(); await c.tick();
    const first = state();
    latest = regressed; await vi.advanceTimersByTimeAsync(5 * 60_000); await c.tick();
    const duringRegression = state();
    latest = '1.1.0';
    // A controller restart should not lose uncertain delivery identity.
    await controller().tick();
    console.log('REVIEW_REGRESSED_LOOKUP', JSON.stringify({ regressed, first, duringRegression, final: state(), deliveries }));
    expect(deliveries.filter(d => d.uuid === first.pending?.uuid)).toHaveLength(1);
    expect(deliveries.filter(d => d.owner === 'ou_review')).toHaveLength(1);
  });

  it('one controller never overlaps a slow send with periodic checks', async () => {
    const entered = deferred(), release = deferred();
    const realSend = deps.send;
    deps.send = async (n, guard) => { entered.resolve(); await release.promise; await realSend(n, guard); };
    const c = controller(); c.start();
    await vi.advanceTimersByTimeAsync(20_000); await entered.promise;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Drain real filesystem turns after the controlled timers advance.
    for (let i = 0; i < 100; i++) await new Promise<void>(r => realSetImmediate(r));
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(0);
    expect(deps.log).not.toHaveBeenCalled();
    release.resolve(); await ioUntil(() => vi.mocked(deps.log).mock.calls.length > 0);
    expect(deliveries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('real disk lock contender times out without egress and recovers after the slow holder completes', async () => {
    const entered = deferred(), release = deferred<string | null>();
    deps.fetchLatest = vi.fn(async () => { entered.resolve(); return release.promise; });
    const a = controller(), b = controller();
    const holder = a.tick(); await entered.promise;
    let contenderDone = false;
    const contender = b.tick().then(() => { contenderDone = true; });
    for (let i = 0; i < 70 && !contenderDone; i++) {
      await new Promise<void>(r => realSetImmediate(r));
      await vi.advanceTimersByTimeAsync(100);
    }
    await contender;
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(sdk.request).not.toHaveBeenCalled();
    console.log('REVIEW_LOCK_CONTENDER', JSON.stringify({ logs: vi.mocked(deps.log).mock.calls }));
    expect(vi.mocked(deps.log).mock.calls.some(([message]) => /lock/i.test(message))).toBe(true);
    release.resolve('1.1.0'); await holder;
    await b.tick();
    expect(deliveries).toHaveLength(1);
    expect(existsSync(statePath() + '.lock')).toBe(false);
  });

  it('the real disk lock blocks lookup and egress until its external holder releases it', async () => {
    mkdirSync(deps.dataDir);
    const entered = deferred(), release = deferred();
    const holder = withFileLock(statePath(), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let done = false;
    const run = controller().tick().then(() => { done = true; });
    try {
      await ioUntil(() => vi.getTimerCount() > 0 || vi.mocked(deps.fetchLatest).mock.calls.length > 0);
      expect(deps.fetchLatest).not.toHaveBeenCalled();
      expect(sdk.request).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await holder;
      for (let i = 0; i < 60 && !done; i++) {
        await new Promise<void>(r => realSetImmediate(r));
        await vi.advanceTimersByTimeAsync(100);
      }
      await run;
    }
    expect(deliveries).toHaveLength(1);
  });

  it('a switch disabled while waiting for the real disk lock suppresses the queued version lookup', async () => {
    mkdirSync(deps.dataDir);
    const entered = deferred(), release = deferred();
    const holder = withFileLock(statePath(), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let done = false;
    const run = controller().tick().then(() => { done = true; });
    await new Promise<void>(r => realSetImmediate(r));
    enabled = false; release.resolve(); await holder;
    for (let i = 0; i < 60 && !done; i++) {
      await new Promise<void>(r => realSetImmediate(r));
      await vi.advanceTimersByTimeAsync(100);
    }
    await run;
    console.log('REVIEW_DISABLE_WAITING_LOCK', JSON.stringify({ checks: vi.mocked(deps.fetchLatest).mock.calls.length, deliveries }));
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    expect(sdk.request).not.toHaveBeenCalled();
  });
});
