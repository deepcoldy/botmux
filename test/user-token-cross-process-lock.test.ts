import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

describe('user token cross-process replacement lock', () => {
  const roots: string[] = [];
  const children: import('node:child_process').ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(children.splice(0).map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('serializes final scope validation and write across two OAuth callback processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-user-token-lock-'));
    roots.push(root);
    const tokenDir = join(root, '.botmux', 'data');
    mkdirSync(tokenDir, { recursive: true });
    const appId = 'cli_cross_process_lock';
    const openId = 'ou_cross_process_lock';
    const tokenPath = join(tokenDir, `user-token-${appId}-${openId}.json`);
    const pausedPath = join(root, 'narrow-paused');
    const releasePath = join(root, 'release-narrow');
    writeFileSync(tokenPath, JSON.stringify({
      access_token: 'old',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      expires_at: '2099-01-01T00:00:00.000Z',
      refresh_expires_at: '2099-01-01T00:00:00.000Z',
      scope: 'im:message:readonly im:resource offline_access',
      appId,
      brand: 'feishu',
      openId,
    }));

    const workerPath = join(root, 'worker.mts');
    writeFileSync(workerPath, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createInterface } from 'node:readline';

      const role = process.env.ROLE!;
      const tokenPath = process.env.TOKEN_PATH!;
      let pauseNextTokenRead = false;
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        const value = originalRead.call(this, path, ...args);
        if (role === 'narrow' && pauseNextTokenRead && String(path) === tokenPath) {
          pauseNextTokenRead = false;
          fs.writeFileSync(process.env.PAUSED_PATH!, 'locked read completed');
          const deadline = Date.now() + 15_000;
          while (!fs.existsSync(process.env.RELEASE_PATH!)) {
            if (Date.now() > deadline) throw new Error('narrow barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return value;
      };
      syncBuiltinESMExports();

      const userToken = await import(${JSON.stringify(join(process.cwd(), 'src/utils/user-token.ts'))});
      const extras = role === 'broad'
        ? ['contact:user.base:readonly', 'docs:document.comment:read']
        : ['contact:user.base:readonly'];
      const { authUrl, state } = userToken.generateAuthUrl(
        ${JSON.stringify(appId)},
        'secret',
        'feishu',
        extras,
        ${JSON.stringify(openId)},
      );
      const scope = new URL(authUrl).searchParams.get('scope');
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({
          access_token: role,
          refresh_token: role + '-refresh',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope,
        }));
        if (String(url).endsWith('/user_info')) return new Response(JSON.stringify({
          code: 0,
          data: { open_id: ${JSON.stringify(openId)} },
        }));
        throw new Error('unexpected endpoint');
      };

      console.log(JSON.stringify({ phase: 'ready' }));
      for await (const line of createInterface({ input: process.stdin })) {
        if (line !== 'go') continue;
        pauseNextTokenRead = true;
        const message = await userToken.handleCallbackUrl(
          'http://127.0.0.1:9768/callback?code=fake&state=' + state,
        );
        console.log(JSON.stringify({ phase: 'done', ok: message?.startsWith('✅') }));
        break;
      }
    `);

    const spawnWorker = (role: 'narrow' | 'broad') => {
      const child = spawnNodeTsScript(workerPath, [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          ROLE: role,
          TOKEN_PATH: tokenPath,
          PAUSED_PATH: pausedPath,
          RELEASE_PATH: releasePath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      return {
        child,
        events: () => stdout.split('\n').flatMap(line => {
          try { return [JSON.parse(line) as { phase?: string; ok?: boolean }]; } catch { return []; }
        }),
        stderr: () => stderr,
      };
    };
    const waitFor = async (predicate: () => boolean, workers: Array<{ stderr: () => string }>) => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`worker timeout: ${workers.map(worker => worker.stderr()).join('\n')}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };

    const narrow = spawnWorker('narrow');
    const broad = spawnWorker('broad');
    await waitFor(
      () => narrow.events().some(event => event.phase === 'ready')
        && broad.events().some(event => event.phase === 'ready'),
      [narrow, broad],
    );

    narrow.child.stdin!.write('go\n');
    await waitFor(() => existsSync(pausedPath), [narrow, broad]);
    broad.child.stdin!.write('go\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(broad.events().some(event => event.phase === 'done')).toBe(false);

    writeFileSync(releasePath, 'release');
    await waitFor(
      () => narrow.events().some(event => event.phase === 'done')
        && broad.events().some(event => event.phase === 'done'),
      [narrow, broad],
    );

    const final = JSON.parse(readFileSync(tokenPath, 'utf8')) as { scope: string };
    expect(final.scope.split(/\s+/)).toContain('docs:document.comment:read');
    expect(narrow.events().find(event => event.phase === 'done')?.ok).toBe(true);
    expect(broad.events().find(event => event.phase === 'done')?.ok).toBe(true);
  }, 30_000);
});
