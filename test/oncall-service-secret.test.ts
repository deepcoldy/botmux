import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { readOncallDeploymentEnv } from '../src/services/oncall-deployment-config.js';
import { loadOncallGroupTarget } from '../src/services/oncall-group-client.js';
import { handleOncallServiceSecret } from '../src/dashboard/oncall-service-secret.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';
import { decideDashboardAuth, decideWorkbenchH5Auth } from '../src/dashboard/auth.js';

let dir: string, envFile: string, base: string, csrf: string;
let server: Server;
let identity: { canManageHost: boolean; authSessionId: string } | null;
const endpoint = '/api/oncall-service-secret';
beforeEach(async () => {
  for (const key of ['ONCALL_GROUP_ENDPOINT', 'ONCALL_EMAIL_DOMAIN', 'ONCALL_SERVICE_SECRET']) vi.stubEnv(key, '');
  dir = mkdtempSync(join(tmpdir(), 'oncall-secret-'));
  envFile = join(dir, '.env');
  identity = { canManageHost: true, authSessionId: 'admin' };
  const csrfTokens = new ControlCsrfTokens();
  csrf = csrfTokens.mint('admin');
  server = createServer(async (req, res) => {
    const handled = await handleOncallServiceSecret(req, res, new URL(req.url!, base), { identity, csrfTokens, envFile, dataDir: dir });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
const get = () => fetch(base + endpoint);
const connectionPut = (body: unknown, token = csrf) => fetch(base + '/api/oncall-connection', {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: base, 'x-botmux-csrf': token }, body: JSON.stringify(body),
});

it('inherits existing platform defaults and keeps connection updates separate from the service credential', async () => {
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { tenantId: 12, endpoint: 'https://legacy.test/chat/', emailDomain: 'legacy.test' } }));
  writeFileSync(envFile, 'ONCALL_SERVICE_SECRET="keep-secret"\nOTHER=keep\n', { mode: 0o600 });
  const before = await (await fetch(base + '/api/oncall-connection?appId=app')).json();
  expect(before).toEqual({ ok: true, endpoint: 'https://legacy.test/chat/', emailDomain: 'legacy.test', restartRequired: false });
  expect(JSON.stringify(before)).not.toContain('keep-secret');
  const saved = await connectionPut({ endpoint: 'https://shared.test/chat/', emailDomain: 'shared.test' });
  expect(saved.status).toBe(200);
  expect(parse(readFileSync(envFile, 'utf8'))).toEqual({ ONCALL_SERVICE_SECRET: 'keep-secret', OTHER: 'keep', ONCALL_GROUP_ENDPOINT: 'https://shared.test/chat/', ONCALL_EMAIL_DOMAIN: 'shared.test' });
  expect((await (await fetch(base + '/api/oncall-connection?appId=app')).json()).endpoint).toBe('https://shared.test/chat/');
});

it('protects administrator connection settings with host authority, CSRF and validation', async () => {
  const valid = { endpoint: 'https://shared.test/chat/', emailDomain: 'shared.test' };
  expect((await connectionPut(valid, '')).status).toBe(403);
  expect((await connectionPut({ ...valid, endpoint: 'http://insecure.test' })).status).toBe(400);
  expect((await connectionPut({ ...valid, secret: 'invalid\nsecret' })).status).toBe(400);
  identity = { canManageHost: false, authSessionId: 'viewer' };
  expect((await fetch(base + '/api/oncall-connection')).status).toBe(403);
  expect((await connectionPut(valid)).status).toBe(403);
  expect(existsSync(envFile)).toBe(false);
});
const put = (body: unknown, headers: Record<string, string> = {}) => fetch(base + endpoint, {
  method: 'PUT', headers: { 'content-type': 'application/json', origin: base, 'x-botmux-csrf': csrf, ...headers },
  body: JSON.stringify(body),
});

it('shows an unconfigured connection as editable empty fields without creating deployment or bot files', async () => {
  const view = await (await fetch(base + '/api/oncall-connection')).json();
  expect(view).toEqual({ ok: true, endpoint: '', emailDomain: '', restartRequired: false });
  expect(existsSync(envFile)).toBe(false);
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { tenantId: 12 } }));
  expect(() => loadOncallGroupTarget(dir, 'app', readOncallDeploymentEnv(envFile))).toThrow('平台连接尚未配置');
});

