import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRealToolBinary } from '../src/core/cli-identity.js';
import { larkToolBindingPath, larkToolChildEnv, prepareLarkToolEnv, type LarkToolBinding } from '../src/core/lark-tool-binding.js';
import { parseLarkToolInvocation, larkToolExecutionArgs } from '../src/core/lark-tool-command.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const realCli = findRealToolBinary('lark-cli', process.env.PATH);
const canIsolateNetwork = process.platform === 'linux' && spawnSync('bwrap', [
  '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5000 }).status === 0;
describe.skipIf(!realCli)('installed lark-cli command contract (fake credentials)', () => {
  let root: string, binding: LarkToolBinding, server: ReturnType<typeof createServer>, port: number, requests: string[];
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'real-lark-contract-')); requests = [];
    binding = prepareLarkToolEnv({ env: { PATH: process.env.PATH }, dataDir: root, sessionId: 'contract', appId: 'cli_contract' });
    server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const mode = JSON.parse(raw).mode; requests.push(mode);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, appId: binding.appId, mode,
        credentialType: mode === 'bot' ? 'tenant_access_token' : 'user_access_token', credential: 'fake-not-a-live-credential' }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    // Keep real CLI state under a disposable home as well as config/data dirs.
    mkdirSync(join(root, 'home')); binding.ipcPort = port;
    writeFileSync(larkToolBindingPath(root, 'contract'), JSON.stringify(binding), { mode: 0o600 });
  });
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); });
  function run(args: string[]) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolveResult, reject) => {
      const child = spawnTsScript(resolve('src/lark-tool-runner.ts'), ['--binding', larkToolBindingPath(root, 'contract'), '--', ...args], {
        env: { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), BOTMUX_DAEMON_IPC_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout!.on('data', b => out += b); child.stderr!.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => resolveResult({ code, out, err }));
    });
  }
  it.skipIf(!canIsolateNetwork)('resolves the injected bot token for a real API command before the isolated network rejects it', () => {
    const env = larkToolChildEnv({ ...process.env, HOME: join(root, 'home') }, binding,
      { mode: 'bot', credential: 'fake-not-a-live-token' });
    const result = spawnSync('bwrap', ['--unshare-net', '--ro-bind', '/', '/', '--',
      binding.realBinary, 'api', 'GET', '/open-apis/im/v1/messages/fake-message', '--as', 'bot'], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ identity: 'bot', error: { type: 'network' } });
  });
  it('keeps keyword --as=user and dry-run intact through the real binary', async () => {
    const result = await run(['docs', '+fetch', '--doc', 'doc-fixture', '--scope', 'keyword', '--keyword', '--as=user', '--dry-run']);
    expect(result.code, result.err).toBe(0);
    const body = JSON.parse(result.out);
    expect(body.dry_run).toBe(true);
    expect(JSON.stringify(body)).toContain('--as=user');
    expect(requests).toEqual(['bot']);
  });
  it('preserves replacement text without switching to user', async () => {
    const result = await run(['sheets', '+replace', '--spreadsheet-token', 'sheet-fixture', '--sheet-id', 'tab', '--range', 'tab!A1', '--find', 'old', '--replacement', '--as=user', '--dry-run']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).dry_run).toBe(true);
    expect(result.out).toContain('--as=user');
    expect(requests).toEqual(['bot']);
  });
  it.each([['event', 'list', '--json'], ['event', 'schema', 'im.message.receive_v1', '--json'], ['doctor', '--offline']])(
    'passes local command without identity or unsupported flags: %s %s', async (...args) => {
      const direct = (() => {
        try { return { code: 0, out: execFileSync(realCli!, args, { env: larkToolChildEnv({ ...process.env, HOME: join(root, 'home') }, binding), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }; }
        catch (error: any) { return { code: error.status, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') }; }
      })();
      const result = await run(args);
      expect(result.out + result.err).not.toContain('unknown flag');
      expect(result.out + result.err).not.toContain('Unknown lark-cli');
      expect(requests).toEqual([]);
      // doctor can report deliberately unconfigured fake credentials; preserve
      // the CLI's result instead of claiming the fake account is healthy.
      expect(result.code, result.err).toBe(direct.code);
      expect(result.out).toBe(direct.out);
      expect(result.err).toBe(direct.err);
    },
  );
  it('parses the real typed API flag grouping before business execution', () => {
    const input = ['im', 'pins', 'list', '--chat-id', '--as=user', '--dry-run'];
    const parsed = parseLarkToolInvocation(input, binding, command => execFileSync(realCli!, [...command, '--help'], {
      env: larkToolChildEnv(process.env, binding), encoding: 'utf8', timeout: 5000,
    }));
    expect(larkToolExecutionArgs(parsed)).toEqual([...input, '--as', 'bot']);
  });
});
