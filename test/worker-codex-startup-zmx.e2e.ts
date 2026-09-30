import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { resolveNodeExecutable, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

// Real worker IPC, real ZMX history/resync, and a deterministic CLI stdin sink.
// No model/API/Feishu traffic; no HOME override or live ZMX socket access.
it.skipIf(process.platform === 'win32' || !ZmxBackend.isAvailable()).each([
  ['banner', 'before'], ['banner', 'after'],
  ['resume', 'before'], ['resume', 'after'], ['warm-resume', 'after'], ['reattach', 'after'], ['resume-append', 'before'],
  ['warm-banner', 'after'], ['reattach-banner', 'after'],
] as const)(
  'delivers ZMX %s input arriving %s initialization without waiting for the first-prompt timeout',
  async (mode, arrival) => {
    const root = mkdtempSync('/tmp/bmx-startup-');
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const socketDir = join(root, 'zmx');
    for (const dir of [home, dataDir, socketDir]) mkdirSync(dir);
    const loadingFile = join(root, 'loading');
    const releaseFile = join(root, 'release');
    const inputFile = join(root, 'input');
    const fakeCli = join(root, 'fake-codex');
    const fakeScript = join(root, 'fake-codex.cjs');
    const node = resolveNodeExecutable();
    if (!node) throw new Error('Node is required for the fake CLI');
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(fakeCli, `#!/bin/sh\nexec ${quote(node)} ${quote(fakeScript)} "$@"\n`);
    chmodSync(fakeCli, 0o755);
    let resumedHistory = readFileSync(join(process.cwd(), 'test/fixtures/codex-startup/zmx-history-resumed.txt'), 'utf8')
      .replace('• Previous conversation restored.', 'old output\n'.repeat(60));
    if (mode === 'warm-banner' || mode === 'reattach-banner') {
      const banner = readFileSync(join(process.cwd(), 'test/fixtures/codex-startup/zmx-history-initialized.txt'), 'utf8').split('\n\n  Tip:')[0];
      resumedHistory = banner + '\n\n' + 'old output\n'.repeat(60)
        + resumedHistory.slice(resumedHistory.lastIndexOf('›'));
    }
    writeFileSync(fakeScript, `
const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdin.on('data', b => fs.appendFileSync(${JSON.stringify(inputFile)}, b));
const screen = value => '\\x1b[2J\\x1b[H│ model: ' + value + ' │\\r\\n│ directory: ' + value + ' │\\r\\n› Ask Codex to do anything\\r\\n  100% left';
const resumed = '\\x1b[2J\\x1b[H' + ${JSON.stringify(resumedHistory)}.replace(/\\n/g, '\\r\\n');
process.stdout.write(${JSON.stringify(mode)}.startsWith('warm-') ? resumed : screen('loading'));
fs.writeFileSync(${JSON.stringify(loadingFile)}, 'ready');
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(poll);
  // Replace cells in place: the backend must emit resync, not an appended feed.
  if (${JSON.stringify(mode)} === 'resume-append') {
    const split = resumed.lastIndexOf('›');
    process.stdout.write(resumed.slice(0, split));
    setTimeout(() => process.stdout.write(resumed.slice(split)), 700);
  } else {
    process.stdout.write(${JSON.stringify(mode)} === 'banner' ? screen('initialized') : resumed);
  }
  // Repeated redraws must not duplicate the queued message or declare idle.
  setInterval(() => process.stdout.write('\\x1b[?25h'), 300);
}, 25);
`);
    const sessionId = randomUUID();
    const zmxSession = `bmx-${sessionId.slice(0, 8)}`;
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    let child: ChildProcess | undefined;
    const input = () => existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : '';
    const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() >= deadline || child?.exitCode != null) {
          throw new Error(`worker condition timed out\n${logs.join('')}`);
        }
        await new Promise(r => setTimeout(r, 25));
      }
    };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
      SHELL: '/bin/sh', TMPDIR: process.env.TMPDIR,
      SESSION_DATA_DIR: dataDir, ZMX_DIR: socketDir,
      BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1',
      LARK_APP_ID: 'app_startup_test', LARK_APP_SECRET: 'test-secret',
    };
    const startWorker = () => {
      // Mock only the worker's filesystem home APIs before module evaluation.
      // Shells/tool managers continue to inherit the real HOME and PATH.
      child = spawnTsEvalWithRepoImports(`
        import os from 'node:os';
        import { syncBuiltinESMExports } from 'node:module';
        os.homedir = () => ${JSON.stringify(home)};
        const userInfo = os.userInfo;
        os.userInfo = options => {
          const info = userInfo(options);
          return { ...info, homedir: Buffer.isBuffer(info.homedir)
            ? Buffer.from(${JSON.stringify(home)}) : ${JSON.stringify(home)} };
        };
        syncBuiltinESMExports();
        if (process.versions.bun) {
          // Bun's builtin named exports do not follow syncBuiltinESMExports.
          const { mock } = await import('bun:test');
          mock.module('node:os', () => ({ ...os, default: os }));
        }
        const namedOs = await import('node:os');
        if (namedOs.homedir() !== ${JSON.stringify(home)} || namedOs.userInfo().homedir !== ${JSON.stringify(home)}) {
          throw new Error('worker filesystem home fence was not installed');
        }
        await import('./src/worker.js');
      `, { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.on('message', m => messages.push(m as WorkerToDaemon));
      child.stdout?.on('data', b => logs.push(b.toString()));
      child.stderr?.on('data', b => logs.push(b.toString()));
      child.send({
        type: 'init', sessionId, chatId: 'http_async_startup_test', rootMessageId: 'om_root',
        workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType: 'zmx',
        launchShell: '/bin/sh', prompt: '', apiOnly: true,
        larkAppId: 'app_startup_test', larkAppSecret: 'test-secret',
      } satisfies DaemonToWorker);
    };
    try {
      startWorker();
      await waitFor(() => existsSync(loadingFile) && messages.some(m => m.type === 'ready'));
      // Let the initial loading capture arrive before the ordinary IM input.
      await new Promise(r => setTimeout(r, 500));
      const sendInput = () => child!.send({
        // Ordinary IM delivery; dispatchAttempt belongs to durable dispatch,
        // whose independent no-type-ahead fence must remain intact.
        type: 'message', content: 'say-hi-startup-probe', turnId: 'om_startup',
      } satisfies DaemonToWorker);
      if (arrival === 'before') {
        sendInput();
        await waitFor(() => logs.join('').includes('still booting'));
      }
      await new Promise(r => setTimeout(r, 2_200));
      expect(input()).toBe('');
      expect(messages.some(m => m.type === 'prompt_ready')).toBe(false);

      let releasedAt = Date.now();
      writeFileSync(releaseFile, 'loaded');
      // Observe the fake CLI's actual screen, not a particular detection log:
      // an already-initialized banner can legitimately complete in feed().
      await waitFor(() => execFileSync('zmx', ['history', zmxSession], {
        env, encoding: 'utf8', timeout: 3_000,
      }).includes(mode === 'banner' ? 'model: initialized' : ' · Ready'));
      if (mode.startsWith('reattach')) {
        const previous = child!;
        const exited = new Promise<void>(r => previous.once('exit', () => r()));
        previous.kill('SIGTERM');
        await exited;
        expect(execFileSync('zmx', ['get', zmxSession, 'botmux.session'], { env, encoding: 'utf8', timeout: 3_000 }).trim()).toBe(sessionId);
        logs.length = 0;
        messages.length = 0;
        startWorker();
        await waitFor(() => messages.some(m => m.type === 'ready'));
        expect(logs.join('')).toContain('Re-attached to existing zmx session');
      }
      // An empty queue at initialization must not consume the only wake-up.
      // A subsequent resync also resets idle evidence, but not startup evidence.
      if (arrival === 'after') {
        await new Promise(r => setTimeout(r, 700));
        releasedAt = Date.now();
        sendInput();
      }
      await waitFor(() => input().includes('say-hi-startup-probe') && input().includes('\r'), 6_000);
      expect(Date.now() - releasedAt).toBeLessThan(6_000);
      await new Promise(r => setTimeout(r, 700));
      expect(input().match(/say-hi-startup-probe/g)).toHaveLength(1);
      expect(input()).toContain('\x1b[200~');
      expect(logs.join('')).toContain('observer recovered');
      expect(logs.join('')).not.toContain('First prompt timeout');
      expect(messages.some(m => m.type === 'prompt_ready')).toBe(false);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(r => child!.once('exit', () => r()));
        if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
        await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      try { execFileSync('zmx', ['kill', zmxSession], { env, stdio: 'ignore', timeout: 3_000 }); } catch { /* closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000,
);
