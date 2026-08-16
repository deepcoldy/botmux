/**
 * A containment handle: the thing that still identifies a mojo turn's process
 * subtree AFTER the backend object that spawned it is gone.
 *
 * Why this module exists
 * ---------------------
 * mojo-process-tree.ts can enumerate a subtree, but only while someone still
 * remembers two facts: the root pid, and the env nonce that was injected into it.
 * Both used to live in per-instance MojoBackend fields (`lastTurnPid`, a
 * `readonly treeNonce` freshly randomised in the field initialiser). Every worker
 * generation therefore got a BRAND NEW nonce and a null root pid, which means a
 * subtree left behind by the previous generation became permanently
 * unenumerable — and `terminateChildProven()` reads "no root pid" as "no subtree
 * exists" and returns true. A credentialed survivor thus turned into a
 * successful close, the row was published `closed`, and the device-isolation
 * blocker vanished (mergePersistedDeviceIsolationSessions filters closed rows).
 *
 * So the handle has to outlive the backend, the worker generation and the daemon
 * process. That is what this module provides, plus the ONE rule that makes it
 * safe:
 *
 *   a handle may only be released when quiescence is PROVEN.
 *
 * Two strengths of handle
 * -----------------------
 *   STRONG (`cgroup`) — a per-session cgroup v2 directory. Membership is kernel
 *     state that no same-user child can forge, unlink or setsid its way out of,
 *     and `cgroup.procs` being empty is real proof. This is the only kind that
 *     closes the trust gap documented in mojo-process-tree.
 *
 *   WEAK (`tree-identity`) — a persisted (rootPid, bootId, startTime, nonce)
 *     record for hosts with no usable cgroup v2 (this includes cgroup-v1-only
 *     hosts and Darwin). It is EVIDENCE THAT A TREE MAY STILL EXIST, never proof
 *     that one is gone. `bootId` + `startTime` exist so that pid REUSE cannot be
 *     mistaken for the original tree (and, in the one genuinely provable
 *     direction, so that a reboot can be recognised as having killed it).
 *
 * Fail-closed, in the same direction as the rest of the isolation path
 * -------------------------------------------------------------------
 * Unreadable state, an unsupported platform, a timeout, or any "cannot tell"
 * answer resolves to NOT PROVEN, so the caller keeps the blocker. This matches
 * the scanner's fail-closed contract (a read error fails the whole scan) and the
 * destroy contract's `local-unproven` staying fenced. `mojo-launcher-env-quarantine`
 * deliberately shipped with no clearing API because "proving that needs
 * trustworthy termination of the whole mojo process group ... which does not
 * exist yet"; `proveContainmentQuiescent` is that missing mechanism, which is why
 * releasing is allowed here and only against a proven verdict.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { TurnQuiescence } from '../adapters/backend/mojo-process-tree.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';

const FILE_NAME = 'mojo-containment-handles.json';

/** Where per-session cgroups are created when the host supports cgroup v2. */
const CGROUP_ROOT = '/sys/fs/cgroup';
const CGROUP_SLICE = 'botmux.slice';

export interface StrongContainmentHandle {
    kind: 'cgroup';
    sessionId: string;
    /** Worker generation that acquired it; kept for operator-facing logs only. */
    generation: number;
    /** Absolute cgroup v2 directory owning the turn subtree. */
    cgroupPath: string;
    /** Env nonce injected into the tree, so a degraded scan can still corroborate. */
    nonce: string;
}

export interface WeakContainmentHandle {
    kind: 'tree-identity';
    sessionId: string;
    generation: number;
    rootPid: number;
    /** Boot identity, so a pid from a previous boot is never re-signalled. */
    bootId: string;
    /** `/proc/<pid>/stat` field 22, which makes pid reuse detectable. */
    startTime: number;
    nonce: string;
}

