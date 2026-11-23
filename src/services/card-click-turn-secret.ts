/**
 * Per-bot signing secret for card-click turns, shared by the daemon's click
 * binder (verification) and every producer of a signed button (the dashboard
 * POST route, the reply card「下一步」row). Kept apart from the binder so a
 * producer inside the worker pool does not import the binder's worker wiring.
 */
import { join } from 'node:path';
import { loadOrCreateDashboardSecret } from '../dashboard/auth.js';
import { issueCardClickTurn } from './card-click-turn.js';

const APP_ID_RE = /^[A-Za-z0-9_]{4,64}$/;

/** Per-bot directory. The session data dir is shared by every bot daemon in a fleet. */
export function cardClickTurnDir(dataDir: string, larkAppId: string): string {
  if (!APP_ID_RE.test(larkAppId)) throw new Error('invalid app id');
  return join(dataDir, 'card-click-turn', larkAppId);
}

export function cardClickTurnSecret(dataDir: string, larkAppId: string): string {
  return loadOrCreateDashboardSecret(join(cardClickTurnDir(dataDir, larkAppId), 'secret'));
}

/** A signed single-use button token that sends `prompt` to one live session. */
export function issueSessionCardClickTurn(input: {
  dataDir: string;
  larkAppId: string;
  sessionId: string;
  prompt: string;
  ttlMs?: number;
}): { payload: string; sig: string } | undefined {
  const issued = issueCardClickTurn({
    secret: cardClickTurnSecret(input.dataDir, input.larkAppId),
    larkAppId: input.larkAppId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
  return issued.ok ? { payload: issued.payload, sig: issued.sig } : undefined;
}
