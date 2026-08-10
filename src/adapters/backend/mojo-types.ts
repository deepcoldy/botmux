/**
 * Types for the mojo (@byted/mojo) backend.
 *
 * Kept in a separate module so `mojo.ts` (the CLI adapter) and
 * `mojo-backend.ts` can share them without a cycle, and so the event shapes —
 * which were established empirically against @byted/mojo 1.0.10 — are
 * documented in one place.
 */

/**
 * USER-CONFIGURABLE mojo settings — the `bots[].mojo` block in bots.json,
 * `/config set mojo` and the dashboard.
 *
 * Deliberately contains ONLY settings with no platform-wide equivalent. Anything
 * botmux already resolves generically (the binary, working dir, model, approval
 * bypass, launch prefix) lives on the TOP-LEVEL bot config, is frozen onto the
 * session at creation, and must not have a second entry point here — see
 * EffectiveMojoConfig for why that matters.
 */
export interface MojoConfig {
    /** `--workspace-id`. */
    workspaceId?: string;
    /** `--agent-id`. Only meaningful when creating (not resuming) a session. */
    agentId?: string;
    /** `--cloud` — run tools in the cloud sandbox instead of on the bot host. */
    cloud?: boolean;
    /** `--idle-timeout <sec>`. */
    idleTimeoutSec?: number;
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
    /**
     * Extra env for the spawned CLI. Merged ON TOP of the authoritative env the
     * worker hands to spawn() (which already carries the BOTMUX_* session
     * context and per-bot `env`), so an explicit value here wins — mirroring how
     * RiffBackendConfig.env layers over the session context.
     */
    env?: Record<string, string>;
}

/**
 * Keys that are INTERNAL plumbing and must never be accepted from user config.
 *
 * Each has a platform-wide source of truth that is frozen onto the session at
 * creation (`Session.agentFrozen`), so a second entry point inside the `mojo`
 * block would let live edits override a frozen identity — e.g. cancelling an
 * orphaned remote session through a binary or wrapper the bot only gained
 * afterwards, reaching the wrong gateway or tenant.
 *
 * bots.json parsing and `/config set mojo` both reject these outright rather
 * than dropping them silently, because a silent drop reads as "applied".
 */
export const MOJO_INTERNAL_CONFIG_KEYS = [
    'bin',
    'cwd',
    'model',
    'disableCliBypass',
    'wrapperCli',
    'resumeCliSessionId',
    'extraCliArgs',
] as const;

/** The top-level bot field that owns each internal key, for error messages. */
export const MOJO_INTERNAL_KEY_OWNER: Readonly<Record<string, string>> = {
    bin: 'cliPathOverride',
    cwd: 'workingDir',
    model: 'model',
    disableCliBypass: 'disableCliBypass',
    wrapperCli: 'wrapperCli',
    resumeCliSessionId: '(managed by botmux)',
    extraCliArgs: 'CLI_EXTRA_ARGS',
};

/**
 * Control-plane fields that decide WHERE and AS WHOM a session executes:
 * cloud-vs-host execution, the API endpoint, the PPE profile, and the
 * workspace/agent it is routed to.
 *
 * These are frozen onto the session at creation (see MojoSessionIdentity). A live
 * bot edit must never retroactively move an existing session between execution
 * modes or tenants — a cold resume would otherwise resume, or a `/close` cancel,
 * against a different endpoint than the one that created the remote session.
 *
 * Credentials (`jwt` / `jwtEnv` / `env`) are deliberately NOT here: they must
 * stay live so a rotated token takes effect, and a plaintext JWT must not be
 * persisted into session state.
 */
export const MOJO_IDENTITY_KEYS = [
    'cloud',
    'localDaemon',
    'baseUrl',
    'ppeEnv',
    'workspaceId',
    'agentId',
] as const;

