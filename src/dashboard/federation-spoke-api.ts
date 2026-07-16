/**
 * Federation SPOKE endpoints, mounted INSIDE the dashboard's token gate (these
 * are owner actions — the dashboard token already proves the owner). The spoke
 * makes OUTBOUND calls to a hub; it never needs to expose anything inbound.
 *   - POST /api/team/join-remote   { hubUrl, inviteCode }
 *   - GET  /api/team/remote-roster
 *   - POST /api/team/sync-remote
 *   - POST /api/team/leave-remote  { hubUrl, teamId }
 *
 * The long-lived syncToken is sent in the `Authorization: Bearer` header (never
 * in a URL, so it stays out of access/proxy logs). All hub calls have a timeout.
 * See docs/federation-design.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { jsonRes } from './http.js';
import { buildTeamRoster, type LiveBot } from '../services/team-roster.js';
import { buildFederatedRoster } from '../services/federation-roster.js';
import { getDeploymentIdentity, setDeploymentName } from '../services/deployment-identity.js';
import { addMembership, listMemberships, removeMembership } from '../services/federation-membership-store.js';
import type { FederatedBot } from '../services/federation-store.js';
import { listFederatedDeployments } from '../services/federation-store.js';
import { ensureDefaultTeam, DEFAULT_TEAM_ID, listTeams, createTeam, deleteTeam, getTeam } from '../services/team-store.js';
import { listTeamGroups, recordTeamGroup } from '../services/team-groups-store.js';
import { createInvite, deleteInvitesForTeam } from '../services/invite-store.js';
import { removeTeamFederation, removeDeployment } from '../services/federation-store.js';
import { loadBotConfigs, registerBot, getBot, type BotConfig } from '../bot-registry.js';
import { setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import { setBotOwner } from '../services/bot-owner-store.js';
import { setDeploymentOwner } from '../services/deployment-identity.js';
import { createPairing, getPairingStatus, consumePairing } from '../services/pairing-store.js';
import { resolveAllowedUsersWithMap, resolveUserUnionId } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import {
  fetchWithTimeout,
  hubError,
  orchestrateFederatedGroup,
  type Fetcher,
  type TeamGroupCreateResult,
  type TeamGroupOwnerTransferResult,
} from './federated-group-core.js';

export interface OwnerCandidate { unionId: string; name: string }

/** Injectable seams for the owner resolver (defaults hit Feishu via the bot's
 *  own credentials). Lets the resolver's registry/iteration logic be unit-tested
 *  without network. */
interface OwnerResolveDeps {
  configs?: () => BotConfig[];
  /** Auth-only callers only need union_id membership and should not pay a
   *  best-effort contact lookup just to decorate direct `on_` candidates. */
  skipNames?: boolean;
  /** Ensure a usable Lark client exists for cfg. The DASHBOARD process has no bot
   *  registry (it proxies to daemons), so getBotClient() would throw — register
   *  the cfg on demand (it carries the app secret from bots.json). */
  ensureClient?: (cfg: BotConfig) => void;
  resolveAllowed?: (larkAppId: string, allowed: string[]) => Promise<string[]>;
  resolveUnion?: (larkAppId: string, openId: string) => Promise<{ unionId?: string; name?: string }>;
}

/** Resolve this deployment's owner identity from bots.json `allowedUsers` using
 *  each bot's OWN app credentials (no /pair, no shared pairings.json — immune to
 *  the dataDir-split that broke /pair). Iterates ALL bots with non-empty
 *  allowedUsers, resolves each independently, then aggregates and deduplicates by
 *  union_id across all bots. The UI auto-binds when there's exactly one candidate,
 *  else lets the owner pick. A bot failing (no scope / API error) is skipped so
 *  one mis-config doesn't hide the rest.
 *
 *  allowedUsers 支持三种格式：
 *  - `on_xxx` (union_id)  — 跨应用稳定 ID，直接使用，无需 API 解析（推荐）
 *  - 邮箱                 — 通过 bot 凭证查询 open_id 再转 union_id
 *  - `ou_xxx` (open_id)   — 仅对签发该 open_id 的同一应用有效；跨应用会报 99992361 */
