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

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** Atomic JSON write (tmp + rename) so a crash never leaves a torn wait file. */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** Write the initial `pending` wait file for a gate.  Overwrites any stale
 *  file at the same waitId (a re-dispatched gate). */
export function writePendingWait(
  runDir: string,
  input: { waitId: string; nodeId: string; prompt: string } &
    Partial<Pick<GateWait, 'options' | 'approveOptions' | 'approvers' | 'instanceId'>>,
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
    status: 'pending',
    createdAt: Date.now(),
  };
  atomicWriteJson(waitPath(runDir, input.waitId), wait);
  return wait;
}

/** Read a single wait file, or `undefined` if it doesn't exist. */
export function readWait(runDir: string, waitId: string): GateWait | undefined {
  const path = waitPath(runDir, waitId);
  if (!existsSync(path)) return undefined;
  return normalizeWaitFile(JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateWait>);
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
  const existing = readWait(runDir, waitId);
  if (!existing) throw new Error(`v3 human-gate: no pending wait "${waitId}" in ${runDir}`);
  const resolved: GateWait = { ...existing, status: resolution, resolvedAt: Date.now(), by, selected };
  atomicWriteJson(waitPath(runDir, waitId), resolved);
  return resolved;
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
      const wait = normalizeWaitFile(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Partial<GateWait>);
      if (wait.status === 'pending') out.push(wait);
    } catch {
      // skip a torn / unparseable wait file (mid-write crash)
    }
  }
  return out;
}

function normalizeWaitFile(raw: Partial<GateWait>): GateWait {
  const options = raw.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
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
  return async ({ nodeId, prompt, waitId, runDir }) => {
    const wait = writePendingWait(runDir, { waitId, nodeId, prompt });
    const { resolution, by, selected } = await deps.awaitDecision(wait);
    resolveWait(runDir, waitId, resolution, by, selected);
    return { resolution, by, selected };
  };
}
