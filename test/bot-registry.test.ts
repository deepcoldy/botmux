/**
 * Unit tests for bot-registry: loadBotConfigs, registerBot, getBot, getAllBots.
 *
 * Run:  pnpm vitest run test/bot-registry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock @larksuiteoapi/node-sdk — we don't want real Lark connections.
// The Client constructor just stores whatever it receives.
vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  }
  return { Client: FakeClient };
});

// Mock node:fs so loadBotConfigs doesn't touch real disk.
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Fresh-import the module so the internal `bots` Map is empty each time. */
async function freshImport() {
  // resetModules causes vitest to re-evaluate the module (new Map instance)
  vi.resetModules();
  return await import('../src/bot-registry.js');
}

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'app_test_001',
    larkAppSecret: 'secret_001',
    cliId: 'claude-code' as const,
    ...overrides,
  };
}

// ─── registerBot ──────────────────────────────────────────────────────────

describe('registerBot', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should return a BotState with the provided config', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    expect(state.config).toBe(cfg);
  });

  it('should create a Lark Client with appId and appSecret', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    // FakeClient stores opts
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.appId).toBe('app_test_001');
    expect(client.opts.appSecret).toBe('secret_001');
  });

  it('should default the SDK Client domain to feishu when brand is unset', () => {
    const state = mod.registerBot(makeCfg());
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.domain).toBe('https://open.feishu.cn');
  });

  it('should point the SDK Client domain at larksuite.com when brand is lark', () => {
    const state = mod.registerBot(makeCfg({ brand: 'lark' }));
    const client = state.client as unknown as { opts: Record<string, unknown> };
    expect(client.opts.domain).toBe('https://open.larksuite.com');
  });

  it('should set resolvedAllowedUsers from config.allowedUsers', () => {
    const cfg = makeCfg({ allowedUsers: ['u1', 'u2'] });
    const state = mod.registerBot(cfg);
    expect(state.resolvedAllowedUsers).toEqual(['u1', 'u2']);
  });

  it('should default resolvedAllowedUsers to empty array when allowedUsers is undefined', () => {
    const cfg = makeCfg();
    const state = mod.registerBot(cfg);
    expect(state.resolvedAllowedUsers).toEqual([]);
  });

  it('should make the bot retrievable by appId', () => {
    const cfg = makeCfg();
    mod.registerBot(cfg);
    const retrieved = mod.getBot('app_test_001');
    expect(retrieved.config.larkAppId).toBe('app_test_001');
  });

  it('should overwrite a previous registration with the same appId', () => {
    mod.registerBot(makeCfg({ larkAppSecret: 'old' }));
    mod.registerBot(makeCfg({ larkAppSecret: 'new' }));
    const state = mod.getBot('app_test_001');
    expect(state.config.larkAppSecret).toBe('new');
    expect(mod.getAllBots()).toHaveLength(1);
  });
});

// ─── brand parsing ──────────────────────────────────────────────────────────

describe('parseBotConfigsFromText — brand', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('keeps brand "lark" when configured', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', brand: 'lark' },
    ]));
    expect(cfg.brand).toBe('lark');
  });

  it('leaves brand undefined when unset (defaults to feishu downstream)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.brand).toBeUndefined();
  });

  it('drops bogus brand values to undefined', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', brand: 'wechat' },
    ]));
    expect(cfg.brand).toBeUndefined();
  });

  it('keeps a positive-integer maxLiveWorkers cap', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', maxLiveWorkers: 8 },
    ]));
    expect(cfg.maxLiveWorkers).toBe(8);
  });

  it('leaves maxLiveWorkers undefined (= unlimited) when unset', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's' },
    ]));
    expect(cfg.maxLiveWorkers).toBeUndefined();
  });

  it('drops ≤0 / fractional / non-numeric maxLiveWorkers to undefined', () => {
    for (const bad of [0, -2, 1.5, '4', null] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', maxLiveWorkers: bad },
      ]));
      expect(cfg.maxLiveWorkers).toBeUndefined();
    }
  });

  it('normalizes startupCommands (adds leading /, keeps args, dedupes)', () => {
    const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'a', larkAppSecret: 's', startupCommands: ['effort ultracode', '/model opus', '/effort ultracode', '', 7] },
    ]));
    expect(cfg.startupCommands).toEqual(['/effort ultracode', '/model opus']);
  });

  it('leaves startupCommands undefined when unset / empty / non-array', () => {
    for (const val of [undefined, [], '/effort ultracode', ['', '   ']] as const) {
      const [cfg] = mod.parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'a', larkAppSecret: 's', startupCommands: val },
      ]));
      expect(cfg.startupCommands).toBeUndefined();
    }
  });
});

