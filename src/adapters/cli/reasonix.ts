import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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
    // 全进程表扫描：显式抬高 maxBuffer，防输出超过 Node 默认 1MiB 时 ENOBUFS。
    const raw = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
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
 * Find the session lease owned by the current CLI process tree. The lease file
 * is created at CLI startup, so its stem — the identifier `--resume` accepts —
 * is available before the first prompt. The npm launcher may add an
 * intermediate process; bwrap may add a PID namespace.
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

/**
 * Adapter for the Reasonix Bubble Tea TUI.
 *
 * Reasonix does not emit a stable ready marker after each turn, so input uses
 * the standard quiescence detector. Sessions live under
 * `~/.reasonix/projects/<cwd-hash>/sessions`. The lease pid identifies the
 * session file owned by this process tree, and its stem — the same identifier
 * `--resume` accepts, alongside a transcript path or a free-text query — is
 * persisted as the cliSessionId. `reasonix session list` is deliberately NOT
 * used: it reports opaque `session_<hmac>` machine ids that only the
 * `session show|status|recovery` query surface accepts, and it omits a session
 * until its first turn has been persisted. If capture fails, a later restart
 * opens a fresh session because cwd-scoped `--continue` can select another
 * topic's session.
 */
export function createReasonixAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'reasonix';
  let cachedBin: string | undefined;
  // A fresh spawn captures its own session stem on the first input that lands.
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
      // The lease exists from CLI startup, so the stem is already on disk by the
      // first submit. Stay armed until it resolves: an early miss must be retried
      // on the next input instead of costing the whole session its resume id.
      if (capturePending && pty.cliCwd && pty.cliPid) {
        const stem = findSessionStemForCli(reasonixSessionsDir(pty.cliCwd), pty.cliPid);
        if (stem) {
          capturePending = false;
          return { submitted: true, cliSessionId: stem };
        }
      }
    },

    /**
     * The stem is the transcript file name, so presence is a plain stat. A stem
     * whose `.jsonl` is absent is genuinely unresumable — before the first turn
     * persists, only the lease exists and `--resume <stem>` exits 1 with
     * `no session matches` — so answering false there correctly sends the worker
     * to a fresh session. Anything unrecognizable stays undefined.
     */
    checkResumeTargetExists({ cliSessionId, workingDir }) {
      if (!cliSessionId || !workingDir) return undefined;
      // A path or free-text query is not a stem; only stems can be checked here.
      if (cliSessionId.includes('/')) return undefined;
      try {
        return existsSync(join(reasonixSessionsDir(workingDir), `${cliSessionId}.jsonl`));
      } catch {
        return undefined;
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
