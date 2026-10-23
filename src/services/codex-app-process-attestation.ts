import { readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { collectSessionLineagePids } from '../core/preview-port-owner.js';
import { procStatFieldsAfterComm, procStatStartTimeDigits } from '../utils/proc-stat.js';

export interface CodexAppProcessIdentity {
  launcherPid: number;
  launcherProcStart: string;
  enginePid: number;
  engineProcStart: string;
}

function start(pid: number, procRoot: string): string | undefined {
  try { return procStatStartTimeDigits(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')); }
  catch { return undefined; }
}

/** Capture the actual native app-server behind the npm launcher, before model
 * input is admitted. Kernel ancestry and the inherited RPC stdio pair bind the
 * native process to the child the trusted runner spawned; argv alone is not a
 * process proof. Ambiguous, vanished and unsupported runtimes stay unproven. */
export function captureCodexAppProcessIdentity(
  launcherPid: number, procRoot = '/proc',
): CodexAppProcessIdentity | undefined {
  if ((procRoot === '/proc' && process.platform !== 'linux')
    || !Number.isSafeInteger(launcherPid) || launcherPid <= 1) return undefined;
  const launcherProcStart = start(launcherPid, procRoot);
  if (!launcherProcStart) return undefined;
  try {
    const stdio = [0, 1].map(fd => readlinkSync(join(procRoot, String(launcherPid), 'fd', String(fd))));
    if (stdio.some(fd => !/^(pipe|socket):\[\d+\]$/.test(fd))) return undefined;
    const pids = collectSessionLineagePids(procRoot, [launcherPid]);
    if (!pids) return undefined;
    const candidates: CodexAppProcessIdentity[] = [];
    for (const enginePid of pids) {
      try {
        const engineProcStart = start(enginePid, procRoot);
        if (!engineProcStart || basename(readlinkSync(join(procRoot, String(enginePid), 'exe'))) !== 'codex') continue;
        const raw = readFileSync(join(procRoot, String(enginePid), 'cmdline'), 'utf8');
        const argv = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : [];
        if (argv.length !== 4 || argv[1] !== 'app-server' || argv[2] !== '--listen' || argv[3] !== 'stdio://') continue;
        if (!stdio.every((fd, index) => readlinkSync(join(procRoot, String(enginePid), 'fd', String(index))) === fd)) continue;
        if (start(enginePid, procRoot) !== engineProcStart) return undefined;
        candidates.push({ launcherPid, launcherProcStart, enginePid, engineProcStart });
      } catch { /* an unrelated descendant may exit during enumeration */ }
    }
    return candidates.length === 1 && start(launcherPid, procRoot) === launcherProcStart
      ? candidates[0] : undefined;
  } catch { return undefined; }
}

/** Called only for an authenticated, signed runner state. Recheck its claimed
 * processes against the live backend root and proc start tokens, rather than
 * promoting a PID supplied in an environment variable or an unsigned marker. */
export function verifyCodexAppProcessIdentity(
  value: unknown, backendPid: number | undefined, procRoot = '/proc',
): CodexAppProcessIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !backendPid) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'enginePid,engineProcStart,launcherPid,launcherProcStart'
    || !Number.isSafeInteger(v.launcherPid) || (v.launcherPid as number) <= 1
    || !Number.isSafeInteger(v.enginePid) || (v.enginePid as number) <= 1
    || typeof v.launcherProcStart !== 'string' || !/^\d+$/.test(v.launcherProcStart)
    || typeof v.engineProcStart !== 'string' || !/^\d+$/.test(v.engineProcStart)) return undefined;
  const rootStart = start(backendPid, procRoot);
  const pids = collectSessionLineagePids(procRoot, [backendPid]);
  if (!rootStart || !pids?.has(v.launcherPid as number)) return undefined;
  const captured = captureCodexAppProcessIdentity(v.launcherPid as number, procRoot);
  return captured && captured.launcherProcStart === v.launcherProcStart
    && captured.enginePid === v.enginePid && captured.engineProcStart === v.engineProcStart
    && start(backendPid, procRoot) === rootStart ? captured : undefined;
}

/** Warm reattach to an older signed runner which cannot report the new field.
 * Locate only the exact Botmux runner executable/session under the attested
 * backend, then its directly spawned RPC launcher. A duplicate or an unrelated
 * Codex process never becomes an execution root. Callers must first verify the
 * signed control connection; this is not an alternative authorization entry. */
export function captureAttachedCodexAppProcessIdentity(
  backendPid: number | undefined, sessionId: string, runnerExecutable: string, procRoot = '/proc',
): CodexAppProcessIdentity | undefined {
  if (!backendPid || !sessionId || (procRoot === '/proc' && process.platform !== 'linux')) return undefined;
  const rootStart = start(backendPid, procRoot);
  const pids = collectSessionLineagePids(procRoot, [backendPid]);
  if (!rootStart || !pids) return undefined;
  const runners: number[] = [];
  for (const pid of pids) {
    try {
      const exe = readlinkSync(join(procRoot, String(pid), 'exe')).replace(/ \(deleted\)$/, '');
      if (exe !== runnerExecutable.replace(/ \(deleted\)$/, '')) continue;
      const argv = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0');
      // Compiled runner and source runner respectively. The kernel executable
      // check above is independent of this argv/session-shape check.
      const index = argv.indexOf('__codex-app-runner');
      if ((index !== 1 && index !== 2) || argv[index + 1] !== '--session-id' || argv[index + 2] !== sessionId) continue;
      runners.push(pid);
    } catch { /* disappeared candidate */ }
  }
  if (runners.length !== 1) return undefined;
  const candidates: CodexAppProcessIdentity[] = [];
  for (const pid of pids) {
    try {
      const fields = procStatFieldsAfterComm(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
      if (Number(fields?.[1]) !== runners[0]) continue;
      const identity = captureCodexAppProcessIdentity(pid, procRoot);
      if (identity) candidates.push(identity);
    } catch { /* disappeared child */ }
  }
  return candidates.length === 1 && start(backendPid, procRoot) === rootStart
    ? verifyCodexAppProcessIdentity(candidates[0], backendPid, procRoot) : undefined;
}
