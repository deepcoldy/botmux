export type BotmuxUpdatePhase = 'updating' | 'restarting';

export interface BotmuxUpdateResult {
  oldVersion: string;
  newVersion: string;
  changed: boolean;
  restarted: boolean;
  /** Populated when the update succeeded but the restart handoff failed. */
  restartError?: string;
  /** True when a restart was already in progress (another driver claimed the lease). */
  alreadyScheduled?: boolean;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Decide whether a successful `/api/update/run` response requires a restart to
 * take effect. A restart is needed when the server explicitly says so
 * (`restartRequired` — set for local-dev, whose build regenerates dist/ even
 * when HEAD didn't move) OR when the installed version changed (the generic
 * npm/pnpm/bun path, which sends no `restartRequired`). Pure so the Settings
 * update flow can be regression-tested without rendering the component.
 */
export function updateResponseNeedsRestart(
  body: { restartRequired?: unknown; changed?: unknown },
): boolean {
  return body.restartRequired === true || body.changed === true;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function responseError(response: Response, body: Record<string, unknown>): Error & { code?: string } {
  const detail = body.detail ?? body.error;
  const error = new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`) as Error & { code?: string };
  // Machine-readable code so callers can special-case 409 update_in_flight
  // (join/observe the running update) without matching on message text.
  if (typeof body.error === 'string') error.code = body.error;
  return error;
}

// ── Live progress for standalone-binary updates (~174MB asset) ─────────────────

export type BinaryUpdatePhase = 'download' | 'checksum' | 'probe' | 'swap';

export interface BinaryUpdateStatus {
  version: string;
  phase: BinaryUpdatePhase;
  bytesReceived: number;
  bytesTotal: number | null;
}

/** Subset of GET /api/update/status the update flow polls. `updateInFlight`
 *  is strictly in-process: an update running in the CLI or the maintenance
 *  daemon holds the same file lock but leaves this flag false. */
export interface UpdateStatusSnapshot {
  current: string;
  latest: string | null;
  behind?: boolean;
  updateInFlight?: boolean;
  binaryUpdate?: BinaryUpdateStatus | null;
}

export function updateActionErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const shown = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/** Download fraction in 0..1, or null when the server cannot report a total
 *  (chunked response). */
export function binaryDownloadFraction(status: BinaryUpdateStatus): number | null {
  if (status.phase !== 'download' || !status.bytesTotal || status.bytesTotal <= 0) return null;
  return Math.min(1, status.bytesReceived / status.bytesTotal);
}

/** Map server progress onto the install half (5..48%) of the top-bar ring:
 *  download owns 5..45%, then checksum/probe/swap hold at 46/47/48 until the
 *  restart phase takes over at 50%. Null keeps the existing faux creep. */
export function binaryProgressRingValue(status: BinaryUpdateStatus): number | null {
  const fraction = binaryDownloadFraction(status);
  if (fraction !== null) return 5 + fraction * 40;
  if (status.phase === 'checksum') return 46;
  if (status.phase === 'probe') return 47;
  if (status.phase === 'swap') return 48;
  return null;
}

const BINARY_PHASE_LABEL_KEY: Record<BinaryUpdatePhase, string> = {
  download: 'update.binaryDownloading',
  checksum: 'update.binaryChecksum',
  probe: 'update.binaryProbe',
  swap: 'update.binarySwap',
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Human-readable, locale-aware line for a binary-update status snapshot. */
export function binaryProgressText(status: BinaryUpdateStatus, t: Translate): string {
  const version = `v${status.version}`;
  if (status.phase === 'download') {
    const fraction = binaryDownloadFraction(status);
    if (fraction !== null) {
      return t('update.downloadProgress', {
        version,
        received: formatBytes(status.bytesReceived),
        total: formatBytes(status.bytesTotal ?? 0),
        percent: Math.round(fraction * 100),
      });
    }
    if (status.bytesReceived > 0) {
      return t('update.downloadProgressUnknown', {
        version,
        received: formatBytes(status.bytesReceived),
      });
    }
  }
  return t(BINARY_PHASE_LABEL_KEY[status.phase], { version });
}

/** Poll GET /api/update/status while a (possibly cross-tab or cross-process)
 *  update runs. Returns a stop function. Errors are swallowed: the dashboard
 *  becomes briefly unreachable during the restart handoff.
 *
 *  `timeoutMs`/`onTimeout` run on an INDEPENDENT timer, so a server that keeps
 *  returning 503, a dead network, or a request that hangs forever still reaches
 *  the terminal state. On timeout polling stops itself before invoking
 *  `onTimeout` — the callback must not keep polling. */
export function pollUpdateStatus(
  fetchImpl: FetchLike,
  onStatus: (status: UpdateStatusSnapshot) => void,
  intervalMs = 1000,
  timeoutMs?: number,
  onTimeout?: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const clearScheduled = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const stop = (): void => {
    stopped = true;
    clearScheduled();
    if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  };
  const tick = async (): Promise<void> => {
    timer = null;
    try {
      const response = await fetchImpl('/api/update/status', { cache: 'no-store' });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (!stopped && body && typeof body === 'object') {
          onStatus(body as UpdateStatusSnapshot);
        }
      }
    } catch { /* transient — poll again */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  if (timeoutMs !== undefined && onTimeout) {
    timeoutTimer = setTimeout(() => {
      stop();
      onTimeout();
    }, timeoutMs);
  }
  timer = setTimeout(tick, 0);
  return stop;
}

export type OtherUpdateState = 'progress' | 'busy' | 'waiting' | 'completed';

/**
 * Interpret a status snapshot AFTER our own POST was rejected with 409
 * update_in_flight. Completion is decided ONLY from version state
 * (`behind === false`), never from `updateInFlight === false`: an update in the
 * CLI/maintenance process never flips this dashboard's in-memory flag.
 */
export function classifyOtherUpdate(status: UpdateStatusSnapshot): OtherUpdateState {
  if (status.binaryUpdate && typeof status.binaryUpdate.phase === 'string') return 'progress';
  if (status.updateInFlight) return 'busy';
  if (status.latest && status.behind === false) return 'completed';
  return 'waiting';
}

/**
 * Whether the observed update finished INSTALLING, from version state alone:
 * a rollback moves `current`, an update makes `behind` false (and either may
 * move `current`). This is deliberately NOT the reload gate: install
 * completion precedes the restart, another tab may still be showing a restart
 * confirmation, and a CLI-driven update never restarts at all. Callers gate any
 * reload on the dashboard INSTANCE changing (/__selfcheck), not on this.
 */
export function observedInstallCompleted(
  status: UpdateStatusSnapshot,
  startVersion: string,
  isRollback: boolean,
): boolean {
  if (status.current !== startVersion) return true;
  return !isRollback && classifyOtherUpdate(status) === 'completed';
}

/** Install the latest, or atomically roll back to an allow-listed older version. */
export async function updateAndRestartBotmux(
  fetchImpl: FetchLike,
  onPhase: (phase: BotmuxUpdatePhase) => void = () => {},
  targetVersion?: string,
): Promise<BotmuxUpdateResult> {
  onPhase('updating');
  const updateResponse = await fetchImpl(targetVersion ? '/api/update/rollback' : '/api/update/run', targetVersion
    ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: targetVersion }),
      }
    : { method: 'POST' });
  const update = await responseBody(updateResponse);
  if (!updateResponse.ok || update.ok === false) throw responseError(updateResponse, update);
  if (
    update.ok !== true ||
    typeof update.oldVersion !== 'string' ||
    typeof update.newVersion !== 'string' ||
    typeof update.changed !== 'boolean'
  ) {
    throw new Error('Invalid update response');
  }
  if (targetVersion && (update.newVersion !== targetVersion || update.changed !== true)) {
    throw new Error('Invalid rollback response');
  }

  const result: BotmuxUpdateResult = {
    oldVersion: update.oldVersion,
    newVersion: update.newVersion,
    changed: update.changed,
    restarted: false,
  };

  onPhase('restarting');
  // The rollback endpoint holds the install lock through restart handoff, so
  // there is deliberately no client-side /restart gap for maintenance to race.
  if (targetVersion) return { ...result, restarted: true };

  const restartResponse = await fetchImpl('/api/update/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      update: { oldVersion: result.oldVersion, newVersion: result.newVersion },
    }),
  });
  const restart = await responseBody(restartResponse);
  if (!restartResponse.ok || restart.ok === false) {
    // The update itself succeeded — the new version is already installed.
    // Return restarted:false instead of throwing so the caller can surface a
    // "please restart manually" message rather than treating it as a full
    // update failure (which would tempt the user to re-run the install).
    return { ...result, restarted: false, restartError: responseError(restartResponse, restart).message };
  }
  if (restart.ok !== true) throw new Error('Invalid restart response');
  const alreadyScheduled = restart.alreadyScheduled === true;
  return alreadyScheduled
    ? { ...result, restarted: true, alreadyScheduled: true }
    : { ...result, restarted: true };
}
