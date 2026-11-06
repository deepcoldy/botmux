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

function writeBotsInfo(rows: unknown): void {
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(rows));
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

  it('a stale name frozen into an online row loses to the current name', () => {
    writeBotsInfo([{ larkAppId: 'cli_on', botName: '飞书现名' }]);
    const nameOf = createBotDisplayNameLookup({ configs: [{ larkAppId: 'cli_on' }], liveName: () => '飞书现名', dataDir });
    const seeds = buildResourceMonitorDaemonSeeds(
      [{ larkAppId: 'cli_on' }],
      [{ larkAppId: 'cli_on', botName: '改名前', pid: 1 }],
      nameOf,
    );
    expect(seeds[0]?.botName).toBe('飞书现名');
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
});
