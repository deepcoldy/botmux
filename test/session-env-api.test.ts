/**
 * Dashboard routes for「会话环境变量」: raw values and tmux server edits are
 * local-owner capabilities; everyone else gets fully masked views.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleSessionEnvRoute, type SessionEnvApiDeps } from '../src/dashboard/session-env-api.js';

function fakeRes() {
  const res: any = {
    status: 0,
    body: undefined as unknown,
    writableEnded: false,
    writeHead(status: number) { res.status = status; return res; },
    end(text?: string) { res.writableEnded = true; if (text) res.body = JSON.parse(text); },
  };
  return res;
}

function deps(over: Partial<SessionEnvApiDeps> = {}) {
  const calls: Array<{ appId: string; path: string; init: RequestInit }> = [];
  const d: SessionEnvApiDeps & { calls: typeof calls } = {
    calls,
    canReveal: false,
    daemons: () => [{ larkAppId: 'app_b', botName: 'B', botIndex: 1 }, { larkAppId: 'app_a', botName: 'A', botIndex: 0 }],
    proxyToDaemon: vi.fn(async (appId: string, path: string, init: RequestInit) => {
      calls.push({ appId, path, init });
      if (path.startsWith('/api/session-env-sessions')) {
        return new Response(JSON.stringify({ ok: true, sessions: [{ sessionId: `s-${appId}`, stale: true }] }));
      }
      return new Response(JSON.stringify({ ok: true, rows: [] }), { headers: { 'content-type': 'application/json' } });
    }),
    readJsonBody: vi.fn(async () => ({})),
    applyGlobalOps: vi.fn(() => ({ ok: true as const })),
    jsonRes: (res, status, body) => { res.status = status; res.body = body; res.writableEnded = true; },
    ...over,
  };
  return d;
}

async function call(d: SessionEnvApiDeps, method: string, path: string) {
  const res = fakeRes();
  const handled = await handleSessionEnvRoute({ method } as any, res, new URL(`http://x${path}`), d);
  return { handled, res };
}

describe('owner-only capabilities', () => {
  for (const [method, path] of [
    ['GET', '/api/session-env/reveal?key=A'],
    ['POST', '/api/session-env/tmux/remove'],
    ['GET', '/api/bots/app_a/session-env/reveal?key=A'],
    ['GET', '/api/bots/app_a/sessions/s1/env/reveal?key=A'],
  ] as const) {
    it(`${method} ${path} → 403 without reaching a daemon`, async () => {
      const d = deps();
      const { handled, res } = await call(d, method, path);
      expect(handled).toBe(true);
      expect(res.status).toBe(403);
      expect(d.calls).toHaveLength(0);
    });
  }

  it('the owner reaches the daemon reveal route', async () => {
    const d = deps({ canReveal: true });
    await call(d, 'GET', '/api/bots/app_a/sessions/s%201/env/reveal?key=TOKEN');
    expect(d.calls[0]).toMatchObject({ appId: 'app_a', path: '/api/bot-session-env/live/reveal?sessionId=s%201&key=TOKEN' });
  });
});

describe('views', () => {
  it('asks the daemon to mask everything for a non-owner', async () => {
    const d = deps();
    const { res } = await call(d, 'GET', '/api/bots/app_a/session-env');
    expect(d.calls[0]!.path).toBe('/api/bot-session-env?maskAll=1');
    expect(res.body).toMatchObject({ ok: true, canReveal: false });
  });

  it('the owner gets the heuristic mask (reveal available)', async () => {
    const d = deps({ canReveal: true });
    const { res } = await call(d, 'GET', '/api/bots/app_a/session-env');
    expect(d.calls[0]!.path).toBe('/api/bot-session-env');
    expect(res.body).toMatchObject({ canReveal: true });
  });

  it('global view: one daemon for the machine view, every daemon for running sessions', async () => {
    const d = deps();
    const { res } = await call(d, 'GET', '/api/session-env');
    expect(d.calls[0]).toMatchObject({ appId: 'app_a', path: '/api/session-env-global?maskAll=1' });
    expect((res.body as any).sessions.map((s: any) => s.sessionId).sort()).toEqual(['s-app_a', 's-app_b']);
  });

  it('global view falls back to the next daemon when one cannot serve it', async () => {
    const d = deps({
      proxyToDaemon: vi.fn(async (appId: string, path: string) => {
        if (path.startsWith('/api/session-env-sessions')) return new Response(JSON.stringify({ ok: true, sessions: [] }));
        return appId === 'app_a'
          ? new Response(JSON.stringify({ error: 'not_found_yet' }), { status: 404 })
          : new Response(JSON.stringify({ ok: true, scope: 'global', rows: [{ key: 'X' }] }));
      }),
    });
    const { res } = await call(d, 'GET', '/api/session-env');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'global', rows: [{ key: 'X' }] });
  });

  it('global view without any daemon is an explicit 503', async () => {
    const { res } = await call(deps({ daemons: () => [] }), 'GET', '/api/session-env');
    expect(res.status).toBe(503);
  });
});

describe('global writes', () => {
  it('validates ops before touching config.json', async () => {
    const d = deps({ readJsonBody: vi.fn(async () => ({ ops: [{ op: 'unset', key: 'BOTMUX_SESSION_ID' }] })) });
    const { res } = await call(d, 'PUT', '/api/session-env');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'reserved_key', key: 'BOTMUX_SESSION_ID' });
    expect(d.applyGlobalOps).not.toHaveBeenCalled();
  });

  it('persists valid ops and answers with the fresh view', async () => {
    const ops = [{ op: 'set', key: 'HTTPS_PROXY', value: 'http://p' }, { op: 'unset', key: 'BYTECLOUD_AUTH_AS' }];
    const d = deps({ readJsonBody: vi.fn(async () => ({ ops })) });
    const { res } = await call(d, 'PUT', '/api/session-env');
    expect(d.applyGlobalOps).toHaveBeenCalledWith(ops);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('reports an over-budget global save as a 400', async () => {
    const d = deps({
      readJsonBody: vi.fn(async () => ({ ops: [{ op: 'set', key: 'A', value: 'x' }] })),
      applyGlobalOps: vi.fn(() => ({ ok: false as const, error: 'layer_too_large' })),
    });
    const { res } = await call(d, 'PUT', '/api/session-env');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'layer_too_large' });
  });

  it('forwards bot ops verbatim (the daemon validates with the bot lock context)', async () => {
    const ops = [{ op: 'unset', key: 'ZDOTDIR' }];
    const d = deps({ readJsonBody: vi.fn(async () => ({ ops })) });
    await call(d, 'PUT', '/api/bots/app_a/session-env');
    expect(d.calls[0]).toMatchObject({ appId: 'app_a', path: '/api/bot-session-env?maskAll=1' });
    expect(JSON.parse(String(d.calls[0]!.init.body))).toEqual({ ops });
  });
});
