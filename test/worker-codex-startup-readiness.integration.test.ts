import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

it('keeps the worker input queue untouched during Codex loading, then pastes the first message once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-startup-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const loadingFile = join(root, 'loading');
  const releaseFile = join(root, 'release');
  const inputFile = join(root, 'input');
  const cliPidFile = join(root, 'cli-pid');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.on('data', b => fs.appendFileSync(${JSON.stringify(inputFile)}, b));
process.stdout.write('│ model: loading /model to change │\\n│ directory: loading │\\n› Ask Codex to do anything\\n  ? for shortcuts');
fs.writeFileSync(${JSON.stringify(loadingFile)}, 'ready');
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(poll);
  process.stdout.write('\\n│ model: custom-model /model to change │\\n│ directory: /tmp │\\n› Ask Codex to do anything\\n  custom-model · /tmp');
}, 50);
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 12_000;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) throw new Error(logs.join(''));
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: 'sid-startup-test', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId: 'sid-startup-test', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType: 'pty',
      prompt: 'only-this-startup-prompt', turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(loadingFile));
    // Cross the real 2s screen-idle threshold while startup remains blocked.
    await new Promise(r => setTimeout(r, 3_200));
    expect(existsSync(inputFile), logs.join('')).toBe(false);
    expect(messages.some(m => m.type === 'prompt_ready')).toBe(false);
    writeFileSync(releaseFile, 'loaded');
    await waitFor(() => existsSync(inputFile));
    const text = readFileSync(inputFile, 'utf8');
    expect(text.match(/only-this-startup-prompt/g)).toHaveLength(1);
    expect(text).toContain('\x1b[200~');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
