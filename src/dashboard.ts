// src/dashboard.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  readFileSync, existsSync, chmodSync, mkdirSync, statSync, createReadStream,
} from 'node:fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { listenWithProbe } from './utils/listen-with-probe.js';
import {
  generateToken, parseCookie, buildSetCookie, verifyHmac, decideDashboardAuth,
  loadPersistedToken, persistToken,
} from './dashboard/auth.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';
import { pickCreatorForGroup } from './dashboard/operator-selector.js';
import { planGroupCreator } from './dashboard/team-group.js';
import { handleWorkflowApi, jsonRes } from './dashboard/workflow-api.js';
import { handleDashboardTriggerApi } from './dashboard/trigger-api.js';
import { handleConnectorApi } from './dashboard/connector-api.js';
import { redactGroupsForPublic, redactSchedulesForPublic } from './dashboard/public-redact.js';
import { handleWebhookRoute } from './dashboard/webhook-routes.js';
import { handleFederationApi } from './dashboard/federation-api.js';
import { handleFederationSpokeApi, syncAllMemberships, type TeamSessionRowLike } from './dashboard/federation-spoke-api.js';
import { getRunsDir } from './workflows/runs-dir.js';
import { BotOnboardingManager } from './dashboard/bot-onboarding.js';
import { CLI_SELECT_OPTIONS, resolveCliSelection } from './setup/cli-selection.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import { mergeDashboardConfig, mergeGlobalConfig, mergeMaintenanceConfig, parseMaintenancePatch, readGlobalConfig, setGlobalLocale, type DashboardGlobalConfig, type MaintenanceConfig } from './global-config.js';
import { isLocale } from './i18n/types.js';
import { isLocalDevInstall } from './utils/install-info.js';
import { listTeamReports, readTeamBoard, setTeamBoardEntry } from './services/team-board-store.js';
import type { CliId } from './adapters/cli/types.js';
import type { ConnectorDefinition } from './services/connector-store.js';
import { hd2dAssetPath, hd2dStatus, startHd2dDownload } from './dashboard/hd2d-assets.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const TOKEN_PATH = join(homedir(), '.botmux', '.dashboard-token');
const BOTS_JSON_PATH = join(homedir(), '.botmux', 'bots.json');
const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
// The dashboard probes upward if its configured port is busy (e.g. a second
// botmux instance on this host). The actually-bound port is persisted here so
// the `botmux dashboard` CLI can reach /__cli/rotate without guessing.
const PORT_PATH = join(homedir(), '.botmux', '.dashboard-port');

function loadOrCreateSecret(): string {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf8').trim();
  const s = randomBytes(32).toString('base64url');
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  atomicWriteFileSync(SECRET_PATH, s, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  logger.info(`[dashboard] Generated dashboard secret at ${SECRET_PATH}`);
  return s;
}

// The active dashboard token is persisted to disk so a previously-issued
// dashboard URL survives `botmux restart`; only `botmux dashboard` (the
// /__cli/rotate endpoint) rotates it and thereby invalidates the old link.
// The start/restart hint reads it via the non-rotating /__cli/current endpoint
// so it can show the live link without invalidating it.
let activeToken: string | null = loadPersistedToken(TOKEN_PATH);

// The port we actually bound (may differ from config.dashboard.port after an
// EADDRINUSE probe). Used for the rotation-URL and persisted for the CLI.
let boundDashboardPort = config.dashboard.port;

const SECRET = loadOrCreateSecret();

/** Sign a loopback request to a daemon's write-link route. The daemon verifies
 *  with the same .dashboard-secret, so only a caller that can read the secret —
 *  the dashboard — can mint write tokens; a bare local process that only knows
 *  the ipcPort can't. Same scheme as the `botmux dashboard` → /__cli/rotate
 *  HMAC. */
function signDaemonTokenHeaders(): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', SECRET).update(`${ts}:${nonce}`).digest('base64url');
  return { 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': sig };
}
mkdirSync(REGISTRY_DIR, { recursive: true });
const registry = new DaemonRegistry(REGISTRY_DIR);
const aggregator = new Aggregator();
const botOnboarding = new BotOnboardingManager({ botsJsonPath: BOTS_JSON_PATH });
const subs = new Map<string, () => void>();
const attaching = new Set<string>();   // dedup concurrent attaches per appId

interface ResolvedDashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  /** Auto-update / auto-restart schedule (off by default). */
  maintenance: MaintenanceConfig;
  /** True when running from a source checkout — the Settings UI greys out the
   *  auto-update toggle (npm-global only). */
  localDevInstall: boolean;
}

