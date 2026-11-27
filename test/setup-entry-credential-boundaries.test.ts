import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWecomSetupClient } from '../src/cli/wecom/onboarding-client.js';
import { callDashboard } from '../src/cli/dashboard-endpoint.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const roots: string[] = [];
const token = 'independent_owner_token_0123456789';
const csrf = 'independent_csrf_ticket_0123456789';
const id = 'wecom-01234567-0123-0123-0123-0123456789ab';
const snapshot = { id, platform: 'wecom', status: 'starting', cliId: 'codex', workingDir: '/tmp', createdAt: 1, updatedAt: 1, resumeUntil: 2, saved: false, retryable: false, externalBotCreated: false };
const root = () => { const path = mkdtempSync(join(tmpdir(), 'setup-entry-')); roots.push(path); return path; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const html = () => new Response(`<meta name="botmux-csrf" content="${csrf}">`, { headers: { 'content-type': 'text/html' } });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('setup local credential boundaries', () => {
  it('keeps cookie and CSRF on the HMAC dial port despite remote URLs and remote localUrl', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const client = await createWecomSetupClient({ ok: true, url: `https://remote.invalid/?t=${token}`, localUrl: `http://10.0.0.2:99/?t=${token}` }, 41234, {
      fetch: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? html() : url.endsWith('wecom-jobs') ? json({ jobs: [snapshot] }) : json({ job: snapshot }); },
    });
    // A caller cannot point the shared start route at another platform; any mode but an
    // explicit 'manual' (see wecom-setup-client.test.ts) is sent as scan-to-create.
    await client.list(); await client.start({ platform: 'lark', mode: 'not-a-mode' }); await client.action(id, 'cancel');
    expect(calls.every(call => new URL(call.url).origin === 'http://127.0.0.1:41234')).toBe(true);
    expect(calls.every(call => call.init.headers.cookie === `botmux_dashboard_token=${token}`)).toBe(true);
    expect(calls[2].init.headers).toMatchObject({ origin: 'http://127.0.0.1:41234', 'x-botmux-csrf': csrf });
    expect(JSON.parse(calls[2].init.body)).toMatchObject({ platform: 'wecom', mode: 'qr' });
    const before = calls.length; await expect(client.get('../secrets')).rejects.toThrow(/本机 Dashboard 请求失败/); expect(calls).toHaveLength(before);
  });
  it('binds the management port to the successful HMAC request even when port file changes during the exchange', async () => {
    const configDir = root(); writeFileSync(join(configDir, '.dashboard-secret'), 'independent-fixture-secret', { mode: 0o600 }); writeFileSync(join(configDir, '.dashboard-port'), '41234');
    const ports: number[] = [];
    const result = await callDashboard({ configDir, defaultPort: 7891, path: '/__cli/ensure', onDashboardPort: port => ports.push(port), fetchImpl: (async () => {
      writeFileSync(join(configDir, '.dashboard-port'), '41235'); return json({ url: `https://remote.invalid/?t=${token}` });
    }) as any });
    expect(result.ok).toBe(true); expect(ports).toEqual([41234]);
  });
  it.each([undefined, 'not-a-token', 'sensitive\r\ncookie'])('rejects missing or invalid token before any dial (%s)', async bad => {
    const fetch = vi.fn(); await expect(createWecomSetupClient({ ok: true, url: `http://127.0.0.1/?t=${encodeURIComponent(bad ?? '')}` }, 41234, { fetch })).rejects.toThrow(/本机 Dashboard 请求失败/); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects redirects and never sends owner cookie to their destination or configured proxies', async () => {
    let leaked = 0; let arrived = 0;
    const foreign = createServer((_req, res) => { leaked++; res.end('forbidden'); }); foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
    const remote = `http://127.0.0.1:${(foreign.address() as any).port}`;
    const local = createServer((_req, res) => { arrived++; res.writeHead(302, { location: remote }); res.end(); }); local.listen(0, '127.0.0.1'); await once(local, 'listening');
    vi.stubEnv('http_proxy', remote); vi.stubEnv('HTTP_PROXY', remote); vi.stubEnv('ALL_PROXY', remote); vi.stubEnv('no_proxy', '');
    try { await expect(createWecomSetupClient({ ok: true, url: `https://public.invalid/?t=${token}` }, (local.address() as any).port)).rejects.toThrow(/本机 Dashboard 请求失败/); expect(arrived).toBe(1); expect(leaked).toBe(0); }
    finally { await Promise.all([new Promise<void>(done => local.close(() => done())), new Promise<void>(done => foreign.close(() => done()))]); }
  });
  it('bounds a real partial response body and keeps server error secrets out of diagnostics', async () => {
    const local = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('PRIVATE_BODY_SECRET'); }); local.listen(0, '127.0.0.1'); await once(local, 'listening');
    try { const started = Date.now(); const error = await createWecomSetupClient({ ok: true, url: `http://127.0.0.1/?t=${token}` }, (local.address() as any).port, { timeoutMs: 50 }).catch(error => error); expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('PRIVATE_BODY_SECRET'); expect(error.message).not.toContain(token); expect(Date.now() - started).toBeLessThan(2000); }
    finally { local.closeAllConnections(); await new Promise<void>(done => local.close(() => done())); }
  });
});

async function cli(args: string[]) {
  const home = root(); const child = spawnTsScript(resolve('src/cli.ts'), ['setup', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, BOTS_CONFIG: join(home, 'bots.json'), SESSION_DATA_DIR: join(home, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout!.on('data', value => stdout += value); child.stderr!.on('data', value => stderr += value);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000); const [status, signal] = await once(child, 'close'); clearTimeout(deadline); return { status, signal, stdout, stderr };
}

describe('real setup executable compatibility', () => {
  // Bare `setup` (and `--lang en`, or unrecognised flags such as `--platform wecom`)
  // without a terminal is the Feishu wizard reading piped answers, exactly as before
  // WeCom: see setup-default-feishu-entry.test.ts.
  it('routes scripted list through original Lark JSON output', async () => {
    const result = await cli(['list', '--json']); expect(result.signal).toBeNull(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
