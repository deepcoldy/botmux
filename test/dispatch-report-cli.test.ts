import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', CLI_PATH, ...args],
        {
          env: { ...process.env, ...env, BOTMUX_WORKFLOW: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', status => resolve({ status, stdout, stderr }));
    },
  );
}

describe('botmux report CLI source-daemon boundary', () => {
  it('signs the source-session report route and forwards the exact report body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-report-cli-'));
    roots.push(root);
    const home = join(root, 'home');
    const configDir = join(home, '.botmux');
    const dataDir = join(root, 'data');
    const daemonDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(daemonDir, { recursive: true });
    const secret = 'dispatch-report-cli-secret';
    writeFileSync(join(configDir, '.dashboard-secret'), secret);
    writeFileSync(join(dataDir, 'sessions-cli_source.json'), JSON.stringify({
      'session-source': {
        sessionId: 'session-source',
        chatId: 'oc_task',
        chatType: 'group',
        rootMessageId: 'om_dispatch',
        scope: 'thread',
        title: 'Resident task',
        status: 'active',
        createdAt: '2026-07-25T00:00:00.000Z',
        larkAppId: 'cli_source',
      },
    }));
    writeFileSync(join(dataDir, 'orchestrate-dispatch.json'), JSON.stringify({
      om_dispatch: {
        orchAppId: 'cli_orchestrator',
        orchSessionId: 'session-orchestrator',
        targetAppIds: ['cli_source'],
        targetChatId: 'oc_task',
        title: 'Workboard run run_1 dispatch rds_1',
      },
    }));

    let capturedPath = '';
    let capturedBody: any;
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        capturedPath = req.url ?? '';
        capturedHeaders = req.headers;
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          delivery: 'orchestrator-session',
          reportedTo: 'session-orchestrator',
          viaRegistry: true,
          triggerId: 'trigger-cli',
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(join(daemonDir, 'cli_source.json'), JSON.stringify({
        larkAppId: 'cli_source',
        ipcPort: port,
        lastHeartbeat: Date.now(),
      }));
      const content = '[MOSA_WORKBOARD_OUTCOME:review_ready]\n\nTask complete.';
      const result = await runCli([
        'report',
        '--session-id', 'session-source',
        '--dispatch-root', 'om_dispatch',
        content,
      ], {
        HOME: home,
        USERPROFILE: home,
        SESSION_DATA_DIR: dataDir,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        success: true,
        delivery: 'orchestrator-session',
        reportedTo: 'session-orchestrator',
        viaRegistry: true,
        triggerId: 'trigger-cli',
      });
      expect(capturedPath).toBe('/api/sessions/session-source/report');
      expect(capturedBody).toMatchObject({
        dispatchRoot: 'om_dispatch',
        content,
      });

      const ts = String(capturedHeaders['x-botmux-cli-ts']);
      const nonce = String(capturedHeaders['x-botmux-cli-nonce']);
      const expected = createHmac('sha256', secret)
        .update(
          `${ts}:${nonce}:POST /api/sessions/session-source/report ${port}`,
        )
        .digest('base64url');
      expect(capturedHeaders['x-botmux-cli-auth']).toBe(expected);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
