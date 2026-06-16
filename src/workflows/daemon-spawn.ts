/**
 * Daemon-backed `WorkerSpawnFn` implementation.
 *
 * Forks `worker.js` for a single workflow step, sends the prompt via
 * the `init` IPC, and resolves with the agent's final transcript when
 * the worker emits `final_output` and quiesces.
 *
 * Why not reuse `forkWorker` from `core/worker-pool.ts`: that path is
 * tightly coupled to chat / card / streaming state (DaemonSession,
 * dashboardEventBus, sessionStore writes).  Workflow steps don't have
 * a real chat to bind to — we mint a synthetic chatId / rootMessageId
 * and ignore the worker's chat-side side effects (streaming card POST,
 * screenshot uploads).  The bot's real `larkAppId / larkAppSecret`
 * still flow through so the CLI adapter's environment matches a real
 * spawn.
 *
 * The `WorkerProcessFactory` indirection keeps the module unit-testable:
 * tests inject a scripted process that emits canned IPC frames, real
 * code injects `forkWorkerJs` (defined below).
 */

import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DaemonRunOneShotInput,
  DaemonRunOneShotResult,
  DaemonSpawnDeps,
} from './spawn-bot.js';
import { WorkflowSpawnCancelledError } from './spawn-bot.js';
import type { AbortCancelReason, WorkerSessionInfo } from './runtime.js';
import {
  ATTEMPT_TERMINAL_SCHEMA_VERSION,
  ATTEMPT_TERMINAL_SIDECAR,
  type AttemptTerminalSidecar,
  type AttemptTerminalStatus,
} from './attempt-terminal.js';
import { logger } from '../utils/logger.js';

type WindowsForkOptions = ForkOptions & { windowsHide?: boolean };

// ─── IPC payloads (subset of WorkerToDaemon we care about) ────────────────