// ─── getBot / getBotClient ────────────────────────────────────────────────

describe('getBot / getBotClient', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should throw for an unknown appId', () => {
    expect(() => mod.getBot('no_such_app')).toThrow('Bot not registered: no_such_app');
  });

  it('should return the correct bot when multiple are registered', () => {
    mod.registerBot(makeCfg({ larkAppId: 'app_a', larkAppSecret: 'sa' }));
    mod.registerBot(makeCfg({ larkAppId: 'app_b', larkAppSecret: 'sb' }));
    expect(mod.getBot('app_a').config.larkAppSecret).toBe('sa');
    expect(mod.getBot('app_b').config.larkAppSecret).toBe('sb');
  });

  it('getBotClient should return the Client instance', () => {
    mod.registerBot(makeCfg());
    const client = mod.getBotClient('app_test_001');
    expect(client).toBeDefined();
    const opts = (client as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.appId).toBe('app_test_001');
  });

  it('getBotClient should throw for unknown appId', () => {
    expect(() => mod.getBotClient('missing')).toThrow('Bot not registered: missing');
  });
});

// ─── getAllBots ────────────────────────────────────────────────────────────

describe('getAllBots', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;

  beforeEach(async () => {
    mod = await freshImport();
  });

  it('should return an empty array when nothing is registered', () => {
    expect(mod.getAllBots()).toEqual([]);
  });

  it('should return all registered bots', () => {
    mod.registerBot(makeCfg({ larkAppId: 'a1', larkAppSecret: 's1' }));
    mod.registerBot(makeCfg({ larkAppId: 'a2', larkAppSecret: 's2' }));
    mod.registerBot(makeCfg({ larkAppId: 'a3', larkAppSecret: 's3' }));
    const all = mod.getAllBots();
    expect(all).toHaveLength(3);
    const ids = all.map(b => b.config.larkAppId).sort();
    expect(ids).toEqual(['a1', 'a2', 'a3']);
  });
});


// ─── isChatOncallBoundForAnyBot ───────────────────────────────────────────

describe('isChatOncallBoundForAnyBot', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fsMock: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; statSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mod = await freshImport();
    const fs = await import('node:fs');
    fsMock = {
      existsSync: fs.existsSync as unknown as ReturnType<typeof vi.fn>,
      readFileSync: fs.readFileSync as unknown as ReturnType<typeof vi.fn>,
      statSync: fs.statSync as unknown as ReturnType<typeof vi.fn>,
    };
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.statSync.mockReset();
    delete process.env.BOTS_CONFIG;
  });

  it('sees oncall chats bound to a sibling bot in the shared config file', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ mtimeMs: 100 });
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'app_a', larkAppSecret: 'sa' },
      { larkAppId: 'app_b', larkAppSecret: 'sb', oncallChats: [{ chatId: 'oc_oncall', workingDir: '/repo' }] },
    ]));

    const configs = mod.loadBotConfigs();
    mod.registerBot(configs[0]);

    expect(mod.findOncallChat('app_a', 'oc_oncall')).toBeUndefined();
    expect(mod.isChatOncallBoundForAnyBot('oc_oncall')).toBe(true);
    expect(mod.findOncallChatForAnyBot('oc_oncall')).toEqual({ chatId: 'oc_oncall', workingDir: '/repo' });
    expect(mod.isChatOncallBoundForAnyBot('oc_other')).toBe(false);
  });

  it('refreshes the sibling oncall cache when bots.json mtime changes', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync
      .mockReturnValueOnce({ mtimeMs: 1 })
      .mockReturnValueOnce({ mtimeMs: 2 })
      .mockReturnValueOnce({ mtimeMs: 2 });
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([{ larkAppId: 'app_a', larkAppSecret: 'sa' }]));

    const configs = mod.loadBotConfigs();
    mod.registerBot(configs[0]);

    // First lookup builds a negative cache from the original file content.
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([{ larkAppId: 'app_a', larkAppSecret: 'sa' }]));
    expect(mod.isChatOncallBoundForAnyBot('oc_new')).toBe(false);

    // A later mtime causes the cache to refresh and pick up sibling bindings.
    fsMock.readFileSync.mockReturnValueOnce(JSON.stringify([
      { larkAppId: 'app_a', larkAppSecret: 'sa' },
      { larkAppId: 'app_b', larkAppSecret: 'sb', oncallChats: [{ chatId: 'oc_new', workingDir: '/repo' }] },
    ]));
    expect(mod.isChatOncallBoundForAnyBot('oc_new')).toBe(true);
    expect(mod.findOncallChatForAnyBot('oc_new')?.workingDir).toBe('/repo');
  });
});

