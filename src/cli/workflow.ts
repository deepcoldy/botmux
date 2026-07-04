/**
 * `botmux workflow <sub>` CLI subcommand handlers.
 *
 * v0 offline-runner: load a workflow definition, drive `runLoop` against
 * a stub spawn, and print events to stdout.  No daemon / no IM
 * integration — used for smoke-testing the orchestrator end-to-end.
 *
 * The on-daemon path (with lark fan-out, real worker spawn) lives in
 * the `/workflow run` Skill (Slice E-2).  This module deliberately
 * keeps the CLI route the simplest possible smoke test.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';

import { EventLog } from '../workflows/events/append.js';
import { replay } from '../workflows/events/replay.js';
import { parseWorkflowDefinition } from '../workflows/definition.js';
import { loadWorkflowDefinition } from '../workflows/loader.js';
import {
  coerceWorkflowParams,
  ParamCoerceFailure,
  type RawParamInput,
} from '../workflows/params.js';
import { runLoop } from '../workflows/loop.js';
import { mintWorkflowRunId } from '../workflows/run-id.js';
import { createRun, type BotResolver } from '../workflows/run-init.js';
import { getRunsDir, runDir } from '../workflows/runs-dir.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../workflows/hostExecutors/registry.js';
import { loadEffectInputSidecar } from '../workflows/effect-input.js';
import {
  cancelWorkflowRun,
  isTerminalRunStatus,
} from '../workflows/cancel-run.js';
import {
  createStubSpawnFn,
  type StubSpawnHandler,
} from '../workflows/spawn-bot.js';
import type {
  WorkerSpawnFn,
  WorkflowRuntimeContext,
} from '../workflows/runtime.js';
import {
  eventSeqFromId,
  extractEventContext,
  listRuns,
} from '../workflows/ops-projection.js';

// Local arg parsers — mirror cli.ts shape; deliberately not exported.
function argValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const f of flags) {
      if (a === f && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=') && i + 1 < args.length) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function cmdWorkflow(sub: string, rest: string[]): Promise<void> {
  // v3 grill host-controller verbs route to host.ts (lazy import — keeps the v3
  // ephemeral-pool / worker deps out of the v0.2 workflow path).
  if (['new', 'spec-finalize', 'approve-spec', 'revise-spec', 'architect', 'revise-dag', 'approve-dag'].includes(sub)) {
    const { cmdWorkflowHost } = await import('../workflows/v3/host.js');
    await cmdWorkflowHost(sub, rest);
    return;
  }
  switch (sub) {
    case 'run':
      await cmdWorkflowRun(rest);
      return;
    case 'resume':
      await cmdWorkflowResume(rest);
      return;
    case 'cancel':
      await cmdWorkflowCancel(rest);
      return;
    case 'ls':
    case 'list':
      await cmdWorkflowLs(rest);
      return;
    case 'tail':
      await cmdWorkflowTail(rest);
      return;
    case 'validate':
      await cmdWorkflowValidate(rest);
      return;
    case 'show':
      await cmdWorkflowShow(rest);
      return;
    case 'help':
    case '':
    case undefined:
      printHelp();
      return;
    default:
      console.error(`未知子命令: workflow ${sub}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`用法: botmux workflow <run|resume|cancel|ls|tail|validate|show> [...]

子命令:
  run <id> [--param key=value ...] [--param-json key=<json> ...] [--run-id <id>] [--bot-resolver echo]
      离线驱动 workflow（stub spawn）。事件 / 状态打到 stdout。
      humanGate 节点跑到 'awaiting-wait' 即退出（CLI 离线场景下没有审批入口）。
      --param 适合标量（string/number/boolean）；--param-json 适合 object/array
      或希望严格保留 JSON 类型的值，例如 --param-json users='["a","b"]'。
      未声明的 param 名会被拒；type 不匹配 / 缺 required 会清晰报错。

  resume <runId>
      从磁盘 runDir 冷恢复一个已有 run。R0 recovery 先收 dangling effect，
      之后 orchestrator 继续推进；遇到 humanGate 只输出 awaiting-wait，
      不伪造审批；run 已 terminal 则直接打摘要，零事件写入。
      CLI 不会 spawn 新 subagent —— 现有 in-flight subagent 会被标记
      WorkerCrashed/manual 并由 orchestrator 终结 run。

  cancel <runId> [--reason <text>]
      写入 run-level cancelRequested 并驱动 cancel recovery。terminal run
      直接 no-op；不会发 IM 通知或重发审批卡。

  ls [--all] [--status running,failed,...] [--wide] [--json]
      列出 runsDir 下所有 run。默认仅 non-terminal；--all 全列；--status
      支持逗号多选；--wide 增加 failedNodeId/chatId/larkAppId；--json
      输出完整 JSON 行。

  tail <runId> [--from <seq>] [--follow] [--json]
      打印 run 的事件简表（seq / type / node / activity / errorCode）。
      默认 history-only；--follow 才轮询 events.ndjson 增量。--from 默认 1。

  validate <path>
      校验 workflow.json 文件。成功打印 workflowId / node 数；失败打印
      JSON parse、Zod issue path + message，或 graph invariant 错误。

  show <runId>
      replay 当前 run 的事件，打印 Snapshot 摘要 JSON（含 nodes/dangling 等）。

环境变量:
  BOTMUX_WORKFLOW_RUNS_DIR=<path>  覆盖 runs 根目录（默认 ~/.botmux/workflow-runs）
`);
}

// ─── run ──────────────────────────────────────────────────────────────────

async function cmdWorkflowRun(rest: string[]): Promise<void> {
  const id = positionals(rest)[0];
  if (!id) {
    console.error('用法: botmux workflow run <id> [--param key=value ...] [--param-json key=<json> ...]');
    process.exit(1);
  }
  const runId = argValue(rest, '--run-id') ?? mintWorkflowRunId(id);
  const rawParams = collectRawParams(rest);

  const def = await loadWorkflowDefinition(id).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
  // unreachable after process.exit, but TS doesn't know
  if (!def) return;
  let params: Record<string, unknown>;
  try {
    params = coerceWorkflowParams(def, rawParams);
  } catch (err) {
    if (err instanceof ParamCoerceFailure) {
      console.error('参数校验失败：');
      for (const issue of err.issues) {
        console.error(`- ${issue.message}`);
      }
    } else {
      console.error(`参数校验失败：${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  // Bootstrap the in-memory bot registry so hostExecutors like
  // feishu-send can resolve `larkAppId` → Lark client.  IM path inherits
  // the daemon's already-registered bots; the standalone CLI doesn't.
  try {
    const { registerBot, loadBotConfigs } = await import('../bot-registry.js');
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch {
    // Missing/invalid bots.json is fine — workflows that don't touch
    // Feishu still run; the host executor will surface a clear
    // "Bot not registered" error if one does.
  }

  const log = new EventLog(runId, getRunsDir());
  const botResolver: BotResolver = () => ({});
  const spawnSubagent = createStubSpawnFn(echoHandler);

  console.log(`workflow=${id} runId=${runId} params=${JSON.stringify(params)}`);
  console.log(`runsDir=${getRunsDir()}`);

  await createRun(log, { def, params, initiator: 'cli', botResolver });
  console.log('runCreated, runStarted');

  const ctx: WorkflowRuntimeContext = {
    log,
    def,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
  };
  const result = await runLoop(ctx, { maxTicks: 200 });

  console.log(`\nloop stopped: ${result.reason} after ${result.ticks} tick(s)`);
  console.log(`run.status=${result.lastSnapshot.run.status}`);
  console.log(`events: ${result.lastSnapshot.lastSeq}`);
  if (result.reason === 'awaiting-wait') {
    console.log(`awaiting-wait on: ${result.lastSnapshot.danglingWaits.join(', ')}`);
    console.log(`(CLI 离线模式没有审批入口；从 IM 用 /template run 跑能拿到审批卡)`);
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.output) {
    console.log(`output: ${result.lastSnapshot.run.output.outputHash}`);
  }
}

const echoHandler: StubSpawnHandler = (input) => ({
  echo: input.prompt.slice(0, 200),
  bot: input.botName,
  activityId: input.activityId,
});

// ─── resume ───────────────────────────────────────────────────────────────

/**
 * R1 cold resume — pick up an existing run from its on-disk runDir.
 *
 * Contract (codex-loopy review 2026-05-20):
 *   - Replay first.  If the run is already terminal, print summary and
 *     write zero events.
 *   - Do NOT call `createRun` / write `runStarted` — those are mint-time
 *     events.  Resume just attaches a fresh ctx to the existing log.
 *   - `spawnSubagent` is a no-throw failure stub: returns
 *     `WorkerCrashed/manual` so any subagent dispatch the orchestrator
 *     decides to do during resume lands as a recorded `activityFailed`
 *     (NOT a thrown JS error that would crash the CLI).  manual class
 *     prevents R0 from auto-retrying.
 *   - hostExecutors / reconcilers / loadEffectInput are wired so the
 *     recovery phase can settle dangling side-effects via reconciler.
 *
 * Out of scope for R1: daemon-startup scan, watcher rebuild, real worker
 * reattach, dashboard surface.
 */