export async function resolveOwnerCandidatesFromAllowedUsers(d: OwnerResolveDeps = {}): Promise<OwnerCandidate[]> {
  const loadConfigs = d.configs ?? loadBotConfigs;
  const ensureClient = d.ensureClient ?? ((cfg: BotConfig) => { try { getBot(cfg.larkAppId); } catch { registerBot(cfg); } });
  const resolveAllowed = d.resolveAllowed ?? (async (id, a) => (await resolveAllowedUsersWithMap(id, a)).resolved);
  const resolveUnion = d.resolveUnion ?? resolveUserUnionId;
  const skipNames = d.skipNames === true;
  let configs: BotConfig[] = [];
  try { configs = loadConfigs(); } catch { return []; }
  const byUnion = new Map<string, OwnerCandidate>();
  for (const cfg of configs) {
    const allowed = cfg.allowedUsers ?? [];
    if (allowed.length === 0) continue;

    // on_ union_id: 跨应用稳定，直接加入候选列表，无需 bot 凭证（best-effort 补名字）
    for (const v of allowed) {
      if (!v.startsWith('on_') || byUnion.has(v)) continue;
      let name = '';
      if (!skipNames) {
        try {
          ensureClient(cfg);
          const res = await (getBot(cfg.larkAppId).client as any).contact.v3.user.get({
            path: { user_id: v }, params: { user_id_type: 'union_id' },
          });
          if (res.code === 0) name = res.data?.user?.name ?? '';
        } catch { /* best-effort */ }
      }
      byUnion.set(v, { unionId: v, name });
    }

    // 邮箱 / ou_ open_id: 通过 bot 自身凭证解析
    const nonUnion = allowed.filter(v => !v.startsWith('on_'));
    if (nonUnion.length === 0) continue;
    try { ensureClient(cfg); } catch { continue; }
    let openIds: string[] = [];
    try { openIds = await resolveAllowed(cfg.larkAppId, nonUnion); } catch {
      logger.warn(`resolveOwnerCandidates [${cfg.larkAppId}]: resolveAllowed 失败，跳过该 bot`);
      continue;
    }
    for (const oid of openIds) {
      if (!oid.startsWith('ou_')) continue;
      const u = await resolveUnion(cfg.larkAppId, oid);
      if (u.unionId && !byUnion.has(u.unionId)) {
        byUnion.set(u.unionId, { unionId: u.unionId, name: u.name ?? '' });
      }
    }
  }
  return [...byUnion.values()];
}

// Keep in sync with MAX_ROLE_BYTES in core/role-resolver.ts.
const MAX_ROLE_BYTES = 32 * 1024;
/** Team-level role file at {dataDir}/team-roles/{larkAppId}.md (matches role-resolver). */
function teamRolePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, 'team-roles', `${larkAppId}.md`);
}
function writeTeamRole(dataDir: string, larkAppId: string, content: string): void {
  const fp = teamRolePath(dataDir, larkAppId);
  mkdirSync(dirname(fp), { recursive: true });
  let out = content.trim();
  const buf = Buffer.from(out, 'utf-8');
  if (buf.length > MAX_ROLE_BYTES) {
    let end = MAX_ROLE_BYTES;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // don't split a codepoint
    out = buf.subarray(0, end).toString('utf-8');
  }
  atomicWriteFileSync(fp, out);
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/** Normalize a hub base URL (strip trailing slash); only http/https allowed. */
function normalizeHubUrl(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(s)) return null;
  return s;
}

/** bots.json (config) order of larkAppIds, so federated rosters match the dashboard. */
function botConfigOrder(): string[] {
  try { return loadBotConfigs().map(b => b.larkAppId); } catch { return []; }
}

/** This deployment's bots, in the shape the hub federates (bots.json order).
 *  Prefer the live daemon registry (authoritative) over bots-info.json. */
function localBots(dataDir: string, live?: LiveBot[]): FederatedBot[] {
  return buildTeamRoster(dataDir, undefined, undefined, live).bots.map(b => ({
    larkAppId: b.larkAppId,
    botName: b.name,
    cliId: b.cliId,
    capability: b.capability,
    hasTeamRole: b.hasTeamRole,
    // owner (union_id+name) federated so the hub can pull owners into 拉群
    ownerUnionId: b.owner?.unionId,
    ownerName: b.owner?.name,
    // botUnionId: not needed — 拉群 adds bots by app_id (larkAppId), see docs
  }));
}

