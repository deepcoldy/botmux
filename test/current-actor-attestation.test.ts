import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveDaemonCurrentActor,
  resolveLoopbackPeerProcesses,
} from '../src/core/current-actor-attestation.js';

function procStat(pid: number, ppid: number, start: string): string {
  const tail = ['S', String(ppid), '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', start];
  return `${pid} (proc ${pid}) ${tail.join(' ')}\n`;
}

function writeProc(root: string, pid: number, ppid: number, start: string): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), procStat(pid, ppid, start));
}

function activeSession(): any {
  return {
    session: { sessionId: 's1', status: 'active' },
    worker: { pid: 90, killed: false },
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    workerGeneration: 7,
    localProcessAttestation: {
      backendType: 'pty',
      credentialIsolated: false,
      cliPid: 100,
      cliProcStart: '1000',
      workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32),
      turnId: 'om_turn',
      callerOpenId: 'ou_current',
      preexistingProcessIdentities: ['100:1000'],
    },
    initConfig: { apiOnly: false },
  };
}

const SCHEDULED_TURN_ID = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';

function activeScheduledSession(): any {
  const ds = activeSession();
  ds.managedTurnOrigin.turnId = SCHEDULED_TURN_ID;
  ds.managedTurnOrigin.callerOpenId = 'ou_scheduler';
  ds.scheduledTurnCallers = new Map([[SCHEDULED_TURN_ID, {
    requestUserOpenId: 'ou_scheduler',
    requestLarkAppId: 'cli_app',
    source: 'schedule_creator',
    taskId: 'abcdef12',
  }]]);
  return ds;
}