/**
 * A tree we can neither contain nor describe.
 *
 * Reached when the host offers NO usable mechanism: no cgroup v2 delegation, and
 * no readable boot id / starttime (a non-Linux host, or a locked-down /proc). The
 * turn still spawned a credentialed child, so the honest record is not "nothing to
 * track" — it is "something exists here that this host can never prove gone".
 *
 * Why this exists rather than returning null
 * -----------------------------------------
 * `acquireContainmentHandle` used to return null in this case, which meant the
 * caller recorded NOTHING and `hasUnprovenContainment()` answered false — so the
 * device-isolation blocker was not retained on exactly the platform that cannot
 * prove anything. That inverted the intended fail-closed direction, and it did so
 * silently, because "no handle" is indistinguishable from "no turn ever ran".
 *
 * An unprovable handle is deliberately a DEAD END: `proveContainmentQuiescent`
 * can never return `proven: true` for it, so the type-level guard on
 * `releaseContainmentHandle` makes it impossible to release. The session's blocker
 * therefore stays for the lifetime of the record, which is the correct answer when
 * a credentialed subtree existed and the host cannot ever demonstrate its death.
 *
 * The platform is recorded so an operator can tell "macOS, no cgroups" apart from
 * "Linux with /proc unreadable" without re-deriving it.
 */
export interface UnprovableContainmentHandle {
    kind: 'unprovable';
    sessionId: string;
    generation: number;
    nonce: string;
    /** `process.platform` at acquisition time. */
    platform: string;
    /** Why nothing stronger could be minted, for operator-facing logs. */
    reason: string;
}

export type ContainmentHandle =
    | StrongContainmentHandle
    | WeakContainmentHandle
    | UnprovableContainmentHandle;

/**
 * Result of asking "is everything this handle owns gone?".
 *
 * `proven: false` deliberately carries no "probably fine" variant: every
 * non-proof (alive, unreadable, unsupported, timed out) is the same verdict to a
 * caller, because all of them must keep the blocker.
 */
export type QuiescenceVerdict =
    | { proven: true; handle: ContainmentHandle; reason?: string }
    | { proven: false; handle: ContainmentHandle; reason: string; residualPids?: number[] };

/** Thrown instead of degrading to an empty (fail-open) handle store. */
export class MojoContainmentUnavailableError extends Error {
    constructor(message: string, readonly cause?: unknown) {
        super(message);
        this.name = 'MojoContainmentUnavailableError';
    }
}

// ── host facts ───────────────────────────────────────────────────────────────

/**
 * Boot identity of the running kernel.
 *
 * Returns null when it cannot be read (non-Linux, or a locked-down /proc).
 * Callers must treat null as "cannot mint a trustworthy weak handle", NOT as a
 * blank value to store: a handle whose bootId is empty would compare equal
 * across reboots and across hosts, resurrecting exactly the pid-reuse confusion
 * the field exists to prevent.
 */
