/**
 * v3 ephemeral worker pool.
 *
 * One `runNode` call forks one throwaway worker, initializes it in goal-mode,
 * waits for the CLI turn to finish, then tears the worker down.  The pool
 * deliberately does NOT parse or trust the model's final text; node success is
 * determined later by validating BOTMUX_GOAL_MANIFEST_PATH.
 */

import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerToDaemon } from '../../types.js';
import {
  expandWorkflowWorkingDir,
  forkWorkerJsFactory,
  syntheticSessionUuid,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../shared/worker-process.js';
import {
  GOAL_ENV,
  type RunNode,
  type RunNodeRequest,
  type RunNodeResult,
  type WorkerSessionInfo,
} from './contract.js';
import { workflowSandboxInitFields } from '../shared/sandbox-policy.js';
import {
  armV3AttemptWorkerFence,
  bindV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  closeV3AttemptWorkerFence,
  readV3AttemptWorkerFence,
  removeV3AttemptWorkerFence,
} from './worker-fence.js';

type WorkerEvent = WorkerToDaemon;

export const GOAL_COMMAND = '/goal';

export interface EphemeralPoolDeps {
  /**
   * Secrets are intentionally not frozen into the runDir.  Resolve the live
   * secret by the frozen larkAppId at spawn time.
   */
  resolveLarkAppSecret(larkAppId: string): string | undefined | Promise<string | undefined>;
  factory?: WorkerProcessFactory;
  workerPath?: string;
  quiesceMs?: number;
  cancelGraceMs?: number;
  manifestPollMs?: number;
  manifestSettleMs?: number;
}

export function createEphemeralPool(deps: EphemeralPoolDeps): { runNode: RunNode } {
  const factory = deps.factory ?? forkWorkerJsFactory;
  const workerPath = deps.workerPath ?? defaultWorkerPath();
  const quiesceMs = deps.quiesceMs ?? 500;
  const cancelGraceMs = deps.cancelGraceMs ?? 5000;
  const manifestPollMs = deps.manifestPollMs ?? 1000;
  const manifestSettleMs = deps.manifestSettleMs ?? 1000;
  return {
    runNode: (req) => runNodeImpl(req, {
      ...deps,
      factory,
      workerPath,
      quiesceMs,
      cancelGraceMs,
      manifestPollMs,
      manifestSettleMs,
    }),
  };
}

type RunNodeInternalDeps = Required<Pick<EphemeralPoolDeps, 'factory' | 'workerPath' | 'quiesceMs' | 'cancelGraceMs' | 'manifestPollMs' | 'manifestSettleMs'>> &
  Pick<EphemeralPoolDeps, 'resolveLarkAppSecret'>;

async function runNodeImpl(
  req: RunNodeRequest,
  deps: RunNodeInternalDeps,
): Promise<RunNodeResult> {
  const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH] ?? join(req.attemptDir, 'manifest.json');
  const ptyLogPath = join(req.attemptDir, 'pty.log');
  if (!req.workerFence) await mkdir(req.attemptDir, { recursive: true });
  const armedFence = req.workerFence ??
    armV3AttemptWorkerFence({
      attemptDir: req.attemptDir,
      runId: req.runId,
      attemptId: req.attemptId,
    });
  // A durable run cancel may beat this dispatch into the pool. Never resolve
  // credentials or fork a worker for an already-aborted attempt.
  if (req.cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: req.cancelSignal.reason };
  }
  let secret: string | undefined;
  try {
    secret = await deps.resolveLarkAppSecret(req.botSnapshot.larkAppId);
  } catch (err) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'setup_failed');
    throw err;
  }
  if (req.cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: req.cancelSignal.reason };
  }
  if (!secret) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'secret_missing');
    return { status: 'fail', manifestPath };
  }

  try {
    await mkdir(dirname(stdoutPath(req)), { recursive: true });
    await mkdir(dirname(stderrPath(req)), { recursive: true });
  } catch (err) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'setup_failed');
    throw err;
  }

  if (req.cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: req.cancelSignal.reason };
  }

  const cwd = expandWorkflowWorkingDir(req.botSnapshot.workingDir) ?? process.cwd();
  const sessionId = syntheticSessionUuid(`v3-${req.runId}-${req.attemptId}`);
  let worker: WorkerHandle;
  try {
    worker = deps.factory.spawn({
      workerPath: deps.workerPath,
      cwd,
      env: {
        ...process.env,
        ...req.env,
        [GOAL_ENV.V3_MARKER]: '1',
        BOTMUX_WORKFLOW: '1',
        BOTMUX_WORKFLOW_PTY_LOG_PATH: ptyLogPath,
        BOTMUX_WORKFLOW_RUN_ID: req.runId,
        BOTMUX_WORKFLOW_NODE_ID: req.node.id,
      },
    });
  } catch (err) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'spawn_threw');
    throw err;
  }

  // Register a close waiter before activation so even a child that fails in
  // its first tick cannot escape the bind-failure drain path below.
  let outerCloseSeen = false;
  let resolveOuterClose: (() => void) | undefined;
  let deferredWorkerError: Error | undefined;
  let forwardWorkerError: ((error: Error) => void) | undefined;
  const outerClose = new Promise<void>((resolve) => {
    resolveOuterClose = resolve;
    worker.on('close', () => {
      outerCloseSeen = true;
      resolve();
    });
  });
  // A fork that fails asynchronously emits `error` before/alongside `close`
  // and may have no pid, which makes fence binding fail immediately. Install
  // the listener before binding so that path cannot surface an unhandled
  // EventEmitter error and crash the daemon. Once the main settle state
  // exists, forward the first deferred error into its ordinary failure path.
  worker.on('error', (err) => {
    void appendLine(stderrPath(req), `[worker] process error: ${err.message}`);
    if (forwardWorkerError) forwardWorkerError(err);
    else deferredWorkerError ??= err;
  });
  try {
    bindV3AttemptWorkerFence({
      worker,
      attemptDir: req.attemptDir,
      armed: armedFence,
      onCleanupError: (err) => {
        void appendLine(stderrPath(req), `[v3] worker fence close failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  } catch (bindError) {
    // Fork succeeded, so never reject until the outer process resource fence
    // closes. Otherwise runtime could settle the node while an unfenced worker
    // continues executing. Escalate close → TERM → KILL and then preserve a
    // closed tombstone (or remove the still-armed record after proven close).
    try { worker.send({ type: 'close' }); } catch { /* child may not have IPC */ }
    const term = setTimeout(() => {
      try { worker.kill('SIGTERM'); } catch { /* already gone */ }
    }, 250);
    const kill = setTimeout(() => {
      try { worker.kill('SIGKILL'); } catch { /* already gone */ }
    }, 250 + deps.cancelGraceMs);
    if (!outerCloseSeen) await outerClose;
    clearTimeout(term);
    clearTimeout(kill);
    try {
      const current = readV3AttemptWorkerFence(req.attemptDir, {
        runId: req.runId,
        attemptId: req.attemptId,
      });
      if (current?.phase === 'active') closeV3AttemptWorkerFence(req.attemptDir, current);
      else if (current?.phase === 'armed') removeV3AttemptWorkerFence(req.attemptDir, current);
    } catch { /* recovery will fail closed on a malformed/stale fence */ }
    throw bindError;
  } finally {
    // Keep a strong reference until listeners are installed; this assignment
    // also documents that close can race activation without being lost.
    void resolveOuterClose;
  }

  drainWorkerDiagnostics(worker, req);

  const init = {
    type: 'init' as const,
    sessionId,
    chatId: `v3-chat-${req.runId}`,
    rootMessageId: `v3-root-${req.attemptId}`,
    workingDir: cwd,
    cliId: req.botSnapshot.cliId,
    cliPathOverride: req.botSnapshot.cliPathOverride,
    model: req.botSnapshot.model,
    // Workflow workers require CLI bypass permissions by product contract.
    // Restricted bots are rejected before a BotSnapshot is created.
    disableCliBypass: false,
    ...workflowSandboxInitFields(req.botSnapshot),
    backendType: 'pty' as const,
    prompt: '',
    resume: false,
    larkAppId: req.botSnapshot.larkAppId,
    larkAppSecret: secret,
    botName: req.node.bot,
    locale: 'zh' as const,
  };

  return new Promise<RunNodeResult>((resolve) => {
    let settled = false;
    let pendingResult: { status: 'ok' | 'fail'; reason: string } | undefined;
    let quiesceTimer: NodeJS.Timeout | undefined;
    let sigtermTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let manifestTimer: NodeJS.Timeout | undefined;
    let manifestCandidate: { size: number; mtimeMs: number; firstSeenMs: number } | undefined;
    let webPort: number | undefined;
    let token: string | undefined;
    let cancelRequested = false;
    let initSent = false;
    let goalSent = false;
    let sessionReadyNotified = false;
    let cancelReason: unknown;

    const hardDeadline = setTimeout(() => {
      finish('fail', 'timeout');
    }, req.timeoutMs);

    function sessionInfo(): WorkerSessionInfo {
      return {
        sessionId,
        ...(webPort !== undefined ? { webPort } : {}),
        ...(token ? { token } : {}),
      };
    }

    function notifySessionReady(): void {
      if (sessionReadyNotified || webPort === undefined) return;
      sessionReadyNotified = true;
      try {
        void req.onSessionReady?.({
          ...sessionInfo(),
          ptyLogPath,
        });
      } catch (err) {
        void appendLine(stderrPath(req), `[v3] onSessionReady callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    function requestWorkerExit(): void {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      if (manifestTimer) clearTimeout(manifestTimer);
      try { worker.send({ type: 'close' }); } catch { /* worker may be gone */ }
      sigtermTimer = setTimeout(() => {
        try { worker.kill('SIGTERM'); } catch { /* worker may be gone */ }
      }, 250);
      // A normal success/failure must also be fenced by the outer worker exit.
      // If close+SIGTERM cannot stop it, use the same bounded hard fallback as
      // cancellation; never leave the runtime waiting forever on a wedged child.
      sigkillTimer = setTimeout(() => {
        void appendLine(stderrPath(req), `[v3] worker exit grace expired; escalating to SIGKILL`);
        try { worker.kill('SIGKILL'); } catch { /* worker may be gone */ }
      }, 250 + deps.cancelGraceMs);
    }

    function finish(status: RunNodeResult['status'], reason: string): void {
      if (settled || cancelRequested || pendingResult) return;
      if (status === 'cancelled') return;
      pendingResult = { status, reason };
      void appendLine(stderrPath(req), `[v3] worker outcome claimed status=${status} reason=${reason}; waiting for worker exit`);
      requestWorkerExit();
    }

    function onAbort(): void {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      cancelReason = req.cancelSignal?.reason;
      pendingResult = undefined;
      clearTimeout(hardDeadline);
      if (quiesceTimer) {
        clearTimeout(quiesceTimer);
        quiesceTimer = undefined;
      }
      if (manifestTimer) {
        clearTimeout(manifestTimer);
        manifestTimer = undefined;
      }
      if (sigtermTimer) {
        clearTimeout(sigtermTimer);
        sigtermTimer = undefined;
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
      void appendLine(stderrPath(req), `[v3] cancel signal received; sending close+SIGINT`);
      try { worker.send({ type: 'close' }); } catch { /* already gone */ }
      try { worker.kill('SIGINT'); } catch { /* already gone */ }
      sigkillTimer = setTimeout(() => {
        void appendLine(stderrPath(req), `[v3] cancel grace expired; escalating to SIGKILL`);
        try { worker.kill('SIGKILL'); } catch { /* already gone */ }
      }, deps.cancelGraceMs);
    }

    if (req.cancelSignal) {
      if (req.cancelSignal.aborted) setImmediate(onAbort);
      else req.cancelSignal.addEventListener('abort', onAbort);
    }

    function armQuiesce(): void {
      if (quiesceTimer) clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(() => finish('ok', 'final_output'), deps.quiesceMs);
    }

    function sendInit(): void {
      if (initSent) return;
      worker.send(init);
      initSent = true;
    }

    function sendGoalIfReady(): void {
      if (!initSent || webPort === undefined || goalSent) return;
      worker.send({ type: 'raw_input', content: buildGoalCommand(req) });
      goalSent = true;
      startManifestWatch();
    }

    function startManifestWatch(): void {
      if (manifestTimer || settled) return;
      const poll = () => {
        manifestTimer = undefined;
        if (settled || cancelRequested) return;
        const stable = manifestIsStable(manifestPath, manifestCandidate, deps.manifestSettleMs);
        manifestCandidate = stable.candidate;
        if (stable.done) {
          finish('ok', 'manifest-written');
          return;
        }
        manifestTimer = setTimeout(poll, deps.manifestPollMs);
      };
      manifestTimer = setTimeout(poll, deps.manifestPollMs);
    }

    worker.on('message', (event: WorkerEvent) => {
      if (cancelRequested) {
        // CLI exit is not the outer worker exit.  The worker may still own a
        // PTY, file descriptors, or sandbox cleanup, so no IPC message may
        // settle cancellation; only ChildProcess 'close' below is the fence.
        if (event.type === 'claude_exit') {
          void appendLine(stderrPath(req), `[worker] cli exited while cancellation waits for worker exit`);
        }
        return;
      }
      if (pendingResult) return;
      switch (event.type) {
        case 'ready':
          webPort = event.port;
          token = event.token;
          notifySessionReady();
          try {
            sendInit();
          } catch {
            finish('fail', 'init-send-failed');
          }
          break;
        case 'final_output':
          void appendLine(stdoutPath(req), event.content);
          armQuiesce();
          break;
        case 'screen_update':
          break;
        case 'prompt_ready':
          try {
            sendGoalIfReady();
          } catch {
            finish('fail', 'goal-send-failed');
          }
          break;
        case 'error':
          void appendLine(stderrPath(req), `[worker] ${event.message}`);
          finish('fail', 'worker-error');
          break;
        case 'claude_exit':
          void appendLine(stderrPath(req), `[worker] cli exit code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`);
          finish(event.code === 0 ? 'ok' : 'fail', 'cli-exit');
          break;
      }
    });

    forwardWorkerError = (err) => {
      if (cancelRequested) return;
      finish('fail', 'worker-process-error');
    };
    if (deferredWorkerError) {
      const err = deferredWorkerError;
      deferredWorkerError = undefined;
      setImmediate(() => forwardWorkerError?.(err));
    }

    worker.on('close', (code) => {
      if (sigtermTimer) clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settled) return;
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      if (manifestTimer) clearTimeout(manifestTimer);
      req.cancelSignal?.removeEventListener('abort', onAbort);
      if (cancelRequested) {
        settled = true;
        void appendLine(stderrPath(req), `[v3] worker closed after cancellation code=${code ?? 'null'}`);
        resolve({
          status: 'cancelled',
          manifestPath,
          cancelReason,
          sessionInfo: sessionInfo(),
        });
        return;
      }
      settled = true;
      const status = pendingResult?.status ?? (code === 0 ? 'ok' : 'fail');
      const reason = pendingResult?.reason ?? 'worker-exit';
      void appendLine(stderrPath(req), `[v3] worker closed status=${status} reason=${reason} code=${code ?? 'null'}`);
      resolve({ status, manifestPath, sessionInfo: sessionInfo() });
    });

    try {
      sendInit();
    } catch {
      // Real worker emits `ready` from inside its init handler.  Keep the
      // ready-branch retry for scripted or partially-started workers, but never
      // send /goal until the CLI reports `prompt_ready`.
    }
  });
}

export function buildGoalCommand(req: RunNodeRequest): string {
  const env = GOAL_ENV;
  return `${GOAL_COMMAND} Read $${env.GOAL_PATH} and complete it. You are done only when $${env.MANIFEST_PATH} and all files it lists exist.`;
}

function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', '..', 'worker.js');
  if (existsSync(candidate)) return candidate;
  return join(here, '..', '..', '..', 'src', 'worker.ts');
}

function stdoutPath(req: RunNodeRequest): string {
  return req.stdoutPath ?? join(req.attemptDir, 'stdout.log');
}

function stderrPath(req: RunNodeRequest): string {
  return req.stderrPath ?? join(req.attemptDir, 'stderr.log');
}

function manifestIsStable(
  manifestPath: string,
  previous: { size: number; mtimeMs: number; firstSeenMs: number } | undefined,
  settleMs: number,
): { done: boolean; candidate: { size: number; mtimeMs: number; firstSeenMs: number } | undefined } {
  let stat;
  try {
    stat = statSync(manifestPath);
  } catch {
    return { done: false, candidate: undefined };
  }
  if (!stat.isFile()) return { done: false, candidate: undefined };

  const now = Date.now();
  if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) {
    return {
      done: false,
      candidate: { size: stat.size, mtimeMs: stat.mtimeMs, firstSeenMs: now },
    };
  }
  return {
    done: now - previous.firstSeenMs >= settleMs,
    candidate: previous,
  };
}

function drainWorkerDiagnostics(worker: WorkerHandle, req: RunNodeRequest): void {
  worker.stdout?.on?.('data', (chunk: Buffer | string) => {
    void appendRaw(stdoutPath(req), String(chunk));
  });
  worker.stderr?.on?.('data', (chunk: Buffer | string) => {
    void appendRaw(stderrPath(req), String(chunk));
  });
}

async function appendLine(path: string, line: string): Promise<void> {
  await appendRaw(path, line.endsWith('\n') ? line : `${line}\n`);
}

async function appendRaw(path: string, text: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, 'utf-8');
  } catch {
    // Logging is best-effort; runtime state is driven by the returned status
    // and manifest validation, not by diagnostic log writes.
  }
}
