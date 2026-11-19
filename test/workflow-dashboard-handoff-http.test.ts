/**
 * 换编排 Bot over HTTP: the real Dashboard handler on a real socket (the
 * platform tunnel is the real `isPlatformTunnelPeer`) sequencing two daemons,
 * each a real draft IPC route table (registerWorkflowDraftIpcRoutes) over its
 * own real draft service, resolving the person with the real D1 resolution
 * (`resolveDashboardWorkflowInitiator`) in its own app. Fakes: the per-app
 * union_id → open_id lookup and canOperate lists, the clarify sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { handleWorkflowDraftsApi } from '../src/dashboard/workflow-drafts-api.js';
import { registerWorkflowDraftIpcRoutes, WORKFLOW_DRAFTS_PATH } from '../src/core/workflow-draft-daemon.js';
import {
  DASHBOARD_INITIATOR_SOURCE_HEADER,
  DASHBOARD_INITIATOR_UNION_HEADER,
  WORKFLOW_INITIATOR_PATH,
  initiatorFailureBody,
  resolveDashboardWorkflowInitiator,
} from '../src/core/workflow-initiator.js';
import { readWorkflowDraft, workflowDraftOwner } from '../src/workflows/v3/draft-store.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';
import { DOC, MAIN, SKETCHES, STEWARD, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => unknown;

const ALICE_UNION = 'on_alice';
const BOB_UNION = 'on_bob';
/** Per app: union_id → that app's open_id, and who may operate the bot. */
const DIRECTORY: Record<string, { ids: Record<string, string>; operators: Set<string> }> = {
  [MAIN]: { ids: { [ALICE_UNION]: 'ou_alice_main', [BOB_UNION]: 'ou_bob_main' }, operators: new Set(['ou_alice_main', 'ou_bob_main', `ou_owner_${MAIN}`]) },
  [DOC]: { ids: { [ALICE_UNION]: 'ou_alice_doc', [BOB_UNION]: 'ou_bob_doc' }, operators: new Set(['ou_alice_doc', `ou_owner_${DOC}`]) },
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : undefined); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** One bot's daemon: its draft routes + the initiator route, D1 in its own app. */
async function startDaemon(appId: string, service: ReturnType<typeof makeService>['service']): Promise<{ server: Server; port: number; hits: string[] }> {
  const routes: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];
  const hits: string[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_m, key) => { keys.push(key); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };
  const resolveInitiator = (req: IncomingMessage) => resolveDashboardWorkflowInitiator(
    { source: req.headers[DASHBOARD_INITIATOR_SOURCE_HEADER], unionId: req.headers[DASHBOARD_INITIATOR_UNION_HEADER] },
    {
      appId,
      featureEnabled: true,
      trustedHost: true,
      ownerOpenId: () => `ou_owner_${appId}`,
      resolveOpenId: async (_app, union) => (DIRECTORY[appId]!.ids[union]
        ? { status: 'resolved', openId: DIRECTORY[appId]!.ids[union]! }
        : { status: 'definitive' }),
      canOperate: (_app, openId) => DIRECTORY[appId]!.operators.has(openId),
    },
  );
  registerWorkflowDraftIpcRoutes(route, {
    appId: () => appId,
    featureEnabled: () => true,
    trustedHost: () => true,
    resolveInitiator,
    service: () => service,
    readJsonBody: readJson,
    jsonRes,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://daemon.local');
    hits.push(`${req.method} ${url.pathname}`);
    if (req.method === 'POST' && url.pathname === WORKFLOW_INITIATOR_PATH) {
      const body = await readJson(req) as { larkAppId?: unknown } | undefined;
      if (body?.larkAppId !== appId) return jsonRes(res, 409, { ok: false, error: 'bot_mismatch', retryable: false });
      const resolved = await resolveInitiator(req);
      return resolved.ok ? jsonRes(res, 200, { ok: true, initiator: resolved.initiator }) : jsonRes(res, resolved.status, initiatorFailureBody(resolved));
    }
    for (const entry of routes) {
      const match = entry.method === req.method ? url.pathname.match(entry.re) : null;
      if (!match) continue;
      await entry.handler(req, res, Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]!])));
      return;
    }
    jsonRes(res, 404, { ok: false, error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, port: (server.address() as { port: number }).port, hits };
}

