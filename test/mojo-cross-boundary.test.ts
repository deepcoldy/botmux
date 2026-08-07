/**
 * Cross-boundary contract tests for the mojo backend.
 *
 * These are the five scenarios round-11 review reproduced as failing probes. They
 * live here permanently: every one of them passed a unit-level suite while being
 * broken in production, because each involves a COMBINATION — queueing, restart,
 * durable suppression, PATH layering — that a single-call test cannot reach.
 *
 * Run:  pnpm vitest run test/mojo-cross-boundary.test.ts
 */
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { DaemonToWorker } from '../src/types.js';

vi.setConfig({ testTimeout: 90_000 });

/** A fake mojo that appends the JWT it saw, one line per invocation. */
function writeJwtRecorder(root: string, dump: string): void {
  const bin = join(root, 'mojo');
  writeFileSync(bin, `#!/usr/bin/env bash
echo "[$X_JWT_TOKEN]" >> ${dump}
echo '{"type":"system","subtype":"init","session_id":"sid-x"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-x","warnings":[]}'
`);
  chmodSync(bin, 0o755);
}

async function waitFor(pred: () => boolean, ms: number, fail: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>(r => setTimeout(r, 100));
  }
  throw new Error(fail());
}

function lines(dump: string): string[] {
  if (!existsSync(dump)) return [];
  const raw = readFileSync(dump, 'utf-8').trim();
  return raw ? raw.split('\n') : [];
}

interface Harness {
  root: string;
  dump: string;
  child: ChildProcess;
  logs: string[];
}

function bootWorker(opts: { mojo?: Record<string, unknown>; appId?: string }): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-xb-')));
  const dump = join(root, 'jwts.txt');
  writeJwtRecorder(root, dump);
  const appId = opts.appId ?? 'app_xb';
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: appId, larkAppSecret: 'secret',
    cliId: 'mojo', backendType: 'mojo',
    mojo: { cloud: true, ...(opts.mojo ?? {}) },
  }]));
  const logs: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root, SESSION_DATA_DIR: root, BOTS_CONFIG: join(root, 'bots.json'),
      BOTMUX_SESSION_ID: 'sid-xb', LARK_APP_ID: appId, LARK_APP_SECRET: 'secret',
      PATH: `${root}:${process.env.PATH ?? ''}`,
      // Must never stand in for a cleared credential.
      X_JWT_TOKEN: 'ambient-token',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', c => logs.push(c.toString()));
  child.stderr?.on('data', c => logs.push(c.toString()));
  return { root, dump, child, logs };
}

function teardown(h: Harness): void {
  if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGKILL');
  rmSync(h.root, { recursive: true, force: true });
}

