/**
 * CLI boundary regression for `botmux ask` custom replies.
 *
 * Runs the real cmdAsk dispatch in a subprocess against a tiny fake daemon so
 * stdout, stderr, and the process exit code are covered together. Using the
 * source entry through tsx keeps this unit test independent of a prior build.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runAsk(dataDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'ask', 'buttons', '--options', 'yes,no', '请作答'],
      {
        env: {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'sess_test',
          BOTMUX_CHAT_ID: 'oc_test',
          BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_ROOT_MESSAGE_ID: 'om_test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

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

describe('botmux ask — CLI boundary', () => {
  it('文字作答保持空 stdout / exit 0，并在 stderr 指明用 --json 读取 comment', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [[]],
        by: 'ou_test',
        comment: '我想先灰度 10% 再全量',
        timedOut: false,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const registryDir = join(dataDir, 'dashboard-daemons');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'cli_test.json'),
        JSON.stringify({ larkAppId: 'cli_test', ipcPort: port, lastHeartbeat: Date.now() }),
      );

      const result = await runAsk(dataDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('\n');
      expect(result.stderr).toContain('用户以文字作答');
      expect(result.stderr).toContain('--json');
      expect(result.stderr).toContain('comment');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});
