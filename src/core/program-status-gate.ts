import type { CliAdapter } from '../adapters/cli/types.js';
import type { ProgramStatusBlock } from '../utils/idle-detector.js';
import type { CodexBridgeQueue } from '../services/codex-bridge-queue.js';
import type { EnvPolicy } from './env-policy.js';
import { compareTraexVersions, parseTraexVersion } from '../adapters/cli/traex-version.js';
import { classifyStuckPage } from '../utils/stuck-detector.js';

export const ANTIGRAVITY_OSC7501_ENV_KEY = 'AGY_CLI_OSC7501';
export const ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY = 'AGY_CLI_OSC7501_MESSAGES';

const ANTIGRAVITY_OSC7501_ENV_KEYS: ReadonlySet<string> = new Set([
  ANTIGRAVITY_OSC7501_ENV_KEY,
  ANTIGRAVITY_OSC7501_MESSAGES_ENV_KEY,
]);

/** Hard ceiling (measured from turn mark / predecessor terminal) for how long
 *  an OSC 7501 busy (`working` / `blocked`) report may refresh an unstarted
 *  Antigravity structured-bridge head's pre-start attribution lease. Matches
 *  Cursor/Hermes's 120s ceiling: covers cold-start >20s delays before `agy`
 *  writes `USER_INPUT` to `transcript.jsonl`, while still expiring cleanly
 *  if the CLI wedges without ever writing a user record. */
export const ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS = 120_000;

/** What the worker knows about this launch when it decides whether to parse
 *  OSC 7501 reports. */
