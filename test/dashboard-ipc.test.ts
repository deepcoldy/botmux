// test/dashboard-ipc.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcRoute, startIpcServer, setLarkAppId, setIpcAuthSecret, setBotRenamer, setBotAvatarChanger, setBotDescriptionManager, setExactChatGrantHandler, armCoreOnlyReadinessGate, setCoreOnlyReady, __testOnly_resetCoreOnlyReadiness, type IpcServerHandle,
  __testOnly_agentSwitchBeforePreCloseVerify,
} from '../src/core/dashboard-ipc-server.js';
import { rmwBotEntry } from '../src/services/config-store.js';
import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as groupsStore from '../src/services/groups-store.js';
import { setScheduleScope } from '../src/services/schedule-store.js';

// Per-bot schedule stores: the daemon binds the store to its own bot before
// serving IPC; the schedule endpoints under test assume that binding exists.
setScheduleScope('cli_ipc_test_bot001');
import * as larkClient from '../src/im/lark/client.js';
import * as oncallStore from '../src/services/oncall-store.js';
import * as sessionStore from '../src/services/session-store.js';
import * as sandboxStore from '../src/services/sandbox-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as scheduler from '../src/core/scheduler.js';
import { clearMessageListenerRunPreviewStore, markMessageListenerRunPreviewReplied } from '../src/services/message-listener-run-preview-store.js';
import * as persistentBackend from '../src/core/persistent-backend.js';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { sessionKey } from '../src/core/types.js';
import { writeRoleFile, writeTeamRoleFile } from '../src/core/role-resolver.js';
import {
  _allAskIds,
  _resetForTest as resetAskBrokerForTest,
  registerAsk,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import { managedOriginAttestationProofPath } from '../src/core/managed-origin-capability.js';
import { MANAGED_ORIGIN_PROOF_DOMAIN } from '../src/core/managed-origin-attestation.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
} from '../src/core/bot-turn-mutation-gate.js';
import { SESSION_WAKE_DEADLINE_HEADER } from '../src/core/session-wake-deadline.js';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from '../src/dashboard/reply-style.js';
import {
  REPLY_LAYOUT_TAG_MAX_CODEPOINTS,
  REPLY_RECIPE_PROMPT_MAX_CODEPOINTS,
} from '../src/im/lark/reply-card-style.js';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';

// Loopback-HMAC the write-link routes require. Inject a known secret per test
// (setIpcAuthSecret) and sign with it, so the suite doesn't depend on a real
// ~/.botmux/.dashboard-secret existing on the box.
const TEST_IPC_SECRET = 'test-ipc-secret-deadbeef';
function tokenAuthHeaders(secret = TEST_IPC_SECRET, bind?: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(bind ? `${ts}:${nonce}:${bind}` : `${ts}:${nonce}`).digest('base64url');
  return { 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': sig };
}

function trustedHostHeaders(
  method: string,
  path: string,
  port: number,
  secret = TEST_IPC_SECRET,
): Record<string, string> {
  const auth = signCliAuth(secret, cliAuthBind(method, path, port));
  return {
    'X-Botmux-Cli-Ts': auth.ts,
    'X-Botmux-Cli-Nonce': auth.nonce,
    'X-Botmux-Cli-Auth': auth.sig,
  };
}

function parseSseFrame(raw: string): { type: string; body: any } | null {
  let type: string | undefined;
  let data: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
  }
  if (!type) return null;
  let body: any;
  try { body = data ? JSON.parse(data) : undefined; } catch { body = undefined; }
  return { type, body };
}

/** Connect to an SSE endpoint and resolve with the first event matching the
 *  predicate, or null on timeout. Aborts the stream when done. */
async function readSseEvent(
  url: string,
  predicate: (e: { type: string; body: any }) => boolean,
  timeoutMs = 3000,
): Promise<{ type: string; body: any } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = parseSseFrame(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (frame && predicate(frame)) return frame;
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) return null;
    throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  // Reset module-level larkAppId between tests so groups endpoints don't
  // leak state across describes.
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  setIpcAuthSecret(null);
  resetAskBrokerForTest();
  setExactChatGrantHandler(null);
  clearMessageListenerRunPreviewStore();
});

describe('dashboard IPC server', () => {
  it('writes bot-scoped chat feedback and returns an effective trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-feedback-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'feedback-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const prevDataDir = config.session.dataDir;
    try {
      process.env.BOTS_CONFIG = configPath;
      config.session.dataDir = dir;
      writeFileSync(configPath, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'secret', feedback: { enabled: true } }]));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const put = await fetch(`${base}/api/chat-feedback/chat-a`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feedback: { enabled: false } }) });
      expect(put.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0].chatFeedbackPolicies['chat-a']).toEqual({ enabled: false });
      const preview = await (await fetch(`${base}/api/feedback-effective?chatId=chat-a`)).json();
      expect(preview).toMatchObject({ ok: true, trace: { reason: 'disabled', effective: null, layers: { chat: { enabled: false } }, sources: { enabled: 'chat' } } });
    } finally {
      if (handle) await handle.close(); handle = null;
      config.session.dataDir = prevDataDir;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('binds to 127.0.0.1 and serves /__health', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/__health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for unknown route', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/nope`);
    expect(res.status).toBe(404);
  });

  it('binds and serves health early but holds authenticated state routes behind readiness', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    let releaseReady!: () => void;
    const ready = new Promise<void>(resolve => { releaseReady = resolve; });
    let mutations = 0;
    const path = '/api/test-startup-readiness-mutation';
    ipcRoute('POST', path, (_req, res) => {
      mutations += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      authRequired: true,
      ready,
    });
    const base = `http://127.0.0.1:${handle.port}`;

    const health = await fetch(`${base}/__health`);
    expect(health.status).toBe(200);
    const pending = fetch(`${base}${path}`, {
      method: 'POST',
      headers: trustedHostHeaders('POST', path, handle.port),
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mutations).toBe(0);

    releaseReady();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(mutations).toBe(1);
  });

  it('denies sandbox-like loopback reads and mutations but accepts route-bound trusted-host calls', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    let mutations = 0;
    const mutationPath = '/api/test-receiver-ipc-mutation';
    ipcRoute('POST', mutationPath, (_req, res) => {
      mutations += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const base = `http://127.0.0.1:${handle.port}`;

    const leakedRead = await fetch(`${base}/api/sessions`);
    expect(leakedRead.status).toBe(401);
    expect(mutations).toBe(0);

    const forgedMutation = await fetch(`${base}${mutationPath}`, { method: 'POST' });
    expect(forgedMutation.status).toBe(401);
    expect(mutations).toBe(0);

    const trustedRead = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port),
    });
    expect(trustedRead.status).toBe(200);

    const trustedMutation = await fetch(`${base}${mutationPath}`, {
      method: 'POST',
      headers: trustedHostHeaders('POST', mutationPath, handle.port),
    });
    expect(trustedMutation.status).toBe(200);
    expect(mutations).toBe(1);

    const wrongRoute = await fetch(`${base}${mutationPath}`, {
      method: 'POST',
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port),
    });
    expect(wrongRoute.status).toBe(401);
    expect(mutations).toBe(1);

    const rotatedSecret = 'test-ipc-secret-rotated-deadbeef';
    setIpcAuthSecret(rotatedSecret);
    const staleSecret = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port),
    });
    expect(staleSecret.status).toBe(401);
    const currentSecret = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, rotatedSecret),
    });
    expect(currentSecret.status).toBe(200);
  });
});

// The verifier's REAL on-disk secret read (ipcAuthSecret → loadDashboardSecret)
// — every other test injects the key via setIpcAuthSecret and never exercises
// this branch. This is a per-request verifier on ~96 daemon IPC routes; a
// symlinked / loose-perms `.dashboard-secret` planted after boot must not be
// followed and trusted as the HMAC key (it fails closed → 401), and a genuine
// 0600 secret must still authenticate. We point HOME at a temp dir so
// dashboardSecretPath() resolves there; loadDashboardSecret re-reads per call.
describe('IPC auth reads the on-disk dashboard secret through the secure primitive', () => {
  const REAL_SECRET = 'real-ondisk-ipc-secret-cafebabe';
  let home: string;
  let botmuxDir: string;
  let secretPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Force the disk path (no injected override) for this whole describe.
    setIpcAuthSecret(null);
    home = mkdtempSync(join(tmpdir(), 'bmx-ipc-home-'));
    botmuxDir = join(home, '.botmux');
    mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
    secretPath = join(botmuxDir, '.dashboard-secret');
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    // Loosen back to a removable shape before rm (a 0700 dir is fine here).
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('authenticates a valid trusted-host signature against a real 0600 secret', async () => {
    writeFileSync(secretPath, REAL_SECRET, { mode: 0o600 });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const base = `http://127.0.0.1:${handle.port}`;

    const authed = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, REAL_SECRET),
    });
    expect(authed.status).toBe(200);

    const wrongKey = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, 'not-the-secret'),
    });
    expect(wrongKey.status).toBe(401);
  });

  it('fails closed (401) when the secret leaf is a symlink, without following it', async () => {
    if (process.platform === 'win32') return;
    // A local attacker who can write ~/.botmux plants a symlink to content they
    // know; the secure reader must refuse it rather than sign with that value.
    const planted = join(home, 'attacker-known');
    writeFileSync(planted, REAL_SECRET, { mode: 0o600 });
    symlinkSync(planted, secretPath);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const base = `http://127.0.0.1:${handle.port}`;

    // Even signing with the exact planted content is rejected: the leaf is a
    // symlink, so its value is never loaded as the HMAC key.
    const forged = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, REAL_SECRET),
    });
    expect(forged.status).toBe(401);
    // The symlink target is untouched.
    expect(readFileSync(planted, 'utf8')).toBe(REAL_SECRET);
  });

  it('fails closed (401) when the secret file has loose (0644) permissions', async () => {
    if (process.platform === 'win32') return;
    writeFileSync(secretPath, REAL_SECRET, { mode: 0o644 });
    chmodSync(secretPath, 0o644);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const base = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, REAL_SECRET),
    });
    expect(res.status).toBe(401);
  });

  it('fails closed (401) when the secret is absent', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const base = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${base}/api/sessions`, {
      headers: trustedHostHeaders('GET', '/api/sessions', handle.port, REAL_SECRET),
    });
    expect(res.status).toBe(401);
  });
});

describe('Desktop ask IPC', () => {
  it('keeps pending asks behind the trusted-host boundary', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}`;

    const pending = await fetch(`${base}/api/asks/pending`);
    expect(pending.status).toBe(403);
    expect(await pending.json()).toEqual({ ok: false, error: 'trusted_host_required' });

    const answer = await fetch(`${base}/api/asks/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ askId: 'unknown', selections: [['yes']] }),
    });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ ok: false, error: 'trusted_host_required' });
  });

  it('lists and answers only the selected daemon ask with validated selections', async () => {
    setCardDispatcher({ send: async () => ({ messageId: 'om_dashboard_ask' }) });
    const result = registerAsk({
      larkAppId: 'app-one',
      chatId: 'oc-chat',
      rootMessageId: 'om-root',
      sessionId: 'session-one',
      questions: [{
        prompt: '继续吗？',
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '停止' },
        ],
        multiSelect: false,
      }],
      timeoutMs: 30_000,
    });
    const [askId] = _allAskIds();
    expect(askId).toBeTruthy();

    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      authRequired: true,
    });
    const base = `http://127.0.0.1:${handle.port}`;

    const pendingPath = '/api/asks/pending';
    const pending = await fetch(`${base}${pendingPath}`, {
      headers: trustedHostHeaders('GET', pendingPath, handle.port),
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      asks: [{
        askId,
        sessionId: 'session-one',
        larkAppId: 'app-one',
      }],
    });

    const answerPath = '/api/asks/answer';
    const invalid = await fetch(`${base}${answerPath}`, {
      method: 'POST',
      headers: {
        ...trustedHostHeaders('POST', answerPath, handle.port),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ askId, selections: [[]] }),
    });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ ok: false, error: 'stale' });

    const accepted = await fetch(`${base}${answerPath}`, {
      method: 'POST',
      headers: {
        ...trustedHostHeaders('POST', answerPath, handle.port),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ askId, selections: [['yes']], by: 'desktop' }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, outcome: 'accepted' });
    await expect(result).resolves.toMatchObject({
      kind: 'answered',
      answers: [['yes']],
      by: 'desktop',
    });

    const duplicate = await fetch(`${base}${answerPath}`, {
      method: 'POST',
      headers: {
        ...trustedHostHeaders('POST', answerPath, handle.port),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ askId, selections: [['yes']] }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ ok: false, error: 'already_settled' });
  });
});

