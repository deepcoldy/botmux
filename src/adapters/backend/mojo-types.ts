/**
 * Types for the mojo (@byted/mojo) backend.
 *
 * Kept in a separate module so `mojo.ts` (the CLI adapter) and
 * `mojo-backend.ts` can share them without a cycle, and so the event shapes —
 * which were established empirically against @byted/mojo 1.0.10 — are
 * documented in one place.
 */

/** Per-bot config block, surfaced as `bots[].mojo` in bots.json. */
export interface MojoBackendConfig {
    /** Override the `mojo` executable (absolute path or PATH lookup name). */
    bin?: string;
    /** cwd for the spawned CLI. */
    cwd?: string;
    /** `--model`. Invalid values exit 2 with the authoritative list on stderr. */
    model?: string;
    /** `--workspace-id`. */
    workspaceId?: string;
    /** `--agent-id`. Only meaningful when creating (not resuming) a session. */
    agentId?: string;
    /** `--cloud` — run tools in the cloud sandbox instead of on the bot host. */
    cloud?: boolean;
    /** `--idle-timeout <sec>`. */
    idleTimeoutSec?: number;
    /**
     * Set true to NOT pass `--yolo`. Note this is not a real safety boundary on
     * the `--cloud` path; see the comment in `buildArgs()`.
     */
    disableCliBypass?: boolean;
    /** Default true. When false, `--include-partial` is omitted (no deltas). */
    stream?: boolean;
    /** Prepended to every prompt (botmux routing/identity block). */
    systemPrompt?: string;
    /** Literal JWT; wins over `jwtEnv`. */
    jwt?: string;
    /** Env var to read the JWT from. Defaults to `X_JWT_TOKEN`. */
    jwtEnv?: string;
    /** `AGENT_BASE_URL`. */
    baseUrl?: string;
    /** `AGENT_LOCAL_DAEMON=1` — runs tools on the bot host. Off by default. */
    localDaemon?: boolean;
    /** `MOJO_PPE_ENV`. */
    ppeEnv?: string;
    /** Persisted mojo session id, restored across daemon restarts. */
    resumeCliSessionId?: string;
    /**
     * INTERNAL, not a bots.json field. Mirrors the TOP-LEVEL
     * `BotConfig.wrapperCli`, which is the single source of truth for the launch
     * prefix across every CLI.
     *
     * It is carried here only so MojoBackend can re-apply the prefix to EVERY
     * per-turn invocation (unlike a PTY CLI there is no single long-lived process
     * to wrap once) and so the daemon's workerless cancel path can reconstruct
     * the same launch.
     *
     * Deliberately NOT user-configurable inside the `mojo` block: the worker's
     * wrapper handling (ttadk gateway injection, sandbox-takes-precedence, cjadk
     * special-casing) is all built around the top-level field, so a second entry
     * point would silently diverge — run through one wrapper, cancel through
     * another. `buildEffectiveMojoConfig` ignores any value found in the block,
     * and `/config set mojo` rejects it outright.
     */
    wrapperCli?: string;
    /**
     * Extra env for the spawned CLI. Merged ON TOP of the authoritative env the
     * worker hands to spawn() (which already carries the BOTMUX_* session
     * context and per-bot `env`), so an explicit value here wins — mirroring how
     * RiffBackendConfig.env layers over the session context.
     */
    env?: Record<string, string>;
}

/** `mojo auth status --json`. */
export interface MojoAuthStatus {
    logged_in?: boolean;
    identity?: string;
    mode?: string;
    source?: string;
    expires_at?: string;
    [k: string]: unknown;
}

/**
 * `error` is an OBJECT on both envelope shapes — naive interpolation yields
 * "[object Object]".
 */
export interface MojoError {
    code?: string;
    message?: string;
    retryable?: boolean;
    [k: string]: unknown;
}

/**
 * Foreground stream events (`-p --output-format stream-json --include-partial`).
 *
 * NOTE: this is NOT the `--background` / `session.*` schema-v1 envelope, which
 * additionally carries schema_version / operation / state / turn_id /
 * result_complete / interaction. Never assume `state` or `result_complete`
 * exists here.
 */
