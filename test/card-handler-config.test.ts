/**
 * `/botconfig` 交互卡片：usageDisplay 是三态枚举,经 config_set 选项写入,
 * coerce 校验枚举值并即时落盘 + 同步内存 config。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const deps = {
  activeSessions: new Map(),
  sessionReply: vi.fn(async () => 'om_reply'),
  lastRepoScan: new Map(),
} as any;

let root: string;
let configPath: string;

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(cfg => registry.registerBot(cfg));
  return { registry, handler };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-card-config-'));
  configPath = join(root, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_config',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedUsers: ['ou_owner'],
  }], null, 2));
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('/botconfig usageDisplay enum', () => {
  it('config_set writes a non-default usageDisplay (footer) and syncs runtime config', async () => {
    const { registry, handler } = await fresh();
    const result = await handler.handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: 'config_set',
          field: 'usageDisplay',
          loc: 'en',
        },
        option: 'footer',
      },
    }, deps, 'app_config');

    expect(result?.toast).toMatchObject({
      type: 'success',
      content: '✓ usageDisplay = footer',
    });
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].usageDisplay).toBe('footer');
    expect(registry.getBot('app_config').config.usageDisplay).toBe('footer');
  });

  it('config_set rejects an invalid usageDisplay value', async () => {
    const { registry, handler } = await fresh();
    const result = await handler.handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: { action: 'config_set', field: 'usageDisplay', loc: 'en' },
        option: 'nonsense',
      },
    }, deps, 'app_config');

    expect(result?.toast?.type).toBe('error');
    // Unchanged on disk / in memory.
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].usageDisplay).toBeUndefined();
    expect(registry.getBot('app_config').config.usageDisplay).toBeUndefined();
  });
});