describe('POST /api/session-origin/attest', () => {
  const CHANNEL = '77'.repeat(32);
  const CAPABILITY = 'ab'.repeat(32);
  const TURN_ID = 'turn-managed-origin';
  const DISPATCH_ATTEMPT = 3;

  function installManagedOriginFixture(options: {
    worker?: Record<string, unknown> | null;
    origin?: Record<string, unknown> | null;
    ledger?: unknown[];
  } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-origin-attest-'));
    const previousDataDir = config.session.dataDir;
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    const sessionId = `origin-attest-${randomBytes(8).toString('hex')}`;
    const defaultWorker = {
      pid: process.pid,
      connected: true,
      killed: false,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
    };
    const defaultOrigin = {
      capability: CAPABILITY,
      originChannelId: CHANNEL,
      turnId: TURN_ID,
      dispatchAttempt: DISPATCH_ATTEMPT,
    };
    const worker = options.worker === null
      ? null
      : { ...defaultWorker, ...(options.worker ?? {}) };
    const managedTurnOrigin = options.origin === null
      ? undefined
      : { ...defaultOrigin, ...(options.origin ?? {}) };
    const session = {
      sessionId,
      cliId: 'codex-app',
      codexAppDispatchLedger: options.ledger ?? [{
        dispatchId: 'dispatch-managed-origin',
        turnId: TURN_ID,
        dispatchAttempt: DISPATCH_ATTEMPT,
        state: 'prepared',
        content: 'prompt',
        deliverySink: 'lark',
      }],
    };
    const active = {
      session,
      worker,
      managedTurnOrigin,
      initConfig: { cliId: 'codex-app' },
      larkAppId: 'app-managed-origin',
    } as any;
    config.session.dataDir = dataDir;
    workerPool.setActiveSessionsRegistry(new Map([[sessionId, active]]));

    return {
      active,
      dataDir,
      sessionId,
      proofPath: (nonce: string, channelId = CHANNEL) =>
        managedOriginAttestationProofPath(dataDir, sessionId, channelId, nonce),
      cleanup: () => {
        workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
        config.session.dataDir = previousDataDir;
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }

  async function postAttestation(
    port: number,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/session-origin/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('writes an exact nonce/channel/turn/ledger proof only for the live worker capability', async () => {
    const fixture = installManagedOriginFixture();
    const nonce = 'cd'.repeat(32);
    const issuedAfter = Date.now();
    try {
      setIpcAuthSecret(TEST_IPC_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const res = await postAttestation(handle.port, {
        sessionId: fixture.sessionId,
        channelId: CHANNEL,
        originCapability: CAPABILITY,
        nonce,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const path = fixture.proofPath(nonce);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const proof = JSON.parse(readFileSync(path, 'utf8'));
      expect(proof).toMatchObject({
        domain: MANAGED_ORIGIN_PROOF_DOMAIN,
        version: 1,
        nonce,
        channelId: CHANNEL,
        sessionId: fixture.sessionId,
        turnId: TURN_ID,
        dispatchAttempt: DISPATCH_ATTEMPT,
        requiresCodexAppLedger: true,
      });
      expect(proof.issuedAtMs).toBeGreaterThanOrEqual(issuedAfter);
      expect(proof.issuedAtMs).toBeLessThanOrEqual(Date.now());
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects missing, disconnected, or dead exact workers without writing a proof', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const cases = [
      { name: 'missing', worker: null },
      { name: 'disconnected', worker: { connected: false } },
      { name: 'dead', worker: { pid: undefined } },
    ] as const;
    for (const candidate of cases) {
      const fixture = installManagedOriginFixture({ worker: candidate.worker });
      const nonce = randomBytes(32).toString('hex');
      try {
        const res = await postAttestation(handle.port, {
          sessionId: fixture.sessionId,
          channelId: CHANNEL,
          originCapability: CAPABILITY,
          nonce,
        });
        expect(res.status, candidate.name).toBe(403);
        expect(await res.json(), candidate.name).toEqual({ ok: false, error: 'origin_unproven' });
        expect(existsSync(fixture.proofPath(nonce)), candidate.name).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('rejects a wrong rotating capability without writing a proof', async () => {
    const fixture = installManagedOriginFixture();
    const nonce = 'de'.repeat(32);
    try {
      setIpcAuthSecret(TEST_IPC_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const res = await postAttestation(handle.port, {
        sessionId: fixture.sessionId,
        channelId: CHANNEL,
        originCapability: 'ef'.repeat(32),
        nonce,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
      expect(existsSync(fixture.proofPath(nonce))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a missing or malformed live authority channel without writing a proof', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const cases = [
      { name: 'missing', originChannelId: undefined },
      { name: 'malformed', originChannelId: 'not-a-channel' },
    ] as const;
    for (const candidate of cases) {
      const fixture = installManagedOriginFixture({
        origin: { originChannelId: candidate.originChannelId },
      });
      const nonce = randomBytes(32).toString('hex');
      try {
        const res = await postAttestation(handle.port, {
          sessionId: fixture.sessionId,
          channelId: CHANNEL,
          originCapability: CAPABILITY,
          nonce,
        });
        expect(res.status, candidate.name).toBe(403);
        expect(await res.json(), candidate.name).toEqual({
          ok: false,
          error: 'origin_channel_unproven',
        });
        expect(existsSync(fixture.proofPath(nonce)), candidate.name).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('rejects a missing, malformed, or non-matching claimed channel without writing a proof', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const cases = [
      { name: 'missing', channelId: undefined, status: 400, error: 'bad_attestation_request' },
      { name: 'malformed', channelId: 'not-a-channel', status: 400, error: 'bad_attestation_request' },
      { name: 'non-matching', channelId: '88'.repeat(32), status: 403, error: 'origin_channel_unproven' },
    ] as const;
    for (const candidate of cases) {
      const fixture = installManagedOriginFixture();
      const nonce = randomBytes(32).toString('hex');
      try {
        const res = await postAttestation(handle.port, {
          sessionId: fixture.sessionId,
          ...(candidate.channelId === undefined ? {} : { channelId: candidate.channelId }),
          originCapability: CAPABILITY,
          nonce,
        });
        expect(res.status, candidate.name).toBe(candidate.status);
        expect(await res.json(), candidate.name).toEqual({
          ok: false,
          error: candidate.error,
        });
        expect(existsSync(fixture.proofPath(nonce)), candidate.name).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('rejects missing or non-exact Codex App ledger ownership without writing a proof', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const cases = [
      { name: 'missing', ledger: [] },
      {
        name: 'wrong-turn',
        ledger: [{
          dispatchId: 'dispatch-wrong-turn',
          turnId: 'turn-other',
          dispatchAttempt: DISPATCH_ATTEMPT,
          state: 'prepared',
          content: 'prompt',
          deliverySink: 'lark',
        }],
      },
      {
        name: 'wrong-attempt',
        ledger: [{
          dispatchId: 'dispatch-wrong-attempt',
          turnId: TURN_ID,
          dispatchAttempt: DISPATCH_ATTEMPT + 1,
          state: 'prepared',
          content: 'prompt',
          deliverySink: 'lark',
        }],
      },
    ];
    for (const candidate of cases) {
      const fixture = installManagedOriginFixture({ ledger: candidate.ledger });
      const nonce = randomBytes(32).toString('hex');
      try {
        const res = await postAttestation(handle.port, {
          sessionId: fixture.sessionId,
          channelId: CHANNEL,
          originCapability: CAPABILITY,
          nonce,
        });
        expect(res.status, candidate.name).toBe(409);
        expect(await res.json(), candidate.name).toEqual({
          ok: false,
          error: 'origin_not_sendable',
        });
        expect(existsSync(fixture.proofPath(nonce)), candidate.name).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('rejects an oversized unauthenticated body before capability lookup and writes no proof', async () => {
    const fixture = installManagedOriginFixture();
    const nonce = 'f0'.repeat(32);
    try {
      setIpcAuthSecret(TEST_IPC_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const res = await postAttestation(handle.port, {
        sessionId: fixture.sessionId,
        channelId: CHANNEL,
        originCapability: CAPABILITY,
        nonce,
        padding: 'x'.repeat(3_000),
      });

      expect(res.status).toBe(413);
      expect(res.headers.get('connection')).toBe('close');
      expect(await res.json()).toEqual({ ok: false, error: 'body_too_large' });
      expect(existsSync(fixture.proofPath(nonce))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('times out a slow partial unauthenticated body and writes no proof', async () => {
    const fixture = installManagedOriginFixture();
    const nonce = 'f1'.repeat(32);
    try {
      setIpcAuthSecret(TEST_IPC_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const result = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: handle!.port,
          path: '/api/session-origin/attest',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.once('error', reject);
        // Send a complete JSON value but deliberately omit the terminating
        // chunk, exercising the pre-auth slow-body deadline.
        req.write(JSON.stringify({
          sessionId: fixture.sessionId,
          channelId: CHANNEL,
          originCapability: CAPABILITY,
          nonce,
        }));
      });

      expect(result.status).toBe(408);
      expect(result.headers.connection).toBe('close');
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'body_timeout' });
      expect(existsSync(fixture.proofPath(nonce))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 5_000);
});

describe('PUT /api/bot-card-prefs — Codex App clean history', () => {
  it('is default-off and persists explicit on/off changes immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-codex-clean-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-codex-clean-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex-app',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial.codexAppCleanInput).toBe(false);

      const on = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codexAppCleanInput: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ ok: true, codexAppCleanInput: true });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].codexAppCleanInput).toBe(true);

      const off = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codexAppCleanInput: false }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ ok: true, codexAppCleanInput: false });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].codexAppCleanInput).toBeUndefined();
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-card-prefs — 入群 seed 文案与内置默认一致时不落盘', () => {
  // 编辑态软预填把「当前生效的内置默认」直接填进输入框，所以一次顺手的保存会把
  // bot 从「跟随动态默认」钉死成「锁定这一版文案」（升级不再跟上、切 locale 仍发
  // 旧语言那句），而 UI 上两种状态几乎无法区分。归一化必须发生在写盘之前。
  it('归一化：等于内置默认 → 存空（跟随默认）；真自定义 → 原样落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-join-seed-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-join-seed-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      // 服务端自报当前 locale 下的内置默认，避免把文案字面量写死在断言里
      // （改文案 / 换 locale 都不该让这条用例失真）。
      const oncall = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      const builtin: string = oncall.autoStartOnGroupJoinSeedDefault;
      expect(typeof builtin).toBe('string');
      expect(builtin.length).toBeGreaterThan(0);

      const putSeed = async (autoStartOnGroupJoinSeed: string) => {
        const r = await fetch(`${base}/api/bot-card-prefs`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoStartOnGroupJoinSeed }),
        });
        expect(r.status).toBe(200);
        return r.json();
      };
      const persisted = () => JSON.parse(readFileSync(configPath, 'utf-8'))[0].autoStartOnGroupJoinSeed;

      // 1) 软预填原样回存（内容 === 内置默认）→ 视作未自定义，键不落盘。
      expect(await putSeed(builtin)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
      expect(persisted()).toBeUndefined();
      expect(getBot(appId).config.autoStartOnGroupJoinSeed).toBeUndefined();

      // 2) 真正的自定义文案照常落盘（归一化不能误伤这一侧）。
      const custom = `${builtin} —— 值班中`;
      expect(await putSeed(custom)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: custom });
      expect(persisted()).toBe(custom);
      expect(getBot(appId).config.autoStartOnGroupJoinSeed).toBe(custom);

      // 3) 已自定义后再存一次软预填值 → 清回跟随默认（与「恢复默认」同义）。
      expect(await putSeed(builtin)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
      expect(persisted()).toBeUndefined();

      // 4) 仅首尾空白之差也算「等于默认」，否则一个不可见空格就把 bot 钉死。
      await putSeed(custom);
      expect(persisted()).toBe(custom);
      expect(await putSeed(`  ${builtin}  `)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
      expect(persisted()).toBeUndefined();

      // 5) GET 之后 bot locale 被改掉（/config lang 立即生效、不发 bots.changed，
      //    本页不会重拉），页面里的软预填仍是旧语言那句。此时保存必须仍判为
      //    「未自定义」——否则 accidental pin 只是从「任何时候」收窄成 locale
      //    时序窗口，而窗口内钉死的还是一句用户没打算自定义的旧语言文案。
      const { localeForBot, t } = await import('../src/i18n/index.js');
      const before = localeForBot(appId);
      getBot(appId).config.lang = before === 'en' ? 'zh' : 'en';
      try {
        const switched = t('daemon.auto_start_join_seed', undefined, localeForBot(appId));
        expect(switched).not.toBe(builtin); // 前提：两种 locale 的默认确实不同
        const r = await fetch(`${base}/api/bot-card-prefs`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          // 前端提交的是页面当时预填的旧语言默认 + 它自报的 seedDefault
          body: JSON.stringify({
            autoStartOnGroupJoinSeed: builtin,
            autoStartOnGroupJoinSeedDefault: builtin,
          }),
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
        expect(persisted()).toBeUndefined();

        // 同一时序下，真正的自定义文案仍须原样落盘（修法不能顺手放行一切）。
        const stillCustom = `${builtin} —— 切 locale 后仍是自定义`;
        const r2 = await fetch(`${base}/api/bot-card-prefs`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            autoStartOnGroupJoinSeed: stillCustom,
            autoStartOnGroupJoinSeedDefault: builtin,
          }),
        });
        expect(r2.status).toBe(200);
        expect(persisted()).toBe(stillCustom);
        await putSeed(switched); // 清回跟随默认，避免污染后续断言
        expect(persisted()).toBeUndefined();
      } finally {
        getBot(appId).config.lang = before;
      }

      // 6) 旧客户端兼容：请求体完全不带 seedDefault（旧前端 / 脚本 / curl）时，
      //    退回「与服务端当刻默认比较」，行为与引入该字段之前一致。
      const legacyPut = async (v: string) => {
        const r = await fetch(`${base}/api/bot-card-prefs`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoStartOnGroupJoinSeed: v }),
        });
        expect(r.status).toBe(200);
        return r.json();
      };
      expect(await legacyPut(builtin)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
      expect(persisted()).toBeUndefined();
      expect(await legacyPut(custom)).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: custom });
      expect(persisted()).toBe(custom);
      // 旧客户端清空（空串）仍是「恢复默认」，不因新分支改变语义。
      expect(await legacyPut('')).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: '' });
      expect(persisted()).toBeUndefined();

      // 7) seedDefault 是非字符串（脏输入）时不得抛错，按缺失处理。
      //    seed 必须【不等于】服务端默认，否则 `||` 左侧先为真就短路，右侧那次
      //    presentedDefault.trim() 根本不求值，这一格就测不到脏输入（实测过：
      //    用 builtin 当 seed 时，去掉 typeof 守卫仍然全绿）。
      const dirty = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoStartOnGroupJoinSeed: custom, autoStartOnGroupJoinSeedDefault: 42 }),
      });
      expect(dirty.status).toBe(200);
      expect(await dirty.json()).toMatchObject({ ok: true, autoStartOnGroupJoinSeed: custom });
      expect(persisted()).toBe(custom);
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-card-prefs — pin streaming card', () => {
  it('is default-off, preserves unrelated partial patches, and rejects non-boolean writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-pin-streaming-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-pin-streaming-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial.pinStreamingCard).toBe(false);

      const on = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinStreamingCard: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ ok: true, pinStreamingCard: true });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].pinStreamingCard).toBe(true);
      expect((await (await fetch(`${base}/api/bot-default-oncall`)).json()).pinStreamingCard).toBe(true);

      const unrelated = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ silentTurnReactions: true }),
      });
      expect(unrelated.status).toBe(200);
      expect(await unrelated.json()).toMatchObject({
        ok: true,
        silentTurnReactions: true,
        pinStreamingCard: true,
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].pinStreamingCard).toBe(true);
      expect((await (await fetch(`${base}/api/bot-default-oncall`)).json()).pinStreamingCard).toBe(true);

      const off = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinStreamingCard: false }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ ok: true, pinStreamingCard: false });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].pinStreamingCard).toBeUndefined();
      expect((await (await fetch(`${base}/api/bot-default-oncall`)).json()).pinStreamingCard).toBe(false);

      const bogus = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinStreamingCard: 'true' }),
      });
      expect(bogus.status).toBe(400);
      expect(await bogus.json()).toMatchObject({ ok: false, error: 'no_valid_fields' });
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns promptly even when hot reconciliation throws or remains pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-pin-streaming-async-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-pin-streaming-async-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const change = await import('../src/services/pin-streaming-card-change.js');
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const disposeThrow = change.registerPinStreamingCardChangeHandler(() => {
        throw new Error('reconcile failed after write');
      });
      const throwRes = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinStreamingCard: true }),
      });
      disposeThrow();
      expect(throwRes.status).toBe(200);
      expect(await throwRes.json()).toMatchObject({ ok: true, pinStreamingCard: true });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].pinStreamingCard).toBe(true);

      let release!: () => void;
      const disposePending = change.registerPinStreamingCardChangeHandler(() => {
        void new Promise<void>((resolve) => { release = resolve; });
      });
      const pendingRes = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinStreamingCard: false }),
      });
      disposePending();
      expect(pendingRes.status).toBe(200);
      expect(await pendingRes.json()).toMatchObject({ ok: true, pinStreamingCard: false });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].pinStreamingCard).toBeUndefined();
      release();
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-card-prefs — summary memory', () => {
  it('surfaces the persisted memory toggle and path in the Bot Defaults refresh payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-summary-memory-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-summary-memory-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial).toMatchObject({
        summaryMemory: false,
        summaryMemoryPath: 'summary.md',
      });

      const on = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          summaryMemory: true,
          summaryMemoryPath: 'docs/summary.md',
        }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({
        ok: true,
        summaryMemory: true,
        summaryMemoryPath: 'docs/summary.md',
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        summaryMemory: true,
        summaryMemoryPath: 'docs/summary.md',
      });

      const refreshed = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(refreshed).toMatchObject({
        summaryMemory: true,
        summaryMemoryPath: 'docs/summary.md',
      });
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-card-prefs — senderTag (<sender> 注入开关)', () => {
  it('defaults ON, persists only an explicit false, and clears the key when turned back on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-sender-tag-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-sender-tag-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      // Absent key ⇒ ON, so an untouched bot keeps injecting the tag.
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ senderTag: true });

      const off = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senderTag: false }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ ok: true, senderTag: false });
      // Only the non-default state is written to disk.
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({ senderTag: false });
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ senderTag: false });

      const on = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senderTag: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ ok: true, senderTag: true });
      // Back to default ⇒ the key is REMOVED rather than stored as true, so
      // bots.json stays free of redundant defaults.
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].senderTag).toBeUndefined();
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-grant-prefs — p2pOpen (私聊对话全开)', () => {
  it('surfaces it in the Bot Defaults payload and persists explicit on/off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-p2p-open-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-p2p-open-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        allowedUsers: ['ou_owner'],
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial.p2pOpen).toBe(false);

      const on = await fetch(`${base}/api/bot-grant-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ p2pOpen: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ ok: true, p2pOpen: true });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].p2pOpen).toBe(true);
      expect((await (await fetch(`${base}/api/bot-default-oncall`)).json()).p2pOpen).toBe(true);

      const off = await fetch(`${base}/api/bot-grant-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ p2pOpen: false }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ ok: true, p2pOpen: false });
      // Off = key deleted (缺省即关闭)，bots.json 保持干净。
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].p2pOpen).toBeUndefined();

      // Non-boolean must not reach the store: it is dropped, so a body carrying
      // only a bogus p2pOpen is rejected as "no valid fields" (no silent write).
      const bogus = await fetch(`${base}/api/bot-grant-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ p2pOpen: 'yes' }),
      });
      expect(bogus.status).toBe(400);
      expect(await bogus.json()).toMatchObject({ ok: false, error: 'no_valid_fields' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].p2pOpen).toBeUndefined();
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT/GET /api/message-listeners/:chatId — disabled draft persistence (Bug2: 二刷消失)', () => {
  it('persists a disabled listener that still has a prompt, and GET returns it after reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-listener-draft-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-listener-draft-app';
    const chatId = 'oc_draft_chat';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      // Save with the toggle OFF but a real prompt typed in — the exact action
      // that used to silently drop everything.
      const put = await fetch(`${base}/api/message-listeners/${chatId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, name: '告警监听草稿', prompt: '分析命中的告警消息' }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json();
      expect(putBody).toMatchObject({ ok: true });
      expect(putBody.listener).toMatchObject({ enabled: false, prompt: '分析命中的告警消息', name: '告警监听草稿' });

      // It must survive on disk (this is what the reload reads back).
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'))[0].messageListeners?.[chatId];
      expect(persisted).toBeTruthy();
      expect(persisted.enabled).toBe(false);
      expect(persisted.prompt).toBe('分析命中的告警消息');

      // GET (the "二刷" / reload) returns the draft, not null.
      const get = await (await fetch(`${base}/api/message-listeners/${chatId}`)).json();
      expect(get.listener).toMatchObject({ enabled: false, prompt: '分析命中的告警消息', name: '告警监听草稿' });
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the entry when a disabled update carries a blank prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-listener-clear-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-listener-clear-app';
    const chatId = 'oc_clear_chat';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude',
        messageListeners: {
          [chatId]: { enabled: true, prompt: '旧配置', messagePolicy: { scope: 'top_level' }, replyPolicy: { mode: 'thread', sessionMode: 'per_message' } },
        },
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const put = await fetch(`${base}/api/message-listeners/${chatId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, prompt: '   ' }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, listener: null });
      // Entry removed from disk, and (being the only one) messageListeners dropped.
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].messageListeners).toBeUndefined();
      const get = await (await fetch(`${base}/api/message-listeners/${chatId}`)).json();
      expect(get.listener).toBeNull();
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-card-prefs — reply-card usage display mode', () => {
  it('defaults to streaming and persists explicit footer/off changes immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-usage-display-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-usage-display-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial.usageDisplay).toBe('streaming');

      const footer = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usageDisplay: 'footer' }),
      });
      expect(footer.status).toBe(200);
      expect(await footer.json()).toMatchObject({ ok: true, usageDisplay: 'footer' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].usageDisplay).toBe('footer');
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ usageDisplay: 'footer' });

      // Back to the default 'streaming' → key dropped, GET reflects the default.
      const streaming = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usageDisplay: 'streaming' }),
      });
      expect(streaming.status).toBe(200);
      expect(await streaming.json()).toMatchObject({ ok: true, usageDisplay: 'streaming' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].usageDisplay).toBeUndefined();
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ usageDisplay: 'streaming' });

      // 'off' persists verbatim.
      const off = await fetch(`${base}/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usageDisplay: 'off' }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ ok: true, usageDisplay: 'off' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].usageDisplay).toBe('off');
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-reply-style — sparse reply-card appearance', () => {
  it('persists normalized overrides, hot-updates GET, and clears the default block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-reply-style-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-reply-style-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'must-not-leak',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const put = await fetch(`${base}/api/bot-reply-style`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replyStyle: {
            recipes: false,
            layout: true,
            theme: 'vivid',
            recipePrompt: '  风险优先  ',
            layoutColors: { result: 'turquoise', blocked: 'laser', handoff: 'grey' },
            layoutTags: { result: '', risk: '请确认', progress: 42 },
          },
        }),
      });
      expect(put.status).toBe(200);
      const body = await put.json();
      expect(body).toMatchObject({
        ok: true,
        replyStyle: {
          recipes: false,
          theme: 'vivid',
          recipePrompt: '风险优先',
          layoutColors: { result: 'turquoise' },
          layoutTags: { result: '', risk: '请确认' },
        },
      });
      expect(body.warnings).toHaveLength(3);
      expect(body).not.toHaveProperty('larkAppSecret');

      const disk = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(disk.replyStyle).toEqual(body.replyStyle);
      expect(disk.larkAppSecret).toBe('must-not-leak');
      expect((getBot(appId).config as any).replyStyle).toEqual(body.replyStyle);
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ replyStyle: body.replyStyle });

      const overLimit = await fetch(`${base}/api/bot-reply-style`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replyStyle: {
            recipes: false,
            recipePrompt: '配'.repeat(REPLY_RECIPE_PROMPT_MAX_CODEPOINTS + 1),
            layoutTags: {
              risk: '签'.repeat(REPLY_LAYOUT_TAG_MAX_CODEPOINTS + 1),
              blocked: '请处理',
            },
          },
        }),
      });
      expect(overLimit.status).toBe(200);
      expect(await overLimit.json()).toMatchObject({
        ok: true,
        replyStyle: { recipes: false, layoutTags: { blocked: '请处理' } },
        warnings: [expect.stringContaining('recipePrompt'), expect.stringContaining('layoutTags.risk')],
      });

      for (const replyStyle of [[], 'primitive', 42]) {
        const invalidReplyStyle = await fetch(`${base}/api/bot-reply-style`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replyStyle }),
        });
        expect(invalidReplyStyle.status, JSON.stringify(replyStyle)).toBe(400);
        expect(await invalidReplyStyle.json())
          .toMatchObject({ ok: false, error: 'invalid_body' });
        expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].replyStyle)
          .toEqual({ recipes: false, layoutTags: { blocked: '请处理' } });
      }

      const clear = await fetch(`${base}/api/bot-reply-style`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replyStyle: null }),
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toMatchObject({ ok: true, replyStyle: null });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].replyStyle).toBeUndefined();
      expect(await (await fetch(`${base}/api/bot-default-oncall`)).json())
        .toMatchObject({ replyStyle: null });

      for (const raw of ['null', '[]', '"primitive"', '{}', '{"replyStyle":null,"extra":true}']) {
        const invalid = await fetch(`${base}/api/bot-reply-style`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        expect(invalid.status, raw).toBe(400);
        expect(await invalid.json()).toMatchObject({ ok: false, error: 'invalid_body' });
      }

      const oversized = await fetch(`${base}/api/bot-reply-style`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replyStyle: { recipePrompt: 'x'.repeat(REPLY_STYLE_REQUEST_MAX_BYTES) } }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ ok: false, error: 'body_too_large' });
    } finally {
      if (handle) await handle.close();
      handle = null;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/grants/chat', () => {
  it('requires loopback HMAC before invoking the permission service', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer'],
      }),
    });
    expect(res.status).toBe(401);

    const bareLegacyHmac = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders() },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer'],
      }),
    });
    expect(bareLegacyHmac.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 503 when the daemon receiver identity is not ready', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId('');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer'],
      }),
    });
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the daemon identity as source-of-truth and rejects stale descriptor routing', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId('cli_actual_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_stale_descriptor',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer'],
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'receiver_mismatch' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards only the daemon receiver and preserves explicit talk-only output', async () => {
    const handler = vi.fn(async (input: any) => ({
      ok: true as const,
      operation: 'grant' as const,
      permissionSource: 'chatGrant' as const,
      talkOnly: true as const,
      receiverLarkAppId: input.receiverLarkAppId,
      chatId: input.chatId,
      grantsTalk: true,
      grantsOperate: false as const,
      subjects: [{
        subjectOpenId: input.subjectOpenIds[0],
        chatGrantActive: true,
        changed: true,
        grantsTalk: true,
        grantsOperate: false as const,
      }],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_peer'],
      }),
    });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectOpenIds: ['ou_peer'],
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      talkOnly: true,
      grantsTalk: true,
      grantsOperate: false,
      subjects: [{ subjectOpenId: 'ou_peer', chatGrantActive: true }],
    });
  });

  it('accepts stable subject app ids and returns the receiver-side identity mapping', async () => {
    const handler = vi.fn(async (input: any) => ({
      ok: true as const,
      operation: 'grant' as const,
      permissionSource: 'chatGrant' as const,
      talkOnly: true as const,
      receiverLarkAppId: input.receiverLarkAppId,
      chatId: input.chatId,
      grantsTalk: true,
      grantsOperate: false as const,
      subjectMappings: [{ larkAppId: input.subjectLarkAppIds[0], subjectOpenId: 'ou_pm_seen_by_receiver' }],
      subjects: [{
        subjectOpenId: 'ou_pm_seen_by_receiver',
        chatGrantActive: true,
        changed: true,
        grantsTalk: true,
        grantsOperate: false as const,
      }],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectLarkAppIds: ['cli_pm'],
      }),
    });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      talkOnly: true,
      grantsOperate: false,
      subjectMappings: [{ larkAppId: 'cli_pm', subjectOpenId: 'ou_pm_seen_by_receiver' }],
    });
  });

  it('requires exactly one subject identity form before invoking the permission service', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${handle.port}/api/grants/chat`;
    const bind = cliAuthBind('POST', '/api/grants/chat', handle.port);

    for (const subjects of [
      {},
      { subjectOpenIds: ['ou_peer'], subjectLarkAppIds: ['cli_peer'] },
    ]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, bind) },
        body: JSON.stringify({
          operation: 'grant',
          receiverLarkAppId: 'cli_receiver',
          chatId: 'oc_chat',
          ...subjects,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'exactly_one_subject_identity_required' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects stable subject app ids for revoke or readback before invoking the service', async () => {
    const handler = vi.fn();
    setExactChatGrantHandler(handler as any);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'revoke',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectLarkAppIds: ['cli_pm'],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'subject_lark_app_ids_grant_only' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes through stable identity failures without exposing the internal status field', async () => {
    const handler = vi.fn(async () => ({
      ok: false as const,
      status: 409,
      error: 'subject_lark_app_ambiguous',
      message: 'ambiguous bot_name',
      invalidSubjectLarkAppIds: ['cli_pm'],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectLarkAppIds: ['cli_pm'],
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: 'subject_lark_app_ambiguous',
      invalidSubjectLarkAppIds: ['cli_pm'],
    });
    expect(body).not.toHaveProperty('status');
  });

  it('passes through service failure status without exposing the internal status field', async () => {
    const handler = vi.fn(async () => ({
      ok: false as const,
      status: 409,
      error: 'subject_not_current_chat_bot',
      message: 'not current',
      invalidSubjectOpenIds: ['ou_stale'],
    }));
    setExactChatGrantHandler(handler);
    setLarkAppId('cli_receiver');
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/grants/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenAuthHeaders(TEST_IPC_SECRET, cliAuthBind('POST', '/api/grants/chat', handle.port)) },
      body: JSON.stringify({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectOpenIds: ['ou_stale'],
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'subject_not_current_chat_bot' });
    expect(body).not.toHaveProperty('status');
  });
});

describe('GET /api/sessions', () => {
  it('returns array shape (sessions: Row[])', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('shows an unregistered quarantined active row as dormant in list and detail', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-quarantined-'));
    const prevConfigDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    try {
      config.session.dataDir = dataDir;
      sessionStore.init('cli_quarantined');
      workerPool.setActiveSessionsRegistry(registry);

      const session = sessionStore.createSession('oc_quarantined', 'om_quarantined', '待确认清理', 'group');
      session.larkAppId = 'cli_quarantined';
      session.scope = 'thread';
      session.cliId = 'codex' as any;
      session.backendType = 'zmx';
      session.restoreQuarantinedAt = '2026-07-31T00:00:00.000Z';
      sessionStore.updateSession(session);

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const listRes = await fetch(`${base}/api/sessions`);
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()).sessions.find((row: any) => row.sessionId === session.sessionId);
      expect(listed).toMatchObject({
        sessionId: session.sessionId,
        status: 'dormant',
        quarantined: true,
        backendType: 'zmx',
        webPort: null,
      });
      expect(listed).not.toHaveProperty('closedAt');

      const detailRes = await fetch(`${base}/api/sessions/${session.sessionId}`);
      expect(detailRes.status).toBe(200);
      expect((await detailRes.json()).session).toMatchObject({
        sessionId: session.sessionId,
        status: 'dormant',
        quarantined: true,
      });
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/sessions/:sessionId', () => {
  it('returns 404 for unknown sessionId', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/nonexistent-id`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/:sessionId/usage', () => {
  it('returns the daemon-cached native usage snapshot for an active Session', async () => {
    const ds = { session: { sessionId: 's-usage' } } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const usageSpy = vi.spyOn(workerPool, 'getDaemonReplyCardUsageSnapshot').mockReturnValue({
      context: { usedTokens: 12_345, windowTokens: 100_000, percentUsed: 12 },
      tokens: { in: 67_890, out: 123 },
    });
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-usage/usage`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        usage: {
          context: { usedTokens: 12_345, windowTokens: 100_000, percentUsed: 12 },
          tokens: { in: 67_890, out: 123 },
        },
      });
      expect(usageSpy).toHaveBeenCalledWith(ds);
    } finally {
      findSpy.mockRestore();
      usageSpy.mockRestore();
    }
  });

  it('returns the card-specific empty snapshot when footer usage is disabled', async () => {
    const ds = { session: { sessionId: 's-usage-hidden' } } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const rawSpy = vi.spyOn(workerPool, 'getDaemonSessionUsageSnapshot').mockReturnValue({
      context: { usedTokens: 12_345 },
      tokens: { in: 67_890, out: 123 },
    });
    const cardSpy = vi.spyOn(workerPool, 'getDaemonReplyCardUsageSnapshot').mockReturnValue({
      context: null,
      tokens: null,
    });
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/sessions/s-usage-hidden/usage`,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        usage: { context: null, tokens: null },
      });
      expect(cardSpy).toHaveBeenCalledWith(ds);
      expect(rawSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      rawSpy.mockRestore();
      cardSpy.mockRestore();
    }
  });

  it('returns 404 when the Session is not active', async () => {
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/missing/usage`);
      expect(res.status).toBe(404);
    } finally {
      findSpy.mockRestore();
    }
  });
});

describe('POST /api/sessions/:sessionId/rename', () => {
  it('updates the canonical title and requests native sync from a live Codex worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-session-rename-'));
    const prevDataDir = config.session.dataDir;
    const events: any[] = [];
    const off = dashboardEventBus.subscribe(event => events.push(event));
    const send = vi.fn();
    let findSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      const session = sessionStore.createSession('oc_rename', 'om_rename', 'Old title', 'group');
      session.cliId = 'codex';
      session.cliPathOverride = '/bin/codex';
      session.backendType = 'tmux';
      sessionStore.updateSession(session);

      const active = {
        session,
        worker: { killed: false, connected: true, send },
        workerPort: 1234,
        workerToken: 'token',
        larkAppId: 'app',
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: '1',
        lastMessageAt: Date.now(),
        hasHistory: true,
      } as any;
      findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);

      setIpcAuthSecret(TEST_IPC_SECRET);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const renamePath = `/api/sessions/${session.sessionId}/rename`;
      const res = await fetch(`http://127.0.0.1:${handle.port}${renamePath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...trustedHostHeaders('POST', renamePath, handle.port),
        },
        body: JSON.stringify({ title: '  New\tTitle\u001b  ' }),
      });

      expect(res.status).toBe(200);
      const renameResult = await res.json();
      expect(renameResult).toEqual({
        ok: true,
        title: 'New Title',
        titleUpdatedAt: expect.any(String),
        titleSource: 'dashboard',
        agentSync: 'requested',
      });
      expect(sessionStore.getSession(session.sessionId)).toMatchObject({
        title: 'New Title',
        titleUpdatedAt: renameResult.titleUpdatedAt,
        titleSource: 'dashboard',
        nativeSessionTitle: 'New Title',
        nativeSessionTitleUserDefined: true,
      });
      expect(send).toHaveBeenCalledWith({ type: 'rename_session', title: 'New Title' });
      expect(events).toContainEqual({
        type: 'session.update',
        body: {
          sessionId: session.sessionId,
          patch: {
            title: 'New Title',
            titleUpdatedAt: renameResult.titleUpdatedAt,
            titleSource: 'dashboard',
          },
        },
      });
    } finally {
      findSpy?.mockRestore();
      off();
      sessionStore.init();
      config.session.dataDir = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/sessions/:sessionId/close', () => {
  it('returns 200 with ok=true even when session does not exist (idempotent)', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const path = '/api/sessions/nonexistent/close';
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: trustedHostHeaders('POST', path, handle.port),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe('POST /api/sessions/:sessionId/lock', () => {
  it('persists the lock flag and publishes a dashboard patch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-lock-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const seen: any[] = [];
    const off = dashboardEventBus.subscribe(e => seen.push(e));
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      const session = sessionStore.createSession('oc_lock', 'om_lock', 'lock me', 'group');

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const lockRes = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locked: true }),
      });

      expect(lockRes.status).toBe(200);
      expect(await lockRes.json()).toEqual({ ok: true, locked: true });
      expect(sessionStore.getSession(session.sessionId)?.locked).toBe(true);
      expect(seen).toContainEqual({
        type: 'session.update',
        body: { sessionId: session.sessionId, patch: { locked: true } },
      });

      const unlockRes = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locked: false }),
      });

      expect(unlockRes.status).toBe(200);
      expect(await unlockRes.json()).toEqual({ ok: true, locked: false });
      expect(sessionStore.getSession(session.sessionId)?.locked).toBeUndefined();
    } finally {
      off();
      sessionStore.init();
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed lock payloads', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/anything/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locked: 'yes' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'bad_locked' });
  });
});

