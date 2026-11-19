/**
 * `botmux send --mention <bot on this machine>` (D2): the real CLI asks the
 * daemon to register the handoff before the message leaves and binds it to the
 * exact message id afterwards. A send without such a mention, or a daemon that
 * declines, leaves the send exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

let dir: string;
let server: Server;
let port: number;
let calls: Array<{ path: string; body: any }>;
let prepareReply: Record<string, unknown>;
const DELIVERY = '11111111-2222-4333-8444-555555555555';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-mention-handoff-'));
  calls = [];
  prepareReply = { ok: true, delegated: true, deliveryId: DELIVERY, targetAppIds: ['cli_peer'] };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as empty */ }
      calls.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/dispatch-user/mention-prepare') return res.end(JSON.stringify(prepareReply));
      if (req.url === '/api/dispatch-user/mention-bind') return res.end(JSON.stringify({ ok: true, bound: true }));
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_in_test' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function send(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const botsPath = join(dir, 'bots.json');
  writeFileSync(botsPath, JSON.stringify([
    { larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [], workingDir: dir },
  ]));
  // This machine's bots, and the open_id this app sees the peer bot as.
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: 'cli_test', botName: 'Self', botOpenId: 'ou_self_own' },
    { larkAppId: 'cli_peer', botName: 'Peer', botOpenId: 'ou_peer_own' },
  ]));
  writeFileSync(join(dataDir, 'bot-openids-cli_test.json'), JSON.stringify({ Peer: 'ou_peer_seen' }));
  seedPersistedSessionRows(dataDir, 'cli_test', {
    'test-handoff': {
      sessionId: 'test-handoff', larkAppId: 'cli_test', chatId: 'oc_test',
      scope: 'chat', status: 'active', cliId: 'claude-code', workingDir: dir,
      ownerOpenId: 'ou_owner', createdAt: new Date(0).toISOString(),
    },
  });
  const child = spawnTsScript(fileURLToPath(new URL('./fixtures/send-mention-handoff-capture.ts', import.meta.url)), args, {
    env: {
      PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: botsPath,
      BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_SESSION_ID: 'test-handoff', BOTMUX_CHAT_ID: 'oc_test',
      BOTMUX_SESSION_SCOPE: 'chat', BOTMUX_DAEMON_IPC_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout!.on('data', chunk => { out += chunk; });
  child.stderr!.on('data', chunk => { err += chunk; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, out, err };
}
const handoffCalls = () => calls.filter(call => call.path.startsWith('/api/dispatch-user/'));

describe('botmux send --mention handoff', () => {
  it('registers the handoff before the message leaves and binds it to the sent message id', async () => {
    const result = await send(['send', '--mention', 'ou_peer_seen:Peer', '请接手这一步']);
    expect(result.code, result.err + result.out).toBe(0);
    const [prepare, bind] = handoffCalls();
    expect(prepare).toMatchObject({
      path: '/api/dispatch-user/mention-prepare',
      body: { sessionId: 'test-handoff', chatId: 'oc_test', targetAppIds: ['cli_peer'] },
    });
    expect(bind).toMatchObject({
      path: '/api/dispatch-user/mention-bind',
      body: { sessionId: 'test-handoff', deliveryId: DELIVERY, messageId: 'om_handoff_sent' },
    });
    // The process names target bots only; who the human is stays the daemon's call.
    expect(Object.keys(prepare.body).filter(key => /open|union|caller|user/i.test(key))).toEqual([]);
    expect(result.out).toContain('CAPTURE_MESSAGE=');
  });

  it('a bot woken by an @ written in the text is a handoff target too', async () => {
    const result = await send(['send', '--mention', 'ou_human:Someone', '请 @Peer 接手这一步']);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out).toContain('ou_peer_seen');
    expect(handoffCalls()[0]).toMatchObject({
      path: '/api/dispatch-user/mention-prepare', body: { targetAppIds: ['cli_peer'] },
    });
  });

  it('asks nothing for a mention of a person', async () => {
    const result = await send(['send', '--mention', 'ou_human:Someone', '看一下']);
    expect(result.code, result.err + result.out).toBe(0);
    expect(handoffCalls()).toEqual([]);
  });

  it('sends unchanged and binds nothing when the daemon declines', async () => {
    prepareReply = { ok: true, delegated: false, reason: 'delegate_on_mention_off' };
    const result = await send(['send', '--mention', 'ou_peer_seen:Peer', '请接手这一步']);
    expect(result.code, result.err + result.out).toBe(0);
    expect(handoffCalls().map(call => call.path)).toEqual(['/api/dispatch-user/mention-prepare']);
    expect(result.out).toContain('CAPTURE_MESSAGE=');
  });
});
