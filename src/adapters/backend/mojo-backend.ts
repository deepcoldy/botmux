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
import type { Readable } from 'node:stream';
import { locateOnPath } from '../cli/registry.js';
import { buildWrappedLaunch } from '../../setup/cli-selection.js';
import { logger } from '../../utils/logger.js';
import type { SessionBackend, SpawnOpts } from './types.js';
import type {
    MojoAuthStatus,
    MojoBackendConfig,
    MojoCliEnvelope,
    MojoError,
    MojoLineStyle,
    MojoStreamEvent,
} from './mojo-types.js';

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

/** Cap on remembered settled-turn session ids (see settleTurn). */
const SEEN_RESULTS_MAX = 64;

/**
 * stdio is always `['ignore','pipe','pipe']` here (stdin MUST be closed — see
 * runTurn), so the child has NO stdin. `ChildProcessWithoutNullStreams` is the
 * wrong type for that shape and tsc rejects the cast; this is the accurate one.
 */
type MojoChild = ChildProcessByStdio<null, Readable, Readable>;

export class MojoBackend implements SessionBackend {
    private readonly config: MojoBackendConfig;
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
    /** True once the current turn has emitted its `result` event, so a late
     *  process exit cannot fire a second turn boundary. */
    private turnSettled = true;
    /** Bounded set of session ids whose boundary already fired. */
    private readonly seenResults = new Set<string>();
    /** Buffer for partial NDJSON lines across stdout chunks. */
    private stdoutTail = '';
    /** Set when --include-partial deltas have already rendered this turn's text,
     *  so the trailing whole-segment `text` event isn't printed twice. */
    private streamedThisTurn = false;
    private readonly cliTimeoutMs = 60_000;
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
    private writeChain: Promise<void> = Promise.resolve();

