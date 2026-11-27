import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { encodeRunnerInput } from '../src/adapters/cli/runner-input.js';
import {
  CodexAppControlLineDecoder,
  codexAppControlSocketPath,
  createCodexAppControlBootstrap,
  encodeCodexAppControlAccepted,
  encodeCodexAppControlAck,
  encodeCodexAppControlChallenge,
  generateCodexAppControlChallenge,
  parseCodexAppControlWireRecord,
  verifyCodexAppControlAuth,
} from '../src/utils/codex-app-control.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { readPidFile } from './helpers/pid-file.js';

/**
 * The developer instructions the real codex-app runner sends on thread/start,
 * for the argv the real adapter builds. The runner is a CLI child and never sees
 * the native gateway marker, so in a native gateway core the adapter has to tell
 * it; without that the model is told it talks to Feishu/Lark.
 */
const APP = 'local_wecom_runnerfix';
const SESSION_ID = 'session-runner-native';
const RUNNER = resolve('src/codex-app-runner.ts');
const FAKE = resolve('test/fixtures/fake-codex-app-server.mjs');
// Run last-registered first: the runner and its app-server stop before the
// socket closes and before their directories are removed (a still-running
// app-server appending to its log made the removal fail with ENOTEMPTY, and the
// throw skipped the kill, orphaning the runner). Every step runs; the first
// failure is reported after all of them.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  const failures: unknown[] = [];
  for (const f of cleanups.splice(0).reverse()) {
    try { await f(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
});

/** SIGTERM (the runner closes its app-server on it), SIGKILL after a grace period; resolves on exit. */
async function stopRunner(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveExit => {
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => { clearTimeout(force); resolveExit(); });
    child.kill('SIGTERM');
  });
}

