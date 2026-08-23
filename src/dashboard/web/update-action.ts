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
  /** True when the new binary is installed but a normal restart is refused
   * because live daemons still run the pre-signal-death-autorestart PM2 policy.
   * The operator must run the one-time `--bootstrap-shutdown-protocol` upgrade
   * from a terminal. Distinct from restartError so the UI shows a precise,
   * actionable message instead of a generic failure. */
  bootstrapRequired?: boolean;
  /** Canonical PM2 names still on the old policy (best-effort, may be empty). */
  unsafeDaemons?: string[];
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

function responseError(response: Response, body: Record<string, unknown>): Error {
  const detail = body.detail ?? body.error;
  return new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`);
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
  if (restart.error === 'bootstrap_shutdown_protocol_required') {
    // Installed successfully, but the fleet predates the signal-death
    // autorestart protocol: a normal restart fails closed. Surface this as its
    // own state so the UI can point the operator at the one-time bootstrap
    // command rather than polling a reconnect that will never happen.
    const unsafe = Array.isArray(restart.unsafeDaemons)
      ? restart.unsafeDaemons.filter((name): name is string => typeof name === 'string')
      : [];
    return { ...result, restarted: false, bootstrapRequired: true, unsafeDaemons: unsafe };
  }
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
