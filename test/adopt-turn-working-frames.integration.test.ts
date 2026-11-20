import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
const tmuxAvailable = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session]); } catch { /* already stopped */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function waitFor(child: ChildProcess, logs: string[], predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${label}\n${logs.join('')}`);
    if (Date.now() > deadline) throw new Error(`timed out: ${label}\n${logs.join('')}`);
    await sleep(25);
  }
}

/**
 * Regression: the screen sampler is started while the worker handles `init`,
 * before any runtime binding exists. Its frames then carried no binding, the
 * host refused every one (runtime_scope_missing), and an adopted pane never
 * reported 「工作中」— the starting-card health check marked every adopt turn
 * longer than 45s as 「长时间无进展」.
 */
describe('adopted pane turn status frames', () => {
  it.skipIf(!tmuxAvailable)('publishes bound working frames for each adopt turn while the CLI is busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-adopt-working-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // A minimal interactive CLI: idle prompt; each submitted line keeps it
    // visibly busy until the test drops the release file, then idle again.
    const fakeCli = join(root, 'fake-cli');
    const release = join(root, 'release');
    writeFileSync(fakeCli, `#!/usr/bin/env node
const { existsSync, rmSync } = require('node:fs');
const readline = require('node:readline');
process.stdout.write('ready\\n> ');
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', () => {
  if (busy) return;
  busy = true;
  let n = 0;
  const timer = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      rmSync(${JSON.stringify(release)});
      clearInterval(timer);
      process.stdout.write('\\ndone\\n> ');
      busy = false;
      return;
    }
    process.stdout.write('\\rworking ' + (n++) + ' ' + '.'.repeat(n % 5) + '     ');
  }, 200);
});
`);
    chmodSync(fakeCli, 0o755);

    const tmuxSession = `botmux-adopt-working-${process.pid}-${Date.now()}`;
    tmuxSessions.add(tmuxSession);
    execFileSync('tmux', ['new-session', '-d', '-x', '160', '-y', '50', '-s', tmuxSession, fakeCli]);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-adopt-working',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    // Answer the runtime reservation the way the host does, so the worker binds
    // the adopted pane to a runtime exactly as in production.
    const runtime = { runtimeId: 'runtime-adopt-working', epoch: 1 };
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      messages.push(message);
      if (message.type === 'runtime_binding_started') {
        child.send({ type: 'runtime_contract_reserved', bindingId: message.bindingId, mayStart: true, runtime } satisfies DaemonToWorker);
      } else if (message.type === 'runtime_binding') {
        child.send({ type: 'runtime_contract_assigned', bindingId: message.bindingId, runtime, mayExecute: true } satisfies DaemonToWorker);
      }
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: 'sid-adopt-working',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'claude-code',
      backendType: 'tmux',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      adoptMode: true,
      adoptTmuxTarget: `${tmuxSession}:0.0`,
      adoptPaneCols: 160,
      adoptPaneRows: 50,
      // Production workers always run under a session contract.
      sessionContract: {
        version: 2,
        session: { appId: 'app_test', sessionId: 'sid-adopt-working' },
        worker: { workerId: 'worker-adopt-working', generation: 1 },
      },
    } satisfies DaemonToWorker);
    await waitFor(child, logs, () => logs.join('').includes('Adopt mode (tmux): observing'), 'adopt attach');
    await sleep(3_000);

    const framesSince = (start: number) => messages.slice(start)
      .filter((m): m is Extract<WorkerToDaemon, { type: 'screen_update' }> => m.type === 'screen_update')
      // A frame the host can admit names the runtime binding it observed; one
      // without a binding is refused as runtime_scope_missing.
      .map(m => `${m.status}:${m.turnId ?? '-'}:${(m as any).sessionContract?.bindingId ? 'bound' : 'unbound'}`);
    const runTurn = async (turnId: string) => {
      const start = messages.length;
      child.send({
        type: 'message', content: `hello ${turnId}`, turnId,
        // The host admits each input as an execution on the bound runtime.
        sessionCommand: { version: 2, runtime, execution: { executionId: `execution-${turnId}`, turnId } },
      } satisfies DaemonToWorker);
      // The CLI stays busy until released: wait for the turn's working frame.
      await waitFor(child, logs, () => framesSince(start).some(frame => frame.startsWith(`working:${turnId}:`)),
        `working frame for ${turnId}`, 30_000);
      const frames = framesSince(start);
      writeFileSync(release, '');
      await waitFor(child, logs, () => messages.slice(start).some(m => m.type === 'prompt_ready'), `prompt_ready after ${turnId}`, 30_000);
      return frames;
    };

    const first = await runTurn('om_turn_one');
    const second = await runTurn('om_turn_two');
    expect(first, JSON.stringify(first)).toContain('working:om_turn_one:bound');
    expect(second, JSON.stringify(second)).toContain('working:om_turn_two:bound');
    expect([...first, ...second].filter(frame => frame.endsWith(':unbound')), JSON.stringify({ first, second })).toEqual([]);
  }, 120_000);
});
