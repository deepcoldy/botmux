import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCodexAppProcessAttestation, verifyCodexAppProcessAttestation } from '../codex-app-process-attestation.js';
import { resolveDaemonCurrentExecution } from '../../core/current-execution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-app-process-proof-')); roots.push(root);
  const proc = (pid: number, parent: number, start = String(pid * 10), state = 'S') => {
    mkdirSync(join(root, String(pid)), { recursive: true });
    const fields = Array<string>(20).fill('0'); fields[0] = state; fields[1] = String(parent); fields[19] = start;
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (process with spaces) ${fields.join(' ')}\n`);
  };
  proc(90, 1); proc(95, 90); proc(100, 95); proc(110, 100); proc(120, 110);
  const proof = captureCodexAppProcessAttestation(100, 110, root)!;
  const ds: any = {
    session: { sessionId: 'session-a', status: 'active' }, larkAppId: 'cli_a', chatId: 'oc_a',
    worker: { pid: 90, killed: false, connected: true }, workerGeneration: 2,
    localProcessAttestation: { cliPid: 100, cliProcStart: '1000', workerGeneration: 2 },
    managedTurnOrigin: { turnId: 'turn-2', capability: 'fixture', preexistingProcessIdentities: ['100:1000', '110:1100'] },
  };
  const input = { sessionId: 'session-a', peer: { pid: 120, procStart: '1200' }, procRoot: root, findSession: () => ds };
  return { root, proc, proof, ds, input };
}

describe('authenticated Codex App engine process proof', () => {
  it('accepts direct runner and wrapper backend roots', () => {
    const { root, proof } = fixture();
    expect(verifyCodexAppProcessAttestation(proof, 100, root)).toEqual(proof);
    expect(verifyCodexAppProcessAttestation(proof, 95, root)).toEqual(proof);
  });
  it('accepts the native app-server under a resident npm launcher', () => {
    const { root, proc } = fixture();
    proc(115, 110);
    const proof = captureCodexAppProcessAttestation(100, 115, root);
    expect(proof?.enginePid).toBe(115);
    expect(verifyCodexAppProcessAttestation(proof, 95, root)).toEqual(proof);
  });
  it('maps namespace-local PIDs to the exact backend descendants', () => {
    const { root, proof } = fixture();
    for (const [pid, localPid] of [[100, 2], [110, 3]]) {
      writeFileSync(join(root, String(pid), 'status'), `NSpid: ${pid} ${localPid}\n`);
      mkdirSync(join(root, String(pid), 'ns')); symlinkSync('pid:[fixture]', join(root, String(pid), 'ns/pid'));
    }
    const local = { ...proof, runnerPid: 2, enginePid: 3 };
    expect(verifyCodexAppProcessAttestation(local, 95, root)).toEqual(proof);
    expect(verifyCodexAppProcessAttestation(local, 999, root)).toBeUndefined();
    expect(verifyCodexAppProcessAttestation({ ...local, engineProcStart: '1101' }, 95, root)).toBeUndefined();
  });
  it.each(['runner-reused', 'engine-reused', 'unrelated-engine', 'wrong-backend', 'zombie', 'missing-birth', 'missing-engine'])(
    'rejects %s', reason => {
      const { root, proc, proof } = fixture();
      if (reason === 'runner-reused') proc(100, 95, '1001');
      if (reason === 'engine-reused') proc(110, 100, '1101');
      if (reason === 'unrelated-engine') proc(110, 95);
      if (reason === 'zombie') proc(110, 100, '1100', 'Z');
      if (reason === 'missing-birth') delete (proof as any).engineProcStart;
      if (reason === 'missing-engine') delete (proof as any).enginePid;
      expect(verifyCodexAppProcessAttestation(proof, reason === 'wrong-backend' ? 999 : 100, root)).toBeUndefined();
    },
  );
  it('proves a new tool on turn two through an existing authenticated engine', () => {
    const { proof, ds, input } = fixture();
    expect(resolveDaemonCurrentExecution(input)).toBeNull();
    Object.assign(ds.localProcessAttestation, { enginePid: proof.enginePid, engineProcStart: proof.engineProcStart });
    expect(resolveDaemonCurrentExecution(input)).toMatchObject({ status: 'verified', turnId: 'turn-2' });
  });
  it('still rejects an old tool and new children of an old tool', () => {
    const { proof, ds, input, proc } = fixture();
    Object.assign(ds.localProcessAttestation, { enginePid: proof.enginePid, engineProcStart: proof.engineProcStart });
    ds.managedTurnOrigin.preexistingProcessIdentities.push('120:1200');
    expect(resolveDaemonCurrentExecution(input)).toBeNull();
    proc(130, 120); input.peer = { pid: 130, procStart: '1300' };
    expect(resolveDaemonCurrentExecution(input)).toBeNull();
  });
  it('never rebinds an old engine identity after PID reuse', () => {
    const { proof, ds, input, proc } = fixture();
    Object.assign(ds.localProcessAttestation, { enginePid: proof.enginePid, engineProcStart: proof.engineProcStart });
    proc(110, 100, '1101');
    expect(resolveDaemonCurrentExecution(input)).toBeNull();
  });
});
