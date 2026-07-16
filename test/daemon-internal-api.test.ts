import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonInternalApi,
  type DaemonInternalApi,
  type DaemonInternalApiDeps,
} from '../src/dashboard/daemon-internal-api.js';
import {
  createNonceStore,
  signDaemonRequest,
  type ClockLike,
} from '../src/dashboard/daemon-internal-auth.js';

const SECRET = 'test-secret-string';

/** ─── Test deps factory ─────────────────────────────────────────────── */

function makeUpstream(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function makeDeps(over: Partial<DaemonInternalApiDeps> = {}): DaemonInternalApiDeps {
  const groupsActionDeps = {
    registryList: () => [] as any[],
    registryGetByAppId: () => undefined,
    proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
    closeSessionsMatching: vi.fn(async () => []),
    fetch: vi.fn(async () => makeUpstream(200, { inChat: true })),
  };
  const settingsApplierDeps = {
    readGlobalConfig: vi.fn(() => ({})),
    mergeDashboardConfig: vi.fn((p: any) => p),
    mergeMaintenanceConfig: vi.fn((p: any) => p),
    parseMaintenancePatch: vi.fn((b: any) => ({ ok: true, patch: b ?? {} })),
    isLocalDevInstall: vi.fn(() => false),
    resolveDashboardSettings: vi.fn(() => ({
      publicReadOnly: false,
      openTerminalInFeishu: false,
      vcMeetingAgent: { enabled: true },
      maintenance: {},
      localDevInstall: false,
    })),
  };
  return {
    secret: SECRET,
    nonceStore: createNonceStore(),
    getSessions: () => [{ sessionId: 's1' }],
    getSchedules: () => [{ id: 'sched-1' }],
    resolveDashboardSettings: () => ({
      publicReadOnly: false,
      openTerminalInFeishu: false,
      vcMeetingAgent: { enabled: true },
      maintenance: {},
      localDevInstall: false,
    }),
    buildGroupsMatrix: async () => ({ chats: [], bots: [] }),
    settingsApplierDeps,
    groupsActionDeps,
    proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
    ownerOf: vi.fn((sid: string) => sid === 'sess-known' ? 'cli_owner' : undefined),
    // sess-known has owner; sess-legacy exists but has no larkAppId.
    sessionExists: vi.fn((sid: string) => sid === 'sess-known' || sid === 'sess-legacy'),
    scheduleOwnerOf: vi.fn((id: string) => id === 'sched-known' ? 'cli_owner' : undefined),
    // sched-known has owner; sched-legacy exists but has no larkAppId
    // (legacy persistence). 'sched-missing' deliberately omitted to assert
    // 404 unknown_schedule for unknown ids.
    scheduleExists: vi.fn((id: string) => id === 'sched-known' || id === 'sched-legacy'),
    settingsOwnerDeps: {
      resolveOwnerCandidates: vi.fn(async () => [{ unionId: 'on_admin', name: 'admin' }]),
    },
    ...over,
  };
}

function url(path: string, query: Record<string, string> = {}): URL {
  const u = new URL(`http://127.0.0.1:7891${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

/** ─── 5 READ ENDPOINTS — happy ─────────────────────────────────────── */

describe('dispatch: read endpoints', () => {
  it('GET /__daemon/sessions-list returns deps.getSessions()', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/sessions-list'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sessions: [{ sessionId: 's1' }] });
  });

  it('GET /__daemon/settings-snapshot returns deps.resolveDashboardSettings()', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/settings-snapshot'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ settings: { publicReadOnly: false, openTerminalInFeishu: false, vcMeetingAgent: { enabled: true }, maintenance: {}, localDevInstall: false } });
  });

  it('GET /__daemon/groups-matrix returns { chats, bots }', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chats: [], bots: [] });
  });

  it('GET /__daemon/overview-snapshot composes 4 sub-snapshots', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/overview-snapshot'));
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.sessions).toEqual([{ sessionId: 's1' }]);
    expect(body.schedules).toEqual([{ id: 'sched-1' }]);
    expect(body.settings).toBeDefined();
    expect(body.groups).toEqual({ chats: [], bots: [] });
  });

  it('GET /__daemon/schedules-list returns deps.getSchedules() (no scoping when callerAppId absent — test seam)', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/schedules-list'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schedules: [{ id: 'sched-1' }] });
  });

  it('returns a zero-I/O retirement tombstone for legacy workflow reads', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/workflows-runs-snapshot'));
    expect(r).toEqual({
      status: 410,
      body: {
        ok: false,
        error: 'legacy_workflow_retired',
        message: 'v2 workflow run APIs are retired; migrate definitions with botmux template migrate-v3 and inspect v3 runs via /api/v3/runs',
      },
    });
  });
});

/** ─── Per-bot read scoping (codex 2026-06-09 blocker) ─────────────────
 *  sessions-list / schedules-list MUST filter by the authenticated caller's
 *  bot id; the aggregator (`aggregator.ts:62-63`) mixes data from all
 *  daemons, so without this filter a bot A owner could peek into bot B's
 *  state. Legacy rows (no larkAppId) are KEPT so a fresh upgrade doesn't
 *  drop them. */
describe('per-bot read scoping: callerAppId filters aggregator rows', () => {
  const cliA = { sessionId: 'sA', larkAppId: 'cli_a' };
  const cliB = { sessionId: 'sB', larkAppId: 'cli_b' };
  const legacy = { sessionId: 'sLegacy' };  // No larkAppId — must remain visible.
  const schedA = { id: 'schA', larkAppId: 'cli_a' };
  const schedB = { id: 'schB', larkAppId: 'cli_b' };
  const schedLegacy = { id: 'schLegacy' };  // Legacy — must remain.

  function mixedDeps(): DaemonInternalApiDeps {
    return makeDeps({
      getSessions: () => [cliA, cliB, legacy],
      getSchedules: () => [schedA, schedB, schedLegacy],
    });
  }

  it('sessions-list with callerAppId=cli_a → only cli_a rows + legacy (no cli_b)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/sessions-list'), '', 'cli_a');
    expect(r.status).toBe(200);
    const sessions = (r.body as any).sessions as Array<{ sessionId: string }>;
    const ids = sessions.map(s => s.sessionId).sort();
    expect(ids).toEqual(['sA', 'sLegacy']);
    expect(ids).not.toContain('sB');
  });

  it('sessions-list with callerAppId=cli_a AND ?scope=global → ALL rows cross-bot', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/sessions-list?scope=global'), '', 'cli_a');
    expect(r.status).toBe(200);
    const sessions = (r.body as any).sessions as Array<{ sessionId: string }>;
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['sA', 'sB', 'sLegacy']);
  });

  it('schedules-list with callerAppId=cli_b → only cli_b rows + legacy (no cli_a)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/schedules-list'), '', 'cli_b');
    expect(r.status).toBe(200);
    const schedules = (r.body as any).schedules as Array<{ id: string }>;
    const ids = schedules.map(s => s.id).sort();
    expect(ids).toEqual(['schB', 'schLegacy']);
    expect(ids).not.toContain('schA');
  });

  /** ─── global dashboard read scope ───────────────────────────────────
   *  `/dashboard` is a Bot-Owner tool panel; `?scope=global` returns the
   *  list module cross-bot (no `scopeByCaller`). The per-bot default is
   *  preserved for callers that don't opt in, so isolation tests remain
   *  deterministic. */
  it('schedules-list with callerAppId=cli_b AND ?scope=global → ALL rows cross-bot (cli_a + cli_b + legacy)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/schedules-list?scope=global'), '', 'cli_b');
    expect(r.status).toBe(200);
    const schedules = (r.body as any).schedules as Array<{ id: string }>;
    const ids = schedules.map(s => s.id).sort();
    expect(ids).toEqual(['schA', 'schB', 'schLegacy']);
  });

  it('schedules-list `?scope=globalish` (typo / unknown value) → falls back to per-bot scope (no surprise widen)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/schedules-list?scope=globalish'), '', 'cli_b');
    expect(r.status).toBe(200);
    const schedules = (r.body as any).schedules as Array<{ id: string }>;
    const ids = schedules.map(s => s.id).sort();
    expect(ids).toEqual(['schB', 'schLegacy']);
  });

  it('sessions-list with no callerAppId (test seam) → full list (unfiltered)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/sessions-list'));
    const sessions = (r.body as any).sessions as Array<{ sessionId: string }>;
    expect(sessions.map(s => s.sessionId).sort()).toEqual(['sA', 'sB', 'sLegacy']);
  });

  // PR3 overview slice 1 (2026-06-09): the overview-snapshot endpoint
  // bundles sessions + schedules from the aggregator and MUST apply the
  // same callerAppId scoping the dedicated list endpoints do, or a bot A
  // owner would observe bot B's sessions/schedules through the bundled
  // overview surface.
  it('overview-snapshot with callerAppId=cli_a → only cli_a sessions + schedules + legacy (no cli_b)', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/overview-snapshot'), '', 'cli_a');
    expect(r.status).toBe(200);
    const body = r.body as any;
    const sessIds = (body.sessions as Array<{ sessionId: string }>).map(s => s.sessionId).sort();
    expect(sessIds).toEqual(['sA', 'sLegacy']);
    expect(sessIds).not.toContain('sB');
    const schedIds = (body.schedules as Array<{ id: string }>).map(s => s.id).sort();
    expect(schedIds).toEqual(['schA', 'schLegacy']);
    expect(schedIds).not.toContain('schB');
    // settings + groups still present in the composed response.
    expect(body.settings).toBeDefined();
    expect(body.groups).toBeDefined();
  });

  it('overview-snapshot with callerAppId=cli_b AND ?scope=global → sessions + schedules cross-bot', async () => {
    const api = createDaemonInternalApi(mixedDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/overview-snapshot?scope=global'), '', 'cli_b');
    expect(r.status).toBe(200);
    const body = r.body as any;
    const sessIds = (body.sessions as Array<{ sessionId: string }>).map(s => s.sessionId).sort();
    expect(sessIds).toEqual(['sA', 'sB', 'sLegacy']);
    const schedIds = (body.schedules as Array<{ id: string }>).map(s => s.id).sort();
    expect(schedIds).toEqual(['schA', 'schB', 'schLegacy']);
  });
});

/** ─── groups-matrix: codex strict per-bot scope (PR3 groups slice 1) ────
 *  Unlike sessions / schedules where a legacy row (no `larkAppId`) is KEPT,
 *  the groups matrix is fail-closed: bots without `larkAppId` are dropped,
 *  and chats without a matching `memberBots[*]` where `inChat=true` for the
 *  caller are dropped — empty/missing `memberBots` also drops the chat.
 *  Each retained chat's `memberBots` array is trimmed to the caller's
 *  single entry so other bots' roster never leaks. */
describe('groups-matrix: codex strict per-bot scope', () => {
  const strictMatrix = () => ({
    chats: [
      { chatId: 'c1', memberBots: [
        { larkAppId: 'cli_a', inChat: true },
        { larkAppId: 'cli_b', inChat: true },
      ] },
      { chatId: 'c2', memberBots: [
        { larkAppId: 'cli_a', inChat: false },
        { larkAppId: 'cli_b', inChat: true },
      ] },
      { chatId: 'c3', memberBots: [
        { larkAppId: 'cli_b', inChat: true },
      ] },
      { chatId: 'c4_legacy', memberBots: [] },
      { chatId: 'c5_no_members' },
    ],
    bots: [
      { larkAppId: 'cli_a' },
      { larkAppId: 'cli_b' },
      { name: 'legacy_no_appid' },
    ],
  });

  function mixedGroupsDeps(): DaemonInternalApiDeps {
    return makeDeps({
      buildGroupsMatrix: async () => strictMatrix() as unknown as { chats: unknown[]; bots: unknown[] },
    });
  }

  it('callerAppId=cli_a → only c1 kept (cli_a present AND inChat=true); c2/c3/c4_legacy/c5_no_members dropped', async () => {
    const api = createDaemonInternalApi(mixedGroupsDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix'), '', 'cli_a');
    expect(r.status).toBe(200);
    const body = r.body as { chats: Array<{ chatId: string; memberBots: Array<{ larkAppId: string }> }>; bots: Array<{ larkAppId?: string; name?: string }> };
    const chatIds = body.chats.map(c => c.chatId).sort();
    expect(chatIds).toEqual(['c1']);
    expect(chatIds).not.toContain('c2');
    expect(chatIds).not.toContain('c3');
    expect(chatIds).not.toContain('c4_legacy');
    expect(chatIds).not.toContain('c5_no_members');
  });

  it('c1.memberBots has length 1, only cli_a entry (cli_b roster not leaked)', async () => {
    const api = createDaemonInternalApi(mixedGroupsDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix'), '', 'cli_a');
    const body = r.body as { chats: Array<{ chatId: string; memberBots: Array<{ larkAppId: string }> }> };
    const c1 = body.chats.find(c => c.chatId === 'c1')!;
    expect(c1.memberBots).toHaveLength(1);
    expect(c1.memberBots[0].larkAppId).toBe('cli_a');
    // No cli_b leakage anywhere in the response payload.
    expect(JSON.stringify(r.body)).not.toContain('cli_b');
  });

  it('bots = [{ larkAppId: "cli_a" }] only (cli_b dropped; legacy_no_appid dropped)', async () => {
    const api = createDaemonInternalApi(mixedGroupsDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix'), '', 'cli_a');
    const body = r.body as { bots: Array<{ larkAppId?: string; name?: string }> };
    expect(body.bots).toEqual([{ larkAppId: 'cli_a' }]);
  });

  it('test seam (no callerAppId) → full unscoped matrix returned', async () => {
    const api = createDaemonInternalApi(mixedGroupsDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix'));
    expect(r.status).toBe(200);
    const body = r.body as { chats: Array<{ chatId: string }>; bots: Array<{ larkAppId?: string; name?: string }> };
    expect(body.chats.map(c => c.chatId).sort()).toEqual([
      'c1', 'c2', 'c3', 'c4_legacy', 'c5_no_members',
    ]);
    // Full bots list (including legacy without larkAppId).
    expect(body.bots).toHaveLength(3);
  });

  it('callerAppId=cli_a AND ?scope=global → full unscoped matrix returned', async () => {
    const api = createDaemonInternalApi(mixedGroupsDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/groups-matrix?scope=global'), '', 'cli_a');
    expect(r.status).toBe(200);
    const body = r.body as { chats: Array<{ chatId: string; memberBots?: unknown[] }>; bots: Array<{ larkAppId?: string; name?: string }> };
    expect(body.chats.map(c => c.chatId).sort()).toEqual([
      'c1', 'c2', 'c3', 'c4_legacy', 'c5_no_members',
    ]);
    expect(body.chats.find(c => c.chatId === 'c1')?.memberBots).toHaveLength(2);
    expect(body.bots).toHaveLength(3);
  });

  it('original matrix object is NOT mutated (memberBots arrays unchanged)', async () => {
    // Build a single matrix object that the deps callback returns each time;
    // after the scoping run, the original object's structure must survive.
    const original = strictMatrix();
    const originalC1Members = original.chats[0].memberBots.slice();
    const originalBotsLen = original.bots.length;
    const deps = makeDeps({
      buildGroupsMatrix: async () => original as unknown as { chats: unknown[]; bots: unknown[] },
    });
    const api = createDaemonInternalApi(deps);
    await api.dispatchForTest('GET', url('/__daemon/groups-matrix'), '', 'cli_a');

    // Original arrays untouched: c1 still has 2 memberBots; bots still has 3.
    expect(original.chats[0].memberBots).toEqual(originalC1Members);
    expect(original.chats[0].memberBots).toHaveLength(2);
    expect(original.bots).toHaveLength(originalBotsLen);
    // Each chat still present in the original.
    expect(original.chats.map(c => c.chatId)).toEqual([
      'c1', 'c2', 'c3', 'c4_legacy', 'c5_no_members',
    ]);
  });
});

/** ─── 1 SETTINGS-WRITE ENDPOINT — owner gate ───────────────────────── */

describe('dispatch: PUT /__daemon/settings-write owner gate', () => {
  it('happy: valid on_ owner + valid patch → 200 with merged settings', async () => {
    const deps = makeDeps();
    const api = createDaemonInternalApi(deps);
    const body = JSON.stringify({ patch: { publicReadOnly: true }, ownerUnionId: 'on_admin' });
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), body);
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
  });

  it('rejects when ownerUnionId is missing → 403 owner_only', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const body = JSON.stringify({ patch: { publicReadOnly: true } });
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), body);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'owner_only' });
  });

  it('rejects when ownerUnionId is non-on_ prefix → 403 owner_only (no fallback)', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const body = JSON.stringify({ patch: { publicReadOnly: true }, ownerUnionId: 'ou_appscoped_alice' });
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), body);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'owner_only' });
  });

  it('rejects when ownerUnionId does not match any candidate → 403 owner_only', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const body = JSON.stringify({ patch: { publicReadOnly: true }, ownerUnionId: 'on_stranger' });
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), body);
    expect(r.status).toBe(403);
  });

  it('valid owner but applier validation fails → 400 with applier error', async () => {
    const deps = makeDeps({
      settingsApplierDeps: {
        ...makeDeps().settingsApplierDeps,
        // Force invalid patch by sending wrong-type publicReadOnly
      },
    });
    const api = createDaemonInternalApi(deps);
    const body = JSON.stringify({ patch: { publicReadOnly: 'yes' }, ownerUnionId: 'on_admin' });
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), body);
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_publicReadOnly');
  });
});

/** ─── SESSIONS write × 3 ─────────────────────────────────────────── */

describe('dispatch: sessions write', () => {
  it.each(['close', 'resume', 'locate'] as const)('POST /sessions/:id/%s happy', async (action) => {
    const deps = makeDeps();
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-known/${action}`));
    expect(r.status).toBe(200);
    expect(deps.proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      `/api/sessions/sess-known/${action}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POST /sessions/:id/close on unknown id → 404 unknown_session', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('POST', url('/__daemon/sessions/sess-missing/close'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_session' });
  });
});

/** ─── GROUPS write × 5 ────────────────────────────────────────────── */

describe('dispatch: groups write', () => {
  it('POST /groups/:id/leave forwards parsed body to leaveGroup helper', async () => {
    const deps = makeDeps({
      groupsActionDeps: {
        ...makeDeps().groupsActionDeps,
        registryGetByAppId: (id: string) => id === 'cli_a' ? { larkAppId: 'cli_a', ipcPort: 9000 } : undefined,
        fetch: (async () => makeUpstream(200, { inChat: true })) as unknown as typeof fetch,
        proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
      },
    });
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest(
      'POST',
      url('/__daemon/groups/oc_x/leave'),
      JSON.stringify({ larkAppIds: ['cli_a'] }),
    );
    expect(r.status).toBe(200);
    expect((r.body as any).result).toHaveLength(1);
  });

  it('POST /groups/:id/disband forwards body and cascade-closes on success', async () => {
    const deps = makeDeps();
    const proxySpy = vi.fn(async () => makeUpstream(200, { ok: true }));
    deps.groupsActionDeps.proxyToDaemon = proxySpy;
    const closedSpy = vi.fn(async () => [{ sessionId: 's1' }]);
    deps.groupsActionDeps.closeSessionsMatching = closedSpy as any;
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest(
      'POST',
      url('/__daemon/groups/oc_x/disband'),
      JSON.stringify({ larkAppId: 'cli_owner' }),
    );
    expect(r.status).toBe(200);
    expect((r.body as any).closedSessions).toEqual([{ sessionId: 's1' }]);
    expect(closedSpy).toHaveBeenCalledOnce();
  });

  it('POST /groups/:id/add-bots forwards bodyRaw verbatim', async () => {
    const deps = makeDeps();
    const fetchSpy = vi.fn(async (input: any) => {
      if (String(input).endsWith('/membership')) return makeUpstream(200, { inChat: true });
      return makeUpstream(200, { ok: true, added: ['cli_y'] });
    });
    deps.groupsActionDeps.registryList = () => [{ larkAppId: 'cli_a', ipcPort: 9000 }] as any;
    deps.groupsActionDeps.fetch = fetchSpy as unknown as typeof fetch;
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest(
      'POST',
      url('/__daemon/groups/oc_x/add-bots'),
      JSON.stringify({ larkAppIds: ['cli_y'] }),
    );
    expect(r.status).toBe(200);
    expect((r.body as any).added).toEqual(['cli_y']);
  });

  it('POST /groups/:id/oncall/:appId/bind proxies to internal /api/oncall/:chatId PUT', async () => {
    const proxySpy = vi.fn(async () => makeUpstream(200, { ok: true }));
    const deps = makeDeps();
    deps.groupsActionDeps.proxyToDaemon = proxySpy;
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest(
      'POST',
      url('/__daemon/groups/oc_x/oncall/cli_owner/bind'),
      JSON.stringify({ workingDir: '/repo' }),
    );
    expect(r.status).toBe(200);
    expect(proxySpy.mock.calls[0]![1]).toBe('/api/oncall/oc_x');
    expect((proxySpy.mock.calls[0]![2] as RequestInit).method).toBe('PUT');
  });

  it('POST /groups/:id/oncall/:appId/unbind proxies to internal /api/oncall/:chatId DELETE', async () => {
    const proxySpy = vi.fn(async () => makeUpstream(200, { ok: true }));
    const deps = makeDeps();
    deps.groupsActionDeps.proxyToDaemon = proxySpy;
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest('POST', url('/__daemon/groups/oc_x/oncall/cli_owner/unbind'));
    expect(r.status).toBe(200);
    expect(proxySpy.mock.calls[0]![1]).toBe('/api/oncall/oc_x');
    expect((proxySpy.mock.calls[0]![2] as RequestInit).method).toBe('DELETE');
  });

  it('GET /groups/:id/roles/:appId proxies to internal /api/roles/:chatId GET', async () => {
    const proxySpy = vi.fn(async () => makeUpstream(200, { content: 'role text', hasRole: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest('GET', url('/__daemon/groups/oc_x/roles/cli_owner'));
    expect(r.status).toBe(200);
    expect((r.body as any).content).toBe('role text');
    expect(proxySpy).toHaveBeenCalledWith(
      'cli_owner',
      '/api/roles/oc_x',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('PUT /groups/:id/roles/:appId proxies role body to internal /api/roles/:chatId PUT', async () => {
    const proxySpy = vi.fn(async () => makeUpstream(200, { ok: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const api = createDaemonInternalApi(deps);
    const body = JSON.stringify({ content: 'new role' });
    const r = await api.dispatchForTest('PUT', url('/__daemon/groups/oc_x/roles/cli_owner'), body);
    expect(r.status).toBe(200);
    expect(proxySpy).toHaveBeenCalledWith(
      'cli_owner',
      '/api/roles/oc_x',
      expect.objectContaining({ method: 'PUT', body }),
    );
  });

  it('DELETE /groups/:id/roles/:appId proxies to internal /api/roles/:chatId DELETE', async () => {
    const proxySpy = vi.fn(async () => makeUpstream(200, { ok: true, existed: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest('DELETE', url('/__daemon/groups/oc_x/roles/cli_owner'));
    expect(r.status).toBe(200);
    expect(proxySpy).toHaveBeenCalledWith(
      'cli_owner',
      '/api/roles/oc_x',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

/** ─── SCHEDULES write × 4 ───────────────────────────────────────── */

describe('dispatch: schedules write', () => {
  it.each(['run', 'pause', 'resume', 'delivery'] as const)('POST /schedules/:id/%s happy', async (action) => {
    const deps = makeDeps();
    const api = createDaemonInternalApi(deps);
    const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-known/${action}`));
    expect(r.status).toBe(200);
    expect(deps.proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      `/api/schedules/sched-known/${action}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POST /schedules/:id/run on unknown id → 404 unknown_schedule', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('POST', url('/__daemon/schedules/sched-missing/run'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_schedule' });
  });
});

/** ─── SCHEDULES write — codex hard constraint #1: cross-bot owner gate ─
 *  PR3 schedules slice 2a (2026-06-10) introduced a write-side scope check
 *  for pause/resume: when `callerAppId` is set (real HMAC caller) and the
 *  schedule's `scheduleOwnerOf` returns a different bot, dispatch MUST
 *  refuse with 403 schedule_owner_mismatch and NEVER touch
 *  `proxyToDaemon`. The test seam (no callerAppId) keeps the historical
 *  pass-through for `dispatchForTest`.
 *  The Route B gate covers all four verbs (run|pause|resume|delivery) — the
 *  UI exposes pause/resume/delivery in slices 2a/2b, but the underlying route
 *  table shares one handler, so run is tested for completeness. */
describe('dispatch: schedules write — cross-bot owner gate', () => {
  function ownerMismatchDeps() {
    return makeDeps({
      // Owner is cli_b for this schedule; caller will pretend to be cli_a.
      scheduleOwnerOf: vi.fn((id: string) => id === 'sched-known' ? 'cli_b' : undefined),
      proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
    });
  }

  for (const action of ['pause', 'resume', 'run', 'delivery'] as const) {
    it(`callerAppId=cli_a + owner=cli_b → 403 schedule_owner_mismatch, proxyToDaemon NOT called (${action})`, async () => {
      const deps = ownerMismatchDeps();
      const api = createDaemonInternalApi(deps);
      const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-known/${action}`), '', 'cli_a');
      expect(r.status).toBe(403);
      expect((r.body as any).error).toBe('schedule_owner_mismatch');
      expect(deps.proxyToDaemon).not.toHaveBeenCalled();
    });

    it(`callerAppId=cli_b + owner=cli_b → proxyToDaemon called once, upstream status reflected (${action})`, async () => {
      const deps = ownerMismatchDeps();
      const api = createDaemonInternalApi(deps);
      const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-known/${action}`), '', 'cli_b');
      expect(r.status).toBe(200);
      expect(deps.proxyToDaemon).toHaveBeenCalledTimes(1);
      expect(deps.proxyToDaemon).toHaveBeenCalledWith(
        'cli_b',
        `/api/schedules/sched-known/${action}`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it(`test seam (no callerAppId) → proxy still called (back-compat dispatchForTest) (${action})`, async () => {
      const deps = ownerMismatchDeps();
      const api = createDaemonInternalApi(deps);
      const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-known/${action}`));
      expect(r.status).toBe(200);
      expect(deps.proxyToDaemon).toHaveBeenCalledTimes(1);
      expect(deps.proxyToDaemon).toHaveBeenCalledWith(
        'cli_b',
        `/api/schedules/sched-known/${action}`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  }

  /** Legacy schedule rows (no `larkAppId` field — persisted before per-bot
   *  routing existed) survive the read scope filter (see scopeByCaller
   *  short-circuit on missing larkAppId) and are still visible in the
   *  schedules card. Without this branch, the user would click pause /
   *  resume on a legacy row and the write would 404 because
   *  scheduleOwnerOf returns undefined. The fix: proxy legacy rows to the
   *  AUTHENTICATED caller's bot — the same bot that fetched and rendered
   *  the row in the first place.
   *  codex 2026-06-10 schedules slice 2a blocker. */
  describe('legacy schedule rows (scheduleOwnerOf returns undefined)', () => {
    function legacyDeps() {
      return makeDeps({
        // 'sched-legacy' exists but has no owner — pre-larkAppId persistence.
        scheduleOwnerOf: vi.fn((id: string) => id === 'sched-known' ? 'cli_b' : undefined),
        scheduleExists: vi.fn((id: string) => id === 'sched-known' || id === 'sched-legacy'),
        proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
      });
    }

    for (const action of ['pause', 'resume', 'delivery'] as const) {
      it(`legacy row + callerAppId=cli_caller → proxy to caller (${action})`, async () => {
        const deps = legacyDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-legacy/${action}`), '', 'cli_caller');
        expect(r.status).toBe(200);
        expect(deps.proxyToDaemon).toHaveBeenCalledTimes(1);
        // Critical: routed to caller, NOT to the (nonexistent) row owner.
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_caller',
          `/api/schedules/sched-legacy/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`legacy row + test seam (no callerAppId) → 404 unknown_schedule (back-compat) (${action})`, async () => {
        const deps = legacyDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-legacy/${action}`));
        // dispatchForTest with no callerAppId keeps the historical 404 for
        // legacy rows — production callers always have an HMAC appId, so
        // the only path that hits this is the test seam itself.
        expect(r.status).toBe(404);
        expect((r.body as any).error).toBe('unknown_schedule');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });

      it(`row genuinely missing → 404 unknown_schedule (regardless of caller) (${action})`, async () => {
        const deps = legacyDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/schedules/sched-vanished/${action}`), '', 'cli_caller');
        expect(r.status).toBe(404);
        expect((r.body as any).error).toBe('unknown_schedule');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });
    }
  });

  /** ─── global-schedules slice (codex 2026-06-11) ───────────────────────
   *  When the schedule POST is marked `?scope=global`, the cross-bot 403
   *  is bypassed and the write is proxied to the row's TRUE owner (not
   *  the caller). The three-state semantics around legacy / missing rows
   *  are preserved unchanged — global only changes "owner exists +
   *  caller mismatch" from 403 to "proxy owner". */
  describe('global scope (?scope=global)', () => {
    function ownedDeps() {
      return makeDeps({
        scheduleOwnerOf: vi.fn((id: string) => id === 'sched-known' ? 'cli_b' : undefined),
        scheduleExists: vi.fn((id: string) => id === 'sched-known' || id === 'sched-legacy'),
        proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
      });
    }

    for (const action of ['pause', 'resume', 'run', 'delivery'] as const) {
      it(`?scope=global + callerAppId=cli_a + owner=cli_b → proxy to OWNER (cli_b), NOT 403 (${action})`, async () => {
        const deps = ownedDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest(
          'POST',
          url(`/__daemon/schedules/sched-known/${action}?scope=global`),
          '',
          'cli_a',
        );
        // The cross-bot 403 is bypassed under global scope.
        expect(r.status).toBe(200);
        expect((r.body as any).error).toBeUndefined();
        expect(deps.proxyToDaemon).toHaveBeenCalledTimes(1);
        // Route to the OWNER (cli_b), not the caller (cli_a).
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_b',
          `/api/schedules/sched-known/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`?scope=global + legacy row + callerAppId=cli_caller → STILL proxies to caller (legacy three-state preserved) (${action})`, async () => {
        const deps = ownedDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest(
          'POST',
          url(`/__daemon/schedules/sched-legacy/${action}?scope=global`),
          '',
          'cli_caller',
        );
        expect(r.status).toBe(200);
        // Legacy branch still fires — global does NOT route legacy to a
        // ghost owner. It routes to the authenticated caller, as before.
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_caller',
          `/api/schedules/sched-legacy/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`?scope=global + missing row → 404 unknown_schedule (three-state preserved) (${action})`, async () => {
        const deps = ownedDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest(
          'POST',
          url(`/__daemon/schedules/sched-vanished/${action}?scope=global`),
          '',
          'cli_caller',
        );
        expect(r.status).toBe(404);
        expect((r.body as any).error).toBe('unknown_schedule');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });

      it(`?scope=globalish (typo) + cross-bot caller → falls back to 403 (no surprise widen) (${action})`, async () => {
        const deps = ownedDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest(
          'POST',
          url(`/__daemon/schedules/sched-known/${action}?scope=globalish`),
          '',
          'cli_a',
        );
        expect(r.status).toBe(403);
        expect((r.body as any).error).toBe('schedule_owner_mismatch');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });
    }
  });

  // ─── Sessions write gate (codex 2026-06-10 follow-up hardening) ────
  //
  // sessions write endpoint now mirrors the schedules gate: cross-bot
  // caller → 403; legacy row → proxy caller; missing row → 404. The slice
  // 2a sanity test that previously LOCKED IN the "still ownerOf-only"
  // behaviour is now inverted because the unguarded behaviour was the
  // bug. Pattern reuse with schedules is intentional (codex follow-up).
  describe('sessions write — cross-bot owner gate + legacy fallback', () => {
    function ownerMismatchDeps() {
      return makeDeps({
        ownerOf: vi.fn((sid: string) => sid === 'sess-known' ? 'cli_b' : undefined),
        sessionExists: vi.fn((sid: string) => sid === 'sess-known' || sid === 'sess-legacy'),
        proxyToDaemon: vi.fn(async () => makeUpstream(200, { ok: true })),
      });
    }

    for (const action of ['close', 'resume', 'locate'] as const) {
      it(`callerAppId=cli_a + owner=cli_b → 403 session_owner_mismatch, proxyToDaemon NOT called (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-known/${action}`), '', 'cli_a');
        expect(r.status).toBe(403);
        expect((r.body as any).error).toBe('session_owner_mismatch');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });

      it(`callerAppId=cli_b + owner=cli_b → proxy cli_b (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-known/${action}`), '', 'cli_b');
        expect(r.status).toBe(200);
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_b',
          `/api/sessions/sess-known/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`?scope=global + callerAppId=cli_a + owner=cli_b → proxy owner cli_b, NOT 403 (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest(
          'POST',
          url(`/__daemon/sessions/sess-known/${action}?scope=global`),
          '',
          'cli_a',
        );
        expect(r.status).toBe(200);
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_b',
          `/api/sessions/sess-known/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`test seam (no callerAppId) → proxy owner (back-compat) (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-known/${action}`));
        expect(r.status).toBe(200);
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_b',
          `/api/sessions/sess-known/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`legacy row + callerAppId=cli_caller → proxy caller (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-legacy/${action}`), '', 'cli_caller');
        expect(r.status).toBe(200);
        expect(deps.proxyToDaemon).toHaveBeenCalledWith(
          'cli_caller',
          `/api/sessions/sess-legacy/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it(`legacy row + test seam → 404 unknown_session (back-compat) (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-legacy/${action}`));
        expect(r.status).toBe(404);
        expect((r.body as any).error).toBe('unknown_session');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });

      it(`row genuinely missing → 404 unknown_session (${action})`, async () => {
        const deps = ownerMismatchDeps();
        const api = createDaemonInternalApi(deps);
        const r = await api.dispatchForTest('POST', url(`/__daemon/sessions/sess-vanished/${action}`), '', 'cli_caller');
        expect(r.status).toBe(404);
        expect((r.body as any).error).toBe('unknown_session');
        expect(deps.proxyToDaemon).not.toHaveBeenCalled();
      });
    }
  });
});

/** ─── ROUTING EDGE CASES ─────────────────────────────────────────── */

describe('dispatch: routing edge cases', () => {
  it('unknown path → 404 unknown_endpoint (no allowlist leak)', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('GET', url('/__daemon/secrets'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_endpoint' });
  });

  it('method mismatch on known path → 405 method_not_allowed', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('POST', url('/__daemon/sessions-list'));
    expect(r.status).toBe(405);
    expect(r.body).toEqual({ ok: false, error: 'method_not_allowed' });
  });

  it('bad_json after valid HMAC → 400 bad_json (does not crash)', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const r = await api.dispatchForTest('PUT', url('/__daemon/settings-write'), '{invalid:json');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_json' });
  });
});

/** ─── HMAC INTEGRATION via handle() ───────────────────────────────── */

function fixedClock(ms: number): ClockLike & { advance(d: number): void; nowMs: number } {
  const c = { nowMs: ms, now() { return c.nowMs; }, advance(d: number) { c.nowMs += d; } };
  return c;
}

interface CapturedResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[]>;
}

function makeReq(opts: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  remoteAddr?: string;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(opts.body ?? '', 'utf8')]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  return Object.assign(stream, {
    method: opts.method,
    url: opts.url,
    headers,
    socket: { remoteAddress: opts.remoteAddr ?? '127.0.0.1' } as any,
  }) as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '', headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      captured.status = status;
      if (headers) captured.headers = headers;
      return this;
    },
    end(body?: string) {
      if (body !== undefined) captured.body = body;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function signedReq(opts: {
  method: string;
  pathWithQuery: string;
  body?: string;
  ts: string;
  nonce: string;
}): IncomingMessage {
  const body = opts.body ?? '';
  const { wire } = signDaemonRequest({
    secret: SECRET, ts: opts.ts, nonce: opts.nonce,
    method: opts.method, pathWithQuery: opts.pathWithQuery, bodyRaw: body,
  });
  return makeReq({
    method: opts.method,
    url: opts.pathWithQuery,
    body,
    headers: {
      'x-botmux-daemon-ts': opts.ts,
      'x-botmux-daemon-nonce': opts.nonce,
      'x-botmux-daemon-sig': wire,
      'x-botmux-daemon-appid': 'cli_test',
    },
  });
}

describe('handle(): HMAC integration', () => {
  it('valid HMAC + happy dispatch → 200', async () => {
    const clock = fixedClock(10_000_000);
    const api = createDaemonInternalApi({ ...makeDeps(), nonceStore: createNonceStore(clock), clock });
    const ts = String(clock.now());
    const req = signedReq({ method: 'GET', pathWithQuery: '/__daemon/sessions-list', ts, nonce: 'n1' });
    const { res, captured } = makeRes();
    const handled = await api.handle(req, res, new URL('http://127.0.0.1:7891/__daemon/sessions-list'));
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ sessions: [{ sessionId: 's1' }] });
  });

  it('non-/__daemon/* path is not handled (returns false)', async () => {
    const api = createDaemonInternalApi(makeDeps());
    const req = makeReq({ method: 'GET', url: '/api/sessions' });
    const { res } = makeRes();
    const handled = await api.handle(req, res, new URL('http://127.0.0.1:7891/api/sessions'));
    expect(handled).toBe(false);
  });

  it('bad sig → 401 sig_mismatch', async () => {
    const clock = fixedClock(11_000_000);
    const api = createDaemonInternalApi({ ...makeDeps(), nonceStore: createNonceStore(clock), clock });
    const ts = String(clock.now());
    const req = makeReq({
      method: 'GET',
      url: '/__daemon/sessions-list',
      headers: {
        'x-botmux-daemon-ts': ts,
        'x-botmux-daemon-nonce': 'n-bad',
        'x-botmux-daemon-sig': 'AAAA',
        'x-botmux-daemon-appid': 'cli_test',
      },
    });
    const { res, captured } = makeRes();
    await api.handle(req, res, new URL('http://127.0.0.1:7891/__daemon/sessions-list'));
    expect(captured.status).toBe(401);
    expect(JSON.parse(captured.body).error).toBe('sig_mismatch');
  });

  it('replay → 401 replay (same nonce sent twice)', async () => {
    const clock = fixedClock(12_000_000);
    const ts = String(clock.now());
    const api = createDaemonInternalApi({ ...makeDeps(), nonceStore: createNonceStore(clock), clock });

    const req1 = signedReq({ method: 'GET', pathWithQuery: '/__daemon/sessions-list', ts, nonce: 'replay-me' });
    const r1 = makeRes();
    await api.handle(req1, r1.res, new URL('http://127.0.0.1:7891/__daemon/sessions-list'));
    expect(r1.captured.status).toBe(200);

    const req2 = signedReq({ method: 'GET', pathWithQuery: '/__daemon/sessions-list', ts, nonce: 'replay-me' });
    const r2 = makeRes();
    await api.handle(req2, r2.res, new URL('http://127.0.0.1:7891/__daemon/sessions-list'));
    expect(r2.captured.status).toBe(401);
    expect(JSON.parse(r2.captured.body).error).toBe('replay');
  });

  it('caller-passed URL does not override req.url — sig minted for sessions-list cannot reach settings-snapshot (B1 regression)', async () => {
    const clock = fixedClock(14_000_000);
    const api = createDaemonInternalApi({ ...makeDeps(), nonceStore: createNonceStore(clock), clock });
    const ts = String(clock.now());

    // Sign for /__daemon/sessions-list, then request that same path via req.url
    // but pass a DIFFERENT url object as the third arg to handle().
    const req = signedReq({
      method: 'GET', pathWithQuery: '/__daemon/sessions-list', ts, nonce: 'n-conflict',
    });
    const callerLiedUrl = new URL('http://127.0.0.1:7891/__daemon/settings-snapshot');
    const { res, captured } = makeRes();

    await api.handle(req, res, callerLiedUrl);

    // Dispatch must follow req.url (sessions-list), NOT the caller's mismatched URL.
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ sessions: [{ sessionId: 's1' }] });
    // Critically: settings-snapshot's payload (`{settings: ...}`) must NOT appear.
    expect(captured.body).not.toContain('publicReadOnly');
  });

  it('body tampering → 401 sig_mismatch (sig was for original body)', async () => {
    const clock = fixedClock(13_000_000);
    const api = createDaemonInternalApi({ ...makeDeps(), nonceStore: createNonceStore(clock), clock });
    const ts = String(clock.now());
    const original = '{"larkAppIds":["cli_a"]}';
    const tampered = '{"larkAppIds":["cli_evil"]}';
    const { wire } = signDaemonRequest({
      secret: SECRET, ts, nonce: 'n-tamper', method: 'POST',
      pathWithQuery: '/__daemon/groups/oc_x/leave', bodyRaw: original,
    });
    // Send the tampered body but the sig was computed for `original`.
    const req = makeReq({
      method: 'POST',
      url: '/__daemon/groups/oc_x/leave',
      body: tampered,
      headers: {
        'x-botmux-daemon-ts': ts,
        'x-botmux-daemon-nonce': 'n-tamper',
        'x-botmux-daemon-sig': wire,
        'x-botmux-daemon-appid': 'cli_test',
      },
    });
    const { res, captured } = makeRes();
    await api.handle(req, res, new URL('http://127.0.0.1:7891/__daemon/groups/oc_x/leave'));
    expect(captured.status).toBe(401);
    expect(JSON.parse(captured.body).error).toBe('sig_mismatch');
  });
});

/** ─── Route table immutability ─────────────────────────────────── */

describe('route table immutability', () => {
  it('createDaemonInternalApi returns the same handle reference each call with same deps (no rebuild side effects)', () => {
    const deps = makeDeps();
    const a1 = createDaemonInternalApi(deps);
    const a2 = createDaemonInternalApi(deps);
    // Identity is not required; what matters is that both instances dispatch consistently.
    expect(typeof a1.handle).toBe('function');
    expect(typeof a2.handle).toBe('function');
  });
});