/** Wait until the fake app-server (the runner's child, not ours to reap) is gone. */
async function waitForAppServerExit(pidPath: string, timeoutMs = 10_000): Promise<void> {
  const pid = readPidFile(pidPath);
  if (pid === undefined) return; // never started
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`fake app-server ${pid} still running ${timeoutMs}ms after its runner exited`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function adapterArgv(mode: 'native' | 'bare-core', locale: 'zh' | 'en', botName = APP): string[] {
  vi.unstubAllEnvs();
  vi.stubEnv('BOTMUX_CORE_ONLY', '1');
  if (mode === 'native') vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
  const argv = createCliAdapterSync('codex-app').buildArgs({
    sessionId: SESSION_ID, resume: false, workingDir: '/placeholder', botName, botOpenId: `bot_${APP}`, larkAppId: APP, locale,
  } as any) as string[];
  vi.unstubAllEnvs();
  return argv;
}

/** Run the runner with the adapter's flags until it sends thread/start; return its developerInstructions. */
async function developerInstructions(argv: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-runner-native-'));
  const sockDir = mkdtempSync('/tmp/bca-sock-');
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(sockDir, { recursive: true, force: true }); });
  const fake = join(dir, 'fake-codex');
  copyFileSync(FAKE, fake);
  chmodSync(fake, 0o755);
  const log = join(dir, 'requests.jsonl');
  const pidPath = join(dir, 'app-server.pid');
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd);
  const socketPath = codexAppControlSocketPath(sockDir, SESSION_ID);
  const bootstrap = createCodexAppControlBootstrap(dir, SESSION_ID, socketPath);
  const server: Server = createServer((socket: Socket) => {
    const decoder = new CodexAppControlLineDecoder();
    const challenge = generateCodexAppControlChallenge();
    let authenticated = false;
    socket.on('data', chunk => {
      for (const line of decoder.push(chunk).lines) {
        const record = parseCodexAppControlWireRecord(line);
        if (!record || record.sessionId !== SESSION_ID) { socket.destroy(); return; }
        if (!authenticated) {
          if (record.type !== 'auth' || !verifyCodexAppControlAuth(record, bootstrap.identity.publicKey)) { socket.destroy(); return; }
          authenticated = true;
          socket.write(`${encodeCodexAppControlAccepted(SESSION_ID, bootstrap.identity.generation, challenge)}\n`);
        } else if (record.type === 'marker') {
          socket.write(`${encodeCodexAppControlAck(SESSION_ID, bootstrap.identity.generation, challenge, record.seq)}\n`);
        }
      }
    });
    socket.on('error', () => undefined);
    socket.write(`${encodeCodexAppControlChallenge(SESSION_ID, challenge)}\n`);
  });
  await new Promise<void>(r => server.listen(socketPath, () => r()));
  cleanups.push(() => new Promise<void>(closed => server.close(() => closed())));
  // The adapter's runner flags, minus the three this test points at its fixture.
  const flags: string[] = [];
  for (let i = argv.indexOf('--session-id'); i < argv.length; i++) {
    if (['--session-id', '--codex-bin', '--cwd'].includes(argv[i])) { i++; continue; }
    flags.push(argv[i]);
  }
  const { command, prefixArgs } = tsRunnerPrefix();
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_PID_PATH: pidPath, FAKE_CODEX_VERSION: '0.146.1', FAKE_CODEX_BEHAVIOR: 'success',
    NODE_ENV: 'test', BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP: bootstrap.path };
  delete env.BOTMUX_CODEX_APP_CONTROL_NONCE;
  delete env.BOTMUX_NATIVE_GATEWAY_CORE;
  const child = spawn(command, [...prefixArgs, RUNNER, '--session-id', SESSION_ID, '--codex-bin', fake, '--cwd', cwd, ...flags],
    { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  cleanups.push(async () => { await stopRunner(child); await waitForAppServerExit(pidPath); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 30_000;
  let sent = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
    if (!sent && stdout.includes('Codex App connected.')) {
      sent = true;
      child.stdin.write(`::botmux-codex-app:${encodeRunnerInput('hello (fake)')}\r`);
    }
    if (!existsSync(log)) continue;
    for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const params = record.params ?? record.request?.params;
      if ((record.method ?? record.request?.method) === 'thread/start' && typeof params?.developerInstructions === 'string') {
        return params.developerInstructions;
      }
    }
  }
  throw new Error(`no thread/start\nstdout:${stdout}\nstderr:${stderr}`);
}

/** Sentences banning botmux send with no exception (as in native-gateway-prompt.test.ts). */
function unconditionalSendBans(text: string): string[] {
  return text.split(/\n|(?<=[.;。；])/)
    .filter(s => /botmux send/.test(s))
    .filter(s => /\b(do not|don't|never)\b|不要|禁止|不得/i.test(s))
    .filter(s => !/\b(other|unless|except|only)\b|其它|其他|除非|只有/i.test(s));
}

describe('codex-app runner instructions in a native gateway core', () => {
  it('the adapter flags the runner only in a native gateway core', () => {
    expect(adapterArgv('native', 'zh')).toContain('--native-gateway');
    expect(adapterArgv('bare-core', 'zh')).not.toContain('--native-gateway');
  });

  it.each(['zh', 'en'] as const)('[%s] describe the channel gateway, not Feishu/Lark, and keep the send rule of the turn', async (locale) => {
    const native = await developerInstructions(adapterArgv('native', locale));
    expect(native).not.toMatch(/飞书|Feishu|Lark/i);
    expect(native).not.toMatch(/botmux (history|quoted|bots)/);
    expect(unconditionalSendBans(native)).toEqual([]);
    expect(native).toContain('request_user_input');
    expect(native).not.toContain('open_id');
    expect(native).not.toContain(APP);
    // Same runner, same identity, without the flag: the existing instructions.
    const bare = await developerInstructions(adapterArgv('bare-core', locale));
    expect(bare).not.toBe(native);
    expect(bare).toMatch(/Lark/);
  });

  it('a configured display name still reaches the identity', async () => {
    const native = await developerInstructions(adapterArgv('native', 'en', '客服小助手'));
    expect(native).toContain('客服小助手');
    expect(native).not.toContain('open_id');
  });
});
