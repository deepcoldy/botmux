/**
 * MojoBackend — API-backed SessionBackend for @byted/mojo.
 *
 * Implements botmux's pseudo-PTY SessionBackend surface on top of mojo's
 * headless mode, in the same spirit as RiffBackend. Verified empirically
 * against @byted/mojo 1.0.10 (linux-x64).
 *
 * ── Why not a TUI adapter (kimi/grok style) ──────────────────────────────────
 *  1. `--yolo` / `-r` / `-c` / `--output-format` / `--timeout` / `--idle-timeout`
 *     are all "仅 -p" (headless only). Passing them without `-p` does not launch
 *     a TUI — the process just blocks on stdin until EOF.
 *  2. mojo keeps NO local per-session transcript (`~/.mojo` holds only
 *     credentials/ memory/ skills/; session state is server-side), so the
 *     grok-style "tail updates.jsonl for turn end" bridge is impossible and only
 *     unreliable screen-scraping would remain.
 *
 * ── Why foreground streaming and not `--background` + polling ────────────────
 * `--background` looks attractive (instant id, ask_user/confirm interactions,
 * survives restarts) but it is CREATE-ONLY — verified:
 *     mojo -p --background -r <sid>  → error invalid_argument "--background 不支持：--resume"
 *     mojo -p --background -c        → error invalid_argument "--background 不支持：--continue"
 * A chat bot is inherently multi-turn, so a create-only submit path would start a
 * fresh context-less session on every IM message. Foreground `-p -r <sid>` does
 * resume correctly (including sessions originally created by --background), and
 * additionally gives real token-level streaming plus an exact turn boundary.
 *
 * The cost, made explicit so it isn't discovered in production: in foreground
 * mode mojo AUTO-SKIPS ask_user and cancels the turn —
 *     warnings: ["agent 的提问（ask-user）在非交互模式下被自动跳过"]
 *     error: {code:"cancelled"}, exit code 1
 * We detect exactly that and tell the user to supply the missing detail, instead
 * of leaving them with a silently empty turn. See ASK_USER_SKIPPED_RE.
 *
 * ── Event stream (`-p --output-format stream-json --include-partial`) ────────
 *   {type:"system", subtype:"init", session_id, model}   ← id available up-front
 *   {type:"text_delta", text}                            ← incremental
 *   {type:"text", text}                                  ← whole segment
 *   {type:"tool_call", id, name, input}
 *   {type:"result", status, result, session_id, duration_ms, num_tool_calls,
 *                  warnings, error}                      ← exact turn boundary
 *
 * NOTE: the foreground envelope is NOT the same shape as the `--background` /
 * `session.*` schema-v1 envelope (which additionally carries schema_version,
 * operation, state, turn_id, result_complete, interaction). Never assume `state`
 * or `result_complete` exists on a foreground result. Also `error` is an OBJECT
 * ({code, message, retryable}), not a string.
 */
