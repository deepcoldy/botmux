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

function runAsk(
  dataDir: string,
  args = ['ask', 'buttons', '--options', 'yes,no', '请作答'],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, ...args],
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
  it('--multi 发送多选问题并输出逗号分隔的 keys', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-cli-'));
    tempDirs.push(dataDir);
    let requestBody: Record<string, unknown> | undefined;

    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        kind: 'answered',
        answers: [['a', 'c']],
        by: 'ou_test',
        comment: null,
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

      const result = await runAsk(dataDir, [
        'ask', 'buttons', '--multi', '--options', 'a=A,b=B,c=C', '请选择',
      ]);
      expect(result).toMatchObject({ status: 0, stdout: 'a,c\n', stderr: '' });
      expect(requestBody?.questions).toEqual([{
        prompt: '请选择',
        multiSelect: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
          { key: 'c', label: 'C' },
        ],
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });

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
