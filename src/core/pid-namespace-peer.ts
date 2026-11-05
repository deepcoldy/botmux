import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { ProcessIdentity } from './current-actor-attestation.js';
import { procStatStartTimeDigits } from '../utils/proc-stat.js';

function procStart(pid: number, procRoot: string): string | undefined {
  try {
    return procStatStartTimeDigits(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
  } catch {
    return undefined;
  }
}

function pidNamespace(pid: number, procRoot: string): string | undefined {
  try {
    return readlinkSync(join(procRoot, String(pid), 'ns', 'pid'));
  } catch {
    return undefined;
  }
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
 * into the same live process's host identity. Start time is global across PID
 * namespaces; matching it together with the namespace inode prevents a PID
 * collision in a sibling namespace from being accepted. */
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
  const wantedNamespace = pidNamespace(input.namespaceRoot.pid, procRoot);
  if (!wantedNamespace) return null;
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
    if (!nspids || nspids[0] !== pid || nspids.at(-1) !== input.peer.pid
      || pidNamespace(pid, procRoot) !== wantedNamespace) continue;
    const start = procStart(pid, procRoot);
    if (start === input.peer.procStart) matches.push({ pid, procStart: start });
  }
  return matches.length === 1 ? matches[0]! : null;
}