describe('POST /api/sessions/:sessionId/board queued activation', () => {
  it('returns the activation failure without publishing a false in-progress success', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-board-activation-'));
    const previousDataDir = config.session.dataDir;
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    const appId = 'test-board-activation-app';
    const events: any[] = [];
    const off = dashboardEventBus.subscribe(event => events.push(event));
    try {
      config.session.dataDir = dataDir;
      registerBot({
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
        defaultWorkingDir: '/tmp',
        workingDir: '/tmp',
        workingDirs: ['/tmp'],
      } as any);
      setLarkAppId(appId);
      sessionStore.init(appId);
      const session = sessionStore.createSession('oc_board', 'om_board', 'queued board task', 'group');
      Object.assign(session, {
        larkAppId: appId,
        scope: 'thread',
        workingDir: '/tmp',
        queued: true,
        queuedPrompt: 'queued board payload',
        kanbanColumn: 'backlog',
      });
      sessionStore.updateSession(session);
      const ds = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId: appId,
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: false,
        workingDir: '/tmp',
        pendingPrompt: session.queuedPrompt,
      } as any;
      workerPool.setActiveSessionsRegistry(new Map([[sessionKey(session.rootMessageId, appId), ds]]));
      workerPool.initWorkerPool({
        sessionReply: vi.fn(async () => 'om_reply'),
        getSessionWorkingDir: () => { throw new Error('forced pre-init failure'); },
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/board`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ column: 'in_progress', position: 7 }),
        },
      );

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'forced pre-init failure' });
      expect(sessionStore.getSession(session.sessionId)).toMatchObject({
        queued: true,
        queuedPrompt: 'queued board payload',
        kanbanColumn: 'backlog',
      });
      expect(events).not.toContainEqual(expect.objectContaining({
        type: 'session.update',
        body: expect.objectContaining({ sessionId: session.sessionId }),
      }));
    } finally {
      off();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
      workerPool.initWorkerPool({
        sessionReply: vi.fn(async () => 'om_reply'),
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 0,
        closeSession: vi.fn(),
      });
      sessionStore.init();
      config.session.dataDir = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/sessions/:sessionId/restart', () => {
  it('sends a restart IPC message to the live worker', async () => {
    const send = vi.fn();
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-restart', cliId: 'codex' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-restart/restart`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-restart', cliId: 'codex' });
    expect(send).toHaveBeenCalledWith({ type: 'restart', reason: 'operator' });
    findSpy.mockRestore();
  });

  it('uses the frozen compatible runtime name in the restart notice', async () => {
    registerBot({
      larkAppId: 'runtime-app',
      larkAppSecret: 'secret',
      cliId: 'codex',
      cliPathOverride: 'new-vendor-codex',
      cliRuntime: {
        id: 'new-vendor-codex',
        displayName: 'New Live Name',
        executable: 'new-vendor-codex',
        update: { provider: 'none' },
      },
    });
    const replySpy = vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_notice');
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      larkAppId: 'runtime-app',
      chatId: 'oc_runtime',
      scope: 'thread',
      session: {
        sessionId: 's-runtime-restart',
        rootMessageId: 'om_runtime_root',
        cliId: 'codex',
        cliPathOverride: 'vendor-codex',
        cliRuntime: {
          id: 'vendor-codex',
          displayName: 'Frozen Vendor Codex',
          executable: 'vendor-codex',
          source: 'configured',
          update: { provider: 'auto' },
        },
      },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/sessions/s-runtime-restart/restart`,
        { method: 'POST' },
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(replySpy).toHaveBeenCalled());
      const notice = JSON.parse(replySpy.mock.calls[0]![2]);
      expect(notice.text).toContain('Frozen Vendor Codex');
      expect(notice.text).not.toContain('New Live Name');
    } finally {
      replySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  it('rejects unknown sessions without creating a restart side effect', async () => {
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/missing/restart`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
    findSpy.mockRestore();
  });

  it('rejects adopt/observed sessions without restarting (would kill the user pane)', async () => {
    const send = vi.fn();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt', cliId: 'codex' },
      worker: { send, killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-adopt/restart`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_restart_unsupported' });
    expect(send).not.toHaveBeenCalled();
    expect(forkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    forkSpy.mockRestore();
  });

  it('rejects Riff sessions with close-and-recreate guidance', async () => {
    const send = vi.fn();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-riff', cliId: 'riff', backendType: 'riff' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-riff/restart`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'remote_restart_unsupported',
      message: expect.stringMatching(/Riff.*不支持重启.*\/close/),
    });
    expect(send).not.toHaveBeenCalled();
    expect(forkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    forkSpy.mockRestore();
  });

  it('rejects Mojo restarts with the same remote guard (gate 4: restart cancels the remote session)', async () => {
    const send = vi.fn();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-mojo-rst', cliId: 'mojo', backendType: 'mojo' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-mojo-rst/restart`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'remote_restart_unsupported',
    });
    // Neither the restart IPC (whose mojo teardown cancels the remote session)
    // nor a refork may have fired.
    expect(send).not.toHaveBeenCalled();
    expect(forkSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    forkSpy.mockRestore();
  });

  it('revives a worker-less but active session by re-forking (matches the Feishu card path)', async () => {
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-revive', cliId: 'codex' },
      worker: null,
      adoptedFrom: undefined,
      hasHistory: true,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-revive/restart`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-revive', cliId: 'codex', revived: true });
    expect(forkSpy).toHaveBeenCalledTimes(1);
    // forkWorker(ds, prompt, resume) — resume must carry ds.hasHistory so the
    // revived CLI resumes the conversation rather than starting blank.
    expect(forkSpy.mock.calls[0][2]).toBe(true);
    findSpy.mockRestore();
    forkSpy.mockRestore();
  });

  it('returns 502 when sending the restart IPC throws (e.g. closed channel)', async () => {
    const send = vi.fn(() => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); });
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-throw', cliId: 'codex' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-throw/restart`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
    findSpy.mockRestore();
  });
});