/** 上报给团队看板的会话裁剪行所需的最小字段（来源 SessionRow）。 */
export interface TeamSessionRowLike {
  sessionId: string;
  botName?: string;
  cliId?: string;
  status?: string;
  title?: string;
  chatId: string;
  scope?: string;
  adopt?: boolean;
  lastMessageAt?: number;
}

/** Push this deployment's current bots to every joined hub. Best-effort.
 *  传 sessionsProvider 时顺带上报团队看板的会话裁剪行：hub 在 sync 响应里下发
 *  该团队的协作群清单，按 chatId 过滤本地会话 POST 回 hub（活跃优先，截 200）。 */
export async function syncAllMemberships(
  dataDir: string,
  fetcher: Fetcher = fetch,
  live?: LiveBot[],
  sessionsProvider?: () => TeamSessionRowLike[],
): Promise<{ synced: number; failed: number }> {
  const bots = localBots(dataDir, live);
  const me = getDeploymentIdentity(dataDir);
  let synced = 0, failed = 0;
  for (const m of listMemberships(dataDir)) {
    try {
      const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
        body: JSON.stringify({ syncToken: m.syncToken, bots, ownerUnionId: me.ownerUnionId, ownerName: me.ownerName, name: me.name }),
      });
      if (r.ok) synced++; else failed++;
      if (r.ok) {
        try {
          const j = await r.json().catch(() => ({} as any));
          const groupChatIds: unknown[] = Array.isArray(j?.groupChatIds) ? j.groupChatIds : [];
          // Mirror this team's 拉群 groups onto THIS (member) deployment so its
          // auth gate sees the same trust boundary as the hub — a teammate bot
          // talking in one of these groups is then learned + trusted locally
          // (see [[team-bots-store]] / isTeamGroupChat). Recorded regardless of
          // sessionsProvider; the session-report below is the separate concern.
          for (const cid of groupChatIds) recordTeamGroup(dataDir, m.teamId, String(cid));
          if (groupChatIds.length && sessionsProvider) {
            const teamChats = new Set(groupChatIds.map(String));
            const sessions = sessionsProvider()
              .filter(s => teamChats.has(String(s.chatId)))
              .sort((a, b) => {
                // 活跃优先，再按最近活跃倒序——截断时先丢最旧的已关闭会话
                const ac = a.status === 'closed' ? 1 : 0;
                const bc = b.status === 'closed' ? 1 : 0;
                if (ac !== bc) return ac - bc;
                return Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0);
              })
              .slice(0, 200)
              .map(s => ({
                sessionId: s.sessionId,
                botName: s.botName,
                cliId: s.cliId,
                status: s.status,
                title: s.title,
                chatId: s.chatId,
                scope: s.scope,
                adopt: s.adopt || undefined,
                lastMessageAt: Number(s.lastMessageAt ?? 0),
              }));
            await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/team-sessions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
              body: JSON.stringify({ sessions }),
            });
          }
        } catch { /* 上报失败不影响心跳同步本身 */ }
      }
    } catch { failed++; }
  }
  return { synced, failed };
}

/** Persist a resolved owner as THIS deployment's identity, claim its unassigned
 *  bots (no-steal: only bots without a manual owner), then push the new identity
 *  to every joined hub. Shared verbatim by the interactive bind paths (/pair
 *  consume, dashboard auto-bind) and the headless startup auto-bind, so the three
 *  never drift apart. */
export async function bindDeploymentOwnerAndClaim(
  dataDir: string,
  owner: { unionId?: string; name?: string },
  opts: { fetcher?: Fetcher; live?: LiveBot[] } = {},
): Promise<{ synced: number; failed: number }> {
  setDeploymentOwner(dataDir, owner);
  for (const b of buildTeamRoster(dataDir, undefined, undefined, opts.live).bots) {
    setBotOwner(dataDir, b.larkAppId, { unionId: owner.unionId, name: owner.name }, { override: false });
  }
  return syncAllMemberships(dataDir, opts.fetcher ?? fetch, opts.live).catch(() => ({ synced: 0, failed: 0 }));
}

/** Headless single-candidate auto-bind, for a standalone (non-team) deployment so
 *  the owner identity gets set WITHOUT a manual dashboard click — the left-rail
 *  avatar then shows, 拉群 can pull the operator in, and bots are claimed. Resolves
 *  the owner from the bots' OWN allowedUsers (no /pair, immune to the dataDir-split
 *  that /pair has). Only acts when there is exactly ONE candidate (unambiguous); a
 *  multi-person deployment still needs the dashboard picker. Idempotent: a no-op
 *  once bound (cheap local read, no network). */
