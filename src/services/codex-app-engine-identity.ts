import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { procStatStartTimeDigits } from '../utils/proc-stat.js';

export interface CodexAppEngineIdentity {
  pid: number;
  procStart: string;
}

/** A local wait retired; it is not a semantic rejection of a replayed frame. */
export class CodexAppEngineRootWaitCancelled extends Error {
  constructor(
    readonly ownerSocket: object | undefined,
    readonly ownerBackend: object | null,
    readonly ownerChannel: number,
  ) {
    super('Codex App engine root wait was retired');
    this.name = 'CodexAppEngineRootWaitCancelled';
  }
}

/** Syntax only: a signed namespace-local claim is not yet a host identity. */
export function parseCodexAppEngineIdentityClaim(value: unknown): CodexAppEngineIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'pid' && key !== 'procStart')
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 1
    || typeof record.procStart !== 'string' || !/^\d+$/.test(record.procStart)
    || record.procStart.length > 64) return undefined;
  return { pid: record.pid as number, procStart: record.procStart };
}

/** Only call on an authenticated, signed runner payload. Resolve the runner's
 * namespace-local child PID inside the backend's HOST process tree. Never
 * interpret it as an ambient host PID: bwrap uses --unshare-pid, and an
 * unrelated host process can have the same number. */
export function verifyCodexAppEngineIdentity(
  value: unknown,
  rootPid: number | undefined,
  procRoot = '/proc',
  readProcFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): CodexAppEngineIdentity | undefined {
  const record = parseCodexAppEngineIdentityClaim(value);
  if (!record) return undefined;
  if (typeof rootPid !== 'number' || !Number.isSafeInteger(rootPid) || rootPid <= 1) return undefined;
  const readStart = (pid: number): string | undefined => {
    try {
      return procStatStartTimeDigits(readProcFile(join(procRoot, String(pid), 'stat')));
    } catch { return undefined; }
  };
  const rootStart = readStart(rootPid);
  if (!rootStart) return undefined;
  const pending: Array<{ pid: number; ancestors: CodexAppEngineIdentity[] }> = [{ pid: rootPid, ancestors: [] }];
  const seen = new Set<number>();
  let match: CodexAppEngineIdentity | undefined;
  let matchLineage: CodexAppEngineIdentity[] = [];
  // Bound synchronous /proc work. An incomplete or ambiguous lookup is never
  // evidence that a namespace-local PID belongs to this generation.
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { pid: hostPid, ancestors } = pending[cursor]!;
    if (seen.has(hostPid)) continue;
    if (seen.size >= 256) return undefined;
    seen.add(hostPid);
    const start = readStart(hostPid);
    if (!start) continue; // exited while walking the tree
    const lineage = [...ancestors, { pid: hostPid, procStart: start }];
    const directory = join(procRoot, String(hostPid));
    try {
      const status = readProcFile(join(directory, 'status'));
      const nspid = status.match(/^NSpid:\s+([^\n]+)$/m)?.[1]?.trim().split(/\s+/);
      // The runner and its direct child share the innermost namespace. Older
      // kernels without NSpid still support the ordinary host-PID case.
      const childPid = nspid ? Number(nspid.at(-1)) : hostPid;
      if (childPid === record.pid && start === record.procStart) {
        if (match) return undefined;
        match = { pid: hostPid, procStart: start };
        matchLineage = lineage;
      }
      // A multithreaded runner may spawn from a non-leader task (e.g. Bun).
      for (const task of readdirSync(join(directory, 'task'))) {
        if (!/^\d+$/.test(task)) continue;
        try {
          const children = readProcFile(join(directory, 'task', task, 'children'));
          for (const child of children.trim().split(/\s+/)) {
            const pid = Number(child);
            if (Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) pending.push({ pid, ancestors: lineage });
          }
        } catch { /* task exited */ }
      }
    } catch { /* process exited or its namespace proof is unavailable */ }
  }
  // Short-lived tools elsewhere in the tree may exit during the scan. Only
  // the matched engine and its ancestry are evidence we must keep alive and
  // birth-token-bound; an unrelated leaf disappearing must not kill a session.
  return match && readStart(rootPid) === rootStart
    && matchLineage.every(identity => readStart(identity.pid) === identity.procStart)
    ? match : undefined;
}
