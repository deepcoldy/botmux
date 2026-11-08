import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDaemonCurrentActor } from '../src/core/current-actor-attestation.js';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';
import {
  CURRENT_EXECUTION_ORIGINS, CURRENT_EXECUTION_SCHEMA, CURRENT_EXECUTION_TRIGGER_SOURCES,
  isCurrentExecutionDocument, parseCurrentExecutionArgs, resolveCurrentExecution,
} from '../src/cli/current-execution.js';
import { TRIGGER_SOURCES, TURN_ORIGINS, __testOnly_resetTriggerTurns, rememberTriggerTurn } from '../src/core/turn-origin.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  __testOnly_resetTriggerTurns();
});

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

  it('returns the execution identity reference when a follow-up keeps the original principal', async () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.identityTurnId = 'original-turn';
    const proof = resolveDaemonCurrentExecution(input);
    expect(proof).toEqual({ ...document, identityTurnId: 'original-turn' });
    expect(await resolveCurrentExecution({ ipcPort: 12345, sessionId: 'session-a', larkAppId: 'cli_a',
      fetchImpl: async () => new Response(JSON.stringify(proof), { status: 200 }) })).toEqual(proof);
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
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      redirect: 'error', body: '{"sessionId":"session-a","fields":["origin"]}',
    });
    for (const change of [{ larkAppId: 'cli_b' }, { sessionId: 'session-b' }, { capability: 'secret' },
      { workerGeneration: 0 }, { dispatchAttempt: -1 }, { identityTurnId: '' }, { identityTurnId: 'bad\nturn' },
      { status: 'blocked' }, { schema: 'botmux.current-actor.v2' },
      { origin: 'human' }, { origin: 'schedule' }, { origin: 'im', scheduleTaskId: 'abcdef12' },
      { origin: 'trigger' }, { origin: 'trigger', triggerSource: 'email' }, { origin: 'im', triggerSource: 'webhook' },
      { origin: 'schedule', scheduleTaskId: 'bad task' }, { callerOpenId: 'ou_x' }]) {
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

describe('current execution origin', () => {
  const SCHEDULE_TURN = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';
  const withOrigin = (ds: any, input: any) => resolveDaemonCurrentExecution(input, { includeOrigin: true });

  it('omits origin unless the caller asked, so the original strict client keeps working', () => {
    const { input } = fixture();
    expect(resolveDaemonCurrentExecution(input)).toEqual(document);
  });

  it('a human IM message turn reads as im', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'om_human';
    ds.activeInteractiveTurn = { turnId: 'om_human', caller: { requestUserOpenId: 'ou_a', senderType: 'user' } };
    expect(withOrigin(ds, input)).toEqual({ ...document, turnId: 'om_human', origin: 'im' });
  });

  it('falls back to the durable per-turn registry, and only a proven non-bot sender is a person', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'om_queued';
    ds.session.replyTargets = { om_queued: {
      rootMessageId: 'om_root', senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }],
    } };
    expect(withOrigin(ds, input)?.origin).toBe('im');
    ds.session.replyTargets.om_queued.participants = [{ openId: 'ou_a' }];
    expect(withOrigin(ds, input)?.origin).toBe('unknown');
  });

  it('an interactive record for an earlier turn says nothing about the current one', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'om_new';
    ds.activeInteractiveTurn = { turnId: 'om_older', caller: { requestUserOpenId: 'ou_a', senderType: 'user' } };
    expect(withOrigin(ds, input)?.origin).toBe('unknown');
  });

  it('a turn opened by another bot reads as dispatch', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'om_from_bot';
    ds.activeInteractiveTurn = { turnId: 'om_from_bot', caller: { requestUserOpenId: 'ou_bot', senderType: 'bot' } };
    expect(withOrigin(ds, input)?.origin).toBe('dispatch');
    delete ds.activeInteractiveTurn;
    ds.session.replyTargets = { om_from_bot: {
      rootMessageId: 'om_root', senderOpenId: 'ou_bot', participants: [{ openId: 'ou_bot', isBot: true }],
    } };
    expect(withOrigin(ds, input)?.origin).toBe('dispatch');
  });

  it('a scheduled fire reads as schedule with its task id, and so does its recovery continuation', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = SCHEDULE_TURN;
    // A stale interactive record for another turn must not leak in.
    ds.activeInteractiveTurn = { turnId: 'om_older', caller: { senderType: 'user' } };
    expect(withOrigin(ds, input)).toEqual({
      ...document, turnId: SCHEDULE_TURN, origin: 'schedule', scheduleTaskId: 'abcdef12',
    });
    const continuation = 'schedule:abcdef12:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    ds.managedTurnOrigin.turnId = continuation;
    ds.session.ordinaryTurnRecovery = { logicalTurnId: SCHEDULE_TURN, currentTurnId: continuation };
    expect(withOrigin(ds, input)).toMatchObject({ origin: 'schedule', scheduleTaskId: 'abcdef12' });
  });

  it('a trigger turn reads as trigger with the connector kind the daemon admitted it under', () => {
    const { ds, input } = fixture();
    expect(withOrigin(ds, input)?.origin).toBe('unknown');
    rememberTriggerTurn('trigger-a', 'webhook');
    expect(withOrigin(ds, input)).toEqual({ ...document, origin: 'trigger', triggerSource: 'webhook' });
  });

  it('a recovery continuation of a human turn is not a new human message', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'bmx-recovery-1';
    ds.session.ordinaryTurnRecovery = { logicalTurnId: 'om_human', currentTurnId: 'bmx-recovery-1' };
    ds.session.replyTargets = { 'bmx-recovery-1': {
      rootMessageId: 'om_root', senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }],
    } };
    expect(withOrigin(ds, input)?.origin).toBe('recovery');
    ds.managedTurnOrigin.turnId = 'om_retry';
    delete ds.session.ordinaryTurnRecovery;
    ds.session.failedTurnRecovery = { turnId: 'om_retry' };
    ds.activeInteractiveTurn = { turnId: 'om_retry', caller: { senderType: 'user', source: 'failed_turn_recovery' } };
    expect(withOrigin(ds, input)?.origin).toBe('recovery');
  });

  // Ordering guard: the readonly-task continuation dispatch (worker-pool)
  // installs activeInteractiveTurn with the frozen human caller CLONED onto
  // the continuation turn id. Recovery must still win: this turn was minted by
  // the daemon, it is not a new human message.
  it('a readonly-task continuation with an inherited human interactive record reads as recovery', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'bmx-ro-1';
    ds.activeInteractiveTurn = {
      turnId: 'bmx-ro-1',
      caller: { requestUserOpenId: 'ou_a', requestLarkAppId: 'cli_a', senderType: 'user' },
    };
    ds.session.readonlyTaskContinuation = { leaseId: 'lease-1', logicalTurnId: 'om_human', currentTurnId: 'bmx-ro-1' };
    ds.session.replyTargets = { 'bmx-ro-1': {
      rootMessageId: 'om_root', senderOpenId: 'ou_a', participants: [{ openId: 'ou_a', isBot: false }],
    } };
    expect(withOrigin(ds, input)?.origin).toBe('recovery');
  });

  // A caller stamped with a recovery source never authenticates a fresh human
  // turn on its own; with no recovery marker naming it there is no proof of
  // anything, so it must not be guessed into im.
  it('an active interactive caller sourced from failed-turn recovery is not im without a recovery marker', () => {
    const { ds, input } = fixture();
    ds.managedTurnOrigin.turnId = 'om_stale';
    ds.activeInteractiveTurn = {
      turnId: 'om_stale',
      caller: { requestUserOpenId: 'ou_a', senderType: 'user', source: 'failed_turn_recovery' },
    };
    expect(withOrigin(ds, input)?.origin).toBe('unknown');
  });

  it('round-trips every origin through the client validator', () => {
    for (const doc of [
      { ...document, origin: 'im' }, { ...document, origin: 'dispatch' }, { ...document, origin: 'recovery' },
      { ...document, origin: 'unknown' }, { ...document, origin: 'schedule', scheduleTaskId: 'abcdef12' },
      ...CURRENT_EXECUTION_TRIGGER_SOURCES.map(triggerSource => ({ ...document, origin: 'trigger', triggerSource })),
    ]) expect(isCurrentExecutionDocument(doc), JSON.stringify(doc)).toBe(true);
  });

  // 一致性（K4）：CLI 包里的取值表与 daemon 侧判定用的是两份字面量（CLI 不 import daemon 模块），必须相同。
  it('the client accepts exactly the values the daemon can produce', () => {
    expect([...CURRENT_EXECUTION_ORIGINS]).toEqual([...TURN_ORIGINS]);
    expect([...CURRENT_EXECUTION_TRIGGER_SOURCES]).toEqual([...TRIGGER_SOURCES]);
  });
});