export async function autoBindOwnerIfUnambiguous(
  dataDir: string,
  opts: { fetcher?: Fetcher; live?: LiveBot[]; ownerCandidates?: () => Promise<OwnerCandidate[]> } = {},
): Promise<{ status: 'already_bound' | 'bound' | 'need_choice' | 'no_candidates'; owner?: OwnerCandidate; candidates?: OwnerCandidate[] }> {
  if (getDeploymentIdentity(dataDir).ownerUnionId) return { status: 'already_bound' };
  const candidates = await (opts.ownerCandidates ?? resolveOwnerCandidatesFromAllowedUsers)();
  if (candidates.length === 0) return { status: 'no_candidates' };
  if (candidates.length > 1) return { status: 'need_choice', candidates };
  const owner = candidates[0];
  await bindDeploymentOwnerAndClaim(dataDir, owner, opts);
  return { status: 'bound', owner };
}

export interface FederationSpokeDeps {
  dataDir?: string;
  fetcher?: Fetcher;
  /** Live daemon-registry bots (injected by dashboard.ts) — authoritative source
   *  for THIS deployment's bots, so an empty/stale bots-info.json never hides
   *  running bots from the team roster / federation sync. */
  liveBots?: () => LiveBot[];
  /** Injected by dashboard.ts — picks a local online creator + proxies to its
   *  daemon's /api/groups/create (federated bots are added by larkAppId). */
  createTeamGroup?: (args: { name: string; larkAppIds: string[]; ownerUnionIds?: string[]; transferOwnerUnionId?: string }) => Promise<TeamGroupCreateResult>;
  transferTeamGroupOwner?: (args: {
    creatorLarkAppId: string;
    chatId: string;
    transferOwnerUnionId: string;
  }) => Promise<TeamGroupOwnerTransferResult>;
  /** Test seam: resolve owner candidates from allowedUsers (defaults to the real
   *  Feishu-backed resolver). */
  ownerCandidates?: () => Promise<OwnerCandidate[]>;
}