describe('POST /api/sessions/:sessionId/wake', () => {
  it('cold-resumes a worker-less active session without sending a prompt', async () => {
    const ds = {
      session: { sessionId: 's-list-wake', cliId: 'codex' },
      worker: null,
      adoptedFrom: undefined,
      hasHistory: true,
    } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);

    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-list-wake/wake`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-list-wake', woke: true });
      expect(forkSpy).toHaveBeenCalledWith(ds, '', true);
    } finally {
      findSpy.mockRestore();
      forkSpy.mockRestore();
    }
  });

  it('does not restart a live worker when a Lark wake races the local picker', async () => {
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-list-race', cliId: 'codex' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
      hasHistory: true,
    } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const forkSpy = vi.spyOn(workerPool, 'forkWorker');

    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-list-race/wake`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, woke: false, reason: 'already_running' });
      expect(send).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      forkSpy.mockRestore();
    }
  });

  it('times out while another turn holds the bot mutation gate and never wakes later', async () => {
    const appId = 'app-list-wake-timeout';
    const ds = {
      larkAppId: appId,
      session: { sessionId: 's-list-timeout', cliId: 'codex' },
      worker: null,
      adoptedFrom: undefined,
      hasHistory: true,
    } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const forkSpy = vi.spyOn(workerPool, 'forkWorker');
    let releaseAdmission!: () => void;
    let markAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>(resolve => { markAdmissionStarted = resolve; });
    const admissionHold = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const admission = withBotTurnAdmission(appId, async () => {
      markAdmissionStarted();
      await admissionHold;
    });

    try {
      await admissionStarted;
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const path = '/api/sessions/s-list-timeout/wake';
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: 'POST',
        headers: { [SESSION_WAKE_DEADLINE_HEADER]: String(Date.now() + 50) },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'wake_mutation_timeout' });
      expect(forkSpy).not.toHaveBeenCalled();

      releaseAdmission();
      await admission;
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      releaseAdmission();
      await admission;
      findSpy.mockRestore();
      forkSpy.mockRestore();
      __testOnly_resetBotTurnMutationGates();
    }
  });

  it('rejects a Riff-backed wake: a remote lineage must never be locally re-forked', async () => {
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => true as any);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-riff-wake', cliId: 'riff', backendType: 'riff' },
      worker: null,
      adoptedFrom: undefined,
      hasHistory: true,
    } as any);

    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-riff-wake/wake`, { method: 'POST' });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'remote_wake_unsupported' });
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      forkSpy.mockRestore();
    }
  });

  it('rejects a Mojo-backed wake with the same remote guard (not just riff)', async () => {
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => true as any);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-mojo-wake', cliId: 'mojo', backendType: 'mojo' },
      worker: null,
      adoptedFrom: undefined,
      hasHistory: true,
    } as any);

    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-mojo-wake/wake`, { method: 'POST' });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'remote_wake_unsupported' });
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      forkSpy.mockRestore();
    }
  });
});

describe('POST /api/sessions/:sessionId/suspend', () => {
  it('suspends a live session via suspendWorker (manual_suspend reason)', async () => {
    const ds = {
      session: { sessionId: 's-susp', cliId: 'claude-code' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-susp/suspend`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-susp', suspended: true });
    expect(suspendSpy).toHaveBeenCalledWith(ds, 'manual_suspend');
    findSpy.mockRestore();
    suspendSpy.mockRestore();
  });

  it('404s for sessions that are not active', async () => {
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/missing/suspend`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
    findSpy.mockRestore();
  });

  it('409s before suspension while durable Codex App dispatch ownership is non-empty', async () => {
    const ds = {
      session: {
        sessionId: 's-owned',
        cliId: 'codex-app',
        codexAppDispatchLedger: [
          { dispatchId: 'd-1', turnId: 't-1', state: 'prepared', content: 'owned' },
        ],
      },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any;
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-owned/suspend`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'codex_app_dispatch_pending' });
    expect(suspendSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    suspendSpy.mockRestore();
  });

  it('rejects adopt/observed sessions (suspending would kill the user pane)', async () => {
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt-susp', cliId: 'codex' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-adopt-susp/suspend`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_suspend_unsupported' });
    expect(suspendSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    suspendSpy.mockRestore();
  });

  it('is idempotent when the worker is already gone (idle-suspended earlier)', async () => {
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(true);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-gone', cliId: 'codex' },
      worker: null,
      adoptedFrom: undefined,
    } as any);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-gone/suspend`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suspended: false, reason: 'no_live_worker' });
    expect(suspendSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    suspendSpy.mockRestore();
  });

  it('409s when the backend is not suspendable (suspendWorker returns false)', async () => {
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-pty', cliId: 'codex' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker').mockReturnValue(false);

    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-pty/suspend`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'backend_not_suspendable' });
    findSpy.mockRestore();
    suspendSpy.mockRestore();
  });
});

describe('PUT /api/bot-read-isolation', () => {
  for (const enabled of [false, true]) {
    it(`treats ${enabled}→${enabled} as a no-op even with active and persisted pending owners`, async () => {
      const appId = `test-read-isolation-noop-${enabled}`;
      registerBot({
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex-app',
        workingDir: process.cwd(),
        workingDirs: [process.cwd()],
        readIsolation: enabled,
      } as any);
      setLarkAppId(appId);
      const pendingLedger = [
        { dispatchId: 'd-noop', turnId: 't-noop', state: 'accepted', content: 'owned' },
      ];
      const previousRegistry = workerPool.getActiveSessionsRegistry();
      workerPool.setActiveSessionsRegistry(new Map([['active-noop', {
        larkAppId: appId,
        session: { sessionId: 's-active-noop', codexAppDispatchLedger: pendingLedger },
        worker: { send: vi.fn(), killed: false },
      } as any]]));
      const listSpy = vi.spyOn(sessionStore, 'listSessions').mockReturnValue([{
        sessionId: 's-persisted-noop',
        chatId: 'oc_noop',
        rootMessageId: 'om_noop',
        title: 'persisted pending no-op',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: appId,
        backendType: 'tmux',
        codexAppDispatchLedger: pendingLedger,
      } as any]);
      const updateSpy = vi.spyOn(sandboxStore, 'updateBotReadIsolation');
      const probeSpy = vi.spyOn(persistentBackend, 'probePersistentSession');
      const suspendSpy = vi.spyOn(workerPool, 'suspendWorker');
      try {
        handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          ok: true,
          readIsolation: enabled,
          suspendedSessions: 0,
          changed: false,
        });
        expect(listSpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(probeSpy).not.toHaveBeenCalled();
        expect(suspendSpy).not.toHaveBeenCalled();
      } finally {
        suspendSpy.mockRestore();
        probeSpy.mockRestore();
        updateSpy.mockRestore();
        listSpy.mockRestore();
        workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
      }
    });
  }

  it('rejects before persisting or suspending when any bot session owns a Codex App dispatch', async () => {
    const appId = 'test-read-isolation-owned';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      readIsolation: true,
    } as any);
    const owned = {
      larkAppId: appId,
      session: {
        sessionId: 's-read-isolation-owned',
        codexAppDispatchLedger: [
          { dispatchId: 'd-1', turnId: 't-1', state: 'prepared', content: 'owned' },
        ],
      },
      worker: { send: vi.fn(), killed: false },
    } as any;
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map([['owned', owned]]));
    setLarkAppId(appId);
    const suspendSpy = vi.spyOn(workerPool, 'suspendWorker');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'codex_app_dispatch_pending' });
      expect(suspendSpy).not.toHaveBeenCalled();
    } finally {
      suspendSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });

  it('refuses read-isolation disable before persistence while an old-policy active session can resume', async () => {
    const appId = 'test-read-isolation-active-disable';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      readIsolation: true,
    } as any);
    const workerless = {
      larkAppId: appId,
      session: { sessionId: 's-read-isolation-active-disable', backendType: 'tmux' },
      initConfig: { backendType: 'tmux' },
      // A quiet restart/crash can leave worker=null while its old read-isolated
      // pane survives and remains attachable.
      worker: null,
    } as any;
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map([['workerless', workerless]]));
    setLarkAppId(appId);
    const updateSpy = vi.spyOn(sandboxStore, 'persistBotReadIsolation');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'read_isolation_active_sessions' });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(sandboxStore.getBotReadIsolation(appId)).toBe(true);
    } finally {
      updateSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });

  it.runIf(process.platform === 'darwin')('refuses read-isolation enable before persistence while a write-only pane can survive restart', async () => {
    const appId = 'test-read-isolation-active-enable';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      sandbox: true,
    } as any);
    const workerless = {
      larkAppId: appId,
      session: { sessionId: 's-write-only-active', backendType: 'tmux', sandbox: true },
      initConfig: { backendType: 'tmux', sandbox: true, readIsolation: false },
      worker: null,
    } as any;
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map([['workerless-write-only', workerless]]));
    setLarkAppId(appId);
    const updateSpy = vi.spyOn(sandboxStore, 'persistBotReadIsolation');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'read_isolation_active_sessions' });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(sandboxStore.getBotReadIsolation(appId)).toBe(false);
    } finally {
      updateSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });

  it('refuses before persistence for a durable active row omitted from the runtime registry', async () => {
    const appId = 'test-read-isolation-persisted-active';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      readIsolation: true,
    } as any);
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map());
    setLarkAppId(appId);
    const listSpy = vi.spyOn(sessionStore, 'listSessions').mockReturnValue([{
      sessionId: 's-persisted-not-restored',
      chatId: 'oc_persisted',
      rootMessageId: 'om_persisted',
      title: 'persisted active',
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: appId,
      backendType: 'tmux',
      // Deliberately points at this live Vitest process. A closed row must not
      // treat a reused pid as teardown authority; the stamped pane probe is.
      pid: process.pid,
    } as any]);
    const updateSpy = vi.spyOn(sandboxStore, 'updateBotReadIsolation');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, error: 'read_isolation_active_sessions' });
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
      listSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });

  it('waits for a just-closed persistent backing to disappear before changing policy', async () => {
    const appId = 'test-read-isolation-close-teardown';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      readIsolation: true,
    } as any);
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map());
    setLarkAppId(appId);
    const listSpy = vi.spyOn(sessionStore, 'listSessions').mockReturnValue([{
      sessionId: 's-just-closed',
      chatId: 'oc_closed',
      rootMessageId: 'om_closed',
      title: 'just closed',
      status: 'closed',
      createdAt: new Date().toISOString(),
      larkAppId: appId,
      backendType: 'tmux',
    } as any]);
    const probeSpy = vi.spyOn(persistentBackend, 'probePersistentSession')
      .mockReturnValueOnce('exists')
      .mockReturnValue('missing');
    const updateSpy = vi.spyOn(sandboxStore, 'updateBotReadIsolation')
      .mockResolvedValue({ ok: true, readIsolation: false });
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const endpoint = `http://127.0.0.1:${handle.port}/api/bot-read-isolation`;
      const request = () => fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      const first = await request();
      expect(first.status).toBe(409);
      expect(await first.json()).toMatchObject({
        ok: false,
        error: 'read_isolation_teardown_unverified',
      });
      expect(updateSpy).not.toHaveBeenCalled();

      const second = await request();
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        ok: true,
        readIsolation: false,
        suspendedSessions: 0,
      });
      expect(updateSpy).toHaveBeenCalledOnce();
      expect(probeSpy).toHaveBeenCalledWith('tmux', 'bmx-s-just-c');
    } finally {
      updateSpy.mockRestore();
      probeSpy.mockRestore();
      listSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });

  it('does not synchronously fan out legacy closed rows across every persistent backend', async () => {
    const appId = 'test-read-isolation-legacy-backing';
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex-app',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      readIsolation: true,
    } as any);
    const previousRegistry = workerPool.getActiveSessionsRegistry();
    workerPool.setActiveSessionsRegistry(new Map());
    setLarkAppId(appId);
    const listSpy = vi.spyOn(sessionStore, 'listSessions').mockReturnValue([{
      sessionId: 's-legacy-no-backend',
      chatId: 'oc_legacy',
      rootMessageId: 'om_legacy',
      title: 'legacy closed',
      status: 'closed',
      createdAt: new Date().toISOString(),
      larkAppId: appId,
      // Deliberately no backendType stamp.
    } as any]);
    const probeSpy = vi.spyOn(persistentBackend, 'probePersistentSession');
    const updateSpy = vi.spyOn(sandboxStore, 'updateBotReadIsolation')
      .mockResolvedValue({ ok: true, readIsolation: false });
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        readIsolation: false,
      });
      expect(updateSpy).toHaveBeenCalledOnce();
      expect(probeSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
      probeSpy.mockRestore();
      listSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(previousRegistry ?? new Map());
    }
  });
});

describe('POST /api/sessions/:sessionId/resume', () => {
  it('Plan B: resumes a closed meeting-agent session as an ordinary chat session (wake=1)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-resume-'));
    const prevConfigDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      workerPool.setActiveSessionsRegistry(registry);

      const session = sessionStore.createSession('oc_listener', 'oc_listener', '[Meeting] meeting-42', 'group');
      session.larkAppId = '';
      session.scope = 'chat';
      session.cliId = 'codex' as any;
      session.workingDir = process.cwd();
      // The vcMeetingReceiver marker is now pure delivery metadata; it no longer
      // blocks resume. A closed meeting-agent session reactivates into its
      // ordinary (chatId, appId) chat slot like any chat session.
      session.vcMeetingReceiver = {
        listenerAppId: 'listener-app',
        meetingId: 'meeting-42',
        memberId: 'member-agent',
        memberEpoch: 7,
      };
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/resume?wake=1`,
        { method: 'POST' },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, sessionId: session.sessionId, wake: true });
      // Reactivated at the ordinary chat slot and forked.
      expect(registry.get(sessionKey('oc_listener', ''))?.session.sessionId).toBe(session.sessionId);
      expect(sessionStore.getSession(session.sessionId)?.status).toBe('active');
      expect(forkSpy).toHaveBeenCalled();
    } finally {
      forkSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('wakes a resumed session immediately when wake=1 is set', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-resume-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      workerPool.setActiveSessionsRegistry(registry);

      const session = sessionStore.createSession('oc_resume', 'om_resume', 'resume topic', 'group');
      session.larkAppId = '';
      session.scope = 'thread';
      session.cliId = 'codex' as any;
      session.workingDir = process.cwd();
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/resume?wake=1`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, sessionId: session.sessionId, wake: true });
      expect(registry.get(sessionKey('om_resume', ''))?.session.sessionId).toBe(session.sessionId);
      expect(forkSpy).toHaveBeenCalledWith(
        expect.objectContaining({ session: expect.objectContaining({ sessionId: session.sessionId }) }),
        '',
        true,
      );
    } finally {
      forkSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('default resume (no wake) reactivates without forking a worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-resume-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      workerPool.setActiveSessionsRegistry(registry);

      const session = sessionStore.createSession('oc_resume', 'om_resume', 'resume topic', 'group');
      session.larkAppId = '';
      session.scope = 'thread';
      session.cliId = 'codex' as any;
      session.workingDir = process.cwd();
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId);

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/resume`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Reactivated, but NO eager fork — the session cold-resumes lazily on the
      // next inbound message. This guards the `wake &&` short-circuit against a
      // refactor that reverts to forking on every resume.
      expect(body).toMatchObject({ ok: true, sessionId: session.sessionId, wake: false });
      expect(registry.get(sessionKey('om_resume', ''))?.session.sessionId).toBe(session.sessionId);
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      forkSpy.mockRestore();
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/events', () => {
  it('replays current active sessions as session.spawned on connect (snapshot-on-connect)', async () => {
    // Guards the descriptor→restore race: a dashboard that subscribes AFTER an
    // empty hydrate (or after a restore-time announce it missed) must still learn
    // every active row. The SSE handler subscribes then replays the live registry.
    const registry = new Map<string, any>();
    workerPool.setActiveSessionsRegistry(registry);
    try {
      registry.set(sessionKey('om_snap', 'cli_app'), {
        session: {
          sessionId: 'snap-1', chatId: 'oc_snap', rootMessageId: 'om_snap',
          title: 't', status: 'active', createdAt: new Date(1000).toISOString(),
          scope: 'thread', cliId: 'codex',
        },
        worker: null, workerPort: null, workerToken: null,
        larkAppId: 'cli_app', chatId: 'oc_snap', chatType: 'group', scope: 'thread',
        spawnedAt: 1000, cliVersion: 'test', lastMessageAt: 1000, hasHistory: true,
      });

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const ev = await readSseEvent(
        `http://127.0.0.1:${handle.port}/api/events`,
        e => e.type === 'session.spawned' && e.body?.session?.sessionId === 'snap-1',
      );
      expect(ev).not.toBeNull();
      expect(ev!.body.session.status).toBe('dormant'); // restored worker:null → lazily resumes on next input
      expect(ev!.body.session.hasHistory).toBe(true);
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
    }
  });

  it('replays this-run closed sessions as session.spawned (zombie-close visibility)', async () => {
    // A restore-time zombie is registered, announced, then immediately
    // closeSession()'d (evicted from the active Map) — all before a racing
    // dashboard's SSE subscription exists. By connect time it's gone from the Map,
    // so the active-only replay can't surface it. The closed-since-process-start
    // replay must still deliver it as a closed row so the dashboard doesn't lose
    // it (or keep a stale active entry).
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-sse-closed-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const registry = new Map<string, any>();
    try {
      config.session.dataDir = dataDir;
      sessionStore.init();
      workerPool.setActiveSessionsRegistry(registry); // empty — zombie already evicted

      const session = sessionStore.createSession('oc_zombie', 'om_zombie', 'zombie topic', 'group');
      session.larkAppId = '';
      session.scope = 'thread';
      session.cliId = 'codex' as any;
      sessionStore.updateSession(session);
      sessionStore.closeSession(session.sessionId); // closedAt = now ≥ PROCESS_START_MS

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const ev = await readSseEvent(
        `http://127.0.0.1:${handle.port}/api/events`,
        e => e.type === 'session.spawned' && e.body?.session?.sessionId === session.sessionId,
      );
      expect(ev).not.toBeNull();
      expect(ev!.body.session.status).toBe('closed');
      expect(typeof ev!.body.session.closedAt).toBe('number');
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/sessions/:sessionId/write-link', () => {
  it('returns 401 without a valid loopback-HMAC signature', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('returns 404 session_not_active for an unknown/closed session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/ghost/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('session_not_active');
  });

  it('returns 409 terminal_unavailable when the live session has no web terminal yet', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's1', webPort: null },
      workerPort: null,
      workerToken: null,
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s1/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('terminal_unavailable');
    spy.mockRestore();
  });

  it('reports Web Terminal as unsupported for the zmx backend', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-zmx', backendType: 'zmx', webPort: 4321 },
      workerPort: 4321,
      workerToken: 'stale-secret',
      riffAccessUrl: 'https://stale-riff.example',
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-zmx/write-link`, {
      headers: tokenAuthHeaders(),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('terminal_unsupported');
    spy.mockRestore();
  });

  it('returns 200 with a token-bearing url for a live session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's2', webPort: 4321 },
      workerPort: 4321,
      workerToken: 'secret-tok',
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('token=secret-tok');
    spy.mockRestore();
  });
});

describe('GET /api/sessions/:sessionId/view-link', () => {
  it('returns the LIVE per-boot view token so the central mint can pin a generation', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's2', webPort: 4321 },
      workerPort: 4321,
      workerToken: 'secret-tok',
      workerViewToken: 'boot-view-token',
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/view-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.url).toContain('viewToken=boot-view-token');
    // 只读入口，绝不带写 token（这条 URL 会被中央改写后送进浏览器）。
    expect(body.url).not.toContain('secret-tok');
    spy.mockRestore();
  });

  it('P1-5: refuses when only a STALE persisted port survives the dead worker', async () => {
    // session.webPort 是落盘的，worker 死掉后还在；workerViewToken 只在 ready 时写入。
    // 这种「端口还在、boot token 没了」的状态下不能给链接：中央拿不到当前这一代的
    // generation，签出来的能力就会钉在一个已经不存在的 worker 上。
    setIpcAuthSecret(TEST_IPC_SECRET);
    const spy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's3', webPort: 4321 },
      workerPort: null,
      workerToken: null,
      workerViewToken: null,
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s3/view-link`, { headers: tokenAuthHeaders() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('terminal_unavailable');
    spy.mockRestore();
  });
});

