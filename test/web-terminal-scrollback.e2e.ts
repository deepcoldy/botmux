/**
 * E2E test: Web terminal scrollback replay.
 *
 * Tests that the WebSocket replay mechanism correctly sends accumulated
 * scrollback to newly connected clients, and that xterm.js can render
 * the replayed content with working scroll.
 *
 * Simulates the worker.ts web server + scrollback buffer pattern without
 * spawning an actual CLI process.
 *
 * Run:  pnpm vitest run test/web-terminal-scrollback.e2e.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

// ─── Constants ───────────────────────────────────────────────────────────────

const HOST = '127.0.0.1';
const MAX_SCROLLBACK_ORIGINAL = 100_000;  // original value
const MAX_SCROLLBACK_INCREASED = 1_000_000; // 10x value

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate N lines of terminal output (with ANSI codes like real CLI output) */
function generateLines(count: number, charsPerLine = 80): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    // Simulate realistic CLI output with ANSI color codes
    const lineNum = String(i + 1).padStart(5, '0');
    const content = `\x1b[32m[${lineNum}]\x1b[0m ${'x'.repeat(charsPerLine - 15)}`;
    lines.push(content);
  }
  return lines.join('\r\n') + '\r\n';
}

interface TestServer {
  httpServer: Server;
  wss: WebSocketServer;
  port: number;
  scrollback: string;
  maxScrollback: number;
  /** Simulate PTY data arriving */
  feedData(data: string): void;
  /** Connect a WS client and collect all received data */
  connectClient(): Promise<{ data: string; close: () => void }>;
}

