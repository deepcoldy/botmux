import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { collectSessionLineagePids } from '../core/preview-port-owner.js';
import { procStatFieldsAfterComm, procStatStartTimeDigits } from '../utils/proc-stat.js';
import { parseArgs, type Args } from '../dsh-runner-args.js';

export interface DshProcessIdentity {
  runnerPid: number;
  runnerProcStart: string;
  enginePid: number;
  engineProcStart: string;
}

/** An unlinked, inherited fd binds the RPC child to its trusted runner without
 * trusting a PID from terminal output. Keep the runner's copy open until exit.
 * Other platforms retain their existing behavior without a weaker proof. */
export function createDshProcessAttestationFd(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  let dir: string | undefined;
  let path: string | undefined;
  let fd: number | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'botmux-dsh-attestation-'));
    path = join(dir, 'proof');
    fd = openSync(path, 'wx+', 0o600);
    if (!fstatSync(fd).isFile()) throw new Error('Invalid DSH attestation fd');
    unlinkSync(path);
    return fd;
  } catch {
    // Attestation is additive: without a proof the engine gets no extra trust,
    // but the pre-attestation SDK launch must remain available.
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup after setup failure */ }
    }
    return undefined;
  } finally {
    if (path) {
      try { unlinkSync(path); } catch { /* already unlinked or setup failed */ }
    }
    if (dir) {
      try { rmdirSync(dir); } catch { /* already removed or setup failed */ }
    }
  }
}

function processStat(pid: number, root: string): { start: string; parent: number } | undefined {
  try {
    const raw = readFileSync(join(root, String(pid), 'stat'), 'utf8');
    const fields = procStatFieldsAfterComm(raw);
    const start = procStatStartTimeDigits(raw);
    const parent = Number(fields?.[1]);
    return start && !['Z', 'X'].includes(fields?.[0] ?? '') && Number.isSafeInteger(parent)
      ? { start, parent } : undefined;
  } catch { return undefined; }
}

function argv(pid: number, root: string): string[] {
  const raw = readFileSync(join(root, String(pid), 'cmdline'), 'utf8');
  return raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : [];
}

