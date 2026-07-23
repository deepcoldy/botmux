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
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

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
let turnCount = 0;

const httpServer = createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
      case 'initialize': return reply({ ok: true });
      case 'thread/start': return reply({ thread: { id: 'thread-fake-1' } });
      case 'thread/resume': return reply({ thread: { id: msg.params?.threadId ?? 'thread-fake-1' } });
      case 'turn/start': {
        turnCount++;
        const nativeTurnId = `turn-fake-${turnCount}`;
        const terminal = () => {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: msg.params?.threadId, turn: { id: nativeTurnId } },
          }));
          if (!NO_TURN_TERMINAL) {
            const turn = {
              id: nativeTurnId,
              ...(TURN_STATUS ? { status: TURN_STATUS } : {}),
              ...(TURN_STATUS === 'failed'
                ? { error: { code: 'fake_failed', message: 'fake failure' } }
                : {}),
            };
            const completed = JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { threadId: msg.params?.threadId, turn },
            });
            ws.send(completed);
            if (DUPLICATE_TERMINAL) ws.send(completed);
          }
        };
        if (HANG_TURN) {
          if (HANG_TURN_NOTIFY) terminal();
          return;
        }
        if (TERMINAL_BEFORE_RESPONSE) {
          terminal();
          reply({ turn: { id: nativeTurnId } });
        } else {
          reply({ turn: { id: nativeTurnId } });
          terminal();
        }
        return;
      }
      default: return reply({});
    }
  });
});
httpServer.listen(port, '127.0.0.1');
if (DIE_AFTER > 0) setTimeout(() => process.exit(1), DIE_AFTER);