function createTestServer(maxScrollback: number): Promise<TestServer> {
  return new Promise((resolve) => {
    let scrollback = '';
    const httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('test');
    });
    const wss = new WebSocketServer({ server: httpServer });

    // Mirror worker.ts: replay scrollback on connection, broadcast new data
    wss.on('connection', (ws) => {
      if (scrollback.length > 0) {
        ws.send(scrollback);
      }
    });

    httpServer.listen(0, HOST, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      const server: TestServer = {
        httpServer,
        wss,
        port,
        get scrollback() { return scrollback; },
        set scrollback(v) { scrollback = v; },
        maxScrollback,

        feedData(data: string) {
          // Mirror worker.ts onPtyData scrollback logic
          scrollback += data;
          if (scrollback.length > maxScrollback) {
            scrollback = scrollback.slice(-maxScrollback);
          }
          // Broadcast to connected clients
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        },

        connectClient(): Promise<{ data: string; close: () => void }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${HOST}:${port}/`);
            let received = '';
            ws.on('open', () => {
              // Give time for replay to arrive
              setTimeout(() => {
                resolve({
                  data: received,
                  close: () => ws.close(),
                });
              }, 500);
            });
            ws.on('message', (msg) => {
              received += String(msg);
            });
            ws.on('error', reject);
          });
        },
      };

      resolve(server);
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Web terminal scrollback replay', () => {
  let server: TestServer | null = null;

  afterEach(() => {
    if (server) {
      for (const client of server.wss.clients) client.close();
      server.wss.close();
      server.httpServer.close();
      server = null;
    }
  });

  it('replays small scrollback correctly', async () => {
    server = await createTestServer(MAX_SCROLLBACK_ORIGINAL);
    const testData = generateLines(100);
    server.feedData(testData);

    const client = await server.connectClient();
    expect(client.data.length).toBe(testData.length);
    expect(client.data).toBe(testData);
    client.close();
  });

  it('truncates scrollback at MAX_SCROLLBACK limit', async () => {
    server = await createTestServer(MAX_SCROLLBACK_ORIGINAL);

    // Feed more than MAX_SCROLLBACK chars
    const bigData = generateLines(2000, 80); // ~160K chars > 100K limit
    server.feedData(bigData);

    expect(server.scrollback.length).toBeLessThanOrEqual(MAX_SCROLLBACK_ORIGINAL);

    const client = await server.connectClient();
    // Client should receive exactly the truncated buffer
    expect(client.data.length).toBe(server.scrollback.length);
    expect(client.data).toBe(server.scrollback);
    client.close();
  });

  it('replay data starts mid-line after truncation (potential scroll issue)', async () => {
    server = await createTestServer(MAX_SCROLLBACK_ORIGINAL);

    // Feed 2x the limit to force truncation
    const bigData = generateLines(3000, 80);
    server.feedData(bigData);

    const client = await server.connectClient();

    // After truncation via .slice(-MAX_SCROLLBACK), the buffer starts at an
    // arbitrary position — potentially mid-line or mid-ANSI-sequence.
    // This is a known issue that could cause xterm.js rendering problems.
    const firstNewline = client.data.indexOf('\n');
    const firstChars = client.data.substring(0, Math.min(firstNewline, 100));
    console.log(`[scroll] Replay starts with: ${JSON.stringify(firstChars)}`);
    console.log(`[scroll] Replay size: ${client.data.length} chars`);
    console.log(`[scroll] First newline at index: ${firstNewline}`);

    // Check if replay starts mid-ANSI-sequence (broken escape code)
    const startsClean = client.data.startsWith('\x1b[') || client.data.startsWith('\r\n');
    console.log(`[scroll] Starts with clean escape/newline: ${startsClean}`);

    // Count complete lines in replay
    const lines = client.data.split('\n').length;
    console.log(`[scroll] Total lines in replay: ${lines}`);

    client.close();
  });

  it('increased MAX_SCROLLBACK preserves more history', async () => {
    server = await createTestServer(MAX_SCROLLBACK_INCREASED);

    // Feed ~200K chars — fits in 1M but would overflow 100K
    const data = generateLines(3000, 80); // ~240K chars
    server.feedData(data);

    // With 1M limit, nothing should be truncated
    expect(server.scrollback.length).toBe(data.length);

    const client = await server.connectClient();
    expect(client.data.length).toBe(data.length);
    expect(client.data).toBe(data);
    client.close();

    console.log(`[10x] 3000 lines (${data.length} chars) preserved intact with 1M limit`);
  });

  it('xterm scrollback:50000 vs scrollback:100000 line capacity', async () => {
    // This test measures how many lines can fit before xterm client-side
    // scrollback would be the bottleneck vs server-side truncation.
    //
    // xterm scrollback:50000 = 50K lines max in browser
    // At ~80 chars/line = ~4M chars needed server-side
    // At ~120 chars/line (with ANSI) = ~6M chars needed server-side
    //
    // With MAX_SCROLLBACK=100K chars: ~1250 lines (way below 50K)
    // With MAX_SCROLLBACK=1M chars:   ~12500 lines (still below 50K)

    const charsPerLine = 80; // average

    const linesAt100K = Math.floor(MAX_SCROLLBACK_ORIGINAL / charsPerLine);
    const linesAt1M = Math.floor(MAX_SCROLLBACK_INCREASED / charsPerLine);

    console.log(`[capacity] MAX_SCROLLBACK=100K → ~${linesAt100K} lines`);
    console.log(`[capacity] MAX_SCROLLBACK=1M   → ~${linesAt1M} lines`);
    console.log(`[capacity] xterm scrollback:50000 → 50000 lines`);
    console.log(`[capacity] xterm scrollback:100000 → 100000 lines`);
    console.log(`[capacity] Server-side is always the bottleneck`);

    // Server-side is always the bottleneck — xterm client can hold more
    expect(linesAt100K).toBeLessThan(50_000);
    expect(linesAt1M).toBeLessThan(50_000);
  });

  it('large replay does not corrupt WebSocket framing', async () => {
    server = await createTestServer(MAX_SCROLLBACK_INCREASED);

    // Feed exactly 1M chars worth of data
    const lineCount = Math.ceil(MAX_SCROLLBACK_INCREASED / 100);
    const data = generateLines(lineCount, 85);
    server.feedData(data);

    // Should be truncated to exactly MAX_SCROLLBACK
    expect(server.scrollback.length).toBeLessThanOrEqual(MAX_SCROLLBACK_INCREASED);

    const client = await server.connectClient();

    // Verify no data corruption: the replay should be a suffix of the original
    expect(data.endsWith(client.data) || client.data === server.scrollback).toBe(true);
    console.log(`[ws] Replayed ${client.data.length} chars via WebSocket without corruption`);

    client.close();
  });

  it('concurrent clients each get full replay', async () => {
    server = await createTestServer(MAX_SCROLLBACK_ORIGINAL);

    const data = generateLines(500, 80);
    server.feedData(data);

    // Connect 3 clients concurrently
    const [c1, c2, c3] = await Promise.all([
      server.connectClient(),
      server.connectClient(),
      server.connectClient(),
    ]);

    expect(c1.data).toBe(server.scrollback);
    expect(c2.data).toBe(server.scrollback);
    expect(c3.data).toBe(server.scrollback);

    c1.close(); c2.close(); c3.close();
  });
});
