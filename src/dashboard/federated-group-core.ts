/**
 * Shared 拉群 orchestration for federation — used by BOTH the local team page
 * (`/api/team/federated-group`, dashboard token) and the hub endpoint a spoke
 * calls (`/api/federation/group`, syncToken). Keeps the create-or-delegate +
 * owner-invite logic in one place so the two entry points can't drift.
 *
 * Invite set (union_id, deduped) = the OPERATOR (whoever initiated; for a spoke
 * request it's the hub-derived spoke owner — NEVER client-supplied) + each
 * selected bot's owner. Bots are added by app_id (see docs/federation-design.md).
 */
import { buildFederatedRoster } from '../services/federation-roster.js';
import { listFederatedDeployments } from '../services/federation-store.js';
import { DEFAULT_TEAM_ID } from '../services/team-store.js';
import { recordTeamGroup } from '../services/team-groups-store.js';
import { logger } from '../utils/logger.js';
import type { LiveBot } from '../services/team-roster.js';

const HUB_TIMEOUT_MS = 8000;

/** Thrown by fetchWithTimeout when a hub/spoke call doesn't answer in time. */
export class HubTimeout extends Error { constructor() { super('hub_timeout'); this.name = 'HubTimeout'; } }

export type Fetcher = typeof fetch;

/** Wrap an outbound call with an abort timeout; surface a distinguishable timeout. */
export async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit = {}, ms = HUB_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError' || e instanceof HubTimeout) throw new HubTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map an outbound call failure to a stable {status, error}. */
export function hubError(e: unknown): { status: number; error: string } {
  return e instanceof HubTimeout ? { status: 504, error: 'hub_timeout' } : { status: 502, error: 'hub_unreachable' };
}

export interface OrchestrateGroupDeps {
  /** Picks a LOCAL online creator + proxies to its daemon (federated bots added by app_id). */
  createTeamGroup: (args: { name: string; larkAppIds: string[]; ownerUnionIds?: string[] }) => Promise<{
    ok: boolean; chatId?: string; shareLink?: string; invalidBotIds?: string[]; invalidOwnerUnionIds?: string[]; error?: string;
  }>;
  fetcher: Fetcher;
  /** Live daemon-registry bots (authoritative local roster source). */
  live?: LiveBot[];
}

export interface OrchestrateGroupArgs {
  name: string;
  larkAppIds: string[];
  /** Hub-derived/local operator union_id (the person who initiated). Undefined ⇒
   *  operator identity not bound (missingOperatorIdentity surfaced). NEVER trust
   *  a client-supplied value — callers derive this from auth. */
  operatorUnionId?: string;
  /** Idempotency key for delegate calls (one per 拉群). */
  requestId: string;
  /** Team whose aggregated roster gates the selection (hub may host non-default teams). */
  teamId?: string;
}

/**
 * Validate selection against the team's aggregated roster, collect invitees
 * (operator + selected bots' owners), then create locally if a local online bot
 * exists, else delegate to a federated deployment that owns a selected bot.
 * Returns a transport-agnostic {status, body}.
 */
