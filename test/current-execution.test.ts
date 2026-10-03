import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDaemonCurrentActor } from '../src/core/current-actor-attestation.js';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';
import { CURRENT_EXECUTION_SCHEMA, parseCurrentExecutionArgs, resolveCurrentExecution } from '../src/cli/current-execution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const procRoot = mkdtempSync(join(tmpdir(), 'current-execution-')); roots.push(procRoot);
  const proc = (pid: number, parent: number, start: string) => {
    mkdirSync(join(procRoot, String(pid)), { recursive: true });
    const fields = Array<string>(20).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[19] = start;
    writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (process) ${fields.join(' ')}\n`);
  };
  proc(90, 1, '900'); proc(100, 90, '1000'); proc(110, 100, '1100');
  const ds: any = {
    session: { sessionId: 'session-a', status: 'active' }, larkAppId: 'cli_a', chatId: 'oc_chat',
    worker: { pid: 90, killed: false }, workerGeneration: 7,
    localProcessAttestation: { workerGeneration: 7, cliPid: 100, cliProcStart: '1000', backendType: 'pty' },
    managedTurnOrigin: { capability: 'private-capability', turnId: 'trigger-a', dispatchAttempt: 3,
      preexistingProcessIdentities: ['100:1000'] },
  };
  const input = { procRoot, sessionId: 'session-a', peer: { pid: 110, procStart: '1100' },
    findSession: (id: string) => id === ds.session.sessionId ? ds : undefined };
  return { ds, input, proc };
}

const document = { schema: CURRENT_EXECUTION_SCHEMA, status: 'verified', larkAppId: 'cli_a',
  sessionId: 'session-a', chatId: 'oc_chat', turnId: 'trigger-a', workerGeneration: 7, dispatchAttempt: 3 };

describe('current execution proof', () => {
  it('proves a machine turn without resolving or authorizing a human actor', async () => {
    const { ds, input } = fixture(); const before = JSON.stringify(ds);
    expect(resolveDaemonCurrentExecution(input)).toEqual(document);
    const resolveIdentity = vi.fn();
    expect(await resolveDaemonCurrentActor({ ...input, resolveIdentity })).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(JSON.stringify(ds)).toBe(before);
  });

  it.each(['old-descendant', 'recycled-cli', 'recycled-peer', 'worker-generation', 'disconnected', 'revoked', 'wrong-session', 'invalid-attempt'])(
    'rejects %s', (reason) => {
      const { ds, input, proc } = fixture();
      if (reason === 'old-descendant') ds.managedTurnOrigin.preexistingProcessIdentities.push('110:1100');
      if (reason === 'recycled-cli') proc(100, 90, 'changed');
      if (reason === 'recycled-peer') proc(110, 100, 'changed');
      if (reason === 'worker-generation') ds.workerGeneration++;
      if (reason === 'disconnected') ds.worker.connected = false;
      if (reason === 'revoked') delete ds.managedTurnOrigin;
      if (reason === 'wrong-session') input.sessionId = 'session-b';
      if (reason === 'invalid-attempt') ds.managedTurnOrigin.dispatchAttempt = 0;
      expect(resolveDaemonCurrentExecution(input)).toBeNull();
    },
  );

  it('rejects a child of a preexisting descendant even when that child is new', () => {
    const { ds, input, proc } = fixture();
    proc(120, 110, '1200'); input.peer = { pid: 120, procStart: '1200' };
    ds.managedTurnOrigin.preexistingProcessIdentities.push('110:1100');
    expect(resolveDaemonCurrentExecution(input)).toBeNull();
  });

  it('accepts an attested RPC engine root and omits an absent attempt', () => {
    const { ds, input } = fixture();
    ds.localProcessAttestation.enginePid = 100; ds.localProcessAttestation.engineProcStart = '1000';
    delete ds.localProcessAttestation.cliPid; delete ds.localProcessAttestation.cliProcStart;
    delete ds.managedTurnOrigin.dispatchAttempt;
    const { dispatchAttempt: _, ...expected } = document;
    expect(resolveDaemonCurrentExecution(input)).toEqual(expected);
  });

  it('only requests the original session and checks the returned bot and session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(document), { status: 200 }));
    const options = { ipcPort: 12345, sessionId: 'session-a', larkAppId: 'cli_a', fetchImpl };
    expect(await resolveCurrentExecution(options)).toEqual(document);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:12345/api/current-execution');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', body: '{"sessionId":"session-a"}' });
    for (const change of [{ larkAppId: 'cli_b' }, { sessionId: 'session-b' }, { capability: 'secret' },
      { workerGeneration: 0 }, { dispatchAttempt: -1 }, { status: 'blocked' }, { schema: 'botmux.current-actor.v2' }]) {
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ...document, ...change }), { status: 200 }));
      await expect(resolveCurrentExecution(options)).rejects.toThrow('current_execution_unverified');
    }
  });

  it('does not treat a failed HTTP response or a caller-selected turn as proof', async () => {
    await expect(resolveCurrentExecution({ ipcPort: 12345, sessionId: 'session-a', larkAppId: 'cli_a',
      fetchImpl: async () => new Response(JSON.stringify(document), { status: 403 }) })).rejects.toThrow();
    expect(parseCurrentExecutionArgs(['current', '--json'])).toBe(true);
    for (const args of [[], ['--json'], ['current'], ['current', '--json', '--turn', 'trigger-a']]) {
      expect(parseCurrentExecutionArgs(args)).toBe(false);
    }
  });
});
