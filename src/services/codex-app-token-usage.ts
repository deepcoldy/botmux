/**
 * Per-turn token-usage accumulator for the codex app-server protocol.
 *
 * codex emits token usage via `thread/tokenUsage/updated` notifications, NOT on
 * `turn/completed` (whose Turn object carries no usage). A single codex turn can
 * produce MANY upstream completions (tool-call loops), so the notification's
 * `tokenUsage.last` is only the LAST completion's usage — never the whole turn.
 * The authoritative per-turn figure is a delta of the cumulative `total`:
 *
 *   - on the first notification for a turn, derive baseline = total - last
 *     (per field), so a resumed session needs no prior session-total knowledge;
 *   - the turn's usage so far = latestTotal - baseline (per field);
 *   - later notifications only advance latestTotal (total-delta is idempotent
 *     against duplicate notifications — never sum `last`, never overwrite).
 *
 * Fail-closed: if `total` regresses or any derived field goes negative, the
 * usage is dropped (returns null) and the caller logs a protocol warning rather
 * than reporting corrupt numbers.
 *
 * Ref: codex protocol TokenUsageInfo::append_last_usage (total += last; last =
 * this completion) and app-server ThreadTokenUsageUpdatedNotification /
 * TokenUsageBreakdown (0.145 generated types).
 */

/** codex TokenUsageBreakdown (0.145). All numbers; cumulative on `total`. */
export interface CodexTokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** riff-facing four-bucket usage (mutually exclusive input buckets). */
export interface TurnTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Token counts are non-negative integers; a negative or fractional value is a
 *  protocol violation, not a real count. */
function isTokenCount(v: unknown): v is number {
  return isFiniteNum(v) && Number.isInteger(v) && v >= 0;
}

/** Validate a raw notification payload's breakdown into a typed one, or null.
 *  0.145 fields are REQUIRED except `cacheWriteInputTokens` (added later, so a
 *  compat default of 0 is honest for it only). Any other missing/non-numeric
 *  field returns null — defaulting them to 0 would misreport a protocol gap as a
 *  real 0.
 *
 *  NOTE: when `total` and `last` are consumed together (the accumulator), prefer
 *  `parseTokenUsagePair` — it additionally enforces that the back-compat
 *  cacheWrite default is only honored when BOTH sides omit the field. A lone
 *  breakdown parsed here cannot see its counterpart, so a `cacheWrite=0` default
 *  here is provisional until the pair check confirms symmetry. */
export function parseCodexTokenBreakdown(raw: unknown): CodexTokenBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const required: (keyof CodexTokenBreakdown)[] = [
    'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
  ];
  const out = {} as CodexTokenBreakdown;
  for (const k of required) {
    if (!isTokenCount(r[k])) return null; // required non-negative integer; else protocol gap
    out[k] = r[k] as number;
  }
  // cacheWriteInputTokens: back-compat optional; absent → 0, present must be a token count.
  if (r.cacheWriteInputTokens === undefined) out.cacheWriteInputTokens = 0;
  else if (!isTokenCount(r.cacheWriteInputTokens)) return null;
  else out.cacheWriteInputTokens = r.cacheWriteInputTokens as number;
  return out;
}

/** True when a raw breakdown object carries `cacheWriteInputTokens` on the wire
 *  (vs. omitting it — the pre-cacheWrite codex versions the compat default is
 *  meant for). */
function hasCacheWriteField(raw: unknown): boolean {
  return !!raw && typeof raw === 'object'
    && (raw as Record<string, unknown>).cacheWriteInputTokens !== undefined;
}

/** Parse the `{ total, last }` pair from one notification, enforcing the
 *  cross-breakdown invariant the single parser can't see: the back-compat
 *  `cacheWriteInputTokens → 0` default is honest ONLY when BOTH breakdowns omit
 *  the field (a genuinely old codex). If exactly one side carries it, the two
 *  disagree (version skew / corruption): silently defaulting the missing side to
 *  0 would misattribute real cache-create tokens into fresh input AND poison the
 *  baseline for later completions with a plausible-looking undercount. Return
 *  null so the caller poisons the turn instead of emitting corrupt buckets. */
export function parseTokenUsagePair(
  rawTotal: unknown,
  rawLast: unknown,
): { total: CodexTokenBreakdown; last: CodexTokenBreakdown } | null {
  const total = parseCodexTokenBreakdown(rawTotal);
  const last = parseCodexTokenBreakdown(rawLast);
  if (!total || !last) return null;
  // Asymmetric cacheWrite presence ⇒ the 0-default on the missing side is a
  // guess, not a fact. Refuse rather than fabricate a wrong split.
  if (hasCacheWriteField(rawTotal) !== hasCacheWriteField(rawLast)) return null;
  return { total, last };
}

