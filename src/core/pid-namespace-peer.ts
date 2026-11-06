import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ProcessIdentity } from './current-actor-attestation.js';
import { procStatFieldsAfterComm, procStatStartTimeDigits } from '../utils/proc-stat.js';

function procStart(pid: number, procRoot: string): string | undefined {
  try {
    return procStatStartTimeDigits(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
  } catch {
    return undefined;
  }
}

function procParent(pid: number, procRoot: string): number | undefined {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const parent = Number(procStatFieldsAfterComm(raw)?.[1]);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}

function descendsFrom(pid: number, ancestorPid: number, procRoot: string): boolean {
  const seen = new Set<number>();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    if (current === ancestorPid) return true;
    seen.add(current);
    const parent = procParent(current, procRoot);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function namespacePids(pid: number, procRoot: string): number[] | undefined {
  let status: string;
  try {
    status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
  } catch {
    return undefined;
  }
  const raw = status.match(/^NSpid:\s+(.+)$/m)?.[1];
  if (!raw) return undefined;
  const values = raw.trim().split(/\s+/).map(Number);
  return values.length > 0 && values.every(value => Number.isSafeInteger(value) && value > 0)
    ? values
    : undefined;
}

/** Resolve the single child that `unshare --pid --fork` placed in the new PID
 * namespace. The parent remains in the host PID namespace while it waits. */
export function resolvePidNamespaceRoot(
  unsharePid: number,
  procRoot = '/proc',
): ProcessIdentity | null {
  if (!Number.isSafeInteger(unsharePid) || unsharePid <= 1) return null;
  let raw: string;
  try {
    raw = readFileSync(
      join(procRoot, String(unsharePid), 'task', String(unsharePid), 'children'),
      'utf8',
    );
  } catch {
    return null;
  }
  const children = raw.trim().split(/\s+/).filter(Boolean).map(Number);
  if (children.length !== 1 || !Number.isSafeInteger(children[0]) || children[0]! <= 1) return null;
  const pid = children[0]!;
  const start = procStart(pid, procRoot);
  const nspids = namespacePids(pid, procRoot);
  if (!start || !nspids || nspids.length < 2 || nspids[0] !== pid || nspids.at(-1) !== 1) return null;
  return { pid, procStart: start };
}

/** Translate a process identity observed through a PID-namespace-local procfs
 * into the same live process's host identity. The peer PID is the value visible
 * from the network runner's PID namespace, while the task may live in a PID
 * namespace nested further below it (for example bwrap --unshare-pid). Match
 * that namespace depth and require the host process to descend from the runner,
 * so an equal local PID in an unrelated namespace cannot be accepted. */
export function mapPidNamespacePeerToHost(input: {
  namespaceRoot: ProcessIdentity;
  peer: ProcessIdentity;
  procRoot?: string;
}): ProcessIdentity | null {
  const procRoot = input.procRoot ?? '/proc';
  if (!Number.isSafeInteger(input.namespaceRoot.pid) || input.namespaceRoot.pid <= 1
    || !/^\d{1,64}$/.test(input.namespaceRoot.procStart)
    || !Number.isSafeInteger(input.peer.pid) || input.peer.pid <= 1
    || !/^\d{1,64}$/.test(input.peer.procStart)
    || procStart(input.namespaceRoot.pid, procRoot) !== input.namespaceRoot.procStart) {
    return null;
  }
  const rootNamespacePids = namespacePids(input.namespaceRoot.pid, procRoot);
  if (!rootNamespacePids || rootNamespacePids[0] !== input.namespaceRoot.pid
    || rootNamespacePids.at(-1) !== 1) return null;
  const visiblePidIndex = rootNamespacePids.length - 1;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const matches: ProcessIdentity[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const nspids = namespacePids(pid, procRoot);
    if (!nspids || nspids[0] !== pid || nspids[visiblePidIndex] !== input.peer.pid
      || !descendsFrom(pid, input.namespaceRoot.pid, procRoot)) continue;
    const start = procStart(pid, procRoot);
    if (start === input.peer.procStart) matches.push({ pid, procStart: start });
  }
  return matches.length === 1 ? matches[0]! : null;
}
