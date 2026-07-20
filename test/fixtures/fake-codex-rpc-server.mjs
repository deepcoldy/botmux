#!/usr/bin/env node
// Minimal stand-in for `codex app-server --listen ws://127.0.0.1:<port>` used by
// codex-rpc-engine.test.ts. Serves HTTP /readyz AND a JSON-RPC WebSocket on the
// SAME port (as the real app-server does), answering the handshake + thread/turn
// requests. Env knobs drive the failure-path tests:
//   FAKE_HANG_TURN=1     → never answer turn/start (wedged app-server)
//   FAKE_DIE_AFTER_MS=N  → exit(1) after N ms (crash → engine onDead)
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const listenArg = process.argv[process.argv.indexOf('--listen') + 1] || '';
const m = listenArg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
const port = m ? Number(m[1]) : 0;
const HANG_TURN = process.env.FAKE_HANG_TURN === '1';
const DIE_AFTER = process.env.FAKE_DIE_AFTER_MS ? Number(process.env.FAKE_DIE_AFTER_MS) : 0;

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
      case 'turn/start': if (HANG_TURN) return; return reply({ accepted: true });
      default: return reply({});
    }
  });
});
httpServer.listen(port, '127.0.0.1');
if (DIE_AFTER > 0) setTimeout(() => process.exit(1), DIE_AFTER);
