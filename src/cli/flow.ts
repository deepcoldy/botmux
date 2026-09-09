/**
 * `botmux flow …`：JS-as-runtime 编排的终端入口（设计文档 §4.1、§11 M1）。
 *
 *   flow run <script.mjs> [--input '<json>' | --input-file <f>] [--cli-path <cli>=<path>]… [--model <m>]
 *            [--concurrency N] [--cwd <dir>] [--require-containment] [--unsafe-no-container]
 *            [--follow] [--foreground]
 *   flow resume <runId> [--accept-journal] [--assume-clean] [--retry-uncertain] [--follow] [--foreground]
 *   flow inspect <runId> [--json]
 *   flow ls [--json]
 *   flow cancel <runId>
 *   flow decide <runId> <identity> --attempt <n> (--accept-failed | --retry)
 *   flow decide <runId> (--accept-journal | --assume-clean)
 *   flow signal <runId> <identity> --payload '<json>' [--version N]     （§7.4 终端入口）
 *   flow resend <runId> <identity>                                      （信号卡重发，version+1）
 *   flow check-replay <runId> [--json]
 *
 * runner 默认 detached 启动（run 常驻不依赖终端）；`--foreground` 在本进程内跑（调试与测试）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { controlSocketPath, flowRunsDir, flowSlotsFile } from '../flow/paths.js';
import { checkReplay } from '../flow/check-replay.js';
import { decisionKey, loadJournal, type Projection } from '../flow/journal.js';
import { readLeaseUnlocked, holderAlive } from '../flow/ownership.js';
import { FlowRunner, readRunJson, resolveFlowEntry, type RunnerOptions } from '../flow/runner.js';
import { assertScriptLint, ScriptLintError } from '../flow/script-lint.js';
import { DEFAULT_RUN_LIMITS, type ControlRequest, type ControlResponse, type FlowExecutor, type RunBinding, type RunLimits } from '../flow/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FLOW_USAGE = `Usage:
  botmux flow run <script.mjs> [--input '<json>'|--input-file <f>] [--executor bot|pty] [--model <m>]
                  [--concurrency N] [--cwd <dir>] [--max-duration-min N] [--max-resident-runs N]
                  [--cli-path <cli>=<path>]... [--require-containment] [--unsafe-no-container] [--follow] [--foreground]
                  (--executor bot = each agent runs as a headless session on its bot's daemon [default];
                   pty = the runner spawns bare CLIs itself; --cli-path / containment flags apply to pty only)
  botmux flow resume <runId> [--accept-journal] [--assume-clean] [--retry-uncertain] [--follow] [--foreground]
                  (cwd / executor / --cli-path / --model / limits are restored from the run record unless given again)
  botmux flow inspect <runId> [--json]
  botmux flow ls [--json]
  botmux flow cancel <runId>
  botmux flow decide <runId> <identity> --attempt <n> (--accept-failed|--retry)
  botmux flow decide <runId> (--accept-journal|--assume-clean)
  botmux flow signal <runId> <identity> --payload '<json>' [--version N]
  botmux flow resend <runId> <identity>
  botmux flow check-replay <runId> [--json]`;

export { flowRunsDir, flowSlotsFile };

export function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
  multi: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(['--input', '--input-file', '--cli-path', '--model', '--executor', '--concurrency', '--cwd', '--attempt', '--by', '--data-dir', '--dist-dir', '--max-duration-min', '--max-resident-runs', '--payload', '--version']);

export function parseFlowArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const multi = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    let value: string | true = true;
    if (eq !== -1) value = a.slice(eq + 1);
    else if (VALUE_FLAGS.has(name)) {
      value = args[i + 1] ?? '';
      i++;
    }
    if (name === '--cli-path') {
      multi.set(name, [...(multi.get(name) ?? []), String(value)]);
      continue;
    }
    flags.set(name, value);
  }
  return { positionals, flags, multi };
}

function str(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function has(p: ParsedArgs, name: string): boolean {
  return p.flags.has(name);
}

export interface FlowCliDeps {
  dataDir?: string;
  distDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** 前台模式下 runner 的可注入项（测试用）。 */
  runnerOverrides?: Partial<RunnerOptions>;
}