function equalArgs(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function launchContract(args: readonly string[]): Args | undefined {
  // These fields select the session and executable composition. The native
  // parser accepts last-wins duplicates; a process proof must reject them.
  for (const flag of ['--session-id', '--dsh-bin', '--dsh-profile', '--bridge-patch']) {
    if (args.filter(value => value === flag).length > 1) return undefined;
  }
  try { return parseArgs([...args]); } catch { return undefined; }
}

function stillDescendsFrom(pid: number, rootPid: number, procRoot: string): boolean {
  const path = new Map<number, { start: string; parent: number }>();
  for (let current = pid; current > 1 && path.size < 256;) {
    if (path.has(current)) return false;
    const stat = processStat(current, procRoot);
    if (!stat) return false;
    path.set(current, stat);
    if (current === rootPid) {
      return [...path].every(([seen, before]) => {
        const after = processStat(seen, procRoot);
        return after?.start === before.start && after.parent === before.parent;
      });
    }
    current = stat.parent;
  }
  return false;
}

/** Kernel-only discovery for the exact adapter launch, including warm reattach.
 * Model discovery children lack the inherited fd and their argv differs.
 * An unsigned readiness marker can request this check, never choose its PID.
 * The worker freezes the first proof for its CLI generation. Warm workers can
 * reconstruct different display/model/watchdog settings for a surviving pane;
 * compare only the executable entry and session/composition contract. */
export function captureDshProcessIdentity(
  backendPid: number | undefined, runnerExecutable: string, runnerArgs: readonly string[], procRoot = '/proc',
): DshProcessIdentity | undefined {
  if ((procRoot === '/proc' && process.platform !== 'linux')
    || !backendPid || !Number.isSafeInteger(backendPid) || backendPid <= 1) return undefined;
  const rootStat = processStat(backendPid, procRoot);
  const pids = collectSessionLineagePids(procRoot, [backendPid]);
  if (!rootStat || !pids || runnerArgs.length < 5) return undefined;
  const entryLength = runnerArgs.indexOf('--session-id');
  const expected = launchContract(runnerArgs);
  const dshBin = expected?.dshBin;
  if (entryLength < 1 || !dshBin || !isAbsolute(dshBin)) return undefined;
  const profile = expected.dshProfile?.trim() || 'botmux';
  const launchArgs = ['--profile', profile];
  if (expected.bridgePatch) launchArgs.push(`--patch=${expected.bridgePatch}`);
  try {
    const runners = [...pids].filter(pid => {
      try {
        const actualArgs = argv(pid, procRoot).slice(1);
        const actual = launchContract(actualArgs.slice(entryLength));
        return readlinkSync(join(procRoot, String(pid), 'exe')).replace(/ \(deleted\)$/, '')
          === runnerExecutable.replace(/ \(deleted\)$/, '')
          && equalArgs(actualArgs.slice(0, entryLength), runnerArgs.slice(0, entryLength))
          && actual?.sessionId === expected.sessionId && actual.dshBin === dshBin
          && (actual.dshProfile?.trim() || 'botmux') === profile
          && actual.bridgePatch === expected.bridgePatch;
      } catch { return false; }
    });
    if (runners.length !== 1) return undefined;
    const runnerPid = runners[0]!;
    const runnerStat = processStat(runnerPid, procRoot);
    if (!runnerStat) return undefined;
    const runnerFds = readdirSync(join(procRoot, String(runnerPid), 'fd'));
    const candidates: DshProcessIdentity[] = [];
    for (const enginePid of pids) {
      const engineStat = processStat(enginePid, procRoot);
      if (!engineStat || engineStat.parent !== runnerPid) continue;
      try {
        const exe = readlinkSync(join(procRoot, String(enginePid), 'exe')).replace(/ \(deleted\)$/, '');
        const engineArgs = argv(enginePid, procRoot);
        const native = exe === dshBin && equalArgs(engineArgs.slice(1), launchArgs);
        const node = ['node', 'nodejs'].includes(basename(exe))
          && equalArgs(engineArgs.slice(1), [dshBin, ...launchArgs]);
        if (!native && !node) continue;
        const fdPath = join(procRoot, String(enginePid), 'fd', '3');
        if (!/\/botmux-dsh-attestation-[^/]+\/proof \(deleted\)$/.test(readlinkSync(fdPath))) continue;
        const proof = statSync(fdPath);
        if (!proof.isFile() || proof.nlink !== 0 || proof.mode & 0o077) continue;
        if (!runnerFds.some(fd => {
          if (!/^\d+$/.test(fd) || Number(fd) < 3) return false;
          try {
            const held = statSync(join(procRoot, String(runnerPid), 'fd', fd));
            return held.isFile() && held.nlink === 0 && held.dev === proof.dev && held.ino === proof.ino;
          } catch { return false; }
        })) continue;
        const stdio = [0, 1].map(fd => readlinkSync(join(procRoot, String(enginePid), 'fd', String(fd))));
        if (stdio.some(fd => !/^(pipe|socket):\[\d+\]$/.test(fd)) || stdio[0] === stdio[1]) continue;
        const checked = processStat(enginePid, procRoot);
        if (checked?.start !== engineStat.start || checked.parent !== runnerPid) return undefined;
        candidates.push({ runnerPid, runnerProcStart: runnerStat.start, enginePid, engineProcStart: engineStat.start });
      } catch { /* exited or inaccessible: no authority */ }
    }
    return candidates.length === 1 && processStat(runnerPid, procRoot)?.start === runnerStat.start
      && processStat(backendPid, procRoot)?.start === rootStat.start
      && stillDescendsFrom(candidates[0]!.enginePid, backendPid, procRoot) ? candidates[0] : undefined;
  } catch { return undefined; }
}