it('makes saved connection and credential values available to readers with stale startup environments', async () => {
  const inherited = { ONCALL_GROUP_ENDPOINT: 'https://old.test/chat/', ONCALL_EMAIL_DOMAIN: 'old.test', ONCALL_SERVICE_SECRET: 'old-secret' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { tenantId: 12 } }));
  expect((await put({ secret: 'new-secret' })).status).toBe(200);
  expect((await connectionPut({ endpoint: 'https://new.test/chat/', emailDomain: 'new.test' })).status).toBe(200);
  for (const processSnapshot of [{ ...inherited }, { ...inherited }]) {
    const active = readOncallDeploymentEnv(envFile, processSnapshot);
    expect(loadOncallGroupTarget(dir, 'app', active)).toMatchObject({ endpoint: 'https://new.test/chat/', emailDomain: 'new.test' });
    expect(active.ONCALL_SERVICE_SECRET).toBe('new-secret');
    expect(processSnapshot).toEqual(inherited);
  }
});

it('commits connection and credential edits together and retains both old values on rejection', async () => {
  writeFileSync(envFile, 'ONCALL_GROUP_ENDPOINT=https://old.test/chat/\nONCALL_EMAIL_DOMAIN=old.test\nONCALL_SERVICE_SECRET=old-secret\n', { mode: 0o600 });
  const next = { endpoint: 'https://new.test/chat/', emailDomain: 'new.test', secret: 'new-secret' };
  expect((await connectionPut({ ...next, endpoint: 'http://invalid.test' })).status).toBe(400);
  expect(readOncallDeploymentEnv(envFile)).toMatchObject({ ONCALL_GROUP_ENDPOINT: 'https://old.test/chat/', ONCALL_SERVICE_SECRET: 'old-secret' });
  expect((await connectionPut(next)).status).toBe(200);
  expect(readOncallDeploymentEnv(envFile)).toMatchObject({ ONCALL_GROUP_ENDPOINT: next.endpoint, ONCALL_EMAIL_DOMAIN: next.emailDomain, ONCALL_SERVICE_SECRET: next.secret });
});

it('loads saved connections over inherited startup values without restarting', async () => {
  vi.stubEnv('ONCALL_GROUP_ENDPOINT', 'https://old.example.test/chat/');
  vi.stubEnv('ONCALL_EMAIL_DOMAIN', 'old.example.test');
  try {
    writeFileSync(envFile, 'ONCALL_GROUP_ENDPOINT=https://new.example.test/chat/\nONCALL_EMAIL_DOMAIN=new.example.test\n', { mode: 0o600 });
    const view = await (await fetch(base + '/api/oncall-connection')).json();
    expect(view).toMatchObject({ endpoint: 'https://new.example.test/chat/', emailDomain: 'new.example.test', restartRequired: false });
  } finally { vi.unstubAllEnvs(); }
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

  it('stores only the secret in a private env file, returns the saved password only to host administrators and leaves runtime env unchanged', async () => {
    const runtime = process.env.ONCALL_SERVICE_SECRET;
    expect(await (await get()).json()).toEqual({ ok: true, configured: false, secret: '', restartRequired: false });
    expect(existsSync(envFile)).toBe(false);
    const saved = await put({ secret: '  service-secret  ' });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(await saved.json()).toEqual({ ok: true, configured: true, restartRequired: false });
    expect(parse(readFileSync(envFile))).toEqual({ ONCALL_SERVICE_SECRET: 'service-secret' });
    if (process.platform !== 'win32') expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(await (await get()).json()).toEqual({ ok: true, configured: true, secret: 'service-secret', restartRequired: false });
    expect(process.env.ONCALL_SERVICE_SECRET).toBe(runtime);
  });

  it('loads a rotated credential immediately without modifying inherited process values', async () => {
    vi.stubEnv('ONCALL_SERVICE_SECRET', 'old-secret');
    try {
      expect((await put({ secret: 'new-secret' })).status).toBe(200);
      expect(await (await get()).json()).toMatchObject({ configured: true, restartRequired: false });
      expect(readOncallDeploymentEnv(envFile).ONCALL_SERVICE_SECRET).toBe('new-secret');
      expect(process.env.ONCALL_SERVICE_SECRET).toBe('old-secret');
      expect(await (await get()).json()).toMatchObject({ configured: true, restartRequired: false });
    } finally { vi.unstubAllEnvs(); }
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
    writeFileSync(envFile, 'ONCALL_SERVICE_SECRET=private-secret\n', { mode: 0o600 });
    for (const denied of [null, { canManageHost: false, authSessionId: 'viewer' }]) {
      identity = denied;
      const deniedRead = await get();
      expect(deniedRead.status).toBe(403);
      expect(await deniedRead.text()).not.toContain('private-secret');
      expect((await put({ secret: 'secret' })).status).toBe(403);
    }
    expect(parse(readFileSync(envFile))).toEqual({ ONCALL_SERVICE_SECRET: 'private-secret' });
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
