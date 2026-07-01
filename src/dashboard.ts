// src/dashboard.ts
import { createServer, get as httpGet, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  readFileSync, existsSync, mkdirSync, statSync, createReadStream,
} from 'node:fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { join, dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import { listenWithProbe } from './utils/listen-with-probe.js';
import {
  generateToken, parseCookie, buildSetCookie, verifyHmac, cliAuthBind, decideDashboardAuth,
  loadPersistedToken, persistToken, loadDashboardSecret, loadOrCreateDashboardSecret,
} from './dashboard/auth.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';
import { pickCreatorForGroup } from './dashboard/operator-selector.js';
import { planGroupCreator } from './dashboard/team-group.js';
import { handleWorkflowApi, jsonRes } from './dashboard/workflow-api.js';
import { handleV3RunsApi } from './dashboard/v3-runs-api.js';
import { defaultRunsDir as v3RunsDir } from './workflows/v3/ops-projection.js';
import { handleDashboardTriggerApi } from './dashboard/trigger-api.js';
import { handleConnectorApi } from './dashboard/connector-api.js';
import { redactGroupsForPublic, redactSchedulesForPublic } from './dashboard/public-redact.js';
import { handleWebhookRoute } from './dashboard/webhook-routes.js';
import { handleFederationApi } from './dashboard/federation-api.js';
import { handleFederationSpokeApi, syncAllMemberships, autoBindOwnerIfUnambiguous, type TeamSessionRowLike } from './dashboard/federation-spoke-api.js';
import { getRunsDir } from './workflows/runs-dir.js';
import { BotOnboardingManager } from './dashboard/bot-onboarding.js';
import {
  CLI_SELECT_OPTIONS,
  resolveCliSelection,
  isTtadkWrapper,
  ttadkAcceptsModel,
  TTADK_DEFAULT_MODEL,
  TTADK_MODEL_SUGGESTIONS,
} from './setup/cli-selection.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import { invalidateGlobalConfigCache, mergeGlobalConfig, readGlobalConfig, type MaintenanceConfig, type RepoPickerMode, type WhiteboardConfig } from './global-config.js';
import { buildDashboardUrl } from './core/dashboard-url.js';
import { deleteWhiteboard, listWhiteboards, readWhiteboard, whiteboardEnabled } from './services/whiteboard-store.js';
import { isLocalDevInstall, botmuxVersion } from './utils/install-info.js';
import { checkNode, detectBotmuxInstalls, resolveCurrentVersion } from './utils/install-diagnostics.js';
import { fetchLatestVersion, fetchReleasesSince, isNewerVersion, type ChangelogResult } from './core/update-check.js';
import { GITHUB_REPO } from './core/restart-report.js';
import { spawnDetachedRestart, npmGlobalUpdateLockTarget } from './core/maintenance.js';
import { writeRestartIntent } from './services/restart-intent-store.js';
import { withFileLock } from './utils/file-lock.js';
import { spawn } from 'node:child_process';
import {
  applySettingsWrite,
  defaultSettingsWriteApplierDeps,
} from './dashboard/settings-write-applier.js';
import {
  addBotsToGroup,
  bindOncall,
  disbandGroup,
  leaveGroup,
  unbindOncall,
  type GroupsActionDeps,
  type HandlerResult as GroupsHandlerResult,
} from './dashboard/groups-action-helpers.js';
import { defaultWorkflowsActionDeps } from './dashboard/workflows-action-helpers.js';
import {
  listRuns as listRunsImpl,
  readRunSnapshot as readRunSnapshotImpl,
  scrubSnapshotForUnauthed as scrubSnapshotImpl,
  isValidRunId as isValidRunIdImpl,
  TERMINAL_RUN_STATUSES as TERMINAL_RUN_STATUSES_IMPL,
  type RunSnapshotDTO,
} from './workflows/ops-projection.js';
import { createDaemonInternalApi } from './dashboard/daemon-internal-api.js';
import { listTeamReports, readTeamBoard, setTeamBoardEntry } from './services/team-board-store.js';
import type { CliId } from './adapters/cli/types.js';
import type { ConnectorDefinition } from './services/connector-store.js';
import { hd2dAssetPath, hd2dStatus, startHd2dDownload } from './dashboard/hd2d-assets.js';
import {
  installLocalSkillLinks,
  readSkillRegistry,
  removeInstalledSkill,
  updateInstalledSkillAsync,
} from './services/skill-registry-store.js';
import { redactGitUrlCredentials } from './core/skills/sources.js';
import { loadBotConfigs } from './bot-registry.js';
import type { BotSkillPolicy, SkillPackage } from './core/skills/types.js';
import { discoverNativeCliSkillGroups } from './core/skills/discovery.js';
import { analyzeSkillReferences, type SkillReferenceBot, type SkillReferenceSummary } from './core/skills/references.js';
import { installDashboardSkill, parseDashboardSkillInstallRequest, parseInstallLocalLinksSources, MAX_LOCAL_LINK_SOURCES } from './dashboard/skill-install-request.js';
import { botDefaultsPayload, botSummaryPayload } from './dashboard/bot-payload.js';
import { isValidRoleProfileId } from './services/role-profile-store.js';
import { mergeSafeInsightOverviews } from './services/insight/report.js';
import type { SafeInsightOverview } from './services/insight/types.js';
import { readPlatformBinding } from './platform/binding.js';
import { startPlatformTunnelClient, type PlatformBotInfo } from './platform/tunnel-client.js';
import { cleanupIdleSessions, parseIdleCleanupHours } from './dashboard/session-cleanup.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const TOKEN_PATH = join(homedir(), '.botmux', '.dashboard-token');
/** Per-daemon budget for the cross-daemon insight overview fan-out — bounds
 *  aggregate latency when one daemon's insight parse is slow or hung. */
const INSIGHT_FANOUT_TIMEOUT_MS = 10_000;
const BOTS_JSON_PATH = join(homedir(), '.botmux', 'bots.json');
const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');
// The dashboard probes upward if its configured port is busy (e.g. a second
// botmux instance on this host). The actually-bound port is persisted here so
// the `botmux dashboard` CLI can reach /__cli/rotate without guessing.
const PORT_PATH = join(homedir(), '.botmux', '.dashboard-port');

function loadOrCreateSecret(): string {
  let existing: string | null;
  try {
    existing = loadDashboardSecret(SECRET_PATH);
  } catch (e) {
    logger.error(`[dashboard] Failed to read dashboard secret at ${SECRET_PATH}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (existing) return existing;

  const existed = existsSync(SECRET_PATH);
  try {
    const secret = loadOrCreateDashboardSecret(SECRET_PATH);
    logger.info(`[dashboard] ${existed ? 'Regenerated empty' : 'Generated'} dashboard secret at ${SECRET_PATH}`);
    return secret;
  } catch (e) {
    logger.error(`[dashboard] Failed to create dashboard secret at ${SECRET_PATH}: ${(e as Error).message}`);
    process.exit(1);
  }
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

function isWildcardBindHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

function tcpPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

function dashboardPortAvailable(port: number): Promise<boolean> {
  if (!isWildcardBindHost(config.dashboard.host)) return Promise.resolve(true);
  // `botmux dashboard` talks to loopback even when the browser-facing server
  // binds wildcard. On macOS another process can hold 127.0.0.1:port while a
  // wildcard bind still succeeds, causing CLI HMAC calls to hit that process.
  return tcpPortAvailable('127.0.0.1', port);
}

// Per-process random marker served at /__selfcheck. Lets verifyDashboardBinding
// confirm a loopback request to our just-bound wildcard port reaches THIS
// process and not a shadow holding 127.0.0.1:port. The value is meaningless to
// anyone else, so exposing it is safe.
const DASHBOARD_SELF_NONCE = randomBytes(16).toString('hex');

/**
 * Post-bind loopback identity check handed to listenWithProbe (verifyBound).
 * dashboardPortAvailable is a PRE-bind gate, but on macOS a loopback occupant
 * can appear in the race window between that check and the wildcard listen, and
 * a 0.0.0.0 bind succeeds anyway while loopback routing favours the occupant —
 * so the dashboard would advertise a port it doesn't actually own on loopback.
 * This runs AFTER listen: dial 127.0.0.1:port/__selfcheck and require OUR nonce
 * back. A shadow answers with its own body/404 → reject → listenWithProbe steps
 * up. Number-independent: it works no matter which port or who is shadowing.
 * Loopback-host binds can't be shadowed, so they short-circuit to true.
 */
function verifyDashboardBinding(port: number): Promise<boolean> {
  if (!isWildcardBindHost(config.dashboard.host)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/__selfcheck', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 128) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 && body === DASHBOARD_SELF_NONCE));
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

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
  /** Experimental current-chat bot discovery via Lark `/members/bots`. Default ON. */
  chatBotDiscovery: boolean;
  repoPickerMode: RepoPickerMode;
  /** Auto-update / auto-restart schedule (off by default). */
  maintenance: MaintenanceConfig;
  /** True when running from a source checkout — the Settings UI greys out the
   *  auto-update toggle (npm-global only). */
  localDevInstall: boolean;
  /** Optional local project whiteboard. Disabled by default. */
  whiteboard: WhiteboardConfig;
  /** 远程访问: emit central-platform URLs (terminals / cards / webhooks) instead
   *  of local host:port. Off by default; only meaningful when bound. */
  remoteAccess: boolean;
}

function resolveDashboardSettings(): ResolvedDashboardSettings {
  const global = readGlobalConfig();
  const dashboard = global.dashboard ?? {};
  return {
    publicReadOnly: dashboard.publicReadOnly ?? config.dashboard.publicReadOnly,
    openTerminalInFeishu: dashboard.openTerminalInFeishu === true,
    chatBotDiscovery: dashboard.chatBotDiscovery !== false, // default ON
    repoPickerMode: global.repoPickerMode ?? 'all',
    maintenance: global.maintenance ?? {},
    localDevInstall: isLocalDevInstall(),
    whiteboard: { enabled: global.whiteboard?.enabled === true },
    remoteAccess: global.remoteAccess === true,
  };
}

// Single shared deps object for `applySettingsWrite` — both the browser
// `PUT /api/settings` route and (PR2 C6) the HMAC-gated `PUT /__daemon/settings-write`
// route call through this so error codes / merge semantics stay identical.
async function reloadLocaleOnAllDaemons(): Promise<void> {
  await Promise.all(registry.list().map(d =>
    fetch(`http://127.0.0.1:${d.ipcPort}/api/locale/reload`, { method: 'POST' }).catch(() => undefined),
  ));
}
const settingsWriteApplierDeps = defaultSettingsWriteApplierDeps(resolveDashboardSettings, reloadLocaleOnAllDaemons);

