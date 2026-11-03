import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import {
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { SANDBOX_RELAY_ROUTE_GATE_ENV } from '../src/core/sandbox-send-route.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(join(__dirname, '..', 'src', 'cli.ts'), args, {
      cwd: join(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stderr}`));
    }, 10_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function errorReceipt(stderr: string): Record<string, unknown> {
  const line = stderr.trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error('missing stderr receipt');
  return JSON.parse(line) as Record<string, unknown>;
}

describe('sandbox dispatch CLI routing', () => {
  it('dispatches through the host watcher without any readable Session Store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-relay-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(dataDir);
    mkdirSync(outbox);
    const capability = 'ab'.repeat(32);
    replaceManagedOriginCapabilityFile(
      join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability, turnId: 'turn-live', dispatchAttempt: 1 }),
    );
    const calls = join(root, 'calls.jsonl');
    const fixture = join(root, 'dispatch-host.mjs');
    writeFileSync(fixture, `
      import { appendFileSync, readFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      const value = flag => argv[argv.indexOf(flag) + 1];
      const result = {
        command: argv[0],
        sessionId: value('--session-id'),
        chatId: value('--chat-id'),
        targetAppId: value('--bot-app'),
        delegate: value('--delegate'),
        brief: readFileSync(value('--brief-file'), 'utf8'),
      };
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(result) + '\\n');
      process.stdout.write(JSON.stringify(result));
    `);
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'source-session', {
      cliPath: fixture,
      authorize: claim => claim.capability === capability
        ? { ok: true, origin: { turnId: 'turn-live', dispatchAttempt: 1 } }
        : { ok: false, error: 'stale capability' },
    });
    try {
      const result = await runCli([
        'dispatch', '--session-id', 'source-session', '--title', 'work',
        '--bot-app', 'cli_target', '--chat-id', 'oc_target', '--brief', 'bounded task',
        '--delegate', 'schedule:create',
      ], {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'source-session',
        BOTMUX_SEND_RELAY: outbox,
        BOTMUX_WORKFLOW: '',
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        command: 'dispatch',
        sessionId: 'source-session',
        chatId: 'oc_target',
        targetAppId: 'cli_target',
        delegate: 'schedule:create',
        brief: 'bounded task',
      });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readdirSync(dataDir)).toEqual([]);
    } finally {
      stop();
    }
  });

  it('rejects a forged source session before writing an outbox request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-source-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const result = await runCli([
      'dispatch', '--session-id', 'forged-session', '--title', 'work',
      '--bot-app', 'cli_target', '--chat-id', 'oc_target', '--brief', 'task',
    ], {
      ...process.env,
      SESSION_DATA_DIR: join(root, 'data'),
      BOTMUX_SESSION_ID: 'source-session',
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_WORKFLOW: '',
    });
    expect(result.code).toBe(2);
    expect(errorReceipt(result.stderr)).toMatchObject({
      success: false,
      sourceSessionId: 'source-session',
      errorCode: 'SOURCE_SESSION_NOT_AUTHORIZED',
    });
    expect(readdirSync(outbox).some(name => name.endsWith('.req.json'))).toBe(false);
  });

  it('relays sandbox --into to the host, which binds the root to the validated chat', async () => {
    // The relay only carries a bounded om_ id; the host re-exec runs the
    // ordinary dispatch path whose daemon delivery route refuses a root that
    // is not in the target chat (dispatch_chat_mismatch, covered in
    // dispatch-user-route.test.ts).
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-into-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(dataDir);
    mkdirSync(outbox);
    const capability = 'ef'.repeat(32);
    replaceManagedOriginCapabilityFile(
      join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability, turnId: 'turn-live', dispatchAttempt: 1 }),
    );
    const fixture = join(root, 'dispatch-host.mjs');
    writeFileSync(fixture, `
      import { readFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      const value = flag => argv[argv.indexOf(flag) + 1];
      process.stdout.write(JSON.stringify({
        command: argv[0],
        sessionId: value('--session-id'),
        into: value('--into'),
        intoCount: argv.filter(token => token === '--into').length,
        targetAppId: value('--bot-app'),
        brief: readFileSync(value('--brief-file'), 'utf8'),
      }));
    `);
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'source-session', {
      cliPath: fixture,
      authorize: claim => claim.capability === capability
        ? { ok: true, origin: { turnId: 'turn-live', dispatchAttempt: 1 } }
        : { ok: false, error: 'stale capability' },
    });
    try {
      const result = await runCli([
        'dispatch', '--session-id', 'source-session', '--into', 'om_existing_root',
        '--bot-app', 'cli_target', '--brief', 'follow-up task',
      ], {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'source-session',
        BOTMUX_SEND_RELAY: outbox,
        BOTMUX_WORKFLOW: '',
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        command: 'dispatch',
        sessionId: 'source-session',
        into: 'om_existing_root',
        intoCount: 1,
        targetAppId: 'cli_target',
        brief: 'follow-up task',
      });
    } finally {
      stop();
    }
  });

  it.each([
    ['a malformed root', ['--into', 'oc_not_a_message']],
    ['two roots', ['--into', 'om_a', '--into', 'om_b']],
  ])('rejects sandbox --into with %s before writing an outbox request', async (_label, intoArgs) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-into-bad-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const result = await runCli([
      'dispatch', '--session-id', 'source-session', ...intoArgs,
      '--bot-app', 'cli_target', '--brief', 'task',
    ], {
      ...process.env,
      SESSION_DATA_DIR: join(root, 'data'),
      BOTMUX_SESSION_ID: 'source-session',
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_WORKFLOW: '',
    });
    expect(result.code).toBe(2);
    expect(errorReceipt(result.stderr)).toMatchObject({
      success: false,
      errorCode: 'INVALID_DISPATCH_ROOT',
    });
    expect(readdirSync(outbox).some(name => name.endsWith('.req.json'))).toBe(false);
  });

  function sendRelayFixture(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(dataDir);
    mkdirSync(outbox);
    const capability = 'cd'.repeat(32);
    replaceManagedOriginCapabilityFile(
      join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability, turnId: 'turn-live', dispatchAttempt: 1 }),
    );
    const calls = join(root, 'calls.jsonl');
    const hostFixture = join(root, 'send-host.mjs');
    writeFileSync(hostFixture, `
      import { appendFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      const result = { argv, routeGate: process.env.${SANDBOX_RELAY_ROUTE_GATE_ENV} ?? null };
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(result) + '\\n');
      process.stdout.write(JSON.stringify({ success: true }));
    `);
    const env = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'session',
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_WORKFLOW: '',
    };
    const watch = (allowRouting: boolean) => startOutboxWatcher(outbox, { ...process.env }, 'session', {
      cliPath: hostFixture,
      allowRouting,
      authorize: claim => claim.capability === capability
        ? { ok: true, origin: { turnId: 'turn-live', dispatchAttempt: 1 } }
        : { ok: false, error: 'stale capability' },
    });
    const hostCalls = () => existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; routeGate: string | null })
      : [];
    return { outbox, env, watch, hostCalls };
  }

  it('relays sandbox send routing flags to the host re-exec, which carries the route gate', async () => {
    const f = sendRelayFixture('botmux-send-cli-routing-');
    const stop = f.watch(true);
    try {
      const result = await runCli([
        'send', 'broadcast', '--chat-id', 'oc_target', '--top-level', '--no-mention',
      ], f.env);
      expect(result.code, result.stderr).toBe(0);
      const [call, ...rest] = f.hostCalls();
      expect(rest).toEqual([]);
      expect(call!.routeGate).toBe('1');
      expect(call!.argv[0]).toBe('send');
      expect(call!.argv).toEqual(expect.arrayContaining(['--top-level', '--no-mention']));
      expect(call!.argv[call!.argv.indexOf('--chat-id') + 1]).toBe('oc_target');
      // session-id is forced host-side, never taken from the request
      expect(call!.argv[call!.argv.indexOf('--session-id') + 1]).toBe('session');

      const into = await runCli(['send', 'follow-up', '--into', 'om_root', '--no-mention'], f.env);
      expect(into.code, into.stderr).toBe(0);
      const intoCall = f.hostCalls()[1]!;
      expect(intoCall.argv[intoCall.argv.indexOf('--into') + 1]).toBe('om_root');
    } finally {
      stop();
    }
  });

  it('a watcher without routing permission rejects routing flags before any host re-exec', async () => {
    const f = sendRelayFixture('botmux-send-cli-norouting-');
    const stop = f.watch(false);
    try {
      const result = await runCli(['send', 'broadcast', '--chat-id', 'oc_target', '--no-mention'], f.env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('relay rejected: flag not allowed: --chat-id');
      expect(f.hostCalls()).toEqual([]);
    } finally {
      stop();
    }
  });

  it('keeps refusing routing flags in a credential-only pane with exit 2 and no relay request', async () => {
    const f = sendRelayFixture('botmux-send-cli-credonly-');
    const result = await runCli([
      'send', 'must not send', '--session-id', 'session', '--chat-id', 'oc_target',
      '--top-level', '--no-mention',
    ], { ...f.env, BOTMUX_SEND_RELAY_SCOPE: 'send' });
    expect(result.code).toBe(2);
    expect(errorReceipt(result.stderr)).toMatchObject({
      success: false,
      transportState: 'failed',
      acceptanceState: 'not_requested',
      errorCode: 'ROUTING_NOT_SUPPORTED',
    });
    expect(readdirSync(f.outbox).some(name => name.endsWith('.req.json'))).toBe(false);
  });

  it('returns BRIEF_FILE_NOT_FOUND for a missing sandbox brief', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-brief-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const missing = join(root, 'missing.md');
    expect(existsSync(missing)).toBe(false);
    const result = await runCli([
      'dispatch', '--session-id', 'source-session', '--title', 'work',
      '--bot-app', 'cli_target', '--chat-id', 'oc_target', '--brief-file', missing,
    ], {
      ...process.env,
      SESSION_DATA_DIR: join(root, 'data'),
      BOTMUX_SESSION_ID: 'source-session',
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_WORKFLOW: '',
    });
    expect(result.code).toBe(1);
    expect(errorReceipt(result.stderr)).toMatchObject({
      success: false,
      errorCode: 'BRIEF_FILE_NOT_FOUND',
    });
    expect(readdirSync(outbox).some(name => name.endsWith('.req.json'))).toBe(false);
  });
});
