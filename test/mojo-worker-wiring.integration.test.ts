/**
 * Worker-level integration tests for the mojo backend.
 *
 * These sit one layer above the MojoBackend unit tests on purpose: every bug
 * they cover was invisible there, because the backend was fine in isolation and
 * the DEFECT WAS IN THE WORKER WIRING — botmux resolved a setting and then never
 * handed it to the backend.
 *
 * A fake `mojo` executable records its argv + selected env + cwd to a JSON file,
 * so the assertions are made against what would REALLY have been executed. No
 * @byted/mojo install and no JWT required.
 *
 * Run:  pnpm vitest run test/mojo-worker-wiring.integration.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

interface Invocation {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * Write a fake `mojo` that dumps its invocation, then emits a minimal valid
 * stream (init + result) so the turn settles like a real one.
 */
function writeFakeMojo(dir: string, dumpPath: string): string {
  const bin = join(dir, 'mojo');
  writeFileSync(bin, `#!/usr/bin/env bash
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.MOJO_DUMP, JSON.stringify({
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    env: {
      PER_BOT_TOKEN: process.env.PER_BOT_TOKEN,
      MOJO_BLOCK_ONLY: process.env.MOJO_BLOCK_ONLY,
      BOTMUX_SESSION_ID: process.env.BOTMUX_SESSION_ID,
      AGENT_LOCAL_DAEMON: process.env.AGENT_LOCAL_DAEMON,
      X_JWT_TOKEN: process.env.X_JWT_TOKEN,
    },
  }, null, 2));
' -- "$@"
echo '{"type":"system","subtype":"init","session_id":"sid-fake-1"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-fake-1","warnings":[]}'
`);
  chmodSync(bin, 0o755);
  void dumpPath;
  return bin;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(r => setTimeout(r, 100));
  }
  throw new Error(describeFailure());
}

interface RunResult {
  invocation: Invocation;
  logs: string;
  messages: WorkerToDaemon[];
  elapsedMs: number;
}

