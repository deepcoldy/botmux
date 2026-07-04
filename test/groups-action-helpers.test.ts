import { describe, expect, it, vi } from 'vitest';

import {
  addBotsToGroup,
  bindOncall,
  disbandGroup,
  leaveGroup,
  unbindOncall,
  type DaemonHandle,
  type GroupsActionDeps,
} from '../src/dashboard/groups-action-helpers.js';

/** Build a Response-like object from a JSON body + status. */
function makeRes(status: number, body: unknown, opts: { textOverride?: string } = {}): Response {
  const text = opts.textOverride ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function daemon(larkAppId: string, ipcPort: number): DaemonHandle {
  return { larkAppId, ipcPort, botName: larkAppId };
}

function makeDeps(over: Partial<GroupsActionDeps> = {}): GroupsActionDeps {
  return {
    registryList: vi.fn(() => [] as DaemonHandle[]),
    registryGetByAppId: vi.fn(() => undefined),
    proxyToDaemon: vi.fn(async () => makeRes(200, { ok: true })),
    closeSessionsMatching: vi.fn(async () => []),
    fetch: vi.fn(async () => makeRes(200, { inChat: true })),
    ...over,
  };
}

describe('addBotsToGroup', () => {
  it('forwards body to the first inChat daemon and echoes upstream', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/membership')) return makeRes(200, { inChat: true });
      return makeRes(200, { ok: true, added: ['cli_x'] });
    });
    const deps = makeDeps({
      registryList: () => [daemon('cli_a', 9000)],
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await addBotsToGroup('oc_demo', '{"larkAppIds":["cli_x"]}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, added: ['cli_x'] });
    // membership probe + add-bots
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns no_proxy_bot when no online daemon is in chat', async () => {
    const fetchSpy = vi.fn(async () => makeRes(200, { inChat: false }));
    const deps = makeDeps({
      registryList: () => [daemon('cli_a', 9000), daemon('cli_b', 9001)],
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await addBotsToGroup('oc_demo', '{}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, error: 'no_proxy_bot' });
  });

  it('returns bad_json when body is not valid JSON', async () => {
    const deps = makeDeps();
    const r = await addBotsToGroup('oc_demo', '{not-json', deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_json' });
  });

  it('skips daemons whose membership endpoint returns non-ok status', async () => {
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      if (call === 1) return makeRes(503, { error: 'offline' });
      if (call === 2) return makeRes(200, { inChat: true });
      return makeRes(200, { ok: true });
    });
    const deps = makeDeps({
      registryList: () => [daemon('cli_off', 9000), daemon('cli_ok', 9001)],
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await addBotsToGroup('oc_demo', '{}', deps);
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
  });
});

describe('disbandGroup', () => {
  it('happy: proxies to named bot, cascade-closes sessions on success', async () => {
    const closedReturn = [{ sessionId: 's1' }, { sessionId: 's2' }];
    const deps = makeDeps({
      proxyToDaemon: vi.fn(async () => makeRes(200, { ok: true })),
      closeSessionsMatching: vi.fn(async () => closedReturn),
    });
    const r = await disbandGroup('oc_demo', { larkAppId: 'cli_owner' }, deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, closedSessions: closedReturn });
    expect(deps.closeSessionsMatching).toHaveBeenCalledOnce();
  });

  it('returns larkAppId_required when body lacks the field', async () => {
    const deps = makeDeps();
    const r = await disbandGroup('oc_demo', {}, deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'larkAppId_required' });
    expect(deps.proxyToDaemon).not.toHaveBeenCalled();
  });

  it('does not cascade-close when upstream disband fails', async () => {
    const deps = makeDeps({
      proxyToDaemon: vi.fn(async () => makeRes(500, { ok: false, error: 'lark_denied' })),
    });
    const r = await disbandGroup('oc_demo', { larkAppId: 'cli_x' }, deps);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'lark_denied', closedSessions: [] });
    expect(deps.closeSessionsMatching).not.toHaveBeenCalled();
  });
});

describe('leaveGroup', () => {
  it('returns per-bot result: success, daemon_offline, not_in_chat — and cascade closes only successful bots\'s sessions', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // cli_a inChat=true, cli_c inChat=false
      if (url.includes('9000')) return makeRes(200, { inChat: true });
      if (url.includes('9001')) return makeRes(200, { inChat: false });
      return makeRes(200, { inChat: true });
    });
    const proxyByAppId: Record<string, Response> = {
      cli_a: makeRes(200, { ok: true }),
    };
    const closedSpy = vi.fn(async (pred: (s: any) => boolean) => {
      const out = [{ chatId: 'oc_demo', larkAppId: 'cli_a' }];
      return out.filter(pred);
    });
    const deps = makeDeps({
      registryGetByAppId: vi.fn((id: string) => {
        if (id === 'cli_a') return daemon('cli_a', 9000);
        if (id === 'cli_c') return daemon('cli_c', 9001);
        return undefined; // cli_b offline
      }),
      fetch: fetchSpy as unknown as typeof fetch,
      proxyToDaemon: vi.fn(async (appId) => proxyByAppId[appId] ?? makeRes(500, { ok: false })),
      closeSessionsMatching: closedSpy as any,
    });

    const r = await leaveGroup('oc_demo', { larkAppIds: ['cli_a', 'cli_b', 'cli_c'] }, deps);
    expect(r.status).toBe(200);
    const body = r.body as { result: Array<Record<string, unknown>> };
    expect(body.result.length).toBe(3);

    const byApp = Object.fromEntries(body.result.map((r: any) => [r.larkAppId, r]));

    // Successful leave carries closedSessions (length=1, only cli_a's session).
    expect(byApp.cli_a).toEqual({
      larkAppId: 'cli_a',
      ok: true,
      error: undefined,
      closedSessions: [{ chatId: 'oc_demo', larkAppId: 'cli_a' }],
    });

    // Pre-proxy failure branches do NOT include closedSessions (shape parity
    // with the historical inline route at dashboard.ts:789-800).
    expect(byApp.cli_b).toEqual({ larkAppId: 'cli_b', ok: false, error: 'daemon_offline' });
    expect(byApp.cli_b.closedSessions).toBeUndefined();

    expect(byApp.cli_c).toEqual({ larkAppId: 'cli_c', ok: false, error: 'not_in_chat' });
    expect(byApp.cli_c.closedSessions).toBeUndefined();

    // Cascade close called only for cli_a (the only successful leave).
    expect(closedSpy).toHaveBeenCalledOnce();
  });

  it('returns larkAppIds_required when body lacks the array or it is empty', async () => {
    const deps = makeDeps();
    expect((await leaveGroup('oc_demo', {}, deps)).body).toEqual({ ok: false, error: 'larkAppIds_required' });
    expect((await leaveGroup('oc_demo', { larkAppIds: [] }, deps)).body).toEqual({ ok: false, error: 'larkAppIds_required' });
    expect((await leaveGroup('oc_demo', { larkAppIds: [123] }, deps)).body).toEqual({ ok: false, error: 'larkAppIds_required' });
  });

  it('membership_check_failed when fetch throws — has no closedSessions field', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('econnrefused'); });
    const deps = makeDeps({
      registryGetByAppId: () => daemon('cli_x', 9000),
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await leaveGroup('oc_demo', { larkAppIds: ['cli_x'] }, deps);
    const body = r.body as { result: Array<Record<string, unknown>> };
    expect(body.result[0]).toEqual({
      larkAppId: 'cli_x',
      ok: false,
      error: 'membership_check_failed: econnrefused',
    });
    expect(body.result[0].closedSessions).toBeUndefined();
  });

  it('upstream proxy failure carries closedSessions=[] (post-proxy branch)', async () => {
    const fetchSpy = vi.fn(async () => makeRes(200, { inChat: true }));
    const deps = makeDeps({
      registryGetByAppId: () => daemon('cli_x', 9000),
      fetch: fetchSpy as unknown as typeof fetch,
      proxyToDaemon: vi.fn(async () => makeRes(500, { ok: false, error: 'lark_denied' })),
    });
    const r = await leaveGroup('oc_demo', { larkAppIds: ['cli_x'] }, deps);
    const body = r.body as { result: Array<Record<string, unknown>> };
    expect(body.result[0]).toEqual({
      larkAppId: 'cli_x',
      ok: false,
      error: 'lark_denied',
      closedSessions: [],
    });
  });
});