describe('Dashboard 换编排 Bot across two daemons', () => {
  let dir: string;
  let runsDir: string;
  let a: ReturnType<typeof makeService>;
  let b: ReturnType<typeof makeService>;
  let daemons: Record<string, { server: Server; port: number; hits: string[] }>;
  let dashboard: Server;
  let dashboardPort = 0;
  const forgetBridges: Array<() => void> = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-handoff-http-'));
    runsDir = join(dir, 'v3-runs');
    mkdirSync(runsDir);
    a = makeService(runsDir);
    b = makeService(runsDir, { appId: DOC });
    daemons = { [MAIN]: await startDaemon(MAIN, a.service), [DOC]: await startDaemon(DOC, b.service) };
    dashboard = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.local');
      const proxyToDaemon = async (larkAppId: string, path: string, init: RequestInit) => {
        const daemon = daemons[larkAppId];
        if (!daemon) return new Response(JSON.stringify({ ok: false, error: 'daemon_offline' }), { status: 503 });
        return fetch(`http://127.0.0.1:${daemon.port}${path}`, init);
      };
      if (await handleWorkflowDraftsApi(req, res, url, {
        identity: { kind: 'legacy-dashboard' } as DashboardRequestIdentity,
        canManageHost: true,
        platformBound: true,
        featureEnabled: () => true,
        runsDir,
        proxyToDaemon,
      })) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', () => resolve()));
    dashboardPort = (dashboard.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const forget of forgetBridges.splice(0)) forget();
    for (const daemon of Object.values(daemons)) await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
    await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** A real socket; its actual local port registered as a platform tunnel bridge. */
  /** `actor: null`: the local token (a direct connection, no platform actor). */
  async function call(method: 'GET' | 'POST', path: string, body: unknown, actor: string | null): Promise<{ status: number; body: any }> {
    const socket = connect(dashboardPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
    if (actor !== null) forgetBridges.push(registerPlatformTunnelBridge(socket.localPort!));
    const payload = body === null ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: dashboardPort, createConnection: () => socket, method, path,
        headers: {
          ...(actor !== null ? { 'x-botmux-actor': actor } : {}),
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async function failedDraft(actor: string | null = ALICE_UNION): Promise<string> {
    const created = await call('POST', WORKFLOW_DRAFTS_PATH, { larkAppId: MAIN, goal: '出一份代码风险报告' }, actor);
    expect(created.status).toBe(200);
    const runId = created.body.draft.runId as string;
    a.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
    await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`, null, actor);
    expect((await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/messages`, { text: '再补一句' }, actor)).status).toBe(200);
    a.clarify.fail('provider_authentication_failed');
    const view = await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`, null, actor);
    expect(view.body.draft.failure).toMatchObject({ category: 'permission', larkAppId: MAIN });
    return runId;
  }

  it('one request: the target checks the person, the owner hands over, the target takes over; reads then route to the new bot', async () => {
    const runId = await failedDraft();
    const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
    expect(out.status).toBe(200);
    expect(out.body.draft).toMatchObject({ orchestratorAppId: DOC, clarify: { state: 'active', pending: true } });
    expect(out.body.draft.initiator).toEqual({ openId: 'ou_alice_doc', unionId: ALICE_UNION, source: 'dashboard-platform' });
    expect(workflowDraftOwner(runsDir, runId)).toBe(DOC);
    expect(daemons[DOC]!.hits).toContain(`POST ${WORKFLOW_INITIATOR_PATH}`);
    expect(daemons[MAIN]!.hits).toContain(`POST ${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/prepare`);
    expect(daemons[DOC]!.hits).toContain(`POST ${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/accept`);

    const read = await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`, null, ALICE_UNION);
    expect(read.body.draft.orchestratorAppId).toBe(DOC);
    expect(daemons[DOC]!.hits.at(-1)).toBe(`GET ${WORKFLOW_DRAFTS_PATH}/${runId}`);
    // Asking again is answered from the new owner, without a second session.
    const again = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
    expect(again.status).toBe(200);
    expect(b.clarify.creates).toBe(1);
  });

  it('a local-token draft is handed over too: the new bot resolves the local token as its own owner', async () => {
    const runId = await failedDraft(null);
    expect(readWorkflowDraft(join(runsDir, runId))?.initiator).toEqual({ openId: `ou_owner_${MAIN}`, source: 'dashboard-local' });
    const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, null);
    expect(out.status).toBe(200);
    expect(out.body.draft.orchestratorAppId).toBe(DOC);
    expect(out.body.draft.initiator).toEqual({ openId: `ou_owner_${DOC}`, source: 'dashboard-local' });
    expect(out.body.draft.handoffs.at(-1).by).toEqual({ source: 'dashboard-local', fromOpenId: `ou_owner_${MAIN}`, toOpenId: `ou_owner_${DOC}` });
    expect(workflowDraftOwner(runsDir, runId)).toBe(DOC);
    // A platform login is another person's path: it cannot move this draft back.
    const platform = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: MAIN }, ALICE_UNION);
    expect(platform).toMatchObject({ status: 403, body: { error: 'not_initiator' } });
    expect(workflowDraftOwner(runsDir, runId)).toBe(DOC);
  });

  it('the person cannot operate the new bot (I1): refused before the old bot changes anything', async () => {
    const runId = await failedDraft();
    DIRECTORY[DOC]!.operators.delete('ou_alice_doc');
    try {
      const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
      expect(out).toMatchObject({ status: 403, body: { error: 'cannot_operate' } });
      expect(daemons[MAIN]!.hits.some((hit) => hit.endsWith('/handoff/prepare'))).toBe(false);
      expect(readWorkflowDraft(join(runsDir, runId))?.handoff).toBeUndefined();
      expect(workflowDraftOwner(runsDir, runId)).toBe(MAIN);
    } finally {
      DIRECTORY[DOC]!.operators.add('ou_alice_doc');
    }
  });

  it('someone else (who may operate both bots) cannot move another person\'s draft', async () => {
    const runId = await failedDraft();
    DIRECTORY[DOC]!.operators.add('ou_bob_doc');
    try {
      const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, BOB_UNION);
      expect(out).toMatchObject({ status: 403, body: { error: 'not_initiator' } });
      expect(workflowDraftOwner(runsDir, runId)).toBe(MAIN);
    } finally {
      DIRECTORY[DOC]!.operators.delete('ou_bob_doc');
    }
  });

  it('the steward is refused by the owner (static rule), nothing closed', async () => {
    const runId = await failedDraft();
    DIRECTORY[STEWARD] = { ids: { [ALICE_UNION]: 'ou_alice_st' }, operators: new Set(['ou_alice_st']) };
    daemons[STEWARD] = await startDaemon(STEWARD, makeService(runsDir, { appId: STEWARD }).service);
    const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: STEWARD }, ALICE_UNION);
    expect(out).toMatchObject({ status: 422, body: { error: 'orchestrator_ineligible' } });
    expect(a.clarify.closes).toEqual([]);
  });

  it('the new bot is unreachable after the handoff was prepared: the owner keeps it, the page sees the pending handoff and can finish later', async () => {
    const runId = await failedDraft();
    const docDaemon = daemons[DOC]!;
    // The accept goes nowhere (daemon gone), the initiator check still answers.
    const realPort = docDaemon.port;
    let acceptDown = true;
    const proxyServer = createServer(async (req, res) => {
      if (acceptDown && req.url?.endsWith('/handoff/accept')) { res.destroy(); return; }
      const upstream = await fetch(`http://127.0.0.1:${realPort}${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        ...(req.method === 'POST' ? { body: JSON.stringify(await readJson(req)) } : {}),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()));
    daemons[DOC] = { ...docDaemon, port: (proxyServer.address() as { port: number }).port };
    try {
      const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
      expect(out.status).toBe(502);
      expect(workflowDraftOwner(runsDir, runId)).toBe(MAIN);
      const pending = await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`, null, ALICE_UNION);
      expect(pending.body.draft.handoff).toMatchObject({ toAppId: DOC, state: 'ready' });
      acceptDown = false;
      const finished = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
      expect(finished.status).toBe(200);
      expect(workflowDraftOwner(runsDir, runId)).toBe(DOC);
    } finally {
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      daemons[DOC] = docDaemon;
    }
  });

  it('two tabs switch to the same bot at once: both answer the moved draft (the later one is not told bot_mismatch), one new session', async () => {
    const runId = await failedDraft();
    const real = a.clarify.clarifier.close.bind(a.clarify.clarifier);
    const held: Array<() => Promise<void>> = [];
    a.clarify.clarifier.close = (session) => new Promise<void>((resolve) => { held.push(async () => { await real(session); resolve(); }); });
    const tab1 = call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
    const tab2 = call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/orchestrator`, { larkAppId: DOC }, ALICE_UNION);
    for (let i = 0; i < 500 && held.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(held).toHaveLength(2);
    await held[0]!();
    const first = await tab1;
    expect(first.status).toBe(200);
    expect(workflowDraftOwner(runsDir, runId)).toBe(DOC);
    await held[1]!();
    const second = await tab2;
    expect(second.status).toBe(200);
    expect(second.body.draft.orchestratorAppId).toBe(DOC);
    expect(b.clarify.creates).toBe(1);
  });

  it('the handoff steps are not reachable through the generic draft route: only /orchestrator (target I1 first) runs them; cancel stays', async () => {
    const runId = await failedDraft();
    const prepare = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/prepare`, { toLarkAppId: DOC }, ALICE_UNION);
    expect(prepare).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(prepare.body).not.toHaveProperty('token');
    const accept = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/accept`, { token: '00000000-0000-0000-0000-000000000000' }, ALICE_UNION);
    expect(accept).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(daemons[MAIN]!.hits.some((hit) => hit.includes('/handoff/'))).toBe(false);
    expect(readWorkflowDraft(join(runsDir, runId))?.handoff).toBeUndefined();
    expect(a.clarify.closes).toEqual([]);
    // 取消更换 still goes to the owner (nothing pending here: the owner says so).
    const cancel = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/cancel`, {}, ALICE_UNION);
    expect(cancel).toMatchObject({ status: 409, body: { error: 'state_conflict' } });
    expect(daemons[MAIN]!.hits).toContain(`POST ${WORKFLOW_DRAFTS_PATH}/${runId}/handoff/cancel`);
  });
});
