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
} from '../daemon-spawn.js';
import {
  GOAL_ENV,
  type RunNode,
  type RunNodeRequest,
  type RunNodeResult,
  type WorkerSessionInfo,
} from './contract.js';

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
  const secret = await deps.resolveLarkAppSecret(req.botSnapshot.larkAppId);
  const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH] ?? join(req.attemptDir, 'manifest.json');
  const ptyLogPath = join(req.attemptDir, 'pty.log');
  if (!secret) return { status: 'fail', manifestPath };

  await mkdir(dirname(stdoutPath(req)), { recursive: true });
  await mkdir(dirname(stderrPath(req)), { recursive: true });

  const cwd = expandWorkflowWorkingDir(req.botSnapshot.workingDir) ?? process.cwd();
  const sessionId = syntheticSessionUuid(`v3-${req.runId}-${req.attemptId}`);
  const worker = deps.factory.spawn({
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
    // P2: 受限 bot / restricted 节点 → worker 关闭 CLI 权限旁路（adapter 据此
    // 不再注入 --dangerously-skip-permissions / --yolo 等 bypass flag）。
    disableCliBypass: req.botSnapshot.disableCliBypass === true,
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
    let quiesceTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let manifestTimer: NodeJS.Timeout | undefined;
    let manifestCandidate: { size: number; mtimeMs: number; firstSeenMs: number } | undefined;
    let webPort: number | undefined;
    let token: string | undefined;
    let cancelRequested = false;
    let initSent = false;
    let goalSent = false;
    let sessionReadyNotified = false;

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

    function cleanup(signal: NodeJS.Signals = 'SIGTERM'): void {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      if (manifestTimer) clearTimeout(manifestTimer);
      req.cancelSignal?.removeEventListener('abort', onAbort);
      try { worker.send({ type: 'close' }); } catch { /* worker may be gone */ }
      setTimeout(() => {
        try { worker.kill(signal); } catch { /* worker may be gone */ }
      }, 250);
    }

    function finish(status: RunNodeResult['status'], reason: string): void {
      if (settled) return;
      settled = true;
      cleanup(status === 'ok' ? 'SIGTERM' : 'SIGTERM');
      void appendLine(stderrPath(req), `[v3] worker finished status=${status} reason=${reason}`);
      resolve({ status, manifestPath, sessionInfo: sessionInfo() });
    }

    function onAbort(): void {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      clearTimeout(hardDeadline);
      if (quiesceTimer) {
        clearTimeout(quiesceTimer);
        quiesceTimer = undefined;
      }
      if (manifestTimer) {
        clearTimeout(manifestTimer);
        manifestTimer = undefined;
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
      if (cancelRequested && event.type !== 'claude_exit') return;
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

    worker.on('error', (err) => {
      void appendLine(stderrPath(req), `[worker] process error: ${err.message}`);
      finish('fail', 'worker-process-error');
    });

    worker.on('exit', (code) => {
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (!settled) finish(cancelRequested ? 'fail' : (code === 0 ? 'ok' : 'fail'), 'worker-exit');
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
