import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/services/frozen-card-store.js', () => ({ deleteFrozenCards: vi.fn() }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionTokenUsage: vi.fn(() => null) }));

import {
  createSession,
  __testOnly_setAfterPrincipalWorkspaceEnqueueCommit,
  __testOnly_setBeforePrincipalWorkspaceEnqueueCommit,
  enqueuePrincipalWorkspaceTicket,
  ensurePrincipalLaneSource,
  init,
  inventoryPrincipalWorkspaceTickets,
  readPrincipalWorkspaceMembershipV2,
  updateSession,
} from '../src/services/session-store.js';
import {
  appendPrincipalLaneQueueRecord,
  openPrincipalLaneQueue,
  type PrincipalLaneAppendReceipt,
  type PrincipalLaneQueueHandle,
} from '../src/services/message-queue.js';
import {
  createPrincipalLaneDispatchContext,
  type PrincipalLaneDispatchAuthority,
} from '../src/core/principal-lane-dispatch.js';
import type { PrincipalLaneIngressPlan } from '../src/core/principal-lane-ingress.js';
import {
  principalWorkspaceTicketIdV1,
  type PrincipalWorkspaceTicket,
} from '../src/core/principal-workspace-admission.js';
import type { LarkMessage } from '../src/types.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const appId = 'app-workspace-ticket';
const now = '2026-09-20T01:00:00.000Z';

