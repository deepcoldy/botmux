import { createProtectedLoopbackProxyAttestation, PROTECTED_LOOPBACK_ATTESTATION_HEADER } from '../src/core/protected-loopback-attestation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetTriggerTurns, rememberTriggerTurn } from '../src/core/turn-origin.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import { spawnTsEvalWithRepoImports, spawnTsScript } from './helpers/ts-runner.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishActiveTurn, writeSessionIdentity, recallProvenIdentityContent } from '../src/core/cli-identity.js';
import { config } from '../src/config.js';
import type { CredentialGrantRequest, CredentialGrantResult } from '../src/platform/credential-grant-client.js';
import { trackTurnIdentityPublication } from '../src/core/turn-cli-identity.js';

let ipc: IpcServerHandle | null = null;
let previousDataDir = '';
afterEach(async () => {
  __testOnly_resetTriggerTurns();
  if (ipc) await ipc.close(); ipc = null; setIpcAuthSecret(null); vi.restoreAllMocks();
  if (previousDataDir) { config.session.dataDir = previousDataDir; previousDataDir = ''; }
});
function session(): any {
  return { session: { sessionId: 's-execution', status: 'active', backendType: 'pty' },
    larkAppId: 'cli_execution', chatId: 'oc_execution', workerGeneration: 7,
    worker: { pid: process.pid, killed: false },
    // F3: the daemon's identity model comes from the worker's spawn report,
    // never from a config re-derivation. The proven-content cases below rely
    // on this report; the adopt case mutates the session into a shape where
    // this report is structurally impossible (conflict → refused).
    reportedIdentityModel: { model: 'proven', sandboxEngaged: false, loopbackShared: true,
      workerPid: process.pid, workerGeneration: 7, reportedAt: 1 },
    localProcessAttestation: { backendType: 'pty', workerGeneration: 7,
      cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
    managedTurnOrigin: { capability: 'ca'.repeat(32), turnId: 'trigger-current', dispatchAttempt: 3,
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] } };
}
async function request(body: unknown) {
  return fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * Spawn-level smoke for ancestor routing (see #2069):
 *
 * `resolveBotmuxAncestorContext` reads kernel-held environment of ANCESTORS
 * only, starting at `process.ppid`; the spawned CLI's own environment is not
 * attestation. A direct spawn (no wrapper) therefore routes via whatever
 * complete BotMux context the test runner's own ancestors carry:
 *  - clean runner: no ancestor context, the CLI fails closed LOCALLY and the
 *    daemon attestation is never exercised (a vacuous green),
 *  - runner inside a live BotMux session: the request is hijacked by the real
 *    production daemon.
 * The negative half is structurally unconstructable with a real spawn, so it
 * lives in deterministic fake-procfs tests instead:
 *  - local fail-closed without an ancestor: current-actor.test.ts
 *    (`resolveBotmuxAncestorContext` throws on empty/conflicting ancestry),
 *  - daemon-side lineage rejection: current-actor-attestation.test.ts
 *    (unrelated lineage, another session's root, unreadable mid-chain stat…).
 *
 * The wrapper eval below is the nearest complete ancestor of the spawned CLI
 * and always carries THIS mock's routing, so the runner's own ancestors cannot
 * hijack these legs (nearest-complete-context selection). No skip guard is
 * needed: the asserted document uniquely identifies the mock responder, so an
 * answer from any other daemon fails the test instead of passing silently.
 */
async function cliViaAncestor(opts: { poisonOwnEnv?: boolean; foreignAncestor?: boolean } = {}): Promise<
  { code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, BOTMUX: '1', BOTMUX_SESSION_ID: 's-execution',
    BOTMUX_LARK_APP_ID: 'cli_execution', BOTMUX_DAEMON_IPC_PORT: String(ipc!.port),
    BOTMUX_TURN_ID: 'stale-spawn-turn', BOTMUX_DISPATCH_ATTEMPT: '999', BOTMUX_NO_CLAIM: '1' };
  const options = { env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  // When poisonOwnEnv is set, the CLI process keeps wrong routing in its OWN
  // environment while its wrapper ancestor holds the mock routing. Success
  // proves the resolver ignores the self layer. A dead port makes a self-env
  // regression fail fast with ECONNREFUSED instead of a timeout.
  // foreignAncestor inverts the split: the inner CLI claims the target session
  // itself, but the nearest complete ancestor routes a DIFFERENT session, so
  // the daemon must reject self-reported env alone.
  const innerEnv = opts.poisonOwnEnv
    ? `env: { ...process.env, BOTMUX_DAEMON_IPC_PORT: '1', BOTMUX_SESSION_ID: 's-poisoned' },`
    : opts.foreignAncestor
      ? `env: { ...process.env, BOTMUX_SESSION_ID: 's-execution' },`
      : '';
  const child = spawnTsEvalWithRepoImports(`
    import { spawnTsScript } from './test/helpers/ts-runner.js';
    const child = spawnTsScript('src/cli.ts', ['execution', 'current', '--json'],
      { stdio: 'inherit', ${innerEnv} });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    child.once('error', () => { process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
  `, { ...options, env: { ...env, BOTMUX_SESSION_ID: opts.foreignAncestor ? 'foreign-ancestor' : 's-execution' } });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('execution CLI timed out')); }, 20000);
    child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The mock's exact verified document; any other daemon answers differently. */
const mockDocument = {
  schema: 'botmux.current-execution.v1',
  status: 'verified',
  larkAppId: 'cli_execution',
  sessionId: 's-execution',
  chatId: 'oc_execution',
  turnId: 'trigger-current',
  workerGeneration: 7,
  dispatchAttempt: 3,
  // The real CLI asks for the origin; the mock turn has no daemon record.
  origin: 'unknown',
};

describe('POST /api/current-execution', () => {
  it.skipIf(process.platform !== 'linux')('serves the proven identity content bound to the execution turn', async () => {
    const ds = session();
    ds.managedTurnOrigin.identityTurnId = 'identity-original';
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli identity runner-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    writeSessionIdentity(dataDir, 's-execution', {
      tool: 'bytedcli', cloudJwt: 'jwt-original', turnId: 'identity-original', openId: 'ou-original',
    }, 'proven');
    const expected = recallProvenIdentityContent(dataDir, 's-execution', 'identity-original', 'bytedcli')!;
    const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawnTsScript('src/cli-identity-runner.ts', [
        '--data-dir', dataDir, '--session-id', 's-execution', '--app-id', 'cli_execution',
        '--ipc-port', String(ipc!.port), '--tool', 'bytedcli',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    try {
      publishActiveTurn(dataDir, 's-execution', 'newer-envelope', 'ou_newer');
      const accepted = await run();
      expect(accepted.code, accepted.stderr).toBe(0);
      expect(accepted.stdout).toBe(expected);
      expect(accepted.stdout).toContain('jwt-original');
      delete ds.managedTurnOrigin.identityTurnId;
      const missing = await run();
      expect(missing.code).toBe(77); expect(missing.stdout).toBe('');
      ds.workerGeneration++;
      const stale = await run();
      expect(stale.code).toBe(77); expect(stale.stdout).toBe('');
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('returns a distinct terminal error when the proven material is gone', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    // Lineage proves (the session/worker fixtures pass attestation) but nothing
    // was ever published for this turn: 404 identity_material_unavailable, not
    // the 403 proof failure.
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'identity_material_unavailable' });
  });

  it('waits for a publication still in flight instead of refusing the first call', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'identity-in-flight-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    try {
      // The opening turn's replay is still resolving (e.g. a slow platform grant).
      void trackTurnIdentityPublication(dataDir, 's-execution', new Promise<void>(resolve => setTimeout(() => {
        writeSessionIdentity(dataDir, 's-execution', {
          tool: 'bytedcli', cloudJwt: 'jwt-late', turnId: 'trigger-current', openId: 'ou-late',
        }, 'proven');
        resolve();
      }, 300)));
      const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain('jwt-late');
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it.each([
    ['recovers when the bot still takes credentials from the platform', 'platform', true],
    ['does not re-ask once the bot was switched to local credentials mid-turn', 'local', false],
  ] as const)('re-asks the platform on the wrapper\'s next fetch after a transient grant failure: %s', async (_label, liveSource, recovers) => {
    const { publishTurnCliIdentity, __resetTransientRefusalsForTest } = await import('../src/core/turn-cli-identity.js');
    const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
    const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    const atTurnStart = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' });
    // What the bot registry holds when the wrapper fetches (Dashboard edits apply in place).
    const live = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: liveSource });
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty', triggerUserAuth: live,
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-transient-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    const grants: Array<'down' | 'up'> = ['down', 'up'];
    let calls = 0;
    __resetTransientRefusalsForTest();
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
      resolveUnionId: async () => 'on_alice',
      requestGrant: async () => {
        calls++;
        return grants.shift() === 'up'
          ? { ok: true, value: { tool: 'bytedcli', unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
            variables: { BYTEDCLI_USER_CLOUD_JWT: 'jwt-recovered' } } }
          : { ok: false, reason: 'network', error: '连接超时（5000ms）' };
      },
    });
    const fetchIdentity = async () => {
      const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { env: string }).env;
    };
    try {
      await publishTurnCliIdentity({
        botConfig: { larkAppId: 'cli_execution', larkAppSecret: 's', brand: 'feishu', triggerUserAuth: atTurnStart } as any,
        sessionDataDir: dataDir, sessionId: 's-execution', senderOpenId: 'ou_alice',
        turnId: 'trigger-current', storageModel: 'proven',
      });
      expect(calls).toBe(1);
      const env = await fetchIdentity();
      if (recovers) {
        expect(calls).toBe(2);
        expect(env).toContain("BYTEDCLI_USER_CLOUD_JWT='jwt-recovered'");
      } else {
        expect(calls).toBe(1);
        expect(env).toContain("BOTMUX_IDENTITY_MODE='denied'");
      }
    } finally {
      __setPlatformCredentialDepsForTest(null);
      __resetTransientRefusalsForTest();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['an older platform response without states', undefined],
    ['a pending partition', 'pending'],
    ['a failed mint', 'failed'],
    ['two missing partitions requested in parallel', 'two_partitions'],
    ['an unauthorized partition', 'not_authorized'],
    ['a revoked partition', 'reauth_required'],
    ['a turn advanced during the grant', 'next_turn'],
    ['a different speaker took over during the grant', 'next_speaker'],
    ['the policy switched to local during the grant', 'local_policy'],
    ['the identity was republished during the grant', 'republication'],
    ['the user revoked credentials during the grant', 'revoked'],
  ] as const)('handles a partial regional grant: %s', async (_label, scenario) => {
    const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
    const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
    const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
    const ds = session();
    ds.managedTurnOrigin.callerOpenId = 'ou_alice';
    // The model/lineage tests exercise the Linux gate. Stub those checks here
    // so the grant behavior can run on either platform.
    vi.spyOn(workerPool, 'identityModelRefusalReason').mockReturnValue(undefined);
    const attestation = await import('../src/core/current-actor-attestation.js');
    vi.spyOn(attestation, 'resolveLoopbackPeerProcesses').mockResolvedValue({
      ok: true, peer: { pid: process.pid, procStart: '1' },
    });
    let twoRegionalCallersReady!: () => void;
    const twoRegionalCallers = new Promise<void>(resolve => { twoRegionalCallersReady = resolve; });
    let provenRequests = 0;
    vi.spyOn(attestation, 'attestCurrentExecutionLoopbackPeer').mockImplementation(() => {
      if (++provenRequests === 3) twoRegionalCallersReady();
      return {
        ds, turnId: ds.managedTurnOrigin.turnId, generation: ds.workerGeneration,
        dispatchAttempt: ds.managedTurnOrigin.dispatchAttempt, capability: ds.managedTurnOrigin.capability,
        workerPid: process.pid, workerProcStart: '1', processIdentities: [],
      };
    });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    const botConfig = {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }),
    } as any;
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: botConfig } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-partial-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    const jwt = (region: string) => ['e30', Buffer.from(JSON.stringify({
      region, exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url'), 'signature'].join('.');
    const i18n = jwt('i18n');
    const tx = jwt('tx');
    const i18nbd = jwt('i18nbd');
    let finishGrant!: () => void;
    const releaseGrant = new Promise<void>(resolve => { finishGrant = resolve; });
    let grantStarted!: () => void;
    const started = new Promise<void>(resolve => { grantStarted = resolve; });
    const state = scenario === 'pending' || scenario === 'failed' || scenario === 'not_authorized'
      || scenario === 'reauth_required' ? scenario : undefined;
    let grants = 0;
    const requestGrant = vi.fn(async (req: CredentialGrantRequest): Promise<CredentialGrantResult> => {
      const first = ++grants === 1;
      const region = req.cloudJwtRegions?.[0];
      if (!first) {
        grantStarted();
        await releaseGrant;
      }
      return {
        ok: true as const, value: {
          tool: 'bytedcli' as const, unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
          cloudJwtRegions: first ? ['i18n', 'tx', 'i18nbd'] : [...(req.cloudJwtRegions ?? [])],
          ...(first && state ? { cloudJwtRegionStates: { i18n: state } } : {}),
          variables: first
            ? { BYTEDCLI_USER_CLOUD_JWT: 'original-default', BYTEDCLI_USER_CLOUD_JWT_TX: tx }
            : {
              BYTEDCLI_USER_CLOUD_JWT: 'other-default',
              ...(region === 'i18nbd' ? { BYTEDCLI_USER_CLOUD_JWT_I18NBD: i18nbd } : { BYTEDCLI_USER_CLOUD_JWT_I18N: i18n }),
            },
        },
      };
    });
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
      resolveUnionId: async () => 'on_alice',
      requestGrant,
    });
    const fetchIdentity = async (region?: string, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli', region }),
      });
      expect(response.status).toBe(status);
      return ((await response.json()) as { env: string }).env;
    };
    try {
      await publishTurnCliIdentity({
        botConfig, sessionDataDir: dataDir, sessionId: 's-execution', senderOpenId: 'ou_alice',
        turnId: 'trigger-current', storageModel: 'proven',
      });
      expect(await fetchIdentity()).not.toContain(i18n);
      expect(requestGrant).toHaveBeenCalledTimes(1);
      if (state === 'not_authorized' || state === 'reauth_required') {
        const env = await fetchIdentity('i18n');
        expect(env).not.toContain(i18n);
        expect(env).toContain(state);
        expect(requestGrant).toHaveBeenCalledTimes(1);
        return;
      }
      if (scenario === 'next_turn' || scenario === 'next_speaker' || scenario === 'local_policy'
        || scenario === 'republication' || scenario === 'revoked') {
        const staleExecution = scenario === 'next_turn' || scenario === 'next_speaker';
        const status = staleExecution ? 403 : scenario === 'revoked' ? 404 : 200;
        const pendingFetch = fetchIdentity('i18n', status);
        await started;
        if (scenario === 'next_turn') ds.managedTurnOrigin.turnId = 'trigger-next';
        if (scenario === 'next_speaker') ds.managedTurnOrigin.callerOpenId = 'ou_bob';
        if (scenario === 'local_policy') {
          botConfig.triggerUserAuth = parseTriggerUserAuthConfig({
            enabled: true, tools: ['bytedcli'], credentialSource: 'local',
          });
        }
        if (scenario === 'republication') {
          writeSessionIdentity(dataDir, 's-execution', {
            tool: 'bytedcli', cloudJwt: 'replacement-default', turnId: 'trigger-current', openId: 'ou_alice',
          }, 'proven');
        }
        if (scenario === 'revoked') {
          const { dropPublishedIdentitiesForOpenId } = await import('../src/core/cli-identity.js');
          expect(dropPublishedIdentitiesForOpenId(dataDir, 'ou_alice')).toBeGreaterThan(0);
        }
        finishGrant();
        const env = await pendingFetch;
        expect(env ?? '').not.toContain(i18n);
        expect(recallProvenIdentityContent(dataDir, 's-execution', 'trigger-current', 'bytedcli') ?? '').not.toContain(i18n);
        if (scenario === 'republication') expect(env).toContain('replacement-default');
        return;
      }
      const otherRegion = scenario === 'two_partitions' ? 'i18nbd' : 'i18n';
      const requests = Promise.all([fetchIdentity('i18n'), fetchIdentity(otherRegion)]);
      await Promise.all([started, twoRegionalCallers]);
      finishGrant();
      const [first, concurrent] = await requests;
      if (scenario === 'two_partitions') {
        expect(concurrent).toContain(i18nbd);
        expect(recallProvenIdentityContent(dataDir, 's-execution', 'trigger-current', 'bytedcli'))
          .toContain(i18n);
        expect(await fetchIdentity('i18n')).toContain(i18nbd);
        expect(requestGrant).toHaveBeenCalledTimes(3);
        return;
      }
      expect(first).toBe(concurrent);
      expect(first).toContain(i18n);
      expect(first).toContain(tx);
      expect(first).toContain('original-default');
      expect(first).not.toContain('other-default');
      expect(requestGrant).toHaveBeenCalledTimes(2);
      expect(requestGrant).toHaveBeenLastCalledWith(expect.objectContaining({
        unionId: 'on_alice', turnId: 'trigger-current', cloudJwtRegions: ['i18n'],
      }), expect.anything());
      expect(await fetchIdentity('i18n')).toBe(first);
      expect(requestGrant).toHaveBeenCalledTimes(2);
    } finally {
      finishGrant();
      __setPlatformCredentialDepsForTest(null);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    'renewed', 'stale', 'malformed', 'unavailable', 'turn advanced', 'worker replaced', 'policy changed', 'split-source policy changed',
    'binding changed', 'snapshot replaced', 'revoked', 'consent missing', 'CN uses default', 'CN has its own JWT', 'default does not claim CN',
  ] as const)('handles default ByteCloud renewal in the proven turn: %s', async scenario => {
    const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
    const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
    const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
    const { dropPublishedIdentitiesForOpenId } = await import('../src/core/cli-identity.js');
    const ds = session();
    const turnId = ds.managedTurnOrigin.turnId;
    const senderOpenId = 'ou_alice';
    ds.managedTurnOrigin.callerOpenId = senderOpenId;
    vi.spyOn(workerPool, 'identityModelRefusalReason').mockReturnValue(undefined);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    const attestation = await import('../src/core/current-actor-attestation.js');
    vi.spyOn(attestation, 'resolveLoopbackPeerProcesses').mockResolvedValue({
      ok: true, peer: { pid: process.pid, procStart: '1' },
    });
    const attest = vi.spyOn(attestation, 'attestCurrentExecutionLoopbackPeer').mockImplementation(() => ({
      ds, turnId: ds.managedTurnOrigin.turnId, generation: ds.workerGeneration,
      dispatchAttempt: ds.managedTurnOrigin.dispatchAttempt, capability: ds.managedTurnOrigin.capability,
      workerPid: process.pid, workerProcStart: '1', processIdentities: [],
    }));
    const botConfig = {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'],
        credentialSource: scenario === 'split-source policy changed'
          ? { 'lark-user': 'platform', bytecloud: 'platform' } : 'platform' }),
    } as any;
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: botConfig } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-default-renewal-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;

    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const jwt = (region: string, remainingSeconds: number) =>
      `e30.${Buffer.from(JSON.stringify({ region, exp: Math.floor(now / 1_000) + remainingSeconds })).toString('base64url')}.fixture`;
    const original = jwt(scenario === 'default does not claim CN' ? 'i18n' : 'cn', 5);
    const newer = jwt('cn', 3_600);
    const originalRegional = jwt('tx', 600);
    const independentCn = scenario === 'CN has its own JWT' ? jwt('cn', 900) : undefined;
    const requestedRegion = scenario === 'CN uses default' || independentCn || scenario === 'default does not claim CN'
      ? 'cn' : 'default';
    let machineId = 'm-1';
    let releaseGrant!: () => void;
    const grantHeld = new Promise<void>(resolve => { releaseGrant = resolve; });
    let grants = 0;
    const requestGrant = vi.fn(async (req: CredentialGrantRequest): Promise<CredentialGrantResult> => {
      const first = ++grants === 1;
      if (!first) await grantHeld;
      if (grants === 2 && scenario === 'unavailable') return { ok: false, reason: 'network', error: 'fixture unavailable' };
      if (grants === 2 && scenario === 'consent missing') return { ok: false, reason: 'consent_missing', error: 'machine consent missing' };
      const cloudJwt = first || scenario === 'stale' ? original
        : scenario === 'malformed' ? newer.slice(0, newer.lastIndexOf('.')) : newer;
      return { ok: true, value: {
        tool: 'bytedcli', unionId: req.unionId, expiresAt: now + 3_600_000,
        variables: first
          ? {
              BYTEDCLI_USER_CLOUD_JWT: cloudJwt, BYTEDCLI_USER_CODE_JWT: 'original-codebase',
              BYTEDCLI_USER_CLOUD_JWT_TX: originalRegional,
              ...(independentCn ? { BYTEDCLI_USER_CLOUD_JWT_CN: independentCn } : {}),
            }
          : { BYTEDCLI_USER_CLOUD_JWT: cloudJwt, BYTEDCLI_USER_CODE_JWT: 'replacement-codebase' },
      } };
    });
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId }),
      resolveUnionId: async () => 'on_alice',
      requestGrant,
    });
    const fetchIdentity = async (region?: 'default' | 'cn') => {
      const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli', region }),
      });
      return { status: response.status, body: await response.json() };
    };
    const published = () => recallProvenIdentityContent(dataDir, 's-execution', turnId, 'bytedcli');
    try {
      await publishTurnCliIdentity({
        botConfig, sessionDataDir: dataDir, sessionId: 's-execution', senderOpenId, turnId, storageModel: 'proven',
      });
      const startingSnapshot = published();
      expect(await fetchIdentity(requestedRegion)).toMatchObject({ status: 200, body: { env: startingSnapshot } });
      expect(requestGrant).toHaveBeenCalledTimes(1);

      now += 10_000;
      // A caller that does not need the default ByteCloud JWT does not wait on its renewal.
      expect(await fetchIdentity()).toMatchObject({ status: 200, body: { env: startingSnapshot } });
      expect(requestGrant).toHaveBeenCalledTimes(1);
      if (independentCn || scenario === 'default does not claim CN') {
        const response = await fetchIdentity('cn');
        expect(response).toMatchObject({ status: 200, body: { env: startingSnapshot } });
        if (independentCn) expect(response.body.env).toContain(`BOTMUX_IDENTITY_CLOUD_JWT_CN='${independentCn}'`);
        else expect(response.body.env).not.toContain('BOTMUX_IDENTITY_CLOUD_JWT_CN');
        expect(requestGrant).toHaveBeenCalledTimes(1);
        return;
      }
      const first = fetchIdentity(requestedRegion);
      await vi.waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(2));
      expect(requestGrant).toHaveBeenLastCalledWith(expect.objectContaining({
        unionId: 'on_alice', appId: 'cli_execution', sessionId: 's-execution', turnId,
      }), expect.anything());

      if (scenario === 'renewed' || scenario === 'CN uses default') {
        const proofs = attest.mock.calls.length;
        const concurrent = fetchIdentity('default');
        await vi.waitFor(() => expect(attest).toHaveBeenCalledTimes(proofs + 1));
        expect(requestGrant).toHaveBeenCalledTimes(2);
        releaseGrant();
        const [firstResponse, concurrentResponse] = await Promise.all([first, concurrent]);
        expect(firstResponse).toEqual(concurrentResponse);
        expect(firstResponse).toMatchObject({ status: 200, body: { identityTurnId: turnId, env: published() } });
        expect(firstResponse.body.env).toContain(`BYTEDCLI_USER_CLOUD_JWT='${newer}'`);
        expect(firstResponse.body.env).toContain(`BOTMUX_IDENTITY_CLOUD_JWT_CN='${newer}'`);
        expect(firstResponse.body.env).toContain(`BOTMUX_IDENTITY_OPEN_ID='${senderOpenId}'`);
        expect(firstResponse.body.env).toContain(originalRegional);
        expect(firstResponse.body.env).toContain('original-codebase');
        expect(firstResponse.body.env).not.toContain('replacement-codebase');
        expect(firstResponse.body.env).not.toContain(original);
        expect(await fetchIdentity(requestedRegion)).toEqual(firstResponse);
        expect(requestGrant).toHaveBeenCalledTimes(2);
        return;
      }

      if (scenario === 'turn advanced') ds.managedTurnOrigin.turnId = 'trigger-next';
      if (scenario === 'worker replaced') ds.workerGeneration++;
      if (scenario === 'policy changed' || scenario === 'split-source policy changed') {
        botConfig.triggerUserAuth = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'],
          credentialSource: scenario === 'split-source policy changed'
            ? { 'lark-user': 'platform', bytecloud: 'local' } : 'local' });
      }
      if (scenario === 'binding changed') machineId = 'm-2';
      if (scenario === 'snapshot replaced') {
        writeSessionIdentity(dataDir, 's-execution', {
          tool: 'bytedcli', cloudJwt: jwt('cn', 900), turnId, openId: senderOpenId,
        }, 'proven');
        expect(published()).not.toBe(startingSnapshot);
      }
      if (scenario === 'revoked') expect(dropPublishedIdentitiesForOpenId(dataDir, senderOpenId)).toBeGreaterThan(0);
      const snapshotBeforeResponse = published();
      releaseGrant();
      const response = await first;
      if (scenario === 'consent missing') {
        expect(response).toMatchObject({ status: 200 });
        expect(response.body.env).toContain('[reason=platform_consent_missing]');
        expect(published()).toBe(snapshotBeforeResponse);
        return;
      }
      expect(response.body.env).toBeUndefined();
      if (scenario === 'stale' || scenario === 'malformed' || scenario === 'unavailable') {
        expect(response).toMatchObject({ status: 503, body: { reason: 'bytecloud_grant_unavailable' } });
        expect(await fetchIdentity('default')).toEqual(response);
        expect(requestGrant).toHaveBeenCalledTimes(2);
      } else {
        expect(scenario === 'revoked' ? [403, 404] : [403]).toContain(response.status);
      }
      expect(published()).toBe(snapshotBeforeResponse);
      if (scenario === 'unavailable') {
        now += 10_001;
        expect(await fetchIdentity('default')).toMatchObject({
          status: 200, body: { identityTurnId: turnId, env: expect.stringContaining(newer) },
        });
        expect(requestGrant).toHaveBeenCalledTimes(3);
      }
    } finally {
      releaseGrant();
      __setPlatformCredentialDepsForTest(null);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a requester who authorizes mid-turn gets the grant on a later fetch of the same turn (#3312)', async () => {
    const { publishTurnCliIdentity, __resetTransientRefusalsForTest, NOT_AUTHORIZED_RETRY_INTERVAL_MS } = await import('../src/core/turn-cli-identity.js');
    const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
    const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    const policy = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' });
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty', triggerUserAuth: policy,
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-not-authorized-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    let authorized = false;
    let calls = 0;
    __resetTransientRefusalsForTest();
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
      resolveUnionId: async () => 'on_alice',
      requestGrant: async () => {
        calls++;
        return authorized
          ? { ok: true, value: { tool: 'bytedcli', unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
            variables: { BYTEDCLI_USER_CLOUD_JWT: 'jwt-after-authorizing' } } }
          : { ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' };
      },
    });
    const fetchIdentity = async () => {
      const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { env: string }).env;
    };
    try {
      await publishTurnCliIdentity({
        botConfig: { larkAppId: 'cli_execution', larkAppSecret: 's', brand: 'feishu', triggerUserAuth: policy } as any,
        sessionDataDir: dataDir, sessionId: 's-execution', senderOpenId: 'ou_alice',
        turnId: 'trigger-current', storageModel: 'proven',
      });
      // The turn starts refused, and its next call right away is not a new platform request.
      expect(await fetchIdentity()).toContain("BOTMUX_IDENTITY_MODE='denied'");
      expect(calls).toBe(1);
      // They authorize on the platform; once the spacing has passed, the same turn picks the grant up.
      authorized = true;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + NOT_AUTHORIZED_RETRY_INTERVAL_MS + 1_000);
      expect(await fetchIdentity()).toContain("BYTEDCLI_USER_CLOUD_JWT='jwt-after-authorizing'");
      expect(calls).toBe(2);
    } finally {
      __setPlatformCredentialDepsForTest(null);
      __resetTransientRefusalsForTest();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('re-reads the live bot policy after the platform answers: a mid-flight switch to local is not written', async () => {
    const { publishTurnCliIdentity, __resetTransientRefusalsForTest } = await import('../src/core/turn-cli-identity.js');
    const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
    const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    const platformPolicy = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' });
    const localPolicy = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' });
    // The registry returns a NEW config object per call, exactly like
    // bot-registry.ts's `bots.set(appId, { config: cfg, … })` on a Dashboard edit.
    let live: any = platformPolicy;
    const getBot = vi.spyOn(await import('../src/bot-registry.js'), 'getBot');
    getBot.mockImplementation(() => ({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty', triggerUserAuth: live,
    } }) as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-transient-inflight-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    let release!: (v: unknown) => void;
    let calls = 0;
    __resetTransientRefusalsForTest();
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
      resolveUnionId: async () => 'on_alice',
      requestGrant: () => {
        calls++;
        if (calls === 1) return Promise.resolve({ ok: false, reason: 'network', error: '连接超时（5000ms）' } as any);
        return new Promise(r => { release = r; }) as any;   // the re-ask, held open
      },
    });
    try {
      await publishTurnCliIdentity({
        botConfig: { larkAppId: 'cli_execution', larkAppSecret: 's', brand: 'feishu', triggerUserAuth: platformPolicy } as any,
        sessionDataDir: dataDir, sessionId: 's-execution', senderOpenId: 'ou_alice',
        turnId: 'trigger-current', storageModel: 'proven',
      });
      expect(calls).toBe(1);
      const pending = fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
      });
      await vi.waitFor(() => expect(calls).toBe(2));
      live = localPolicy;              // operator switches the bot while the re-ask is in flight
      release({ ok: true, value: { tool: 'bytedcli', unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
        variables: { BYTEDCLI_USER_CLOUD_JWT: 'jwt-should-not-land' } } });
      const response = await pending;
      expect(response.status).toBe(200);
      const env = ((await response.json()) as { env: string }).env;
      expect(env).toContain("BOTMUX_IDENTITY_MODE='denied'");
      expect(env).not.toContain('jwt-should-not-land');
    } finally {
      __setPlatformCredentialDepsForTest(null);
      __resetTransientRefusalsForTest();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses identity content for a session on the single model', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    // adoptMode forces single even on Linux
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ds.session.adoptedFrom = 'tmux-session-1';
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'current_execution_unverified', reason: 'identity_decision_conflict' });
  });

  it.each([
    ['no identity decision ever reached the daemon', (ds: any) => { delete ds.reportedIdentityModel; }, 'identity_decision_missing'],
    ['the worker reported the single model', (ds: any) => { ds.reportedIdentityModel.model = 'single'; }, 'identity_model_single'],
    ['the caller is not in the live turn', (ds: any) => { ds.localProcessAttestation.cliProcStart = 'stale'; }, 'lineage_unproven'],
    // An unproven caller learns only that it is not proven, never the model.
    ['an unproven caller asks about a session that has no decision', (ds: any) => {
      ds.localProcessAttestation.cliProcStart = 'stale'; delete ds.reportedIdentityModel; }, 'lineage_unproven'],
    ['an unproven caller asks about a single-model session', (ds: any) => {
      ds.localProcessAttestation.cliProcStart = 'stale'; ds.reportedIdentityModel.model = 'single'; }, 'lineage_unproven'],
  ])('names the refused step when %s', async (_label, mutate, reason) => {
    const ds = session(); mutate(ds);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-execution', tool: 'bytedcli' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ schema: 'botmux.current-execution-identity.v1', status: 'blocked',
      error: 'current_execution_unverified', reason });
  });

  it('logs each kind of refusal once a minute per live session, and nothing a caller chose', async () => {
    const { logger } = await import('../src/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ds = session(); delete ds.reportedIdentityModel;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const refuse = async (sessionId: string) => (await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, tool: 'bytedcli' }),
    })).status;
    const refusals = () => warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes('refused bytedcli identity'));
    // Clear of any refusal another case in this file logged (the limiter is daemon-wide state).
    const start = Date.now() + 3_600_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < 3; i++) expect(await refuse('s-execution')).toBe(403);
    expect(refusals()).toEqual([expect.stringMatching(/for s-execut: identity_decision_missing$/)]);
    // Sessions the daemon does not know share one key, and their ids never reach the log.
    for (let i = 0; i < 5; i++) expect(await refuse(`forged-${i}\nFORGED LOG LINE`)).toBe(403);
    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).toMatch(/for an unknown session: lineage_unproven/);
    expect(refusals().join('\n')).not.toContain('FORGED');
    // The live session's own limit was not reset by them; it reopens after a minute.
    expect(await refuse('s-execution')).toBe(403);
    expect(refusals()).toHaveLength(2);
    clock.mockReturnValue(start + 61_000);
    expect(await refuse('s-execution')).toBe(403);
    expect(refusals()).toHaveLength(3);
  });

  it.skipIf(process.platform !== 'linux')('the wrapper runner tells a proven caller which step refused, and prints no identity', async () => {
    const ds = session(); delete ds.reportedIdentityModel;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    vi.spyOn(await import('../src/bot-registry.js'), 'getBot').mockReturnValue({ config: {
      larkAppId: 'cli_execution', larkToolBinding: true, backendType: 'pty',
    } } as any);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-identity-refusal-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    writeSessionIdentity(dataDir, 's-execution', {
      tool: 'bytedcli', cloudJwt: 'jwt-must-not-leak', turnId: 'trigger-current', openId: 'ou-original',
    }, 'proven');
    const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawnTsScript('src/cli-identity-runner.ts', [
        '--data-dir', dataDir, '--session-id', 's-execution', '--app-id', 'cli_execution',
        '--ipc-port', String(ipc!.port), '--tool', 'bytedcli',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    try {
      const result = await run();
      expect(result.code).toBe(77);
      expect(result.stdout).toBe('');
      const lines = result.stderr.trim().split('\n');
      expect(lines[0]).toBe('botmux: current_execution_unverified [reason=identity_decision_missing]');
      // A cause and a next step follow, naming the tool; never the identity.
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('bytedcli');
      expect(result.stderr).not.toContain('jwt-must-not-leak');
      // Once the decision is known, the same caller is served its identity.
      ds.reportedIdentityModel = session().reportedIdentityModel;
      const served = await run();
      expect(served.code, served.stderr).toBe(0);
      expect(served.stdout).toBe(recallProvenIdentityContent(dataDir, 's-execution', 'trigger-current', 'bytedcli'));
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('does not let a valid host HMAC bypass current process attestation', async () => {
    const secret = 'current-execution-test-secret'; setIpcAuthSecret(secret);
    const ds = session(); ds.localProcessAttestation.cliProcStart = 'stale';
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetchDaemonIpc(ipc.port, '/api/current-execution', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-execution' }),
    }, secret);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'blocked', error: 'current_execution_unverified' });
  });

  it.skipIf(process.platform !== 'linux')(
    'routes a real spawned CLI through its wrapper ancestor to the mock daemon',
    async () => {
      const ds = session();
      vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
      ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const result = await cliViaAncestor();
      expect(result.code, result.stderr).toBe(0);
      // toEqual over the full key set: a foreign daemon hijacking the route
      // cannot answer with the mock-only turn/generation/session tuple.
      expect(JSON.parse(result.stdout)).toEqual(mockDocument);
    }, 30000,
  );

  it.skipIf(process.platform !== 'linux')(
    'ignores the spawned CLI own environment when a complete ancestor context exists',
    async () => {
      const ds = session();
      vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
      ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const result = await cliViaAncestor({ poisonOwnEnv: true });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(mockDocument);
    }, 30000,
  );

  it.skipIf(process.platform !== 'linux')(
    'rejects the spawned CLI own environment when its ancestor routes another session',
    async () => {
      const ds = session();
      vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
      ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
      const rejected = await cliViaAncestor({ foreignAncestor: true });
      expect(rejected.code).toBe(2);
      expect(JSON.parse(rejected.stdout)).toEqual({ schema: 'botmux.current-execution.v1',
        status: 'blocked', error: 'current_execution_unverified' });
    }, 30000,
  );

  it.skipIf(process.platform !== 'linux')('derives a machine execution from the real socket peer, ignoring forged tuple fields', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const before = JSON.stringify(ds);
    const response = await request({ sessionId: 's-execution', turnId: 'forged', dispatchAttempt: 999, capability: 'forged' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema: 'botmux.current-execution.v1', status: 'verified',
      larkAppId: 'cli_execution', sessionId: 's-execution', chatId: 'oc_execution',
      turnId: 'trigger-current', workerGeneration: 7, dispatchAttempt: 3 });
    expect(JSON.stringify(ds)).toBe(before);
    expect((await request({ sessionId: 'another-session' })).status).toBe(403);
    ds.workerGeneration++;
    expect((await request({ sessionId: 's-execution' })).status).toBe(403);
  });

  it.skipIf(process.platform !== 'linux')('returns origin only to a caller that asks for it', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const plain = await (await request({ sessionId: 's-execution' })).json();
    expect(plain).not.toHaveProperty('origin');
    rememberTriggerTurn('trigger-current', 'webhook');
    const asked = await (await request({ sessionId: 's-execution', fields: ['origin'] })).json();
    expect(asked).toMatchObject({ turnId: 'trigger-current', origin: 'trigger', triggerSource: 'webhook' });
    // A caller cannot pick the answer: forged origin fields in the request are ignored.
    const forged = await (await request({
      sessionId: 's-execution', fields: ['origin'], origin: 'im', scheduleTaskId: 'abcdef12',
    })).json();
    expect(forged).toEqual(asked);
  });

  it('rejects invalid and oversized bodies before using session state', async () => {
    const lookup = vi.spyOn(workerPool, 'findActiveBySessionId');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    for (const body of [null, [], {}, { sessionId: 3 }]) expect((await request(body)).status).toBe(400);
    expect((await request({ sessionId: 'x'.repeat(1200) })).status).toBe(413);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects an unsupported or inapplicable region on the identity route before session work', async () => {
    const lookup = vi.spyOn(workerPool, 'findActiveBySessionId');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const postIdentity = (body: unknown) => fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const body of [
      { sessionId: 's-execution', tool: 'bytedcli', region: 'boe' },
      { sessionId: 's-execution', tool: 'bytedcli', region: 'bogus' },
      { sessionId: 's-execution', tool: 'bytedcli', region: 42 },
      { sessionId: 's-execution', tool: 'lark-cli', region: 'i18n' },
    ]) expect((await postIdentity(body)).status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== 'linux')('proves execution through a signed relay and rejects a stale turn and forged process', async () => {
 const ds=session();ds.protectedLoopbackProxyAttestation={secret:'ab'.repeat(32),workerGeneration:7};
 vi.spyOn(workerPool,'findActiveBySessionId').mockImplementation(id=>id==='s-execution'?ds:undefined);
 vi.spyOn(await import('../src/bot-registry.js'),'getBot').mockReturnValue({config:{larkAppId:'cli_execution',backendType:'pty'}} as any);
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});
 const value={sessionId:'s-execution'};const raw=JSON.stringify(value);
 const signed=(pid=process.pid)=>createProtectedLoopbackProxyAttestation('ab'.repeat(32),{sessionId:'s-execution',serviceId:'current-execution',workerGeneration:7,turnId:'trigger-current',dispatchAttempt:3,peer:{pid,procStart:readProcessStartIdentity(process.pid)!},method:'POST',path:'/api/current-execution',headers:{'content-type':'application/json'},body:Buffer.from(raw)});
 const call=(token:string)=>fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution`,{method:'POST',headers:{'content-type':'application/json',[PROTECTED_LOOPBACK_ATTESTATION_HEADER]:token},body:raw});
 expect((await (await call(signed())).json()).status).toBe('verified');
 expect((await (await call(signed(999999))).json()).status).toBe('blocked');
 const old=signed();ds.managedTurnOrigin.turnId='new-turn';
 expect((await (await call(old)).json()).status).toBe('blocked');
});
it.skipIf(process.platform !== 'linux')('proves only validated local headless execution without inventing a human actor', async () => {
 const ds=session();const id='hl_11111111-1111-4111-8111-111111111111';
 ds.chatId='headless_'+id;ds.session.headless={id,source:'cli',createdAt:new Date().toISOString()};
 vi.spyOn(workerPool,'findActiveBySessionId').mockImplementation(id=>id==='s-execution'?ds:undefined);
 vi.spyOn(await import('../src/bot-registry.js'),'getBot').mockReturnValue({config:{larkAppId:'cli_execution',backendType:'pty'}} as any);
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});
 expect((await (await request({sessionId:'s-execution'})).json()).status).toBe('verified');
 ds.session.headless.source='forged';
 expect((await (await request({sessionId:'s-execution'})).json()).status).toBe('blocked');
});
