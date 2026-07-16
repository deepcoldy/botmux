/**
 * v3 humanGate — file-backed approval waits.
 *
 * Codex's v1-review blocker #4: a workflow gate is RUNTIME state, not an
 * in-memory chat ask.  Its pending/resolved status MUST persist to the runDir
 * so a daemon restart doesn't lose a pending approval.  The journal already
 * records `gateDispatched` / `gateResolved` (audit truth); this module owns the
 * materialized, mutable wait files under `runDir/waits/<waitId>.json` — the
 * active state the Lark card layer keys off and the restart-recovery scan reads.
 *
 * Split of concerns:
 *   - THIS file: the file-wait store + a gate resolver that persists
 *     pending → resolved around an injected decision source.  Pure file IO,
 *     bot-agnostic, testable without the daemon.
 *   - daemon (later): supplies `awaitDecision` — posts the Lark approval card
 *     (reusing v0.2's card-builder / card-handler UX) and resolves when the
 *     button is clicked; on restart it re-arms pending waits via
 *     `listPendingWaits`.
 *
 * The wait shape mirrors v0.2's `waitKind: 'human-gate'` lineage but is
 * deliberately scoped to v3's gate needs: no deadline, but options /
 * approveOptions / approvers are persisted for crash-safe card recovery.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  writeFileSync,
  readFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../../utils/file-lock.js';
import { fsyncDirectorySyncPortable, fsyncRegularFileSync } from '../../utils/fs-durability.js';
import { DEFAULT_HUMAN_GATE_OPTIONS, type V3HumanGate } from './dag.js';
import type { V3RuntimeDeps } from './runtime.js';

export type GateWaitStatus = 'pending' | 'approved' | 'rejected';

export interface GateWait {
  waitId: string;
  nodeId: string;
  /** The runtime instance this gate belongs to (`A#001`).  A revisit makes a
   *  fresh instance + fresh gate; resolve-time validation rejects a stale card
   *  whose instance is no longer the node's effective one (code review). */
  instanceId?: string;
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
  status: GateWaitStatus;
  createdAt: number;
  resolvedAt?: number;
  /** open_id (or 'system') of the resolver, once resolved. */
  by?: string;
  /** The concrete option selected by the reviewer. */
  selected?: string;
  /** Host-only: the exact frozen provider input this approval covers. */
  hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
}

/** The concrete (non-optional) shape the runtime injects as `resolveGate`. */
export type GateResolver = NonNullable<V3RuntimeDeps['resolveGate']>;

// ─── File-wait store ────────────────────────────────────────────────────────

export function waitsDir(runDir: string): string {
  return join(runDir, 'waits');
}

export function waitPath(runDir: string, waitId: string): string {
  return join(waitsDir(runDir), `${waitId}.json`);
}

/** Host approvals are per frozen attempt, while ordinary gates remain per
 * runtime instance. Including the attempt number prevents a safe pre-intent
 * retry from reusing an already-resolved approval file. */
export function v3GateWaitId(
  nodeId: string,
  instanceId?: string,
  hostApproval?: { attemptId: string },
): string {
  const base = instanceId ?? nodeId;
  if (!hostApproval) return `${base}-gate`;
  const attempt = hostApproval.attemptId.slice(hostApproval.attemptId.lastIndexOf('/') + 1);
  if (!/^\d{3}$/.test(attempt)) {
    throw new Error(`v3 human-gate: invalid host attempt id ${JSON.stringify(hostApproval.attemptId)}`);
  }
  return `${base}-host-${attempt}-gate`;
}

/** Atomic JSON write (tmp + rename) so a crash never leaves a torn wait file. */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  const runDir = dirname(dir);
  assertRealDirectory(runDir, 'run directory');
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch { /* race: assert below */ }
  }
  assertRealDirectory(dir, 'waits directory');
  chmodSync(dir, 0o700);
  if (existsSync(path)) assertPrivateRegularWaitFile(path, false);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Rename replaces a raced final symlink rather than following it, but an
    // already-present one is an integrity signal and was rejected above.
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* tolerate */ }
    }
    try { unlinkSync(tmp); } catch { /* tolerate */ }
    throw err;
  }
  chmodSync(path, 0o600);
  fsyncRegularFileSync(path);
  fsyncDirectorySyncPortable(dir);
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`v3 human-gate: ${label} must be a real directory`);
  }
}

