import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

const LEASE_SUFFIX = '.jsonl.lease.json';

/** Return the Reasonix session directory for a working directory. */
export function reasonixSessionsDir(cwd: string, sessionRoot = join(homedir(), '.reasonix')): string {
  // Reasonix hashes getcwd(3), so resolve symlinks before deriving the bucket.
  // Keep the supplied path when it has disappeared during teardown.
  let canonicalCwd = cwd;
  try { canonicalCwd = realpathSync(cwd); } catch { /* best effort */ }
  return join(sessionRoot, 'projects', canonicalCwd.replaceAll('/', '-'), 'sessions');
}

/**
 * Check whether pid belongs to ancestorPid's process tree. Linux reads the
 * parent chain from procfs; other POSIX platforms use one `ps` snapshot.
 */
export function isDescendantOf(pid: number, ancestorPid: number): boolean {
  if (pid === ancestorPid) return true;
  if (process.platform === 'linux') {
    let cur = pid;
    for (let depth = 0; depth < 16; depth++) {
      try {
        const stat = readFileSync(`/proc/${cur}/stat`, 'utf-8');
        // `comm` may contain spaces and `)`, so split after its final `)`.
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(after[1]);
        if (!Number.isFinite(ppid)) return false;
        if (ppid === ancestorPid) return true;
        if (ppid <= 1) return false;
        cur = ppid;
      } catch {
        return false;
      }
    }
    return false;
  }
  try {
    const raw = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' });
    const ppidOf = new Map<number, number>();
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ppidOf.set(Number(m[1]), Number(m[2]));
    }
    let cur: number | undefined = pid;
    for (let depth = 0; depth < 16 && cur !== undefined; depth++) {
      const parent = ppidOf.get(cur);
      if (parent === undefined) return false;
      if (parent === ancestorPid) return true;
      cur = parent;
    }
    return false;
  } catch {
    return false;
  }
}

/** Match a lease pid against a host process tree, including nested PID namespaces. */
export function pidBelongsToProcessTree(pid: number, rootPid: number, procRoot = '/proc'): boolean {
  if (isDescendantOf(pid, rootPid)) return true;
  if (process.platform !== 'linux') return false;

  const pending = [rootPid];
  const seen = new Set<number>();
  for (let scanned = 0; pending.length > 0 && scanned < 256; scanned++) {
    const hostPid = pending.shift()!;
    if (seen.has(hostPid)) continue;
    seen.add(hostPid);
    try {
      const status = readFileSync(join(procRoot, String(hostPid), 'status'), 'utf-8');
      const nspid = status.match(/^NSpid:\s+(.+)$/m)?.[1]
        ?.trim().split(/\s+/).map(Number).filter(Number.isFinite) ?? [];
      if (nspid.includes(pid)) return true;
    } catch { /* process may exit during the scan */ }
    try {
      const children = readFileSync(join(procRoot, String(hostPid), 'task', String(hostPid), 'children'), 'utf-8');
      for (const child of children.trim().split(/\s+/)) {
        const childPid = Number(child);
        if (Number.isFinite(childPid) && childPid > 0 && !seen.has(childPid)) pending.push(childPid);
      }
    } catch { /* leaf or exited process */ }
  }
  return false;
}

/**
 * Find the session lease owned by the current CLI process tree. The npm
 * launcher may add an intermediate process; bwrap may add a PID namespace.
 */
export function findSessionStemForCli(sessionsDir: string, cliPid: number): string | undefined {
  let files: string[];
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return undefined;
  }
  for (const f of files) {
    if (!f.endsWith(LEASE_SUFFIX)) continue;
    try {
      const lease = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8')) as { pid?: number };
      if (lease.pid !== undefined && pidBelongsToProcessTree(lease.pid, cliPid)) {
        return f.slice(0, -LEASE_SUFFIX.length);
      }
    } catch { /* ignore incomplete lease files */ }
  }
  return undefined;
}