/**
 * The child's effective environment, layered lowest → highest precedence:
 *
 *   base (worker-supplied session env / process env)
 *   → bot `env`      (bots.json top-level, already sanitized)
 *   → `mojo.env`     (bots.json mojo block — highest)
 *
 * This exists so the launcher and the backend cannot disagree. They previously
 * layered independently and the launcher omitted `mojo.env` entirely, so a
 * wrapper binary was resolved against a PATH the child never actually ran with:
 * a same-named program earlier on the bot-level PATH shadowed the one the
 * operator pinned in `mojo.env.PATH`. For a wrapper that carries auth or acts
 * as a gateway, that means executing under the wrong identity.
 *
 * Callers that need control-plane hygiene must still strip
 * MOJO_CONTROL_ENV_KEYS afterwards; this helper only fixes the layering.
 */
export function buildEffectiveChildEnv(layers: {
    base?: NodeJS.ProcessEnv;
    botEnv?: NodeJS.ProcessEnv;
    mojoEnv?: Record<string, string> | undefined;
}): NodeJS.ProcessEnv {
    return {
        ...(layers.base ?? {}),
        ...(layers.botEnv ?? {}),
        ...(layers.mojoEnv ?? {}),
    };
}

/**
 * Environment variables that carry the SAME control-plane decisions as the frozen
 * identity keys. They exist because the mojo CLI reads its endpoint/profile from
 * env, which makes `env` a back door around the freeze: a live
 * `env: { AGENT_BASE_URL: ... }` would move an existing session to another tenant
 * even though `baseUrl` itself is frozen.
 *
 * buildEnv() therefore DELETES all of these after merging and re-derives them
 * from the (frozen) config alone. `X_JWT_TOKEN` is deliberately absent: a rotated
 * credential must keep taking effect.
 */
export const MOJO_CONTROL_ENV_KEYS = [
    'AGENT_BASE_URL',
    'MOJO_PPE_ENV',
    'AGENT_LOCAL_DAEMON',
] as const;

/**
 * The one env var name the mojo CLI actually reads its credential from.
 *
 * `jwtEnv` only tells the DAEMON where to look up the value; buildEnv() always
 * hands the resolved token to the child as this name. That asymmetry is why the
 * remote-execution proof exempts this fixed name and never `jwtEnv` — see
 * mojoUnprovableEnvKeys.
 */
export const MOJO_CANONICAL_JWT_ENV_KEY = 'X_JWT_TOKEN';

/** The frozen control-plane identity, persisted on the session. */
export type MojoSessionIdentity = Pick<MojoConfig, typeof MOJO_IDENTITY_KEYS[number]>;

/**
 * Pick just the control-plane identity out of a (already normalized) config.
 * Absent keys are omitted rather than stored as undefined, so the frozen record
 * stays a faithful snapshot of what was actually configured.
 */
export function pickMojoSessionIdentity(cfg: MojoConfig | undefined): MojoSessionIdentity {
    const out: Record<string, unknown> = {};
    if (!cfg) return out;
    for (const key of MOJO_IDENTITY_KEYS) {
        const value = (cfg as Record<string, unknown>)[key];
        if (value !== undefined) out[key] = value;
    }
    return out;
}

/**
 * Which control-plane keys differ between the frozen snapshot and live config,
 * for the log line explaining why a session kept its original control plane.
 * Empty array = identical.
 *
 * Returns KEY NAMES ONLY, never values. `baseUrl` is a URL that may legitimately
 * carry userinfo (`https://user:pass@host`) or a signed query
 * (`?sig=<token>`) — the URL validator allows both, because they are valid
 * endpoints — so logging old/new values verbatim would write credentials into the
 * daemon log. The key name is all an operator needs to know what changed; the
 * value is already in their own config.
 */
export function diffMojoSessionIdentity(
    frozen: MojoSessionIdentity,
    live: MojoSessionIdentity,
): string[] {
    const changes: string[] = [];
    for (const key of MOJO_IDENTITY_KEYS) {
        const a = (frozen as Record<string, unknown>)[key];
        const b = (live as Record<string, unknown>)[key];
        if (a === b) continue;
        // Booleans are not secrets and the transition is the whole point
        // (cloud→host execution is the dangerous one), so those are shown.
        changes.push(
            typeof a === 'boolean' || typeof b === 'boolean'
                ? `${key}: ${String(a)} → ${String(b)}`
                : key,
        );
    }
    return changes;
}

