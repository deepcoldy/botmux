/**
 * Bot 在飞书开放平台改名后，botmux 各展示处要在一个刷新周期内换成新名字；
 * 飞书拉取失败时保留旧名、不报错。
 *
 * 真实组件 + 假时钟：刷新器（services/bot-profile-refresh.ts）+ 真实 bots-info.json
 * 写入（bots-info-store）+ 真实读取方（工作流用的 v3BotDisplayNameResolver、
 * Dashboard 用的 createBotDisplayNameLookup）。只有 `/bot/v3/info` 的网络调用是假的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBotProfileRefresher,
  type BotProfileChange,
  type BotProfileState,
  type FetchedBotProfile,
} from '../src/services/bot-profile-refresh.js';
import { upsertBotInfoEntries } from '../src/services/bots-info-store.js';
import { __resetBotsInfoCacheForTest } from '../src/services/bots-info-cache.js';
import { createBotDisplayNameLookup } from '../src/services/bot-display-name.js';
import { v3BotDisplayNameResolver } from '../src/im/lark/v3-bot-eligibility.js';

const APP = 'cli_profile_refresh_test';
const INTERVAL = 60_000;

let dataDir = '';

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-profile-refresh-'));
  __resetBotsInfoCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
  __resetBotsInfoCacheForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A fake Feishu whose current app name / failure mode the test controls. */
function fakeFeishu(initial: string) {
  let name = initial;
  let failing = false;
  const fetchProfile = vi.fn(async (): Promise<FetchedBotProfile> => {
    if (failing) throw new Error('network down');
    return { openId: 'ou_self', name, avatarUrl: 'https://cdn/avatar.png' };
  });
  return {
    fetchProfile,
    rename(next: string) { name = next; },
    fail(on: boolean) { failing = on; },
  };
}

/** Wire the refresher exactly like the daemon: state = BotState, fan-out = bots-info rewrite. */
function wire(feishu: ReturnType<typeof fakeFeishu>, state: BotProfileState, intervalMs = INTERVAL) {
  const changes: BotProfileChange[] = [];
  const refresher = createBotProfileRefresher({
    larkAppId: APP,
    fetchProfile: feishu.fetchProfile,
    state: () => state,
    onChange: (change) => {
      changes.push(change);
      upsertBotInfoEntries(dataDir, [{
        larkAppId: APP,
        botOpenId: state.botOpenId ?? null,
        botName: state.botName ?? null,
        botAvatarUrl: state.botAvatarUrl ?? null,
        cliId: 'claude-code',
      }]);
    },
    intervalMs,
    minTriggerGapMs: 5_000,
  });
  return { refresher, changes };
}

/** Advance past one full period (interval + the per-app spread offset ≤ interval/5). */
async function onePeriod(intervalMs = INTERVAL): Promise<void> {
  await vi.advanceTimersByTimeAsync(intervalMs + Math.ceil(intervalMs / 5) + 1);
}

function displayedNames(): { workflow: string; dashboard: string | undefined } {
  return {
    workflow: v3BotDisplayNameResolver(dataDir)(APP),
    dashboard: createBotDisplayNameLookup({ configs: [{ larkAppId: APP }], liveName: () => undefined, dataDir })(APP),
  };
}

