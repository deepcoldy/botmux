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

  it('rejects sandbox --into because its thread is not bound to the validated chat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-cli-into-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    const result = await runCli([
      'dispatch', '--session-id', 'source-session', '--into', 'om_other',
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
      errorCode: 'ROUTING_NOT_SUPPORTED',
    });
    expect(String(errorReceipt(result.stderr).detail)).toContain('--into');
    expect(readdirSync(outbox).some(name => name.endsWith('.req.json'))).toBe(false);
  });

  it('fails sandbox send routing with exit 2 and no relay request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-cli-routing-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outbox = join(root, 'outbox');
    mkdirSync(dataDir);
    mkdirSync(outbox);
    replaceManagedOriginCapabilityFile(
      join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: 'cd'.repeat(32), turnId: 'turn-live', dispatchAttempt: 1 }),
    );
    writeFileSync(join(dataDir, 'sessions-app-a.json'), JSON.stringify({
      session: {
        sessionId: 'session', chatId: 'oc_source', rootMessageId: 'om_source',
        title: 'source', status: 'active', createdAt: new Date(0).toISOString(),
        larkAppId: 'app-a', cliId: 'codex-app',
        codexAppDispatchLedger: [{
          dispatchId: 'dispatch-live', turnId: 'turn-live', dispatchAttempt: 1,
          state: 'prepared', content: 'prompt', deliverySink: 'lark',
        }],
      },
    }));
    const result = await runCli([
      'send', 'must not send', '--session-id', 'session', '--chat-id', 'oc_target',
      '--top-level', '--no-mention',
    ], {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'session',
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_WORKFLOW: '',
    });
    expect(result.code).toBe(2);
    expect(errorReceipt(result.stderr)).toMatchObject({
      success: false,
      transportState: 'failed',
      acceptanceState: 'not_requested',
      errorCode: 'ROUTING_NOT_SUPPORTED',
    });
    expect(readdirSync(outbox).some(name => name.endsWith('.req.json'))).toBe(false);
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
