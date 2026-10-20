/**
 * Unit tests for services/message-queue.
 *
 * The module is file-system backed, so we mock `node:fs` and the config/logger
 * dependencies to keep the tests fast and deterministic.
 *
 * Run:  pnpm vitest run test/message-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory FS simulation ─────────────────────────────────────────────────

/** Simple in-memory file store keyed by absolute path. */
let files: Record<string, string>;
let readPaths: string[];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => p in files,
    mkdirSync: (_p: string, _opts?: any) => {
      /* no-op: directory creation is a side effect we don't need to track */
    },
    writeFileSync: (p: string, data: string, _enc?: string) => {
      files[p] = data;
    },
    appendFileSync: (p: string, data: string, _enc?: string) => {
      files[p] = (files[p] ?? '') + data;
    },
    readFileSync: (p: string, _enc?: string) => {
      readPaths.push(p);
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
});

// This suite owns the queue semantics, not atomic-write's fd/fsync machinery.
// Keep persistence in the same in-memory store while atomic-write has its own
// dedicated tests. This avoids duplicating every current/future node:fs syscall
// in a fragile full-module mock.
vi.mock('../src/utils/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, data: string | Buffer) => {
    files[path] = Buffer.isBuffer(data) ? data.toString('utf8') : data;
  },
}));