describe('bot profile refresher', () => {
  it('startup fetch persists the Feishu name so every reader shows it', async () => {
    const feishu = fakeFeishu('旧名Bot');
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(state).toMatchObject({ botOpenId: 'ou_self', botName: '旧名Bot' });
    expect(changes).toEqual([{ first: true, nameChanged: true, avatarChanged: true }]);
    expect(displayedNames()).toEqual({ workflow: '旧名Bot', dashboard: '旧名Bot' });
    refresher.stop();
  });

  it('a rename on the open platform reaches the readers within one refresh period, without a restart', async () => {
    const feishu = fakeFeishu('旧名Bot');
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);

    feishu.rename('新名Bot');
    // Not yet: nothing re-reads before the period elapses.
    await vi.advanceTimersByTimeAsync(INTERVAL / 2);
    expect(displayedNames().workflow).toBe('旧名Bot');

    await onePeriod();
    expect(state.botName).toBe('新名Bot');
    expect(changes.at(-1)).toEqual({ first: false, nameChanged: true, avatarChanged: false, previousName: '旧名Bot' });
    expect(displayedNames()).toEqual({ workflow: '新名Bot', dashboard: '新名Bot' });
    refresher.stop();
  });

  it('an unchanged name does not rewrite derived caches', async () => {
    const feishu = fakeFeishu('同名Bot');
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    await onePeriod();
    await onePeriod();
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(3);
    expect(changes).toHaveLength(1); // only the first success
    refresher.stop();
  });

  it('a failed fetch keeps the old name without throwing, and the next period retries', async () => {
    const feishu = fakeFeishu('旧名Bot');
    const state: BotProfileState = {};
    const { refresher } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);

    feishu.rename('新名Bot');
    feishu.fail(true);
    await onePeriod();
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(2);
    expect(state.botName).toBe('旧名Bot');
    expect(displayedNames()).toEqual({ workflow: '旧名Bot', dashboard: '旧名Bot' });

    feishu.fail(false);
    await onePeriod();
    expect(state.botName).toBe('新名Bot');
    expect(displayedNames().workflow).toBe('新名Bot');
    refresher.stop();
  });

  it('a failing first fetch leaves the last-known persisted name on display', async () => {
    upsertBotInfoEntries(dataDir, [{ larkAppId: APP, botOpenId: 'ou_self', botName: '上次的名字', botAvatarUrl: null, cliId: 'claude-code' }]);
    const feishu = fakeFeishu('x');
    feishu.fail(true);
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([]);
    expect(displayedNames()).toEqual({ workflow: '上次的名字', dashboard: '上次的名字' });
    refresher.stop();
  });

  it('never overwrites a known open_id (routing identity stays as probed)', async () => {
    const feishu = fakeFeishu('Bot');
    feishu.fetchProfile.mockResolvedValueOnce({ openId: 'ou_other', name: 'Bot' });
    const state: BotProfileState = { botOpenId: 'ou_self' };
    const { refresher } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.botOpenId).toBe('ou_self');
    refresher.stop();
  });

  it('requestRefresh (rename hint) fetches early, throttled by the minimum gap', async () => {
    const feishu = fakeFeishu('旧名Bot');
    const state: BotProfileState = {};
    const { refresher } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(1);

    feishu.rename('新名Bot');
    refresher.requestRefresh('hint'); // inside the 5s gap since startup → ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    refresher.requestRefresh('hint');
    await vi.advanceTimersByTimeAsync(0);
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(2);
    expect(state.botName).toBe('新名Bot');
    refresher.stop();
  });

  it('a dashboard rename is not reverted by an in-flight or not-yet-propagated fetch', async () => {
    const feishu = fakeFeishu('旧名Bot');
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);

    // A periodic fetch is in flight when the renamer writes the new name.
    let release!: (p: FetchedBotProfile) => void;
    feishu.fetchProfile.mockImplementationOnce(() => new Promise(r => { release = r; }));
    await onePeriod();
    state.botName = '新名Bot';
    refresher.noteLocalWrite();
    release({ openId: 'ou_self', name: '旧名Bot' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.botName).toBe('新名Bot');

    // Next read still serves the old version (publish not propagated) → held.
    await onePeriod();
    expect(state.botName).toBe('新名Bot');
    expect(changes.filter(c => c.nameChanged && c.previousName === '新名Bot')).toEqual([]);

    // After the hold window the open platform is authoritative again.
    feishu.rename('再改Bot');
    await onePeriod();
    await onePeriod();
    expect(state.botName).toBe('再改Bot');
    refresher.stop();
  });

  it('a failed derived write is retried on the next successful fetch even if nothing changed', async () => {
    const feishu = fakeFeishu('Bot');
    const state: BotProfileState = {};
    let failWrites = true;
    const written: string[] = [];
    const refresher = createBotProfileRefresher({
      larkAppId: APP,
      fetchProfile: feishu.fetchProfile,
      state: () => state,
      onChange: () => {
        if (failWrites) throw new Error('EACCES bots-info');
        written.push(state.botName ?? '');
      },
      intervalMs: INTERVAL,
    });
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([]);
    failWrites = false;
    await onePeriod();
    expect(written).toEqual(['Bot']);
    await onePeriod();
    expect(written).toEqual(['Bot']); // settled: no further rewrites
    refresher.stop();
  });

  it('a fetch that settles after stop() changes nothing', async () => {
    const feishu = fakeFeishu('旧名Bot');
    let release!: (p: FetchedBotProfile) => void;
    feishu.fetchProfile.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const state: BotProfileState = {};
    const { refresher, changes } = wire(feishu, state);
    refresher.start();
    refresher.stop();
    release({ openId: 'ou_self', name: '新名Bot' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toEqual({});
    expect(changes).toEqual([]);
  });

  it('refreshNow works before start() and does not arm the periodic timer', async () => {
    const feishu = fakeFeishu('Bot');
    const state: BotProfileState = {};
    const { refresher } = wire(feishu, state);
    await expect(refresher.refreshNow('manual')).resolves.toBe(true);
    expect(state.botName).toBe('Bot');
    await onePeriod();
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels further periodic fetches', async () => {
    const feishu = fakeFeishu('Bot');
    const { refresher } = wire(feishu, {});
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    refresher.stop();
    await onePeriod();
    await onePeriod();
    expect(feishu.fetchProfile).toHaveBeenCalledTimes(1);
  });
});
