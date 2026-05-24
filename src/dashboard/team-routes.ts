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
import { getWebSession, revokeWebSession, type WebSession } from '../services/web-session-store.js';
import { buildTeamRoster } from '../services/team-roster.js';
import { getTeam, removeMember, isMember } from '../services/team-store.js';
import { createInvite } from '../services/invite-store.js';
import { setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import { listConnectors } from '../services/connector-store.js';
import { listTriggerLogs, summarizeTriggerLogs, type TriggerLogListOptions } from '../services/trigger-log-store.js';
import { TEAM_PAGE_HTML } from './team-page.js';

const MAX_ROLE_BYTES = 4 * 1024;
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
  if (path !== '/team' && !path.startsWith('/api/pairing/') && !path.startsWith('/api/team/')) return false;

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
  // Re-check membership on every authenticated request: a removed user's session
  // must stop working immediately (within its TTL), not keep team write access.
  if (!isMember(dataDir, session.teamId, { unionId: session.identity.unionId, openId: session.identity.openId })) {
    jsonRes(res, 403, { ok: false, error: 'not_a_member' });
    return true;
  }
  const knownBot = (app: string) => buildTeamRoster(dataDir, session.teamId).bots.some(b => b.larkAppId === app);

  if (path === '/api/team/me' && method === 'GET') {
    jsonRes(res, 200, { ok: true, user: session.identity, teamId: session.teamId });
    return true;
  }
  if (path === '/api/team/roster' && method === 'GET') {
    jsonRes(res, 200, { ok: true, ...buildTeamRoster(dataDir, session.teamId) });
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
  if (path === '/api/team/invite' && method === 'POST') {
    const inv = createInvite(dataDir, session.teamId, session.identity.openId ?? session.identity.unionId ?? 'unknown');
    jsonRes(res, 200, { ok: true, code: inv.code, expiresAt: inv.expiresAt });
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