function resolveDashboardSettings(): ResolvedDashboardSettings {
  const dashboard = readGlobalConfig().dashboard ?? {};
  return {
    publicReadOnly: dashboard.publicReadOnly ?? config.dashboard.publicReadOnly,
    openTerminalInFeishu: dashboard.openTerminalInFeishu === true,
    maintenance: readGlobalConfig().maintenance ?? {},
    localDevInstall: isLocalDevInstall(),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

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
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
};

/** Stream an absolute file (used for HD2D cache binaries that live outside
 *  WEB_DIR). Callers pass only vetted paths from `hd2dAssetPath`. */
function serveFileAbs(res: ServerResponse, fp: string): boolean {
  let st;
  try { st = statSync(fp); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(fp)] ?? 'application/octet-stream',
    'content-length': String(st.size),
  });
  createReadStream(fp).pipe(res);
  return true;
}

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
    return new Response(JSON.stringify({ ok: false, error: 'daemon_offline', errorCode: 'daemon_offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return fetch(`http://127.0.0.1:${d.ipcPort}${daemonPath}`, init);
}

/** Create a Feishu group from the team UI: pick a creator daemon among the
 *  selected bots, proxy to its /api/groups/create, invite the requesting user.
 *  Surfaces invalidBotIds/invalidUserIds so the UI never implies a non-added
 *  bot/user joined. */
/** Live daemon-registry bots — authoritative source for THIS deployment's
 *  bots (cliId added from bots-info.json downstream). Fixes an empty/stale
 *  bots-info.json hiding running bots from the team roster / federation. */
function liveBots(): { larkAppId: string; botName: string }[] {
  return registry.list().map(d => ({ larkAppId: d.larkAppId, botName: d.botName }));
}

async function createTeamGroup(args: { name: string; larkAppIds: string[]; userOpenId?: string; preferredCreator?: string; ownerUnionIds?: string[] }): Promise<{
  ok: boolean; chatId?: string; shareLink?: string; invalidBotIds?: string[]; invalidUserIds?: string[]; invalidOwnerUnionIds?: string[]; error?: string; autoInviteUnavailable?: boolean;
}> {
  const selectedIds = Array.from(new Set(args.larkAppIds.filter(Boolean)));
  if (selectedIds.length === 0) return { ok: false, error: 'no_bots_selected' };
  // Only auto-invite the web user when their paired bot is the creator (open_id
  // is scoped to that app); otherwise create the group but don't forward a
  // wrong-scope open_id — UI will flag autoInviteUnavailable.
  const plan = planGroupCreator(
    selectedIds,
    args.preferredCreator,
    (id) => !!registry.getByAppId(id),
    (ids) => {
      const p = pickCreatorForGroup(ids, (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      return p ? p.creatorLarkAppId : null;
    },
  );
  if (!plan.creatorLarkAppId) return { ok: false, error: 'no_online_daemon' };
  const userOpenIds = plan.inviteUser && args.userOpenId ? [args.userOpenId] : [];
  try {
    const upstream = await proxyToDaemon(plan.creatorLarkAppId, '/api/groups/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: args.name, larkAppIds: selectedIds, userOpenIds, ownerUnionIds: args.ownerUnionIds ?? [] }),
    });
    const text = await upstream.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
    if (!upstream.ok || !parsed?.ok || typeof parsed.chatId !== 'string') {
      return { ok: false, error: parsed?.error ?? `group_create_http_${upstream.status}` };
    }
    return { ok: true, chatId: parsed.chatId, shareLink: typeof parsed.shareLink === 'string' ? parsed.shareLink : undefined, invalidBotIds: parsed.invalidBotIds ?? [], invalidUserIds: parsed.invalidUserIds ?? [], invalidOwnerUnionIds: parsed.invalidOwnerUnionIds ?? [], autoInviteUnavailable: !plan.inviteUser };
  } catch {
    return { ok: false, error: 'group_create_proxy_failed' };
  }
}

function lifecycleBotIds(connector: ConnectorDefinition): string[] {
  return Array.from(new Set([connector.target.botId, ...(connector.target.botIds ?? [])].filter(Boolean)));
}

function lifecycleGroupName(connector: ConnectorDefinition, dedupKey: string): string {
  const cleanKey = dedupKey.replace(/\s+/g, ' ').trim();
  const name = `${connector.name}: ${cleanKey}`;
  return name.length <= 58 ? name : `${name.slice(0, 55)}...`;
}

async function createLifecycleGroupForWebhook(
  connector: ConnectorDefinition,
  args: { dedupKey: string },
): Promise<{ chatId: string; creatorLarkAppId?: string }> {
  const selectedIds = lifecycleBotIds(connector);
  const pick = pickCreatorForGroup(selectedIds, (id) => {
    const d = registry.getByAppId(id);
    return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
  });
  if (!pick) throw new Error('no_online_daemon');
  const creator = registry.getByAppId(pick.creatorLarkAppId);
  if (!creator) throw new Error('creator_daemon_offline');
  // Pull the creator bot's authorized humans (allowedUsers) into the auto-created
  // group so a person — not just bots — is in the room. allowedUsers stores both
  // union_ids (on_, tenant-stable) and legacy open_ids (ou_, creator-app-scoped);
  // route each to the matching invite channel. @-notify the first open_id if any.
  const allowed = creator.resolvedAllowedUsers ?? [];
  const ownerUnionIds = allowed.filter(u => u.startsWith('on_'));
  const userOpenIds = allowed.filter(u => u.startsWith('ou_'));
  const upstream = await fetch(`http://127.0.0.1:${creator.ipcPort}/api/groups/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: lifecycleGroupName(connector, args.dedupKey),
      larkAppIds: selectedIds,
      ...(ownerUnionIds.length > 0 ? { ownerUnionIds } : {}),
      ...(userOpenIds.length > 0 ? { userOpenIds } : {}),
      ...(userOpenIds[0] ? { notifyOwnerOpenId: userOpenIds[0] } : {}),
    }),
  });
  const text = await upstream.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* leave null */ }
  if (!upstream.ok || !parsed?.ok || typeof parsed.chatId !== 'string') {
    throw new Error(parsed?.error ?? `group_create_http_${upstream.status}`);
  }
  return { chatId: parsed.chatId, creatorLarkAppId: parsed.creator ?? pick.creatorLarkAppId };
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

/**
 * Shared loopback-HMAC gate for the `/__cli/*` endpoints. Returns `{ ok: true }`
 * on success, or a ready-to-send `{ status, body }` error otherwise.
 */
function verifyCliRequest(req: IncomingMessage):
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return { ok: false, status: 400, body: { error: 'missing_headers' } };
  }
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const r = verifyHmac(SECRET, { ts, nonce, sig }, remote);
  if (!r.ok) return { ok: false, status: 401, body: { error: 'unauthorized', reason: r.reason } };
  return { ok: true };
}

/** Build the dashboard URL for a token, using the actually-bound port. */
function dashboardUrlFor(token: string): string {
  return `http://${config.dashboard.externalHost}:${boundDashboardPort}/?t=${token}`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    if (await handleWebhookRoute(req, res, url, {
      proxyToDaemon,
      createLifecycleGroup: createLifecycleGroupForWebhook,
    })) {
      return;
    }

    // (The legacy bmx_session /team page + pairing-login were removed; the team
    // platform now lives entirely in the SPA dashboard under the token gate —
    // see handleFederationSpokeApi below.)

    // Federation HUB endpoints — cross-deployment, self-authed by invite code /
    // syncToken, so mounted before the token gate (like webhook/team routes).
    // createTeamGroup injected for the delegate-group path (hub→spoke 拉群).
    if (await handleFederationApi(req, res, url, { createTeamGroup, liveBots })) {
      return;
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard`. Mints a fresh
    // token, invalidating any previously-issued link.
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const gate = verifyCliRequest(req);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      activeToken = generateToken();
      try {
        persistToken(TOKEN_PATH, activeToken);
      } catch (e) {
        logger.warn(`[dashboard] Failed to persist token to ${TOKEN_PATH}: ${(e as Error).message}`);
      }
      return jsonRes(res, 200, { url: dashboardUrlFor(activeToken) });
    }

    // CLI read current URL (HMAC + loopback only) — for the start/restart hint.
    // Unlike /__cli/rotate this does NOT mint a token, so an already-issued
    // dashboard link survives restart untouched. 404 → no token has ever been
    // minted (caller falls back to suggesting `botmux dashboard`).
    if (req.method === 'POST' && url.pathname === '/__cli/current') {
      const gate = verifyCliRequest(req);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      if (!activeToken) return jsonRes(res, 404, { error: 'no_active_token' });
      return jsonRes(res, 200, { url: dashboardUrlFor(activeToken) });
    }

    const presentedToken = authedToken(req, url);
    const dashboardSettings = resolveDashboardSettings();
    const decision = decideDashboardAuth({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      hasTokenParam: url.searchParams.has('t'),
      presentedToken,
      activeToken: activeToken ?? '',
      publicReadOnly: dashboardSettings.publicReadOnly,
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

    // ─── Static frontend (index.html + /assets/* + /game/*) ────────────────
    if (
      req.method === 'GET' &&
      (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/game/'))
    ) {
      // HD2D runtime binaries (index.wasm / index.pck) are NOT shipped — they
      // are downloaded on demand into the cache dir and served from there.
      // Everything else under /game/ is the small shell shipped in dist.
      if (url.pathname === '/game/index.wasm' || url.pathname === '/game/index.pck') {
        const fp = hd2dAssetPath(url.pathname.slice('/game/'.length));
        if (fp && serveFileAbs(res, fp)) return;
        res.writeHead(404); res.end(); return;
      }
      // Map /assets/foo.js → WEB_DIR/foo.js; /game/* is served as-is.
      const lookupPath = url.pathname.startsWith('/assets/')
        ? '/' + url.pathname.slice(8)
        : url.pathname;
      if (serveStatic(req, res, lookupPath)) return;
    }

    // ─── HD2D office assets (token-gated: download triggers a ~74MB fetch) ──
    if (req.method === 'GET' && url.pathname === '/api/game/status') {
      // `proxy` prefills the office tab's optional proxy input (config value
      // only; an env-var proxy still works as a silent fallback downstream).
      return jsonRes(res, 200, { ...hd2dStatus(), proxy: readGlobalConfig().httpProxy ?? '' });
    }
    if (req.method === 'POST' && url.pathname === '/api/game/download') {
      // Optional `proxy` in the body is persisted (so it survives restart) and
      // takes effect immediately for this download — Node's fetch ignores the
      // proxy env vars, so hosts behind a proxy set it here.
      let body: unknown;
      try { body = await readJsonBody(req); } catch { body = undefined; }
      if (body && typeof body === 'object' && 'proxy' in body) {
        const raw = (body as { proxy?: unknown }).proxy;
        const proxy = typeof raw === 'string' ? raw.trim() : '';
        mergeGlobalConfig({ httpProxy: proxy || null });
      }
      return jsonRes(res, 200, startHd2dDownload());
    }

    // ─── Public API (cookie/token already validated above) ──────────────────

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // Sessions spawned before a bot config carried a display name store the
      // raw appId as botName — resolve through the live registry so consumers
      // (dashboard, HD2D office tab) always see the human-facing name.
      const names = new Map([...registry.list()].map(d => [d.larkAppId, d.botName] as const));
      const sessions = aggregator.getSessions().map(s => {
        const n = names.get(s.larkAppId);
        return n && n !== s.larkAppId && (!s.botName || s.botName === s.larkAppId)
          ? { ...s, botName: n }
          : s;
      });
      return jsonRes(res, 200, { sessions });
    }
    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      // Public-read carve-out: the row carries CONTENT (prompt = business
      // instructions) and a bound `workingDir` (repo/customer path) — strip
      // both for anonymous visitors. The schedules page only renders
      // name/timing/status, so nothing degrades.
      const schedules = authed
        ? aggregator.getSchedules()
        : redactSchedulesForPublic(aggregator.getSchedules());
      return jsonRes(res, 200, { schedules });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      // `authed` lets the Settings page disable toggles for read-only
      // visitors up front, instead of letting them flip a switch that
      // 401s + rolls back on save.
      // `lang` is the global UI locale (single source of truth shared with
      // `botmux lang` and the Feishu cards) — the web UI reads it as its
      // authoritative initial language when set.
      return jsonRes(res, 200, { settings: dashboardSettings, lang: readGlobalConfig().lang ?? null, authed });
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      const patch: DashboardGlobalConfig = {};
      if ('publicReadOnly' in body) {
        if (typeof body.publicReadOnly !== 'boolean') return jsonRes(res, 400, { ok: false, error: 'invalid_publicReadOnly' });
        patch.publicReadOnly = body.publicReadOnly;
      }
      if ('openTerminalInFeishu' in body) {
        if (typeof body.openTerminalInFeishu !== 'boolean') return jsonRes(res, 400, { ok: false, error: 'invalid_openTerminalInFeishu' });
        patch.openTerminalInFeishu = body.openTerminalInFeishu;
      }
      let touched = false;
      if (Object.keys(patch).length > 0) { mergeDashboardConfig(patch); touched = true; }
      if ('maintenance' in body) {
        const r = parseMaintenancePatch(body.maintenance);
        if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.error });
        // Auto-update is npm-global only; refuse enabling it on a source checkout.
        if (r.patch.autoUpdate?.enabled && isLocalDevInstall()) {
          return jsonRes(res, 400, { ok: false, error: 'local_dev_no_autoupdate' });
        }
        // Auto-restart only applies an auto-update — it's meaningless without it.
        // Refuse enabling auto-restart unless auto-update is (or is being) on.
        if (r.patch.autoRestart?.enabled) {
          const autoUpdateOn = r.patch.autoUpdate?.enabled
            ?? readGlobalConfig().maintenance?.autoUpdate?.enabled
            ?? false;
          if (!autoUpdateOn) return jsonRes(res, 400, { ok: false, error: 'autoupdate_required' });
        }
        mergeMaintenanceConfig(r.patch);
        touched = true;
      }
      if ('lang' in body) {
        // Global UI locale — single source of truth shared with `botmux lang`
        // and the Feishu cards. Persist to ~/.botmux/config.json, then fan out
        // to every online daemon over the same IPC bus the per-bot config
        // writes use, so running cards switch language live (no restart).
        const v = body.lang;
        if (v === null) setGlobalLocale(null);
        else if (isLocale(v)) setGlobalLocale(v);
        else return jsonRes(res, 400, { ok: false, error: 'invalid_lang' });
        await Promise.all(registry.list().map(d =>
          fetch(`http://127.0.0.1:${d.ipcPort}/api/locale/reload`, { method: 'POST' }).catch(() => undefined),
        ));
        touched = true;
      }
      if (!touched) return jsonRes(res, 400, { ok: false, error: 'empty_patch' });
      return jsonRes(res, 200, { ok: true, settings: resolveDashboardSettings() });
    }

    if (await handleConnectorApi(req, res, url)) {
      return;
    }

    // Federation SPOKE endpoints (owner actions) — token-gated above.
    if (await handleFederationSpokeApi(req, res, url, { createTeamGroup, liveBots })) {
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/trigger') {
      return handleDashboardTriggerApi(req, res, { proxyToDaemon });
    }

    // CLI 下拉选项 (id=选择键 + 展示名), 单一事实源在 cli-selection.CLI_SELECT_OPTIONS,
    // 含 aiden×claude / aiden×codex 网关项——前端打开"添加机器人"表单时拉取填充下拉.
    // id 既可能是普通 cliId, 也可能是 'aiden-x-claude' 这类选择键, 由 resolveCliSelection 解析.
    if (req.method === 'GET' && url.pathname === '/api/cli-options') {
      return jsonRes(res, 200, { options: CLI_SELECT_OPTIONS.map((o) => ({ id: o.key, label: o.label })) });
    }

    if (req.method === 'POST' && url.pathname === '/api/bot-onboarding/start') {
      let parsed: { cliId?: unknown; workingDir?: unknown; model?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // CLI: 把下拉传来的选择键 (普通 cliId 或 aiden-x-claude/codex) 解析成
      // { cliId, wrapperCli }——空 → 默认 claude-code; 非法键 → 400.
      let cliId: CliId | undefined;
      let wrapperCli: string | undefined;
      try {
        const key = typeof parsed.cliId === 'string' && parsed.cliId.trim() ? parsed.cliId.trim() : 'claude-code';
        const sel = resolveCliSelection(key);
        cliId = sel.cliId;
        wrapperCli = sel.wrapperCli;
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_cli', message: err?.message ?? String(err) });
      }
      // 工作目录: 留空 → '~'; 在 daemon 主机上校验目录确实存在 (对齐 setup 的
      // ensureBotWorkingDirsExist). 失败 fail-fast, 让用户在扫码前就改对.
      const workingDir = typeof parsed.workingDir === 'string' && parsed.workingDir.trim()
        ? parsed.workingDir.trim()
        : '~';
      const bad = invalidWorkingDirs({ workingDir });
      if (bad.length > 0) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_working_dir', message: `目录不存在或不是目录: ${bad.join(', ')}` });
      }
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
      const job = botOnboarding.start({ cliId, wrapperCli, workingDir, model });
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

    // 部署 owner 资料（左上角头像）。authed-only；代理到任一在线 daemon。
    if (req.method === 'GET' && url.pathname === '/api/owner-profile') {
      const d = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex)[0];
      if (!d) return jsonRes(res, 503, { ok: false, error: 'no_daemon' });
      const upstream = await proxyToDaemon(d.larkAppId, '/api/owner-profile', { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ── 团队看板（本地托管团队，host=本部署）：共享编排 + 成员上报快照 ──────
    // authed-only（不在公开读白名单）。远程团队走 /api/team/remote-board 代理。
    let mBoard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mBoard = url.pathname.match(/^\/api\/team\/board\/local\/([^/]+)$/))) {
      const teamId = decodeURIComponent(mBoard[1]);
      return jsonRes(res, 200, {
        ok: true,
        board: readTeamBoard(config.session.dataDir, teamId),
        reports: listTeamReports(config.session.dataDir, teamId),
      });
    }
    if (req.method === 'POST' && (mBoard = url.pathname.match(/^\/api\/team\/board\/local\/([^/]+)\/move$/))) {
      const teamId = decodeURIComponent(mBoard[1]);
      const moveBody = await readJsonBody(req) as any;
      const entry = setTeamBoardEntry(config.session.dataDir, teamId, String(moveBody?.sessionId ?? ''), moveBody?.column, moveBody?.position);
      if (!entry) return jsonRes(res, 400, { ok: false, error: 'bad_request' });
      return jsonRes(res, 200, { ok: true, entry });
    }

    // 看板放置 / 重命名：带 JSON body 的会话写操作，原样转发给 owner daemon。
    // 不在公开读白名单内 → 只读访客在 decideDashboardAuth 已被 401。
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(board|rename)$/))) {
      const sid = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 会话历史（飞书消息实时拉取）。不在公开读白名单 → 只读访客 401。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/history${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Writable web-terminal link (token-bearing). Not in any public allow-list,
    // so decideDashboardAuth has already 401'd unauthenticated callers before we
    // get here — the token only reaches authenticated dashboard sessions.
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/write-link$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/write-link`, { method: 'GET', headers: signDaemonTokenHeaders() });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Sandbox landing: review the clone's diff (GET) then apply/discard (POST).
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/sandbox-diff$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/sandbox-diff`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/sandbox-land\/(apply|discard)$/))) {
      const sid = decodeURIComponent(m[1]); const action = m[2];
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/sandbox-land/${action}`, { method: 'POST' });
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
            const { oncallChat, firstSeenAt, hasRole, observedBotNames, ...chatBase } = c;
            const cur = out.get(c.chatId) ?? { ...chatBase, memberBots: [] as any[], _firstSeenAt: null as number | null, observedBotNames: [] as string[] };
            // /introduce 记录按观察者（bot）分文件——跨 daemon 取并集（按名字去重）
            if (Array.isArray(observedBotNames) && observedBotNames.length) {
              cur.observedBotNames = [...new Set([...(cur.observedBotNames ?? []), ...observedBotNames])];
            }
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
      // Public-read carve-out: oncall bindings carry workingDir (repo/customer
      // paths). The read-only board only needs chat/bot names; the oncall
      // editor that consumes oncallChat is authed-only. Strip for anon so the
      // bound dirs don't leak via /api/groups (mirrors the /api/schedules
      // prompt strip + keeps /api/bots oncall removal honest).
      return jsonRes(res, 200, {
        chats: authed ? sorted : redactGroupsForPublic(sorted),
        bots: onlineBots.map(b => ({ larkAppId: b.larkAppId, botName: b.botName, botAvatarUrl: b.botAvatarUrl })),
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
            sandbox: j.sandbox === true,
            disableStreamingCard: j.disableStreamingCard === true,
            writableTerminalLinkInCard: j.writableTerminalLinkInCard === true,
            privateCard: j.privateCard === true,
            autoStartOnGroupJoin: j.autoStartOnGroupJoin === true,
            autoStartOnGroupJoinPrompt: typeof j.autoStartOnGroupJoinPrompt === 'string' ? j.autoStartOnGroupJoinPrompt : '',
            autoStartOnNewTopic: j.autoStartOnNewTopic === true,
            regularGroupReplyMode: (j.regularGroupReplyMode === 'new-topic' || j.regularGroupReplyMode === 'shared')
              ? j.regularGroupReplyMode
              : 'chat',
            regularGroupMentionMode: (j.regularGroupMentionMode === 'topic' || j.regularGroupMentionMode === 'never')
              ? j.regularGroupMentionMode
              : 'always',
            restrictGrantCommands: j.restrictGrantCommands === true,
            messageQuotaDefaultLimit: typeof j.messageQuotaDefaultLimit === 'number' ? j.messageQuotaDefaultLimit : null,
            p2pMode: j.p2pMode === 'chat' ? 'chat' : 'thread',
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

    // PUT /api/bots/:appId/sandbox — proxy to that bot's daemon. Body `{ enabled: boolean }`.
    let mBotSandbox: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSandbox = url.pathname.match(/^\/api\/bots\/([^/]+)\/sandbox$/))) {
      const appId = decodeURIComponent(mBotSandbox[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-sandbox`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/card-prefs — proxy to that bot's daemon. Body carries
    // any subset of per-bot behavior booleans / prompt strings.
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

    // PUT /api/bots/:appId/p2p-mode — proxy to that bot's daemon. Body
    // `{ p2pMode: 'chat' | 'thread' }` ('chat' = flat continuous DM session;
    // anything else clears back to the per-message thread default).
    let mBotP2pMode: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotP2pMode = url.pathname.match(/^\/api\/bots\/([^/]+)\/p2p-mode$/))) {
      const appId = decodeURIComponent(mBotP2pMode[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-p2p-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/grant-prefs — proxy to that bot's daemon. Body carries
    // any subset of `{ restrictGrantCommands?: boolean, messageQuotaDefaultLimit?: number|null }`.
    let mBotGrantPrefs: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotGrantPrefs = url.pathname.match(/^\/api\/bots\/([^/]+)\/grant-prefs$/))) {
      const appId = decodeURIComponent(mBotGrantPrefs[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-grant-prefs`, {
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
        // Mirror the GET /api/schedules carve-out: schedule events carry the
        // full task object — strip the prompt AND workingDir for anonymous SSE
        // listeners, or the REST-side scrub would be trivially bypassed by
        // `/events`.
        let body = ev.body;
        if (!authed && (ev.type === 'schedule.created' || ev.type === 'schedule.updated')) {
          const b = body as { schedule?: Record<string, unknown>; patch?: Record<string, unknown>; id?: string };
          body = {
            ...b,
            ...(b.schedule ? { schedule: { ...b.schedule, prompt: undefined, workingDir: undefined } } : {}),
            ...(b.patch ? { patch: { ...b.patch, prompt: undefined, workingDir: undefined } } : {}),
          } as typeof ev.body;
        }
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ larkAppId: ev.larkAppId, body })}\n\n`);
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

// Probe upward on EADDRINUSE rather than crashing with an unhandled 'error':
// a second botmux instance on this host (or a stray process) holding the
// configured port would otherwise tear the dashboard process down on bind.
// The bound port is persisted so `botmux dashboard` can still reach us.
listenWithProbe({
  server,
  port: config.dashboard.port,
  host: config.dashboard.host,
  log: (m) => logger.warn(`[dashboard] ${m}`),
}).then((port) => {
  boundDashboardPort = port;
  try { atomicWriteFileSync(PORT_PATH, String(port)); } catch (e) {
    logger.warn(`[dashboard] Failed to persist port to ${PORT_PATH}: ${(e as Error).message}`);
  }
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${port}`);
}).catch((err) => {
  logger.error(`[dashboard] could not bind near ${config.dashboard.host}:${config.dashboard.port} after probing — set BOTMUX_DASHBOARD_PORT to a free port. ${(err as Error).message}`);
  process.exit(1);
});

// Federation: periodically push this deployment's bots + heartbeat to every hub
// it has joined (best-effort; no-op when not federated). Keeps remote rosters fresh.
const federationSync = setInterval(() => {
  // sessionsProvider：顺带把本部署在各团队协作群里的会话裁剪行上报给团队 host
  // （hub 在 sync 响应里下发协作群清单，详见 syncAllMemberships）。
  // aggregator Row 是宽松索引类型，实际为 SessionRow（含 chatId 等字段）
  syncAllMemberships(config.session.dataDir, fetch, liveBots(), () => aggregator.getSessions() as unknown as TeamSessionRowLike[])
    .catch(() => { /* best-effort */ });
}, 2 * 60 * 1000);
federationSync.unref();

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
