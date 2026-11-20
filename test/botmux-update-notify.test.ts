import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOTMUX_UPDATE_CHECK_MS, BOTMUX_UPDATE_RETRY_MS, BOTMUX_UPDATE_DEDUPE_MS,
  buildBotmuxUpdateNoticeCard, createBotmuxUpdateNotifier,
  readBotmuxUpdateNotifyState, writeBotmuxUpdateNotifyState,
  type BotmuxUpdateNotifyDeps,
} from '../src/core/botmux-update-notify.js';

describe('botmux owner version reminders', () => {
  let dir: string;
  let clock: number;
  let enabled: boolean;
  let owner: string | undefined;
  let current: string;
  let latest: string | null;
  let deps: BotmuxUpdateNotifyDeps;
  const controllers: ReturnType<typeof createBotmuxUpdateNotifier>[] = [];
  const controller = () => {
    const c = createBotmuxUpdateNotifier(deps); controllers.push(c); return c;
  };
  const path = () => join(deps.dataDir, 'botmux-update-notify.json');
  const recipient = () => readBotmuxUpdateNotifyState(path()).entries[JSON.stringify([deps.larkAppId, owner])];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-version-notify-'));
    clock = Date.now(); enabled = true; owner = 'ou_owner'; current = '1.0.0'; latest = '1.1.0';
    deps = {
      dataDir: join(dir, 'state'), larkAppId: 'cli_primary',
      enabled: () => enabled, ownerOpenId: () => owner,
      currentVersion: () => current, now: () => clock,
      fetchLatest: vi.fn(async () => latest),
      send: vi.fn(async (_notice, beforeWrite) => { beforeWrite(); }),
      log: vi.fn(),
    };
  });
  afterEach(() => {
    controllers.splice(0).forEach(c => c.stop()); vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does no network, writes, or sends while disabled', async () => {
    enabled = false; await controller().tick();
    expect(deps.fetchLatest).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    expect(existsSync(deps.dataDir)).toBe(false);
  });
  it('waits for a resolvable owner', async () => {
    owner = undefined; const c = controller(); await c.tick();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    owner = 'ou_owner'; await c.tick(); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it.each(['1.0.0', '0.9.0', null, 'invalid'])('does not notify about an unavailable or older version: %s', value => {
    latest = value; return controller().tick().then(() => expect(deps.send).not.toHaveBeenCalled());
  });
  it('does not flag a canary ahead of latest stable as outdated', async () => {
    current = '1.2.0-canary.1'; await controller().tick(); expect(deps.send).not.toHaveBeenCalled();
  });
  it('does not compare an unknown running version', async () => {
    current = 'unknown'; await controller().tick(); expect(deps.fetchLatest).not.toHaveBeenCalled();
  });
  it('delivers once per newer version across ticks and restart, and ignores source regressions', async () => {
    const c = controller(); await c.tick();
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ ownerOpenId: owner, current, latest }), expect.any(Function));
    await c.tick(); expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    await controller().tick(); expect(deps.send).toHaveBeenCalledTimes(1);
    clock += BOTMUX_UPDATE_CHECK_MS; latest = '1.2.0'; await c.tick();
    clock += BOTMUX_UPDATE_CHECK_MS; latest = '1.1.0'; await c.tick();
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(recipient().lastNotifiedVersion).toBe('1.2.0');
  });
  it('enables live without waiting for an old successful check window', async () => {
    const c = controller(); latest = current; await c.tick();
    enabled = false; await c.tick(); latest = '1.1.0'; enabled = true;
    await c.tick(); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('retries failed delivery with its durable UUID without marking it delivered', async () => {
    const send = vi.mocked(deps.send);
    send.mockRejectedValueOnce(new Error('network'));
    const c = controller(); await c.tick();
    const pending = recipient();
    expect(pending.lastNotifiedVersion).toBeUndefined(); expect(pending.pending?.version).toBe(latest);
    await c.tick(); expect(send).toHaveBeenCalledTimes(1);
    clock += BOTMUX_UPDATE_RETRY_MS; await c.tick();
    expect(send.mock.calls[1][0].uuid).toBe(send.mock.calls[0][0].uuid);
    expect(recipient().pending).toBeUndefined();
  });
  it('reuses the UUID after successful send followed by a failed final state write', async () => {
    let writes = 0;
    deps.writeState = (p, state) => {
      if (++writes === 2) throw new Error('disk full');
      writeBotmuxUpdateNotifyState(p, state);
    };
    await controller().tick(); await controller().tick();
    const calls = vi.mocked(deps.send).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0].uuid).toBe(calls[0][0].uuid);
    expect(recipient().lastNotifiedVersion).toBe(latest);
  });
  it('preserves prepared delivery across a temporary lookup outage', async () => {
    let writes = 0;
    deps.writeState = (p, state) => {
      if (++writes === 2) throw new Error('disk full');
      writeBotmuxUpdateNotifyState(p, state);
    };
    const c = controller(); await c.tick();
    clock += BOTMUX_UPDATE_RETRY_MS; latest = null; await c.tick();
    expect(recipient().pending).toBeDefined();
    clock += BOTMUX_UPDATE_RETRY_MS; latest = '1.1.0'; await c.tick();
    const calls = vi.mocked(deps.send).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0].uuid).toBe(calls[0][0].uuid);
  });
  it.each(['1.0.0', '1.1.0'])('preserves a pending newer UUID across a source regression: %s', older => {
    latest = '1.2.0'; let writes = 0;
    deps.writeState = (p, state) => {
      if (++writes === 2) throw new Error('disk full');
      writeBotmuxUpdateNotifyState(p, state);
    };
    return (async () => {
      const c = controller(); await c.tick();
      clock += BOTMUX_UPDATE_RETRY_MS; latest = older; await c.tick();
      expect(recipient().pending?.version).toBe('1.2.0'); expect(deps.send).toHaveBeenCalledTimes(1);
      clock += BOTMUX_UPDATE_RETRY_MS; latest = '1.2.0'; await c.tick();
      const calls = vi.mocked(deps.send).mock.calls;
      expect(calls).toHaveLength(2); expect(calls[1][0].uuid).toBe(calls[0][0].uuid);
    })();
  });
  it('suspends unknown delivery retries before the UUID retention expires', async () => {
    deps.writeState = (p, state) => {
      const entry = Object.values(state.entries)[0];
      if (entry.lastNotifiedVersion) throw new Error('disk full');
      writeBotmuxUpdateNotifyState(p, state);
    };
    const c = controller(); await c.tick(); clock += BOTMUX_UPDATE_DEDUPE_MS;
    await c.tick(); clock += BOTMUX_UPDATE_CHECK_MS; await controller().tick();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(recipient().lastNotifiedVersion).toBeUndefined(); expect(recipient().pending).toBeDefined();
  });
  it('backs off thrown version lookup failures', async () => {
    deps.fetchLatest = vi.fn(async () => { throw new Error('network'); });
    const c = controller(); await c.tick(); await c.tick();
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    clock += BOTMUX_UPDATE_RETRY_MS; await c.tick(); expect(deps.fetchLatest).toHaveBeenCalledTimes(2);
  });
  it('refuses to send if preparing the delivery state fails', async () => {
    deps.writeState = () => { throw new Error('disk full'); };
    await controller().tick(); expect(deps.send).not.toHaveBeenCalled();
  });
  it('keeps an unreadable or corrupt delivery ledger intact and does not send', async () => {
    mkdirSync(deps.dataDir); writeFileSync(path(), '{broken');
    await controller().tick(); expect(deps.send).not.toHaveBeenCalled();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });
  it('throttles unavailable version lookups and recovers', async () => {
    latest = null; const c = controller(); await c.tick(); await c.tick();
    expect(deps.fetchLatest).toHaveBeenCalledTimes(1);
    clock += BOTMUX_UPDATE_RETRY_MS; latest = '1.1.0'; await c.tick();
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it.each(['disable', 'owner', 'upgrade', 'stop'])('rechecks applicability after a slow probe: %s', action => {
    const c = controller();
    deps.fetchLatest = vi.fn(async () => {
      if (action === 'disable') enabled = false;
      if (action === 'owner') owner = 'ou_new';
      if (action === 'upgrade') current = '1.1.0';
      if (action === 'stop') c.stop();
      return latest;
    });
    // Construct again to take the new dependency function.
    const active = controller();
    if (action === 'stop') deps.fetchLatest = async () => { active.stop(); return latest; };
    return active.tick().then(() => expect(deps.send).not.toHaveBeenCalled());
  });
  it('rechecks the live switch at the actual transport write boundary', async () => {
    let writes = 0;
    deps.send = async (_notice, beforeWrite) => { enabled = false; beforeWrite(); writes++; };
    await controller().tick(); expect(writes).toBe(0);
    expect(recipient().lastNotifiedVersion).toBeUndefined();
  });
  it('routes a new owner independently of the previous owner delivery state', async () => {
    const c = controller(); await c.tick(); owner = 'ou_new'; await c.tick();
    const calls = vi.mocked(deps.send).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0].ownerOpenId).toBe('ou_new');
    expect(calls[1][0].uuid).not.toBe(calls[0][0].uuid);
    owner = 'ou_owner'; await c.tick(); expect(deps.send).toHaveBeenCalledTimes(2);
  });
  it('serializes overlapping ticks and independently created controllers', async () => {
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    deps.fetchLatest = vi.fn(async () => { await wait; return latest; });
    const a = controller(), b = controller();
    const first = a.tick(); const second = a.tick(); const other = b.tick();
    release(); await Promise.all([first, second, other]);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('starts live polling while off and stops without leaving timers', async () => {
    vi.useFakeTimers(); enabled = false; const c = controller(); c.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    c.stop(); enabled = true; await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.fetchLatest).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('renders version and useful links without callback actions', () => {
    for (const locale of ['zh', 'en'] as const) {
      const card = JSON.parse(buildBotmuxUpdateNoticeCard({ current, latest: latest! }, { locale, dashboardUrl: 'https://dashboard.example/' }));
      const text = card.elements[0].content;
      expect(text).toContain(current); expect(text).toContain(latest);
      expect(text).toContain('https://github.com/deepcoldy/botmux/releases/tag/v1.1.0');
      expect(text).toContain('https://dashboard.example/');
      expect(card.elements.every((e: { tag: string }) => e.tag === 'markdown')).toBe(true);
    }
  });
});
