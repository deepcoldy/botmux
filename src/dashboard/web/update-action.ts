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