vi.mock('../src/config.js', () => ({
  config: {
    session: { dataDir: '/tmp/test-mq' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

// Import the module under test *after* mocks are registered.
import {
  ensureQueue,
  appendMessage,
  readUnread,
  rewindOffset,
  getOffset,
  appendPrincipalLaneMessage,
  getPrincipalLaneQueueOffset,
  openPrincipalLaneQueue,
  readPrincipalLaneUnread,
  rewindPrincipalLaneQueue,
} from '../src/services/message-queue.js';
import {
  createPrincipalLaneDispatchContext,
  type PrincipalLaneDispatchAuthority,
  type PrincipalLaneDispatchCapability,
  type PrincipalLaneQueueIdentity,
} from '../src/core/principal-lane-dispatch.js';
import type {
  HumanLanePrincipal,
  LarkMessage,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  PrincipalLaneWorktreeProof,
} from '../src/types.js';
import type { PrincipalLaneIngressPlan } from '../src/core/principal-lane-ingress.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  principalWorkspaceGroupIdV2,
} from '../src/core/principal-workspace-admission.js';
import { principalLaneWorktreeMaterializationId } from '../src/core/principal-lane-worktree.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(id: string, text = 'hello'): LarkMessage {
  return {
    messageId: id,
    rootId: 'root_1',
    senderId: 'ou_user',
    senderType: 'user',
    msgType: 'text',
    content: text,
    createTime: String(Date.now()),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  files = {};
  readPaths = [];
});

describe('ensureQueue', () => {
  it('creates an empty queue file for a new key', () => {
    ensureQueue('root_a');
    expect(files['/tmp/test-mq/queues/root_a.jsonl']).toBe('');
  });

  it('does not overwrite an existing queue file', () => {
    files['/tmp/test-mq/queues'] = ''; // directory marker
    files['/tmp/test-mq/queues/root_a.jsonl'] = 'existing\n';
    ensureQueue('root_a');
    expect(files['/tmp/test-mq/queues/root_a.jsonl']).toBe('existing\n');
  });
});

describe('appendMessage', () => {
  it('appends a JSON line to the queue file', () => {
    const msg = makeMessage('m1');
    appendMessage('root_b', msg);

    const raw = files['/tmp/test-mq/queues/root_b.jsonl'];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toEqual(msg);
  });

  it('appends multiple messages as separate lines', () => {
    appendMessage('root_b', makeMessage('m1'));
    appendMessage('root_b', makeMessage('m2'));

    const lines = files['/tmp/test-mq/queues/root_b.jsonl']
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).messageId).toBe('m1');
    expect(JSON.parse(lines[1]).messageId).toBe('m2');
  });
});

describe('readUnread', () => {
  it('returns all messages when nothing has been read yet', () => {
    appendMessage('root_c', makeMessage('m1', 'first'));
    appendMessage('root_c', makeMessage('m2', 'second'));

    const msgs = readUnread('root_c');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('first');
    expect(msgs[1].content).toBe('second');
  });

  it('advances offset so subsequent call returns empty', () => {
    appendMessage('root_d', makeMessage('m1'));
    const first = readUnread('root_d');
    expect(first).toHaveLength(1);

    const second = readUnread('root_d');
    expect(second).toHaveLength(0);
  });

  it('returns only new messages after offset advances', () => {
    appendMessage('root_e', makeMessage('m1'));
    readUnread('root_e'); // consume m1

    appendMessage('root_e', makeMessage('m2', 'new'));
    const msgs = readUnread('root_e');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });

  it('returns empty array for a non-existent queue', () => {
    expect(readUnread('nonexistent')).toEqual([]);
  });

  it('returns empty array when queue file exists but is empty', () => {
    ensureQueue('root_empty');
    expect(readUnread('root_empty')).toEqual([]);
  });
});

describe('rewindOffset', () => {
  it('resets offset to 0 so all messages are re-read', () => {
    appendMessage('root_f', makeMessage('m1'));
    appendMessage('root_f', makeMessage('m2'));
    readUnread('root_f'); // consume both

    rewindOffset('root_f');

    const msgs = readUnread('root_f');
    expect(msgs).toHaveLength(2);
  });

  it('resets offset to a specific byte position', () => {
    appendMessage('root_g', makeMessage('m1'));
    const afterFirst = getOffset('root_g'); // still 0

    // Read once to advance offset past m1.
    readUnread('root_g');
    const midpoint = getOffset('root_g');
    expect(midpoint).toBeGreaterThan(0);

    appendMessage('root_g', makeMessage('m2'));
    readUnread('root_g'); // consume m2

    // Rewind to midpoint — only m2 should be visible.
    rewindOffset('root_g', midpoint);
    const msgs = readUnread('root_g');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe('m2');
  });
});

describe('getOffset', () => {
  it('returns 0 when no offset file exists', () => {
    expect(getOffset('root_new')).toBe(0);
  });

  it('returns current byte offset after reading', () => {
    appendMessage('root_h', makeMessage('m1'));
    readUnread('root_h');
    expect(getOffset('root_h')).toBeGreaterThan(0);
  });

  it('returns 0 after rewindOffset()', () => {
    appendMessage('root_i', makeMessage('m1'));
    readUnread('root_i');
    rewindOffset('root_i');
    expect(getOffset('root_i')).toBe(0);
  });
});

describe('key isolation', () => {
  it('separate keys maintain independent queues and offsets', () => {
    appendMessage('key_a', makeMessage('a1', 'alpha'));
    appendMessage('key_b', makeMessage('b1', 'beta'));

    const msgsA = readUnread('key_a');
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].content).toBe('alpha');

    const msgsB = readUnread('key_b');
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].content).toBe('beta');

    // Reading key_a again yields nothing — offset was advanced independently.
    expect(readUnread('key_a')).toHaveLength(0);
  });

  it('rewinding one key does not affect another', () => {
    appendMessage('key_x', makeMessage('x1'));
    appendMessage('key_y', makeMessage('y1'));

    readUnread('key_x');
    readUnread('key_y');

    rewindOffset('key_x');

    expect(readUnread('key_x')).toHaveLength(1);
    expect(readUnread('key_y')).toHaveLength(0);
  });
});

const laneTimestamp = '2026-09-19T10:00:00.000Z';

interface LaneFixtureOptions extends Partial<PrincipalLaneQueueIdentity> {
  principal?: HumanLanePrincipal;
}

