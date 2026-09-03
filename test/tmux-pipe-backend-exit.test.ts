/**
 * Regression: tearing down the fifo reader must not wedge process exit.
 *
 * THE BUG (production incident): TmuxPipeBackend opens its fifo O_RDWR and
 * reads it with a libuv threadpool read that is deliberately BLOCKING (see the
 * O_NONBLOCK rationale in spawn()). `readStream.destroy()` detaches the JS
 * stream but leaves that thread parked inside the kernel `read()`, and since we
 * hold the write end ourselves the read never sees EOF. `process.exit()` then
 * blocks forever in uv__threadpool_cleanup joining the thread — with the event
 * loop already stopped, so the process cannot self-kill on a timer. Every
 * worker of one daemon ended up stuck mid-exit; the daemon still believed they
 * were live and kept delivering turns, so every user message came back as
 * "Worker 未能接收这条消息" (worker.input_delivery_failed), permanently.
 *
 * WHY A CHILD PROCESS: the failure IS "the process never exits". Nothing
 * in-process can observe it — an in-test assertion would itself hang. So the
 * only honest probe is to spawn a real process and assert it terminates.
 *
 * WHY tmux IS FAKED: the production code targets the DEFAULT tmux socket,
 * shared with every live daemon on this machine. A fake `tmux` first on PATH
 * keeps the real fifo/read/teardown path intact while touching no real server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { spawnTsScript, tsRunnerPrefix, isBunRuntime } from './helpers/ts-runner.js';

const FIXTURE = resolve(__dirname, 'fixtures/tmux-pipe-exit-fixture.ts');
// Generous vs. the ~250ms the fixture needs: on a loaded box a slow start must
// not look like a wedge. The wedged variant hangs forever, so a false PASS is
// impossible in the other direction.
const EXIT_TIMEOUT_MS = 20_000;

let fakeBinDir: string;
let failingBinDir: string;
/** Static `ulimit -n 128; exec "$@"` wrapper — see the emfile note in runFixture. */
let fdLimitWrapper: string;
let wrapperDir: string;

/** Run the fixture; resolve with how it ended. `timedOut` means it wedged. */
type FixtureMode = 'real' | 'nowake' | 'paneexit' | 'full' | 'spawnfail' | 'unlinked' | 'emfile' | 'directexit' | 'wakefail';

async function runFixture(mode: FixtureMode): Promise<{
  timedOut: boolean;
  code: number | null;
  stdout: string;
}> {
  const bin = mode === 'spawnfail' ? failingBinDir : fakeBinDir;
  const extraEnv = mode === 'wakefail' ? { BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL: '1' } : {};
  // The emfile case fills the fd table, so it MUST run under a low
  // RLIMIT_NOFILE. This box allows 1,048,576 fds: opening a million of them
  // burns kernel file objects, can push the shared host toward a global ENFILE,
  // and would disturb the ~275 live daemon workers running alongside the tests.
  //
  // The limit is applied by a STATIC wrapper script (`ulimit -n 128; exec "$@"`)
  // rather than an inline `sh -c` string. Same effect, but nothing dynamic is
  // ever concatenated into shell source — the interpreter path arrives as a
  // quoted argv element — which is what CodeQL flagged about the inline form.
  const child = mode === 'emfile'
    ? spawn(
      fdLimitWrapper,
      [tsRunnerPrefix().command, ...tsRunnerPrefix().prefixArgs, FIXTURE, mode],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv, PATH: `${bin}:${process.env.PATH ?? ''}` } },
    )
    : spawnTsScript(FIXTURE, [mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
  let stdout = '';
  child.stdout?.on('data', (b) => { stdout += String(b); });
  child.stderr?.on('data', (b) => { stdout += String(b); });

  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ timedOut: true, code: null, stdout });
    }, EXIT_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code, stdout });
    });
  });
}

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'botmux-fake-tmux-'));
  const fake = join(fakeBinDir, 'tmux');
  // `pipe-pane` must succeed (exit 0) or spawn() throws before a fifo exists.
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);

  // A tmux whose pipe-pane fails NON-retryably, so spawn() gives up at once
  // instead of sleeping through the retry ladder: a numeric exit status plus
  // stderr that is not a server-level error reads as "the server answered and
  // deterministically rejected" (isRetryableStartupTmuxFailure).
  failingBinDir = mkdtempSync(join(tmpdir(), 'botmux-failing-tmux-'));
  const failing = join(failingBinDir, 'tmux');
  writeFileSync(
    failing,
    '#!/bin/sh\n'
    + 'case "$1" in\n'
    + "  pipe-pane) echo \"can't find pane: bmx-exit-fixture\" >&2; exit 1 ;;\n"
    + '  *) exit 0 ;;\n'
    + 'esac\n',
  );
  chmodSync(failing, 0o755);

  // Static wrapper: constant script body, everything dynamic arrives as argv.
  // Its own dir, NOT fakeBinDir — that one goes on the child's PATH and must
  // hold only the fake `tmux`.
  wrapperDir = mkdtempSync(join(tmpdir(), 'botmux-fdlimit-'));
  fdLimitWrapper = join(wrapperDir, 'with-low-fd-limit.sh');
  writeFileSync(fdLimitWrapper, '#!/bin/sh\nulimit -n 128\nexec "$@"\n');
  chmodSync(fdLimitWrapper, 0o755);
});

