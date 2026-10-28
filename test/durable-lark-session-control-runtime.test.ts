import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import type { InboxClaim } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import { createDurableSessionControlDispatch } from '../src/services/durable-session-control-dispatch.js';
import {
  durableDirectSessionControlEvent,
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
  parseDurableSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import { createDurableLarkSessionControlRuntime } from '../src/services/durable-lark-session-control-runtime.js';
import { DurableSessionControlOwnerHandoffError } from '../src/services/durable-session-control-errors.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { admitDurableLarkSession, parseDurablePrimarySessionRecord } from '../src/services/durable-session-primary.js';
import { parseDurableLarkOutboxRecord } from '../src/services/durable-lark-outbox.js';

const tempDirs: string[] = [];

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Control Session',
    status: 'active',
    createdAt: '2026-10-09T00:00:00.000Z',
    larkAppId: 'cli_test',
    ownerOpenId: 'ou_owner',
    streamCardId: 'om_card',
    ...overrides,
  };
}

function message(): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: 'im.message.receive_v1:cli_test:om_turn',
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId: 'om_turn',
    attempts: 1,
    data: { message: { message_id: 'om_turn' } },
  };
}

function control(action: 'close' | 'resume' = 'close') {
  const data = {
    event_id: `evt_${action}`,
    action: { value: { action, session_id: 'session-1', root_id: 'om_root' } },
    operator: { open_id: 'ou_operator' },
    context: { open_message_id: 'om_card' },
  };
  const event = durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', `evt_${action}`),
    partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
    data,
    now: 2,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
  return { data, claim, control: parseDurableLarkSessionControlClaim(claim) };
}