    constructor(config: MojoBackendConfig, sessionId: string) {
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

        // A launch prefix only ever reaches us from wrapperCli: the mojo adapter's
        // resolvedBin is '' and its buildArgs() returns [], and the sandbox
        // wrappers (which also rewrite spawnBin) are unreachable for this backend
        // — a fully-remote mojo session never requests the local sandbox, and a
        // locally-executing one that does is refused before spawn (see
        // backendSandboxCompatibilityError).
        if (this.config.wrapperCli) {
            this.wrapperResolved = true;
            if (bin) {
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
        return { bin: this.config.bin ?? 'mojo', args: cliArgs };
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
            const launch = buildWrappedLaunch(wrapperCli, [], b => locateOnPath(b) ?? b);
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

    write(data: string): void {
        if (this.killed || this.closing) return;
        const text = data.trim();
        if (!text) return;
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

    kill(): void {
        if (this.killed) return;
        this.killed = true;
        this.child?.kill('SIGTERM');
        this.child = null;
        // Mirror RiffBackend: the server-side mojo session KEEPS RUNNING here.
        // kill() fires on worker teardown / daemon restart, where the persisted
        // cliSessionId resumes the lineage afterwards. Cancelling the remote
        // session belongs to the explicit /close path (destroySession).
        this.exitCb?.(0, null);
    }

    /** /close teardown — cancel the server-side session so it stops consuming
     *  cloud sandbox time after the IM session is gone. */
    async destroySession(): Promise<void> {
        this.closing = true;
        this.child?.kill('SIGTERM');
        this.child = null;
        if (this.cliSessionId) {
            try {
                await this.runCliJson(['session', 'cancel', this.cliSessionId]);
                logger.info(`[mojo] cancelled session ${this.cliSessionId}`);
            } catch (err: unknown) {
                // Best-effort: a completed session cannot be cancelled and that is fine.
                logger.warn(`[mojo] session cancel failed: ${String(err)}`);
            }
        }
        this.killed = true;
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
        if (!this.config.disableCliBypass) args.push('--yolo');
        if (this.cliSessionId) args.push('-r', this.cliSessionId);
        if (this.config.model?.trim()) args.push('--model', this.config.model.trim());
        if (this.config.workspaceId) args.push('--workspace-id', this.config.workspaceId);
        if (this.config.agentId && !this.cliSessionId) args.push('--agent-id', this.config.agentId);
        // Run in the cloud sandbox instead of touching the bot host's filesystem.
        if (this.config.cloud) args.push('--cloud');
        if (this.config.idleTimeoutSec) args.push('--idle-timeout', String(this.config.idleTimeoutSec));
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
        this.settleTurn(ev.session_id);
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
    private settleTurn(resultSessionId?: string): void {
        if (this.turnSettled) return;
        this.turnSettled = true;
        if (resultSessionId) {
            this.seenResults.add(resultSessionId);
            if (this.seenResults.size > SEEN_RESULTS_MAX) this.seenResults.clear();
        }
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

    private decorate(prompt: string): string {
        return this.config.systemPrompt
            ? `${this.config.systemPrompt}\n\n---\n\n${prompt}`
            : prompt;
    }

    private buildEnv(): NodeJS.ProcessEnv {
        // Layering, lowest → highest precedence:
        //   worker-supplied env (BOTMUX_* session context, redacted process env)
        //   → per-bot injectEnv (bots.json `env`, already sanitized)
        //   → bots.json `mojo.env`
        // Falling back to process.env keeps direct/unit use working when spawn()
        // was never called.
        const env: NodeJS.ProcessEnv = {
            ...(this.spawnOpts?.env ?? process.env),
            ...(this.spawnOpts?.injectEnv ?? {}),
            ...(this.config.env ?? {}),
        };
        // Prefer an injected JWT so the bot never depends on an interactive
        // `mojo auth login` on the host. Verified: X_JWT_TOKEN makes
        // `mojo auth status --json` report mode=jwt / source=env.
        //
        // Read from the ALREADY-MERGED env, never from process.env: the daemon's
        // ambient X_JWT_TOKEN is the lowest layer of that merge, so reaching back
        // to process.env here would let the host's token override a per-bot one
        // and silently run the bot as the wrong identity.
        const jwtKey = this.config.jwtEnv ?? 'X_JWT_TOKEN';
        const jwt = this.config.jwt ?? env[jwtKey];
        if (jwt) env.X_JWT_TOKEN = jwt;
        if (this.config.baseUrl) env.AGENT_BASE_URL = this.config.baseUrl;
        // A bot host must not run a local execution daemon on behalf of chat users.
        env.AGENT_LOCAL_DAEMON = this.config.localDaemon ? '1' : '0';
        // Never let an interactive upgrade prompt pollute the NDJSON stream.
        env.MOJO_NO_UPDATE = '1';
        if (this.config.ppeEnv) env.MOJO_PPE_ENV = this.config.ppeEnv;
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
 * Cancel a mojo session by id WITHOUT a live backend instance.
 *
 * The daemon needs this on the workerless `/close` path: the worker is already
 * gone, so `MojoBackend.destroySession()` is unreachable, yet the server-side
 * session must stop consuming cloud sandbox time (and stop an agent that may
 * still hold injected credentials). Mirrors `cancelRiffTaskById`.
 *
 * Best-effort with one retry; a session that already completed cannot be
 * cancelled and that is not an error worth surfacing.
 */
export async function cancelMojoSessionById(
    config: MojoBackendConfig,
    sessionId: string,
): Promise<boolean> {
    // Reuse the instance's CLI plumbing (env layering, JSON envelope parsing,
    // timeout) rather than duplicating spawn logic here. The sentinel session id
    // is only used for logging.
    const backend = new MojoBackend(config, 'orphan-cancel');
    const attempt = async (): Promise<void> => {
        await backend['runCliJson'](['session', 'cancel', sessionId]);
    };
    try {
        await attempt();
        return true;
    } catch {
        try {
            await attempt();
            return true;
        } catch (err: unknown) {
            logger.warn(
                `[mojo] orphan session cancel failed (session ${sessionId} may keep running remotely): ${String(err)}`,
            );
            return false;
        }
    }
}
