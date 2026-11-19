/** Floor for a metadata-poll iteration's per-request budget. Below this, the
 *  poll deadline is effectively reached: issuing a thread/read with a
 *  sub-floor client timeout would reliably time out (and REJECT, not return)
 *  before even a fast localhost response lands, and that rejection would
 *  escape the poll loop instead of degrading to "not found" / "no update".
 *  Guards waitForThreadPreview / waitForThreadUpdatedAfter in both the live
 *  CodexRpcEngine (codex-rpc-engine.ts) and the one-shot naming probe
 *  (services/codex-app-threads.ts) against a flaky end-of-window request.
 *  50ms is comfortably above a localhost RPC round-trip yet negligible vs
 *  the callers' 200ms–10s budgets. Kept in one place so the two copies of
 *  the polling loop cannot drift apart. */
export const MIN_POLL_REQUEST_BUDGET_MS = 50;