import { randomBytes } from 'node:crypto';
import { spawn as spawnProcess, type ChildProcessByStdio } from 'node:child_process';
import { classifyUnprovenTermination } from './destroy-result.js';
import {
    acquireContainmentHandle,
    containmentHandleKey,
    containmentHandles,
    killPreparedBoundary,
    prepareContainmentBoundary,
    proveContainmentQuiescent,
    recordContainmentHandle,
    releaseContainmentHandle,
    strongHandleFromPreparedBoundary,
    containedProvenQuiescence,
    containmentQuiescence,
    type ContainmentReleaseDecision,
    type PreparedContainmentBoundary,
    weakHandleRootStillOriginal,
} from '../../core/mojo-containment.js';
import type { ContainmentHandle, QuiescenceVerdict, WeakContainmentHandle } from '../../core/mojo-containment.js';
import {
    MOJO_TREE_NONCE_ENV,
    terminationOutcomeFromQuiescence,
    quiescenceFromScan,
    readProcessIdentity,
    scanMojoTree,
    signalTurnTreeGroup,
} from './mojo-process-tree.js';
import type { MojoProcessIdentity, TerminationOutcome, TurnQuiescence } from './mojo-process-tree.js';
import { accessSync, constants as fsConstants, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import { locateOnPath } from '../cli/registry.js';
import { buildWrappedLaunch } from '../../setup/cli-selection.js';
import { logger } from '../../utils/logger.js';
import type {
    SessionBackend,
    SessionAbortDestroyResult,
    SessionDestroyResult,
    SessionShutdownDetachResult,
    SpawnOpts,
} from './types.js';
import {
    cleanupMojoIsolatedWorkspace,
    ensureMojoIsolatedWorkspace,
} from './mojo-isolated-workspace.js';
import {
    buildEffectiveChildEnv,
    deriveMojoExecutionMode,
    findReservedMojoCliFlags,
    mojoRemoteProofFailureReason,
    isMojoRemoteGone,
    MOJO_CANONICAL_JWT_ENV_KEY,
    MOJO_CONTROL_ENV_KEYS,
} from './mojo-types.js';
import type {
    MojoAuthStatus,
    MojoLivePatch,
    EffectiveMojoConfig,
    MojoCliEnvelope,
    MojoError,
    MojoCancelOutcome,
    MojoLineStyle,
    MojoLocalCloseResidual,
    MojoStreamEvent,
} from './mojo-types.js';
import { MOJO_CLI_TIMEOUT_MS, MOJO_DESTROY_SETTLE_MS, MOJO_CHILD_TERMINATION_PROOF_MS } from './mojo-budgets.js';

/** mojo silently drops an agent clarifying question in headless mode and marks
 *  the turn cancelled. Matching this is the difference between a helpful nudge
 *  and a mystifying empty reply. */
const ASK_USER_SKIPPED_RE = /ask-?user|提问.*被自动跳过/i;

/**
 * The server-side session stays RUNNING for a short window AFTER the foreground
 * process has already emitted its `result` event and exited. Verified: firing the
 * next turn immediately fails with
 *     mojo: 会话 <sid> 正在执行中（RUNNING），稍后再试   (exit 1)
 * A human typing in IM rarely hits this, but botmux flushes queued follow-ups the
 * instant a turn boundary fires — so it hits reliably there. Retry with backoff
 * instead of surfacing a spurious error to the user.
 */
const SESSION_BUSY_RE = /正在执行中|RUNNING）|already running/i;

/**
 * A resumed session id can stop being resumable (server-side GC, expiry, or a
 * session created under a different workspace/agent). Without handling this the
 * lineage is a permanent trap: every later message re-sends the same dead `-r
 * <sid>` and fails forever.
 *
 * ⚠️ NOT EMPIRICALLY VERIFIED — @byted/mojo was not installable in the porting
 * environment (npm 404, internal registry only), so the exact wording is
 * unknown. The patterns below are deliberately BROAD, and the decision is
 * additionally gated on `-r` having actually been passed (see maybeDropLineage),
 * so a false positive costs one lost context rather than a wedged session.
 * Calibrate against real output in the E2E pass — see OPEN_ITEMS.md.
 */
const RESUME_DEAD_RE =
    /会话.*(不存在|已过期|已结束|无效|未找到)|session.*(not\s*found|expired|invalid|does not exist)|not_found|invalid_session/i;
const BUSY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/**
 * Pre-exec cgroup enrolment shim (P0: the spawn→enrolment window).
 *
 * Post-spawn migration cannot capture descendants the child forked before the
 * parent's `cgroup.procs` write landed — cgroup v2 does not retroactively move
 * an existing process's descendants — so the enrolment has to happen INSIDE the
 * child, before any target code runs. `/bin/sh` writes its own pid into the
 * prepared boundary and only then `exec`s the real launch, keeping the same
 * pid. Between fork and the write the process executes just this shim, which
 * forks nothing, so every descendant of the target is born enrolled.
 *
 * The `|| exit 97` is the handshake: an enrolment failure must NOT fall through
 * to running a credentialed binary outside the boundary. Exit 97 is reserved —
 * the parent maps it to a refused turn (see MOJO_ENROLL_FAILED_EXIT).
 *
 * Invoked as: sh -c SHIM <name> <cgroup.procs path> <bin> <args...>
 * ($0 = name, $1 = procs path; after `shift`, "$@" = bin + args.)
 */
// NOTE: `exec "$@"` NOT `exec -- "$@"`. dash (the Linux /bin/sh) treats `exec --`
// as an attempt to exec a command literally named `--` and fails, so the shim
// would never reach mojo. The `--` guard is unneeded anyway: the bin is always a
// resolved ABSOLUTE path (never starts with `-`), so there is no option-injection
// to guard against.
export const MOJO_CGROUP_ENROLL_SHIM = 'echo "$$" > "$1" || exit 97; shift; exec "$@"';
export const MOJO_ENROLL_FAILED_EXIT = 97;

/**
 * stdio is always `['ignore','pipe','pipe']` here (stdin MUST be closed — see
 * runTurn), so the child has NO stdin. `ChildProcessWithoutNullStreams` is the
 * wrong type for that shape and tsc rejects the cast; this is the accurate one.
 */
type MojoChild = ChildProcessByStdio<null, Readable, Readable>;

export class MojoBackend implements SessionBackend {
    /** Mutable: applyLivePatch rotates credentials without a refork. */
    private config: EffectiveMojoConfig;
    private readonly sessionId: string;

    private dataCb: ((data: string) => void) | null = null;
    private taskDoneCb: (() => void) | null = null;
    private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
    private taskIdCb: ((taskId: string | null) => void) | null = null;
    private turnFinalCb: ((text: string) => void) | null = null;

    private outputBuffer = '';
    /**
     * This turn's assistant answer, accumulated from the SAME text the user
     * sees on the card (emitText is the single choke point for model prose —
     * tool-call/warning chrome goes through emitLine and is deliberately left
     * out). Reset per turn in runTurn(); handed to turnFinalCb at settleTurn().
     */
    private turnFinalText = '';
    /** mojo-side session id — the resume lineage. */
    private cliSessionId: string | null = null;
    private child: MojoChild | null = null;
    private killed = false;
    private closing = false;
    /** A close attempt observed evidence that something credentialed may still be
     *  alive (an unproven local subtree, or a dispatched turn with no lineage).
     *
     *  ONE-WAY for the lifetime of this backend: nothing clears it. The CLOSE stays
     *  retryable though — a later destroySession() whose terminateChildProven()
     *  succeeds proceeds to the remote cancel and returns ok:true — and that
     *  liveness property IS covered by a test, because a fence that also wedged the
     *  close would be worse than the bug it fixes.
     *
     *  Honest scope note: the one-way lifetime itself is an implementation fact, not
     *  a tested guarantee. Once a close succeeds `killed` refuses writes anyway, so
     *  clearing this field at that point is an equivalent mutation (verified: it
     *  survives). Do not read it as a proven invariant. */
    private admissionFenced = false;
    /** Graceful daemon shutdown is a non-cancelling detach. Fence only writes
     * arriving after prepare, then wait just long enough for an already accepted
     * first turn to publish its `system/init` lineage. */
    private shutdownDetaching = false;
    private shutdownDetachPrepared = false;
    private shutdownDetachAttempt: symbol | null = null;
    private shutdownDetachInFlight: Promise<SessionShutdownDetachResult> | null = null;
    private shutdownDetachAbortInFlight: Promise<SessionShutdownDetachResult> | null = null;
    private shutdownDetachWake: (() => void) | null = null;
    private lineageWaiters = new Set<() => void>();
    /** At least one turn crossed the adapter boundary while no lineage was
     * known. A later process exit without `system/init` cannot prove that no
     * remote session was created, so shutdown must not persist authoritative
     * null merely because the local write promise settled. */
    private acceptedWriteWithoutLineage = false;
    /** Inherited by every descendant of every turn, so the subtree stays
     *  enumerable after setsid/reparenting. Per BACKEND, not per turn: a tool left
     *  behind by an earlier turn must still be found. */
    /**
     * Env nonce injected into the turn subtree, inherited by every descendant.
     *
     * NOT `readonly`, and NOT freshly random per instance: a replacement worker
     * generation builds a NEW backend for the SAME session, and a new nonce would
     * make the previous generation's tree unenumerable forever (the env signal is
     * the only one that survives setsid + reparenting). So it is adopted from an
     * inherited containment handle whenever one is outstanding.
     */
    private treeNonce = `botmux-mojo-${randomBytes(12).toString('hex')}`;
    /**
     * Worker generation, used only for operator-facing logs on the handle. Derived
     * from how many handles this session already has outstanding, so a replacement
     * generation is distinguishable from the first one.
     */
    private readonly containmentGeneration: number;
    /**
     * The cgroup boundary prepared for the CURRENT turn, created before spawn so
     * the child can enrol itself pre-exec (see MOJO_CGROUP_ENROLL_SHIM). Null on
     * hosts without cgroup v2 delegation — those turns get a weak handle instead.
     */
    private preparedBoundary: PreparedContainmentBoundary | null = null;
    /** Realpath of this session's isolated workspace (host execution only).
     *  Populated lazily by resolveCwd(); spawn and close share this exact
     *  string so the close-side daemon-registry match cannot drift. */
    private isolatedWorkspace?: string;
    /** True for control-plane-only instances (the workerless orphan-cancel
     *  helper): they never run an agent turn, so isolating their cwd would
     *  only mint a junk workspace dir (and potentially a junk daemon) for a
     *  sentinel session id. */
    private readonly controlPlaneOnly: boolean = false;
    /**
     * Latched once a strong boundary proved unusable at runtime — the shim's
     * enrolment write was rejected (exit 97). The prepare-time probe only opens
     * cgroup.procs; a host that rejects the pid WRITE (delegation containment)
     * would otherwise fail EVERY turn with exit 97 forever. After the first such
     * failure this backend degrades to the weak post-spawn handle instead.
     */
    private strongBoundaryUnusable = false;
    /** True for the turn currently in flight iff it launched through the cgroup
     *  enrolment shim, so a genuine mojo `exit 97` is not misread as an enrolment
     *  failure (and vice versa) on weak-handle hosts where no shim runs. */
    private usedEnrolShim = false;
    /**
     * Latched when a spawned turn's containment handle could NOT be persisted
     * AND the started subtree could not be proven terminated afterwards. While
     * set, every close/destroy proof is refused: there is a tree nothing durable
     * describes, so publishing a closed row would drop the device-isolation
     * blocker over a subtree we cannot enumerate.
     */
    private containmentUnrecorded = false;
    /**
     * Root pid of the most recent turn, kept AFTER `this.child` is cleared.
     *
     * The child's own `close` handler nulls `this.child`, so a later `/close` had
     * nothing left to check and skipped the subtree scan entirely — the exact hole
     * that let a survivor go unnoticed once its parent had exited.
     */
    private lastTurnPid: number | null = null;
    /**
     * Recycle-proof identity of `lastTurnPid`, captured AT SPAWN.
     *
     * The pid number alone is not a handle: by the time teardown runs, the kernel
     * may have recycled it onto an unrelated process, and `kill(-pid)` would then
     * signal a stranger's whole process group. Binding boot id + starttime at
     * spawn is what lets the signal path prove it is still aiming at OUR child.
     */
    private turnIdentity: MojoProcessIdentity | null = null;
    /**
     * Evidence class of the last quiescence attempt. DIAGNOSTIC ONLY.
     *
     * The previous wording claimed the blocker decision requires
     * `boundaryProof === true` on this value. It did not, and still does not:
     * nothing in production reads `TurnQuiescence.boundaryProof`, so that was a
     * claim about code that was never written. The real gate is
     * `TerminationOutcome.boundaryProven` (see the close path below), which is
     * derived from `containmentReleaseDecision` in mojo-containment.ts. This field
     * is kept for logs and for tests that assert the grading, and it is read
     * through the `lastTurnQuiescence` getter only.
     */
    private lastQuiescence: TurnQuiescence | null = null;
    private lastTermination: TerminationOutcome | null = null;
    /** True once the current turn has emitted its `result` event, so a late
     *  process exit cannot fire a second turn boundary. */
    private turnSettled = true;
    /** Buffer for partial NDJSON lines across stdout chunks. */
    private stdoutTail = '';
    /** Set when --include-partial deltas have already rendered this turn's text,
     *  so the trailing whole-segment `text` event isn't printed twice. */
    private streamedThisTurn = false;
    private readonly cliTimeoutMs = MOJO_CLI_TIMEOUT_MS;
    /** How long /close waits for an in-flight turn to publish its session id
     *  before tearing down. Must stay well under the worker's close/restart
     *  race so teardown never becomes the thing that times out. */
    private readonly destroySettleMs = MOJO_DESTROY_SETTLE_MS;
    /**
     * Captured from spawn(). The worker owns the authoritative cwd + env (the
     * BOTMUX_* session context, per-bot `env`, credential paths, proxies) and
     * hands them over exactly once; ignoring them silently drops repo selection,
     * per-bot tokens and proxy settings. `config` values still win where set, so
     * an explicit bots.json override remains authoritative.
     */
    private spawnOpts: SpawnOpts | null = null;
    /**
     * Resolved launch PREFIX from BotConfig.wrapperCli (e.g. `env VAR=x mojo`,
     * a ttadk gateway). The worker resolves the prefix into a real bin + args and
     * passes them to spawn(); a PTY CLI is wrapped once for the life of its
     * process, but mojo is invoked per turn, so the prefix must be re-applied to
     * EVERY invocation. Null when no wrapper is configured, in which case the
     * plain binary is used.
     */
    private launchPrefix: { bin: string; args: string[] } | null = null;
    /** Guard so the config-side wrapper resolution is attempted at most once. */
    private wrapperResolved = false;
    /** Resolved once per session — see resolveBin. */
    private pinnedBin: string | null = null;
    /**
     * Live JWT, THREE states — the distinction is why a clear used to fail:
     *   undefined → no live snapshot received; resolve from config/env as before
     *   string    → use exactly this
     *   null      → explicitly cleared; do NOT fall back to any config-layer env
     *
     * The daemon already folds the ambient fallback into the snapshot it sends, so
     * `null` genuinely means "no credential from any config layer". Previously a
     * clear only set `config.jwt = undefined`, and buildEnv then re-read `jwtEnv`
     * out of the init-time `config.env` / `injectEnv`, reviving a stale token.
     */
    private liveJwt: string | null | undefined = undefined;
    /**
     * Generic CLI args the worker composed for this session (today: CLI_EXTRA_ARGS,
     * e.g. `--timeout 77`). The mojo adapter's buildArgs() returns [], so anything
     * arriving here came from the worker's shared arg pipeline and must be applied
     * to every turn — dropping it made the flag work with a wrapper configured
     * (buildWrappedLaunch folds spawnArgs into the prefix) but silently vanish
     * without one.
     */
    private extraCliArgs: string[] = [];
    private writeChain: Promise<void> = Promise.resolve();

    constructor(
        config: EffectiveMojoConfig,
        sessionId: string,
        opts?: { controlPlaneOnly?: boolean },
    ) {
        this.config = config;
        this.sessionId = sessionId;
        this.controlPlaneOnly = opts?.controlPlaneOnly === true;
        // Adopt the nonce of any subtree this session already owns. A replacement
        // generation MUST keep hunting the previous generation's tree, and the env
        // nonce is the only signal that survives setsid + reparenting to init — a
        // fresh random value here would strand that tree permanently.
        //
        // `containmentHandles` THROWS on an unreadable store rather than answering
        // "none". Letting that escape the constructor is deliberate: a backend that
        // cannot know what it inherited must not come up and start a turn it can
        // never prove quiescent.
        const inherited = containmentHandles(sessionId);
        this.containmentGeneration = inherited.length;
        const adopted = inherited[0]?.nonce;
        if (adopted !== undefined) {
            this.treeNonce = adopted;
            logger.warn(
                `[mojo] session ${sessionId}: adopting ${inherited.length} unproven turn `
                + 'subtree(s) from a previous worker generation; the device-isolation blocker '
                + 'stays until they are proven quiescent',
            );
        }
        // Daemon-restart resume: the persisted mojo session id restores the
        // lineage so the first write after a restart continues the conversation
        // instead of cold-booting a context-less session.
        if (config.resumeCliSessionId) this.cliSessionId = config.resumeCliSessionId;
    }

    // ── SessionBackend surface ───────────────────────────────────────────────

    spawn(bin: string, args: string[], opts: SpawnOpts): void {
        // No persistent process is started here — the headless CLI is invoked
        // once per turn — but the spawn contract is still where the worker hands
        // over the authoritative cwd/env, so keep them for buildEnv()/runTurn().
        this.spawnOpts = opts;

        // FAIL CLOSED on a launch prefix we did not ask for.
        //
        // This used to assume a non-empty `bin` could only be wrapperCli, on the
        // grounds that the FILE sandbox is refused for this backend before spawn
        // (backendSandboxCompatibilityError). That misses a second, INDEPENDENT
        // wrapping path: mandatory device-credential isolation, which
        // read-isolation.ts documents as "independent of the optional bot sandbox
        // toggle" and which rewrites spawnBin whenever the host is enrolled and the
        // session is not provably remote — e.g. a mojo bot with no `cloud` set.
        //
        // In that state the old code dropped the wrapper AND passed its argv to
        // mojo as extraCliArgs, so a boundary the platform mandates vanished while
        // the session looked healthy. Refusing is the only safe answer here: this
        // backend cannot tell which confinement it was handed, and guessing is
        // what caused the silent downgrade.
        if (bin && !this.config.wrapperCli) {
            // Say WHY this session is not provably remote, from the shared helper.
            // The old text always advised "run fully remote (cloud on, localDaemon
            // off)" — useless for the common case where cloud is already on and the
            // blocker is an env key, which is exactly the state that sends a session
            // down this path in the first place.
            const proofGap = mojoRemoteProofFailureReason(this.config);
            throw new Error(
                `[mojo] refusing to launch session ${this.sessionId}: unexpected launch wrapper `
                + `"${bin}" was supplied but no wrapperCli is configured. The mojo backend `
                + 'invokes the CLI per turn and cannot carry an unknown confinement wrapper. '
                + (proofGap
                    ? `This session is not provably remote, which is what engaged the wrapper: ${proofGap} `
                    + 'Resolve that so the credential boundary is satisfied remotely, or '
                    + 'configure wrapperCli explicitly.'
                    : 'Configure wrapperCli explicitly if this bot needs a launch prefix.'),
            );
        }
        // Generic extra args come from the config: the worker deliberately keeps
        // them out of both the spawn args and the wrapper prefix so they can be
        // appended AFTER our own flags on every turn (last-value-wins). Fall back
        // to the spawn args for any caller that has not been updated.
        const requestedExtraArgs = this.config.extraCliArgs
            ? [...this.config.extraCliArgs]
            : (args.length > 0 && !this.config.wrapperCli ? [...args] : []);
        // Defence in depth: the worker already refuses these, but this backend is
        // also constructed by the daemon's cancel path. A reserved flag reaching
        // here would override the frozen control plane, so drop it loudly rather
        // than letting it through.
        const reservedExtra = findReservedMojoCliFlags(requestedExtraArgs);
        if (reservedExtra.length > 0) {
            logger.warn(
                `[mojo] ignoring platform-owned flag(s) in extra CLI args: ${reservedExtra.join(' ')}`,
            );
            this.extraCliArgs = [];
        } else {
            this.extraCliArgs = requestedExtraArgs;
        }

        if (this.config.wrapperCli) {
            this.wrapperResolved = true;
            if (bin) {
                // The worker resolves the prefix with `[]` for args, so whatever
                // arrives here is the wrapper itself and nothing else.
                this.launchPrefix = { bin, args: [...args] };
                logger.info(`[mojo] launch prefix from wrapperCli: ${bin} ${args.join(' ')}`);
            } else {
                // Never claim a wrapper was applied while running the bare binary.
                logger.warn(
                    `[mojo] wrapperCli="${this.config.wrapperCli}" was configured but the worker `
                    + 'supplied no launch binary — running mojo unwrapped',
                );
            }
        }
        if (this.extraCliArgs.length > 0) {
            logger.info(`[mojo] extra CLI args applied per turn: ${this.extraCliArgs.join(' ')}`);
        }
        // Execution-mode audit line (review F4): host execution BY DEFAULT is a
        // posture change, so make "came from default" vs "came from explicit
        // config" distinguishable in the log. Same shared derivation as
        // buildArgs/buildEnv — label and env value cannot drift by construction.
        const execMode = deriveMojoExecutionMode(this.config).label;
        logger.info(`[mojo] spawn ${this.sessionId} in ${this.resolveCwd() ?? '(inherited cwd)'} (headless CLI invoked per turn, execution=${execMode})`);
    }

    /**
     * Resolve the executable + leading args for one invocation, re-applying the
     * wrapperCli prefix when present.
     *
     * The prefix normally arrives pre-resolved from the worker via spawn(). The
     * daemon's workerless cancel path never calls spawn(), so when a wrapper is
     * configured but unresolved we resolve it here from the config — otherwise
     * `/close` would run an unwrapped binary that a wrapper-dependent setup
     * (e.g. a gateway that injects auth) cannot reach.
     */
    private resolveLaunch(cliArgs: string[]): { bin: string; args: string[] } {
        const prefix = this.launchPrefix ?? this.resolveConfiguredWrapper();
        if (prefix) {
            return { bin: prefix.bin, args: [...prefix.args, ...cliArgs] };
        }
        return { bin: this.resolveBin(), args: cliArgs };
    }

    /**
     * Resolve the binary ONCE and reuse it for every turn of this session.
     *
     * Without pinning, a bare `mojo` was re-resolved on each turn against the
     * then-current PATH, so anything able to influence the environment between
     * turns could substitute the executable. The live patch no longer carries
     * `env` at all, but pinning removes the class of problem rather than one
     * instance of it — and it also keeps a session on one binary if PATH shifts
     * underneath a long-running worker.
     */
    private resolveBin(): string {
        if (this.pinnedBin) return this.pinnedBin;
        const configured = this.config.bin?.trim();
        if (configured) {
            this.pinnedBin = configured;
            return this.pinnedBin;
        }
        // Resolve against the EFFECTIVE child PATH, not the daemon's own.
        // `locateOnPath` reads this process's env, which silently ignored a
        // per-bot `PATH` — the child would then run a different binary than the
        // one that was pinned, changing the documented semantics of per-bot env.
        this.pinnedBin = this.locateOnEffectivePath('mojo') ?? 'mojo';
        logger.info(`[mojo] pinned binary for this session: ${this.pinnedBin}`);
        return this.pinnedBin;
    }

    /**
     * Find an executable using the PATH the CHILD will actually see.
     *
     * Layered exactly like buildEnv (worker env → per-bot injectEnv → mojo.env),
     * so a per-bot PATH override takes effect. Falls back to the caller's own PATH
     * when spawn() has not run (direct/unit use).
     */
    private locateOnEffectivePath(cmd: string): string | null {
        const childPath = this.config.env?.PATH
            ?? this.spawnOpts?.injectEnv?.PATH
            ?? this.spawnOpts?.env?.PATH;
        if (!childPath) return locateOnPath(cmd);
        for (const dir of childPath.split(delimiter)) {
            if (!dir) continue;
            const candidate = join(dir, cmd);
            try {
                accessSync(candidate, fsConstants.X_OK);
                return candidate;
            } catch { /* not here */ }
        }
        // Explicit child PATH is authoritative: do NOT fall back to the daemon's
        // ambient PATH. Falling back is how an ambient install shadowed a per-bot
        // one, which defeats the point of resolving on the child PATH at all.
        return null;
    }

    /** Lazily resolve (and memoize) `config.wrapperCli` when spawn() never ran. */
    private resolveConfiguredWrapper(): { bin: string; args: string[] } | null {
        if (this.wrapperResolved) return this.launchPrefix;
        this.wrapperResolved = true;
        const wrapperCli = this.config.wrapperCli?.trim();
        if (!wrapperCli) return null;
        try {
            // cliArgs is [] on purpose: the mojo adapter bakes nothing into launch
            // args, so this yields the PREFIX only, and the per-turn args are
            // appended by resolveLaunch.
            // Same effective-PATH resolution as resolveBin: a per-bot PATH must
            // decide the wrapper binary too, or the two disagree about which
            // install is in use.
            const launch = buildWrappedLaunch(
                wrapperCli, [], b => this.locateOnEffectivePath(b) ?? b,
            );
            if (!launch.bin) return null;
            this.launchPrefix = { bin: launch.bin, args: launch.args };
            logger.info(`[mojo] launch prefix resolved from config: ${launch.bin} ${launch.args.join(' ')}`);
            return this.launchPrefix;
        } catch (err: unknown) {
            // Never let an unusable wrapper turn teardown into a crash — but do
            // not pretend it was applied either.
            logger.warn(`[mojo] could not resolve wrapperCli "${wrapperCli}": ${String(err)}`);
            return null;
        }
    }

    /** bots.json `mojo.cwd` wins; otherwise the worker's session working dir. */
    /** The operator-facing working directory (the repo). Kept separate from
     *  resolveCwd(): host execution runs the CLI in an isolated per-session
     *  directory instead, and the decorate() preamble points the agent back
     *  here for repo work. */
    private realWorkingDir(): string | undefined {
        return this.config.cwd ?? this.spawnOpts?.cwd;
    }

    /** True when this config executes tools on the bot host (shared derivation
     *  with buildEnv/buildArgs — see deriveMojoExecutionMode). */
    private hostExecution(): boolean {
        return deriveMojoExecutionMode(this.config).agentLocalDaemon === '1';
    }

    /** HOME for the isolated workspace root. Prefer the CHILD env the worker
     *  hands over — in production it equals the daemon's own HOME (so the
     *  workerless close path, which uses os.homedir(), matches), while in
     *  tests it keeps backend instances from minting directories under the
     *  developer's real ~/.botmux (the full suite did exactly that once). */
    private isolationHome(): string | undefined {
        const home = this.config.env?.HOME ?? this.spawnOpts?.injectEnv?.HOME ?? this.spawnOpts?.env?.HOME;
        return typeof home === 'string' && home.length > 0 ? home : undefined;
    }

    private resolveCwd(): string | undefined {
        if (this.controlPlaneOnly || !this.hostExecution()) return this.realWorkingDir();
        // Host execution: run the CLI from a physically distinct per-session
        // directory. mojo keys its local execution daemon on
        // hash(process.cwd()) — realpath, so a symlink would collapse back
        // into the shared daemon (see mojo-isolated-workspace.ts for the
        // whole P0/P1 story). Cached: spawn and close must use the SAME
        // realpath string or the close-side registry match silently misses.
        this.isolatedWorkspace ??= ensureMojoIsolatedWorkspace(this.sessionId, this.isolationHome());
        return this.isolatedWorkspace;
    }

    write(data: string): boolean {
        if (this.killed || this.closing || this.shutdownDetaching) return false;
        if (this.containmentUnrecorded) {
            // A prior turn's subtree could not be recorded AND could not be proven
            // terminated. Running another credentialed turn on top of a possibly
            // live, undescribed tree is exactly the fail-open the latch exists to
            // prevent — refuse until a close proves (or contains) it.
            this.emitLine('❌ mojo 进程围栏存在未登记的残留子进程，已拒绝新一轮，请先 /close 本会话。', 'err');
            return false;
        }
        const text = data.trim();
        if (!text) return false;
        if (!this.cliSessionId) this.acceptedWriteWithoutLineage = true;
        // Serialize turns: mojo rejects a concurrent turn on the same session,
        // and a second message arriving before the first init event would fork a
        // duplicate session (cliSessionId still null).
        this.writeChain = this.writeChain
            .then(() => (this.killed || this.closing) ? undefined : this.runTurnWithBusyRetry(text))
            .catch((err: unknown) => {
                logger.warn(`[mojo] turn failed: ${String(err)}`);
                this.emitLine(`❌ mojo 执行失败：${this.fmtErr(err)}`, 'err');
                this.settleTurn();
            });
        return true;
    }

    /**
     * Rotate the JWT on a LIVE session, without a refork.
     *
     * Needed because the config is otherwise read once at worker init, so every
     * subsequent per-turn CLI invocation kept using the ORIGINAL token — a rotated
     * credential never took effect.
     *
     * Takes a COMPLETE snapshot rather than a sparse diff, so the two states that
     * a sparse patch could not express both work:
     *   - `jwt: null`      → cleared (a deleted `mojo.jwt` must not linger)
     *   - `jwt: <original>` → rolled back (A → B → A must return to A)
     *
     * Only the JWT is patchable. An `env` patch would be equivalent to replacing
     * the launcher — see MOJO_LIVE_PATCH_KEYS.
     */
    applyLivePatch(patch: MojoLivePatch): void {
        if (patch.jwt === undefined) return;
        if (this.liveJwt === patch.jwt) return;
        this.liveJwt = patch.jwt;
        // Never log the value.
        logger.info(`[mojo] live JWT ${patch.jwt === null ? 'cleared' : 'rotated'}`);
    }

    resize(_cols: number, _rows: number): void { /* no terminal to resize */ }

    onData(cb: (data: string) => void): void { this.dataCb = cb; }
    /**
     * NOT fired on per-turn CLI exit — the binary is spawned and exits every
     * turn, so forwarding that would tear the session down after the first
     * reply. It IS fired from kill(), mirroring RiffBackend: the worker needs to
     * learn the backend is gone on teardown / daemon restart, and nothing else
     * tells it.
     */
    onExit(cb: (code: number | null, signal: string | null) => void): void {
        this.exitCb = cb;
    }

    /** Turn boundary — required: an API-backed backend produces no PTY output, so
     *  botmux's idle detector never fires and nothing else re-arms prompt-ready. */
    onTaskDone(cb: () => void): void { this.taskDoneCb = cb; }

    /** This turn's assistant answer, for the worker's final_output bridge. A
     *  headless mojo session has no terminal the user could read instead, so an
     *  answer the agent never `botmux send`s would otherwise reach nobody. */
    onTurnFinal(cb: (text: string) => void): void { this.turnFinalCb = cb; }

    /** Lineage id updates — forwarded to the daemon so multi-turn context
     *  survives a daemon restart. */
    onTaskId(cb: (taskId: string | null) => void): void {
        this.taskIdCb = cb;
        if (this.cliSessionId) cb(this.cliSessionId);
    }

    captureCurrentScreen(): string { return this.outputBuffer; }
    captureViewport(): string { return this.outputBuffer; }
    getPaneSize(): { cols: number; rows: number } | null { return null; }
    getChildPid(): number | null { return this.child?.pid ?? null; }

    /**
     * SIGTERM, then PROVE the child is gone (escalating to SIGKILL).
     *
     * `child.kill('SIGTERM')` returning true only means the signal was delivered.
     * A child that ignores it keeps executing with the injected credential while
     * the explicit close publishes the row as `closed` — and a closed row is
     * filtered out of the device-isolation inventory
     * (mergePersistedDeviceIsolationSessions), so the blocker vanishes with the
     * process still alive. That is exactly the state this backend must never
     * report as a successful teardown.
     *
     * Returns false when termination could not be proven; the caller must then
     * refuse the close rather than let the row be published as closed.
     */
    /** Overridable so a behaviour test can exercise the escalation ladder without
     *  burning the production budget in wall-clock. Production never changes it. */
    protected get terminationProofBudgetMs(): number {
        return MOJO_CHILD_TERMINATION_PROOF_MS;
    }

    /** Overridable so a test can point the scan at a synthetic /proc. */
    protected get procRoot(): string { return '/proc'; }

    /** Overridable so a test can point boundary preparation at a synthetic
     *  cgroup root. `undefined` = the real /sys/fs/cgroup. */
    protected get cgroupRoot(): string | undefined { return undefined; }

    /** Overridable so a test can point the delegated-parent lookup
     *  (/proc/self/cgroup) at a synthetic /proc. `undefined` = the real /proc. */
    protected get cgroupProcRoot(): string | undefined { return undefined; }

    /**
     * SIGTERM the whole turn SUBTREE, then gather the best evidence this host can
     * give that nothing in it survives (escalating to SIGKILL).
     *
     * Read the result precisely. `ok: true` means "no executing member was
     * found", NOT "the credential is now unreachable". Enumeration cannot see a
     * descendant that both setsid'd and scrubbed its own environ, so a clean scan
     * is a DIAGNOSTIC signal only — `boundaryProven` is the field that says
     * whether a real boundary was established, and only kernel-level containment
     * (a per-session cgroup) can set it true. `ok: true` with
     * `boundaryProven: false` is therefore legal and, for Linux weak handles, the
     * common case; destroySession() below consumes the two fields separately and
     * downgrades the second case to a residual close.
     *
     * Three fail-open paths are closed here.
     *
     * 1. `child.kill()` returning true only means the signal was DELIVERED. A
     *    child that ignores SIGTERM keeps executing with the injected credential
     *    while the close publishes the row as `closed` — and a closed row is
     *    filtered out of the device-isolation inventory, so the blocker vanishes
     *    with the process still alive.
     * 2. Signalling the direct pid leaves DESCENDANTS alive.
     * 3. Signalling the process GROUP still leaves descendants that escaped it via
     *    setsid/detached. Enumeration therefore unions PGID, the inherited env
     *    nonce and the PPID chain — see mojo-process-tree.
     *
     * Reports `ok: false` whenever no such evidence could be obtained, INCLUDING when
     * the scan itself fails: "cannot enumerate" must never read as "nothing is
     * running". The caller then refuses the close, which keeps the row active and
     * so keeps the device-isolation blocker in place. (destroySession makes ONE
     * exception, for a platform that can never enumerate at all — see the
     * `unsupported-platform` branch there.)
     *
     * Zombie members are discounted, because a reaped process executes nothing and
     * cannot use the credential; only a definite `Z` state qualifies.
     */
    private async terminateChildProven(): Promise<TerminationOutcome> {
        const q = await this.proveTurnQuiescence();
        // The projection is where evidence grading survives. Returning a bare
        // boolean here is what discarded it: `diagnostic-clean` and
        // `contained-proven` both collapsed to `true`, so a clean Linux scan --
        // which cannot see a setsid'd, environ-scrubbed descendant -- authorised
        // the same plain closed row as a real kernel-level proof.
        const outcome = terminationOutcomeFromQuiescence(q);
        this.lastTermination = outcome;
        return outcome;
    }

    /** Structured evidence from the last termination attempt; see TerminationOutcome. */
    get lastTerminationOutcome(): TerminationOutcome | null {
        return this.lastTermination;
    }

    /** Evidence class of the last termination attempt; see TurnQuiescence. */
    get lastTurnQuiescence(): TurnQuiescence | null {
        return this.lastQuiescence;
    }

    /**
     * SIGTERM the whole turn SUBTREE, then try to establish that nothing in it
     * survives (escalating to SIGKILL), and report WHAT KIND of evidence we got.
     */
    protected async proveTurnQuiescence(): Promise<TurnQuiescence> {
        const record = (q: TurnQuiescence): TurnQuiescence => { this.lastQuiescence = q; return q; };
        const child = this.child;
        // lastTurnPid, not just `child`: the child's own `close` handler clears
        // `this.child`, and an escaped descendant outlives its parent. Falling back
        // to the remembered root pid is what keeps the subtree checkable.
        const rootPid = (typeof child?.pid === 'number' && child.pid > 0) ? child.pid : this.lastTurnPid;
        // The DURABLE view of what this session still owns. In-memory state is not
        // enough: on a replacement generation `lastTurnPid` is always null, and the
        // old code concluded "no turn ever spawned, so there is no subtree" — which
        // returned true for a session that may still have a live credentialed
        // survivor from the previous generation. Only the store can retire that claim.
        //
        // A throw here (unreadable store) propagates and refuses the close, which is
        // the correct fail-closed outcome.
        const outstanding = containmentHandles(this.sessionId);
        if (rootPid === null && outstanding.length === 0) {
            // No in-memory root AND nothing outstanding in the store: genuinely
            // nothing was ever credentialed under this session.
            this.child = null;
            return record({ kind: 'diagnostic-clean', boundaryProof: false });
        }

        const exited = new Promise<void>(resolve => {
            if (!child) return resolve();
            const done = (): void => resolve();
            child.once('exit', done);
            child.once('close', done);
            if (child.exitCode !== null || child.signalCode !== null) resolve();
        });

        const budget = this.terminationProofBudgetMs;
        const grace = Math.max(1, Math.floor(budget / 2));
        // Never signal ourselves: the daemon shares neither nonce nor group, but an
        // explicit guard is cheaper than trusting that while sending SIGKILL.
        const excludePids = this.selfPids();

        // rootPid may be null here while handles are still outstanding (a replacement
        // generation inherited a tree it never spawned). There is no in-memory root to
        // scan in that case, so the in-memory ladder is skipped and the inherited
        // handles below become the ONLY thing that can retire the close.
        if (rootPid === null) {
            return record(this.dischargeContainment(
                outstanding,
                { kind: 'diagnostic-clean', boundaryProof: false },
            ));
        }

        const look = (): TurnQuiescence => quiescenceFromScan(
            // turnIdentity was bound at spawn, while the pid was guaranteed to be
            // this child. It gates PGID-based claiming inside the scan: without a
            // verified root, only the env nonce (positive evidence of membership)
            // may claim, so a recycled root pid can never pull a stranger's
            // process group into a scan whose members get SIGKILLed.
            scanMojoTree(rootPid, this.treeNonce, {
                procRoot: this.procRoot,
                excludePids,
                ...(this.turnIdentity && this.turnIdentity.pid === rootPid
                    ? { rootIdentity: this.turnIdentity }
                    : {}),
            }),
        );

        const settle = async (deadlineMs: number): Promise<TurnQuiescence> => {
            const deadline = Date.now() + deadlineMs;
            for (;;) {
                const now = look();
                // Fail-closed: an unscannable host or an unsupported platform can
                // never be read as "nothing is running", and retrying will not turn
                // either into knowledge, so stop immediately.
                if (now.kind === 'unscannable') {
                    logger.error(`[mojo] cannot enumerate turn subtree: ${now.reason}`);
                    return now;
                }
                if (now.kind === 'unsupported-platform') {
                    logger.error(
                        `[mojo] cannot enumerate turn subtree on ${now.platform}: /proc is Linux-only, `
                        + 'so quiescence cannot be established on this host',
                    );
                    return now;
                }
                if (now.kind !== 'alive') return now;
                if (Date.now() >= deadline) return now;
                // Plain sleep: racing an ALREADY-RESOLVED `exited` here spun the
                // loop as fast as the event loop allowed (a busy loop until the
                // deadline). The direct child's exit is not the condition anyway —
                // the scan is.
                await new Promise<void>(r => setTimeout(r, 25).unref?.());
            }
        };

        const signalTree = (signal: NodeJS.Signals): void => {
            // Group first: it reaches processes that /proc may not have listed yet.
            // But NEVER as a bare kill(-rootPid): the pid may have been recycled, so
            // the identity captured at spawn is re-verified first and the signal is
            // skipped entirely on mismatch, on failure to verify, or off-Linux.
            if (this.turnIdentity === null) {
                logger.error(
                    '[mojo] refusing to signal the turn process group: no spawn-time identity was '
                    + 'captured, so the pid cannot be proven to still be our child',
                );
            } else {
                const sent = signalTurnTreeGroup(this.turnIdentity, signal, { procRoot: this.procRoot });
                if (sent.kind === 'identity-mismatch') {
                    logger.error(
                        `[mojo] refusing to signal pid ${this.turnIdentity.pid}: it has been recycled `
                        + `(starttime ${this.turnIdentity.starttime} -> ${sent.actual.starttime}); `
                        + 'signalling it would hit an unrelated process group',
                    );
                } else if (sent.kind === 'unverifiable') {
                    logger.error(`[mojo] refusing to signal the turn process group: ${sent.reason}`);
                } else if (sent.kind === 'unsupported-platform') {
                    logger.error(
                        `[mojo] refusing to signal the turn process group on ${sent.platform}: `
                        + 'pid identity cannot be verified without /proc',
                    );
                }
            }
            // Per-pid signals still go out: they come from an enumeration that just
            // observed each pid, and they are positive (not group-negated) targets.
            const scan = look();
            if (scan.kind === 'alive') {
                for (const pid of scan.pids) {
                    try { process.kill(pid, signal); } catch { /* raced us */ }
                }
            } else if (scan.kind === 'unscannable' || scan.kind === 'unsupported-platform') {
                // Cannot enumerate: fall back to the direct child handle, which is the
                // only target we can name without /proc.
                try { child?.kill(signal); } catch { /* gone */ }
            }
        };

        signalTree('SIGTERM');
        let verdict = await settle(grace);
        if (verdict.kind === 'diagnostic-clean') {
            this.child = null;
            await exited.catch?.(() => undefined);
            return record(this.dischargeContainment(outstanding, verdict));
        }

        if (verdict.kind === 'alive') {
            // Escalate. SIGKILL cannot be caught, so a survivor after this means we
            // genuinely cannot prove quiescence (e.g. uninterruptible state).
            signalTree('SIGKILL');
            verdict = await settle(budget - grace);
            if (verdict.kind === 'diagnostic-clean') {
                this.child = null;
                return record(this.dischargeContainment(outstanding, verdict));
            }
        }

        logger.error(
            `[mojo] turn subtree rooted at ${rootPid} could not be proven `
            + `quiescent (${verdict.kind}); refusing to report the close as successful — the session `
            + 'row stays active so its device-isolation blocker is retained',
        );
        // Deliberately NOT clearing this.child / lastTurnPid / turnIdentity: the
        // close is refused, so a retry must be able to signal the same subtree again.
        return record(verdict);
    }

    /**
     * Mint and PERSIST the containment handle for a freshly spawned turn root.
     *
     * Extracted so it can be exercised directly: doing this at close time would be
     * too late, because a crash between spawn and record is exactly the window that
     * loses the tree, and a lost tree can never be proven quiescent afterwards.
     */
    private recordTurnContainment(rootPid: number): void {
        // Strong path: the boundary was prepared before spawn and the child enrols
        // itself pre-exec, so the handle can simply adopt the directory — no pid
        // migration, hence no spawn→enrolment window (the P0 this replaced).
        const prepared = this.preparedBoundary;
        if (prepared) {
            recordContainmentHandle(strongHandleFromPreparedBoundary(prepared));
            // The handle owns the directory now; a later spawn failure must not
            // kill a boundary that belongs to a recorded turn.
            this.preparedBoundary = null;
            return;
        }
        // acquireContainmentHandle cannot return null: on a host with neither a
        // preparable cgroup boundary nor a readable boot id it mints an
        // `unprovable` handle instead, which is persisted, can never be released,
        // and reports unsupported-platform. That is what makes the residual-close
        // path safe — there is always something durable holding the
        // device-isolation blocker, so there is no "nothing was recorded" case
        // left to handle here.
        recordContainmentHandle(acquireContainmentHandle({
            sessionId: this.sessionId,
            generation: this.containmentGeneration,
            rootPid,
            nonce: this.treeNonce,
        }));
    }

    /**
     * Terminate a subtree whose containment handle could not be persisted.
     *
     * `containmentUnrecorded` is already latched by the caller. It is cleared
     * only when the boundary is PROVEN empty (rmdir accepted by the kernel) —
     * anything less keeps every close proof refused, because a tree nothing
     * durable describes must not be closable.
     */
    private async containUnrecordedSpawn(
        child: ChildProcessByStdio<null, Readable, Readable>,
        cause: unknown,
    ): Promise<void> {
        logger.error(
            `[mojo] containment handle could not be persisted for pid ${child.pid}; `
            + `terminating the just-started subtree: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.emitLine('❌ mojo 本轮启动失败：进程围栏无法登记，已终止刚启动的子进程。', 'err');
        const prepared = this.preparedBoundary;
        // Belt and braces alongside cgroup.kill: the direct child is its own
        // group leader (detached:true), so the group signal reaches a pre-exec
        // shim that has not enrolled yet.
        if (typeof child.pid === 'number' && child.pid > 0) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
            try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
        // Wait for the reap: a SIGKILLed member lingers in cgroup.procs as a
        // zombie until its parent (us) collects it, and the rmdir proof below
        // would spin against that zombie forever.
        await new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
            child.once('close', () => { clearTimeout(timer); resolve(); });
        });
        if (prepared) {
            this.preparedBoundary = null;
            if (await killPreparedBoundary(prepared)) {
                this.containmentUnrecorded = false;
                return;
            }
            logger.error(
                `[mojo] boundary ${prepared.cgroupPath} could not be proven empty after the record `
                + 'failure; every close proof for this generation stays refused',
            );
        } else {
            // Weak path: no boundary to prove emptiness with. The latch stays set —
            // the tree may have descendants only a recorded handle could enumerate.
            logger.error(
                '[mojo] unrecorded subtree was signalled but cannot be proven terminated '
                + '(no strong boundary); every close proof for this generation stays refused',
            );
        }
        // Fail-closed state must live in the DURABLE store, not only in this
        // memory latch: if the worker later dies, the workerless proof finds no
        // outstanding handle and would publish a plain `closed`, dropping the
        // blocker the latch was holding — and the latch dies with the process.
        // Retry the record so `hasUnprovenContainment` stays true across a worker
        // death (and `mojo-containment revoke` has something to target). If it
        // still fails, the memory latch remains as the last line.
        try {
            recordContainmentHandle(prepared
                ? strongHandleFromPreparedBoundary(prepared)
                : acquireContainmentHandle({
                    sessionId: this.sessionId,
                    generation: this.containmentGeneration,
                    rootPid: child.pid ?? this.lastTurnPid ?? 0,
                    nonce: this.treeNonce,
                }));
        } catch (err) {
            logger.error(
                `[mojo] durable re-record of the unrecorded subtree ALSO failed; the fail-closed `
                + `state survives only in memory for this worker's lifetime: ${String(err)}`,
            );
        }
    }

    /**
     * Discharge every DURABLE handle this session owns, after the in-memory ladder
     * believes its own root is gone.
     *
     * The in-memory verdict only ever speaks for the pid THIS backend spawned. A
     * replacement generation inherits handles describing trees it never spawned, and
     * those must be proven independently or the close stays refused. A handle leaves
     * the store only against a `proven: true` verdict — `releaseContainmentHandle`
     * takes the verdict itself and throws on anything else, so "clear the blocker
     * without proof" is not representable here.
     */
    private dischargeContainment(
        outstanding: readonly ContainmentHandle[],
        cleanVerdict: TurnQuiescence,
    ): TurnQuiescence {
        const decisions: ContainmentReleaseDecision[] = [];
        for (const handle of outstanding) {
            // An inherited handle means this generation TOOK OVER responsibility for
            // cleaning that tree. Only proving it (never signalling it) left an
            // escaped survivor that nothing would ever kill: every /close retry
            // re-proved it alive and refused, so the session could never be closed
            // while the credentialed process kept running. Proof alone turns the
            // handle into a permanent tombstone, so signal first, then prove.
            //
            // Signalling is strictly GATED, because a pid is not an identity:
            //   * weak handle   only when weakHandleRootStillOriginal confirms the
            //                   recorded pid is still the same process (same boot id
            //                   AND same starttime). Without that, the number may
            //                   have been recycled onto a stranger and negating it
            //                   would take down an unrelated process group.
            //   * unprovable    never: it has no pid to signal at all.
            // Failing the gate means "do not signal", NOT "the tree is gone" — the
            // proof below still has to speak for the subtree.
            if (handle.kind === 'tree-identity') {
                const rootStillOriginal = weakHandleRootStillOriginal(handle, { procRoot: this.procRoot });
                if (!rootStillOriginal) {
                    logger.warn(
                        `[mojo] inherited handle ${containmentHandleKey(handle)}: recorded root pid is no `
                        + 'longer the original process (recycled or gone), so its GROUP will not be '
                        + 'signalled; enumerated members are still signalled individually',
                    );
                }
                this.signalInheritedTree(handle, rootStillOriginal);
            }
            const verdict = proveContainmentQuiescent(handle, {
                procRoot: this.procRoot,
                // `scanned: false` must NEVER collapse into `pids: []`: an empty pid
                // list reads as "nothing alive", which is precisely the fail-open the
                // scanner's failure modes exist to prevent.
                scan: weak => {
                    const scan = scanMojoTree(weak.rootPid, weak.nonce, {
                        procRoot: this.procRoot,
                        excludePids: this.selfPids(),
                        // The handle's RECORDED identity, so PGID claiming stays
                        // disabled once the pid stops being the original process.
                        rootIdentity: { pid: weak.rootPid, bootId: weak.bootId, starttime: weak.startTime },
                    });
                    return scan.ok
                        // Zombies are discounted here for the SAME reason the
                        // in-memory verdict discounts them: a reaped process
                        // executes nothing and cannot use the credential. Passing
                        // them through made the two paths disagree — the ladder
                        // called the tree clean while the handle proof called the
                        // very same tree alive, so a correct close was refused and
                        // the handle could never be discharged.
                        ? { scanned: true, pids: scan.members.filter(m => !m.zombie).map(m => m.pid) }
                        : { scanned: false, pids: [], reason: scan.reason };
                },
            });
            if (!verdict.proven) {
                logger.error(
                    `[mojo] inherited turn subtree (${containmentHandleKey(handle)}) could not be `
                    + `proven quiescent (${verdict.reason}); refusing the close so the `
                    + 'device-isolation blocker is retained',
                );
                // Do NOT hand-roll the projection here. `unscannable` routes to a
                // FENCE, which latches write admission and fails the close; that is
                // right when a retry might still produce proof, and permanently wrong
                // on a host that can never enumerate at all. An INHERITED unprovable
                // handle is exactly that host: every /close after a worker generation
                // replacement re-derived `unscannable`, so admission stayed latched and
                // the session could never be closed -- the same permanent wedge C-7
                // fixed on the primary path, still reachable through this one.
                // `containmentQuiescence` owns the grading and maps an unprovable
                // handle to `unsupported-platform`, which routes to a RESIDUAL CLOSE:
                // the row closes, the blocker stays on the handle that was never
                // released. Grading belongs to the containment module, not to a
                // second copy of its rules living here.
                return containmentQuiescence(verdict);
            }
            // The decision is the containment module's to make, not ours: it says
            // whether the handle was actually discharged and whether a residual
            // must survive the close. Discarding it here and re-deriving the answer
            // from `handle.kind` is what made this path contradict the store --
            // a bootId-aged-out weak handle really was released, while the verdict
            // still reported `diagnostic-clean`, so the outcome asked the daemon to
            // keep a device-isolation blocker whose only evidence (the handle) had
            // just been deleted. The blocker IS the handle, so that was a lie in the
            // safe-looking direction, and a lie is what the review is about.
            decisions.push(releaseContainmentHandle(verdict));
        }
        // A boundary proof is the only thing that may upgrade the verdict, and
        // `boundaryProof` is the single field allowed to say so. It is true for
        // exactly ONE evidence — a changed boot id (a reboot), for a weak handle
        // OR a cgroup handle whose stamped bootId is gone. It is FALSE for a merely
        // clean /proc scan AND for an empty cgroup (a same-UID process can migrate
        // itself out of the leaf), both of which stay `diagnostic-clean` and keep
        // their residual.
        if (decisions.length > 0 && decisions.every(d => d.boundaryProof)) {
            // Built by the containment module, which owns the only constructor of a
            // proven boundary; this layer decides WHETHER it applies, never what it
            // looks like. Fabricating a verdict to feed containmentQuiescence would
            // be wrong here: a weak handle aged out by a changed boot id is a real
            // boundary proof, yet a synthesised cgroup-empty verdict on that same
            // handle would be graded back down to a diagnostic scan.
            return containedProvenQuiescence();
        }
        return cleanVerdict;
    }

    /** Pids that must never be signalled, whatever a scan says. */
    private selfPids(): number[] {
        return [process.pid, process.ppid].filter(pid => typeof pid === 'number' && pid > 0);
    }

    /**
     * SIGKILL an inherited tree whose recorded root identity has already been
     * re-verified by the caller.
     *
     * SIGTERM is skipped deliberately: this tree belongs to a previous worker
     * generation that is already gone, so nobody is waiting to shut it down
     * gracefully, and the graceful attempt was made when that generation closed.
     * Every enumerated member is signalled individually as well, because a
     * descendant may have left the group via setsid and would survive the group
     * signal alone.
     *
     * Best effort by design: this only creates the CHANCE for the proof below to
     * succeed. If anything survives, the proof still refuses the close.
     */
    private signalInheritedTree(handle: WeakContainmentHandle, rootStillOriginal: boolean): void {
        logger.warn(
            `[mojo] signalling inherited turn subtree rooted at ${handle.rootPid}: this generation owns `
            + 'its cleanup, and proving it without signalling would leave the session permanently unclosable',
        );
        // The RECORDED identity, never a fresh read: re-reading the pid here and
        // passing that as "expected" made signalTurnTreeGroup compare a value to
        // itself, so the whole verification collapsed to a race — a pid recycled
        // between the caller's gate and this signal would still have its (new)
        // group taken down. signalTurnTreeGroup re-reads internally and refuses
        // on mismatch against the identity recorded when the tree was spawned.
        if (rootStillOriginal) {
            signalTurnTreeGroup(
                { pid: handle.rootPid, bootId: handle.bootId, starttime: handle.startTime },
                'SIGKILL',
                { procRoot: this.procRoot },
            );
        }
        // Per-member signals stay safe even when the recorded root is long gone, and
        // this is the case that actually matters: a descendant that called setsid
        // OUTLIVES its parent, so the root-identity gate can never pass for it.
        //
        // Two properties make each kill attributable:
        //   * HANDLE nonce, not this.treeNonce: the constructor only adopts the
        //     FIRST inherited handle's nonce, so scanning a later handle with the
        //     adopted nonce found nothing by env at all — its tree was only ever
        //     reachable through fragile pgid number collisions.
        //   * the recorded root identity gates PGID claiming inside the scan, so
        //     every member here was claimed via the env nonce (or as a descendant
        //     of one), which is positive evidence of THIS tree's membership — and
        //     the target is a single positive pid rather than a negated group, so
        //     even a raced pid cannot drag an unrelated group down with it.
        //
        // Without this, an escaped survivor was re-proven alive on every retry and
        // never signalled, so the session could never be closed at all.
        const scan = scanMojoTree(handle.rootPid, handle.nonce, {
            procRoot: this.procRoot,
            excludePids: this.selfPids(),
            rootIdentity: { pid: handle.rootPid, bootId: handle.bootId, starttime: handle.startTime },
        });
        if (!scan.ok) return;
        for (const member of scan.members) {
            if (member.zombie) continue;   // already reaped; signalling it is pointless
            try { process.kill(member.pid, 'SIGKILL'); } catch { /* raced us */ }
        }
    }

    kill(): void {
        if (this.killed) return;
        this.killed = true;
        // Daemon shutdown / worker teardown. SIGTERM is not proof of anything, and
        // NOTHING is released here on purpose: the handles recorded at spawn are
        // durable, so an unproven tree survives the restart as an explicit blocker
        // instead of being silently forgotten. Calling releaseContainmentHandle on
        // this path would be exactly the laundering this review exists to remove.
        try {
            const stillOwned = containmentHandles(this.sessionId).length;
            if (stillOwned > 0) {
                logger.warn(
                    `[mojo] shutdown leaves ${stillOwned} unproven turn subtree(s) for `
                    + `${this.sessionId}; the blocker will be reloaded on the next boot`,
                );
            }
        } catch (err) {
            // Never let an unreadable store turn shutdown into a crash; the store
            // being unreadable already means the next boot fails closed.
            logger.warn(`[mojo] cannot report outstanding turn subtrees at shutdown: ${String(err)}`);
        }
        this.shutdownDetachWake?.();
        for (const wake of this.lineageWaiters) wake();
        this.child?.kill('SIGTERM');
        this.child = null;
        // Mirror RiffBackend: the server-side mojo session KEEPS RUNNING here.
        // kill() fires on worker teardown / daemon restart, where the persisted
        // cliSessionId resumes the lineage afterwards. Cancelling the remote
        // session belongs to the explicit /close path (destroySession).
        this.exitCb?.(0, null);
    }

    /** Test-only view of the adopted lineage, so a teardown test can assert it is
     *  still unset inside the pre-init window it is exercising. */
    get cliSessionIdForTest(): string | undefined {
        return this.cliSessionId ?? undefined;
    }

    /** /close teardown — cancel the server-side session so it stops consuming
     *  cloud sandbox time after the IM session is gone. */
    async destroySession(): Promise<SessionDestroyResult> {
        // Set when the local subtree is unprovable for a reason no retry can fix
        // (a platform with no /proc). Carried onto the successful result as an
        // explicit residual marker rather than silently dropped.
        let residualOnPlatform = false;
        // Set when the ladder completed cleanly but produced no unforgeable boundary
        // proof (Linux weak handle / diagnostic-clean). Distinct from
        // residualOnPlatform: that one is "this host has no instrument at all", this
        // one is "the instrument answered, and its answer is not proof".
        let residualBoundaryUnproven = false;
        if (this.shutdownDetaching) {
            return {
                ok: false,
                ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
                error: 'shutdown_detach_in_progress',
            };
        }
        if (this.containmentUnrecorded) {
            // A spawned subtree exists that no durable handle describes (the record
            // failed and termination could not be proven). Publishing ANY close
            // verdict would drop the device-isolation blocker over a tree we cannot
            // enumerate, so the close is refused outright.
            this.closing = true;
            this.admissionFenced = true;
            return {
                ok: false,
                ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
                error: 'containment_unrecorded_subtree',
                recovery: 'retryable',
                admission: 'fenced',
            };
        }
        // Gate FIRST so no new turn is accepted, then let the in-flight one settle
        // before tearing anything down. Killing the child here (as this used to)
        // destroyed the only source of the lineage: cliSessionId is adopted from
        // the first `system/init` line, so a /close inside the "turn dispatched,
        // init not yet arrived" window found it null, skipped the cancel, and never
        // fired taskIdCb — leaving the daemon's orphan fallback without an id too.
        // The remote session then leaked, still holding the injected credential.
        //
        // Bounded, and only worth waiting for while a turn is actually in flight.
        // Budget sits under the worker's own close/restart race (see
        // RiffBackend.destroySession for the layered deadlines).
        this.closing = true;
        // Gate on "a turn was dispatched and its lineage has not arrived", NOT on
        // `this.child`. Keying it on a live child meant a mojo that accepted the
        // write and then exited before emitting `system/init` skipped the wait
        // entirely — and with cliSessionId still null the cancel below was skipped
        // too, so this returned ok:true for a remote session we cannot even name.
        // `prepareShutdownDetach` already uses this exact predicate
        // (`lineageExpected`); the two protocols must agree about what "proven
        // gone" means.
        const lineageExpected = this.acceptedWriteWithoutLineage;
        if (lineageExpected && !this.cliSessionId) {
            await Promise.race([
                this.writeChain.catch(() => undefined),
                new Promise<void>(r => setTimeout(r, this.destroySettleMs).unref?.()),
            ]);
        }
        // Order matters: the local subtree is torn down BEFORE the remote cancel,
        // and a failure here returns immediately. The cancel is the only
        // irreversible step, so it must never run while an earlier step can still
        // veto the close -- previously an unproven local child still fell through
        // to a successful cancel, producing a failure the caller was told to roll
        // back even though the remote session was already gone forever.
        //
        // SIGTERM is not proof, and neither is the direct pid — see
        // terminateChildProven.
        const termination = await this.terminateChildProven();
        if (!termination.ok) {
            // Two very different facts reach this branch, and collapsing them is
            // what wedged non-Linux hosts.
            //
            //  * "the instrument says something may still be running" — real
            //    evidence of a possibly credentialed survivor. Admission must be
            //    fenced, because admitting a new turn would layer it on top of a
            //    live orphan.
            //  * "this host has no instrument at all" — off Linux there is no
            //    /proc, so no retry, no delay and no operator action can ever turn
            //    this into a proof. Fencing it made /close fail forever AND
            //    refused every rollback, so the session could neither be closed
            //    nor written to again.
            //
            // classifyUnprovenTermination owns that split (see destroy-result.ts);
            // anything it does not positively recognise as a terminal platform
            // limit falls through to the fence, so the default stays fail-closed.
            const verdict = classifyUnprovenTermination(this.lastTurnQuiescence?.kind);
            if (verdict.outcome === 'residual-close') {
                // Deliberately NOT setting admissionFenced: that latch is exactly
                // the wedge. The credential boundary is carried instead by the
                // containment handle recorded at spawn — on a host this branch can
                // be reached from, that handle is `unprovable`, which can never be
                // released, so the device-isolation blocker is retained.
                //
                // Execution deliberately CONTINUES into the remote cancel below: a
                // residual local subtree is no reason to leak the remote session.
                logger.warn(
                    `[mojo] session ${this.sessionId}: local turn subtree cannot be proven gone on `
                    + `this platform (${verdict.reason}); closing with a residual marker instead of `
                    + 'fencing the session forever — the device-isolation blocker is retained by the '
                    + 'durable containment handle',
                );
                residualOnPlatform = true;
            } else {
                // `closing` deliberately STAYS true, and the fence is latched. The
                // close is retryable (the irreversible remote cancel below has NOT
                // run), but a process that may still hold the injected credential is
                // possibly alive — admitting a new turn would layer it on top of that
                // live orphan. Clearing `closing` here is what made a post-abort
                // write() succeed on exactly this state.
                this.admissionFenced = true;
                // A dispatched turn whose lineage never materialised is an UNCERTAIN
                // outcome in its own right, and this earlier local failure must not
                // launder it into `retryable`: the very next check below would have
                // returned `uncertain` for the same session. Whichever step fails
                // first, an unnamable remote session stays unnamable.
                const unnamedRemotePossible = lineageExpected && !this.cliSessionId;
                return {
                    ok: false,
                    ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
                    error: verdict.reason,
                    recovery: unnamedRemotePossible ? 'uncertain' : 'retryable',
                    admission: 'fenced',
                };
            }
        } else if (!termination.boundaryProven) {
            // THE GATE. The ladder completed and found no executing member, but no
            // unforgeable boundary was established -- on Linux this is the weak
            // handle / `diagnostic-clean` case, which the old bare boolean laundered
            // into a plain `closed` row. A closed row is filtered out of the
            // device-isolation inventory, so the blocker vanished for a subtree that
            // a setsid'd, environ-scrubbed descendant could still be living in.
            //
            // Reviewer's second option, deliberately not the first: the clean scan is
            // allowed to stop the signalling (`signalsStopped`) and the session row is
            // allowed to close, but it does NOT authorise a plain closed row. The
            // residual marker below is what carries the device-isolation blocker past
            // the close.
            //
            // Admission is deliberately NOT fenced: unlike the `!ok` branch there is
            // no positive evidence of a live member, and fencing every clean-scan
            // close would wedge ordinary Linux sessions forever. Execution continues
            // into the remote cancel for the same reason it does on the
            // residual-close path: a residual LOCAL subtree is no reason to leak the
            // REMOTE session.
            //
            // Releasing the handle is not done here by design -- that decision lives
            // in mojo-containment.ts, and only `boundaryProven === true` may authorise
            // it. This branch is the negative case, so it releases nothing.
            logger.warn(
                `[mojo] session ${this.sessionId}: local turn subtree scanned clean but the credential `
                + `boundary is NOT proven (evidence ${termination.evidence}`
                + `${termination.residual?.reason ? `: ${termination.residual.reason}` : ''}); closing with a `
                + 'residual marker instead of a plain closed row — the device-isolation blocker is retained',
            );
            residualBoundaryUnproven = true;
        }
        // A turn was dispatched but its lineage never materialised: there may be a
        // remote session we have no id for, so it cannot be cancelled and cannot be
        // claimed gone. Same verdict prepareShutdownDetach reaches from this state.
        if (lineageExpected && !this.cliSessionId) {
            // `closing` deliberately STAYS true. Clearing it here re-opened write
            // admission (a probe called write() straight after and it returned
            // true), which is exactly what `uncertain` must prevent: an unnamed
            // remote session may exist, so a fresh turn must not be layered on top
            // of a possible orphan. abortDestroySession() is the only legitimate
            // way back, and the worker must not call it for this verdict.
            // taskId is deliberately omitted rather than null: SessionDestroyResult
            // types it as an optional string, and "absent" is the honest answer —
            // there is no id to hand back for retry.
            //
            // `uncertain`, not `retryable`: an unnamed remote session may exist, so
            // admission must stay fenced instead of starting a fresh lineage on top
            // of a possible orphan. The row stays active, which keeps the
            // device-isolation blocker in place.
            this.admissionFenced = true;
            return {
                ok: false,
                error: 'mojo_lineage_not_materialized',
                recovery: 'uncertain',
                admission: 'fenced',
            };
        }
        if (this.cliSessionId) {
            let outcome: MojoCancelOutcome;
            try {
                await this.runCliJson(['session', 'cancel', this.cliSessionId]);
                outcome = { kind: 'cancelled' };
                logger.info(`[mojo] cancelled session ${this.cliSessionId}`);
            } catch (err: unknown) {
                outcome = classifyMojoCancelFailure(err);
                logger.warn(`[mojo] session cancel failed: ${String(err)}`);
            }
            if (!isMojoRemoteGone(outcome)) {
                // Report it instead of swallowing it. This used to return void on
                // every path, so the worker ACKed a "successful" close and the
                // daemon published a closed row while the remote session kept
                // running and holding the injected credential.
                //
                // `killed` deliberately stays false and recovery is `retryable`:
                // the remote session was NOT torn down, so restoring admission is
                // both safe and required for the retry.
                this.closing = false;
                return {
                    ok: false,
                    taskId: this.cliSessionId,
                    error: outcome.kind === 'failed' ? outcome.message : 'cancel not proven',
                    recovery: 'retryable',
                    // The local subtree was PROVEN gone above and the remote session
                    // is named, so there is no unnamed survivor to fence against.
                    admission: 'restorable',
                };
            }
        }
        this.killed = true;
        // Reap this session's isolated execution daemon LAST, after the close
        // verdict is already decided: a reaping failure is a leaked idle daemon
        // (availability), never grounds to fail or roll back a close whose
        // remote cancel already happened. kill()/shutdown-detach deliberately
        // do NOT reap — the session survives a daemon restart and its daemon
        // must keep serving the resumed lineage.
        if (this.hostExecution() && !this.controlPlaneOnly) {
            await cleanupMojoIsolatedWorkspace(this.sessionId, { home: this.isolationHome() })
                .catch(() => undefined);
        }
        return {
            ok: true,
            ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
            ...(residualOnPlatform
                ? { residual: 'local_subtree_unprovable_on_platform' as const }
                : residualBoundaryUnproven
                    ? { residual: 'local_subtree_boundary_unproven' as const }
                    : {}),
        };
    }

    /**
     * Roll back a FAILED prepare (restore write admission).
     *
     * Only valid when the cancel did not succeed. A proven cancel is irreversible:
     * the remote session is gone, so restoring admission would produce a session
     * that looks active but can never continue.
     */
    abortDestroySession(): SessionAbortDestroyResult {
        if (this.killed) {
            logger.warn('[mojo] abortDestroySession ignored: session was already torn down');
            // The session is gone for good, so writes are not "restored" here
            // either; saying otherwise would let the daemon clear a fence that the
            // irreversible teardown owns.
            return { admissionRestored: false, reason: 'session_already_torn_down' };
        }
        // A latched fence outranks the rollback. The daemon/worker may legitimately
        // abort a close it could not commit, but "the close was abandoned" is not
        // evidence that the possibly-live local subtree died, so restoring writes
        // here would defeat the fence destroySession deliberately kept.
        if (this.admissionFenced) {
            logger.warn(
                '[mojo] abortDestroySession did NOT restore write admission: a previous close '
                + 'could not prove local termination (or the turn lineage never materialised). '
                + 'This session will not accept writes again; retry the close instead',
            );
            // Reported, not swallowed: the daemon must persist "still fenced" rather
            // than infer success from a call that did not throw.
            return { admissionRestored: false, reason: 'local_termination_unproven' };
        }
        this.closing = false;
        return { admissionRestored: true };
    }

    /**
     * Prepare a daemon-restart detach without cancelling the remote Mojo
     * session. Unlike Riff, a Mojo turn can legitimately run for 60 seconds;
     * shutdown only needs the lineage from its first `system/init`, not the
     * whole answer. Therefore a pre-init turn waits at most destroySettleMs,
     * while a known lineage (or an idle backend with no accepted turn) prepares
     * immediately.
     */
    async prepareShutdownDetach(): Promise<SessionShutdownDetachResult> {
        if (this.shutdownDetachInFlight) return this.shutdownDetachInFlight;
        if (this.shutdownDetachPrepared) {
            return { ok: true, taskId: this.cliSessionId };
        }
        if (this.killed) {
            return { ok: false, taskId: this.cliSessionId, error: 'backend_killed' };
        }
        if (this.closing) {
            return { ok: false, taskId: this.cliSessionId, error: 'explicit_close_in_progress' };
        }

        const attempt = Symbol('mojo-shutdown-detach');
        const acceptedWrites = this.writeChain;
        const lineageExpected = this.acceptedWriteWithoutLineage;
        this.shutdownDetachAttempt = attempt;
        this.shutdownDetaching = true;

        const prepare = (async (): Promise<SessionShutdownDetachResult> => {
            if (!this.cliSessionId && lineageExpected) {
                await new Promise<void>((resolve) => {
                    let settled = false;
                    const finish = (): void => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        this.lineageWaiters.delete(finish);
                        if (this.shutdownDetachWake === finish) this.shutdownDetachWake = null;
                        resolve();
                    };
                    const timer = setTimeout(finish, this.destroySettleMs);
                    timer.unref?.();
                    this.lineageWaiters.add(finish);
                    this.shutdownDetachWake = finish;
                    void acceptedWrites.then(finish, finish);
                    if (this.cliSessionId) finish();
                });

                if (this.killed || this.shutdownDetachAttempt !== attempt || !this.shutdownDetaching) {
                    return { ok: false, taskId: this.cliSessionId, error: 'shutdown_detach_aborted' };
                }
                if (!this.cliSessionId) {
                    return {
                        ok: false,
                        taskId: null,
                        error: 'mojo_lineage_not_materialized',
                    };
                }
            }

            if (this.closing) {
                return { ok: false, taskId: this.cliSessionId, error: 'explicit_close_in_progress' };
            }
            this.shutdownDetachPrepared = true;
            logger.info(
                `[mojo] graceful shutdown detach prepared`
                + `${this.cliSessionId ? ` (session ${this.cliSessionId})` : ' (no session lineage)'}`,
            );
            return { ok: true, taskId: this.cliSessionId };
        })();
        this.shutdownDetachInFlight = prepare.finally(() => {
            this.shutdownDetachInFlight = null;
        });
        return this.shutdownDetachInFlight;
    }

    async abortShutdownDetach(): Promise<SessionShutdownDetachResult> {
        if (this.killed) {
            return { ok: false, taskId: this.cliSessionId, error: 'backend_killed' };
        }
        if (this.shutdownDetachAbortInFlight) return this.shutdownDetachAbortInFlight;
        const pending = this.shutdownDetachInFlight;
        this.shutdownDetachAttempt = null;
        this.shutdownDetachPrepared = false;
        this.shutdownDetachWake?.();
        this.shutdownDetachAbortInFlight = (async (): Promise<SessionShutdownDetachResult> => {
            if (pending) await pending.catch(() => undefined);
            if (this.killed) {
                return { ok: false, taskId: this.cliSessionId, error: 'backend_killed' };
            }
            if (this.closing || this.shutdownDetachAttempt !== null) {
                return {
                    ok: false,
                    taskId: this.cliSessionId,
                    error: this.closing ? 'explicit_close_in_progress' : 'new_shutdown_detach_in_progress',
                };
            }
            this.shutdownDetaching = false;
            logger.info('[mojo] graceful shutdown detach aborted; write admission restored');
            return { ok: true, taskId: this.cliSessionId };
        })().finally(() => {
            this.shutdownDetachAbortInFlight = null;
        });
        return this.shutdownDetachAbortInFlight;
    }

    commitShutdownDetach(): void {
        this.shutdownDetachPrepared = false;
        this.shutdownDetachAttempt = null;
        // Keep admission fenced until the worker exits immediately after commit.
        this.shutdownDetaching = true;
    }

    // ── One turn ─────────────────────────────────────────────────────────────

    private buildArgs(prompt: string): string[] {
        const args: string[] = ['-p', '--output-format', 'stream-json'];
        // Token-level deltas → the IM layer can live-edit the reply card.
        if (this.config.stream !== false) args.push('--include-partial');
        // `--help` says the default is to auto-REJECT tools needing confirmation,
        // but that is NOT what happens on the cloud-sandbox path: verified without
        // --yolo that `echo … > f && cat f` returned return_code 0 with the file
        // actually written, and that `rm -rf <dir>` likewise succeeded — no
        // rejection, no warning, no interaction. So this flag is belt-and-braces
        // rather than load-bearing; we keep it for explicitness and in case a
        // future mojo build does enforce a confirmation gate headlessly.
        //
        // Consequence worth stating plainly (review F4): host execution is now
        // the DEFAULT, and with --yolo there is no per-tool approval — a mojo
        // bot's blast radius on the host is bounded only by the OS user and the
        // bot's allowedUsers gate. Operators who don't accept that must set
        // `cloud: true` (fully-remote sandbox) or `localDaemon: false`.
        if (this.config.disableCliBypass !== true) args.push('--yolo');
        if (this.cliSessionId) args.push('-r', this.cliSessionId);
        if (this.config.model?.trim()) args.push('--model', this.config.model.trim());
        if (this.config.workspaceId) args.push('--workspace-id', this.config.workspaceId);
        if (this.config.agentId && !this.cliSessionId) args.push('--agent-id', this.config.agentId);
        // Run in the cloud sandbox instead of touching the bot host's filesystem.
        // Shared derivation with buildEnv()/the spawn audit log — see
        // deriveMojoExecutionMode for the precedence rules (explicit
        // localDaemon wins and suppresses --cloud) and why hand-copying this
        // logic produced fail-opens before.
        if (deriveMojoExecutionMode(this.config).passCloudFlag) args.push('--cloud');
        if (this.config.idleTimeoutSec) args.push('--idle-timeout', String(this.config.idleTimeoutSec));
        // Before the positional prompt, which must stay last. Placed after our own
        // flags so an operator's CLI_EXTRA_ARGS can override them.
        args.push(...this.extraCliArgs);
        args.push(this.decorate(prompt));
        return args;
    }

    /** Retry the "session still RUNNING" race with backoff (see SESSION_BUSY_RE). */
    private async runTurnWithBusyRetry(prompt: string): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const busy = await this.runTurn(prompt);
            if (!busy) return;
            const delay = BUSY_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) {
                this.emitLine('❌ mojo 会话持续处于执行中，本条消息未能送达，请稍后重发。', 'err');
                this.settleTurn();
                return;
            }
            logger.info(`[mojo] session busy; retrying in ${delay}ms`);
            await new Promise<void>(r => setTimeout(r, delay));
            if (this.killed || this.closing) return;
        }
    }

    /** Resolves `true` when the turn was rejected because the session is still
     *  RUNNING (caller should retry), `false` once the turn is accounted for. */
    private runTurn(prompt: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const { bin, args } = this.resolveLaunch(this.buildArgs(prompt));
            this.turnSettled = false;
            this.streamedThisTurn = false;
            this.turnFinalText = '';
            this.stdoutTail = '';

            // The strong boundary must exist BEFORE the child does, and the child
            // must enter it BEFORE exec (see MOJO_CGROUP_ENROLL_SHIM): post-spawn
            // migration leaves already-forked descendants outside the cgroup, which
            // voids the entire strong proof. Null → weak handle fallback. Skipped
            // entirely once a prior turn proved enrolment impossible on this host.
            this.preparedBoundary = this.strongBoundaryUnusable
                ? null
                : prepareContainmentBoundary(
                    {
                        sessionId: this.sessionId,
                        generation: this.containmentGeneration,
                        nonce: this.treeNonce,
                    },
                    {
                        ...(this.cgroupRoot !== undefined ? { cgroupRoot: this.cgroupRoot } : {}),
                        ...(this.cgroupProcRoot !== undefined ? { procRoot: this.cgroupProcRoot } : {}),
                    },
                );
            this.usedEnrolShim = this.preparedBoundary !== null;
            const launchBin = this.preparedBoundary ? '/bin/sh' : bin;
            const launchArgs = this.preparedBoundary
                ? [
                    '-c', MOJO_CGROUP_ENROLL_SHIM, 'mojo-cgroup-enroll',
                    `${this.preparedBoundary.cgroupPath}/cgroup.procs`,
                    bin, ...args,
                ]
                : args;

            const child = spawnProcess(launchBin, launchArgs, {
                cwd: this.resolveCwd(),
                env: this.buildEnv(),
                // stdin MUST be closed: mojo waits on socket-type stdin and an open
                // pipe makes `-p` block until EOF (observed as a silent hang).
                stdio: ['ignore', 'pipe', 'pipe'],
                // Own process GROUP, so teardown can prove the whole subtree is
                // gone instead of only the direct child. mojo runs tools and can
                // leave detached descendants that inherited X_JWT_TOKEN; those
                // survive a kill aimed at the direct pid, and the close would
                // still publish a `closed` row -- dropping the device-isolation
                // blocker while a credentialed process is still executing.
                //
                // Without a dedicated group there is no safe fix: the child would
                // share the daemon's group, so `kill(-pgid)` would take down the
                // daemon itself. detached only changes group/session membership
                // here; the pipes are still owned and awaited, so nothing is
                // orphaned by this flag on its own.
                detached: true,
            });
            this.child = child;
            if (typeof child.pid === 'number' && child.pid > 0) {
                this.lastTurnPid = child.pid;
                // Bind the identity NOW, while the pid is guaranteed to still be
                // this child: read later, it could already describe a recycled pid.
                const id = readProcessIdentity(child.pid, { procRoot: this.procRoot });
                this.turnIdentity = id.ok ? id.identity : null;
                if (!id.ok) {
                    // Without an identity the group signal must be refused later, so
                    // say so once, loudly, rather than discovering it during teardown.
                    logger.warn(
                        `[mojo] cannot bind turn identity for pid ${child.pid} (${id.reason}); `
                        + 'group signalling will be refused and quiescence cannot be proven',
                    );
                }
                // Close the EMPTY-AT-BIRTH window: the strong handle is recorded
                // now, but its cgroup stays empty until the shim's own write lands
                // (~1-5ms). A workerless prove+release racing that window would read
                // the cgroup empty and drop the blocker while the shim then execs a
                // credentialed binary. The parent writes child.pid too — idempotent
                // with the shim's write (same pid), so the cgroup is non-empty from
                // the instant the handle exists. This does NOT reintroduce the old
                // post-spawn-migration P0: the shim forks nothing before enrolling,
                // so there are no pre-enrolment descendants to miss.
                if (this.preparedBoundary) {
                    try {
                        writeFileSync(`${this.preparedBoundary.cgroupPath}/cgroup.procs`, `${child.pid}\n`);
                    } catch {
                        // The shim's own write remains the authoritative enrolment;
                        // this is belt-and-braces. A failure here is not fatal.
                    }
                }
                // Mint and PERSIST the containment handle before the child can act.
                // Doing this at close time would be too late: a crash in between is
                // exactly the window that loses the tree, and a lost tree is one the
                // next generation can never prove quiescent.
                try {
                    this.recordTurnContainment(child.pid);
                } catch (err) {
                    // A child is RUNNING and nothing durable describes it. Failing
                    // only the turn would leave that subtree alive behind a blocker
                    // nobody recorded — so terminate it now, and refuse every close
                    // proof until termination is itself proven (the latch is set
                    // FIRST so a concurrent /close cannot slip through the async
                    // window below).
                    this.containmentUnrecorded = true;
                    void this.containUnrecordedSpawn(child, err).catch((e: unknown) => {
                        logger.error(`[mojo] containUnrecordedSpawn crashed (latch retained): ${String(e)}`);
                    });
                }
            }
            let stderr = '';

            child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()));
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

            child.on('error', (err: Error) => {
                this.child = null;
                // Spawn failed: nothing ever ran, so nobody enrolled. Reap the
                // prepared boundary (a recorded handle, if the record already
                // happened, owns the directory instead and preparedBoundary is null).
                const prepared = this.preparedBoundary;
                if (prepared) {
                    this.preparedBoundary = null;
                    void killPreparedBoundary(prepared);
                }
                reject(err);
            });
            // 'close' alone is NOT a reliable end-of-turn signal here: in host
            // execution the CLI auto-spawns the per-workspace mojo-daemon as its
            // CHILD, which inherits our stdout/stderr pipes and keeps them open
            // for its whole lifetime — 'close' then never fires even though the
            // client exited minutes ago, the runTurn promise stays pending, and
            // every later write queues forever (observed live: turn 2 of a DM
            // session hung 8+ minutes with the daemon healthy). 'exit' + settled
            // turn is already conclusive; when the turn is NOT settled yet, give
            // trailing pipe output a bounded grace and then finalize anyway.
            let finalized = false;
            const finalize = (code: number | null): void => {
                if (finalized) return;
                finalized = true;
                this.child = null;
                this.flushTail();
                // The pre-exec shim's handshake: enrolment into the prepared cgroup
                // failed, so it exited WITHOUT exec'ing mojo (nothing credentialed
                // ran). Gated on `usedEnrolShim` so a genuine mojo exit 97 (on a
                // weak-handle host, where no shim runs) is NOT misread as this and
                // does not lose its normal exit handling. On a real enrolment
                // failure the strong boundary is latched unusable, so the NEXT turn
                // degrades to a weak handle instead of failing here forever (the
                // prepare-time probe cannot catch a write-time delegation refusal).
                if (this.usedEnrolShim && code === MOJO_ENROLL_FAILED_EXIT
                    && !this.streamedThisTurn && !this.turnSettled) {
                    this.strongBoundaryUnusable = true;
                    logger.error(
                        '[mojo] cgroup enrolment was rejected at write time (exit 97); this host cannot '
                        + 'host a strong boundary, degrading to the weak handle for subsequent turns',
                    );
                    this.emitLine('❌ mojo 启动失败：无法进入进程围栏（cgroup 入组被拒），本轮未执行，后续改用降级隔离。', 'err');
                    this.settleTurn();
                    return resolve(false);
                }
                // exit 2 == unknown model; stderr carries the authoritative list.
                if (code === 2 && /未知模型|unknown model/i.test(stderr)) {
                    this.emitLine(`❌ 模型名无效。${stderr.trim()}`, 'err');
                    this.settleTurn();
                    return resolve(false);
                }
                // Busy race: nothing was streamed and the session is still RUNNING.
                if (!this.turnSettled && SESSION_BUSY_RE.test(stderr)) return resolve(true);
                // Dead resume lineage → drop it and let the user retry fresh.
                if (!this.turnSettled && this.maybeDropLineage(stderr)) {
                    this.settleTurn();
                    return resolve(false);
                }
                // A `result` event already settled the turn in the normal path
                // (including the ask-user cancellation, which also exits 1).
                if (!this.turnSettled) {
                    if (code !== 0) {
                        this.emitLine(
                            `❌ mojo 退出码 ${code}${stderr.trim() ? `：${stderr.trim()}` : ''}`,
                            'err',
                        );
                    }
                    this.settleTurn();
                }
                resolve(false);
            };
            child.on('close', (code: number | null) => finalize(code));
            child.on('exit', (code: number | null) => {
                if (this.turnSettled) {
                    // The result event already accounted for this turn; nothing
                    // the withheld pipes could still deliver changes the verdict.
                    finalize(code);
                    return;
                }
                // Not settled: stderr/stdout may still be in flight through the
                // pipes (they outlive the process). Bounded grace, then the same
                // single finalize path — 'close' beats the timer when it does fire.
                const t = setTimeout(() => finalize(code), 2_000);
                t.unref?.();
            });
        });
    }

    /**
     * Drop a dead resume lineage so the NEXT message starts a fresh session
     * instead of re-sending the same doomed `-r <sid>` forever.
     *
     * Mirrors RiffBackend's broken-lineage path: the `null` broadcast is what
     * clears the DAEMON-side persisted id — without it a daemon restart would
     * resurrect the very session we just declared dead.
     *
     * Returns true when the lineage was dropped (caller must not treat the turn
     * as a generic failure).
     */
    private maybeDropLineage(stderr: string): boolean {
        // Only meaningful when this turn actually resumed something.
        if (!this.cliSessionId) return false;
        if (!RESUME_DEAD_RE.test(stderr)) return false;
        logger.warn(`[mojo] resume lineage ${this.cliSessionId} looks dead; starting fresh next turn`);
        this.cliSessionId = null;
        this.taskIdCb?.(null);
        this.emitLine('⚠️ 之前的 mojo 会话已失效，下一条消息将新建会话（上下文不会延续）。', 'warn');
        return true;
    }

    /** Parse NDJSON incrementally — a chunk may split a line in half. */
    private consume(chunk: string): void {
        this.stdoutTail += chunk;
        const lines = this.stdoutTail.split('\n');
        this.stdoutTail = lines.pop() ?? '';
        for (const line of lines) this.handleLine(line);
    }

    private flushTail(): void {
        const line = this.stdoutTail;
        this.stdoutTail = '';
        if (line.trim()) this.handleLine(line);
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (!trimmed.startsWith('{')) {
            // Startup notices / update hints are plain text — surface them dimly
            // rather than corrupting the transcript.
            logger.info(`[mojo] ${trimmed}`);
            return;
        }
        let ev: MojoStreamEvent;
        try {
            ev = JSON.parse(trimmed) as MojoStreamEvent;
        } catch {
            logger.warn(`[mojo] unparseable stream line: ${trimmed.slice(0, 200)}`);
            return;
        }
        switch (ev.type) {
            case 'system': {
                const e = ev as Extract<MojoStreamEvent, { type: 'system' }>;
                if (e.subtype === 'init') this.adoptSession(e.session_id, e.model);
                return;
            }
            case 'text_delta': {
                const e = ev as Extract<MojoStreamEvent, { type: 'text_delta' }>;
                if (e.text) {
                    this.streamedThisTurn = true;
                    this.emitText(e.text);
                }
                return;
            }
            case 'text': {
                // With --include-partial the deltas already rendered this text.
                const e = ev as Extract<MojoStreamEvent, { type: 'text' }>;
                if (!this.streamedThisTurn && e.text) this.emitText(e.text);
                return;
            }
            case 'tool_call': {
                const e = ev as Extract<MojoStreamEvent, { type: 'tool_call' }>;
                this.emitLine(`🔧 ${e.name ?? '(tool)'}${this.summarizeInput(e.input)}`, 'info');
                return;
            }
            case 'tool_result': {
                // Without this the user sees `🔧 Bash {...}`, then 20–30s of dead
                // air while the tool runs, then a sudden final answer — it reads
                // like a hang. Surface a one-line outcome instead.
                const e = ev as Extract<MojoStreamEvent, { type: 'tool_result' }>;
                this.emitLine(this.summarizeToolResult(e.output), 'plain');
                return;
            }
            case 'result':
                this.handleResult(ev as Extract<MojoStreamEvent, { type: 'result' }>);
                return;
            default:
                logger.info(`[mojo] unhandled event type: ${String(ev.type)}`);
        }
    }

    private adoptSession(id?: string, model?: string): void {
        if (!id || id === this.cliSessionId) return;
        this.cliSessionId = id;
        this.acceptedWriteWithoutLineage = false;
        for (const wake of this.lineageWaiters) wake();
        // Available in the FIRST event, so the lineage is persisted even if the
        // turn later dies — no grok-style "recapture the id afterwards" needed.
        this.taskIdCb?.(id);
        logger.info(`[mojo] session ${id} (model=${model ?? 'default'})`);
    }

    private handleResult(ev: Extract<MojoStreamEvent, { type: 'result' }>): void {
        // Some flows emit only `result` without any text event.
        if (!this.streamedThisTurn && typeof ev.result === 'string' && ev.result) {
            this.emitText(ev.result);
        }

        const warnings: unknown[] = Array.isArray(ev.warnings) ? ev.warnings : [];
        const askSkipped = warnings.some(w => ASK_USER_SKIPPED_RE.test(String(w)));
        if (askSkipped) {
            // The single most confusing failure mode: the agent wanted to ask a
            // clarifying question, mojo dropped it, and the turn came back
            // cancelled with little or no text.
            this.emitLine('⚠️ mojo 想向你追问以确认细节，但无头模式下提问会被自动跳过，本回合已中断。', 'warn');
            this.emitLine('请把缺少的信息（例如具体文件 / 路径 / 目标）补全后重新发一次。', 'info');
        } else {
            for (const w of warnings) this.emitLine(`⚠️ ${String(w)}`, 'warn');
        }
        if (ev.error && !askSkipped) this.emitLine(`❌ ${this.fmtErr(ev.error)}`, 'err');
        this.settleTurn();
    }

    /**
     * Fire the turn boundary exactly once.
     *
     * This is the ONLY authority on when a mojo turn ends, which is why the
     * worker must not run its generic IdleDetector for this backend: that
     * detector infers "done" from ~2s of output quiescence, and a mojo turn goes
     * quiet for far longer while a tool runs. An early idle would re-arm
     * prompt-ready mid-turn, flushing queued messages into a session that is
     * still RUNNING (rejected — see SESSION_BUSY_RE) and attributing the reply
     * to the wrong turn/card. See the `isRemoteBackendType` gate in worker.ts.
     */
    private settleTurn(): void {
        // `turnSettled` alone provides the once-per-turn guarantee. A
        // `seenResults` Set used to be maintained alongside it and described as
        // "session ids whose boundary already fired", but nothing ever queried it
        // — it was only added to and, past a cap, cleared wholesale. Dead state
        // reading as if it enforced cross-turn dedup, so it is gone rather than
        // left to mislead. If per-session result dedup is ever actually needed,
        // it has to be a real lookup here.
        if (this.turnSettled) return;
        this.turnSettled = true;
        // BEFORE taskDoneCb: that callback re-arms prompt-ready and flushes
        // queued follow-ups, so emitting the answer afterwards would race the
        // next turn's card/turn attribution. A turn that produced no prose
        // (tool-only, cancelled, failed) hands over '' and the worker's gate
        // drops it — the backend does not decide deliverability.
        const finalText = this.turnFinalText;
        this.turnFinalText = '';
        this.turnFinalCb?.(finalText);
        this.taskDoneCb?.();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** `error` is an object ({code, message, retryable}) on both envelope shapes;
     *  naive interpolation yields "[object Object]". */
    private fmtErr(err: unknown): string {
        if (!err) return '未知错误';
        if (typeof err === 'string') return err;
        if (err instanceof Error) return err.message;
        const e = err as MojoError;
        const code = e.code ? `[${e.code}] ` : '';
        return `${code}${e.message ?? JSON.stringify(err)}`;
    }

    /** Condense a tool_result payload into one status line. The output is a JSON
     *  string for shell-like tools ({return_code, stdout, stderr, status}) but may
     *  be arbitrary text for others, so both shapes are handled. */
    private summarizeToolResult(output: unknown): string {
        if (output === undefined || output === null) return '   ↳ (无输出)';
        const raw = typeof output === 'string' ? output : JSON.stringify(output);
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch { /* plain text result */ }
        if (parsed && typeof parsed === 'object' && 'return_code' in parsed) {
            const p = parsed as { return_code?: unknown; stdout?: unknown; stderr?: unknown };
            const ok = p.return_code === 0;
            const body = String(p.stdout || p.stderr || '').trim();
            const head = ok ? '   ↳ ✓' : `   ↳ ✗ exit ${String(p.return_code)}`;
            return body ? `${head} ${this.clip(body)}` : head;
        }
        return `   ↳ ${this.clip(raw)}`;
    }

    private clip(s: string, n = 160): string {
        const oneLine = s.replace(/\s+/g, ' ').trim();
        return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
    }

    private summarizeInput(input: unknown): string {
        if (!input) return '';
        const s = typeof input === 'string' ? input : JSON.stringify(input);
        const oneLine = s.replace(/\s+/g, ' ').trim();
        return oneLine ? ` ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}` : '';
    }

    /**
     * Prepend the platform-owned skill block and the operator's systemPrompt.
     *
     * Order matters and is deliberate: the skill catalog is APPENDED after the
     * operator prompt, never merged into it. Folding it into `systemPrompt` would
     * mean a bot that sets its own prompt silently loses skill discovery — the
     * same trap riff documented for its mandatory routing rules.
     *
     * `builtinSkillBlock` is only populated for `prompt` / `off`; in `global`
     * mode the files are already on disk (~/.mojo/skills) so it stays empty.
     */
    private decorate(prompt: string): string {
        const preamble = [
            this.config.systemPrompt?.trim(),
            this.config.builtinSkillBlock?.trim(),
            this.hostGuidanceBlock(),
        ]
            .filter((s): s is string => !!s)
            .join('\n\n');
        return preamble ? `${preamble}\n\n---\n\n${prompt}` : prompt;
    }

    /**
     * Host-execution guidance (undefined in cloud mode). Two compensations for
     * the isolated per-session cwd:
     *   1. the initial working directory is NOT the repo — point the agent at
     *      the real one so repo work still lands in the right place;
     *   2. every botmux command carries an explicit `--session-id`: the
     *      execution daemon's env belongs to whichever session spawned it, so
     *      an inherited BOTMUX_SESSION_ID must never be what routes a reply
     *      (defence in depth — the isolated daemon already carries the right
     *      env, this survives even a regression back to a shared daemon).
     */
    private hostGuidanceBlock(): string | undefined {
        if (!this.hostExecution()) return undefined;
        const repo = this.realWorkingDir();
        const lines = [
            repo
                ? `你的工作仓库在 ${repo} 。当前初始工作目录是一个会话隔离目录,不含仓库文件;涉及仓库文件的读写或命令,请显式 \`cd ${repo}\` 后再执行。`
                : '当前初始工作目录是一个会话隔离目录;如需在某个仓库/目录下工作,请先显式 cd 过去。',
            `所有 botmux 命令请显式带 \`--session-id ${this.sessionId}\`(例:\`botmux send --session-id ${this.sessionId} ...\`),确保回话投递到本会话。`,
        ];
        return lines.join('\n');
    }

    private buildEnv(): NodeJS.ProcessEnv {
        // Layering, lowest → highest precedence:
        //   worker-supplied env (BOTMUX_* session context, redacted process env)
        //   → per-bot injectEnv (bots.json `env`, already sanitized)
        //   → bots.json `mojo.env`
        // Falling back to process.env keeps direct/unit use working when spawn()
        // was never called.
        // Shared with the launcher's wrapper resolution — see
        // buildEffectiveChildEnv. Do NOT re-inline this layering: the two sites
        // drifted apart once already and the launcher silently dropped mojo.env.
        const env: NodeJS.ProcessEnv = buildEffectiveChildEnv({
            base: this.spawnOpts?.env ?? process.env,
            botEnv: this.spawnOpts?.injectEnv,
            mojoEnv: this.config.env,
        });
        // Prefer an injected JWT so the bot never depends on an interactive
        // `mojo auth login` on the host. Verified: X_JWT_TOKEN makes
        // `mojo auth status --json` report mode=jwt / source=env.
        //
        // Read from the ALREADY-MERGED env, never from process.env: the daemon's
        // ambient X_JWT_TOKEN is the lowest layer of that merge, so reaching back
        // to process.env here would let the host's token override a per-bot one
        // and silently run the bot as the wrong identity.
        // `jwtEnv` decides only WHERE the value is read from; the child is always
        // handed it under the canonical name below. The remote-execution proof
        // relies on exactly this (mojoUnprovableEnvKeys exempts the canonical name
        // and never `jwtEnv`), so both sites share one constant rather than two
        // literals that could drift apart and silently re-open the bypass.
        const jwtKey = this.config.jwtEnv ?? MOJO_CANONICAL_JWT_ENV_KEY;
        if (this.liveJwt !== undefined) {
            // A live snapshot is authoritative and already includes the daemon's
            // ambient fallback. `null` therefore means "no credential anywhere", so
            // the inherited value must be REMOVED rather than left to stand in —
            // otherwise deleting `mojo.jwt` / `jwtEnv` revived the stale token.
            delete env[jwtKey];
            delete env[MOJO_CANONICAL_JWT_ENV_KEY];
            if (this.liveJwt !== null) env[MOJO_CANONICAL_JWT_ENV_KEY] = this.liveJwt;
        } else {
            const jwt = this.config.jwt ?? env[jwtKey];
            if (jwt) env[MOJO_CANONICAL_JWT_ENV_KEY] = jwt;
        }

        // ── Control plane: config is the ONLY source ──────────────────────────
        // Drop every inherited control-plane variable BEFORE re-deriving it. The
        // mojo CLI reads its endpoint/profile/execution mode from env, so leaving
        // an inherited value in place is a back door around the frozen identity:
        // a live `env: { AGENT_BASE_URL: <tenant-b> }` would move an existing
        // session to another tenant even though `baseUrl` itself is frozen. Note
        // these were previously only CONDITIONALLY overwritten (`if (baseUrl)`),
        // so a session whose frozen snapshot had no baseUrl silently inherited it.
        //
        // Unconditional delete also means "frozen as unset" is honoured: the CLI
        // falls back to its own default instead of a value the operator added
        // after this session was created.
        for (const key of MOJO_CONTROL_ENV_KEYS) delete env[key];

        if (this.config.baseUrl) env.AGENT_BASE_URL = this.config.baseUrl;
        if (this.config.ppeEnv) env.MOJO_PPE_ENV = this.config.ppeEnv;
        // Execution mode. Host execution is the DEFAULT, matching every other
        // CLI adapter (claude-code, codex, … all run on the bot host): a mojo
        // bot with no `mojo` block used to be forced into the cloud sandbox
        // (AGENT_LOCAL_DAEMON=0 without --cloud), where `botmux` does not exist
        // while the skill catalog still teaches `botmux send` — the session
        // could neither see the host nor reply through the current bot.
        // '0' is written exactly when the config itself asks for it:
        //   · cloud=true with localDaemon unset — the fully-remote shape that
        //     isMojoFullyRemote() accepts as proof of remote execution, or
        //   · an explicit localDaemon=false — operator opt-out of host tools
        //     (without cloud=true the CLI then falls back to its sandbox).
        // `=== true` / `=== false`, NOT truthy: this value must stay in strict
        // lockstep with isMojoFullyRemote(), which compares strictly. A truthy
        // check here made the string "false" mean "local execution ON" while the
        // sandbox check read it as "not local, safe to bypass" — isolation off and
        // host execution on at once. Always written (never inherited), so an
        // ambient AGENT_LOCAL_DAEMON cannot flip the mode either way.
        env.AGENT_LOCAL_DAEMON = deriveMojoExecutionMode(this.config).agentLocalDaemon;
        // Never let an interactive upgrade prompt pollute the NDJSON stream.
        env.MOJO_NO_UPDATE = '1';
        // Termination authority, not configuration: this value is what makes the
        // subtree enumerable in /proc after a descendant escapes the process group
        // via setsid. It carries no privilege and is safe to expose to the child.
        //
        // Asserted LAST, as a hard invariant of this function: not only can no
        // config layer shadow it, no DELETE above can erase it either. Config
        // validation already rejects a `jwtEnv` naming a reserved key, but frozen
        // snapshots written by older builds bypass re-validation, and a
        // `delete env[jwtKey]` that hit this name would blind scanMojoTree to
        // every escaped descendant while the close still reported clean.
        env[MOJO_TREE_NONCE_ENV] = this.treeNonce;
        return env;
    }

    /** Single-shot CLI call returning one JSON envelope (session.* subcommands). */
    private async runCliJson(args: string[]): Promise<MojoCliEnvelope> {
        const out = await this.runCli(args);
        // Startup notices can precede the envelope — take the last JSON line
        // rather than parsing the whole buffer.
        const line = out.split(/\r?\n/).map(l => l.trim())
            .filter(l => l.startsWith('{') && l.endsWith('}')).pop();
        if (!line) throw new Error(`no JSON envelope in output: ${out.slice(0, 300)}`);
        const env = JSON.parse(line) as MojoCliEnvelope;
        if (env.error) throw new Error(this.fmtErr(env.error));
        return env;
    }

    private runCli(args: string[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const launch = this.resolveLaunch(args);
            const child = spawnProcess(launch.bin, launch.args, {
                cwd: this.resolveCwd(),
                env: this.buildEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`mojo ${args.join(' ')} timed out after ${this.cliTimeoutMs}ms`));
            }, this.cliTimeoutMs);
            child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
            child.on('close', (code: number | null) => {
                clearTimeout(timer);
                if (code !== 0 && !stdout.trim()) {
                    return reject(new Error(`mojo exited ${code}: ${stderr.trim() || '(no stderr)'}`));
                }
                resolve(stdout);
            });
        });
    }

    /** Probe the authoritative model list: an invalid --model exits 2 and prints
     *  "可用模型：a、b、c" to stderr. */
    async probeModels(): Promise<string[] | null> {
        try {
            await this.runCli(['-p', '--model', '__botmux_probe_invalid__', 'x']);
            return null;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err ?? '');
            const m = /可用模型：(.+)$/m.exec(msg);
            return m ? m[1].split(/[、,]/).map(s => s.trim()).filter(Boolean) : null;
        }
    }

    /** `mojo auth status --json` → {logged_in, identity, mode, source, expires_at}. */
    async authStatus(): Promise<MojoAuthStatus | null> {
        const out = await this.runCli(['auth', 'status', '--json']);
        const line = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop();
        return line ? (JSON.parse(line) as MojoAuthStatus) : null;
    }

    private emitLine(text: string, style: MojoLineStyle = 'info'): void {
        const codes: Record<MojoLineStyle, string> = {
            info: '\x1b[36m',
            warn: '\x1b[33m',
            ok: '\x1b[32m',
            err: '\x1b[31m',
            title: '\x1b[1m',
            plain: '',
        };
        const open = codes[style] ?? '';
        const close = open ? '\x1b[0m' : '';
        const line = `\r\n${open}${text}${close}\r\n`;
        this.outputBuffer += line;
        this.dataCb?.(line);
    }

    /** Normalize newlines for xterm rendering (bare \n → \r\n). */
    private emitText(text: string): void {
        const normalized = text.replace(/\r?\n/g, '\r\n');
        this.outputBuffer += normalized;
        // Keep the bridge copy in the CLI's own newline convention — it is
        // destined for a Lark message, not a terminal.
        this.turnFinalText += text;
        this.dataCb?.(normalized);
    }
}

