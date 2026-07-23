#!/usr/bin/env node
// Minimal stand-in for `codex app-server --listen ws://127.0.0.1:<port>` used by
// codex-rpc-engine.test.ts. Serves HTTP /readyz AND a JSON-RPC WebSocket on the
// SAME port (as the real app-server does), answering the handshake + thread/turn
// requests. Env knobs drive the failure-path tests:
//   FAKE_HANG_TURN=1     → never answer turn/start (wedged app-server)
//   FAKE_HANG_TURN_NOTIFY=1 → emit started/completed but lose the ack
//   FAKE_TERMINAL_BEFORE_RESPONSE=1 → broadcast terminal before turn/start ack
//   FAKE_DUPLICATE_TERMINAL=1 → broadcast turn/completed twice
//   FAKE_DIE_AFTER_MS=N  → exit(1) after N ms (crash → engine onDead)
//   FAKE_THREAD_CONFIG_FILE=path → write the received thread/start params to path
//                                  (lets a test assert model/effort forwarding)
//   FAKE_RESUME_CONFIG_FILE=path → write the received thread/resume params to path
//                                  (lets a test assert model/effort are SUPPRESSED
//                                   on resume)
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { writeFileSync } from 'node:fs';

const listenArg = process.argv[process.argv.indexOf('--listen') + 1] || '';
const m = listenArg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
const port = m ? Number(m[1]) : 0;
const HANG_TURN = process.env.FAKE_HANG_TURN === '1';
const HANG_TURN_NOTIFY = process.env.FAKE_HANG_TURN_NOTIFY === '1';
const TERMINAL_BEFORE_RESPONSE = process.env.FAKE_TERMINAL_BEFORE_RESPONSE === '1';
const DUPLICATE_TERMINAL = process.env.FAKE_DUPLICATE_TERMINAL === '1';
const NO_TURN_TERMINAL = process.env.FAKE_NO_TURN_TERMINAL === '1';
const TURN_STATUS = process.env.FAKE_TURN_STATUS ?? '';
const DIE_AFTER = process.env.FAKE_DIE_AFTER_MS ? Number(process.env.FAKE_DIE_AFTER_MS) : 0;
const PREVIEW_DELAY_READS = Number(process.env.FAKE_PREVIEW_DELAY_READS ?? '0');
const UPDATED_DELAY_READS = Number(process.env.FAKE_UPDATED_DELAY_READS ?? '0');
const UPDATED_BEFORE = Number(process.env.FAKE_UPDATED_BEFORE ?? '100');
const UPDATED_AFTER = Number(process.env.FAKE_UPDATED_AFTER ?? '101');
let threadReadAttempt = 0;
let currentThreadName;
const REQUEST_USER_INPUT = process.env.FAKE_REQUEST_USER_INPUT === '1';
let turnCount = 0;

const httpServer = createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  let pendingTurnReply;
  let pendingNativeTurnId;
  let pendingThreadId;
  const emitTurnLifecycle = (threadId, nativeTurnId, status = TURN_STATUS) => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId, turn: { id: nativeTurnId } },
    }));
    if (NO_TURN_TERMINAL) return;
    const turn = {
      id: nativeTurnId,
      ...(status ? { status } : {}),
      ...(status === 'failed'
        ? { error: { code: 'fake_failed', message: 'fake failure' } }
        : {}),
    };
    const completed = JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId, turn },
    });
    ws.send(completed);
    if (DUPLICATE_TERMINAL) ws.send(completed);
  };
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
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
        result: { accepted, turn: { id: pendingNativeTurnId, status: 'completed' } },
      }));
      emitTurnLifecycle(pendingThreadId, pendingNativeTurnId, 'completed');
      pendingTurnReply = undefined;
      pendingNativeTurnId = undefined;
      pendingThreadId = undefined;
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
      case 'initialize': return reply({ ok: true });
      case 'thread/start': {
        if (process.env.FAKE_THREAD_CONFIG_FILE) {
          try { writeFileSync(process.env.FAKE_THREAD_CONFIG_FILE, JSON.stringify(msg.params ?? {})); } catch { /* test-only */ }
        }
        return reply({ thread: { id: 'thread-fake-1' } });
      }
      case 'thread/resume': {
        if (process.env.FAKE_RESUME_CONFIG_FILE) {
          try { writeFileSync(process.env.FAKE_RESUME_CONFIG_FILE, JSON.stringify(msg.params ?? {})); } catch { /* test-only */ }
        }
        return reply({ thread: { id: msg.params?.threadId ?? 'thread-fake-1' } });
      }
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
            result: { turn: { id: pendingNativeTurnId, status: 'interrupted' } },
          }));
          emitTurnLifecycle(pendingThreadId, pendingNativeTurnId, 'interrupted');
          pendingTurnReply = undefined;
          pendingNativeTurnId = undefined;
          pendingThreadId = undefined;
        }
        return reply({});
      }
      case 'turn/start': {
        turnCount++;
        const nativeTurnId = `turn-fake-${turnCount}`;
        const threadId = msg.params?.threadId;
        if (HANG_TURN) {
          if (HANG_TURN_NOTIFY) emitTurnLifecycle(threadId, nativeTurnId);
          return;
        }
        if (REQUEST_USER_INPUT) {
          pendingTurnReply = msg.id;
          pendingNativeTurnId = nativeTurnId;
          pendingThreadId = threadId;
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 900,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: msg.params?.threadId ?? 'thread-fake-1',
              turnId: nativeTurnId,
              itemId: 'item-fake-1',
              questions: [{
                id: 'choice', header: 'Test', question: 'Continue?', multiSelect: false,
                options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
              }],
            },
          }));
          return;
        }
        if (TERMINAL_BEFORE_RESPONSE) {
          emitTurnLifecycle(threadId, nativeTurnId);
          reply({ turn: { id: nativeTurnId } });
        } else {
          reply({ turn: { id: nativeTurnId } });
          emitTurnLifecycle(threadId, nativeTurnId);
        }
        return;
      }
      default: return reply({});
    }
  });
});
httpServer.listen(port, '127.0.0.1');
if (DIE_AFTER > 0) setTimeout(() => process.exit(1), DIE_AFTER);