describe('POST /api/sessions/:sessionId/write-link-card', () => {
  it('returns 401 without a valid loopback-HMAC signature', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s2/write-link-card`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('returns 404 session_not_active for an unknown/closed session', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/ghost/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('session_not_active');
  });

  it('on success returns delivery counts only — never the token or URL', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's9' }, workerPort: 4321, workerToken: 'secret-tok',
    } as any);
    const deliverSpy = vi.spyOn(workerPool, 'deliverWriteLinkCardToOwners').mockResolvedValue({
      ok: true, delivered: 2, total: 2, channels: ['ephemeral', 'dm'],
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // The token rides only the private Lark channels — the HTTP response that
    // crosses back to the CLI must carry counts, not the credential.
    expect(raw).not.toContain('secret-tok');
    expect(raw).not.toContain('token=');
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ ok: true, delivered: 2, total: 2, channels: ['ephemeral', 'dm'] });
    expect(body.url).toBeUndefined();
    findSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  it('maps no_owner → 422 and terminal_unavailable → 409', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({ session: { sessionId: 's9' } } as any);
    const deliverSpy = vi.spyOn(workerPool, 'deliverWriteLinkCardToOwners');

    deliverSpy.mockResolvedValueOnce({ ok: false, error: 'no_owner', delivered: 0, total: 0, channels: [] });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const noOwner = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(noOwner.status).toBe(422);
    expect((await noOwner.json()).error).toBe('no_owner');

    deliverSpy.mockResolvedValueOnce({ ok: false, error: 'terminal_unavailable', delivered: 0, total: 0, channels: [] });
    const notReady = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s9/write-link-card`, {
      method: 'POST', headers: tokenAuthHeaders(),
    });
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).error).toBe('terminal_unavailable');

    findSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});

describe('POST /api/sessions/:sessionId/locate rate limit', () => {
  it('returns 429 on second call within window', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    // First call expected 404 because no session exists — but it consumes the limiter slot.
    await fetch(`http://127.0.0.1:${handle.port}/api/sessions/sX-test/locate`, { method: 'POST' });
    const second = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/sX-test/locate`, { method: 'POST' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });
});

describe('GET /api/schedules', () => {
  it('returns schedules array shape', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.schedules)).toBe(true);
  });

  it('includes raw schedule so the edit form can prefill the schedule field', async () => {
    setLarkAppId('cli_ipc_test_bot001');
    const add = scheduler.addTask({
      name: 'AI 工作环境巡检',
      schedule: '10 0,12 * * *',
      prompt: '执行一次巡检',
      workingDir: '/tmp',
      chatId: 'oc_schedule',
      larkAppId: 'cli_ipc_test_bot001',
      executionPosition: 'topic',
      rootMessageId: 'om_schedule_root',
      chatType: 'topic_group',
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.schedules.find((s: any) => s.id === add.id);

    expect(row).toMatchObject({
      id: add.id,
      name: 'AI 工作环境巡检',
      schedule: '10 0,12 * * *',
      parsed: { display: '10 0,12 * * *' },
    });
  });
});

describe('POST /api/schedules execution position', () => {
  it('accepts fresh-topic execution with a custom title and no retained root', async () => {
    setLarkAppId('cli_schedule_test');
    const addSpy = vi.spyOn(scheduler, 'addTask').mockImplementation((params: any) => ({
      ...params,
      id: 'fresh-1',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      enabled: true,
      createdAt: '2026-07-21T00:00:00.000Z',
      deliver: 'origin',
    }));
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '每日巡检',
        schedule: 'every 30m',
        prompt: '检查发布状态',
        chatId: 'oc_target',
        executionPosition: 'new-topic',
        topicTitle: '每日发布巡检',
      }),
    });

    expect(res.status).toBe(200);
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'chat',
      executionPosition: 'new-topic',
      topicTitle: '每日发布巡检',
      rootMessageId: undefined,
    }));
    expect((await res.json()).task).toMatchObject({
      executionPosition: 'new-topic',
      topicTitle: '每日发布巡检',
    });
    addSpy.mockRestore();
  });

  it('accepts fresh-topic + silent as a lazily materialized topic', async () => {
    setLarkAppId('cli_schedule_test');
    const addSpy = vi.spyOn(scheduler, 'addTask').mockImplementation((params: any) => ({
      ...params,
      id: 'silent-fresh-1',
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
      enabled: true,
      createdAt: '2026-07-21T00:00:00.000Z',
      deliver: 'origin',
    }));
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '静默巡检',
        schedule: 'every 30m',
        prompt: '检查发布状态',
        chatId: 'oc_target',
        executionPosition: 'new-topic',
        silent: true,
      }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).task).toMatchObject({
      name: '静默巡检',
      executionPosition: 'new-topic',
      scope: 'chat',
      silent: true,
    });
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      executionPosition: 'new-topic',
      scope: 'chat',
      silent: true,
    }));
    addSpy.mockRestore();
  });
});

describe('POST /api/schedules/:id/(run|pause|resume)', () => {
  it('returns ok=false for unknown id (run)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  it('returns ok=false for unknown id (pause)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  it('returns ok=false for unknown id (resume)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });

  // The delivery-toggle route must be registered on the IPC server (the outer
  // dashboard proxy in dashboard.ts forwards /(run|pause|resume|delivery)$ here).
  it('returns ok=false for unknown id (delivery)', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedules/nonexistent/delivery`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
  });
});

describe('GET /api/goals', () => {
  it('returns the verified-delivery goal board from the ledger', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-goals-ipc-'));
    const prevEnv = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    process.env.SESSION_DATA_DIR = dataDir;
    config.session.dataDir = dataDir;
    try {
      openLedger().append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-goal',
        chatId: 'oc_goal',
        ts: 1_000,
        idempotencyKey: 'dispatched:task-goal',
        payload: { taskId: 'task-goal', title: 'Goal task' },
      });
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/goals`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.goals).toHaveLength(1);
      expect(body.goals[0]).toMatchObject({
        goalChatId: 'oc_goal',
        counts: { dispatched: 1, reported: 0, accepted: 0, rejected: 0, total: 1 },
      });
      expect(body.goals[0].tasks[0]).toMatchObject({ taskId: 'task-goal', title: 'Goal task', status: 'dispatched' });
    } finally {
      if (prevEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevEnv;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns the operator attention board with ledger-derived risk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-goals-attention-ipc-'));
    const prevEnv = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    process.env.SESSION_DATA_DIR = dataDir;
    config.session.dataDir = dataDir;
    try {
      const now = Date.now();
      const led = openLedger();
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-risk',
        chatId: 'oc_goal',
        ts: now - 10_000,
        idempotencyKey: 'dispatched:task-risk',
        payload: { taskId: 'task-risk', title: 'Risk task' },
      });
      for (let i = 1; i <= 3; i++) {
        led.append({
          type: 'TaskDispatched',
          actor: 'orchestrator',
          taskId: 'task-risk',
          chatId: 'oc_goal',
          ts: now - 5_000 + i,
          idempotencyKey: `reassign:task-risk:${i}`,
          payload: { taskId: 'task-risk', title: 'Risk task' },
        });
      }

      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/goals/attention`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.systemRisk).toHaveLength(1);
      expect(body.systemRisk[0]).toMatchObject({
        taskId: 'task-risk',
        source: 'ledger',
        disposition: { bucket: 'systemRisk', reason: 'reassign_budget_exhausted' },
      });
      expect(body.counts.systemRisk).toBe(1);
      expect(body.perGoal[0].tasks[0]).toMatchObject({ taskId: 'task-risk', status: 'dispatched' });
    } finally {
      if (prevEnv === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevEnv;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/goals/attention/live auth', () => {
  it('rejects a bare loopback caller and accepts the trusted dashboard wrapper with a query', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const path = '/api/goals/attention/live?chatId=oc_goal';

    const bare = await fetch(`http://127.0.0.1:${handle.port}${path}`);
    expect(bare.status).toBe(401);

    const trusted = await fetchDaemonIpc(handle.port, path, { method: 'GET' }, TEST_IPC_SECRET);
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toMatchObject({ systemRisk: expect.any(Array) });
  });
});

describe('SSE /api/events', () => {
  it('delivers a published event to a connected client', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    setTimeout(() => dashboardEventBus.publish({ type: 'heartbeat', body: { ts: 42 } }), 50);

    const decoder = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('"ts":42')) break;
    }
    expect(buf).toContain('event: heartbeat');
    expect(buf).toContain('"ts":42');

    reader.releaseLock();
    await res.body!.cancel();
  }, 5_000);
});

describe('POST /api/locale/reload', () => {
  it('hot-reloads the process default locale from disk and reports it', async () => {
    setLarkAppId('');  // no registered bot → per-bot override path stays null
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/locale/reload`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(['zh', 'en']).toContain(body.defaultLocale);
    expect(body.botLang).toBeNull();
    // The route applied it in-process: getDefaultLocale reflects the same value
    // (same i18n module singleton the daemon's card rendering reads).
    const { getDefaultLocale } = await import('../src/i18n/index.js');
    expect(getDefaultLocale()).toBe(body.defaultLocale);
  });
});

describe('PUT /api/bot-skills', () => {
  it('rejects invalid non-null policy instead of clearing skills', async () => {
    const appId = 'test-skill-policy-app';
    setLarkAppId(appId);
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
      skills: { include: ['skill:deploy'] },
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-skills`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set', policy: { include: [123] } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_policy' });
  });
});