function laneFixture(options: LaneFixtureOptions = {}) {
  const identity: PrincipalLaneQueueIdentity = {
    larkAppId: options.larkAppId ?? 'cli_lane_app',
    sourceSessionId: options.sourceSessionId ?? 'source-session',
    laneId: options.laneId ?? 'lane-a',
    sessionId: options.sessionId ?? 'session-a',
  };
  const displayTarget: PrincipalLaneDisplayTarget = {
    scope: 'thread',
    larkAppId: identity.larkAppId,
    chatId: 'chat-shared',
    rootMessageId: 'root-shared',
  };
  const sourcePrincipal: HumanLanePrincipal = {
    senderType: 'user', kind: 'union', unionId: 'on_source',
  };
  const lanePrincipal: HumanLanePrincipal = options.principal ?? {
    senderType: 'user', kind: 'union', unionId: 'on_lane_a',
  };
  const sourceLane: PrincipalLaneBinding = {
    version: 1,
    laneId: 'source',
    sourceSessionId: identity.sourceSessionId,
    principalKey: 'user:union:on_source',
    principal: sourcePrincipal,
    routingAnchor: 'principal-lane:source:routing-only',
    displayTarget,
    workspaceEpoch: 3,
    phase: 'active',
    revision: 4,
    createdAt: laneTimestamp,
    updatedAt: laneTimestamp,
  };
  const lanePrincipalKey = lanePrincipal.kind === 'union'
    ? `user:union:${lanePrincipal.unionId}`
    : `user:app:${lanePrincipal.larkAppId}:open:${lanePrincipal.openId}`;
  const lane: PrincipalLaneBinding = {
    version: 1,
    laneId: identity.laneId,
    sourceSessionId: identity.sourceSessionId,
    principalKey: lanePrincipalKey,
    principal: lanePrincipal,
    routingAnchor: `principal-lane:${identity.laneId}:routing-only`,
    displayTarget,
    workspaceEpoch: 3,
    phase: 'active',
    revision: 5,
    createdAt: laneTimestamp,
    updatedAt: laneTimestamp,
  };
  const sourceState: PrincipalLaneSourceState = {
    version: 1,
    sourcePrincipalKey: sourceLane.principalKey,
    displayTarget,
    canonicalCwd: '/workspace/repo',
    workspaceEpoch: 3,
    workspaceGroupId: principalWorkspaceGroupIdV2(identity.larkAppId, '/workspace/repo'),
    workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
    phase: 'active',
    revision: 6,
    updatedAt: laneTimestamp,
  };
  const plan: PrincipalLaneIngressPlan = {
    kind: 'route_lane',
    reason: 'existing_caller_lane',
    lane,
    displayTarget,
    fence: {
      callerPrincipalKey: lane.principalKey,
      sourceSessionId: identity.sourceSessionId,
      sourcePrincipalKey: sourceLane.principalKey,
      sourceRevision: sourceState.revision,
      sourceLaneRevision: sourceLane.revision,
      workspaceEpoch: sourceState.workspaceEpoch,
      canonicalCwd: sourceState.canonicalCwd,
      workspaceGroupId: sourceState.workspaceGroupId,
      workspaceGroupKeyVersion: sourceState.workspaceGroupKeyVersion,
      displayTarget,
      laneId: lane.laneId,
      laneRevision: lane.revision,
      lanePrincipalKey: lane.principalKey,
      routingAnchor: lane.routingAnchor,
      sessionId: identity.sessionId,
    },
  };
  const worktreeRoot = `/workspace/repo-wt-${identity.laneId}`;
  const worktree: PrincipalLaneWorktreeProof = {
    version: 1,
    materializationId: principalLaneWorktreeMaterializationId({
      sourceSessionId: identity.sourceSessionId,
      principalKey: lane.principalKey,
      workspaceEpoch: lane.workspaceEpoch,
      sourceCanonicalCwd: sourceState.canonicalCwd,
    }),
    sourceSessionId: identity.sourceSessionId,
    laneId: lane.laneId,
    sessionId: identity.sessionId,
    principalKey: lane.principalKey,
    workspaceEpoch: lane.workspaceEpoch,
    sourceCanonicalCwd: sourceState.canonicalCwd,
    sourceRepoRoot: sourceState.canonicalCwd,
    sourceGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    sourceRelativeCwd: '',
    worktreeRoot,
    worktreeGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    workingDir: worktreeRoot,
    branch: `wt/principal-lane-${identity.laneId}`,
    baseRef: 'HEAD',
    phase: 'ready',
    revision: 1,
    createdAt: laneTimestamp,
    updatedAt: laneTimestamp,
  };
  const authority: PrincipalLaneDispatchAuthority = {
    source: {
      sourceSessionId: identity.sourceSessionId,
      source: sourceState,
      lane: sourceLane,
    },
    lane: { lane, sessionId: identity.sessionId },
    session: {
      sessionId: identity.sessionId,
      chatId: displayTarget.chatId,
      rootMessageId: displayTarget.rootMessageId,
      scope: 'thread',
      title: 'Principal lane',
      status: 'active',
      createdAt: laneTimestamp,
      larkAppId: displayTarget.larkAppId,
      workingDir: worktree.workingDir,
      principalLane: lane,
      principalLaneWorktree: worktree,
    },
  };
  const dispatch = createPrincipalLaneDispatchContext(plan, authority);
  if (dispatch.status !== 'ready') {
    throw new Error(`expected ready dispatch: ${JSON.stringify(dispatch)}`);
  }
  return { ...identity, identity, plan, authority, capability: dispatch.capability };
}