function assertPrivateRegularWaitFile(path: string, requirePrivate = true): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('v3 human-gate: wait file must be a regular file');
  }
  if (requirePrivate && (stat.mode & 0o077) !== 0) {
    throw new Error('v3 human-gate: host wait file must not be group/world accessible');
  }
}

/** Write the initial `pending` wait file for a gate.  Overwrites any stale
 *  file at the same waitId (a re-dispatched gate). */
export function writePendingWait(
  runDir: string,
  input: { waitId: string; nodeId: string; prompt: string } &
    Partial<Pick<GateWait, 'options' | 'approveOptions' | 'approvers' | 'instanceId' | 'hostApproval'>>,
): GateWait {
  const options = input.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  const approveOptions = input.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]);
  const wait: GateWait = {
    waitId: input.waitId,
    nodeId: input.nodeId,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    prompt: input.prompt,
    options,
    approveOptions,
    approvers: input.approvers ?? [],
    ...(input.hostApproval ? { hostApproval: input.hostApproval } : {}),
    status: 'pending',
    createdAt: Date.now(),
  };
  atomicWriteJson(waitPath(runDir, input.waitId), wait);
  return wait;
}

/** Read a single wait file, or `undefined` if it doesn't exist. */
export function readWait(runDir: string, waitId: string): GateWait | undefined {
  const path = waitPath(runDir, waitId);
  if (existsSync(waitsDir(runDir))) assertRealDirectory(waitsDir(runDir), 'waits directory');
  if (!existsSync(path)) return undefined;
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('v3 human-gate: wait file must be a regular file');
  }
  const wait = normalizeWaitFile(JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateWait>);
  if (wait.hostApproval && (pathStat.mode & 0o077) !== 0) {
    throw new Error('v3 human-gate: host wait file must not be group/world accessible');
  }
  return wait;
}

/** Transition a wait to approved / rejected.  Throws if the wait is missing
 *  (a resolution for an unknown gate is a programming error, not a no-op). */
export function resolveWait(
  runDir: string,
  waitId: string,
  resolution: 'approved' | 'rejected',
  by: string,
  selected?: string,
): GateWait {
  const outcome = resolveWaitOnce(runDir, waitId, resolution, by, selected);
  if (!outcome.changed) {
    throw new Error(
      `v3 human-gate: wait "${waitId}" is already ${outcome.wait.status}; first resolution wins`,
    );
  }
  return outcome.wait;
}

/** Cross-process compare-and-set for a pending wait. Exactly one resolver may
 *  transition it; every later contradictory click observes the first result. */
export function resolveWaitOnce(
  runDir: string,
  waitId: string,
  resolution: 'approved' | 'rejected',
  by: string,
  selected?: string,
): { wait: GateWait; changed: boolean } {
  const path = waitPath(runDir, waitId);
  if (existsSync(waitsDir(runDir))) assertRealDirectory(waitsDir(runDir), 'waits directory');
  if (!existsSync(path)) {
    throw new Error(`v3 human-gate: no pending wait "${waitId}" in ${runDir}`);
  }
  return withFileLockSync(path, () => {
    const existing = readWait(runDir, waitId);
    if (!existing) throw new Error(`v3 human-gate: no pending wait "${waitId}" in ${runDir}`);
    if (existing.status !== 'pending') return { wait: existing, changed: false };
    const resolved: GateWait = {
      ...existing,
      status: resolution,
      resolvedAt: Date.now(),
      by,
      selected,
    };
    atomicWriteJson(path, resolved);
    return { wait: resolved, changed: true };
  });
}

export function normalizeGateWaitInput(gate: V3HumanGate): Pick<GateWait, 'prompt' | 'options' | 'approveOptions' | 'approvers'> {
  const options = gate.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  return {
    prompt: gate.prompt,
    options,
    approveOptions: gate.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]),
    approvers: gate.approvers ?? [],
  };
}

