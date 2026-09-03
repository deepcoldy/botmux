/**
 * Fixture for tmux-pipe-backend-exit.test.ts — run as a CHILD process.
 *
 * Exercises the REAL TmuxPipeBackend fifo lifecycle (spawn → kill) and then
 * lets the process exit naturally. The parent asserts the child actually
 * exits: the bug under test wedges `process.exit()` forever, which is
 * invisible in-process and therefore cannot be caught by an in-test assertion.
 *
 * tmux itself is neutralized by a fake `tmux` executable the parent puts first
 * on PATH, so nothing here touches the real tmux server (the production code
 * targets the DEFAULT socket, shared with every live daemon on the machine).
 * Everything else — mkfifo, the O_RDWR open, the libuv read stream, the
 * teardown — is the real production path.
 *
 * argv[2] selects the teardown variant so the parent can run reverse mutations:
 *   real     — the shipped kill() path
 *   paneexit — the OTHER teardown site, handlePaneExit(); without this a fix
 *              applied to only one of the two sites would look complete
 *   full     — pipe deliberately full at teardown (tmux left output behind and
 *              the reader is no longer draining). Distinguishes a NON-BLOCKING
 *              wake-up write from a blocking one: a blocking write on our own
 *              O_RDWR fd hangs here, recreating the very bug being fixed
 *   spawnfail— `tmux pipe-pane` fails terminally AFTER the fifo reader is live.
 *              spawn() throws, and the caller has no backend handle to clean
 *              up, so spawn() itself must tear the reader down
 *   unlinked — the fifo pathname is gone before teardown. A teardown that only
 *              opens its wake fd on demand gets ENOENT here and fails open
 *   emfile   — fd table exhausted before teardown; an on-demand wake fd open
 *              gets EMFILE. Both this and `unlinked` are why the wake fd is
 *              acquired at spawn() instead
 *   directexit— live backend, kill() NEVER called, straight to process.exit().
 *              Covers sendFatalWorkerErrorAndExit / uncaughtException /
 *              parent-exit, which all bypass both teardown sites
 *   wakefail — the wake-fd open fails during spawn(). Without a wake fd the
 *              reader can never be unblocked, so spawn() must fail closed
 *              rather than hand back a backend nothing can rescue.
 *              BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL drives the injection.
 *   nowake   — reproduces the pre-fix teardown (destroy + unlink, no wake-up
 *              byte) and MUST hang, proving the harness has teeth
 */
import fs from 'node:fs';
import { TmuxPipeBackend, __testOnly_liveFifoReaderCount as readerRegistrySize } from '../../src/adapters/backend/tmux-pipe-backend.js';

const mode = process.argv[2] ?? 'real';

// The spawn-failure path is exercised before anything else: it asserts on
// spawn() itself throwing, so it never reaches the shared teardown block below.
if (mode === 'spawnfail') {
  // The parent points PATH at a `tmux` that fails pipe-pane with a
  // non-retryable (pane-gone) error, so spawn() throws after opening the fifo.
  const failing = new TmuxPipeBackend('bmx-exit-fixture');
  let threw = false;
  try {
    failing.spawn('/bin/true', [], { cwd: process.cwd(), cols: 80, rows: 24, env: {} });
  } catch {
    threw = true;
  }
  process.stdout.write(threw ? 'SPAWN_THREW\n' : 'SPAWN_DID_NOT_THROW\n');
  // Did spawn() clean up after itself? The exit-hook backstop would let this
  // process exit either way, so exit alone cannot tell a tidy spawn from a
  // leaky one. Assert on the observable leak instead: after a failed spawn no
  // reader may remain registered, and the fifo must be gone from disk.
  const leakedReaders = readerRegistrySize();
  const fifoLeft = fs.existsSync((failing as unknown as { fifoPath: string }).fifoPath);
  process.stdout.write(`LEAKED_READERS=${leakedReaders} FIFO_LEFT=${fifoLeft}\n`);
  // Yield first. libuv only parks the blocking fifo read on a threadpool
  // thread after one event-loop turn, and spawn() throws synchronously — exit
  // in the same tick and even a leaked reader cannot wedge, which would make
  // this case pass against the leak it exists to catch (verified: without this
  // delay the missing-teardown mutation survives). In production the caller
  // always returns to the loop after a failed spawn, so the wait is realistic,
  // not a contrivance to force a failure.
  setTimeout(() => {
    process.stdout.write('EXITING\n');
    process.exit(0);
  }, 250);
}

if (mode === 'wakefail') {
  // The parent sets BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL=1. Without a wake fd the
  // reader is unrescuable, so spawn() must fail closed and leave nothing behind
  // rather than return a backend that will wedge the process at exit.
  const doomed = new TmuxPipeBackend('bmx-exit-fixture');
  let threw = false;
  try {
    doomed.spawn('/bin/true', [], { cwd: process.cwd(), cols: 80, rows: 24, env: {} });
  } catch {
    threw = true;
  }
  const fifoLeft = fs.existsSync((doomed as unknown as { fifoPath: string }).fifoPath);
  process.stdout.write(`SPAWN_THREW=${threw} LEAKED_READERS=${readerRegistrySize()} FIFO_LEFT=${fifoLeft}\n`);
  // Same reason as the spawnfail case: give libuv a turn to park a read, so a
  // fail-open regression actually gets the chance to wedge this process.
  setTimeout(() => {
    process.stdout.write('EXITING\n');
    process.exit(0);
  }, 250);
}