/**
 * Classify a failed `session cancel` into the outcome model.
 *
 * Currently ALWAYS `failed`. Distinguishing "the session had already finished"
 * from "cancellation is broken" requires the real @byted/mojo error codes/states,
 * which are not calibrated yet — and guessing from stderr text is precisely the
 * mistake that made the old boolean ambiguous. Failing closed here means a close
 * refuses rather than silently claiming a still-running session is gone.
 *
 * When the codes ARE calibrated (needs intranet CLI + a real JWT), this is the one
 * place that changes: return `already_terminal` with the matched code as evidence.
 */
function classifyMojoCancelFailure(err: unknown): MojoCancelOutcome {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', message, retryable: true };
}

/**
 * Cancel a mojo session by id WITHOUT a live backend instance.
 *
 * The daemon needs this on the workerless `/close` path: the worker is already
 * gone, so `MojoBackend.destroySession()` is unreachable, yet the server-side
 * session must stop consuming cloud sandbox time (and stop an agent that may
 * still hold injected credentials). Mirrors `cancelRiffTaskById`.
 *
 * One retry, then a STRUCTURED outcome — see MojoCancelOutcome for why this is no
 * longer a boolean.
 */
export async function cancelMojoSessionById(
    config: EffectiveMojoConfig,
    sessionId: string,
): Promise<MojoCancelOutcome> {
    // Reuse the instance's CLI plumbing (env layering, JSON envelope parsing,
    // timeout) rather than duplicating spawn logic here. The sentinel session id
    // is only used for logging.
    const backend = (() => {
        try {
            return new MojoBackend(config, 'orphan-cancel', { controlPlaneOnly: true });
        } catch {
            return null;
        }
    })();
    if (backend === null) {
        // The constructor fails closed when the containment store is unreadable,
        // which is correct — but this function DECLARES a structured outcome, and a
        // throw here does not stay local. Its call site in worker-pool is a
        // fire-and-forget `void cancelMojoSessionById(...).then(...)` with no
        // .catch(), and the daemon installs no unhandledRejection handler, so on
        // Node 22 an unreadable store would terminate the daemon and every session
        // it serves. Fail-closed must not mean fail-crash.
        //
        // Reporting `failed` keeps the intended semantics and is strictly stronger:
        // an unreadable store is not proof the remote session is gone, so the caller
        // refuses the close and the device-isolation blocker is retained.
        logger.error(
            `[mojo] cannot construct a cancel backend for session ${sessionId}: the containment `
            + 'store is unreadable, so the close is refused (the blocker is retained)',
        );
        return {
            kind: 'failed',
            message: `containment store unreadable for session ${sessionId}`,
            retryable: true,
        };
    }
    const attempt = async (): Promise<void> => {
        await backend['runCliJson'](['session', 'cancel', sessionId]);
    };
    // The LOCAL subtree first. "There is no worker" must never be read as "there is
    // no local process": the worker dying is exactly what orphans a credentialed
    // descendant. Cancelling the remote session says nothing about a local one, so
    // without this check the daemon publishes the row `closed`, the row drops out of
    // the device-isolation inventory, and the blocker disappears while a credentialed
    // process is still executing.
    const local = proveWorkerlessLocalSubtree(sessionId);
    if (local.unproven) return local.unproven;
    // A weak-only local proof must survive every remote-gone outcome, or the
    // caller publishes a plain `closed` row while the handle (and the blocker)
    // silently stays behind — the exact laundering this type exists to prevent.
    const carryResidual = (outcome: MojoCancelOutcome): MojoCancelOutcome =>
        local.residual !== null && outcome.kind !== 'failed'
            ? { ...outcome, localResidual: local.residual }
            : outcome;

    try {
        await attempt();
        return carryResidual({ kind: 'cancelled' });
    } catch {
        try {
            await attempt();
            return carryResidual({ kind: 'cancelled' });
        } catch (err: unknown) {
            const outcome = classifyMojoCancelFailure(err);
            logger.warn(
                `[mojo] orphan session cancel failed (session ${sessionId} may keep running remotely): ${String(err)}`,
            );
            return carryResidual(outcome);
        }
    }
}