function readyValue<T>(result: { status: string; value?: T; reason?: string }): T {
  if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}:${result.reason}`);
  return result.value as T;
}

function message(id: string, content = `payload-${id}`): LarkMessage {
  return {
    messageId: id,
    rootId: 'root-ticket',
    senderId: 'ou_ticket_user',
    senderType: 'user',
    msgType: 'text',
    content,
    createTime: '1790000000000',
  };
}

function setupLane() {
  init(appId);
  const session = createSession('chat-ticket', 'root-ticket', 'source-ticket', 'group', 'thread');
  session.larkAppId = appId;
  session.ownerUnionId = 'on_ticket_source';
  session.ownerOpenId = 'ou_ticket_source';
  session.workingDir = realpathSync(tempDir);
  updateSession(session);
  const source = ensurePrincipalLaneSource({
    sourceSessionId: session.sessionId,
    caller: { senderType: 'user', kind: 'union', unionId: 'on_ticket_source' },
    now,
  });
  if (source.status !== 'ready') throw new Error(`source not ready: ${source.status}`);
  const membership = readPrincipalWorkspaceMembershipV2(session.sessionId);
  if (membership.status !== 'ready') throw new Error(`membership not ready: ${membership.status}`);
  const laneSnapshot = membership.lanes.find(value => value.lane.laneId === 'source')!;
  const fence = {
    callerPrincipalKey: source.lane.principalKey,
    sourceSessionId: session.sessionId,
    sourcePrincipalKey: source.source.sourcePrincipalKey,
    sourceRevision: source.source.revision,
    sourceLaneRevision: source.lane.revision,
    workspaceEpoch: source.source.workspaceEpoch,
    canonicalCwd: source.source.canonicalCwd,
    workspaceGroupId: source.source.workspaceGroupId,
    workspaceGroupKeyVersion: source.source.workspaceGroupKeyVersion,
    displayTarget: source.source.displayTarget,
    laneId: source.lane.laneId,
    laneRevision: source.lane.revision,
    lanePrincipalKey: source.lane.principalKey,
    routingAnchor: source.lane.routingAnchor,
    sessionId: session.sessionId,
  };
  const plan: PrincipalLaneIngressPlan = {
    kind: 'route_lane', reason: 'existing_caller_lane', lane: source.lane,
    displayTarget: source.source.displayTarget, fence,
  };
  const authority: PrincipalLaneDispatchAuthority = {
    source: { sourceSessionId: session.sessionId, source: source.source, lane: source.lane },
    lane: { lane: source.lane, sessionId: session.sessionId },
    session: laneSnapshot.session,
  };
  const dispatch = createPrincipalLaneDispatchContext(plan, authority);
  if (dispatch.status !== 'ready') throw new Error(`dispatch not ready: ${JSON.stringify(dispatch)}`);
  const handle = readyValue<PrincipalLaneQueueHandle>(
    openPrincipalLaneQueue(dispatch.capability, authority),
  );
  return {
    authority, handle, plan,
    expected: { groupRevision: membership.group.revision, memberRevision: laneSnapshot.member.revision },
  };
}

function append(
  lane: ReturnType<typeof setupLane>,
  turnId: string,
  payload: LarkMessage,
): PrincipalLaneAppendReceipt {
  return readyValue<PrincipalLaneAppendReceipt>(
    appendPrincipalLaneQueueRecord(lane.handle, lane.authority, turnId, payload),
  );
}

function recordPath(lane: ReturnType<typeof setupLane>, recordId: string): string {
  return join(
    tempDir, 'queues', 'principal-lanes', 'v1', lane.handle.namespace,
    'records', 'v1', `${recordId}.json`,
  );
}

function sessionDbPath(): string {
  return join(tempDir, 'session-stores', appId, 'sessions.db');
}

function insertTicketRow(
  db: DatabaseSync,
  ticket: PrincipalWorkspaceTicket,
  rawRow = JSON.stringify(ticket),
): void {
  db.prepare(
    'INSERT INTO principal_workspace_tickets '
    + '(ticket_id, group_id, sequence, source_session_id, lane_id, session_id, '
    + 'workspace_epoch, turn_id, status, revision, namespace_version, namespace, '
    + 'record_version, record_id, payload_encoding, payload_hash, exact_file_length, '
    + 'created_at, updated_at, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    ticket.ticketId, ticket.groupId, ticket.sequence, ticket.sourceSessionId, ticket.laneId,
    ticket.sessionId, ticket.workspaceEpoch, ticket.turnId, ticket.status, ticket.revision,
    ticket.locator.namespaceVersion, ticket.locator.namespace, ticket.locator.recordVersion,
    ticket.locator.recordId, ticket.locator.payloadEncoding, ticket.locator.payloadHash,
    ticket.locator.exactFileLength, ticket.createdAt, ticket.updatedAt, rawRow,
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'principal-workspace-ticket-'));
  init();
  __testOnly_setBeforePrincipalWorkspaceEnqueueCommit(undefined);
  __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
});

afterEach(() => {
  __testOnly_setBeforePrincipalWorkspaceEnqueueCommit(undefined);
  __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('principal workspace durable enqueue', () => {
  it('allocates monotonic group FIFO sequences and replays an exact turn idempotently', () => {
    const lane = setupLane();
    const firstReceipt = append(lane, 'turn-a', message('message-a'));
    const first = enqueuePrincipalWorkspaceTicket({
      receipt: firstReceipt, authority: lane.authority, expected: lane.expected, now,
    });
    expect(first).toMatchObject({ status: 'ready', created: true, ticket: { sequence: 1 } });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: firstReceipt, authority: lane.authority, expected: lane.expected, now,
    })).toMatchObject({ status: 'ready', created: false, ticket: { sequence: 1 } });

    const second = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-b', message('message-b')),
      authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    });
    expect(second).toMatchObject({ status: 'ready', created: true, ticket: { sequence: 2 } });
  });

  it('serializes two processes into one monotonic group FIFO', async () => {
    const lane = setupLane();
    init();
    const childCode = (turnId: string) => `
      import { init, enqueuePrincipalWorkspaceTicket } from './src/services/session-store.js';
      import { createPrincipalLaneDispatchContext } from './src/core/principal-lane-dispatch.js';
      import { openPrincipalLaneQueue, appendPrincipalLaneQueueRecord } from './src/services/message-queue.js';
      init(${JSON.stringify(appId)});
      const authority = ${JSON.stringify(lane.authority)};
      const plan = ${JSON.stringify(lane.plan)};
      const dispatch = createPrincipalLaneDispatchContext(plan, authority);
      if (dispatch.status !== 'ready') throw new Error('dispatch:' + JSON.stringify(dispatch));
      const opened = openPrincipalLaneQueue(dispatch.capability, authority);
      if (opened.status !== 'ready') throw new Error('open:' + JSON.stringify(opened));
      const appended = appendPrincipalLaneQueueRecord(opened.value, authority, ${JSON.stringify(turnId)}, {
        messageId: ${JSON.stringify(`message-${turnId}`)}, rootId: 'root-ticket',
        senderId: 'ou_ticket_user', senderType: 'user', msgType: 'text',
        content: ${JSON.stringify(`payload-${turnId}`)}, createTime: '1790000000000',
      });
      if (appended.status !== 'ready') throw new Error('append:' + JSON.stringify(appended));
      const result = enqueuePrincipalWorkspaceTicket({
        receipt: appended.value, authority, expected: ${JSON.stringify(lane.expected)},
        now: '2026-09-20T01:00:02.000Z',
      });
      console.log('ENQUEUE_RESULT=' + JSON.stringify(result));
    `;
    const run = (turnId: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(childCode(turnId), {
        env: { ...process.env, SESSION_DATA_DIR: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    const outcomes = await Promise.all([run('turn-race-a'), run('turn-race-b')]);
    const results = outcomes.map(outcome => {
      expect(outcome.code, outcome.output).toBe(0);
      return JSON.parse(outcome.output.split('ENQUEUE_RESULT=')[1]!.trim().split('\n')[0]!);
    });
    expect(results.every(result => result.status === 'ready' && result.created)).toBe(true);
    expect(results.map(result => result.ticket.sequence).sort()).toEqual([1, 2]);

    const duplicateOutcomes = await Promise.all([run('turn-race-same'), run('turn-race-same')]);
    const duplicateResults = duplicateOutcomes.map(outcome => {
      expect(outcome.code, outcome.output).toBe(0);
      return JSON.parse(outcome.output.split('ENQUEUE_RESULT=')[1]!.trim().split('\n')[0]!);
    });
    expect(duplicateResults.filter(result => result.status === 'ready' && result.created).length)
      .toBe(1);
    expect(duplicateResults.filter(result => result.status === 'ready' && !result.created).length)
      .toBe(1);
    expect(duplicateResults.map(result => result.ticket.sequence)).toEqual([3, 3]);
  });

  it('keeps the original ticket when one turn points at a different immutable record', () => {
    const lane = setupLane();
    const first = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-conflict', message('message-one', 'one')),
      authority: lane.authority, expected: lane.expected, now,
    });
    expect(first).toMatchObject({ status: 'ready', created: true });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-conflict', message('message-two', 'two')),
      authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    })).toEqual({ status: 'conflict', reason: 'turn_record_conflict' });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-after-conflict', message('message-after-conflict')),
      authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:02.000Z',
    })).toMatchObject({ status: 'ready', created: true, ticket: { sequence: 2 } });
  });

  it('reports only records and tickets from the verified queue namespace', () => {
    const lane = setupLane();
    enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-ticketed', message('message-ticketed')),
      authority: lane.authority, expected: lane.expected, now,
    });
    append(lane, 'turn-orphan', message('message-orphan'));
    writeFileSync(join(
      tempDir, 'queues', 'principal-lanes', 'v1', lane.handle.namespace,
      'records', 'v1', '.stage-00000000-0000-4000-8000-000000000000.tmp',
    ), 'stage');
    const db = new DatabaseSync(sessionDbPath());
    try {
      const before = {
        dataVersion: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
        groups: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_groups').all()),
        tickets: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_tickets').all()),
        audit: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_ticket_audit').all()),
      };
      const inventory = inventoryPrincipalWorkspaceTickets({
        handle: lane.handle, authority: lane.authority, expected: lane.expected,
      });
      expect(inventory).toMatchObject({
        status: 'ready', ticketed: [{ sequence: 1 }], orphanRecords: [{}],
        conflicts: [], unknown: [],
        staging: [{ name: '.stage-00000000-0000-4000-8000-000000000000.tmp' }],
      });
      expect({
        dataVersion: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
        groups: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_groups').all()),
        tickets: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_tickets').all()),
        audit: JSON.stringify(db.prepare('SELECT * FROM principal_workspace_ticket_audit').all()),
      }).toEqual(before);
    } finally { db.close(); }
  });

  it('fails closed when a persisted ticket is rebound to another queue namespace', () => {
    const lane = setupLane();
    enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-namespace', message('message-namespace')),
      authority: lane.authority, expected: lane.expected, now,
    });
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      const hit = db.prepare('SELECT ticket_id, row FROM principal_workspace_tickets').get() as {
        ticket_id: string; row: string;
      };
      const ticket = JSON.parse(hit.row);
      ticket.locator.namespace = `plq_v1_${'f'.repeat(64)}`;
      db.prepare('UPDATE principal_workspace_tickets SET namespace = ?, row = ? WHERE ticket_id = ?')
        .run(ticket.locator.namespace, JSON.stringify(ticket), hit.ticket_id);
    } finally { db.close(); }
    expect(inventoryPrincipalWorkspaceTickets({
      handle: lane.handle, authority: lane.authority, expected: lane.expected,
    })).toMatchObject({
      status: 'ready', ticketed: [], orphanRecords: [{}], unknown: [],
      conflicts: [{ reason: 'ticket_namespace_mismatch' }],
    });
  });

  it('reports deterministic record length conflicts without quarantining or writing', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-length-conflict', message('message-length-conflict')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    writeFileSync(recordPath(lane, enqueued.ticket.locator.recordId), 'x');
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      const before = JSON.stringify({
        dataVersion: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
        group: db.prepare('SELECT * FROM principal_workspace_groups').get(),
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      });
      expect(inventoryPrincipalWorkspaceTickets({
        handle: lane.handle, authority: lane.authority, expected: lane.expected,
      })).toMatchObject({
        status: 'ready', ticketed: [], orphanRecords: [], unknown: [],
        conflicts: [{
          recordId: enqueued.ticket.locator.recordId,
          reason: 'record_length_mismatch',
          expectedExactFileLength: enqueued.ticket.locator.exactFileLength,
          observedExactFileLength: 1,
        }],
      });
      expect(JSON.stringify({
        dataVersion: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
        group: db.prepare('SELECT * FROM principal_workspace_groups').get(),
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      })).toBe(before);
    } finally { db.close(); }
  });

  it('reports a ticket with no record as unknown without mutating admission state', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-record-missing', message('message-record-missing')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    unlinkSync(recordPath(lane, enqueued.ticket.locator.recordId));
    expect(inventoryPrincipalWorkspaceTickets({
      handle: lane.handle, authority: lane.authority, expected: lane.expected,
    })).toMatchObject({
      status: 'ready', ticketed: [], orphanRecords: [], conflicts: [],
      unknown: [{
        ticketId: enqueued.ticket.ticketId,
        recordId: enqueued.ticket.locator.recordId,
        reason: 'record_missing',
      }],
    });
  });

  it('reports missing ticket audit evidence as unknown without writing', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-audit-missing', message('message-audit-missing')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    const db = new DatabaseSync(sessionDbPath());
    try {
      db.prepare("DELETE FROM principal_workspace_ticket_audit WHERE event = 'enqueued'").run();
      const before = JSON.stringify({
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      });
      expect(inventoryPrincipalWorkspaceTickets({
        handle: lane.handle, authority: lane.authority, expected: lane.expected,
      })).toMatchObject({
        status: 'ready', ticketed: [], orphanRecords: [], conflicts: [],
        unknown: [{ ticketId: enqueued.ticket.ticketId, reason: 'ticket_audit_unverified' }],
      });
      expect(JSON.stringify({
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      })).toBe(before);
    } finally { db.close(); }
  });

  it('reports unverified counter evidence as unknown without writing', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-counter-unverified', message('message-counter-unverified')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    const db = new DatabaseSync(sessionDbPath());
    try {
      db.prepare("UPDATE principal_workspace_ticket_sequences SET row = '{bad-json'").run();
      const before = JSON.stringify({
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      });
      expect(inventoryPrincipalWorkspaceTickets({
        handle: lane.handle, authority: lane.authority, expected: lane.expected,
      })).toMatchObject({
        status: 'ready', ticketed: [], orphanRecords: [], conflicts: [],
        unknown: [{ ticketId: enqueued.ticket.ticketId, reason: 'ticket_counter_unverified' }],
      });
      expect(JSON.stringify({
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      })).toBe(before);
    } finally { db.close(); }
  });

  it('verifies the counter against the highest indexed sequence across the whole group', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-source-sequence', message('message-source-sequence')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    const otherLaneTicket: PrincipalWorkspaceTicket = {
      ...enqueued.ticket,
      ticketId: principalWorkspaceTicketIdV1({
        groupId: enqueued.ticket.groupId,
        sourceSessionId: enqueued.ticket.sourceSessionId,
        laneId: 'shadow-manual',
        sessionId: 'shadow-session-manual',
        turnId: 'turn-other-lane-high-sequence',
      }),
      sequence: 4,
      laneId: 'shadow-manual',
      sessionId: 'shadow-session-manual',
      turnId: 'turn-other-lane-high-sequence',
      locator: {
        ...enqueued.ticket.locator,
        recordId: `plr_v1_${'a'.repeat(64)}`,
        turnId: 'turn-other-lane-high-sequence',
        payloadHash: `sha256:${'b'.repeat(64)}`,
      },
    };
    const db = new DatabaseSync(sessionDbPath());
    try { insertTicketRow(db, otherLaneTicket); } finally { db.close(); }
    expect(inventoryPrincipalWorkspaceTickets({
      handle: lane.handle, authority: lane.authority, expected: lane.expected,
    })).toMatchObject({
      status: 'ready', ticketed: [], conflicts: [],
      unknown: [{
        ticketId: enqueued.ticket.ticketId,
        reason: 'ticket_counter_unverified',
      }],
    });
  });

  it('includes malformed high-sequence ticket indexes in the group counter proof', () => {
    const lane = setupLane();
    const enqueued = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-valid-low-sequence', message('message-valid-low-sequence')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (enqueued.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(enqueued)}`);
    const malformedTicket: PrincipalWorkspaceTicket = {
      ...enqueued.ticket,
      ticketId: principalWorkspaceTicketIdV1({
        groupId: enqueued.ticket.groupId,
        sourceSessionId: enqueued.ticket.sourceSessionId,
        laneId: enqueued.ticket.laneId,
        sessionId: enqueued.ticket.sessionId,
        turnId: 'turn-malformed-high-sequence',
      }),
      sequence: 5,
      turnId: 'turn-malformed-high-sequence',
      locator: {
        ...enqueued.ticket.locator,
        recordId: `plr_v1_${'c'.repeat(64)}`,
        turnId: 'turn-malformed-high-sequence',
        payloadHash: `sha256:${'d'.repeat(64)}`,
      },
    };
    const db = new DatabaseSync(sessionDbPath());
    try { insertTicketRow(db, malformedTicket, '{bad-json'); } finally { db.close(); }
    const inventory = inventoryPrincipalWorkspaceTickets({
      handle: lane.handle, authority: lane.authority, expected: lane.expected,
    });
    expect(inventory).toMatchObject({ status: 'ready', ticketed: [], conflicts: [] });
    if (inventory.status !== 'ready') throw new Error(`inventory failed: ${JSON.stringify(inventory)}`);
    expect(inventory.unknown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticketId: enqueued.ticket.ticketId,
        reason: 'ticket_counter_unverified',
      }),
      expect.objectContaining({
        ticketId: malformedTicket.ticketId,
        sequence: 5,
        reason: 'ticket_row_unverified',
      }),
    ]));
  });

  it('fails closed on a valid but exhausted sequence without changing any durable row', () => {
    const lane = setupLane();
    const groupId = lane.authority.source.source.workspaceGroupId;
    const counter = {
      version: 1, groupId, lastSequence: Number.MAX_SAFE_INTEGER, revision: 7,
      createdAt: now, updatedAt: now,
    };
    const db = new DatabaseSync(sessionDbPath());
    try {
      db.prepare(
        'INSERT INTO principal_workspace_ticket_sequences '
        + '(group_id, last_sequence, revision, created_at, updated_at, row) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      ).run(groupId, counter.lastSequence, counter.revision, now, now, JSON.stringify(counter));
      const before = JSON.stringify({
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').get(),
        group: db.prepare('SELECT * FROM principal_workspace_groups').get(),
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      });
      expect(enqueuePrincipalWorkspaceTicket({
        receipt: append(lane, 'turn-sequence-exhausted', message('message-sequence-exhausted')),
        authority: lane.authority, expected: lane.expected, now,
      })).toEqual({ status: 'busy', reason: 'sequence_exhausted' });
      expect(JSON.stringify({
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').get(),
        group: db.prepare('SELECT * FROM principal_workspace_groups').get(),
        tickets: db.prepare('SELECT * FROM principal_workspace_tickets').all(),
        audit: db.prepare('SELECT * FROM principal_workspace_ticket_audit').all(),
      })).toBe(before);
    } finally { db.close(); }
  });

  it('quarantines a group when its monotonic counter regresses below existing tickets', () => {
    const lane = setupLane();
    const receipt = append(lane, 'turn-counter', message('message-counter'));
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected, now,
    })).toMatchObject({ status: 'ready', created: true });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const hit = db.prepare('SELECT group_id, row FROM principal_workspace_ticket_sequences')
        .get() as { group_id: string; row: string };
      const counter = JSON.parse(hit.row);
      counter.lastSequence = 0;
      db.prepare('UPDATE principal_workspace_ticket_sequences SET last_sequence = 0, row = ? WHERE group_id = ?')
        .run(JSON.stringify(counter), hit.group_id);
    } finally { db.close(); }
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    })).toEqual({ status: 'quarantined', target: 'group', reason: 'counter_corruption' });
    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare('SELECT phase FROM principal_workspace_groups').get() as { phase: string }).phase)
        .toBe('quarantined');
      expect((verify.prepare("SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit WHERE event = 'counter_corruption'")
        .get() as { n: number }).n).toBe(1);
    } finally { verify.close(); }
  });

  it('converges a commit-unknown result by read-only ticket and audit proof', () => {
    const lane = setupLane();
    const receipt = append(lane, 'turn-commit-unknown', message('message-commit-unknown'));
    __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(() => {
      __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
      throw new Error('simulated commit acknowledgement loss');
    });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected, now,
    })).toMatchObject({ status: 'ready', created: false, ticket: { sequence: 1 } });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_tickets')
        .get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit WHERE event = 'enqueued'")
        .get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('proves a pre-commit rollback as not committed without leaving traces', () => {
    const lane = setupLane();
    __testOnly_setBeforePrincipalWorkspaceEnqueueCommit(() => {
      __testOnly_setBeforePrincipalWorkspaceEnqueueCommit(undefined);
      throw new Error('simulated failure before commit');
    });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-pre-commit-failure', message('message-pre-commit-failure')),
      authority: lane.authority, expected: lane.expected, now,
    })).toEqual({ status: 'retry', reason: 'enqueue_not_committed' });
    const db = new DatabaseSync(sessionDbPath());
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_sequences')
        .get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_tickets')
        .get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit')
        .get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it('keeps commit outcome unknown when a counter residue remains without a ticket', () => {
    const lane = setupLane();
    __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(() => {
      __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
      const db = new DatabaseSync(sessionDbPath());
      try {
        db.prepare('DELETE FROM principal_workspace_tickets').run();
        db.prepare('DELETE FROM principal_workspace_ticket_audit').run();
      } finally { db.close(); }
      throw new Error('simulated commit acknowledgement loss with counter residue');
    });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-counter-residue', message('message-counter-residue')),
      authority: lane.authority, expected: lane.expected, now,
    })).toEqual({ status: 'unknown', reason: 'enqueue_unknown' });
    const db = new DatabaseSync(sessionDbPath());
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_sequences')
        .get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_tickets')
        .get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit')
        .get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it('keeps commit outcome unknown when a non-enqueued audit residue remains', () => {
    const lane = setupLane();
    const receipt = append(lane, 'turn-audit-residue', message('message-audit-residue'));
    const ticketId = principalWorkspaceTicketIdV1({
      groupId: lane.authority.source.source.workspaceGroupId,
      sourceSessionId: lane.authority.source.sourceSessionId,
      laneId: lane.authority.lane.lane.laneId,
      sessionId: lane.authority.lane.sessionId,
      turnId: 'turn-audit-residue',
    });
    __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(() => {
      __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
      const db = new DatabaseSync(sessionDbPath());
      try {
        db.prepare('DELETE FROM principal_workspace_tickets').run();
        db.prepare('DELETE FROM principal_workspace_ticket_audit').run();
        db.prepare('DELETE FROM principal_workspace_ticket_sequences').run();
        db.prepare(
          'INSERT INTO principal_workspace_ticket_audit '
          + '(audit_id, group_id, ticket_id, source_session_id, lane_id, session_id, '
          + 'turn_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          'audit-residue', lane.authority.source.source.workspaceGroupId, ticketId,
          lane.authority.source.sourceSessionId, lane.authority.lane.lane.laneId,
          lane.authority.lane.sessionId, 'turn-audit-residue', 'turn_record_conflict', '{}', now,
        );
      } finally { db.close(); }
      throw new Error('simulated commit acknowledgement loss with audit residue');
    });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected, now,
    })).toEqual({ status: 'unknown', reason: 'enqueue_unknown' });
  });

  it('keeps commit outcome unknown when the ticket audit proof is missing', () => {
    const lane = setupLane();
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(() => {
      __testOnly_setAfterPrincipalWorkspaceEnqueueCommit(undefined);
      const db = new DatabaseSync(dbPath);
      try { db.prepare("DELETE FROM principal_workspace_ticket_audit WHERE event = 'enqueued'").run(); }
      finally { db.close(); }
      throw new Error('simulated commit acknowledgement loss with damaged proof');
    });
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-unknown-proof', message('message-unknown-proof')),
      authority: lane.authority, expected: lane.expected, now,
    })).toEqual({ status: 'unknown', reason: 'enqueue_unknown' });
  });

  it('classifies a deterministic ticket id rebound to another identity as a collision', () => {
    const lane = setupLane();
    const existing = enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-existing-ticket', message('message-existing-ticket')),
      authority: lane.authority, expected: lane.expected, now,
    });
    if (existing.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(existing)}`);
    const incomingTurnId = 'turn-ticket-id-collision';
    const incomingTicketId = principalWorkspaceTicketIdV1({
      groupId: lane.authority.source.source.workspaceGroupId,
      sourceSessionId: lane.authority.source.sourceSessionId,
      laneId: lane.authority.lane.lane.laneId,
      sessionId: lane.authority.lane.sessionId,
      turnId: incomingTurnId,
    });
    const db = new DatabaseSync(sessionDbPath());
    try {
      const hit = db.prepare('SELECT row FROM principal_workspace_tickets WHERE ticket_id = ?')
        .get(existing.ticket.ticketId) as { row: string };
      const row = JSON.parse(hit.row);
      row.ticketId = incomingTicketId;
      db.prepare('UPDATE principal_workspace_tickets SET ticket_id = ?, row = ? WHERE ticket_id = ?')
        .run(incomingTicketId, JSON.stringify(row), existing.ticket.ticketId);
    } finally { db.close(); }
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, incomingTurnId, message('message-ticket-id-collision')),
      authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    })).toEqual({ status: 'quarantined', target: 'ticket', reason: 'ticket_id_collision' });
    const verify = new DatabaseSync(sessionDbPath());
    try {
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit WHERE event = 'ticket_id_collision'",
      ).get() as { n: number }).n).toBe(1);
    } finally { verify.close(); }
  });

  it('keeps malformed same-identity ticket rows distinct from ticket id collisions', () => {
    const lane = setupLane();
    const receipt = append(lane, 'turn-row-corruption', message('message-row-corruption'));
    const existing = enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected, now,
    });
    if (existing.status !== 'ready') throw new Error(`enqueue failed: ${JSON.stringify(existing)}`);
    const db = new DatabaseSync(sessionDbPath());
    try {
      const hit = db.prepare('SELECT row FROM principal_workspace_tickets WHERE ticket_id = ?')
        .get(existing.ticket.ticketId) as { row: string };
      const row = JSON.parse(hit.row);
      row.locator.exactFileLength += 1;
      db.prepare('UPDATE principal_workspace_tickets SET row = ? WHERE ticket_id = ?')
        .run(JSON.stringify(row), existing.ticket.ticketId);
    } finally { db.close(); }
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    })).toMatchObject({ status: 'quarantined', target: 'ticket', reason: 'ticket:indexed_value_mismatch' });
    const verify = new DatabaseSync(sessionDbPath());
    try {
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit WHERE event = 'ticket_row_corruption'",
      ).get() as { n: number }).n).toBe(1);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit WHERE event = 'ticket_id_collision'",
      ).get() as { n: number }).n).toBe(0);
    } finally { verify.close(); }
  });

  it('rolls back the exact counter row when ticket insertion fails after counter CAS', () => {
    const lane = setupLane();
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: append(lane, 'turn-before-insert-failure', message('message-before-insert-failure')),
      authority: lane.authority, expected: lane.expected, now,
    })).toMatchObject({ status: 'ready', ticket: { sequence: 1 } });
    const secondReceipt = append(lane, 'turn-insert-failure', message('message-insert-failure'));
    const db = new DatabaseSync(sessionDbPath());
    let before: string;
    try {
      db.exec(`CREATE TRIGGER fail_principal_workspace_ticket_insert
        BEFORE INSERT ON principal_workspace_tickets
        BEGIN SELECT RAISE(ABORT, 'injected_ticket_insert_failure'); END`);
      before = JSON.stringify({
        counter: db.prepare('SELECT * FROM principal_workspace_ticket_sequences').get(),
        ticketCount: db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_tickets').get(),
        auditCount: db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit').get(),
      });
    } finally { db.close(); }
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: secondReceipt, authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:01.000Z',
    })).toEqual({ status: 'retry', reason: 'enqueue_not_committed' });
    const verify = new DatabaseSync(sessionDbPath());
    try {
      expect(JSON.stringify({
        counter: verify.prepare('SELECT * FROM principal_workspace_ticket_sequences').get(),
        ticketCount: verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_tickets').get(),
        auditCount: verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_ticket_audit').get(),
      })).toBe(before!);
      verify.exec('DROP TRIGGER fail_principal_workspace_ticket_insert');
    } finally { verify.close(); }
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: secondReceipt, authority: lane.authority, expected: lane.expected,
      now: '2026-09-20T01:00:02.000Z',
    })).toMatchObject({ status: 'ready', created: true, ticket: { sequence: 2 } });
  });

  it('leaves only an inventory-visible orphan when authority is stale before enqueue', () => {
    const lane = setupLane();
    const receipt = append(lane, 'turn-orphan-stale', message('message-orphan-stale'));
    expect(enqueuePrincipalWorkspaceTicket({
      receipt, authority: lane.authority,
      expected: { ...lane.expected, groupRevision: lane.expected.groupRevision + 1 }, now,
    })).toEqual({ status: 'retry', reason: 'stale_authority' });
    expect(inventoryPrincipalWorkspaceTickets({
      handle: lane.handle, authority: lane.authority, expected: lane.expected,
    })).toMatchObject({
      status: 'ready', ticketed: [], orphanRecords: [{}], conflicts: [], unknown: [],
    });
  });

  it('rejects a hand-made receipt before opening the ticket transaction', () => {
    const lane = setupLane();
    expect(enqueuePrincipalWorkspaceTicket({
      receipt: { version: 1 } as PrincipalLaneAppendReceipt,
      authority: lane.authority, expected: lane.expected, now,
    })).toEqual({ status: 'invalid', reason: 'invalid_capability' });
  });
});