async function cmdWorkflowResume(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow resume <runId>');
    process.exit(1);
  }

  const runsDir = getRunsDir();
  const dir = runDir(runId, runsDir);
  const workflowJsonPath = join(dir, 'workflow.json');

  let defRaw: string;
  try {
    defRaw = await fs.readFile(workflowJsonPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`找不到 runDir 的 workflow.json：${workflowJsonPath}`);
      console.error(`(runsDir=${runsDir}；用 BOTMUX_WORKFLOW_RUNS_DIR 覆盖)`);
    } else {
      console.error(`读取 ${workflowJsonPath} 失败：${(err as Error).message}`);
    }
    process.exit(1);
  }

  let def;
  try {
    def = parseWorkflowDefinition(JSON.parse(defRaw!));
  } catch (err) {
    console.error(`解析 ${workflowJsonPath} 失败：${(err as Error).message}`);
    process.exit(1);
    return;
  }

  // Same as run: load bots so feishu host executors can resolve larkAppId.
  try {
    const { registerBot, loadBotConfigs } = await import('../bot-registry.js');
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch {
    // bots.json missing/invalid is fine — workflows that don't touch IM
    // still resume; IM-touching steps will surface a clear error.
  }

  const log = new EventLog(runId, runsDir);
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${runsDir})`);
    process.exit(1);
  }

  const { replay } = await import('../workflows/events/replay.js');
  const initialSnap = replay(events);

  console.log(`workflow=${def!.workflowId} runId=${runId}`);
  console.log(`runsDir=${runsDir}`);

  // ── Terminal short-circuit ────────────────────────────────────────────
  // Per codex review: replay first; if the run already finished, print
  // summary and DON'T enter runLoop (no new events written).
  if (
    initialSnap.run.status === 'succeeded' ||
    initialSnap.run.status === 'failed' ||
    initialSnap.run.status === 'cancelled'
  ) {
    console.log(`\nrun.status=${initialSnap.run.status} (terminal — nothing to resume)`);
    console.log(`events: ${initialSnap.lastSeq}`);
    if (initialSnap.run.output) {
      console.log(`output: ${initialSnap.run.output.outputHash}`);
    }
    if (initialSnap.run.status !== 'succeeded') {
      process.exit(1);
    }
    return;
  }

  const spawnSubagent: WorkerSpawnFn = async (input) => ({
    kind: 'failure',
    errorCode: 'WorkerCrashed',
    errorClass: 'manual',
    errorMessage:
      `subagent '${input.botName}' (node=${input.nodeId}, activity=${input.activityId}) ` +
      `is not resumable via 'botmux workflow resume' — CLI does not spawn workers. ` +
      `Use IM /template run for full execution, or restart the run.`,
  });

  const ctx: WorkflowRuntimeContext = {
    log,
    def: def!,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
  };

  const result = await runLoop(ctx, { maxTicks: 200 });

  console.log(`\nloop stopped: ${result.reason} after ${result.ticks} tick(s)`);
  console.log(`run.status=${result.lastSnapshot.run.status}`);
  console.log(`events: ${result.lastSnapshot.lastSeq}`);
  if (result.reason === 'awaiting-wait') {
    console.log(`awaiting-wait on: ${result.lastSnapshot.danglingWaits.join(', ')}`);
    console.log(`(CLI resume 不发卡；从 IM 用 /template run 进的话审批入口在那边)`);
  }
  if (result.reason === 'no-progress') {
    if (result.lastSnapshot.danglingEffectAttempted.length > 0) {
      console.log(
        `dangling effects: ${result.lastSnapshot.danglingEffectAttempted.join(', ')}`,
      );
    }
    const danglingNonEffect = result.lastSnapshot.danglingActivities.filter(
      (a) => !result.lastSnapshot.danglingEffectAttempted.includes(a),
    );
    if (danglingNonEffect.length > 0) {
      console.log(`dangling activities (non-effect): ${danglingNonEffect.join(', ')}`);
    }
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.output) {
    console.log(`output: ${result.lastSnapshot.run.output.outputHash}`);
  }

  // Non-zero exit when the run did not resolve to a clean terminal/awaiting.
  if (
    result.reason !== 'terminal' &&
    result.reason !== 'awaiting-wait'
  ) {
    process.exit(1);
  }
  if (result.reason === 'terminal' && result.lastSnapshot.run.status !== 'succeeded') {
    process.exit(1);
  }
}

// ─── cancel ───────────────────────────────────────────────────────────────

async function cmdWorkflowCancel(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow cancel <runId> [--reason <text>]');
    process.exit(1);
  }
  const reason = argValue(rest, '--reason') ?? 'cancelled via botmux workflow cancel';
  const runsDir = getRunsDir();
  const log = new EventLog(runId, runsDir);

  const def = await loadRunWorkflowDefinition(runId, runsDir);
  let snapshot = replay(await readExistingRunEvents(log, runsDir, runId));

  console.log(`workflow=${def.workflowId} runId=${runId}`);
  console.log(`runsDir=${runsDir}`);

  if (isTerminalRunStatus(snapshot.run.status)) {
    console.log(`\nrun.status=${snapshot.run.status} (terminal — nothing to cancel)`);
    console.log(`events: ${snapshot.lastSeq}`);
    return;
  }

  const ctx = workflowCliRuntimeContext(log, def, cliResumeSpawnSubagent);
  const result = await cancelWorkflowRun({
    ctx,
    reason,
    by: 'cli',
    actor: 'human',
    maxTicks: 200,
  });
  snapshot = result.snapshot;

  if (result.cancelEventId) {
    console.log(
      result.cancelAlreadyRequested
        ? `cancel already requested: ${result.cancelEventId}`
        : `cancelRequested: ${result.cancelEventId}`,
    );
  }

  console.log(
    `\nloop stopped: ${result.loopResult?.reason ?? 'terminal'} ` +
      `after ${result.loopResult?.ticks ?? 0} tick(s)`,
  );
  console.log(`run.status=${snapshot.run.status}`);
  console.log(`events: ${snapshot.lastSeq}`);
  if (snapshot.danglingCancels.length > 0) {
    console.log(`dangling cancels: ${snapshot.danglingCancels.join(', ')}`);
  }
  if (snapshot.danglingEffectAttempted.length > 0) {
    console.log(`dangling effects: ${snapshot.danglingEffectAttempted.join(', ')}`);
  }
  if (snapshot.danglingWaits.length > 0) {
    console.log(`dangling waits: ${snapshot.danglingWaits.join(', ')}`);
  }

  if (snapshot.run.status !== 'cancelled') {
    process.exit(1);
  }
}

function workflowCliRuntimeContext(
  log: EventLog,
  def: Awaited<ReturnType<typeof loadRunWorkflowDefinition>>,
  spawnSubagent: WorkerSpawnFn,
): WorkflowRuntimeContext {
  return {
    log,
    def,
    spawnSubagent,
    hostExecutors: createDefaultHostExecutorRegistry(),
    reconcilers: createDefaultProviderReconcilers(),
    loadEffectInput: (activityId, attemptId) =>
      loadEffectInputSidecar(log, activityId, attemptId),
  };
}

const cliResumeSpawnSubagent: WorkerSpawnFn = async (input) => ({
  kind: 'failure',
  errorCode: 'WorkerCrashed',
  errorClass: 'manual',
  errorMessage:
    `subagent '${input.botName}' (node=${input.nodeId}, activity=${input.activityId}) ` +
    `is not resumable via 'botmux workflow resume' — CLI does not spawn workers. ` +
    `Use IM /template run for full execution, or restart the run.`,
});

async function loadRunWorkflowDefinition(
  runId: string,
  runsDir = getRunsDir(),
): Promise<Awaited<ReturnType<typeof loadWorkflowDefinition>>> {
  const workflowJsonPath = join(runDir(runId, runsDir), 'workflow.json');
  let defRaw: string;
  try {
    defRaw = await fs.readFile(workflowJsonPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`找不到 runDir 的 workflow.json：${workflowJsonPath}`);
      console.error(`(runsDir=${runsDir}；用 BOTMUX_WORKFLOW_RUNS_DIR 覆盖)`);
    } else {
      console.error(`读取 ${workflowJsonPath} 失败：${(err as Error).message}`);
    }
    process.exit(1);
  }

  try {
    return parseWorkflowDefinition(JSON.parse(defRaw!));
  } catch (err) {
    console.error(`解析 ${workflowJsonPath} 失败：${(err as Error).message}`);
    process.exit(1);
  }
}

async function readExistingRunEvents(
  log: EventLog,
  runsDir: string,
  runId: string,
) {
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${runsDir})`);
    process.exit(1);
  }
  return events;
}

