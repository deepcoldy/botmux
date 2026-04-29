// src/dashboard.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, statSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import {
  generateToken, parseCookie, buildSetCookie, verifyHmac,
} from './dashboard/auth.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');

let activeToken: string | null = null;

function loadOrCreateSecret(): string {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf8').trim();
  const s = randomBytes(32).toString('base64url');
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  logger.info(`[dashboard] Generated dashboard secret at ${SECRET_PATH}`);
  return s;
}

const SECRET = loadOrCreateSecret();
mkdirSync(REGISTRY_DIR, { recursive: true });
const registry = new DaemonRegistry(REGISTRY_DIR);
const aggregator = new Aggregator();
const subs = new Map<string, () => void>();

function syncSubscriptions(): void {
  const online = new Set(registry.list().map(d => d.larkAppId));
  // Open new subscriptions
  for (const d of registry.list()) {
    if (!subs.has(d.larkAppId)) {
      subs.set(
        d.larkAppId,
        subscribeDaemon(d, aggregator, e =>
          logger.warn(`[aggregator] ${d.larkAppId}: ${e.message}`),
        ),
      );
    }
  }
  // Close subscriptions for offline daemons
  for (const [id, off] of subs) {
    if (!online.has(id)) { off(); subs.delete(id); }
  }
}

await registry.start();
registry.on(syncSubscriptions);
syncSubscriptions();

// Initial hydrate from each online daemon
async function hydrate(): Promise<void> {
  for (const d of registry.list()) {
    try {
      const [sRes, schRes] = await Promise.all([
        fetch(`http://127.0.0.1:${d.ipcPort}/api/sessions`),
        fetch(`http://127.0.0.1:${d.ipcPort}/api/schedules`),
      ]);
      const s = await sRes.json() as { sessions: any[] };
      const sch = await schRes.json() as { schedules: any[] };
      aggregator.hydrateSessions(d.larkAppId, s.sessions ?? []);
      aggregator.hydrateSchedules(sch.schedules ?? []);
    } catch (e: any) {
      logger.warn(`[dashboard] hydrate ${d.larkAppId}: ${e.message ?? e}`);
    }
  }
}
await hydrate();

// ─── Static frontend ─────────────────────────────────────────────────────────

// Path to the bundled frontend (sibling of dist/dashboard.js)
const __dirname = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(__dirname, 'dashboard-web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(_req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fp = join(WEB_DIR, rel);
  // Path-traversal guard: resolved path must stay inside WEB_DIR
  if (!fp.startsWith(WEB_DIR + '/') && fp !== join(WEB_DIR, 'index.html')) return false;
  try {
    const st = statSync(fp);
    if (!st.isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(fp)] ?? 'application/octet-stream' });
    res.end(readFileSync(fp));
    return true;
  } catch {
    return false;
  }
}

// ─── HTTP routing ────────────────────────────────────────────────────────────

