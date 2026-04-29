/**
 * Pure rotation-policy gate for the Claude bridge watcher.
 *
 * Lives outside `worker.ts` so tests can import without dragging worker-level
 * fs / IPC side-effects.
 */

export type PidFollowResult = 'unavailable' | 'same' | 'switched';

/**
 * Decide whether `bridgeIngest` should fall through to the directory-mtime
 * `maybeFollowQuietRotation` heuristic this tick.
 *
 * Inputs:
 *   - `pidFollow`: result of the authoritative pid-state probe
 *     (`maybeFollowSessionRotationViaPid`). `'switched'` means it already
 *     moved us; `'same'` means the pid file's `sessionId` matches our
 *     current path; `'unavailable'` means the pid file was unreadable
 *     (non-Linux, no `~/.claude/sessions/<pid>.json`, validation failure).
 *   - `switched`: whether ANY earlier rotation step (pid resolver OR
 *     fingerprint fallback) already moved the watcher this tick.
 *
 * Returns true only when there was no earlier switch AND the pid resolver
 * gave no opinion.
 *
 * Trade-off: pid resolver `'same'` is NOT proof that no rotation happened
 * — Claude Code 2.1.123 writes `sessionId` ONCE at process start and the
 * in-pane `/clear` path does not refresh it. We still skip the mtime
 * heuristic on `'same'` because the alternative is sibling-pane hijack:
 * any other Claude pane in the same cwd gets a busier jsonl and the
 * heuristic picks it. The cost is that a pure-local `/clear` with no
 * pending Lark turn won't auto-follow until the user sends a Lark
 * message (which arms fingerprint fallback). The Lark-message path is
 * the dominant /clear recovery flow in practice; sibling-pane
 * corruption would silently break every multi-pane adopt setup.
 *
 * `--resume` is a fresh spawn and rewrites the pid file's sessionId, so
 * it surfaces here as `'switched'`, not `'same'` — it's not affected by
 * this gate.
 */
export function shouldRunQuietRotation(
  pidFollow: PidFollowResult,
  switched: boolean,
): boolean {
  if (switched) return false;
  return pidFollow === 'unavailable';
}

// ─── Pid-resolver pull-back suppression ────────────────────────────────────

export interface PidResolverPullbackInput {
  /** sessionId reported by the pid file this tick. */
  resolvedCliSessionId: string;
  /** The pid file's full jsonl path (derived from sessionId + cwd). */
  resolvedPath: string;
  /** Current bridge jsonl path. */
  currentBridgeJsonlPath: string | undefined;
  /** Sid recorded as "stale" by the fingerprint fallback the last time it
   *  accepted a candidate the pid file disagreed about. Undefined when no
   *  fingerprint accept has overridden the pid file. */
  stalePidStateSessionId: string | undefined;
}

export interface PidResolverPullbackDecision {
  /** True ⇒ pid resolver should report 'same' rather than rotate the
   *  watcher back to `resolvedPath`. */
  suppress: boolean;
  /** True ⇒ caller should clear `stalePidStateSessionId`: a fresh sid
   *  (different from the stale one) appeared in the pid file, meaning a
   *  real rotation has happened (`--resume` / fresh spawn) and the prior
   *  fingerprint accept is no longer relevant. */
  clearStale: boolean;
}

/**
 * Decide whether the pid resolver should pull the watcher back to a path
 * that disagrees with the current bridgeJsonlPath, given the worker's
 * staleness bookkeeping.
 *
 * Rules:
 * - No `stalePidStateSessionId` recorded ⇒ honour pid resolver as before.
 * - Recorded sid matches pid file's current sid ⇒ suppress: this is the
 *   spawn-time sid that fingerprint fallback already overrode for an
 *   in-pane /clear that pid file can't see.
 * - Recorded sid differs from pid file's current sid ⇒ a NEW rotation has
 *   happened (`--resume` / fresh spawn / Claude restart with new pid file
 *   contents). Clear the stale flag and let pid resolver switch normally.
 */
export function evaluatePidResolverPullback(
  input: PidResolverPullbackInput,
): PidResolverPullbackDecision {
  if (input.stalePidStateSessionId === undefined) {
    return { suppress: false, clearStale: false };
  }
  if (input.resolvedCliSessionId === input.stalePidStateSessionId) {
    return { suppress: true, clearStale: false };
  }
  return { suppress: false, clearStale: true };
}

