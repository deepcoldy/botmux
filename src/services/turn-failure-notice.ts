/**
 * Which turn failures deserve a user-visible, actionable notice — and which of
 * those may offer a retry button.
 *
 * Two independent questions, deliberately kept apart:
 *
 * 1. **Should we notify at all?** A `failed` terminal always warrants a notice.
 *    An `ambiguous` one does NOT: that bucket mixes genuine breakage the user
 *    cannot see (the CLI process died, an input write threw) with endings the
 *    user already knows about — an interruption they performed themselves
 *    (Esc, or the card's ⏹ stop button, which sends `^C`), or a turn their own
 *    newer message superseded. Notifying on those would manufacture exactly the
 *    alert noise this feature exists to reduce, so they stay silent. An abort
 *    that cannot be attributed to the user still surfaces.
 *
 * 2. **May we offer retry, and with what warning?** `retryable === true` is
 *    single-sourced today (the Claude transcript classifier is its only
 *    producer; every other CLI leaves it `undefined`), so a cross-CLI retry
 *    affordance cannot lean on it. What generalises instead is whether the
 *    failure is *pre-execution*: an input that never reached the CLI has no
 *    side effects to duplicate, so re-sending it is unconditionally safe.
 *
 *    A turn that died mid-execution (`cli_exit`) is the harder case. It is NOT
 *    safe-by-construction — the CLI may already have edited files, pushed a
 *    commit or sent a message before dying, and `/retry` re-injects the ORIGINAL
 *    input verbatim (unlike the recovery path, which sends a checkpoint-aware
 *    prompt). Hiding retry there would strand the user; offering it silently
 *    would risk duplicate side effects. So it is offered as `caveated`, and the
 *    card must say so — the user is the only one who can judge whether the
 *    partial work is safe to redo.
 *
 * Keeping this as pure functions (no session, no IPC) makes the policy testable
 * without a live worker and gives the card builder and the click handler one
 * shared source of truth — a button that renders must be one the handler
 * honours.
 */

/** Terminal statuses that can carry a failure. Mirrors `turn_terminal`. */
export type FailureNoticeStatus = 'failed' | 'ambiguous' | 'completed' | 'cancelled';

/**
 * Error codes proving the USER deliberately stopped this turn. These arrive as
 * `ambiguous` because a stop can land after side effects began, so the audit
 * semantics stay uncertain — but the user already knows the turn ended, so a
 * notice would be pure noise.
 *
 * Membership requires direct evidence that the code is user-initiated: each of
 * these is documented as an Esc/interrupt in its transcript adapter (see
 * `pi-transcript.ts` "user interrupt (Esc)").
 *
 * Note the deliberate ABSENCE of `structured_turn_aborted`: that is the `??`
 * fallback in `codex-bridge-queue.ts` for an abort carrying no code of its own,
 * so it means "unattributable", not "the user did it". Unattributable aborts
 * must surface — that is the same rule this module applies to a missing code.
 */
const USER_ABORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'pi_turn_aborted',
  'omp_turn_aborted',
  'rpc_turn_aborted',
]);

/**
 * Adapters that encode the abort REASON into the code itself
 * (`codex_turn_aborted:user_interrupt`, `traex_turn_aborted:interrupted_by_user_unsafe`),
 * so the code is not a fixed string and cannot be matched by set membership.
 *
 * These are compared against the segment BEFORE the first `:` — not with
 * `startsWith`, which would also swallow a hypothetical sibling like
 * `codex_turn_aborted_by_policy`. The reason suffix is deliberately ignored:
 * every `turn_aborted` record from these two adapters is a cancellation the
 * user drove (via Esc, or the card's own ⏹ stop button, which sends `^C`),
 * and the suffix only names which flavour.
 */
const USER_ABORT_ERROR_CODE_PREFIXES: readonly string[] = [
  'codex_turn_aborted',
  'traex_turn_aborted',
];

