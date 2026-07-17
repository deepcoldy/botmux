/**
 * Federation HUB endpoints. Cross-deployment, so mounted BEFORE the dashboard's
 * `?t=` token gate (like webhook/team routes) — they authenticate by their OWN
 * credentials instead:
 *   - POST /api/federation/join   → an invite code (single-use admission)
 *   - POST /api/federation/sync   → a syncToken (per-deployment bearer)
 *   - GET  /api/federation/roster → a syncToken
 *
 * A spoke deployment registers once with an invite, gets a long-lived syncToken,
 * then pushes bots + pulls the aggregated roster with it. See docs/federation-design.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { jsonRes } from './http.js';
import { consumeInvite } from '../services/invite-store.js';
import { getTeam } from '../services/team-store.js';
import {
  registerDeployment, syncDeployment, getDeploymentByToken, removeDeploymentByToken,
  type FederatedBot,
} from '../services/federation-store.js';
import { buildFederatedRoster } from '../services/federation-roster.js';
import { listTeamGroups } from '../services/team-groups-store.js';
import {
  listTeamReports,
  readTeamBoard,
  recordTeamSessions,
  sanitizeReportedSessions,
  setTeamBoardEntry,
} from '../services/team-board-store.js';
import { findMembershipByDelegationToken } from '../services/federation-membership-store.js';
import { buildTeamRoster, type LiveBot } from '../services/team-roster.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import {
  orchestrateFederatedGroup,
  type Fetcher,
  type TeamGroupCreateResult,
  type TeamGroupOwnerTransferResult,
} from './federated-group-core.js';
import { addUsersToChatByUnionId } from '../services/groups-store.js';
import { loadBotConfigs, registerBot, getBot } from '../bot-registry.js';

/** Ensure a Lark client exists for larkAppId in THIS (dashboard) process, which
 *  has no bot registry — register on demand from bots.json (carries the secret).
 *  Used by delegate-add-owner so it can add a user via a specific local bot. */
function ensureLocalClient(larkAppId: string): boolean {
  try { getBot(larkAppId); return true; } catch { /* not registered yet */ }
  try {
    const cfg = loadBotConfigs().find(c => c.larkAppId === larkAppId);
    if (!cfg) return false;
    registerBot(cfg);
    return true;
  } catch { return false; }
}

const MAX_BOTS = 200;
const MAX_OWNERS = 100;

/** Short-TTL idempotency cache for delegate-group: a hub may retry the SAME
 *  request (timeout/lost response) — replaying must return the first result, not
 *  create a duplicate group. Keyed by delegationToken+requestId. In-memory is
 *  enough (single dashboard process; the dedup window is seconds–minutes). */
const DELEGATE_IDEM_TTL_MS = 10 * 60 * 1000;
const delegateIdem = new Map<string, { expiresAt: number; result: unknown }>();
function idemGet(key: string): unknown | null {
  const e = delegateIdem.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { delegateIdem.delete(key); return null; }
  return e.result;
}
function idemSet(key: string, result: unknown): void {
  const now = Date.now();
  for (const [k, v] of delegateIdem) if (v.expiresAt <= now) delegateIdem.delete(k); // opportunistic prune
  delegateIdem.set(key, { expiresAt: now + DELEGATE_IDEM_TTL_MS, result });
}

/** Federation bearer token: prefer the header (keeps the long-lived syncToken out
 *  of URLs / access logs); fall back to ?syncToken= for short-term hub compat. */
function federationToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-botmux-federation-token'];
  if (typeof x === 'string' && x) return x.trim();
  return (url.searchParams.get('syncToken') ?? '').trim();
}

/** Header-only bearer for pre-auth WRITE endpoints (group create): the token must
 *  never come from URL/body — keep it out of access logs and off replayable surfaces.
 *  Unlike federationToken() there is NO ?syncToken= / body fallback here. */
function bearerOnly(req: IncomingMessage): string {
  const auth = req.headers['authorization'];
  return (typeof auth === 'string' && auth.startsWith('Bearer ')) ? auth.slice(7).trim() : '';
}

async function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
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