export async function cmdFlow(sub: string, args: string[], deps: FlowCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const p = parseFlowArgs(args);
  const dataDir = str(p, '--data-dir') ?? deps.dataDir ?? config.session.dataDir;
  const distDir = str(p, '--dist-dir') ?? deps.distDir ?? join(__dirname, '..');
  try {
    switch (sub) {
      case 'run':
        return await cmdRun(p, { dataDir, distDir, out, err, overrides: deps.runnerOverrides });
      case 'resume':
        return await cmdResume(p, { dataDir, distDir, out, err, overrides: deps.runnerOverrides });
      case 'inspect':
        return cmdInspect(p, { dataDir, out, err });
      case 'ls':
        return cmdLs(p, { dataDir, out });
      case 'cancel':
        return await cmdControl(p, { dataDir, out, err }, (by) => ({ t: 'cancel', by }));
      case 'decide':
        return await cmdDecide(p, { dataDir, out, err });
      case 'signal':
        return await cmdSignal(p, { dataDir, out, err });
      case 'resend':
        return await cmdResend(p, { dataDir, out, err });
      case 'check-replay':
        return await cmdCheckReplay(p, { dataDir, distDir, out, err });
      case 'help':
      case '':
      case '--help':
        out(FLOW_USAGE);
        return 0;
      default:
        err(`unknown flow subcommand: ${sub}\n${FLOW_USAGE}`);
        return 2;
    }
  } catch (e) {
    err(`flow ${sub}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

interface Ctx {
  dataDir: string;
  distDir?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  overrides?: Partial<RunnerOptions>;
}

function parseLimits(p: ParsedArgs): Partial<RunLimits> {
  const limits: Partial<RunLimits> = {};
  const concurrency = str(p, '--concurrency');
  if (concurrency !== undefined) {
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1) throw new Error('--concurrency must be a positive integer');
    limits.maxConcurrency = n;
  }
  const maxDuration = str(p, '--max-duration-min');
  if (maxDuration !== undefined) {
    const n = Number(maxDuration);
    if (!Number.isFinite(n) || n <= 0) throw new Error('--max-duration-min must be a positive number');
    limits.maxDurationMs = n * 60_000;
  }
  return limits;
}

function parseCliPaths(p: ParsedArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of p.multi.get('--cli-path') ?? []) {
    const eq = item.indexOf('=');
    if (eq === -1) throw new Error(`--cli-path expects <cli>=<path>, got ${JSON.stringify(item)}`);
    out[item.slice(0, eq)] = resolve(item.slice(eq + 1));
  }
  return out;
}

/** 常驻 run 上限（§9）：`paused` / 等待中的 run 各常驻 runner + script host 两个进程。 */
export const DEFAULT_MAX_RESIDENT_RUNS = 8;

/** 统计本数据目录下 lease 持有者仍存活的 run（= 常驻的 runner）。 */
export function countResidentRuns(dataDir: string): { count: number; runIds: string[] } {
  const dir = flowRunsDir(dataDir);
  if (!existsSync(dir)) return { count: 0, runIds: [] };
  const runIds: string[] = [];
  for (const name of readdirSync(dir)) {
    const lease = readLeaseUnlocked(join(dir, name));
    if (lease && holderAlive(lease.holderPid, lease.holderIdentity)) runIds.push(name);
  }
  return { count: runIds.length, runIds };
}

function assertResidentCapacity(p: ParsedArgs, ctx: Ctx): void {
  const raw = str(p, '--max-resident-runs') ?? process.env.BOTMUX_FLOW_MAX_RESIDENT_RUNS;
  const max = raw === undefined ? DEFAULT_MAX_RESIDENT_RUNS : Number(raw);
  if (!Number.isInteger(max) || max < 1) throw new Error('--max-resident-runs must be a positive integer');
  const resident = countResidentRuns(ctx.dataDir);
  if (resident.count >= max) {
    throw new Error(`maxResidentRuns (${max}) reached: ${resident.count} run(s) still have a live runner (${resident.runIds.join(', ')}); finish, cancel or wait for one before starting another`);
  }
}

async function cmdRun(p: ParsedArgs, ctx: Ctx): Promise<number> {
  assertResidentCapacity(p, ctx);
  const scriptArg = p.positionals[0];
  if (!scriptArg) throw new Error(`script path is required\n${FLOW_USAGE}`);
  const scriptPath = resolve(scriptArg);
  const source = readFileSync(scriptPath, 'utf8');
  try {
    assertScriptLint(source);
  } catch (e) {
    if (e instanceof ScriptLintError) {
      ctx.err(e.message);
      return 2;
    }
    throw e;
  }
  let input: unknown = null;
  const inputFile = str(p, '--input-file');
  const inputInline = str(p, '--input');
  if (inputFile !== undefined) input = JSON.parse(readFileSync(resolve(inputFile), 'utf8'));
  else if (inputInline !== undefined) input = JSON.parse(inputInline);

  const runId = newRunId();
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  mkdirSync(runDir, { recursive: true });
  const options: SerializableRunnerOptions = {
    runId,
    runDir,
    mode: 'run',
    script: { path: scriptPath, source },
    input,
    cwd: str(p, '--cwd') ? resolve(str(p, '--cwd')!) : process.cwd(),
    limits: parseLimits(p),
    cliPaths: parseCliPaths(p),
    model: str(p, '--model'),
    executor: parseExecutor(p),
    slotsFile: flowSlotsFile(ctx.dataDir),
    requireContainment: has(p, '--require-containment'),
    unsafeNoContainer: has(p, '--unsafe-no-container'),
    decidedBy: str(p, '--by') ?? 'terminal',
    distDir: ctx.distDir,
  };
  ctx.out(`run ${runId}`);
  ctx.out(`  dir: ${runDir}`);
  return launch(options, p, ctx);
}

async function cmdResume(p: ParsedArgs, ctx: Ctx): Promise<number> {
  const runId = p.positionals[0];
  if (!runId) throw new Error(`runId is required\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  if (!existsSync(runDir)) throw new Error(`run ${runId} not found under ${flowRunsDir(ctx.dataDir)}`);
  assertResidentCapacity(p, ctx);
  const options: SerializableRunnerOptions = {
    runId,
    runDir,
    mode: 'resume',
    // cwd / cliPaths / model / limits 缺省从 run.json 恢复（它们参与 content hash，
    // 换了就等于全部重做）；显式传入才覆盖。
    cwd: str(p, '--cwd') ? resolve(str(p, '--cwd')!) : undefined,
    limits: parseLimits(p),
    cliPaths: parseCliPaths(p),
    model: str(p, '--model'),
    executor: parseExecutor(p),
    slotsFile: flowSlotsFile(ctx.dataDir),
    requireContainment: has(p, '--require-containment'),
    unsafeNoContainer: has(p, '--unsafe-no-container'),
    acceptJournal: has(p, '--accept-journal'),
    assumeClean: has(p, '--assume-clean'),
    retryUncertain: has(p, '--retry-uncertain'),
    decidedBy: str(p, '--by') ?? 'terminal',
    distDir: ctx.distDir,
  };
  return launch(options, p, ctx);
}

type SerializableRunnerOptions = Omit<RunnerOptions, 'spawnScriptHost' | 'spawnAgentWorker' | 'hooks' | 'distDir' | 'botExecutor'> & { distDir?: string };

function parseExecutor(p: ParsedArgs): FlowExecutor | undefined {
  const v = str(p, '--executor');
  if (v === undefined) return undefined;
  if (v === 'bot' || v === 'pty') return v;
  throw new Error(`--executor expects bot or pty, got ${JSON.stringify(v)}`);
}

async function launch(options: SerializableRunnerOptions, p: ParsedArgs, ctx: Ctx): Promise<number> {
  if (has(p, '--foreground')) {
    const runner = new FlowRunner({
      ...options,
      distDir: options.distDir ?? join(__dirname, '..'),
      hooks: { log: (line) => ctx.err(line) },
      ...(ctx.overrides ?? {}),
    });
    const onSignal = () => void runner.interrupt('SIGINT');
    process.once('SIGINT', onSignal);
    try {
      const summary = await runner.run();
      ctx.out(formatSummary(summary));
      return summary.exitCode;
    } finally {
      process.off('SIGINT', onSignal);
    }
  }
  const { command, args } = resolveFlowEntry('flow-runner', options.distDir ?? join(__dirname, '..'));
  const logFd = openSync(join(options.runDir, 'runner.log'), 'a');
  const child = spawn(command, [...args, JSON.stringify(options)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  ctx.out(`  runner pid ${child.pid} (log: ${join(options.runDir, 'runner.log')})`);
  if (!has(p, '--follow')) {
    ctx.out(`  follow with: botmux flow inspect ${options.runId}`);
    return 0;
  }
  return followRun(options.runDir, ctx);
}

async function followRun(runDir: string, ctx: Ctx): Promise<number> {
  let seen = 0;
  for (;;) {
    const loaded = loadJournal(runDir);
    const rows = loaded.raw.rows;
    for (; seen < rows.length; seen++) {
      const row = rows[seen]!;
      switch (row.t) {
        case 'note':
          ctx.out(`  [note] ${row.text}`);
          break;
        case 'started':
          ctx.out(`  [${row.identity}] attempt ${row.attempt} started (${row.botName ? `${row.botName}${row.cli ? ` · ${row.cli}` : ''}` : row.cli ?? row.kind})`);
          break;
        case 'result':
          ctx.out(`  [${row.identity}] attempt ${row.attempt} ok`);
          break;
        case 'failed':
          ctx.out(`  [${row.identity}] attempt ${row.attempt} failed: ${row.category} (${row.retry}/${row.effects}) ${row.error}`);
          break;
        case 'run.error':
          ctx.out(`  [run] error ${row.code}: ${row.error}`);
          break;
        case 'run.takeover':
          ctx.out(`  [run] gen ${row.gen} took over (${row.reason})`);
          break;
        case 'escape':
          ctx.out(`  [run] escaped processes: ${row.pids.join(', ')}`);
          break;
        default:
          break;
      }
    }
    const p = loaded.projection;
    if (p.terminal === 'finished' && p.finished) {
      ctx.out(`run ${p.finished.status} (${p.finished.health}); replay ${p.finished.replay}`);
      if (p.finished.returned !== null) ctx.out(JSON.stringify(p.finished.returned, null, 2));
      return p.finished.status === 'completed' ? 0 : p.finished.status === 'partial' ? 2 : 1;
    }
    if (p.terminal === 'interrupted') {
      ctx.out(`run interrupted (${p.interrupted?.reason}); resume with: botmux flow resume`);
      return 1;
    }
    const lease = readLeaseUnlocked(runDir);
    if (!lease || !holderAlive(lease.holderPid, lease.holderIdentity)) {
      // runner 不在也没写终态：可能刚起、也可能死了；多看几眼
      await new Promise((r) => setTimeout(r, 1_000));
      const again = readLeaseUnlocked(runDir);
      if ((!again || !holderAlive(again.holderPid, again.holderIdentity)) && loadJournal(runDir).projection.terminal === null && rows.length > 0) {
        ctx.out('runner is not alive and the run did not finish; inspect or resume it');
        return 1;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function formatSummary(summary: { runId: string; gen: number; status: string; health: string; counts: { started: number; ok: number; failed: number }; replay: string; returned: unknown }): string {
  const lines = [`run ${summary.runId} gen ${summary.gen}: ${summary.status} (${summary.health}) started ${summary.counts.started} ok ${summary.counts.ok} failed ${summary.counts.failed}; replay ${summary.replay}`];
  if (summary.returned !== null && summary.returned !== undefined) lines.push(JSON.stringify(summary.returned, null, 2));
  return lines.join('\n');
}

export interface InspectReport {
  runId: string;
  gen: number;
  status: string;
  health: string;
  holder: { pid: number; alive: boolean } | null;
  containment: { containment: string; probe: unknown } | null;
  integrity: { dropped: number };
  counts: Projection['counts'];
  activeMs: number;
  cpuMs: number;
  /** `executor`：run.json 记录的执行器（canary.2 之前的 run 没记 → null，实际是 pty）。 */
  executor: string | null;
  attempts: Array<{ identity: string; attempt: number; state: string; phase: string | null; container: string | null; intent: boolean; cli?: string; bot?: string; botName?: string; sessionId?: string; category?: string; retry?: string; effects?: string; error?: string }>;
  pending: Array<{ identity: string; attempt: number; reason: string; error: string }>;
  /** 逻辑 open 的信号等待与其投递状态（§7.3）。 */
  waits: Array<{ identity: string; version: number; state: string; delivery: string | null; messageId: string | null; error: string | null; prompt: string }>;
  binding: { larkAppId: string; chatId: string; rootId: string; trigger?: RunBinding['trigger'] } | null;
  escapes: number[];
  finished: { status: string; health: string; replay: string; returned: unknown } | null;
  errors: Array<{ code: string; error: string }>;
}

export function inspectRun(runDir: string): InspectReport {
  const runJson = readRunJson(runDir);
  const loaded = loadJournal(runDir);
  const p = loaded.projection;
  const lease = readLeaseUnlocked(runDir);
  const holderIsAlive = lease ? holderAlive(lease.holderPid, lease.holderIdentity) : false;
  let status: string;
  if (p.terminal === 'finished' && p.finished) status = p.finished.status;
  else if (p.terminal === 'interrupted') status = 'interrupted';
  else if (!holderIsAlive) status = 'interrupted';
  else status = runJson?.status ?? 'running';
  const attempts = [...p.identities.values()].map((ident) => {
    const a = ident.latest;
    return {
      identity: a.identity,
      attempt: a.attempt,
      state: a.state,
      phase: a.phase,
      container: a.container,
      intent: a.intent !== null,
      ...(a.cli ? { cli: a.cli } : {}),
      ...(a.bot ? { bot: a.bot } : {}),
      ...(a.botName ? { botName: a.botName } : {}),
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.failed ? { category: a.failed.category, retry: a.failed.retry, effects: a.failed.effects, error: a.failed.error } : {}),
    };
  });
  const pending = attempts
    .filter((a) => a.state === 'failed' && !(a.retry === 'auto' && a.effects === 'none') && !p.decisions.has(decisionKey(a.identity, p.identities.get(a.identity)!.latest.content, a.attempt)))
    .map((a) => ({ identity: a.identity, attempt: a.attempt, reason: a.effects === 'uncertain' ? 'uncertain' : 'failed_manual', error: a.error ?? '' }));
  const waits = [...p.waits.values()].map((w) => ({
    identity: w.identity,
    version: w.version,
    state: w.state,
    delivery: w.delivery?.state ?? null,
    messageId: w.delivery?.card?.messageId ?? null,
    error: w.delivery?.error ?? null,
    prompt: w.wait.prompt.length > 120 ? `${w.wait.prompt.slice(0, 120)}…` : w.wait.prompt,
  }));
  const binding = runJson?.binding ?? p.started?.binding ?? null;
  return {
    runId: runJson?.runId ?? p.started?.runId ?? '',
    gen: Math.max(p.gen, runJson?.gen ?? 0),
    status,
    health: p.health,
    holder: lease ? { pid: lease.holderPid, alive: holderIsAlive } : null,
    containment: p.takeovers.length > 0 ? { containment: p.takeovers[p.takeovers.length - 1]!.containment, probe: p.takeovers[p.takeovers.length - 1]!.probe } : p.started ? { containment: p.started.containment, probe: p.started.probe } : null,
    integrity: { dropped: loaded.integrity.dropped.length },
    executor: runJson?.execConfig?.executor ?? null,
    counts: p.counts,
    activeMs: p.activity?.activeMs ?? runJson?.activeMs ?? 0,
    cpuMs: p.activity?.cpuMs ?? runJson?.cpuMs ?? 0,
    attempts,
    pending,
    waits,
    binding: binding ? { larkAppId: binding.larkAppId, chatId: binding.chatId, rootId: binding.rootId, ...(binding.trigger ? { trigger: binding.trigger } : {}) } : null,
    escapes: p.escapes.flatMap((e) => e.pids),
    finished: p.finished ? { status: p.finished.status, health: p.finished.health, replay: p.finished.replay, returned: p.finished.returned } : null,
    errors: p.errors.map((e) => ({ code: e.code, error: e.error })),
  };
}

function cmdInspect(p: ParsedArgs, ctx: Ctx): number {
  const runId = p.positionals[0];
  if (!runId) throw new Error(`runId is required\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  if (!existsSync(runDir)) throw new Error(`run ${runId} not found`);
  const report = inspectRun(runDir);
  if (has(p, '--json')) {
    ctx.out(JSON.stringify(report, null, 2));
    return 0;
  }
  ctx.out(`run ${report.runId} gen ${report.gen}: ${report.status} (${report.health})`);
  ctx.out(`  holder: ${report.holder ? `pid ${report.holder.pid} ${report.holder.alive ? 'alive' : 'dead'}` : 'none'}; executor: ${report.executor ?? 'pty (unrecorded)'}; containment: ${JSON.stringify(report.containment?.containment ?? null)}`);
  ctx.out(`  active ${Math.round(report.activeMs / 1000)}s, script cpu ${Math.round(report.cpuMs)}ms; journal dropped rows: ${report.integrity.dropped}`);
  for (const a of report.attempts) {
    const who = a.botName ? ` on ${a.botName}${a.cli ? ` · ${a.cli}` : ''}${a.sessionId ? ` [${a.sessionId.slice(0, 8)}]` : ''}` : a.cli ? ` (${a.cli})` : '';
    ctx.out(`  ${a.identity} attempt ${a.attempt}${who}: ${a.state}${a.phase ? ` (${a.phase})` : ''}${a.intent ? ' intent' : ''}${a.category ? ` ${a.category} ${a.retry}/${a.effects}: ${a.error}` : ''}`);
  }
  for (const d of report.pending) ctx.out(`  pending decision: ${d.identity} attempt ${d.attempt} (${d.reason}) → botmux flow decide ${report.runId} '${d.identity}' --attempt ${d.attempt} --accept-failed|--retry`);
  if (report.binding) {
    ctx.out(`  bound to: app ${report.binding.larkAppId} chat ${report.binding.chatId} topic ${report.binding.rootId}`);
    if (report.binding.trigger) ctx.out(`  triggered by: ${report.binding.trigger.kind} ${report.binding.trigger.connectorId ?? '-'} (${report.binding.trigger.triggerId}, source ${report.binding.trigger.source})`);
  }
  for (const w of report.waits) {
    ctx.out(`  wait ${w.identity} v${w.version}: ${w.state}; card ${w.delivery ?? 'not delivered'}${w.messageId ? ` (${w.messageId})` : ''}${w.error ? `: ${w.error}` : ''}`);
    if (w.state === 'open') ctx.out(`    → botmux flow signal ${report.runId} '${w.identity}' --payload '<json>'  |  botmux flow resend ${report.runId} '${w.identity}'`);
  }
  if (report.escapes.length > 0) ctx.out(`  escaped pids: ${report.escapes.join(', ')}`);
  for (const e of report.errors) ctx.out(`  error ${e.code}: ${e.error}`);
  if (report.finished) ctx.out(`  finished: ${report.finished.status} replay ${report.finished.replay}${report.finished.returned !== null ? `\n${JSON.stringify(report.finished.returned, null, 2)}` : ''}`);
  return 0;
}

function cmdLs(p: ParsedArgs, ctx: Pick<Ctx, 'dataDir' | 'out'>): number {
  const dir = flowRunsDir(ctx.dataDir);
  const rows: Array<{ runId: string; status: string; gen: number; updatedAt: number }> = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const runDir = join(dir, name);
      try {
        if (!statSync(runDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const report = inspectRun(runDir);
      const runJson = readRunJson(runDir);
      rows.push({ runId: name, status: report.status, gen: report.gen, updatedAt: runJson?.updatedAt ?? 0 });
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  if (has(p, '--json')) {
    ctx.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) ctx.out('no flow runs');
  for (const r of rows) ctx.out(`${r.runId}\tgen ${r.gen}\t${r.status}`);
  return 0;
}

async function control(runDir: string, request: ControlRequest): Promise<ControlResponse> {
  const path = controlSocketPath(runDir);
  if (!existsSync(path)) throw new Error('runner is not listening (run is interrupted or finished); resume it first');
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as ControlResponse);
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
  });
}

async function cmdControl(p: ParsedArgs, ctx: Ctx, build: (by: string) => ControlRequest): Promise<number> {
  const runId = p.positionals[0];
  if (!runId) throw new Error(`runId is required\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  const response = await control(runDir, build(str(p, '--by') ?? 'terminal'));
  if (!response.ok) {
    ctx.err(response.error);
    return 1;
  }
  ctx.out(`status: ${response.status}`);
  return 0;
}

async function cmdDecide(p: ParsedArgs, ctx: Ctx): Promise<number> {
  const runId = p.positionals[0];
  if (!runId) throw new Error(`runId is required\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  const by = str(p, '--by') ?? 'terminal';
  if (has(p, '--accept-journal') || has(p, '--assume-clean')) {
    const response = await control(runDir, { t: 'decide-run', choice: has(p, '--accept-journal') ? 'accept-journal' : 'assume-clean', by });
    if (!response.ok) {
      ctx.err(response.error);
      return 1;
    }
    ctx.out(`status: ${response.status}`);
    return 0;
  }
  const identity = p.positionals[1];
  const attempt = Number(str(p, '--attempt'));
  const choice = has(p, '--accept-failed') ? 'accept-failed' : has(p, '--retry') ? 'retry' : null;
  if (!identity || !Number.isInteger(attempt) || !choice) throw new Error(`decide needs <identity> --attempt <n> and --accept-failed or --retry\n${FLOW_USAGE}`);
  const status = await control(runDir, { t: 'status' });
  if (!status.ok) {
    ctx.err(status.error);
    return 1;
  }
  const pending = status.pending.find((d) => d.identity === identity && d.attempt === attempt);
  if (!pending) {
    ctx.err(`no pending decision for ${identity} attempt ${attempt}; pending: ${status.pending.map((d) => `${d.identity}#${d.attempt}`).join(', ') || 'none'}`);
    return 1;
  }
  const response = await control(runDir, { t: 'decide', identity, content: pending.content, attempt, choice, by });
  if (!response.ok) {
    ctx.err(response.error);
    return 1;
  }
  ctx.out(`decided ${identity} attempt ${attempt}: ${choice}; status ${response.status}`);
  return 0;
}

/** 终端提交信号（§7.4）：投递失败时的兜底入口，也是测试入口。缺省对准当前 open 的 version。 */
async function cmdSignal(p: ParsedArgs, ctx: Ctx): Promise<number> {
  const runId = p.positionals[0];
  const identity = p.positionals[1];
  const payloadRaw = str(p, '--payload');
  if (!runId || !identity || payloadRaw === undefined) throw new Error(`signal needs <runId> <identity> --payload '<json>'\n${FLOW_USAGE}`);
  const value = JSON.parse(payloadRaw) as unknown;
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  const by = str(p, '--by') ?? 'terminal';
  const status = await control(runDir, { t: 'status' });
  if (!status.ok) {
    ctx.err(status.error);
    return 1;
  }
  const wait = status.waits.find((w) => w.identity === identity);
  if (!wait) {
    ctx.err(`no open wait for ${identity}; open: ${status.waits.map((w) => `${w.identity} v${w.version}`).join(', ') || 'none'}`);
    return 1;
  }
  const versionRaw = str(p, '--version');
  const version = versionRaw === undefined ? wait.version : Number(versionRaw);
  const response = await control(runDir, { t: 'signal', identity, version, content: wait.content, by, value });
  if (!response.ok) {
    ctx.err(`${response.code ?? 'rejected'}: ${response.error}`);
    return 1;
  }
  ctx.out(`signal ${identity} v${version} accepted; status ${response.status}`);
  return 0;
}

async function cmdResend(p: ParsedArgs, ctx: Ctx): Promise<number> {
  const runId = p.positionals[0];
  const identity = p.positionals[1];
  if (!runId || !identity) throw new Error(`resend needs <runId> <identity>\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  const response = await control(runDir, { t: 'resend', identity, by: str(p, '--by') ?? 'terminal' });
  if (!response.ok) {
    ctx.err(`${response.code ?? 'rejected'}: ${response.error}`);
    return 1;
  }
  const wait = response.waits.find((w) => w.identity === identity);
  ctx.out(`resent ${identity} as v${wait?.version ?? '?'}: delivery ${wait?.delivery ?? '?'}${wait?.deliveryError ? ` (${wait.deliveryError})` : ''}`);
  return 0;
}

async function cmdCheckReplay(p: ParsedArgs, ctx: Ctx): Promise<number> {
  const runId = p.positionals[0];
  if (!runId) throw new Error(`runId is required\n${FLOW_USAGE}`);
  const runDir = join(flowRunsDir(ctx.dataDir), runId);
  if (!existsSync(runDir)) throw new Error(`run ${runId} not found`);
  const report = await checkReplay({ runDir, distDir: ctx.distDir ?? join(__dirname, '..') });
  if (has(p, '--json')) {
    ctx.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (report.error) ctx.err(report.error);
  if (report.blocked) ctx.err(`not replayable read-only: ${report.blocked.reason}`);
  if (report.completed) {
    ctx.out(report.returnedMatches ? `replay ok: return value matches (${report.cacheHits} cached identities)` : 'replay MISMATCH: the script returned a different value from the same cached outcomes — it violates the branch-isolation constraint (§5.2)');
    if (!report.returnedMatches) {
      ctx.out(`expected: ${JSON.stringify(report.expected)}`);
      ctx.out(`actual:   ${JSON.stringify(report.actual)}`);
    }
  }
  return report.ok ? 0 : 1;
}

export { DEFAULT_RUN_LIMITS };