/**
 * Codes proving a NEWER input replaced this turn — not a user abort, but not
 * something to alarm about either: the user just sent the follow-up that
 * superseded it, and the new turn owns delivery from here.
 *
 * Kept apart from `USER_ABORT_ERROR_CODES` because the cause differs: nobody
 * pressed stop. `grok-transcript.ts` states the intent directly — a `send_now`
 * cancel maps to `ambiguous` "instead of a user-visible failed card".
 *
 * Only the `ambiguous` arm is affected: Grok reuses `grok_turn_cancelled` for
 * OTHER cancellations with status `failed`, and a `failed` terminal always
 * notifies (see below), so those keep their card.
 */
const SUPERSEDED_BY_NEWER_INPUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'grok_turn_cancelled',
]);

/** Whether this code marks a cancellation the user themselves caused. */
function isUserAbortErrorCode(errorCode: string): boolean {
  if (USER_ABORT_ERROR_CODES.has(errorCode)) return true;
  const head = errorCode.split(':')[0];
  return USER_ABORT_ERROR_CODE_PREFIXES.includes(head);
}

/**
 * Error codes proving the turn's input never reached the CLI. Nothing executed,
 * so re-sending duplicates no external side effect.
 *
 * ⚠️ The three `recovery_*` codes are deliberately NOT here. They describe the
 * fate of an automatic CONTINUATION, but the retry button re-injects whatever
 * `lastFailedTurn` holds — and that record is only written from `turn_terminal`,
 * which the recovery-handoff failures never emit (`failOrdinaryImDelivery`
 * returns straight after `requireOrdinaryTurnRecoveryAttention`; the enqueue
 * failure only commits state and warns). So the record still points at the
 * ORIGINAL turn, whose progress these codes say nothing about. Worse, the
 * ladder only dispatches a continuation for `failed && retryable === true`, so
 * the original turn is by construction a transient fault mid-work — exactly the
 * case that must stay `caveated`.
 */
const PRE_EXECUTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'write_input_threw',
  'adopt_write_input_threw',
  'raw_input_write_failed',
  'zmx_recovery_blocked_before_write',
  'terminal_bridge_unavailable',
]);

export interface TurnFailureNoticeInput {
  status: FailureNoticeStatus;
  errorCode?: string;
}

/**
 * Whether this terminal deserves a user-visible failure notice.
 *
 * `failed` always qualifies. `ambiguous` qualifies unless the turn ended for a
 * reason the user already knows about: they stopped it themselves, or their own
 * newer message superseded it. `cli_exit`, `write_input_threw` and friends are
 * invisible today (the card silently returns to idle, indistinguishable from
 * success), which is the gap this predicate closes.
 */
export function shouldNotifyTurnFailure(turn: TurnFailureNoticeInput): boolean {
  if (turn.status === 'failed') return true;
  if (turn.status !== 'ambiguous') return false;
  // An abort with no code cannot be attributed to the user; surface the
  // unattributable case rather than swallowing it.
  if (turn.errorCode === undefined) return true;
  if (isUserAbortErrorCode(turn.errorCode)) return false;
  return !SUPERSEDED_BY_NEWER_INPUT_ERROR_CODES.has(turn.errorCode);
}

/**
 * How a retry may be offered:
 * - `safe`     — the input provably never executed. No duplicate-side-effect
 *                risk to warn about.
 * - `caveated` — the turn may have executed before dying. Offer the button, but
 *                the card MUST warn that redoing it can repeat side effects.
 * - `none`     — do not offer retry (not a notifiable failure, or the CLI
 *                explicitly refused: re-sending cannot help).
 *
 * ⚠️ `retryable === true` DOES NOT MEAN `safe`. It used to, and that was a lie
 * the card told users: the CLI's `retryable` answers "would retrying possibly
 * help?", not "did anything run?". `provider_server_error` is the proof — it is
 * raised for HTTP 5xx AND for `closed mid-response` / `connection reset`
 * signatures (see claude-transcript.ts), i.e. the connection dying AFTER the
 * model has already been running and calling tools. MEASURED in the wild: a turn
 * that had already read state and sent several Lark messages died with
 * `provider_server_error`, and the card announced「这一轮的输入没有送达 CLI，
 * 没有任何已执行的操作」— every clause false, and it steered the user toward a
 * verbatim replay that would redo those side effects.
 *
 * Only WHERE the failure happened can prove nothing ran, which is exactly what
 * `PRE_EXECUTION_ERROR_CODES` enumerates. So that set is now the ONLY route to
 * `safe`; `retryable` decides only whether a retry is worth offering at all.
 */
