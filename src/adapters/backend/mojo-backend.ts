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
import { spawn as spawnProcess, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import { locateOnPath } from '../cli/registry.js';
import { buildWrappedLaunch } from '../../setup/cli-selection.js';
import { logger } from '../../utils/logger.js';
import type {
    SessionBackend,
    SessionDestroyResult,
    SessionShutdownDetachResult,
    SpawnOpts,
} from './types.js';
import {
    buildEffectiveChildEnv,
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

    private outputBuffer = '';
    /** mojo-side session id — the resume lineage. */
    private cliSessionId: string | null = null;
    private child: MojoChild | null = null;
    private killed = false;
    private closing = false;
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

    constructor(config: EffectiveMojoConfig, sessionId: string) {
        this.config = config;
        this.sessionId = sessionId;
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
        logger.info(`[mojo] spawn ${this.sessionId} in ${this.resolveCwd() ?? '(inherited cwd)'} (headless CLI invoked per turn)`);
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
    private resolveCwd(): string | undefined {
        return this.config.cwd ?? this.spawnOpts?.cwd;
    }

    write(data: string): boolean {
        if (this.killed || this.closing || this.shutdownDetaching) return false;
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
    private async terminateChildProven(): Promise<boolean> {
        const child = this.child;
        this.child = null;
        if (!child) return true;
        // Already reaped by the runtime: exitCode/signalCode are set only after the
        // process actually ended, so this IS proof.
        if (child.exitCode !== null || child.signalCode !== null) return true;

        const exited = new Promise<boolean>(resolve => {
            const done = (): void => resolve(true);
            child.once('exit', done);
            child.once('close', done);
            // A child that is already gone but whose 'exit' fired before we
            // subscribed would otherwise hang until the timeout.
            if (child.exitCode !== null || child.signalCode !== null) resolve(true);
        });
        const grace = Math.max(1, Math.floor(MOJO_CHILD_TERMINATION_PROOF_MS / 2));

        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const afterTerm = await Promise.race([
            exited,
            new Promise<false>(r => setTimeout(() => r(false), grace).unref?.()),
        ]);
        if (afterTerm) return true;

        // Escalate. SIGKILL cannot be caught, so a still-running process after this
        // means we genuinely cannot prove anything (e.g. uninterruptible state).
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const afterKill = await Promise.race([
            exited,
            new Promise<false>(r => setTimeout(() => r(false), MOJO_CHILD_TERMINATION_PROOF_MS - grace).unref?.()),
        ]);
        if (!afterKill) {
            logger.error(
                `[mojo] child pid ${child.pid ?? '?'} survived SIGTERM+SIGKILL; refusing to report `
                + 'the close as successful (a closed row would drop the device-isolation blocker)',
            );
        }
        return afterKill;
    }

    kill(): void {
        if (this.killed) return;
        this.killed = true;
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
        if (this.shutdownDetaching) {
            return {
                ok: false,
                ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
                error: 'shutdown_detach_in_progress',
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
        // SIGTERM is not proof — see terminateChildProven.
        const childTerminated = await this.terminateChildProven();
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
                // `killed` deliberately stays false: the session was NOT torn down,
                // and abortDestroySession() must be able to restore admission.
                this.closing = false;
                return {
                    ok: false,
                    taskId: this.cliSessionId,
                    error: outcome.kind === 'failed' ? outcome.message : 'cancel not proven',
                };
            }
        }
        // A turn was dispatched but its lineage never materialised: there may be a
        // remote session we have no id for, so we cannot claim it is gone. Same
        // verdict prepareShutdownDetach reaches from the same state.
        if (lineageExpected && !this.cliSessionId) {
            this.closing = false;
            // taskId is deliberately omitted rather than null: SessionDestroyResult
            // types it as an optional string, and "absent" is the honest answer —
            // there is no id to hand back for retry.
            return { ok: false, error: 'mojo_lineage_not_materialized' };
        }
        // The local child could not be proven dead. Refusing here keeps the durable
        // row active, which is what keeps the device-isolation blocker in place.
        if (!childTerminated) {
            this.closing = false;
            return {
                ok: false,
                ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}),
                error: 'mojo_local_child_termination_unproven',
            };
        }
        this.killed = true;
        return { ok: true, ...(this.cliSessionId ? { taskId: this.cliSessionId } : {}) };
    }

    /**
     * Roll back a FAILED prepare (restore write admission).
     *
     * Only valid when the cancel did not succeed. A proven cancel is irreversible:
     * the remote session is gone, so restoring admission would produce a session
     * that looks active but can never continue.
     */
    abortDestroySession(): void {
        if (this.killed) {
            logger.warn('[mojo] abortDestroySession ignored: session was already torn down');
            return;
        }
        this.closing = false;
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
        // rejection, no warning, no interaction. So on the recommended --cloud
        // config this flag is belt-and-braces rather than load-bearing; we keep it
        // for explicitness and in case the local-daemon path (AGENT_LOCAL_DAEMON=1,
        // untested here) does enforce a confirmation gate.
        //
        // Consequence worth stating plainly: a mojo bot's blast radius is bounded
        // by --cloud, NOT by per-tool approval. Do not run one against a host
        // filesystem you care about.
        if (this.config.disableCliBypass !== true) args.push('--yolo');
        if (this.cliSessionId) args.push('-r', this.cliSessionId);
        if (this.config.model?.trim()) args.push('--model', this.config.model.trim());
        if (this.config.workspaceId) args.push('--workspace-id', this.config.workspaceId);
        if (this.config.agentId && !this.cliSessionId) args.push('--agent-id', this.config.agentId);
        // Run in the cloud sandbox instead of touching the bot host's filesystem.
        // `=== true` to stay in lockstep with isMojoFullyRemote(), which decides
        // the sandbox bypass. A truthy check here could add --cloud for a value
        // the sandbox logic does NOT accept as proof of remote execution (or vice
        // versa), and the two disagreeing is exactly what produces a fail-open.
        if (this.config.cloud === true) args.push('--cloud');
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
            this.stdoutTail = '';

            const child = spawnProcess(bin, args, {
                cwd: this.resolveCwd(),
                env: this.buildEnv(),
                // stdin MUST be closed: mojo waits on socket-type stdin and an open
                // pipe makes `-p` block until EOF (observed as a silent hang).
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.child = child;
            let stderr = '';

            child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()));
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

            child.on('error', (err: Error) => {
                this.child = null;
                reject(err);
            });
            child.on('close', (code: number | null) => {
                this.child = null;
                this.flushTail();
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
        const preamble = [this.config.systemPrompt?.trim(), this.config.builtinSkillBlock?.trim()]
            .filter((s): s is string => !!s)
            .join('\n\n');
        return preamble ? `${preamble}\n\n---\n\n${prompt}` : prompt;
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
        // A bot host must not run a local execution daemon on behalf of chat users.
        // `=== true`, NOT truthy: this value also drives the sandbox bypass
        // decision via isMojoFullyRemote(), which compares strictly. A truthy
        // check here made the string "false" mean "local execution ON" while the
        // sandbox check read it as "not local, safe to bypass" — isolation off and
        // host execution on at once. Always written (never inherited), so an
        // ambient AGENT_LOCAL_DAEMON=1 cannot enable host execution either.
        env.AGENT_LOCAL_DAEMON = this.config.localDaemon === true ? '1' : '0';
        // Never let an interactive upgrade prompt pollute the NDJSON stream.
        env.MOJO_NO_UPDATE = '1';
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
    const backend = new MojoBackend(config, 'orphan-cancel');
    const attempt = async (): Promise<void> => {
        await backend['runCliJson'](['session', 'cancel', sessionId]);
    };
    try {
        await attempt();
        return { kind: 'cancelled' };
    } catch {
        try {
            await attempt();
            return { kind: 'cancelled' };
        } catch (err: unknown) {
            const outcome = classifyMojoCancelFailure(err);
            logger.warn(
                `[mojo] orphan session cancel failed (session ${sessionId} may keep running remotely): ${String(err)}`,
            );
            return outcome;
        }
    }
}
