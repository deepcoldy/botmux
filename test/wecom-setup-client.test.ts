import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createWecomSetupClient, WecomSetupRejectedError } from '../src/cli/wecom/onboarding-client.js';
import { ControlCsrfTokens, injectControlCsrfMeta, guardControlRequest } from '../src/dashboard/control-csrf.js';

const servers: Server[] = [];
const token = 'synthetic_token_1234567890';
const id = 'wecom-11111111-1111-4111-8111-111111111111';
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const host = createServer(handler); servers.push(host); host.listen(0, '127.0.0.1'); await once(host, 'listening');
  return (host.address() as { port: number }).port;
}
describe('扫码setup本机管理客户端', () => {
  it('主URL远端/LAN本地URL时，仍只请求已发现端口并携带真实cookie与CSRF', async () => {
    const csrf = new ControlCsrfTokens(), ticket = csrf.mint('legacy-session');
    const visited: string[] = [];
    const port = await server((req, res) => {
      visited.push(req.url!);
      expect(req.headers.cookie).toBe(`botmux_dashboard_token=${token}`);
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(injectControlCsrfMeta('<head></head>', ticket)); return; }
      if (req.method === 'POST') expect(guardControlRequest({ headers: req.headers, authSessionId: 'legacy-session', tokens: csrf })).toMatchObject({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url?.endsWith('wecom-jobs') ? { jobs: [] } : { job: { id, platform: 'wecom', status: 'starting' } }));
    });
    const networkFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not use proxied fetch'));
    const client = await createWecomSetupClient({ ok: true, url: 'https://platform.example/', localUrl: `http://192.168.9.9:9000/?t=${token}` }, port);
    await client.list(); await client.start({ cliId: 'codex' }); await client.action(id, 'cancel');
    expect(visited).toEqual(['/', '/api/bot-onboarding/wecom-jobs', '/api/bot-onboarding/start', `/api/bot-onboarding/${id}/cancel`]);
    expect(networkFetch).not.toHaveBeenCalled();
  });
  it('创建请求默认扫码；只有显式 mode: manual 才带手动凭据，其它 mode 值一律按扫码', async () => {
    const bodies: Record<string, unknown>[] = [];
    const port = await server((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<meta name="botmux-csrf" content="${token}">`); return; }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job: { id, platform: 'wecom', status: 'starting' } }));
      });
    });
    const client = await createWecomSetupClient({ ok: true, url: `http://lan/?t=${token}` }, port);
    await client.start({ cliId: 'codex' });
    await client.start({ cliId: 'codex', mode: 'manual', botId: 'bot-1', secret: 'fixture-secret' });
    await client.start({ cliId: 'codex', mode: 'something-else', platform: 'lark' });
    expect(bodies).toEqual([
      { cliId: 'codex', platform: 'wecom', mode: 'qr' },
      { cliId: 'codex', platform: 'wecom', mode: 'manual', botId: 'bot-1', secret: 'fixture-secret' },
      { cliId: 'codex', platform: 'wecom', mode: 'qr' },
    ]);
  });
  describe('创建请求被 Dashboard 拒绝', () => {
    const SECRET = 'CLIENT-REJECTION-SECRET-5b2e';
    /** Every request after the page answers with `status` / `contentType` / `body`. */
    async function rejectingClient(status: number, contentType: string, body: string) {
      const port = await server((req, res) => {
        if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<meta name="botmux-csrf" content="${token}">`); return; }
        req.resume();
        req.on('end', () => { res.writeHead(status, { 'content-type': contentType }); res.end(body); });
      });
      return createWecomSetupClient({ ok: true, url: `http://lan/?t=${token}` }, port);
    }
    const start = (client: Awaited<ReturnType<typeof rejectingClient>>) =>
      client.start({ cliId: 'codex', mode: 'manual', botId: 'bot-1', secret: SECRET }).then(() => undefined, (error: unknown) => error);

    it('400 + JSON + wecom_ 码：抛 WecomSetupRejectedError 且只带这个码，不带请求体', async () => {
      const client = await rejectingClient(400, 'application/json', JSON.stringify({ ok: false, error: 'wecom_cli_unavailable', echo: SECRET }));
      const error = await start(client);
      expect(error).toBeInstanceOf(WecomSetupRejectedError);
      expect((error as WecomSetupRejectedError).code).toBe('wecom_cli_unavailable');
      const err = error as Error;
      expect(JSON.stringify({ ...err, message: err.message, stack: err.stack, name: err.name })).not.toContain(SECRET);
      expect(String(err)).not.toContain(SECRET);
    });

    it.each([
      { name: '400 但 error 不是 wecom_ 码', status: 400, type: 'application/json', body: JSON.stringify({ ok: false, error: 'bad_json' }) },
      { name: '400 但 error 带大写/数字', status: 400, type: 'application/json', body: JSON.stringify({ ok: false, error: 'wecom_Cli1' }) },
      { name: '400 但 error 不是字符串', status: 400, type: 'application/json', body: JSON.stringify({ ok: false, error: ['wecom_cli_unavailable'] }) },
      { name: '400 但不是 JSON', status: 400, type: 'text/html', body: 'wecom_cli_unavailable' },
      { name: '400 但 JSON 坏了', status: 400, type: 'application/json', body: '{"error":"wecom_cli_unavailable"' },
      { name: '500 带 wecom_ 码', status: 500, type: 'application/json', body: JSON.stringify({ ok: false, error: 'wecom_cli_unavailable' }) },
      { name: '403 带 wecom_ 码', status: 403, type: 'application/json', body: JSON.stringify({ ok: false, error: 'wecom_host_admin_required' }) },
    ])('$name：仍是固定的「请求失败」错误', async ({ status, type, body }) => {
      const client = await rejectingClient(status, type, body);
      const error = await start(client);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(WecomSetupRejectedError);
      expect((error as Error).message).toMatch(/本机 Dashboard 请求失败/);
      expect(String(error)).not.toContain(SECRET);
    });

    it('只有 start 读拒绝码：get / action / list 收到同样的 400 仍是固定错误', async () => {
      const client = await rejectingClient(400, 'application/json', JSON.stringify({ ok: false, error: 'wecom_cli_unavailable' }));
      for (const call of [() => client.get(id), () => client.action(id, 'retry'), () => client.list()]) {
        const error = await call().then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(WecomSetupRejectedError);
      }
    });
  });
  it('拒绝redirect且不发送token至Location', async () => {
    let calls = 0;
    const port = await server((_req, res) => { calls++; res.writeHead(302, { location: 'https://attacker.example/' }); res.end(); });
    await expect(createWecomSetupClient({ ok: true, url: `http://lan/?t=${token}` }, port)).rejects.toThrow(/本机 Dashboard 请求失败/);
    expect(calls).toBe(1);
  });
  it('拒绝过大的HTML和缺少/重复CSRF的壳，不回显原始正文', async () => {
    for (const body of ['secret-html', `<meta name="botmux-csrf" content="${token}"><meta name="botmux-csrf" content="${token}">`, 'x'.repeat(512 * 1024 + 1)]) {
      const port = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); });
      await expect(createWecomSetupClient({ ok: true, url: `http://lan/?t=${token}` }, port)).rejects.toThrow(/本机 Dashboard/);
    }
  });
  it('超时覆盖已经收到headers但永远不结束的body', async () => {
    const port = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<head>'); });
    await expect(createWecomSetupClient({ ok: true, url: `http://lan/?t=${token}` }, port, { timeoutMs: 30 })).rejects.toThrow(/本机 Dashboard 请求失败/);
  });
  it('缺失token或实际端口时在网络前拒绝', async () => {
    const fetch = vi.fn();
    await expect(createWecomSetupClient({ ok: true, url: 'http://remote/' }, 7891, { fetch })).rejects.toThrow(/本机 Dashboard 请求失败/);
    await expect(createWecomSetupClient({ ok: true, url: `http://remote/?t=${token}` }, 0, { fetch })).rejects.toThrow(/本机 Dashboard 请求失败/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