function directControl(source: 'lark-command' | 'trusted-host', action: 'close' | 'resume' = 'close') {
  const event = durableDirectSessionControlEvent({
    source,
    larkAppId: 'cli_test',
    operationId: `${source}.session-control:cli_test:session-1:1:${action}`,
    action,
    sessionId: 'session-1',
    rootId: 'om_root',
    ...(source === 'lark-command' ? { operatorOpenId: 'ou_operator' } : {}),
    cardMessageId: 'om_card',
    now: 2,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
  return { claim, control: parseDurableSessionControlClaim(claim) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable Lark session control runtime', () => {
  it('closes a never-started canonical remote Session from trusted host state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-unstarted-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const canonical = session({
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 0,
        providerState: { sessionKey: 'bmx1-never-started' },
      },
    });
    let persisted: Session | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: canonical });
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const closeSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      takeOverActiveSession: vi.fn(async () => {
        throw new Error('must not take over an unstarted remote Session');
      }),
      canOperate: () => false,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 20,
    });
    const input = directControl('trusted-host');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(materializeClosedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'closed',
      closedAt: new Date(20).toISOString(),
    }));
    expect(closeSession).not.toHaveBeenCalled();
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{ source: 'trusted-host', action: 'close' }],
      });
    await facade.stop();
  });

  it('re-authorizes typed Lark controls but trusts the HMAC-gated host source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-source-auth-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const current = session();
    await admitDurableLarkSession({ facade, message: message(), session: current });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [current],
      getPersistedSession: () => current,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: vi.fn(),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
    });

    await expect(runtime.resolve(directControl('lark-command').control, {
      claim: directControl('lark-command').claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'ignored', reason: 'operator is not allowed to control this Session' });
    await expect(runtime.resolve(directControl('trusted-host').control, {
      claim: directControl('trusted-host').claim,
      signal: new AbortController().signal,
    })).rejects.toThrow(/could not be taken over/);
    await facade.stop();
  });

  it('closes one owned Session, commits canonical state, and enqueues an idempotent card update', async () => {
    let now = 10;
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    let persisted = session();
    let active: DaemonSession | undefined = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const closeSession = vi.fn(async () => {
      persisted = { ...persisted, status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' };
      active = undefined;
      return { ok: true, outcome: 'closed' as const, alreadyClosed: false };
    });
    let operatorAllowed = true;
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active || undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => operatorAllowed,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => '{"header":{"title":"closed"}}',
      buildActiveCard: () => '{"header":{"title":"active"}}',
      buildPendingCard: action => JSON.stringify({ pending: action }),
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => now,
    });
    const input = control();
    const resolved = await runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    });
    if (resolved.kind !== 'target') throw new Error('expected control target');
    await expect(resolved.target.commit({
      version: 1,
      type: 'botmux.lark.session-control-result',
      action: 'resume',
      sessionId: 'session-1',
      status: 'closed',
    }, new AbortController().signal)).rejects.toThrow(/result is invalid/);
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(true);
    await expect(runtime.pendingCardBeforeAck(input.data)).resolves.toEqual({ pending: 'close' });
    expect(await runtime.authorizeBeforeAck({
      ...input.data,
      context: { open_message_id: 'om_stale_card' },
    })).toBe(false);
    operatorAllowed = false;
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(false);
    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'ignored',
      reason: 'operator is not allowed to control this Session',
    });
    operatorAllowed = true;
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:session-1',
    ]);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(closeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(canonical).toBeDefined();
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'close', operationId: input.control.operationId }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    const output = await store.readOutbox(`control_update_${digest}`);
    expect(output).toMatchObject({ state: 'pending' });
    expect(parseDurableLarkOutboxRecord(output!)).toMatchObject({
      target: { kind: 'update', messageId: 'om_card' },
      content: '{"header":{"title":"closed"}}',
    });
    now = 11;
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:session-1',
    ]);
    await facade.stop();
    await store.close();
  });

  it('authorizes on the shared canonical Session when ingress and owner are different Pods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-cross-pod-auth-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not local' }),
      resumeSession: async () => ({ ok: false, error: 'not local' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
    });

    expect(await runtime.authorizeBeforeAck(control().data)).toBe(true);
    expect(runtime.ownedPartitionKeys()).toEqual([]);
    await facade.stop();
    await store.close();
  });

  it('materializes a canonical closed Session on a fresh replica before resolving resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-canonical-resume-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const canonicalClosed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted: Session | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: canonicalClosed });
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const resumeSession = vi.fn(async () => ({
      ok: false as const,
      error: 'anchor_occupied',
      activeSessionId: 'session-other',
    }));
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
    });
    expect(runtime.ownedPartitionKeys()).toEqual([]);
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(materializeClosedSession).toHaveBeenCalledOnce();
    expect(resumeSession).toHaveBeenCalledWith('session-1');
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:session-1',
    ]);
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'resume', result: { applied: false, error: 'anchor_occupied' } }],
    });
    await facade.stop();
    await store.close();
  });

  it('settles a safe resume refusal once and delivers a durable notice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-refusal-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session({ status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' });
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession: async () => ({
        ok: false,
        error: 'anchor_occupied',
        activeSessionId: 'session-other',
      }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: (error, activeSessionId) => `${error}:${activeSessionId}`,
      now: () => 10,
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'resume', result: { applied: false, error: 'anchor_occupied' } }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'anchor_occupied:session-other',
      });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'closed',
      });
    await facade.stop();
    await store.close();
  });

  it('waits for expected remote readiness without marking the operation ambiguous, then settles rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-rollback-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = { ...closed, status: 'active', closedAt: undefined };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 0,
      resumeReadinessTimeoutMs: 1_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        persisted = closed;
        active = undefined;
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(resumeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{
        action: 'resume',
        result: { status: 'closed', applied: false, error: 'resume_start_failed' },
      }],
    });
    const operation = await store.readControlOperation(input.control.operationId);
    expect(operation).toMatchObject({
      state: 'completed',
      attempts: 1,
      result: { status: 'closed', applied: false, error: 'resume_start_failed' },
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({ content: 'resume_start_failed' });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'closed',
      });
    await facade.stop();
    await store.close();
  });

  it('rolls an active resume projection back to the closed card when readiness flickers before 750ms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-flicker-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = {
        ...closed,
        status: 'active',
        closedAt: undefined,
        remoteBackendState: {
          version: 1,
          provider: 'test-runner',
          generation: 3,
          remoteSessionId: 'compute-2',
          agentThreadId: 'thread-1',
        },
      };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        suppressRecoveryCard: true,
        worker: { killed: false },
        workerReady: true,
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 750,
      resumeReadinessTimeoutMs: 2_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        if (now >= 310) {
          persisted = closed;
          active = undefined;
        }
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(now).toBe(310);
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{
          action: 'resume',
          result: { status: 'closed', applied: false, error: 'resume_start_failed' },
        }],
      });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({ content: 'closed' });
    await facade.stop();
    await store.close();
  });

  it('waits for host readiness after the provider generation advances, then requires stability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-ready-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = { ...closed, status: 'active', closedAt: undefined };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        suppressRecoveryCard: true,
        worker: { killed: false },
        workerReady: false,
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const readinessChecks: Array<{ generation: number | undefined; workerReady: boolean | undefined }> = [];
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      isResumeReady: ds => {
        readinessChecks.push({
          generation: ds.session.remoteBackendState?.generation,
          workerReady: ds.workerReady,
        });
        return !!ds.worker && !ds.worker.killed && ds.workerReady === true;
      },
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 200,
      resumeReadinessTimeoutMs: 1_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        if (now >= 110 && active && active.session.remoteBackendState?.generation === 2) {
          persisted = {
            ...persisted,
            remoteBackendState: {
              version: 1,
              provider: 'test-runner',
              generation: 3,
              remoteSessionId: 'compute-2',
              agentThreadId: 'thread-1',
            },
          };
          active = { ...active, session: persisted };
        }
        if (now >= 310 && active && active.workerReady !== true) {
          active = { ...active, workerReady: true };
        }
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(resumeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: {
        status: 'active',
        remoteBackendState: { generation: 3, remoteSessionId: 'compute-2' },
      },
      controls: [{ action: 'resume', result: { status: 'active' } }],
    });
    const operation = await store.readControlOperation(input.control.operationId);
    expect(operation).toMatchObject({ state: 'completed', attempts: 1 });
    expect(readinessChecks).toContainEqual({ generation: 3, workerReady: false });
    expect(readinessChecks).toContainEqual({ generation: 3, workerReady: true });
    expect(now).toBe(510);
    expect(active?.suppressRecoveryCard).toBeUndefined();
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({ content: 'active' });
    await facade.stop();
    await store.close();
  });

  it('durably reports a close residual instead of rendering an ordinary closed card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-residual-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    let persisted = session();
    let active: DaemonSession | undefined = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => {
        persisted = { ...persisted, status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' };
        active = undefined;
        return {
          ok: true,
          outcome: 'closed_with_residual',
          alreadyClosed: false,
          residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-9' },
        };
      },
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'must-not-render-ordinary-closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => 10,
    });
    const input = control();
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{
        action: 'close',
        result: {
          residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-9' },
          noticeText: 'residual:remote-9',
        },
      }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'residual:remote-9',
      });
    expect(await store.readOutbox(`control_update_${digest}`)).toBeUndefined();
    await facade.stop();
    await store.close();
  });

  it('durably reports a close refusal while preserving the active Session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-refused-close-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [active],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => ({
        ok: false,
        error: 'remote_cancel_unverified',
        taskId: 'remote-9',
      }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'must-not-render-ordinary-closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => 10,
    });
    const input = control();
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'active' },
      controls: [{
        action: 'close',
        result: {
          applied: false,
          error: 'remote_cancel_unverified',
          taskId: 'remote-9',
          noticeText: 'refused:remote_cancel_unverified:remote-9',
        },
      }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'refused:remote_cancel_unverified:remote-9',
      });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'active',
      });
    await facade.stop();
    await store.close();
  });

  it.each([
    'workspace_retired',
    'deferred_unmaterialized',
    'not_found',
    'not_closed',
    'resume_cancelled',
  ])('settles deterministic resume refusal %s without retrying the control operation', async error => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-deterministic-refusal-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session({ status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' });
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession: async () => ({ ok: false, error }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (closeError, taskId) => `refused:${closeError}:${taskId}`,
      resumeRefusedText: resumeError => `resume-refused:${resumeError}`,
      now: () => 10,
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      attempts: 1,
      result: { applied: false, error },
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({ content: `resume-refused:${error}` });
    await facade.stop();
    await store.close();
  });

  it('takes over a non-local active Session before applying close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-non-local-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: session() });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'takeover-owner' });
    const takeOverActiveSession = vi.fn(async (_sessionKey: string, canonical: Session) => {
      persisted = structuredClone(canonical);
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
      } as DaemonSession;
      return persisted;
    });
    const closeSession = vi.fn(async () => {
      persisted = { ...persisted!, status: 'closed', closedAt: '2026-10-09T00:02:00.000Z' };
      active = undefined;
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });

    const input = control('close');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
    );
    expect(closeSession).toHaveBeenCalledWith('session-1');
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({ session: { status: 'closed' } });
    await facade.stop();
    await store.close();
  });

  it('classifies an occupied active-session takeover as an owner handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-owner-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: session() });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => setupFacade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession: async () => ({
        kind: 'retry',
        reason: 'active Session lease is still owned by exact-owner',
      }),
      canOperate: () => true,
      closeSession: async () => ({ ok: true, outcome: 'closed' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = control('close');

    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DurableSessionControlOwnerHandoffError);
    await setupFacade.stop();
    await store.close();
  });
});