/**
 * The config MojoBackend actually runs on: user settings PLUS the platform-owned
 * launch identity resolved by the worker (live session) or reconstructed by the
 * daemon from the session's FROZEN values (workerless cancel).
 *
 * Never built by hand from user input — always via buildEffectiveMojoConfig().
 */
export interface EffectiveMojoConfig extends MojoConfig {
    /**
     * Resolved `mojo` executable. From the top-level `cliPathOverride` frozen on
     * the session, not from the mojo block.
     */
    bin?: string;
    /** cwd for the spawned CLI — the session working dir. */
    cwd?: string;
    /** `--model`. From the top-level bot model frozen on the session. */
    model?: string;
    /** Top-level opt-out of `--yolo`. */
    disableCliBypass?: boolean;
    /**
     * Resolved launch prefix from the top-level `wrapperCli` frozen on the
     * session. Carried here because MojoBackend must re-apply it to EVERY
     * per-turn invocation (unlike a PTY CLI there is no single long-lived process
     * to wrap once) and the daemon's workerless cancel path has no worker to
     * resolve it from.
     */
    wrapperCli?: string;
    /** Persisted mojo session id, restored across daemon restarts. */
    resumeCliSessionId?: string;
    /**
     * Generic extra CLI args the worker composed for this session (today:
     * CLI_EXTRA_ARGS). Passed explicitly rather than through spawn() args so
     * they land AFTER the backend's own flags on every turn — with a wrapper the
     * worker used to bake them into the prefix, which put them BEFORE and
     * silently inverted last-value-wins precedence.
     */
    extraCliArgs?: string[];
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
 * live OUTSIDE the `mojo` block, so a backend that only reads MojoConfig
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
    /** BotConfig.wrapperCli — launch prefix, see EffectiveMojoConfig. */
    wrapperCli?: string;
    /** Generic extra CLI args (CLI_EXTRA_ARGS), applied after the backend flags. */
    extraCliArgs?: readonly string[];
}

/**
 * Combine the user's `mojo` block with the platform-owned launch identity into
 * the ONE config both the worker (live session) and the daemon (workerless
 * `/close`) run on.
 *
 * Sharing this matters: the daemon cancels an orphaned session WITHOUT a worker,
 * so it never calls spawn() and cannot pick these up from SpawnOpts. Building
 * the config only in the worker meant a bot running fine on a custom binary /
 * per-bot JWT could not be cancelled once its worker died — leaving the remote
 * session burning cloud sandbox time while still holding injected credentials.
 *
 * There is no precedence question to answer here: the launch identity has EXACTLY
 * one source (`generic`, which callers populate from the session's frozen
 * values). Anything the user put under those keys in the `mojo` block is stripped
 * — both config entry points reject them, so reaching this function with one set
 * means a hand-edited file, and honouring it would let a live edit override a
 * frozen session identity.
 */
export function buildEffectiveMojoConfig(
    mojoBlock: MojoConfig | undefined,
    generic: MojoGenericLaunchInput,
): EffectiveMojoConfig {
    const block: Record<string, unknown> = { ...(mojoBlock ?? {}) };
    for (const key of MOJO_INTERNAL_CONFIG_KEYS) delete block[key];
    const merged: EffectiveMojoConfig = block as MojoConfig;

    const bin = emptyToUndefined(generic.cliPathOverride);
    if (bin !== undefined) merged.bin = bin;

    if (generic.workingDir !== undefined) merged.cwd = generic.workingDir;

    const model = emptyToUndefined(generic.model);
    if (model !== undefined) merged.model = model;

    if (generic.disableCliBypass !== undefined) {
        merged.disableCliBypass = generic.disableCliBypass;
    }

    // Per-bot env is the LOWER layer: an explicit `mojo.env` entry wins. This one
    // IS a genuine two-source merge — `mojo.env` has no top-level equivalent.
    if (generic.env || merged.env) {
        merged.env = { ...(generic.env ?? {}), ...(merged.env ?? {}) };
    }

    if (generic.resumeCliSessionId !== undefined) {
        merged.resumeCliSessionId = generic.resumeCliSessionId;
    }

    const wrapperCli = emptyToUndefined(generic.wrapperCli);
    if (wrapperCli !== undefined) merged.wrapperCli = wrapperCli;

    if (generic.extraCliArgs && generic.extraCliArgs.length > 0) {
        merged.extraCliArgs = [...generic.extraCliArgs];
    }

    return merged;
}

