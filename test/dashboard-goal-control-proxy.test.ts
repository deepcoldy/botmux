import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGoalControlProxy } from '../src/dashboard/goal-control-proxy.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';

let server: Server;
let base: string;
let csrf: string;
let identity: any;
let proxy: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  identity = { kind: 'legacy-dashboard', authSessionId: 'admin' };
  const tokens = new ControlCsrfTokens();
  csrf = tokens.mint('admin');
  proxy = vi.fn(async () => new Response(JSON.stringify({ ok: true, actions: ['start', 'status'] })));
  server = createServer(async (req, res) => {
    if (!await handleGoalControlProxy(req, res, new URL(req.url!, base), {
      identity, csrfTokens: tokens, ownerOf: id => id === 's1' ? 'app1' : undefined, proxy,
    })) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const post = (headers: Record<string, string>, body = { action: 'start', objective: 'fix login' }) => fetch(`${base}/api/sessions/s1/goal`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
describe('Dashboard goal control boundary', () => {
  it('reads capability without starting work', async () => {
    expect((await fetch(`${base}/api/sessions/s1/goal`)).status).toBe(200);
    expect(proxy).toHaveBeenCalledWith('app1', '/api/sessions/s1/goal', expect.objectContaining({ method: 'GET' }));
  });
  it('forwards owner commands with valid CSRF', async () => {
    expect((await post({ origin: base, 'x-botmux-csrf': csrf })).status).toBe(200);
    expect(proxy).toHaveBeenCalledWith('app1', '/api/sessions/s1/goal', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'start', objective: 'fix login' }),
    }));
  });
  it('refuses missing ticket and cross-origin commands', async () => {
    expect((await post({ origin: base })).status).toBe(403);
    expect((await post({ origin: 'https://example.org', 'x-botmux-csrf': csrf })).status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });
  it.each([null, { kind: 'platform-dashboard', authSessionId: 'admin' }, { kind: 'h5', authSessionId: 'admin' }])('refuses non-owner identity', async value => {
    identity = value;
    expect((await post({ origin: base, 'x-botmux-csrf': csrf })).status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });
  it('refuses unknown sessions', async () => {
    expect((await fetch(`${base}/api/sessions/missing/goal`)).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