export function selectedResolution(
  wait: Pick<GateWait, 'options' | 'approveOptions'>,
  selected: string,
): 'approved' | 'rejected' | undefined {
  if (!wait.options.includes(selected)) return undefined;
  return wait.approveOptions.includes(selected) ? 'approved' : 'rejected';
}

export function canResolveGateWait(wait: Pick<GateWait, 'approvers'>, by: string | undefined): boolean {
  return wait.approvers.length === 0 || (!!by && wait.approvers.includes(by));
}

/** All still-pending waits in the runDir — the daemon's restart-recovery scan
 *  uses this to re-post / re-arm approval cards after a crash. */
export function listPendingWaits(runDir: string): GateWait[] {
  const dir = waitsDir(runDir);
  if (!existsSync(dir)) return [];
  const out: GateWait[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    try {
      const wait = readWait(runDir, name.slice(0, -'.json'.length));
      if (!wait) continue;
      if (wait.status === 'pending') out.push(wait);
    } catch {
      // skip a torn / unparseable wait file (mid-write crash)
    }
  }
  return out;
}

function normalizeWaitFile(raw: Partial<GateWait>): GateWait {
  const options = raw.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  let hostApproval: GateWait['hostApproval'];
  if (raw.hostApproval !== undefined) {
    const approval = raw.hostApproval as unknown as Record<string, unknown>;
    if (
      !approval ||
      typeof approval !== 'object' ||
      Array.isArray(approval) ||
      Object.keys(approval).sort().join(',') !== 'approvalDigest,attemptId,inputHash' ||
      typeof approval.attemptId !== 'string' ||
      !/\/attempts\/\d{3}$/.test(approval.attemptId) ||
      typeof approval.approvalDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(approval.approvalDigest) ||
      typeof approval.inputHash !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(approval.inputHash)
    ) {
      throw new Error('v3 human-gate: malformed hostApproval in wait file');
    }
    hostApproval = approval as unknown as NonNullable<GateWait['hostApproval']>;
  }
  return {
    waitId: raw.waitId ?? '',
    nodeId: raw.nodeId ?? '',
    ...(raw.instanceId ? { instanceId: raw.instanceId } : {}),
    prompt: raw.prompt ?? '',
    options,
    approveOptions: raw.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]),
    approvers: raw.approvers ?? [],
    status: raw.status ?? 'pending',
    createdAt: raw.createdAt ?? 0,
    resolvedAt: raw.resolvedAt,
    by: raw.by,
    selected: raw.selected,
    ...(hostApproval ? { hostApproval } : {}),
  };
}

// ─── Gate resolver (injected into the runtime) ──────────────────────────────

/**
 * Build the `resolveGate` the runtime injects.  Persists the wait as `pending`,
 * delegates to the daemon-supplied `awaitDecision` (post card + await the
 * click), then persists the resolution — so the file store is authoritative
 * for pending/resolved regardless of whether the in-memory decision promise
 * survives a restart (the daemon re-arms via `listPendingWaits`).
 *
 * `awaitDecision` is the only daemon-coupled seam; everything else here is file
 * IO, which is why this factory is unit-testable with a fake decision source.
 */
export function createFileGate(deps: {
  awaitDecision: (wait: GateWait) => Promise<{ resolution: 'approved' | 'rejected'; by: string; selected?: string }>;
}): GateResolver {
  return async ({ nodeId, prompt, waitId, runDir, hostApproval }) => {
    const wait = writePendingWait(runDir, { waitId, nodeId, prompt, ...(hostApproval ? { hostApproval } : {}) });
    const { resolution, by, selected } = await deps.awaitDecision(wait);
    const settled = resolveWaitOnce(runDir, waitId, resolution, by, selected);
    return {
      resolution: settled.wait.status === 'approved' ? 'approved' : 'rejected',
      by: settled.wait.by ?? by,
      selected: settled.wait.selected,
    };
  };
}