export type TurnRetryOffer = 'safe' | 'caveated' | 'none';

export function turnRetryOffer(
  turn: TurnFailureNoticeInput & { retryable?: boolean },
): TurnRetryOffer {
  if (!shouldNotifyTurnFailure(turn)) return 'none';
  // An explicit refusal (auth failure, invalid request) outranks every
  // heuristic below: re-sending the same input provably cannot succeed.
  // ⚠️ Checked BEFORE the pre-execution set on purpose: those codes are emitted
  // without a `retryable` flag (worker.ts passes none), so this cannot swallow
  // them — but a future call site that pairs a refusal with such a code means
  // "do not re-send", and honouring the refusal is the conservative reading.
  if (turn.retryable === false) return 'none';
  // Location, not retryability, is what proves nothing executed. See the note on
  // TurnRetryOffer: `retryable === true` used to short-circuit to `safe` here and
  // made the card claim "nothing was executed" for mid-response failures.
  if (turn.errorCode !== undefined && PRE_EXECUTION_ERROR_CODES.has(turn.errorCode)) return 'safe';
  return 'caveated';
}

/** Convenience for call sites that only need "is there a button at all". */
export function mayOfferTurnRetry(
  turn: TurnFailureNoticeInput & { retryable?: boolean },
): boolean {
  return turnRetryOffer(turn) !== 'none';
}

/**
 * What to actually submit when the user presses the failure card's button.
 *
 * `safe` → re-send the original input verbatim. Nothing executed, so restating
 * the request is the cleanest, most predictable thing we can do.
 *
 * `caveated` → the turn may have half-executed, so a verbatim re-send risks
 * repeating side effects. Submit a continue instruction instead.
 *
 * Kept deliberately SHORT. The click lands on a session that resumes its own
 * transcript (`forkWorker(..., ds.hasHistory)` → `--resume <id>`), so the model
 * already has the original task and everything it did before dying. Restating
 * the task, or explaining at length what "continue" means, would spend tokens
 * re-teaching the model what it can already read. Verified in practice: a bare
 * "继续" is enough to get a CLI to pick up where it stopped.
 *
 * So this carries exactly the three things the transcript does NOT tell it:
 *  1. that the previous turn was cut off mid-flight (the transcript just ends —
 *     it cannot distinguish "interrupted" from "finished"),
 *  2. that work may already have landed, so completed side effects must not be
 *     repeated. This is the one instruction worth the tokens: it is the whole
 *     reason this is a continue rather than a replay, and
 *  3. that stopping to ask a human is the correct move when the checkpoint
 *     cannot be established safely. Without this the model's only options are
 *     to guess or to redo, and both can duplicate an external side effect —
 *     which is the exact risk this prompt exists to bound.
 *
 * Also NOT reusing `ORDINARY_TURN_RECOVERY_PROMPT`: its first line asserts a
 * transient provider fault, which is false for the codes that land here
 * (`cli_exit` is a dead process). A wrong cause sends the model looking in the
 * wrong place.
 */
export function buildTurnContinuePrompt(): string {
  return '[BOTMUX_CONTINUE] 上一轮被异常中断，可能已完成了一部分。'
    + '请确认现场后从中断处继续，不要重复已完成的操作；'
    + '无法安全判断则停下并请求人工决策。';
}

/** Test/introspection helpers. Copies, so callers cannot mutate the policy.
 *
 *  A test that iterates one of these is asserting "the members are handled
 *  consistently" — NOT that the set is complete. Completeness has to be pinned
 *  with literal codes taken from the producing adapter's own tests; iterating
 *  the set under test cannot fail when a code is missing from it. */
export function userAbortErrorCodes(): string[] {
  return [...USER_ABORT_ERROR_CODES];
}

export function userAbortErrorCodePrefixes(): string[] {
  return [...USER_ABORT_ERROR_CODE_PREFIXES];
}

export function supersededByNewerInputErrorCodes(): string[] {
  return [...SUPERSEDED_BY_NEWER_INPUT_ERROR_CODES];
}

export function preExecutionErrorCodes(): string[] {
  return [...PRE_EXECUTION_ERROR_CODES];
}
