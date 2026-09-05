/**
 * Single source of truth for which CliIds use the structured transcript
 * bridge (CodexBridgeQueue path in the worker).
 *
 * ALWAYS = harvested whenever the CLI is botmux-spawned (or adopted).
 * Cursor was historically adopt-only (spawned cursor replied via `botmux
 * send` with no fallback, so a send-less turn ghosted the thread); it now
 * rides the same always-on fallback as codex — the send-marker gate in
 * bridge-fallback-gate.ts suppresses the transcript emit when the model
 * did send, exactly like the other structured CLIs.
 *
 * File-path resolution for JSONL-style bridges lives in
 * `resolveFileBridgePath` (same module family, worker-facing). Hermes/MTR
 * use SQLite drivers and are NOT in the file-path helper — they stay on
 * their dedicated attach paths. Full driver-table platformization is a
 * follow-up; this file only collapses the OR-list tax.
 */
import type { CliId } from '../adapters/cli/types.js';

/** Always-on structured-bridge CLIs (including SQLite-backed hermes/mtr). */
export const STRUCTURED_BRIDGE_ALWAYS_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'hermes',
  'mtr',
  'pi',
  'oh-my-pi',
  'ebsd',
  'grok',
  'cursor',
] as const satisfies readonly CliId[];

/** Adopt must forward pid/cwd/cliSessionId for these (CLIs whose worker
 *  adopt branch consumes them, plus cursor's store.db fd probe).
 *
 *  hermes is deliberately NOT here despite being ALWAYS: it has no adopt
 *  transcript branch (its bridge attaches via the timer's dedicated hermes
 *  path), and forwarding adoptCliPid would silently switch its tmux adopt
 *  from pane-only to pid liveness (TmuxPipeBackend.watchCliPid polls the
 *  pid and detaches on exit) — a behavior change that belongs to the
 *  driver-table follow-up, not this convergence PR. Matches the historical
 *  worker-pool allowlist. */
export const STRUCTURED_BRIDGE_ADOPT_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'mtr',
  'pi',
  'grok',
  'cursor',
] as const satisfies readonly CliId[];

const ALWAYS_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS);
const ADOPT_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_CLI_IDS);

/** Drivers whose transcript contract exposes every terminal edge needed for a
 *  strong started-turn status gate. Codex has final_answer plus explicit
 *  turn_aborted parsing. Pi's drainPiTranscript closes a turn on
 *  stop/length-without-toolcall and on the hard error/aborted edges (verified
 *  against pi 0.84.2: `terminate:true` is still not persisted and the newer
 *  pending/deferred StopReasons never reach the session JSONL), so a started
 *  Pi turn may suppress the screen-ready heuristic. OMP additionally retains
 *  terminal records provisionally until a decisive record or guarded quiet
 *  tick proves no plugin continuation follows. Accepted gap: a custom
 *  tool returning `terminate:true` leaves a started turn with no on-disk
 *  terminal — the card stays working until the NEXT user turn's transcript
 *  user event HOL-drops the unclosed head (botmux ships no such tool; same
 *  bounded-recovery shape Codex accepts for lost rollout finals). ebsd does
 *  not use that provisional OMP stop: it commits a versioned custom terminal
 *  only after its hidden diagnosis finalizer has completed. Grok's
 *  updates.jsonl exposes an authoritative user_message_chunk → turn_completed
 *  lifecycle; the parser maps end_turn, cancelled, error, and unknown stop
 *  reasons to explicit terminal outcomes, while worker exit owns the remaining
 *  ambiguous boundary. Keep a transient TUI prompt from publishing idle until
 *  that structured terminal settles the turn. Other structured drivers still
 *  use the queue for attribution, but their interrupted/error shapes are not
 *  yet complete enough to let a started turn suppress screen-ready forever. */
export const STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS = [
  'codex',
  'pi',
  'oh-my-pi',
  'ebsd',
  'grok',
] as const satisfies readonly CliId[];

const LIFECYCLE_BLOCKING_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS);

export function isStructuredBridgeLifecycleBlockingCli(cliId: string | undefined): boolean {
  return !!cliId && LIFECYCLE_BLOCKING_SET.has(cliId);
}

/** Worker `codexBridgeFallbackActive`. */
export function isStructuredBridgeFallbackActive(cliId: string | undefined): boolean {
  return !!cliId && ALWAYS_SET.has(cliId);
}

/** Daemon adopt path — forward transcript bind fields. */
export function isStructuredBridgeAdoptCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_SET.has(cliId);
}

/**
 * Idle-adapter / adopt input-adapter: CLIs whose adapter should be used for
 * idle detection / writeInput during adopt (excludes cursor's special baseline
 * path and hermes which uses its own attach). Matches historical
 * `adoptIdleAdapter` allowlist: codex/traex/coco/mtr/pi/grok.
 */
export const STRUCTURED_BRIDGE_ADOPT_IDLE_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'mtr',
  'pi',
  'grok',
] as const satisfies readonly CliId[];

const ADOPT_IDLE_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_IDLE_CLI_IDS);

export function isStructuredBridgeAdoptIdleCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_IDLE_SET.has(cliId);
}

/** Adopt input adapter: needs writeInput for local pane typing. */
export const STRUCTURED_BRIDGE_ADOPT_INPUT_CLI_IDS = [
  'codex',
  'traex',
  'coco',
  'pi',
  'grok',
  'mtr',
] as const satisfies readonly CliId[];

const ADOPT_INPUT_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ADOPT_INPUT_CLI_IDS);

export function isStructuredBridgeAdoptInputCli(cliId: string | undefined): boolean {
  return !!cliId && ADOPT_INPUT_SET.has(cliId);
}
