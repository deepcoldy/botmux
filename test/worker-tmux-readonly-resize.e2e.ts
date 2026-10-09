import { type ChildProcess, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children: ChildProcess[] = [];
const tempDirs: string[] = [];
const tmuxSessions: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const session of tmuxSessions.splice(0)) TmuxBackend.killSession(session);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(message);
}

function paneSize(sessionName: string): string {
  try {
    return execFileSync(
      'tmux', ['display-message', '-p', '-t', sessionName, '#{pane_width}x#{pane_height}'],
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return '';
  }
}

function openSocket(url: string, frames?: string[]): Promise<WebSocket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    socket.on('message', data => frames?.push(String(data)));
    const timer = setTimeout(() => rejectPromise(new Error('Web Terminal socket timeout')), 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolvePromise(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

describe('worker tmux Web Terminal resize ownership', () => {
  it.skipIf(!TmuxBackend.isAvailable())('keeps read-only resize local while preserving writable resize', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-tmux-readonly-resize-'));
    tempDirs.push(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const sessionId = randomUUID();
    const tmuxSession = TmuxBackend.sessionName(sessionId);
    tmuxSessions.push(tmuxSession);
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_tmux_readonly_resize',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));

    const readyPromise = new Promise<Extract<WorkerToDaemon, { type: 'ready' }>>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`worker ready timeout\n${logs.join('')}`)), 15_000);
      child.on('message', raw => {
        const message = raw as WorkerToDaemon;
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolveReady(message);
        } else if (message.type === 'error') {
          clearTimeout(timer);
          rejectReady(new Error(`worker error: ${message.message}\n${logs.join('')}`));
        }
      });
    });
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_tmux_readonly_resize',
      rootMessageId: 'om_tmux_readonly_resize',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'tmux',
      prompt: '',
      larkAppId: 'app_tmux_readonly_resize',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    const ready = await readyPromise;
    await waitFor(() => paneSize(tmuxSession) === '160x50', `initial pane size: ${paneSize(tmuxSession)}`);

    const readFrames: string[] = [];
    const readSocket = await openSocket(
      `ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(ready.viewToken!)}`,
      readFrames,
    );
    await waitFor(
      () => readFrames.join('').includes('\x1b]1989;160;50\x07'),
      `read-only initial grid pin missing: ${JSON.stringify(readFrames)}`,
    );
    readSocket.send(JSON.stringify({ type: 'resize', cols: 60, rows: 56 }));
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 250));
    expect(paneSize(tmuxSession)).toBe('160x50');
    expect(readFrames.join('')).not.toContain('\x1b]1989;follower;60;56\x07');

    const writeSocket = await openSocket(
      `ws://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`,
    );
    writeSocket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    await waitFor(() => paneSize(tmuxSession) === '100x40', `writable pane size: ${paneSize(tmuxSession)}`);
    await waitFor(
      () => readFrames.join('').includes('\x1b]1989;follower;100;40\x07'),
      `read-only follower did not receive writable grid update: ${JSON.stringify(readFrames)}`,
    );
    readSocket.close();
    writeSocket.close();

    const childExit = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.send({ type: 'close' } satisfies DaemonToWorker);
    await childExit;
  }, 30_000);
});
