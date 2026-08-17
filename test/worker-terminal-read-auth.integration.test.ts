import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { deriveTerminalWriteToken } from '../src/core/terminal-write-auth.js';
import { issueTerminalControlGrant } from '../src/core/terminal-control-grant.js';

/** The RETIRED stable view derivation (P1-5). Reproduced here so the tests can
 *  prove a live worker rejects every historically issued stable view token. */
function retiredStableViewToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update('botmux-terminal-view-v1\0')
    .update(sessionId)
    .digest('base64url');
}

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
    const controlAuditLog = join(root, 'dashboard-control.ndjson');
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
        BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: controlAuditLog,
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

    // P1-5: the reported read capability is PER-BOOT random — deliberately no
    // longer the stable secret-derived HMAC, which was irrevocable (logout,
    // session expiry and worker restarts all left it valid forever).
    expect(ready.viewToken).toBeTruthy();
    expect(ready.viewToken).not.toBe(retiredStableViewToken(secret, sessionId));
    // The operate/write link must still be the stable HMAC (not a random boot
    // token), so an already-issued 「操作链接」survives a worker restart that
    // re-runs init → refreshTerminalWriteToken → ready (P1-6: write-capability
    // semantics stay untouched).
    expect(ready.token).toBe(deriveTerminalWriteToken(secret, sessionId));
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

    // Every historically issued stable view token fails closed on this worker.
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(retiredStableViewToken(secret, sessionId))}`)).status).toBe(403);

    const write = await fetch(`${base}/?token=${encodeURIComponent(ready.token)}`);
    expect(write.status).toBe(200);
    expect(await write.text()).toContain('var hasToken=true');

    // P1-6: the explicit write capability has independent HIGHEST priority —
    // an injected read-scope grant (what the central proxy hands teammate/guest
    // viewers) must NOT downgrade a correct 「操作链接」 to read-only.
    const injectedReadGrant = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_platform_teammate', authSessionId: 'platform-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10_000,
    });
    const writeDespiteReadGrant = await fetch(`${base}/?token=${encodeURIComponent(ready.token)}`, {
      headers: { 'x-botmux-terminal-control': injectedReadGrant },
    });
    expect(writeDespiteReadGrant.status).toBe(200);
    expect(await writeDespiteReadGrant.text()).toContain('var hasToken=true');
    // A wrong write token with no other credential stays fully denied — it
    // must never fall back to something weaker than the explicit capability.
    expect((await fetch(`${base}/?token=wrong-token`)).status).toBe(403);

    // P1-5: the dashboard-minted BOUND view capability (signed read grant in
    // ?viewToken=) opens the terminal read-only…
    const boundView = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_h5_viewer', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
    });
    const boundResponse = await fetch(`${base}/?viewToken=${encodeURIComponent(boundView)}`);
    expect(boundResponse.status).toBe(200);
    expect(await boundResponse.text()).toContain('var hasToken=false');
    // …an EXPIRED one is refused (expired reconnects with a kept URL die)…
    const expiredBoundView = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_h5_viewer', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 10_000,
    });
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(expiredBoundView)}`)).status).toBe(403);
    // …and a WRITE-scope grant may never travel in a URL: it neither writes
    // nor even reads through the ?viewToken= channel (viewToken 永不升级).
    const writeScopeInUrl = issueTerminalControlGrant(secret, {
      scope: 'write', sessionId, userId: 'ou_h5_viewer', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10_000,
    });
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(writeScopeInUrl)}`)).status).toBe(403);

    const signedRead = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_h5_owner', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10_000,
    });
    const signedReadResponse = await fetch(`${base}/`, {
      headers: { 'x-botmux-terminal-control': signedRead },
    });
    expect(signedReadResponse.status).toBe(200);
    expect(await signedReadResponse.text()).toContain('var hasToken=false');

    const wrongSessionGrant = issueTerminalControlGrant(secret, {
      scope: 'write', sessionId: 'another-session', userId: 'ou_h5_owner', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10_000,
    });
    expect((await fetch(`${base}/`, { headers: { 'x-botmux-terminal-control': wrongSessionGrant } })).status).toBe(403);

    const expiredGrant = issueTerminalControlGrant(secret, {
      scope: 'write', sessionId, userId: 'ou_h5_owner', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 10_000,
    });
    expect((await fetch(`${base}/`, { headers: { 'x-botmux-terminal-control': expiredGrant } })).status).toBe(403);

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

    // P1-5: a READ socket authorized by a bound capability is closed at the
    // capability's signed expiresAt — read streams no longer outlive their
    // authentication even when the front proxy never tears them down.
    const shortBoundView = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_h5_viewer', authSessionId: 'h5-auth-1',
      issuedAt: Date.now(), expiresAt: Date.now() + 2_000,
    });
    const readWs = new WebSocket(`ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(shortBoundView)}`);
    const readWsClosed = new Promise<{ code: number; reason: string }>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('read WS was not closed at its expiry boundary')), 8_000);
      readWs.once('close', (code, reason) => { clearTimeout(timer); resolvePromise({ code, reason: reason.toString() }); });
      readWs.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('bound-view WS open timeout')), 5_000);
      readWs.once('open', () => { clearTimeout(timer); resolvePromise(); });
      readWs.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    const readWsClose = await readWsClosed;
    expect(readWsClose.code).toBe(4003);
    expect(readWsClose.reason).toBe('view expired');

    // A valid short-lived Dashboard write grant is independently verified by
    // the worker. Accepted input is audited with identity/session/action and a
    // byte count only; neither the grant nor input content is retained.
    writeFileSync(inputLog, '');
    const signedWrite = issueTerminalControlGrant(secret, {
      scope: 'write', sessionId, userId: 'ou_h5_owner', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10_000,
    });
    const controlledWs = new WebSocket(`ws://127.0.0.1:${ready.port}/`, {
      headers: { 'x-botmux-terminal-control': signedWrite },
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('controlled WS timeout')), 5_000);
      controlledWs.once('open', () => { clearTimeout(timer); resolvePromise(); });
      controlledWs.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    const controlledInput = 'H5_CONTROLLED_INPUT\n';
    controlledWs.send(JSON.stringify({ type: 'input', data: controlledInput }));
    const controlledWritten = await waitForFileText(
      inputLog,
      text => text.includes(Buffer.from(controlledInput).toString('hex')),
    );
    expect(controlledWritten).toContain(Buffer.from(controlledInput).toString('hex'));
    const auditText = await waitForFileText(controlAuditLog, text => text.includes('terminal.input'));
    const auditRows = auditText.trim().split('\n').map(line => JSON.parse(line));
    expect(auditRows).toContainEqual(expect.objectContaining({
      timestamp: expect.any(String),
      user: 'ou_h5_owner',
      session: sessionId,
      action: 'terminal.input',
      bytes: Buffer.byteLength(controlledInput),
    }));
    expect(auditText).not.toContain(controlledInput.trim());
    expect(auditText).not.toContain(signedWrite);
    controlledWs.close();

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

  // P1-5 回归矩阵的收尾一格：worker 重启后，重启前发出的一切读 token（旧稳定
  // HMAC、上一代 boot token）全部失效；而显式写能力（操作链接）跨重启存活不变。
  it('a worker restart invalidates every prior read capability while the operate link survives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-terminal-restart-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const secret = 'integration-restart-dashboard-secret';
    const botmuxDir = join(root, '.botmux');
    mkdirSync(botmuxDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), secret, { mode: 0o600 });
    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const sessionId = 'terminal-restart-session';
    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_terminal_restart',
      rootMessageId: 'om_terminal_restart',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_terminal_restart',
      larkAppSecret: 'secret',
    };
    const spawnWorker = async (): Promise<{ child: ChildProcess; ready: Extract<WorkerToDaemon, { type: 'ready' }> }> => {
      const logs: string[] = [];
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: 'app_terminal_restart',
          LARK_APP_SECRET: 'secret',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.add(child);
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      child.send(init);
      return { child, ready: await waitForReady(child, logs) };
    };

    const first = await spawnWorker();
    const firstViewToken = first.ready.viewToken!;
    expect(first.ready.token).toBe(deriveTerminalWriteToken(secret, sessionId));
    const firstExit = new Promise<void>(resolvePromise => first.child.once('exit', () => resolvePromise()));
    first.child.kill('SIGKILL');
    await firstExit;

    const second = await spawnWorker();
    // 新一代 boot token 与上一代不同；写 token 稳定不变。
    expect(second.ready.viewToken).toBeTruthy();
    expect(second.ready.viewToken).not.toBe(firstViewToken);
    expect(second.ready.token).toBe(first.ready.token);

    const base = `http://127.0.0.1:${second.ready.port}`;
    // 重启前的读能力（上一代 boot token、退役的稳定 HMAC）全部 403。
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(firstViewToken)}`)).status).toBe(403);
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(retiredStableViewToken(secret, sessionId))}`)).status).toBe(403);
    // 本代 boot token 只读可用。
    const freshView = await fetch(`${base}/?viewToken=${encodeURIComponent(second.ready.viewToken!)}`);
    expect(freshView.status).toBe(200);
    expect(await freshView.text()).toContain('var hasToken=false');
    // 重启前发出的操作链接照常可写（写能力语义不动）。
    const write = await fetch(`${base}/?token=${encodeURIComponent(first.ready.token)}`);
    expect(write.status).toBe(200);
    expect(await write.text()).toContain('var hasToken=true');

    second.child.send({ type: 'close' } satisfies DaemonToWorker);
  }, 45_000);
});
