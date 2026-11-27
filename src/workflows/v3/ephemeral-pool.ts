/**
 * v3 ephemeral worker pool.
 *
 * One `runNode` call forks one throwaway worker, initializes it in goal-mode,
 * waits for the CLI turn to finish, then tears the worker down.  The pool
 * deliberately does NOT parse or trust the model's final text; node success is
 * determined later by validating BOTMUX_GOAL_MANIFEST_PATH.
 */

import { buildBotWorkerEnv } from '../../core/env-policy.js';
import { protectedMcpCurrentRedactedEnvKeys, protectedMcpIsolationPolicy } from '../../core/protected-mcp-capabilities.js';
import { configuredProtectedMcpEnvKeys, readGlobalConfig } from '../../global-config.js';
import { SessionController } from '../../core/session-controller.js';
import { SessionContractStore } from '../../services/session-contract-store.js';
import { sessionContractsEnabled } from '../../services/session-contract.js';
import type { DaemonSession } from '../../core/types.js';
import { resolveSessionEnv, type SessionEnvBotInput } from '../../core/session-env-resolve.js';
import { effectiveDefaultWorkingDir, getBot, loadBotConfigsCached, type BotConfig } from '../../bot-registry.js';
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { BoundedLogFile } from '../../utils/bounded-log-file.js';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerToDaemon } from '../../types.js';
import type { BackendType } from '../../adapters/backend/types.js';
import { config } from '../../config.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { resolveSandboxMode } from '../../adapters/cli/sandbox-mode.js';
import { prepareWorkflowClaudeTrust } from '../../core/claude-folder-trust.js';
import { spawnWorker } from '../../core/self-spawn.js';
import {
  expandWorkflowWorkingDir,
  syntheticSessionUuid,
  type WorkerHandle,
  type WorkerProcessFactory,
} from '../shared/worker-process.js';
import {
  GOAL_COMMAND,
  GOAL_COMMAND_OBJECTIVE,
  GOAL_ENV,
  cliTakesNativeGoalCommand,
  type RunNode,
  type RunNodeRequest,
  type RunNodeResult,
  type RuntimeAttestation,
  type WorkerSessionInfo,
} from './contract.js';
import { workflowSandboxInitFields } from '../shared/sandbox-policy.js';
import { stripPm2GracefulExitMarker } from '../../pm2-graceful-exit.js';
import { removeSessionSkillRuntime } from '../../core/skills/snapshot.js';
import {
  armV3AttemptWorkerFence,
  bindV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  closeV3AttemptWorkerFence,
  readV3AttemptWorkerFence,
  removeV3AttemptWorkerFence,
} from './worker-fence.js';

type WorkerEvent = WorkerToDaemon;

export { GOAL_COMMAND } from './contract.js';

/**
 * Cushion between a workflow node's outer wall-clock deadline and an
 * adapter-internal turn timer (mcode ACP runner). The outer pool deadline
 * plus its SIGTERM/SIGKILL escalation (~5.3s) must win; keep a wide margin.
 */
const WORKFLOW_INNER_TURN_GRACE_MS = 60_000;

export interface EphemeralPoolDeps {
  /**
   * Secrets are intentionally not frozen into the runDir.  Resolve the live
   * secret by the frozen larkAppId at spawn time.
   */
  resolveLarkAppSecret(larkAppId: string): string | undefined | Promise<string | undefined>;
  /** Resolve the live bot config at spawn time so env values (session-env
   *  layers, core/session-env.ts) are never persisted in snapshots. Defaults
   *  to this daemon's bot registry, then live bots.json. */
  resolveBot?: (larkAppId: string) => SessionEnvBotInput | undefined;
  factory?: WorkerProcessFactory;
  workerPath?: string;
  quiesceMs?: number;
  cancelGraceMs?: number;
  manifestPollMs?: number;
  manifestSettleMs?: number;
}

/** Live config of a node's bot. A daemon registers only its own bot, and
 *  standalone runs register none, while workflow nodes may use any configured
 *  bot: fall back to live bots.json. */
function liveBotConfig(larkAppId: string): BotConfig | undefined {
  try { return getBot(larkAppId).config; } catch { /* not hosted by this daemon */ }
  try { return loadBotConfigsCached().find(b => b.larkAppId === larkAppId); } catch { return undefined; }
}

/** A run may override its cwd or replay an old profile. Only seed the live
 * bot's configured project and profile. A sandbox or credential-isolated
 * worker provisions its own state and must leave its source profile alone. */
