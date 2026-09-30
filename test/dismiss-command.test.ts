/** Dismissal is confirmed, owner-scoped, and conditional on verified teardown. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { SessionGroupEntry } from '../src/services/session-groups-store.js';
import type { CloseSessionResult } from '../src/core/worker-pool.js';

const h = vi.hoisted(() => ({
  entry: undefined as SessionGroupEntry | undefined,
  rows: [] as Session[],
  peers: [] as Session[],
  close: vi.fn<(id: string) => Promise<CloseSessionResult>>(),
  disband: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
  inventory: vi.fn<() => Session[]>(),
  remove: vi.fn(),
}));
vi.mock('../src/services/session-groups-store.js', () => ({
  getSessionGroup: () => h.entry,
  removeSessionGroup: h.remove,
}));
vi.mock('../src/services/session-store.js', () => ({
  listSessionsStrict: () => h.rows,
  findActiveSessionsByChatStrict: h.inventory,
}));
vi.mock('../src/core/worker-pool.js', () => ({ closeSession: h.close }));
vi.mock('../src/services/groups-store.js', () => ({ disbandChat: h.disband }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { dismissSessionGroup } from '../src/core/dismiss-command.js';

const APP = 'cli_test';
const CHAT = 'oc_test';
const OWNER = 'ou_owner';
const active = new Map<string, DaemonSession>();
const request = { larkAppId: APP, chatId: CHAT, rootId: CHAT, senderId: OWNER, activeSessions: active };
/** Capture the actual confirmation, so tests also exercise the no-side-effect first step. */
async function confirmation(): Promise<string> {
  const result = await dismissSessionGroup(request);
  expect(result.status).toBe('confirm');
  if (result.status !== 'confirm') throw new Error('missing confirmation');
  return result.state;
}
beforeEach(() => {
  vi.clearAllMocks(); active.clear();
  h.entry = { ownerOpenId: OWNER, lastSessionId: 's1', createdAt: 1, lastActiveAt: 1 };
  h.rows = [{ sessionId: 's1', chatId: CHAT, rootMessageId: CHAT, scope: 'chat', status: 'active', createdAt: '2026-09-29T00:00:00Z', title: 'Test', larkAppId: APP }];
  h.peers = [];
  h.inventory.mockImplementation(() => [...h.rows.filter(s => s.status === 'active'), ...h.peers]);
  h.close.mockImplementation(async () => {
    h.rows[0].status = 'closed'; active.clear();
    return { ok: true, known: true, alreadyClosed: false, outcome: 'closed' };
  });
  h.disband.mockResolvedValue({ ok: true });
  h.remove.mockImplementation(() => { h.entry = undefined; });
});

