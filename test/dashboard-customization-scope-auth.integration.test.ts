/**
 * The 「自定义」 API's WeCom scope behind the real Dashboard: real gate, real
 * identity resolution, real route wiring (dashboard.ts) and real control CSRF.
 *
 * `?scope=wecom` is a WeCom surface like `/api/wecom/*`: only the host admin
 * (the local management cookie) gets it — a platform co-manager with
 * `dashboard:manage`, who passes the general gate, is answered 403
 * `wecom_host_admin_required`, reads included (an anonymous visitor never gets
 * past the gate) — and the host admin's writes pass the control CSRF check. The scope-less (Feishu) routes answer every one
 * of them exactly as before: same gate, no new header.
 *
 * HOME is a temp dir with an empty bot registry; only the static HTML asset is
 * replaced (so the shell carries the CSRF meta), everything else is the real
 * Dashboard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await releaseWecomCorePorts();
});

async function startDashboard() {
  const root = mkdtempSync(join(tmpdir(), 'customization-scope-auth-'));
  roots.push(root);
  const home = join(root, 'home');
  const configDir = join(home, '.botmux');
  const data = join(configDir, 'data');
  mkdirSync(data, { recursive: true });
  const bots = join(configDir, 'bots.json');
  writeFileSync(bots, '[]');
  writeFileSync(join(configDir, '.env'), '');
  writeFileSync(join(configDir, '.dashboard-secret'), 'customization-scope-auth-secret', { mode: 0o600 });
  const token = loadOrCreatePersistedToken(join(configDir, '.dashboard-token'));
  const htmlFile = join(root, 'index.html');
  writeFileSync(htmlFile, '<!doctype html><html><head></head><body>customization scope fixture</body></html>');

  const child = spawnTsScript(resolve('test/helpers/dashboard-with-fixture-index.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: bots,
      BOTMUX_ONBOARDING_TEST_INDEX: htmlFile, BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: String(await reserveWecomCorePort()), BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let logs = '';
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });

  const cookie = `botmux_dashboard_token=${token}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dashboard exited: ${logs}`);
    try {
      const port = Number(readFileSync(join(configDir, '.dashboard-port'), 'utf8'));
      if (port) {
        const base = `http://127.0.0.1:${port}`;
        if ((await fetch(`${base}/api/settings`, { headers: { cookie } })).ok) {
          // A bound platform with an unreachable URL: identities its proxy injects are accepted.
          writeFileSync(join(configDir, 'platform.json'), JSON.stringify({ platformUrl: 'http://127.0.0.1:1', machineId: 'isolated-machine', machineToken: 'isolated-token' }), { mode: 0o600 });
          return { base, cookie, data };
        }
      }
    } catch { /* still starting */ }
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error(`Dashboard did not start: ${logs}`);
}

async function send(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

/** The control CSRF token the Dashboard injects into the shell it serves this identity. */
async function csrfFor(base: string, headers: Record<string, string>): Promise<string> {
  const html = await (await fetch(`${base}/`, { headers })).text();
  const token = /<meta name="botmux-csrf" content="([^"]+)">/.exec(html)?.[1];
  expect(token, 'CSRF meta in the shell').toBeTruthy();
  return token!;
}

describe('Dashboard: the customization API\'s WeCom scope', () => {
  it('is the host admin\'s only, CSRF-checked for writes, while the Feishu scope answers as before', async () => {
    const { base, cookie, data } = await startDashboard();
    const hostAdmin = { cookie };
    const coManager = { cookie, 'x-botmux-role': 'owner', 'x-botmux-actor': 'on_isolated_manager', 'x-botmux-scopes': 'dashboard:manage' };
    const wecomStore = join(data, 'customizations-wecom', 'state.json');
    const prompt = (value: string) => ({ locale: 'zh', key: 'wecom.task.channel_group', value });
    const denied = { ok: false, error: 'wecom_host_admin_required' };

    // A platform co-manager passes the general gate (the Feishu scope reads and writes) …
    expect((await send(base, 'GET', '/api/customization', coManager)).status).toBe(200);
    expect((await send(base, 'PUT', '/api/customization/prompt', { ...coManager, origin: base }, { locale: 'zh', key: 'ai.routing.intro', value: 'CO' })).status).toBe(200);
    // … but is not told the WeCom scope exists, and cannot write it even with its own CSRF token.
    const coCsrf = await csrfFor(base, coManager);
    expect(await send(base, 'GET', '/api/customization?scope=wecom', coManager)).toEqual({ status: 403, body: denied });
    expect(await send(base, 'GET', '/api/customization/export?scope=wecom', coManager)).toEqual({ status: 403, body: denied });
    expect(await send(base, 'PUT', '/api/customization/prompt?scope=wecom', { ...coManager, origin: base, 'x-botmux-csrf': coCsrf }, prompt('FROM_CO_MANAGER')))
      .toEqual({ status: 403, body: denied });
    // An anonymous visitor (public read-only Dashboard) stays at the gate for both scopes.
    expect((await send(base, 'GET', '/api/customization', {})).status).toBe(401);
    const anonymous = await send(base, 'GET', '/api/customization?scope=wecom', {});
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain('wecom.task');
    expect(existsSync(wecomStore)).toBe(false);

    // The host admin reads it, and writes it only with the control CSRF token.
    expect((await send(base, 'GET', '/api/customization?scope=wecom', hostAdmin)).status).toBe(200);
    expect(await send(base, 'PUT', '/api/customization/prompt?scope=wecom', { ...hostAdmin, origin: base }, prompt('NO_TOKEN')))
      .toEqual({ status: 403, body: { ok: false, error: 'control_csrf_invalid' } });
    expect(await send(base, 'PUT', '/api/customization/prompt?scope=wecom', hostAdmin, prompt('NO_ORIGIN')))
      .toEqual({ status: 403, body: { ok: false, error: 'control_origin_forbidden' } });
    expect(existsSync(wecomStore)).toBe(false);
    const csrf = await csrfFor(base, hostAdmin);
    const written = await send(base, 'PUT', '/api/customization/prompt?scope=wecom', { ...hostAdmin, origin: base, 'x-botmux-csrf': csrf }, prompt('FROM_HOST_ADMIN'));
    expect(written.status).toBe(200);
    expect(JSON.parse(readFileSync(wecomStore, 'utf8')).promptOverrides).toEqual({ zh: { 'wecom.task.channel_group': 'FROM_HOST_ADMIN' } });

    // The Feishu scope needs no new header from the host admin either.
    expect((await send(base, 'PUT', '/api/customization/prompt', { ...hostAdmin, origin: base }, { locale: 'zh', key: 'ai.routing.intro', value: 'ADMIN' })).status).toBe(200);
  }, 60_000);
});
