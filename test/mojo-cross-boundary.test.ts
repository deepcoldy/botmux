/**
 * Cross-boundary contract tests for the mojo backend.
 *
 * The cross-boundary scenarios review reproduced as failing probes (rounds 10 and
 * 11). They live here permanently: every one of them passed a unit-level suite
 * while being broken in production, because each involves a COMBINATION —
 * queueing, restart, lifecycle teardown, env layering — that a single-call test
 * cannot reach.
 *
 * Each test states which fix it isolates. Two of them (2 and 2b) look similar on
 * purpose: 2 covers a clear that rides the queue during a rebuild, 2b covers a
 * clear that settled BEFORE the rebuild, and only 2b fails if the
 * post-respawn credential restore is removed.
 *
 * Run:  pnpm vitest run test/mojo-cross-boundary.test.ts
 */
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { DaemonToWorker } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';

vi.setConfig({ testTimeout: 180_000 });

/**
 * A fake mojo that records, one line per invocation, the two things a hijack
 * would show up in: the JWT it ran with, and the session id botmux injected.
 *
 * BOTMUX_SESSION_ID is recorded because the reserved-key test asserts the actual
 * CONSEQUENCE (mojo.env is the highest-precedence layer, so an accepted reserved
 * key wins the merge and rewrites session routing). Recording only the JWT made
 * that test a restatement of the validator unit test.
 */
function writeJwtRecorder(root: string, dump: string): void {
  const bin = join(root, 'mojo');
  writeFileSync(bin, `#!/usr/bin/env bash
echo "[$X_JWT_TOKEN] sid=$BOTMUX_SESSION_ID" >> ${dump}
echo '{"type":"system","subtype":"init","session_id":"sid-x"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-x","warnings":[]}'
`);
  chmodSync(bin, 0o755);
}

/**
 * Every per-step budget below is multiplied by this.
 *
 * These steps spawn REAL worker processes, so under a full-suite run (5 workers
 * competing for CPU) a step that takes ~1s in isolation can take many times
 * that. The file-level testTimeout was already raised to 90s for exactly this
 * reason, but the individual waitFor budgets were not — which is what made these
 * tests intermittently red under load (~2/8 full runs) while passing standalone.
 * Scaled rather than hardcoded larger so a genuine hang still fails reasonably
 * fast when the file is run on its own.
 */
const LOAD_FACTOR = process.env.BOTMUX_TEST_LOAD_FACTOR
  ? Number(process.env.BOTMUX_TEST_LOAD_FACTOR)
  : 4;

async function waitFor(pred: () => boolean, ms: number, fail: () => string): Promise<void> {
  const deadline = Date.now() + ms * LOAD_FACTOR;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>(r => setTimeout(r, 100));
  }
  throw new Error(fail());
}

/** How many IPC messages of this type have arrived so far. Fences compare a
 *  BEFORE and AFTER count, because init emits the same readiness handshake that
 *  a respawn does — presence alone proves nothing. */
function countMsgs(h: Harness, type: string): number {
  return h.msgs.filter(m => m.type === type).length;
}

/** Raw recorder lines, e.g. `[tok] sid=abc`. */
function rawLines(dump: string): string[] {
  if (!existsSync(dump)) return [];
  const raw = readFileSync(dump, 'utf-8').trim();
  return raw ? raw.split('\n') : [];
}

/** Just the credential each invocation ran with, e.g. `[tok]`. */
function lines(dump: string): string[] {
  return rawLines(dump).map(l => l.replace(/ sid=.*$/, ''));
}

/** Just the injected session id each invocation ran with. */
function sessionIds(dump: string): string[] {
  return rawLines(dump).map(l => l.replace(/^.* sid=/, ''));
}

interface Harness {
  root: string;
  dump: string;
  child: ChildProcess;
  logs: string[];
  /** WorkerToDaemon IPC messages, so a test can fence on the worker's own
   *  readiness signals (`local_process_attestation` / `prompt_ready`) instead of
   *  grepping stdout for a log line. Always COUNT these rather than testing for
   *  presence: init emits the same handshake, so `some()` is satisfied before the
   *  event under test has happened. */
  msgs: Array<{ type: string; message?: string }>;
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
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
  const msgs: Array<{ type: string; message?: string }> = [];
  child.stdout?.on('data', c => logs.push(c.toString()));
  child.stderr?.on('data', c => logs.push(c.toString()));
  child.on('message', (m) => msgs.push(m as { type: string; message?: string }));
  return { root, dump, child, logs, msgs };
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

