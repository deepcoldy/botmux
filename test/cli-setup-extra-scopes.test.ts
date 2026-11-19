/**
 * `botmux setup add|configure --extra-scopes-file`：记下的路径怎么落盘、怎么沿用、怎么降级。
 *
 * 直接跑 cmdSetupScripted，读写 vitest 临时 HOME 下的真 bots.json；只替换开放平台自动配置、
 * supervisor 启动、旧 pm2 清理和凭证 / owner 校验这些要出网或碰进程的出口。
 *
 * Run: pnpm vitest run test/cli-setup-extra-scopes.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  automateOpenPlatformSetup: vi.fn(),
  createFeishuOpenPlatformApp: vi.fn(),
  inspectCachedFeishuOpenPlatformSession: vi.fn(),
  onReadDefaultScopeManifest: vi.fn(),
  startBotViaSupervisor: vi.fn(),
  validateCredentials: vi.fn(),
}));

vi.mock('../src/setup/open-platform-automation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/setup/open-platform-automation.js')>();
  return {
    ...actual,
    automateOpenPlatformSetup: mocks.automateOpenPlatformSetup,
    createFeishuOpenPlatformApp: mocks.createFeishuOpenPlatformApp,
    inspectCachedFeishuOpenPlatformSession: mocks.inspectCachedFeishuOpenPlatformSession,
    readStoredCookiesFromSessionFile: () => [],
    readDefaultScopeManifest: () => {
      mocks.onReadDefaultScopeManifest();
      return actual.readDefaultScopeManifest();
    },
  };
});

vi.mock('../src/core/fleet-runtime.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startBotViaSupervisor: mocks.startBotViaSupervisor,
}));

vi.mock('../src/core/legacy-pm2-reaper.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reapLegacyPm2: () => ({ found: false, unresolved: false }),
}));

vi.mock('../src/setup/verify-permissions.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateCredentials: mocks.validateCredentials,
}));

vi.mock('../src/setup/owner-identity.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  normalizeManagedOwnerEntries: async (entries: string | undefined) => entries,
  detectUnusableOwnerEntries: async () => [],
}));

vi.mock('../src/setup/cli-availability.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkCliAvailability: () => ({ available: true }),
}));

import { cmdSetupScripted } from '../src/cli.js';

const botsFile = join(homedir(), '.botmux', 'bots.json');
const scratch = mkdtempSync(join(tmpdir(), 'botmux-cli-extra-scopes-'));
const extraFile = join(scratch, 'extra.json');
const otherFile = join(scratch, 'other.json');
const emptyFile = join(scratch, 'empty.json');
writeFileSync(extraFile, '{"scopes":{"tenant":["spark:app:read"]}}');
writeFileSync(otherFile, '{"scopes":["spark:app:write"]}');
writeFileSync(emptyFile, '{"scopes":{}}');

function botEntry(appId: string, extra: Record<string, unknown> = {}) {
  return { larkAppId: appId, larkAppSecret: `secret-${appId}`, cliId: 'claude-code', allowedUsers: ['a@b.com'], ...extra };
}

function writeBots(bots: unknown[]): void {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true });
  writeFileSync(botsFile, JSON.stringify(bots, null, 2));
}

function readBots(): any[] {
  return JSON.parse(readFileSync(botsFile, 'utf8'));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function lastJson(): any {
  const calls = logSpy.mock.calls.map(args => String(args[0]));
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].trimStart().startsWith('{')) return JSON.parse(calls[i]);
  }
  throw new Error(`no JSON output: ${calls.join('\n')}`);
}

function manifestPassedToAutomation(): any {
  expect(mocks.automateOpenPlatformSetup).toHaveBeenCalledTimes(1);
  return mocks.automateOpenPlatformSetup.mock.calls[0][0].scopeManifest;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.automateOpenPlatformSetup.mockResolvedValue({
    ok: true,
    sessionSource: 'botmux_cache',
    scopeCount: 3,
    skippedScopeCount: 0,
    redirectConfigured: true,
    versionId: 'v1',
  });
  mocks.startBotViaSupervisor.mockReturnValue({ ok: false, reason: 'fleet_down', message: 'daemon 未在运行' });
  mocks.validateCredentials.mockResolvedValue({ ok: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BOTMUX_COORDINATION_MODE;
  process.exitCode = undefined;
});

describe('setup configure --extra-scopes-file', () => {
  it('显式传入：合并清单交给自动配置，并把绝对路径记到该机器人', async () => {
    writeBots([botEntry('cli_a')]);

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', extraFile, '--json']);

    expect(manifestPassedToAutomation().scopes.tenant).toContain('spark:app:read');
    expect(readBots()[0].extraScopesFile).toBe(extraFile);
    const out = lastJson();
    expect(out).toMatchObject({ ok: true, extraScopes: { file: extraFile, merged: true, addedScopeCount: 1 } });
    expect(out.bot.extraScopesFile).toBe(extraFile);
    expect(process.exitCode).toBeUndefined();
  });

  it('不带参重跑沿用已记的路径，且不重写 bots.json', async () => {
    writeBots([botEntry('cli_a', { extraScopesFile: extraFile })]);
    const before = readFileSync(botsFile, 'utf8');

    await cmdSetupScripted(['configure', 'cli_a', '--json']);

    expect(manifestPassedToAutomation().scopes.tenant).toContain('spark:app:read');
    expect(readFileSync(botsFile, 'utf8')).toBe(before);
    expect(lastJson()).toMatchObject({ ok: true, extraScopes: { file: extraFile, merged: true } });
  });

  it('显式传入的新文件覆盖已记的路径', async () => {
    writeBots([botEntry('cli_a', { extraScopesFile: extraFile })]);

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', otherFile, '--json']);

    const manifest = manifestPassedToAutomation();
    expect(manifest.scopes.user).toContain('spark:app:write');
    expect(manifest.scopes.tenant).not.toContain('spark:app:read');
    expect(readBots()[0].extraScopesFile).toBe(otherFile);
  });

  it('已记的文件不见了：告警后按内置清单继续，路径保留', async () => {
    const gone = join(scratch, 'gone.json');
    writeBots([botEntry('cli_a', { extraScopesFile: gone })]);

    await cmdSetupScripted(['configure', 'cli_a', '--json']);

    expect(manifestPassedToAutomation()).toBeUndefined();
    const out = lastJson();
    expect(out).toMatchObject({ ok: true, extraScopes: { file: gone, merged: false } });
    expect(out.extraScopes.warning).toMatch(/gone\.json/);
    expect(readBots()[0].extraScopesFile).toBe(gone);
  });

  it('已记的文件不见了时 --switch-account 重跑也不被卡住', async () => {
    writeBots([botEntry('cli_a', { extraScopesFile: join(scratch, 'gone.json') })]);

    await cmdSetupScripted(['configure', 'cli_a', '--switch-account', '--json']);

    expect(mocks.automateOpenPlatformSetup).toHaveBeenCalledTimes(1);
    expect(mocks.automateOpenPlatformSetup.mock.calls[0][0]).toMatchObject({ forceQrLogin: true, scopeManifest: undefined });
  });

  it('显式传入的文件有问题直接失败：不跑自动配置、不动 bots.json', async () => {
    writeBots([botEntry('cli_a', { extraScopesFile: extraFile })]);
    const before = readFileSync(botsFile, 'utf8');

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', join(scratch, 'gone.json'), '--json']);

    expect(mocks.automateOpenPlatformSetup).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: false });
    expect(readFileSync(botsFile, 'utf8')).toBe(before);
    expect(process.exitCode).toBe(1);
  });

  it('--extra-scopes-file - 清除已记的路径，本次只申请内置清单', async () => {
    writeBots([botEntry('cli_a', { extraScopesFile: join(scratch, 'gone.json') })]);

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', '-', '--json']);

    expect(manifestPassedToAutomation()).toBeUndefined();
    expect(readBots()[0]).not.toHaveProperty('extraScopesFile');
    const out = lastJson();
    expect(out).toMatchObject({ ok: true, extraScopes: { file: null, merged: false, cleared: true } });
    expect(out.bot).not.toHaveProperty('extraScopesFile');
  });

  it('只改这一个机器人的字段：运行期间并发写入 bots.json 的变更不丢', async () => {
    writeBots([botEntry('cli_a')]);
    mocks.onReadDefaultScopeManifest.mockImplementation(() => {
      const current = readBots();
      current[0].displayName = '并发改名';
      writeBots([...current, botEntry('cli_b')]);
    });

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', extraFile, '--json']);

    const bots = readBots();
    expect(bots.map(b => b.larkAppId)).toEqual(['cli_a', 'cli_b']);
    expect(bots[0]).toMatchObject({ extraScopesFile: extraFile, displayName: '并发改名' });
  });

  it('primary 协调模式下记不下路径时返回结构化错误，不跑自动配置', async () => {
    writeBots([botEntry('cli_a')]);
    const before = readFileSync(botsFile, 'utf8');
    process.env.BOTMUX_COORDINATION_MODE = 'primary';

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', extraFile, '--json']);

    expect(mocks.automateOpenPlatformSetup).not.toHaveBeenCalled();
    const out = lastJson();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/记录追加权限清单路径失败/);
    expect(readFileSync(botsFile, 'utf8')).toBe(before);
    expect(process.exitCode).toBe(1);
  });

  it('primary 协调模式下不带参重跑不需要写盘，照常沿用（路径写法未规范化也一样）', async () => {
    for (const saved of [extraFile, `${scratch}/./extra.json`]) {
      writeBots([botEntry('cli_a', { extraScopesFile: saved })]);
      const before = readFileSync(botsFile, 'utf8');
      process.env.BOTMUX_COORDINATION_MODE = 'primary';
      mocks.automateOpenPlatformSetup.mockClear();

      await cmdSetupScripted(['configure', 'cli_a', '--json']);

      expect(manifestPassedToAutomation().scopes.tenant).toContain('spark:app:read');
      expect(lastJson()).toMatchObject({ ok: true, extraScopes: { file: extraFile, merged: true } });
      expect(readFileSync(botsFile, 'utf8')).toBe(before);
    }
  });

  it('Lark 机器人显式传清单直接失败，不记路径、不跑自动配置；- 清除照常可用', async () => {
    writeBots([botEntry('cli_a', { brand: 'lark', extraScopesFile: extraFile })]);
    const before = readFileSync(botsFile, 'utf8');

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', otherFile, '--json']);

    expect(mocks.automateOpenPlatformSetup).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ ok: false });
    expect(lastJson().error).toMatch(/Lark/);
    expect(readFileSync(botsFile, 'utf8')).toBe(before);

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', '-', '--json']);
    expect(readBots()[0]).not.toHaveProperty('extraScopesFile');
  });

  it('清单未贡献内置清单之外的权限时给告警（JSON 与人类可读输出）', async () => {
    writeBots([botEntry('cli_a')]);
    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', emptyFile, '--json']);
    expect(lastJson().extraScopes).toMatchObject({ merged: true, addedScopeCount: 0 });
    expect(lastJson().extraScopes.warning).toMatch(/未贡献内置清单之外的权限/);

    mocks.automateOpenPlatformSetup.mockClear();
    await cmdSetupScripted(['configure', 'cli_a']);
    expect(warnSpy.mock.calls.map(args => String(args[0])).join('\n')).toMatch(/未贡献内置清单之外的权限/);
  });

  it('自动配置未完成时 partial JSON 也带 extraScopes', async () => {
    writeBots([botEntry('cli_a')]);
    mocks.automateOpenPlatformSetup.mockResolvedValue({ ok: false, reason: 'network', message: 'console 不可达' });

    await cmdSetupScripted(['configure', 'cli_a', '--extra-scopes-file', extraFile, '--json']);

    expect(lastJson()).toMatchObject({ ok: false, partial: true, extraScopes: { file: extraFile, merged: true } });
    expect(readBots()[0].extraScopesFile).toBe(extraFile);
  });
});

describe('setup add --extra-scopes-file', () => {
  it('新机器人写入时带上路径，合并清单交给自动配置', async () => {
    writeBots([botEntry('cli_a')]);

    await cmdSetupScripted([
      'add', '--app-id', 'cli_new', '--app-secret', 'secret-new', '--allowed-users', 'a@b.com',
      '--working-dir', scratch, '--open-platform-auto', '--extra-scopes-file', extraFile, '--json',
    ]);

    expect(manifestPassedToAutomation().scopes.tenant).toContain('spark:app:read');
    const bots = readBots();
    expect(bots.map(b => b.larkAppId)).toEqual(['cli_a', 'cli_new']);
    expect(bots[1].extraScopesFile).toBe(extraFile);
    expect(lastJson()).toMatchObject({ ok: true, action: 'add', extraScopes: { file: extraFile, merged: true } });
  });

  it('应用已创建、配置未写入时的 partial JSON 也带 extraScopes，续跑命令带上清单路径', async () => {
    writeBots([botEntry('cli_a')]);
    const before = readFileSync(botsFile, 'utf8');
    mocks.inspectCachedFeishuOpenPlatformSession.mockResolvedValue({
      ok: true,
      identity: { userId: 'u_1', userName: 'Alice', tenantId: 't_1', tenantName: 'Example' },
    });
    mocks.createFeishuOpenPlatformApp.mockResolvedValue({ ok: true, appId: 'cli_created', appSecret: 'secret-created', brand: 'feishu' });
    mocks.validateCredentials.mockResolvedValue({ ok: false, error: 'invalid_secret', message: '凭证无效' });

    await cmdSetupScripted([
      'add', '--create-app', '--allowed-users', 'a@b.com', '--working-dir', scratch,
      '--extra-scopes-file', extraFile, '--json',
    ]);

    const out = lastJson();
    expect(out).toMatchObject({ ok: false, partial: true, appId: 'cli_created', extraScopes: { file: extraFile, merged: true } });
    expect(out.continueCommand).toContain(`--extra-scopes-file ${extraFile}`);
    expect(mocks.automateOpenPlatformSetup).not.toHaveBeenCalled();
    expect(readFileSync(botsFile, 'utf8')).toBe(before);
  });
});
