/**
 * 统一的 Bot 显示名解析（按 larkAppId 现查，只用于展示）：优先级、离线退回、
 * 不把 PM2 进程名 / appId 当名字、bots-info 损坏不抛出；以及 Dashboard 展示处
 * 接上它之后，存档里写死的旧名不再显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBotDisplayNameLookup,
  lastKnownBotName,
  pickBotDisplayName,
  readPersistedBotNameMap,
} from '../src/services/bot-display-name.js';
import { __resetBotsInfoCacheForTest } from '../src/services/bots-info-cache.js';
import { upsertBotInfoEntries } from '../src/services/bots-info-store.js';
import { buildResourceMonitorDaemonSeeds } from '../src/dashboard/resource-monitor-service.js';
import { noteSelfMentionNames, setSelfMentionNameObserver } from '../src/im/lark/event-dispatcher.js';

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-display-name-'));
  __resetBotsInfoCacheForTest();
});

afterEach(() => {
  __resetBotsInfoCacheForTest();
  setSelfMentionNameObserver(null);
  rmSync(dataDir, { recursive: true, force: true });
});

/** Write the shared file the way daemons do (atomic replace, new inode). */
function writeBotsInfo(rows: Array<{ larkAppId: string; botName: string }>): void {
  upsertBotInfoEntries(dataDir, rows.map(r => ({ ...r, botOpenId: null, botAvatarUrl: null, cliId: 'claude-code' })));
}

describe('pickBotDisplayName', () => {
  it('displayName alias > live descriptor name > persisted Feishu name', () => {
    expect(pickBotDisplayName({ larkAppId: 'cli_a', displayName: '别名', liveName: '在线名', persistedName: '飞书名' })).toBe('别名');
    expect(pickBotDisplayName({ larkAppId: 'cli_a', liveName: '在线名', persistedName: '飞书名' })).toBe('在线名');
    expect(pickBotDisplayName({ larkAppId: 'cli_a', persistedName: '飞书名' })).toBe('飞书名');
  });

  it('skips placeholders: blank names and the raw app id', () => {
    expect(pickBotDisplayName({ larkAppId: 'cli_a', liveName: 'cli_a', persistedName: '飞书名' })).toBe('飞书名');
    expect(pickBotDisplayName({ larkAppId: 'cli_a', displayName: '  ', liveName: null })).toBeUndefined();
  });
});

describe('persisted names (bots-info.json)', () => {
  it('reads appId → Feishu name; missing or corrupt file yields no names and does not throw', () => {
    expect(readPersistedBotNameMap(dataDir).size).toBe(0);
    writeFileSync(join(dataDir, 'bots-info.json'), '{not json');
    expect(() => readPersistedBotNameMap(dataDir)).not.toThrow();
    expect(readPersistedBotNameMap(dataDir).size).toBe(0);
    expect(lastKnownBotName('cli_a', dataDir)).toBeUndefined();
  });

  it('a later rewrite of the shared file is picked up by the next lookup', () => {
    writeBotsInfo([{ larkAppId: 'cli_a', botName: '旧名' }]);
    const before = createBotDisplayNameLookup({ configs: [], liveName: () => undefined, dataDir });
    expect(before('cli_a')).toBe('旧名');
    writeBotsInfo([{ larkAppId: 'cli_a', botName: '新名' }]);
    const after = createBotDisplayNameLookup({ configs: [], liveName: () => undefined, dataDir });
    expect(after('cli_a')).toBe('新名');
    expect(lastKnownBotName('cli_a', dataDir)).toBe('新名');
  });
});

describe('dashboard display sites re-resolve by appId', () => {
  it('offline bots show the persisted Feishu name, never the PM2 process name', () => {
    writeBotsInfo([{ larkAppId: 'cli_off', botName: '飞书现名' }]);
    const nameOf = createBotDisplayNameLookup({ configs: [{ larkAppId: 'cli_off' }], liveName: () => undefined, dataDir });
    const seeds = buildResourceMonitorDaemonSeeds(
      [{ larkAppId: 'cli_off', name: 'botmux-17' }],
      [],
      nameOf,
    );
    expect(seeds[0]?.botName).toBe('飞书现名');
  });

  it('never-probed bots get no invented name (callers keep their own last resort)', () => {
    const nameOf = createBotDisplayNameLookup({ configs: [{ larkAppId: 'cli_new' }], liveName: () => undefined, dataDir });
    expect(nameOf('cli_new')).toBeUndefined();
  });
});