function openLane(options: LaneFixtureOptions = {}) {
  const fixture = laneFixture(options);
  const opened = openPrincipalLaneQueue(fixture.capability, fixture.authority);
  if (opened.status !== 'ready') throw new Error(`expected ready queue: ${opened.reason}`);
  return { ...fixture, handle: opened.value };
}

describe('principal lane queue handles', () => {
  it('isolates messages and offsets for lanes sharing one visible surface', () => {
    const laneA = openLane({ laneId: 'lane-a', sessionId: 'session-a' });
    const laneB = openLane({ laneId: 'lane-b', sessionId: 'session-b' });
    expect(laneA.handle.namespace).not.toBe(laneB.handle.namespace);

    expect(appendPrincipalLaneMessage(
      laneA.handle, laneA.authority, makeMessage('a1', 'alpha'),
    ).status).toBe('ready');
    expect(appendPrincipalLaneMessage(
      laneB.handle, laneB.authority, makeMessage('b1', 'beta'),
    ).status).toBe('ready');
    expect(readPrincipalLaneUnread(laneA.handle, laneA.authority)).toMatchObject({
      status: 'ready', value: [{ messageId: 'a1', content: 'alpha' }],
    });
    expect(getPrincipalLaneQueueOffset(laneA.handle, laneA.authority))
      .toMatchObject({ status: 'ready' });
    expect(getPrincipalLaneQueueOffset(laneB.handle, laneB.authority))
      .toEqual({ status: 'ready', value: 0 });
    expect(readPrincipalLaneUnread(laneB.handle, laneB.authority)).toMatchObject({
      status: 'ready', value: [{ messageId: 'b1', content: 'beta' }],
    });
    expect(rewindPrincipalLaneQueue(laneA.handle, laneA.authority))
      .toEqual({ status: 'ready', value: undefined });
    expect(readPrincipalLaneUnread(laneA.handle, laneA.authority)).toMatchObject({
      status: 'ready', value: [{ messageId: 'a1' }],
    });
    expect(readPrincipalLaneUnread(laneB.handle, laneB.authority))
      .toEqual({ status: 'ready', value: [] });
  });

  it('uses a stable namespace without human identity evidence', () => {
    const beforeUpgrade = openLane({
      principal: {
        senderType: 'user', kind: 'app_open', larkAppId: 'cli_lane_app', openId: 'ou_lane_a',
      },
    });
    const afterUpgrade = openLane({
      principal: { senderType: 'user', kind: 'union', unionId: 'on_lane_a' },
    });
    expect(afterUpgrade.handle.namespace).toBe(beforeUpgrade.handle.namespace);
    const manifest = JSON.parse(files[Object.keys(files).find(path => path.endsWith('/manifest.json'))!]);
    expect(manifest).toEqual({
      namespaceVersion: 1,
      larkAppId: 'cli_lane_app',
      sourceSessionId: 'source-session',
      laneId: 'lane-a',
      sessionId: 'session-a',
    });
    expect(JSON.stringify(manifest)).not.toContain('openId');
    expect(JSON.stringify(manifest)).not.toContain('unionId');
  });

  it.each([
    ['app', { larkAppId: 'cli_other' }],
    ['source', { sourceSessionId: 'source-other' }],
    ['lane', { laneId: 'lane-other' }],
    ['session', { sessionId: 'session-other' }],
  ])('changes namespace across %s authority', (_label, override) => {
    const base = openLane();
    const changed = openLane(override);
    expect(changed.handle.namespace).not.toBe(base.handle.namespace);
  });

  it('hashes malicious identity text instead of using it as a path', () => {
    const lane = openLane({
      sourceSessionId: '../../../../escape',
      laneId: '../lane',
      sessionId: '..\\session',
    });
    expect(appendPrincipalLaneMessage(
      lane.handle, lane.authority, makeMessage('safe'),
    ).status).toBe('ready');
    for (const path of Object.keys(files)) {
      expect(path).toMatch(/^\/tmp\/test-mq\/queues\/principal-lanes\/v1\/plq_v1_[a-f0-9]{64}\//);
      expect(path).not.toContain('escape');
      expect(path).not.toContain('..\\session');
    }
  });

  it('fails closed on manifest replacement before reading queue data', () => {
    const lane = openLane();
    expect(appendPrincipalLaneMessage(
      lane.handle, lane.authority, makeMessage('secret'),
    ).status).toBe('ready');
    const manifestPath = Object.keys(files).find(path => path.endsWith('/manifest.json'))!;
    files[manifestPath] = `${JSON.stringify({
      namespaceVersion: 1,
      ...lane.identity,
      sessionId: 'attacker-session',
    })}\n`;
    readPaths = [];

    expect(readPrincipalLaneUnread(lane.handle, lane.authority)).toEqual({
      status: 'quarantined', reason: 'manifest_identity_mismatch',
    });
    expect(readPaths).toEqual([manifestPath]);
    expect(openPrincipalLaneQueue(lane.capability, lane.authority)).toEqual({
      status: 'quarantined', reason: 'manifest_identity_mismatch',
    });
  });

  it('rejects a hand-built capability before creating queue files', () => {
    const lane = laneFixture();
    expect(openPrincipalLaneQueue(
      { version: 1 } as PrincipalLaneDispatchCapability,
      lane.authority,
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });
    expect(Object.keys(files)).toEqual([]);
  });

  it('rejects a stale capability at the queue operation boundary', () => {
    const lane = openLane();
    const staleAuthority: PrincipalLaneDispatchAuthority = {
      ...lane.authority,
      source: {
        ...lane.authority.source,
        source: {
          ...lane.authority.source.source,
          revision: lane.authority.source.source.revision + 1,
        },
      },
    };
    readPaths = [];
    expect(appendPrincipalLaneMessage(
      lane.handle, staleAuthority, makeMessage('must-not-write'),
    )).toEqual({ status: 'retry', reason: 'stale_authority' });
    expect(readPaths).toEqual([]);
    expect(Object.keys(files).some(path => path.endsWith('/messages.jsonl'))).toBe(false);
  });
});
