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
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import { createDurableLarkSessionControlRuntime } from '../src/services/durable-lark-session-control-runtime.js';
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable Lark session control runtime', () => {
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
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active || undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => '{"header":{"title":"closed"}}',
      buildActiveCard: () => '{"header":{"title":"active"}}',
      resumeRefusedText: error => error,
      now: () => now,
    });
    const input = control();
    expect(runtime.authorizeBeforeAck(input.data)).toBe(true);
    expect(runtime.authorizeBeforeAck({
      ...input.data,
      context: { open_message_id: 'om_stale_card' },
    })).toBe(false);
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
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession: async () => ({
        ok: false,
        error: 'anchor_occupied',
        activeSessionId: 'session-other',
      }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
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
    expect(await store.readOutbox(`control_update_${digest}`)).toBeUndefined();
    await facade.stop();
    await store.close();
  });
});