export function readBootId(opts: { procRoot?: string } = {}): string | null {
    const procRoot = opts.procRoot ?? '/proc';
    try {
        const id = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
        return id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/**
 * `/proc/<pid>/stat` field 22 (starttime, in clock ticks since boot).
 *
 * null means the pid is not currently live (or is unreadable), which is why the
 * caller may never read null as "the tree is gone": the ROOT exiting says
 * nothing about a descendant that called setsid().
 *
 * Field indexing has the same comm hazard as the scanner: field 2 is
 * parenthesised and may contain spaces or ')', so the split starts after the LAST
 * ')'. From there, index 0 is state (field 3), hence starttime (field 22) sits at
 * index 19.
 */
export function readProcStartTime(pid: number, opts: { procRoot?: string } = {}): number | null {
    const procRoot = opts.procRoot ?? '/proc';
    let text: string;
    try {
        text = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    } catch {
        return null;
    }
    const close = text.lastIndexOf(')');
    if (close < 0) return null;
    const rest = text.slice(close + 1).trim().split(/\s+/);
    const started = Number(rest[19]);
    return Number.isInteger(started) ? started : null;
}

/**
 * Is a usable cgroup v2 hierarchy mounted?
 *
 * `cgroup.controllers` exists only on the v2 unified hierarchy, so its presence
 * is the cheap discriminator against a v1-only host (where per-session
 * containment via this module is not available).
 */
export function cgroupV2Available(opts: { cgroupRoot?: string } = {}): boolean {
    const root = opts.cgroupRoot ?? CGROUP_ROOT;
    try {
        readFileSync(`${root}/cgroup.controllers`, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Process state from `/proc/<pid>/stat` field 3, for zombie classification.
 *
 *   'zombie'     — state Z: the process has exited and is only waiting to be
 *                  reaped. It executes no instructions and cannot use a
 *                  credential, but it REMAINS a member of its cgroup until the
 *                  parent reaps it (and `rmdir` keeps failing while it does).
 *   'running'    — any other state. Treated as executing.
 *   'gone'       — ENOENT: the pid vanished between listing and reading, i.e.
 *                  genuinely not a member any more (same race rule the scanner
 *                  applies).
 *   'unreadable' — anything else. Deliberately NOT merged into 'zombie': a state
 *                  we cannot read must count as executing, or an EACCES becomes
 *                  a free pass.
 *
 * DUPLICATED RULE — read before changing any of the three cases
 * ------------------------------------------------------------
 * The same zombie rule has to hold in TWO places that deliberately do not share
 * code: here, for cgroup members read out of `cgroup.procs`, and in the /proc
 * subtree scanner (mojo-process-tree), for members found by enumeration. They stay
 * separate because they start from different inputs, but they must agree, and
 * nothing enforces that agreement automatically.
 *
 * Why the agreement matters more than the rule itself: if one side discounts a
 * zombie and the other does not, the SAME tree gets two verdicts. That is not a
 * cosmetic inconsistency — ProcTree hit it for real while wiring 7-A. A SIGKILLed
 * child sat in state Z awaiting reap; the in-memory ladder discounted it and
 * reported clean, while the pid list handed to `proveContainmentQuiescent` still
 * carried it, so this module judged the tree alive. The close was then refused
 * forever and the handle could never be discharged: a permanent wedge produced
 * purely by two definitions of "running".
 *
 * So: change one side and you MUST change the other. The rule is exactly
 *   - state 'Z'        -> discounted (a zombie executes nothing, holds no credential)
 *   - ENOENT           -> gone, skipped (raced away; not a member)
 *   - anything else     -> EXECUTING, including any state we cannot read
 * The last case is the one that must never be relaxed on either side: turning an
 * unreadable state into "harmless" is a fail-open, and it is reachable by the very
 * process being policed.
 */
export type ProcLiveness = 'zombie' | 'running' | 'gone' | 'unreadable';

export function readProcLiveness(pid: number, opts: { procRoot?: string } = {}): ProcLiveness {
    const procRoot = opts.procRoot ?? '/proc';
    let text: string;
    try {
        text = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
    }
    // Same comm hazard as everywhere else: field 2 is parenthesised and may
    // contain spaces or ')', so cut at the LAST ')'. After that, index 0 is
    // field 3 (state).
    const close = text.lastIndexOf(')');
    if (close < 0) return 'unreadable';
    const state = text.slice(close + 1).trim().split(/\s+/)[0];
    if (!state) return 'unreadable';
    return state === 'Z' ? 'zombie' : 'running';
}

// ── acquiring ────────────────────────────────────────────────────────────────

export interface AcquireContainmentInput {
    sessionId: string;
    generation: number;
    /** Root pid of the turn (the direct child this backend spawned). */
    rootPid: number;
    /** The env nonce already injected into that tree. */
    nonce: string;
}

/**
 * Mint the strongest handle this host can support for a turn subtree.
 *
 * Returns null only when NEITHER kind can be minted (no cgroup v2 AND no boot
 * id, i.e. we cannot even describe the tree durably). A null return is itself a
 * fail-closed signal: the caller has spawned a credentialed child it will never
 * be able to prove quiescent, so it must keep the blocker for the session's
 * lifetime rather than proceed as if containment existed.
 */
export function acquireContainmentHandle(
    input: AcquireContainmentInput,
    opts: { cgroupRoot?: string; procRoot?: string; platform?: string } = {},
): ContainmentHandle {
    const cgroupRoot = opts.cgroupRoot ?? CGROUP_ROOT;
    if (cgroupV2Available({ cgroupRoot })) {
        // A stable, collision-free name: two generations of the same session must
        // not share a directory, or releasing one would release the other's proof.
        const dir = join(
            cgroupRoot,
            CGROUP_SLICE,
            `mojo-${sanitizeForPath(input.sessionId)}-g${input.generation}-${randomBytes(4).toString('hex')}`,
        );
        try {
            mkdirSync(dir, { recursive: true });
            // Moving the root in migrates it AND every future descendant: cgroup
            // membership is inherited across fork and is unaffected by setsid.
            writeFileSync(`${dir}/cgroup.procs`, `${input.rootPid}\n`);
            return {
                kind: 'cgroup',
                sessionId: input.sessionId,
                generation: input.generation,
                cgroupPath: dir,
                nonce: input.nonce,
            };
        } catch {
            // Delegation not granted / read-only /sys — fall through to the weak
            // handle rather than pretending containment was established.
            try { rmdirSync(dir); } catch { /* best-effort */ }
        }
    }
    const bootId = readBootId({ procRoot: opts.procRoot });
    const startTime = bootId === null
        ? null
        : readProcStartTime(input.rootPid, { procRoot: opts.procRoot });
    if (bootId === null || startTime === null) {
        // NOT null. Returning null here meant the caller recorded nothing and
        // `hasUnprovenContainment()` answered false, so the blocker was dropped on
        // precisely the hosts that can never prove anything (see
        // UnprovableContainmentHandle).
        return {
            kind: 'unprovable',
            sessionId: input.sessionId,
            generation: input.generation,
            nonce: input.nonce,
            platform: opts.platform ?? process.platform,
            reason: bootId === null
                ? 'no cgroup v2 delegation and no readable boot id'
                : `no cgroup v2 delegation and pid ${input.rootPid} has no readable starttime`,
        };
    }
    return {
        kind: 'tree-identity',
        sessionId: input.sessionId,
        generation: input.generation,
        rootPid: input.rootPid,
        bootId,
        startTime,
        nonce: input.nonce,
    };
}

function sanitizeForPath(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// ── proving ──────────────────────────────────────────────────────────────────

/**
 * Outcome of a degraded, /proc-based enumeration, supplied by the caller.
 *
 * Deliberately a callback rather than a direct import of `scanMojoTree`: the
 * scanner is owned by mojo-process-tree.ts and this module must stay a leaf that
 * a unit test can drive with a synthetic world. `scanned: false` is the scanner's
 * fail-closed signal and MUST NOT be collapsed into an empty pid list by the
 * caller.
 */
export interface TreeScanEvidence {
    scanned: boolean;
    pids: readonly number[];
    reason?: string;
}

export interface ProveContainmentOpts {
    procRoot?: string;
    /** Required to prove a WEAK handle; ignored for a strong one. */
    scan?: (handle: WeakContainmentHandle) => TreeScanEvidence;
}

/**
 * Can we prove that nothing this handle owns is still executing?
 *
 * STRONG handle: `cgroup.procs` is authoritative. An absent directory also counts
 * as proof, because the kernel refuses `rmdir` on a non-empty cgroup and this
 * module only removes one after a proven verdict — so "gone" can only mean
 * "was empty when it went". Any OTHER read error is a non-proof.
 *
 * WEAK handle:
 *   - a bootId mismatch is genuine, cheap proof: the recorded tree cannot have
 *     survived the reboot that changed the id;
 *   - otherwise the only available evidence is a /proc scan, which the caller
 *     must supply. No scan, or a failed scan, or any surviving pid → not proven.
 *   - the root pid being gone is explicitly NOT accepted on its own: a descendant
 *     that called setsid() outlives its parent, which is the whole reason the
 *     scanner unions three signals.
 *
 * A clean weak verdict is the best this host can do, not an unforgeable
 * boundary — see the trust-domain note in mojo-process-tree. Callers that need
 * certainty need a strong handle.
 */
export function proveContainmentQuiescent(
    handle: ContainmentHandle,
    opts: ProveContainmentOpts = {},
): QuiescenceVerdict {
    if (handle.kind === 'cgroup') {
        let raw: string;
        try {
            raw = readFileSync(`${handle.cgroupPath}/cgroup.procs`, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return { proven: true, handle };
            }
            return {
                proven: false,
                handle,
                reason: `cannot read ${handle.cgroupPath}/cgroup.procs `
                    + `(${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
            };
        }
        const pids = raw.split('\n').map(l => Number(l.trim())).filter(n => Number.isInteger(n) && n > 0);
        if (pids.length === 0) return { proven: true, handle };
        // A non-empty cgroup is NOT automatically a live tree. `cgroup.procs`
        // keeps listing a zombie until its parent reaps it, and a zombie executes
        // nothing and cannot use the injected credential. Treating it as alive
        // would wedge the session permanently: the close is already allowed to
        // succeed (the scanner reaches the same verdict), yet the blocker could
        // never clear and `rmdir` on the cgroup would fail forever, leaving an
        // unexplainable stuck blocker and a leaked cgroup directory.
        //
        // Fail-closed is preserved in the direction that matters: only state 'Z'
        // is discounted, an ENOENT means the pid genuinely left, and a state we
        // cannot read counts as EXECUTING.
        const executing: number[] = [];
        const zombies: number[] = [];
        for (const pid of pids) {
            const liveness = readProcLiveness(pid, { procRoot: opts.procRoot });
            if (liveness === 'gone') continue;            // raced us; not a member
            if (liveness === 'zombie') { zombies.push(pid); continue; }
            executing.push(pid);                          // running OR unreadable
        }
        if (executing.length > 0) {
            return { proven: false, handle, reason: 'cgroup still has executing members', residualPids: executing };
        }
        // Zombie-only (or everything raced away): nothing can execute, so this is
        // genuine quiescence. Reported in the reason so an operator can see why a
        // still-populated cgroup was accepted.
        return zombies.length > 0
            ? { proven: true, handle, reason: `zombie-only cgroup members (${zombies.join(',')})` }
            : { proven: true, handle };
    }

    if (handle.kind === 'unprovable') {
        // By construction there is no evidence that could settle this. Returning
        // proven:false unconditionally is what keeps the blocker, and because
        // releaseContainmentHandle only accepts a proven verdict, such a handle can
        // never be released — which is the intended terminal state.
        return {
            proven: false,
            handle,
            reason: `containment is unprovable on ${handle.platform}: ${handle.reason}`,
        };
    }

    const currentBootId = readBootId({ procRoot: opts.procRoot });
    if (currentBootId === null) {
        // We cannot even establish which boot we are on, so we cannot rule out
        // that this pid is the original tree. Fail closed.
        return { proven: false, handle, reason: 'boot id unreadable; cannot age out the recorded tree' };
    }
    if (currentBootId !== handle.bootId) {
        return { proven: true, handle };
    }
    if (!opts.scan) {
        return {
            proven: false,
            handle,
            reason: 'weak containment handle cannot prove quiescence without a subtree scan',
        };
    }
    const evidence = opts.scan(handle);
    if (!evidence.scanned) {
        return {
            proven: false,
            handle,
            reason: `subtree scan failed: ${evidence.reason ?? 'unknown'}`,
        };
    }
    if (evidence.pids.length > 0) {
        return {
            proven: false,
            handle,
            reason: 'subtree still has live members',
            residualPids: [...evidence.pids],
        };
    }
    return { proven: true, handle };
}

/**
 * Is the recorded root pid still the ORIGINAL process?
 *
 * Used before signalling: a weak handle names a pid, and pids are reused. Sending
 * SIGKILL to a recycled pid would kill an unrelated process, so a caller must
 * confirm identity first. False therefore means "do not signal this pid", NOT
 * "the tree is gone".
 */
export function weakHandleRootStillOriginal(
    handle: WeakContainmentHandle,
    opts: { procRoot?: string } = {},
): boolean {
    const bootId = readBootId({ procRoot: opts.procRoot });
    if (bootId === null || bootId !== handle.bootId) return false;
    const startTime = readProcStartTime(handle.rootPid, { procRoot: opts.procRoot });
    return startTime !== null && startTime === handle.startTime;
}

// ── durable store ────────────────────────────────────────────────────────────

interface ContainmentFile {
    version: 1;
    /** sessionId -> handles whose subtree has NOT been proven quiescent. */
    sessions: Record<string, ContainmentHandle[]>;
}

function filePath(dataDir?: string): string {
    return join(dataDir ?? config.session.dataDir, FILE_NAME);
}

/** Stable identity of a handle, so union/removal cannot double-count or mis-hit. */
export function containmentHandleKey(handle: ContainmentHandle): string {
    if (handle.kind === 'cgroup') return `cgroup:${handle.cgroupPath}`;
    if (handle.kind === 'unprovable') return `unprovable:${handle.sessionId}:${handle.generation}`;
    return `tree:${handle.bootId}:${handle.rootPid}:${handle.startTime}`;
}

function parseHandle(value: unknown, path: string, sessionId: string): ContainmentHandle {
    const bad = (why: string): never => {
        throw new MojoContainmentUnavailableError(
            `mojo containment store at ${path} has ${why} for ${sessionId}; `
            + 'refusing to treat the session as contained',
        );
    };
    if (!value || typeof value !== 'object') return bad('a non-object handle');
    const h = value as Record<string, unknown>;
    const common = typeof h.sessionId === 'string' && h.sessionId.length > 0
        && typeof h.generation === 'number' && Number.isInteger(h.generation)
        && typeof h.nonce === 'string' && h.nonce.length > 0;
    if (!common) return bad('a handle with missing common fields');
    if (h.kind === 'cgroup') {
        if (typeof h.cgroupPath !== 'string' || h.cgroupPath.length === 0) return bad('a cgroup handle with no path');
        return h as unknown as StrongContainmentHandle;
    }
    if (h.kind === 'unprovable') {
        if (typeof h.platform !== 'string' || h.platform.length === 0
            || typeof h.reason !== 'string' || h.reason.length === 0) {
            return bad('a malformed unprovable handle');
        }
        return h as unknown as UnprovableContainmentHandle;
    }
    if (h.kind === 'tree-identity') {
        const ok = typeof h.rootPid === 'number' && Number.isInteger(h.rootPid) && h.rootPid > 0
            && typeof h.bootId === 'string' && h.bootId.length > 0
            && typeof h.startTime === 'number' && Number.isInteger(h.startTime);
        if (!ok) return bad('a malformed tree-identity handle');
        return h as unknown as WeakContainmentHandle;
    }
    return bad(`an unknown handle kind ${JSON.stringify(h.kind)}`);
}

/**
 * Read the store. No caching: a cached snapshot would hide another daemon's
 * writes and could lose a recorded, still-unproven tree.
 *
 * A genuinely absent file is an empty store; anything else (EACCES, corrupt JSON,
 * unknown version, malformed entry) THROWS, because "cannot read" must never
 * become "nothing is contained" — that is the fail-open direction, and it is
 * trivially arranged by the same-user process being policed.
 */
function readStrict(dataDir?: string): ContainmentFile {
    const path = filePath(dataDir);
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, sessions: {} };
        }
        throw new MojoContainmentUnavailableError(
            `cannot read mojo containment store at ${path} `
            + `(${(err as NodeJS.ErrnoException).code ?? 'unknown'}); `
            + 'refusing to treat sessions as contained',
            err,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new MojoContainmentUnavailableError(
            `mojo containment store at ${path} is corrupt; refusing to treat sessions as contained`,
            err,
        );
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (version !== 1) {
        throw new MojoContainmentUnavailableError(
            `mojo containment store at ${path} has unsupported version ${JSON.stringify(version)}`,
        );
    }
    const sessionsRaw = (parsed as { sessions?: unknown } | null)?.sessions;
    if (!parsed || typeof parsed !== 'object' || !sessionsRaw || typeof sessionsRaw !== 'object') {
        throw new MojoContainmentUnavailableError(
            `mojo containment store at ${path} has an unexpected shape; refusing to treat sessions as contained`,
        );
    }
    const sessions: Record<string, ContainmentHandle[]> = {};
    for (const [sessionId, list] of Object.entries(sessionsRaw as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
            throw new MojoContainmentUnavailableError(
                `mojo containment store at ${path} has a non-array entry for ${sessionId}`,
            );
        }
        // Rejecting the whole file rather than filtering: silently dropping one
        // junk element would EMPTY that session's containment and unblock it.
        sessions[sessionId] = list.map(item => parseHandle(item, path, sessionId));
    }
    return { version: 1, sessions };
}

/** Atomic replace via a UNIQUE temp file — a shared `.tmp` races between daemons. */
function writeStrict(data: ContainmentFile, dataDir?: string): void {
    const path = filePath(dataDir);
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, path);
    } catch (err) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort cleanup */ }
        throw new MojoContainmentUnavailableError(
            `cannot persist mojo containment store at ${path}; an unproven subtree would be lost`,
            err,
        );
    }
}

/**
 * Record a handle as OWNED AND UNPROVEN.
 *
 * Call this at spawn time, before the child can do anything: a crash between
 * spawn and record is exactly the window that used to lose the tree entirely.
 * Monotonic union by handle identity, so re-recording is idempotent and a later
 * call can never retract an earlier one.
 *
 * THROWS on any read/write failure — the caller must not proceed believing the
 * tree was recorded.
 */
export function recordContainmentHandle(
    handle: ContainmentHandle,
    dataDir?: string,
): void {
    const path = filePath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(path, () => {
        const data = readStrict(dataDir);
        const before = data.sessions[handle.sessionId] ?? [];
        const key = containmentHandleKey(handle);
        if (before.some(h => containmentHandleKey(h) === key)) return;
        data.sessions[handle.sessionId] = [...before, handle];
        writeStrict(data, dataDir);
    });
}

/**
 * Handles this session still owns. Empty ONLY when nothing is outstanding.
 *
 * THROWS when the store cannot be read, so isolation callers fail closed instead
 * of reading an error as "clean".
 */
export function containmentHandles(sessionId: string, dataDir?: string): ContainmentHandle[] {
    return readStrict(dataDir).sessions[sessionId] ?? [];
}

/**
 * Session ids with an outstanding handle, INCLUDING sessions whose row is gone.
 *
 * The residual path needs this: an explicit `/close` deletes the row, so without
 * it the inventory would lose every trace of an unproven credentialed subtree.
 */
export function containmentSessionIds(dataDir?: string): string[] {
    return Object.keys(readStrict(dataDir).sessions);
}

/**
 * Does this session still have a tree we cannot prove is gone?
 *
 * This is the predicate the device-isolation blocker hangs off. It THROWS on an
 * unreadable store rather than answering false.
 */
export function hasUnprovenContainment(sessionId: string, dataDir?: string): boolean {
    return containmentHandles(sessionId, dataDir).length > 0;
}

/**
 * Release a handle — the ONLY removal path, and it demands the proof.
 *
 * Taking the verdict (rather than a boolean, or nothing at all) is deliberate: it
 * makes "clear the blocker without proving quiescence" unrepresentable at the type
 * level, which is the invariant this whole module exists to enforce. A caller
 * holding a `proven: false` verdict has no way to spend it here.
 *
 * For a strong handle the now-empty cgroup directory is removed too; `rmdir` on a
 * cgroup fails if it is non-empty, so this is also a last kernel-side re-check of
 * the proof we were handed.
 */
export function releaseContainmentHandle(
    verdict: QuiescenceVerdict,
    dataDir?: string,
): void {
    if (!verdict.proven) {
        throw new MojoContainmentUnavailableError(
            `refusing to release containment for session ${verdict.handle.sessionId}: `
            + `quiescence was not proven (${verdict.reason})`,
        );
    }
    const handle = verdict.handle;
    const path = filePath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(path, () => {
        const data = readStrict(dataDir);
        const before = data.sessions[handle.sessionId] ?? [];
        const key = containmentHandleKey(handle);
        const after = before.filter(h => containmentHandleKey(h) !== key);
        if (after.length === before.length) return;
        if (after.length === 0) delete data.sessions[handle.sessionId];
        else data.sessions[handle.sessionId] = after;
        writeStrict(data, dataDir);
    });
    if (handle.kind === 'cgroup') {
        // ENOENT means it was already reclaimed. Anything else leaves a directory
        // behind that an operator would otherwise find with no explanation: the most
        // common cause is a ZOMBIE-ONLY cgroup, which this module deliberately
        // accepts as quiescent (a zombie executes nothing) while the kernel still
        // refuses rmdir on a non-empty cgroup. Say so rather than swallowing it.
        //
        // Not a failure: the handle is already out of the store and the blocker may
        // be dropped, so the close must not be refused over a leftover directory.
        try {
            rmdirSync(handle.cgroupPath);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
                logger.warn(
                    `[mojo] released containment for session ${handle.sessionId} but could not remove `
                    + `${handle.cgroupPath} (${code ?? 'unknown'}); a zombie-only cgroup is the usual `
                    + 'cause and the empty directory can be reclaimed once its parent reaps it',
                );
            }
        }
    }
}

/**
 * Hand every outstanding handle of a session to a new worker generation.
 *
 * Inheritance is a UNION and it is unconditional: replacement does not prove
 * anything about the old tree, so the new generation becomes responsible for
 * proving it later. The generation stamp is refreshed for logging while the
 * IDENTITY fields (cgroup path, pid/boot/starttime, nonce) are preserved
 * verbatim — rewriting those would invent a handle that proves nothing about the
 * tree actually left behind.
 *
 * Nothing is removed here, so a crash mid-inheritance is safe: the handles are
 * still recorded under the same session id.
 */
export function inheritContainmentHandles(
    sessionId: string,
    nextGeneration: number,
    dataDir?: string,
): ContainmentHandle[] {
    const path = filePath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    let inherited: ContainmentHandle[] = [];
    withFileLockSync(path, () => {
        const data = readStrict(dataDir);
        const before = data.sessions[sessionId] ?? [];
        if (before.length === 0) return;
        inherited = before.map(h => ({ ...h, generation: nextGeneration }));
        data.sessions[sessionId] = inherited;
        writeStrict(data, dataDir);
    });
    return inherited;
}

// ── the ONLY source of boundaryProof: true ───────────────────────────────────

/**
 * Map a containment verdict onto ProcTree's `TurnQuiescence`.
 *
 * This function is the single place in the codebase allowed to mint
 * `{ kind: 'contained-proven', boundaryProof: true }`, and it only does so for a
 * STRONG (cgroup) handle. That split is the whole point of the two contracts
 * meeting here:
 *
 *   - `quiescenceFromScan()` can never produce `boundaryProof: true`; a clean
 *     /proc scan is a diagnostic signal, because a descendant that both setsids
 *     AND scrubs its own environ evades enumeration entirely.
 *   - cgroup membership is kernel state that the same-user child cannot forge,
 *     unlink or escape, so an empty (or zombie-only) `cgroup.procs` is a real
 *     boundary proof.
 *
 * A WEAK handle therefore maps to `diagnostic-clean` even when its verdict is
 * `proven: true`. That is deliberate and is NOT a downgrade of this module's own
 * release rule: releasing a weak handle from the durable store is legitimate
 * (the tree really does look gone by every means this host offers), but it must
 * not license clearing a device-isolation blocker, whose bar is an unforgeable
 * boundary. Callers gate the blocker on `boundaryProof === true` only.
 */
export function containmentQuiescence(verdict: QuiescenceVerdict): TurnQuiescence {
    if (!verdict.proven) {
        if (verdict.handle.kind === 'unprovable') {
            return { kind: 'unsupported-platform', boundaryProof: false, platform: verdict.handle.platform };
        }
        return verdict.residualPids && verdict.residualPids.length > 0
            ? { kind: 'alive', boundaryProof: false, pids: [...verdict.residualPids] }
            : { kind: 'unscannable', boundaryProof: false, reason: verdict.reason };
    }
    if (verdict.handle.kind === 'cgroup') {
        return { kind: 'contained-proven', boundaryProof: true };
    }
    // No `unprovable` case here on purpose. proveContainmentQuiescent NEVER returns
    // proven:true for that kind, so a branch for it would be unreachable — an
    // unfalsifiable claim that no mutation can kill. A hand-constructed impossible
    // verdict falls through to the line below, which is still boundaryProof:false,
    // so deleting the branch costs no safety.
    //
    // Proven as far as a weak handle can prove anything — diagnostic only.
    return { kind: 'diagnostic-clean', boundaryProof: false };
}

/**
 * Strongest quiescence statement available for a session, across ALL of its
 * outstanding handles.
 *
 * Semantics are intentionally pessimistic, because a session is only as contained
 * as its WEAKEST outstanding tree:
 *   - any handle that is not proven  → that handle's non-proof is the answer
 *   - no handles at all              → `diagnostic-clean`; nothing is recorded,
 *     but "nothing recorded" is not a kernel-level boundary proof either
 *   - every handle proven, at least one weak → `diagnostic-clean`
 *   - every handle proven AND all strong     → `contained-proven`
 *
 * A store that cannot be read THROWS (via `containmentHandles`), so an
 * unreadable store can never present itself as a clean session.
 */
export function sessionContainmentQuiescence(
    sessionId: string,
    prove: (handle: ContainmentHandle) => QuiescenceVerdict,
    dataDir?: string,
): TurnQuiescence {
    const handles = containmentHandles(sessionId, dataDir);
    if (handles.length === 0) return { kind: 'diagnostic-clean', boundaryProof: false };
    let allStrong = true;
    for (const handle of handles) {
        const verdict = prove(handle);
        if (!verdict.proven) return containmentQuiescence(verdict);
        if (handle.kind !== 'cgroup') allStrong = false;   // weak or unprovable
    }
    return allStrong
        ? { kind: 'contained-proven', boundaryProof: true }
        : { kind: 'diagnostic-clean', boundaryProof: false };
}