/**
 * Parse CLI args into raw param inputs.  Each `--param key=value` carries a
 * plain string (type coercion happens in `coerceWorkflowParams` against the
 * workflow's `params` schema); each `--param-json key=<json>` carries a
 * parsed JSON value, which is the only way to thread `object` / `array`
 * params (or numbers / booleans you'd rather not stringify) into a run.
 *
 * Both flags accept the `--flag value` and `--flag=value` forms.
 */
function collectRawParams(rest: string[]): Record<string, RawParamInput> {
  const out: Record<string, RawParamInput> = {};
  const ingestStringKV = (kv: string): void => {
    const eq = kv.indexOf('=');
    if (eq <= 0) {
      console.error(`--param 期望 key=value，收到 "${kv}"`);
      process.exit(1);
    }
    out[kv.slice(0, eq)] = { kind: 'string', value: kv.slice(eq + 1) };
  };
  const ingestJsonKV = (kv: string): void => {
    const eq = kv.indexOf('=');
    if (eq <= 0) {
      console.error(`--param-json 期望 key=<json>，收到 "${kv}"`);
      process.exit(1);
    }
    const key = kv.slice(0, eq);
    const jsonText = kv.slice(eq + 1);
    try {
      out[key] = { kind: 'json', value: JSON.parse(jsonText) };
    } catch (err) {
      console.error(
        `--param-json ${key} 的 JSON 解析失败：` +
          (err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  };

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--param' && i + 1 < rest.length) {
      ingestStringKV(rest[i + 1]!);
      i++;
    } else if (rest[i]?.startsWith('--param=')) {
      ingestStringKV(rest[i]!.slice('--param='.length));
    } else if (rest[i] === '--param-json' && i + 1 < rest.length) {
      ingestJsonKV(rest[i + 1]!);
      i++;
    } else if (rest[i]?.startsWith('--param-json=')) {
      ingestJsonKV(rest[i]!.slice('--param-json='.length));
    }
  }
  return out;
}

// ─── validate ─────────────────────────────────────────────────────────────

async function cmdWorkflowValidate(rest: string[]): Promise<void> {
  const path = positionals(rest)[0];
  if (!path) {
    console.error('用法: botmux workflow validate <path>');
    process.exit(1);
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(path, 'utf-8');
  } catch (err) {
    console.error(`读取 ${path} 失败：${(err as Error).message}`);
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText!);
  } catch (err) {
    console.error(`解析 JSON 失败：${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const def = parseWorkflowDefinition(raw);
    console.log(
      `workflow valid: ${def.workflowId} ` +
        `(version=${def.version}, nodes=${Object.keys(def.nodes).length})`,
    );
  } catch (err) {
    console.error(`workflow invalid: ${path}`);
    if (err instanceof ZodError) {
      for (const issue of err.issues) {
        const p = issue.path.length ? issue.path.join('.') : '<root>';
        console.error(`- ${p}: ${issue.message}`);
      }
    } else {
      console.error(`- ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

// ─── ls ───────────────────────────────────────────────────────────────────

/**
 * `botmux workflow ls` — operator surface for "what's running on disk?"
 *
 * Read-only: walks runsDir/<runId>/events.ndjson, replays each, projects a
 * row.  By default lists only non-terminal runs (the typical operator
 * question: "what's still hot?").  Terminal runs are useful for triage
 * and stay one `--all` flag away.
 *
 * Output:
 *   - default: aligned table on stdout.  Column set tuned to fit ~120
 *     cols: runId | workflowId | status | lastSeq | dEf/dAct/dWait | updatedAt
 *   - `--wide`: appends failedNodeId / chatId / larkAppId.
 *   - `--json`: one JSON object per line (machine-parseable).
 *
 * Filters:
 *   - `--all`: include terminal (succeeded/failed/cancelled).
 *   - `--status running,failed`: comma-separated set; overrides `--all`.
 */
async function cmdWorkflowLs(rest: string[]): Promise<void> {
  const all = rest.includes('--all');
  const wide = rest.includes('--wide');
  const json = rest.includes('--json');
  const statusFilter = argValue(rest, '--status');
  const wantStatuses = statusFilter
    ? new Set(statusFilter.split(',').map((s) => s.trim()).filter(Boolean))
    : undefined;

  const runsDir = getRunsDir();
  let rows;
  try {
    rows = await listRuns(runsDir, {
      all,
      statuses: wantStatuses,
      // chat-binding columns are only printed in --wide or --json; skip the
      // extra fs op otherwise.
      includeBinding: wide || json,
    });
  } catch (err) {
    console.error(`读取 ${runsDir} 失败：${(err as Error).message}`);
    process.exit(1);
  }

  if (json) {
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }

  if (rows.length === 0) {
    console.log('(no runs match)');
    return;
  }

  const headers = wide
    ? ['RUN_ID', 'WORKFLOW', 'STATUS', 'LAST_SEQ', 'dEf/dAct/dWait', 'UPDATED', 'FAILED_NODE', 'CHAT_ID', 'LARK_APP']
    : ['RUN_ID', 'WORKFLOW', 'STATUS', 'LAST_SEQ', 'dEf/dAct/dWait', 'UPDATED'];

  const rowCells = rows.map((r) => {
    const dangling = `${r.dEf}/${r.dAct}/${r.dWait}`;
    const updated = new Date(r.updatedAt).toISOString().slice(0, 19).replace('T', ' ');
    const base = [r.runId, r.workflowId, r.status, String(r.lastSeq), dangling, updated];
    if (!wide) return base;
    return [...base, r.failedNodeId ?? '-', r.chatId ?? '-', r.larkAppId ?? '-'];
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rowCells.map((row) => row[i]!.length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(w - s.length);
  console.log(headers.map((h, i) => pad(h, widths[i]!)).join('  '));
  for (const cells of rowCells) {
    console.log(cells.map((c, i) => pad(c, widths[i]!)).join('  '));
  }
}

// ─── tail ─────────────────────────────────────────────────────────────────

/**
 * `botmux workflow tail <runId>` — operator surface for "show me the
 * event stream of this run".
 *
 * Default mode is history-only (codex review 2026-05-20): print every
 * event from `--from` (default 1) and exit.  CLI defaults that hang are
 * a footgun for scripts and tests — `--follow` is the opt-in that turns
 * on the watch loop.
 *
 * Follow strategy: poll `fs.stat` on the events.ndjson file at 200ms
 * cadence and incrementally read new bytes from the recorded offset.
 * NDJSON makes the boundary handling trivial — we only emit on `\n`.
 * Truncation / rotation isn't supported here (events.ndjson is
 * append-only by design); if the file shrinks we surface a warning.
 */
async function cmdWorkflowTail(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow tail <runId> [--from <seq>] [--follow] [--json]');
    process.exit(1);
  }
  const fromArg = argValue(rest, '--from');
  const fromSeq = fromArg ? Number(fromArg) : 1;
  if (!Number.isFinite(fromSeq) || fromSeq < 1) {
    console.error(`--from 必须是 >=1 的整数，收到 "${fromArg}"`);
    process.exit(1);
  }
  const follow = rest.includes('--follow') || rest.includes('-f');
  const json = rest.includes('--json');

  const runsDir = getRunsDir();
  const eventsPath = join(runsDir, runId, 'events.ndjson');
  const log = new EventLog(runId, runsDir);

  // Capture the watch starting offset BEFORE readAll so that any event
  // appended between readAll and the first stat is still picked up by
  // the watch loop (lastSeq dedups any overlap).  Codex review (O1
  // medium #1): if we stat AFTER readAll, a race-window event lands
  // past readAll's view but inside the offset, and follow silently
  // skips it forever.
  let followOffset = 0;
  if (follow) {
    try {
      followOffset = (await fs.stat(eventsPath)).size;
    } catch {
      // events.ndjson must exist if readAll below succeeds; defensive
      // fallback keeps offset 0 so the watch re-reads the whole file
      // and lastSeq still dedups.
      followOffset = 0;
    }
  }

  let initial;
  try {
    initial = await log.readAll();
  } catch (err) {
    console.error(`读取 ${eventsPath} 失败：${(err as Error).message}`);
    process.exit(1);
  }
  if (initial!.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${runsDir})`);
    process.exit(1);
  }

  for (const ev of initial!) {
    const seq = eventSeqFromId(ev.eventId);
    if (seq < fromSeq) continue;
    printEventLine(ev, json);
  }

  if (!follow) return;

  // Watch loop.  Resume from `followOffset` (captured pre-readAll); parse
  // incrementally by line.  Stop on Ctrl-C; until then we never resolve.
  let offset = followOffset;
  let lastSeq = eventSeqFromId(initial![initial!.length - 1]!.eventId);
  let buffer = '';

  process.on('SIGINT', () => process.exit(0));

  while (true) {
    await new Promise((r) => setTimeout(r, 200));
    const stat = await fs.stat(eventsPath).catch(() => null);
    if (!stat) continue;
    if (stat.size < offset) {
      console.error(`(events.ndjson 大小回退 ${offset} → ${stat.size}，停止 tail)`);
      return;
    }
    if (stat.size === offset) continue;
    const fd = await fs.open(eventsPath, 'r');
    try {
      const chunk = Buffer.alloc(stat.size - offset);
      await fd.read(chunk, 0, chunk.length, offset);
      offset = stat.size;
      buffer += chunk.toString('utf-8');
    } finally {
      await fd.close();
    }
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: { eventId?: unknown } | undefined;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof ev?.eventId !== 'string') continue;
      const seq = eventSeqFromId(ev.eventId);
      if (seq <= lastSeq) continue;
      lastSeq = seq;
      if (seq < fromSeq) continue;
      printEventLine(ev, json);
    }
  }
}

function printEventLine(ev: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(ev));
    return;
  }
  const e = ev as {
    eventId: string;
    type: string;
    payload?: Record<string, unknown> | { ref: string };
  };
  const seq = String(eventSeqFromId(e.eventId)).padStart(4);
  const type = e.type.padEnd(22);
  const ctx = extractEventContext(e.payload);
  const parts: string[] = [];
  if (ctx.nodeId) parts.push('node=' + ctx.nodeId);
  if (ctx.activityId) parts.push('act=' + ctx.activityId);
  const where = parts.join(' ');
  const err = ctx.errorCode ? ' err=' + ctx.errorCode : '';
  console.log(seq + '  ' + type + '  ' + where + err);
}

// ─── show ─────────────────────────────────────────────────────────────────

async function cmdWorkflowShow(rest: string[]): Promise<void> {
  const runId = positionals(rest)[0];
  if (!runId) {
    console.error('用法: botmux workflow show <runId>');
    process.exit(1);
  }
  const { replay } = await import('../workflows/events/replay.js');
  const log = new EventLog(runId, getRunsDir());
  const events = await log.readAll();
  if (events.length === 0) {
    console.error(`runId=${runId} 没找到任何事件 (runsDir=${getRunsDir()})`);
    process.exit(1);
  }
  const snap = replay(events);
  console.log(JSON.stringify(
    {
      runId,
      workflowId: snap.run.workflowId,
      revisionId: snap.run.revisionId,
      status: snap.run.status,
      lastSeq: snap.lastSeq,
      nodes: [...snap.nodes.entries()].map(([id, n]) => ({
        id,
        status: n.status,
        retryCount: n.retryCount,
      })),
      danglingActivities: snap.danglingActivities,
      danglingWaits: snap.danglingWaits,
    },
    null,
    2,
  ));
  // `parseWorkflowDefinition` re-exported here only so the bundler keeps it
  // alongside loader (some smoke tests dlopen the helpers directly).
  void parseWorkflowDefinition;
}
