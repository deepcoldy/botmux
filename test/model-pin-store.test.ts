import { ModelPinBusyError } from '../src/core/model-pin.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let dir: string;
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return dir; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<object>(),
  getBot: () => ({ config: { cliId: 'codex', model: 'bot-default' } }),
  getAllBots: () => [],
}));
import * as store from '../src/services/session-store.js';
import { botModelPins, clearModelPins } from '../src/core/model-pin-store.js';
const pin = { model: 'gpt-6.1-terra', effort: 'high' as const, source: 'command' as const, setBy: 'owner', setAt: '2026-11-06T00:00:00.000Z' };
const deps = { findActive: (_id: string): any => undefined, assertMutable: (_ds: any) => {}, publish: vi.fn() };
function create(appId = 'pin-app') {
  const s = store.createSession('chat', crypto.randomUUID(), 'title', 'group', 'thread');
  s.larkAppId = appId; s.cliId = 'codex'; s.modelPin = { ...pin };
  store.updateSession(s, { modelPinWrite: true }); return s;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-pin-store-')); store.init('pin-app'); deps.publish.mockClear(); });
afterEach(() => { store.__testOnly_setBeforeRowPersist(undefined); rmSync(dir, { recursive: true, force: true }); });
describe('durable explicit model intent', () => {
  it('round-trips provenance and effort through a real SQLite reload, leaving legacy sessions unpinned', () => {
    const s = create(); const old = store.createSession('chat', 'legacy', 'old');
    store.init('pin-app');
    expect(store.getOwnedSession(s.sessionId)?.modelPin).toEqual(pin);
    expect(store.getOwnedSession(old.sessionId)?.modelPin).toBeUndefined();
  });
  it('single clear, batch clear including closed sessions, and bot isolation survive reload', () => {
    const a = create(), b = create(), other = create('other-app');
    store.closeSession(b.sessionId);
    expect(botModelPins('pin-app')).toEqual({ total: 2, protected: 1 });
    expect(clearModelPins('pin-app', a.sessionId, deps)).toEqual([a.sessionId]);
    expect(store.getOwnedSession(b.sessionId)?.modelPin).toEqual(pin);
    expect(clearModelPins('pin-app', undefined, deps)).toEqual([b.sessionId]);
    store.init('pin-app');
    expect(store.getOwnedSession(a.sessionId)?.modelPin).toBeUndefined();
    expect(store.getOwnedSession(b.sessionId)?.modelPin).toBeUndefined();
    expect(store.getOwnedSession(other.sessionId)?.modelPin).toEqual(pin);
  });
  it('late whole-row metadata cannot erase a new pin or resurrect a cleared pin', () => {
    const s = create(); const stalePin = structuredClone(s);
    clearModelPins('pin-app', s.sessionId, deps);
    stalePin.title = 'late'; store.updateSession(stalePin);
    expect(store.getOwnedSession(s.sessionId)?.modelPin).toBeUndefined();
    const staleEmpty = structuredClone(stalePin);
    s.modelPin = { ...pin, model: 'new-choice' }; store.updateSession(s, { modelPinWrite: true });
    store.updateSession(staleEmpty);
    expect(store.getOwnedSession(s.sessionId)?.modelPin?.model).toBe('new-choice');
  });
  it('rolls back the entire batch on the second write failure and publishes nothing', () => {
    const a = create(), b = create(); let writes = 0;
    store.__testOnly_setBeforeRowPersist(() => { if (++writes === 2) throw new Error('write failed'); });
    expect(() => clearModelPins('pin-app', undefined, deps)).toThrow('write failed');
    store.__testOnly_setBeforeRowPersist(undefined);
    expect(deps.publish).not.toHaveBeenCalled(); store.init('pin-app');
    expect(store.getOwnedSession(a.sessionId)?.modelPin).toEqual(pin);
    expect(store.getOwnedSession(b.sessionId)?.modelPin).toEqual(pin);
    expect(clearModelPins('pin-app', undefined, deps)).toHaveLength(2);
  });
  it('refuses the whole operation if a target is transferring/restarting before any write', () => {
    const a = create(), b = create();
    expect(() => clearModelPins('pin-app', undefined, { ...deps, findActive: id => id === b.sessionId ? {} as any : undefined,
      assertMutable() { throw new Error('busy'); } })).toThrow('busy');
    expect(store.getOwnedSession(a.sessionId)?.modelPin).toEqual(pin); expect(deps.publish).not.toHaveBeenCalled();
  });
});

it('aggregates every busy target and commits none before a later retry', () => {
  const a = create(), b = create(), c = create();
  const { busySessionIds, busySessions } = (() => {
    try { clearModelPins('pin-app', undefined, { ...deps, findActive: id => ({ session: { sessionId: id } }) as any,
      assertMutable(ds) {
        const id = ds.session.sessionId;
        if (id !== c.sessionId) throw new ModelPinBusyError([{ sessionId: id, reason: id === a.sessionId ? 'transferring' : 'restarting' }]);
      } }); } catch (error) { if (error instanceof ModelPinBusyError) return error; throw error; }
    throw new Error('expected a busy refusal');
  })();
  expect(busySessionIds.sort()).toEqual([a.sessionId,b.sessionId].sort()); expect(busySessions).toHaveLength(2);
  for (const s of [a,b,c]) expect(store.getOwnedSession(s.sessionId)?.modelPin).toEqual(pin);
  expect(deps.publish).not.toHaveBeenCalled(); expect(clearModelPins('pin-app', undefined, deps)).toHaveLength(3);
});
