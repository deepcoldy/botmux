/**
 * A card's terminal / write-link button asks the Dashboard for a one-time link
 * (contract/dashboard-routes.ts). What the gateway does with each outcome:
 *  - the Dashboard certainly minted nothing (connection refused, a refusal,
 *    `ok: false`): the click is taken back and the clicker is told once;
 *  - no answer came (a timeout, a reset): no link, the clicker is told once to
 *    click again, and the callback stays blocked, so one click never yields
 *    two links;
 * and where the request goes when no client is injected: the port the Dashboard
 * recorded in `~/.botmux/.dashboard-port`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WecomBridge, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import { requestTerminalMint, type TerminalMintClient } from '../src/im/wecom/gateway/bridge/terminal-mint.js';
import { NativeTerminalAccess } from '../src/dashboard/wecom/terminal-access.js';
import { createDaemonClient } from '../src/dashboard/daemon-internal-client.js';
import {
  WECOM_DASHBOARD_ROUTE_PATHS,
  type WecomTerminalMintRequest,
} from '../src/im/wecom/contract/dashboard-routes.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const SECRET = 'terminal-link-mint-test-secret';
const EXCHANGE = '/wecom-terminal/exchange?code=';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

/**
 * The Dashboard's own mint handler behind a loopback server. `deny`: the
 * request is refused the way a Dashboard refuses it (403). `hang`: the request
 * is accepted and never answered. `reset`: the connection is dropped once the
 * request arrived. `onRequest` runs as a request arrives.
 */
async function fakeDashboard(secret = SECRET) {
  const control = { deny: false, hang: false, reset: false, requests: 0, onRequest: undefined as (() => void) | undefined };
  const held: ServerResponse[] = [];
  const access = new NativeTerminalAccess({
    secret,
    origin: () => 'http://127.0.0.1:12345',
    resolve: async request => {
      if (control.deny) {
        throw new Error('denied');
      }
      return { uiSessionId: 'ui', nativeSessionId: request.sessionId, binding: 'worker', proxyPort: 1, epoch: 'epoch' };
    },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === WECOM_DASHBOARD_ROUTE_PATHS.terminalMint) {
      control.requests++;
      control.onRequest?.();
      if (control.hang) {
        held.push(res);
        return;
      }
      if (control.reset) {
        req.socket.destroy();
        return;
      }
    }
    if (!await access.handle(req, res, url)) {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    for (const res of held) {
      res.destroy();
    }
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  return { control, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

function message(id: string, text: string): WecomInboundMessage {
  return { messageId: id, userId: 'alice', conversationId: 'group', chatType: 'group', text, attachments: [], replyContext: { requestId: id } };
}

/** A real bridge whose mint client signs for `target.url`, answering within 300 ms. */
function bridgeFixture(target: { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-terminal-link-'));
  cleanup.push(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'state.json');
  const policy: WecomBridgePolicy = {
    allowedUsers: ['alice'],
    cli: 'claude',
    replyCardActions: true,
    writableTerminalLinkInCard: true,
  };
  const core = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 'turn', target: { kind: 'turn' as const, sessionId: 'sid' } })),
    result: vi.fn(async () => ({ ok: true, state: 'running' as const, output: { content: 'result' } })),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => ({ ok: true })),
    progress: vi.fn(async () => ({ turnId: 'turn', workerGeneration: 1, entries: [] })),
  };
  const transport = {
    send: vi.fn(async (_recipient: string, _text: string) => {}),
    reply: vi.fn(async () => {}),
    sendCard: vi.fn(async (_recipient: string, _card: WecomTemplateCard) => {}),
    updateCard: vi.fn(async () => {}),
  };
  const terminalMintClient: TerminalMintClient = {
    request: options => createDaemonClient({
      dashboardUrl: target.url,
      appId: 'terminal-link-test',
      secret: SECRET,
      timeoutMs: 300,
    }).request(options),
  };
  const create = () => new WecomBridge({
    botId: 'bot',
    connectionId: 'connection',
    stateFile: file,
    allowedUsers: policy.allowedUsers,
    policy: () => policy,
    transport,
    core,
    terminalMintClient,
  });
  const task = () => Object.values(JSON.parse(readFileSync(file, 'utf8')).tasks)[0] as {
    cardEvents?: Record<string, true>;
  };
  /** Every private message to the clicker, split into links and the rest. */
  const toClicker = () => {
    const texts = transport.send.mock.calls.filter(([recipient]) => recipient === 'alice').map(([, text]) => text);
    return { links: texts.filter(text => text.includes(EXCHANGE)), other: texts.filter(text => !text.includes(EXCHANGE)) };
  };
  return { dir, file, transport, create, task, toClicker };
}

