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
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

interface Invocation {
  argv: string[];
  cwd: string;
  /** Path of the binary that actually executed (`$0`). */
  self: string;
  env: Record<string, string | undefined>;
}

/**
 * Write a fake `mojo` that dumps its invocation, then emits a minimal valid
 * stream (init + result) so the turn settles like a real one.
 */
function writeFakeMojo(dir: string, fileName = 'mojo'): string {
  const bin = join(dir, fileName);
  // `self` is how the cliPathOverride / wrapper assertions know WHICH binary ran.
  writeFileSync(bin, `#!/usr/bin/env bash
export SELF="$0"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.MOJO_DUMP, JSON.stringify({
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    self: process.env.SELF,
    env: {
      PER_BOT_TOKEN: process.env.PER_BOT_TOKEN,
      MOJO_BLOCK_ONLY: process.env.MOJO_BLOCK_ONLY,
      BOTMUX_SESSION_ID: process.env.BOTMUX_SESSION_ID,
      AGENT_LOCAL_DAEMON: process.env.AGENT_LOCAL_DAEMON,
      X_JWT_TOKEN: process.env.X_JWT_TOKEN,
      WRAPPER_MARK: process.env.WRAPPER_MARK,
    },
  }, null, 2));
' -- "$@"
echo '{"type":"system","subtype":"init","session_id":"sid-fake-1"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-fake-1","warnings":[]}'
`);
  chmodSync(bin, 0o755);
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
  /** Absolute path of the fake binary written for this run. */
  bin: string;
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
  /** Name the fake binary something other than `mojo` (path-override tests). */
  binName?: string;
  /** Extra env for the worker process itself (ambient-vs-per-bot tests). */
  workerEnv?: Record<string, string>;
  /** Point cliPathOverride at the fake binary written for this run. */
  cliPathOverrideFromBin?: boolean;
}): Promise<RunResult> {
  // realpathSync: macOS os.tmpdir() is a symlink (/var → /private/var); the child
  // reports the resolved path, so normalize here to keep cwd assertions portable.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-worker-')));
  const dump = join(root, 'invocation.json');
  const bin = writeFakeMojo(root, opts.binName ?? 'mojo');
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
      ...(opts.cliPathOverrideFromBin ? { cliPathOverride: bin } : {}),
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
        SELF: '',
        // Keep the fake binary discoverable even when no explicit path is set.
        PATH: `${root}:${process.env.PATH ?? ''}`,
        ...(opts.workerEnv ?? {}),
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
      ...(opts.cliPathOverrideFromBin ? { cliPathOverride: bin } : {}),
      ...(opts.init ?? {}),
    } as DaemonToWorker;
    child.send(init);

    await waitFor(
      () => existsSync(dump),
      opts.timeoutMs ?? 20_000,
      () => `mojo was never invoked\n${logs.join('')}`,
    );
    return {
      bin,
      invocation: JSON.parse(readFileSync(dump, 'utf-8')) as Invocation,
      logs: logs.join(''),
      messages,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
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

  it('passes the session working dir, per-bot env and model through', async () => {
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

  it('runs the binary pinned by cliPathOverride, not a bare `mojo` from PATH', async () => {
    // The install check validates the OVERRIDE path, so running a different
    // binary at turn time would make that check meaningless.
    const { invocation, bin } = await runWorker({
      binName: 'mojo-custom',
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
      cliPathOverrideFromBin: true,
    });
    expect(invocation.self).toBe(bin);
    expect(invocation.self).toContain('mojo-custom');
  }, 40_000);

  it('lets a per-bot JWT win over the daemon ambient X_JWT_TOKEN', async () => {
    // buildEnv() used to read process.env directly AFTER merging, so the host
    // token overrode the per-bot one and the bot ran as the wrong identity.
    const { invocation } = await runWorker({
      workerEnv: { X_JWT_TOKEN: 'ambient-jwt' },
      botEntry: { env: { X_JWT_TOKEN: 'per-bot-jwt' }, mojo: { cloud: true } },
      init: {
        env: { X_JWT_TOKEN: 'per-bot-jwt' },
        backendConfig: { cloud: true },
      },
    });
    expect(invocation.env.X_JWT_TOKEN).toBe('per-bot-jwt');
  }, 40_000);

  it('still uses the ambient JWT when the bot supplies none', async () => {
    const { invocation } = await runWorker({
      workerEnv: { X_JWT_TOKEN: 'ambient-jwt' },
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
    });
    expect(invocation.env.X_JWT_TOKEN).toBe('ambient-jwt');
  }, 40_000);

  it('lets an explicit mojo.jwt win over both', async () => {
    const { invocation } = await runWorker({
      workerEnv: { X_JWT_TOKEN: 'ambient-jwt' },
      botEntry: { env: { X_JWT_TOKEN: 'per-bot-jwt' }, mojo: { cloud: true, jwt: 'block-jwt' } },
      init: {
        env: { X_JWT_TOKEN: 'per-bot-jwt' },
        backendConfig: { cloud: true, jwt: 'block-jwt' },
      },
    });
    expect(invocation.env.X_JWT_TOKEN).toBe('block-jwt');
  }, 40_000);

  it('re-applies the wrapperCli launch prefix on every turn', async () => {
    // A PTY CLI is wrapped once for the life of its process; mojo is invoked per
    // turn, so dropping the prefix meant the worker logged "Launch prefix: …"
    // while actually running an unwrapped mojo.
    const { invocation } = await runWorker({
      botEntry: { wrapperCli: 'env WRAPPER_MARK=wrapped mojo', mojo: { cloud: true } },
      init: { wrapperCli: 'env WRAPPER_MARK=wrapped mojo', backendConfig: { cloud: true } },
    });
    expect(invocation.env.WRAPPER_MARK).toBe('wrapped');
    // The prompt must still arrive — the prefix wraps, it does not replace.
    expect(invocation.argv).toContain('hello mojo');
  }, 40_000);

  it('applies CLI_EXTRA_ARGS even with no wrapper configured', async () => {
    // The mojo adapter's buildArgs() returns [], so anything reaching spawn()
    // came from the worker's shared arg pipeline. Dropping it made the flag work
    // WITH a wrapper (buildWrappedLaunch folds spawnArgs into the prefix) and
    // vanish without one — a config-dependent inconsistency.
    const { invocation } = await runWorker({
      workerEnv: { CLI_EXTRA_ARGS: '--timeout 77' },
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
    });
    expect(invocation.argv).toContain('--timeout');
    expect(invocation.argv[invocation.argv.indexOf('--timeout') + 1]).toBe('77');
    // The positional prompt must stay LAST.
    expect(invocation.argv[invocation.argv.length - 1]).toContain('hello mojo');
  }, 40_000);

  it('does not launch a wrapper declared only inside the mojo block', async () => {
    // The worker builds the prefix from the TOP-LEVEL wrapperCli only, so a block
    // value must not take effect on the run path either. Paired with the
    // cancel-path test in mojo-orphan-cancel.test.ts, this pins that both paths
    // agree — the divergence review found was run-bare / cancel-wrapped.
    const { invocation } = await runWorker({
      botEntry: { mojo: { cloud: true, wrapperCli: 'env WRAPPER_MARK=nested mojo' } },
      init: { backendConfig: { cloud: true, wrapperCli: 'env WRAPPER_MARK=nested mojo' } },
    });
    expect(invocation.env.WRAPPER_MARK).toBeUndefined();
  }, 40_000);

  it('refuses to start a locally-executing mojo bot that requested sandbox', async () => {
    // cloud is NOT set here, so tools would run on this host while the user
    // believes the sandbox is active. Fail closed rather than silently skipping.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-sbx-')));
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
      writeFakeMojo(root);

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
