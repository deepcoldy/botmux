/**
 * `botmux v3 run <dag.json>` — standalone CLI entry that runs a hand-written
 * v3 DAG to terminal on the REAL ephemeral worker pool.
 *
 * This is the daemon-independent dogfood path: it wires the two injected seams
 * (codex's `ephemeral-pool` + `manifest` validator) against live `bots.json`,
 * so the whole engine can be exercised end-to-end without the daemon running.
 *
 * Secret handling follows the contract: secrets are NEVER frozen into the
 * runDir.  The pool re-resolves `larkAppSecret` by the frozen `larkAppId` at
 * spawn time via `resolveLarkAppSecret`, which reads `bots.json` and
 * process-fails (returns a fail result) if the bot is gone — it deliberately
 * does NOT fall back to an environment variable.
 *
 * Gate handling: a CLI run has no Lark card layer, so `humanGate` nodes resolve
 * through a terminal y/N prompt (or `--yes` to auto-approve).  Wiring the gate
 * to the v0.2 approval card is the daemon's job, deferred until the engine is
 * proven on real workers.
 */

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { loadDag, type V3Dag } from './dag.js';
import { runWorkflow, type V3RuntimeDeps, type V3RuntimeOptions } from './runtime.js';
import { createEphemeralPool } from './ephemeral-pool.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import { createFileGate, type GateWait } from './human-gate.js';
import {
  V3_SUPPORTED_CLIS,
  type BotSnapshot,
  type ValidateManifest,
} from './contract.js';
import { readJournal } from './journal.js';
import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import {
  botToSnapshot,
  freezeDagBotSnapshots,
  parseFrozenBotSnapshots,
  serializeFrozenBotSnapshots,
} from './bot-resolve.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../../utils/file-lock.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeManualCliRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type PublishRunEnvelopeResult,
  type V3ManualCliRunEnvelope,
} from './run-envelope.js';
import { V3_DRIVE_LEASE_MAX_WAIT_MS, v3DriveLeaseTarget } from './drive-lease.js';
import {
  createDefaultHostExecutorRegistry,
  createDefaultProviderReconcilers,
} from '../hostExecutors/registry.js';

interface V3RunArgs {
  dagPath: string;
  botSelector?: string;
  workingDir?: string;
  baseDir: string;
  autoApproveGates: boolean;
  maxParallel?: number;
}

/** Default run root: `~/.botmux/v3-runs/<runId>`. */
function defaultBaseDir(): string {
  return join(homedir(), '.botmux', 'v3-runs');
}

function argValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const f of flags) {
      if (a === f && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function firstPositional(args: string[], flagsWithValue: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsWithValue.includes(a)) { i++; continue; }
    if (flagsWithValue.some((f) => a.startsWith(f + '='))) continue;
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

/** Resolve which bot config drives a node: by larkAppId, by `name`, else the
 *  first bot when the selector is omitted (the run-level default). */
function resolveBotConfig(selector: string | undefined, bots: BotConfig[]): BotConfig {
  if (!selector) {
    if (bots.length === 0) throw new Error('v3: bots.json has no bots — run `botmux setup` first');
    return bots[0]!;
  }
  const match = bots.find((b) => b.larkAppId === selector)
    ?? bots.find((b) => b.name === selector);
  if (!match) {
    const known = bots.map((b) => b.name ?? b.larkAppId).join(', ') || '(none)';
    throw new Error(`v3: no bot matches "${selector}" (known: ${known})`);
  }
  return match;
}

/** Terminal gate decision: prompt y/N on stdin, or auto-approve with `--yes`.
 *  Non-TTY without `--yes` rejects with a clear message (gates need a human or
 *  the daemon's card). */
function makeAwaitDecision(autoApprove: boolean) {
  return async (wait: GateWait): Promise<{ resolution: 'approved' | 'rejected'; by: string; selected?: string }> => {
    if (autoApprove) {
      console.log(`\n🔓 [gate ${wait.nodeId}] 自动批准 (--yes): ${wait.prompt}`);
      return { resolution: 'approved', by: 'cli:--yes', selected: wait.approveOptions[0] };
    }
    if (!process.stdin.isTTY) {
      console.error(`\n⛔ [gate ${wait.nodeId}] 需要人工批准但 stdin 非交互；用 --yes 自动批准，或在 daemon 内跑以走飞书审批卡片。`);
      return { resolution: 'rejected', by: 'cli:non-tty', selected: firstRejectOption(wait) };
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await new Promise<string>((res) => {
        rl.question(`\n🛑 [gate ${wait.nodeId}] ${wait.prompt}\n   批准? (y/N): `, res);
      })).trim().toLowerCase();
      const approved = answer === 'y' || answer === 'yes';
      return {
        resolution: approved ? 'approved' : 'rejected',
        by: 'cli:tty',
        selected: approved ? wait.approveOptions[0] : firstRejectOption(wait),
      };
    } finally {
      rl.close();
    }
  };
}

function firstRejectOption(wait: GateWait): string | undefined {
  return wait.options.find((opt) => !wait.approveOptions.includes(opt));
}

function parseArgs(rest: string[]): V3RunArgs {
  const flagsWithValue = ['--bot', '--working-dir', '--base-dir', '--max-parallel'];
  const dagPath = firstPositional(rest, flagsWithValue);
  if (!dagPath) {
    throw new Error('用法: botmux v3 run <dag.json> [--bot <larkAppId|name>] [--working-dir <dir>] [--base-dir <dir>] [--max-parallel <n>] [--yes]');
  }
  const maxParallelRaw = argValue(rest, '--max-parallel');
  const maxParallel = maxParallelRaw ? Number(maxParallelRaw) : undefined;
  if (maxParallel !== undefined && (!Number.isInteger(maxParallel) || maxParallel < 1)) {
    throw new Error(`--max-parallel 必须是正整数，收到 "${maxParallelRaw}"`);
  }
  return {
    dagPath: resolve(dagPath),
    botSelector: argValue(rest, '--bot'),
    workingDir: argValue(rest, '--working-dir'),
    baseDir: argValue(rest, '--base-dir') ? resolve(argValue(rest, '--base-dir')!) : defaultBaseDir(),
    autoApproveGates: rest.includes('--yes') || rest.includes('-y'),
    maxParallel,
  };
}

/** Pretty-print the terminal journal so a CLI run shows what happened without
 *  the operator having to cat the ndjson. */
function printOutcome(runDir: string): void {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  console.log(`\n── 节点结果 ──`);
  for (const e of events) {
    if (e.type === 'nodeSucceeded') {
      console.log(`  ✅ ${e.nodeId}  → ${e.manifestPath}`);
    } else if (e.type === 'nodeFailed') {
      console.log(`  ❌ ${(e as any).nodeId}  [${(e as any).errorClass}] ${(e as any).message}`);
    } else if (e.type === 'gateResolved') {
      const ge = e as any;
      console.log(`  🛑 ${ge.nodeId}  gate → ${ge.resolution} (by ${ge.by})`);
    }
  }
}

export interface AuthorizeManualCliRunOptions {
  runDir: string;
  dag: V3Dag;
  bots: BotConfig[];
  defaultBotSelector?: string;
  workingDirOverride?: string;
  now?: Date;
}

export interface AuthorizeManualCliRunResult {
  dag: V3Dag;
  frozenBotSnapshots: Map<string, BotSnapshot>;
  envelope: V3ManualCliRunEnvelope;
  publication: PublishRunEnvelopeResult;
}

/**
 * Create/reuse a manual CLI run's immutable execution authorization.
 *
 * The lock deliberately spans the missing-envelope check, all shared artifact
 * writes, digest construction, and run.json publication. link(2) alone keeps
 * run.json create-once, but cannot stop two manual launchers from overwriting
 * dag.json/bots.snapshot.json between one another's digest and publication.
 */
export function authorizeManualCliRun(opts: AuthorizeManualCliRunOptions): AuthorizeManualCliRunResult {
  mkdirSync(opts.runDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(join(opts.runDir, 'run.json'), () => {
    // Re-read only after the cross-process lock is held. A completed winner is
    // always reused byte-for-byte; never rebuild snapshots from live bots.json.
    const existing = readRunEnvelope(opts.runDir, opts.dag.runId);
    if (existing.kind === 'invalid') {
      throw new Error(`run.json 已损坏，拒绝回退/覆盖: ${existing.problems.join('; ')}`);
    }
    if (existing.kind === 'ok') {
      const loaded = loadAuthorizedV3Run(opts.runDir, {
        expectedRunId: opts.dag.runId,
        allowedSources: ['manual_cli'],
      });
      const envelope = loaded.envelope as V3ManualCliRunEnvelope;
      return {
        dag: loaded.dag,
        frozenBotSnapshots: parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag),
        envelope,
        publication: {
          created: false,
          path: join(opts.runDir, 'run.json'),
          envelope,
        },
      };
    }

    if (existsSync(join(opts.runDir, 'journal.ndjson'))) {
      throw new Error('发现无 run.json 的历史 manual run；为避免用新 DAG 覆盖旧 journal，请迁移或换 runId');
    }

    const frozenBotSnapshots = freezeDagBotSnapshots(opts.dag, opts.bots, {
      defaultSelector: opts.defaultBotSelector,
      workingDirOverride: opts.workingDirOverride,
    });
    atomicWriteFileSync(join(opts.runDir, 'dag.json'), `${JSON.stringify(opts.dag, null, 2)}\n`, { mode: 0o600 });
    atomicWriteFileSync(
      join(opts.runDir, 'bots.snapshot.json'),
      `${JSON.stringify(serializeFrozenBotSnapshots(frozenBotSnapshots), null, 2)}\n`,
      { mode: 0o600 },
    );
    const now = (opts.now ?? new Date()).toISOString();
    const envelope = makeManualCliRunEnvelope({
      runId: opts.dag.runId,
      createdAt: now,
      authorizedAt: now,
      artifacts: {
        dag: artifactRef(opts.runDir, 'dag.json'),
        botSnapshots: artifactRef(opts.runDir, 'bots.snapshot.json'),
      },
    });
    const publication = publishRunEnvelopeOnce(opts.runDir, envelope);
    return { dag: opts.dag, frozenBotSnapshots, envelope, publication };
  });
}

/**
 * `botmux v3 <sub> ...` dispatcher.  MVP exposes only `run`.
 */
export async function cmdV3(sub: string, rest: string[]): Promise<void> {
  if (sub !== 'run') {
    console.error(`未知子命令: ${sub || '(空)'}\n用法: botmux v3 run <dag.json> [--bot ...] [--working-dir ...] [--base-dir ...] [--yes]`);
    process.exit(1);
  }

  let args: V3RunArgs;
  try {
    args = parseArgs(rest);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!existsSync(args.dagPath)) {
    console.error(`❌ 找不到 dag.json: ${args.dagPath}`);
    process.exit(1);
  }

  let bots: BotConfig[];
  try {
    bots = loadBotConfigs();
  } catch (err) {
    console.error(`❌ 读取 bots.json 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (bots.length === 0) {
    console.error('❌ 未配置任何 bot，请先运行 `botmux setup`');
    process.exit(1);
  }

  // Secret resolver: by larkAppId from live bots.json; no env fallback (contract).
  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  const resolveLarkAppSecret = (larkAppId: string): string | undefined => secretById.get(larkAppId);

  // codex's throw-based validator → the runtime's result-style seam.
  const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
    try {
      const manifest = await readAndValidateManifest(manifestPath, outputDir);
      return { ok: true, manifest };
    } catch (e) {
      return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
    }
  };

  const resolveBotSnapshot = (botId: string | undefined): BotSnapshot => {
    const bot = resolveBotConfig(botId ?? args.botSelector, bots);
    return botToSnapshot(bot, args.workingDir);
  };

  const { runNode } = createEphemeralPool({ resolveLarkAppSecret });
  const resolveGate = createFileGate({ awaitDecision: makeAwaitDecision(args.autoApproveGates) });

  let dag: V3Dag;
  try {
    dag = loadDag(args.dagPath);
  } catch (err) {
    console.error(`❌ DAG 校验失败:\n   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const runDir = join(args.baseDir, dag.runId);
  let frozenBotSnapshots: Map<string, BotSnapshot>;
  try {
    const authorization = authorizeManualCliRun({
      runDir,
      dag,
      bots,
      defaultBotSelector: args.botSelector,
      workingDirOverride: args.workingDir,
    });
    dag = authorization.dag;
    frozenBotSnapshots = authorization.frozenBotSnapshots;
  } catch (err) {
    console.error(`❌ manual run 物化/授权失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const deps: V3RuntimeDeps = {
    runNode,
    validateManifest,
    resolveBotSnapshot,
    resolveGate,
    hostExecutors: createDefaultHostExecutorRegistry(),
    hostReconcilers: createDefaultProviderReconcilers(),
  };
  const opts: V3RuntimeOptions = {
    baseDir: args.baseDir,
    authorizedArtifacts: true,
    frozenBotSnapshots,
    ...(args.maxParallel ? { globalConcurrency: args.maxParallel } : {}),
  };

  const defaultBot = resolveBotConfig(args.botSelector, bots);
  console.log(`\n🚀 v3 run "${dag.runId}"  (${dag.nodes.length} 节点)`);
  console.log(`   DAG:       ${args.dagPath}`);
  console.log(`   runDir:    ${join(args.baseDir, dag.runId)}`);
  console.log(`   默认 bot:  ${defaultBot.name ?? defaultBot.larkAppId} (${defaultBot.cliId})`);
  console.log(`   支持 CLI:  ${V3_SUPPORTED_CLIS.join(', ')}`);

  let outcome;
  try {
    // Same cross-process drive lease as the daemon. A blocking CLI humanGate
    // intentionally keeps the lease for the whole prompt so no daemon/manual
    // runner can spawn a second scheduler for the same on-disk run.
    outcome = await withFileLock(
      v3DriveLeaseTarget(args.baseDir, dag.runId),
      () => runWorkflow(dag, deps, opts),
      { maxWaitMs: V3_DRIVE_LEASE_MAX_WAIT_MS },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = detail.includes('file-lock timeout waiting for')
      ? `另一进程正在驱动 run "${dag.runId}"，请等待其结束后重试`
      : detail;
    console.error(`\n❌ run 失败（启动期）: ${message}`);
    process.exit(1);
  }

  printOutcome(outcome.runDir);
  if (outcome.reason === 'awaitingGate') {
    console.error(
      `\n⏸️  run 正在等待 humanGate：${outcome.pendingWaits.map(w => `${w.nodeId}(${w.waitId})`).join(', ')}`,
    );
    console.error(`   CLI 默认应使用 blocking gate；若看到此消息，请改用 daemon 驱动或检查 gateMode。`);
    process.exit(1);
  }
  if (outcome.runStatus === 'succeeded') {
    console.log(`\n✅ run 成功 — 产物在 ${outcome.runDir}`);
    process.exit(0);
  } else if (outcome.runStatus === 'cancelled') {
    console.error(
      outcome.uncertainHostEffects?.length
        ? `\n⚠️ run 已取消，但有 ${outcome.uncertainHostEffects.length} 个外部操作状态待核实；禁止直接重试 — 详见 ${join(outcome.runDir, 'journal.ndjson')}`
        : `\n⏹ run 已取消 — 详见 ${join(outcome.runDir, 'journal.ndjson')}`,
    );
    process.exit(1);
  } else if (outcome.runStatus === 'blocked') {
    // Blocked ≠ failed: a contract/semantic failure that a retry can fix —
    // or an exhausted loop that a grant (+1 iteration) can re-open.
    console.error(outcome.uncertainHostEffects?.length
      ? `\n⚠️ run 受阻：外部操作状态无法确认，请先对账；普通 retry 已禁用 — 详见 ${join(outcome.runDir, 'journal.ndjson')}`
      : `\n⏸️  run 受阻${outcome.blockedNodeId ? `（节点 ${outcome.blockedNodeId}）` : ''} — 节点受阻用 \`botmux workflow retry ${dag.runId}\` 重试；loop 轮数耗尽用 \`botmux workflow grant ${dag.runId}\` 追加一轮；详见 ${join(outcome.runDir, 'journal.ndjson')}`);
    process.exit(1);
  } else {
    console.error(`\n❌ run 失败${outcome.failedNodeId ? `（节点 ${outcome.failedNodeId}）` : ''} — 详见 ${join(outcome.runDir, 'journal.ndjson')}`);
    process.exit(1);
  }
}
