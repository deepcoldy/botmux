/**
 * Worker: Pi's on-screen "updated while this session was running" warning is
 * reported to the daemon once, checked against the version on disk.
 *
 * Run: bun x vitest run --project unit test/worker-pi-install-change.integration.test.ts
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>(done => setTimeout(done, 2_000))]);
    }
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

/** A fake `pi` living in an npm-global-shaped install whose package.json says
 *  `installedVersion`; it prints Pi's warning (with ANSI) naming `runningVersion`. */
function makeFakePiInstall(root: string, installedVersion: string, runningVersion: string): string {
  const pkgDir = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: installedVersion }));
  const cli = join(pkgDir, 'dist', 'cli.js');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('pi ready\\n');
setTimeout(() => {
  process.stdout.write('\\x1b[31mError: Cannot find module openai-completions-WWQW7S3V.js\\x1b[39m\\r\\n');
  process.stdout.write('\\x1b[33m Warning: pi was updated to ${installedVersion} while this session was running (${runningVersion}). '
    + 'Features that load code on demand can fail until restart.\\x1b[39m\\r\\n');
}, 1_000);
setInterval(() => {}, 1_000);
`);
  chmodSync(cli, 0o755);
  mkdirSync(join(root, 'bin'));
  const bin = join(root, 'bin', 'pi');
  symlinkSync(cli, bin);
  return bin;
}

function startWorker(root: string, bin: string, sessionId: string) {
  const dataDir = join(root, 'session');
  mkdirSync(dataDir, { recursive: true });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    workingDir: dataDir,
    cliId: 'pi',
    cliPathOverride: bin,
    cliSessionId: 'deadbeef-1234-4678-9abc-def0123456aa',
    backendType: 'pty',
    prompt: '',
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, messages, logs };
}

async function waitUntil(check: () => boolean, logs: string[], what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`timed out waiting for ${what}\n${logs.join('')}`);
}

describe('worker: Pi install changed under the running process', () => {
  it('reports the warning once, with the version actually on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-upgrade-'));
    tempDirs.add(root);
    const bin = makeFakePiInstall(root, '1.3.0', '1.1.0');
    const { messages, logs } = startWorker(root, bin, 'sid-worker-pi-upgrade');

    await waitUntil(() => messages.some(m => m.type === 'cli_install_changed'), logs, 'cli_install_changed');
    await new Promise(done => setTimeout(done, 500));

    const reports = messages.filter((m): m is Extract<WorkerToDaemon, { type: 'cli_install_changed' }> => m.type === 'cli_install_changed');
    expect(reports).toEqual([{ type: 'cli_install_changed', runningVersion: '1.1.0', installedVersion: '1.3.0' }]);
  }, 30_000);

  it('stays quiet when the warning names the version that is installed (not this process)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-upgrade-quoted-'));
    tempDirs.add(root);
    const bin = makeFakePiInstall(root, '1.3.0', '1.3.0');
    const { messages, logs } = startWorker(root, bin, 'sid-worker-pi-upgrade-quoted');

    await waitUntil(() => logs.join('').includes('not this process; ignoring'), logs, 'the ignore log');
    expect(messages.some(m => m.type === 'cli_install_changed')).toBe(false);
  }, 30_000);
});