describe('daemon current actor attestation', () => {
  it('derives the HTTP client pid from the live kernel socket tuple', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-peer-'));
    mkdirSync(join(procRoot, 'net'), { recursive: true });
    writeFileSync(join(procRoot, 'net', 'tcp'), [
      'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode',
      '0: 0100007F:C350 0100007F:1F0F 01 00000000:00000000 00:00000000 00000000 1000 0 4242',
    ].join('\n'));
    writeFileSync(join(procRoot, 'net', 'tcp6'), '');
    writeProc(procRoot, 101, 100, '2000');
    mkdirSync(join(procRoot, '101', 'fd'), { recursive: true });
    symlinkSync('socket:[4242]', join(procRoot, '101', 'fd', '7'));

    expect(resolveLoopbackPeerProcesses({
      remoteAddress: '127.0.0.1',
      remotePort: 50_000,
      localPort: 7_951,
      procRoot,
    })).toEqual({ ok: true, peer: { pid: 101, procStart: '2000' } });
  });

  it('rejects a non-loopback request before process lookup', () => {
    expect(resolveLoopbackPeerProcesses({
      remoteAddress: '10.0.0.1', remotePort: 50_000, localPort: 7_951,
    })).toEqual({ ok: false, reason: 'not_loopback' });
  });

  it('binds a live client descendant to the in-memory turn caller', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    const ds = activeSession();
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'Current.User@Example.COM',
    }));

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 101, procStart: '2000' },
      findSession: () => ds,
      resolveIdentity,
      procRoot,
    })).resolves.toMatchObject({
      ok: true,
      document: { actor: { email: 'current.user@example.com' } },
    });
    expect(resolveIdentity).toHaveBeenCalledWith('cli_app', 'ou_current');
  });

  it('proves the exact scheduled turn against the live caller registry', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    const ds = activeScheduledSession();

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 101, procStart: '2000' },
      findSession: () => ds,
      resolveIdentity: async () => ({
        openId: 'ou_scheduler', type: 'user' as const, email: 'scheduler@example.com',
      }),
      procRoot,
      expectedScheduledTurnId: SCHEDULED_TURN_ID,
    })).resolves.toMatchObject({ ok: true });
  });

  it('rejects a missing, different, or cleaned-up scheduled turn', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeScheduledSession();
    const request = (expectedScheduledTurnId: string) => resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 100, procStart: '1000' },
      findSession: () => ds,
      resolveIdentity: async () => ({
        openId: 'ou_scheduler', type: 'user' as const, email: 'scheduler@example.com',
      }),
      procRoot,
      expectedScheduledTurnId,
    });

    await expect(request(
      'schedule:abcdef12:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    )).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });

    ds.scheduledTurnCallers = undefined;
    await expect(request(SCHEDULED_TURN_ID)).resolves.toEqual({
      ok: false, error: 'current_actor_unverified',
    });
  });

  it('rejects scheduled-turn registry cleanup during identity lookup', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeScheduledSession();

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 100, procStart: '1000' },
      findSession: () => ds,
      resolveIdentity: async () => {
        ds.scheduledTurnCallers = undefined;
        return { openId: 'ou_scheduler', type: 'user' as const, email: 'scheduler@example.com' };
      },
      procRoot,
      expectedScheduledTurnId: SCHEDULED_TURN_ID,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });

  it('binds an RPC tool descendant to the independently attested engine root', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 90, '3000');
    writeProc(procRoot, 201, 200, '3100');
    const ds = activeSession();
    ds.localProcessAttestation.enginePid = 200;
    ds.localProcessAttestation.engineProcStart = '3000';
    ds.managedTurnOrigin.preexistingProcessIdentities = ['100:1000', '200:3000'];
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
    }));

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 201, procStart: '3100' },
      findSession: () => ds,
      resolveIdentity,
      procRoot,
    })).resolves.toMatchObject({
      ok: true,
      document: { actor: { email: 'current@example.com' } },
    });
  });

  it('rejects a peer rooted in another still-active session', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 91, 1, '901');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 91, '3000');
    writeProc(procRoot, 201, 200, '3100');
    const target = activeSession();
    const other = activeSession();
    other.session.sessionId = 's2';
    other.worker = { pid: 91, killed: false };
    delete other.localProcessAttestation.cliPid;
    delete other.localProcessAttestation.cliProcStart;
    other.localProcessAttestation.enginePid = 200;
    other.localProcessAttestation.engineProcStart = '3000';
    other.managedTurnOrigin.preexistingProcessIdentities = ['200:3000'];
    const sessions = new Map([['s1', target], ['s2', other]]);
    const resolveIdentity = vi.fn();

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 201, procStart: '3100' },
      findSession: id => sessions.get(id),
      resolveIdentity,
      procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('supports the RPC opening window before the viewer CLI PID exists', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 200, 90, '3000');
    writeProc(procRoot, 201, 200, '3100');
    const ds = activeSession();
    delete ds.localProcessAttestation.cliPid;
    delete ds.localProcessAttestation.cliProcStart;
    ds.localProcessAttestation.enginePid = 200;
    ds.localProcessAttestation.engineProcStart = '3000';
    ds.managedTurnOrigin.preexistingProcessIdentities = ['200:3000'];

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 201, procStart: '3100' },
      findSession: () => ds,
      resolveIdentity: async () => ({
        openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
      }),
      procRoot,
    })).resolves.toMatchObject({ ok: true });
  });

  it('rejects an RPC engine PID whose process identity is stale', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 90, 'reused');
    writeProc(procRoot, 201, 200, '3100');
    const ds = activeSession();
    ds.localProcessAttestation.enginePid = 200;
    ds.localProcessAttestation.engineProcStart = 'original';
    ds.managedTurnOrigin.preexistingProcessIdentities = ['100:1000', '200:original'];
    const resolveIdentity = vi.fn();

    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 201, procStart: '3100' },
      findSession: () => ds,
      resolveIdentity,
      procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects a same-uid process outside the attested CLI lineage', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 1, '3000');
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
    }));
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 200, procStart: '3000' },
      findSession: () => activeSession(),
      resolveIdentity,
      procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects a new descendant reached through an old-turn child', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '1100');
    writeProc(procRoot, 102, 101, '1200');
    const ds = activeSession();
    ds.managedTurnOrigin.preexistingProcessIdentities = ['100:1000', '101:1100'];
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
    }));
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 102, procStart: '1200' },
      findSession: () => ds,
      resolveIdentity,
      procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects a stale worker generation before identity lookup', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.workerGeneration = 6;
    const resolveIdentity = vi.fn();
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1', peer: { pid: 100, procStart: '1000' },
      findSession: () => ds, resolveIdentity, procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects a turn rotation during the live Contact lookup', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    const resolveIdentity = vi.fn(async () => {
      ds.managedTurnOrigin = { capability: 'db'.repeat(32), turnId: 'om_next', callerOpenId: 'ou_other' };
      return { openId: 'ou_current', type: 'user' as const, email: 'current@example.com' };
    });
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1', peer: { pid: 100, procStart: '1000' },
      findSession: () => ds, resolveIdentity, procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });

  it('rejects a sender change during the live Contact lookup', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    const resolveIdentity = vi.fn(async () => {
      ds.managedTurnOrigin.callerOpenId = 'ou_other';
      return { openId: 'ou_current', type: 'user' as const, email: 'current@example.com' };
    });
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1', peer: { pid: 100, procStart: '1000' },
      findSession: () => ds, resolveIdentity, procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });

  it('rejects an adopt session that never published its CLI pid', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.cliPid = undefined;
    ds.localProcessAttestation.cliProcStart = undefined;
    ds.managedTurnOrigin.preexistingProcessIdentities = undefined;
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
    }));
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1', peer: { pid: 100, procStart: '1000' },
      findSession: () => ds, resolveIdentity, procRoot,
    })).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('binds an adopt session once its CLI pid is published', async () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'actor-proc-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    const ds = activeSession();
    const resolveIdentity = vi.fn(async () => ({
      openId: 'ou_current', type: 'user' as const, email: 'current@example.com',
    }));
    await expect(resolveDaemonCurrentActor({
      sessionId: 's1',
      peer: { pid: 101, procStart: '2000' },
      findSession: () => ds,
      resolveIdentity,
      procRoot,
    })).resolves.toMatchObject({ ok: true, document: { actor: { email: 'current@example.com' } } });
  });
});
