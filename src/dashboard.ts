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
  generateToken, parseCookie, buildSetCookie, verifyHmac, decideDashboardAuth,
} from './dashboard/auth.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';
import { pickCreatorForGroup } from './dashboard/operator-selector.js';
import { handleWorkflowApi, jsonRes } from './dashboard/workflow-api.js';
import { getRunsDir } from './workflows/runs-dir.js';
import { BotOnboardingManager } from './dashboard/bot-onboarding.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const BOTS_JSON_PATH = join(homedir(), '.botmux', 'bots.json');
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
const botOnboarding = new BotOnboardingManager({ botsJsonPath: BOTS_JSON_PATH });
const subs = new Map<string, () => void>();
const attaching = new Set<string>();   // dedup concurrent attaches per appId

/**
 * Attach to one daemon: hydrate its sessions/schedules into the aggregator,
 * THEN open the SSE subscription. Order matters — hydrating after subscribe
 * would let snapshot data clobber events that arrived between subscribe and
 * the snapshot fetch.
 *
 * Idempotent: a second call for the same daemon while one is in flight is a
 * no-op; a call after attach finished re-hydrates (useful when a daemon
 * restarts and we want to refresh its slice of the cache).
 */
async function attachDaemon(d: import('./dashboard/registry.js').DaemonInfo): Promise<void> {
  if (attaching.has(d.larkAppId)) return;
  attaching.add(d.larkAppId);
  try {
    // 1. Hydrate snapshot (blocking — completes before we wire SSE)
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
    // 2. Open SSE subscription if not already (idempotent)
    if (!subs.has(d.larkAppId)) {
      subs.set(
        d.larkAppId,
        subscribeDaemon(d, aggregator, e =>
          logger.warn(`[aggregator] ${d.larkAppId}: ${e.message}`),
        ),
      );
    }
  } finally {
    attaching.delete(d.larkAppId);
  }
}

function syncSubscriptions(): void {
  const online = new Set(registry.list().map(d => d.larkAppId));
  // Attach (hydrate + subscribe) any newly-online daemon. Fire-and-forget
  // because the registry callback is sync and the attach is per-daemon
  // independent.
  for (const d of registry.list()) {
    if (!subs.has(d.larkAppId)) {
      void attachDaemon(d);
    }
  }
  // Close subscriptions for daemons that went offline. Cache entries are
  // intentionally retained — the user may still want to see the last-known
  // state of those sessions/schedules in the dashboard.
  for (const [id, off] of subs) {
    if (!online.has(id)) { off(); subs.delete(id); }
  }
}

await registry.start();
registry.on(syncSubscriptions);
// Initial attach for every daemon already known. Run in parallel so a slow
// daemon doesn't block the others.
await Promise.all(registry.list().map(attachDaemon));

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

/**
 * Close every active session matching `pred` by routing to its owning daemon.
 * Used after disband (close all sessions in chat) and leave (close only the
 * leaving bot's sessions in chat) so the UI doesn't end up with zombie workers
 * pointing at a chat the bot can no longer post into.
 */
