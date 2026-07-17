/** `botmux template archive-runs`: private, content-addressed v2 run archive. */

import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveBotmuxDataDir } from '../core/data-dir.js';
import {
  commitV2RunArchive,
  planV2RunArchive,
  retireV2RunSource,
  verifyV2RunArchive,
  type V2RunArchivePlan,
  type V2RunArchiveVerification,
} from '../workflows/migration/v2-run-archive.js';
import {
  archiveDirectoryName,
  v2RunArchiveId,
} from '../workflows/migration/v2-run-archive-schema.js';

export interface WorkflowRunArchiveCliOptions {
  mode: 'plan' | 'commit' | 'verify' | 'retire';
  json: boolean;
  runsDir: string;
  archiveBaseDir: string;
  archiveRef?: string;
  daemonStoppedAcknowledged: boolean;
}

export interface WorkflowRunArchiveCliReport {
  mode: WorkflowRunArchiveCliOptions['mode'];
  archiveId?: string;
  runCount: number;
  residualCount: number;
  fileCount: number;
  totalBytes: number;
  warningCodes: string[];
  archiveDir?: string;
  reused?: boolean;
  staticVerified?: boolean;
  sourceVerified?: boolean;
  retirementStatus?: 'retired' | 'already_retired' | 'nothing_to_retire';
  quarantineDir?: string;
  receiptPath?: string;
}

const VALUE_FLAGS = new Set(['--verify', '--retire', '--runs-dir', '--archive-dir']);
const BOOLEAN_FLAGS = new Set(['--commit', '--json', '--ack-daemon-stopped']);

