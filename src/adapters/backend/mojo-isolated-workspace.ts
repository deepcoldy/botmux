/**
 * Per-session isolated workspaces for mojo HOST execution.
 *
 * Why this exists (review P0/P1, traex + Immortal): mojo's local execution
 * daemon is keyed by `hash(process.cwd())` — the daemon-id is
 * `${machine}-${user}-${ww(workspace)}` with `workspace = process.cwd()` of the
 * FIRST client that spawned it, and the daemon then serves every later client
 * whose cwd hashes the same. Two consequences botmux cannot accept:
 *
 *   1. the daemon (and every tool process it runs) lives OUTSIDE the per-turn
 *      containment tree — interrupting or closing a turn does not stop tools;
 *   2. the daemon freezes the ENV of whichever session started it — a later
 *      session in another chat executes tools that carry the first session's
 *      BOTMUX_SESSION_ID/CHAT_ID, so an agent-run `botmux send` would deliver
 *      into the wrong topic (verified live).
 *
 * The fix: give every session a physically distinct REAL directory as the
 * per-turn CLI cwd, so realpath is unique → daemon-id is unique → each session
 * gets its own daemon carrying its own env. A symlink does NOT work — Node's
 * `process.cwd()` returns the kernel realpath, so symlinks to a shared target
 * collapse back into one daemon (empirically verified; do not "simplify" this
 * back to symlinks).
 *
 * On explicit session close the session's daemon is reaped by scanning mojo's
 * own registry (`~/.mojo/daemons/<id>.json` = `{workspace, pid}`) for an entry
 * whose workspace equals the isolated directory's realpath. Scanning is
 * deliberate: deriving the id needs the machine-user prefix whose hostname
 * source inside mojo is unverified, while the workspace string comparison only
 * needs the same realpath the daemon itself recorded.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';

/** Raw (pre-realpath) isolated workspace directory for a botmux session. */
export function mojoIsolatedWorkspacePath(sessionId: string, home: string = homedir()): string {
    return join(home, '.botmux', 'mojo-workspaces', sessionId);
}

/**
 * Create (idempotently) and resolve the isolated workspace for a session.
 * Returns the REALPATH — the exact string mojo's daemon will record as its
 * workspace (macOS `/var` → `/private/var` style symlinks make the raw path and
 * the recorded workspace differ, so every consumer must use this value).
 */
export function ensureMojoIsolatedWorkspace(sessionId: string, home: string = homedir()): string {
    const raw = mojoIsolatedWorkspacePath(sessionId, home);
    mkdirSync(raw, { recursive: true });
    return realpathSync(raw);
}

/** mojo's workspace-hash (reverse-engineered, byte-verified against the live
 *  registry): h = h*31 + charCode | 0 over the string, unsigned, base36. */
export function mojoWorkspaceHash(workspace: string): string {
    let h = 0;
    for (const c of workspace) h = h * 31 + c.charCodeAt(0) | 0;
    return (h >>> 0).toString(36);
}

export type MojoDaemonReapResult =
    | { outcome: 'killed'; daemonId: string; pid: number; forced: boolean }
    | { outcome: 'not-found'; reason: string }
    | { outcome: 'mismatch'; daemonId: string; pid: number; reason: string };

export interface MojoDaemonReapDeps {
    daemonsDir: string;
    readdir: (dir: string) => string[];
    readFile: (path: string) => string;
    /** Sends a signal; must throw ESRCH-like on a missing pid (process.kill semantics). */
    kill: (pid: number, signal: NodeJS.Signals | 0) => void;
    /** Resolve the command line of a pid, or null when it does not exist. */
    pidCommand: (pid: number) => string | null;
    unlink: (path: string) => void;
    sleep: (ms: number) => Promise<void>;
}

function defaultPidCommand(pid: number): string | null {
    // Linux: /proc is authoritative. darwin has no /proc — `ps` output is the
    // only evidence available, which is weaker; the caller's log line says so.
    try {
        if (process.platform === 'linux') {
            return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' ');
        }
        return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf-8', timeout: 3_000,
        }).trim() || null;
    } catch {
        return null;
    }
}

export const defaultMojoDaemonReapDeps: MojoDaemonReapDeps = {
    daemonsDir: join(homedir(), '.mojo', 'daemons'),
    readdir: dir => readdirSync(dir),
    readFile: path => readFileSync(path, 'utf-8'),
    kill: (pid, signal) => { process.kill(pid, signal); },
    pidCommand: defaultPidCommand,
    unlink: path => unlinkSync(path),
    sleep: ms => new Promise<void>(r => setTimeout(r, ms)),
};