/** Treat a blank/whitespace-only override as unset. */
function emptyToUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * CLI flags that carry platform-owned decisions: the control plane, the execution
 * mode, the approval bypass, the model, and the resume lineage.
 *
 * `CLI_EXTRA_ARGS` is appended AFTER the backend's own flags so an operator can
 * override behaviour knobs (that is the documented contract), but with
 * last-value-wins parsing that also let it override these — making env a second
 * entry point for the very identity that is frozen per session. They are rejected
 * instead.
 *
 * Long forms only: the mojo CLI has no short aliases for any of these, and
 * `-r` is covered separately because it is the resume lineage.
 */
const MOJO_RESERVED_CLI_FLAGS: ReadonlySet<string> = new Set([
    '--workspace-id',
    '--agent-id',
    '--cloud',
    '--no-cloud',
    '--model',
    '--yolo',
    '--no-yolo',
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--background',
    '--output-format',
    '--include-partial',
]);

/**
 * Reject platform-owned flags in operator-supplied extra args.
 *
 * Handles `--flag value`, `--flag=value` and the bare boolean form, since all
 * three reach the CLI identically. Returns the offending flags, empty when clean.
 */
export function findReservedMojoCliFlags(args: readonly string[]): string[] {
    const offending: string[] = [];
    for (const arg of args) {
        if (!arg.startsWith('-')) continue;
        // `--flag=value` and `--flag value` are the same flag to the CLI.
        const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
        if (MOJO_RESERVED_CLI_FLAGS.has(flag) && !offending.includes(flag)) {
            offending.push(flag);
        }
    }
    return offending;
}

/**
 * Can this mojo session prove it executes nothing locally?
 *
 * A launch prefix (wrapperCli) breaks the proof: it runs BEFORE the binary and
 * can rewrite the very environment the decision depends on — `env
 * AGENT_LOCAL_DAEMON=1 mojo` re-enables host execution after buildEnv() set it to
 * 0, and buildEnv cannot defend against it because the prefix is applied later.
 * Inspecting the wrapper string is not enough either: a wrapper may be a script
 * that sets the variable internally.
 *
 * So a wrapper makes the session unprovable, and the local sandbox stays engaged.
 * The launcher's ENV is treated exactly the same way, and for the same reason —
 * see mojoUnprovableEnvKeys.
 */
export function mojoUnprovableEnvKeys(
    // `jwtEnv` is accepted (callers spread a whole config in) but deliberately
    // IGNORED — see the exemption note below. Keep it in the signature so those
    // spreads keep type-checking; do NOT read it.
    cfg?: { jwtEnv?: string; env?: Record<string, string> },
): string[] {
    const keys = Object.keys(cfg?.env ?? {});
    if (keys.length === 0) return [];
    // ALLOWLIST, deliberately: the set of variables that can redirect execution
    // (PATH, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, …) cannot be
    // enumerated completely — the same reason `env` is not live-patchable, see
    // MOJO_LIVE_PATCH_KEYS below. So anything NOT known-harmless voids the proof.
    //
    // The exemption is the FIXED canonical name and nothing else. It must never be
    // derived from `jwtEnv`, because that made the allowlist operator-extensible:
    // `jwtEnv: 'PATH'` + `env: { PATH: <dir with a fake mojo> }` passed validation
    // (PATH is not a reserved key) and then reported ZERO unprovable keys, so
    // isMojoFullyRemote() returned true — the local sandbox was skipped and device
    // isolation classified the session safe_remote, while resolveBin() picked the
    // binary off that very PATH. Same trick with NODE_OPTIONS / LD_PRELOAD / DYLD_*.
    //
    // Ignoring `jwtEnv` here is not a compatibility break in the child: buildEnv()
    // resolves whatever `jwtEnv` names and hands the VALUE to the CLI as
    // X_JWT_TOKEN regardless (see MojoBackend.buildEnv). `jwtEnv` is a "where to
    // read it from" pointer, never a name the child reads — so it has no business
    // widening a proof about which binary executes.
    return keys.filter(k => k !== MOJO_CANONICAL_JWT_ENV_KEY).sort();
}

