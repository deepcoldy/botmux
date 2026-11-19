import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

it('requires owner confirmation, reports retained backups on build failure, and accepts a freshly previewed retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-force-update-'));
  const home = join(root, 'home'), upstream = join(root, 'upstream'), repo = join(root, 'repo');
  const config = join(home, '.botmux'), data = join(config, 'data');
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, stdio: 'ignore' });
  mkdirSync(upstream); mkdirSync(data, { recursive: true }); mkdirSync(join(config, 'bin'));
  git(upstream, 'init'); writeFileSync(join(upstream, 'package.json'), '{"name":"botmux"}');
  writeFileSync(join(upstream, 'feature.txt'), 'official'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'official');
  git(root, 'clone', upstream, repo); writeFileSync(join(repo, 'feature.txt'), 'custom draft');
  writeFileSync(join(config, 'bots.json'), '[]'); writeFileSync(join(config, '.data-dir'), data, { mode: 0o600 });
  writeFileSync(join(config, 'bin/botmux'), `#!/bin/sh\nexec "/bin/bun" "${repo}/dist/cli.js" "$@"\n`);
  try {
    const child = spawnSyncBunTsEvalWithRepoImports(`
      import { mock } from 'bun:test';
      import { join } from 'node:path';
      import { homedir } from 'node:os';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { loopbackFetch } from './src/core/loopback-fetch.js';
      import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
      const info = { ...await import('./src/utils/install-info.js') };
      mock.module('./src/utils/install-info.js', () => ({ ...info, isLocalDevInstall: () => true }));
      const spawn = { ...await import('./src/dashboard/managed-spawn.js') };
      let buildFails = true;
      const steps = [];
      mock.module('./src/dashboard/managed-spawn.js', () => ({ ...spawn,
        runLocalDevStep: async (_dir, command, args) => {
          steps.push([command, args]);
          if (args[0] === 'run' && buildFails) throw Object.assign(new Error('fixture build failed'), { code: 128 });
        },
      }));
      const token = loadOrCreatePersistedToken(join(homedir(), '.botmux/.dashboard-token'));
      await import('./src/index-dashboard.js');
      let port;
      for (let i=0; i<500 && !port; i++) {
        try { port=Number(readFileSync(join(homedir(), '.botmux/.dashboard-port'), 'utf8')); }
        catch { await new Promise(r => setTimeout(r,20)); }
      }
      async function request(path, body, auth=true) {
        const response = await loopbackFetch('http://127.0.0.1:'+port+path, {
          method:'POST', headers:{ ...(auth ? {cookie:'botmux_dashboard_token='+token} : {}), ...(body ? {'content-type':'application/json'} : {}) },
          ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000),
        });
        return {status:response.status, body:await response.json().catch(() => ({}))};
      }
      const unauthorized=await request('/api/update/local-dev/preview',null,false);
      const dirty=await request('/api/update/run');
      const invalid=await request('/api/update/run',{forceLocal:true,previewToken:'forged'});
      const preview=await request('/api/update/local-dev/preview');
      const failed=await request('/api/update/run',{forceLocal:true,previewToken:preview.body.token});
      const replay=await request('/api/update/run',{forceLocal:true,previewToken:preview.body.token});
      writeFileSync(join(process.env.FORCE_TEST_REPO,'feature.txt'),'retry draft');
      const retryPreview=await request('/api/update/local-dev/preview');
      buildFails=false;
      const retried=await request('/api/update/run',{forceLocal:true,previewToken:retryPreview.body.token});
      console.log('FORCE_RESULTS='+JSON.stringify({unauthorized,dirty,invalid,failed,replay,retried,steps}));
      process.exit(0);
    `, { cwd: process.cwd(), encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL', env: {
      ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: join(config, 'bots.json'),
      BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false', FORCE_TEST_REPO: repo,
    } });
    expect(child.status, String(child.stderr)).toBe(0);
    const line = String(child.stdout).split('\n').find(x => x.startsWith('FORCE_RESULTS='));
    expect(line, String(child.stdout)).toBeDefined();
    const results = JSON.parse(line!.slice('FORCE_RESULTS='.length));
    expect(results).toMatchObject({
      unauthorized: { status: 401 }, dirty: { status: 409, body: { error: 'dirty_worktree' } },
      invalid: { status: 409, body: { error: 'local_update_preview_stale' } },
      failed: { status: 500, body: { error: 'install_failed', backupRef: expect.stringMatching(/^refs\/botmux\/update-backups\//) } },
      replay: { status: 409, body: { error: 'local_update_preview_stale' } },
      retried: { status: 200, body: { ok: true, restartRequired: true, backupRef: expect.any(String) } },
    });
    expect(results.steps).toEqual([['bun', ['install', '--frozen-lockfile']], ['bun', ['run', 'build']],
      ['bun', ['install', '--frozen-lockfile']], ['bun', ['run', 'build']]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