/**
 * Reap the daemon bound to `workspaceRealpath` (SIGTERM → bounded wait →
 * SIGKILL) and remove its registry file. Never throws: a reaping failure is an
 * availability loss (a leaked idle daemon), never a reason to fail a close —
 * the caller only logs the structured outcome.
 *
 * pid-reuse guard: the pid is signalled only when its live command line
 * contains `mojo` — a recycled pid belonging to something else is reported as
 * `mismatch` and left alone.
 */
export async function reapMojoIsolatedDaemon(
    workspaceRealpath: string,
    deps: MojoDaemonReapDeps = defaultMojoDaemonReapDeps,
): Promise<MojoDaemonReapResult> {
    let entries: string[];
    try {
        entries = deps.readdir(deps.daemonsDir).filter(f => f.endsWith('.json'));
    } catch {
        return { outcome: 'not-found', reason: 'daemon registry unreadable/absent' };
    }
    for (const file of entries) {
        let parsed: { workspace?: unknown; pid?: unknown };
        try {
            parsed = JSON.parse(deps.readFile(join(deps.daemonsDir, file))) as typeof parsed;
        } catch {
            continue;
        }
        if (parsed.workspace !== workspaceRealpath) continue;
        const daemonId = file.replace(/\.json$/, '');
        const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN;
        const registryFile = join(deps.daemonsDir, file);
        if (!Number.isInteger(pid) || pid <= 0) {
            try { deps.unlink(registryFile); } catch { /* ENOENT is fine */ }
            return { outcome: 'not-found', reason: `registry entry ${daemonId} carries no valid pid` };
        }
        const command = deps.pidCommand(pid);
        if (command === null) {
            // Daemon already gone; just clear the stale registry row.
            try { deps.unlink(registryFile); } catch { /* ENOENT is fine */ }
            return { outcome: 'not-found', reason: `pid ${pid} not running` };
        }
        if (!command.includes('mojo')) {
            // Recycled pid — belongs to something else now. Never signal it.
            return { outcome: 'mismatch', daemonId, pid, reason: `pid ${pid} command is not a mojo daemon` };
        }
        let forced = false;
        try { deps.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        for (let waited = 0; waited < 2_000; waited += 200) {
            await deps.sleep(200);
            try { deps.kill(pid, 0); } catch { break; }
        }
        try {
            deps.kill(pid, 0);
            deps.kill(pid, 'SIGKILL');
            forced = true;
        } catch { /* exited on SIGTERM */ }
        try { deps.unlink(registryFile); } catch { /* daemon may have cleaned up */ }
        return { outcome: 'killed', daemonId, pid, forced };
    }
    return { outcome: 'not-found', reason: 'no registry entry matches this workspace' };
}

/**
 * Full close-time cleanup for one botmux session: reap its daemon (when the
 * isolated dir ever existed) and remove the directory. Shared by
 * MojoBackend.destroySession() and the daemon's workerless close path.
 */
export async function cleanupMojoIsolatedWorkspace(
    sessionId: string,
    opts: { home?: string; deps?: MojoDaemonReapDeps } = {},
): Promise<void> {
    const raw = mojoIsolatedWorkspacePath(sessionId, opts.home);
    let real: string | null = null;
    try {
        if (existsSync(raw)) real = realpathSync(raw);
    } catch { /* raced away — nothing to reap */ }
    if (real) {
        const result = await reapMojoIsolatedDaemon(real, opts.deps);
        // darwin has no /proc: even 'killed' rests on ps evidence, not an
        // unforgeable proof — say so instead of overclaiming.
        const evidence = process.platform === 'linux' ? '/proc' : 'ps (weak evidence, no /proc)';
        switch (result.outcome) {
            case 'killed':
                logger.info(
                    `[mojo] session ${sessionId}: isolated daemon ${result.daemonId} (pid ${result.pid}) `
                    + `reaped${result.forced ? ' via SIGKILL' : ''} — verified by ${evidence}`,
                );
                break;
            case 'mismatch':
                logger.warn(
                    `[mojo] session ${sessionId}: refusing to signal pid ${result.pid} `
                    + `(${result.reason}) — registry row ${result.daemonId} left for manual inspection`,
                );
                break;
            case 'not-found':
                logger.info(`[mojo] session ${sessionId}: no isolated daemon to reap (${result.reason})`);
                break;
        }
    }
    try {
        rmSync(raw, { recursive: true, force: true });
    } catch (err) {
        logger.warn(`[mojo] session ${sessionId}: isolated workspace cleanup failed: ${(err as Error).message}`);
    }
}