export function isMojoFullyRemote(
    cfg?: {
        cloud?: boolean;
        localDaemon?: boolean;
        wrapperCli?: string;
        jwtEnv?: string;
        env?: Record<string, string>;
    },
): boolean {
    if (cfg?.cloud !== true) return false;
    if (cfg.localDaemon === true) return false;
    if (cfg.wrapperCli?.trim()) return false;
    // The launcher ENV is part of the proof, not just the wrapper. resolveBin()
    // picks the binary off the effective child PATH, so `env: { PATH: <dir with a
    // fake mojo> }` runs different code while cloud/localDaemon/wrapperCli all
    // still look clean — and loader hooks (LD_PRELOAD / NODE_OPTIONS / DYLD_*) do
    // the same to the real binary.
    //
    // This is not hypothetical drift: `env` is NOT part of the frozen identity, so
    // sessionMojoConfig() re-merges it from LIVE bot config on every cold refork.
    // A session created as cloud-only could therefore be switched to a local fake
    // after a daemon restart while this function kept returning true — bypassing
    // the local sandbox AND getting classified safe_remote by device isolation.
    if (mojoUnprovableEnvKeys(cfg).length > 0) return false;
    return true;
}

/**
 * The ONLY setting that may change on a live session: the JWT.
 *
 * Deliberately this narrow. The previous version allowed an arbitrary `env` patch,
 * which review showed is equivalent to replacing the launcher: with no
 * `cliPathOverride` the backend spawns the bare name `mojo`, so a live
 * `env: { PATH: <dir with a fake mojo> }` executes a different binary on the next
 * turn — and `NODE_OPTIONS` / `LD_PRELOAD` / `DYLD_*` are comparable. Enumerating
 * dangerous variables cannot be made complete, so `env` is not patchable at all.
 *
 * Note this is not about a compromised daemon (which already has more authority
 * than this); the problem was that a completely legitimate, validated patch could
 * change what gets executed.
 *
 * Everything else in `mojo` (env / stream / systemPrompt / idleTimeoutSec) now
 * requires a new session, matching how the control plane already behaves.
 */
export const MOJO_LIVE_PATCH_KEYS = ['jwt'] as const;

/**
 * A COMPLETE snapshot of the live-updatable state, not a sparse diff.
 *
 * `null` is a tombstone meaning "cleared"; `undefined` means the daemon has
 * nothing to say. The distinction matters because a sparse patch could neither
 * clear a credential nor roll one back: with `undefined` skipped on both sides,
 * deleting `mojo.jwt` left the backend holding the old token indefinitely.
 */
export interface MojoLivePatch {
    /**
     * Resolved JWT: the literal `mojo.jwt`, or the value read from `jwtEnv` —
     * resolved DAEMON-side so the backend never receives an env map. `null`
     * clears it (fall back to whatever the host login provides).
     */
    jwt?: string | null;
}

/**
 * Build the complete live snapshot for a session.
 *
 * Resolves `jwtEnv` here rather than shipping the env map, so credential rotation
 * works without giving a patch the power to change PATH / loader variables.
 * Always returns an explicit value (`null` when there is no credential), because
 * an omitted field cannot express "cleared".
 */
