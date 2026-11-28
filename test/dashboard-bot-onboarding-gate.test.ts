/**
 * The「添加机器人」routes run behind the real Dashboard gate.
 *
 * Feishu onboarding keeps its original gate (global auth + cross-site origin
 * check): SPA tabs opened before an upgrade and the permission-recovery helpers
 * do not send `x-botmux-csrf`, so those requests must still reach their
 * handlers. The WeCom onboarding namespace (`wecom-*` jobs and `start` with
 * `platform: 'wecom'`) additionally requires the control CSRF token.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A real Dashboard with a disposable HOME and an empty Feishu roster. */
async function startDashboard(): Promise<{ base: string; cookie: string }> {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-gate-'));
  roots.push(root);
  const home = join(root, 'home');
  const configDir = join(home, '.botmux');
  const data = join(configDir, 'data');
  mkdirSync(data, { recursive: true });
  const bots = join(configDir, 'bots.json');
  writeFileSync(bots, '[]');
  writeFileSync(join(configDir, '.env'), '');
  writeFileSync(join(configDir, '.dashboard-secret'), 'onboarding-gate-secret', { mode: 0o600 });
  const token = loadOrCreatePersistedToken(join(configDir, '.dashboard-token'));
  const htmlFile = join(root, 'index.html');
  writeFileSync(htmlFile, '<!doctype html><html><head></head><body>onboarding gate fixture</body></html>');

  const child = spawnTsScript(resolve('test/helpers/dashboard-with-fixture-index.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: bots,
      BOTMUX_ONBOARDING_TEST_INDEX: htmlFile, BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: String(await reserveWecomCorePort()),
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
        if ((await fetch(`${base}/api/settings`, { headers: { cookie } })).ok) return { base, cookie };
      }
    } catch { /* still starting */ }
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error(`Dashboard did not start: ${logs}`);
}

async function post(base: string, path: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('Dashboard onboarding gate', () => {
  it('lets Feishu onboarding requests without a CSRF token reach their handlers, and keeps WeCom onboarding behind it', async () => {
    const { base, cookie } = await startDashboard();
    // Same-origin page without the CSRF header (a tab from before an upgrade),
    // and a non-browser helper that sends no Origin at all.
    for (const headers of [{ cookie, origin: base }, { cookie }]) {
      expect(await post(base, '/api/bot-onboarding/recover-permissions', headers, {}))
        .toEqual({ status: 400, body: { ok: false, error: 'permission_recovery_target_invalid' } });
      expect(await post(base, '/api/bot-onboarding/bot_missing/complete-scope-propagation', headers, {}))
        .toEqual({ status: 400, body: { ok: false, error: 'permission_recovery_target_invalid' } });
      expect(await post(base, '/api/bot-onboarding/bot_missing/owner', headers, { owner: 'someone@example.com' }))
        .toMatchObject({ status: 404, body: { error: 'unknown_onboarding_job' } });
      expect(await post(base, '/api/bot-onboarding/start', headers, { cliId: 'not-a-real-cli-for-gate-test' }))
        .toMatchObject({ status: 400, body: { error: 'invalid_cli' } });
    }
    const job = await fetch(`${base}/api/bot-onboarding/bot_missing`, { headers: { cookie } });
    expect(job.status).toBe(404);

    // WeCom onboarding still requires the control CSRF token.
    const wecomStart = await post(base, '/api/bot-onboarding/start', { cookie, origin: base }, { platform: 'wecom' });
    expect(wecomStart.status).toBe(403);
    expect(wecomStart.body.error).toBe('control_csrf_invalid');
    const wecomCancel = await post(base, '/api/bot-onboarding/wecom-00000000-0000-4000-8000-000000000000/cancel',
      { cookie, origin: base }, {});
    expect(wecomCancel.status).toBe(403);
    expect(wecomCancel.body.error).toBe('control_csrf_invalid');
    expect((await fetch(`${base}/api/bot-onboarding/wecom-jobs`, { headers: { cookie } })).status).toBe(200);
  }, 30_000);
});
