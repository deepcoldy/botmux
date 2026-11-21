/** Dismissal is confirmed, permission-checked, and conditional on verified teardown. */
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
  owns: vi.fn(async () => true),
  inventory: vi.fn<() => Session[]>(),
  remove: vi.fn(),
  online: vi.fn((app: string): { larkAppId: string; ipcPort: number } | null => ({ larkAppId: app, ipcPort: 4100 })),
  ipc: vi.fn(),
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
vi.mock('../src/services/groups-store.js', () => ({ disbandChat: h.disband, botProvablyOwnsChat: h.owns }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../src/utils/daemon-discovery.js', () => ({ findOnlineDaemon: h.online }));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({ fetchDaemonIpc: h.ipc }));
import { dismissSessionGroup } from '../src/core/dismiss-command.js';

const APP = 'cli_test';
const CHAT = 'oc_test';
const OWNER = 'ou_owner';
const active = new Map<string, DaemonSession>();
const request = { larkAppId: APP, chatId: CHAT, rootId: CHAT, senderId: OWNER, activeSessions: active };
/** Capture the actual confirmation, so tests also exercise the no-side-effect first step. */
async function confirmation(): Promise<string> {
  return (await confirmed()).state;
}
async function confirmed(): Promise<Extract<Awaited<ReturnType<typeof dismissSessionGroup>>, { status: 'confirm' }>> {
  const result = await dismissSessionGroup(request);
  expect(result.status).toBe('confirm');
  if (result.status !== 'confirm') throw new Error('missing confirmation');
  return result;
}
/** Peer daemon close response, as `/api/sessions/:id/close` serializes CloseSessionResult. */
const peerReply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
/** A co-resident session another local bot holds in the same group. */
const peer = (sessionId: string, larkAppId = 'cli_other'): Session =>
  ({ ...h.rows[0], sessionId, scope: 'thread', larkAppId, status: 'active' });
beforeEach(() => {
  vi.clearAllMocks(); active.clear();
  h.entry = { ownerOpenId: OWNER, lastSessionId: 's1', createdAt: 1, lastActiveAt: 1 };
  h.rows = [{ sessionId: 's1', chatId: CHAT, rootMessageId: CHAT, scope: 'chat', status: 'active', createdAt: '2026-09-29T00:00:00Z', title: 'Test', larkAppId: APP }];
  h.peers = [];
  h.inventory.mockImplementation(() => [...h.rows, ...h.peers].filter(s => s.status === 'active'));
  h.close.mockImplementation(async (id: string) => {
    const row = h.rows.find(r => r.sessionId === id); if (row) row.status = 'closed';
    for (const [key, ds] of active) if (ds.session.sessionId === id) active.delete(key);
    return { ok: true, known: true, alreadyClosed: false, outcome: 'closed' };
  });
  h.online.mockImplementation((app: string) => ({ larkAppId: app, ipcPort: 4100 }));
  h.ipc.mockImplementation(async (_port: number, path: string) => {
    const id = decodeURIComponent(path.split('/')[3]);
    const row = h.peers.find(p => p.sessionId === id); if (row) row.status = 'closed';
    return peerReply(200, { ok: true, outcome: 'closed', alreadyClosed: false, known: true });
  });
  h.disband.mockResolvedValue({ ok: true });
  h.owns.mockResolvedValue(true);
  h.remove.mockImplementation(() => { h.entry = undefined; });
});

describe('dismissSessionGroup', () => {
  it('first asks for confirmation without closing, disbanding or removing registration', async () => {
    await confirmation();
    expect(h.close).not.toHaveBeenCalled(); expect(h.disband).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('closes the exact session before deleting only its current group', async () => {
    const state = await confirmation();
    expect(await dismissSessionGroup({ ...request, confirmedState: state })).toEqual({ status: 'dismissed', workingDirs: [] });
    expect(h.close).toHaveBeenCalledWith('s1');
    expect(h.disband).toHaveBeenCalledWith(APP, CHAT);
    expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.disband.mock.invocationCallOrder[0]);
    expect(h.remove).toHaveBeenCalledWith(CHAT);
    // A session group keeps its own owner rule; the ordinary-group ownership probe never runs.
    expect(h.owns).not.toHaveBeenCalled();
  });
  it('rejects another user before confirmation', async () => {
    expect((await dismissSessionGroup({ ...request, senderId: 'ou_other' })).status).toBe('owner_only');
    expect(h.close).not.toHaveBeenCalled();
  });
  it.each(['topic', 'adopt', 'app-adopt', 'foreign-app', 'missing-row', 'wrong-chat'])('rejects unsafe scope: %s', async shape => {
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
  it('lists every local bot session in the group for confirmation, resident first', async () => {
    h.rows.push({ ...h.rows[0], sessionId: 's3', scope: 'thread', rootMessageId: 'om_topic' });
    h.peers = [peer('s2')];
    const { sessions } = await confirmed();
    expect(sessions.map(s => [s.larkAppId, s.session.sessionId, s.resident])).toEqual([
      [APP, 's1', true], [APP, 's3', false], ['cli_other', 's2', false],
    ]);
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled();
  });
  it('closes co-resident sessions of this and peer bots before the resident, then disbands', async () => {
    h.rows[0].workingDir = '/repo-wt-a';
    h.rows.push({ ...h.rows[0], sessionId: 's3', scope: 'thread', rootMessageId: 'om_topic' });
    h.peers = [{ ...peer('s2'), workingDir: '/repo-wt-b' }];
    const state = await confirmation();
    // Every closed session's working dir, once each, for the receipt's cleanup offer.
    expect(await dismissSessionGroup({ ...request, confirmedState: state }))
      .toEqual({ status: 'dismissed', workingDirs: ['/repo-wt-a', '/repo-wt-b'] });
    expect(h.close.mock.calls.map(c => c[0])).toEqual(['s3', 's1']);
    expect(h.ipc).toHaveBeenCalledWith(4100, '/api/sessions/s2/close', expect.objectContaining({ method: 'POST' }));
    expect(h.online).toHaveBeenCalledWith('cli_other');
    expect(h.ipc.mock.invocationCallOrder[0]).toBeLessThan(h.close.mock.invocationCallOrder[1]);
    expect(h.close.mock.invocationCallOrder[1]).toBeLessThan(h.disband.mock.invocationCallOrder[0]);
  });
  it('lists a group with only a closed resident as having nothing to close', async () => {
    h.rows[0].status = 'closed';
    expect((await confirmed()).sessions).toEqual([]);
  });
  it('refuses before confirmation when a peer bot is offline', async () => {
    h.peers = [peer('s2'), peer('s4', 'cli_third')];
    h.online.mockImplementation((app: string) => app === 'cli_third' ? null : { larkAppId: app, ipcPort: 4100 });
    expect(await dismissSessionGroup(request)).toEqual({ status: 'peer_offline', larkAppIds: ['cli_third'] });
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled();
  });
  it.each(['row', 'live'])('refuses a co-resident shared adopt it cannot end (%s)', async shape => {
    if (shape === 'row') h.peers = [{ ...peer('s2'), adoptedFrom: 'tmux:test' }];
    else active.set('om_topic', { larkAppId: APP, session: { ...h.rows[0], sessionId: 's5', scope: 'thread' }, chatId: CHAT, scope: 'thread', adoptedFrom: 'tmux:test' } as unknown as DaemonSession);
    expect((await dismissSessionGroup(request)).status).toBe('shared_adopt');
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled();
  });
  it.each([
    ['failed', peerReply(502, { ok: false, alreadyClosed: false, error: 'riff_cancel_failed' }), 'close_failed', 'riff_cancel_failed'],
    ['unknown', peerReply(200, { ok: true, outcome: 'closed', alreadyClosed: false, known: false }), 'close_failed', 'unknown'],
    ['residual', peerReply(200, { ok: true, outcome: 'closed_with_residual', residual: { reason: 'mojo_lineage_quarantined', taskId: 'peer-survivor' } }), 'residual', 'peer-survivor'],
  ])('keeps the resident and the group when a peer close is %s', async (_shape, reply, status, detail) => {
    h.peers = [peer('s2')];
    const state = await confirmation();
    h.ipc.mockResolvedValue(reply);
    const result = await dismissSessionGroup({ ...request, confirmedState: state, botName: app => `bot:${app}` });
    expect(result.status).toBe(status);
    expect('detail' in result && result.detail).toContain('bot:cli_other');
    expect('detail' in result && result.detail).toContain(detail);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.disband).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('treats a peer daemon that cannot be reached as an unverified close', async () => {
    h.peers = [peer('s2')];
    const state = await confirmation();
    h.ipc.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const result = await dismissSessionGroup({ ...request, confirmedState: state });
    expect(result.status).toBe('close_failed');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('re-confirms when a session appears after the card was shown', async () => {
    const state = await confirmation();
    h.peers = [peer('s2')];
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('confirm');
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled();
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
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('changed');
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
    const { sessions, state } = await confirmed();
    expect(sessions.map(s => [s.larkAppId, s.resident])).toEqual([[APP, true], ['cli_other', false]]);
    expect((await dismissSessionGroup({ ...request, confirmedState: state })).status).toBe('dismissed');
    expect(h.ipc).toHaveBeenCalledWith(4100, '/api/sessions/s1/close', expect.anything());
    expect(h.close).toHaveBeenCalledTimes(1);
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

describe('dismissSessionGroup in an ordinary group', () => {
  // No session-group registration; invoked from inside a topic, as a topic group always is.
  const group = { ...request, rootId: 'om_topic_1', chatType: 'group' };
  const topic = (sessionId: string, workingDir: string): Session =>
    ({ ...h.rows[0], sessionId, scope: 'thread', rootMessageId: `om_${sessionId}`, workingDir });
  async function groupConfirmed() {
    const result = await dismissSessionGroup(group);
    expect(result.status).toBe('confirm');
    if (result.status !== 'confirm') throw new Error('missing confirmation');
    return result;
  }
  beforeEach(() => {
    h.entry = undefined;
    h.rows = [topic('t1', '/repo-wt-a'), topic('t2', '/repo-wt-b')];
  });

  it('lists every local session in the group without touching anything first', async () => {
    h.peers = [peer('p1')];
    const result = await groupConfirmed();
    expect(result.ordinaryGroup).toBe(true);
    expect(result.sessions.map(s => [s.larkAppId, s.session.sessionId, s.resident])).toEqual([
      [APP, 't1', false], [APP, 't2', false], ['cli_other', 'p1', false],
    ]);
    expect(h.owns).toHaveBeenCalledWith(APP, CHAT);
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled(); expect(h.disband).not.toHaveBeenCalled();
  });
  it('closes every topic session, live or stored, then disbands the whole group', async () => {
    active.set('om_t3', { larkAppId: APP, session: topic('t3', '/repo-wt-a'), chatId: CHAT, scope: 'thread' } as DaemonSession);
    h.peers = [{ ...peer('p1'), workingDir: '/repo-wt-c' }];
    const { state } = await groupConfirmed();
    expect(await dismissSessionGroup({ ...group, confirmedState: state }))
      .toEqual({ status: 'dismissed', workingDirs: ['/repo-wt-a', '/repo-wt-b', '/repo-wt-c'], ordinaryGroup: true });
    expect(h.close.mock.calls.map(c => c[0])).toEqual(['t1', 't2', 't3']);
    expect(h.ipc).toHaveBeenCalledWith(4100, '/api/sessions/p1/close', expect.objectContaining({ method: 'POST' }));
    expect(h.disband).toHaveBeenCalledWith(APP, CHAT);
    const lastClose = Math.max(...h.close.mock.invocationCallOrder, ...h.ipc.mock.invocationCallOrder);
    expect(lastClose).toBeLessThan(h.disband.mock.invocationCallOrder[0]);
    // Nothing is registered for an ordinary group.
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('disbands a group with no session after confirmation', async () => {
    h.rows = [];
    const { state, sessions } = await groupConfirmed();
    expect(sessions).toEqual([]);
    expect((await dismissSessionGroup({ ...group, confirmedState: state })).status).toBe('dismissed');
    expect(h.disband).toHaveBeenCalledTimes(1);
  });
  it('closes nothing and shows no card when ownership cannot be proven', async () => {
    h.owns.mockResolvedValue(false);
    expect(await dismissSessionGroup(group)).toEqual({ status: 'no_permission' });
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled();
    expect(h.disband).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('re-checks ownership on confirmation and closes nothing once it is lost', async () => {
    h.peers = [peer('p1')];
    const { state } = await groupConfirmed();
    h.owns.mockResolvedValue(false);
    expect(await dismissSessionGroup({ ...group, confirmedState: state })).toEqual({ status: 'no_permission' });
    expect(h.close).not.toHaveBeenCalled(); expect(h.ipc).not.toHaveBeenCalled(); expect(h.disband).not.toHaveBeenCalled();
    expect(h.rows.every(r => r.status === 'active')).toBe(true);
  });
  it('treats a DM as unsupported without probing it', async () => {
    expect(await dismissSessionGroup({ ...group, chatType: 'p2p' })).toEqual({ status: 'unsupported' });
    expect(h.owns).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  });
  it('does not accept a session-group confirmation for the same chat', async () => {
    h.entry = { ownerOpenId: OWNER, lastSessionId: 't1', createdAt: 1, lastActiveAt: 1 };
    h.rows[0].scope = 'chat';
    const sessionGroupState = (await dismissSessionGroup(request));
    expect(sessionGroupState.status).toBe('confirm');
    h.entry = undefined;
    if (sessionGroupState.status !== 'confirm') return;
    expect((await dismissSessionGroup({ ...group, confirmedState: sessionGroupState.state })).status).toBe('confirm');
    expect(h.close).not.toHaveBeenCalled();
  });
  it.each(['row', 'live'])('refuses a shared adopt it cannot end (%s)', async shape => {
    if (shape === 'row') h.rows[1].adoptedFrom = 'tmux:test';
    else active.set('om_t3', { larkAppId: APP, session: topic('t3', '/x'), chatId: CHAT, scope: 'thread', adoptedFrom: 'tmux:test' } as unknown as DaemonSession);
    expect((await dismissSessionGroup(group)).status).toBe('shared_adopt');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('refuses before confirmation when a peer bot is offline', async () => {
    h.peers = [peer('p1', 'cli_third')];
    h.online.mockImplementation((app: string) => app === 'cli_third' ? null : { larkAppId: app, ipcPort: 4100 });
    expect(await dismissSessionGroup(group)).toEqual({ status: 'peer_offline', larkAppIds: ['cli_third'] });
    expect(h.close).not.toHaveBeenCalled();
  });
  it('re-confirms when a session appears after the card was shown', async () => {
    const { state } = await groupConfirmed();
    h.rows.push(topic('t9', '/x'));
    expect((await dismissSessionGroup({ ...group, confirmedState: state })).status).toBe('confirm');
    expect(h.close).not.toHaveBeenCalled();
  });
  it('keeps the group when a session cannot be closed safely', async () => {
    const { state } = await groupConfirmed();
    h.close.mockImplementation(async (id: string) => id === 't2'
      ? { ok: false, alreadyClosed: false, error: 'riff_cancel_failed', retryable: true }
      : { ok: true, known: true, alreadyClosed: false, outcome: 'closed' });
    const result = await dismissSessionGroup({ ...group, confirmedState: state });
    expect(result.status).toBe('close_failed');
    expect('detail' in result && result.detail).toContain('riff_cancel_failed');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('keeps the group when a residual remains', async () => {
    const { state } = await groupConfirmed();
    h.close.mockResolvedValue({ ok: true, known: true, alreadyClosed: false, outcome: 'closed_with_residual', residual: { reason: 'mojo_lineage_quarantined', taskId: 'survivor' } });
    expect((await dismissSessionGroup({ ...group, confirmedState: state })).status).toBe('residual');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('keeps the group when a new session appears during teardown', async () => {
    const { state } = await groupConfirmed();
    const close = h.close.getMockImplementation()!;
    h.close.mockImplementation(async (id: string) => {
      if (id === 't2') h.peers.push(peer('p9'));
      return close(id);
    });
    expect((await dismissSessionGroup({ ...group, confirmedState: state })).status).toBe('changed');
    expect(h.disband).not.toHaveBeenCalled();
  });
  it('reports a refused disband after the sessions are closed', async () => {
    const { state } = await groupConfirmed();
    h.disband.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect((await dismissSessionGroup({ ...group, confirmedState: state })).status).toBe('disband_failed');
    expect(h.rows.every(r => r.status === 'closed')).toBe(true);
  });
  it('serializes duplicate confirmations so the group is disbanded once', async () => {
    const { state } = await groupConfirmed();
    const outcomes = await Promise.all([1, 2].map(() => dismissSessionGroup({ ...group, confirmedState: state })));
    expect(outcomes.filter(r => r.status === 'dismissed')).toHaveLength(1);
    expect(h.disband).toHaveBeenCalledTimes(1);
  });
});