/** The workerless local-subtree proof, split into its two independent answers. */
export interface WorkerlessLocalSubtreeProof {
    /** Non-null → quiescence itself is unproven; the close must be REFUSED. */
    unproven: MojoCancelOutcome | null;
    /**
     * Quiescence was proven, but at least one release decision kept its handle
     * (weak evidence carries no boundary proof), so the close may proceed ONLY
     * as `closed_with_residual`. Discarding this — the old contract returned
     * bare null here — published a plain `closed` row while the handle and the
     * device-isolation blocker silently stayed behind.
     */
    residual: MojoLocalCloseResidual | null;
}

/**
 * Prove (and discharge) the LOCAL subtree a dead worker may have left behind.
 *
 * `unproven: null` means every outstanding handle was proven quiescent (or none
 * existed). `residual` then reports whether any of those proofs was weak-only,
 * in which case the handle stays in the store and the caller must surface a
 * residual close instead of a plain one.
 */
export function proveWorkerlessLocalSubtree(
    sessionId: string,
    opts: { procRoot?: string } = {},
): WorkerlessLocalSubtreeProof {
    const procRoot = opts.procRoot ?? '/proc';
    const excludePids = [process.pid, process.ppid].filter(pid => typeof pid === 'number' && pid > 0);
    let outstanding: ContainmentHandle[];
    try {
        outstanding = containmentHandles(sessionId);
    } catch (err) {
        // Unreadable store: we cannot know what is outstanding, so the close must not
        // succeed. Retryable, because a later read may well work.
        return {
            unproven: {
                kind: 'failed',
                message: `cannot read containment store for ${sessionId}: ${String(err)}`,
                retryable: true,
            },
            residual: null,
        };
    }
    let residual: MojoLocalCloseResidual | null = null;

    for (const handle of outstanding) {
        const verdict: QuiescenceVerdict = proveContainmentQuiescent(handle, {
            procRoot,
            scan: weak => {
                const scan = scanMojoTree(weak.rootPid, weak.nonce, {
                    procRoot,
                    excludePids,
                    // Recorded identity gates PGID claiming, as on the teardown path.
                    rootIdentity: { pid: weak.rootPid, bootId: weak.bootId, starttime: weak.startTime },
                });
                // `scanned: false` must not collapse into `pids: []`: that reads as
                // "nothing alive" and would hand back a proof we do not have.
                return scan.ok
                    // Same zombie discount as the teardown path, so the workerless
                    // close cannot disagree with it about the same tree.
                    ? { scanned: true, pids: scan.members.filter(m => !m.zombie).map(m => m.pid) }
                    : { scanned: false, pids: [], reason: scan.reason };
            },
        });
        if (!verdict.proven) {
            logger.error(
                `[mojo] workerless close for ${sessionId}: local subtree `
                + `${containmentHandleKey(handle)} could not be proven quiescent (${verdict.reason}); `
                + 'refusing to report the session closed so its device-isolation blocker is retained',
            );
            return {
                unproven: {
                    kind: 'failed',
                    message: `local subtree unproven: ${verdict.reason}`,
                    retryable: true,
                },
                residual: null,
            };
        }
        const decision = releaseContainmentHandle(verdict);
        if (decision.residual !== null) {
            // Weak evidence: the handle (and the blocker) stays. The close may
            // proceed, but only as a residual one — mirrors the live-worker
            // teardown's `boundaryProven === false` branch so the two paths can
            // never disagree about the same evidence grade.
            logger.warn(
                `[mojo] workerless close for ${sessionId}: local subtree `
                + `${containmentHandleKey(handle)} scanned clean but the credential boundary is NOT `
                + `proven (evidence ${decision.evidence}); the close will carry a residual marker `
                + 'and the device-isolation blocker is retained',
            );
            residual = 'local_subtree_boundary_unproven';
        }
    }
    return { unproven: null, residual };
}