// ─── Two-phase fingerprint-fallback decision ───────────────────────────────

/** UUID-shaped Claude jsonl filename (sessionId.jsonl). Duplicated from
 *  `src/adapters/cli/claude-code.ts:SESSION_UUID_RE` to keep this module
 *  free of adapter imports. Keep the two patterns in sync; both gate
 *  trust-set membership and fingerprint-fallback candidate eligibility. */
export const SESSION_ID_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract the sessionId portion of a `<sid>.jsonl` path (basename minus
 *  the `.jsonl` extension). Returns the empty string when the path lacks
 *  the expected suffix; callers should treat that as "untrusted". */
export function sessionIdFromJsonlPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : '';
}

export interface FingerprintSwitchInput {
  /** Substring fingerprint to feed Phase 1's scanner. Required. */
  contentFingerprint: string;
  /** Full normalised content of the Lark turn. Phase 2 (unknown-sid
   *  exact-content recovery) is skipped when this is missing or empty —
   *  short content can't anchor a recovery without ambiguity. */
  contentNormalized?: string;
  /** Trust set populated from initial attach, pid resolver hits, fd probes. */
  knownSessionIds: ReadonlySet<string>;
  /** Phase 1 scanner: substring fingerprint search. Caller wires it to
   *  `findJsonlContainingFingerprint`; this helper only sees the result. */
  findSubstring: (acceptCandidate: (path: string) => boolean) => string | null;
  /** Phase 2 scanner: exact-content search returning ALL matches in
   *  mtime-descending order. Caller wires it to
   *  `findJsonlsContainingExactContent`. */
  findExact: (acceptCandidate: (path: string) => boolean) => string[];
}

export type FingerprintSwitchDecision =
  | { action: 'switch'; path: string; reason: 'known-sid-substring' | 'unknown-sid-exact' }
  | { action: 'abstain'; reason: 'multiple-unknown-exact'; candidates: string[] }
  | { action: 'no-match' };

/**
 * Two-phase candidate selection for the bridge fingerprint fallback.
 *
 * Phase 1 (known-sid substring): the cheap path. Run the substring
 * fingerprint scanner with an acceptCandidate predicate that requires
 * `(UUID-shaped sid) AND (sid in knownSessionIds)`. Sibling panes are
 * UUID-shaped but not in our trust set — their fingerprint hits are
 * rejected. UUID gate also blocks accidental non-Claude jsonls.
 *
 * Phase 2 (unknown-sid exact-content recovery): only runs when
 * `contentNormalized` is non-empty. Fires when Phase 1 found no match,
 * which is the worst-case in-pane `/clear` scenario where the new sid
 * never reaches our trust set (pid file lags, fd probe missed the open
 * window). Run the exact-content scanner with predicate
 * `(UUID-shaped sid) AND (sid NOT in knownSessionIds)`. Decision:
 *   - 0 matches → no-match
 *   - 1 match  → switch (the post-/clear file we couldn't otherwise see)
 *   - ≥2 matches → abstain; multiple untrusted files normalise to the
 *     same Lark content, so we cannot pick one without further evidence.
 *     Caller is expected to log and surface a diagnostic.
 *
 * Pure: never touches fs / IPC / module state. Tests inject fakes for
 * `findSubstring` and `findExact` to exercise every branch.
 */
export function decideFingerprintSwitch(
  input: FingerprintSwitchInput,
): FingerprintSwitchDecision {
  const matchedKnown = input.findSubstring((path) => {
    const sid = sessionIdFromJsonlPath(path);
    return SESSION_ID_FILENAME_RE.test(sid) && input.knownSessionIds.has(sid);
  });
  if (matchedKnown) {
    return { action: 'switch', path: matchedKnown, reason: 'known-sid-substring' };
  }
  if (!input.contentNormalized || input.contentNormalized.length === 0) {
    return { action: 'no-match' };
  }
  const exact = input.findExact((path) => {
    const sid = sessionIdFromJsonlPath(path);
    return SESSION_ID_FILENAME_RE.test(sid) && !input.knownSessionIds.has(sid);
  });
  if (exact.length === 0) return { action: 'no-match' };
  if (exact.length > 1) {
    return { action: 'abstain', reason: 'multiple-unknown-exact', candidates: exact };
  }
  return { action: 'switch', path: exact[0], reason: 'unknown-sid-exact' };
}