type WorkerEvent =
  | { type: 'ready'; port: number; token: string }
  | { type: 'cli_session_id'; cliSessionId: string }
  | {
      type: 'final_output';
      content: string;
      lastUuid: string;
      turnId: string;
      kind?: 'bridge' | 'local-turn' | 'local-turn-headless';
      userText?: string;
    }
  | {
      type: 'screen_update';
      content: string;
      status: 'working' | 'idle' | 'analyzing';
    }
  | { type: 'prompt_ready' }
  | { type: 'claude_exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };

// ─── Worker process abstraction (factory + handle) ────────────────────────

export interface WorkerHandle {
  send(msg: unknown): void;
  on(event: 'message', cb: (msg: WorkerEvent) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export interface WorkerProcessFactory {
  spawn(opts: WorkerSpawnOptions): WorkerHandle;
}

export type WorkerSpawnOptions = {
  workerPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Default factory: real `node:child_process.fork` against `worker.js`. */
export const forkWorkerJsFactory: WorkerProcessFactory = {
  spawn(opts) {
    const child: ChildProcess = fork(opts.workerPath, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: opts.cwd,
      env: opts.env,
    } as WindowsForkOptions);
    return {
      send: (m) => child.send(m as never),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        child.on(event as never, cb);
      },
      kill: (sig) => {
        if (!child.killed) child.kill(sig);
      },
      get pid() {
        return child.pid;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
    } as WorkerHandle;
  },
};

// ─── Deps for the factory ────────────────────────────────────────────────

export type WorkflowDaemonSpawnDeps = {
  /** Real workers need access to bot credentials per step. */
  resolveLarkCredentials(botName: string): {
    larkAppId: string;
    larkAppSecret: string;
  };
  /** Override worker.js path (tests).  Default: `<dist>/worker.js`. */
  workerPath?: string;
  /** Override process factory (tests). */
  factory?: WorkerProcessFactory;
  /**
   * Override how long we wait for the worker's first final_output after
   * init.  Defaults to 5 minutes — long enough for typical agent steps
   * with tool use.  Workflow `node.timeoutMs` overrides on a per-step
   * basis.
   */
  defaultTimeoutMs?: number;
  /**
   * After we receive `final_output` we wait `quiesceMs` before resolving,
   * in case the worker emits additional turns (multi-step agent loops).
   * Tests can shrink this.  Default 800 ms.
   */
  quiesceMs?: number;
  /**
   * Grace period after cancel SIGINT before escalating to SIGKILL.
   * Default 5000 ms — long enough for a CLI to flush its current chunk
   * and exit cleanly, short enough that a stuck worker doesn't keep
   * `cancelWorkflowRunOnDaemon` blocked.  Per-CLI tuning lives in
   * v0.1.4-b's `cancelPolicy` schema; we keep a single constant here.
   */
  cancelGraceMs?: number;
};

export function createWorkflowDaemonSpawn(
  deps: WorkflowDaemonSpawnDeps,
): DaemonSpawnDeps {
  const factory = deps.factory ?? forkWorkerJsFactory;
  const workerPath = deps.workerPath ?? defaultWorkerPath();
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 5 * 60 * 1000;
  const quiesceMs = deps.quiesceMs ?? 800;
  const cancelGraceMs = deps.cancelGraceMs ?? 5000;

  return {
    runOneShot: (input) =>
      runOneShotImpl(input, {
        factory,
        workerPath,
        defaultTimeoutMs,
        quiesceMs,
        cancelGraceMs,
        resolveLarkCredentials: deps.resolveLarkCredentials,
      }),
  };
}

// ─── Default worker.js path ──────────────────────────────────────────────

function defaultWorkerPath(): string {
  // This module typically runs from `dist/workflows/daemon-spawn.js`;
  // worker.js lives next to dist root, i.e. `<dist>/worker.js`.
  // When running from source via ts-node etc., fall back to `src/worker.ts`
  // (the factory is meant for production; tests should override).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'worker.js');
  if (existsSync(candidate)) return candidate;
  return join(here, '..', '..', 'src', 'worker.ts');
}

// ─── runOneShot core ─────────────────────────────────────────────────────

type RunOneShotInternalDeps = {
  factory: WorkerProcessFactory;
  workerPath: string;
  defaultTimeoutMs: number;
  quiesceMs: number;
  cancelGraceMs: number;
  resolveLarkCredentials: WorkflowDaemonSpawnDeps['resolveLarkCredentials'];
};

async function runOneShotImpl(
  input: DaemonRunOneShotInput,
  deps: RunOneShotInternalDeps,
): Promise<DaemonRunOneShotResult> {
  logOneShotMemory(input, 'enter');
  const creds = deps.resolveLarkCredentials(input.botName);
  logOneShotMemory(input, 'after-resolve-credentials');
  const startedAt = Date.now();
  const synthetic = syntheticIds(input);
  logOneShotMemory(input, 'after-synthetic-ids');
  const cwd = expandWorkflowWorkingDir(input.workingDir) ?? process.cwd();
  appendAttemptLog(input, 'system', `starting workflow worker cwd=${cwd}`);

  logOneShotMemory(input, 'before-worker-spawn');
  const worker = deps.factory.spawn({
    workerPath: deps.workerPath,
    cwd,
    env: {
      ...process.env,
      // Marker so the CLI session / skill detect a workflow-issued worker.
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: input.runId,
      BOTMUX_WORKFLOW_NODE_ID: input.nodeId,
      // Raw PTY byte stream sink for the dashboard "terminal replay" view.
      // Worker lazily opens this on first PTY chunk; absent → worker skips
      // the write (older daemon → older sidecar layout still works).
      ...(input.attemptLogPath
        ? { BOTMUX_WORKFLOW_PTY_LOG_PATH: join(dirname(input.attemptLogPath), 'pty.log') }
        : {}),
    },
  });
  logOneShotMemory(input, `after-worker-spawn pid=${worker.pid ?? 'unknown'}`);
  appendAttemptLog(input, 'system', `worker spawned pid=${worker.pid ?? 'unknown'}`);
  drainWorkerDiagnostics(worker, input);
  logOneShotMemory(input, 'after-drain-diagnostics');

  let webPort: number | undefined;
  const collectedOutputs: Array<{ content: string; turnId: string }> = [];
  let quiesceTimer: NodeJS.Timeout | undefined;
  const cliId = input.botSnapshot?.cliId ?? 'claude-code';
  let cliSessionId: string | undefined;

  const init = {
    type: 'init' as const,
    sessionId: synthetic.sessionId,
    chatId: synthetic.chatId,
    rootMessageId: synthetic.rootMessageId,
    workingDir: cwd,
    cliId,
    backendType: 'pty' as const,
    prompt: input.prompt,
    resume: false,
    larkAppId: creds.larkAppId,
    larkAppSecret: creds.larkAppSecret,
    botName: input.botName,
    locale: 'zh' as const,
    ...(input.botSnapshot?.cliPathOverride
      ? { cliPathOverride: input.botSnapshot.cliPathOverride }
      : {}),
  };
  logOneShotMemory(input, 'after-init-object');

  return new Promise<DaemonRunOneShotResult>((resolve, reject) => {
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let cancelRequested = false;
    let cancelOriginEventId = '';
    const timeoutMs = input.timeoutMs ?? deps.defaultTimeoutMs;
    const hardDeadline = setTimeout(() => {
      fail(new Error(`workflow worker timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    const cleanup = (opts: { skipSigterm?: boolean } = {}): void => {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      // sigkillTimer is cleared only on the worker's `exit` event so the
      // grace escalation isn't cancelled by our own cleanup path.
      input.cancelSignal?.removeEventListener('abort', onCancelAbort);
      try {
        worker.send({ type: 'close' });
      } catch {
        /* worker may already be gone */
      }
      // Cancel path manages its own SIGINT + grace + SIGKILL.  Sending
      // an extra SIGTERM 250ms after abort would race with the 5s grace
      // and potentially kill a CLI mid-flush.  The success path still
      // wants SIGTERM to make sure idle workers exit promptly.
      if (!opts.skipSigterm) {
        setTimeout(() => worker.kill('SIGTERM'), 250);
      }
    };

    /**
     * Cancel responsiveness (v0.1.4-a slice 2):
     *   1. Tell the worker via the existing IPC `close` channel so the CLI
     *      can flush its current chunk and exit cleanly.
     *   2. SIGINT for an unambiguous interrupt signal that CLI shells
     *      conventionally honor (Ctrl-C semantics).
     *   3. Arm a SIGKILL fallback after `cancelGraceMs` in case the CLI
     *      is stuck (rare but real — e.g. mid-network call).
     *   4. **Wait for the worker's `exit` event** before rejecting the
     *      outer Promise.  This guarantees `activityCanceled` (written
     *      by dispatchWork on `kind: 'cancelled'`) is only appended
     *      after the worker process is actually gone — otherwise we'd
     *      mark the activity terminal while the worker could still be
     *      writing files or invoking tools (codex round 4 B1).
     *
     * success-wins: if the worker already produced final_output and the
     * quiesce window is running, the `settled` guard in `finish`
     * prevents this from overriding.
     */
    function onCancelAbort(): void {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      const reason = input.cancelSignal!.reason as AbortCancelReason | undefined;
      cancelOriginEventId = typeof reason?.cancelOriginEventId === 'string'
        ? reason.cancelOriginEventId
        : '';
      appendAttemptLog(
        input,
        'system',
        `cancel signal received origin=${cancelOriginEventId || '<missing>'}, sending close+SIGINT (grace ${deps.cancelGraceMs}ms)`,
      );
      // Cancel-wins (codex round 5 M1): once aborted, no other path may
      // settle the promise before the worker exits — neither quiesce →
      // success nor hardDeadline / error → failure.  Disarm those timers
      // here so they can't fire after the abort; `finish` and `fail` also
      // short-circuit on `cancelRequested` defensively.
      clearTimeout(hardDeadline);
      if (quiesceTimer) {
        clearTimeout(quiesceTimer);
        quiesceTimer = undefined;
      }
      try { worker.send({ type: 'close' }); } catch { /* already gone */ }
      try { worker.kill('SIGINT'); } catch { /* already gone */ }
      sigkillTimer = setTimeout(() => {
        appendAttemptLog(input, 'system', `cancel grace expired; escalating to SIGKILL`);
        try { worker.kill('SIGKILL'); } catch { /* already gone */ }
      }, deps.cancelGraceMs);
      // NB: don't reject here.  The worker's `exit` handler below
      // finalizes the WorkflowSpawnCancelledError once the process is
      // truly gone.
    }
    if (input.cancelSignal) {
      if (input.cancelSignal.aborted) {
        // Signal already aborted before we got here — fire on next tick
        // so the spawn at least gets a chance to register handlers and
        // appendAttemptLog is meaningful.
        setImmediate(onCancelAbort);
      } else {
        input.cancelSignal.addEventListener('abort', onCancelAbort);
      }
    }

    function makeSessionSnapshot(): WorkerSessionInfo {
      return {
        sessionId: synthetic.sessionId,
        cliSessionId,
        larkAppId: creds.larkAppId,
        botName: input.botName,
        cliId,
        workingDir: cwd,
        webPort,
        logPath: input.attemptLogPath,
        startedAt,
        endedAt: Date.now(),
      };
    }

    const fail = (err: Error): void => {
      if (settled) return;
      // Cancel-wins (codex round 5 M1): once an abort has fired, all
      // failure paths defer to the worker.on('exit') handler which
      // rejects with WorkflowSpawnCancelledError.  Otherwise a racing
      // hardDeadline / worker error would surface as a generic failure
      // and lose the cancel origin id.
      if (cancelRequested) {
        appendAttemptLog(
          input,
          'system',
          `ignoring fail(${err.message}) while cancel in flight; deferring to exit handler`,
        );
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const finish = (): void => {
      if (settled) return;
      // Cancel-wins guard symmetric with `fail`: quiesce timer might be
      // disarmed in onCancelAbort, but defend against any path that
      // calls finish() directly after abort.
      if (cancelRequested) {
        appendAttemptLog(
          input,
          'system',
          'ignoring finish() while cancel in flight; deferring to exit handler',
        );
        return;
      }
      cleanup();
      const last = collectedOutputs[collectedOutputs.length - 1];
      if (!last) {
        fail(new Error('workflow worker quiesced without final_output'));
        return;
      }
      settled = true;
      resolve({
        finalTranscript: last.content,
        session: {
          sessionId: synthetic.sessionId,
          cliSessionId,
          larkAppId: creds.larkAppId,
          botName: input.botName,
          cliId,
          workingDir: cwd,
          webPort,
          logPath: input.attemptLogPath,
          startedAt,
          endedAt: Date.now(),
        },
      });
    };

    const armQuiesce = (): void => {
      if (quiesceTimer) clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(finish, deps.quiesceMs);
    };

    worker.on('message', (event) => {
      switch (event.type) {
        case 'ready':
          if (settled) break;
          webPort = event.port;
          appendAttemptLog(input, 'system', `worker ready port=${event.port}`);
          writeAttemptTerminalSidecar(input, makeSessionSnapshot(), 'live');
          logOneShotMemory(input, 'worker-ready-before-init-send');
          try {
            worker.send(init);
            logOneShotMemory(input, 'worker-ready-after-init-send');
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
          // Note: init may already have been sent by tests' scripted
          // factory before 'ready' lands.  Re-sending is a no-op
          // because `lastInitConfig` short-circuits.
          break;
        case 'cli_session_id':
          if (typeof event.cliSessionId !== 'string' || !event.cliSessionId) break;
          cliSessionId = event.cliSessionId;
          appendAttemptLog(input, 'system', `CLI session id observed ${event.cliSessionId}`);
          if (!settled && webPort !== undefined) {
            writeAttemptTerminalSidecar(input, makeSessionSnapshot(), 'live');
          }
          break;
        case 'final_output':
          if (settled) break;
          appendAttemptLog(input, `final_output:${event.turnId}`, event.content);
          collectedOutputs.push({
            content: event.content,
            turnId: event.turnId,
          });
          armQuiesce();
          break;
        case 'screen_update':
          if (event.status === 'idle' && collectedOutputs.length > 0) {
            armQuiesce();
          }
          break;
        case 'prompt_ready':
          if (collectedOutputs.length > 0) armQuiesce();
          break;
        case 'error':
          appendAttemptLog(input, 'error', event.message);
          fail(new Error(`worker error: ${event.message}`));
          break;
        case 'claude_exit':
          appendAttemptLog(
            input,
            'system',
            `CLI exited code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`,
          );
          if (collectedOutputs.length > 0) {
            finish();
          } else {
            fail(
              new Error(
                `CLI exited (code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}) before producing final_output`,
              ),
            );
          }
          break;
      }
    });

    worker.on('error', (err) => {
      appendAttemptLog(input, 'error', err.message);
      fail(err);
    });

    worker.on('exit', (code) => {
      appendAttemptLog(input, 'system', `worker process exit code=${code ?? 'null'}`);
      if (webPort !== undefined) {
        writeAttemptTerminalSidecar(input, makeSessionSnapshot(), 'closed');
      }
      // Worker is gone — we don't need to SIGKILL it anymore.
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
      // Cancel path: worker has actually stopped, NOW we can settle as
      // cancelled (codex round 4 B1 — activityCanceled must not land
      // while the worker is still alive and possibly still writing).
      if (cancelRequested && !settled) {
        settled = true;
        cleanup({ skipSigterm: true });
        reject(new WorkflowSpawnCancelledError(cancelOriginEventId, makeSessionSnapshot()));
        return;
      }
      // If we already resolved, the cleanup() already killed the worker;
      // ignore the exit.  If we're still waiting for output, treat as fail.
      if (!settled && collectedOutputs.length === 0) {
        fail(
          new Error(
            `worker exited (code=${code ?? 'null'}) before producing final_output`,
          ),
        );
      }
    });

    // Some workers send 'init' eagerly without waiting for 'ready' — for
    // tests we send right away.  Real worker.js requires us to wait for
    // 'ready' (it allocates a port first), but it also short-circuits a
    // double `init`, so a redundant send is harmless.
    try {
      logOneShotMemory(input, 'before-eager-init-send');
      worker.send(init);
      logOneShotMemory(input, 'after-eager-init-send');
    } catch {
      /* worker may not be ready yet — wait for 'ready' to retry */
      logOneShotMemory(input, 'eager-init-send-failed');
    }
  });
}

function writeAttemptTerminalSidecar(
  input: DaemonRunOneShotInput,
  session: WorkerSessionInfo,
  status: AttemptTerminalStatus,
): void {
  if (!input.attemptLogPath || session.webPort === undefined || session.webPort <= 0) return;
  try {
    const dir = dirname(input.attemptLogPath);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const sidecar: AttemptTerminalSidecar = {
      schemaVersion: ATTEMPT_TERMINAL_SCHEMA_VERSION,
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      webPort: session.webPort,
      status,
      larkAppId: session.larkAppId,
      botName: session.botName,
      cliId: session.cliId,
      workingDir: session.workingDir,
      logPath: session.logPath,
      startedAt: session.startedAt,
      updatedAt: now,
      ...(status === 'closed' ? { closedAt: now } : {}),
    };
    // 原子写：daemon 重启后 attempt-resume 会读这个 sidecar 恢复会话。
    atomicWriteFileSync(
      join(dir, ATTEMPT_TERMINAL_SIDECAR),
      JSON.stringify(sidecar, null, 2),
    );
  } catch (err) {
    appendAttemptLog(
      input,
      'system',
      `failed to write terminal sidecar: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Per-spawn memory diagnostics. Gated by the same env flag the periodic
// daemon-level diag uses (`BOTMUX_MEMORY_DIAG_INTERVAL_MS` > 0). Default off
// in master so workflow spawn doesn't spam ~10 lines per attempt; flip the env
// on when chasing a real RSS regression and both layers light up together.
function spawnMemDiagEnabled(): boolean {
  const raw = process.env.BOTMUX_MEMORY_DIAG_INTERVAL_MS;
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

function logOneShotMemory(input: DaemonRunOneShotInput, phase: string): void {
  if (!spawnMemDiagEnabled()) return;
  const usage = process.memoryUsage();
  const external = usage.external ?? 0;
  const nativeOther = Math.max(0, usage.rss - usage.heapTotal - external);
  logger.info(
    `[workflow:${input.runId}:${input.nodeId}:spawn-mem] ` +
    `phase=${phase} ` +
    `rss=${formatMiB(usage.rss)} ` +
    `heapUsed=${formatMiB(usage.heapUsed)} ` +
    `heapTotal=${formatMiB(usage.heapTotal)} ` +
    `external=${formatMiB(external)} ` +
    `arrayBuffers=${formatMiB(usage.arrayBuffers ?? 0)} ` +
    `nativeOther~=${formatMiB(nativeOther)} ` +
    `promptBytes=${Buffer.byteLength(input.prompt, 'utf-8')} ` +
    `cwd=${expandWorkflowWorkingDir(input.workingDir) ?? process.cwd()}`,
  );
}

export function expandWorkflowWorkingDir(workingDir: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  if (workingDir === '~') return homedir();
  if (workingDir.startsWith('~/')) return join(homedir(), workingDir.slice(2));
  return workingDir;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

function drainWorkerDiagnostics(worker: WorkerHandle, input: DaemonRunOneShotInput): void {
  const { runId, nodeId } = input;
  const prefix = `[workflow:${runId}:${nodeId}:worker]`;
  worker.stdout?.on?.('data', (data: Buffer | string) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`${prefix}:out ${truncateLogLine(trimmed)}`);
    }
    appendAttemptLog(input, 'stdout', String(data));
  });
  worker.stderr?.on?.('data', (data: Buffer | string) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`${prefix}:err ${truncateLogLine(trimmed)}`);
    }
    appendAttemptLog(input, 'stderr', String(data));
  });
}

function appendAttemptLog(
  input: Pick<DaemonRunOneShotInput, 'attemptLogPath'>,
  channel: string,
  chunk: string,
): void {
  if (!input.attemptLogPath) return;
  const ts = new Date().toISOString();
  const text = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
  const lines = text.replace(/\r/g, '').split('\n');
  let out = '';
  for (const line of lines) {
    if (line === '') continue;
    out += `[${ts}] ${channel} ${line}\n`;
  }
  if (!out) return;
  try {
    appendFileSync(input.attemptLogPath, out, 'utf-8');
  } catch (err) {
    logger.warn(
      `failed to append workflow attempt log ${input.attemptLogPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function truncateLogLine(line: string): string {
  return line.length > 2000 ? `${line.slice(0, 2000)}…[truncated]` : line;
}

/**
 * Deterministically map any string id to a UUID-v4-shaped hex token.
 *
 * Why: Claude Code CLI ≥ 2.1.146 rejects `--session-id` values that
 * aren't valid UUIDs ("Invalid session ID. Must be a valid UUID."). The
 * workflow runtime mints synthetic ids by concatenating runId /
 * activityId / attemptId (which embed `::` separators), so the raw form
 * fails validation. We keep determinism (same input → same uuid, so the
 * jsonl bridge path & resume both work) by hashing through SHA-256 and
 * rewriting the version + variant nibbles to satisfy the v4 shape.
 */
export function syntheticSessionUuid(rawId: string): string {
  const h = createHash('sha256').update(rawId).digest('hex');
  const version = `4${h.slice(13, 16)}`;
  const variantNibble = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${h.slice(17, 20)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version}-${variant}-${h.slice(20, 32)}`;
}

function syntheticIds(input: DaemonRunOneShotInput): {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
} {
  const rawSessionId = `wf-${input.runId}-${input.activityId}-${input.attemptId}`;
  return {
    sessionId: syntheticSessionUuid(rawSessionId),
    chatId: `wf-chat-${input.runId}`,
    rootMessageId: `wf-root-${input.activityId}`,
  };
}
