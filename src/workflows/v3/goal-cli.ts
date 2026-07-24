/**
 * `botmux goal run` — a small, daemon-free product entrypoint for one real
 * headless goal. It deliberately reuses the v3 run envelope, journal, drive
 * lease, worker fence, ephemeral pool, and manifest validator. There is no
 * second scheduler or mutable result store here.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { withFileLock } from '../../utils/file-lock.js';
import { expandHomePath } from '../../utils/working-dir.js';
import { validateDag, MAX_NODE_TIMEOUT_SEC, type V3Dag } from './dag.js';
import { v3DriveLeaseTarget } from './drive-lease.js';
import { createEphemeralPool } from './ephemeral-pool.js';
import { readJournal, type StoredEvent } from './journal.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import { runWorkflow, type V3RuntimeDeps } from './runtime.js';
import { materialize, type V3RunStatus } from './state.js';
import {
  botToSnapshot,
  resolveBotConfig,
} from './bot-resolve.js';
import {
  authorizeManualCliRun,
  defaultBaseDir,
} from './cli-run.js';
import { readRunEnvelope, RunEnvelopeConflictError } from './run-envelope.js';
import type {
  BotSnapshot,
  Manifest,
  ManifestFile,
  RunNode,
  ValidateManifest,
} from './contract.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../hostExecutors/registry.js';

export const GOAL_RUN_REQUEST_SCHEMA = 'botmux.goal-run-request/v1' as const;
export const GOAL_RUN_RESULT_SCHEMA = 'botmux.goal-run-result/v1' as const;

export const GOAL_RUN_EXIT = {
  succeeded: 0,
  failed: 10,
  blocked: 11,
  cancelled: 12,
  conflict: 13,
  error: 14,
} as const;

const GOAL_NODE_ID = 'goal';
const DRIVE_LOCK_RECOVERY_WAIT_MS = 1_200;

interface GoalRunArgs {
  goal: string;
  runId: string;
  botSelector?: string;
  workingDir?: string;
  baseDir: string;
  timeoutMs?: number;
  json: boolean;
}

interface GoalRunRequestV1 {
  schemaVersion: typeof GOAL_RUN_REQUEST_SCHEMA;
  goal: string;
  /** Invocation intent, not live config. The pinned DAG/bot snapshot holds the
   * resolved identity; keeping these exact CLI inputs makes re-drive
   * reproducible even when bots.json changes after a crash. */
  botSelector: string | null;
  workingDir: string | null;
  timeoutMs: number | null;
}

export type GoalRunTerminalState = 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface GoalRunResultV1 {
  schemaVersion: typeof GOAL_RUN_RESULT_SCHEMA;
  runId: string | null;
  state: GoalRunTerminalState | 'conflict' | 'error';
  exitCode: number;
  summary?: string;
  error?: { code: string; message: string };
  artifacts?: ManifestFile[];
  runDirectory?: {
    path: string;
    stability: 'informative-only';
  };
}