describe('dismissSessionGroup', () => {
  it('first asks for confirmation without closing, disbanding or removing registration', async () => {
    await confirmation();
    expect(h.close).not.toHaveBeenCalled(); expect(h.disband).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('closes the exact session before deleting only its current group', async () => {
    const state = await confirmation();
    expect(await dismissSessionGroup({ ...request, confirmedState: state })).toEqual({ status: 'dismissed' });
    expect(h.close).toHaveBeenCalledWith('s1');
    expect(h.disband).toHaveBeenCalledWith(APP, CHAT);
    expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.disband.mock.invocationCallOrder[0]);
    expect(h.remove).toHaveBeenCalledWith(CHAT);
  });
  it('rejects another user before confirmation', async () => {
    expect((await dismissSessionGroup({ ...request, senderId: 'ou_other' })).status).toBe('owner_only');
    expect(h.close).not.toHaveBeenCalled();
  });
  it.each(['ordinary', 'topic', 'adopt', 'app-adopt', 'foreign-app', 'missing-row', 'wrong-chat'])('rejects unsafe scope: %s', async shape => {
    if (shape === 'ordinary') h.entry = undefined;
    if (shape === 'topic') h.rows[0].scope = 'thread';
    if (shape === 'adopt') h.rows[0].adoptedFrom = 'tmux:test';
    if (shape === 'app-adopt') h.rows[0].existingAppServerEndpoint = 'ws://localhost:1234';
    if (shape === 'foreign-app') h.rows[0].larkAppId = 'cli_other';
    if (shape === 'missing-row') h.rows = [];
    if (shape === 'wrong-chat') h.rows[0].chatId = 'oc_other';
    expect((await dismissSessionGroup(request)).status).toBe('unsupported');
    expect(h.close).not.toHaveBeenCalled(); expect(h.disband).not.toHaveBeenCalled();
  });
  it('rejects subtopic invocations even when a chat-scope session exists', async () => {
    expect((await dismissSessionGroup({ ...request, rootId: 'om_topic' })).status).toBe('unsupported');
  });
  it('invalidates confirmation after close/resume state changes', async () => {
    const state = await confirmation(); h.rows[0].status = 'closed';
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('confirm');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('blocks foreign bot sessions and topics in the same group', async () => {
    h.peers = [{ ...h.rows[0], sessionId: 's2', scope: 'thread', larkAppId: 'cli_other' }];
    expect((await dismissSessionGroup(request)).status).toBe('other_sessions');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('fails closed when the cross-bot inventory is unreadable', async () => {
    h.inventory.mockImplementation(() => { throw new Error('unreadable store'); });
    expect((await dismissSessionGroup(request)).status).toBe('unavailable');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'refused', 'throw', 'residual'])('never deletes after unverified close: %s', async failure => {
    const state = await confirmation();
    if (failure === 'unknown') h.close.mockResolvedValue({ ok: true, known: false, alreadyClosed: false, outcome: 'closed' });
    if (failure === 'refused') h.close.mockResolvedValue({ ok: false, alreadyClosed: false, error: 'riff_cancel_failed', retryable: true });
    if (failure === 'throw') h.close.mockRejectedValue(new Error('teardown failed'));
    if (failure === 'residual') h.close.mockResolvedValue({ ok: true, known: true, alreadyClosed: false, outcome: 'closed_with_residual', residual: { reason: 'local_subtree_boundary_unproven' } });
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).not.toBe('dismissed');
    expect(h.disband).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('rechecks peers after async teardown', async () => {
    const state = await confirmation();
    h.close.mockImplementation(async () => {
      h.rows[0].status = 'closed'; h.peers.push({ ...h.rows[0], sessionId: 's2', status: 'active' });
      return { ok: true, known: true, alreadyClosed: false, outcome: 'closed' };
    });
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('other_sessions');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('returns a surviving remote ID for the operator to inspect', async () => {
    const state = await confirmation();
    h.close.mockResolvedValue({ ok: true, known: true, alreadyClosed: false, outcome: 'closed_with_residual', residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-survivor' } });
    expect(await dismissSessionGroup({ ...request, confirmedState: state })).toEqual({ status: 'residual', detail: 'remote-survivor' });
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('preserves registry on deletion failure and retries from the already-closed row', async () => {
    const state = await confirmation(); h.disband.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('disband_failed');
    expect(h.rows[0].status).toBe('closed'); expect(h.remove).not.toHaveBeenCalled();
    const next = await confirmation();
    expect((await dismissSessionGroup({ ...request, confirmedState: next })).status).toBe('dismissed');
  });
  it('serializes duplicate confirmations so group deletion runs once', async () => {
    const state = await confirmation();
    const outcomes = await Promise.all([1, 2].map(() => dismissSessionGroup({ ...request, confirmedState: state })));
    expect(outcomes.filter(r => r.status === 'dismissed')).toHaveLength(1);
    expect(h.disband).toHaveBeenCalledTimes(1);
  });
  it('does not mistake another bot with the same session ID for the target', async () => {
    h.peers = [{ ...h.rows[0], larkAppId: 'cli_other' }];
    expect((await dismissSessionGroup(request)).status).toBe('other_sessions');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('rejects a live shared adopt even before its metadata reaches storage', async () => {
    active.set(CHAT, { larkAppId: APP, session: h.rows[0], chatId: CHAT, scope: 'chat', adoptedFrom: 'tmux:test' } as DaemonSession);
    expect((await dismissSessionGroup(request)).status).toBe('unsupported');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('invalidates confirmation when the live generation changes', async () => {
    const live = { larkAppId: APP, session: h.rows[0], chatId: CHAT, scope: 'chat', spawnedAt: 1 } as DaemonSession;
    active.set(CHAT, live);
    const state = await confirmation(); live.spawnedAt = 2;
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('confirm');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('preserves the group when registration changes during teardown', async () => {
    const state = await confirmation();
    h.close.mockImplementation(async () => {
      h.rows[0].status = 'closed'; h.entry!.lastSessionId = 'replacement';
      return { ok: true, known: true, alreadyClosed: false, outcome: 'closed' };
    });
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('changed');
    expect(h.disband).not.toHaveBeenCalled();
  });
});
