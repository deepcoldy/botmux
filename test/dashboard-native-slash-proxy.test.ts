import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNativeSlashCommandsProxy } from '../src/dashboard/native-slash-commands-proxy.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';

let server: Server;
let base: string;
let csrf: string;
let identity: { canManageHost: boolean; authSessionId: string } | null;
let proxy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  identity = { canManageHost: true, authSessionId: 'admin' };
  const csrfTokens = new ControlCsrfTokens();
  csrf = csrfTokens.mint('admin');
  proxy = vi.fn(async (_appId: string, path: string) => new Response(JSON.stringify({ ok: true, path }), { status: 200 }));
  server = createServer(async (req, res) => {
    const handled = await handleNativeSlashCommandsProxy(req, res, new URL(req.url!, base), {
      identity, csrfTokens, proxy: proxy as any,
    });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const post = (action: string, headers: Record<string, string>, body?: unknown) => fetch(
  `${base}/api/bots/cli_demo/slash-commands/${action}`,
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
);

describe('native slash-command dashboard proxy — control CSRF gate', () => {
  it('GET snapshot is relayed without a CSRF ticket', async () => {
    const res = await fetch(`${base}/api/bots/cli_demo/slash-commands`);
    expect(res.status).toBe(200);
    expect(proxy).toHaveBeenCalledWith('cli_demo', '/api/bot-slash-commands', { method: 'GET' });
  });

  it.each(['sync', 'sync-one', 'delete'])('rejects %s without a CSRF ticket (body-less form POST shape)', async action => {
    const res = await post(action, { origin: base });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'control_csrf_invalid' });
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin page even with a valid ticket, and a request with no origin signal', async () => {
    const foreign = await post('sync', { origin: 'http://127.0.0.1:1', 'x-botmux-csrf': csrf });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: 'control_origin_forbidden' });
    const bare = await post('sync', { 'x-botmux-csrf': csrf });
    expect(bare.status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects a forged ticket and identities without host management', async () => {
    const forged = await post('delete', { origin: base, 'x-botmux-csrf': 'forged' }, { command: 'help' });
    expect(forged.status).toBe(403);
    identity = { canManageHost: false, authSessionId: 'admin' };
    const viewer = await post('delete', { origin: base, 'x-botmux-csrf': csrf }, { command: 'help' });
    expect(viewer.status).toBe(403);
    identity = null;
    const anonymous = await post('delete', { origin: base, 'x-botmux-csrf': csrf }, { command: 'help' });
    expect(anonymous.status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('relays a same-origin write carrying a valid ticket to the bot daemon', async () => {
    const res = await post('sync-one', { origin: base, 'x-botmux-csrf': csrf }, { command: '/help' });
    expect(res.status).toBe(200);
    expect(proxy).toHaveBeenCalledWith('cli_demo', '/api/bot-slash-commands/sync-one', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ command: '/help' }),
    }));
    const sync = await post('sync', { 'sec-fetch-site': 'same-origin', 'x-botmux-csrf': csrf });
    expect(sync.status).toBe(200);
    expect(proxy).toHaveBeenLastCalledWith('cli_demo', '/api/bot-slash-commands/sync', expect.objectContaining({ body: '{}' }));
  });

  it('caps the write body size', async () => {
    const res = await post('sync-one', { origin: base, 'x-botmux-csrf': csrf }, { command: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('ignores unrelated routes', async () => {
    expect((await fetch(`${base}/api/bots/cli_demo/other`, { method: 'POST' })).status).toBe(404);
  });
});