/** Defensive: only keep the fields we expect, cap the count, coerce types. */
function sanitizeBots(input: unknown): FederatedBot[] {
  if (!Array.isArray(input)) return [];
  const out: FederatedBot[] = [];
  for (const raw of input.slice(0, MAX_BOTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.larkAppId !== 'string' || !r.larkAppId) continue;
    out.push({
      larkAppId: r.larkAppId,
      botName: typeof r.botName === 'string' ? r.botName : r.larkAppId,
      cliId: typeof r.cliId === 'string' ? r.cliId : '',
      botUnionId: typeof r.botUnionId === 'string' ? r.botUnionId : undefined,
      capability: typeof r.capability === 'string' ? r.capability : null,
      hasTeamRole: !!r.hasTeamRole,
      ownerUnionId: typeof r.ownerUnionId === 'string' ? r.ownerUnionId : undefined,
      ownerName: typeof r.ownerName === 'string' ? r.ownerName : undefined,
    });
  }
  return out;
}

export interface FederationApiDeps {
  dataDir?: string;
  fetcher?: Fetcher;
  /** Live daemon-registry bots (authoritative over bots-info.json) for the
   *  delegate-group local-bot guard. */
  liveBots?: () => LiveBot[];
  /** Injected by dashboard.ts — used when a HUB delegates 拉群 to THIS spoke
   *  (we create the chat with one of OUR local online bots as creator). */
  createTeamGroup?: (args: { name: string; larkAppIds: string[]; ownerUnionIds?: string[]; transferOwnerUnionId?: string }) => Promise<TeamGroupCreateResult>;
  /** Complete a pending transfer through the daemon that originally created
   *  the chat. Used locally and by delegate-transfer-owner. */
  transferTeamGroupOwner?: (args: {
    creatorLarkAppId: string;
    chatId: string;
    transferOwnerUnionId: string;
  }) => Promise<TeamGroupOwnerTransferResult>;
  /** Add owners to an existing chat via one of OUR local bots (defaults to
   *  ensure-client + addUsersToChatByUnionId). Test seam. Returns the rejected ids. */
  addOwners?: (viaLarkAppId: string, chatId: string, ownerUnionIds: string[]) => Promise<{ invalidUserIds: string[] }>;
}