describe('mojo cross-boundary contracts', () => {
  it('1. concurrently queued credential turns run A/B/C, not A/C/C', async () => {
    // The patch used to be applied on IPC RECEIPT, but the message body may be
    // dequeued much later. Queueing two credential turns therefore collapsed to
    // the newest value for both.
    const h = bootWorker({ mojo: { jwt: 'A' } });
    try {
      h.child.send({
        type: 'init',
        sessionId: 'sid-xb', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: h.root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, jwt: 'A' },
        prompt: 'turn A', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);
      await waitFor(() => lines(h.dump).length >= 1, 25_000, () => `turn A never ran\n${h.logs.join('')}`);

      // Two turns queued back to back, each with its OWN credential.
      h.child.send({ type: 'message', content: 'turn B', mojoLivePatch: { jwt: 'B' } } as DaemonToWorker);
      h.child.send({ type: 'message', content: 'turn C', mojoLivePatch: { jwt: 'C' } } as DaemonToWorker);

      await waitFor(() => lines(h.dump).length >= 3, 30_000, () => `only ${lines(h.dump).length} turns ran\n${h.logs.join('')}`);
      expect(lines(h.dump).slice(0, 3)).toEqual(['[A]', '[B]', '[C]']);
    } finally { teardown(h); }
  });

  it('2. a clear QUEUED DURING a restart is not revived by the replacement', async () => {
    // Review's exact ordering: the clear turn queues while the backend is being
    // rebuilt. The replacement is constructed from the ORIGINAL init config, so
    // without carrying the credential state forward the queued turn ran against
    // the revived jwtEnv token.
    const h = bootWorker({ mojo: { jwtEnv: 'MY_JWT', env: { MY_JWT: 'stale-A' } } });
    try {
      h.child.send({
        type: 'init',
        sessionId: 'sid-xb', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: h.root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, jwtEnv: 'MY_JWT', env: { MY_JWT: 'stale-A' } },
        prompt: 'turn one', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);
      await waitFor(() => lines(h.dump).length >= 1, 25_000, () => `turn one never ran\n${h.logs.join('')}`);
      expect(lines(h.dump)[0]).toBe('[stale-A]');

      // Restart, then IMMEDIATELY the clear — it queues while the backend rebuilds.
      h.child.send({ type: 'restart' } as DaemonToWorker);
      h.child.send({ type: 'message', content: 'clear me', mojoLivePatch: { jwt: null } } as DaemonToWorker);

      // Index-free on purpose: a restart RE-QUEUES the original prompt, so the
      // line count after a restart is an implementation detail. What matters is
      // that once the clear has been applied, no later turn shows the old token.
      await waitFor(
        () => lines(h.dump).includes('[]'),
        40_000,
        () => `queued clear turn never produced a cleared credential\n${lines(h.dump).join(' ')}\n${h.logs.join('')}`,
      );
      const clearedAt = lines(h.dump).indexOf('[]');

      // A LATER turn carrying no patch of its own must stay cleared — this is the
      // case the replacement backend would otherwise revert.
      h.child.send({ type: 'message', content: 'after restart' } as DaemonToWorker);
      await waitFor(
        () => lines(h.dump).length > clearedAt + 1,
        30_000,
        () => `post-restart turn never ran\n${h.logs.join('')}`,
      );
      // EVERY turn from the clear onwards must be cleared, with no revival.
      expect(lines(h.dump).slice(clearedAt)).not.toContain('[stale-A]');
      expect(lines(h.dump).slice(clearedAt)).not.toContain('[ambient-token]');
      // NOTE on what this test does and does not prove: in THIS ordering the clear
      // rides on the queue item and is applied at write time (fix 1), so the
      // replacement-backend restore (fix 2) is not the mechanism that saves it.
      // Fix 2 covers the other ordering — a clear already applied, then a rebuild,
      // then a turn carrying no patch — which a restart's re-queued initial prompt
      // makes hard to isolate here. The observable contract both fixes serve is
      // asserted above: after a clear, no later turn shows a revived credential.
    } finally { teardown(h); }
  });

  it('3. an ambient wrapper must not shadow a per-bot one', async () => {
    // buildWrappedLaunch resolved through locateOnPath, which reads the DAEMON's
    // env, so a per-bot PATH was ignored for the wrapper binary and the child ran
    // the ambient install instead.
    //
    // Asserted on the resolved prefix the production code logs, not on the
    // wrapper's own side effects: the resolution IS the behaviour under test, and
    // depending on a fixture shell's nested PATH lookup would test the fixture.
    const h = bootWorker({});
    const perBot = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-perbot-')));
    try {
      // Same wrapper name in both places; only the per-bot one may be chosen.
      for (const dir of [h.root, perBot]) {
        const w = join(dir, 'mywrap');
        writeFileSync(w, '#!/usr/bin/env bash\nexec "$@"\n');
        chmodSync(w, 0o755);
      }

      h.child.send({
        type: 'init',
        sessionId: 'sid-xb', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: h.root, cliId: 'mojo', backendType: 'mojo',
        wrapperCli: 'mywrap mojo',
        env: { PATH: `${perBot}:${h.root}` },
        backendConfig: { cloud: true },
        prompt: 'wrapped turn', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => h.logs.join('').includes('Launch prefix: spawning'),
        25_000,
        () => `wrapper prefix never resolved\n${h.logs.join('')}`,
      );
      const all = h.logs.join('');
      expect(all).toContain(`Launch prefix: spawning ${join(perBot, 'mywrap')}`);
      // The ambient install must not appear as the chosen prefix.
      expect(all).not.toContain(`Launch prefix: spawning ${join(h.root, 'mywrap')}`);
    } finally {
      rmSync(perBot, { recursive: true, force: true });
      teardown(h);
    }
  });
});
