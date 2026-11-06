import * as store from '../services/session-store.js';
import { getBot } from '../bot-registry.js';
import { ModelPinBusyError } from './model-pin.js';
import { resolveSessionModelPinView } from './session-model.js';
import type { DaemonSession } from './types.js';

export function botModelPins(appId: string, findActive?: (id: string) => DaemonSession | undefined) {
  const cfg = getBot(appId).config;
  const rows = store.listSessionsStrict().filter(s => s.larkAppId === appId && s.modelPin);
  return { total: rows.length, protected: rows.filter(s => s.status === 'active' && resolveSessionModelPinView(findActive?.(s.sessionId) ?? { session: s }, cfg)?.active).length };
}

export function clearModelPins(appId: string, sessionId: string | undefined, deps: {
  findActive(id: string): DaemonSession | undefined;
  assertMutable(ds: DaemonSession): void;
  publish(id: string): void;
}): string[] {
  const rows = store.listSessionsStrict().filter(s => s.larkAppId === appId && (!sessionId || s.sessionId === sessionId));
  if (sessionId && !rows.length) throw new Error('session_not_found');
  const ids = rows.filter(s => s.modelPin).map(s => s.sessionId);
  if (!ids.length) return [];
  const busySessions: ModelPinBusyError['busySessions'] = [];
  for (const id of ids) {
    const ds = deps.findActive(id);
    if (ds) try { deps.assertMutable(ds); }
    catch (error) {
      if (!(error instanceof ModelPinBusyError)) throw error;
      busySessions.push(...error.busySessions);
    }
  }
  if (busySessions.length) throw new ModelPinBusyError(busySessions);
  store.mutateOwnedSessionsAtomically(ids, fresh => {
    for (const row of fresh.values()) delete row.modelPin;
  }, { modelPinWrite: true });
  for (const id of ids) {
    const ds = deps.findActive(id);
    if (ds) { delete ds.session.modelPin; ds.modelPinCleared = true; }
    deps.publish(id);
  }
  return ids;
}