describe('PUT /api/bot-substitute-mode', () => {
  it('preserves quote reply mode in the response and bots.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-substitute-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-substitute-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-substitute-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          targets: [{ userId: 'u_alice', name: 'Alice' }],
          disclosure: 'prefix',
          replyMode: 'quote',
          excludedChats: ['oc_x', ' oc_y ', '', 'oc_x'],
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        substituteMode: { replyMode: 'quote', excludedChats: ['oc_x', 'oc_y'] },
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].substituteMode).toMatchObject({
        replyMode: 'quote',
        excludedChats: ['oc_x', 'oc_y'],
      });
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-agent', () => {
  it('updates cli selection and model through bots.json and live config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'traex',
        model: 'old-model',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const invalid = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: 'gpt-5.4', reasoningEffort: 'ultra' }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: 'reasoning_effort_not_supported_by_model' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'ttadk-x-codex', model: 'kimi-k2.5', reasoningEffort: 'xhigh' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        cliId: 'codex',
        wrapperCli: 'ttadk codex',
        model: 'kimi-k2.5',
        reasoningEffort: 'xhigh',
        selectionKey: 'ttadk-x-codex',
      });
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored).toMatchObject({
        cliId: 'codex',
        wrapperCli: 'ttadk codex',
        model: 'kimi-k2.5',
        reasoningEffort: 'xhigh',
      });

      const sol = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'ttadk-x-codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }),
      });
      expect(sol.status).toBe(200);

      // Simulate a stale in-memory snapshot while the locked bots.json entry
      // already contains the newer ultra value. Validation must use the entry
      // read inside rmwBotEntry, not this stale live config.
      getBot(appId).config.reasoningEffort = 'xhigh';

      const omittedEffort = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'ttadk-x-codex', model: 'gpt-5.4' }),
      });
      expect(omittedEffort.status).toBe(400);
      expect(await omittedEffort.json()).toMatchObject({ error: 'reasoning_effort_not_supported_by_model' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        model: 'gpt-5.6-sol',
        reasoningEffort: 'ultra',
      });
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists TraeX reasoning effort and validates it against TraeX levels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-traex-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-traex-agent-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'traex',
        model: 'DeepSeek-V4-Pro',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const ok = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'traex', model: 'DeepSeek-V4-Pro', reasoningEffort: 'medium' }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        ok: true,
        cliId: 'traex',
        model: 'DeepSeek-V4-Pro',
        reasoningEffort: 'medium',
        selectionKey: 'traex',
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        cliId: 'traex',
        model: 'DeepSeek-V4-Pro',
        reasoningEffort: 'medium',
      });

      const unsupported = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'traex', model: 'DeepSeek-V4-Pro', reasoningEffort: 'max' }),
      });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({ error: 'reasoning_effort_not_supported_by_model' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        model: 'DeepSeek-V4-Pro',
        reasoningEffort: 'medium',
      });
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists, validates and clears the dsh turn timeout through bots.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-tt-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-tt-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'dsh',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const url = `http://127.0.0.1:${handle.port}/api/bot-agent`;

      // Reject non-positive / non-integer values.
      const bad = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: 0 }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_turn_timeout_ms' });

      // Reject values above the arm-able bound (would overflow Node setTimeout).
      const over = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: 2_147_483_648 }),
      });
      expect(over.status).toBe(400);
      expect(await over.json()).toMatchObject({ error: 'invalid_turn_timeout_ms' });

      // A legal non-whole-minute value is accepted and stored verbatim.
      const oddMs = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: 90_001 }),
      });
      expect(oddMs.status).toBe(200);
      expect(await oddMs.json()).toMatchObject({ ok: true, turnTimeoutMs: 90_001 });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({ turnTimeoutMs: 90_001 });

      // Set a valid timeout → stored on the dsh bot + echoed back.
      const set = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: 1_800_000 }),
      });
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ ok: true, cliId: 'dsh', turnTimeoutMs: 1_800_000 });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({ turnTimeoutMs: 1_800_000 });
      expect(getBot(appId).config.turnTimeoutMs).toBe(1_800_000);

      // Empty string clears it (revert to runner default).
      const cleared = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: '' }),
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ ok: true, turnTimeoutMs: null });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].turnTimeoutMs).toBeUndefined();
      expect(getBot(appId).config.turnTimeoutMs).toBeUndefined();

      // Set it again, then switch away from dsh → non-dsh CLI drops the field.
      await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', turnTimeoutMs: 900_000 }),
      });
      const switched = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'claude-code', model: '' }),
      });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ cliId: 'claude-code', turnTimeoutMs: null });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].turnTimeoutMs).toBeUndefined();
      expect(getBot(appId).config.turnTimeoutMs).toBeUndefined();
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists, validates and clears the dsh runtime variant through bots.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-dshrt-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-dshrt-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'dsh',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const url = `http://127.0.0.1:${handle.port}/api/bot-agent`;

      // Reject unknown runtime values.
      const bad = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', dshRuntime: 'bogus' }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_dsh_runtime' });

      // Set tui → stored on the dsh bot + echoed back.
      const setTui = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', dshRuntime: 'tui' }),
      });
      expect(setTui.status).toBe(200);
      expect(await setTui.json()).toMatchObject({ ok: true, cliId: 'dsh', dshRuntime: 'tui' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({ dshRuntime: 'tui' });
      expect(getBot(appId).config.dshRuntime).toBe('tui');

      // Switch back to official.
      const setOfficial = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', dshRuntime: 'official' }),
      });
      expect(setOfficial.status).toBe(200);
      expect(await setOfficial.json()).toMatchObject({ ok: true, dshRuntime: 'official' });
      expect(getBot(appId).config.dshRuntime).toBe('official');

      // Empty string clears it (revert to default = official).
      const cleared = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', dshRuntime: '' }),
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ ok: true, dshRuntime: null });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].dshRuntime).toBeUndefined();

      // Set tui, then switch away from dsh → non-dsh CLI drops the field.
      await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'dsh', model: '', dshRuntime: 'tui' }),
      });
      const switched = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'claude-code', model: '' }),
      });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ cliId: 'claude-code', dshRuntime: null });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].dshRuntime).toBeUndefined();
      expect(getBot(appId).config.dshRuntime).toBeUndefined();
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsettled Codex App session before config/readIsolation mutation or close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-pending-ipc-'));
    const dataDir = join(dir, 'data');
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-pending-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const prevDataDir = config.session.dataDir;
    try {
      process.env.BOTS_CONFIG = configPath;
      config.session.dataDir = dataDir;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex-app',
        model: 'old-model',
        readIsolation: true,
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      sessionStore.init(appId);
      const session = sessionStore.createSession('oc_pending', 'om_pending', 'Pending', 'group');
      session.larkAppId = appId;
      session.cliId = 'codex-app';
      session.codexAppDispatchLedger = [{
        dispatchId: 'dispatch-pending', turnId: 'turn-pending',
        state: 'prepared', content: 'prompt', deliverySink: 'lark',
      }];
      sessionStore.updateSession(session);
      const send = vi.fn();
      const registry = new Map([[sessionKey(session.rootMessageId, appId), {
        session,
        worker: { killed: false, send },
        workerPort: 1,
        workerToken: 'token',
        larkAppId: appId,
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
      } as any]]);
      workerPool.setActiveSessionsRegistry(registry);
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const beforeFile = readFileSync(configPath, 'utf8');
      const beforeLive = structuredClone(getBot(appId).config);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'ttadk-x-codex', model: 'new-model' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'codex_app_dispatch_pending',
        blockingSessions: [{
          sessionId: session.sessionId,
          cliId: 'codex-app',
          reasons: ['codex_app_dispatch'],
        }],
      });
      expect(readFileSync(configPath, 'utf8')).toBe(beforeFile);
      expect(getBot(appId).config).toEqual(beforeLive);
      expect(sessionStore.getSession(session.sessionId)).toMatchObject({
        status: 'active',
        codexAppDispatchLedger: [{ dispatchId: 'dispatch-pending' }],
      });
      expect(registry.has(sessionKey(session.rootMessageId, appId))).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevDataDir;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports non-Codex pending work with a backend-neutral error and actionable sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-generic-pending-ipc-'));
    const dataDir = join(dir, 'data');
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-generic-pending-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const prevDataDir = config.session.dataDir;
    try {
      process.env.BOTS_CONFIG = configPath;
      config.session.dataDir = dataDir;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'traex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      sessionStore.init(appId);
      const session = sessionStore.createSession(
        'oc_generic_pending',
        'om_generic_pending',
        'Generic pending',
        'group',
      );
      session.larkAppId = appId;
      session.cliId = 'traex';
      session.queued = true;
      session.pendingRepoSetup = { mode: 'picker', prompt: 'OPENING_N' };
      sessionStore.updateSession(session);
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'session_mutation_pending',
        blockingSessions: [{
          sessionId: session.sessionId,
          cliId: 'traex',
          reasons: ['queued_todo', 'repository_setup'],
        }],
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0].cliId).toBe('traex');
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevDataDir;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the hot-switch mismatch close after a settled Codex App ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-settled-ipc-'));
    const dataDir = join(dir, 'data');
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-settled-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const prevDataDir = config.session.dataDir;
    try {
      process.env.BOTS_CONFIG = configPath;
      config.session.dataDir = dataDir;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'secret', cliId: 'codex-app',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      sessionStore.init(appId);
      const session = sessionStore.createSession('oc_settled', 'om_settled', 'Settled', 'group');
      session.larkAppId = appId;
      session.cliId = 'codex-app';
      session.codexAppDispatchLedger = [];
      sessionStore.updateSession(session);
      const registry = new Map([[sessionKey(session.rootMessageId, appId), {
        session, worker: null, workerPort: null, workerToken: null,
        larkAppId: appId, chatId: session.chatId, chatType: 'group', scope: 'thread',
        spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(),
        hasHistory: true,
      } as any]]);
      workerPool.setActiveSessionsRegistry(registry);
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, closedMismatchedSessions: 1 });
      expect(sessionStore.getSession(session.sessionId)?.status).toBe('closed');
      expect(registry.has(sessionKey(session.rootMessageId, appId))).toBe(false);
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevDataDir;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a validated Codex-compatible runtime and reports its own version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-runtime-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const cliRuntime = {
        id: 'vendor-codex',
        displayName: 'Vendor Codex',
        executable: process.execPath,
        update: { provider: 'self' },
      };
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: 'custom-model', cliRuntime }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        cliId: 'codex',
        cliRuntime,
        runtimeProbe: { updateProvider: 'self' },
      });
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored).toMatchObject({ cliId: 'codex', cliRuntime });
      expect(stored.cliPathOverride).toBe(cliRuntime.executable);
      expect(getBot(appId).config).toMatchObject({
        cliRuntime,
        // Parsed/live config keeps the executable shadow for existing adapters.
        cliPathOverride: process.execPath,
      });
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a runtime for old same-selection clients and clears it only when explicit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-compat-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-runtime-compat-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const cliRuntime = {
      id: 'vendor-codex',
      displayName: 'Vendor Codex',
      executable: process.execPath,
      update: { provider: 'none' },
    };
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
        cliRuntime,
        cliPathOverride: cliRuntime.executable,
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const url = `http://127.0.0.1:${handle.port}/api/bot-agent`;

      const oldClientSave = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: 'new-model' }),
      });
      expect(oldClientSave.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        cliRuntime,
        cliPathOverride: cliRuntime.executable,
      });

      const explicitOfficial = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: 'new-model', cliRuntime: null }),
      });
      expect(explicitOfficial.status).toBe(200);
      expect(await explicitOfficial.json()).toMatchObject({ cliRuntime: null });
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored).not.toHaveProperty('cliRuntime');
      expect(stored).not.toHaveProperty('cliPathOverride');
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns and preserves a legacy CLI path when a model-only client omits cliRuntime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-legacy-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-runtime-legacy-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
        cliPathOverride: process.execPath,
        model: 'old-model',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const initial = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(initial).toMatchObject({
        cliId: 'codex',
        cliRuntime: null,
        cliPathOverride: process.execPath,
      });

      const modelSave = await fetch(`${base}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: 'new-model' }),
      });
      expect(modelSave.status).toBe(200);
      expect(await modelSave.json()).toMatchObject({
        cliRuntime: null,
        cliPathOverride: process.execPath,
        model: 'new-model',
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).toMatchObject({
        cliPathOverride: process.execPath,
        model: 'new-model',
      });
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a custom runtime for non-Codex or wrapper selections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-reject-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-runtime-reject-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const cliRuntime = { id: 'vendor-codex', executable: process.execPath };
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const url = `http://127.0.0.1:${handle.port}/api/bot-agent`;

      const nonCodex = await fetch(url, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'claude-code', cliRuntime }),
      });
      expect(nonCodex.status).toBe(400);
      expect(await nonCodex.json()).toMatchObject({ error: 'runtime_requires_codex' });

      const wrapper = await fetch(url, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'ttadk-x-codex', cliRuntime }),
      });
      expect(wrapper.status).toBe(400);
      expect(await wrapper.json()).toMatchObject({ error: 'runtime_wrapper_conflict' });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0]).not.toHaveProperty('cliRuntime');
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-riff config safety (finding H)', () => {
  async function withRiffBot(fn: (base: string, configPath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-cfg-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-riff-cfg-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'riff',
        riff: {
          baseUrl: 'https://riff-old.example',
          agent: 'aiden',
          templateId: 'tpl-1',
          jwt: 'SECRET-JWT',
          env: { API_KEY: 'SECRET-ENV' },
          logLevel: 'verbose',
          // sandboxCluster 现在可编辑；旧 dashboard 保存省略时仍须兼容保留。
          sandboxCluster: 'boe',
          // 已移出 UI 的字段：UI 保存省略时旧值必须原样保留。
          injectStatusLines: false,
        },
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      await fn(`http://127.0.0.1:${handle.port}`, configPath);
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('preserves hidden fields and an old-client sandbox selection on save, then redacts the response', async () => {
    await withRiffBot(async (base, configPath) => {
      const res = await fetch(`${base}/api/bot-riff`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ riff: JSON.stringify({ baseUrl: 'https://riff-new.example', reasoningEffort: 'high' }) }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // 响应绝不携带明文 secret
      expect(String(body.riff)).not.toContain('SECRET-JWT');
      expect(String(body.riff)).not.toContain('SECRET-ENV');
      // 落盘：UI 字段更新、隐藏字段原样保留
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0].riff;
      expect(stored).toMatchObject({
        baseUrl: 'https://riff-new.example',
        reasoningEffort: 'high',
        // agent 已下线 UI（服务端写死 codex）——存量值按隐藏字段保留
        agent: 'aiden',
        templateId: 'tpl-1',
        jwt: 'SECRET-JWT',
        env: { API_KEY: 'SECRET-ENV' },
        logLevel: 'verbose',
        // 旧 dashboard 未回写 sandboxCluster 时兼容保留原选择。
        sandboxCluster: 'boe',
        // UI 已不回写 injectStatusLines——存量值按隐藏字段保留。
        injectStatusLines: false,
      });
    });
  });

  it('updates sandboxCluster and rejects unsupported values', async () => {
    await withRiffBot(async (base, configPath) => {
      const update = await fetch(`${base}/api/bot-riff`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ riff: JSON.stringify({ baseUrl: 'https://riff-new.example', sandboxCluster: 'cn' }) }),
      });
      expect(update.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].riff.sandboxCluster).toBe('cn');

      const invalid = await fetch(`${base}/api/bot-riff`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ riff: JSON.stringify({ baseUrl: 'https://riff-new.example', sandboxCluster: 'sg' }) }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ ok: false, error: 'invalid_sandbox_cluster' });
    });
  });

  it('rejects a save without a valid http(s) baseUrl', async () => {
    await withRiffBot(async (base) => {
      const res = await fetch(`${base}/api/bot-riff`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ riff: JSON.stringify({ agent: 'codex' }) }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_base_url' });
    });
  });

  it('bot-defaults response never contains riff jwt/env', async () => {
    await withRiffBot(async (base) => {
      const res = await fetch(`${base}/api/bot-default-oncall`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('SECRET-JWT');
      expect(text).not.toContain('SECRET-ENV');
    });
  });
});

describe('PUT /api/bot-agent riff backend pairing', () => {
  it('reports a mismatch close that left a REMOTE session behind', async () => {
    // mojo / riff sessions live off-box: the local row can close while the remote
    // one survives. Flattening that into "closed N" loses the only handle an
    // operator has for cleanup, so the route must forward residual/failed too.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-residual-'));
    const dataDir = join(dir, 'data');
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-residual';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    const prevDataDir = config.session.dataDir;
    try {
      process.env.BOTS_CONFIG = configPath;
      config.session.dataDir = dataDir;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId, larkAppSecret: 'secret', cliId: 'claude-code',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      sessionStore.init(appId);

      // A live session frozen on the old agent, so the sweep has something to do.
      const session = sessionStore.createSession('oc_res', 'om_res', 'residual', 'group');
      session.larkAppId = appId;
      session.cliId = 'claude-code';
      session.agentFrozen = true;
      sessionStore.updateSession(session);
      workerPool.setActiveSessionsRegistry(new Map([[sessionKey(session.rootMessageId, appId), {
        session, worker: null, workerPort: null, workerToken: null,
        larkAppId: appId, chatId: session.chatId, chatType: 'group', scope: 'thread',
        spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(),
        hasHistory: true,
      } as any]]));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // All three counters must be present — not just the closed count.
      expect(body).toMatchObject({ closedMismatchedSessions: 1 });
      expect(body, 'residual must be reported alongside the count')
        .toHaveProperty('closedMismatchedResidual');
      expect(body, 'a refused close must be reportable too')
        .toHaveProperty('closedMismatchedFailed');
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      sessionStore.init();
      config.session.dataDir = prevDataDir;
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-pairs backendType=mojo when switching TO mojo', async () => {
    // The pairing must be driven by "is this a remote CLI", not by a hardcoded
    // 'riff'. mojo runs off-box and its resolvedBin is the empty string, so a bot
    // left on the default pty backend cannot spawn at all.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-mojo-pair-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-mojo-pair';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'codex',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'mojo', model: '' }),
      });
      expect(res.status).toBe(200);

      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.cliId).toBe('mojo');
      expect(stored.backendType, 'mojo must be paired with the mojo backend').toBe('mojo');
      const { getBot } = await import('../src/bot-registry.js');
      expect(getBot(appId).config.backendType).toBe('mojo');
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the auto-paired backendType=mojo when switching back to a local CLI', async () => {
    // Symmetric to the riff case: the clear branch must also test "is remote",
    // otherwise a mojo-paired bot keeps backendType=mojo after moving to codex and
    // every turn is dispatched as a remote mojo turn.
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-mojo-unpair-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-mojo-unpair';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'mojo',
        backendType: 'mojo',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });
      expect(res.status).toBe(200);

      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.cliId).toBe('codex');
      expect(stored.backendType, 'the remote pairing must be cleared').toBeUndefined();
      const { getBot } = await import('../src/bot-registry.js');
      expect(getBot(appId).config.backendType).toBeUndefined();
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the auto-paired backendType=riff when switching back to a non-riff CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-riff-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-riff-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'riff',
        riff: { baseUrl: 'https://riff.example' },
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });
      expect(res.status).toBe(200);

      // riff→codex：自动配对的 backendType 必须清掉，否则 Codex adapter 会跑在
      // RiffBackend 上（PTY 分块输入被当成一串 riff 任务）。
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.cliId).toBe('codex');
      expect(stored.backendType).toBeUndefined();
      const { getBot } = await import('../src/bot-registry.js');
      expect(getBot(appId).config.backendType).toBeUndefined();
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a manual non-riff backend override when switching CLIs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-agent-tmux-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-agent-tmux-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        backendType: 'tmux',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliId: 'codex', model: '' }),
      });
      expect(res.status).toBe(200);
      const stored = JSON.parse(readFileSync(configPath, 'utf-8'))[0];
      expect(stored.backendType).toBe('tmux');
    } finally {
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/bot-rename', () => {
  async function withRenameServer(fn: (base: string, configPath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rename-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-rename-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      await fn(`http://127.0.0.1:${handle.port}`, configPath);
    } finally {
      setBotRenamer(null);
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('renames via the wired Open Platform renamer (mode=feishu, no displayName written)', async () => {
    await withRenameServer(async (base, configPath) => {
      const seen: string[] = [];
      setBotRenamer(async (name) => { seen.push(name); return { ok: true, name }; });

      const res = await fetch(`${base}/api/bot-rename`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  新名字  ' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, mode: 'feishu' });
      expect(seen).toEqual(['新名字']); // trimmed before hitting the renamer
      // Feishu rename succeeded → no local alias persisted by the route.
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].displayName).toBeUndefined();
    });
  });

  it('falls back to the local displayName with a warning when the renamer fails', async () => {
    await withRenameServer(async (base, configPath) => {
      setBotRenamer(async () => ({ ok: false, reason: 'no_session', message: 'run botmux setup' }));

      const res = await fetch(`${base}/api/bot-rename`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '小助手' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        mode: 'local',
        warning: 'no_session',
        message: 'run botmux setup',
      });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].displayName).toBe('小助手');

      // The local alias surfaces on the bot-defaults GET.
      const get = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(get).toMatchObject({ displayName: '小助手' });
    });
  });

  it('rejects empty and over-long names without calling the renamer', async () => {
    await withRenameServer(async (base, configPath) => {
      let called = 0;
      setBotRenamer(async (name) => { called++; return { ok: true, name }; });

      const empty = await fetch(`${base}/api/bot-rename`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toMatchObject({ ok: false, error: 'name_required' });

      const long = await fetch(`${base}/api/bot-rename`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(65) }),
      });
      expect(long.status).toBe(400);
      expect(await long.json()).toMatchObject({ ok: false, error: 'too_long' });

      expect(called).toBe(0);
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].displayName).toBeUndefined();
    });
  });
});

