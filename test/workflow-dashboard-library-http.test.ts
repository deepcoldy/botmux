/**
 * Workflow templates end to end over HTTP (design 2026-11-03
 * workflow-dashboard-orchestration §5, §7.2, §10, D5): a real Dashboard-side
 * handler on a real socket, forwarding over the real signed host channel to a
 * real daemon IPC server, which resolves the initiator (D1, incl. the I1
 * canOperate gate) and runs the real draft service and library. Fakes: the
 * Lark contact lookup, Feishu (fakeLaunch), the clarify session, the
 * Architect worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { handleWorkflowLibraryApi } from '../src/dashboard/workflow-library-api.js';
import { handleWorkflowDraftsApi } from '../src/dashboard/workflow-drafts-api.js';
import { workflowInitiatorPreGateDenial } from '../src/dashboard/workflow-initiator-api.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { installWorkflowDraftService, resetWorkflowDraftServiceForTests } from '../src/core/workflow-draft-daemon.js';
import * as larkClient from '../src/im/lark/client.js';
import { registerBot } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { computeSavedWorkflowGateDigest } from '../src/workflows/v3/library-schema.js';
import { BOTS, DOC, MAIN, PI, SKETCHES, STEWARD, goalNode, makeService } from './helpers/workflow-draft-fakes.js';
import { fakeLaunch } from './helpers/workflow-launch-fakes.js';

const SECRET = 'wf-library-host-key';
const OWNER_OPEN = 'ou_owner';
const ALICE = { open: 'ou_alice', union: 'on_alice' };
const LIB = '/api/v3/orchestration/library';
const RUN_ID = 'src-261101-080000-000-bbbb0001';

describe('Dashboard → daemon workflow templates', () => {
  let dir: string;
  let runsDir: string;
  let libraryDir: string;
  let previousDataDir: string;
  let ipc: IpcServerHandle | undefined;
  let dashboard: Server | undefined;
  let dashboardPort = 0;
  let allowed: string[];
  let deps: { identity: DashboardRequestIdentity | null; canManageHost: boolean; featureEnabled: boolean };
  let proxied: string[];
  let h: ReturnType<typeof makeService>;
  const forgetBridges: Array<() => void> = [];

  function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** A finished run of MAIN started by `ownerOpenId`. */
  function seedRun(runId: string, ownerOpenId = OWNER_OPEN): void {
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes: [goalNode('inspect', MAIN), { ...goalNode('write', DOC), depends: ['inspect'] }] });
    writeJson(join(runDir, 'spec.json'), { schemaVersion: 1, runId, title: '代码风险报告', requirement: '出报告', nodes: SKETCHES.map(({ assignee: _a, ...sketch }) => sketch) });
    writeJson(join(runDir, 'bots.snapshot.json'), {
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
      [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
    });
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId, createdAt: '2026-11-01T08:00:00.000Z', authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId },
      artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-library-http-'));
    runsDir = join(dir, 'v3-runs');
    libraryDir = dir;
    mkdirSync(runsDir);
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    mkdirSync(config.session.dataDir, { recursive: true });
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(dir, 'config.json'));
    vi.stubEnv('BOTMUX_WORKFLOW_ENABLED', '');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ workflow: { enabled: true, nodeExecutor: 'bot' } }));
    invalidateGlobalConfigCache();
    allowed = [OWNER_OPEN, ALICE.open];
    const bot = registerBot({ larkAppId: MAIN, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, allowedUsers: [...allowed] });
    Object.defineProperty(bot, 'resolvedAllowedUsers', { get: () => allowed, configurable: true });
    setLarkAppId(MAIN);
    vi.spyOn(larkClient, 'resolveTargetAppOpenId').mockImplementation(async (_app, union) =>
      union === ALICE.union ? { status: 'resolved', openId: ALICE.open } : { status: 'definitive' });
    const launch = fakeLaunch(runsDir);
    launch.setOnline([MAIN, DOC, STEWARD, PI]);
    h = makeService(runsDir, { launch: launch.deps, libraryDataDir: libraryDir, loadBots: () => BOTS });
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
      const common = { identity: deps.identity, canManageHost: deps.canManageHost, platformBound: true, featureEnabled: () => deps.featureEnabled, runsDir, proxyToDaemon };
      if (await handleWorkflowLibraryApi(req, res, url, { ...common, libraryDataDir: libraryDir })) return;
      if (await handleWorkflowDraftsApi(req, res, url, common)) return;
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

  /** Connect first, register THAT socket's port as a tunnel bridge, then
   *  speak HTTP over it (no port race). `body: null` sends no body. */
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown = method === 'POST' ? {} : null,
    opts: { viaTunnel?: boolean; actor?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const socket = connect(dashboardPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
    if (opts.viaTunnel) forgetBridges.push(registerPlatformTunnelBridge(socket.localPort!));
    const payload = body === null ? undefined : JSON.stringify(body);
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

  it('save a finished run → listed with its counts → detail → run it (a draft at 已确认流程)', async () => {
    seedRun(RUN_ID);
    const preview = await call('POST', `${LIB}/runs/${RUN_ID}/save/preview`, {});
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ nodeCount: 2, gateCount: 0, appendCandidates: [] });
    const saved = await call('POST', `${LIB}/runs/${RUN_ID}/save`, { requestKey: 'req-http-0001', displayName: '风险报告' });
    expect(saved).toMatchObject({ status: 200, body: { saved: { humanVersion: 1, created: true } } });
    expect(proxied).toEqual([`POST ${LIB}/runs/${RUN_ID}/save/preview`, `POST ${LIB}/runs/${RUN_ID}/save`]);

    const list = await call('GET', LIB);
    expect(list.body.templates).toEqual([expect.objectContaining({
      workflowId: saved.body.saved.workflowId, displayName: '风险报告', orchestratorAppId: MAIN, ownerOpenId: OWNER_OPEN,
      scope: { kind: 'global' }, paramCount: 0, nodeCount: 2, gateCount: 0, runnable: true, savedFromDraft: false,
    })]);
    const detail = await call('GET', `${LIB}/${saved.body.saved.workflowId}`);
    expect(detail.body.template.versions).toEqual([expect.objectContaining({ humanVersion: 1, source: 'dashboard_run', sourceRunId: RUN_ID, published: true })]);

    const run = await call('POST', `${LIB}/${saved.body.saved.workflowId}/run`, { params: {} }, alice);
    expect(run.status).toBe(200);
    expect(run.body.draft).toMatchObject({ phase: 'flow_confirmed', initiator: { openId: ALICE.open, unionId: ALICE.union }, template: { ownerOpenId: OWNER_OPEN } });
    // The template run lists as a draft of its initiator.
    const drafts = await call('GET', '/api/v3/orchestration/drafts');
    expect(drafts.body.drafts).toEqual([expect.objectContaining({ runId: run.body.draft.runId, template: expect.objectContaining({ workflowId: saved.body.saved.workflowId }) })]);
  });

  it('another person cannot save my run; a person who cannot operate the bot cannot run its template (I1)', async () => {
    seedRun(RUN_ID);
    expect(await call('POST', `${LIB}/runs/${RUN_ID}/save`, { requestKey: 'req-http-0002' }, alice))
      .toMatchObject({ status: 403, body: { error: 'not_owner' } });
    const saved = await call('POST', `${LIB}/runs/${RUN_ID}/save`, { requestKey: 'req-http-0003' });
    allowed = [OWNER_OPEN];
    expect(await call('POST', `${LIB}/${saved.body.saved.workflowId}/run`, { params: {} }, alice))
      .toMatchObject({ status: 403, body: { error: 'cannot_operate' } });
    expect(readdirSync(runsDir)).toEqual([RUN_ID]);
  });

  it('a chat-scoped template: shown, not runnable here (no daemon asked); writes need a JSON body', async () => {
    const chatScoped = await createSavedWorkflow(libraryDir, {
      displayName: '群模板', owner: { openId: OWNER_OPEN, larkAppId: MAIN }, scope: { kind: 'chat', chatId: 'oc_a' },
      revision: {
        inputs: {}, contextRefs: [],
        specTemplate: { schemaVersion: 1, title: 't', requirement: 'r', nodes: [{ sketchId: 'a', goal: 'a', input_needs: [], expected_outputs: ['a.md'], acceptance: 'ok', risk_gate: false, unknowns: [] }] } as any,
        specStatus: 'current',
        dagTemplate: { schemaVersion: 2, nodes: [goalNode('a', MAIN) as any] },
        safety: { gateDigest: computeSavedWorkflowGateDigest({ nodes: [goalNode('a', MAIN) as any] }), sideEffects: [] },
      },
    });
    const list = await call('GET', LIB);
    expect(list.body.templates).toEqual([expect.objectContaining({ scope: { kind: 'chat', chatId: 'oc_a' }, runnable: false })]);
    expect(await call('POST', `${LIB}/${chatScoped.metadata.workflowId}/run`, { params: {} })).toMatchObject({ status: 409, body: { error: 'template_scope' } });
    seedRun(RUN_ID);
    expect(await call('POST', `${LIB}/runs/${RUN_ID}/save`, null)).toMatchObject({ status: 400, body: { error: 'json_body_required' } });
    expect(proxied).toEqual([]);
  });

  it('with the switch off there is no template surface at all', async () => {
    deps.featureEnabled = false;
    seedRun(RUN_ID);
    expect(await call('GET', LIB)).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    expect(await call('POST', `${LIB}/runs/${RUN_ID}/save`, { requestKey: 'req-http-0004' })).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    // The daemon refuses on its own as well.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ workflow: { enabled: false, nodeExecutor: 'bot' } }));
    invalidateGlobalConfigCache();
    deps.featureEnabled = true;
    expect(await call('POST', `${LIB}/runs/${RUN_ID}/save`, { requestKey: 'req-http-0005' })).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    expect(readdirSync(libraryDir).filter((name) => name === 'workflow-library')).toEqual([]);
  });

  it('Feishu H5 login is refused with its own code', async () => {
    deps.identity = { kind: 'feishu-h5' } as DashboardRequestIdentity;
    deps.canManageHost = false;
    expect(await call('GET', LIB)).toMatchObject({ status: 403, body: { error: 'h5_login_unsupported' } });
  });
});
