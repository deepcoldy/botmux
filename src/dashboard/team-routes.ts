/**
 * Team platform routes: pairing-login + authenticated team read APIs.
 *
 * Mounted BEFORE the personal-dashboard shared-token gate (like the webhook
 * route), because the team platform is a SEPARATE surface with its OWN auth:
 * a per-user Feishu identity → `bmx_session` cookie (via pairing-login). The
 * personal dashboard's `?t=` token gate is left untouched.
 *
 * Returns true if it handled the request, false to let the dashboard continue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { jsonRes } from './workflow-api.js';
import { pairingStart, pairingStatusView, pairingConsume, PAIR_COOKIE, SESSION_COOKIE } from './pairing-api.js';
import { getWebSession, revokeWebSession, updateSessionTeam, type WebSession } from '../services/web-session-store.js';
import { buildTeamRoster } from '../services/team-roster.js';
import { getTeam, removeMember, isMember, listTeams, listTeamsForMember, createTeam, addMember, deleteTeam } from '../services/team-store.js';
import { loadBotConfigs } from '../bot-registry.js';
import { createInvite, consumeInvite, deleteInvitesForTeam } from '../services/invite-store.js';
import { setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import { setBotOwner, clearBotOwner } from '../services/bot-owner-store.js';
import { listConnectors } from '../services/connector-store.js';
import { handleConnectorApi } from './connector-api.js';
import { listTriggerLogs, summarizeTriggerLogs, type TriggerLogListOptions } from '../services/trigger-log-store.js';
import { TEAM_PAGE_HTML } from './team-page.js';

const MAX_ROLE_BYTES = 4 * 1024;
/** Guardrails against accidental/scripted bloat of teams.json (team内互信，非安全边界). */
const MAX_TEAMS = 100;
const MAX_TEAM_NAME = 64;
/** Write/delete a bot's team-level role file directly under dataDir (matches
 *  role-resolver's `{dataDir}/team-roles/{larkAppId}.md`; kept dataDir-based so
 *  the dashboard process and tests don't depend on role-resolver's config read). */
function setTeamRoleFile(dataDir: string, larkAppId: string, content: string): void {
  const fp = join(dataDir, 'team-roles', `${larkAppId}.md`);
  mkdirSync(dirname(fp), { recursive: true });
  let out = content.trim();
  while (Buffer.byteLength(out, 'utf-8') > MAX_ROLE_BYTES) out = out.slice(0, -1);
  writeFileSync(fp, out, 'utf-8');
}
function deleteTeamRoleFile(dataDir: string, larkAppId: string): void {
  try { unlinkSync(join(dataDir, 'team-roles', `${larkAppId}.md`)); } catch { /* already gone */ }
}

export interface TeamRouteDeps {
  dataDir?: string;
  /** Injected by dashboard.ts (needs daemon proxy + creator selection). */
  createTeamGroup?: (args: { name: string; larkAppIds: string[]; userOpenId?: string; preferredCreator?: string }) => Promise<{
    ok: boolean; chatId?: string; invalidBotIds?: string[]; invalidUserIds?: string[]; error?: string; autoInviteUnavailable?: boolean;
  }>;
}

/** bots.json (config) order of larkAppIds, so the team roster matches the
 *  personal dashboard's ordering. Guarded: falls back to [] (bots-info order)
 *  if no config is resolvable (e.g. tests with only a temp dataDir). */