describe('PUT /api/bot-avatar', () => {
  async function withAvatarServer(fn: (base: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-avatar-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-avatar-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      await fn(`http://127.0.0.1:${handle.port}`);
    } finally {
      setBotAvatarChanger(null);
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('decodes the (data-URL) base64 body and returns the changer outcome', async () => {
    await withAvatarServer(async (base) => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      const seen: Buffer[] = [];
      setBotAvatarChanger(async (image) => {
        seen.push(image);
        return { ok: true, avatarUrl: 'https://cdn.example/new-avatar', versionId: 'v-9' };
      });

      const res = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: `data:image/png;base64,${png.toString('base64')}` }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, avatarUrl: 'https://cdn.example/new-avatar', versionId: 'v-9' });
      expect(seen).toHaveLength(1);
      expect(seen[0].equals(png)).toBe(true); // data URL 前缀被剥掉、按 base64 解码
    });
  });

  it('maps changer failures to 502 (feishu-side) / 400 (invalid_image) with the structured reason', async () => {
    await withAvatarServer(async (base) => {
      setBotAvatarChanger(async () => ({ ok: false, reason: 'no_session', message: 'run botmux setup' }));
      const feishuFail = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: Buffer.from('x').toString('base64') }),
      });
      expect(feishuFail.status).toBe(502);
      expect(await feishuFail.json()).toMatchObject({ ok: false, error: 'no_session', message: 'run botmux setup' });

      setBotAvatarChanger(async () => ({ ok: false, reason: 'invalid_image', message: 'not a png' }));
      const badImage = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: Buffer.from('x').toString('base64') }),
      });
      expect(badImage.status).toBe(400);
      expect(await badImage.json()).toMatchObject({ ok: false, error: 'invalid_image' });
    });
  });

  it('rejects missing/oversized payloads without calling the changer, and 501s when unwired', async () => {
    await withAvatarServer(async (base) => {
      let called = 0;
      setBotAvatarChanger(async () => { called++; return { ok: true, avatarUrl: 'u' }; });

      const missing = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ ok: false, error: 'image_required' });

      // JSON 顶层为 null：属性访问前必须收窄，返回 400 而不是 500。
      const nullBody = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      });
      expect(nullBody.status).toBe(400);
      expect(await nullBody.json()).toMatchObject({ ok: false, error: 'image_required' });

      const huge = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: 'A'.repeat(3_000_001) }),
      });
      expect(huge.status).toBe(413);
      expect(await huge.json()).toMatchObject({ ok: false, error: 'image_too_large' });

      expect(called).toBe(0);

      setBotAvatarChanger(null);
      const unwired = await fetch(`${base}/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: Buffer.from('x').toString('base64') }),
      });
      expect(unwired.status).toBe(501);
      expect(await unwired.json()).toMatchObject({ ok: false, error: 'avatar_not_wired' });
    });
  });
});

describe('GET/PUT /api/bot-description', () => {
  async function withDescriptionServer(fn: (base: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-description-ipc-'));
    const configPath = join(dir, 'bots.json');
    const appId = 'test-description-app';
    const prevBotsConfig = process.env.BOTS_CONFIG;
    try {
      process.env.BOTS_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify([{
        larkAppId: appId,
        larkAppSecret: 'secret',
        cliId: 'claude-code',
      }], null, 2));
      loadBotConfigs().forEach((c: any) => registerBot(c));
      setLarkAppId(appId);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      await fn(`http://127.0.0.1:${handle.port}`);
    } finally {
      setBotDescriptionManager(null);
      if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads and updates descriptions through the registered manager', async () => {
    await withDescriptionServer(async base => {
      const updates: Array<Record<string, string>> = [];
      setBotDescriptionManager({
        read: async () => ({
          ok: true, primaryLang: 'zh_cn',
          languages: [{ lang: 'zh_cn', description: '中文' }, { lang: 'en_us', description: 'English' }],
        }),
        update: async descriptions => {
          updates.push(descriptions);
          return { ok: true, primaryLang: 'zh_cn', descriptions, versionId: 'v-1' };
        },
      });
      expect(await (await fetch(`${base}/api/bot-description`)).json()).toMatchObject({
        ok: true, primaryLang: 'zh_cn',
      });
      const saved = await fetch(`${base}/api/bot-description`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ descriptions: { zh_cn: ' 新中文 ', en_us: ' New English ' } }),
      });
      expect(saved.status).toBe(200);
      expect(updates).toEqual([{ zh_cn: '新中文', en_us: 'New English' }]);
    });
  });

  it.each([
    ['languages_changed', 409],
    ['description_required', 400],
    ['description_too_long', 400],
    ['invalid_descriptions', 400],
    ['no_session', 502],
    ['session_expired', 502],
    ['no_access', 502],
    ['unsupported_brand', 502],
    ['api_error', 502],
  ] as const)('maps manager failure %s to HTTP %i', async (reason, status) => {
    await withDescriptionServer(async base => {
      setBotDescriptionManager({
        read: async () => ({ ok: false, reason: 'api_error', message: 'read failed' }),
        update: async () => ({ ok: false, reason, message: 'update failed' }),
      });
      const response = await fetch(`${base}/api/bot-description`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ descriptions: { zh_cn: '中文' } }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, error: reason });
    });
  });

  it.each([
    ['null', 'invalid_body'],
    ['[]', 'invalid_body'],
    [JSON.stringify({ descriptions: { zh_cn: '' } }), 'description_required'],
    [JSON.stringify({ descriptions: { bad: 'x' } }), 'invalid_descriptions'],
    [JSON.stringify({ descriptions: { zh_cn: 'x' }, extra: true }), 'invalid_body'],
  ] as const)('rejects malformed input without calling the manager', async (body, error) => {
    await withDescriptionServer(async base => {
      let updates = 0;
      setBotDescriptionManager({
        read: async () => ({ ok: false, reason: 'api_error', message: 'unused' }),
        update: async descriptions => { updates += 1; return { ok: true, primaryLang: 'zh_cn', descriptions }; },
      });
      const response = await fetch(`${base}/api/bot-description`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error });
      expect(updates).toBe(0);
    });
  });

  it('bounds PUT bodies and rejects malformed JSON', async () => {
    await withDescriptionServer(async base => {
      setBotDescriptionManager({
        read: async () => ({ ok: false, reason: 'api_error', message: 'unused' }),
        update: async descriptions => ({ ok: true, primaryLang: 'zh_cn', descriptions }),
      });
      const oversized = await fetch(`${base}/api/bot-description`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ descriptions: { zh_cn: 'x'.repeat(64 * 1024) } }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ ok: false, error: 'body_too_large' });
      const malformed = await fetch(`${base}/api/bot-description`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ ok: false, error: 'invalid_json' });
    });
  });

  it('returns 501 when no description manager is registered', async () => {
    await withDescriptionServer(async base => {
      setBotDescriptionManager(null);
      for (const method of ['GET', 'PUT'] as const) {
        const response = await fetch(`${base}/api/bot-description`, {
          method,
          headers: method === 'PUT' ? { 'content-type': 'application/json' } : undefined,
          body: method === 'PUT' ? JSON.stringify({ descriptions: { zh_cn: '中文' } }) : undefined,
        });
        expect(response.status).toBe(501);
      }
    });
  });

  it('passes through successful and failed reads', async () => {
    await withDescriptionServer(async base => {
      setBotDescriptionManager({
        read: async () => ({
          ok: true, primaryLang: 'zh_cn',
          languages: [{ lang: 'zh_cn', description: '中文' }],
        }),
        update: async descriptions => ({ ok: true, primaryLang: 'zh_cn', descriptions }),
      });
      expect(await (await fetch(`${base}/api/bot-description`)).json()).toMatchObject({ ok: true });
      setBotDescriptionManager({
        read: async () => ({ ok: false, reason: 'no_access', message: 'denied' }),
        update: async descriptions => ({ ok: true, primaryLang: 'zh_cn', descriptions }),
      });
      const failed = await fetch(`${base}/api/bot-description`);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ ok: false, error: 'no_access' });
    });
  });
});

describe('GET /api/groups (Phase B)', () => {
  it('returns 503 when larkAppId not set', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('larkAppId_not_set');
  });

  it('lists chats from groups-store when larkAppId set', async () => {
    setLarkAppId('test-app');
    const bot = registerBot({
      larkAppId: 'test-app',
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
      workingDirs: [process.cwd()],
    } as any);
    bot.botOpenId = 'ou_test_bot';
    bot.botName = 'Codex Test Bot';
    const spy = vi.spyOn(groupsStore, 'listChats').mockResolvedValue([
      { chatId: 'oc_1', name: 'team' },
    ]);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bots).toEqual([{
      larkAppId: 'test-app',
      botOpenId: 'ou_test_bot',
      botName: 'Codex Test Bot',
      cliId: 'codex',
    }]);
    // Each chat now carries an `oncallChat` enrichment (null when unbound)
    // so the dashboard matrix can render toggle state without a second
    // round-trip.
    // `firstSeenAt` is the per-bot creation-order proxy added so the
    // dashboard can sort newly-added chats to the top. In this test the
    // store hasn't been init()'d (no daemon), so the value degrades to
    // null instead of failing the request — see chat-first-seen-store.
    // `hasMessageListener` lets the roles tree mark bots with active listener
    // configs without issuing one request per chat.
    expect(body.chats).toEqual([{ chatId: 'oc_1', name: 'team', oncallChat: null, firstSeenAt: null, hasRole: false, hasMessageListener: false, observedBotNames: [] }]);
    spy.mockRestore();
  });
});

describe('PUT/DELETE /api/oncall/:chatId', () => {
  it('rejects PUT without workingDir', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('workingDir_required');
  });

  it('rejects PUT with non-existent path', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: '/nonexistent/path/xyz' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/目录不存在/);
  });

  it('returns 503 when larkAppId not set (DELETE)', async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, { method: 'DELETE' });
    expect(res.status).toBe(503);
  });

  it('PUT happy path forwards to bindOncall and echoes resolvedPath', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'bindOncall').mockResolvedValue({
      ok: true,
      entry: { chatId: 'oc_1', workingDir: '/tmp' },
      created: true,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.entry).toEqual({ chatId: 'oc_1', workingDir: '/tmp' });
    expect(body.resolvedPath).toBe('/tmp');
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_1', '/tmp');
    spy.mockRestore();
  });

  it('DELETE happy path forwards to unbindOncall', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'unbindOncall').mockResolvedValue({ ok: true, wasBound: true });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasBound).toBe(true);
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_1');
    spy.mockRestore();
  });

  it('DELETE is idempotent — succeeds even when chat was not bound, and surfaces wasBound=false', async () => {
    // Updated semantics: unbind on a not-bound chat is no longer an error,
    // because unbindOncall always writes a tombstone into
    // defaultOncallAutoboundChats so the auto-bind judge won't reinstate
    // the chat. The route reflects that with 200 + wasBound:false.
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'unbindOncall').mockResolvedValue({
      ok: true,
      wasBound: false,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/oncall/oc_1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasBound).toBe(false);
    spy.mockRestore();
  });
});

describe('POST /api/groups/:chatId/add-bots (Phase B)', () => {
  it('rejects bad body', async () => {
    setLarkAppId('test-app');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_1/add-bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('forwards to groups-store and returns per-id result', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([
      { id: 'cli_X', ok: true },
      { id: 'cli_Y', ok: false, error: 'invalid_id' },
    ]);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/oc_1/add-bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['cli_X', 'cli_Y'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual([
      { id: 'cli_X', ok: true },
      { id: 'cli_Y', ok: false, error: 'invalid_id' },
    ]);
    spy.mockRestore();
  });
});

describe('POST /api/groups/create', () => {
  it('forwards bindWorkingDir after validating it is an existing directory', async () => {
    setLarkAppId('test-app');
    const spy = vi.spyOn(oncallStore, 'bindOncall').mockResolvedValue({
      ok: true,
      entry: { chatId: 'oc_new', workingDir: process.cwd() },
      created: true,
    });
    const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
      chatId: 'oc_new',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    const addSpy = vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([
      { id: 'cli_X', ok: true },
    ]);
    const linkSpy = vi.spyOn(groupsStore, 'getChatShareLink').mockResolvedValue({
      ok: true,
      shareLink: 'https://example.test/chat',
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['test-app', 'cli_X'], bindWorkingDir: process.cwd() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bindResolvedPath).toBe(process.cwd());
    expect(body.oncallBindings).toEqual([
      { larkAppId: 'test-app', ok: true, created: true },
      { larkAppId: 'cli_X', ok: true, created: true },
    ]);
    expect(createSpy).toHaveBeenCalledWith('test-app', {
      name: undefined,
      botIds: [],
      userIds: [],
    });
    expect(addSpy).toHaveBeenCalledWith('test-app', 'oc_new', ['cli_X']);
    expect(spy).toHaveBeenCalledWith('test-app', 'oc_new', process.cwd());
    expect(spy).toHaveBeenCalledWith('cli_X', 'oc_new', process.cwd());
    addSpy.mockRestore();
    spy.mockRestore();
    createSpy.mockRestore();
    linkSpy.mockRestore();
  });

  it('rejects missing bindWorkingDir before creating the group', async () => {
    setLarkAppId('test-app');
    const createSpy = vi.spyOn(groupsStore, 'createChat').mockResolvedValue({
      chatId: 'oc_should_not_create',
      invalidBotIds: [],
      invalidUserIds: [],
    });
    const addSpy = vi.spyOn(groupsStore, 'addBotToChat').mockResolvedValue([]);
    const bindSpy = vi.spyOn(oncallStore, 'bindOncall').mockResolvedValue({
      ok: true,
      entry: { chatId: 'oc_should_not_bind', workingDir: process.cwd() },
      created: true,
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppIds: ['test-app'], bindWorkingDir: '/definitely/not/a/real/botmux/path' }),
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();
    bindSpy.mockRestore();
    addSpy.mockRestore();
    createSpy.mockRestore();
  });
});

describe('POST /api/groups/transfer-owner', () => {
  it('completes a deferred transfer by union_id and notifies the new owner', async () => {
    setLarkAppId('test-app');
    const transferSpy = vi.spyOn(groupsStore, 'transferChatOwner').mockResolvedValue({ ok: true });
    const notifySpy = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_owner');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/transfer-owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_new', ownerUnionId: 'on_operator' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ownerTransferredTo: 'on_operator',
      transferError: null,
      notifyMessageId: 'om_owner',
    });
    expect(transferSpy).toHaveBeenCalledWith('test-app', 'oc_new', 'on_operator', 'union_id');
    expect(notifySpy).toHaveBeenCalledWith(
      'test-app', 'oc_new', '<at user_id="on_operator"></at>', 'text',
    );
    notifySpy.mockRestore();
    transferSpy.mockRestore();
  });

  it('rejects malformed chat or union ids before calling Feishu', async () => {
    setLarkAppId('test-app');
    const transferSpy = vi.spyOn(groupsStore, 'transferChatOwner').mockResolvedValue({ ok: true });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/groups/transfer-owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'bad', ownerUnionId: 'ou_wrong_scope' }),
    });
    expect(res.status).toBe(400);
    expect(transferSpy).not.toHaveBeenCalled();
    transferSpy.mockRestore();
  });
});

