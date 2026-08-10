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
      AGENT_BASE_URL: process.env.AGENT_BASE_URL,
      MOJO_PPE_ENV: process.env.MOJO_PPE_ENV,
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

  it('resolves a custom jwtEnv from the DAEMON env on the first turn', async () => {
    // The migration offered when a custom `jwtEnv` is refused from bots.json is
    // "move it to the daemon's own environment". That has to work on the FIRST turn,
    // and only a real worker run proves it: `init` carries the first prompt but no
    // mojoLivePatch, so the live-patch path cannot cover for it — the value has to
    // survive redactChildEnv() into the worker env and be picked up by buildEnv().
    // A unit test on pickMojoLivePatch() would miss a change to the redaction list.
    const { invocation } = await runWorker({
      workerEnv: { MY_JWT: 'ambient-token' },
      botEntry: { mojo: { cloud: true, jwtEnv: 'MY_JWT' } },
      init: { backendConfig: { cloud: true, jwtEnv: 'MY_JWT' } },
    });
    // Delivered under the CANONICAL name whatever jwtEnv is called — the asymmetry
    // the remote-execution proof depends on.
    expect(invocation.env.X_JWT_TOKEN).toBe('ambient-token');
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

  it('refuses a wrapper smuggled in through the mojo block', async () => {
    // Previously this was silently dropped (run bare, cancel wrapped). Both config
    // doors now reject it, and the worker's defensive gate refuses a stale/forged
    // init payload carrying it — a wrapper that provides auth must never be
    // reported as applied while running unwrapped.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-blockwrap-')));
    let child: ChildProcess | undefined;
    const logs: string[] = [];
    try {
      const appId = 'app_mojo_blockwrap';
      const botsPath = join(root, 'bots.json');
      writeFileSync(botsPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'secret',
        cliId: 'mojo', backendType: 'mojo', mojo: { cloud: true },
      }]));
      writeFakeMojo(root);

      const errors: string[] = [];
      child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root, SESSION_DATA_DIR: root, BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-mojo-blockwrap',
          LARK_APP_ID: appId, LARK_APP_SECRET: 'secret',
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
        sessionId: 'sid-mojo-blockwrap', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, wrapperCli: 'env WRAPPER_MARK=nested mojo' } as never,
        prompt: 'should not run', larkAppId: appId, larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => errors.length > 0,
        20_000,
        () => `expected a fail-closed wrapper error\n${logs.join('')}`,
      );
      // The error must name the top-level field that DOES own it.
      expect(errors.join('\n')).toContain('wrapperCli');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('lets CLI_EXTRA_ARGS override a built-in flag, wrapper or not', async () => {
    // With a wrapper, buildWrappedLaunch used to fold the extra args into the
    // PREFIX, i.e. before the backend's own flags — so with last-value-wins
    // parsing the built-in won, contradicting the documented precedence.
    for (const wrapperCli of [undefined, 'env WRAPPER_MARK=wrapped mojo']) {
      const { invocation } = await runWorker({
        workerEnv: { CLI_EXTRA_ARGS: '--idle-timeout 77' },
        botEntry: { mojo: { cloud: true, idleTimeoutSec: 12 }, ...(wrapperCli ? { wrapperCli } : {}) },
        init: { backendConfig: { cloud: true, idleTimeoutSec: 12 }, ...(wrapperCli ? { wrapperCli } : {}) },
      });
      const flags = invocation.argv.filter(a => a === '--idle-timeout');
      expect(flags.length, `wrapperCli=${String(wrapperCli)}`).toBe(2);
      // LAST occurrence must be the operator's override.
      const lastIdx = invocation.argv.lastIndexOf('--idle-timeout');
      expect(invocation.argv[lastIdx + 1], `wrapperCli=${String(wrapperCli)}`).toBe('77');
      // And the wrapper still applies when configured.
      if (wrapperCli) expect(invocation.env.WRAPPER_MARK).toBe('wrapped');
    }
  }, 60_000);

  it('refuses to launch on a stringified boolean instead of failing open', async () => {
    // The security case: `localDaemon: "false"` satisfied the sandbox check's
    // strict `!== true` (so local isolation was bypassed) while being truthy when
    // the child env was built (so AGENT_LOCAL_DAEMON=1). Isolation off, host
    // execution on. The worker now refuses rather than launching in that state.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-badcfg-')));
    let child: ChildProcess | undefined;
    const logs: string[] = [];
    try {
      const appId = 'app_mojo_badcfg';
      const botsPath = join(root, 'bots.json');
      // bots.json intentionally holds a VALID block — this exercises the worker's
      // defensive gate against a stale/malformed IPC payload, which is the path
      // the two config doors cannot cover.
      writeFileSync(botsPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'secret',
        cliId: 'mojo', backendType: 'mojo', mojo: { cloud: true },
      }]));
      writeFakeMojo(root);

      const errors: string[] = [];
      child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root, SESSION_DATA_DIR: root, BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-mojo-badcfg',
          LARK_APP_ID: appId, LARK_APP_SECRET: 'secret',
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
        sessionId: 'sid-mojo-badcfg', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, localDaemon: 'false' } as never,
        prompt: 'should not run', larkAppId: appId, larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => errors.length > 0,
        20_000,
        () => `expected a fail-closed config error\n${logs.join('')}`,
      );
      expect(errors.join('\n')).toContain('localDaemon');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('routes to the configured control plane', async () => {
    // Baseline for the freeze test below: baseUrl reaches the child as
    // AGENT_BASE_URL, so a tenant switch is observable end to end.
    const { invocation } = await runWorker({
      botEntry: { mojo: { cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a' } },
      init: { backendConfig: { cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a' } },
    });
    expect(invocation.env.AGENT_BASE_URL).toBe('https://tenant-a.example.com');
    expect(invocation.argv).toContain('--workspace-id');
    expect(invocation.argv[invocation.argv.indexOf('--workspace-id') + 1]).toBe('ws-a');
  }, 40_000);

  it('does not let per-bot env supply the control plane', async () => {
    // The freeze covers `baseUrl`/`ppeEnv`, but the mojo CLI also reads them from
    // env — so a live `env: { AGENT_BASE_URL: <tenant-b> }` was a back door around
    // it. Worse, the old code only overwrote these CONDITIONALLY (`if (baseUrl)`),
    // so a session whose frozen snapshot had no baseUrl inherited the live one.
    const { invocation } = await runWorker({
      workerEnv: {
        AGENT_BASE_URL: 'https://ambient-tenant.example.com',
        MOJO_PPE_ENV: 'ppe-ambient',
      },
      botEntry: { env: { UNRELATED: 'kept' }, mojo: { cloud: true } },
      init: { env: { UNRELATED: 'kept' }, backendConfig: { cloud: true } },
    });
    // Config declares neither, so the CLI must fall back to its own defaults
    // rather than inherit an endpoint from the environment.
    expect(invocation.env.AGENT_BASE_URL).toBeUndefined();
    expect(invocation.env.MOJO_PPE_ENV).toBeUndefined();
    // Unrelated per-bot env is untouched — only control-plane keys are stripped.
    expect(invocation.env.PER_BOT_TOKEN).toBeUndefined();
    // And an ambient AGENT_LOCAL_DAEMON cannot enable host execution.
    expect(invocation.env.AGENT_LOCAL_DAEMON).toBe('0');
  }, 40_000);

  it('an ambient AGENT_LOCAL_DAEMON=1 cannot enable host execution', async () => {
    const { invocation } = await runWorker({
      workerEnv: { AGENT_LOCAL_DAEMON: '1' },
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
    });
    // Always written from config, never inherited.
    expect(invocation.env.AGENT_LOCAL_DAEMON).toBe('0');
  }, 40_000);

  it('derives the control plane from config, overriding any inherited value', async () => {
    const { invocation } = await runWorker({
      workerEnv: { AGENT_BASE_URL: 'https://ambient-tenant.example.com' },
      botEntry: { mojo: { cloud: true, baseUrl: 'https://configured.example.com', ppeEnv: 'ppe-1' } },
      init: { backendConfig: { cloud: true, baseUrl: 'https://configured.example.com', ppeEnv: 'ppe-1' } },
    });
    expect(invocation.env.AGENT_BASE_URL).toBe('https://configured.example.com');
    expect(invocation.env.MOJO_PPE_ENV).toBe('ppe-1');
  }, 40_000);

  it('refuses CLI_EXTRA_ARGS that override the frozen control plane', async () => {
    // Extra args are appended AFTER the backend's flags so an operator can
    // override behaviour knobs — but last-value-wins meant they could also
    // override --workspace-id / --agent-id / --cloud / --yolo / -r, making env a
    // second entry point for the identity that is frozen per session.
    for (const extra of [
      '--workspace-id workspace-b',
      '--workspace-id=workspace-b',
      '--agent-id other-agent',
      '--cloud',
      '--yolo',
      '-r some-other-session',
      '--model other-model',
    ]) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-resv-')));
      let child: ChildProcess | undefined;
      const logs: string[] = [];
      try {
        const appId = 'app_mojo_reserved';
        const botsPath = join(root, 'bots.json');
        writeFileSync(botsPath, JSON.stringify([{
          larkAppId: appId, larkAppSecret: 'secret',
          cliId: 'mojo', backendType: 'mojo',
          mojo: { cloud: true, workspaceId: 'workspace-a' },
        }]));
        writeFakeMojo(root);

        const errors: string[] = [];
        child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
          cwd: resolve('.'),
          env: {
            ...process.env,
            HOME: root, SESSION_DATA_DIR: root, BOTS_CONFIG: botsPath,
            BOTMUX_SESSION_ID: 'sid-mojo-resv',
            LARK_APP_ID: appId, LARK_APP_SECRET: 'secret',
            PATH: `${root}:${process.env.PATH ?? ''}`,
            CLI_EXTRA_ARGS: extra,
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
          sessionId: 'sid-mojo-resv', chatId: 'oc_x', rootMessageId: 'om_x',
          workingDir: root, cliId: 'mojo', backendType: 'mojo',
          backendConfig: { cloud: true, workspaceId: 'workspace-a' },
          prompt: 'should not run', larkAppId: appId, larkAppSecret: 'secret',
        } as DaemonToWorker);

        await waitFor(
          () => errors.length > 0,
          20_000,
          () => `expected a refusal for CLI_EXTRA_ARGS="${extra}"\n${logs.join('')}`,
        );
        expect(errors.join('\n'), extra).toMatch(/CLI_EXTRA_ARGS|platform-owned/);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('still accepts a non-reserved CLI_EXTRA_ARGS flag', async () => {
    // The refusal must not break the legitimate override contract.
    const { invocation } = await runWorker({
      workerEnv: { CLI_EXTRA_ARGS: '--idle-timeout 77' },
      botEntry: { mojo: { cloud: true } },
      init: { backendConfig: { cloud: true } },
    });
    expect(invocation.argv).toContain('--idle-timeout');
  }, 40_000);

  it('clears the JWT through the REAL IPC boundary (A → null)', async () => {
    // The previous clear test called backend.applyLivePatch() directly and so
    // bypassed the worker's validator — which rejected every `null` tombstone
    // (`jwt must be a string`), meaning the backend never saw a clear request in
    // production. This drives it over real IPC, two turns, one process.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-clear-')));
    let child: ChildProcess | undefined;
    const logs: string[] = [];
    const dump = join(root, 'jwts.txt');
    try {
      const appId = 'app_mojo_clear';
      const botsPath = join(root, 'bots.json');
      writeFileSync(botsPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'secret',
        cliId: 'mojo', backendType: 'mojo',
        // A stale credential reachable via jwtEnv: clearing must not revive it.
        mojo: { cloud: true, jwtEnv: 'MY_JWT', env: { MY_JWT: 'stale-A' } },
      }]));
      // Append X_JWT_TOKEN on every invocation so the two turns are comparable.
      const bin = join(root, 'mojo');
      writeFileSync(bin, `#!/usr/bin/env bash
echo "[$X_JWT_TOKEN]" >> ${dump}
echo '{"type":"system","subtype":"init","session_id":"sid-clear"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-clear","warnings":[]}'
`);
      chmodSync(bin, 0o755);

      let ready = 0;
      child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root, SESSION_DATA_DIR: root, BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid-clear',
          LARK_APP_ID: appId, LARK_APP_SECRET: 'secret',
          PATH: `${root}:${process.env.PATH ?? ''}`,
          // Ambient must not stand in for a cleared credential either.
          X_JWT_TOKEN: 'ambient-token',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout?.on('data', c => logs.push(c.toString()));
      child.stderr?.on('data', c => logs.push(c.toString()));
      child.on('message', raw => {
        const msg = raw as WorkerToDaemon;
        if (msg.type === 'prompt_ready') ready += 1;
      });

      child.send({
        type: 'init',
        sessionId: 'sid-clear', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, jwtEnv: 'MY_JWT', env: { MY_JWT: 'stale-A' } },
        prompt: 'turn one', larkAppId: appId, larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => existsSync(dump) && readFileSync(dump, 'utf-8').trim().split('\n').length >= 1,
        20_000,
        () => `first turn never ran\n${logs.join('')}`,
      );

      // Second turn carrying the tombstone the daemon would send after the
      // operator deleted the credential.
      child.send({
        type: 'message',
        content: 'turn two',
        mojoLivePatch: { jwt: null },
      } as DaemonToWorker);

      await waitFor(
        () => readFileSync(dump, 'utf-8').trim().split('\n').length >= 2,
        20_000,
        () => `second turn never ran\n${logs.join('')}`,
      );

      const seen = readFileSync(dump, 'utf-8').trim().split('\n');
      expect(seen[0]).toBe('[stale-A]');
      // Cleared means cleared: neither the jwtEnv value nor the ambient token may
      // stand in for it.
      expect(seen[1]).toBe('[]');
      expect(logs.join('')).not.toContain('Ignoring invalid mojo live patch');
      void ready;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

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