export function parseWorkflowRunArchiveCliOptions(
  args: string[],
  dataDir: string = resolveBotmuxDataDir(),
  env: NodeJS.ProcessEnv = process.env,
): WorkflowRunArchiveCliOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument ${JSON.stringify(token)}`);
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equals >= 0) throw new Error(`${flag} does not accept a value`);
      if (booleans.has(flag)) throw new Error(`duplicate flag ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate flag ${flag}`);
    const value = equals >= 0 ? token.slice(equals + 1) : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const commit = booleans.has('--commit');
  const verifyRef = values.get('--verify');
  const retireRef = values.get('--retire');
  const selectedModes = Number(commit) + Number(verifyRef !== undefined) + Number(retireRef !== undefined);
  if (selectedModes > 1) throw new Error('--commit, --verify, and --retire are mutually exclusive');
  const archiveRef = verifyRef ?? retireRef;
  const daemonStoppedAcknowledged = booleans.has('--ack-daemon-stopped');
  if (daemonStoppedAcknowledged && !retireRef) {
    throw new Error('--ack-daemon-stopped is only valid with --retire');
  }
  const runsDir = resolve(
    values.get('--runs-dir') ??
    env.BOTMUX_WORKFLOW_RUNS_DIR ??
    join(dataDir, 'workflow-runs'),
  );
  const archiveBaseDir = resolve(
    values.get('--archive-dir') ?? join(dataDir, 'workflow-archives', 'v2-runs'),
  );
  return {
    mode: retireRef ? 'retire' : verifyRef ? 'verify' : commit ? 'commit' : 'plan',
    json: booleans.has('--json'),
    runsDir,
    archiveBaseDir,
    daemonStoppedAcknowledged,
    ...(archiveRef ? { archiveRef } : {}),
  };
}

function resolveArchiveRef(baseDir: string, ref: string): string {
  if (isAbsolute(ref) || ref.includes('/') || ref.includes('\\')) return resolve(ref);
  if (/^sha256:[0-9a-f]{64}$/.test(ref)) return join(baseDir, archiveDirectoryName(ref));
  if (/^sha256-[0-9a-f]{64}$/.test(ref)) return join(baseDir, ref);
  throw new Error('--verify/--retire expects an absolute/relative archive path or sha256 archive id');
}

function warningCodes(plan: V2RunArchivePlan): string[] {
  return [...new Set(plan.content.runs.flatMap((run) => run.warnings.map((warning) => warning.code)))].sort();
}

function reportFromPlan(
  mode: WorkflowRunArchiveCliOptions['mode'],
  plan: V2RunArchivePlan,
): WorkflowRunArchiveCliReport {
  return {
    mode,
    archiveId: v2RunArchiveId(plan.content),
    runCount: plan.runCount,
    residualCount: plan.residualCount,
    fileCount: plan.content.payloadFiles.length,
    totalBytes: plan.totalPayloadBytes,
    warningCodes: warningCodes(plan),
  };
}

function reportFromVerification(
  verification: V2RunArchiveVerification,
): WorkflowRunArchiveCliReport {
  const manifest = verification.manifest;
  return {
    mode: 'verify',
    archiveId: manifest.archiveId,
    runCount: manifest.content.runs.length,
    residualCount: manifest.content.residuals.length,
    fileCount: verification.fileCount,
    totalBytes: verification.totalBytes,
    warningCodes: [...new Set(manifest.content.runs.flatMap((run) => run.warnings.map((warning) => warning.code)))].sort(),
    archiveDir: verification.archiveDir,
    staticVerified: verification.staticVerified,
    sourceVerified: verification.sourceVerified,
  };
}

export async function runWorkflowRunArchiveCli(
  options: WorkflowRunArchiveCliOptions,
): Promise<WorkflowRunArchiveCliReport> {
  if (options.mode === 'verify') {
    let sourceRunsDir: string | undefined;
    try {
      // ENOENT after a successful retirement is the one legitimate reason to
      // perform static-only verification. Existing but unreadable/unsafe or
      // changed sources must still fail loudly in the source-aware verifier.
      lstatSync(options.runsDir);
      sourceRunsDir = options.runsDir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return reportFromVerification(await verifyV2RunArchive({
      archiveDir: resolveArchiveRef(options.archiveBaseDir, options.archiveRef!),
      ...(sourceRunsDir ? { sourceRunsDir } : {}),
    }));
  }
  if (options.mode === 'retire') {
    const retired = await retireV2RunSource({
      runsDir: options.runsDir,
      archiveBaseDir: options.archiveBaseDir,
      archiveDir: resolveArchiveRef(options.archiveBaseDir, options.archiveRef!),
      daemonStoppedAcknowledged: options.daemonStoppedAcknowledged,
    });
    if (retired.status === 'nothing_to_retire') {
      return {
        mode: 'retire',
        runCount: 0,
        residualCount: 0,
        fileCount: 0,
        totalBytes: 0,
        warningCodes: [],
        retirementStatus: retired.status,
      };
    }
    return {
      ...reportFromVerification(retired.verification),
      mode: 'retire',
      retirementStatus: retired.status,
      quarantineDir: retired.quarantineDir,
      receiptPath: retired.receiptPath,
    };
  }
  const plan = await planV2RunArchive({ runsDir: options.runsDir });
  if (options.mode === 'plan') return reportFromPlan('plan', plan);
  const committed = await commitV2RunArchive({
    runsDir: options.runsDir,
    archiveBaseDir: options.archiveBaseDir,
  });
  return {
    ...reportFromVerification(committed.verification),
    mode: 'commit',
    reused: committed.reused,
  };
}

function printHuman(report: WorkflowRunArchiveCliReport): void {
  const mib = (report.totalBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[${report.mode}] archive=${report.archiveId ?? 'none'} runs=${report.runCount} ` +
    `residuals=${report.residualCount} files=${report.fileCount} bytes=${report.totalBytes} (${mib} MiB)`,
  );
  if (report.warningCodes.length > 0) {
    console.log(`warnings=${report.warningCodes.join(',')}`);
  }
  if (report.mode === 'plan') {
    console.log('dry-run only; add --commit to publish the private archive');
  } else if (report.mode === 'retire') {
    console.log(
      `retirementStatus=${report.retirementStatus}` +
      (report.quarantineDir ? ` quarantineDir=${report.quarantineDir}` : '') +
      (report.receiptPath ? ` receiptPath=${report.receiptPath}` : ''),
    );
  } else {
    console.log(
      `staticVerified=${report.staticVerified === true} sourceVerified=${report.sourceVerified === true}` +
      (report.reused !== undefined ? ` reused=${report.reused}` : ''),
    );
  }
}

export async function cmdWorkflowRunArchive(args: string[]): Promise<void> {
  const options = parseWorkflowRunArchiveCliOptions(args);
  const report = await runWorkflowRunArchiveCli(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}