async function prepareNodeFolderTrust(
  snapshot: RunNodeRequest['botSnapshot'], cwd: string, sandboxEnv: string | undefined, signal?: AbortSignal,
): Promise<void> {
  if (snapshot.credentialsSourceDir || resolveSandboxMode({ configSandbox: snapshot.sandbox, envValue: sandboxEnv }) !== 'off') return;
  const bot = liveBotConfig(snapshot.larkAppId);
  if (!bot || bot.cliId !== snapshot.cliId || bot.cliConfigDir !== snapshot.cliConfigDir) return;
  const adapter = createCliAdapterSync(snapshot.cliId, snapshot.cliPathOverride, { configDir: snapshot.cliConfigDir });
  if (!adapter.claudeStateJsonPath) return;

  const canonical = realpathSync(cwd);
  const directories = [effectiveDefaultWorkingDir(bot), bot.workingDir, ...(bot.workingDirs ?? [])];
  const configured = directories.some(directory => {
    const path = expandWorkflowWorkingDir(directory);
    if (!path) return false;
    try { return realpathSync(path) === canonical; } catch { return false; }
  });
  if (configured) await prepareWorkflowClaudeTrust(canonical, adapter.claudeStateJsonPath, signal);
}

/** Throws when the live bot runs personal-assistant mode (see runNodeImpl). */
export function assertNotAssistantModeBot(larkAppId: string): void {
  // A bot absent from both sources has no secret to launch with either, so
  // that case is left to the credential resolver.
  const assistant = liveBotConfig(larkAppId)?.assistantMode === true;
  if (assistant) throw new Error(`v3 workflow does not support personal-assistant mode; bot ${larkAppId} has assistantMode=true`);
}

/** Session env overlay for a workflow worker, from the live bot config. */
function v3WorkerSessionEnv(
  larkAppId: string,
  resolveBot: EphemeralPoolDeps['resolveBot'],
): { env?: Record<string, string>; envUnset?: string[] } {
  let bot: SessionEnvBotInput | undefined;
  try { bot = (resolveBot ?? liveBotConfig)(larkAppId); } catch { bot = undefined; }
  if (!bot) return {};
  // Workflow workers never install the identity wrappers (usesLarkToolBinding).
  const resolved = resolveSessionEnv({ bot, backendType: v3WorkerBackendType(), facts: { unwrapped: true } });
  return {
    ...(resolved.env ? { env: resolved.env } : {}),
    ...(resolved.envUnset ? { envUnset: resolved.envUnset } : {}),
  };
}

