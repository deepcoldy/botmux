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
