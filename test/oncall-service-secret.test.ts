import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { handleOncallServiceSecret } from '../src/dashboard/oncall-service-secret.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';
import { decideDashboardAuth, decideWorkbenchH5Auth } from '../src/dashboard/auth.js';

let dir: string, envFile: string, base: string, csrf: string;
let server: Server;
let identity: { canManageHost: boolean; authSessionId: string } | null;
const endpoint = '/api/oncall-service-secret';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oncall-secret-'));
  envFile = join(dir, '.env');
  identity = { canManageHost: true, authSessionId: 'admin' };
  const csrfTokens = new ControlCsrfTokens();
  csrf = csrfTokens.mint('admin');
  server = createServer(async (req, res) => {
    const handled = await handleOncallServiceSecret(req, res, new URL(req.url!, base), { identity, csrfTokens, envFile });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
const get = () => fetch(base + endpoint);
const put = (body: unknown, headers: Record<string, string> = {}) => fetch(base + endpoint, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: base, 'x-botmux-csrf': csrf, ...headers },
  body: JSON.stringify(body),
});

describe('Oncall service secret configuration', () => {
  it('does not shadow a legacy working-directory env file when creating global config', async () => {
    writeFileSync(envFile, 'OTHER=keep\n', { mode: 0o600 });
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    envFile = join(dir, 'home', '.env');
    const response = await put({ secret: 'new-secret' });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('迁移');
    expect(existsSync(envFile)).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('OTHER=keep\n');
  });

  it('stores only the secret in a private env file, returns status only and leaves runtime env unchanged', async () => {
    const runtime = process.env.ONCALL_SERVICE_SECRET;
    expect(await (await get()).json()).toEqual({ ok: true, configured: false });
    expect(existsSync(envFile)).toBe(false);
    const saved = await put({ secret: '  service-secret  ' });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(await saved.json()).toEqual({ ok: true, configured: true, restartRequired: true });
    expect(parse(readFileSync(envFile))).toEqual({ ONCALL_SERVICE_SECRET: 'service-secret' });
    if (process.platform !== 'win32') expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(await (await get()).json()).toEqual({ ok: true, configured: true });
    expect(process.env.ONCALL_SERVICE_SECRET).toBe(runtime);
  });

  it('rotates duplicate and multiline values without changing other variables or comments', async () => {
    const unrelated = '# keep this comment\nOTHER="a\\nb"\nMULTI=\'line1\nONCALL_SERVICE_SECRET=not-a-key\nline3\'\n';
    writeFileSync(envFile, unrelated + 'export ONCALL_SERVICE_SECRET="old\nvalue" # credential\n# keep this too\nONCALL_SERVICE_SECRET=old2\n', { mode: 0o600 });
    expect((await put({ secret: 'new-secret' })).status).toBe(200);
    const updated = readFileSync(envFile, 'utf8');
    expect(updated).toContain(unrelated);
    expect(updated).toContain('# credential');
    expect(updated).toContain('# keep this too');
    expect(updated).not.toContain('old');
    expect(parse(updated)).toEqual({ OTHER: 'a\nb', MULTI: 'line1\nONCALL_SERVICE_SECRET=not-a-key\nline3', ONCALL_SERVICE_SECRET: 'new-secret' });
  });

  it.each(['hash#value', 'back\\nslash', "single'quote", 'double"quote', 'back`tick'])('round-trips a single-line credential %s', async secret => {
    writeFileSync(envFile, '# comment\r\nOTHER=value', { mode: 0o600 });
    expect((await put({ secret })).status).toBe(200);
    expect(parse(readFileSync(envFile))).toEqual({ OTHER: 'value', ONCALL_SERVICE_SECRET: secret });
  });

  it.each([{}, { secret: '' }, { secret: '  ' }, { secret: 'x\nOTHER=y' }, { secret: 'x\rvalue' },
    { secret: 'x\0value' }, { secret: 123 }, { secret: 'a'.repeat(8193) }, { secret: 'value', path: '/tmp/other' }])('rejects invalid input without changing disk: %j', async body => {
    writeFileSync(envFile, 'OTHER=keep\n', { mode: 0o600 });
    expect((await put(body)).status).toBe(400);
    expect(readFileSync(envFile, 'utf8')).toBe('OTHER=keep\n');
  });

  it('rejects malformed and oversized JSON without echoing it', async () => {
    const response = await fetch(base + endpoint, { method: 'PUT', headers: { origin: base, 'x-botmux-csrf': csrf }, body: '{private-secret' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private-secret');
    expect((await put({ secret: 'a'.repeat(20_000) })).status).toBe(400);
    expect(existsSync(envFile)).toBe(false);
  });

  it('requires host management authority for reading and writing', async () => {
    for (const denied of [null, { canManageHost: false, authSessionId: 'viewer' }]) {
      identity = denied;
      expect((await get()).status).toBe(403);
      expect((await put({ secret: 'secret' })).status).toBe(403);
    }
    expect(existsSync(envFile)).toBe(false);
    for (const method of ['GET', 'PUT']) {
      expect(decideDashboardAuth({ method, pathname: endpoint, hasTokenParam: false, presentedToken: undefined, activeToken: 'admin', publicReadOnly: true }).kind).toBe('deny401');
      expect(decideWorkbenchH5Auth({ method, pathname: endpoint }).kind).toBe('deny401');
    }
  });

  it('rejects cross-origin, missing or wrong-session CSRF tokens', async () => {
    expect((await put({ secret: 'secret' }, { origin: 'https://foreign.test' })).status).toBe(403);
    expect((await put({ secret: 'secret' }, { 'x-botmux-csrf': '' })).status).toBe(403);
    identity!.authSessionId = 'other-admin';
    expect((await put({ secret: 'secret' })).status).toBe(403);
    expect(existsSync(envFile)).toBe(false);
  });

  it('does not follow symlinks or overwrite unsafe files', async () => {
    if (process.platform === 'win32') return;
    const target = join(dir, 'target');
    writeFileSync(target, 'OTHER=keep\n', { mode: 0o600 });
    symlinkSync(target, envFile);
    expect((await get()).status).toBe(503);
    expect((await put({ secret: 'secret' })).status).toBe(503);
    expect(readFileSync(target, 'utf8')).toBe('OTHER=keep\n');
    rmSync(envFile);
    writeFileSync(envFile, 'OTHER=keep\n', { mode: 0o600 });
    chmodSync(envFile, 0o644);
    expect((await put({ secret: 'secret' })).status).toBe(503);
    expect(readFileSync(envFile, 'utf8')).toBe('OTHER=keep\n');
  });
});