/** Helper to render a {status, body} HandlerResult through `res`. */
function writeHandlerResult(res: import('node:http').ServerResponse, result: GroupsHandlerResult): void {
  const headers = { 'content-type': 'application/json', ...(result.headers ?? {}) };
  res.writeHead(result.status, headers);
  res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
}

// Shared deps for groups-action-helpers — both the browser
// `/api/groups/*` routes and (PR2 C6) the HMAC-gated `/__daemon/groups/*`
// routes use these helpers so response shapes / cascade-close semantics
// stay identical.
const groupsActionDeps: GroupsActionDeps = {
  registryList: () => registry.list(),
  registryGetByAppId: (id) => registry.getByAppId(id),
  proxyToDaemon,
  closeSessionsMatching,
};

// ─── PR2 C8: Route B internal API (`/__daemon/*`) ───────────────────────────
// HMAC + loopback + ts ±60s + nonce TTL, signed-request envelope = full
// (ts, nonce, method, pathWithQuery, sha256(body)). Reuses `.dashboard-secret`
// for the HMAC key — the same secret `/__cli/rotate` already uses — but the
// signing material is wider so a `/__cli/rotate` signature cannot be replayed
// here and vice versa (different protocols, same secret, no cross-replay).
//
// SECRET fail-closed: `loadOrCreateSecret()` returns a 32-byte base64url
// string and never empty; we still guard below at server-startup time.
if (!SECRET || SECRET.length === 0) {
  logger.error('[dashboard] SECRET is empty — refusing to mount /__daemon/* dispatcher');
  process.exit(1);
}

const daemonInternalApi = createDaemonInternalApi({
  secret: SECRET,
  getSessions: () => aggregator.getSessions(),
  getSchedules: () => aggregator.getSchedules(),
  resolveDashboardSettings,
  buildGroupsMatrix,
  settingsApplierDeps: settingsWriteApplierDeps,
  groupsActionDeps,
  workflowsActionDeps: defaultWorkflowsActionDeps<RunSnapshotDTO>({
    runsDir: getRunsDir(),
    proxyToDaemon,
    listRuns: listRunsImpl,
    readRunSnapshot: readRunSnapshotImpl,
    scrubSnapshotForUnauthed: scrubSnapshotImpl,
    TERMINAL_RUN_STATUSES: TERMINAL_RUN_STATUSES_IMPL,
    isValidRunId: isValidRunIdImpl,
  }),
  proxyToDaemon,
  ownerOf: (sid) => aggregator.ownerOf(sid),
  scheduleOwnerOf: (id) => aggregator.scheduleOwnerOf(id),
  scheduleExists: (id) => aggregator.scheduleExists(id),
  sessionExists: (sessionId) => aggregator.sessionExists(sessionId),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** Fast in-process guard against double-clicks within this dashboard process.
 *  Cross-process serialization against the maintenance auto-update (a different
 *  process) is handled separately by the shared file lock in the run route. */
let updateInFlight = false;

// Cache the upstream version/changelog lookups so the nav-badge check + the
// Settings card don't hammer the npm registry / GitHub on every page load.
// GitHub's unauthenticated API is only 60 req/h per IP, so caching the changelog
// also keeps us from exhausting it. Failures cache briefly so they self-heal.
const LATEST_TTL_MS = 30 * 60_000;
const CHANGELOG_TTL_MS = 15 * 60_000;
const FAILURE_TTL_MS = 60_000;
let latestVersionCache: { value: string | null; at: number } | null = null;
let changelogCache: { key: string; value: ChangelogResult; at: number } | null = null;

async function cachedLatestVersion(now = Date.now()): Promise<string | null> {
  const ttl = latestVersionCache?.value ? LATEST_TTL_MS : FAILURE_TTL_MS;
  if (latestVersionCache && now - latestVersionCache.at < ttl) return latestVersionCache.value;
  const value = await fetchLatestVersion();
  latestVersionCache = { value, at: now };
  return value;
}

async function cachedChangelog(current: string, now = Date.now()): Promise<ChangelogResult> {
  const ttl = changelogCache?.value.ok ? CHANGELOG_TTL_MS : FAILURE_TTL_MS;
  if (changelogCache && changelogCache.key === current && now - changelogCache.at < ttl) return changelogCache.value;
  const value = await fetchReleasesSince(current);
  changelogCache = { key: current, value, at: now };
  return value;
}

/**
 * Run `npm install -g botmux@latest` for the manual-update flow WITHOUT blocking
 * the event loop (async spawn, not execSync — the dashboard must keep serving
 * during the ~10-30s install). Resolves on exit 0; rejects with the tail of
 * stdout/stderr on a non-zero exit, spawn error, or 3-minute timeout. Args are
 * a fixed literal — no shell interpolation of untrusted input.
 */
function runNpmInstallLatest(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', 'botmux@latest'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // resolve npm.cmd on Windows
    });
    let tail = '';
    const capture = (d: Buffer): void => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('npm install timed out after 180s'));
    }, 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited ${code}: ${tail.trim().slice(-500)}`));
    });
  });
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
const __dirname = dirname(fileURLToPath(import.meta.url));
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

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fp = resolve(WEB_DIR, rel);
  const webRoot = resolve(WEB_DIR);
  const relToRoot = relative(webRoot, fp);
  // Path-traversal guard: resolved path must stay inside WEB_DIR.
  if (relToRoot === '..' || relToRoot.startsWith('..\\') || relToRoot.startsWith('../') || isAbsolute(relToRoot)) return false;
  try {
    const st = statSync(fp);
    if (!st.isFile()) return false;
    // Fixed entry filenames (index.html/app.js/style.css) need revalidation so
    // a deploy never serves new JS with old CSS. Lazy chunks are content-hashed
    // and can be cached immutably once the current app.js points at them.
    const immutableChunk = relToRoot.startsWith('chunks/') || relToRoot.startsWith('chunks\\');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'content-type': MIME[extname(fp)] ?? 'application/octet-stream',
      'cache-control': immutableChunk ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
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
 *  bots. cliId comes from the daemon descriptor, with bots.json as a
 *  compatibility fallback for descriptors written by older daemons. */
function configuredCliIds(): Map<string, string> {
  try {
    return new Map(loadBotConfigs().map(b => [b.larkAppId, b.cliId]));
  } catch {
    return new Map();
  }
}

function configuredBotAgentFields(): Map<string, { cliId?: string; wrapperCli?: string; model?: string }> {
  try {
    return new Map(loadBotConfigs().map(b => [b.larkAppId, {
      cliId: b.cliId,
      wrapperCli: b.wrapperCli,
      model: b.model,
    }]));
  } catch {
    return new Map();
  }
}

function withConfiguredCliId<T extends { larkAppId: string; cliId?: string; wrapperCli?: string; model?: string }>(
  bot: T,
  ids: Map<string, string> | Map<string, { cliId?: string; wrapperCli?: string; model?: string }>,
): T & { cliId?: string; wrapperCli?: string; model?: string } {
  const raw = ids.get(bot.larkAppId);
  const fallback = typeof raw === 'string' ? { cliId: raw } : raw;
  return {
    ...bot,
    cliId: bot.cliId || fallback?.cliId,
    wrapperCli: bot.wrapperCli || fallback?.wrapperCli,
    model: bot.model || fallback?.model,
  };
}

function liveBots(): { larkAppId: string; botName: string; cliId?: string }[] {
  const ids = configuredCliIds();
  return registry.list().map(d => {
    const b = withConfiguredCliId(d, ids);
    return { larkAppId: b.larkAppId, botName: b.botName, cliId: b.cliId };
  });
}

async function createTeamGroup(args: { name: string; larkAppIds: string[]; userOpenId?: string; preferredCreator?: string; ownerUnionIds?: string[]; roleProfileId?: string }): Promise<{
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
      body: JSON.stringify({
        name: args.name,
        larkAppIds: selectedIds,
        userOpenIds,
        ownerUnionIds: args.ownerUnionIds ?? [],
        ...(args.roleProfileId ? { roleProfileId: args.roleProfileId } : {}),
      }),
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
 * Build the per-(chat × bot) coverage matrix shared by `GET /api/groups`
 * (browser) and `GET /__daemon/groups-matrix` (Route B). Pure aggregation,
 * always returns the raw (unscrubbed) view — the browser route applies its
 * `redactGroupsForPublic` scrub on top when the caller is unauthed.
 */
async function buildGroupsMatrix(): Promise<{ chats: any[]; bots: any[] }> {
  const out = new Map<string, any>();
  const cliIds = configuredCliIds();
  const onlineBots = [...registry.list()]
    .map(b => withConfiguredCliId(b, cliIds))
    .sort((a, b) => a.botIndex - b.botIndex);
  await Promise.all(onlineBots.map(async d => {
    try {
      const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/groups`);
      if (!r.ok) return;
      const j = await r.json() as { chats?: any[] };
      for (const c of j.chats ?? []) {
        const { oncallChat, firstSeenAt, hasRole, observedBotNames, ...chatBase } = c;
        const cur = out.get(c.chatId) ?? {
          ...chatBase,
          memberBots: [] as any[],
          _firstSeenAt: null as number | null,
          observedBotNames: [] as string[],
        };
        if (Array.isArray(observedBotNames) && observedBotNames.length > 0) {
          cur.observedBotNames = [...new Set([...(cur.observedBotNames ?? []), ...observedBotNames])];
        }
        cur.memberBots.push({
          larkAppId: d.larkAppId,
          botName: d.botName,
          cliId: d.cliId,
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
  for (const c of out.values()) {
    const present = new Set<string>(c.memberBots.map((mb: any) => mb.larkAppId));
    for (const b of onlineBots) {
      if (!present.has(b.larkAppId)) {
        c.memberBots.push({ larkAppId: b.larkAppId, botName: b.botName, cliId: b.cliId, inChat: false, oncallChat: null, hasRole: false });
      }
    }
  }
  const chats = [...out.values()]
    .sort((a, b) => {
      const ta = a._firstSeenAt ?? 0;
      const tb = b._firstSeenAt ?? 0;
      if (tb !== ta) return tb - ta;
      return (a.name ?? a.chatId).localeCompare(b.name ?? b.chatId);
    })
    .map(({ _firstSeenAt, ...rest }) => rest);
  const bots = onlineBots.map(botSummaryPayload);
  return { chats, bots };
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
 *
 * The HMAC is bound to `method + pathname + the port WE actually bound`
 * (`boundDashboardPort`, not the attacker-controllable Host header). That scopes
 * a captured credential to this exact route on this exact dashboard, so a
 * malicious local server handed a `botmux dashboard` discovery probe can't
 * forward those headers to a different `/__cli/*` route or to the real dashboard
 * on another port. See {@link cliAuthBind}.
 */
function verifyCliRequest(req: IncomingMessage, pathname: string):
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return { ok: false, status: 400, body: { error: 'missing_headers' } };
  }
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const bind = cliAuthBind(req.method ?? 'POST', pathname, boundDashboardPort);
  const r = verifyHmac(SECRET, { ts, nonce, sig }, remote, bind);
  if (!r.ok) return { ok: false, status: 401, body: { error: 'unauthorized', reason: r.reason } };
  return { ok: true };
}

/** Build the dashboard URL for a token, using the actually-bound port. Routes
 *  through the central-platform machine subdomain when 远程访问 is on and this
 *  host is bound (see buildDashboardUrl); falls back to the local host:port. */
function dashboardUrlFor(token: string): string {
  return buildDashboardUrl({ host: config.dashboard.externalHost, port: boundDashboardPort, token });
}

type SkillJobStatus = 'running' | 'succeeded' | 'failed';
interface SkillJob {
  id: string;
  type: 'install' | 'update';
  status: SkillJobStatus;
  createdAt: string;
  updatedAt: string;
  skill?: SkillPackage;
  error?: string;
}

const skillJobs = new Map<string, SkillJob>();
const MAX_SKILL_JOBS = 50;

function publicSkillJob(job: SkillJob): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    skill: job.skill ? sanitizeSkillForDashboard(job.skill) : undefined,
    error: job.error,
  };
}