// ─── loadBotConfigs ───────────────────────────────────────────────────────

describe('loadBotConfigs', () => {
  let mod: Awaited<ReturnType<typeof freshImport>>;
  let fsMock: { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn>; statSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mod = await freshImport();
    // Grab mocked fs functions
    const fs = await import('node:fs');
    fsMock = {
      existsSync: fs.existsSync as unknown as ReturnType<typeof vi.fn>,
      readFileSync: fs.readFileSync as unknown as ReturnType<typeof vi.fn>,
      statSync: fs.statSync as unknown as ReturnType<typeof vi.fn>,
    };
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.statSync.mockReset();
    fsMock.statSync.mockReturnValue({ mtimeMs: 0 });
    // Clean env
    delete process.env.BOTS_CONFIG;
  });

  it('should throw when no config source is available', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(() => mod.loadBotConfigs()).toThrow('No bot configuration found');
  });

  it('should throw when BOTS_CONFIG env points to a missing file', () => {
    process.env.BOTS_CONFIG = '/tmp/nowhere/bots.json';
    fsMock.existsSync.mockReturnValue(false);
    expect(() => mod.loadBotConfigs()).toThrow('BOTS_CONFIG file not found');
  });

  it('should load config from BOTS_CONFIG env var', () => {
    process.env.BOTS_CONFIG = '/tmp/bots.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'env_app', larkAppSecret: 'env_secret' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].larkAppId).toBe('env_app');
    expect(configs[0].larkAppSecret).toBe('env_secret');
    expect(configs[0].cliId).toBe('claude-code'); // default
  });

  it('should fall back to ~/.botmux/bots.json when BOTS_CONFIG is not set', () => {
    // No BOTS_CONFIG env var
    // existsSync: first call (for BOTS_CONFIG) won't happen since env isn't set,
    // second call for default path should return true
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'default_app', larkAppSecret: 'default_secret', cliId: 'aiden' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].larkAppId).toBe('default_app');
    expect(configs[0].cliId).toBe('aiden');
  });

  it('should throw on invalid JSON', () => {
    process.env.BOTS_CONFIG = '/tmp/bad.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('not valid json {{{');

    expect(() => mod.loadBotConfigs()).toThrow('Invalid JSON in bot config file');
  });

  it('should throw when JSON is not an array', () => {
    process.env.BOTS_CONFIG = '/tmp/obj.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ larkAppId: 'x', larkAppSecret: 'y' }));

    expect(() => mod.loadBotConfigs()).toThrow('must contain a JSON array');
  });

  it('should throw when larkAppId is missing', () => {
    process.env.BOTS_CONFIG = '/tmp/noid.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppSecret: 'secret' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppId is required');
  });

  it('should throw when larkAppSecret is missing', () => {
    process.env.BOTS_CONFIG = '/tmp/nosecret.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'app1' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppSecret is required');
  });

  it('should throw when larkAppId is not a string', () => {
    process.env.BOTS_CONFIG = '/tmp/badtype.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 123, larkAppSecret: 'secret' },
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [0]: larkAppId is required and must be a string');
  });

  it('should report correct index for validation errors in second entry', () => {
    process.env.BOTS_CONFIG = '/tmp/idx.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'ok', larkAppSecret: 'ok' },
      { larkAppId: 'also_ok' }, // missing secret
    ]));

    expect(() => mod.loadBotConfigs()).toThrow('Bot config [1]: larkAppSecret is required');
  });

  it('should parse all optional fields', () => {
    process.env.BOTS_CONFIG = '/tmp/full.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_full',
      larkAppSecret: 'secret_full',
      name: 'codex-main',
      cliId: 'gemini',
      cliPathOverride: '/usr/local/bin/gemini',
      disableCliBypass: true,
      sandbox: true,
      sandboxHidePaths: ['~/.ssh', '', 42, '/etc/secret'],
      sandboxReadonlyPaths: ['/srv/source-a-readonly', '  /srv/source-b-readonly  ', null],
      sandboxNetwork: false,
      backendType: 'tmux',
      workingDir: '/home/user/project',
      allowedUsers: ['alice', 'bob'],
      allowedChatGroups: ['oc_team', 'oc_project'],
    }]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(1);
    const c = configs[0];
    expect(c.name).toBe('codex-main');
    expect(c.cliId).toBe('gemini');
    expect(c.cliPathOverride).toBe('/usr/local/bin/gemini');
    expect(c.disableCliBypass).toBe(true);
    expect(c.sandbox).toBe(true);
    expect(c.sandboxHidePaths).toEqual(['~/.ssh', '/etc/secret']);
    expect(c.sandboxReadonlyPaths).toEqual(['/srv/source-a-readonly', '/srv/source-b-readonly']);
    expect(c.sandboxNetwork).toBe(false);
    expect(c.backendType).toBe('tmux');
    expect(c.workingDir).toBe('/home/user/project');
    expect(c.allowedUsers).toEqual(['alice', 'bob']);
    expect(c.allowedChatGroups).toEqual(['oc_team', 'oc_project']);
  });

  it('defaults disableCliBypass to false when omitted', () => {
    process.env.BOTS_CONFIG = '/tmp/no-disable-cli-bypass.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app',
      larkAppSecret: 'secret',
    }]));

    const configs = mod.loadBotConfigs();
    expect(configs[0].disableCliBypass).toBe(false);
  });

  it('should split comma-separated workingDir into workingDirs', () => {
    process.env.BOTS_CONFIG = '/tmp/dirs.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_dirs',
      larkAppSecret: 'secret_dirs',
      workingDir: '/proj/a, /proj/b, /proj/c',
    }]));

    const configs = mod.loadBotConfigs();
    const c = configs[0];
    expect(c.workingDirs).toEqual(['/proj/a', '/proj/b', '/proj/c']);
    expect(c.workingDir).toBe('/proj/a'); // first element
  });

  it('should preserve explicit workingDirs over workingDir splitting', () => {
    process.env.BOTS_CONFIG = '/tmp/explicit.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_explicit',
      larkAppSecret: 'secret_explicit',
      workingDir: '/old/single',
      workingDirs: ['/new/a', '/new/b'],
    }]));

    const configs = mod.loadBotConfigs();
    const c = configs[0];
    expect(c.workingDirs).toEqual(['/new/a', '/new/b']);
    expect(c.workingDir).toBe('/new/a'); // first from workingDirs
  });

  it('should handle multiple bot entries', () => {
    process.env.BOTS_CONFIG = '/tmp/multi.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'bot1', larkAppSecret: 's1', cliId: 'claude-code' },
      { larkAppId: 'bot2', larkAppSecret: 's2', cliId: 'aiden' },
      { larkAppId: 'bot3', larkAppSecret: 's3', cliId: 'coco' },
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs).toHaveLength(3);
    expect(configs.map(c => c.larkAppId)).toEqual(['bot1', 'bot2', 'bot3']);
    expect(configs.map(c => c.cliId)).toEqual(['claude-code', 'aiden', 'coco']);
  });

  it('should parse defaultWorkingDir as an optional string', () => {
    process.env.BOTS_CONFIG = '/tmp/defwd.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([
      { larkAppId: 'a1', larkAppSecret: 's1', defaultWorkingDir: '~/projects/foo' },
      { larkAppId: 'a2', larkAppSecret: 's2' },                      // unset → undefined
      { larkAppId: 'a3', larkAppSecret: 's3', defaultWorkingDir: '' },  // empty → undefined
      { larkAppId: 'a4', larkAppSecret: 's4', defaultWorkingDir: '   ' }, // whitespace → undefined
      { larkAppId: 'a5', larkAppSecret: 's5', defaultWorkingDir: 42 }, // non-string → undefined
      { larkAppId: 'a6', larkAppSecret: 's6', defaultWorkingDir: '  /repos/bar  ' }, // trimmed
    ]));

    const configs = mod.loadBotConfigs();
    expect(configs[0].defaultWorkingDir).toBe('~/projects/foo');
    expect(configs[1].defaultWorkingDir).toBeUndefined();
    expect(configs[2].defaultWorkingDir).toBeUndefined();
    expect(configs[3].defaultWorkingDir).toBeUndefined();
    expect(configs[4].defaultWorkingDir).toBeUndefined();
    expect(configs[5].defaultWorkingDir).toBe('/repos/bar');
  });

  it('should handle empty workingDir string gracefully', () => {
    process.env.BOTS_CONFIG = '/tmp/empty_wd.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_empty_wd',
      larkAppSecret: 'secret',
      workingDir: '',
    }]));

    const configs = mod.loadBotConfigs();
    // Empty string is falsy so the comma-split path is never taken;
    // workingDirs stays undefined, workingDir falls through to the raw value.
    expect(configs[0].workingDirs).toBeUndefined();
    expect(configs[0].workingDir).toBe('');
  });

  it('should return empty array for an empty JSON array', () => {
    process.env.BOTS_CONFIG = '/tmp/empty_arr.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('[]');

    const configs = mod.loadBotConfigs();
    expect(configs).toEqual([]);
  });

  // ── defaultOncall parsing ────────────────────────────────────────────────

  it('should parse a fully-formed defaultOncall entry', () => {
    process.env.BOTS_CONFIG = '/tmp/default_oncall.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncall: { enabled: true, workingDir: '/projects/x', since: 1700000000000 },
      defaultOncallAutoboundChats: ['oc_one', 'oc_two'],
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall).toEqual({
      enabled: true,
      workingDir: '/projects/x',
      since: 1700000000000,
    });
    expect(c.defaultOncallAutoboundChats).toEqual(['oc_one', 'oc_two']);
  });

  it('should coerce defaultOncall.enabled=true to false when workingDir is blank', () => {
    // Hand-edited configs can be inconsistent: enabled but no dir. Treat as
    // off so we never auto-bind into a blank path.
    process.env.BOTS_CONFIG = '/tmp/default_oncall_blank.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncall: { enabled: true, workingDir: '', since: 100 },
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall?.enabled).toBe(false);
    expect(c.defaultOncall?.workingDir).toBe('');
  });

  it('should leave defaultOncall undefined when the field is absent', () => {
    process.env.BOTS_CONFIG = '/tmp/no_default.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d', larkAppSecret: 's',
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncall).toBeUndefined();
    expect(c.defaultOncallAutoboundChats).toBeUndefined();
  });

  it('should drop non-string entries from defaultOncallAutoboundChats', () => {
    process.env.BOTS_CONFIG = '/tmp/autobound_mixed.json';
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify([{
      larkAppId: 'app_d',
      larkAppSecret: 's',
      defaultOncallAutoboundChats: ['oc_ok', 42, null, 'oc_also'],
    }]));

    const c = mod.loadBotConfigs()[0];
    expect(c.defaultOncallAutoboundChats).toEqual(['oc_ok', 'oc_also']);
  });
});
