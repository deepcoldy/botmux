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
 * This test acts as the mock host watcher: it waits for `<id>.req.json`, then
 * writes a `<id>.res.json` whose stdout/stderr are far past the ~146 KiB
 * partial-flush ceiling, and asserts the child delivers every byte and the
 * host's exit code. Both relay call sites (send + dispatch) share
 * `mirrorRelayResponseAndExit`, so this covers the shared mirror path.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runDispatchRelay(
  relayDir: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, ['dispatch', ...args], {
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
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('sandbox relay response mirror', () => {
  it('mirrors a host response past the flush ceiling without truncation', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-relay-mirror-'));
    tempDirs.push(relayDir);

    const bigStdout = 'x'.repeat(300_000);
    const bigStderr = 'y'.repeat(200_000);

    // Mock host watcher: answer the first request with an oversized response.
    const watcher = (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const req = readdirSync(relayDir).find(f => f.endsWith('.req.json'));
        if (req) {
          const id = req.slice(0, -'.req.json'.length);
          writeFileSync(join(relayDir, `${id}.res.json`), JSON.stringify({
            code: 7,
            stdout: bigStdout,
            stderr: bigStderr,
          }));
          return;
        }
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error('mock watcher timed out waiting for req.json');
    })();

    const result = await runDispatchRelay(relayDir, ['--title', 'test', '--bot-app', 'cli_test', '--brief', 'hello']);
    await watcher;

    expect(result.status).toBe(7);
    expect(result.stdout).toBe(bigStdout);
    expect(result.stderr).toBe(bigStderr);
  }, 30_000);
});