describe('bindOncall', () => {
  it('proxies to internal daemon path /api/oncall/:chatId with PUT + body forwarded', async () => {
    const proxySpy = vi.fn(async (appId, daemonPath, init) => makeRes(200, { ok: true, workingDir: '/repo/x' }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const r = await bindOncall('oc_demo', 'cli_owner', '{"workingDir":"/repo/x"}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, workingDir: '/repo/x' });

    const call = proxySpy.mock.calls[0]!;
    expect(call[0]).toBe('cli_owner');
    expect(call[1]).toBe('/api/oncall/oc_demo');
    expect((call[2] as RequestInit).method).toBe('PUT');
    expect((call[2] as RequestInit).body).toBe('{"workingDir":"/repo/x"}');
  });

  it('uses "{}" body when raw body is empty', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    await bindOncall('oc_demo', 'cli_owner', '', deps);
    expect((proxySpy.mock.calls[0]![2] as RequestInit).body).toBe('{}');
  });
});

describe('unbindOncall', () => {
  it('proxies to internal daemon path /api/oncall/:chatId with DELETE', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const r = await unbindOncall('oc_demo', 'cli_owner', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const call = proxySpy.mock.calls[0]!;
    expect(call[0]).toBe('cli_owner');
    expect(call[1]).toBe('/api/oncall/oc_demo');
    expect((call[2] as RequestInit).method).toBe('DELETE');
  });
});