export type MojoStreamEvent =
    | { type: 'system'; subtype?: string; session_id?: string; model?: string }
    | { type: 'text_delta'; text?: string }
    | { type: 'text'; text?: string }
    | { type: 'tool_call'; id?: string; name?: string; input?: unknown }
    | { type: 'tool_result'; id?: string; output?: unknown }
    | {
        type: 'result';
        status?: string;
        result?: unknown;
        session_id?: string;
        duration_ms?: number;
        num_tool_calls?: number;
        warnings?: unknown;
        error?: MojoError | string | null;
    }
    | { type: string; [k: string]: unknown };

/** One JSON envelope from a `session.*` subcommand. */
export interface MojoCliEnvelope {
    error?: MojoError | string | null;
    [k: string]: unknown;
}

/** Line styles understood by `emitLine`. */
export type MojoLineStyle = 'info' | 'warn' | 'ok' | 'err' | 'title' | 'plain';

/**
 * Generic, host-owned session settings that must reach the mojo CLI. They are
 * resolved by botmux (dashboard, `botmux setup`, repo selection, bots.json) and
 * live OUTSIDE the `mojo` block, so a backend that only reads MojoBackendConfig
 * would silently ignore all of them.
 */
export interface MojoGenericLaunchInput {
    /** BotConfig.cliPathOverride — an operator-pinned mojo binary. */
    cliPathOverride?: string;
    /** Session working dir (repo selection writes this). */
    workingDir?: string;
    /** BotConfig.model / dashboard model picker. */
    model?: string;
    /** BotConfig.disableCliBypass — keep the CLI's own approvals. */
    disableCliBypass?: boolean;
    /** Per-bot env (bots.json `env`), already sanitized by the caller. */
    env?: Record<string, string>;
    /** Persisted remote lineage (Session.riffParentTaskId, shared by riff/mojo). */
    resumeCliSessionId?: string;
    /** BotConfig.wrapperCli — launch prefix, see MojoBackend.spawn. */
    wrapperCli?: string;
}

/**
 * Fold the generic session settings into the mojo-specific block, producing the
 * ONE config both the worker (live session) and the daemon (workerless `/close`)
 * must use.
 *
 * Sharing this matters: the daemon cancels an orphaned session WITHOUT a worker,
 * so it never calls spawn() and cannot pick these up from SpawnOpts. Building
 * the config only in the worker meant a bot running fine on a custom binary /
 * per-bot JWT could not be cancelled once its worker died — leaving the remote
 * session burning cloud sandbox time while still holding injected credentials.
 *
 * Precedence: an explicit value in the `mojo` block wins (it is the more
 * specific setting); the generic session value is the fallback.
 */
export function buildEffectiveMojoConfig(
    mojoBlock: MojoBackendConfig | undefined,
    generic: MojoGenericLaunchInput,
): MojoBackendConfig {
    const block = mojoBlock ?? {};
    // `??` throughout: the mojo block is the more specific setting and wins, but
    // only when actually set — `false` and `''` must not be treated as absent.
    const merged: MojoBackendConfig = { ...block };

    const bin = block.bin ?? emptyToUndefined(generic.cliPathOverride);
    if (bin !== undefined) merged.bin = bin;

    const cwd = block.cwd ?? generic.workingDir;
    if (cwd !== undefined) merged.cwd = cwd;

    const model = block.model ?? generic.model;
    if (model !== undefined) merged.model = model;

    const disableCliBypass = block.disableCliBypass ?? generic.disableCliBypass;
    if (disableCliBypass !== undefined) merged.disableCliBypass = disableCliBypass;

    // Per-bot env is the LOWER layer: an explicit `mojo.env` entry wins.
    if (generic.env || block.env) {
        merged.env = { ...(generic.env ?? {}), ...(block.env ?? {}) };
    }

    const resume = block.resumeCliSessionId ?? generic.resumeCliSessionId;
    if (resume !== undefined) merged.resumeCliSessionId = resume;

    // Top-level ONLY — see MojoBackendConfig.wrapperCli. A value in the block is
    // dropped here (and rejected at config time) rather than quietly winning,
    // which would make the run path and the cancel path use different wrappers.
    const wrapperCli = emptyToUndefined(generic.wrapperCli);
    if (wrapperCli !== undefined) merged.wrapperCli = wrapperCli;
    else delete merged.wrapperCli;

    return merged;
}

/** Treat a blank/whitespace-only override as unset. */
function emptyToUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
