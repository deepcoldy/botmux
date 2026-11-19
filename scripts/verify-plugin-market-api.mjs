import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-plugin-market-api.mjs <compiled-binary>');
const binary = resolve(process.argv[2]);
const home = await mkdtemp(join(tmpdir(), 'botmux-plugin-api-'));
await mkdir(join(home, '.botmux'));
await writeFile(join(home, '.botmux/bots.json'), '[]');
await writeFile(join(home, '.botmux/.dashboard-token'), 'isolated-api-fixture-token', { mode: 0o600 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_')
  && !['BOTMUX', 'BOTS_CONFIG', 'SESSION_DATA_DIR', 'PM2_HOME', 'PLUGIN_PM2_HOME', 'BUN_BE_BUN'].includes(key)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, BOTS_CONFIG: join(home, '.botmux/bots.json'),
  SESSION_DATA_DIR: join(home, '.botmux/data'),
  BOTMUX_DASHBOARD_PORT: '19892', BOTMUX_DAEMON_IPC_BASE_PORT: '19960', BOTMUX_WEB_PROXY_BASE_PORT: '19820',
});
const child = spawn(binary, ['__dashboard'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
child.stdout.on('data', data => logs.push(String(data)));
child.stderr.on('data', data => logs.push(String(data)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let base;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const port = (await readFile(join(home, '.botmux/.dashboard-port'), 'utf8')).trim();
      const candidate = `http://127.0.0.1:${port}`;
      if ((await fetch(candidate, { signal: AbortSignal.timeout(1000) })).ok) { base = candidate; break; }
    } catch {}
    assert.equal(child.exitCode, null, 'Scratch Dashboard exited early');
    await delay(150);
  }
  assert.ok(base, 'Scratch Dashboard did not bind');
  const token = (await readFile(join(home, '.botmux/.dashboard-token'), 'utf8')).trim();
  const cookie = `botmux_dashboard_token=${token}`;
  const shell = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="botmux-csrf" content="([^"]+)"/.exec(shell)?.[1];
  assert.ok(csrf, 'Authenticated shell did not include CSRF token');
  assert.ok(shell.includes('/assets/app.css'));
  assert.equal((await fetch(`${base}/assets/app.css`)).status, 200);
  assert.equal((await fetch(`${base}/api/plugins/market`)).status, 401);
  const post = (action, body, extra = {}) => fetch(`${base}/api/plugins/market/${action}`, {
    method: 'POST', headers: { Cookie: cookie, Origin: base, 'x-botmux-csrf': csrf, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body), signal: AbortSignal.timeout(40000),
  });
  assert.equal((await post('uninstall', {}, { 'x-botmux-csrf': '' })).status, 403);
  assert.equal((await post('uninstall', {}, { Origin: 'https://unrelated.example' })).status, 403);
  const catalogResponse = await fetch(`${base}/api/plugins/market`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) });
  const catalog = await catalogResponse.json();
  assert.ok(catalog.available && catalog.items.some(item => item.id === 'agent-chrome'));
  const prepared = await post('prepare', { id: 'agent-chrome' });
  assert.equal(prepared.status, 200);
  const { plan } = await prepared.json();
  assert.equal(plan.packageName, '@botmux-ai/plugin-agent-chrome');
  assert.equal(plan.expectedState, null);
  assert.match(plan.integrity, /^sha512-/);
  assert.equal((await post('install', { nonce: plan.nonce, confirm: false })).status, 409);
  await writeFile(join(home, '.botmux/.dashboard-token'), 'fixture-rotated-token');
  assert.equal((await post('install', { nonce: plan.nonce, confirm: true })).status, 401);
  const result = {
    passed: true, compiledDashboard: true, isolatedHome: true,
    cases: ['embedded CSS', 'owner-only catalog', 'CSRF', 'origin', 'live catalog', 'real npm version',
      'explicit confirmation', 'rotated owner token rejected'],
    packageVersion: plan.version, installedPackages: 0,
  };
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(logs.join(''));
  throw error;
} finally {
  child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  await rm(home, { recursive: true, force: true });
}
