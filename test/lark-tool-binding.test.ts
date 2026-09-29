import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { larkToolBindingPath, larkToolChildEnv, parseLarkToolInvocation as parseInvocation, prepareLarkToolEnv, readLarkToolBinding, usesLarkToolBinding, hasLarkToolBinding } from '../src/core/lark-tool-binding.js';
import { readLarkToolHelp, fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lark-tool-binding-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const defaults = { appId: 'cli_current', defaultAs: 'bot' as const };
const parseLarkToolInvocation = (args: string[], binding: { appId: string; defaultAs: 'bot' | 'user' }) => {
  const { args: output, mode, offline } = parseInvocation(args, binding, readLarkToolHelp);
  return { args: output, mode, offline };
};

describe('managed lark-cli binding', () => {
  it('binds new standard sessions and leaves old/adopt/remote sessions alone', () => {
    const config = { sessionId: 'session-a', larkAppId: 'cli_current', chatId: 'oc_chat', backendType: 'pty' as const };
    expect(usesLarkToolBinding(config, dir)).toBe(true);
    expect(usesLarkToolBinding({ ...config, resume: true }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, resume: true, forkSession: true }, dir)).toBe(true);
    expect(usesLarkToolBinding({ ...config, adoptMode: true }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, backendType: 'riff' }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, apiOnly: true }, dir)).toBe(false);
    expect(usesLarkToolBinding(config, dir, true)).toBe(false);
    prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: config.sessionId, appId: config.larkAppId });
    expect(hasLarkToolBinding(dir, config.sessionId)).toBe(true);
    expect(usesLarkToolBinding({ ...config, resume: true }, dir)).toBe(true);
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
    ['--profile', 'cli_other'], ['--profile='], ['--as='], ['--as', 'owner'],
    ['--as', 'bot', '--as=user'], ['--profile=cli_current', '--profile=cli_current'],
    ['profile', 'use', 'other'], ['config', 'init'], ['auth', 'login'], ['update'],
  ].map(args => ({ args })))('refuses account changes or conflicting selectors: $args', ({ args }) => {
    expect(() => parseLarkToolInvocation(args, defaults)).toThrow();
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
    expect(parseLarkToolInvocation(['skills', 'install'], defaults).offline).toBe(false);
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
    const botEnv = larkToolChildEnv({ HOME: dir, HTTPS_PROXY: 'http://proxy', LARKSUITE_CLI_APP_ID: 'cli_other', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'wrong-user' }, first, { mode: 'bot', credential: 'bot-secret' });
    expect(botEnv.LARKSUITE_CLI_APP_ID).toBe(defaults.appId);
    expect(botEnv.LARKSUITE_CLI_BRAND).toBe('lark');
    expect(botEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined();
    expect(botEnv.HTTPS_PROXY).toBe('http://proxy');
    const userEnv = larkToolChildEnv(botEnv, first, { mode: 'user', credential: 'own-user' });
    expect(userEnv.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
    expect(userEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe('own-user');
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
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
    prepareLarkToolEnv({ env, dataDir: dir, sessionId: 'session-a', appId: defaults.appId });
    const result = spawnSyncTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), [
      '--binding', larkToolBindingPath(dir, 'session-a'), '--', '--version',
    ], { env, encoding: 'utf8' });
    expect(result.status, String(result.stderr)).toBe(3);
    expect(result.stdout).toBe('cli_current|--version');
  });
});
