import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { deriveTerminalViewToken } from '../src/core/terminal-write-auth.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function waitForReady(child: ChildProcess, logs: string[]): Promise<Extract<WorkerToDaemon, { type: 'ready' }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`worker ready timeout\n${logs.join('')}`));
    }, 15_000);
    child.on('message', (raw) => {
      const msg = raw as WorkerToDaemon;
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolvePromise(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        rejectPromise(new Error(`worker error: ${msg.message}\n${logs.join('')}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`worker exited before ready (${code ?? signal})\n${logs.join('')}`));
    });
  });
}

function rawWsHandshake(port: number, path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let raw = '';
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(raw); }, 3_000);
    socket.on('data', chunk => {
      raw += chunk.toString();
      if (raw.includes('\r\n\r\n')) socket.end();
    });
    socket.on('close', () => { clearTimeout(timer); resolvePromise(raw); });
    socket.on('error', err => { clearTimeout(timer); rejectPromise(err); });
  });
}

async function waitForFileText(path: string, predicate: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (predicate(text)) return text;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('worker terminal read authorization', () => {
  it('blocks localhost scanners while preserving view, write, HTTP, and WS links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-terminal-auth-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // Give the worker a deterministic host-only secret so its per-session view
    // capability is stable across worker restarts without exposing that secret
    // to the spawned CLI.
    const secret = 'integration-host-dashboard-secret';
    const botmuxDir = join(root, '.botmux');
    mkdirSync(botmuxDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), secret, { mode: 0o600 });

    // Claude adapter arguments are intentionally ignored; this process only
    // keeps the PTY alive long enough to exercise the real worker server.
    const fakeCli = join(root, 'fake-claude');
    const inputLog = join(root, 'terminal-input.hex');
    writeFileSync(fakeCli, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(inputLog)}, chunk.toString('hex') + '\\n'));
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const logs: string[] = [];
    const sessionId = 'terminal-auth-session';
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_terminal_auth',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_terminal_auth',
      rootMessageId: 'om_terminal_auth',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_terminal_auth',
      larkAppSecret: 'secret',
    };
    child.send(init);
    const ready = await waitForReady(child, logs);

    expect(ready.viewToken).toBe(deriveTerminalViewToken(secret, sessionId));
    const base = `http://127.0.0.1:${ready.port}`;

    const scanner = await fetch(`${base}/`);
    expect(scanner.status).toBe(403);
    expect(await scanner.text()).toBe('Forbidden');

    const view = await fetch(`${base}/?viewToken=${encodeURIComponent(ready.viewToken!)}`);
    expect(view.status).toBe(200);
    const viewHtml = await view.text();
    expect(viewHtml).toContain('var hasToken=false');
    // The browser must carry the view capability into its WS connection too.
    expect(viewHtml).toContain("base+'/'+location.search");

    const write = await fetch(`${base}/?token=${encodeURIComponent(ready.token)}`);
    expect(write.status).toBe(200);
    expect(await write.text()).toContain('var hasToken=true');

    const rejectedWs = await rawWsHandshake(ready.port, '/');
    expect(rejectedWs).toContain('403 Forbidden');

    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(ready.viewToken!)}`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('authorized WS timeout')), 5_000);
      ws.once('open', () => { clearTimeout(timer); resolvePromise(); });
      ws.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    // Clear any adapter bootstrap bytes, then prove a forged SGR click/wheel on
    // a valid view socket never reaches the real PTY.
    writeFileSync(inputLog, '');
    ws.send(JSON.stringify({ type: 'input', data: '\x1b[<0;10;10M' }));
    ws.send(JSON.stringify({ type: 'input', data: '\x1b[<64;10;10M' }));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
    expect(readFileSync(inputLog, 'utf8')).toBe('');
    ws.close();

    // The write capability still reaches the PTY through the same server.
    const writeWs = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('write WS timeout')), 5_000);
      writeWs.once('open', () => { clearTimeout(timer); resolvePromise(); });
      writeWs.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    writeWs.send(JSON.stringify({ type: 'input', data: 'WRITE_OK\n' }));
    const written = await waitForFileText(inputLog, text => text.includes(Buffer.from('WRITE_OK\n').toString('hex')));
    expect(written).toContain(Buffer.from('WRITE_OK\n').toString('hex'));
    writeWs.close();

    child.send({ type: 'close' } satisfies DaemonToWorker);
  }, 25_000);
});
