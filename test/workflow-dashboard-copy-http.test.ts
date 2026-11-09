/**
 * 复制为新工作流 over HTTP (design 2026-11-03 workflow-dashboard-orchestration
 * §6, §7.2, D6): the real Dashboard handler on a real socket (the platform
 * tunnel is the real `isPlatformTunnelPeer`), the real signed host channel,
 * the real daemon IPC server resolving the initiator (D1, incl. the I1
 * canOperate gate) and the real draft service. Fakes: the Lark contact
 * lookup, the clarify session and the Architect worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { handleWorkflowDraftsApi, handleWorkflowProjectsApi } from '../src/dashboard/workflow-drafts-api.js';
import { workflowInitiatorPreGateDenial } from '../src/dashboard/workflow-initiator-api.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { installWorkflowDraftService, resetWorkflowDraftServiceForTests, WORKFLOW_DRAFTS_PATH } from '../src/core/workflow-draft-daemon.js';
import * as larkClient from '../src/im/lark/client.js';
import { registerBot } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';
import { BOTS, DOC, MAIN, PI, STEWARD, makeService } from './helpers/workflow-draft-fakes.js';
import { REVIEW, seedRun, treeDigest } from './helpers/workflow-copy-fakes.js';

const SECRET = 'wf-copy-host-key';
const OWNER_OPEN = 'ou_owner';
const ALICE = { open: 'ou_alice', union: 'on_alice' };
const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const RUN = 'src-261101-080000-000-aaaa0001';
const FROM_SOURCE = `${WORKFLOW_DRAFTS_PATH}/from-source`;

describe('Dashboard → daemon: 复制为新工作流', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'wf-copy-http-'));
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
      union === ALICE.union ? { status: 'resolved', openId: ALICE.open } : { status: 'definitive' });
    h = makeService(runsDir, { loadBots: () => FLEET, libraryDataDir: join(dir, 'library') });
    h.setOnline([MAIN, DOC, REVIEW, STEWARD, PI]);
    installWorkflowDraftService(h.service, { sweep: false });
    setIpcAuthSecret(SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    deps = { identity: { kind: 'legacy-dashboard' } as DashboardRequestIdentity, canManageHost: true, featureEnabled: true };
    proxied = [];
    dashboard = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.local');
      if (workflowInitiatorPreGateDenial(res, url.pathname, deps.identity, deps.canManageHost)) return;
      const proxyToDaemon = async (app: string, path: string, init: RequestInit) => {
        proxied.push(`${init.method ?? 'GET'} ${app} ${path}`);
        return fetchDaemonIpc(ipc!.port, path, init, SECRET);
      };
      if (await handleWorkflowDraftsApi(req, res, url, {
        identity: deps.identity,
        canManageHost: deps.canManageHost,
        platformBound: true,
        featureEnabled: () => deps.featureEnabled,
        runsDir,
        libraryDataDir: join(dir, 'library'),
        proxyToDaemon,
      })) return;
      if (await handleWorkflowProjectsApi(req, res, url, {
        canManageHost: deps.canManageHost,
        featureEnabled: () => deps.featureEnabled,
        runsDir,
        proxyToDaemon,
      })) return;
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

  /** Connect first, register the actual local port as a tunnel bridge, then
   *  speak HTTP over that socket (no port probing). */
  async function call(method: 'GET' | 'POST', path: string, body: unknown = method === 'POST' ? {} : null, opts: { viaTunnel?: boolean; actor?: string } = {}): Promise<{ status: number; body: any }> {
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
  const draftDirs = () => readdirSync(runsDir).filter((name) => name !== RUN);

  it('someone else\'s run, copied by a platform login: routed to the source\'s bot, the copier is the initiator; the source untouched', async () => {
    const runDir = seedRun(runsDir, RUN, { ownerOpenId: OWNER_OPEN, revised: true });
    const before = treeDigest(runDir);
    const out = await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN } }, alice);
    expect(out.status).toBe(200);
    expect(out.body.draft).toMatchObject({
      phase: 'spec_ready',
      orchestratorAppId: MAIN,
      initiator: { openId: ALICE.open, unionId: ALICE.union, source: 'dashboard-platform' },
      copy: { source: { kind: 'run', runId: RUN }, prefilled: true },
    });
    expect(proxied).toEqual([`POST ${MAIN} ${FROM_SOURCE}`]);
    expect(treeDigest(runDir)).toEqual(before);
    const runId = out.body.draft.runId;

    // The edits of a copy go through the same initiator check.
    expect(await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/copy/goal`, { goal: '只看安全', mode: 'text_only' }))
      .toMatchObject({ status: 403, body: { error: 'not_initiator' } });
    expect((await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/copy/goal`, { goal: '只看安全', mode: 'text_only' }, alice)).body.draft.copy.goalEditedAt)
      .toBeTruthy();
    const flow = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/approve-spec`, {}, alice);
    expect(flow.body.draft.phase).toBe('dag_ready');
    const edited = await call('POST', `${WORKFLOW_DRAFTS_PATH}/${runId}/nodes/write/text`, { goal: '写安全报告' }, alice);
    expect(edited.body.draft.flow.dag.nodes.find((node: any) => node.id === 'write').goal).toBe('写安全报告');
    expect(treeDigest(runDir)).toEqual(before);
  });

  it('复制运行的项目：没另选 Bot 就问来源运行的编排 Bot；它没设默认目录时，复制必须带上选的项目', async () => {
    seedRun(runsDir, RUN);
    const repo = join(dir, 'repo-a');
    resetWorkflowDraftServiceForTests();
    h = makeService(runsDir, {
      loadBots: () => FLEET,
      libraryDataDir: join(dir, 'library'),
      projects: { defaultDir: () => undefined, candidates: () => [{ path: repo, name: 'repo-a', type: 'repo' }] },
    });
    h.setOnline([MAIN, DOC, REVIEW, STEWARD, PI]);
    installWorkflowDraftService(h.service, { sweep: false });

    const options = await call('GET', `/api/v3/orchestration/projects?runId=${RUN}`);
    expect(options).toMatchObject({ status: 200, body: { project: { kind: 'pick', candidates: [{ path: repo }] } } });
    expect(proxied).toEqual([`GET ${MAIN} /api/v3/orchestration/projects`]);
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN } })).toMatchObject({ status: 422, body: { error: 'project_required' } });
    expect(draftDirs()).toEqual([]);
    const out = await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN }, project: repo });
    expect(out).toMatchObject({ status: 200, body: { draft: { project: { dir: repo, from: 'draft' } } } });
  });

  it('I1: a person who cannot operate the target orchestrating bot is refused, and nothing is created', async () => {
    seedRun(runsDir, RUN);
    allowed = [OWNER_OPEN];
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN } }, alice))
      .toMatchObject({ status: 403, body: { error: 'cannot_operate' } });
    expect(draftDirs()).toEqual([]);
  });

  it('a chosen orchestrator is routed to as named; a malformed or unknown source is refused before any daemon is asked', async () => {
    seedRun(runsDir, RUN);
    expect((await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN }, larkAppId: MAIN })).status).toBe(200);
    proxied = [];
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'nope' } })).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: 'gone-261101-080000-000-aaaa0099' } })).toMatchObject({ status: 404, body: { error: 'unknown_run' } });
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'template', workflowId: `wf_${'1'.repeat(32)}`, revisionId: `rev_${'2'.repeat(64)}` } }))
      .toMatchObject({ status: 404, body: { error: 'template_not_found' } });
    expect(await call('POST', FROM_SOURCE, null)).toMatchObject({ status: 400, body: { error: 'json_body_required' } });
    expect(proxied).toEqual([]);
  });

  it('switch off: no entry — the Dashboard and the daemon both refuse, nothing is created', async () => {
    seedRun(runsDir, RUN);
    deps.featureEnabled = false;
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN } })).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    deps.featureEnabled = true;
    writeWorkflowConfig({ enabled: true, nodeExecutor: 'ephemeral' });
    expect(await call('POST', FROM_SOURCE, { source: { kind: 'run', runId: RUN } })).toMatchObject({ status: 409, body: { error: 'feature_disabled' } });
    expect(draftDirs()).toEqual([]);
  });
});
