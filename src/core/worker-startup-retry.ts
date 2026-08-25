/**
 * Daemon-side self-heal policy for TRANSIENT worker startup failures.
 *
 * 2026-08-23 incident: the shared tmux server died and every bot's workers
 * cold-restarted their sessions simultaneously (261 tmux sessions rebuilt in
 * ~40s, load ≈ 17). A handful of workers hit client-side deadlines against the
 * overloaded server ("spawnSync tmux ETIMEDOUT") and the daemon's only
 * response was a user-visible "会话启动失败" card on sessions nobody had
 * touched for days — even though the backing tmux pane and CLI process were
 * actually alive (only the managing worker had died).
 *
 * The worker side retries what it can (see tmux-pipe-backend's startup retry
 * loops), but any escape hatch — a mis-classified error, a not-yet-hardened
 * call site, a genuinely long stall — used to be terminal. This policy gives
 * the daemon a bounded second line of defence: classify the worker's fatal
 * startup reason, and if it is plausibly transient, schedule a blank re-fork
 * (re-attach if the pane survived, cold `--resume` otherwise — the exact
 * recovery a daemon restart or the next inbound message would perform) with
 * spaced, decorrelated backoff. Only when the budget is exhausted does the
 * failure surface to the chat.
 *
 * Pure module: the classifier and delay schedule are unit-tested; the timer
 * wiring lives in worker-pool's setupWorkerHandlers.
 */

/** Maximum daemon-side auto-retries per failing streak. Reset when a worker
 *  generation reaches `ready`. */
export const MAX_STARTUP_AUTO_RETRIES = 3;

/** Base backoff per attempt (1-indexed). Spaced widely enough that attempt 2+
 *  lands after a restart herd has drained (the 08-23 storm settled in ~60s). */
const STARTUP_AUTO_RETRY_BASE_DELAYS_MS = [15_000, 60_000, 180_000];

/**
 * Is this fatal worker startup reason plausibly transient host/backend
 * pressure (worth a silent daemon-side retry) rather than a deterministic
 * configuration/installation failure (surface immediately)?
 *
 * Matches connection-level and resource-pressure signatures only:
 *   - exec deadline (`ETIMEDOUT`) — the 08-23 escape;
 *   - connect-level failures against a stalled/restarting shared server
 *     (`ECONNREFUSED`, tmux's "error connecting to …" / "lost server" /
 *     "server exited unexpectedly");
 *   - fd/process pressure (`EAGAIN`, `EMFILE`, `ENFILE`).
 * Deliberately NOT matched: ENOENT/EACCES (binary genuinely missing/broken),
 * CLI-specific launch errors, config validation — retrying only delays the
 * same user-actionable failure.
 */
export function isTransientStartupFailure(reason: string): boolean {
  return /\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAGAIN\b|\bEMFILE\b|\bENFILE\b|error connecting to|lost server|server exited unexpectedly/i.test(reason);
}

/**
 * Deterministic decorrelated backoff: base delay for the attempt, jittered to
 * 75%–125% by a session-id hash (same FNV-1a style as tmuxRestartJitterMs).
 * Deterministic jitter keeps the schedule unit-testable while spreading a
 * whole storm's retries — the failure mode being healed IS mass simultaneity,
 * so N failed sessions must not re-storm the server on one shared timer edge.
 */
export function startupAutoRetryDelayMs(sessionId: string, attempt: number): number {
  const clamped = Math.min(
    Math.max(1, Math.floor(attempt)),
    STARTUP_AUTO_RETRY_BASE_DELAYS_MS.length,
  );
  const base = STARTUP_AUTO_RETRY_BASE_DELAYS_MS[clamped - 1];
  const input = `${sessionId}:startup-retry:${clamped}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const jitter = (hash >>> 0) % (base / 2 + 1);
  return Math.round(base * 0.75 + jitter);
}