if (mode !== 'spawnfail' && mode !== 'wakefail') {

const backend = new TmuxPipeBackend('bmx-exit-fixture');
backend.spawn('/bin/true', [], { cwd: process.cwd(), cols: 80, rows: 24, env: {} });

// Prove the fifo reader is actually live before tearing it down — otherwise a
// spawn() that silently failed to open the fifo would make this test pass for
// the wrong reason (no blocked read to wedge on in the first place).
const fifoFd = (backend as unknown as { fifoFd: number | null }).fifoFd;
const readStream = (backend as unknown as { readStream: unknown }).readStream;
if (typeof fifoFd !== 'number' || !readStream) {
  process.stdout.write('FIXTURE_NO_FIFO\n');
  process.exit(2);
}
const fifoPath = (backend as unknown as { fifoPath: string }).fifoPath;

// Give libuv a moment to park a threadpool read on the fifo. Without a read in
// flight there is nothing to wedge and both variants would exit cleanly.
setTimeout(() => {
  if (mode === 'directexit') {
    // No teardown at all — the exit-hook backstop is the only thing that can
    // save this process. Mirrors sendFatalWorkerErrorAndExit and the
    // uncaughtException / parent-exit handlers.
    process.stdout.write('DIRECT_EXIT\n');
    process.stdout.write('EXITING\n');
    process.exit(0);
  }
  if (mode === 'unlinked') {
    // Someone removed the fifo first (stale-tmp sweeper, operator, a racing
    // teardown). A wake fd opened on demand would now get ENOENT.
    try { fs.unlinkSync(fifoPath); } catch { /* already gone */ }
  }
  if (mode === 'emfile') {
    // Exhaust the fd table so an on-demand wake fd open would get EMFILE.
    //
    // The parent runs this mode behind a static `ulimit -n 128` wrapper, and it
    // MUST: unbounded, this box's 1M-fd limit means opening ~a million files,
    // which burns kernel file objects and can push the shared host toward a
    // global ENFILE while ~275 live daemon workers are running beside the tests.
    // (An in-process setrlimit would be tidier, but neither Node nor Bun
    // exposes one — verified; an optional call would have silently no-op'd.)
    for (;;) {
      try { fs.openSync('/dev/null', 'r'); } catch { break; }
    }
  }
  if (mode === 'full') {
    // Fill the pipe (Linux default 64KB) BEFORE teardown. The reader is about
    // to stop draining, so a blocking wake-up write would park here forever —
    // which is what separates the correct non-blocking write from the naive one.
    try {
      const stuffFd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try { for (;;) fs.writeSync(stuffFd, Buffer.alloc(4096, 0x41)); }
      catch { /* EAGAIN — pipe is now full, which is the point */ }
      fs.closeSync(stuffFd);
    } catch { /* best effort */ }
  }
  process.stdout.write('TEARDOWN\n');
  if (mode === 'nowake') {
    // Pre-fix teardown, inlined: destroy the stream and unlink, but never wake
    // the parked read. This is the reverse mutation — it must hang.
    //
    // The exit-hook backstop would otherwise rescue even this, so drop the
    // wake fd first to simulate its absence. That is the point of the case: it
    // proves a read really is parked and really does wedge exit, so every
    // other case in this file is passing for the right reason.
    const wakeFd = (backend as unknown as { fifoWakeFd: number | null }).fifoWakeFd;
    (backend as unknown as { fifoWakeFd: number | null }).fifoWakeFd = null;
    if (wakeFd !== null) { try { fs.closeSync(wakeFd); } catch { /* already closed */ } }
    (backend as unknown as { readStream: { destroy(): void } | null }).readStream?.destroy();
    (backend as unknown as { readStream: unknown }).readStream = null;
    try { fs.closeSync(fifoFd); } catch { /* already closed */ }
    try { fs.unlinkSync(fifoPath); } catch { /* already gone */ }
  } else if (mode === 'paneexit') {
    // The other teardown site. Private, and reached in production when the
    // lifecycle watcher notices the pane vanished.
    (backend as unknown as { handlePaneExit(): void }).handlePaneExit();
  } else {
    backend.kill();
  }
  process.stdout.write('EXITING\n');
  // Same reasoning as the spawn-failure case: with the exit hook in place,
  // "the process exited" no longer distinguishes a teardown that ran from one
  // that did not. Report the observable cleanup so each teardown site is
  // judged on its own work rather than on the backstop's.
  process.stdout.write(
    `LEAKED_READERS=${readerRegistrySize()} FIFO_LEFT=${fs.existsSync(fifoPath)}\n`,
  );
  process.exit(0);
}, 250);

}
