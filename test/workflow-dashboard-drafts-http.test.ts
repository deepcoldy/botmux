/**
 * Dashboard workflow drafts end to end over HTTP (design 2026-11-03
 * workflow-dashboard-orchestration §7.2, D2): a real Dashboard-side handler
 * on a real socket (so the platform tunnel is the real `isPlatformTunnelPeer`),
 * forwarding over the real signed host channel to a real daemon IPC server,
 * which resolves the initiator (D1, incl. canOperate) and runs the real draft
 * service. Fakes: the Lark contact lookup, the clarify session and the
 * Architect worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { handleWorkflowDraftsApi } from '../src/dashboard/workflow-drafts-api.js';
import { handleV3RunsApi } from '../src/dashboard/v3-runs-api.js';
import { workflowInitiatorPreGateDenial } from '../src/dashboard/workflow-initiator-api.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders, fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { installWorkflowDraftService, resetWorkflowDraftServiceForTests, WORKFLOW_DRAFTS_PATH } from '../src/core/workflow-draft-daemon.js';
import { DASHBOARD_INITIATOR_SOURCE_HEADER } from '../src/core/workflow-initiator.js';
import * as larkClient from '../src/im/lark/client.js';
import { registerBot } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';
import { MAIN, SKETCHES, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

const SECRET = 'wf-drafts-host-key';
const OWNER_OPEN = 'ou_owner';
const ALICE = { open: 'ou_alice', union: 'on_alice' };
const OWNER_UNION = 'on_owner';

describe('Dashboard → daemon workflow drafts', () => {
  let dir: string;
  let runsDir: string;
  let previousDataDir: string;
  let ipc: IpcServerHandle | undefined;
  let dashboard: Server | undefined;
  let dashboardPort = 0;
  let allowed: string[];
  let h: ReturnType<typeof makeService>;
  let deps: { identity: DashboardRequestIdentity | null; canManageHost: boolean; featureEnabled: boolean };
  let proxied: string[];
  const forgetBridges: Array<() => void> = [];

  function writeWorkflowConfig(workflow: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ workflow }));
    invalidateGlobalConfigCache();
  }

  beforeEach(async () => {
    // A self-owned parent: nothing here depends on root's file ownership.
    dir = mkdtempSync(join(tmpdir(), 'wf-drafts-http-'));
    runsDir = join(dir, 'v3-runs');
    mkdirSync(runsDir);
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    mkdirSync(config.session.dataDir, { recursive: true });
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(dir, 'config.json'));
    vi.stubEnv('BOTMUX_WORKFLOW_ENABLED', '');
    writeWorkflowConfig({ enabled: true, nodeExecutor: 'bot' });
    allowed = [OWNER_OPEN, ALICE.open];
    const bot = registerBot({ larkAppId: MAIN, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, allowedUsers: [...allowed] });
    Object.defineProperty(bot, 'resolvedAllowedUsers', { get: () => allowed, configurable: true });
    setLarkAppId(MAIN);
    vi.spyOn(larkClient, 'resolveTargetAppOpenId').mockImplementation(async (_app, union) =>
      union === ALICE.union ? { status: 'resolved', openId: ALICE.open }
        : union === OWNER_UNION ? { status: 'resolved', openId: OWNER_OPEN }
          : { status: 'definitive' });
    h = makeService(runsDir);
    installWorkflowDraftService(h.service, { sweep: false });
    setIpcAuthSecret(SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    deps = { identity: { kind: 'legacy-dashboard' } as DashboardRequestIdentity, canManageHost: true, featureEnabled: true };
    proxied = [];
    dashboard = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.local');
      if (workflowInitiatorPreGateDenial(res, url.pathname, deps.identity, deps.canManageHost)) return;
      const proxyToDaemon = async (_app: string, path: string, init: RequestInit) => {
        proxied.push(`${init.method ?? 'GET'} ${path}`);
        return fetchDaemonIpc(ipc!.port, path, init, SECRET);
      };
      if (await handleWorkflowDraftsApi(req, res, url, {
        identity: deps.identity,
        canManageHost: deps.canManageHost,
        platformBound: true,
        featureEnabled: () => deps.featureEnabled,
        runsDir,
        proxyToDaemon,
      })) return;
      if (await handleV3RunsApi(req, res, url, { runsDir, proxyToDaemon }, deps.canManageHost)) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>(resolve => dashboard!.listen(0, '127.0.0.1', () => resolve()));
    dashboardPort = (dashboard.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const forget of forgetBridges.splice(0)) forget();
    resetWorkflowDraftServiceForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    await ipc?.close(); ipc = undefined;
    await new Promise<void>(resolve => (dashboard ? dashboard.close(() => resolve()) : resolve()));
    dashboard = undefined;
    setIpcAuthSecret(null);
    config.session.dataDir = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Call the Dashboard from a real socket. `body: null` sends no body. */
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown = method === 'POST' ? {} : null,
    opts: { viaTunnel?: boolean; actor?: string; rawBody?: string } = {},
  ): Promise<{ status: number; body: any }> {
    // Connect first (the OS picks the client port), register that port as a
    // tunnel bridge, then speak HTTP over the same socket. Probing a free port
    // and binding it later raced under parallel load (EADDRINUSE).
    const socket = connect(dashboardPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
    if (opts.viaTunnel) forgetBridges.push(registerPlatformTunnelBridge(socket.localPort!));
    const payload = opts.rawBody ?? (body === null ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: dashboardPort, createConnection: () => socket, method, path,
        headers: {
          ...(opts.actor ? { 'x-botmux-actor': opts.actor } : {}),
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

  const alice = { viaTunnel: true, actor: ALICE.union };
  const create = (opts: { viaTunnel?: boolean; actor?: string } = {}) =>
    call('POST', WORKFLOW_DRAFTS_PATH, { larkAppId: MAIN, goal: '帮我出一份代码风险报告' }, opts);

  async function waitPhase(runId: string, phase: string): Promise<any> {
    for (let i = 0; i < 400; i++) {
      const got = await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`);
      if (got.body?.draft?.phase === phase) return got.body.draft;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`draft ${runId} never reached ${phase}`);
  }

  it('create → clarify round trip → spec → listed as a draft, never as a run', async () => {
    const created = await create();
    expect(created.status).toBe(200);
    const runId = created.body.draft.runId;
    expect(created.body.draft).toMatchObject({ phase: 'clarifying', initiator: { openId: OWNER_OPEN, source: 'dashboard-local' } });

    h.clarify.reply('先确认范围。\n```botmux-question\n{"question":"看哪个仓库？","options":["主仓","全部"],"recommended":"主仓"}\n```');
    const polled = await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`);
    expect(polled.body.draft.clarify.turns.at(-1)).toMatchObject({ role: 'assistant', question: { recommended: '主仓' } });

    expect((await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/messages`, { text: '主仓' })).status).toBe(200);
    h.clarify.reply(`<botmux-spec>\n${specMarkdown()}\n</botmux-spec>`);
    const finalized = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/spec`, {});
    expect(finalized.body).toMatchObject({ ok: true, draft: { phase: 'spec_ready' } });

    const list = await call('GET', WORKFLOW_DRAFTS_PATH);
    expect(list.body.drafts.map((draft: any) => [draft.runId, draft.phase])).toEqual([[runId, 'spec_ready']]);
    expect((await call('GET', '/api/v3/runs')).body).toEqual({ runs: [] });
    expect((await call('GET', `/api/v3/runs/${runId}`)).status).toBe(404);
  });

  it('a spec that does not validate comes back with its problems', async () => {
    const runId = (await create()).body.draft.runId;
    h.clarify.reply(`<botmux-spec>\n${specMarkdown([{ ...SKETCHES[0], expected_outputs: [] }])}\n</botmux-spec>`);
    const out = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/spec`, { relayProblems: true });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(false);
    expect(out.body.problems.join('\n')).toContain('expected_outputs');
    expect(out.body.draft.phase).toBe('clarifying');
  });

  it('only the initiator writes: another person, or the same person via another login, is refused', async () => {
    const runId = (await create()).body.draft.runId;
    h.clarify.reply(`<botmux-spec>\n${specMarkdown()}\n</botmux-spec>`);
    await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/spec`, {});
    const byAlice = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-spec`, {}, alice);
    expect(byAlice).toMatchObject({ status: 403, body: { ok: false, error: 'not_initiator' } });
    const ownerViaPlatform = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-spec`, {}, { viaTunnel: true, actor: OWNER_UNION });
    expect(ownerViaPlatform).toMatchObject({ status: 403, body: { error: 'not_initiator' } });
    // Anyone with the management login may look (§7.2).
    expect((await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`, null, alice)).status).toBe(200);
    expect((await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-spec`, {})).status).toBe(200);
  });

  it('on a platform-bound machine a direct (non-tunnel) write naming a person is refused, not taken as the owner', async () => {
    expect(await create({ actor: ALICE.union })).toMatchObject({ status: 403, body: { error: 'platform_direct_unsupported' } });
    expect(proxied).toEqual([]);
    expect((await call('GET', WORKFLOW_DRAFTS_PATH)).body.drafts).toEqual([]);
  });

  it('the I1 gate applies to every write: a person who cannot operate the bot is refused', async () => {
    const runId = (await create(alice)).body.draft.runId;
    expect((await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`)).body.draft.initiator)
      .toEqual({ openId: ALICE.open, unionId: ALICE.union, source: 'dashboard-platform' });
    allowed = [OWNER_OPEN];
    expect(await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/messages`, { text: 'x' }, alice))
      .toMatchObject({ status: 403, body: { error: 'cannot_operate' } });
    expect(await create(alice)).toMatchObject({ status: 403, body: { error: 'cannot_operate' } });
    expect((await call('GET', WORKFLOW_DRAFTS_PATH)).body.drafts).toHaveLength(1);
  });

  it('two tabs confirming the flow at once: exactly one wins, the other gets a deterministic conflict', async () => {
    const runId = (await create()).body.draft.runId;
    h.clarify.reply(`<botmux-spec>\n${specMarkdown()}\n</botmux-spec>`);
    await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/spec`, {});
    await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-spec`, {});
    expect((await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/architect`, {})).body.draft.phase).toBe('architect_running');
    const draft = await waitPhase(runId, 'dag_ready');
    const confirm = () => call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-flow`, { flowSummarySha256: draft.flow.flowSummarySha256 });
    const [a, b] = await Promise.all([confirm(), confirm()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error).toBe('already_confirmed');
    expect((await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`)).body.draft.phase).toBe('flow_confirmed');
  });

  it('writes need a JSON object body on the Dashboard and on the daemon', async () => {
    const runId = (await create()).body.draft.runId;
    proxied = [];
    expect(await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/abandon`, null))
      .toMatchObject({ status: 400, body: { error: 'json_body_required' } });
    expect(await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/abandon`, null, { rawBody: '[]' }))
      .toMatchObject({ status: 400, body: { error: 'json_body_required' } });
    // Refused by the Dashboard itself, before any daemon is asked.
    expect(proxied).toEqual([]);
    const path = `${WORKFLOW_DRAFTS_PATH}/${runId}/abandon`;
    const direct = await fetch(`http://127.0.0.1:${ipc!.port}${path}`, {
      method: 'POST',
      headers: daemonIpcAuthHeaders({ secret: SECRET, port: ipc!.port, method: 'POST', path, headers: { [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-local' } }),
    });
    expect(direct.status).toBe(400);
    expect((await direct.json()).error).toBe('json_body_required');
    expect((await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`)).body.draft.phase).toBe('clarifying');
  });

  it('feature off: feature_disabled on the Dashboard and on the daemon, and nothing is created', async () => {
    deps.featureEnabled = false;
    expect(await call('GET', WORKFLOW_DRAFTS_PATH)).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    expect(await create()).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    deps.featureEnabled = true;
    writeWorkflowConfig({ enabled: true });
    expect(await create()).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    writeWorkflowConfig({ enabled: true, nodeExecutor: 'bot' });
    expect((await call('GET', WORKFLOW_DRAFTS_PATH)).body.drafts).toEqual([]);
    // Reads are gated on the daemon too, not only by the Dashboard.
    const runId = (await create()).body.draft.runId;
    writeWorkflowConfig({ enabled: false, nodeExecutor: 'bot' });
    expect(await call('GET', `${WORKFLOW_DRAFTS_PATH}/${runId}`)).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
  });

  it('the daemon refuses unsigned requests and drafts for another bot', async () => {
    const unsigned = await fetch(`http://127.0.0.1:${ipc!.port}${WORKFLOW_DRAFTS_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-local' },
      body: JSON.stringify({ larkAppId: MAIN, goal: 'g' }),
    });
    expect(unsigned.status).toBe(401);
    expect(await call('POST', WORKFLOW_DRAFTS_PATH, { larkAppId: 'cli_other', goal: 'g' }))
      .toMatchObject({ status: 409, body: { error: 'bot_mismatch' } });
    expect((await call('GET', WORKFLOW_DRAFTS_PATH)).body.drafts).toEqual([]);
  });

  it('Feishu H5 and anonymous logins cannot reach drafts', async () => {
    deps.identity = { kind: 'feishu-h5' } as DashboardRequestIdentity;
    deps.canManageHost = false;
    expect(await create()).toMatchObject({ status: 403, body: { error: 'h5_login_unsupported' } });
    deps.identity = null;
    expect(await call('GET', WORKFLOW_DRAFTS_PATH)).toMatchObject({ status: 401 });
  });
});