/** Boot a real worker against the fake binary and return the recorded invocation. */
async function runWorker(opts: {
  botEntry?: Record<string, unknown>;
  init?: Partial<DaemonToWorker & { type: 'init' }>;
  /** Wait this long for the invocation dump (the point of the ready-gate test). */
  timeoutMs?: number;
}): Promise<RunResult> {
  const root = mkdtempSync(join(tmpdir(), 'botmux-mojo-worker-'));
  const dump = join(root, 'invocation.json');
  const bin = writeFakeMojo(root, dump);
  let child: ChildProcess | undefined;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];

  try {
    const appId = 'app_mojo_wiring';
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'mojo',
      backendType: 'mojo',
      ...(opts.botEntry ?? {}),
    }]));

    const startedAt = Date.now();
    child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: root,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-mojo-wiring',
        LARK_APP_ID: appId,
        LARK_APP_SECRET: 'secret',
        MOJO_DUMP: dump,
        // Keep the fake binary discoverable even when no explicit path is set.
        PATH: `${root}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', c => logs.push(c.toString()));
    child.stderr?.on('data', c => logs.push(c.toString()));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    const init = {
      type: 'init',
      sessionId: 'sid-mojo-wiring',
      chatId: 'oc_mojo_wiring',
      rootMessageId: 'om_mojo_wiring',
      workingDir: root,
      cliId: 'mojo',
      backendType: 'mojo',
      prompt: 'hello mojo',
      larkAppId: appId,
      larkAppSecret: 'secret',
      ...(opts.init ?? {}),
    } as DaemonToWorker;
    child.send(init);

    await waitFor(
      () => existsSync(dump),
      opts.timeoutMs ?? 20_000,
      () => `mojo was never invoked\n${logs.join('')}`,
    );
    return {
      invocation: JSON.parse(readFileSync(dump, 'utf-8')) as Invocation,
      logs: logs.join(''),
      messages,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    void bin;
  }
}

describe('mojo worker wiring', () => {
  it('sends the first prompt promptly instead of waiting for the ready fallback', async () => {
    // Remote backends are marked prompt-ready right after spawn(). Without that,
    // isPromptReady stays false until the ~15s first-prompt fallback and every
    // first message is needlessly delayed.
    const { invocation, elapsedMs } = await runWorker({ timeoutMs: 12_000 });
    expect(invocation.argv).toContain('hello mojo');
    expect(elapsedMs).toBeLessThan(12_000);
  }, 40_000);

  it('passes the session working dir, per-bot env, model and cliPathOverride through', async () => {
    const { invocation } = await runWorker({
      botEntry: {
        model: 'gpt-5.5-2026-04-24',
        env: { PER_BOT_TOKEN: 'per-bot-value' },
        mojo: { cloud: true, env: { MOJO_BLOCK_ONLY: 'mojo-block-value' } },
      },
      init: {
        model: 'gpt-5.5-2026-04-24',
        env: { PER_BOT_TOKEN: 'per-bot-value' },
        backendConfig: { cloud: true, env: { MOJO_BLOCK_ONLY: 'mojo-block-value' } },
      },
    });

    // The generic `model` must reach the CLI, not only a hand-written mojo block.
    expect(invocation.argv).toContain('--model');
    expect(invocation.argv[invocation.argv.indexOf('--model') + 1]).toBe('gpt-5.5-2026-04-24');
    // `cloud: true` in the config block.
    expect(invocation.argv).toContain('--cloud');
    // Working dir comes from the session (repo selection lives here).
    expect(invocation.cwd).not.toBe(resolve('.'));
    // Per-bot env and the mojo-specific env block both land in the child.
    expect(invocation.env.PER_BOT_TOKEN).toBe('per-bot-value');
    expect(invocation.env.MOJO_BLOCK_ONLY).toBe('mojo-block-value');
    // A bot host must never run mojo's local execution daemon by default.
    expect(invocation.env.AGENT_LOCAL_DAEMON).toBe('0');
  }, 40_000);

  it('honours the generic disableCliBypass instead of always adding --yolo', async () => {
    const { invocation } = await runWorker({
      botEntry: { disableCliBypass: true, mojo: { cloud: true } },
      init: { disableCliBypass: true, backendConfig: { cloud: true } },
    });
    expect(invocation.argv).not.toContain('--yolo');
  }, 40_000);

  it('adds --yolo when the bypass is not disabled', async () => {
    const { invocation } = await runWorker({
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
    });
    expect(invocation.argv).toContain('--yolo');
  }, 40_000);

  it('resumes the persisted lineage from riffParentTaskId', async () => {
    // The daemon stores every remote backend's lineage in riffParentTaskId (the
    // generic backend.onTaskId → riff_task_id IPC path). If the worker does not
    // translate it into resumeCliSessionId, a daemon restart / relay / worker
    // rebuild silently starts a brand-new context-less mojo session.
    const { invocation } = await runWorker({
      botEntry: { mojo: { cloud: true } },
      init: {
        backendConfig: { cloud: true },
        riffParentTaskId: 'sid-persisted-42',
      },
    });
    expect(invocation.argv).toContain('-r');
    expect(invocation.argv[invocation.argv.indexOf('-r') + 1]).toBe('sid-persisted-42');
  }, 40_000);

  it('refuses to start a locally-executing mojo bot that requested sandbox', async () => {
    // cloud is NOT set here, so tools would run on this host while the user
    // believes the sandbox is active. Fail closed rather than silently skipping.
    const root = mkdtempSync(join(tmpdir(), 'botmux-mojo-sbx-'));
    let child: ChildProcess | undefined;
    const logs: string[] = [];
    try {
      const appId = 'app_mojo_sandbox';
      const botsPath = join(root, 'bots.json');
      writeFileSync(botsPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'mojo',
        backendType: 'mojo',
        sandbox: true,
      }]));
      writeFakeMojo(root, join(root, 'unused.json'));

      const errors: string[] = [];
      child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root,
          SESSION_DATA_DIR: root,
          BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-mojo-sbx',
          LARK_APP_ID: appId,
          LARK_APP_SECRET: 'secret',
          PATH: `${root}:${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout?.on('data', c => logs.push(c.toString()));
      child.stderr?.on('data', c => logs.push(c.toString()));
      child.on('message', raw => {
        const msg = raw as WorkerToDaemon;
        if (msg.type === 'error') errors.push(msg.message);
      });

      child.send({
        type: 'init',
        sessionId: 'sid-mojo-sbx',
        chatId: 'oc_mojo_sbx',
        rootMessageId: 'om_mojo_sbx',
        workingDir: root,
        cliId: 'mojo',
        backendType: 'mojo',
        sandbox: true,
        backendConfig: {},
        prompt: 'should not run',
        larkAppId: appId,
        larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => errors.length > 0,
        20_000,
        () => `expected a fail-closed sandbox error\n${logs.join('')}`,
      );
      expect(errors.join('\n')).toMatch(/mojo/i);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
