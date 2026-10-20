import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import { spawnTsEvalWithRepoImports, spawnTsScript } from './helpers/ts-runner.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';

let ipc: IpcServerHandle | null = null;
afterEach(async () => { if (ipc) await ipc.close(); ipc = null; setIpcAuthSecret(null); vi.restoreAllMocks(); });
function session(): any {
  return { session: { sessionId: 's-execution', status: 'active' },
    larkAppId: 'cli_execution', chatId: 'oc_execution', workerGeneration: 7,
    worker: { pid: process.pid, killed: false },
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

async function cli(withAncestor: boolean) {
  const env = { ...process.env, BOTMUX: '1', BOTMUX_SESSION_ID: 's-execution',
    BOTMUX_LARK_APP_ID: 'cli_execution', BOTMUX_DAEMON_IPC_PORT: String(ipc!.port),
    BOTMUX_TURN_ID: 'stale-spawn-turn', BOTMUX_DISPATCH_ATTEMPT: '999', BOTMUX_NO_CLAIM: '1' };
  const options = { env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  // A real ancestor must carry kernel-held routing; the current CLI's own env
  // alone is intentionally not an attestation. Both spawns use the repo helper.
  const child = withAncestor ? spawnTsEvalWithRepoImports(`
    import { spawnTsScript } from './test/helpers/ts-runner.js';
    const child = spawnTsScript('src/cli.ts', ['execution', 'current', '--json'], { stdio: 'inherit' });
    process.once('SIGTERM', () => child.kill('SIGTERM'));
    child.once('error', () => { process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
  `, options) : spawnTsScript('src/cli.ts', ['execution', 'current', '--json'], options);
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('execution CLI timed out')); }, 20000);
    child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe('POST /api/current-execution', () => {
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

  it.skipIf(process.platform !== 'linux')('runs the real CLI through ancestor routing and rejects self-reported env alone', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const accepted = await cli(true);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ status: 'verified', turnId: 'trigger-current', dispatchAttempt: 3 });
    const rejected = await cli(false);
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout)).toEqual({ schema: 'botmux.current-execution.v1',
      status: 'blocked', error: 'current_execution_unverified' });
  }, 30000);

  it.skipIf(process.platform !== 'linux')('derives a machine execution from the real socket peer, ignoring forged tuple fields', async () => {
    const ds = session();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's-execution' ? ds : undefined);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const before = JSON.stringify(ds);
    const response = await request({ sessionId: 's-execution', turnId: 'forged', dispatchAttempt: 99, capability: 'forged' });
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