interface SignalEmitter {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface GoalCliDependencies {
  loadBots: () => BotConfig[];
  makeRunNode: (bots: BotConfig[]) => RunNode;
  validateManifest: ValidateManifest;
  readValidatedManifest: typeof readAndValidateManifest;
  signalEmitter: SignalEmitter;
  now: () => Date;
  newRunId: () => string;
  stdout: Pick<NodeJS.WriteStream, 'write'> & { fd?: number };
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

function defaultDependencies(): GoalCliDependencies {
  return {
    loadBots: loadBotConfigs,
    makeRunNode: (bots) => {
      const secrets = new Map(bots.map((bot) => [bot.larkAppId, bot.larkAppSecret]));
      return createEphemeralPool({
        resolveLarkAppSecret: (larkAppId) => secrets.get(larkAppId),
      }).runNode;
    },
    validateManifest: async (manifestPath, outputDir) => {
      try {
        const manifest = await readAndValidateManifest(manifestPath, outputDir);
        return { ok: true, manifest };
      } catch (error) {
        return {
          ok: false,
          problems: error instanceof ManifestValidationError ? error.problems : [String(error)],
        };
      }
    },
    readValidatedManifest: readAndValidateManifest,
    signalEmitter: process,
    now: () => new Date(),
    newRunId: () => `goal-${Date.now()}-${randomUUID().slice(0, 8)}`,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function valueFor(args: string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === flag) return args[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function parsePositiveSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds (got ${JSON.stringify(raw)})`);
  }
  // Leave a small cushion above the outer cancellation deadline so timeout is
  // represented as durable run cancellation, not a racing node timeout.
  if (seconds > MAX_NODE_TIMEOUT_SEC - 30) {
    throw new Error(`--timeout must be <= ${MAX_NODE_TIMEOUT_SEC - 30} seconds`);
  }
  return Math.ceil(seconds * 1_000);
}

function parseArgs(rest: string[], deps: GoalCliDependencies): GoalRunArgs {
  const flagsWithValues = new Set([
    '--run-id', '--bot', '--working-dir', '--base-dir', '--goal-file', '--timeout',
  ]);
  const knownFlags = new Set([...flagsWithValues, '--stdin', '--json', '--help', '-h']);
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (flagsWithValues.has(arg)) {
      if (index + 1 >= rest.length || rest[index + 1]!.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index++;
      continue;
    }
    if ([...flagsWithValues].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (arg.startsWith('-')) {
      if (!knownFlags.has(arg)) throw new Error(`unknown option: ${arg}`);
      continue;
    }
    positionals.push(arg);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    throw new Error(
      'usage: botmux goal run <goal> [--run-id <id>] [--bot <id|name>] [--working-dir <dir>] [--timeout <seconds>] [--json]\n' +
      '       botmux goal run --goal-file <path> | --stdin [...options]',
    );
  }

  const goalFile = valueFor(rest, '--goal-file');
  const useStdin = rest.includes('--stdin');
  const sources = Number(positionals.length > 0) + Number(goalFile !== undefined) + Number(useStdin);
  if (sources !== 1 || positionals.length > 1) {
    throw new Error('provide exactly one goal source: a positional goal, --goal-file <path>, or --stdin');
  }
  const rawGoal = goalFile !== undefined
    ? readFileSync(resolve(goalFile), 'utf8')
    : useStdin
      ? readFileSync(0, 'utf8')
      : positionals[0]!;
  const goal = rawGoal.trim();
  if (!goal) throw new Error('goal must not be empty');

  return {
    goal,
    runId: valueFor(rest, '--run-id') ?? deps.newRunId(),
    botSelector: valueFor(rest, '--bot'),
    workingDir: valueFor(rest, '--working-dir')
      ? resolve(expandHomePath(valueFor(rest, '--working-dir')!))
      : undefined,
    baseDir: valueFor(rest, '--base-dir') ? resolve(valueFor(rest, '--base-dir')!) : defaultBaseDir(),
    timeoutMs: parsePositiveSeconds(valueFor(rest, '--timeout')),
    json: rest.includes('--json'),
  };
}

function requestBytes(request: GoalRunRequestV1): string {
  // Fixed key insertion order is the v1 canonical encoding. Exact bytes are
  // pinned by run.json and compared on every attach.
  return `${JSON.stringify(request)}\n`;
}

function exitCodeFor(state: GoalRunTerminalState): number {
  return GOAL_RUN_EXIT[state];
}

function terminalStatus(status: V3RunStatus): status is GoalRunTerminalState {
  return status === 'succeeded' || status === 'failed' || status === 'blocked' || status === 'cancelled';
}

function latestNodeSettle(events: StoredEvent[]): Extract<StoredEvent,
  { type: 'nodeSucceeded' | 'nodeFailed' | 'nodeBlocked' }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'nodeSucceeded' || event.type === 'nodeFailed' || event.type === 'nodeBlocked') {
      return event;
    }
  }
  return undefined;
}

async function validatedManifestForTerminal(
  runDir: string,
  events: StoredEvent[],
  deps: GoalCliDependencies,
): Promise<Manifest | undefined> {
  const settle = latestNodeSettle(events);
  if (!settle) return undefined;
  const manifestPath = settle.type === 'nodeSucceeded'
    ? settle.manifestPath
    : join(runDir, settle.attemptId, 'manifest.json');
  try {
    return await deps.readValidatedManifest(manifestPath, join(dirname(manifestPath), 'work'));
  } catch {
    // A terminal result never publishes unvalidated paths. The journal's
    // terminal state/error remains reportable even when no valid manifest was
    // produced (worker crash, malformed output, or later disk damage).
    return undefined;
  }
}

export async function projectGoalRunTerminal(
  runId: string,
  runDir: string,
  deps: GoalCliDependencies,
): Promise<GoalRunResultV1 | undefined> {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const snapshot = materialize(events);
  if (!terminalStatus(snapshot.runStatus)) return undefined;

  const manifest = await validatedManifestForTerminal(runDir, events, deps);
  const settle = latestNodeSettle(events);
  const error = settle && (settle.type === 'nodeFailed' || settle.type === 'nodeBlocked')
    ? {
        code: settle.errorCode ?? settle.errorClass,
        message: settle.message ?? `${settle.type === 'nodeBlocked' ? 'goal blocked' : 'goal failed'} (${settle.errorClass})`,
      }
    : undefined;
  return {
    schemaVersion: GOAL_RUN_RESULT_SCHEMA,
    runId,
    state: snapshot.runStatus,
    exitCode: exitCodeFor(snapshot.runStatus),
    ...(manifest?.summary ? { summary: manifest.summary } : {}),
    ...(error ? { error } : {}),
    ...(manifest?.files.length ? { artifacts: manifest.files } : {}),
    runDirectory: { path: runDir, stability: 'informative-only' },
  };
}

function errorResult(
  state: 'conflict' | 'error',
  code: string,
  message: string,
  runId: string | null,
  runDir?: string,
): GoalRunResultV1 {
  return {
    schemaVersion: GOAL_RUN_RESULT_SCHEMA,
    runId,
    state,
    exitCode: GOAL_RUN_EXIT[state],
    error: { code, message },
    ...(runDir ? { runDirectory: { path: runDir, stability: 'informative-only' } } : {}),
  };
}

function emitResult(result: GoalRunResultV1, json: boolean, deps: GoalCliDependencies): void {
  if (json) {
    const bytes = `${JSON.stringify(result)}\n`;
    // One synchronous terminal write: journal terminal publication always
    // happens before this acknowledgement, and the process cannot exit 0
    // while a queued stdout write is still pending.
    if (typeof deps.stdout.fd === 'number') writeFileSync(deps.stdout.fd, bytes);
    else deps.stdout.write(bytes);
    return;
  }
  const line = result.state === 'succeeded'
    ? `Goal succeeded (${result.runId})${result.summary ? `: ${result.summary}` : ''}\n`
    : `Goal ${result.state} (${result.runId ?? 'unassigned'}): ${result.error?.message ?? result.summary ?? ''}\n`;
  (result.state === 'succeeded' ? deps.stdout : deps.stderr).write(line);
}

function buildGoalDag(args: GoalRunArgs, resolvedBotId?: string): V3Dag {
  return validateDag({
    runId: args.runId,
    nodes: [{
      id: GOAL_NODE_ID,
      type: 'goal',
      goal: args.goal,
      ...(resolvedBotId ? { bot: resolvedBotId } : {}),
      depends: [],
      inputs: [],
      humanGate: null,
      ...(args.timeoutMs !== undefined
        ? { timeoutSec: Math.ceil(args.timeoutMs / 1_000) + 30 }
        : {}),
    }],
  });
}

async function executeGoalRun(args: GoalRunArgs, deps: GoalCliDependencies): Promise<GoalRunResultV1> {
  // Install cancellation delivery before publishing any run artifacts. A
  // signal/timeout that arrives during authorization is remembered and becomes
  // the runtime's durable cancellation cut as soon as the journal starts.
  const abortController = new AbortController();
  const abort = (): void => {
    if (!abortController.signal.aborted) abortController.abort('goal-cli');
  };
  deps.signalEmitter.on('SIGINT', abort);
  deps.signalEmitter.on('SIGTERM', abort);
  const timeout = args.timeoutMs === undefined ? undefined : setTimeout(abort, args.timeoutMs);
  try {
    return await executeGoalRunCore(args, deps, abortController.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    deps.signalEmitter.off('SIGINT', abort);
    deps.signalEmitter.off('SIGTERM', abort);
  }
}

async function executeGoalRunCore(
  args: GoalRunArgs,
  deps: GoalCliDependencies,
  cancelSignal: AbortSignal,
): Promise<GoalRunResultV1> {
  const runDir = join(args.baseDir, args.runId);
  const request: GoalRunRequestV1 = {
    schemaVersion: GOAL_RUN_REQUEST_SCHEMA,
    goal: args.goal,
    botSelector: args.botSelector ?? null,
    workingDir: args.workingDir ?? null,
    timeoutMs: args.timeoutMs ?? null,
  };

  let dag: V3Dag;
  let frozenBotSnapshots: Map<string, BotSnapshot>;
  let bots: BotConfig[] | undefined;
  const envelope = readRunEnvelope(runDir, args.runId);
  if (envelope.kind === 'invalid') {
    return errorResult(
      'error',
      'RUN_AUTHORIZATION_FAILED',
      `run.json is invalid: ${envelope.problems.join('; ')}`,
      args.runId,
      runDir,
    );
  }
  if (envelope.kind === 'ok') {
    try {
      // Existing authorization supplies the real DAG and frozen bot snapshot;
      // the candidate is used only for its validated runId.
      const authorization = authorizeManualCliRun({
        runDir,
        dag: buildGoalDag(args),
        bots: [],
        goalRequestBytes: requestBytes(request),
      });
      dag = authorization.dag;
      frozenBotSnapshots = authorization.frozenBotSnapshots;
    } catch (error) {
      const conflict = error instanceof RunEnvelopeConflictError;
      return errorResult(
        conflict ? 'conflict' : 'error',
        conflict ? 'RUN_ID_CONFLICT' : 'RUN_AUTHORIZATION_FAILED',
        error instanceof Error ? error.message : String(error),
        args.runId,
        runDir,
      );
    }

    // A durable terminal is fully self-contained: replay it even when live
    // bots.json is missing or has changed since the original execution.
    const terminal = await projectGoalRunTerminal(args.runId, runDir, deps);
    if (terminal) return terminal;
  } else {
    try {
      bots = deps.loadBots();
    } catch (error) {
      return errorResult('error', 'BOTS_CONFIG_UNREADABLE', error instanceof Error ? error.message : String(error), args.runId, runDir);
    }
    if (bots.length === 0) {
      return errorResult('error', 'NO_BOTS_CONFIGURED', 'no bots configured; run `botmux setup` first', args.runId, runDir);
    }
    try {
      const bot = resolveBotConfig(args.botSelector, bots);
      const unresolvedSnapshot = botToSnapshot(bot, args.workingDir);
      // `child_process.fork({cwd})` interprets a relative cwd against the
      // current driver process. Freeze an absolute path so a crash re-drive
      // launched from another shell cannot silently execute in another repo.
      const snapshot: BotSnapshot = {
        ...unresolvedSnapshot,
        workingDir: resolve(expandHomePath(unresolvedSnapshot.workingDir)),
      };
      dag = buildGoalDag(args, bot.larkAppId);
      const authorization = authorizeManualCliRun({
        runDir,
        dag,
        bots,
        defaultBotSelector: bot.larkAppId,
        workingDirOverride: snapshot.workingDir,
        now: deps.now(),
        goalRequestBytes: requestBytes(request),
      });
      dag = authorization.dag;
      frozenBotSnapshots = authorization.frozenBotSnapshots;
    } catch (error) {
      const conflict = error instanceof RunEnvelopeConflictError;
      return errorResult(
        conflict ? 'conflict' : 'error',
        conflict ? 'RUN_ID_CONFLICT' : 'RUN_AUTHORIZATION_FAILED',
        error instanceof Error ? error.message : String(error),
        args.runId,
        runDir,
      );
    }
  }

  // Non-terminal replay still needs live credentials to spawn/recover a
  // worker, but never re-resolves its frozen bot/cwd/model/sandbox settings.
  if (!bots) {
    try {
      bots = deps.loadBots();
    } catch (error) {
      return errorResult('error', 'BOTS_CONFIG_UNREADABLE', error instanceof Error ? error.message : String(error), args.runId, runDir);
    }
  }
  if (bots.length === 0) {
    return errorResult('error', 'NO_BOTS_CONFIGURED', 'no bots configured; cannot re-drive a non-terminal run', args.runId, runDir);
  }
  const firstSnapshot = frozenBotSnapshots.values().next().value as BotSnapshot | undefined;
  if (!firstSnapshot) {
    return errorResult('error', 'RUN_AUTHORIZATION_FAILED', 'bots.snapshot.json contains no frozen bot', args.runId, runDir);
  }
  const resolveFrozenSnapshot = (selector: string | undefined): BotSnapshot =>
    frozenBotSnapshots.get(selector ?? '')
    ?? [...frozenBotSnapshots.values()].find((candidate) => candidate.larkAppId === selector)
    ?? firstSnapshot;

  let runtimeDeps: V3RuntimeDeps;
  try {
    runtimeDeps = {
      runNode: deps.makeRunNode(bots),
      validateManifest: deps.validateManifest,
      resolveBotSnapshot: resolveFrozenSnapshot,
      hostExecutors: createDefaultHostExecutorRegistry(),
      hostReconcilers: createDefaultProviderReconcilers(),
    };
  } catch (error) {
    return errorResult('error', 'RUNNER_INIT_FAILED', error instanceof Error ? error.message : String(error), args.runId, runDir);
  }

  try {
    await withFileLock(
      v3DriveLeaseTarget(args.baseDir, dag.runId),
      () => runWorkflow(dag, runtimeDeps, {
        baseDir: args.baseDir,
        authorizedArtifacts: true,
        frozenBotSnapshots,
        cancelSignal,
      }),
      { maxWaitMs: DRIVE_LOCK_RECOVERY_WAIT_MS },
    );
  } catch (error) {
    const terminal = await projectGoalRunTerminal(args.runId, runDir, deps);
    if (terminal) return terminal;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('file-lock timeout waiting for')) {
      return errorResult('conflict', 'RUN_ACTIVE', `run "${args.runId}" is being driven by another live process`, args.runId, runDir);
    }
    return errorResult('error', 'RUN_DRIVER_FAILED', message, args.runId, runDir);
  }

  return await projectGoalRunTerminal(args.runId, runDir, deps)
    ?? errorResult('error', 'TERMINAL_RESULT_MISSING', 'driver returned before a durable terminal journal event existed', args.runId, runDir);
}

/** Dispatcher for `botmux goal <sub>`. Returns an exit code; never calls exit. */
export async function cmdGoal(
  sub: string,
  rest: string[],
  overrides: Partial<GoalCliDependencies> = {},
): Promise<number> {
  const deps = { ...defaultDependencies(), ...overrides };
  const json = rest.includes('--json');
  let result: GoalRunResultV1 | undefined;
  if (sub !== 'run') {
    result = errorResult('error', 'USAGE', 'usage: botmux goal run <goal> [options]', null);
  } else {
    let args: GoalRunArgs | undefined;
    try {
      args = parseArgs(rest, deps);
    } catch (error) {
      result = errorResult('error', 'USAGE', error instanceof Error ? error.message : String(error), valueFor(rest, '--run-id') ?? null);
    }
    if (args) {
      try {
        result = await executeGoalRun(args, deps);
      } catch (error) {
        result = errorResult(
          'error',
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : String(error),
          args.runId,
          join(args.baseDir, args.runId),
        );
      }
    }
  }
  result ??= errorResult('error', 'INTERNAL_ERROR', 'goal command produced no result', valueFor(rest, '--run-id') ?? null);
  emitResult(result, json, deps);
  return result.exitCode;
}
