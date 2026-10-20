import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { larkToolBindingPath, larkToolChildEnv, larkToolPromptFromEnv, parseLarkToolInvocation as parseInvocation, prepareLarkToolEnv, readLarkToolBinding, usesLarkToolBinding, hasLarkToolBinding, cleanupLarkToolBinding } from '../src/core/lark-tool-binding.js';
import { sessionIdentityBinDir, sessionIdentityDataDir } from '../src/core/cli-identity.js';
import { readLarkToolHelp, fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { nodeTsRunnerPrefix, spawnSyncTsScript } from './helpers/ts-runner.js';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lark-tool-binding-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const defaults = { appId: 'cli_current', defaultAs: 'bot' as const };
const parseLarkToolInvocation = (args: string[], binding: { appId: string; defaultAs: 'bot' | 'user' }) => {
  const { args: output, mode, offline, passthroughProfile } = parseInvocation(args, binding, readLarkToolHelp);
  return { args: output, mode, offline, passthroughProfile };
};

describe('managed lark-cli binding', () => {
  it('is default ON unless explicitly disabled (larkToolBinding: false); leaves adopt/remote/workflow alone', () => {
    const config = { sessionId: 'session-a', larkAppId: 'cli_current', chatId: 'oc_chat', backendType: 'pty' as const };
    // Default on
    expect(usesLarkToolBinding(config, dir)).toBe(true);
    expect(usesLarkToolBinding({ ...config, larkToolBinding: true }, dir)).toBe(true);
    expect(usesLarkToolBinding({ ...config, resume: true }, dir)).toBe(true);

    // Explicit off
    expect(usesLarkToolBinding({ ...config, larkToolBinding: false }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, larkToolBinding: false, resume: true }, dir)).toBe(false);

    // Filtered backends / modes
    expect(usesLarkToolBinding({ ...config, adoptMode: true }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, backendType: 'riff' }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, apiOnly: true }, dir)).toBe(false);
    expect(usesLarkToolBinding(config, dir, true)).toBe(false);
  });

  it('cleans up binding files and managed wrapper when turned off, leaving trigger-user wrappers intact', () => {
    const sessionId = 'session-cleanup';
    const env = { PATH: '/usr/bin:/bin' };
    prepareLarkToolEnv({ env, dataDir: dir, sessionId, appId: defaults.appId });
    expect(hasLarkToolBinding(dir, sessionId)).toBe(true);
    const binDir = sessionIdentityBinDir(dir, sessionId);
    const wrapper = join(binDir, 'lark-cli');
    expect(readFileSync(wrapper, 'utf8')).toContain('# botmux managed lark-cli');

    // Clean up
    cleanupLarkToolBinding(dir, sessionId);
    expect(hasLarkToolBinding(dir, sessionId)).toBe(false);
    expect(() => readFileSync(wrapper, 'utf8')).toThrow();

    // Trigger-user wrapper must be preserved
    writeFileSync(wrapper, '#!/bin/sh\n# botmux trigger-user identity wrapper — generated, do not edit.\nexec real "$@"\n');
    cleanupLarkToolBinding(dir, sessionId);
    expect(readFileSync(wrapper, 'utf8')).toContain('# botmux trigger-user identity wrapper');
  });

  it('cleans up delegations even when dataDir is a symlink alias', async () => {
    const { rememberLarkToolDelegation, getLarkToolDelegation } = await import('../src/core/lark-tool-delegation.js');
    const { isLarkToolBound } = await import('../src/core/lark-tool-binding.js');
    const realDir = join(dir, 'real-data');
    mkdirSync(realDir, { recursive: true });
    const symDir = join(dir, 'sym-data');
    symlinkSync(realDir, symDir);

    const sessionId = 'session-symlink';
    prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: symDir, sessionId, appId: defaults.appId });
    expect(isLarkToolBound({ larkToolBinding: true }, symDir, sessionId)).toBe(true);
    expect(isLarkToolBound({ larkToolBinding: false }, symDir, sessionId)).toBe(false);

    rememberLarkToolDelegation(symDir, sessionId, 'turn-1', { tools: ['lark-cli'] });
    expect(getLarkToolDelegation(symDir, sessionId, 'turn-1')).toBeDefined();
    expect(getLarkToolDelegation(realDir, sessionId, 'turn-1')).toBeDefined();

    // Cleaning up using the real path must also clear delegations accessed via the symlink
    cleanupLarkToolBinding(realDir, sessionId);
    expect(getLarkToolDelegation(symDir, sessionId, 'turn-1')).toBeUndefined();
    expect(getLarkToolDelegation(realDir, sessionId, 'turn-1')).toBeUndefined();
    expect(isLarkToolBound({ larkToolBinding: true }, symDir, sessionId)).toBe(false);
  });
  it('defaults to this bot and selects user without changing the app', () => {
    expect(parseLarkToolInvocation(['docs', '+fetch', '--doc', 'doc-token'], defaults)).toEqual({
      args: ['docs', '+fetch', '--doc', 'doc-token'], mode: 'bot', offline: false,
    });
    expect(parseLarkToolInvocation(['--profile=cli_current', 'docs', '+fetch', '--as=user'], defaults)).toEqual({
      args: ['docs', '+fetch'], mode: 'user', offline: false,
    });
    expect(parseLarkToolInvocation(['docs', '+fetch'], { ...defaults, defaultAs: 'user' }).mode).toBe('user');
  });
  it.each([
    ['--profile='], ['--as='], ['--as', 'owner'],
    ['--as', 'bot', '--as=user'], ['--profile=cli_current', '--profile=cli_current'],
    ['profile', 'use', 'other'], ['config', 'init'], ['auth', 'login'], ['update'],
  ].map(args => ({ args })))('refuses account changes or conflicting selectors: $args', ({ args }) => {
    expect(() => parseLarkToolInvocation(args, defaults)).toThrow();
  });
  it('allows switching to other profiles via --profile as passthrough', () => {
    const parsed = parseLarkToolInvocation(['docs', '+fetch', '--profile', 'cli_other'], defaults);
    expect(parsed.passthroughProfile).toBe('cli_other');
    expect(parsed.args).toEqual(['docs', '+fetch', '--profile', 'cli_other']);
  });
  it('preserves literal payloads and permits credential-free help/schema', () => {
    const args = ['im', '+send', '--text', 'literal --as user', '--', '--profile=other'];
    expect(parseLarkToolInvocation(args, defaults).args).toEqual(args);
    expect(parseLarkToolInvocation(['im', '+send', '--text', '--as=user'], defaults)).toEqual({
      args: ['im', '+send', '--text', '--as=user'], mode: 'bot', offline: false,
    });
    for (const args of [['schema', 'sheets.spreadsheet.sheets.find'], ['auth', 'login', '--help'], ['--version']]) {
      expect(parseLarkToolInvocation(args, defaults).offline).toBe(true);
    }
    expect(() => parseLarkToolInvocation(['skills', 'install'], defaults)).toThrow();
  });
  it('installs an isolated entry, retains the application across RPC and viewer setup', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const real = join(bin, 'lark-cli'); writeFileSync(real, '#!/bin/sh\nexit 0\n'); chmodSync(real, 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
    const first = prepareLarkToolEnv({ env, dataDir: dir, sessionId: 'session-a', appId: defaults.appId, brand: 'lark' });
    const second = prepareLarkToolEnv({ env, dataDir: dir, sessionId: 'session-a', appId: defaults.appId, brand: 'lark' });
    expect(second.accessKey).toBe(first.accessKey);
    expect(second.realBinary).toBe(real);
    expect(readLarkToolBinding(larkToolBindingPath(dir, 'session-a')).appId).toBe(defaults.appId);
    expect(readFileSync(join(first.configDir, 'config.json'), 'utf8')).not.toContain('appSecret');
    const botEnv = larkToolChildEnv({ HOME: dir, HTTPS_PROXY: 'http://proxy', LARKSUITE_CLI_APP_ID: 'cli_other', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'wrong-user', LARKSUITE_CLI_APP_SECRET: 'wrong-secret' }, first, { mode: 'bot', credential: 'bot-token' });
    expect(botEnv.LARKSUITE_CLI_APP_ID).toBe(defaults.appId);
    expect(botEnv.LARKSUITE_CLI_BRAND).toBe('lark');
    expect(botEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(botEnv.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
    expect(botEnv.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe('bot-token');
    expect(botEnv.HTTPS_PROXY).toBe('http://proxy');
    const userEnv = larkToolChildEnv(botEnv, first, { mode: 'user', credential: 'own-user' });
    expect(userEnv.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
    expect(userEnv.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBeUndefined();
    expect(userEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe('own-user');
    expect(larkToolPromptFromEnv('en', env)).toContain('lark-cli uses application cli_current');
    expect(larkToolPromptFromEnv('zh', env)).toContain('lark-cli 固定使用当前机器人的应用 cli_current');
    expect(larkToolPromptFromEnv('en', {})).toBe('');
  });
  it('keeps the configured PATH when viewer setup repeats an RPC binding', () => {
    const daemonBin = join(dir, 'daemon-bin'), botBin = join(dir, 'bot-bin');
    for (const bin of [daemonBin, botBin]) {
      mkdirSync(bin); writeFileSync(join(bin, 'lark-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const input = { dataDir: dir, sessionId: 'rpc-session', appId: defaults.appId };
    const first = prepareLarkToolEnv({ ...input, env: { PATH: botBin } });
    const second = prepareLarkToolEnv({ ...input, env: { PATH: daemonBin }, effectivePath: botBin });
    expect(first.realBinary).toBe(join(botBin, 'lark-cli'));
    expect(second.realBinary).toBe(first.realBinary);
    expect(second.accessKey).toBe(first.accessKey);
  });
  it('executes version offline through the real runner and preserves its exit code', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const real = join(bin, 'lark-cli');
    writeFileSync(real, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write(process.env.LARKSUITE_CLI_APP_ID+"|"+process.argv.slice(2).join(" ")); process.exit(3);\n'); chmodSync(real, 0o755);
    // setup-node installs outside /usr/bin on CI. Give the fixture its own
    // Node entry so its shebang also works with no system directories on PATH.
    symlinkSync(nodeTsRunnerPrefix().command, join(bin, 'node'));
    const env = { PATH: bin, HOME: dir };
    prepareLarkToolEnv({ env, dataDir: dir, sessionId: 'session-a', appId: defaults.appId });
    const result = spawnSyncTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), [
      '--binding', larkToolBindingPath(dir, 'session-a'), '--', '--version',
    ], { env, encoding: 'utf8' });
    expect(result.status, String(result.stderr)).toBe(3);
    expect(result.stdout).toBe('cli_current|--version');
  });
});