/** Admit one task, run one tick, and return a callback for its terminal button. */
async function terminalButton(bridge: WecomBridge, transport: ReturnType<typeof bridgeFixture>['transport']) {
  await bridge.receive(message('q', 'question'));
  await bridge.tick();
  const card = transport.sendCard.mock.calls
    .map(([, sent]) => sent)
    .find(sent => sent.button_list?.some(button => button.key === 'action:terminal'));
  expect(card).toBeDefined();
  /** A fresh delivery of the callback `messageId` (the platform may deliver one more than once). */
  return (messageId: string): WecomCardEvent => ({
    botId: 'bot',
    messageId,
    taskId: card!.task_id,
    eventKey: 'action:terminal',
    userId: 'alice',
    conversationId: 'group',
    chatType: 'group',
    receivedAt: Date.now(),
    requestId: `callback-${messageId}`,
  });
}

describe('one terminal mint request and its outcome', () => {
  const body: WecomTerminalMintRequest = {
    identity: { provider: 'wecom', connectionId: 'c', botId: 'b', userId: 'u' },
    sessionId: 's',
    triggerId: 't',
    permission: 'read',
  };
  const answering = (status: number, answer: unknown): TerminalMintClient => ({
    request: async () => ({ status, body: answer, raw: JSON.stringify(answer) }),
  });
  const failing = (error: unknown): TerminalMintClient => ({
    request: async () => {
      throw error;
    },
  });

  it.each([
    ['a link', answering(200, { ok: true, url: 'http://x/wecom-terminal/exchange?code=c', expiresAt: 1 }), 'minted'],
    ['a refusal', answering(403, { ok: false, error: 'native_terminal_rejected' }), 'rejected'],
    ['a failed signature', answering(401, { ok: false }), 'rejected'],
    ['a 200 that says ok: false', answering(200, { ok: false }), 'rejected'],
    ['a 200 without a link', answering(200, { ok: true }), 'rejected'],
    ['a link under a 403', answering(403, { ok: true, url: 'http://x/wecom-terminal/exchange?code=c', expiresAt: 1 }), 'rejected'],
    ['a link under a 500', answering(500, { ok: true, url: 'http://x/wecom-terminal/exchange?code=c', expiresAt: 1 }), 'rejected'],
    ['a refused connection', failing(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })), 'rejected'],
    ['a refused connection wrapped by fetch', failing(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'rejected'],
    ['a timeout', failing(new DOMException('The operation was aborted.', 'AbortError')), 'uncertain'],
    ['a reset after sending', failing(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'uncertain'],
  ] as const)('classifies %s', async (_name, client, kind) => {
    expect((await requestTerminalMint(() => client, body)).kind).toBe(kind);
  });

  it('counts a client that cannot be made (no Dashboard secret) as nothing sent', async () => {
    const outcome = await requestTerminalMint(() => {
      throw new Error('dashboard_secret_missing');
    }, body);
    expect(outcome.kind).toBe('rejected');
  });

  it.each([403, 500])('sends no link when a %s answer nevertheless carries one (real bridge)', async status => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: 'http://127.0.0.1:12345/wecom-terminal/exchange?code=c', expiresAt: Date.now() + 60_000 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    });
    const f = bridgeFixture({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);

    await bridge.receiveCardEvent(click('click-1'));
    expect(f.toClicker()).toEqual({ links: [], other: [expect.any(String)] });
    expect(f.task().cardEvents?.['click-1']).toBeUndefined();
  });
});