afterAll(() => {
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(failingBinDir, { recursive: true, force: true });
  rmSync(wrapperDir, { recursive: true, force: true });
});

describe('TmuxPipeBackend fifo teardown', () => {
  it('lets the process exit after kill() (does not wedge in uv_thread_join)', async () => {
    const r = await runFixture('real');

    // Order matters: assert the fixture got far enough BEFORE judging the exit,
    // so a fixture that died early can never masquerade as a clean pass.
    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.stdout).toContain('EXITING');
    expect(r.stdout).toContain('LEAKED_READERS=0 FIFO_LEFT=false');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // The OTHER teardown site. kill() and handlePaneExit() each own a copy of
  // this logic, so a fix landed on only one of them would still ship the bug
  // on the pane-vanished path.
  it('lets the process exit after handlePaneExit() too', async () => {
    const r = await runFixture('paneexit');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.stdout).toContain('EXITING');
    expect(r.stdout).toContain('LEAKED_READERS=0 FIFO_LEFT=false');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // The wake-up write MUST be non-blocking. At teardown nobody drains the pipe,
  // so if tmux left it full a blocking write parks forever — the same wedge,
  // moved one line down. Only this case tells the two implementations apart.
  it('still exits when the pipe is full at teardown (wake-up write must not block)', async () => {
    const r = await runFixture('full');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // A THIRD wedge path, distinct from the two teardown sites: spawn() opens the
  // fifo (step 2) before attaching pipe-pane (step 3). If step 3 fails
  // terminally, spawn() throws — and the caller never got a backend handle, so
  // nobody can call kill(). spawn() has to clean up after itself or the parked
  // read outlives the failed spawn and wedges exit.
  it('lets the process exit when spawn() fails after opening the fifo', async () => {
    const r = await runFixture('spawnfail');

    expect(r.stdout).toContain('SPAWN_THREW');
    // Exit alone cannot judge this any more — the exit hook would rescue a
    // leaked reader too. Assert the cleanup itself: nothing left registered,
    // no fifo left on disk.
    expect(r.stdout).toContain('LEAKED_READERS=0 FIFO_LEFT=false');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // Blocker found in review: several production exit paths never call kill() —
  // sendFatalWorkerErrorAndExit(), the uncaughtException / unhandledRejection
  // handlers, and the existing-App-Server parent-exit branch all exit directly.
  // Fixing only the teardown sites would leave the original wedge reachable, so
  // the module installs a process-exit hook. This is its regression.
  it('lets the process exit with a LIVE backend and no teardown call at all', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-')));
    const r = await runFixture('directexit');

    expect(r.stdout).toContain('DIRECT_EXIT');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    // A named fifo is a filesystem object and outlives the process, so the exit
    // hook has to unlink as well as wake — otherwise every teardown-bypassing
    // exit strews /tmp with botmux-pipe-*.
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-'));
    expect(after.filter((f) => !before.has(f))).toEqual([]);
  }, EXIT_TIMEOUT_MS + 15_000);

  // Blocker found in review: acquiring the wake fd lazily AT teardown fails in
  // exactly the states teardown has to survive. Both of these were verified to
  // re-wedge the process while the error was silently swallowed, which is why
  // the fd is opened up front in spawn().
  it('still exits when the fifo was unlinked before teardown', async () => {
    const r = await runFixture('unlinked');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  it('still exits when the fd table is exhausted at teardown (EMFILE)', async () => {
    const r = await runFixture('emfile');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // Blocker found in review: without a wake fd the reader can be unblocked by
  // NOBODY — not teardown, not the exit hook. Returning a backend in that state
  // hands back a process that is already doomed to wedge, so spawn() must fail
  // closed. The window is safe because the read stream does not exist yet.
  it('fails closed (and leaves nothing behind) when the wake fd cannot be opened', async () => {
    const r = await runFixture('wakefail');

    expect(r.stdout).toContain('SPAWN_THREW=true LEAKED_READERS=0 FIFO_LEFT=false');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // Reverse mutation. Without this the tests above prove nothing: if the fifo
  // read were never actually parked, every variant would exit cleanly and they
  // would pass against the broken code too. This asserts the harness has teeth
  // by reproducing the pre-fix teardown and requiring it to hang.
  //
  // NODE ONLY. The wedge is a Node/libuv property — a blocking threadpool read
  // that uv__threadpool_cleanup must join at exit. Bun's runtime ends the
  // pending read on destroy()+close, so it never wedges and this expectation is
  // simply false there (verified: 8/9 under `bunx --bun vitest`, this the only
  // failure). The production bug is Node's, so skipping keeps the assertion
  // honest instead of asserting one runtime's behaviour of the other; the eight
  // positive cases still run under both.
  it.skipIf(isBunRuntime())('reproduces the wedge when the wake-up byte is omitted', async () => {
    const r = await runFixture('nowake');

    expect(r.stdout).toContain('TEARDOWN');
    // It reaches process.exit(0) and prints EXITING, then never dies — that is
    // exactly the production signature, so the wedge is the timeout, not a
    // missing line.
    expect(r.timedOut).toBe(true);
  }, EXIT_TIMEOUT_MS + 15_000);

  it('leaves no fifo behind after teardown', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-')));
    const r = await runFixture('real');
    expect(r.timedOut).toBe(false);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-'));
    expect(after.filter((f) => !before.has(f))).toEqual([]);
  }, EXIT_TIMEOUT_MS + 15_000);
});