export function pickMojoLivePatch(
    cfg: MojoConfig | undefined,
    sources: {
        /** Per-bot `env` (top level). Lower precedence than `mojo.env`. */
        genericEnv?: Record<string, string>;
        /** Ambient env, lowest precedence. Defaults to the daemon's own. */
        ambientEnv?: NodeJS.ProcessEnv;
    } = {},
): MojoLivePatch {
    const literal = cfg?.jwt?.trim();
    if (literal) return { jwt: literal };
    // Resolve the configured key across the same layers buildEnv() would, reading
    // only the VALUE — the map itself is never shipped, which is what stops a
    // patch from rewriting PATH / loader variables.
    const key = cfg?.jwtEnv?.trim() || MOJO_CANONICAL_JWT_ENV_KEY;
    const fromMojoEnv = cfg?.env?.[key]?.trim();
    if (fromMojoEnv) return { jwt: fromMojoEnv };
    const fromGeneric = sources.genericEnv?.[key]?.trim();
    if (fromGeneric) return { jwt: fromGeneric };
    const fromAmbient = (sources.ambientEnv ?? process.env)[key]?.trim();
    // Always explicit: `null` is the tombstone that lets a deleted credential
    // actually be cleared on the backend.
    return { jwt: fromAmbient ? fromAmbient : null };
}

/**
 * Validate a live patch arriving over IPC.
 *
 * Separate from normalizeMojoConfig on purpose: that one validates the USER's
 * config block, where `jwt` must be a non-empty string. A live patch is a
 * different shape — `null` is a meaningful tombstone — so reusing the config
 * validator rejected every clear request and the backend never saw it.
 */
export function normalizeMojoLivePatch(
    raw: unknown,
): { ok: true; value: MojoLivePatch } | { ok: false; errors: string[] } {
    if (raw === undefined || raw === null) return { ok: true, value: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: ['mojo live patch must be a JSON object'] };
    }
    const errors: string[] = [];
    const value: MojoLivePatch = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (key !== 'jwt') {
            // Deliberately strict: an `env` patch would be equivalent to replacing
            // the launcher (see MOJO_LIVE_PATCH_KEYS), so anything beyond `jwt` is
            // a bug or a stale payload, not something to accept quietly.
            errors.push(`mojo live patch does not accept "${key}"`);
            continue;
        }
        if (val === undefined) continue;
        if (val === null) {
            value.jwt = null;
            continue;
        }
        if (typeof val !== 'string' || !val.trim()) {
            errors.push('mojo live patch jwt must be a non-empty string or null');
            continue;
        }
        value.jwt = val;
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Outcome of validating a raw `mojo` config block. */
export type MojoConfigNormalizeResult =
    | { ok: true; value: MojoConfig }
    | { ok: false; errors: string[] };

/** Field-name → validator, so unknown keys are rejected rather than passed through. */
const MOJO_FIELD_VALIDATORS: Readonly<Record<keyof MojoConfig, (v: unknown) => string | undefined>> = {
    workspaceId: nonEmptyString,
    agentId: nonEmptyString,
    cloud: strictBoolean,
    idleTimeoutSec: positiveInteger,
    stream: strictBoolean,
    systemPrompt: plainString,
    jwt: nonEmptyString,
    jwtEnv: envVarName,
    baseUrl: httpUrl,
    localDaemon: strictBoolean,
    ppeEnv: nonEmptyString,
    env: stringMap,
};

function strictBoolean(v: unknown): string | undefined {
    // The reason this is strict rather than coerced: `localDaemon: "false"` used
    // to satisfy `!== true` in the sandbox check (bypassing the local sandbox)
    // while being truthy in buildEnv (setting AGENT_LOCAL_DAEMON=1). That
    // combination skips isolation AND enables host execution.
    return typeof v === 'boolean' ? undefined : 'must be a boolean (true/false, not a string)';
}

function positiveInteger(v: unknown): string | undefined {
    return typeof v === 'number' && Number.isInteger(v) && v > 0
        ? undefined
        : 'must be a positive integer';
}

function plainString(v: unknown): string | undefined {
    return typeof v === 'string' ? undefined : 'must be a string';
}