export function createEphemeralPool(deps: EphemeralPoolDeps): { runNode: RunNode } {
  const factory = deps.factory ?? spawnWorkerFactory;
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
  Pick<EphemeralPoolDeps, 'resolveLarkAppSecret' | 'resolveBot'>;

async function runNodeImpl(
  req: RunNodeRequest,
  deps: RunNodeInternalDeps,
): Promise<RunNodeResult> {
  const logLimit = new AbortController();
  const openLog = (path: string, name: string) => new BoundedLogFile(path, {
    onLimit: kind => logLimit.abort(`${name} exceeded the ${kind} limit`),
  });
  const stdout = openLog(stdoutPath(req), 'stdout.log');
  const stderr = logFileKey(stdout.path) === logFileKey(stderrPath(req)) ? stdout : openLog(stderrPath(req), 'stderr.log');
  try {
    const result = await runNodeWithLogs(req, deps, stdout, stderr, logLimit);
    // Pipe data and the final receipt can arrive after success is claimed but before close.
    if (logLimit.signal.aborted && result.status !== 'cancelled') {
      const error = { code: 'WORKFLOW_LOG_LIMIT', message: String(logLimit.signal.reason) };
      return { ...result, status: 'fail', error, failureDetail: error.message };
    }
    return result;
  } finally {
    await Promise.all([stdout.end(), stderr.end()]);
  }
}

async function runNodeWithLogs(
  req: RunNodeRequest,
  deps: RunNodeInternalDeps,
  stdout: BoundedLogFile,
  stderr: BoundedLogFile,
  logLimit: AbortController,
): Promise<RunNodeResult> {
  if (req.attemptLease && req.attemptLease.attemptId !== req.attemptId) {
    throw new Error(
      `v3 pool: attempt lease "${req.attemptLease.attemptId}" does not match request "${req.attemptId}"`,
    );
  }
  // Personal-assistant mode is checked against the LIVE bot, not the frozen
  // snapshot: a run paused before the mode was enabled resumes from its stored
  // snapshot, and a workflow worker has no per-owner session (it would get the
  // bot-wide BOT_HOME). Refuse before any side effect.
  assertNotAssistantModeBot(req.botSnapshot.larkAppId);
  const cancelSignal = req.attemptLease?.signal ?? req.cancelSignal;
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
  if (cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: cancelSignal.reason };
  }
  let secret: string | undefined;
  try {
    secret = await deps.resolveLarkAppSecret(req.botSnapshot.larkAppId);
  } catch (err) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'setup_failed');
    throw err;
  }
  if (cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: cancelSignal.reason };
  }
  if (!secret) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'secret_missing');
    return { status: 'fail', manifestPath, failureDetail: `no Lark app secret available for ${req.botSnapshot.larkAppId}` };
  }

  try {
    await mkdir(dirname(stdout.path), { recursive: true });
    await mkdir(dirname(stderr.path), { recursive: true });
    const ptyKey = logFileKey(ptyLogPath);
    if (logFileKey(stdout.path) === ptyKey || logFileKey(stderr.path) === ptyKey) {
      throw new Error('workflow stdout/stderr cannot share the worker-owned pty.log');
    }
  } catch (err) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'setup_failed');
    throw err;
  }

  if (cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: cancelSignal.reason };
  }

  const cwd = expandWorkflowWorkingDir(req.botSnapshot.workingDir) ?? process.cwd();
  const sessionId = syntheticSessionUuid(`v3-${req.runId}-${req.attemptId}`);
  const global = readGlobalConfig();
  const protectedEnvKeys = protectedMcpCurrentRedactedEnvKeys(global.protectedMcpCapabilities, configuredProtectedMcpEnvKeys());
  const workerEnv: Record<string, string | undefined> = {
    // v3 ephemeral workers fork straight from the daemon here (not via
    // workerForkEnv), so strip the PM2 graceful-exit sentinel to keep the
    // "only daemon/dashboard carry the marker" invariant — harmless today
    // (the worker doesn't read the graceful helper and its CLI children go
    // through redactChildEnv), but this keeps the boundary honest.
    ...stripPm2GracefulExitMarker(buildBotWorkerEnv(process.env, req.botSnapshot.envPolicy)),
    ...req.env,
    [GOAL_ENV.V3_MARKER]: '1',
    BOTMUX_WORKFLOW: '1',
    BOTMUX_WORKFLOW_PTY_LOG_PATH: ptyLogPath,
    BOTMUX_WORKFLOW_RUN_ID: req.runId,
    BOTMUX_WORKFLOW_NODE_ID: req.node.id,
  };
  for (const key of protectedEnvKeys) delete workerEnv[key];
  try {
    await prepareNodeFolderTrust(req.botSnapshot, cwd, workerEnv.BOTMUX_SANDBOX, cancelSignal);
  } catch (error) {
    // Trust is optional. A missing cwd or profile must still take the normal
    // worker startup path and surface the actual launch error or dialog.
    stderr.writeLine(`[v3] folder trust preparation skipped: ${error}`);
  }
  if (cancelSignal?.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'pre_aborted');
    return { status: 'cancelled', manifestPath, cancelReason: cancelSignal.reason };
  }
  if (logLimit.signal.aborted) {
    closeV3ArmedFenceWithoutSpawn(req.attemptDir, armedFence, 'setup_failed');
    return { status: 'fail', manifestPath };
  }
  // Where the worker writes this attempt's skill manifest + snapshot (its own
  // SESSION_DATA_DIR, i.e. config.session.dataDir unless req.env overrides it).
  const workerDataDir = workerEnv.SESSION_DATA_DIR || config.session.dataDir;
  let worker: WorkerHandle;
  try {
    worker = deps.factory.spawn({
      workerPath: deps.workerPath,
      cwd,
      env: workerEnv,
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
      // The attempt's synthetic session has no persistent row, so
      // sessionStore.closeSession() never runs for it: reclaim its skill
      // manifest + runtime-skills snapshot here, once the worker process
      // (and with it the CLI that read them) has actually exited — on every
      // outcome (ok / fail / timeout / cancelled / bind failure).
      try { removeSessionSkillRuntime(sessionId, workerDataDir); } catch { /* best effort */ }
      resolve();
    });
  });
  // A fork that fails asynchronously emits `error` before/alongside `close`
  // and may have no pid, which makes fence binding fail immediately. Install
  // the listener before binding so that path cannot surface an unhandled
  // EventEmitter error and crash the daemon. Once the main settle state
  // exists, forward the first deferred error into its ordinary failure path.
  worker.on('error', (err) => {
    stderr.writeLine(`[worker] process error: ${err.message}`);
    if (forwardWorkerError) forwardWorkerError(err);
    else deferredWorkerError ??= err;
  });
  try {
    bindV3AttemptWorkerFence({
      worker,
      attemptDir: req.attemptDir,
      armed: armedFence,
      onCleanupError: (err) => {
        stderr.writeLine(`[v3] worker fence close failed: ${err instanceof Error ? err.message : String(err)}`);
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

  worker.stdout?.on('data', (chunk: Buffer | string) => stdout.write(chunk));
  worker.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk));

  // Real chat binding (when the run was born in chat) over synthetic ids: the
  // worker forwards chatId/chatType/rootMessageId/ownerOpenId into the CLI
  // child's BOTMUX_* env, which custom CLI wrappers consume for per-user
  // permission isolation (BOTMUX_OWNER_OPEN_ID is daemon-authenticated at run
  // birth — a CLI child cannot forge it).  Standalone/dev runs keep synthetic
  // values and get no owner env at all.
  const workerSessionEnv = v3WorkerSessionEnv(req.botSnapshot.larkAppId, deps.resolveBot);
  for (const key of protectedEnvKeys) {
    if (workerSessionEnv.env) delete workerSessionEnv.env[key];
  }
  const init = {
    type: 'init' as const,
    sessionId,
    chatId: req.chatBinding?.chatId ?? `v3-chat-${req.runId}`,
    ...(req.chatBinding?.chatType ? { chatType: req.chatBinding.chatType } : {}),
    rootMessageId: req.chatBinding?.rootMessageId ?? `v3-root-${req.attemptId}`,
    ...(req.chatBinding?.ownerOpenId ? { ownerOpenId: req.chatBinding.ownerOpenId } : {}),
    workingDir: cwd,
    cliId: req.botSnapshot.cliId,
    cliInstanceBinding: req.botSnapshot.cliInstanceBinding,
    cliRuntime: req.botSnapshot.cliRuntime,
    cliPathOverride: req.botSnapshot.cliPathOverride,
    credentialsSourceDir: req.botSnapshot.credentialsSourceDir,
    cliConfigDir: req.botSnapshot.cliConfigDir,
    wrapperCli: req.botSnapshot.wrapperCli,
    model: req.botSnapshot.model,
    reasoningEffort: req.botSnapshot.reasoningEffort,
    modelBackendVariant: req.botSnapshot.modelBackendVariant,
    envPolicy: req.botSnapshot.envPolicy,
    ...workerSessionEnv,
    // Workflow nodes receive no write capability or secret channel, but must
    // still deny every machine-configured secret file in their sandbox.
    protectedMcpPolicy: {
      capabilities: [],
      protectedHomePaths: protectedMcpIsolationPolicy([], global.protectedMcpCapabilities).protectedHomePaths,
      redactEnv: protectedEnvKeys,
    },
    // Workflow workers require CLI bypass permissions by product contract.
    // Restricted bots are rejected before a BotSnapshot is created.
    disableCliBypass: false,
    // The mcode runner caps each ACP turn at buildArgs' turnTimeoutMs
    // (runner default 10min when unset). Goal nodes own a much larger wall
    // budget (up to MAX_NODE_TIMEOUT_SEC), so hand the runner a deadline
    // OUTSIDE this node's own hard deadline: the pool's SIGTERM at
    // req.timeoutMs stays the authority for runaway nodes, while a healthy
    // long node is never cut off by the runner first. Only the minimax (and
    // dsh, not v3-admitted) adapters read this field, so the override stays
    // scoped instead of changing every adapter's spawn.
    ...(req.botSnapshot.cliId === 'minimax'
      ? { turnTimeoutMs: req.timeoutMs + WORKFLOW_INNER_TURN_GRACE_MS }
      : {}),
    ...workflowSandboxInitFields(req.botSnapshot),
    // Local terminal backend only: tmux when the daemon runs tmux, otherwise
    // PTY (see v3WorkerBackendType for why it is never the daemon backend as-is).
    backendType: v3WorkerBackendType(),
    prompt: '',
    resume: false,
    larkAppId: req.botSnapshot.larkAppId,
    larkAppSecret: secret,
    botName: req.node.bot,
    locale: 'zh' as const,
  };
  const contractStore = sessionContractsEnabled() ? new SessionContractStore(workerDataDir, req.botSnapshot.larkAppId) : undefined;
  const contractSession = { larkAppId: req.botSnapshot.larkAppId, session: { sessionId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = contractStore ? new SessionController(contractSession, contractStore) : undefined;
  const generation = (controller?.store.read(controller.ref)?.worker?.generation ?? 0) + 1;
  const bootstrap = controller?.bindWorker(generation);
  const execution = controller?.admitInput(req.attemptId, undefined, req.attemptId);
  // The empty init starts the CLI before the goal is dispatched. Attaching the
  // queued execution here would tag prompt_ready with an as-yet unbound turn.
  // Its execution scope belongs on raw_input in sendGoalIfReady().
  const scopedInit = bootstrap ? { ...init, sessionContract: bootstrap } : init;
  const goalBinding = req.botSnapshot.cliInstanceBinding?.source === 'goal'
    ? req.botSnapshot.cliInstanceBinding
    : undefined;

  return new Promise<RunNodeResult>((resolve) => {
    let settled = false;
    let pendingResult: { status: 'ok' | 'fail'; reason: string; detail?: string; error?: RunNodeResult['error'] } | undefined;
    let quiesceTimer: NodeJS.Timeout | undefined;
    let sigtermTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let manifestTimer: NodeJS.Timeout | undefined;
    let manifestCandidate: { size: number; mtimeMs: number; firstSeenMs: number } | undefined;
    let webPort: number | undefined;
    let token: string | undefined;
    let viewToken: string | undefined;
    let cancelRequested = false;
    let initSent = false;
    let goalSent = false;
    /** The CLI cleared its goal after the manifest appeared (see 'error'). */
    let goalAbortedAfterManifest: string | undefined;
    let sessionReadyNotified = false;
    let cancelReason: unknown;
    let observedRuntime: Extract<WorkerEvent, { type: 'active_runtime' }> | undefined;

    function runtimeAttestation(): RuntimeAttestation | undefined {
      if (!observedRuntime) return undefined;
      return {
        cliId: req.botSnapshot.cliId,
        source: 'worker-active-runtime',
        model: observedRuntime.model,
        reasoningEffort: observedRuntime.reasoningEffort,
        ...(goalBinding ? { codexHome: goalBinding.codexHome } : {}),
      };
    }

    function goalRuntimeError(
      runtime: RuntimeAttestation | undefined,
      workerStatus: RunNodeResult['status'],
    ): RunNodeResult['error'] | undefined {
      if (!goalBinding) return undefined;
      if (!runtime) {
        // A worker that already failed (spawn gate, crash, timeout) keeps its
        // own failure; missing evidence only overrides an otherwise-ok run.
        if (workerStatus !== 'ok') return undefined;
        return {
          code: 'GOAL_RUNTIME_UNVERIFIED',
          message: 'goal-scoped Codex worker produced no active-runtime attestation',
        };
      }
      if (runtime.model !== req.botSnapshot.model
        || runtime.reasoningEffort !== req.botSnapshot.reasoningEffort) {
        return {
          code: 'GOAL_RUNTIME_MISMATCH',
          message: `goal-scoped Codex runtime mismatch: expected ${req.botSnapshot.model ?? 'null'}/${req.botSnapshot.reasoningEffort ?? 'null'}, observed ${runtime.model ?? 'null'}/${runtime.reasoningEffort ?? 'null'}`,
        };
      }
      return undefined;
    }

    const hardDeadline = setTimeout(() => {
      finish('fail', 'timeout', { detail: `node timed out after ${Math.round(req.timeoutMs / 1000)}s` });
    }, req.timeoutMs);

    function sessionInfo(): WorkerSessionInfo {
      return {
        sessionId,
        ...(webPort !== undefined ? { webPort } : {}),
        ...(token ? { token } : {}),
        ...(viewToken ? { viewToken } : {}),
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
        stderr.writeLine(`[v3] onSessionReady callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    function requestWorkerExit(): void {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      if (manifestTimer) clearTimeout(manifestTimer);
      try { sendClose(); } catch { /* worker may be gone */ }
      sigtermTimer = setTimeout(() => {
        try { worker.kill('SIGTERM'); } catch { /* worker may be gone */ }
      }, 250);
      // A normal success/failure must also be fenced by the outer worker exit.
      // If close+SIGTERM cannot stop it, use the same bounded hard fallback as
      // cancellation; never leave the runtime waiting forever on a wedged child.
      sigkillTimer = setTimeout(() => {
        stderr.writeLine(`[v3] worker exit grace expired; escalating to SIGKILL`);
        try { worker.kill('SIGKILL'); } catch { /* worker may be gone */ }
      }, 250 + deps.cancelGraceMs);
    }
    function sendClose(): void {
      const operation = controller?.beginControl('close').operation;
      if (operation) controller!.controlStarted(operation.operationId);
      worker.send({ type: 'close', ...(controller ? { sessionCommand: { version: 2, runtime: controller.currentRuntime(), operationId: operation?.operationId } } : {}) });
    }

    /** `detail` is the human-readable root cause kept for a failure that
     *  leaves no manifest; `error` is a precise pool error (wins over both). */
    function finish(
      status: RunNodeResult['status'],
      reason: string,
      outcome: { detail?: string; error?: RunNodeResult['error'] } = {},
    ): void {
      if (settled || cancelRequested || pendingResult) return;
      if (status === 'cancelled') return;
      pendingResult = {
        status, reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      stderr.writeLine(`[v3] worker outcome claimed status=${status} reason=${reason}; waiting for worker exit`);
      requestWorkerExit();
    }

    function onAbort(): void {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      cancelReason = cancelSignal?.reason;
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
      stderr.writeLine(`[v3] cancel signal received; sending close+SIGINT`);
      try { sendClose(); } catch { /* already gone */ }
      try { worker.kill('SIGINT'); } catch { /* already gone */ }
      sigkillTimer = setTimeout(() => {
        stderr.writeLine(`[v3] cancel grace expired; escalating to SIGKILL`);
        try { worker.kill('SIGKILL'); } catch { /* already gone */ }
      }, deps.cancelGraceMs);
    }

    const onLogLimit = () => finish('fail', 'log-limit');
    logLimit.signal.addEventListener('abort', onLogLimit, { once: true });

    if (cancelSignal) {
      if (cancelSignal.aborted) setImmediate(onAbort);
      else cancelSignal.addEventListener('abort', onAbort);
    }

    function armQuiesce(): void {
      if (quiesceTimer) clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(() => finish('ok', 'final_output'), deps.quiesceMs);
    }

    function sendInit(): void {
      if (initSent) return;
      worker.send(scopedInit);
      initSent = true;
    }

    function sendGoalIfReady(): void {
      if (!initSent || webPort === undefined || goalSent) return;
      if (controller && !controller.ds.cliReady) return;
      worker.send({ type: 'raw_input', content: buildGoalCommand(req), turnId: req.attemptId,
        ...(controller ? { sessionCommand: { version: 2, runtime: controller.currentRuntime(), execution } } : {}) });
      goalSent = true;
      startManifestWatch();
    }

    function startManifestWatch(): void {
      if (manifestTimer || settled) return;
      const poll = () => {
        manifestTimer = undefined;
        if (settled || cancelRequested) return;
        if (goalAbortedAfterManifest && !isRegularFile(manifestPath)) {
          // The manifest we deferred to is gone and nothing will write it again.
          finish('fail', 'worker-error', { detail: goalAbortedAfterManifest });
          return;
        }
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

    const handleMessage = (event: WorkerEvent): void => {
      if (controller && bootstrap && event.type !== 'worker_ipc_ready') {
        if (event.type === 'runtime_binding_started' || event.type === 'runtime_binding') {
          if (!controller.admitsRegistration(event.type, event.bindingId, event.sessionContract, bootstrap.worker)) return;
          if (event.type === 'runtime_binding_started') {
            controller.reserveBinding(event.bindingId, bootstrap.worker);
            worker.send({ type: 'runtime_contract_reserved', bindingId: event.bindingId, runtime: controller.store.binding(controller.ref, event.bindingId)?.ref, mayStart: !['closed', 'closing'].includes(controller.store.read(controller.ref)!.lifecycle) });
          }
          else {
            const runtime = controller.bindRuntime(event.bindingId, bootstrap.worker, event.identity, event.operationId);
            worker.send({ type: 'runtime_contract_assigned', bindingId: event.bindingId, runtime: runtime.ref, mayExecute: runtime.phase !== 'retiring',
              executions: controller.store.executions(controller.ref).filter(execution => execution.runtime?.runtimeId === runtime.ref.runtimeId).map(execution => execution.ref),
              admissionStates: controller.store.executions(controller.ref).map(({ ref, runtime, phase }) => ({ ref, runtime, phase })) });
            for (const deferred of controller.store.deferredEvents<WorkerEvent>(controller.ref, event.bindingId)) handleMessage(deferred);
          }
          return;
        }
        const admission = controller.ingest(event as unknown as import('../../core/session-controller.js').ControlledWorkerMessage, bootstrap.worker);
        if (admission.kind === 'reject' || admission.kind === 'defer') return;
        if (event.sessionContract) controller.store.acknowledgeDeferred(controller.ref, event.sessionContract.eventId);
        if (admission.kind === 'historical' && event.type !== 'final_output') return;
      }
      if (cancelRequested) {
        // CLI exit is not the outer worker exit.  The worker may still own a
        // PTY, file descriptors, or sandbox cleanup, so no IPC message may
        // settle cancellation; only ChildProcess 'close' below is the fence.
        if (event.type === 'claude_exit') {
          stderr.writeLine(`[worker] cli exited while cancellation waits for worker exit`);
        }
        return;
      }
      if (event.type === 'error' && event.workflowLogLimit) {
        logLimit.abort(event.message);
        return;
      }
      if (pendingResult) return;
      switch (event.type) {
        case 'ready':
          webPort = event.port;
          token = event.token;
          viewToken = event.viewToken;
          notifySessionReady();
          try {
            sendInit();
          } catch {
            finish('fail', 'init-send-failed');
          }
          break;
        case 'final_output':
          stdout.writeLine(event.content);
          if (!logLimit.signal.aborted) armQuiesce();
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
        case 'active_runtime':
          observedRuntime = event;
          break;
        case 'user_notify':
          // Only the worker's authoritative startup-dialog detection is fatal,
          // and only before the goal went out; every other notice (permission
          // prompts during a running goal, …) stays informational. Nobody can
          // answer the dialog from a workflow, so waiting would only burn the
          // node deadline and end in a bare "manifest missing".
          if (event.kind === 'cli_startup_blocked' && event.startupBlocker && !goalSent) {
            const { kind, rule, folder } = event.startupBlocker;
            const profile = req.botSnapshot.cliConfigDir ? ` (${req.botSnapshot.cliConfigDir})` : '';
            const error = {
              code: `CLI_STARTUP_${kind.toUpperCase()}`,
              message: `${req.botSnapshot.cliId} startup is blocked on ${kind} (${rule})${folder ? ` for ${folder}` : ''} `
                + `before the goal was sent; complete that step with this bot's CLI profile${profile}, then retry the node`,
              retryable: true,
            };
            stderr.writeLine(`[v3] ${error.code}: ${event.message}`);
            finish('fail', 'startup-blocked', { error });
          }
          break;
        case 'error':
          stderr.writeLine(`[worker] ${event.message}`);
          if (event.goalAborted && goalSent && isRegularFile(manifestPath)) {
            // Claude gave up on a call AFTER the goal wrote its manifest (e.g.
            // the context ran out on the closing turn). The work may be on
            // disk: let the manifest watch settle it and the runtime judge it,
            // keeping the cause in case that manifest is not valid.
            goalAbortedAfterManifest = event.message;
            stderr.writeLine('[v3] goal cleared after the manifest was written; settling on the manifest');
            break;
          }
          finish('fail', 'worker-error', { detail: event.message });
          break;
        case 'claude_exit':
          stderr.writeLine(`[worker] cli exit code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`);
          finish(event.code === 0 ? 'ok' : 'fail', 'cli-exit',
            { detail: `CLI exited code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}` });
          break;
      }
    };
    worker.on('message', handleMessage);

    forwardWorkerError = (err) => {
      if (cancelRequested) return;
      finish('fail', 'worker-process-error', { detail: `worker process error: ${err.message}` });
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
      cancelSignal?.removeEventListener('abort', onAbort);
      logLimit.signal.removeEventListener('abort', onLogLimit);
      if (controller && bootstrap) {
        const operation = controller.operation();
        if (operation?.kind === 'close') controller.controlResult(operation.operationId, 'confirmed');
        controller.workerLost(bootstrap.worker);
      }
      contractStore?.close();
      if (cancelRequested) {
        settled = true;
        stderr.writeLine(`[v3] worker closed after cancellation code=${code ?? 'null'}`);
        resolve({
          status: 'cancelled',
          manifestPath,
          cancelReason,
          sessionInfo: sessionInfo(),
          ...(runtimeAttestation() ? { runtime: runtimeAttestation() } : {}),
        });
        return;
      }
      settled = true;
      const runtime = runtimeAttestation();
      const workerStatus = pendingResult?.status ?? (code === 0 ? 'ok' : 'fail');
      const runtimeError = goalRuntimeError(runtime, workerStatus);
      const status = runtimeError ? 'fail' : workerStatus;
      const reason = pendingResult?.reason ?? 'worker-exit';
      if (runtimeError) {
        stderr.writeLine(`[v3] ${runtimeError.code}: ${runtimeError.message}`);
      }
      stderr.writeLine(`[v3] worker closed status=${status} reason=${reason} code=${code ?? 'null'}`);
      const processDetail = workerStatus !== 'fail' ? undefined
        : pendingResult
          // The pool itself closed the worker (send failure, …): its exit code says nothing.
          ? pendingResult.detail ?? `node ended by the pool (${pendingResult.reason})`
          : `worker exited code=${code ?? 'null'}`;
      // A goal the CLI cleared after its manifest appeared is the root cause of
      // whatever ended the node next (deadline, CLI exit, a vanished manifest).
      const failureDetail = goalAbortedAfterManifest && !processDetail?.startsWith(goalAbortedAfterManifest)
        ? (processDetail ? `${goalAbortedAfterManifest}; ${processDetail}` : goalAbortedAfterManifest)
        : processDetail;
      resolve({
        status,
        manifestPath,
        sessionInfo: sessionInfo(),
        ...(failureDetail ? { failureDetail } : {}),
        ...(runtime ? { runtime } : {}),
        ...((runtimeError ?? pendingResult?.error) ? { error: runtimeError ?? pendingResult?.error } : {}),
      });
    });

    if (logLimit.signal.aborted) {
      onLogLimit();
      return;
    }
    try {
      sendInit();
    } catch {
      // Real worker emits `ready` from inside its init handler.  Keep the
      // ready-branch retry for scripted or partially-started workers, but never
      // send /goal until the CLI reports `prompt_ready`.
    }
  });
}

/**
 * First-turn input for a goal-mode worker.
 *
 * Native-`/goal` CLIs get the short `/goal <objective>` line so their native
 * autonomous goal mode handles the turn. Programmatic-session CLIs (mcode's
 * ACP runner, …) have NO verified slash-command surface on the
 * session/prompt path — a literal `/goal` token there is at best inert and at
 * worst an "unknown command" reply — so they receive the bare objective. It
 * is a complete single-line instruction (read goal.txt, write products,
 * write the manifest) either way, and `isBotmuxGoalObjective` matches both
 * shapes.
 */
export function buildGoalCommand(req: RunNodeRequest): string {
  const cliId = req.botSnapshot.cliId;
  return cliTakesNativeGoalCommand(cliId)
    ? `${GOAL_COMMAND} ${GOAL_COMMAND_OBJECTIVE}`
    : GOAL_COMMAND_OBJECTIVE;
}

/**
 * Default worker factory for the v3 pool.
 *
 * Delegates to {@link spawnWorker}, which is the ONLY correct way to launch our
 * own worker entry across both runtime shapes:
 *   • Node (npm/dev): `fork(<distDir>/worker.js)` — byte-for-byte the old
 *     `forkWorkerJsFactory` behavior.
 *   • Bun single-file binary: there is no `worker.js` on disk, so re-exec THIS
 *     binary with the hidden `__worker` subcommand over the same IPC channel.
 *
 * The pre-fix `forkWorkerJsFactory` blindly `fork()`ed `deps.workerPath`, and
 * in a compiled binary `defaultWorkerPath()` resolved that to a bogus
 * `.../src/worker.ts`; `fork` then re-exec'd the binary with that path as a
 * subcommand, which the workflow worker-fence allowlist rejected (exit 2). Here
 * `opts.workerPath` is the dist directory (see {@link defaultWorkerPath}); a
 * standalone binary ignores it and uses the `__worker` subcommand instead.
 */
export const spawnWorkerFactory: WorkerProcessFactory = {
  spawn(opts) {
    const child = spawnWorker({
      distDir: opts.workerPath,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    return {
      send: (message) => child.send(message as never),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        child.on(event as never, cb);
      },
      kill: (signal) => {
        // `child.killed` flips to true when kill(2) is *sent*, not when the
        // process exits; guarding on it would suppress TERM/KILL escalation
        // after an ignored SIGINT. Only an observed exit is terminal.
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
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

/**
 * Terminal backend for a v3 ephemeral worker.
 *
 * Previously hardcoded to `'pty'`, which forced every workflow worker onto
 * node-pty. Under the compiled single-file binary on macOS that path is
 * unusable (even with the spawn-helper materialized, the helper stalls in
 * `open(ttyname(stdin))` under the Bun host), so when the daemon runs tmux the
 * worker follows it — the daemon's own sessions already run there and
 * workflow-worker mode has a dedicated non-PTY branch.
 *
 * Any other daemon backend keeps the old PTY behavior. In particular the pool
 * must never inherit a remote backend (riff/mojo): it has no DaemonSession and
 * sends raw_input without a credential snapshot (see the exemption in
 * test/mojo-wiring.test.ts), and the other multiplexers are not exercised by
 * goal-mode workers.
 */
export function v3WorkerBackendType(daemonBackend: BackendType = config.daemon.backendType): 'tmux' | 'pty' {
  return daemonBackend === 'tmux' ? 'tmux' : 'pty';
}

/**
 * The dist directory whose `worker.js` the Node path forks. `spawnWorker`
 * resolves the actual entry: `<distDir>/worker.js` under Node, or the hidden
 * `__worker` subcommand of the running binary when standalone (where no
 * `worker.js` exists on disk and this path is ignored). `deps.workerPath` stays
 * injectable for tests.
 */
function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/workflows/v3 → dist root (matches worker-pool.ts `join(__dirname, '..')`).
  return join(here, '..', '..');
}

/** Identify hard links and resolve symlinks even when the target log is still missing. */
function logFileKey(path: string, remainingLinks = 40): string {
  const absolute = resolvePath(path);
  try {
    const file = statSync(absolute, { throwIfNoEntry: false });
    if (file) return `${file.dev}:${file.ino}`;
    if (remainingLinks > 0 && lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return logFileKey(resolvePath(dirname(absolute), readlinkSync(absolute)), remainingLinks - 1);
    }
    return join(logFileKey(dirname(absolute), remainingLinks), basename(absolute));
  } catch {
    // Unreadable diagnostics keep the writer's existing best-effort I/O behavior.
    return absolute;
  }
}

function stdoutPath(req: RunNodeRequest): string {
  return req.stdoutPath ?? join(req.attemptDir, 'stdout.log');
}

function stderrPath(req: RunNodeRequest): string {
  return req.stderrPath ?? join(req.attemptDir, 'stderr.log');
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
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