describe('a terminal button whose mint does not succeed (real bridge, fake Dashboard)', () => {
  it('takes a refused connection back, tells the clicker once, and the same callback then gets its link', async () => {
    const dashboard = await fakeDashboard();
    const target = { url: await closedPortUrl() };
    const f = bridgeFixture(target);
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);

    await bridge.receiveCardEvent(click('click-1'));
    expect(f.toClicker()).toEqual({ links: [], other: [expect.any(String)] });
    expect(f.toClicker().other[0]).not.toMatch(/ECONNREFUSED|https?:\/\//);
    expect(f.task().cardEvents?.['click-1']).toBeUndefined();

    target.url = dashboard.url;
    await bridge.receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(1);
    expect(f.toClicker().links).toHaveLength(1);
    expect(f.toClicker().other).toHaveLength(1);
    expect(f.task().cardEvents?.['click-1']).toBe(true);
  });

  it('tells the clicker only once when a refused callback is delivered again and refused again', async () => {
    const dashboard = await fakeDashboard();
    dashboard.control.deny = true;
    const f = bridgeFixture({ url: dashboard.url });
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);

    await bridge.receiveCardEvent(click('click-1'));
    await bridge.receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(2);
    expect(f.toClicker()).toEqual({ links: [], other: [expect.any(String)] });
    expect(f.toClicker().other[0]).not.toContain('native_terminal_rejected');

    // A restart reads both records from disk: still one message.
    const restarted = f.create();
    await restarted.receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(3);
    expect(f.toClicker().other).toHaveLength(1);

    dashboard.control.deny = false;
    await restarted.receiveCardEvent(click('click-1'));
    expect(f.toClicker().links).toHaveLength(1);
  });

  it.each(['hang', 'reset'] as const)('tells the clicker once and keeps the callback blocked when the mint gets no answer (%s)', async mode => {
    const dashboard = await fakeDashboard();
    dashboard.control[mode] = true;
    const f = bridgeFixture({ url: dashboard.url });
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);

    await bridge.receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(1);
    expect(f.toClicker()).toEqual({ links: [], other: [expect.any(String)] });
    expect(f.toClicker().other[0]).not.toMatch(/ECONNRESET|AbortError|aborted|https?:\/\//);
    expect(f.task().cardEvents?.['click-1']).toBe(true);

    // Delivered again, before and after a restart: no request, no second message.
    dashboard.control[mode] = false;
    await bridge.receiveCardEvent(click('click-1'));
    await f.create().receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(1);
    expect(f.toClicker()).toEqual({ links: [], other: [expect.any(String)] });

    // A new click is a new callback and gets its link.
    await f.create().receiveCardEvent(click('click-2'));
    expect(f.toClicker().links).toHaveLength(1);
  });

  it('keeps a failed message about an unanswered mint from breaking anything', async () => {
    const dashboard = await fakeDashboard();
    dashboard.control.hang = true;
    const f = bridgeFixture({ url: dashboard.url });
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);
    f.transport.send.mockRejectedValueOnce(new Error('send failed'));

    await expect(bridge.receiveCardEvent(click('click-1'))).resolves.toBeUndefined();
    expect(bridge.poisoned).toBe(false);
    expect(f.task().cardEvents?.['click-1']).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('keeps the callback blocked and tells no one when taking it back cannot be written', async () => {
    const dashboard = await fakeDashboard();
    const f = bridgeFixture({ url: dashboard.url });
    const bridge = f.create();
    const click = await terminalButton(bridge, f.transport);
    dashboard.control.onRequest = () => {
      // The record was written before the request; nothing more can be.
      chmodSync(f.dir, 0o500);
      dashboard.control.deny = true;
    };

    await expect(bridge.receiveCardEvent(click('click-1'))).rejects.toMatchObject({ code: 'EACCES' });
    expect(bridge.poisoned).toBe(true);
    expect(f.toClicker()).toEqual({ links: [], other: [] });

    chmodSync(f.dir, 0o700);
    dashboard.control.onRequest = undefined;
    dashboard.control.deny = false;
    expect(f.task().cardEvents?.['click-1']).toBe(true);
    await f.create().receiveCardEvent(click('click-1'));
    expect(dashboard.control.requests).toBe(1);
    expect(f.toClicker()).toEqual({ links: [], other: [] });
  });
});

describe('where the gateway sends a mint when no client is injected', () => {
  it('reaches the port the Dashboard recorded in ~/.botmux/.dashboard-port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wecom-terminal-link-home-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const dashboard = await fakeDashboard();
    mkdirSync(join(home, '.botmux'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.botmux', '.dashboard-secret'), SECRET, { mode: 0o600 });
    writeFileSync(join(home, '.botmux', '.dashboard-port'), new URL(dashboard.url).port, { mode: 0o600 });
    const source = `
      const { WecomBridge } = await import(${JSON.stringify(resolve('src/im/wecom/gateway/bridge.ts'))});
      const { join } = await import('node:path');
      const sent = [];
      const cards = [];
      const bridge = new WecomBridge({
        botId: 'bot',
        connectionId: 'connection',
        stateFile: join(process.env.HOME, 'state.json'),
        allowedUsers: ['alice'],
        policy: () => ({ allowedUsers: ['alice'], cli: 'claude', replyCardActions: true }),
        transport: {
          send: async (to, text) => { sent.push({ to, text }); },
          reply: async () => {},
          sendCard: async (_to, card) => { cards.push(card); },
          updateCard: async () => {},
        },
        core: {
          trigger: async () => ({ ok: true, triggerId: 'turn', target: { kind: 'turn', sessionId: 'sid' } }),
          result: async () => ({ ok: true, state: 'running', output: { content: 'result' } }),
          interrupt: async () => {},
        },
      });
      await bridge.receive({ messageId: 'q', userId: 'alice', conversationId: 'group', chatType: 'group', text: 'question', attachments: [], replyContext: { requestId: 'q' } });
      await bridge.tick();
      const card = cards.find(c => c.button_list?.some(b => b.key === 'action:terminal'));
      await bridge.receiveCardEvent({ botId: 'bot', messageId: 'click', taskId: card.task_id, eventKey: 'action:terminal', userId: 'alice', conversationId: 'group', chatType: 'group', receivedAt: Date.now(), requestId: 'callback' });
      console.log(JSON.stringify({ sent }));
      process.exit(0);
    `;
    const child = spawnTsEvalWithRepoImports(source, {
      cwd: resolve('.'),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const [code] = await once(child, 'exit') as [number | null];
    clearTimeout(timer);
    expect(code, stderr).toBe(0);
    const { sent } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { sent: Array<{ to: string; text: string }> };
    expect(dashboard.control.requests).toBe(1);
    expect(sent.filter(item => item.to === 'alice' && item.text.includes(EXCHANGE))).toHaveLength(1);
  }, 90_000);
});
