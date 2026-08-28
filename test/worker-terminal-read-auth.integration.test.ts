import { type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { spawnTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { deriveTerminalWriteToken } from '../src/core/terminal-write-auth.js';
import {
  deriveWorkerViewGeneration,
  issueTerminalControlGrant,
  signTerminalViewForward,
  TERMINAL_VIEW_FORWARD_HEADER,
} from '../src/core/terminal-control-grant.js';

/** The RETIRED stable view derivation (P1-5). Reproduced here so the tests can
 *  prove a live worker rejects every historically issued stable view token. */
function retiredStableViewToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update('botmux-terminal-view-v1\0')
    .update(sessionId)
    .digest('base64url');
}

/**
 * What the central dashboard mints for a browser (P1-5): a READ grant that
 * names its audience (`central`) and pins the worker BOOT it was issued
 * against. `bootViewToken` is the per-boot token the worker reported in
 * `ready`; the generation is derived one-way from it on both sides.
 */
function centralViewCapability(secret: string, sessionId: string, bootViewToken: string, opts: {
  authSessionId?: string;
  issuedAt?: number;
  expiresAt?: number;
  /** Override the pinned generation (to forge a different boot). */
  generation?: string;
} = {}): string {
  return issueTerminalControlGrant(secret, {
    scope: 'read',
    sessionId,
    userId: 'ou_h5_viewer',
    authSessionId: opts.authSessionId ?? 'h5-auth-1',
    issuedAt: opts.issuedAt ?? Date.now() - 1_000,
    expiresAt: opts.expiresAt ?? Date.now() + 60_000,
    audience: 'central',
    workerGeneration: opts.generation ?? deriveWorkerViewGeneration(secret, bootViewToken)!,
  });
}

/** The countersignature the central front proxy attaches on the loopback hop
 *  after it verified the capability's auth session is still live. A browser
 *  holding the raw URL cannot compute it. */
function centralForwardHeaders(secret: string, capability: string): Record<string, string> {
  return { [TERMINAL_VIEW_FORWARD_HEADER]: signTerminalViewForward(secret, capability)! };
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

function rawWsHandshake(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}`
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
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
    // 无平台提示头时按本地只读渲染（readonly 横幅，不是 SSO 登录引导）。
    expect(viewHtml).toContain('var platformReadonly=false');

    // #933 回归修复：中央前门剥掉平台注入的 Cookie/Role 后，用展示层提示头把「平台
    // 认证过的只读访客」带过来 → 页面渲染 SSO 登录引导（platformReadonly=true），
    // 而读/写授权判定不受它影响（仍是只读：hasToken=false）。
    const platformHintView = await fetch(`${base}/?viewToken=${encodeURIComponent(ready.viewToken!)}`, {
      headers: { 'x-botmux-platform-readonly': '1' },
    });
    expect(platformHintView.status).toBe(200);
    const platformHintHtml = await platformHintView.text();
    expect(platformHintHtml).toContain('var hasToken=false');
    expect(platformHintHtml).toContain('var platformReadonly=true');
    // 提示头绝不能把写权限带出来：伪造它 + 错误 token 仍被整体拒绝。
    expect((await fetch(`${base}/?token=wrong-token`, {
      headers: { 'x-botmux-platform-readonly': '1' },
    })).status).toBe(403);

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
    // ?viewToken=) opens the terminal read-only — but ONLY when it arrives
    // through the central front proxy, which countersigns the hop.
    const boundView = centralViewCapability(secret, sessionId, ready.viewToken!);
    const boundResponse = await fetch(`${base}/?viewToken=${encodeURIComponent(boundView)}`, {
      headers: centralForwardHeaders(secret, boundView),
    });
    expect(boundResponse.status).toBe(200);
    expect(await boundResponse.text()).toContain('var hasToken=false');
    // …an EXPIRED one is refused (expired reconnects with a kept URL die)…
    const expiredBoundView = centralViewCapability(secret, sessionId, ready.viewToken!, {
      issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 10_000,
    });
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(expiredBoundView)}`, {
      headers: centralForwardHeaders(secret, expiredBoundView),
    })).status).toBe(403);
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
    const shortBoundView = centralViewCapability(secret, sessionId, ready.viewToken!, {
      issuedAt: Date.now(), expiresAt: Date.now() + 2_000,
    });
    const readWs = new WebSocket(
      `ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(shortBoundView)}`,
      { headers: centralForwardHeaders(secret, shortBoundView) },
    );
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

  // P1-5 第二轮：view grant 只有「经中央前门」才算数。之前的实现里，view-link 返回的
  // URL 保留 daemon/worker origin，拿着裸 URL 直连 worker 端口（或直连 daemon 那个
  // 监听 0.0.0.0 的 /s/ 反代）就能把中央的 authSession 存活性检查整条跳过——签名和
  // 有效期都合法，worker 又是无状态验签，于是登出等于没登出。
  it('P1-5: a raw view URL dialled straight at the worker is refused — only a central-proxy hop counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-view-central-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const secret = 'integration-central-only-secret';
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

    const logs: string[] = [];
    const sessionId = 'view-central-session';
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_view_central',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_view_central',
      rootMessageId: 'om_view_central',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_view_central',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    const ready = await waitForReady(child, logs);
    const base = `http://127.0.0.1:${ready.port}`;
    const boot = ready.viewToken!;

    const capability = centralViewCapability(secret, sessionId, boot);
    const url = `${base}/?viewToken=${encodeURIComponent(capability)}`;

    // 1) 裸 URL 直连 worker（正是把 view-link 的返回值原样粘到浏览器地址栏那条路）：
    //    签名、有效期、会话绑定全对，但没有中央前门的会签 ⇒ 403。
    expect((await fetch(url)).status).toBe(403);
    // 2) 自己编一个会签也没用：那把章是用宿主 .dashboard-secret 算的。
    expect((await fetch(url, { headers: { [TERMINAL_VIEW_FORWARD_HEADER]: 'forged' } })).status).toBe(403);
    // 3) 把别的能力的会签挪过来同样不行：章绑定的是「这一条」能力。
    const otherCapability = centralViewCapability(secret, sessionId, boot, { authSessionId: 'h5-auth-2' });
    expect((await fetch(url, {
      headers: centralForwardHeaders(secret, otherCapability),
    })).status).toBe(403);
    // 4) 经中央前门（带正确会签）才放行，且只读。
    const viaCentral = await fetch(url, { headers: centralForwardHeaders(secret, capability) });
    expect(viaCentral.status).toBe(200);
    expect(await viaCentral.text()).toContain('var hasToken=false');

    // WS 同一把锁：裸 URL 升级握手直接 403，中央链路才 101。
    expect(await rawWsHandshake(ready.port, `/?viewToken=${encodeURIComponent(capability)}`))
      .toContain('403 Forbidden');
    const centralWs = new WebSocket(`ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(capability)}`, {
      headers: centralForwardHeaders(secret, capability),
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('central read WS timeout')), 5_000);
      centralWs.once('open', () => { clearTimeout(timer); resolvePromise(); });
      centralWs.once('error', err => { clearTimeout(timer); rejectPromise(err); });
    });
    centralWs.close();

    // 5) 没有 audience 的内部环回 read grant 塞进 ?viewToken=，哪怕会签是真的也过不去：
    //    内部凭证不因为被塞进 URL 就多出一条浏览器通道。
    const internal = issueTerminalControlGrant(secret, {
      scope: 'read', sessionId, userId: 'ou_h5_viewer', authSessionId: 'h5-auth-1',
      issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
    });
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(internal)}`, {
      headers: centralForwardHeaders(secret, internal),
    })).status).toBe(403);

    // 6) generation 钉的是「这一代 worker」：换一代就是另一条能力，会签再真也无效。
    const wrongGeneration = centralViewCapability(secret, sessionId, boot, {
      generation: deriveWorkerViewGeneration(secret, 'some-other-boot-token')!,
    });
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(wrongGeneration)}`, {
      headers: centralForwardHeaders(secret, wrongGeneration),
    })).status).toBe(403);

    // 7) 飞书卡片那条链路（worker 每 boot 明文 token）语义不变，仍然直连可读——
    //    收紧的只是签名 grant，不是所有只读入口。
    expect((await fetch(`${base}/?viewToken=${encodeURIComponent(boot)}`)).status).toBe(200);

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
      const child = spawnTsScript(resolve('src/worker.ts'), [], {
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
    // 重启前中央签发的一条 view capability（含会签）。它在这一代是好使的。
    const firstGenerationCapability = centralViewCapability(secret, sessionId, firstViewToken, {
      expiresAt: Date.now() + 10 * 60_000,
    });
    const firstGenerationHeaders = centralForwardHeaders(secret, firstGenerationCapability);
    const beforeRestart = await fetch(
      `http://127.0.0.1:${first.ready.port}/?viewToken=${encodeURIComponent(firstGenerationCapability)}`,
      { headers: firstGenerationHeaders },
    );
    expect(beforeRestart.status).toBe(200);
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
    // P1-5：重启前签发的中央 view capability 也一起死掉——同一把 .dashboard-secret
    // 仍在，签名和有效期都还成立，但它钉的 generation 属于上一代 worker，且会签也不
    // 会让它复活。旧 grant 跨 worker restart 继续读终端的路就此封死。
    expect((await fetch(
      `${base}/?viewToken=${encodeURIComponent(firstGenerationCapability)}`,
      { headers: firstGenerationHeaders },
    )).status).toBe(403);
    // 本代重新签发的能力照常可读（重启只让旧能力失效，不是把功能关掉）。
    const secondGenerationCapability = centralViewCapability(secret, sessionId, second.ready.viewToken!);
    const reissued = await fetch(
      `${base}/?viewToken=${encodeURIComponent(secondGenerationCapability)}`,
      { headers: centralForwardHeaders(secret, secondGenerationCapability) },
    );
    expect(reissued.status).toBe(200);
    expect(await reissued.text()).toContain('var hasToken=false');
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

  // ── P1-3：握手前放行 ≠ 登记那一刻仍然有效 ────────────────────────────────────
  //
  // verifyClient 和 connection 回调之间隔着一次真实的、同步的 `.dashboard-secret`
  // 读：ws 先等 verifyClient 回调，再 completeUpgrade 写 101，再 emit('connection')，
  // 而 connection 里重算 access 会把那个文件重新读一遍。能力的到期时刻正好落进这条缝
  // 时，旧实现照样把 socket 登记进 wsClients、把终端 scrollback 直接喂过去，而第二次
  // 解析已经拿不到 controlExpiresAt，于是这条只读连接连到期 timer 都没有——一条永不
  // 过期的窥屏通道，中央前门再怎么撤销也够不着它。
  //
  // 这条缝的宽度就等于那次同步文件读：本地 SSD 上 ~0.1ms，$HOME 挂在慢盘/NFS 上就是
  // 几十上百毫秒（backlog P1-10 记的正是这种 HOME）。以前靠把 secret 文件用 32MB 空白
  // 撑大来复现慢 HOME 的时序，但 #920 给宿主凭证读取加了严格 0600 + 256 字节上限，撑大的
  // 文件会被直接判「大小异常」拒读——于是改用 worker 侧的测试专用 env
  // （BOTMUX_TEST_TERMINAL_SECRET_READ_DELAY_MS）在握手路径的那次 secret 读后加一段有界
  // 忙等：secret 值一个字节没变、凭证文件仍是合法的小文件，只是把这条本来就存在的缝
  // 稳定拉宽到可观测（生产不设该 env，行为不变）。
  it('P1-3: a view capability that dies inside the WS handshake is refused at the connection re-check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-ws-handshake-race-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const secret = 'integration-ws-handshake-race-secret';
    const botmuxDir = join(root, '.botmux');
    mkdirSync(botmuxDir, { recursive: true });
    // 合法的小凭证文件（0600），满足 #920 的严格宿主凭证读取；握手读窗口由下面的
    // 测试专用 env 拉宽，而不是靠撑大文件。
    writeFileSync(
      join(botmuxDir, '.dashboard-secret'),
      secret,
      { mode: 0o600 },
    );
    // 握手路径每次读 secret 后忙等这么久，复现慢 HOME 的读窗口（> P1-3 需要的 20ms 下限）。
    const handshakeReadDelayMs = 40;

    // 让 scrollback 非空。socket 一旦被登记，worker 会立刻把这段历史种子推过去，于是
    // 「有没有被登记」在客户端侧是直接可观测的事实，不用去断言 worker 的内部集合。
    const seedMarker = 'BOTMUX_SCROLLBACK_SEED_MARKER';
    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(seedMarker)} + '\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const logs: string[] = [];
    const sessionId = 'ws-handshake-race-session';
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_ws_race',
        LARK_APP_SECRET: 'secret',
        BOTMUX_TEST_TERMINAL_SECRET_READ_DELAY_MS: String(handshakeReadDelayMs),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_ws_race',
      rootMessageId: 'om_ws_race',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_ws_race',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    const ready = await waitForReady(child, logs);
    const base = `http://127.0.0.1:${ready.port}`;
    const boot = ready.viewToken!;

    interface ViewSocketAttempt {
      kind: 'refused' | 'closed' | 'alive';
      code?: number;
      reason?: string;
      /** 服务端主动推过来的字节（历史种子就走这条路）。 */
      received: string;
    }

    /** 走真实握手开一条 view WS，看它最终是被拒、被关，还是活过了自己的有效期。 */
    const openViewSocket = (capability: string, waitMs: number): Promise<ViewSocketAttempt> => (
      new Promise(resolveAttempt => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${ready.port}/?viewToken=${encodeURIComponent(capability)}`,
          { headers: centralForwardHeaders(secret, capability) },
        );
        const chunks: string[] = [];
        let opened = false;
        let settled = false;
        let deadline: NodeJS.Timeout | undefined;
        const settle = (attempt: Omit<ViewSocketAttempt, 'received'>): void => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          socket.removeAllListeners();
          try { socket.terminate(); } catch { /* already gone */ }
          resolveAttempt({ ...attempt, received: chunks.join('') });
        };
        deadline = setTimeout(() => settle({ kind: opened ? 'alive' : 'refused' }), waitMs);
        socket.on('message', data => chunks.push(data.toString()));
        socket.on('open', () => { opened = true; });
        socket.on('error', () => { if (!opened) settle({ kind: 'refused' }); });
        socket.on('close', (code, reason) => settle(opened
          ? { kind: 'closed', code, reason: reason.toString() }
          : { kind: 'refused' }));
      })
    );

    // 对照组，同时也是页缓存预热：一条两次校验都过的正常能力照常放行、照常拿到历史
    // 种子，并且由第二次解析算出的 expiresAt timer 到点关掉（4003 / view expired）。
    const liveTtlMs = 1_500;
    const liveCapability = centralViewCapability(secret, sessionId, boot, {
      issuedAt: Date.now(), expiresAt: Date.now() + liveTtlMs,
    });
    const liveStart = Date.now();
    const live = await openViewSocket(liveCapability, liveTtlMs + 5_000);
    expect(live.kind).toBe('closed');
    expect(live.code).toBe(4003);
    expect(live.reason).toBe('view expired');
    expect(live.received).toContain(seedMarker);
    expect(Date.now() - liveStart).toBeGreaterThanOrEqual(liveTtlMs - 300);

    // 量一次 access 解析在这台机器上到底多贵——这个数值就是那条缝的宽度：
    // 握手前那次校验发生在「一次解析之后」，connection 里那次发生在「两次解析之后」。
    const probeCapability = centralViewCapability(secret, sessionId, boot, {
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    const probeStart = Date.now();
    const probe = await fetch(`${base}/?viewToken=${encodeURIComponent(probeCapability)}`, {
      headers: centralForwardHeaders(secret, probeCapability),
    });
    const oneResolveMs = Date.now() - probeStart;
    expect(probe.status).toBe(200);
    // 慢 HOME 复现必须真的生效，否则这条缝窄到根本量不出来，后面的扫描就成了空跑。
    expect(oneResolveMs).toBeGreaterThan(20);

    // 把到期时刻扫过 (第一次校验, 第二次校验] 这段区间。
    const attempts: ViewSocketAttempt[] = [];
    for (const factor of [1.15, 1.3, 1.45, 1.6, 1.75, 1.9, 1.45, 1.6]) {
      const ttlMs = Math.max(2, Math.round(oneResolveMs * factor));
      const capability = centralViewCapability(secret, sessionId, boot, {
        issuedAt: Date.now(), expiresAt: Date.now() + ttlMs,
      });
      attempts.push(await openViewSocket(capability, ttlMs + 900));
    }

    // 1) 没有任何一条 socket 活过自己能力的有效期。旧实现里跨缝那条既没被拒也没有
    //    timer，会一直活着——这一条就是本项的红线。
    expect(attempts.filter(attempt => attempt.kind === 'alive')).toEqual([]);
    // 2) 这一轮确实撞进了缝：至少有一条是被 connection 二次校验 fail closed 掉的，
    //    而不是被握手前那次拦掉（refused）、也不是靠到期 timer 兜底（view expired）。
    //    没撞进去就说明这个测试根本没测到东西，所以它必须响，不能默默变绿。
    const refusedAtRecheck = attempts.filter(attempt => (
      attempt.kind === 'closed' && attempt.reason === 'authorization expired'
    ));
    expect(refusedAtRecheck.length).toBeGreaterThan(0);
    expect(refusedAtRecheck.every(attempt => attempt.code === 4003)).toBe(true);
    // 3) 被二次校验拒掉的 socket 压根没进 wsClients，所以一个字节的终端历史都没拿到。
    for (const attempt of refusedAtRecheck) expect(attempt.received).toBe('');

    // worker 重启语义：钉在上一代 worker 上的能力连握手都过不去，压根到不了
    // connection——二次校验是补上的那道闸，不是把前一道闸放松的借口。
    const staleGeneration = centralViewCapability(secret, sessionId, boot, {
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      generation: deriveWorkerViewGeneration(secret, 'previous-boot-view-token')!,
    });
    expect(await rawWsHandshake(
      ready.port,
      `/?viewToken=${encodeURIComponent(staleGeneration)}`,
      centralForwardHeaders(secret, staleGeneration),
    )).toContain('403 Forbidden');
    // 同代、同会签的能力照常 101——上面那条 403 是 generation 造成的，不是会签或别的。
    const currentGeneration = centralViewCapability(secret, sessionId, boot, {
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    expect(await rawWsHandshake(
      ready.port,
      `/?viewToken=${encodeURIComponent(currentGeneration)}`,
      centralForwardHeaders(secret, currentGeneration),
    )).toContain('101 Switching Protocols');

    child.send({ type: 'close' } satisfies DaemonToWorker);
  }, 90_000);
});