function trimSkillJobs(): void {
  const jobs = [...skillJobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (jobs.length > MAX_SKILL_JOBS) {
    const old = jobs.shift();
    if (old) skillJobs.delete(old.id);
  }
}

function startSkillJob(type: SkillJob['type'], run: () => Promise<SkillPackage>): SkillJob {
  const now = new Date().toISOString();
  const job: SkillJob = {
    id: randomBytes(8).toString('hex'),
    type,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  skillJobs.set(job.id, job);
  trimSkillJobs();
  setImmediate(() => void (async () => {
    try {
      job.skill = await run();
      job.status = 'succeeded';
    } catch (err: any) {
      job.error = redactGitUrlCredentials(err?.message ?? String(err));
      job.status = 'failed';
    } finally {
      job.updatedAt = new Date().toISOString();
      trimSkillJobs();
    }
  })());
  return job;
}

function sanitizeSkillForDashboard(skill: SkillPackage): SkillPackage {
  if (skill.source.type !== 'git') return skill;
  return {
    ...skill,
    source: { ...skill.source, url: redactGitUrlCredentials(skill.source.url) },
  };
}

function dashboardSkillCliIds(): CliId[] {
  const ids = new Set<CliId>();
  try {
    for (const cliId of configuredCliIds().values()) ids.add(cliId as CliId);
  } catch {
    // Fall back to daemon descriptors below when persistent config is unavailable.
  }
  for (const bot of registry.list()) {
    if (bot.cliId) ids.add(bot.cliId as CliId);
  }
  return [...ids];
}

function dashboardSkillsPayload(): Record<string, unknown> {
  const globalSkills = readGlobalConfig().skills ?? {};
  const nativeSkillGroups = discoverNativeCliSkillGroups(dashboardSkillCliIds())
    .map(group => ({
      ...group,
      skills: group.skills.map(sanitizeSkillForDashboard),
    }));
  return {
    skills: Object.values(readSkillRegistry().skills)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(sanitizeSkillForDashboard),
    nativeSkillGroups,
    trustProjectSkills: globalSkills.trustProjectSkills ?? 'off',
    delivery: globalSkills.delivery ?? 'auto',
  };
}

function mergeSkillReferenceBot(refs: Map<string, SkillReferenceBot>, ref: SkillReferenceBot): void {
  const current = refs.get(ref.larkAppId);
  if (!current) {
    refs.set(ref.larkAppId, { ...ref });
    return;
  }
  current.direct ||= ref.direct;
}

async function dashboardSkillReferences(skillName: string): Promise<SkillReferenceSummary> {
  const refs = new Map<string, SkillReferenceBot>();
  try {
    for (const ref of analyzeSkillReferences(skillName, {
      bots: loadBotConfigs(),
    }).bots) mergeSkillReferenceBot(refs, ref);
  } catch {
    // Fall back to online daemon data below when the dashboard process cannot
    // read persistent bot config.
  }

  const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
  const onlineRefs = await Promise.all(onlineBots.map(async d => {
    try {
      const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/bot-default-oncall`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!r.ok) return null;
      const j = await r.json() as any;
      const [ref] = analyzeSkillReferences(skillName, {
        bots: [{ larkAppId: d.larkAppId, botName: d.botName ?? j.botName ?? d.larkAppId, skills: j.skills as BotSkillPolicy | null | undefined }],
      }).bots;
      return ref ?? null;
    } catch {
      return null;
    }
  }));
  for (const ref of onlineRefs) {
    if (ref) mergeSkillReferenceBot(refs, ref);
  }
  return {
    bots: [...refs.values()].sort((a, b) => a.botName.localeCompare(b.botName)),
  };
}

/** Extract the sessionId from a terminal path `/s/<sessionId>[/...]`. Returns
 *  the first path segment after `/s/` (stops at the next `/`; query/hash are
 *  already stripped by URL.pathname). undefined when there's no segment. */
function parseTerminalSessionId(pathname: string): string | undefined {
  if (!pathname.startsWith('/s/')) return undefined;
  const seg = pathname.slice(3).split('/')[0];
  return seg || undefined;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    // Loopback self-identification (no auth): echoes this process's nonce so the
    // post-bind shadow check (listen-with-probe verifyBound) can distinguish our
    // server from a process shadowing 127.0.0.1:port. Returns only the nonce.
    if (url.pathname === '/__selfcheck') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(DASHBOARD_SELF_NONCE);
    }

    // Web terminal reverse-proxy: `/s/<sessionId>/*` → the owning bot daemon's
    // terminal proxy. The central platform only tunnels the dashboard port, so
    // terminal links served under the machine subdomain
    // (`https://m-<id>.<host>/s/<sessionId>`) land here. The dashboard is the
    // aggregator process (it fronts many bot daemons, each with its own terminal
    // proxy on proxyBasePort+idx), so we resolve the session's owning daemon's
    // proxy port from the aggregator rows and forward there, streaming the
    // response straight back. Mounted before the dashboard auth gate because the
    // terminal proxy / worker enforces its own write gate (read-only without
    // token / platform role).
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
      const sessionId = parseTerminalSessionId(url.pathname);
      const tport = sessionId ? aggregator.terminalProxyPortOf(sessionId) : undefined;
      if (!tport) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('session terminal not available');
      }
      const upstream = httpRequest(
        { host: '127.0.0.1', port: tport, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('terminal proxy error');
      });
      req.pipe(upstream);
      return;
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

    // Route B: daemon internal API (`/__daemon/*`) — HMAC + loopback,
    // mounted BEFORE the browser cookie/token gate because this protocol is
    // entirely self-contained (the daemon caller has the shared secret and
    // the signing-envelope already binds method/path/body to the timestamp).
    // Letting the auth gate touch these paths would be wrong: there is no
    // cookie or token to set/check; the gate would either 401 the daemon
    // (false negative) or grant cross-protocol access (false positive).
    if (await daemonInternalApi.handle(req, res, url)) {
      return;
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard`. Mints a fresh
    // token, invalidating any previously-issued link.
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const gate = verifyCliRequest(req, url.pathname);
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
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      if (!activeToken) return jsonRes(res, 404, { error: 'no_active_token' });
      return jsonRes(res, 200, { url: dashboardUrlFor(activeToken) });
    }

    // CLI 通知绑定变化（HMAC + loopback）——`botmux bind` 写完绑定后捅一下，立即重连平台，
    // 无需重启 daemon，也不依赖 fs.watch。
    if (req.method === 'POST' && url.pathname === '/__cli/reload-binding') {
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      // `botmux bind` wrote platform.json + (default-on) remoteAccess in the CLI
      // process; this dashboard process holds a short-TTL config cache that may
      // still read the pre-bind value. Drop it so the immediately-following
      // /__cli/current (and live card links) resolve the platform dashboard URL.
      invalidateGlobalConfigCache();
      try {
        platformTunnel?.stop();
      } catch {
        /* ignore */
      }
      platformTunnel = null;
      startPlatformTunnelIfBound();
      return jsonRes(res, 200, { ok: true });
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
    if (req.method === 'POST' && url.pathname === '/api/sessions/cleanup-idle') {
      let body: { olderThanHours?: unknown; sessionIds?: unknown };
      try {
        body = await readJsonBody(req) as { olderThanHours?: unknown; sessionIds?: unknown };
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const olderThanHours = parseIdleCleanupHours(body?.olderThanHours);
      if (!olderThanHours) return jsonRes(res, 400, { ok: false, error: 'invalid_threshold' });

      // WYSIWYG: the UI scopes cleanup to the rows currently visible under the
      // page filters and sends their sessionIds, so the closed set matches the
      // confirmed count. We still hand the scoped rows to cleanupIdleSessions,
      // which re-validates each is a genuine idle candidate — a stale/forged id
      // can never close a non-idle session. Omitting sessionIds (e.g. an older
      // client) falls back to a deployment-wide sweep. Cap the id set so a giant
      // body can't blow up the Set build.
      const idScope = Array.isArray(body?.sessionIds)
        ? new Set((body.sessionIds as unknown[]).slice(0, 10000).map(String))
        : null;
      const rows = aggregator.getSessions();
      const scoped = idScope ? rows.filter(s => idScope.has(s.sessionId)) : rows;

      const result = await cleanupIdleSessions(scoped, olderThanHours, async s => {
        try {
          const upstream = await proxyToDaemon(
            s.larkAppId as string,
            `/api/sessions/${encodeURIComponent(s.sessionId)}/close`,
            { method: 'POST' },
          );
          const text = await upstream.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* tolerate */ }
          // The daemon close route always replies 200 {ok:true}; treat anything
          // else (incl. an unparseable/missing body) as a failure rather than a
          // silent success.
          const ok = upstream.ok && parsed?.ok === true;
          return {
            sessionId: s.sessionId,
            ok,
            error: ok ? undefined : (parsed?.error ?? `http_${upstream.status}`),
          };
        } catch (e: any) {
          return { sessionId: s.sessionId, ok: false, error: e?.message ?? String(e) };
        }
      });
      return jsonRes(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/insights/summary') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
      // Per-daemon timeout + isolate failures: an upstream insight parse can be
      // heavy, so a slow/hung daemon must not stall the aggregated summary. A
      // timed-out / errored chunk drops to null and is filtered out below.
      const chunks = await Promise.all(registry.list().map(async d => {
        try {
          const upstream = await proxyToDaemon(d.larkAppId, `/api/insights/summary?limit=${limit}`, {
            method: 'GET',
            signal: AbortSignal.timeout(INSIGHT_FANOUT_TIMEOUT_MS),
          });
          if (!upstream.ok) return null;
          const body = await upstream.json().catch(() => null) as { overview?: SafeInsightOverview } | null;
          return body?.overview ?? null;
        } catch {
          return null;
        }
      }));
      const overview = mergeSafeInsightOverviews(chunks.filter((x): x is SafeInsightOverview => !!x), { limit });
      return jsonRes(res, 200, { ok: true, overview });
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
      // `bound` reflects central-platform binding; the Settings UI only shows the
      // 远程访问 toggle when bound (the central URLs are meaningless otherwise).
      return jsonRes(res, 200, {
        settings: dashboardSettings,
        lang: readGlobalConfig().lang ?? null,
        authed,
        bound: readPlatformBinding() !== null,
      });
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await applySettingsWrite(parsed, settingsWriteApplierDeps);
      if (!result.ok) return jsonRes(res, 400, { ok: false, error: result.error });
      return jsonRes(res, 200, { ok: true, settings: result.settings });
    }

    // ─── Version & manual update ─────────────────────────────────────────────
    // `npm install -g` and a host restart are privileged: none of these paths
    // are on PUBLIC_READ_PATHS, so decideDashboardAuth already 401s an
    // unauthenticated caller (in both normal and public-read mode). The explicit
    // `authed` guards on the two mutations are defense-in-depth for host actions.
    if (req.method === 'GET' && url.pathname === '/api/update/status') {
      const current = resolveCurrentVersion();
      // Compare against the npm `latest` dist-tag (always stable; the update
      // button installs `@latest`). isNewerVersion uses semver precedence, so a
      // canary running AHEAD of the latest stable (e.g. 2.87.0-canary.0 vs
      // 2.86.0) is NOT flagged behind — exactly the canary case we want.
      const latest = await cachedLatestVersion();
      return jsonRes(res, 200, {
        current,
        latest,
        behind: !!latest && isNewerVersion(latest, current),
        localDevInstall: isLocalDevInstall(),
        node: checkNode(),
        installs: detectBotmuxInstalls(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/update/changelog') {
      const current = resolveCurrentVersion();
      const result = await cachedChangelog(current);
      return jsonRes(res, 200, {
        current,
        ok: result.ok,
        rateLimited: result.rateLimited === true,
        releases: result.releases,
        releasesUrl: `https://github.com/${GITHUB_REPO}/releases`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/update/run') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      if (isLocalDevInstall()) return jsonRes(res, 400, { ok: false, error: 'local_dev_no_update' });
      const node = checkNode();
      if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
      if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      updateInFlight = true;
      const oldVersion = botmuxVersion();
      // Acquire the shared cross-process lock so a scheduled maintenance
      // auto-update (running in the bot-0 daemon) can't `npm install -g` at the
      // same time. `acquired` distinguishes "lock held by maintenance" (409)
      // from "npm itself failed" (500). Short wait: don't block the request on a
      // full in-progress install — report busy fast.
      let acquired = false;
      try {
        await withFileLock(npmGlobalUpdateLockTarget(), async () => {
          acquired = true;
          await runNpmInstallLatest();
        }, { maxWaitMs: 2_000 });
      } catch (e) {
        if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        return jsonRes(res, 500, { ok: false, error: 'npm_failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        updateInFlight = false;
      }
      const newVersion = botmuxVersion();
      return jsonRes(res, 200, { ok: true, oldVersion, newVersion, changed: newVersion !== oldVersion });
    }

    if (req.method === 'POST' && url.pathname === '/api/update/restart') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      let body: Record<string, unknown> = {};
      try {
        const parsed = await readJsonBody(req);
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch { /* empty / bad body → plain restart */ }
      const upd = body.update && typeof body.update === 'object' ? body.update as Record<string, unknown> : null;
      // After a manual update, leave an `update` breadcrumb so the fresh daemon
      // DMs the owner the changelog (reuses the restart-report pipeline). A plain
      // restart leaves none here; cmdRestart writes a `manual` breadcrumb itself.
      if (upd && typeof upd.oldVersion === 'string' && typeof upd.newVersion === 'string' && upd.oldVersion !== upd.newVersion) {
        try {
          writeRestartIntent({ kind: 'update', oldVersion: upd.oldVersion, newVersion: upd.newVersion, at: new Date().toISOString() });
        } catch { /* breadcrumb is best-effort */ }
      }
      spawnDetachedRestart('dashboard');
      return jsonRes(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return jsonRes(res, 200, dashboardSkillsPayload());
    }

    if (req.method === 'PUT' && url.pathname === '/api/skills/global') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      if (!('trustProjectSkills' in body) && !('delivery' in body)) return jsonRes(res, 400, { ok: false, error: 'empty_patch' });
      const patch: NonNullable<ReturnType<typeof readGlobalConfig>['skills']> = {};
      if ('trustProjectSkills' in body) {
        const raw = body.trustProjectSkills;
        const trustProjectSkills = raw === 'trusted' ? 'all' : raw;
        if (trustProjectSkills !== 'off' && trustProjectSkills !== 'all') {
          return jsonRes(res, 400, { ok: false, error: 'invalid_trustProjectSkills' });
        }
        patch.trustProjectSkills = trustProjectSkills;
      }
      if ('delivery' in body) {
        const delivery = body.delivery;
        if (delivery !== 'auto' && delivery !== 'prompt' && delivery !== 'native') {
          return jsonRes(res, 400, { ok: false, error: 'invalid_delivery' });
        }
        patch.delivery = delivery;
      }
      const currentSkills = readGlobalConfig().skills ?? {};
      mergeGlobalConfig({ skills: { ...currentSkills, ...patch } });
      return jsonRes(res, 200, { ok: true, ...dashboardSkillsPayload() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/install') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      try {
        const installRequest = parseDashboardSkillInstallRequest(body);
        const job = startSkillJob('install', () => installDashboardSkill(installRequest));
        return jsonRes(res, 202, { ok: true, job: publicSkillJob(job) });
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: redactGitUrlCredentials(err?.message ?? String(err)) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/install-local-links') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const sources = parseInstallLocalLinksSources(parsed);
      if (sources.length === 0) return jsonRes(res, 400, { ok: false, error: 'sources_required' });
      if (sources.length > MAX_LOCAL_LINK_SOURCES) return jsonRes(res, 400, { ok: false, error: 'too_many_sources' });
      try {
        const skills = installLocalSkillLinks(sources);
        // Frontend re-fetches /api/skills (refresh()) after success, so we keep
        // the response lean — no need to spread a full dashboardSkillsPayload()
        // (which would re-run the native-skill discovery scan a second time).
        return jsonRes(res, 200, { ok: true, installed: skills.map(sanitizeSkillForDashboard) });
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: redactGitUrlCredentials(err?.message ?? String(err)) });
      }
    }

    let mSkillJob: RegExpMatchArray | null;
    if (req.method === 'GET' && (mSkillJob = url.pathname.match(/^\/api\/skills\/jobs\/([^/]+)$/))) {
      const job = skillJobs.get(decodeURIComponent(mSkillJob[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'job_not_found' });
      return jsonRes(res, 200, { ok: true, job: publicSkillJob(job) });
    }

    let mSkillUpdate: RegExpMatchArray | null;
    if (req.method === 'POST' && (mSkillUpdate = url.pathname.match(/^\/api\/skills\/([^/]+)\/update$/))) {
      const name = decodeURIComponent(mSkillUpdate[1]);
      if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
      const job = startSkillJob('update', async () => {
        const r = await updateInstalledSkillAsync(name);
        if (!r.ok) throw new Error(r.reason);
        return r.skill;
      });
      return jsonRes(res, 202, { ok: true, job: publicSkillJob(job) });
    }

    let mSkillDelete: RegExpMatchArray | null;
    if (req.method === 'DELETE' && (mSkillDelete = url.pathname.match(/^\/api\/skills\/([^/]+)$/))) {
      const name = decodeURIComponent(mSkillDelete[1]);
      const force = url.searchParams.get('force') === '1';
      if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
      const refs = await dashboardSkillReferences(name);
      if (!force && refs.bots.length > 0) {
        return jsonRes(res, 409, {
          ok: false,
          error: 'skill_in_use',
          affectedBots: refs.bots,
        });
      }
      const r = removeInstalledSkill(name);
      if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
      return jsonRes(res, 200, {
        ok: true,
        affectedBots: refs.bots,
        ...dashboardSkillsPayload(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/whiteboards') {
      return jsonRes(res, 200, { enabled: whiteboardEnabled(), whiteboards: listWhiteboards() });
    }
    const mWhiteboard = url.pathname.match(/^\/api\/whiteboards\/([^/]+)$/);
    if (req.method === 'GET' && mWhiteboard) {
      try {
        const id = decodeURIComponent(mWhiteboard[1]);
        return jsonRes(res, 200, { enabled: whiteboardEnabled(), id, content: readWhiteboard(id, { allowDisabled: true }) });
      } catch (err: any) {
        return jsonRes(res, 404, { ok: false, error: err?.message ?? 'whiteboard_not_found' });
      }
    }
    if (req.method === 'DELETE' && mWhiteboard) {
      try {
        const id = decodeURIComponent(mWhiteboard[1]);
        return jsonRes(res, 200, deleteWhiteboard(id));
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: err?.message ?? 'whiteboard_delete_failed' });
      }
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
      return jsonRes(res, 200, {
        options: CLI_SELECT_OPTIONS.map((o) => ({
          id: o.key,
          label: o.label,
          // ttadk 网关项: 前端据此把模型框默认成 glm-5.1 并挂候选下拉; CoCo 不接受 -m.
          ...(isTtadkWrapper(o.wrapperCli)
            ? { gateway: 'ttadk' as const, acceptsModel: ttadkAcceptsModel(o.wrapperCli) }
            : {}),
        })),
        // ttadk 模型默认值 + 候选 (单一事实源在 cli-selection), 供前端模型框使用.
        ttadkModelDefault: TTADK_DEFAULT_MODEL,
        ttadkModelSuggestions: TTADK_MODEL_SUGGESTIONS,
      });
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
    let mOwner: RegExpMatchArray | null;
    if (req.method === 'POST' && (mOwner = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)\/owner$/))) {
      // needs_owner 状态下用户手动提交 owner：扫码人身份验证不了时的兜底入口。
      // submitOwner 内部做格式 + 可用性校验, 通过才落盘并转 completed。
      const onboardingId = decodeURIComponent(mOwner[1]);
      let parsedOwner: { owner?: unknown; allowedUsers?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsedOwner = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // 接受 owner 字符串 (逗号/空白分隔) 或 allowedUsers 数组。
      const entries = Array.isArray(parsedOwner.allowedUsers)
        ? parsedOwner.allowedUsers.filter((v): v is string => typeof v === 'string')
        : typeof parsedOwner.owner === 'string'
          ? parsedOwner.owner.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
          : [];
      const r = await botOnboarding.submitOwner(onboardingId, entries);
      if (!r.ok) {
        const status = r.error === 'unknown_onboarding_job' ? 404 : 400;
        return jsonRes(res, status, r);
      }
      return jsonRes(res, 200, { job: botOnboarding.get(onboardingId) });
    }
    let mOnboard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mOnboard = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)$/))) {
      const job = botOnboarding.get(decodeURIComponent(mOnboard[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'unknown_onboarding_job' });
      return jsonRes(res, 200, { job });
    }

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(close|locate|resume|restart|start)$/))) {
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

    // 看板放置 / 重命名 / 锁定：带 JSON body 的会话写操作，原样转发给 owner daemon。
    // 不在公开读白名单内 → 只读访客在 decideDashboardAuth 已被 401。
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(board|rename|lock)$/))) {
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

    // 会话 insight（只读 trace 分析：动作 span / 失败聚合 / 规则建议）。
    // owner-only：不在公开读白名单 → decideDashboardAuth 已对只读访客 401，
    // 公开/联邦访客看不到 tab 也拿不到 span。代理到 owner daemon 的同名 IPC。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/insight$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/insight${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/insight\/turn\/([^/]+)$/))) {
      const sid = decodeURIComponent(m[1]);
      const turnIndex = decodeURIComponent(m[2]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/insight/turn/${turnIndex}${url.search ?? ''}`, { method: 'GET' });
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

    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(run|pause|resume|delivery)$/))) {
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

    // v3 workflow runs (read-only DAG + per-node terminal projection).  Reads
    // the v3 run dirs directly; no daemon proxy (v3 runs are plain files).
    if (await handleV3RunsApi(req, res, url, { runsDir: v3RunsDir() }, authed)) {
      return;
    }

    // ─── Groups (Phase B) ────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      // Fan out via the shared `buildGroupsMatrix` helper so the browser
      // route and the Route B `/__daemon/groups-matrix` endpoint return the
      // same matrix shape. Public-read carve-out: oncall bindings carry
      // workingDir (repo/customer paths) so we scrub when unauthed.
      const matrix = await buildGroupsMatrix();
      return jsonRes(res, 200, {
        chats: authed ? matrix.chats : redactGroupsForPublic(matrix.chats),
        bots: matrix.bots,
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

    // ─── Profiles (aggregate/proxy to daemon) ─────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/role-profiles') {
      type RoleProfileAggregate = {
        profileId: string;
        entryCount: number;
        updatedAt: number | null;
        botEntries: Array<{ larkAppId: string; hasEntry: boolean }>;
      };
      const merged = new Map<string, RoleProfileAggregate>();
      await Promise.all(registry.list().map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/role-profiles`);
          if (!r.ok) return;
          const j = await r.json() as { profiles?: any[]; larkAppId?: string };
          for (const p of j.profiles ?? []) {
            if (typeof p.profileId !== 'string') continue;
            const cur: RoleProfileAggregate = merged.get(p.profileId) ?? { profileId: p.profileId, entryCount: 0, updatedAt: null, botEntries: [] };
            cur.entryCount = Math.max(cur.entryCount, typeof p.entryCount === 'number' ? p.entryCount : 0);
            if (typeof p.updatedAt === 'number') cur.updatedAt = cur.updatedAt === null ? p.updatedAt : Math.max(cur.updatedAt, p.updatedAt);
            const larkAppId = j.larkAppId ?? d.larkAppId;
            if (!cur.botEntries.some(entry => entry.larkAppId === larkAppId)) {
              cur.botEntries.push({ larkAppId, hasEntry: p.hasCurrentBotEntry === true });
            }
            merged.set(p.profileId, cur);
          }
        } catch { /* skip offline/bad daemon */ }
      }));
      return jsonRes(res, 200, {
        profiles: [...merged.values()]
          .map(p => ({
            ...p,
            entryCount: Math.max(p.entryCount, p.botEntries.filter(entry => entry.hasEntry).length),
          }))
          .sort((a, b) => a.profileId.localeCompare(b.profileId)),
      });
    }

    let mRoleProfileApply: RegExpMatchArray | null;
    if (req.method === 'POST' && (mRoleProfileApply = url.pathname.match(/^\/api\/role-profiles\/([^/]+)\/apply$/))) {
      const profileId = decodeURIComponent(mRoleProfileApply[1]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      let raw = '{}';
      let parsed: { larkAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        raw = Buffer.concat(chunks).toString('utf8') || '{}';
        parsed = JSON.parse(raw);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const larkAppId = typeof parsed.larkAppId === 'string' ? parsed.larkAppId : '';
      if (!larkAppId) return jsonRes(res, 400, { ok: false, error: 'larkAppId_required' });
      const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    let mRoleProfileEntry: RegExpMatchArray | null;
    if ((mRoleProfileEntry = url.pathname.match(/^\/api\/role-profiles\/([^/]+)\/([^/]+)$/))) {
      const profileId = decodeURIComponent(mRoleProfileEntry[1]);
      const larkAppId = decodeURIComponent(mRoleProfileEntry[2]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'DELETE' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    let mRoleProfile: RegExpMatchArray | null;
    if (req.method === 'GET' && (mRoleProfile = url.pathname.match(/^\/api\/role-profiles\/([^/]+)$/))) {
      const profileId = decodeURIComponent(mRoleProfile[1]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      type RoleProfileEntryAggregate = {
        profileId: string;
        larkAppId: string;
        content: string;
        byteLength: number;
        updatedAt: number | null;
      };
      const byBot = new Map<string, RoleProfileEntryAggregate>();
      await Promise.all(registry.list().map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/role-profiles/${encodeURIComponent(profileId)}`);
          if (!r.ok) return;
          const j = await r.json() as { entries?: any[] };
          for (const entry of j.entries ?? []) {
            if (typeof entry.larkAppId !== 'string' || typeof entry.content !== 'string') continue;
            const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : null;
            const current = byBot.get(entry.larkAppId);
            if (current && (current.updatedAt ?? 0) > (updatedAt ?? 0)) continue;
            byBot.set(entry.larkAppId, {
              profileId,
              larkAppId: entry.larkAppId,
              content: entry.content,
              byteLength: typeof entry.byteLength === 'number' ? entry.byteLength : Buffer.byteLength(entry.content, 'utf-8'),
              updatedAt,
            });
          }
        } catch { /* skip */ }
      }));
      const entries = [...byBot.values()].sort((a, b) => a.larkAppId.localeCompare(b.larkAppId));
      return jsonRes(res, 200, { profileId, entries });
    }

    let m2: RegExpMatchArray | null;
    if (req.method === 'POST' && (m2 = url.pathname.match(/^\/api\/groups\/([^/]+)\/add-bots$/))) {
      const chatId = decodeURIComponent(m2[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const result = await addBotsToGroup(chatId, raw, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // Disband a chat. Body: `{ larkAppId }` — the bot whose daemon should
    // perform the delete. See `dashboard/groups-action-helpers.ts:disbandGroup`.
    let mDisband: RegExpMatchArray | null;
    if (req.method === 'POST' && (mDisband = url.pathname.match(/^\/api\/groups\/([^/]+)\/disband$/))) {
      const chatId = decodeURIComponent(mDisband[1]);
      let parsed: unknown;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await disbandGroup(chatId, parsed, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // Make selected bots leave a chat. Body: `{ larkAppIds: string[] }`. See
    // `dashboard/groups-action-helpers.ts:leaveGroup` for membership probe +
    // cascade-close semantics.
    let mLeave: RegExpMatchArray | null;
    if (req.method === 'POST' && (mLeave = url.pathname.match(/^\/api\/groups\/([^/]+)\/leave$/))) {
      const chatId = decodeURIComponent(mLeave[1]);
      let parsed: unknown;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await leaveGroup(chatId, parsed, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // ─── Oncall bindings (per chat × bot) ────────────────────────────────────
    // External: PUT/DELETE /api/groups/:chatId/oncall/:larkAppId
    // Internal: PUT/DELETE /api/oncall/:chatId (on the named bot's daemon).
    let mOncall: RegExpMatchArray | null;
    if ((mOncall = url.pathname.match(/^\/api\/groups\/([^/]+)\/oncall\/([^/]+)$/))) {
      const chatId = decodeURIComponent(mOncall[1]);
      const appId = decodeURIComponent(mOncall[2]);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const result = await bindOncall(chatId, appId, raw, groupsActionDeps);
        return writeHandlerResult(res, result);
      }
      if (req.method === 'DELETE') {
        const result = await unbindOncall(chatId, appId, groupsActionDeps);
        return writeHandlerResult(res, result);
      }
    }

    // ─── Per-bot defaults (Bot Defaults tab) ─────────────────────────────────
    // GET  /api/bots                         — fan out to each daemon, return
    //                                          [{larkAppId, botName, defaultOncall, ...}]
    // PUT  /api/bots/:appId/default-oncall   — proxy to that bot's daemon

    if (req.method === 'GET' && url.pathname === '/api/bots') {
      const agentFields = configuredBotAgentFields();
      const onlineBots = [...registry.list()].map(b => withConfiguredCliId(b, agentFields)).sort((a, b) => a.botIndex - b.botIndex);
      const out = await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetch(`http://127.0.0.1:${d.ipcPort}/api/bot-default-oncall`);
          if (!r.ok) {
            return botDefaultsPayload(d, undefined, `http_${r.status}`);
          }
          const j = await r.json() as any;
          return botDefaultsPayload({
            ...d,
            botName: d.botName ?? j.botName,
            cliId: j.cliId || d.cliId,
            wrapperCli: j.wrapperCli || d.wrapperCli,
            model: j.model || d.model,
          }, j);
        } catch (e: any) {
          return botDefaultsPayload(d, undefined, e?.message ?? String(e));
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

    // PUT /api/bots/:appId/working-dir-mode — proxy to that bot's daemon. Body
    // `{ mode: 'off'|'default'|'oncall', workingDir }` — sets the 3-way
    // mutually-exclusive default-dir mode (defaultWorkingDir vs defaultOncall).
    let mBotWdMode: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotWdMode = url.pathname.match(/^\/api\/bots\/([^/]+)\/working-dir-mode$/))) {
      const appId = decodeURIComponent(mBotWdMode[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-working-dir-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/agent — proxy to that bot's daemon. Body
    // `{ cliId, model }`; cliId is the dashboard selection key.
    let mBotAgent: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotAgent = url.pathname.match(/^\/api\/bots\/([^/]+)\/agent$/))) {
      const appId = decodeURIComponent(mBotAgent[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/skills — proxy to that bot's daemon. Body accepts
    // `{ action:'attach'|'detach', name }` or `{ action:'set', policy|null }`.
    let mBotSkills: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSkills = url.pathname.match(/^\/api\/bots\/([^/]+)\/skills$/))) {
      const appId = decodeURIComponent(mBotSkills[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-skills`, {
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

    // PUT /api/bots/:appId/startup-commands — proxy to that bot's daemon. Body
    // `{ startupCommands: string }` (raw text, comma/newline separated; '' = clear).
    let mBotStartup: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotStartup = url.pathname.match(/^\/api\/bots\/([^/]+)\/startup-commands$/))) {
      const appId = decodeURIComponent(mBotStartup[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-startup-commands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/launch-shell — proxy to that bot's daemon. Body
    // `{ launchShell: string }` (shell name or absolute path; '' = clear → $SHELL).
    let mBotLaunchShell: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotLaunchShell = url.pathname.match(/^\/api\/bots\/([^/]+)\/launch-shell$/))) {
      const appId = decodeURIComponent(mBotLaunchShell[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-launch-shell`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/env — proxy to that bot's daemon. Body
    // `{ env: string }` (raw JSON text; '' = clear).
    let mBotEnv: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotEnv = url.pathname.match(/^\/api\/bots\/([^/]+)\/env$/))) {
      const appId = decodeURIComponent(mBotEnv[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-env`, {
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

    // PUT /api/bots/:appId/summary-range — proxy to that bot's daemon. Body
    // `{ limit, sinceHours }`; daemon updates the explicit /summary range.
    let mBotSummaryRange: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSummaryRange = url.pathname.match(/^\/api\/bots\/([^/]+)\/summary-range$/))) {
      const appId = decodeURIComponent(mBotSummaryRange[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-summary-range`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Backward-compatible alias from the short-lived keyword-trigger dashboard.
    let mBotSummaryTrigger: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSummaryTrigger = url.pathname.match(/^\/api\/bots\/([^/]+)\/summary-trigger$/))) {
      const appId = decodeURIComponent(mBotSummaryTrigger[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-summary-trigger`, {
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
    // any subset of `{ restrictGrantCommands?: boolean, autoGrantRequestCards?: boolean,
    // messageQuotaDefaultLimit?: number|null }`.
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

    // PUT /api/bots/:appId/max-live-workers — proxy to that bot's daemon. Body
    // `{ maxLiveWorkers: number | null }` (null = clear → fall back to the
    // built-in default of 30; a positive integer overrides it).
    let mBotMaxLive: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotMaxLive = url.pathname.match(/^\/api\/bots\/([^/]+)\/max-live-workers$/))) {
      const appId = decodeURIComponent(mBotMaxLive[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-max-live-workers`, {
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
      let parsed: { name?: unknown; larkAppIds?: unknown; userOpenIds?: unknown; ownerUnionIds?: unknown; bindWorkingDir?: unknown; roleProfileId?: unknown };
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
      const roleProfileId = typeof parsed.roleProfileId === 'string' && parsed.roleProfileId.trim()
        ? parsed.roleProfileId.trim()
        : null;
      if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
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
      // 跨 app 邀请通道：按 union_id 加人（open_id 是 app 作用域的，union_id 稳定，
      // 由 creator daemon 解析成本 app 的 open_id 再加）。平台「拉群」即走这条。
      const ownerUnionIds = Array.isArray(parsed.ownerUnionIds)
        ? (parsed.ownerUnionIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      // Auto-invite/transfer/notify target: prefer the explicit open_id passed
      // by the caller (rare API consumer use), else the creator bot's first
      // resolved allowlist entry.
      const autoInvited: string | null = explicit[0] ?? pick.userOpenIds[0] ?? null;

      const forwardBody = {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        larkAppIds: selectedIds,
        userOpenIds: [...merged],
        ownerUnionIds,
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
        roleProfileId: roleProfileId ?? undefined,
      };
      const upstream = await fetch(
        `http://127.0.0.1:${creator.ipcPort}/api/groups/create`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forwardBody) },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
      if (upstreamJson && typeof upstreamJson === 'object') {
        if (roleProfileId) upstreamJson.roleProfileId = roleProfileId;
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

    // Dashboard「创建会话」：建飞书群 + 拉选中的 bot，然后按协作模式给各 bot 拉起/暂存
    // 一条 chat-scope 会话。一起开工=每个被选 bot 各起一条；lead 分配=只起 lead，由它
    // 在群里 @ 拉起 sub bot。in_progress=立即开跑；backlog=入待办池（parked，等激活）。
    if (req.method === 'POST' && url.pathname === '/api/sessions/create') {
      let parsed: {
        content?: unknown; larkAppIds?: unknown; mode?: unknown; column?: unknown;
        leadLarkAppId?: unknown; name?: unknown; bindWorkingDir?: unknown;
      };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const content = typeof parsed.content === 'string' ? parsed.content.replace(/\s+$/u, '') : '';
      if (!content.trim()) return jsonRes(res, 400, { ok: false, error: 'empty_content' });
      const selectedIds = Array.isArray(parsed.larkAppIds)
        ? Array.from(new Set((parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')))
        : [];
      if (selectedIds.length === 0) return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      const mode = parsed.mode === 'lead' ? 'lead' : parsed.mode === 'all' ? 'all' : null;
      if (!mode) return jsonRes(res, 400, { ok: false, error: 'bad_mode' });
      const column = parsed.column === 'backlog' ? 'backlog' : parsed.column === 'in_progress' ? 'in_progress' : null;
      if (!column) return jsonRes(res, 400, { ok: false, error: 'bad_column' });
      const bindWorkingDir = typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
        ? parsed.bindWorkingDir.trim() : undefined;
      const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : undefined;

      // 解析 creator：lead 模式 = lead bot；一起开工 = pickCreatorForGroup 在选中里挑一个在线的。
      let creatorLarkAppId: string;
      if (mode === 'lead') {
        const leadLarkAppId = typeof parsed.leadLarkAppId === 'string' ? parsed.leadLarkAppId : '';
        if (!leadLarkAppId || !selectedIds.includes(leadLarkAppId)) {
          return jsonRes(res, 400, { ok: false, error: 'bad_lead' });
        }
        if (!registry.getByAppId(leadLarkAppId)) return jsonRes(res, 503, { ok: false, error: 'lead_offline' });
        creatorLarkAppId = leadLarkAppId;
      } else {
        const pick = pickCreatorForGroup(selectedIds, (id) => {
          const d = registry.getByAppId(id);
          return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
        });
        if (!pick) return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
        creatorLarkAppId = pick.creatorLarkAppId;
      }

      // creator 作用域里的操作者 open_id（首个 ou_ allowedUser）——用于邀请进群 + 转群主 + @通知。
      // 同时取 on_（union_id，租户内跨 app 稳定）做兜底邀请：lead 模式强制 creator=lead，
      // 万一 lead 的 allowlist 没有 ou_ 条目，open_id 解析不到、操作者就进不了群——union_id
      // 不受 app 作用域影响，仍能把人拉进来（createGroupWithBots 走 ownerUnionIds 通道）。
      const creatorDesc = registry.getByAppId(creatorLarkAppId)!;
      const allowed = creatorDesc.resolvedAllowedUsers ?? [];
      const userOpenId = allowed.find(u => u.startsWith('ou_'));
      const ownerUnionIds = allowed.filter(u => u.startsWith('on_'));

      // 建群（拉所有选中 bot + 邀请操作者 + 转群主 + @通知 + 可选绑 oncall 工作目录）。
      let groupResp: any = null;
      try {
        const groupUpstream = await proxyToDaemon(creatorLarkAppId, '/api/groups/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            larkAppIds: selectedIds,
            userOpenIds: userOpenId ? [userOpenId] : [],
            ownerUnionIds,
            transferOwnerTo: userOpenId,
            notifyOwnerOpenId: userOpenId,
            bindWorkingDir,
          }),
        });
        groupResp = await groupUpstream.json().catch(() => null);
        if (!groupUpstream.ok || !groupResp?.ok || typeof groupResp.chatId !== 'string') {
          return jsonRes(res, 502, { ok: false, error: groupResp?.error ?? `group_create_http_${groupUpstream.status}` });
        }
      } catch {
        return jsonRes(res, 502, { ok: false, error: 'group_create_proxy_failed' });
      }
      const chatId: string = groupResp.chatId;
      const invalidBotIds: string[] = Array.isArray(groupResp.invalidBotIds) ? groupResp.invalidBotIds : [];

      // spawn 目标：lead 模式只有 lead；一起开工是所有成功入群的选中 bot。
      const joinedIds = selectedIds.filter(id => !invalidBotIds.includes(id) && !!registry.getByAppId(id));
      const targets = mode === 'lead'
        ? (joinedIds.includes(creatorLarkAppId) ? [creatorLarkAppId] : [])
        : joinedIds;
      if (targets.length === 0) {
        return jsonRes(res, 200, { ok: true, chatId, shareLink: groupResp.shareLink, spawned: [], failed: [], warning: 'no_spawn_target' });
      }

      const bots = liveBots();
      const nameOf = (id: string) => bots.find(b => b.larkAppId === id)?.botName ?? id;
      const spawned: string[] = [];
      const failed: Array<{ larkAppId: string; error: string }> = [];
      await Promise.all(targets.map(async (appId) => {
        const role = mode === 'lead' ? 'lead' : (targets.length > 1 ? 'collab' : 'solo');
        // lead 的 coworker = 所有 sub（除自己）；collab 的 coworker = 其它并列 bot（除自己）。
        const coworkerIds = (mode === 'lead' ? selectedIds : targets).filter(id => id !== appId);
        const coworkers = coworkerIds.map(id => ({ name: nameOf(id) }));
        try {
          const up = await proxyToDaemon(appId, '/api/sessions/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chatId, content, column, role, coworkers,
              postBanner: appId === creatorLarkAppId,
            }),
          });
          const b = await up.json().catch(() => null);
          if (up.ok && b?.ok) spawned.push(appId);
          else failed.push({ larkAppId: appId, error: b?.error ?? `http_${up.status}` });
        } catch (e: any) {
          failed.push({ larkAppId: appId, error: e?.message ?? String(e) });
        }
      }));

      return jsonRes(res, 200, {
        ok: true, chatId, shareLink: groupResp.shareLink, mode, column, spawned, failed,
      });
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

// Web terminal WebSocket reverse-proxy: bridge `/s/*` upgrade requests through to
// the local terminal proxy (which in turn bridges to the session worker). Raw
// socket-to-socket bridge: dial 127.0.0.1:<terminalProxyPort>, replay the upgrade
// request line + headers verbatim, then pipe both directions. Mirrors how
// terminal-proxy.ts bridges to the worker. Non-`/s/*` upgrades are dropped (the
// dashboard SPA uses SSE, not WebSocket).
server.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
  try {
    const rawUrl = req.url ?? '/';
    if (!(rawUrl === '/s' || rawUrl.startsWith('/s/') || rawUrl.startsWith('/s?'))) {
      return clientSocket.destroy();
    }
    // Strip query/hash before extracting the sessionId path segment.
    const pathname = rawUrl.split(/[?#]/)[0];
    const sessionId = parseTerminalSessionId(pathname);
    const tport = sessionId ? aggregator.terminalProxyPortOf(sessionId) : undefined;
    if (!tport) return clientSocket.destroy();

    const upstream = netConnect(tport, '127.0.0.1', () => {
      // rawHeaders is a flat [k, v, k, v, ...] list — preserves casing/duplicates.
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const rh = req.rawHeaders;
      for (let i = 0; i + 1 < rh.length; i += 2) lines.push(`${rh[i]}: ${rh[i + 1]}`);
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const cleanup = () => {
      try { upstream.destroy(); } catch { /* ignore */ }
      try { clientSocket.destroy(); } catch { /* ignore */ }
    };
    upstream.on('error', cleanup);
    clientSocket.on('error', cleanup);
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  } catch {
    try { clientSocket.destroy(); } catch { /* ignore */ }
  }
});

// 拉长 keep-alive 空闲超时：中心化平台反代用 keep-alive 连接池复用隧道连接，但 Node 默认
// keepAliveTimeout 才 5s——空闲>5s 后 dashboard 把连接关了，而平台侧 Agent 可能还把它留在池里
// 复用 → 撞到刚关的连接、首批请求 502。把它拉到 75s（headersTimeout 需更大），让池里的连接在
// 正常使用间隔内不被这端提前关掉，平台复用稳、不再有 stale-reuse 的首批 502。本地直连无副作用。
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

// Probe upward on EADDRINUSE rather than crashing with an unhandled 'error':
// a second botmux instance on this host (or a stray process) holding the
// configured port would otherwise tear the dashboard process down on bind.
// The bound port is persisted so `botmux dashboard` can still reach us.
listenWithProbe({
  server,
  port: config.dashboard.port,
  host: config.dashboard.host,
  portAvailable: dashboardPortAvailable,
  verifyBound: verifyDashboardBinding,
  log: (m) => logger.warn(`[dashboard] ${m}`),
}).then((port) => {
  boundDashboardPort = port;
  try { atomicWriteFileSync(PORT_PATH, String(port)); } catch (e) {
    logger.warn(`[dashboard] Failed to persist port to ${PORT_PATH}: ${(e as Error).message}`);
  }
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${port}`);
  startPlatformTunnelIfBound();
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

// 单候选自动绑定：standalone（未入团队）部署不必手动点面板「绑定」——用各机器人自己的
// 凭证从 allowedUsers 解析出唯一负责人就自动认领，左上角飞书头像 / 拉群把发起人拉进群 /
// 机器人归属随即生效。多候选（部署里配了多个人）仍保留手动选择。幂等：绑定后即刻 no-op。
// 启动时按 0/5/15/60s 退避重试几次以覆盖 boot 时网络/凭证尚未就绪，之后交给手动按钮，
// 不挂进永久心跳（避免对真·多候选/无 allowedUsers 的部署每 2 分钟空打飞书）。
async function tryAutoBindOwner(): Promise<'done' | 'retry'> {
  try {
    const r = await autoBindOwnerIfUnambiguous(config.session.dataDir, { fetcher: fetch, live: liveBots() });
    if (r.status === 'bound') { logger.info(`[identity] 已自动绑定本部署负责人：${r.owner?.name || r.owner?.unionId}（头像/拉群/归属即时生效）`); return 'done'; }
    if (r.status === 'already_bound') return 'done';
    if (r.status === 'need_choice') { logger.info(`[identity] 检测到 ${r.candidates?.length ?? 0} 个候选负责人，请到面板「团队」手动选择绑定`); return 'done'; }
    return 'retry'; // no_candidates：可能是网络/凭证未就绪的瞬时失败，退避后重试
  } catch (e) {
    logger.debug(`[identity] 自动绑定尝试失败（将退避重试）：${(e as Error).message}`);
    return 'retry';
  }
}
void (async () => {
  for (const delayMs of [0, 5_000, 15_000, 60_000]) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if ((await tryAutoBindOwner()) === 'done') return;
  }
})();

// 中心化平台隧道（已绑定才启动；每台机器一个，跑在 dashboard 进程里）
let platformTunnel: { stop(): void } | null = null;
function readBotmuxVersion(): string {
  // 与本地 dashboard「版本与更新」卡同源：源码 checkout 的 package.json 是占位的 0.0.0，
  // resolveCurrentVersion() 会用 git describe 推出真实版本（如 2.91.1），npm 安装则用 package.json。
  try {
    return resolveCurrentVersion();
  } catch {
    return 'unknown';
  }
}
/** 读本机 bots-info.json，转成上报给平台的 bot 概要（人→机器→bot + 拉群用）。 */
function readPlatformBotsInfo(): PlatformBotInfo[] {
  try {
    const fp = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(fp)) return [];
    const entries = JSON.parse(readFileSync(fp, 'utf8')) as Array<{
      larkAppId?: string;
      botOpenId?: string | null;
      botName?: string | null;
      botAvatarUrl?: string | null;
      cliId?: string;
    }>;
    if (!Array.isArray(entries)) return [];
    // Merge per-bot team-visibility config (showInTeam) from bots.json by
    // larkAppId so the platform team page can hide bots. Default: showInTeam =
    // true (shown). bots.json may be unreadable from the dashboard process →
    // fall back to the default.
    const cfgByAppId = new Map<string, { showInTeam?: boolean }>();
    try {
      for (const cfg of loadBotConfigs()) {
        cfgByAppId.set(cfg.larkAppId, { showInTeam: cfg.showInTeam });
      }
    } catch {
      /* defaults below */
    }
    return entries
      .map((e) => {
        const cfg = cfgByAppId.get(e.larkAppId || '');
        return {
          appId: e.larkAppId || '',
          openId: e.botOpenId ?? null,
          name: e.botName || e.larkAppId || 'bot',
          avatar: e.botAvatarUrl || undefined,
          cli: e.cliId,
          showInTeam: cfg?.showInTeam !== false, // default true
        };
      })
      .filter((b) => b.appId);
  } catch {
    return [];
  }
}

function startPlatformTunnelIfBound(): void {
  try {
    const binding = readPlatformBinding();
    if (!binding) return;
    const version = readBotmuxVersion();
    platformTunnel = startPlatformTunnelClient({
      binding,
      getDashboardPort: () => boundDashboardPort,
      getDashboardToken: () => activeToken,
      getVersion: () => version,
      getBots: () => readPlatformBotsInfo(),
      log: (msg, extra) => logger.info(`[platform-tunnel] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    });
    logger.info(`[platform-tunnel] 绑定到 ${binding.platformUrl}，启动隧道`);
  } catch (e) {
    logger.warn(`[platform-tunnel] 启动失败: ${(e as Error).message}`);
  }
}

// Graceful shutdown
function shutdown(): void {
  for (const off of subs.values()) off();
  subs.clear();
  registry.stop();
  platformTunnel?.stop();
  server.close(() => process.exit(0));
  // Hard-exit fallback after 5s
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
