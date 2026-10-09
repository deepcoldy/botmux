/**
 * Single source of truth for which CliIds use the structured transcript
 * bridge (CodexBridgeQueue path in the worker).
 *
 * Split intentionally:
 *   - ALWAYS: harvested whenever the CLI is botmux-spawned (or adopted)
 *   - CURSOR: adopt-only by default — botmux-spawned cursor replies via
 *     `botmux send`, so the transcript bridge stays off outside adopt mode.
 *     Under promptInjection:'none' there is no `botmux send` channel, so the
 *     zero-prompt gate activates the SAME bridge for botmux-spawned cursor.
 *   - ZERO_PROMPT: CLIs whose bridge exists ONLY for zero-prompt spawns —
 *     antigravity has no /adopt bridge at all; its brain transcript.jsonl is
 *     drained just for final-reply harvest when the model cannot be taught a
 *     send command.
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

/** Botmux-spawned CLIs that gain the structured bridge SOLELY under zero-prompt
 *  injection (`promptInjection: 'none'`): in ordinary mode their models deliver
 *  through `botmux send` and harvesting transcript finals would double-post.
 *  Both local-PTY-only CLIs (no remote backend) with an append-only transcript
 *  that can be distilled to the user → assistant_final shape:
 *
 *   - cursor: the same agent-transcripts JSONL the adopt bridge drains
 *     (`drainCursorTranscript`); a botmux spawn owns its store.db fd just like
 *     an adopted pane, so pid → chatId discovery works identically.
 *   - antigravity: `brain/<id>/.system_generated/logs/transcript.jsonl`
 *     (`drainAntigravityTranscript`). No /adopt path exists for it today.
 *
 *  Neither driver has a complete interrupted/error terminal contract, so they
 *  stay OUT of STRUCTURED_BRIDGE_LIFECYCLE_BLOCKING_CLI_IDS — the screen-ready
 *  heuristic keeps owning turn boundaries for them. */
export const STRUCTURED_BRIDGE_ZERO_PROMPT_CLI_IDS = [
  'cursor',
  'antigravity',
] as const satisfies readonly CliId[];

const ZERO_PROMPT_SET: ReadonlySet<string> = new Set(STRUCTURED_BRIDGE_ZERO_PROMPT_CLI_IDS);

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

/** Worker `codexBridgeFallbackActive` — cursor when adopt OR zero-prompt;
 *  antigravity only under zero-prompt (it has no /adopt bridge — never active
 *  in adopt mode even if both flags are passed). */
export function isStructuredBridgeFallbackActive(
  cliId: string | undefined,
  adoptMode?: boolean,
  /** The observing session runs with promptInjection:'none'. Cursor's bridge
   *  is adopt-only without it; antigravity's bridge exists only with it. */
  zeroPrompt?: boolean,
): boolean {
  if (!cliId) return false;
  if (ALWAYS_SET.has(cliId)) return true;
  if (cliId === 'cursor') return adoptMode === true || zeroPrompt === true;
  if (cliId === 'antigravity') return adoptMode !== true && zeroPrompt === true;
  return false;
}

/** Automatic final replies for botmux-spawned CLI sessions, WITHOUT an adopt
 *  context: claude uses its own transcript bridge; the structured drivers that
 *  are always on plus the zero-prompt-only CLIs above. The latter MUST still be
 *  gated on promptInjection:'none' by the caller (see
 *  core/prompt-injection.supportsZeroPromptInjection) — this predicate only
 *  states that a harvestable transcript exists. */
export function supportsZeroPromptStructuredBridge(cliId: string | undefined): boolean {
  return !!cliId && (ALWAYS_SET.has(cliId) || ZERO_PROMPT_SET.has(cliId));
}

/** Automatic final replies for ordinary bot-spawned CLI sessions. Claude uses
 * its own transcript bridge; the remaining drivers share the structured one.
 * Deliberately EXCLUDES the zero-prompt-only CLIs: in default mode they reply
 *  via `botmux send`, so callers must not expect transcript delivery from them. */
export function supportsTranscriptReplyDelivery(cliId: string | undefined): boolean {
  return cliId === 'claude-code' || (!!cliId && ALWAYS_SET.has(cliId));
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