export interface ProgramStatusLaunch {
  /** The daemon's probed `--version` output for the installed CLI (raw:
   *  `0.167.0`, `0.214.1\ninstallation: internal`, `unknown`). */
  cliVersion?: string;
  /** An adopted pane runs whatever process the user started; its version is
   *  not the probed install. */
  adoptMode?: boolean;
  /** A `--remote` viewer of an App Server thread: input and turn boundaries
   *  come from the JSON-RPC engine, not from this TUI. */
  remoteViewer?: boolean;
  /** Effective launch environment (host/inherited env merged with per-bot env),
   *  consulted for explicit CLI opt-outs such as `AGY_CLI_OSC7501=off`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Resolve the effective OSC 7501 env view for a launch, honoring per-bot env
 *  overrides, `envUnset`, and `envPolicy: strict`. */
export function effectiveProgramStatusEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  opts: {
    botEnv?: Readonly<Record<string, string | undefined>>;
    envPolicy?: EnvPolicy;
    envUnset?: readonly string[];
  } = {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const strict = opts.envPolicy?.mode === 'strict';
  const inheritSet = strict ? new Set(opts.envPolicy?.inherit ?? []) : undefined;
  const unsetSet = opts.envUnset?.length ? new Set(opts.envUnset) : undefined;
  for (const key of ANTIGRAVITY_OSC7501_ENV_KEYS) {
    if (opts.botEnv?.[key] !== undefined) {
      out[key] = opts.botEnv[key];
      continue;
    }
    if (unsetSet?.has(key)) continue;
    if (strict && !inheritSet!.has(key)) continue;
    if (baseEnv[key] !== undefined) out[key] = baseEnv[key];
  }
  return out;
}

/** Whether the effective environment explicitly opts this CLI out of OSC 7501.
 *  Verified on `agy 1.5.18`: `AGY_CLI_OSC7501=off` (case-insensitive) silences
 *  both the startup probe and all OSC 7501 status reports. */
export function programStatusDisabledByEnv(
  adapterId: string | undefined,
  env?: Readonly<Record<string, string | undefined>>,
): boolean {
  if (adapterId !== 'antigravity') return false;
  return env?.[ANTIGRAVITY_OSC7501_ENV_KEY]?.trim().toLowerCase() === 'off';
}

/** `true` when `raw` names a release at or above `min`. Unknown, unparsable
 *  and pre-releases of `min` itself count as below. */
export function cliVersionAtLeast(raw: string | undefined, min: string): boolean {
  // Both CLIs print `<name> x.y.z[-pre]`; the shared parser takes the first
  // such token (TraeX appends an `installation:` line).
  const version = raw ? parseTraexVersion(raw) : undefined;
  return version !== undefined && compareTraexVersions(version, min) >= 0;
}

/** Whether this launch mounts the OSC 7501 parser. Adapters without a
 *  verified minimum version keep their unconditional declaration; a gated one
 *  needs a probed version at or above it on a CLI this worker launched. */
export function programStatusEnabledForLaunch(
  adapter: (Pick<CliAdapter, 'supportsProgramStatus' | 'programStatusMinVersion'> & { readonly id?: string }) | null | undefined,
  launch: ProgramStatusLaunch,
): boolean {
  if (adapter?.supportsProgramStatus !== true) return false;
  if (programStatusDisabledByEnv(adapter.id, launch.env)) return false;
  const min = adapter.programStatusMinVersion;
  if (min === undefined) return true;
  if (launch.adoptMode || launch.remoteViewer) return false;
  return cliVersionAtLeast(launch.cliVersion, min);
}

/** Apply `adapter.spawnEnv` onto `childEnv` and return the keys the caller
 *  should protect from a downstream `envUnset` removal.
 *  For Antigravity's OSC 7501 vars, skip injection when OSC 7501 is disabled
 *  for this launch (old/unknown version, adopt, or explicit `off`) and preserve
 *  any explicit value already set in `botEnv` (even empty, which `injectEnv`
 *  would apply after `childEnv`) or any non-empty value already in `childEnv`;
 *  the returned keys are exactly the OSC 7501 defaults injected this call.
 *  All other adapters keep direct `Object.assign` semantics and return no keys,
 *  so their spawnEnv defaults remain subject to the configured `envUnset`. */
export function applyAdapterSpawnEnv(
  childEnv: NodeJS.ProcessEnv,
  adapter: Pick<CliAdapter, 'id' | 'spawnEnv'>,
  opts: {
    programStatusEnabled?: boolean;
    botEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): string[] {
  if (!adapter.spawnEnv) return [];
  if (adapter.id !== 'antigravity') {
    Object.assign(childEnv, adapter.spawnEnv);
    // Return no applied keys: the envUnset filter below exists solely to protect
    // Antigravity's OSC 7501 defaults (injected only when the protocol is on).
    // Other adapters' spawnEnv defaults must stay removable by a configured
    // `envUnset` on pty / strict / herdr, exactly as the pre-OSC-7501 direct
    // Object.assign wiring behaved. Returning these keys would silently exempt
    // them from the user's removal list (a cross-CLI config regression).
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(adapter.spawnEnv)) {
    if (ANTIGRAVITY_OSC7501_ENV_KEYS.has(key)) {
      if (opts.programStatusEnabled === false) continue;
      if (opts.botEnv?.[key] !== undefined || childEnv[key]?.trim()) continue;
    }
    childEnv[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Drop adapter-injected keys from `envUnset` before passing to backends whose
 *  spawn path runs `applySessionEnvUnset(env, unsetEnv)` after `childEnv`
 *  assembly (`ptyChildEnv`, `strictPaneEnvArgs`, `herdr`). This ensures e.g.
 *  `envUnset: ['AGY_CLI_OSC7501']` removes an inherited host `off` without
 *  subsequently deleting the adapter-injected `on` default. */
export function filterAppliedAdapterEnvUnset(
  envUnset: readonly string[] | undefined,
  appliedKeys: readonly string[],
): string[] | undefined {
  if (!envUnset?.length || !appliedKeys.length) return envUnset ? [...envUnset] : undefined;
  const applied = new Set(appliedKeys);
  const filtered = envUnset.filter(key => !applied.has(key));
  return filtered.length ? filtered : undefined;
}

export interface AntigravityQuietFinalProgramStatusInput {
  blocked: boolean;
  heldWorking: boolean;
  programStatusQuietMs: number;
  candidateAgeMs: number;
  staleQuietMs: number;
}

/** Whether an active OSC 7501 hold should defer flushing Antigravity's
 *  provisional trailing final on a quiet bridge tick.
 *  - `blocked` (permission / question dialog) always defers.
 *  - `working` defers until BOTH OSC 7501 has been silent AND this exact
 *    provisional candidate has stayed unchanged for at least `staleQuietMs`
 *    (mirrors `staleProgramStatusVerdict`, so a >60s turn whose `working` was
 *    emitted at t=0 does not flush interim narration 1–2s after it lands). */
export function shouldDeferAntigravityQuietFinalForProgramStatus(
  input: AntigravityQuietFinalProgramStatusInput,
): boolean {
  if (input.blocked) return true;
  if (!input.heldWorking) return false;
  return input.programStatusQuietMs < input.staleQuietMs
    || input.candidateAgeMs < input.staleQuietMs;
}

export interface AntigravityQuietFlushIdleInput {
  /** This ingest explicitly emitted the held candidate's `assistant_final`. */
  flushedCandidateFinal: boolean;
  /** OSC 7501 still holds a (non-blocked) `working` record. */
  heldWorking: boolean;
  /** A background command / subagent the turn is waiting on remains open. */
  hasPendingTasks: boolean;
  /** A started turn with no terminal yet is still live in the bridge queue. */
  hasActiveStartedTurn: boolean;
}

/** Decide whether a quiet-tick trailing-final flush may release a stale OSC
 *  7501 `working` hold via `fireIdle()`. All four facts are gathered by the
 *  worker from the real drainer events and bridge queue; extracting the boolean
 *  keeps the decision testable without the worker's closure.
 *
 *  `flushedCandidateFinal` is the load-bearing guard: between arming the quiet
 *  candidate and this tick a concurrent tool call or follow-up USER_INPUT can
 *  clear `provisionalFinal`, so the ingest may emit no matching `assistant_final`
 *  (or a `turn_aborted` with a different uuid). Releasing the hold then would
 *  end a still-active turn. A newly started successor turn likewise vetoes. */
export function shouldFireIdleAfterAntigravityQuietFlush(
  input: AntigravityQuietFlushIdleInput,
): boolean {
  return input.flushedCandidateFinal
    && input.heldWorking
    && !input.hasPendingTasks
    && !input.hasActiveStartedTurn;
}

export interface ProgramStatusLeaseRefreshInput {
  cliId?: string;
  adoptMode?: boolean;
  runnerFramedInput?: boolean;
  programStatusHeldBusy: boolean;
  queue: Pick<CodexBridgeQueue, 'peek' | 'refreshUnstartedHeadAttributionLease'>;
  nowMs?: number;
  maxSinceMarkMs?: number;
}

/** Refresh unstarted structured-bridge pre-start attribution leases while
 *  Antigravity's OSC 7501 stream actively reports `working` or `blocked`.
 *  Scoped strictly to owned terminal Antigravity sessions so other CLIs keep
 *  their unchanged 20s `STRUCTURED_SUBMIT_START_GRACE_MS` behaviour.
 *
 *  Guards preserved:
 *  - Skips when an earlier turn is already started and unfinished (its own
 *    lifecycle already shields queued successors in `pruneExpiredPreStartHeads`);
 *  - Skips `passedBySuccessor` marks (a later turn already landed in transcript)
 *    and `restoredFromJournal` marks (from a previous worker generation);
 *  - Enforces the hard ceiling `maxSinceMarkMs` (default 120s) inside
 *    `refreshUnstartedHeadAttributionLease`. */
export function refreshStructuredPreStartLeaseFromProgramStatus(
  input: ProgramStatusLeaseRefreshInput,
): number {
  if (input.cliId !== 'antigravity' || input.adoptMode || input.runnerFramedInput) return 0;
  if (!input.programStatusHeldBusy) return 0;
  const turns = input.queue.peek();
  if (turns.length === 0) return 0;
  if (turns.some(turn => turn.started && turn.finalText === undefined)) return 0;
  const nowMs = input.nowMs ?? Date.now();
  const maxSinceMarkMs = input.maxSinceMarkMs ?? ANTIGRAVITY_PROGRAM_STATUS_BUSY_REFRESH_MAX_MS;
  return input.queue.refreshUnstartedHeadAttributionLease(
    nowMs,
    maxSinceMarkMs,
    turn => !turn.passedBySuccessor && !turn.restoredFromJournal,
  );
}

/** Whether the rendered screen can stand behind an `idle` the CLI reported
 *  before botmux's first write. The report only says the CLI is not running a
 *  turn: a resumed TraeX reports it in the same burst that draws its
 *  session-lock page. So the screen must still show a prompt row and no
 *  known blocking page; the footer under the prompt is what may be unknown. */
export function startupIdleReportScreenAdmits(screen: string, readyPattern: RegExp | undefined): boolean {
  return !!screen && !!readyPattern?.test(screen) && classifyStuckPage(screen) === undefined;
}

/** Whether a reported block keeps queued input from being typed ahead (for
 *  adapters that opt in with `programStatusBlockedHoldsInput`). An approval
 *  dialog — and an auth prompt or a block of unnamed kind — would take the
 *  text and its Enter as an answer. A question is the one block the user's
 *  next message is meant to answer; holding it until the turn ends would
 *  wait on itself, so it keeps the pre-OSC behaviour. (TraeX's own question
 *  page is the exception, handled apart: a message would only become a note
 *  there, so its terminal sessions hold input and answer through a question
 *  card instead — see CliAdapter.nativeQuestionPage.) */
export function programStatusBlockHoldsTypeAhead(block: ProgramStatusBlock | null): boolean {
  return block !== null && block.kind !== 'question';
}
