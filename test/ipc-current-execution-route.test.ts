import { afterEach, describe, expect, it, vi } from 'vitest';
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

let ipc: IpcServerHandle | null = null;
let previousDataDir = '';
afterEach(async () => {
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
    expect(await response.json()).toMatchObject({ error: 'current_execution_unverified' });
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

  it('rejects invalid and oversized bodies before using session state', async () => {
    const lookup = vi.spyOn(workerPool, 'findActiveBySessionId');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    for (const body of [null, [], {}, { sessionId: 3 }]) expect((await request(body)).status).toBe(400);
    expect((await request({ sessionId: 'x'.repeat(1200) })).status).toBe(413);
    expect(lookup).not.toHaveBeenCalled();
  });
});