function authedToken(req: IncomingMessage, url: URL): string | undefined {
  const q = url.searchParams.get('t');
  if (q && q === activeToken) return q;
  return parseCookie(req.headers.cookie);
}

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function proxyToDaemon(
  larkAppId: string, daemonPath: string, init: RequestInit,
): Promise<Response> {
  const d = registry.getByAppId(larkAppId);
  if (!d) {
    return new Response(JSON.stringify({ ok: false, error: 'daemon_offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return fetch(`http://127.0.0.1:${d.ipcPort}${daemonPath}`, init);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard`
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const ts = req.headers['x-botmux-cli-ts'];
      const nonce = req.headers['x-botmux-cli-nonce'];
      const sig = req.headers['x-botmux-cli-auth'];
      if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
        return jsonRes(res, 400, { error: 'missing_headers' });
      }
      const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const r = verifyHmac(SECRET, { ts, nonce, sig }, remote);
      if (!r.ok) return jsonRes(res, 401, { error: 'unauthorized', reason: r.reason });
      activeToken = generateToken();
      const fullUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}/?t=${activeToken}`;
      return jsonRes(res, 200, { url: fullUrl });
    }

    // All other paths require an authenticated session.
    const tok = authedToken(req, url);
    if (!tok || tok !== activeToken) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
      return;
    }

    // First hit with `?t=<token>` sets the cookie + redirects to clean URL.
    if (url.searchParams.has('t')) {
      res.writeHead(302, {
        'set-cookie': buildSetCookie(tok),
        'location': url.pathname || '/',
      });
      res.end();
      return;
    }

    // ─── Static frontend (index.html + /assets/*) ──────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      // Map /assets/foo.js → WEB_DIR/foo.js
      const lookupPath = url.pathname.startsWith('/assets/')
        ? '/' + url.pathname.slice(8)
        : url.pathname;
      if (serveStatic(req, res, lookupPath)) return;
    }

    // ─── Public API (cookie/token already validated above) ──────────────────

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return jsonRes(res, 200, { sessions: aggregator.getSessions() });
    }
    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      return jsonRes(res, 200, { schedules: aggregator.getSchedules() });
    }

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(close|locate)$/))) {
      const sid = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/${op}`, { method: 'POST' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(run|pause|resume)$/))) {
      const id = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.scheduleOwnerOf(id);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_schedule' });
      const upstream = await proxyToDaemon(owner, `/api/schedules/${id}/${op}`, { method: 'POST' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ─── Groups (Phase B) ────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      // Fan out: each online daemon returns the chats its bot is in.
      // Merge by chatId; populate memberBots with inChat flags for every configured bot.
      const out = new Map<string, any>();
      const onlineBots = registry.list();
      await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups`);
          if (!r.ok) return;
          const j = await r.json() as { chats?: any[] };
          for (const c of j.chats ?? []) {
            const cur = out.get(c.chatId) ?? { ...c, memberBots: [] as any[] };
            cur.memberBots.push({ larkAppId: d.larkAppId, botName: d.botName, inChat: true });
            out.set(c.chatId, cur);
          }
        } catch { /* skip offline daemons silently — best-effort */ }
      }));
      // Fill in inChat:false slots for bots NOT returned for a given chat (matrix view)
      for (const c of out.values()) {
        const present = new Set<string>(c.memberBots.map((mb: any) => mb.larkAppId));
        for (const b of onlineBots) {
          if (!present.has(b.larkAppId)) {
            c.memberBots.push({ larkAppId: b.larkAppId, botName: b.botName, inChat: false });
          }
        }
      }
      return jsonRes(res, 200, {
        chats: [...out.values()].sort((a, b) => (a.name ?? a.chatId).localeCompare(b.name ?? b.chatId)),
        bots: onlineBots.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })),
      });
    }

    let m2: RegExpMatchArray | null;
    if (req.method === 'POST' && (m2 = url.pathname.match(/^\/api\/groups\/([^/]+)\/add-bots$/))) {
      const chatId = decodeURIComponent(m2[1]);
      // Read body once; we'll forward it to the proxy daemon
      let raw: string;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        raw = Buffer.concat(chunks).toString('utf8') || '{}';
        JSON.parse(raw); // validate is JSON
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // Find a daemon whose bot is already in this chat
      let proxy: { larkAppId: string; ipcPort: number } | undefined;
      for (const d of registry.list()) {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`);
          if (!r.ok) continue;
          const j = await r.json() as { inChat?: boolean };
          if (j.inChat) { proxy = d; break; }
        } catch { /* skip */ }
      }
      if (!proxy) return jsonRes(res, 200, { ok: false, error: 'no_proxy_bot' });
      const upstream = await fetch(
        `http://127.0.0.1:${proxy.ipcPort}/api/groups/${encodeURIComponent(chatId)}/add-bots`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw },
      );
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Public SSE — relays aggregator's listener events
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      const off = aggregator.on(ev => {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ larkAppId: ev.larkAppId, body: ev.body })}\n\n`);
      });
      const hb = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      }, 15_000);
      res.on('close', () => { off(); clearInterval(hb); });
      return;
    }

    // Public API + static frontend land in Task 17 / 18. For now: 404.
    jsonRes(res, 404, { error: 'not_found_yet', path: url.pathname });
  } catch (err) {
    logger.error('[dashboard] handler error', err);
    if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
  }
});

server.listen(config.dashboard.port, config.dashboard.host, () => {
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${config.dashboard.port}`);
});

// Graceful shutdown
function shutdown(): void {
  for (const off of subs.values()) off();
  subs.clear();
  registry.stop();
  server.close(() => process.exit(0));
  // Hard-exit fallback after 5s
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
