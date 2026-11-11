import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { larkToolBindingPath, larkToolChildEnv, larkToolPrompt, larkToolPromptFromEnv, parseLarkToolInvocation as parseInvocation, prepareLarkToolEnv, readLarkToolBinding, usesLarkToolBinding, hasLarkToolBinding, cleanupLarkToolBinding, larkToolLoopbackService, sessionLarkToolBound } from '../src/core/lark-tool-binding.js';
import { sessionIdentityBinDir, sessionIdentityDataDir } from '../src/core/cli-identity.js';
import { GRANT_ROUTE_CLIENT_TIMEOUT_MS, TOTAL_BUDGET_MS } from '../src/platform/credential-grant-budget.js';
import { readLarkToolHelp, fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { nodeTsRunnerPrefix, spawnSyncTsScript, spawnTsScript } from './helpers/ts-runner.js';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lark-tool-binding-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const defaults = { appId: 'cli_current', defaultAs: 'bot' as const };
const parseLarkToolInvocation = (args: string[], binding: { appId: string; defaultAs: 'bot' | 'user' }) => {
  const { args: output, mode, offline, passthroughProfile } = parseInvocation(args, binding, readLarkToolHelp);
  return { args: output, mode, offline, passthroughProfile };
};

describe('managed lark-cli binding', () => {
  it('declares one exact authenticated loopback route for the current session identity', () => {
    expect(larkToolLoopbackService('session-a', 7950)).toEqual({
      id: 'lark-tool-identity',
      listenPort: 7950,
      upstreamPort: 7950,
      method: 'POST',
      path: '/api/sessions/session-a/lark-tool-identity',
      forwardHeaders: ['content-type', 'x-botmux-lark-session'],
      attestProcessPeer: true,
      // The route can run a platform grant: the relay must outlast it.
      upstreamTimeoutMs: GRANT_ROUTE_CLIENT_TIMEOUT_MS,
    });
    expect(GRANT_ROUTE_CLIENT_TIMEOUT_MS).toBeGreaterThan(TOTAL_BUDGET_MS);
  });

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

  it('/login routing: decided from configuration before the first spawn, from the file once a worker runs', () => {
    const sessionId = 'session-login';
    const spawnFacts = { sessionId, larkAppId: 'cli_current', chatId: 'oc_chat', backendType: 'pty' as const };
    const bound = (o: Partial<Parameters<typeof sessionLarkToolBound>[0]> = {}) => sessionLarkToolBound({
      botConfig: {}, dataDir: dir, sessionId, workerLive: false, spawnFacts, ...o,
    });
    // New topic, no worker, no file yet: same answer the worker will give.
    expect(bound()).toBe(true);
    expect(bound({ botConfig: { larkToolBinding: false } })).toBe(false);
    expect(bound({ spawnFacts: { ...spawnFacts, adoptMode: true } })).toBe(false);
    expect(bound({ workflow: true })).toBe(false);
    // A live worker without the file runs the legacy wrapper.
    expect(bound({ workerLive: true })).toBe(false);
    prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId, appId: defaults.appId });
    expect(bound({ workerLive: true })).toBe(true);
    expect(bound({ workerLive: true, botConfig: { larkToolBinding: false } })).toBe(false);
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
  it('binds new local headless runners without enabling other API-only sessions', () => {
    const config = { sessionId: 'headless-session', larkAppId: 'cli_current',
      chatId: 'headless_hl_11111111-1111-4111-8111-111111111111', backendType: 'pty' as const,
      headless: { id: 'hl_11111111-1111-4111-8111-111111111111', source: 'cli' } };
    expect(usesLarkToolBinding(config, dir)).toBe(true);
    // Same lifecycle as ordinary sessions: resume re-evaluates the bot switch.
    expect(usesLarkToolBinding({ ...config, resume: true }, dir)).toBe(true);
    expect(usesLarkToolBinding({ ...config, larkToolBinding: false }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, apiOnly: true }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, chatId: 'http_async_runner' }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, chatId: 'http_wait_runner' }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, headless: undefined }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, chatId: 'headless_forged-http-chat' }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, headless: { id: 'hl_invalid', source: 'cli' } }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, headless: { ...config.headless, source: 'webhook' } }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, adoptMode: true }, dir)).toBe(false);
    expect(usesLarkToolBinding({ ...config, backendType: 'riff' }, dir)).toBe(false);
    expect(usesLarkToolBinding(config, dir, true)).toBe(false);
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
    expect(env.BOTMUX_WRAPPER_BIN).toBe(join(dir, '.botmux', 'bin'));
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
    expect(userEnv.LARKSUITE_CLI_APP_ID).toBe(defaults.appId);
    // A platform-issued user grant runs under the platform's application; a bot
    // call can never be moved off the bound application.
    const platformUserEnv = larkToolChildEnv(botEnv, first, { mode: 'user', credential: 'platform-user', appId: 'cli_platform' });
    expect(platformUserEnv.LARKSUITE_CLI_APP_ID).toBe('cli_platform');
    expect(platformUserEnv.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe('platform-user');
    expect(platformUserEnv.LARKSUITE_CLI_CONFIG_DIR).toBe(first.configDir);
    expect(larkToolChildEnv(botEnv, first, { mode: 'bot', credential: 'bot-token', appId: 'cli_platform' }).LARKSUITE_CLI_APP_ID).toBe(defaults.appId);
    expect(larkToolPromptFromEnv('en', env)).toContain('lark-cli uses application cli_current');
    expect(larkToolPromptFromEnv('zh', env)).toContain('lark-cli 固定使用当前机器人的应用 cli_current');
    const headlessEnv = { ...env, BOTMUX_CHAT_ID: 'headless_hl_runner' };
    for (const locale of ['en', 'zh']) {
      expect(larkToolPromptFromEnv(locale, headlessEnv)).toBe(larkToolPrompt(defaults.appId, locale, true));
      expect(larkToolPromptFromEnv(locale, headlessEnv)).not.toBe(larkToolPrompt(defaults.appId, locale, false));
    }
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
  it('reports a stable bridge rejection code instead of hiding it as an unavailable identity', async () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const real = join(bin, 'lark-cli');
    writeFileSync(real, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write("unexpected execution");\n');
    chmodSync(real, 0o755);
    symlinkSync(nodeTsRunnerPrefix().command, join(bin, 'node'));
    const env = { PATH: bin, HOME: dir };
    const binding = prepareLarkToolEnv({ env, dataDir: dir, sessionId: 'session-a', appId: defaults.appId });
    const server = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'botmux_protected_loopback_forbidden' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      binding.ipcPort = (server.address() as { port: number }).port;
      writeFileSync(larkToolBindingPath(dir, 'session-a'), JSON.stringify(binding), { mode: 0o600 });
      const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
        const child = spawnTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), [
          '--binding', larkToolBindingPath(dir, 'session-a'), '--', 'docs', '+fetch', '--doc', 'doc-token',
        ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout!.on('data', data => { out += data; });
        child.stderr!.on('data', data => { err += data; });
        child.once('error', reject);
        child.once('close', code => resolve({ code, out, err }));
      });
      expect(result.code).toBe(77);
      expect(result.err).toContain('botmux_protected_loopback_forbidden');
      expect(result.out).toBe('');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
