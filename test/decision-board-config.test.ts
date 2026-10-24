/**
 * 管家配置（bots.json `steward`）：加载、/config 写入（等于默认不写盘、非法拒绝），
 * 以及管家群常驻提示只出现在「开了管家的 bot × 它的管家群」。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-config-'));
  configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(dir, 'config.json');
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function writeBots(entries: Array<Record<string, unknown>>) {
  writeFileSync(configPath, JSON.stringify(entries.map(e => ({
    larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_owner'], ...e,
  })), null, 2));
}

async function loaded(entries: Array<Record<string, unknown>>) {
  writeBots(entries);
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  const sessionManager = await import('../src/core/session-manager.js');
  registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
  return { registry, store, sessionManager };
}

describe('bots.json steward', () => {
  it('合法配置原样加载；非法配置按关处理，不阻断 bot 启动', async () => {
    const { registry } = await loaded([
      { larkAppId: 'app_ok', steward: { enabled: true, chatId: 'oc_s', guideText: '只催不合' } },
      { larkAppId: 'app_bad', steward: { enabled: true, chatId: 'not-a-chat' } },
      { larkAppId: 'app_none' },
    ]);
    expect(registry.getBot('app_ok').config.steward).toEqual({ enabled: true, chatId: 'oc_s', guideText: '只催不合' });
    expect(registry.getBot('app_bad').config.steward).toBeUndefined();
    expect(registry.getBot('app_none').config.steward).toBeUndefined();
  });

  it('/config steward：写入合法值；等于默认删掉字段；非法值拒绝且不改盘', async () => {
    const { registry, store } = await loaded([{ larkAppId: 'app_a' }]);
    const spec = store.findConfigField('steward')!;
    const set = async (raw: unknown) => {
      const coerced = store.coerceConfigValue(spec, JSON.stringify(raw));
      if (!coerced.ok) return coerced;
      return store.applyConfigField('app_a', spec, coerced.value);
    };
    expect(await set({ enabled: true, chatId: 'oc_s' })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))[0].steward).toEqual({ enabled: true, chatId: 'oc_s' });
    expect(registry.getBot('app_a').config.steward).toEqual({ enabled: true, chatId: 'oc_s' });

    expect(await set({ enabled: true, guideMode: 'replace' })).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))[0].steward).toEqual({ enabled: true, chatId: 'oc_s' });

    expect(await set({ enabled: false })).toMatchObject({ ok: true });
    expect('steward' in JSON.parse(readFileSync(configPath, 'utf8'))[0]).toBe(false);
  });
});

describe('管家群常驻提示', () => {
  it('只在开了管家的 bot 的管家群里出现', async () => {
    const { sessionManager } = await loaded([
      { larkAppId: 'app_s', steward: { enabled: true, chatId: 'oc_steward' } },
      { larkAppId: 'app_off', steward: { enabled: false, chatId: 'oc_steward' } },
      { larkAppId: 'app_plain' },
    ]);
    const block = sessionManager.renderStewardContextBlock('app_s', 'oc_steward');
    expect(block).toContain('<botmux_steward chat_id="oc_steward">');
    expect(block).toContain('botmux board guide');
    expect(sessionManager.renderStewardContextBlock('app_s', 'oc_other')).toBe('');
    expect(sessionManager.renderStewardContextBlock('app_off', 'oc_steward')).toBe('');
    expect(sessionManager.renderStewardContextBlock('app_plain', 'oc_steward')).toBe('');
    expect(sessionManager.renderStewardContextBlock('app_unknown', 'oc_steward')).toBe('');
  });
});
