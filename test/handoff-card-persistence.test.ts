import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { applyHandoffCardEvent } from '../src/core/handoff-card-lifecycle.js';
import type { DaemonSession } from '../src/core/types.js';

let dataDir: string;
let previousDataDir: string;
beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-handoff-sqlite-'));
  config.session.dataDir = dataDir;
  sessionStore.init('app_handoff_sqlite');
});
afterEach(() => {
  sessionStore.init(undefined, { owner: false });
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
function session(): DaemonSession {
  const row = sessionStore.createSession('oc_fixture', 'om_root', 'fixture', 'group', 'chat');
  row.handoffLiveCard = { turnId: 'turn_one', sequence: 0 };
  sessionStore.updateSession(row);
  return { session: row, currentTurnId: 'turn_one', streamCardId: 'om_live',
    streamCardNonce: 'nonce', streamCardPending: true, streamCardPendingTurnId: 'turn_one',
    pendingCardId: 'om_live', pendingCardJson: '{}' } as DaemonSession;
}
describe('handoff card completion through native SQLite persistence', () => {
  it('clears the completed card after persistence rehydrates the handoff value', async () => {
    const ds = session();
    const oldReference = ds.session.handoffLiveCard;
    const effects = { persist: () => sessionStore.updateSession(ds.session), patch: vi.fn(),
      remove: vi.fn(async () => {}), clear: vi.fn() };
    await applyHandoffCardEvent(ds, {
      kind: 'complete', turnId: 'turn_one', sequence: 1, resultMessageId: 'om_result',
    }, effects);
    expect(ds.session.handoffLiveCard).not.toBe(oldReference);
    expect(sessionStore.getOwnedSession(ds.session.sessionId)?.handoffLiveCard?.closed).toBe(true);
    expect(effects.remove).toHaveBeenCalledExactlyOnceWith('om_live');
    expect(ds.streamCardId).toBeUndefined();
    expect(ds.streamCardNonce).toBeUndefined();
    expect(ds.streamCardPending).toBe(false);
    expect(ds.streamCardPendingTurnId).toBeUndefined();
    expect(ds.pendingCardId).toBeUndefined();
    expect(ds.pendingCardJson).toBeUndefined();
    expect(effects.clear).toHaveBeenCalledExactlyOnceWith();
  });
  it('preserves a new turn and card installed while the old delete is pending', async () => {
    const ds = session();
    const effects = { persist: () => sessionStore.updateSession(ds.session), patch: vi.fn(),
      remove: vi.fn(async () => {
        ds.session.handoffLiveCard = { turnId: 'turn_two', sequence: 0 };
        ds.currentTurnId = 'turn_two';
        ds.streamCardId = 'om_next';
        sessionStore.updateSession(ds.session);
      }), clear: vi.fn() };
    await applyHandoffCardEvent(ds, {
      kind: 'complete', turnId: 'turn_one', sequence: 1, resultMessageId: 'om_result',
    }, effects);
    expect(ds.streamCardId).toBe('om_next');
    expect(ds.session.handoffLiveCard?.turnId).toBe('turn_two');
    expect(effects.clear).not.toHaveBeenCalled();
  });
});