export async function handleFederationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FederationApiDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/federation/')) return false;
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const method = req.method ?? 'GET';

  // Spoke registers via an invite → issued a syncToken bound to the team.
  if (path === '/api/federation/join' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const inviteCode = String(body?.inviteCode ?? '').trim();
    const dep = body?.deployment;
    if (!inviteCode) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    if (!dep || typeof dep.deploymentId !== 'string' || !dep.deploymentId) {
      jsonRes(res, 400, { ok: false, error: 'deployment_required' }); return true;
    }
    // Self-join is meaningless (a deployment federating with itself) — reject
    // clearly before consuming the invite, so the spoke can surface it.
    if (dep.deploymentId === getDeploymentIdentity(dataDir).deploymentId) {
      jsonRes(res, 400, { ok: false, error: 'cannot_join_self' }); return true;
    }
    const inv = consumeInvite(dataDir, inviteCode);
    if (!inv.ok) { jsonRes(res, 403, { ok: false, error: `invite_${inv.reason}` }); return true; }
    const team = getTeam(dataDir, inv.teamId);
    if (!team) { jsonRes(res, 403, { ok: false, error: 'invite_team_deleted' }); return true; }
    const reg = registerDeployment(dataDir, inv.teamId, {
      deploymentId: dep.deploymentId,
      name: typeof dep.name === 'string' && dep.name ? dep.name : dep.deploymentId,
      bots: sanitizeBots(dep.bots),
      ownerUnionId: typeof dep.ownerUnionId === 'string' ? dep.ownerUnionId : undefined,
      ownerName: typeof dep.ownerName === 'string' ? dep.ownerName : undefined,
      callbackUrl: typeof dep.callbackUrl === 'string' && /^https?:\/\//i.test(dep.callbackUrl) ? dep.callbackUrl.replace(/\/+$/, '') : undefined,
      delegationToken: typeof dep.delegationToken === 'string' ? dep.delegationToken : undefined,
    });
    // deploymentId is public (shows in roster) — never hand back an existing
    // deployment's long-lived token. A duplicate must re-bind via an explicit
    // reset proving the old token (future), not by re-joining with an invite.
    if (!reg.created) { jsonRes(res, 409, { ok: false, error: 'deployment_already_joined' }); return true; }
    jsonRes(res, 200, { ok: true, teamId: inv.teamId, teamName: team.name, syncToken: reg.syncToken });
    return true;
  }

  // Spoke-initiated leave/revoke: drop this deployment from its team (authed by
  // its own syncToken). Idempotent — unknown token is treated as already gone.
  if (path === '/api/federation/leave' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const syncToken = String(body?.syncToken ?? '').trim() || federationToken(req, url);
    if (!syncToken) { jsonRes(res, 401, { ok: false, error: 'token_required' }); return true; }
    removeDeploymentByToken(dataDir, syncToken);
    jsonRes(res, 200, { ok: true });
    return true;
  }

  // Spoke pushes its current bots + heartbeat.
  if (path === '/api/federation/sync' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const syncToken = String(body?.syncToken ?? '').trim();
    if (!syncToken) { jsonRes(res, 401, { ok: false, error: 'token_required' }); return true; }
    const ok = syncDeployment(dataDir, syncToken, sanitizeBots(body?.bots), {
      ownerUnionId: typeof body?.ownerUnionId === 'string' ? body.ownerUnionId : undefined,
      ownerName: typeof body?.ownerName === 'string' ? body.ownerName : undefined,
      name: typeof body?.name === 'string' ? body.name : undefined,
    });
    if (!ok) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    // 顺带下发该团队的协作群清单——spoke 据此筛出要上报给团队看板的会话。
    const synced = getDeploymentByToken(dataDir, syncToken);
    jsonRes(res, 200, {
      ok: true,
      groupChatIds: synced ? listTeamGroups(dataDir, synced.teamId).map(b => b.chatId) : [],
    });
    return true;
  }

  // ── 团队看板（既定架构：编排存 host，会话源数据各部署自持）────────────────
  // 成员上报会话裁剪行：白名单清洗后按 deploymentId 覆盖式落盘。
  if (path === '/api/federation/team-sessions' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const found = getDeploymentByToken(dataDir, bearerOnly(req));
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const sessions = sanitizeReportedSessions(body?.sessions);
    recordTeamSessions(dataDir, found.teamId, found.deployment.deploymentId, found.deployment.name, sessions);
    jsonRes(res, 200, { ok: true, accepted: sessions.length });
    return true;
  }

  // 成员拉取团队看板：共享编排 + 各部署最近一次上报（含调用方自己的，
  // 前端按 deploymentId 去掉自己那份，本地数据走实时 store）。
  if (path === '/api/federation/team-board' && method === 'GET') {
    const found = getDeploymentByToken(dataDir, federationToken(req, url));
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    jsonRes(res, 200, {
      ok: true,
      teamId: found.teamId,
      deploymentId: found.deployment.deploymentId,
      board: readTeamBoard(dataDir, found.teamId),
      reports: listTeamReports(dataDir, found.teamId),
      groupChatIds: listTeamGroups(dataDir, found.teamId).map(b => b.chatId),
    });
    return true;
  }

  // 成员拖拽团队看板卡片：编排是全团队共享的一份，谁拖都写 host 这里。
  if (path === '/api/federation/team-board-move' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const found = getDeploymentByToken(dataDir, bearerOnly(req));
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const entry = setTeamBoardEntry(dataDir, found.teamId, String(body?.sessionId ?? ''), body?.column, body?.position);
    if (!entry) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    jsonRes(res, 200, { ok: true, entry });
    return true;
  }

  // Spoke pulls the aggregated cross-deployment roster for its team. Hub's own
  // local bots come from the live registry (liveBots) so an empty bots-info.json
  // doesn't hide them from the roster spokes see.
  if (path === '/api/federation/roster' && method === 'GET') {
    const found = getDeploymentByToken(dataDir, federationToken(req, url));
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    jsonRes(res, 200, { ok: true, ...buildFederatedRoster(dataDir, found.teamId, undefined, undefined, deps.liveBots?.()) });
    return true;
  }

  // Spoke initiates 拉群 on the team it joined; the HUB orchestrates (local
  // creator or delegate). Authed by the spoke's syncToken (team-internal trust).
  // operator = the calling spoke's owner, DERIVED FROM THE TOKEN (never the body).
  if (path === '/api/federation/group' && method === 'POST') {
    if (!deps.createTeamGroup) { jsonRes(res, 501, { ok: false, error: 'group_create_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const token = bearerOnly(req); // header-only: a write endpoint must not take the token from URL/body
    const found = getDeploymentByToken(dataDir, token);
    if (!found) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const requestId = String(body?.requestId ?? '').trim();
    if (!requestId) { jsonRes(res, 400, { ok: false, error: 'request_id_required' }); return true; }
    const larkAppIds: string[] = Array.isArray(body?.larkAppIds) ? body.larkAppIds.filter((x: any) => typeof x === 'string') : [];
    const name = String(body?.name ?? '').trim() || '协作群';
    // Idempotency: replay of the same {syncToken, requestId} returns the FIRST
    // terminal result verbatim — including failures (delegation_timeout /
    // group_create_proxy_failed) which may already have side-effected. A genuine
    // retry must use a fresh requestId; replaying must never re-orchestrate.
    const idemKey = `group:${token}:${requestId}`;
    const cached = idemGet(idemKey) as { status: number; body: any } | undefined;
    if (cached) { jsonRes(res, cached.status, cached.body); return true; }
    const out = await orchestrateFederatedGroup(dataDir,
      { name, larkAppIds, operatorUnionId: found.deployment.ownerUnionId, requestId, teamId: found.teamId },
      {
        createTeamGroup: deps.createTeamGroup,
        transferTeamGroupOwner: deps.transferTeamGroupOwner,
        fetcher: deps.fetcher ?? fetch,
        live: deps.liveBots?.(),
      });
    idemSet(idemKey, { status: out.status, body: out.body });
    jsonRes(res, out.status, out.body);
    return true;
  }

  // Hub delegates 拉群 to THIS spoke (hub→spoke): the hub had no local online
  // creator, so it asks the deployment that owns a selected bot to create the
  // group with ITS own online bot. Authed by the delegationToken THIS spoke
  // issued to that hub at join (team-internal trust).
  if (path === '/api/federation/delegate-group' && method === 'POST') {
    if (!deps.createTeamGroup) { jsonRes(res, 501, { ok: false, error: 'group_create_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const token = bearerOnly(req); // header-only: same pre-auth write semantics as /group (never URL/body)
    if (!findMembershipByDelegationToken(dataDir, token)) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const requestId = String(body?.requestId ?? '').trim();
    if (!requestId) { jsonRes(res, 400, { ok: false, error: 'request_id_required' }); return true; }
    // Idempotency: replay of {token, requestId} returns the FIRST terminal result
    // verbatim — including failures (createTeamGroup may have side-effected). A
    // genuine retry must use a fresh requestId; replaying never re-creates.
    const idemKey = `delegate:${token}:${requestId}`;
    const cached = idemGet(idemKey) as { status: number; body: any } | undefined;
    if (cached) { jsonRes(res, cached.status, cached.body); return true; }
    // Dedup + cap inputs (pre-auth command endpoint — keep blast radius small).
    const larkAppIds: string[] = Array.from(new Set((Array.isArray(body?.larkAppIds) ? body.larkAppIds : []).filter((x: any) => typeof x === 'string')));
    const ownerUnionIds: string[] = Array.from(new Set((Array.isArray(body?.ownerUnionIds) ? body.ownerUnionIds : []).filter((x: any) => typeof x === 'string')));
    const transferOwnerUnionId = typeof body?.transferOwnerUnionId === 'string'
      ? body.transferOwnerUnionId.trim()
      : '';
    const name = (String(body?.name ?? '').trim()) || '协作群';
    if (larkAppIds.length === 0) { jsonRes(res, 400, { ok: false, error: 'no_bots_selected' }); return true; }
    if (larkAppIds.length > MAX_BOTS || ownerUnionIds.length > MAX_OWNERS) { jsonRes(res, 400, { ok: false, error: 'too_many' }); return true; }
    if (body?.transferOwnerUnionId !== undefined
      && (!transferOwnerUnionId.startsWith('on_') || !ownerUnionIds.includes(transferOwnerUnionId))) {
      jsonRes(res, 400, { ok: false, error: 'invalid_transfer_owner_union_id' }); return true;
    }
    // Guardrail: the delegation must involve at least one of OUR local bots
    // (otherwise it's unrelated to this deployment — refuse to act as creator).
    const localIds = new Set(buildTeamRoster(dataDir, undefined, undefined, deps.liveBots?.()).bots.map(b => b.larkAppId));
    if (!larkAppIds.some(id => localIds.has(id))) { jsonRes(res, 400, { ok: false, error: 'no_local_bot' }); return true; }
    const r = await deps.createTeamGroup({
      name,
      larkAppIds,
      ownerUnionIds,
      transferOwnerUnionId: transferOwnerUnionId || undefined,
    });
    if (r.ok
      && r.chatId
      && r.creator
      && transferOwnerUnionId
      && r.invalidOwnerUnionIds?.includes(transferOwnerUnionId)) {
      // Mint a short-lived capability bound to THIS authenticated delegate
      // request. The hub can trigger it only after the owner's deployment has
      // successfully added the operator; it cannot substitute chat/creator/id.
      idemSet(`delegate-transfer-pending:${token}:${requestId}`, {
        creatorLarkAppId: r.creator,
        chatId: r.chatId,
        transferOwnerUnionId,
      });
    }
    const result = { status: r.ok ? 200 : 502, body: r };
    idemSet(idemKey, result); // cache terminal result (success AND failure)
    jsonRes(res, result.status, result.body);
    return true;
  }

  // Hub finishes a deferred transfer on THIS creator deployment after the
  // target's own deployment has successfully added them to the chat. The only
  // client input is requestId; target/chat/creator come from the authenticated
  // delegate-group result cached above, closing the confused-deputy gap.
  if (path === '/api/federation/delegate-transfer-owner' && method === 'POST') {
    if (!deps.transferTeamGroupOwner) { jsonRes(res, 501, { ok: false, error: 'owner_transfer_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const token = bearerOnly(req);
    if (!findMembershipByDelegationToken(dataDir, token)) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const requestId = String(body?.requestId ?? '').trim();
    if (!requestId) { jsonRes(res, 400, { ok: false, error: 'request_id_required' }); return true; }
    const resultKey = `delegate-transfer-result:${token}:${requestId}`;
    const cached = idemGet(resultKey) as { status: number; body: any } | undefined;
    if (cached) { jsonRes(res, cached.status, cached.body); return true; }
    const pending = idemGet(`delegate-transfer-pending:${token}:${requestId}`) as {
      creatorLarkAppId: string;
      chatId: string;
      transferOwnerUnionId: string;
    } | undefined;
    if (!pending) { jsonRes(res, 409, { ok: false, error: 'owner_transfer_not_pending' }); return true; }

    const transferred = await deps.transferTeamGroupOwner(pending);
    const result = { status: 200, body: { ok: true, ...transferred } };
    // Successful transfer is idempotent and may have sent an @ notification;
    // cache it to suppress duplicate notifications. Failures remain retryable.
    if (transferred.ownerTransferredTo && !transferred.transferError) idemSet(resultKey, result);
    jsonRes(res, result.status, result.body);
    return true;
  }

  // Hub asks THIS spoke to add ITS OWN owner(s) to an existing chat (hub→spoke):
  // the hub's creator bot can't add users outside its app's visibility scope
  // (Lark code 232024), but THIS deployment's bot has its owner in scope. We add
  // via `viaLarkAppId` — one of our bots that's already a member of the chat.
  // Authed by the delegationToken THIS spoke issued (team-internal trust).
  if (path === '/api/federation/delegate-add-owner' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const token = bearerOnly(req);
    if (!findMembershipByDelegationToken(dataDir, token)) { jsonRes(res, 403, { ok: false, error: 'unknown_token' }); return true; }
    const requestId = String(body?.requestId ?? '').trim();
    if (!requestId) { jsonRes(res, 400, { ok: false, error: 'request_id_required' }); return true; }
    const idemKey = `add-owner:${token}:${requestId}`;
    const cached = idemGet(idemKey) as { status: number; body: any } | undefined;
    if (cached) { jsonRes(res, cached.status, cached.body); return true; }
    const chatId = String(body?.chatId ?? '').trim();
    const viaLarkAppId = String(body?.viaLarkAppId ?? '').trim();
    // Via-bot candidates to try IN ORDER. The hub sends every bot of THIS
    // deployment that's already a member of the chat; we fall through them so a
    // bot lacking im:chat.members:write_only (99991672) or owner visibility
    // (232024) doesn't strand the owner — another of our bots can still add them.
    // Back-compat: older hubs send only viaLarkAppId.
    const rawCandidates: unknown[] = Array.isArray(body?.viaCandidates) ? body.viaCandidates : [];
    const viaCandidates: string[] = Array.from(new Set(
      [viaLarkAppId, ...rawCandidates.filter((x): x is string => typeof x === 'string')].map(s => s.trim()).filter(Boolean),
    ));
    const rawOwners: unknown[] = Array.isArray(body?.ownerUnionIds) ? body.ownerUnionIds : [];
    const ownerUnionIds: string[] = Array.from(new Set(rawOwners.filter((x): x is string => typeof x === 'string')));
    if (!chatId || ownerUnionIds.length === 0) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    if (ownerUnionIds.length > MAX_OWNERS) { jsonRes(res, 400, { ok: false, error: 'too_many' }); return true; }
    const roster = buildTeamRoster(dataDir, undefined, undefined, deps.liveBots?.());
    // Guardrail: viaLarkAppId must be one of OUR local bots.
    if (!roster.bots.some(b => b.larkAppId === viaLarkAppId)) { jsonRes(res, 400, { ok: false, error: 'not_a_local_bot' }); return true; }
    // Drop any candidate that isn't one of OUR local bots (the hub may list bots
    // we no longer host); viaLarkAppId itself is guaranteed present by the check above.
    const localCandidates = viaCandidates.filter(via => roster.bots.some(b => b.larkAppId === via));
    // Capability limit: only add people who are OUR owners (this deployment's owner
    // or a local bot's owner). A delegationToken holder must NOT use our bot to pull
    // arbitrary in-scope users into arbitrary chats. Non-owners → invalid, no Lark call.
    const me = getDeploymentIdentity(dataDir);
    const allowedOwners = new Set<string>([me.ownerUnionId, ...roster.bots.map(b => b.owner?.unionId)].filter((x): x is string => !!x));
    const toAdd = ownerUnionIds.filter(u => allowedOwners.has(u));
    const notOurs = ownerUnionIds.filter(u => !allowedOwners.has(u));
    const addOwners = deps.addOwners ?? (async (via: string, chat: string, ids: string[]) => {
      if (!ensureLocalClient(via)) return { invalidUserIds: ids };
      return addUsersToChatByUnionId(via, chat, ids);
    });
    // Try each local candidate in turn, narrowing to the owners still not added.
    // Stop as soon as everyone landed; a bot that can't add them (no write scope
    // / no visibility) just leaves them in `remaining` for the next candidate.
    let remaining = [...toAdd];
    for (const via of localCandidates) {
      if (remaining.length === 0) break;
      const ar = await addOwners(via, chatId, remaining);
      const invalid = new Set(ar.invalidUserIds);
      remaining = remaining.filter(u => invalid.has(u));
    }
    const result = { status: 200, body: { ok: true, invalidUserIds: [...notOurs, ...remaining] } };
    idemSet(idemKey, result);
    jsonRes(res, result.status, result.body);
    return true;
  }

  jsonRes(res, 404, { ok: false, error: 'not_found' });
  return true;
}