function nonEmptyString(v: unknown): string | undefined {
    if (typeof v !== 'string') return 'must be a string';
    return v.trim() ? undefined : 'must not be empty';
}

function envVarName(v: unknown): string | undefined {
    if (typeof v !== 'string') return 'must be a string';
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)
        ? undefined
        : 'must be a valid environment variable name';
}

function httpUrl(v: unknown): string | undefined {
    if (typeof v !== 'string' || !v.trim()) return 'must be a non-empty string';
    let parsed: URL;
    try {
        parsed = new URL(v);
    } catch {
        return 'must be a valid URL';
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? undefined
        : 'must be an http(s) URL';
}

/**
 * Same reserved-key rule the top-level `env` uses. Imported rather than
 * duplicated: per-bot-env.ts is itself a dependency-free leaf, so this keeps
 * mojo-types cheap for the many tests that pull it in.
 */
import { isReservedPerBotEnvKey } from '../../core/per-bot-env.js';

/** Same rule the top-level `env` uses — see per-bot-env.ts. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stringMap(v: unknown): string | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be a JSON object';
    const control = new Set<string>(MOJO_CONTROL_ENV_KEYS);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val !== 'string') return `value for "${k}" must be a string`;
        if (!ENV_KEY_RE.test(k)) return `"${k}" is not a valid environment variable name`;
        // `mojo.env` is the HIGHEST-precedence layer of the child env, so it must
        // honour the SAME reserved list as the top-level `env`. Otherwise the block
        // botmux already enforces there (session routing, CLI data roots, bot
        // credentials) is bypassed just by moving the key in here — and it then
        // WINS the merge. Delegated to isReservedPerBotEnvKey rather than
        // re-listed, because a second copy of that set would drift.
        if (isReservedPerBotEnvKey(k)) {
            return `must not set ${k} — botmux owns this variable (session identity, `
                + 'CLI data root, or bot credential); per-bot `env` rejects it too';
        }
        // Reject rather than silently strip: buildEnv() removes these anyway, and
        // an operator who sets AGENT_BASE_URL here would otherwise believe their
        // endpoint took effect while the session kept its frozen one.
        if (control.has(k)) {
            const owner = k === 'AGENT_BASE_URL' ? 'baseUrl'
                : k === 'MOJO_PPE_ENV' ? 'ppeEnv'
                    : 'localDaemon';
            return `must not set ${k} — it is control-plane state frozen per session; `
                + `use the \`${owner}\` setting instead`;
        }
    }
    return undefined;
}

/**
 * Validate a raw `mojo` block from ANY entry point (bots.json, `/config set
 * mojo`, dashboard, or a defensive check before it reaches the worker).
 *
 * Fails closed on: unknown keys (typos like `cluod` would silently disable the
 * cloud sandbox), internal launch-identity keys (they have top-level owners and
 * are frozen on the session), and wrong types.
 *
 * Type strictness is a SECURITY requirement here, not tidiness — see
 * strictBoolean for the concrete fail-open it prevents.
 */
export function normalizeMojoConfig(raw: unknown): MojoConfigNormalizeResult {
    if (raw === undefined || raw === null) return { ok: true, value: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: ['mojo must be a JSON object'] };
    }

    const errors: string[] = [];
    const value: Record<string, unknown> = {};
    const internal = new Set<string>(MOJO_INTERNAL_CONFIG_KEYS);

    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (internal.has(key)) {
            errors.push(
                `mojo.${key} is not configurable inside the mojo block — `
                + `use the top-level \`${MOJO_INTERNAL_KEY_OWNER[key] ?? key}\` instead`,
            );
            continue;
        }
        const validate = MOJO_FIELD_VALIDATORS[key as keyof MojoConfig];
        if (!validate) {
            errors.push(`mojo.${key} is not a recognized setting`);
            continue;
        }
        // An explicit `undefined` (from JSON round-trips) means "unset", not invalid.
        if (val === undefined) continue;
        const problem = validate(val);
        if (problem) errors.push(`mojo.${key} ${problem}`);
        else value[key] = val;
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as MojoConfig };
}