async function closeSessionsMatching(
  pred: (s: any) => boolean,
): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
  const matching = aggregator.getSessions().filter(s => s.status !== 'closed' && pred(s));
  return Promise.all(matching.map(async s => {
    try {
      const upstream = await proxyToDaemon(
        s.larkAppId as string,
        `/api/sessions/${encodeURIComponent(s.sessionId)}/close`,
        { method: 'POST' },
      );
      const text = await upstream.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* tolerate */ }
      return {
        sessionId: s.sessionId as string,
        ok: !!body?.ok,
        error: body?.ok ? undefined : (body?.error ?? `http_${upstream.status}`),
      };
    } catch (e: any) {
      return { sessionId: s.sessionId as string, ok: false, error: e?.message ?? String(e) };
    }
  }));
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

    const presentedToken = authedToken(req, url);
    const decision = decideDashboardAuth({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      hasTokenParam: url.searchParams.has('t'),
      presentedToken,
      activeToken: activeToken ?? '',
    });
    // `authed` is consumed by route handlers that need to distinguish
    // "request got in via public-read carve-out" from "request has a
    // valid cookie" — e.g. `/api/workflows/runs/<id>/snapshot` strips
    // log bytes when unauth'd.  Mirror of the `authed` check in
    // `decideDashboardAuth`.
    const authed = !!presentedToken && presentedToken === activeToken && !!activeToken;

    if (decision.kind === 'deny401') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
      return;
    }

    if (decision.kind === 'allow+set-cookie') {
      res.writeHead(302, {
        'set-cookie': buildSetCookie(decision.token),
        'location': decision.redirectTo,
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

    if (req.method === 'POST' && url.pathname === '/api/bot-onboarding/start') {
      const job = botOnboarding.start();
      return jsonRes(res, 202, { job: botOnboarding.get(job.id) });
    }
    let mOnboard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mOnboard = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)$/))) {
      const job = botOnboarding.get(decodeURIComponent(mOnboard[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'unknown_onboarding_job' });
      return jsonRes(res, 200, { job });
    }

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(close|locate|resume)$/))) {
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

    // ─── Workflows (D0 read-only + D1 cancel mutation) ───────────────────────
    //
    // Dashboard reads runsDir directly (single-process; cross-daemon ownership
    // doesn't matter for read-only).  All readers in `ops-projection` are
    // pure: no mkdir, no EventLog instantiation.  Unknown / corrupt run → 404.
    // Mutations are intentionally proxied to the owner daemon from
    // chat-binding.larkAppId so only the daemon with live workflow runtime
    // context writes the event log.
    if (await handleWorkflowApi(req, res, url, {
      runsDir: getRunsDir(),
      proxyToDaemon,
    }, authed)) {
      return;
    }

    // ─── Groups (Phase B) ────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      // Fan out: each online daemon returns the chats its bot is in.
      // Merge by chatId; populate memberBots with inChat flags for every configured bot.
      const out = new Map<string, any>();
      // Sort by botIndex so the matrix columns + the create-group bot picker
      // both match the order in bots.json (fs.readdir order is unstable).
      const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
      await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups`);
          if (!r.ok) return;
          const j = await r.json() as { chats?: any[] };
          for (const c of j.chats ?? []) {
            // Strip per-bot fields from chat-level so the merged record stays
            // bot-agnostic. oncallChat lives inside memberBots; firstSeenAt is
            // accumulated as the earliest observation across all bots.
            const { oncallChat, firstSeenAt, hasRole, ...chatBase } = c;
            const cur = out.get(c.chatId) ?? { ...chatBase, memberBots: [] as any[], _firstSeenAt: null as number | null };
            cur.memberBots.push({
              larkAppId: d.larkAppId,
              botName: d.botName,
              inChat: true,
              oncallChat: oncallChat ?? null,
              hasRole: hasRole ?? false,
            });
            if (typeof firstSeenAt === 'number') {
              cur._firstSeenAt = cur._firstSeenAt === null
                ? firstSeenAt
                : Math.min(cur._firstSeenAt, firstSeenAt);
            }
            out.set(c.chatId, cur);
          }
        } catch { /* skip offline daemons silently — best-effort */ }
      }));
      // Fill in inChat:false slots for bots NOT returned for a given chat (matrix view)
      for (const c of out.values()) {
        const present = new Set<string>(c.memberBots.map((mb: any) => mb.larkAppId));
        for (const b of onlineBots) {
          if (!present.has(b.larkAppId)) {
            c.memberBots.push({ larkAppId: b.larkAppId, botName: b.botName, inChat: false, oncallChat: null, hasRole: false });
          }
        }
      }
      // Sort newest-first by client-side firstSeenAt (Lark exposes no chat
      // create_time, so daemon stamps timestamps the first time it lists each
      // chat). Tie-break by name asc so chats backfilled in the same listChats
      // pass — typically every chat on first deploy — get a stable order.
      const sorted = [...out.values()]
        .sort((a, b) => {
          const ta = a._firstSeenAt ?? 0;
          const tb = b._firstSeenAt ?? 0;
          if (tb !== ta) return tb - ta;
          return (a.name ?? a.chatId).localeCompare(b.name ?? b.chatId);
        })
        .map(({ _firstSeenAt, ...rest }) => rest);
      return jsonRes(res, 200, {
        chats: sorted,
        bots: onlineBots.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })),
      });
    }

    // ─── Roles (proxy to daemon) ────────────────────────────────────────────
    // GET    /api/roles/:larkAppId/:chatId → read role file
    // PUT    /api/roles/:larkAppId/:chatId → write role file
    // DELETE /api/roles/:larkAppId/:chatId → delete role file

    let mRole: RegExpMatchArray | null;
    if ((mRole = url.pathname.match(/^\/api\/roles\/([^/]+)\/([^/]+)$/))) {
      const larkAppId = decodeURIComponent(mRole[1]);
      const chatId = decodeURIComponent(mRole[2]);
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
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

    // Disband a chat. Body: `{ larkAppId }` — the bot whose daemon should
    // perform the delete. Disband only succeeds when that bot is currently
    // the chat owner (or creator with operate_as_owner scope, which botmux
    // doesn't request by default), so the frontend is responsible for picking
    // a viable bot. The route just proxies and surfaces Lark's error verbatim.
    let mDisband: RegExpMatchArray | null;
    if (req.method === 'POST' && (mDisband = url.pathname.match(/^\/api\/groups\/([^/]+)\/disband$/))) {
      const chatId = decodeURIComponent(mDisband[1]);
      let parsed: { larkAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const appId = typeof parsed.larkAppId === 'string' ? parsed.larkAppId : '';
      if (!appId) return jsonRes(res, 400, { ok: false, error: 'larkAppId_required' });
      const upstream = await proxyToDaemon(
        appId, `/api/groups/${encodeURIComponent(chatId)}/disband`,
        { method: 'POST' },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* tolerate */ }
      // On successful disband, the chat is gone for everyone — every bot's
      // session in this chat becomes a zombie (worker still alive, can't post).
      // Close them all so the UI / Sessions list don't keep them as active.
      let closedSessions: any[] = [];
      if (upstreamJson?.ok) {
        closedSessions = await closeSessionsMatching(s => s.chatId === chatId);
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...(upstreamJson ?? {}), closedSessions }));
      return;
    }

    // Make selected bots leave a chat. Body: `{ larkAppIds: string[] }`.  Each
    // bot is removed via its own daemon (Lark allows self-removal under any
    // role). Per-bot results returned so the UI can show partial successes.
    let mLeave: RegExpMatchArray | null;
    if (req.method === 'POST' && (mLeave = url.pathname.match(/^\/api\/groups\/([^/]+)\/leave$/))) {
      const chatId = decodeURIComponent(mLeave[1]);
      let parsed: { larkAppIds?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const ids = Array.isArray(parsed.larkAppIds)
        ? (parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      // Re-check membership on the daemon side before issuing leave — UI cache
      // can be stale, and Lark's bot-self-remove returns a confusing error if
      // the bot isn't actually in the chat. Skipping such bots up-front keeps
      // the per-bot result useful (`not_in_chat`) instead of a vague API error.
      const result = await Promise.all(ids.map(async appId => {
        const d = registry.getByAppId(appId);
        if (!d) return { larkAppId: appId, ok: false, error: 'daemon_offline' };
        try {
          const memRes = await fetch(
            `http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`,
          );
          const memJson = await memRes.json() as { inChat?: boolean };
          if (!memJson.inChat) return { larkAppId: appId, ok: false, error: 'not_in_chat' };
        } catch (e: any) {
          return { larkAppId: appId, ok: false, error: `membership_check_failed: ${e?.message ?? e}` };
        }
        const upstream = await proxyToDaemon(
          appId, `/api/groups/${encodeURIComponent(chatId)}/leave`,
          { method: 'POST' },
        );
        const text = await upstream.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* tolerate */ }
        // On successful leave, the leaving bot can no longer post into the
        // chat — its sessions there are stranded. Close only THIS bot's
        // sessions for THIS chat (other bots may still be in the chat with
        // their own active sessions).
        const closedSessions = body?.ok
          ? await closeSessionsMatching(s => s.chatId === chatId && s.larkAppId === appId)
          : [];
        return {
          larkAppId: appId,
          ok: !!body?.ok,
          error: body?.ok ? undefined : (body?.error ?? `http_${upstream.status}`),
          closedSessions,
        };
      }));
      return jsonRes(res, 200, { result });
    }

    // ─── Oncall bindings (per chat × bot) ────────────────────────────────────
    // PUT /api/groups/:chatId/oncall/:larkAppId    body: {workingDir}
    // DELETE /api/groups/:chatId/oncall/:larkAppId
    let mOncall: RegExpMatchArray | null;
    if ((mOncall = url.pathname.match(/^\/api\/groups\/([^/]+)\/oncall\/([^/]+)$/))) {
      const chatId = decodeURIComponent(mOncall[1]);
      const appId = decodeURIComponent(mOncall[2]);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(
          appId, `/api/oncall/${encodeURIComponent(chatId)}`,
          { method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw },
        );
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(
          appId, `/api/oncall/${encodeURIComponent(chatId)}`,
          { method: 'DELETE' },
        );
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    // ─── Per-bot defaults (Bot Defaults tab) ─────────────────────────────────
    // GET  /api/bots                         — fan out to each daemon, return
    //                                          [{larkAppId, botName, defaultOncall, ...}]
    // PUT  /api/bots/:appId/default-oncall   — proxy to that bot's daemon

    if (req.method === 'GET' && url.pathname === '/api/bots') {
      const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
      const out = await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/bot-default-oncall`);
          if (!r.ok) {
            return { larkAppId: d.larkAppId, botName: d.botName, online: true, error: `http_${r.status}` };
          }
          const j = await r.json() as any;
          return {
            larkAppId: d.larkAppId,
            botName: d.botName ?? j.botName,
            online: true,
            defaultOncall: j.defaultOncall,
            autoboundChatCount: j.autoboundChatCount ?? 0,
            brandLabel: j.brandLabel ?? null,
            disableStreamingCard: j.disableStreamingCard === true,
            writableTerminalLinkInCard: j.writableTerminalLinkInCard === true,
            privateCard: j.privateCard === true,
          };
        } catch (e: any) {
          return { larkAppId: d.larkAppId, botName: d.botName, online: true, error: e?.message ?? String(e) };
        }
      }));
      return jsonRes(res, 200, { bots: out });
    }

    let mBotDef: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotDef = url.pathname.match(/^\/api\/bots\/([^/]+)\/default-oncall$/))) {
      const appId = decodeURIComponent(mBotDef[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-default-oncall`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/brand-label — proxy to that bot's daemon. Body
    // `{ brandLabel: string | null }` (string '' = off, null = default).
    let mBotBrand: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotBrand = url.pathname.match(/^\/api\/bots\/([^/]+)\/brand-label$/))) {
      const appId = decodeURIComponent(mBotBrand[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-brand-label`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/card-prefs — proxy to that bot's daemon. Body carries
    // either/both `{ disableStreamingCard?, writableTerminalLinkInCard? }` booleans.
    let mBotCardPrefs: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotCardPrefs = url.pathname.match(/^\/api\/bots\/([^/]+)\/card-prefs$/))) {
      const appId = decodeURIComponent(mBotCardPrefs[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Create a new chat — pick a creator from the user-selected larkAppIds
    // (Feishu makes the calling bot the implicit first member, so picking
    // anything else would silently add an unwanted bot). Auto-invite the
    // operator using the creator bot's pre-resolved allowedUsers — open_ids
    // are app-scoped, so creator daemon and operator open_id come from the
    // SAME bot by construction. See dashboard/operator-selector.ts.
    if (req.method === 'POST' && url.pathname === '/api/groups/create') {
      let parsed: { name?: unknown; larkAppIds?: unknown; userOpenIds?: unknown; bindWorkingDir?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        parsed = JSON.parse(raw);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const selectedIds = Array.isArray(parsed.larkAppIds)
        ? (parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (selectedIds.length === 0) {
        return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      }

      const explicit = Array.isArray(parsed.userOpenIds)
        ? (parsed.userOpenIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      const pick = pickCreatorForGroup(selectedIds, (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      if (!pick) {
        return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
      }
      const creator = registry.getByAppId(pick.creatorLarkAppId)!;
      const merged = new Set<string>([...explicit, ...pick.userOpenIds]);
      // Auto-invite/transfer/notify target: prefer the explicit open_id passed
      // by the caller (rare API consumer use), else the creator bot's first
      // resolved allowlist entry.
      const autoInvited: string | null = explicit[0] ?? pick.userOpenIds[0] ?? null;

      const forwardBody = {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        larkAppIds: selectedIds,
        userOpenIds: [...merged],
        // Auto-transfer ownership to the auto-invited operator. Scope-safe
        // because the open_id was sourced from the creator bot's own allowlist.
        transferOwnerTo: autoInvited ?? undefined,
        // Send an @-mention message into the new chat so the operator gets a
        // Feishu push notification — being a chat member alone doesn't always
        // surface the chat in their sidebar (esp. mobile).
        notifyOwnerOpenId: autoInvited ?? undefined,
        bindWorkingDir: typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
          ? parsed.bindWorkingDir.trim()
          : undefined,
      };
      const upstream = await fetch(
        `http://127.0.0.1:${creator.ipcPort}/api/groups/create`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forwardBody) },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
      if (upstreamJson && typeof upstreamJson === 'object') {
        // If Lark rejected the invite (open_id wrong scope, banned user, etc.)
        // null out autoInvitedOpenId so the frontend doesn't falsely claim
        // success — the user actually isn't a member of the new chat.
        const invalidUsers: string[] = Array.isArray(upstreamJson.invalidUserIds)
          ? upstreamJson.invalidUserIds
          : [];
        if (autoInvited && invalidUsers.includes(autoInvited)) {
          upstreamJson.autoInvitedOpenId = null;
          upstreamJson.autoInviteRejected = true;
          // ownerTransferredTo is already null from daemon (it skips transfer
          // when invitee_rejected), so nothing more to do here.
        } else {
          upstreamJson.autoInvitedOpenId = autoInvited;
        }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(upstreamJson ? JSON.stringify(upstreamJson) : upstreamText);
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