  it('2b. a lifecycle cancel after a respawn must not use a revived credential', async () => {
    // Isolates fix 2 (restoreMojoLivePatchAfterRespawn), which test 2 cannot:
    // there the clear rides on the queue item, so fix 1 alone saves it.
    //
    // Here the clear FULLY SETTLES first, then the backend is rebuilt, and the
    // next thing to touch the credential is a lifecycle op (`/close` →
    // destroySession → `mojo session cancel`) that carries no patch of its own.
    // The replacement backend is constructed from the init config, so without
    // carrying the credential state forward it cancels the remote session as the
    // OLD identity — exactly the case review reproduced.
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

      // 1. Clear, and let the turn settle COMPLETELY before restarting — that
      //    ordering is the whole point of this test, so waiting only for the dump
      //    to land is not enough: the worker must also report the turn finished.
      const readyBeforeClear = countMsgs(h, 'prompt_ready');
      h.child.send({ type: 'message', content: 'clear me', mojoLivePatch: { jwt: null } } as DaemonToWorker);
      await waitFor(
        () => lines(h.dump).length >= 2 && countMsgs(h, 'prompt_ready') > readyBeforeClear,
        30_000,
        () => `clear turn never settled (dump=${lines(h.dump).length}, `
          + `prompt_ready ${readyBeforeClear} -> ${countMsgs(h, 'prompt_ready')})\n${h.logs.join('')}`,
      );
      expect(lines(h.dump)[1]).toBe('[]');

      // 2. Rebuild the backend and fence on the worker's own IPC, not a stdout
      //    grep ('Spawning fresh CLI' is also logged at init, so includes() would
      //    be a vacuous precondition). A bare `restart` emits no `restart_result`
      //    (that is only sent for an attemptId-carrying restart), so the fence is
      //    the readiness handshake a fresh backend re-emits. BOTH signals are
      //    counted: init emits this same pair, so `some()` on prompt_ready would
      //    be satisfied by the init handshake and prove nothing.
      const attBeforeRestart = countMsgs(h, 'local_process_attestation');
      const readyBeforeRestart = countMsgs(h, 'prompt_ready');
      h.child.send({ type: 'restart' } as DaemonToWorker);
      await waitFor(
        () => countMsgs(h, 'local_process_attestation') > attBeforeRestart
          && countMsgs(h, 'prompt_ready') > readyBeforeRestart,
        40_000,
        () => `restart never re-emitted the readiness handshake `
          + `(attestation ${attBeforeRestart} -> ${countMsgs(h, 'local_process_attestation')}, `
          + `prompt_ready ${readyBeforeRestart} -> ${countMsgs(h, 'prompt_ready')})\n${h.logs.join('')}`,
      );
      // The restart's own teardown cancels via the OLD backend (already cleared),
      // so it must not be counted as progress — that is what made an earlier
      // version of this test pass vacuously.
      const afterTeardown = lines(h.dump).length;

      // 3. A turn on the REPLACEMENT backend carrying no patch of its own. This
      //    is what revives the credential without the restore, and it also gives
      //    the new backend a session id so the close below can actually cancel.
      h.child.send({ type: 'message', content: 'after respawn' } as DaemonToWorker);
      await waitFor(
        () => lines(h.dump).length > afterTeardown,
        30_000,
        () => `post-respawn turn never ran\n${h.logs.join('')}`,
      );
      const afterTurn = lines(h.dump).length;

      // 4. Now the lifecycle op review asked for, on a backend that has a remote
      //    session to cancel. Since P0-2 a request-less remote close is REFUSED
      //    outright (the legacy path silently cancelled remote sessions on every
      //    generic retirement), so `/close` → destroySession → `mojo session
      //    cancel` now travels as the prepare leg of prepare/commit — the only
      //    supported vehicle, and the same code path that reads the credential.
      h.child.send({ type: 'close', requestId: 'xb-close-1' } as DaemonToWorker);
      await waitFor(
        () => lines(h.dump).length > afterTurn,
        30_000,
        () => `close prepare never reached the CLI\n${lines(h.dump).join(' ')}\n${h.logs.join('')}`,
      );

      // Index-free: every credential use from the clear onwards must be empty.
      expect(lines(h.dump).slice(1)).not.toContain('[stale-A]');
    } finally { teardown(h); }
  });

  it('2c. a passthrough turn honours a cleared credential', async () => {
    // /compact, /model and friends arrive as `raw_input`, not `message`. That IPC
    // carried no credential snapshot and the worker applied none, yet for mojo it
    // becomes a REAL turn (MojoBackend has no sendText, so it falls through to
    // be.write()). A cleared or rotated JWT therefore did not apply to any of
    // these turns — the stale token was used again.
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

      // The rotation must arrive ON THE PASSTHROUGH ITSELF. Asserting it after a
      // preceding `message` that already carried the same snapshot proves nothing:
      // the backend state is identical either way, and an earlier draft of this
      // test passed with the worker-side apply removed.
      h.child.send({ type: 'raw_input', content: '/compact', mojoLivePatch: { jwt: 'rotated-B' } } as DaemonToWorker);
      await waitFor(() => lines(h.dump).length >= 2, 30_000, () => `passthrough never ran\n${h.logs.join('')}`);
      expect(lines(h.dump)[1]).toBe('[rotated-B]');

      // And a clear delivered the same way must stick.
      h.child.send({ type: 'raw_input', content: '/model', mojoLivePatch: { jwt: null } } as DaemonToWorker);
      await waitFor(() => lines(h.dump).length >= 3, 30_000, () => `second passthrough never ran\n${h.logs.join('')}`);
      expect(lines(h.dump)[2]).toBe('[]');
    } finally { teardown(h); }
  });

  it('3b. mojo.env cannot hijack a botmux-owned session variable', async () => {
    // mojo.env is the highest-precedence env layer, so a reserved key accepted by
    // the validator WINS over the worker's own BOTMUX_SESSION_ID — review
    // demonstrated it being rewritten to 'hijacked'. The end-to-end contract is
    // that this session never launches at all.
    //
    // The fence deliberately waits for EITHER outcome (a refusal, or a turn that
    // actually ran). An earlier version waited only for the refusal, so with the
    // fix reverted it died on a 25s poll timeout and the assertion below — the one
    // that actually names the hijack — never executed at all.
    const h = bootWorker({});
    try {
      h.child.send({
        type: 'init',
        sessionId: 'sid-xb', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: h.root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, env: { BOTMUX_SESSION_ID: 'hijacked' } },
        prompt: 'should never run', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => rawLines(h.dump).length > 0 || h.msgs.some(m => m.type === 'error'),
        20_000,
        () => `worker neither refused nor launched: `
          + `${JSON.stringify(h.msgs.map(m => m.type))}\n${h.logs.join('')}`,
      );

      // THE consequence assertion: no invocation may ever have run under the
      // injected session id.
      expect(sessionIds(h.dump), `recorder saw: ${rawLines(h.dump).join(' | ')}`)
        .not.toContain('hijacked');
      // Refused before any turn ran at all (the recorder writes one line per launch).
      expect(rawLines(h.dump)).toEqual([]);
      // And refused for the right reason, naming the key.
      const err = h.msgs.find(m => m.type === 'error')?.message ?? '';
      expect(err).toContain('mojo config is invalid');
      expect(err).toContain('BOTMUX_SESSION_ID');
      expect(err).toContain('botmux owns this variable');
    } finally { teardown(h); }
  });

  it('3c. an ALLOWED mojo.env var still cannot reach session routing', async () => {
    // Positive sentinel for the test above: proves the recorder really observes
    // BOTMUX_SESSION_ID, so `not.toContain('hijacked')` cannot pass merely because
    // the variable is never recorded. Uses a key the validator permits, so the
    // session actually launches.
    const h = bootWorker({ mojo: { env: { MY_TOKEN: 'fine' } } });
    try {
      h.child.send({
        type: 'init',
        sessionId: 'sid-xb', chatId: 'oc_x', rootMessageId: 'om_x',
        workingDir: h.root, cliId: 'mojo', backendType: 'mojo',
        backendConfig: { cloud: true, env: { MY_TOKEN: 'fine' } },
        prompt: 'a real turn', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);
      await waitFor(() => rawLines(h.dump).length >= 1, 20_000, () => `turn never ran\n${h.logs.join('')}`);
      expect(sessionIds(h.dump)[0]).toBe('sid-xb');
    } finally { teardown(h); }
  });

  it('3. wrapper resolution honours all three env layers, mojo.env highest', async () => {
    // buildWrappedLaunch resolved through locateOnPath, which reads the DAEMON's
    // env, so a per-bot PATH was ignored for the wrapper binary and the child ran
    // the ambient install instead.
    //
    // Asserted on the resolved prefix the production code logs, not on the
    // wrapper's own side effects: the resolution IS the behaviour under test, and
    // depending on a fixture shell's nested PATH lookup would test the fixture.
    const h = bootWorker({});
    const perBot = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-perbot-')));
    // THREE layers, because that is where the bug lived: the launcher merged only
    // ambient + bot env, so the highest-precedence `mojo.env.PATH` never won.
    const mojoDir = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-mojoenv-')));
    try {
      // Same wrapper name in all three places; only mojo.env's may be chosen.
      for (const dir of [h.root, perBot, mojoDir]) {
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
        backendConfig: { cloud: true, env: { PATH: `${mojoDir}:${perBot}:${h.root}` } },
        prompt: 'wrapped turn', larkAppId: 'app_xb', larkAppSecret: 'secret',
      } as DaemonToWorker);

      await waitFor(
        () => h.logs.join('').includes('Launch prefix: spawning'),
        25_000,
        () => `wrapper prefix never resolved\n${h.logs.join('')}`,
      );
      const all = h.logs.join('');
      // mojo.env is the highest layer, so its wrapper must win over BOTH the
      // bot-level and the ambient one.
      expect(all).toContain(`Launch prefix: spawning ${join(mojoDir, 'mywrap')}`);
      expect(all).not.toContain(`Launch prefix: spawning ${join(perBot, 'mywrap')}`);
      expect(all).not.toContain(`Launch prefix: spawning ${join(h.root, 'mywrap')}`);
    } finally {
      rmSync(mojoDir, { recursive: true, force: true });
      rmSync(perBot, { recursive: true, force: true });
      teardown(h);
    }
  });
});
