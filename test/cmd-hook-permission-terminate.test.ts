/**
 * `botmux hook claude-code` 进程本身：终端 Esc / No、会话退出时 Claude Code 用 SIGTERM / SIGHUP
 * 结束 hook（约 1.3 秒后强杀）。hook 要先把结局报给 daemon、以拒绝退出，而不是被信号直接打断、
 * 让卡片等到长连接断开 60 秒后才作废。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTsScript } from './helpers/ts-runner.js';
import { PROMPT_LINE, permissionPayload, toolUseLine } from './helpers/claude-permission-transcript.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const APP = 'cli_hook_term';

let root: string;
let transcript: string;
let server: Server;
let asks: Record<string, unknown>[];
let reports: Record<string, unknown>[];
let child: ChildProcess | undefined;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function waitFor(ready: () => boolean, ms: number, what: string): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'botmux-hook-term-'));
  transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, PROMPT_LINE + toolUseLine('toolu_1'));
  asks = [];
  reports = [];
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url === '/api/asks') {
      asks.push(body); // long poll: the card stays unanswered
    } else if (req.url === '/api/asks/cli-resolved') {
      reports.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"outcome":"settled"}');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = join(root, 'data', 'dashboard-daemons');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, `${APP}.json`), JSON.stringify({
    larkAppId: APP, ipcPort: (server.address() as AddressInfo).port, lastHeartbeat: Date.now(),
  }));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

describe('botmux hook claude-code 被 CLI 终止', () => {
  // No terminal record in the transcript, so only the signal path can produce the report.
  it.each(['SIGTERM', 'SIGHUP'] as const)('%s → 先回报结局再以拒绝正常退出', async (signal) => {
    const spawned = spawnTsScript(join(repo, 'src', 'cli.ts'), ['hook', 'claude-code'], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: join(root, 'data'),
        BOTMUX_SESSION_ID: 'sess_hook_term', BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_LARK_APP_ID: APP,
        BOTMUX_ROOT_MESSAGE_ID: 'om_root',
      },
    });
    child = spawned;
    let stdout = '';
    spawned.stdout!.on('data', chunk => { stdout += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      spawned.once('close', (code, sig) => resolve({ code, signal: sig })));
    spawned.stdin!.end(JSON.stringify(permissionPayload(transcript)));

    await waitFor(() => asks.length > 0, 45_000, 'the permission card POST');
    spawned.kill(signal);
    const { code, signal: exitSignal } = await exited;

    expect({ code, exitSignal }).toEqual({ code: 0, exitSignal: null });
    expect(reports).toEqual([expect.objectContaining({ requestId: asks[0]!.requestId, outcome: 'cli_stopped_waiting' })]);
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  }, 60_000);
});
