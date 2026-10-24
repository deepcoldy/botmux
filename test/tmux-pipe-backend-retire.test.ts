/**
 * A managed TmuxPipeBackend.spawn() creates the detached session first and only
 * then sets up the FIFO / wake fd / pipe-pane. When a later step fails, the
 * worker retires the session THIS spawn created before it rolls the sandbox
 * tree back — exactly that session (by tmux session id), never a same-named
 * one another generation created in the meantime.
 *
 * Real tmux on a private socket (PATH shim); the wake-fd failure is the
 * backend's own test seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setStartupTmuxRetrySleepForTests, TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { isTransientStartupFailure } from '../src/core/worker-startup-retry.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

describe.skipIf(!realTmux)('TmuxPipeBackend.retireSessionCreatedBySpawn', () => {
  let dir: string;
  let socket: string;
  const saved: Record<string, string | undefined> = {};
  const name = 'bmx-retire01';
  const tmux = (...args: string[]) => spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8' });

  // The last session exiting takes the tmux server with it; a command that
  // immediately cold-starts a replacement can hit a transient connection error
  // in the window before the new server's socket is listening (observed as a
  // CI-only red on a loaded runner). Production retries exactly this error
  // class via isTransientStartupFailure — the test's bare tmux(...) setup calls
  // align with it through a short bounded retry instead of asserting on a raw
  // spawnSync with no resilience. Deterministic failures return immediately.
  const coldStartMaxAttempts = 5;
  type TmuxRunResult = {
    status: number | null;
    stderr?: Buffer | string;
    error?: (Error & { code?: string }) | null;
  };
  // spawnSync puts a connection error in stderr, but a spawn-level failure
  // (ENOENT / EAGAIN / ENOMEM) leaves stderr undefined and carries the only
  // useful signal in error.code — feed both to the production predicate so a
  // high-load EAGAIN is retried too.
  const failureReason = (result: TmuxRunResult): string => [
    result.stderr ? String(result.stderr) : '',
    result.error ? `${String(result.error.code ?? '')} ${String(result.error.message ?? '')}` : '',
  ].join(' ');
  const withColdStartRetry = <R extends TmuxRunResult>(run: () => R): R => {
    let result = run();
    for (let attempt = 1; attempt < coldStartMaxAttempts; attempt += 1) {
      if (result.status === 0 || !isTransientStartupFailure(failureReason(result))) break;
      // Synchronous short backoff on a fresh SAB (this file already blocks on
      // real tmux child processes); 25/100/225/400 ms covers the cold-start
      // window without slowing the common single-attempt path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt * attempt);
      result = run();
    }
    return result;
  };
  const tmuxWithColdStartRetry = (...args: string[]) => withColdStartRetry(() => tmux(...args));
  // Assertion for setup commands expected to succeed: throw with tmux's own
  // stderr attached, so a future red carries the failure text instead of an
  // unexplained "Expected: 0, Received: 1". A spawn-level failure has no
  // stderr — surface error.code (EAGAIN/ENOENT/…) instead of literal
  // "undefined".
  const assertTmuxOk = (
    result: TmuxRunResult & { signal: NodeJS.Signals | null },
    args: string[],
  ) => {
    if (result.status !== 0) {
      const errorSuffix = result.error
        ? ` error=${String(result.error.code ?? result.error.message ?? result.error)}`
        : '';
      const stderrText = result.stderr ? String(result.stderr).trim() : '';
      throw new Error(
        `tmux ${args.join(' ')} failed: status=${String(result.status)} signal=${String(result.signal)}${errorSuffix}`
          + (stderrText ? `\n${stderrText}` : ''),
      );
    }
    return result;
  };
  const expectTmuxOk = (...args: string[]) => assertTmuxOk(tmuxWithColdStartRetry(...args), args);
  const sessionId = (): string =>
    tmuxWithColdStartRetry('display-message', '-p', '-t', `=${name}:`, '#{session_id}').stdout.toString().trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-retire-'));
    socket = join(dir, 'socket');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
    for (const key of ['PATH', 'SHELL', 'TMUX', 'TMUX_PANE', 'BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL']) saved[key] = process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SHELL = '/bin/sh';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL = '1';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tmux('kill-server');
    rmSandboxScratch(dir);
  });

  const failedSpawn = (): TmuxPipeBackend => {
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    expect(() => backend.spawn('/bin/sh', ['-c', 'sleep 300'], {
      cwd: dir, cols: 80, rows: 24, env: { PATH: process.env.PATH!, HOME: dir },
    })).toThrow(/EMFILE: injected by test/);
    return backend;
  };

  it('kills the session the failed spawn created', () => {
    const backend = failedSpawn();
    expect(sessionId()).toMatch(/^\$\d+$/);
    expect(backend.retireSessionCreatedBySpawn()).toBe(true);
    expect(tmuxWithColdStartRetry('has-session', '-t', `=${name}`).status).not.toBe(0);
    // Nothing left to claim on a second call.
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
  });

  it.each([
    // The last session gone takes the server with it: the replacement lives on
    // a NEW server, where session ids restart at $0.
    ['on a new tmux server', false],
    ['on the same tmux server', true],
  ])('never kills a same-named session that replaced it %s', (_label, keepServer) => {
    const backend = failedSpawn();
    if (keepServer) expectTmuxOk('new-session', '-d', '-s', 'keeper', '--', 'sleep', '300');
    expectTmuxOk('kill-session', '-t', `=${name}`);
    expectTmuxOk('new-session', '-d', '-s', name, '--', 'sleep', '300');
    const foreign = sessionId();
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(sessionId()).toBe(foreign);
  });

  // The first new-session dies with a connection error, but meanwhile another
  // creator (a racing worker) made the same-named session; the retry then sees
  // "duplicate session". Nothing proves that session is ours: never claim it,
  // never retire it.
  it('never claims a same-named session its retry collided with', () => {
    const raced = join(dir, 'raced');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
if [ "$1" = new-session ] && [ ! -e '${raced}' ]; then
  : > '${raced}'
  '${realTmux}' -S '${socket}' new-session -d -s '${name}' -- sleep 300
  echo 'error connecting to ${socket} (Connection refused)' >&2
  exit 1
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
    setStartupTmuxRetrySleepForTests(() => {});
    try {
      const backend = failedSpawn();
      const competitor = sessionId();
      expect(competitor).toMatch(/^\$\d+$/);
      expect(backend.retireSessionCreatedBySpawn()).toBe(false);
      expect(sessionId()).toBe(competitor);
    } finally {
      setStartupTmuxRetrySleepForTests(null);
    }
  });

  // The tmux server exits between an identity check and a kill, and its
  // replacement hands the saved id ($0) to an unrelated session (any name).
  // The shim swaps the server right before the retire command reaches tmux; the
  // check and the kill being ONE server-side command is what keeps the
  // unrelated session alive.
  it('a server swapped right before the retire command cannot cost an unrelated session', () => {
    const swapFlag = join(dir, 'swap-server');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
if [ -e '${swapFlag}' ] && { [ "$1" = if-shell ] || [ "$1" = kill-session ]; }; then
  rm -f '${swapFlag}'
  '${realTmux}' -S '${socket}' kill-server
  while '${realTmux}' -S '${socket}' list-sessions >/dev/null 2>&1; do sleep 0.05; done
  '${realTmux}' -S '${socket}' new-session -d -s unrelated -- sleep 300 || exit 97
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
    const backend = failedSpawn();
    writeFileSync(swapFlag, '');
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(tmuxWithColdStartRetry('display-message', '-p', '-t', '=unrelated:', '#{session_id}').stdout.toString().trim()).toBe('$0');
  });

  it('claims nothing when its own new-session never succeeded', () => {
    const backend = new TmuxPipeBackend(name, { createSession: true, ownsSession: true });
    expectTmuxOk('new-session', '-d', '-s', 'unrelated', '--', 'sleep', '300');
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expectTmuxOk('has-session', '-t', '=unrelated');
  });

  // The retry helper itself is production-adjacent test infrastructure: prove
  // it actually retries the production transient-error class (without this the
  // cold-start red could come back silently), does not mask deterministic
  // failures, and that expectTmuxOk keeps tmux's stderr in its throw. The
  // injected failures arrive through a PATH shim (the test's own tmux()
  // helper bypasses PATH and talks to realTmux directly).
  it('setup helper retries transient cold-start errors through to success', () => {
    const attempts = join(dir, 'coldstart-attempts');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
n=0; [ -e '${attempts}' ] && n=$(cat '${attempts}')
n=$((n+1)); echo $n > '${attempts}'
if [ "$1" = new-session ] && [ "$n" -le 2 ]; then
  echo "server exited unexpectedly" >&2
  exit 1
fi
exec '${realTmux}' -S '${socket}' "$@"
`, { mode: 0o755 });
    const viaPath = (...commandArgs: string[]) =>
      withColdStartRetry(() => spawnSync('tmux', commandArgs, { encoding: 'utf8' }));
    expect(viaPath('new-session', '-d', '-s', 'cold', '--', 'sleep', '300').status).toBe(0);
    expect(Number(readFileSync(attempts, 'utf8').trim())).toBe(3);
    expectTmuxOk('has-session', '-t', '=cold');
  });

  it('setup helper does not retry a deterministic failure and keeps its stderr', () => {
    const calls = join(dir, 'deterministic-calls');
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
echo x >> '${calls}'
echo "marker-deterministic-failure-42" >&2
exit 2
`, { mode: 0o755 });
    const viaPath = (...commandArgs: string[]) =>
      withColdStartRetry(() => spawnSync('tmux', commandArgs, { encoding: 'utf8' }));
    const result = viaPath('list-clients');
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain('marker-deterministic-failure-42');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('expectTmuxOk throws with the tmux stderr attached', () => {
    expect(() => assertTmuxOk(
      { status: 1, signal: null, stderr: 'marker-stderr-in-throw-77' },
      ['list-clients'],
    )).toThrow(/marker-stderr-in-throw-77/);
  });

  it('setup helper retries a spawn-level EAGAIN carried by error.code with no stderr', () => {
    // Under runner load spawnSync itself can fail before exec: status=null,
    // stderr undefined, EAGAIN on error.code. The production predicate knows
    // EAGAIN; the helper must feed error.code to it, not just stderr.
    let calls = 0;
    const result = withColdStartRetry(() => {
      calls += 1;
      return calls <= 2
        ? { status: null, stderr: undefined, error: Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }) }
        : { status: 0, stderr: '' };
    });
    expect(result.status).toBe(0);
    expect(calls).toBe(3);
  });

  it('assertTmuxOk surfaces a spawn-level error.code instead of literal undefined', () => {
    let message = '';
    try {
      assertTmuxOk(
        { status: null, signal: null, stderr: undefined, error: Object.assign(new Error('try again'), { code: 'EAGAIN' }) },
        ['new-session'],
      );
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('error=EAGAIN');
    expect(message).not.toContain('undefined');
  });
});