describe('role profile IPC routes', () => {
  it('previews message listener matches from recent chat history', async () => {
    setLarkAppId('cli_listener');
    registerBot({
      larkAppId: 'cli_listener',
      larkAppSecret: 'secret',
      cliId: 'codex',
    });
    const now = Date.now();
    const historySpy = vi.spyOn(larkClient, 'listChatMessagesUntil').mockImplementation(async (_larkAppId, _chatId, options) => {
      expect(options?.pageSize).toBe(50);
      expect(options?.stopAfter?.({ create_time: String(now - 24 * 60 * 60 * 1000 - 60_000) }, 1)).toBe(true);
      expect(options?.stopAfter?.({ create_time: String(now - 24 * 60 * 60 * 1000 + 60_000) }, 1)).toBe(false);
      return [
        {
          message_id: 'om_ignore',
          create_time: String(now - 10_000),
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'ignore' }) },
          sender: { id: 'ou_other', sender_type: 'user', sender_name: 'Other' },
        },
        {
          message_id: 'om_match',
          create_time: String(now - 5_000),
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'CPU 告警' }) },
          sender: { id: 'ou_allowed', sender_type: 'user', sender_name: '张三' },
        },
      ];
    });
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const res = await fetch(`${base}/api/message-listeners/oc_alerts/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: 50,
          listener: {
            enabled: true,
            prompt: '分析告警',
            senderPolicy: {
              mode: 'include_only',
              includeSenderOpenIds: ['ou_allowed'],
              includeSenderTypes: ['user'],
            },
            messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        requestedLimit: 20,
        matches: [{
          messageId: 'om_match',
          messageText: 'CPU 告警',
          senderOpenId: 'ou_allowed',
          senderName: '张三',
          senderType: 'user',
        }],
      });
      expect(historySpy).toHaveBeenCalledWith('cli_listener', 'oc_alerts', expect.any(Object));
    } finally {
      historySpy.mockRestore();
    }
  });

  it('runs message listener preview through the visible listener reply path', async () => {
    setLarkAppId('cli_listener_run');
    registerBot({
      larkAppId: 'cli_listener_run',
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
    });
    const activeSessions = new Map<string, any>();
    const now = Date.now();
    const historySpy = vi.spyOn(larkClient, 'listChatMessagesUntil').mockResolvedValue([
      {
        message_id: 'om_match_run',
        create_time: String(now - 5_000),
        msg_type: 'text',
        body: { content: JSON.stringify({ text: 'CPU 告警' }) },
        sender: { id: 'ou_allowed', sender_type: 'user', sender_name: '张三' },
      },
    ]);
    const inChatSpy = vi.spyOn(groupsStore, 'isInChat').mockResolvedValue(true);
    const chatModeSpy = vi.spyOn(larkClient, 'getChatMode').mockResolvedValue('topic');
    const messageChatSpy = vi.spyOn(larkClient, 'getMessageChatId').mockResolvedValue('oc_alerts');
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      workerPool.setActiveSessionsRegistry(activeSessions);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const res = await fetch(`${base}/api/message-listeners/oc_alerts/run-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: 5,
          listener: {
            enabled: true,
            prompt: '分析告警',
            senderPolicy: {
              mode: 'include_only',
              includeSenderOpenIds: ['ou_allowed'],
              includeSenderTypes: ['user'],
            },
            messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        runId: expect.stringMatching(/^mlrp_/),
        matches: [{ messageId: 'om_match_run', messageText: 'CPU 告警' }],
        results: [{
          messageId: 'om_match_run',
          ok: true,
          action: 'queued',
          state: 'triggered',
          runId: expect.stringMatching(/^mlrp_/),
          triggerId: expect.stringMatching(/^mlrp_turn_/),
        }],
      });
      expect(body.results[0].runId).toBe(body.runId);
      expect(messageChatSpy).toHaveBeenCalledWith('cli_listener_run', 'om_match_run');
      expect(forkSpy).toHaveBeenCalledTimes(1);
      expect(forkSpy.mock.calls[0][2]).toMatch(/^mlrp_turn_/);
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      forkSpy.mockRestore();
      messageChatSpy.mockRestore();
      chatModeSpy.mockRestore();
      inChatSpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  it('does not match or fork a run-preview session for a history message that explicitly @mentions this bot', async () => {
    setLarkAppId('cli_listener_run');
    registerBot({
      larkAppId: 'cli_listener_run',
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
    });
    getBot('cli_listener_run').botOpenId = 'ou_this_bot';
    const activeSessions = new Map<string, any>();
    const now = Date.now();
    // Same allowed sender + type as the happy path, but the message explicitly
    // @mentions THIS bot → realtime/poll routing hands it to normal @-routing,
    // so preview must NOT match it and run-preview must NOT fork a session.
    const historySpy = vi.spyOn(larkClient, 'listChatMessagesUntil').mockResolvedValue([
      {
        message_id: 'om_mention_run',
        create_time: String(now - 5_000),
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '@bot CPU 告警' }) },
        sender: { id: 'ou_allowed', sender_type: 'user', sender_name: '张三' },
        // REST message-list shape: mention id is a bare string + id_type (not
        // the WS object form) — this is what listChatMessagesUntil returns.
        mentions: [{ key: '@_user_1', id: 'ou_this_bot', id_type: 'open_id', name: 'bot' }],
      },
    ]);
    const inChatSpy = vi.spyOn(groupsStore, 'isInChat').mockResolvedValue(true);
    const chatModeSpy = vi.spyOn(larkClient, 'getChatMode').mockResolvedValue('topic');
    const messageChatSpy = vi.spyOn(larkClient, 'getMessageChatId').mockResolvedValue('oc_alerts');
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      workerPool.setActiveSessionsRegistry(activeSessions);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const res = await fetch(`${base}/api/message-listeners/oc_alerts/run-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: 5,
          listener: {
            enabled: true,
            prompt: '分析告警',
            senderPolicy: {
              mode: 'include_only',
              includeSenderOpenIds: ['ou_allowed'],
              includeSenderTypes: ['user'],
            },
            messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.matches).toEqual([]);
      expect(body.results).toEqual([]);
      // The explicit @mention hands off to normal routing → no session spawned.
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      forkSpy.mockRestore();
      messageChatSpy.mockRestore();
      chatModeSpy.mockRestore();
      inChatSpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  it('reports message listener run preview reply lifecycle by run id', async () => {
    setLarkAppId('cli_listener_status');
    registerBot({
      larkAppId: 'cli_listener_status',
      larkAppSecret: 'secret',
      cliId: 'codex',
      workingDir: process.cwd(),
    });
    const activeSessions = new Map<string, any>();
    const now = Date.now();
    const historySpy = vi.spyOn(larkClient, 'listChatMessagesUntil').mockResolvedValue([
      {
        message_id: 'om_match_status',
        create_time: String(now - 5_000),
        msg_type: 'text',
        body: { content: JSON.stringify({ text: 'CPU 告警' }) },
        sender: { id: 'ou_allowed', sender_type: 'user', sender_name: '张三' },
      },
    ]);
    const inChatSpy = vi.spyOn(groupsStore, 'isInChat').mockResolvedValue(true);
    const chatModeSpy = vi.spyOn(larkClient, 'getChatMode').mockResolvedValue('topic');
    const messageChatSpy = vi.spyOn(larkClient, 'getMessageChatId').mockResolvedValue('oc_alerts');
    const forkSpy = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {});
    try {
      workerPool.setActiveSessionsRegistry(activeSessions);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const runRes = await fetch(`${base}/api/message-listeners/oc_alerts/run-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          limit: 5,
          listener: {
            enabled: true,
            prompt: '分析告警',
            senderPolicy: {
              mode: 'include_only',
              includeSenderOpenIds: ['ou_allowed'],
              includeSenderTypes: ['user'],
            },
            messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
          },
        }),
      });
      expect(runRes.status).toBe(200);
      const runBody = await runRes.json();
      const triggerId = runBody.results[0].triggerId;

      markMessageListenerRunPreviewReplied(triggerId, {
        sessionId: runBody.results[0].sessionId,
        replyMessageId: 'om_reply_status',
      });

      const statusRes = await fetch(`${base}/api/message-listeners/oc_alerts/run-preview/${runBody.runId}`);
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toMatchObject({
        ok: true,
        runId: runBody.runId,
        results: [{
          messageId: 'om_match_status',
          ok: true,
          state: 'replied',
          triggerId,
          replyMessageId: 'om_reply_status',
        }],
      });
    } finally {
      workerPool.setActiveSessionsRegistry(new Map());
      forkSpy.mockRestore();
      messageChatSpy.mockRestore();
      chatModeSpy.mockRestore();
      inChatSpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  it('returns multiple role snapshots in one daemon request', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-role-batch-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    try {
      process.env.SESSION_DATA_DIR = dataDir;
      config.session.dataDir = dataDir;
      setLarkAppId('cli_profile');
      writeRoleFile('cli_profile', 'oc_explicit', '# Explicit role');
      writeTeamRoleFile('cli_profile', '# Team fallback');
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const batch = await fetch(`${base}/api/roles/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatIds: ['oc_explicit', 'oc_fallback', 'oc_explicit'] }),
      });
      expect(batch.status).toBe(200);
      expect((await batch.json()).roles).toMatchObject([
        {
          chatId: 'oc_explicit',
          content: '# Explicit role',
          hasRole: true,
          effectiveContent: '# Explicit role',
          effectiveSource: 'chat',
        },
        {
          chatId: 'oc_fallback',
          content: null,
          hasRole: false,
          effectiveContent: '# Team fallback',
          effectiveSource: 'team',
        },
      ]);

      const invalid = await fetch(`${base}/api/roles/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatIds: ['../escape'] }),
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toBe('invalid_chat_id');
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns effective team role metadata for dashboard save-as-profile flows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-role-effective-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    try {
      process.env.SESSION_DATA_DIR = dataDir;
      config.session.dataDir = dataDir;
      setLarkAppId('cli_profile');
      writeTeamRoleFile('cli_profile', '# Default reviewer\nUse concise bullets.');
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const role = await fetch(`${base}/api/roles/oc_effective`);
      expect(role.status).toBe(200);
      expect(await role.json()).toMatchObject({
        chatId: 'oc_effective',
        content: null,
        hasRole: false,
        effectiveContent: '# Default reviewer\nUse concise bullets.',
        effectiveSource: 'team',
        hasEffectiveRole: true,
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('round-trips and deletes the dispatch completion switch per bot + chat', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dashboard-ipc-role-dispatch-'));
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    try {
      process.env.SESSION_DATA_DIR = dataDir;
      config.session.dataDir = dataDir;
      setLarkAppId('cli_source');
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const roleUrl = `${base}/api/roles/oc_dispatch`;
      const metaPath = join(dataDir, 'roles', 'cli_source', 'oc_dispatch.meta.json');

      const initial = await fetch(roleUrl);
      expect(await initial.json()).toMatchObject({
        chatId: 'oc_dispatch',
        dispatchCompletionEnabled: false,
      });

      const enabled = await fetch(roleUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Dispatcher', injectMode: 'once', dispatchCompletionEnabled: true }),
      });
      expect(enabled.status).toBe(200);
      expect(await (await fetch(roleUrl)).json()).toMatchObject({
        injectMode: 'once',
        dispatchCompletionEnabled: true,
      });

      const disabled = await fetch(roleUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dispatchCompletionEnabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(await (await fetch(roleUrl)).json()).toMatchObject({
        injectMode: 'once',
        dispatchCompletionEnabled: false,
      });

      await fetch(roleUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dispatchCompletionEnabled: true }),
      });
      expect(existsSync(metaPath)).toBe(true);
      const deleted = await fetch(roleUrl, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(existsSync(metaPath)).toBe(false);
      expect(await (await fetch(roleUrl)).json()).toMatchObject({
        content: null,
        injectMode: 'every',
        dispatchCompletionEnabled: false,
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects wrong-daemon role profile mutations', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const saveWrong = await fetch(`${base}/api/role-profiles/collab-main/cli_other`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Other daemon' }),
      });
      expect(saveWrong.status).toBe(403);
      expect((await saveWrong.json()).error).toBe('wrong_daemon');

      const deleteWrong = await fetch(`${base}/api/role-profiles/collab-main/cli_other`, { method: 'DELETE' });
      expect(deleteWrong.status).toBe(403);
      expect((await deleteWrong.json()).error).toBe('wrong_daemon');

      const applyWrong = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_other' }),
      });
      expect(applyWrong.status).toBe(403);
      expect((await applyWrong.json()).error).toBe('wrong_daemon');
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid chat ids before role/profile writes', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const roleWrite = await fetch(`${base}/api/roles/not-a-chat`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Bad chat' }),
      });
      expect(roleWrite.status).toBe(400);
      expect((await roleWrite.json()).error).toBe('invalid_chat_id');

      const apply = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: '../escape', larkAppId: 'cli_profile' }),
      });
      expect(apply.status).toBe(400);
      expect((await apply.json()).error).toBe('invalid_chat_id');
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects encoded traversal profile ids before touching storage', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/role-profiles/%2E%2E/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'bad' }),
      });
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stores a profile entry and materializes it into a chat role', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const save = await fetch(`${base}/api/role-profiles/collab-main/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Reviewer\nBe strict.' }),
      });
      expect(save.status).toBe(200);
      expect((await save.json()).ok).toBe(true);

      const list = await fetch(`${base}/api/role-profiles`);
      expect(list.status).toBe(200);
      expect((await list.json()).profiles).toMatchObject([
        { profileId: 'collab-main', entryCount: 1, hasCurrentBotEntry: true },
      ]);

      const preview = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_profile', preview: true }),
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        ok: true,
        preview: true,
        changed: false,
        wouldOverwrite: false,
        wouldRefuse: false,
        content: '# Reviewer\nBe strict.',
      });

      const apply = await fetch(`${base}/api/role-profiles/collab-main/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_role', larkAppId: 'cli_profile' }),
      });
      expect(apply.status).toBe(200);
      expect((await apply.json()).changed).toBe(true);

      const role = await fetch(`${base}/api/roles/oc_role`);
      expect(role.status).toBe(200);
      expect(await role.json()).toMatchObject({
        chatId: 'oc_role',
        content: '# Reviewer\nBe strict.',
        hasRole: true,
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stores explicit empty profile entries and applies them as no chat role', async () => {
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-profile-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      const save = await fetch(`${base}/api/role-profiles/collab-empty/cli_profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '', allowEmpty: true }),
      });
      expect(save.status).toBe(200);
      expect(await save.json()).toMatchObject({ ok: true, byteLength: 0 });

      const entry = await fetch(`${base}/api/role-profiles/collab-empty/cli_profile`);
      expect(await entry.json()).toMatchObject({
        profileId: 'collab-empty',
        larkAppId: 'cli_profile',
        content: '',
        byteLength: 0,
        hasEntry: true,
      });

      const list = await fetch(`${base}/api/role-profiles`);
      expect((await list.json()).profiles).toMatchObject([
        { profileId: 'collab-empty', entryCount: 1, hasCurrentBotEntry: true },
      ]);

      const applyNoExisting = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile' }),
      });
      expect(applyNoExisting.status).toBe(200);
      expect(await applyNoExisting.json()).toMatchObject({ ok: true, changed: false, deleted: false });

      const roleWrite = await fetch(`${base}/api/roles/oc_empty`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Existing role' }),
      });
      expect(roleWrite.status).toBe(200);

      const applyRefused = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile' }),
      });
      expect(applyRefused.status).toBe(409);
      expect((await applyRefused.json()).error).toBe('chat_role_exists');

      const applyForce = await fetch(`${base}/api/role-profiles/collab-empty/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_empty', larkAppId: 'cli_profile', force: true }),
      });
      expect(applyForce.status).toBe(200);
      expect(await applyForce.json()).toMatchObject({ ok: true, changed: true, deleted: true });

      const role = await fetch(`${base}/api/roles/oc_empty`);
      expect(await role.json()).toMatchObject({ chatId: 'oc_empty', content: null, hasRole: false });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reports `changed` so the dashboard only invalidates on real hasRole mutations', async () => {
    // The groups-matrix snapshot keys off `changed` to avoid busting its 30s
    // cache on no-op writes. A content PUT / real DELETE flip hasRole
    // (changed:true); an injectMode-only PUT and a delete-not-found do NOT
    // (changed:false) — otherwise the common inject-mode toggle would punch
    // through the cache and re-fan-out across every daemon.
    const prevDataDir = process.env.SESSION_DATA_DIR;
    const prevConfigDataDir = config.session.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-changed-ipc-'));
    config.session.dataDir = dataDir;
    setLarkAppId('cli_profile');
    try {
      handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;

      // Content PUT writes the role file → changed:true.
      const putContent = await fetch(`${base}/api/roles/oc_changed`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Role\nhello' }),
      });
      expect(putContent.status).toBe(200);
      expect(await putContent.json()).toMatchObject({ ok: true, changed: true });

      // injectMode-only PUT touches just the .meta.json sidecar → changed:false.
      const putMode = await fetch(`${base}/api/roles/oc_changed`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ injectMode: 'once' }),
      });
      expect(putMode.status).toBe(200);
      expect(await putMode.json()).toMatchObject({ ok: true, changed: false });

      // DELETE that removed the existing file → changed:true.
      const delExisting = await fetch(`${base}/api/roles/oc_changed`, { method: 'DELETE' });
      expect(delExisting.status).toBe(200);
      expect(await delExisting.json()).toMatchObject({ ok: true, existed: true, changed: true });

      // DELETE with nothing to remove → changed:false.
      const delMissing = await fetch(`${base}/api/roles/oc_changed`, { method: 'DELETE' });
      expect(delMissing.status).toBe(200);
      expect(await delMissing.json()).toMatchObject({ ok: true, existed: false, changed: false });
    } finally {
      if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevDataDir;
      config.session.dataDir = prevConfigDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('core-only public routes + readiness barrier (behavioral)', () => {
  afterEach(async () => {
    __testOnly_resetCoreOnlyReadiness();
    if (handle) { await handle.close(); handle = null; }
  });

  it('allowlists ONLY trigger/trigger-result/insight (no HMAC), everything else still 401', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    setLarkAppId('local_smoke');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    setCoreOnlyReady(); // past the readiness barrier for this case
    const base = `http://127.0.0.1:${handle.port}`;
    // Allowlisted (no auth header) → must NOT be 401 (reaches handler: 400 bad-shape / 200 / 404).
    const trig = await fetch(`${base}/api/trigger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(trig.status).not.toBe(401);
    const tr = await fetch(`${base}/api/sessions/nope/trigger-result`);
    expect(tr.status).not.toBe(401);
    const ins = await fetch(`${base}/api/sessions/nope/insight?detail=conversation`);
    expect(ins.status).not.toBe(401);
    // NOT allowlisted (no auth header) → 401.
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/asks/pending`)).status).toBe(401);
    // /api/asks/answer is deliberately excluded from the allowlist → 401.
    expect((await fetch(`${base}/api/asks/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"askId":"x","selections":[]}' })).status).toBe(401);
  });

  it('readiness barrier: control routes AND /healthz return 503 until ready, without a healthz pre-check', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    setLarkAppId('local_smoke');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    armCoreOnlyReadinessGate(); // armed, NOT ready
    const base = `http://127.0.0.1:${handle.port}`;
    // Directly hit a control route WITHOUT probing /healthz first — must be 503.
    const early = await fetch(`${base}/api/trigger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(early.status).toBe(503);
    expect((await early.json()).status).toBe('starting');
    // /healthz also reports starting.
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(503);
    expect((await h.json()).status).toBe('starting');
    // After release: healthz 200 and the control route reaches its handler (not 503).
    setCoreOnlyReady();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const afterReady = await fetch(`${base}/api/trigger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(afterReady.status).not.toBe(503);
  });

  it('does NOT gate a normal (non-core-only) server: /healthz is unconditional 200', async () => {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' }); // no coreOnlyPublicRoutes
    // Even if some other test armed the gate, a server without coreOnlyPublicRoutes
    // never 503s its control routes (they require HMAC anyway); /healthz stays 200
    // because the gate is only consulted for the core-only public surface.
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // Form C: trigger-result carries a read-only web-terminal URL while a live
  // worker terminal exists, so an async caller (riff's task-runner) can open
  // the visible CLI TUI in the sandbox browser.
  it('trigger-result exposes readOnlyUrl + viewToken when a live worker terminal is up (core-only)', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    setLarkAppId('local_smoke');
    setCoreOnlyReady();
    const prevCoreOnly = process.env.BOTMUX_CORE_ONLY;
    process.env.BOTMUX_CORE_ONLY = '1';
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-term', chatId: 'http_async_x', larkAppId: 'local_smoke', status: 'open' },
      chatId: 'http_async_x',
      larkAppId: 'local_smoke',
      workerPort: 4321,
      workerToken: 'write-tok',
      workerViewToken: 'view-cap-abc',
      asyncTriggerResults: new Map(),
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-term/trigger-result`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.readOnlyUrl).toBe('string');
      // Carries the read capability inline, NOT the write token.
      expect(body.readOnlyUrl).toContain('viewToken=view-cap-abc');
      expect(body.readOnlyUrl).not.toContain('write-tok');
      expect(body.viewToken).toBe('view-cap-abc');
    } finally {
      if (prevCoreOnly === undefined) delete process.env.BOTMUX_CORE_ONLY;
      else process.env.BOTMUX_CORE_ONLY = prevCoreOnly;
      findSpy.mockRestore();
    }
  });

  // codex review concern #1: the readOnlyUrl/viewToken attach must be gated to
  // core-only. On a normal/mixed fleet trigger-result must NEVER mint a terminal
  // read-capability into the poll response — even with a live worker terminal —
  // or an HMAC-authed trigger caller would gain a view token the route never
  // historically handed out (tokens are minted only on explicit /write-link).
  it('trigger-result does NOT expose readOnlyUrl on a NON-core-only fleet even with a live worker terminal', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    setLarkAppId('local_smoke');
    const prevCoreOnly = process.env.BOTMUX_CORE_ONLY;
    delete process.env.BOTMUX_CORE_ONLY; // normal fleet
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-fleet', chatId: 'oc_real_chat', larkAppId: 'local_smoke', status: 'open' },
      chatId: 'oc_real_chat',
      larkAppId: 'local_smoke',
      workerPort: 4321,               // live worker terminal present …
      workerToken: 'write-tok',
      workerViewToken: 'view-cap-abc',
      asyncTriggerResults: new Map(),
    } as any);
    // Normal fleet: default server (no coreOnlyPublicRoutes) — trigger-result
    // is HMAC-gated; authorize with the same unbound token the write-link tests
    // use so the request reaches the handler.
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-fleet/trigger-result`, { headers: tokenAuthHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      // … but NO terminal capability is leaked into the poll response.
      expect(body.readOnlyUrl).toBeUndefined();
      expect(body.viewToken).toBeUndefined();
    } finally {
      if (prevCoreOnly === undefined) delete process.env.BOTMUX_CORE_ONLY;
      else process.env.BOTMUX_CORE_ONLY = prevCoreOnly;
      findSpy.mockRestore();
    }
  });

  it('trigger-result omits readOnlyUrl when the live session has no worker terminal yet (core-only)', async () => {
    setIpcAuthSecret(TEST_IPC_SECRET);
    setLarkAppId('local_smoke');
    setCoreOnlyReady();
    const prevCoreOnly = process.env.BOTMUX_CORE_ONLY;
    process.env.BOTMUX_CORE_ONLY = '1';
    const findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noterm', chatId: 'http_async_y', larkAppId: 'local_smoke', status: 'open' },
      chatId: 'http_async_y',
      larkAppId: 'local_smoke',
      workerPort: null,          // worker web server not up yet
      workerViewToken: null,
      asyncTriggerResults: new Map(),
    } as any);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-noterm/trigger-result`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.readOnlyUrl).toBeUndefined();
      expect(body.viewToken).toBeUndefined();
    } finally {
      if (prevCoreOnly === undefined) delete process.env.BOTMUX_CORE_ONLY;
      else process.env.BOTMUX_CORE_ONLY = prevCoreOnly;
      findSpy.mockRestore();
    }
  });
});
