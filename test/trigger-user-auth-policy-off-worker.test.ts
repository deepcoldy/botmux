/**
 * Runtime check with a REAL worker (real worker.ts + real PTY spawn): a
 * session first spawned with trigger-user auth governing bytedcli, then
 * respawned with the policy off, must hand its CLI a PATH on which `bytedcli`
 * is the real tool again. The fake CLI records what its own shell resolves, so
 * the assertion is about the environment the agent actually gets.
 *
 * Synthetic session ids only: the worker manages a systemd scope named after
 * the session id.
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionIdentityBinDir } from '../src/core/cli-identity.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSandboxScratch(dir);
  tempDirs.clear();
});

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function spawnWorker(root: string, fakeBin: string, sessionId: string, triggerUserAuth: boolean) {
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'cli_policyoffworker',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_policy_off_worker',
    rootMessageId: 'om_policy_off_worker',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: join(root, 'fake-cli'),
    backendType: 'pty',
    prompt: '',
    turnId: 'opening-turn',
    larkAppId: 'cli_policyoffworker',
    larkAppSecret: 'secret',
    ...(triggerUserAuth ? { triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback: 'none' } } : {}),
  } satisfies DaemonToWorker);
  return { child, logs, messages };
}

async function resolvedByCli(root: string, worker: ReturnType<typeof spawnWorker>): Promise<string> {
  const record = join(root, 'resolved-bytedcli');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`worker exited early\n${worker.logs.join('')}`);
    }
    if (existsSync(record) && readFileSync(record, 'utf8').endsWith('\n')) return readFileSync(record, 'utf8').trim();
    await delay(50);
  }
  throw new Error(`fake CLI never recorded its PATH resolution\n${worker.logs.join('')}`);
}

async function stop(worker: ReturnType<typeof spawnWorker>): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = new Promise(r => worker.child.once('exit', r));
  worker.child.kill('SIGKILL');
  await exited;
}

describe.skipIf(process.platform !== 'linux')('trigger-user auth off after a governed spawn (real worker)', () => {
  it('the respawned CLI resolves bytedcli to the real binary again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-policy-off-worker-'));
    tempDirs.add(root);
    const fakeBin = join(root, 'fakebin');
    mkdirSync(fakeBin);
    for (const name of ['bytedcli', 'codebase']) {
      writeFileSync(join(fakeBin, name), '#!/bin/sh\necho real\n');
      chmodSync(join(fakeBin, name), 0o755);
    }
    // The CLI writes what ITS shell resolves for bytedcli, then idles.
    writeFileSync(join(root, 'fake-cli'), '#!/bin/sh\n{ command -v bytedcli; } > "$HOME/resolved-bytedcli.tmp"\n'
      + 'mv "$HOME/resolved-bytedcli.tmp" "$HOME/resolved-bytedcli"\nexec sleep 300\n');
    chmodSync(join(root, 'fake-cli'), 0o755);
    const sessionId = `policyoff${Date.now().toString(36)}${process.pid.toString(36)}`;
    const wrapper = join(sessionIdentityBinDir(root, sessionId), 'bytedcli');

    const governed = spawnWorker(root, fakeBin, sessionId, true);
    expect(await resolvedByCli(root, governed)).toBe(wrapper);
    await stop(governed);
    rmSync(join(root, 'resolved-bytedcli'), { force: true });

    const released = spawnWorker(root, fakeBin, sessionId, false);
    expect(await resolvedByCli(root, released)).toBe(join(fakeBin, 'bytedcli'));
    expect(existsSync(wrapper)).toBe(false);
  }, 90_000);
});
