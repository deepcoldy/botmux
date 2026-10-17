import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexAppProcessAttestation {
  runnerPid: number;
  runnerProcStart: string;
  enginePid: number;
  engineProcStart: string;
}

function readProcess(pid: number, procRoot: string): { parent: number; start: string } | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const parent = Number(fields[1]);
    if (!Number.isSafeInteger(parent) || !/^\d+$/.test(fields[19] ?? '') || fields[0] === 'Z') return undefined;
    return { parent, start: fields[19] };
  } catch { return undefined; }
}

function belongsTo(pid: number, root: number, procRoot: string): boolean {
  for (let depth = 0; depth < 32 && pid > 0; depth++) {
    if (pid === root) return true;
    const process = readProcess(pid, procRoot);
    if (!process || process.parent === pid) return false;
    pid = process.parent;
  }
  return false;
}

/** Capture at initialization, not when replaying a marker: PID reuse must never acquire
 * the replacement process's birth identity. Current-execution uses Linux procfs. */
export function captureCodexAppProcessAttestation(
  runnerPid: number,
  enginePid: number | undefined,
  procRoot = '/proc',
): CodexAppProcessAttestation | undefined {
  if (enginePid === undefined) return undefined;
  const runner = readProcess(runnerPid, procRoot);
  const engine = readProcess(enginePid, procRoot);
  if (!runner || !engine || enginePid === runnerPid || !belongsTo(enginePid, runnerPid, procRoot)) return undefined;
  return { runnerPid, runnerProcStart: runner.start, enginePid, engineProcStart: engine.start };
}

/** Only call after the runner marker's session/generation/signature/sequence
 * has been authenticated. The kernel must independently confirm both births,
 * the app-server's ancestry, and the runner's current backend lineage. */
export function verifyCodexAppProcessAttestation(
  payload: unknown,
  cliPid: number | undefined,
  procRoot = '/proc',
): CodexAppProcessAttestation | undefined {
  if (!payload || typeof payload !== 'object' || cliPid === undefined) return undefined;
  const value = payload as CodexAppProcessAttestation;
  const captured = captureCodexAppProcessAttestation(value.runnerPid, value.enginePid, procRoot);
  if (captured && captured.runnerProcStart === value.runnerProcStart
    && captured.engineProcStart === value.engineProcStart && belongsTo(value.runnerPid, cliPid, procRoot)) return captured;
  // A sandbox's procfs reports namespace-local PIDs. Resolve those to the
  // worker's PID namespace using kernel NSpid + birth identity, constrained to
  // this backend's tree. Never accept an ambient same-uid process or guess on
  // multiple matches. Both runtime roots must inhabit the same PID namespace.
  const runners = namespaceCandidates(value.runnerPid, value.runnerProcStart, cliPid, procRoot);
  if (runners.length !== 1) return undefined;
  const runnerPid = runners[0];
  const engines = namespaceCandidates(value.enginePid, value.engineProcStart, runnerPid, procRoot);
  if (engines.length !== 1 || engines[0] === runnerPid) return undefined;
  try {
    if (readlinkSync(join(procRoot, String(runnerPid), 'ns/pid'))
      !== readlinkSync(join(procRoot, String(engines[0]), 'ns/pid'))) return undefined;
  } catch { return undefined; }
  return captureCodexAppProcessAttestation(runnerPid, engines[0], procRoot);
}

function namespaceCandidates(localPid: number, start: string, rootPid: number, procRoot: string): number[] {
  if (!Number.isSafeInteger(localPid) || localPid < 1 || typeof start !== 'string' || !/^\d+$/.test(start)) return [];
  try {
    return readdirSync(procRoot).filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
      const process = readProcess(pid, procRoot);
      if (!process || process.start !== start || !belongsTo(pid, rootPid, procRoot)) return false;
      try {
        const status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
        const ids = status.match(/^NSpid:\s*(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
        return ids?.at(-1) === localPid;
      } catch { return false; }
    });
  } catch { return []; }
}