export async function orchestrateFederatedGroup(
  dataDir: string,
  args: OrchestrateGroupArgs,
  deps: OrchestrateGroupDeps,
): Promise<{ status: number; body: any }> {
  const { name, larkAppIds, operatorUnionId, requestId } = args;
  const teamId = args.teamId ?? DEFAULT_TEAM_ID;
  if (larkAppIds.length === 0) return { status: 400, body: { ok: false, error: 'no_bots_selected' } };
  const roster = buildFederatedRoster(dataDir, teamId, undefined, undefined, deps.live);
  const byId = new Map(roster.bots.map(b => [b.larkAppId, b]));
  const unknown = larkAppIds.filter(id => !byId.has(id));
  if (unknown.length) return { status: 400, body: { ok: false, error: 'unknown_bot', unknown } };

  // Owner-in-group policy (申晗): a bot should only join if its owner is in the
  // group too (else it's "打黑工" — in a group its owner can't see). A REMOTE bot
  // whose owner is unbound has no owner to pull → skip it. (LOCAL bots are covered
  // by the operator, who is always pulled in.)
  const skippedNoOwner = larkAppIds.filter(id => { const b = byId.get(id); return !!b && !b.deployment.local && !b.owner?.unionId; });
  const eligible = larkAppIds.filter(id => !skippedNoOwner.includes(id));
  if (eligible.length === 0) return { status: 400, body: { ok: false, error: 'all_bots_skipped_no_owner', skippedNoOwner } };

  // Invitees = operator (if bound) + each eligible bot's owner. union_id, deduped.
  const ownerUnionIds = Array.from(new Set([
    ...(operatorUnionId ? [operatorUnionId] : []),
    ...eligible.map(id => byId.get(id)?.owner?.unionId).filter((u): u is string => !!u),
  ]));
  const missingOperatorIdentity = !operatorUnionId;

  const r = await deps.createTeamGroup({ name, larkAppIds: eligible, ownerUnionIds });
  if (r.ok) {
    // The creator bot adds the owners IT can reach; owners outside its app's
    // visibility scope (Lark code 232024 — typically owners of OTHER deployments)
    // come back as invalidOwnerUnionIds. Add each of those via THEIR OWN
    // deployment's bot (which has them in scope) — hub→spoke delegate-add-owner.
    let invalidOwners = r.invalidOwnerUnionIds ?? [];
    if (invalidOwners.length > 0 && r.chatId) {
      invalidOwners = await delegateAddOwners(dataDir, teamId, r.chatId, invalidOwners, eligible, requestId, deps.fetcher);
    }
    // 记录 team↔chatId 绑定 —— 看板团队筛选据此识别「dashboard 发起的协作群」。
    if (r.chatId) recordTeamGroup(dataDir, teamId, String(r.chatId));
    return { status: 200, body: { ...r, invalidOwnerUnionIds: invalidOwners, missingOperatorIdentity, skippedNoOwner } };
  }

  // No local online creator → delegate to a reachable deployment that owns a
  // selected bot (hub→spoke). requestId makes each delegate idempotent.
  if (r.error === 'no_online_daemon') {
    const selected = new Set(eligible);
    let lastErr = 'no_creator_available';
    for (const dep of listFederatedDeployments(dataDir, teamId)) {
      if (!dep.callbackUrl || !dep.delegationToken) continue;
      if (!dep.bots.some(b => selected.has(b.larkAppId))) continue;
      try {
        const dr = await fetchWithTimeout(deps.fetcher, `${dep.callbackUrl}/api/federation/delegate-group`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${dep.delegationToken}` },
          body: JSON.stringify({ name, larkAppIds: eligible, ownerUnionIds, requestId }),
        });
        const dj = await dr.json().catch(() => ({} as any));
        if (dr.ok && dj?.ok && dj.chatId) {
          // The delegate creator added the owners IT could; owners it couldn't
          // reach (e.g. a THIRD deployment's owner) must still be added via their
          // own deployment — same post-create delegation as the local-create path.
          let invalidOwners = dj.invalidOwnerUnionIds ?? [];
          if (invalidOwners.length > 0) {
            invalidOwners = await delegateAddOwners(dataDir, teamId, dj.chatId, invalidOwners, eligible, requestId, deps.fetcher);
          }
          recordTeamGroup(dataDir, teamId, String(dj.chatId));
          return { status: 200, body: { ...dj, invalidOwnerUnionIds: invalidOwners, delegatedTo: dep.name, missingOperatorIdentity, skippedNoOwner } };
        }
        lastErr = dj?.error || `hub_${dr.status}`;
      } catch (e) {
        // Timeout ⇒ the delegate MAY have created the group (lost response). Stop —
        // trying another deployment would risk a duplicate.
        if (e instanceof HubTimeout) return { status: 504, body: { ok: false, error: 'delegation_timeout', delegatedTo: dep.name } };
        lastErr = 'hub_unreachable'; // never connected → safe to try next
      }
    }
    return { status: 502, body: { ok: false, error: lastErr } };
  }
  return { status: 502, body: r };
}

/**
 * For owners the creator couldn't add (out of its app scope), delegate the add
 * to each owner's OWN deployment: that deployment has a selected bot already in
 * the chat (`via`) and the owner in its app's visibility scope. Returns the
 * owners still not added after delegation.
 */
async function delegateAddOwners(
  dataDir: string, teamId: string, chatId: string,
  owners: string[], selectedAppIds: string[], requestId: string, fetcher: Fetcher,
): Promise<string[]> {
  const selected = new Set(selectedAppIds);
  const stillInvalid = new Set(owners);
  for (const dep of listFederatedDeployments(dataDir, teamId)) {
    if (!dep.callbackUrl || !dep.delegationToken) continue;
    // Offer EVERY bot of this dep already in the chat as a via candidate, not just
    // the first: a single bot may lack write scope (99991672) or owner visibility
    // (232024) and strand the owner. The spoke falls through them until one lands.
    const viaCandidates = dep.bots.filter(b => selected.has(b.larkAppId)).map(b => b.larkAppId);
    if (viaCandidates.length === 0) continue;
    const via = viaCandidates[0]; // first one doubles as viaLarkAppId for old-spoke back-compat
    const mine = owners.filter(u => dep.ownerUnionId === u || dep.bots.some(b => b.ownerUnionId === u));
    if (mine.length === 0) continue;
    try {
      logger.info(`[federation] delegate-add-owner → ${dep.name} (${dep.callbackUrl}) via=${via} cands=${viaCandidates.length} owners=${mine.length}`);
      const dr = await fetchWithTimeout(fetcher, `${dep.callbackUrl}/api/federation/delegate-add-owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${dep.delegationToken}` },
        body: JSON.stringify({ chatId, ownerUnionIds: mine, viaLarkAppId: via, viaCandidates, requestId }),
      });
      const dj = await dr.json().catch(() => ({} as any));
      logger.info(`[federation] delegate-add-owner ← ${dep.name}: status=${dr.status} ok=${dj?.ok} invalid=${JSON.stringify(dj?.invalidUserIds ?? 'all')}`);
      if (dr.ok && dj?.ok) {
        const inv = new Set<string>(dj.invalidUserIds ?? mine);
        for (const u of mine) if (!inv.has(u)) stillInvalid.delete(u);
      }
    } catch (e: any) {
      logger.warn(`[federation] delegate-add-owner threw for ${dep.name} (${dep.callbackUrl}): ${e?.message ?? e}`);
    }
  }
  if (stillInvalid.size) logger.warn(`[federation] delegateAddOwners: ${stillInvalid.size} owner(s) still not added: ${[...stillInvalid].join(',')}`);
  return [...stillInvalid];
}