export async function handleFederationSpokeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FederationSpokeDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  const LOCAL = new Set(['/api/team/local', '/api/team/local-invite', '/api/team/rename-deployment', '/api/team/federated-group',
    '/api/team/identity/start', '/api/team/identity/status', '/api/team/identity/consume', '/api/team/identity/auto-bind',
    '/api/team/hosted']);
  const REMOTE = new Set(['/api/team/join-remote', '/api/team/remote-roster', '/api/team/sync-remote', '/api/team/leave-remote', '/api/team/remote-group',
    '/api/team/remote-board', '/api/team/remote-board-move']);
  const localBotEdit = path.match(/^\/api\/team\/local-bots\/([^/]+)\/(capability|role)$/);
  const memberDel = path.match(/^\/api\/team\/hosted\/([^/]+)\/members\/([^/]+)$/);
  const hostedDel = path.match(/^\/api\/team\/hosted\/([^/]+)$/);
  if (!LOCAL.has(path) && !REMOTE.has(path) && !localBotEdit && !memberDel && !hostedDel) return false;
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const fetcher = deps.fetcher ?? fetch;
  const method = req.method ?? 'GET';
  const live = deps.liveBots?.(); // live registry bots (authoritative over bots-info.json)

  // Edit a LOCAL bot's capability label / team role (federated bots are read-only
  // — they're owned by another deployment and synced over). Local bots only.
  if (localBotEdit) {
    const larkAppId = decodeURIComponent(localBotEdit[1]);
    const field = localBotEdit[2];
    const localIds = new Set(buildTeamRoster(dataDir, undefined, undefined, live).bots.map(b => b.larkAppId));
    if (!localIds.has(larkAppId)) { jsonRes(res, 404, { ok: false, error: 'not_a_local_bot' }); return true; }
    if (field === 'role' && method === 'GET') {
      const fp = teamRolePath(dataDir, larkAppId);
      jsonRes(res, 200, { ok: true, role: existsSync(fp) ? readFileSync(fp, 'utf-8') : '' });
      return true;
    }
    if (method === 'PUT') {
      let body: any;
      try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
      if (field === 'capability') {
        const cap = String(body?.capability ?? '').trim();
        if (cap) setBotCapability(dataDir, larkAppId, cap); else clearBotCapability(dataDir, larkAppId);
      } else {
        const role = String(body?.role ?? '').trim();
        if (role) writeTeamRole(dataDir, larkAppId, role);
        else { try { unlinkSync(teamRolePath(dataDir, larkAppId)); } catch { /* already gone */ } }
      }
      jsonRes(res, 200, { ok: true });
      return true;
    }
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  // Cross-deployment 拉群: create a Feishu group with selected bots (local +
  // federated). Bots are added by larkAppId (app_id) — the creator is picked
  // from local online bots; federated bots (other apps, same tenant) are added
  // as members. See docs/federation-design.md.
  if (path === '/api/team/federated-group' && method === 'POST') {
    if (!deps.createTeamGroup) { jsonRes(res, 501, { ok: false, error: 'group_create_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const larkAppIds: string[] = Array.isArray(body?.larkAppIds) ? body.larkAppIds.filter((x: any) => typeof x === 'string') : [];
    const name = String(body?.name ?? '').trim() || '协作群';
    // Operator = THIS deployment's bound owner (local initiation). Hub-derived
    // operator (for spoke-initiated /api/federation/group) is handled separately.
    const operatorUnionId = getDeploymentIdentity(dataDir).ownerUnionId;
    const teamId = String(body?.teamId ?? '').trim() || DEFAULT_TEAM_ID; // which hosted team's roster gates the selection
    // Validate the team exists — buildFederatedRoster falls back to the default
    // team for an unknown teamId, so a stale/deleted teamId must be refused here
    // (else 拉群 would silently use the default team's roster). ensureDefaultTeam
    // first so the implicit default team always passes.
    ensureDefaultTeam(dataDir);
    if (!getTeam(dataDir, teamId)) { jsonRes(res, 404, { ok: false, error: 'team_not_found' }); return true; }
    // Operator must end up in the group; only a bot in the operator's OWN
    // deployment+scope can add them. If this deployment HAS online bots but the
    // user selected none, the group would be built by a remote bot that can't add
    // the operator → make them pick one. (If there are no local online bots at
    // all, fall through to delegate-build — degenerate case, operator may not be
    // addable, surfaced as missingOperatorIdentity.)
    const localOnline = new Set((live ?? []).map(b => b.larkAppId));
    if (localOnline.size > 0 && !larkAppIds.some(id => localOnline.has(id))) {
      jsonRes(res, 400, { ok: false, error: 'no_local_online_bot' }); return true;
    }
    const out = await orchestrateFederatedGroup(
      dataDir,
      { name, larkAppIds, operatorUnionId, requestId: randomUUID(), teamId },
      {
        createTeamGroup: deps.createTeamGroup,
        transferTeamGroupOwner: deps.transferTeamGroupOwner,
        fetcher,
        live,
      },
    );
    jsonRes(res, out.status, out.body);
    return true;
  }

  // ── Bind THIS deployment's owner Feishu identity (reuse /pair) ─────────────
  // Owner sends `/pair <code>` to one of our bots; we capture their union_id so
  // 拉群 can pull the operator into groups, and own our bots (no-steal).
  if (path === '/api/team/identity/start' && method === 'POST') {
    const p = createPairing(dataDir, 5 * 60 * 1000);
    jsonRes(res, 200, { ok: true, pairingId: p.pairingId, code: p.code, browserToken: p.browserToken, expiresAt: p.expiresAt });
    return true;
  }
  if (path === '/api/team/identity/status' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const v = getPairingStatus(dataDir, String(body?.pairingId ?? ''), String(body?.browserToken ?? ''));
    if (v.status === 'not_found') { jsonRes(res, 200, { ok: true, status: 'not_found' }); return true; }
    jsonRes(res, 200, { ok: true, status: v.status, name: v.status === 'claimed' ? v.claimedBy.name : undefined });
    return true;
  }
  if (path === '/api/team/identity/consume' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const c = consumePairing(dataDir, String(body?.pairingId ?? ''), String(body?.browserToken ?? ''));
    if (!c.ok) { jsonRes(res, 409, { ok: false, error: c.reason }); return true; }
    const owner = { unionId: c.claimedBy.unionId, name: c.claimedBy.name };
    // Bind + claim bots + push to hubs NOW (best-effort) so a 拉群 immediately after
    // binding can derive the operator — don't wait for the 2-min periodic sync,
    // otherwise #3 (operator not invited) reproduces.
    const sync = await bindDeploymentOwnerAndClaim(dataDir, owner, { fetcher, live });
    jsonRes(res, 200, { ok: true, owner, hubsSynced: sync.synced, hubsFailed: sync.failed });
    return true;
  }

  // ── Bind owner WITHOUT /pair: resolve allowedUsers via the bots' own creds ──
  // No code to copy, no shared pairings.json (immune to dataDir-split). If the
  // bots' allowedUsers resolve to exactly one person, bind them; if several,
  // return candidates for the owner to pick (re-POST with {unionId}).
  if (path === '/api/team/identity/auto-bind' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const candidates = await (deps.ownerCandidates ?? resolveOwnerCandidatesFromAllowedUsers)();
    if (candidates.length === 0) { jsonRes(res, 200, { ok: false, error: 'no_candidates' }); return true; }
    const want = String(body?.unionId ?? '').trim();
    const chosen = want ? candidates.find(c => c.unionId === want) : (candidates.length === 1 ? candidates[0] : undefined);
    if (!chosen) { jsonRes(res, 200, { ok: true, needChoice: true, candidates }); return true; }
    const owner = { unionId: chosen.unionId, name: chosen.name };
    const sync = await bindDeploymentOwnerAndClaim(dataDir, owner, { fetcher, live });
    jsonRes(res, 200, { ok: true, owner, hubsSynced: sync.synced, hubsFailed: sync.failed });
    return true;
  }

  // ── Initiate 拉群 on a JOINED remote team (spoke → hub orchestrates) ────────
  if (path === '/api/team/remote-group' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const teamId = String(body?.teamId ?? '').trim();
    const larkAppIds: string[] = Array.isArray(body?.larkAppIds) ? body.larkAppIds.filter((x: any) => typeof x === 'string') : [];
    const name = String(body?.name ?? '').trim() || '协作群';
    if (!hubUrl || !teamId) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    if (larkAppIds.length === 0) { jsonRes(res, 400, { ok: false, error: 'no_bots_selected' }); return true; }
    const m = listMemberships(dataDir).find(x => x.hubUrl === hubUrl && x.teamId === teamId);
    if (!m) { jsonRes(res, 404, { ok: false, error: 'not_a_member' }); return true; }
    // Push our latest owner + bots to the hub BEFORE it orchestrates, so the
    // operator union_id (hub-derived from our synced record) is fresh — otherwise
    // a 拉群 right after binding could still see a stale/empty owner (the periodic
    // sync is every 2 min) → operator not invited.
    await syncAllMemberships(dataDir, fetcher, live).catch(() => { /* best-effort; group still works without it */ });
    try {
      const r = await fetchWithTimeout(fetcher, `${hubUrl}/api/federation/group`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
        body: JSON.stringify({ name, larkAppIds, requestId: randomUUID() }),
      });
      const j = await r.json().catch(() => ({} as any));
      jsonRes(res, r.ok ? 200 : (r.status === 400 || r.status === 403 ? r.status : 502), j);
    } catch (e) {
      const he = hubError(e);
      jsonRes(res, he.status, { ok: false, error: he.error });
    }
    return true;
  }

  // ── Local team (this deployment as a Hub: identity + own roster + invites) ──
  if (path === '/api/team/local' && method === 'GET') {
    ensureDefaultTeam(dataDir);
    const me = getDeploymentIdentity(dataDir);
    const suggestedHubUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}`;
    jsonRes(res, 200, { ok: true, deployment: me, suggestedHubUrl, ...buildFederatedRoster(dataDir, DEFAULT_TEAM_ID, botConfigOrder(), undefined, live) });
    return true;
  }
  // All teams THIS deployment hosts (default + any created), each with its
  // aggregated roster — the SPA「我的团队」renders one block per team.
  if (path === '/api/team/hosted' && method === 'GET') {
    ensureDefaultTeam(dataDir);
    const me = getDeploymentIdentity(dataDir);
    const suggestedHubUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}`;
    const teams = listTeams(dataDir).map(t => ({
      teamId: t.id, name: t.name, isDefault: t.id === DEFAULT_TEAM_ID,
      // dashboard 团队页发起过的协作群 —— 看板团队筛选的白名单之一
      groupChatIds: listTeamGroups(dataDir, t.id).map(b => b.chatId),
      ...buildFederatedRoster(dataDir, t.id, botConfigOrder(), undefined, live),
    }));
    jsonRes(res, 200, { ok: true, deployment: me, suggestedHubUrl, teams });
    return true;
  }
  if (path === '/api/team/hosted' && method === 'POST') {
    let body: any; try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const name = String(body?.name ?? '').trim();
    if (!name) { jsonRes(res, 400, { ok: false, error: 'name_required' }); return true; }
    if (name.length > 64) { jsonRes(res, 400, { ok: false, error: 'name_too_long' }); return true; }
    if (listTeams(dataDir).length >= 100) { jsonRes(res, 400, { ok: false, error: 'too_many_teams' }); return true; } // guardrail (team-internal trust, not a security boundary)
    const t = createTeam(dataDir, name);
    jsonRes(res, 200, { ok: true, teamId: t.id, name: t.name });
    return true;
  }
  // Remove a member deployment from a team I host (hub kicks a joined spoke).
  if (memberDel && method === 'DELETE') {
    const teamId = decodeURIComponent(memberDel[1]);
    const deploymentId = decodeURIComponent(memberDel[2]);
    if (deploymentId === getDeploymentIdentity(dataDir).deploymentId) { jsonRes(res, 400, { ok: false, error: 'cannot_remove_self' }); return true; }
    const removed = removeDeployment(dataDir, teamId, deploymentId);
    jsonRes(res, removed ? 200 : 404, { ok: removed, ...(removed ? {} : { error: 'member_not_found' }) });
    return true;
  }
  if (hostedDel && method === 'DELETE') {
    const teamId = decodeURIComponent(hostedDel[1]);
    if (teamId === DEFAULT_TEAM_ID) { jsonRes(res, 400, { ok: false, error: 'cannot_delete_default' }); return true; }
    if (!getTeam(dataDir, teamId)) { jsonRes(res, 404, { ok: false, error: 'team_not_found' }); return true; }
    deleteTeam(dataDir, teamId);
    removeTeamFederation(dataDir, teamId); // drop joined spokes' records for this team
    deleteInvitesForTeam(dataDir, teamId); // invalidate its outstanding invites
    jsonRes(res, 200, { ok: true });
    return true;
  }
  // Generate an invite for a hosted team (defaults to the default team).
  if (path === '/api/team/local-invite' && method === 'POST') {
    // Empty body → default team (readBody returns {}); malformed/oversized JSON
    // throws → reject with bad_json (don't silently fall back to default team).
    let body: any; try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    ensureDefaultTeam(dataDir);
    const teamId = String(body?.teamId ?? '').trim() || DEFAULT_TEAM_ID;
    if (!getTeam(dataDir, teamId)) { jsonRes(res, 404, { ok: false, error: 'team_not_found' }); return true; }
    const inv = createInvite(dataDir, teamId, getDeploymentIdentity(dataDir).deploymentId);
    jsonRes(res, 200, { ok: true, code: inv.code, expiresAt: inv.expiresAt, teamId });
    return true;
  }
  if (path === '/api/team/rename-deployment' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const name = String(body?.name ?? '').trim();
    if (!name) { jsonRes(res, 400, { ok: false, error: 'name_required' }); return true; }
    jsonRes(res, 200, { ok: true, deployment: setDeploymentName(dataDir, name) });
    return true;
  }

  // Accept an invite from another deployment's hub: register our bots there.
  if (path === '/api/team/join-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const inviteCode = String(body?.inviteCode ?? '').trim();
    if (!hubUrl) { jsonRes(res, 400, { ok: false, error: 'bad_hub_url' }); return true; }
    if (!inviteCode) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    const me = getDeploymentIdentity(dataDir);
    // Issue a delegationToken to the hub + tell it our callback URL, so the hub
    // can delegate 拉群 back to us (hub→spoke) when it has no local creator.
    const delegationToken = randomBytes(24).toString('base64url');
    const callbackUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}`;
    let hubRes: Response;
    try {
      hubRes = await fetchWithTimeout(fetcher, `${hubUrl}/api/federation/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode, deployment: { deploymentId: me.deploymentId, name: me.name, ownerUnionId: me.ownerUnionId, ownerName: me.ownerName, bots: localBots(dataDir, live), callbackUrl, delegationToken } }),
      });
    } catch (e) {
      const he = hubError(e);
      jsonRes(res, he.status, { ok: false, error: he.error });
      return true;
    }
    const j = await hubRes.json().catch(() => ({} as any));
    if (!hubRes.ok || !j?.ok) {
      const status = [400, 403, 409].includes(hubRes.status) ? hubRes.status : 502;
      jsonRes(res, status, { ok: false, error: j?.error || `hub_${hubRes.status}` });
      return true;
    }
    addMembership(dataDir, { hubUrl, teamId: j.teamId, teamName: j.teamName, syncToken: j.syncToken, deploymentId: me.deploymentId, delegationToken });
    jsonRes(res, 200, { ok: true, hubUrl, teamId: j.teamId, teamName: j.teamName });
    return true;
  }

  // Pull each joined hub's aggregated roster for display (token in header).
  if (path === '/api/team/remote-roster' && method === 'GET') {
    const out: any[] = [];
    for (const m of listMemberships(dataDir)) {
      try {
        const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/roster`, {
          headers: { authorization: `Bearer ${m.syncToken}` },
        });
        const j = await r.json().catch(() => ({} as any));
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: r.ok && j?.ok, roster: j?.ok ? { deployments: j.deployments, bots: j.bots, team: j.team } : null, error: j?.error });
      } catch (e) {
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: false, roster: null, error: hubError(e).error });
      }
    }
    jsonRes(res, 200, { ok: true, memberships: out });
    return true;
  }

  // ── 远程团队看板代理：成员的浏览器 → 本地 dashboard → hub ──────────────────
  // key = `${hubUrl}::${teamId}`（与 membership 存储键、前端团队 key 同构）。
  if (path === '/api/team/remote-board' && method === 'GET') {
    const key = String(url.searchParams.get('key') ?? '');
    const m = listMemberships(dataDir).find(mm => `${mm.hubUrl}::${mm.teamId}` === key);
    if (!m) { jsonRes(res, 404, { ok: false, error: 'membership_not_found' }); return true; }
    try {
      const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/team-board`, {
        headers: { authorization: `Bearer ${m.syncToken}` },
      });
      const j = await r.json().catch(() => ({} as any));
      jsonRes(res, r.ok ? 200 : 502, j);
    } catch (e) {
      jsonRes(res, 502, { ok: false, ...hubError(e) });
    }
    return true;
  }

  if (path === '/api/team/remote-board-move' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const key = String(body?.key ?? '');
    const m = listMemberships(dataDir).find(mm => `${mm.hubUrl}::${mm.teamId}` === key);
    if (!m) { jsonRes(res, 404, { ok: false, error: 'membership_not_found' }); return true; }
    try {
      const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/team-board-move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
        body: JSON.stringify({ sessionId: body?.sessionId, column: body?.column, position: body?.position }),
      });
      const j = await r.json().catch(() => ({} as any));
      jsonRes(res, r.ok ? 200 : 502, j);
    } catch (e) {
      jsonRes(res, 502, { ok: false, ...hubError(e) });
    }
    return true;
  }

  // Manually push bots + heartbeat to all joined hubs.
  if (path === '/api/team/sync-remote' && method === 'POST') {
    const r = await syncAllMemberships(dataDir, fetcher, live);
    jsonRes(res, 200, { ok: true, ...r });
    return true;
  }

  // Leave a remote team: best-effort revoke at the hub (so it drops our
  // deployment + token + stale bots), then forget the membership locally.
  if (path === '/api/team/leave-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const teamId = String(body?.teamId ?? '').trim();
    if (!hubUrl || !teamId) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const m = listMemberships(dataDir).find(x => x.hubUrl === hubUrl && x.teamId === teamId);
    let hubRevoked = false;
    if (m) {
      try {
        const r = await fetchWithTimeout(fetcher, `${hubUrl}/api/federation/leave`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
          body: JSON.stringify({ syncToken: m.syncToken }),
        });
        hubRevoked = r.ok;
      } catch { /* hub unreachable — still forget locally below */ }
    }
    const removed = removeMembership(dataDir, hubUrl, teamId);
    jsonRes(res, removed ? 200 : 404, { ok: removed, hubRevoked });
    return true;
  }

  return false;
}
