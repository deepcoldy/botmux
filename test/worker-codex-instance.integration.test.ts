import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const fixtures: Array<{ root: string; child: ChildProcess; observation: string }> = [];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(predicate: () => boolean, logs: string[], timeout = 12000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${logs.join('')}`);
    await pause(25);
  }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
afterEach(async () => {
  for (const { child, root, observation } of fixtures.splice(0)) {
    if (child.connected) child.send({ type: 'close' });
    await until(() => child.exitCode !== null || child.signalCode !== null, [], 3000).catch(() => child.kill('SIGKILL'));
    await until(() => child.exitCode !== null || child.signalCode !== null, [], 3000);
    // PTY children create their own process groups. Record every fake CLI PID
    // (including short-lived metadata probes), and reap any surviving process.
    const pids = existsSync(observation) ? readFileSync(observation, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid as number) : [];
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await until(() => pids.every(pid => !alive(pid)), [], 3000);
    rmSync(root, { recursive: true, force: true });
  }
});

function launch(missingHome = false, readIsolation = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-worker-instance-')));
  const home = join(root, 'instance-a');
  const dataDir = join(root, 'session');
  mkdirSync(dataDir);
  if (!missingHome) {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), '{"tokens":{"access_token":"fixture-only"}}', { mode: 0o600 });
  }
  const observation = join(root, 'cli-observation.jsonl');
  const cli = join(root, 'fake-codex');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(observation)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), home: process.env.CODEX_HOME, key: process.env.OPENAI_API_KEY, codexKey: process.env.CODEX_API_KEY, base: process.env.OPENAI_BASE_URL, gatewayConfigured: fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8').includes('[mcp_servers.botmux]') }) + '\\n');
if (process.argv.includes('--version')) { console.log('codex-cli 0.1.0'); process.exit(0); }
process.stdin.resume();
setTimeout(() => process.stdout.write('›\\n'), 50);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  chmodSync(cli, 0o755);
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'), env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'wrong-global-home'), OPENAI_API_KEY: 'wrong-key', CODEX_API_KEY: 'wrong-codex-key', OPENAI_BASE_URL: 'https://wrong.invalid', SESSION_DATA_DIR: dataDir, BOTMUX_TIME_SCALE: '0.05', BOTMUX_SESSION_ID: 'instance-worker-test', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'fixture-secret' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  fixtures.push({ root, child, observation });
  child.on('message', raw => { messages.push(raw as WorkerToDaemon); logs.push(JSON.stringify(raw)); });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({ type: 'init', sessionId: 'instance-worker-test', chatId: 'oc_fixture', rootMessageId: 'om_fixture', workingDir: dataDir,
    cliId: 'codex', cliPathOverride: cli, backendType: 'pty', prompt: '', readIsolation,
    cliInstanceBinding: { version: 1, source: 'default', instanceId: 'a', cliId: 'codex', codexHome: home, authMode: 'isolated' },
    larkAppId: 'app_test', larkAppSecret: 'fixture-secret',
  } satisfies DaemonToWorker);
  return { root, home, observation, child, logs, messages };
}

describe('frozen Codex instance through real worker IPC (workflow PTY path)', () => {
  it('launches the fake CLI with the frozen HOME and removes inherited authentication overrides', async () => {
    const f = launch();
    await until(() => f.messages.some(m => m.type === 'ready'), f.logs);
    await until(() => existsSync(f.observation), f.logs);
    const invocations = readFileSync(f.observation, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.home).toBe(f.home);
      expect(invocation.key).toBeUndefined();
      expect(invocation.codexKey).toBeUndefined();
      expect(invocation.base).toBeUndefined();
      if (!invocation.argv.includes('--version')) expect(invocation.gatewayConfigured).toBe(true);
    }
    expect(existsSync(join(f.root, 'wrong-global-home'))).toBe(false);
  }, 20000);
  it('fails before spawning any CLI when the frozen home is missing, without global fallback', async () => {
    const f = launch(true);
    await until(() => f.child.exitCode !== null || f.child.signalCode !== null || f.messages.some(m => m.type === 'error'), f.logs);
    expect(f.messages.some(m => m.type === 'ready')).toBe(false);
    expect(existsSync(f.observation)).toBe(false);
    expect(existsSync(join(f.root, 'wrong-global-home'))).toBe(false);
  }, 20000);
  it('rejects explicit read isolation instead of silently disabling it for a bound instance', async () => {
    const f = launch(false, true);
    await until(() => f.child.exitCode !== null || f.child.signalCode !== null || f.messages.some(m => m.type === 'error'), f.logs);
    expect(f.messages.some(m => m.type === 'ready')).toBe(false);
    expect(f.logs.join('')).toContain('Codex instance routing does not support sandbox/readIsolation');
    expect(existsSync(f.observation)).toBe(false);
  }, 20000);
});
