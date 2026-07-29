#!/usr/bin/env node
// Minimal stand-in for `codex app-server --listen ws://127.0.0.1:<port>` used by
// codex-rpc-engine.test.ts. Serves HTTP /readyz AND a JSON-RPC WebSocket on the
// SAME port (as the real app-server does), answering the handshake + thread/turn
// requests. Env knobs drive the failure-path tests:
//   FAKE_HANG_TURN=1     → never answer turn/start (wedged app-server)
//   FAKE_DIE_AFTER_MS=N  → exit(1) after N ms (crash → engine onDead)
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const listenArg = process.argv[process.argv.indexOf('--listen') + 1] || '';
const m = listenArg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
const port = m ? Number(m[1]) : 0;
const HANG_TURN = process.env.FAKE_HANG_TURN === '1';
const DIE_AFTER = process.env.FAKE_DIE_AFTER_MS ? Number(process.env.FAKE_DIE_AFTER_MS) : 0;
const PREVIEW_DELAY_READS = Number(process.env.FAKE_PREVIEW_DELAY_READS ?? '0');
const UPDATED_DELAY_READS = Number(process.env.FAKE_UPDATED_DELAY_READS ?? '0');
const UPDATED_BEFORE = Number(process.env.FAKE_UPDATED_BEFORE ?? '100');
const UPDATED_AFTER = Number(process.env.FAKE_UPDATED_AFTER ?? '101');
const SETTINGS_UPDATE_ACK_DELAY_MS = Number(process.env.FAKE_SETTINGS_UPDATE_ACK_DELAY_MS ?? '0');
const RPC_LOG = process.env.FAKE_RPC_LOG;
let threadReadAttempt = 0;
let currentThreadName;
const REQUEST_USER_INPUT = process.env.FAKE_REQUEST_USER_INPUT === '1';

const httpServer = createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  let pendingTurnReply;
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (RPC_LOG) appendFileSync(RPC_LOG, `${JSON.stringify(msg)}\n`);
    if (REQUEST_USER_INPUT && msg.id === 900 && (msg.result !== undefined || msg.error !== undefined)) {
      if (!pendingTurnReply) return;
      // Real traex 0.200.19 normalizes ANY reply to requestUserInput (empty
      // answers OR a JSON-RPC error) into {answers:{}} and COMPLETES the turn.
      // Model that: a direct reply always completes the turn. Only an explicit
      // `turn/interrupt` (below) ends it as interrupted. This keeps the fixture
      // faithful to the verified product behavior instead of inventing an
      // "error bubbles up" semantics that traex does not implement.
      const accepted = msg.result?.answers?.choice?.answers?.[0] === 'Yes';
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: pendingTurnReply,
        result: { accepted, status: 'completed' },
      }));
      pendingTurnReply = undefined;
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
      case 'initialize': return reply({ ok: true });
      case 'model/list': return reply({
        data: [
          {
            id: 'gpt-fast',
            model: 'gpt-fast',
            isDefault: true,
            serviceTiers: [
              { id: 'priority', name: 'Fast', description: 'faster' },
            ],
          },
          {
            id: 'gpt-standard',
            model: 'gpt-standard',
            isDefault: false,
            serviceTiers: [],
          },
        ],
        nextCursor: null,
      });
      case 'thread/start': return reply({ thread: { id: 'thread-fake-1' } });
      case 'thread/resume': return reply({ thread: { id: msg.params?.threadId ?? 'thread-fake-1' } });
      case 'thread/settings/update':
        if (SETTINGS_UPDATE_ACK_DELAY_MS > 0) {
          return setTimeout(() => reply({}), SETTINGS_UPDATE_ACK_DELAY_MS);
        }
        return reply({});
      case 'thread/read':
        threadReadAttempt += 1;
        return reply({ thread: {
          id: msg.params?.threadId ?? 'thread-fake-1',
          name: currentThreadName ?? null,
          preview: threadReadAttempt > PREVIEW_DELAY_READS ? '<botmux_routing> first message preview' : '',
          updatedAt: threadReadAttempt > UPDATED_DELAY_READS ? UPDATED_AFTER : UPDATED_BEFORE,
        } });
      case 'thread/name/set': currentThreadName = msg.params?.name; return reply({});
      case 'turn/interrupt': {
        // FAKE_INTERRUPT_ERROR=1 models an interrupt that itself fails: the
        // app-server rejects turn/interrupt with a JSON-RPC error. The engine
        // then has no lever left and must declare itself dead (onDead) rather
        // than leaking a wedged turn.
        if (process.env.FAKE_INTERRUPT_ERROR === '1') {
          return ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32000, message: 'interrupt failed' },
          }));
        }
        // Verified real behavior: interrupt ends the in-flight turn as
        // 'interrupted' and acks with {}. Resolve the pending turn/start as an
        // interrupted turn so the engine test can assert the turn stopped
        // instead of silently completing.
        if (pendingTurnReply) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: pendingTurnReply,
            result: { turn: { status: 'interrupted' } },
          }));
          pendingTurnReply = undefined;
        }
        return reply({});
      }
      case 'turn/start': {
        if (HANG_TURN) return;
        if (REQUEST_USER_INPUT) {
          pendingTurnReply = msg.id;
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 900,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: msg.params?.threadId ?? 'thread-fake-1',
              turnId: 'turn-fake-1',
              itemId: 'item-fake-1',
              questions: [{
                id: 'choice', header: 'Test', question: 'Continue?', multiSelect: false,
                options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
              }],
            },
          }));
          return;
        }
        return reply({ accepted: true });
      }
      default: return reply({});
    }
  });
});
httpServer.listen(port, '127.0.0.1');
if (DIE_AFTER > 0) setTimeout(() => process.exit(1), DIE_AFTER);