function botConfigOrder(): string[] {
  try { return loadBotConfigs().map(b => b.larkAppId); } catch { return []; }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookieHeader(res: ServerResponse, name: string, value: string, maxAgeMs: number): void {
  const maxAge = Math.floor(maxAgeMs / 1000);
  const attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  const existing = res.getHeader('set-cookie');
  const cookie = `${name}=${encodeURIComponent(value)}; ${attrs}`;
  if (Array.isArray(existing)) res.setHeader('set-cookie', [...existing, cookie]);
  else if (typeof existing === 'string') res.setHeader('set-cookie', [existing, cookie]);
  else res.setHeader('set-cookie', cookie);
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
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

export async function handleTeamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: TeamRouteDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/team' && path !== '/api/team' && !path.startsWith('/api/pairing/') && !path.startsWith('/api/team/')) return false;

  const dataDir = deps.dataDir ?? config.session.dataDir;
  const method = req.method ?? 'GET';

  // Team platform SPA (public page; self-authenticates via the pairing flow).
  if (path === '/team' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEAM_PAGE_HTML);
    return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  const sessionOf = (): WebSession | null => getWebSession(dataDir, cookies[SESSION_COOKIE] ?? '');

  // ── Pairing-login (public, pre-auth) ──────────────────────────────────────
  if (path === '/api/pairing/start' && method === 'POST') {
    const r = pairingStart(dataDir);
    if (r.cookie) setCookieHeader(res, r.cookie.name, r.cookie.value, r.cookie.maxAgeMs);
    jsonRes(res, r.status, r.body);
    return true;
  }
  if (path === '/api/pairing/status' && method === 'GET') {
    const r = pairingStatusView(dataDir, url.searchParams.get('pairingId') ?? '', cookies[PAIR_COOKIE] ?? '');
    jsonRes(res, r.status, r.body);
    return true;
  }
  if (path === '/api/pairing/consume' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, reason: 'bad_json' }); return true; }
    const r = pairingConsume(dataDir, String(body?.pairingId ?? ''), cookies[PAIR_COOKIE] ?? '', undefined, body?.inviteCode ? String(body.inviteCode) : undefined);
    if (r.cookie) setCookieHeader(res, r.cookie.name, r.cookie.value, r.cookie.maxAgeMs);
    jsonRes(res, r.status, r.body);
    return true;
  }

  // ── Authenticated team APIs (require bmx_session) ─────────────────────────
  if (path === '/api/team/logout' && method === 'POST') {
    if (cookies[SESSION_COOKIE]) revokeWebSession(dataDir, cookies[SESSION_COOKIE]);
    setCookieHeader(res, SESSION_COOKIE, '', 0);
    jsonRes(res, 200, { ok: true });
    return true;
  }

  const session = sessionOf();
  if (!session) { jsonRes(res, 401, { ok: false, error: 'not_authenticated' }); return true; }
  const identity = { unionId: session.identity.unionId, openId: session.identity.openId };
  const sessionToken = cookies[SESSION_COOKIE] ?? '';

  // ── Account-level APIs ────────────────────────────────────────────────────
  // These are NOT gated on the session's *current* active-team membership: a
  // user removed from their active team but still in others must be able to see
  // and switch to those teams. Each enforces its own target authorization.
  if (path === '/api/team/me' && method === 'GET') {
    const teams = listTeamsForMember(dataDir, identity).map(t => ({ id: t.id, name: t.name, memberCount: t.members.length }));
    // currentTeamValid=false means the session's active team no longer includes
    // the user (kicked); the UI hops to another team or shows the no-team state.
    jsonRes(res, 200, { ok: true, user: session.identity, teamId: session.teamId, teamName: getTeam(dataDir, session.teamId)?.name, currentTeamValid: isMember(dataDir, session.teamId, identity), teams });
    return true;
  }
  // Switch the session's active team — only the TARGET's membership matters.
  if (path === '/api/team/switch' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const teamId = String(body?.teamId ?? '');
    if (!isMember(dataDir, teamId, identity)) { jsonRes(res, 403, { ok: false, error: 'not_a_member' }); return true; }
    if (!updateSessionTeam(dataDir, sessionToken, teamId)) { jsonRes(res, 409, { ok: false, error: 'session_invalid' }); return true; }
    jsonRes(res, 200, { ok: true, teamId });
    return true;
  }
  // Create a new team; the creator joins it and the session switches to it.
  if (path === '/api/team/create' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const name = String(body?.name ?? '').trim();
    if (!name) { jsonRes(res, 400, { ok: false, error: 'name_required' }); return true; }
    if (name.length > MAX_TEAM_NAME) { jsonRes(res, 400, { ok: false, error: 'name_too_long' }); return true; }
    if (listTeams(dataDir).length >= MAX_TEAMS) { jsonRes(res, 400, { ok: false, error: 'team_limit_reached' }); return true; }
    const team = createTeam(dataDir, name);
    addMember(dataDir, team.id, { ...identity, name: session.identity.name });
    if (!updateSessionTeam(dataDir, sessionToken, team.id)) { jsonRes(res, 409, { ok: false, error: 'session_invalid' }); return true; }
    jsonRes(res, 200, { ok: true, teamId: team.id, name: team.name });
    return true;
  }
  // Join another team via a single-use invite code; the session switches to it.
  // Authorization is the bearer invite (single-use), not current-team membership.
  if (path === '/api/team/join' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const code = String(body?.code ?? '').trim();
    if (!code) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    const inv = consumeInvite(dataDir, code);
    if (!inv.ok) { jsonRes(res, 403, { ok: false, error: `invite_${inv.reason}` }); return true; }
    // The team may have been deleted after this invite was minted — don't join /
    // switch into a non-existent team (also catches any pre-cleanup stale invite).
    if (!getTeam(dataDir, inv.teamId)) { jsonRes(res, 403, { ok: false, error: 'invite_team_deleted' }); return true; }
    addMember(dataDir, inv.teamId, { ...identity, name: session.identity.name });
    if (!updateSessionTeam(dataDir, sessionToken, inv.teamId)) { jsonRes(res, 409, { ok: false, error: 'session_invalid' }); return true; }
    jsonRes(res, 200, { ok: true, teamId: inv.teamId, name: getTeam(dataDir, inv.teamId)?.name });
    return true;
  }

  // ── Current-team resource APIs ────────────────────────────────────────────
  // Everything below operates on the session's active team, so it re-checks
  // membership of THAT team on every request: a removed user loses access
  // immediately (within the session TTL), not just at next login.
  if (!isMember(dataDir, session.teamId, identity)) { jsonRes(res, 403, { ok: false, error: 'not_a_member' }); return true; }
  const knownBot = (app: string) => buildTeamRoster(dataDir, session.teamId).bots.some(b => b.larkAppId === app);

  if (path === '/api/team/roster' && method === 'GET') {
    jsonRes(res, 200, { ok: true, ...buildTeamRoster(dataDir, session.teamId, botConfigOrder()) });
    return true;
  }
  // Delete the current team entirely (members + invites dropped; bots/connectors
  // are deployment-level so unaffected). The session hops to another of the
  // user's teams, or becomes team-less (currentTeamValid=false on next /me).
  if (path === '/api/team' && method === 'DELETE') {
    const removed = deleteTeam(dataDir, session.teamId);
    if (!removed) { jsonRes(res, 404, { ok: false, error: 'team_not_found' }); return true; }
    deleteInvitesForTeam(dataDir, session.teamId); // "members + invites dropped" — kill stale codes
    const remaining = listTeamsForMember(dataDir, identity);
    const next = remaining[0]?.id ?? '';
    updateSessionTeam(dataDir, sessionToken, next);
    jsonRes(res, 200, { ok: true, switchedTo: next || null });
    return true;
  }
  // Edit a bot's capability label or team-level role from the web (team内互信).
  const botEdit = path.match(/^\/api\/team\/bots\/([^/]+)\/(capability|role)$/);
  if (botEdit && method === 'PUT') {
    const [, larkAppId, field] = botEdit;
    if (!knownBot(larkAppId)) { jsonRes(res, 404, { ok: false, error: 'unknown_bot' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    if (field === 'capability') {
      const cap = String(body?.capability ?? '').trim();
      if (cap) setBotCapability(dataDir, larkAppId, cap, session.identity.openId);
      else clearBotCapability(dataDir, larkAppId);
    } else {
      const role = String(body?.role ?? '').trim();
      if (role) setTeamRoleFile(dataDir, larkAppId, role);
      else deleteTeamRoleFile(dataDir, larkAppId);
    }
    jsonRes(res, 200, { ok: true });
    return true;
  }
  // Claim a bot ("归到我名下", explicit override) or release ownership.
  const ownerEdit = path.match(/^\/api\/team\/bots\/([^/]+)\/owner$/);
  if (ownerEdit && (method === 'POST' || method === 'DELETE')) {
    const larkAppId = ownerEdit[1];
    if (!knownBot(larkAppId)) { jsonRes(res, 404, { ok: false, error: 'unknown_bot' }); return true; }
    if (method === 'POST') {
      setBotOwner(dataDir, larkAppId, { unionId: session.identity.unionId, openId: session.identity.openId, name: session.identity.name }, { override: true });
    } else {
      clearBotOwner(dataDir, larkAppId);
    }
    jsonRes(res, 200, { ok: true });
    return true;
  }
  // Read a bot's full team role (for the edit form to prefill).
  const roleGet = path.match(/^\/api\/team\/bots\/([^/]+)\/role$/);
  if (roleGet && method === 'GET') {
    if (!knownBot(roleGet[1])) { jsonRes(res, 404, { ok: false, error: 'unknown_bot' }); return true; }
    const fp = join(dataDir, 'team-roles', `${roleGet[1]}.md`);
    const content = existsSync(fp) ? readFileSync(fp, 'utf-8') : '';
    jsonRes(res, 200, { ok: true, role: content });
    return true;
  }

  // ── Team members + invites (team内互信：任何成员可邀请/移除) ───────────────
  if (path === '/api/team/members' && method === 'GET') {
    const team = getTeam(dataDir, session.teamId);
    jsonRes(res, 200, { ok: true, members: (team?.members ?? []).map(m => ({ name: m.name, openId: m.openId, unionId: m.unionId, addedAt: m.addedAt })) });
    return true;
  }
  if (path === '/api/team/members' && method === 'DELETE') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const target = { unionId: body?.unionId as string | undefined, openId: body?.openId as string | undefined };
    const isSelf = (target.unionId && target.unionId === session.identity.unionId) || (target.openId && target.openId === session.identity.openId);
    if (isSelf) { jsonRes(res, 400, { ok: false, error: 'cannot_delete_self' }); return true; }
    if ((getTeam(dataDir, session.teamId)?.members.length ?? 0) <= 1) { jsonRes(res, 400, { ok: false, error: 'cannot_delete_last' }); return true; }
    const removed = removeMember(dataDir, session.teamId, target);
    jsonRes(res, removed ? 200 : 404, { ok: removed });
    return true;
  }
  if (path === '/api/team/group' && method === 'POST') {
    if (!deps.createTeamGroup) { jsonRes(res, 501, { ok: false, error: 'group_create_unavailable' }); return true; }
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const larkAppIds: string[] = Array.isArray(body?.larkAppIds) ? body.larkAppIds.filter((x: any) => typeof x === 'string') : [];
    const name = (String(body?.name ?? '').trim()) || '协作群';
    if (larkAppIds.length === 0) { jsonRes(res, 400, { ok: false, error: 'no_bots_selected' }); return true; }
    // Only allow bots that are actually on this team's roster (block bad configs).
    const rosterIds = new Set(buildTeamRoster(dataDir, session.teamId).bots.map(b => b.larkAppId));
    const unknown = larkAppIds.filter(id => !rosterIds.has(id));
    if (unknown.length) { jsonRes(res, 400, { ok: false, error: 'unknown_bot', unknown }); return true; }
    // Pass the user's open_id + the bot they paired with; createTeamGroup only
    // forwards the open_id as an invitee when that bot is the creator (open_id
    // is per-app scoped), else flags autoInviteUnavailable.
    const r = await deps.createTeamGroup({ name, larkAppIds, userOpenId: session.identity.openId, preferredCreator: session.identity.pairedLarkAppId });
    jsonRes(res, r.ok ? 200 : 502, r);
    return true;
  }
  if (path === '/api/team/invite' && method === 'POST') {
    const inv = createInvite(dataDir, session.teamId, session.identity.openId ?? session.identity.unionId ?? 'unknown');
    jsonRes(res, 200, { ok: true, code: inv.code, expiresAt: inv.expiresAt });
    return true;
  }
  // Connector WRITE ops: delegate to the connector domain handler AFTER the
  // session+membership gate above (a removed member can't reach this). GET list
  // stays on the desensitized team handler below; webhook-secrets is NOT exposed
  // standalone — secret handling lives inside the connector POST/PUT.
  const isConnWrite = (path === '/api/team/connectors' && method === 'POST')
    || (/^\/api\/team\/connectors\/[^/]+$/.test(path) && (method === 'PUT' || method === 'PATCH' || method === 'DELETE'));
  if (isConnWrite) {
    const delegated = new URL(url.href);
    delegated.pathname = path.replace('/api/team/connectors', '/api/connectors');
    const handled = await handleConnectorApi(req, res, delegated);
    if (!handled) jsonRes(res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  if (path === '/api/team/connectors' && method === 'GET') {
    // Definitions only — secret never leaves the box (store keeps secretRef, not plaintext).
    const connectors = listConnectors(dataDir).map(({ verify, ...rest }) => ({
      ...rest,
      verify: verify ? { type: verify.type, signatureHeader: verify.signatureHeader, timestampHeader: verify.timestampHeader } : undefined,
    }));
    jsonRes(res, 200, { ok: true, connectors });
    return true;
  }
  if (path === '/api/team/connector-stats' && method === 'GET') {
    jsonRes(res, 200, { ok: true, stats: summarizeTriggerLogs({ connectorId: url.searchParams.get('connectorId') ?? undefined }, dataDir) });
    return true;
  }
  if (path === '/api/team/trigger-logs' && method === 'GET') {
    const logs = listTriggerLogs({
      connectorId: url.searchParams.get('connectorId') ?? undefined,
      status: (url.searchParams.get('status') as 'ok' | 'error' | null) ?? undefined,
      errorCode: (url.searchParams.get('errorCode') ?? undefined) as TriggerLogListOptions['errorCode'],
      since: url.searchParams.get('since') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    }, dataDir);
    jsonRes(res, 200, { ok: true, logs });
    return true;
  }

  jsonRes(res, 404, { ok: false, error: 'not_found' });
  return true;
}
