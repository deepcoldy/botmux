/**
 * CLI boundary regression for the sandbox relay response mirror.
 *
 * `botmux dispatch` inside a sandbox writes a request to the relay outbox and
 * waits for the host watcher to drop `<id>.res.json`. The relay then mirrors
 * stdout/stderr and exits with the host's code. Either stream can carry an
 * upstream error body of any size; because the relay exits explicitly, both
 * writes must complete first or a large response is silently truncated at the
 * sandbox boundary.
 *
 * This file acts as the mock host watcher and pins three independent cases:
 *   1. a large stdout AND stderr — the primary write-then-exit regression;
 *   2. an EMPTY stdout with a large stderr — pins the stderr flush on its own;
 *   3. a large stdout with an EMPTY stderr — pins the stdout flush on its own.
 *      Cases 2 and 3 exist because awaiting one stream's drain keeps the whole
 *      process alive, so a half-regression that leaves only the OTHER stream
 *      fire-and-forget can ride that awaited drain to completion on Bun and
 *      escape a combined-payload test. Each stream needs an empty partner: with
 *      nothing else awaited, dropping its own await truncates deterministically.
 *
 * The child's stdout/stderr are paused before any 'data' listener is attached
 * and only resumed `drainDelayMs` after the response lands on disk (see
 * `DRAIN_DELAY_MS` / `SINGLE_STREAM_DRAIN_DELAY_MS`): without real pipe
 * backpressure a write-then-exit regression is not observed on every runtime.
 * Both relay call sites (send + dispatch) share `mirrorRelayResponseAndExit`,
 * so the dispatch path covers the shared mirror logic.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const DISPATCH_ARGS = ['--title', 'test', '--bot-app', 'cli_test', '--brief', 'hello'];

/**
 * LOAD-BEARING — do not remove or shrink as a "magic number". The readers stay
 * paused for this long AFTER the mock host writes `<id>.res.json`, so the relay
 * child (which only notices the response on its 150 ms outbox poll) writes the
 * oversized payload into a pipe nobody is draining and hits backpressure
 * before it exits. Resuming too early lets the pipe drain first and hides a
 * write-then-exit truncation: measured on Bun, 0 ms misses 22/25 mutations,
 * 100 ms misses 11/12, while 600 ms catches 30/30. Must exceed one poll
 * interval plus the write/backpressure window.
 */
const DRAIN_DELAY_MS = 600;

/**
 * LOAD-BEARING for the single-large-stream cases (2 and 3) — larger than
 * `DRAIN_DELAY_MS`. With only one oversized stream and the other empty, the
 * child has no second stream's awaited drain keeping it alive, so under heavy
 * host load (late 150 ms poll + scheduling) 600 ms can occasionally elapse
 * before the child even reads the response, letting a fire-and-forget mutant
 * of the sole stream exit only after the pipes resumed.
 * 1500 ms = ten poll intervals; measured 20/20 caught on both runtimes on a
 * contended box where 600 ms missed once on Node.
 */
const SINGLE_STREAM_DRAIN_DELAY_MS = 1500;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Spawn the dispatch relay child with both readers paused until the gate. */
function runDispatchRelay(
  relayDir: string,
  responseWritten: Promise<void>,
  drainDelayMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, ['dispatch', ...DISPATCH_ARGS], {
      env: {
        ...process.env,
        SESSION_DATA_DIR: join(relayDir, 'data'),
        BOTMUX_SEND_RELAY: relayDir,
        BOTMUX_SESSION_ID: 'sess_relay_test',
        BOTMUX_MULTI_TOPIC_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Pause BEFORE attaching 'data' listeners (on Bun pausing after a listener
    // is attached does not stop reads). The gate resumes only after the host
    // response is on disk plus the load-bearing delay. Backpressure is what
    // makes a missing pre-exit flush observable on both runtimes.
    child.stdout.pause();
    child.stderr.pause();
    responseWritten.then(() => {
      setTimeout(() => {
        child.stdout.resume();
        child.stderr.resume();
      }, drainDelayMs);
    });
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Mock host watcher: resolve `responseWritten` once the first request is
 * answered with an oversized `<id>.res.json`; the returned promise settles when
 * the response file has been written.
 */
function mockHostWatcher(
  relayDir: string,
  stdout: string,
  stderr: string,
): { responseWritten: Promise<void>; watcher: Promise<void> } {
  let releaseDrain!: () => void;
  const responseWritten = new Promise<void>(resolve => { releaseDrain = resolve; });
  const watcher = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const req = readdirSync(relayDir).find(f => f.endsWith('.req.json'));
      if (req) {
        const id = req.slice(0, -'.req.json'.length);
        writeFileSync(join(relayDir, `${id}.res.json`), JSON.stringify({
          code: 7,
          stdout,
          stderr,
        }));
        releaseDrain();
        return;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('mock watcher timed out waiting for req.json');
  })();
  return { responseWritten, watcher };
}

describe('sandbox relay response mirror', () => {
  it('mirrors a host response past the flush ceiling without truncation', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-relay-mirror-'));
    tempDirs.push(relayDir);

    const bigStdout = 'x'.repeat(300_000);
    const bigStderr = 'y'.repeat(300_000);
    const { responseWritten, watcher } = mockHostWatcher(relayDir, bigStdout, bigStderr);

    const result = await runDispatchRelay(relayDir, responseWritten, DRAIN_DELAY_MS);
    await watcher;

    expect(result.status).toBe(7);
    expect(result.stdout).toBe(bigStdout);
    expect(result.stderr).toBe(bigStderr);
  }, 30_000);

  it('flushes a large stderr even when stdout carries no body', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-relay-mirror-'));
    tempDirs.push(relayDir);

    const bigStderr = 'y'.repeat(300_000);
    const { responseWritten, watcher } = mockHostWatcher(relayDir, '', bigStderr);

    const result = await runDispatchRelay(relayDir, responseWritten, SINGLE_STREAM_DRAIN_DELAY_MS);
    await watcher;

    expect(result.status).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(bigStderr);
  }, 30_000);

  it('flushes a large stdout even when stderr carries no body', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-relay-mirror-'));
    tempDirs.push(relayDir);

    const bigStdout = 'x'.repeat(300_000);
    const { responseWritten, watcher } = mockHostWatcher(relayDir, bigStdout, '');

    const result = await runDispatchRelay(relayDir, responseWritten, SINGLE_STREAM_DRAIN_DELAY_MS);
    await watcher;

    expect(result.status).toBe(7);
    expect(result.stdout).toBe(bigStdout);
    expect(result.stderr).toBe('');
  }, 30_000);
});
