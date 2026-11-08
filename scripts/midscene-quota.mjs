// Recognises "the Midscene model service is out of quota" (#2670).
//
// A quota-exhausted run says nothing about the merged code: every case that
// asks the vision model fails the same way until the quota resets. The model
// preflight (check-midscene-model.mjs) uses this to skip the suites, and the
// master failure notification (midscene-notify-failure.mjs) uses it to leave
// such failures off the merged pull requests.
//
// Only HTTP 429 that names the quota counts. A plain rate limit (also 429) is
// transient and stays a real failure.

const QUOTA_WORDING = /insufficient_quota|quota\b[^.\n]{0,60}\b(?:exhausted|exceeded)|exceeded\b[^.\n]{0,40}\bquota/i;

/** A preflight response that means the quota is used up. */
export function isQuotaExhaustedResponse(status, body) {
  return status === 429 && QUOTA_WORDING.test(String(body ?? ''));
}

/**
 * A case failure message (the first line Midscene reports, e.g. "AI model
 * request failed after 3 retries … 429 Your token-plan 1-month quota has been
 * exhausted …") that comes from the quota.
 */
export function isQuotaFailureMessage(message) {
  const text = String(message ?? '');
  return /\b429\b/.test(text) && QUOTA_WORDING.test(text);
}

// Only a complete timestamp: case messages are cut at 200 characters, and a
// half date ("11-15…") would mislead. The pattern also keeps provider text out
// of step outputs.
const RESET_TIME = /\breset(?:s)? (?:at|on) (\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z| UTC)?|\d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})? UTC)/i;

/** When the provider says the quota comes back, or null. */
export function quotaResetTime(text) {
  return String(text ?? '').match(RESET_TIME)?.[1] ?? null;
}

/** The one-line note for run summaries and comments. */
export function quotaNote(resetTime) {
  return `Midscene 模型服务额度耗尽（HTTP 429）${resetTime ? `，额度将于 ${resetTime} 重置` : '，重置时间见用例报错'}`;
}