describe('self-mention rename hint', () => {
  it('reports only an @ of this bot whose name differs from the cached name', () => {
    const seen: string[] = [];
    setSelfMentionNameObserver((_app, name) => seen.push(name));
    const self = { id: { open_id: 'ou_self' }, name: '新名Bot' };
    const other = { id: { open_id: 'ou_other' }, name: '别的Bot' };
    noteSelfMentionNames('cli_a', [other, self], 'ou_self', '旧名Bot');
    noteSelfMentionNames('cli_a', [{ ...self, name: '旧名Bot' }], 'ou_self', '旧名Bot');
    noteSelfMentionNames('cli_a', [other], 'ou_self', '旧名Bot');
    expect(seen).toEqual(['新名Bot']);
  });

  it('a throwing observer never escapes into the @ gate', () => {
    setSelfMentionNameObserver(() => { throw new Error('boom'); });
    expect(() => noteSelfMentionNames('cli_a', [{ id: { open_id: 'ou_self' }, name: 'x' }], 'ou_self', 'y')).not.toThrow();
  });
});

describe('dashboard store relabels cached rows after a rename', () => {
  it('rewrites botName of cached session/schedule rows by appId and bumps the version', async () => {
    vi.resetModules();
    const { store } = await import('../src/dashboard/web/store.js');
    store.replaceSnapshot(
      [{ sessionId: 's1', status: 'idle', larkAppId: 'cli_a', botName: '旧名Bot' }, { sessionId: 's2', status: 'idle', larkAppId: 'cli_b', botName: 'B' }],
      [{ id: 't1', larkAppId: 'cli_a', botName: '旧名Bot' }],
    );
    const before = store.getSnapshot().version;
    const names: Record<string, string> = { cli_a: '新名Bot' };
    expect(store.relabelBots(appId => names[appId])).toBe(true);
    const snap = store.getSnapshot();
    expect(snap.sessions.get('s1')?.botName).toBe('新名Bot');
    expect(snap.sessions.get('s2')?.botName).toBe('B');
    expect(snap.schedules.get('t1')?.botName).toBe('新名Bot');
    expect(snap.version).toBeGreaterThan(before);
    expect(store.relabelBots(appId => names[appId])).toBe(false);
  });
});

describe('dashboard name maps follow bots.changed', () => {
  it('reloadNameMaps refetches past the page-lifetime memo', async () => {
    vi.resetModules();
    let name = '旧名Bot';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ chats: [], bots: [{ larkAppId: 'cli_a', botName: name }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ui = await import('../src/dashboard/web/ui.js');
      await ui.loadNameMaps();
      expect(ui.botDisplayName({ larkAppId: 'cli_a', botName: '存档旧名' })).toBe('旧名Bot');

      name = '新名Bot';
      await ui.loadNameMaps(); // memoized: same page lifetime → no refetch
      expect(ui.botNameForAppId('cli_a')).toBe('旧名Bot');

      await ui.reloadNameMaps();
      expect(ui.botNameForAppId('cli_a')).toBe('新名Bot');
      expect(ui.botDisplayName({ larkAppId: 'cli_a', botName: '存档旧名' })).toBe('新名Bot');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a cached (localStorage) name the server no longer confirms does not beat the row name', async () => {
    vi.resetModules();
    const storage = new Map<string, string>([['botmux.avatarCache.v1', JSON.stringify({ nameByAppId: { cli_off: '下线前旧名' } })]]);
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ chats: [], bots: [] }) }) as unknown as Response));
    try {
      const ui = await import('../src/dashboard/web/ui.js');
      expect(ui.botNameForAppId('cli_off')).toBe('下线前旧名'); // first paint placeholder
      await ui.loadNameMaps();
      expect(ui.botNameForAppId('cli_off')).toBeUndefined();
      expect(ui.botDisplayName({ larkAppId: 'cli_off', botName: '服务端现名' })).toBe('服务端现名');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