/** Map a cumulative-delta codex breakdown to riff's four mutually-exclusive
 *  buckets. codex `inputTokens` INCLUDES cached-read + cache-write, so the
 *  fresh-input bucket subtracts both. Returns null if the split is incoherent
 *  (buckets exceed input) — caller drops usage + warns rather than emit garbage. */
export function toFourBucket(d: CodexTokenBreakdown): TurnTokenUsage | null {
  const cacheReadTokens = d.cachedInputTokens;
  const cacheCreateTokens = d.cacheWriteInputTokens;
  const outputTokens = d.outputTokens; // reasoningOutputTokens is a subset — never add
  const inputTokens = d.inputTokens - cacheReadTokens - cacheCreateTokens;
  if (cacheReadTokens < 0 || cacheCreateTokens < 0 || outputTokens < 0 || inputTokens < 0) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens };
}

/** Accumulates per-turn usage from `thread/tokenUsage/updated` notifications for
 *  ONE appTurnId, using the total-delta algorithm. */
export class TurnTokenUsageAccumulator {
  private baseline: CodexTokenBreakdown | null = null;
  private latestTotal: CodexTokenBreakdown | null = null;
  private protocolWarning: string | undefined;

  /** Feed a notification's `tokenUsage` = { total, last, ... }. `total` is
   *  cumulative; `last` is the most recent completion's usage. */
  update(total: CodexTokenBreakdown, last: CodexTokenBreakdown): void {
    if (this.baseline === null) {
      // baseline = total - last, per field. This lets a mid-session / resumed
      // turn measure only its own tokens without knowing prior session totals.
      // A negative field means total < last — impossible if `last` is a subset
      // of the cumulative `total`; treat as a protocol anomaly and fail closed
      // rather than derive a bogus baseline that inflates the turn.
      const baseline = subtract(total, last);
      if (!allNonNegative(baseline)) {
        this.protocolWarning = 'tokenUsage baseline (total-last) went negative';
        return;
      }
      this.baseline = baseline;
    }
    // total must be monotonic non-decreasing vs the last seen ACROSS ALL FIELDS;
    // a regression in any field is a protocol anomaly → fail closed.
    if (this.latestTotal && !isGreaterOrEqual(total, this.latestTotal)) {
      this.protocolWarning = 'tokenUsage.total regressed';
      return;
    }
    this.latestTotal = total;
  }

  /** Mark this turn's usage as unusable (sticky). Called when a notification for
   *  the turn arrives but its breakdown is malformed: skipping it silently would
   *  let a LATER valid notification rebuild a fresh baseline and report only the
   *  last completion — a plausible-looking undercount. Poisoning makes result()
   *  omit + warn instead. */
  poison(reason: string): void {
    if (!this.protocolWarning) this.protocolWarning = reason;
  }

  /** The turn's usage so far as four buckets, or null if no usage seen / a
   *  protocol anomaly was detected / the bucket split is incoherent. When usage
   *  is dropped for an incoherent delta or bucket split (as opposed to simply
   *  never having seen a notification), a warning is recorded so the caller can
   *  surface the omission rather than dropping it silently. */
  result(): TurnTokenUsage | null {
    if (this.protocolWarning || !this.baseline || !this.latestTotal) return null;
    const delta = subtract(this.latestTotal, this.baseline);
    if (!allNonNegative(delta)) {
      this.protocolWarning = 'tokenUsage delta (latestTotal-baseline) went negative';
      return null;
    }
    const buckets = toFourBucket(delta);
    if (!buckets) {
      this.protocolWarning = 'tokenUsage bucket split incoherent (cache buckets exceed input)';
      return null;
    }
    return buckets;
  }

  /** Non-null when the accumulator gave up on usage for a protocol reason. */
  get warning(): string | undefined { return this.protocolWarning; }
}

function subtract(a: CodexTokenBreakdown, b: CodexTokenBreakdown): CodexTokenBreakdown {
  return {
    totalTokens: a.totalTokens - b.totalTokens,
    inputTokens: a.inputTokens - b.inputTokens,
    cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
  };
}

function isGreaterOrEqual(a: CodexTokenBreakdown, b: CodexTokenBreakdown): boolean {
  // Every cumulative field must be monotonic — a regression in ANY (including
  // cacheRead/cacheWrite/reasoning) is a protocol anomaly, not just total/in/out.
  return a.totalTokens >= b.totalTokens
    && a.inputTokens >= b.inputTokens
    && a.cachedInputTokens >= b.cachedInputTokens
    && a.cacheWriteInputTokens >= b.cacheWriteInputTokens
    && a.outputTokens >= b.outputTokens
    && a.reasoningOutputTokens >= b.reasoningOutputTokens;
}

function allNonNegative(d: CodexTokenBreakdown): boolean {
  return d.totalTokens >= 0 && d.inputTokens >= 0 && d.cachedInputTokens >= 0
    && d.cacheWriteInputTokens >= 0 && d.outputTokens >= 0 && d.reasoningOutputTokens >= 0;
}