/** Read the timestamp used to correlate a session file with `session list`. */
export function readSessionMetaCreatedAt(sessionsDir: string, stem: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(sessionsDir, `${stem}.jsonl.meta`), 'utf-8')) as { created_at?: string };
    return meta.created_at;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the machine session id owned by cliPid. The lease identifies the
 * session file; its created_at value identifies the corresponding entry in
 * `reasonix session list`. This remains scoped when several sessions share cwd.
 */
export function captureSessionIdForCli(
  bin: string,
  cwd: string,
  cliPid: number,
  opts: { tries?: number; delayMs?: number; sessionRoot?: string } = {},
): Promise<string | undefined> {
  const { tries = 3, delayMs = 500, sessionRoot } = opts;
  const sessionsDir = reasonixSessionsDir(cwd, sessionRoot);
  const attempt = (): Promise<string | undefined> => {
    const stem = findSessionStemForCli(sessionsDir, cliPid);
    const metaCreatedAt = stem ? readSessionMetaCreatedAt(sessionsDir, stem) : undefined;
    if (!metaCreatedAt) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      execFile(bin, ['session', 'list', '--json', '--project-root', cwd], { timeout: 8_000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        try {
          const parsed = JSON.parse(stdout) as { sessions?: Array<{ id?: string; created_at?: string }> };
          const match = (parsed.sessions ?? []).find(s => s.id && s.created_at === metaCreatedAt);
          if (match?.id) return resolve(match.id);
          resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  };
  return (async () => {
    for (let currentTry = 0; currentTry < tries; currentTry++) {
      const id = await attempt();
      if (id) return id;
      if (currentTry + 1 < tries) await delay(delayMs);
    }
    return undefined;
  })();
}

/**
 * Adapter for the Reasonix Bubble Tea TUI.
 *
 * Reasonix does not emit a stable ready marker after each turn, so input uses
 * the standard quiescence detector. Sessions live under
 * `~/.reasonix/projects/<cwd-hash>/sessions`. After the first input, the lease
 * pid and metadata timestamp are used to capture the opaque machine session id.
 * Restarts use that id with `--resume`. If capture fails, a later restart opens
 * a fresh session because cwd-scoped `--continue` can select another topic's
 * session.
 */
export function createReasonixAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'reasonix';
  let cachedBin: string | undefined;
  // A fresh spawn captures its native session id after the first input.
  let capturePending = false;
  return {
    id: 'reasonix',
    // Config, machine identity, sessions, leases, and skills share this root.
    authPaths: ['~/.reasonix'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, model, disableCliBypass }) {
      // A missing native id cannot be recovered safely from cwd alone.
      const preciseResume = resume && !!resumeSessionId;
      capturePending = !preciseResume;
      const args: string[] = [];
      if (!disableCliBypass) {
        args.push('--yolo');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (preciseResume) return [...args, '--resume', resumeSessionId];
      return args;
    },

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `reasonix --resume ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        if (pty.sendText(content) === false) return { submitted: false };
        await delay(200);
        if (pty.sendSpecialKeys('Enter') === false) return { submitted: false };
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
      // The first submitted prompt creates the session files needed for capture.
      if (capturePending && pty.cliCwd && pty.cliPid) {
        capturePending = false;
        const cliSessionId = await captureSessionIdForCli(cachedBin ?? rawBin, pty.cliCwd, pty.cliPid);
        if (cliSessionId) return { submitted: true, cliSessionId };
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    // Reasonix 1.19.3 always enters the alternate screen and provides no
    // no-alt-screen option. Its transcript lives in the Bubble Tea viewport,
    // so tmux has no scrollback available for transcript paging.
    altScreen: true,
    skillsDir: '~/.reasonix/skills',
    modelChoices: [
      'deepseek-flash/deepseek-v4-flash',
      'deepseek-pro/deepseek-v4-pro',
    ],
  };
}

export const create = createReasonixAdapter;
