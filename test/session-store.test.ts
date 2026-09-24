/**
 * Unit tests for services/session-store.
 *
 * Uses a real temp directory for each test to exercise the actual
 * file-based persistence without mocking fs.
 *
 * Run:  pnpm vitest run test/session-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

// ─── Mocks ────────────────────────────────────────────────────────────────

const fsControl = vi.hoisted(() => ({ failSessionWrite: false, failReaddir: false }));
const costCalculatorMock = vi.hoisted(() => ({
  getSessionTokenUsage: vi.fn(() => null),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failSessionWrite && String(args[0]).includes('sessions.json.')) {
        throw new Error('simulated session repair write failure');
      }
      return actual.writeFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      // Simulates the CLI file sandbox: per-bot files readable, data dir
      // enumeration denied (EPERM-like failure).
      if (fsControl.failReaddir) throw new Error('simulated readdir denial');
      return actual.readdirSync(...args);
    },
  };
});

// Mock config so we can point session.dataDir at a temp directory
let tempDir: string;
let testWorktreeDirs = new Set<string>();

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

// Mock logger to suppress output
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock frozen-card-store (deleteFrozenCards is called on close)
const mockDeleteFrozenCards = vi.fn();
vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: (...args: any[]) => mockDeleteFrozenCards(...args),
}));

vi.mock('../src/core/cost-calculator.js', () => costCalculatorMock);

// Import the module under test after mocks are set up
import {
  __testOnly_setBeforeRowPersist,
  __testOnly_setBeforePrincipalLaneCreateTransaction,
  __testOnly_setBeforePrincipalLaneWorktreeCommit,
  __testOnly_setAfterPrincipalLaneWorktreeCommit,
  __testOnly_setAfterPrincipalWorkspaceReadFence,
  __testOnly_setBeforePrincipalWorkspaceReadQuarantine,
  init,
  createSession,
  createSessionWithOwnedMutation,
  getSession,
  getOwnedSession,
  listSessions,
  listSessionsStrict,
  SessionStoreBusyError,
  SessionStoreUnavailableError,
  beginMojoCloseJournal,
  markMojoClosePrepared,
  finishMojoCloseAbort,
  closeSession,
  reactivateClosedSession,
  updateSession,
  updateSessionPid,
  persistActiveRemoteLineageExact,
  persistActiveRemoteLineagesExactBatch,
  findActiveSessionsByRoot,
  findActiveSessionsByWorkingDirStrict,
  repairMissingChatScope,
  loadAllSessionsSnapshot,
  applySessionCommandUnowned,
  mutateOwnedSessionsAtomically,
  readSessionRowUnowned,
  readSessionRowFromDisk,
  readSessionRowCopiesAcrossStores,
  ensurePrincipalLaneSource,
  bootstrapPrincipalLaneSourceForIngress,
  ensurePrincipalWorkspaceMembershipV2,
  ensureShadowPrincipalLane,
  hydratePrincipalLaneForIngress,
  retirePrincipalLane,
  prepareShadowPrincipalLaneForIngress,
  readPrincipalLaneSource,
  readPrincipalWorkspaceMembershipV2,
  beginMessageProvenanceTrustAttempt,
  completeMessageProvenanceTrustAttempt,
  abortMessageProvenanceTrustAttempt,
  __testOnly_setAfterProvenanceDenyFence,
  markMessageProvenanceUntrusted,
  recordMessageProvenance,
  readTrustedMessageProvenance,
} from '../src/services/session-store.js';
import { settlePrincipalLaneOutboundProvenance } from '../src/core/principal-lane-outbound-provenance.js';
import { seedPersistedSessionRows, readPersistedSessionRows, sessionStorePath } from './helpers/session-store-disk.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { spawnSyncTsEvalWithRepoImports, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  clearCodexInstanceBots,
  legacyCodexInstanceBinding,
  registerCodexInstanceBot,
} from '../src/services/codex-instance-pool.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  legacyPrincipalWorkspaceGroupId,
  principalWorkspaceGroupIdV2,
} from '../src/core/principal-workspace-admission.js';
import {
  __testOnly_setBeforePrincipalLaneGitIdentity,
  principalLaneWorktreeMaterializationId,
  type PrincipalLaneWorktreeMaterialization,
} from '../src/core/principal-lane-worktree.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

// db-else-json 读盘夹具：引擎替换后，daemon store 的持久化状态落在 sessions*.db
// （既有 JSON 冻结不再更新）；混合窗口场景仍可能只有 .json。读断言统一走这里。
import { DatabaseSync } from 'node:sqlite';

function persistedStorePath(dir: string, appId?: string): string | undefined {
  const dbPath = appId ? join(dir, 'session-stores', appId, 'sessions.db') : join(dir, 'sessions.db');
  if (existsSync(dbPath)) return dbPath;
  const jsonPath = join(dir, appId ? `sessions-${appId}.json` : 'sessions.json');
  return existsSync(jsonPath) ? jsonPath : undefined;
}

function persistedStoreExists(dir: string, appId?: string): boolean {
  return persistedStorePath(dir, appId) !== undefined;
}

function readPersistedRows(dir: string, appId?: string): Record<string, any> {
  const path = persistedStorePath(dir, appId);
  if (!path) throw new Error(`no persisted session store in ${dir} (appId=${appId ?? 'legacy'})`);
  if (path.endsWith('.db')) {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
      return Object.fromEntries(rows.map(r => [r.session_id, JSON.parse(r.row)]));
    } finally {
      db.close();
    }
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = makeTempDir();
  testWorktreeDirs = new Set();
  fsControl.failSessionWrite = false;
  fsControl.failReaddir = false;
  costCalculatorMock.getSessionTokenUsage.mockReset();
  costCalculatorMock.getSessionTokenUsage.mockReturnValue(null);
  __testOnly_setBeforeRowPersist(undefined);
  __testOnly_setBeforePrincipalLaneCreateTransaction(undefined);
  __testOnly_setBeforePrincipalLaneWorktreeCommit(undefined);
  __testOnly_setAfterPrincipalLaneWorktreeCommit(undefined);
  __testOnly_setAfterPrincipalWorkspaceReadFence(undefined);
  __testOnly_setBeforePrincipalWorkspaceReadQuarantine(undefined);
  __testOnly_setBeforePrincipalLaneGitIdentity(undefined);
  clearCodexInstanceBots();
  mockDeleteFrozenCards.mockReset();
  // Reset module state for each test
  init();
});

afterEach(() => {
  for (const dir of testWorktreeDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('principal lane durable store', () => {
  const appId = 'app-principal-lanes';
  const now = '2026-09-19T08:00:00.000Z';

  function sourceSession(root: string, unionId: string, openId: string) {
    init(appId);
    const session = createSession(`chat-${root}`, root, `source-${root}`, 'group', 'thread');
    session.larkAppId = appId;
    session.ownerUnionId = unionId;
    session.ownerOpenId = openId;
    session.workingDir = tempDir;
    updateSession(session);
    return session;
  }

  function initializeSourceGitRepository(): void {
    if (existsSync(join(tempDir, '.git'))) return;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['init', '-b', 'master'], { cwd: tempDir, env: gitEnv });
    writeFileSync(join(tempDir, '.principal-lane-fixture'), 'fixture\n');
    execFileSync('git', ['add', '.principal-lane-fixture'], { cwd: tempDir, env: gitEnv });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: tempDir, env: gitEnv });
  }

  function worktreeMaterialization(args: {
    sourceSessionId: string;
    principalKey?: string;
    workspaceEpoch?: number;
    suffix?: string;
    createdAt?: string;
  }): PrincipalLaneWorktreeMaterialization {
    const sourceCanonicalCwd = realpathSync(tempDir);
    const principalKey = args.principalKey ?? 'user:union:on_b';
    const workspaceEpoch = args.workspaceEpoch ?? 1;
    const suffix = args.suffix ?? 'b';
    const worktreeRoot = `${sourceCanonicalCwd}-wt-${suffix}`;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    initializeSourceGitRepository();
    const branch = `wt/principal-lane-${suffix}`;
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD'], {
      cwd: sourceCanonicalCwd,
      env: gitEnv,
    });
    const commonDir = realpathSync(resolve(
      sourceCanonicalCwd,
      execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: sourceCanonicalCwd, encoding: 'utf8', env: gitEnv,
      }).trim(),
    ));
    testWorktreeDirs.add(worktreeRoot);
    return {
      version: 1,
      materializationId: principalLaneWorktreeMaterializationId({
        sourceSessionId: args.sourceSessionId,
        principalKey,
        workspaceEpoch,
        sourceCanonicalCwd,
      }),
      sourceSessionId: args.sourceSessionId,
      principalKey,
      workspaceEpoch,
      sourceCanonicalCwd,
      sourceRepoRoot: sourceCanonicalCwd,
      sourceGitCommonDir: commonDir,
      sourceRelativeCwd: '',
      worktreeRoot: realpathSync(worktreeRoot),
      worktreeGitCommonDir: commonDir,
      workingDir: realpathSync(worktreeRoot),
      branch,
      baseRef: 'HEAD',
      createdAt: args.createdAt ?? '2026-09-19T08:00:30.000Z',
    };
  }

  function downgradeWorkspaceMembershipToLegacyV1(sourceSessionId: string) {
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const sessionHit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(sourceSessionId) as { row: string };
      const sessionRow = JSON.parse(sessionHit.row);
      const sourceHit = db.prepare(
        'SELECT row FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(sourceSessionId) as { row: string };
      const sourceRow = JSON.parse(sourceHit.row);
      sourceRow.workspaceGroupId = legacyPrincipalWorkspaceGroupId(
        sourceSessionId, sourceRow.canonicalCwd, sourceRow.workspaceEpoch,
      );
      delete sourceRow.workspaceGroupKeyVersion;
      sessionRow.principalLaneSource = sourceRow;
      db.prepare(
        'UPDATE principal_lane_sources SET workspace_group_id = ?, row = ? '
        + 'WHERE source_session_id = ?',
      ).run(sourceRow.workspaceGroupId, JSON.stringify(sourceRow), sourceSessionId);
      db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
        .run(JSON.stringify(sessionRow), sourceSessionId);
      db.prepare('DELETE FROM principal_workspace_members WHERE source_session_id = ?')
        .run(sourceSessionId);
      db.prepare('DELETE FROM principal_workspace_groups').run();
      return sourceRow;
    } finally { db.close(); }
  }

  it('atomically binds a proven owner as source lane 0 and restores it idempotently', () => {
    const session = sourceSession('root-a', 'on_a', 'ou_a');
    const first = ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_a' },
      now,
    });
    expect(first).toMatchObject({
      status: 'ready',
      source: {
        sourcePrincipalKey: 'user:union:on_a',
        workspaceEpoch: 1,
        phase: 'active',
        displayTarget: {
          scope: 'thread', larkAppId: appId, chatId: 'chat-root-a', rootMessageId: 'root-a',
        },
      },
      lane: { laneId: 'source', sourceSessionId: session.sessionId },
    });
    expect(getOwnedSession(session.sessionId)).toMatchObject({
      principalLane: { laneId: 'source' },
      principalLaneSource: { sourcePrincipalKey: 'user:union:on_a' },
    });

    init(appId);
    expect(readPrincipalLaneSource(session.sessionId)).toMatchObject({
      status: 'ready', lane: { laneId: 'source' },
    });
    expect(ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_b' },
      now,
    })).toMatchObject({ status: 'ready' });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_sources').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_migration_audit').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members').get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('migrates all legacy source lanes to one v2 group and makes only a fresh fence idempotent', () => {
    const source = sourceSession('root-workspace-migrate', 'on_source', 'ou_source');
    const sourceReady = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (sourceReady.status !== 'ready') throw new Error('expected ready source');
    const shadow = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (shadow.status !== 'ready') throw new Error('expected ready shadow');
    const legacy = downgradeWorkspaceMembershipToLegacyV1(source.sessionId);
    init(appId);

    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_c', openId: 'ou_c' },
      now: '2026-09-19T08:01:30.000Z',
    })).toEqual({ status: 'retry', reason: 'workspace_migration_required' });

    const oldFence = {
      sourcePrincipalKey: legacy.sourcePrincipalKey,
      sourceRevision: legacy.revision,
      sourceLaneRevision: sourceReady.lane.revision,
      workspaceEpoch: legacy.workspaceEpoch,
      canonicalCwd: legacy.canonicalCwd,
      workspaceGroupId: legacy.workspaceGroupId,
      workspaceGroupKeyVersion: undefined,
      displayTarget: legacy.displayTarget,
    };
    const migrated = ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: oldFence,
      now: '2026-09-19T08:02:00.000Z',
    });
    expect(migrated).toMatchObject({
      status: 'ready', migrated: true,
      source: { workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION },
      members: [{ laneId: shadow.lane.laneId }, { laneId: 'source' }],
    });
    if (migrated.status !== 'ready') throw new Error('expected migrated workspace');

    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: oldFence,
      now: '2026-09-19T08:03:00.000Z',
    })).toEqual({ status: 'retry', reason: 'stale_authority' });

    const freshFence = {
      ...oldFence,
      sourceRevision: migrated.source.revision,
      workspaceGroupId: migrated.source.workspaceGroupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION as const,
    };
    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: freshFence,
      now: '2026-09-19T08:04:00.000Z',
    })).toMatchObject({ status: 'ready', migrated: false, members: [{}, {}] });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members').get() as { n: number }).n).toBe(2);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'migrated'",
      ).get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('reads a complete v2 membership without writing and separates missing, stale, and busy', () => {
    const source = sourceSession('root-workspace-read', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const shadow = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (shadow.status !== 'ready') throw new Error('expected ready shadow');
    const fence = {
      sourcePrincipalKey: ready.source.sourcePrincipalKey,
      sourceRevision: ready.source.revision,
      sourceLaneRevision: ready.lane.revision,
      workspaceEpoch: ready.source.workspaceEpoch,
      canonicalCwd: ready.source.canonicalCwd,
      workspaceGroupId: ready.source.workspaceGroupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION as const,
      displayTarget: ready.source.displayTarget,
    };
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const observer = new DatabaseSync(dbPath);
    let auditCount: number;
    auditCount = (observer.prepare(
      'SELECT COUNT(*) AS n FROM principal_workspace_migration_audit',
    ).get() as { n: number }).n;
    const dataVersion = (observer.prepare('PRAGMA data_version').get() as { data_version: number })
      .data_version;

    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, fence)).toMatchObject({
      status: 'ready',
      sourceLane: { laneId: 'source' },
      group: { phase: 'active' },
      lanes: [
        { lane: { laneId: shadow.lane.laneId }, member: { membershipPhase: 'active' } },
        { lane: { laneId: 'source' }, member: { membershipPhase: 'active' } },
      ],
    });
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, {
      ...fence, sourceRevision: fence.sourceRevision + 1,
    })).toEqual({ status: 'stale', reason: 'source_authority_changed' });
    expect((observer.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
      .toBe(dataVersion);
    observer.close();

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        'SELECT COUNT(*) AS n FROM principal_workspace_migration_audit',
      ).get() as { n: number }).n).toBe(auditCount);
      const groupHit = verify.prepare(
        'SELECT row FROM principal_workspace_groups WHERE group_id = ?',
      ).get(ready.source.workspaceGroupId) as { row: string };
      const group = JSON.parse(groupHit.row);
      group.phase = 'closing';
      group.updatedAt = '2026-09-19T08:02:00.000Z';
      verify.prepare(
        "UPDATE principal_workspace_groups SET phase = 'closing', row = ? WHERE group_id = ?",
      ).run(JSON.stringify(group), ready.source.workspaceGroupId);
    } finally { verify.close(); }
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, fence))
      .toEqual({ status: 'busy', reason: 'workspace_group_not_active' });

    const missing = new DatabaseSync(dbPath);
    try {
      missing.prepare('DELETE FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = ?')
        .run(source.sessionId, shadow.lane.laneId);
      const groupHit = missing.prepare(
        'SELECT row FROM principal_workspace_groups WHERE group_id = ?',
      ).get(ready.source.workspaceGroupId) as { row: string };
      const group = JSON.parse(groupHit.row);
      group.phase = 'active';
      group.updatedAt = '2026-09-19T08:03:00.000Z';
      missing.prepare(
        "UPDATE principal_workspace_groups SET phase = 'active', row = ? WHERE group_id = ?",
      ).run(JSON.stringify(group), ready.source.workspaceGroupId);
    } finally { missing.close(); }
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, fence))
      .toEqual({ status: 'missing', reason: 'workspace_member_missing' });
  });

  it('keeps one read snapshot when another process advances source authority after fence validation', () => {
    const source = sourceSession('root-workspace-read-snapshot', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const fence = {
      sourcePrincipalKey: ready.source.sourcePrincipalKey,
      sourceRevision: ready.source.revision,
      sourceLaneRevision: ready.lane.revision,
      workspaceEpoch: ready.source.workspaceEpoch,
      canonicalCwd: ready.source.canonicalCwd,
      workspaceGroupId: ready.source.workspaceGroupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION as const,
      displayTarget: ready.source.displayTarget,
    };
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    let invoked = false;
    __testOnly_setAfterPrincipalWorkspaceReadFence(() => {
      if (invoked) throw new Error('snapshot race hook invoked more than once');
      invoked = true;
      const child = spawnSyncTsEvalWithRepoImports(`
        import { openDatabaseSyncOrThrow } from './src/services/sqlite-compat.js';
        const db = openDatabaseSyncOrThrow(${JSON.stringify(dbPath)});
        db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        try {
          const sourceHit = db.prepare(
            'SELECT row FROM principal_lane_sources WHERE source_session_id = ?'
          ).get(${JSON.stringify(source.sessionId)});
          const sourceRow = JSON.parse(sourceHit.row);
          sourceRow.revision += 1;
          sourceRow.updatedAt = '2026-09-19T08:10:00.000Z';
          const sessionHit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
            .get(${JSON.stringify(source.sessionId)});
          const sessionRow = JSON.parse(sessionHit.row);
          sessionRow.principalLaneSource = sourceRow;
          db.prepare(
            'UPDATE principal_lane_sources SET revision = ?, row = ? WHERE source_session_id = ?'
          ).run(sourceRow.revision, JSON.stringify(sourceRow), ${JSON.stringify(source.sessionId)});
          db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
            .run(JSON.stringify(sessionRow), ${JSON.stringify(source.sessionId)});
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        } finally { db.close(); }
      `, { encoding: 'utf8', timeout: 20_000 });
      expect(child.status, String(child.stderr)).toBe(0);
    });

    const snapshot = readPrincipalWorkspaceMembershipV2(source.sessionId, fence);
    expect(invoked).toBe(true);
    expect(snapshot).toMatchObject({
      status: 'ready',
      source: { revision: fence.sourceRevision },
      sourceLane: { revision: fence.sourceLaneRevision },
      group: { groupId: fence.workspaceGroupId },
    });
    __testOnly_setAfterPrincipalWorkspaceReadFence(undefined);
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, fence))
      .toEqual({ status: 'stale', reason: 'source_authority_changed' });
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, {
      ...fence, sourceRevision: fence.sourceRevision + 1,
    })).toMatchObject({ status: 'ready', source: { revision: fence.sourceRevision + 1 } });
  });

  it('revalidates malformed read evidence before quarantine and preserves a concurrent phase advance', () => {
    const source = sourceSession('root-workspace-read-cas', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const corrupt = new DatabaseSync(dbPath);
    try {
      const hit = corrupt.prepare(
        "SELECT row FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(source.sessionId) as { row: string };
      const row = JSON.parse(hit.row);
      row.sessionId = 'session-corrupt';
      corrupt.prepare(
        "UPDATE principal_workspace_members SET row = ? WHERE source_session_id = ? AND lane_id = 'source'",
      ).run(JSON.stringify(row), source.sessionId);
    } finally { corrupt.close(); }

    __testOnly_setBeforePrincipalWorkspaceReadQuarantine(() => {
      const repair = new DatabaseSync(dbPath);
      try {
        const hit = repair.prepare(
          "SELECT session_id, row FROM principal_workspace_members "
          + "WHERE source_session_id = ? AND lane_id = 'source'",
        ).get(source.sessionId) as { session_id: string; row: string };
        const row = JSON.parse(hit.row);
        row.sessionId = hit.session_id;
        row.membershipPhase = 'closing';
        row.updatedAt = '2026-09-19T08:11:00.000Z';
        repair.prepare(
          "UPDATE principal_workspace_members SET membership_phase = 'closing', row = ? "
          + "WHERE source_session_id = ? AND lane_id = 'source'",
        ).run(JSON.stringify(row), source.sessionId);
      } finally { repair.close(); }
    });

    expect(readPrincipalWorkspaceMembershipV2(source.sessionId))
      .toEqual({ status: 'busy', reason: 'authority_changed_before_quarantine' });
    __testOnly_setBeforePrincipalWorkspaceReadQuarantine(undefined);
    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        "SELECT membership_phase FROM principal_workspace_members "
        + "WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(source.sessionId) as { membership_phase: string }).membership_phase).toBe('closing');
      expect((verify.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { verify.close(); }
  });

  it('quarantines both groups and writes one conflict audit when read finds an identity collision', () => {
    const source = sourceSession('root-workspace-read-collision', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const identityGroupId = 'principal-workspace:v2:read-identity-collision';
    const db = new DatabaseSync(dbPath);
    try {
      const current = db.prepare(
        'SELECT row FROM principal_workspace_groups WHERE group_id = ?',
      ).get(ready.source.workspaceGroupId) as { row: string };
      const moved = JSON.parse(current.row);
      moved.canonicalCwd = `${ready.source.canonicalCwd}-other`;
      moved.updatedAt = '2026-09-19T08:12:00.000Z';
      db.prepare(
        'UPDATE principal_workspace_groups SET canonical_cwd = ?, row = ? WHERE group_id = ?',
      ).run(moved.canonicalCwd, JSON.stringify(moved), ready.source.workspaceGroupId);
      const alias = {
        version: 1, groupId: identityGroupId, groupKeyVersion: 2, larkAppId: appId,
        canonicalCwd: ready.source.canonicalCwd, phase: 'active', revision: 1,
        lastLeaseGeneration: 0, createdAt: now, updatedAt: now,
      };
      db.prepare(
        'INSERT INTO principal_workspace_groups '
        + '(group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
        + 'last_lease_generation, row) VALUES (?, 2, ?, ?, ?, 1, 0, ?)',
      ).run(identityGroupId, appId, ready.source.canonicalCwd, 'active', JSON.stringify(alias));
    } finally { db.close(); }

    expect(readPrincipalWorkspaceMembershipV2(source.sessionId))
      .toEqual({ status: 'quarantined', target: 'group', reason: 'group:identity_collision' });
    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_groups WHERE phase = 'quarantined'",
      ).get() as { n: number }).n).toBe(2);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'conflict'",
      ).get() as { n: number }).n).toBe(1);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_members "
        + "WHERE source_session_id = ? AND membership_phase = 'active'",
      ).get(source.sessionId) as { n: number }).n).toBe(1);
      expect((verify.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { verify.close(); }
  });

  it('does not run legacy Codex binding migration on the first workspace read', () => {
    const source = sourceSession('root-workspace-cold-read', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const bot = {
      larkAppId: appId,
      cliId: 'codex',
      backendType: 'tmux',
      codexInstancePool: {
        enabled: true,
        defaultInstanceId: 'default',
        scope: 'ordinary-feishu',
        strategy: 'random',
        instances: [{ id: 'default', codexHome: join(tempDir, 'codex-home') }],
      },
    } as any;
    registerCodexInstanceBot(bot);
    const beforeDb = new DatabaseSync(dbPath);
    let before: string;
    try {
      before = (beforeDb.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(source.sessionId) as { row: string }).row;
    } finally { beforeDb.close(); }
    expect(legacyCodexInstanceBinding(JSON.parse(before), bot, tempDir)).toBeDefined();

    init(appId);
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId)).toMatchObject({ status: 'ready' });
    const afterDb = new DatabaseSync(dbPath);
    try {
      const after = (afterDb.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(source.sessionId) as { row: string }).row;
      expect(after).toBe(before);
      expect(JSON.parse(after).cliInstanceBinding).toBeUndefined();
    } finally { afterDb.close(); }
  });

  it('treats legal group and member lifecycle phases as busy without conflict or quarantine', () => {
    const source = sourceSession('root-workspace-phase', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const fence = {
      sourcePrincipalKey: ready.source.sourcePrincipalKey,
      sourceRevision: ready.source.revision,
      sourceLaneRevision: ready.lane.revision,
      workspaceEpoch: ready.source.workspaceEpoch,
      canonicalCwd: ready.source.canonicalCwd,
      workspaceGroupId: ready.source.workspaceGroupId,
      workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION as const,
      displayTarget: ready.source.displayTarget,
    };
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const groupHit = db.prepare('SELECT row FROM principal_workspace_groups WHERE group_id = ?')
        .get(ready.source.workspaceGroupId) as { row: string };
      const group = JSON.parse(groupHit.row);
      group.phase = 'closing';
      group.updatedAt = '2026-09-19T08:01:00.000Z';
      db.prepare("UPDATE principal_workspace_groups SET phase = 'closing', row = ? WHERE group_id = ?")
        .run(JSON.stringify(group), ready.source.workspaceGroupId);
    } finally { db.close(); }
    const secondSource = sourceSession('root-workspace-phase-second', 'on_second', 'ou_second');
    expect(ensurePrincipalLaneSource({
      sourceSessionId: secondSource.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_second' },
      now: '2026-09-19T08:01:30.000Z',
    })).toEqual({ status: 'retry', reason: 'workspace_migration_busy' });
    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: fence,
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'retry', reason: 'migration_busy' });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'retry', reason: 'workspace_migration_busy' });

    const closingCheck = new DatabaseSync(dbPath);
    try {
      expect((closingCheck.prepare(
        'SELECT phase FROM principal_workspace_groups WHERE group_id = ?',
      ).get(ready.source.workspaceGroupId) as { phase: string }).phase).toBe('closing');
      expect((closingCheck.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'conflict'",
      ).get() as { n: number }).n).toBe(0);
      expect((closingCheck.prepare(
        'SELECT COUNT(*) AS n FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(secondSource.sessionId) as { n: number }).n).toBe(0);
    } finally { closingCheck.close(); }

    const memberDb = new DatabaseSync(dbPath);
    try {
      const groupHit = memberDb.prepare('SELECT row FROM principal_workspace_groups WHERE group_id = ?')
        .get(ready.source.workspaceGroupId) as { row: string };
      const group = JSON.parse(groupHit.row);
      group.phase = 'active';
      group.updatedAt = '2026-09-19T08:03:00.000Z';
      memberDb.prepare("UPDATE principal_workspace_groups SET phase = 'active', row = ? WHERE group_id = ?")
        .run(JSON.stringify(group), ready.source.workspaceGroupId);
      const memberHit = memberDb.prepare(
        "SELECT row FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(source.sessionId) as { row: string };
      const member = JSON.parse(memberHit.row);
      member.membershipPhase = 'closed';
      member.updatedAt = '2026-09-19T08:03:00.000Z';
      memberDb.prepare(
        "UPDATE principal_workspace_members SET membership_phase = 'closed', row = ? "
        + "WHERE source_session_id = ? AND lane_id = 'source'",
      ).run(JSON.stringify(member), source.sessionId);
    } finally { memberDb.close(); }
    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: fence,
      now: '2026-09-19T08:04:00.000Z',
    })).toEqual({ status: 'retry', reason: 'migration_busy' });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:04:00.000Z',
    })).toEqual({ status: 'retry', reason: 'lane_not_active' });
    expect(readPrincipalWorkspaceMembershipV2(source.sessionId, fence))
      .toEqual({ status: 'busy', reason: 'workspace_member_not_active' });

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'conflict'",
      ).get() as { n: number }).n).toBe(0);
      expect((verify.prepare(
        "SELECT phase FROM principal_workspace_groups WHERE group_id = ?",
      ).get(ready.source.workspaceGroupId) as { phase: string }).phase).toBe('active');
      expect((verify.prepare(
        "SELECT membership_phase AS phase FROM principal_workspace_members "
        + "WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(source.sessionId) as { phase: string }).phase).toBe('closed');
    } finally { verify.close(); }
  });

  it('shares one v2 group across sources with the same canonical cwd', () => {
    const first = sourceSession('root-shared-group-a', 'on_a', 'ou_a');
    const second = sourceSession('root-shared-group-b', 'on_b', 'ou_b');
    const firstReady = ensurePrincipalLaneSource({
      sourceSessionId: first.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_a' },
      now,
    });
    const secondReady = ensurePrincipalLaneSource({
      sourceSessionId: second.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_b' },
      now: '2026-09-19T08:00:01.000Z',
    });
    if (firstReady.status !== 'ready' || secondReady.status !== 'ready') {
      throw new Error('expected ready sources');
    }
    expect(firstReady.source.workspaceGroupId).toBe(secondReady.source.workspaceGroupId);
    expect(firstReady.source.workspaceGroupKeyVersion).toBe(2);
    expect(secondReady.source.workspaceGroupKeyVersion).toBe(2);

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups')
        .get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(2);
    } finally { db.close(); }
  });

  it('rolls back new source sidecars, group, member and Session when membership creation fails', () => {
    const source = sourceSession('root-source-membership-rollback', 'on_source', 'ou_source');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_source_workspace_member BEFORE INSERT ON principal_workspace_members
        BEGIN SELECT RAISE(ABORT, 'synthetic source member failure'); END;
      `);
    } finally { db.close(); }
    expect(() => ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    })).toThrow('synthetic source member failure');

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lane_sources')
        .get() as { n: number }).n).toBe(0);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lanes')
        .get() as { n: number }).n).toBe(0);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups')
        .get() as { n: number }).n).toBe(0);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(0);
      const row = JSON.parse((verify.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(source.sessionId) as { row: string }).row);
      expect(row.principalLane).toBeUndefined();
      expect(row.principalLaneSource).toBeUndefined();
    } finally { verify.close(); }
  });

  it('validates legacy migration conflicts before business writes and persists only audit evidence', () => {
    const source = sourceSession('root-workspace-conflict', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const legacy = downgradeWorkspaceMembershipToLegacyV1(source.sessionId);
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const conflicting = {
        version: 1,
        sourceSessionId: source.sessionId,
        laneId: 'source',
        sessionId: source.sessionId,
        groupId: 'principal-workspace:v2:conflict',
        workspaceEpoch: legacy.workspaceEpoch,
        membershipPhase: 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        'INSERT INTO principal_workspace_members '
        + '(source_session_id, lane_id, session_id, group_id, workspace_epoch, '
        + 'membership_phase, revision, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        source.sessionId, 'source', source.sessionId, conflicting.groupId,
        legacy.workspaceEpoch, 'active', 1, JSON.stringify(conflicting),
      );
    } finally { db.close(); }
    init(appId);

    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: {
        sourcePrincipalKey: legacy.sourcePrincipalKey,
        sourceRevision: legacy.revision,
        sourceLaneRevision: ready.lane.revision,
        workspaceEpoch: legacy.workspaceEpoch,
        canonicalCwd: legacy.canonicalCwd,
        workspaceGroupId: legacy.workspaceGroupId,
        workspaceGroupKeyVersion: undefined,
        displayTarget: legacy.displayTarget,
      },
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'conflict', reason: 'membership_conflict' });

    const verify = new DatabaseSync(dbPath);
    try {
      const sourceRow = JSON.parse((verify.prepare(
        'SELECT row FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { row: string }).row);
      expect(sourceRow.workspaceGroupKeyVersion).toBeUndefined();
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups')
        .get() as { n: number }).n).toBe(0);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'conflict'",
      ).get() as { n: number }).n).toBe(1);
    } finally { verify.close(); }
  });

  it('quarantines both ambiguous groups while leaving source authority and members unchanged', () => {
    const source = sourceSession('root-workspace-group-collision', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const legacy = downgradeWorkspaceMembershipToLegacyV1(source.sessionId);
    const targetGroupId = principalWorkspaceGroupIdV2(appId, legacy.canonicalCwd);
    const identityGroupId = 'principal-workspace:v2:identity-index-conflict';
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    const insertGroup = db.prepare(
      'INSERT INTO principal_workspace_groups '
      + '(group_id, group_key_version, lark_app_id, canonical_cwd, phase, revision, '
      + 'last_lease_generation, row) VALUES (?, 2, ?, ?, ?, 1, 0, ?)',
    );
    try {
      insertGroup.run(
        targetGroupId, appId, `${legacy.canonicalCwd}-other`, 'active', JSON.stringify({
          version: 1, groupId: targetGroupId, groupKeyVersion: 2, larkAppId: appId,
          canonicalCwd: `${legacy.canonicalCwd}-other`, phase: 'active', revision: 1,
          lastLeaseGeneration: 0, createdAt: now, updatedAt: now,
        }),
      );
      insertGroup.run(
        identityGroupId, appId, legacy.canonicalCwd, 'active', JSON.stringify({
          version: 1, groupId: identityGroupId, groupKeyVersion: 2, larkAppId: appId,
          canonicalCwd: legacy.canonicalCwd, phase: 'active', revision: 1,
          lastLeaseGeneration: 0, createdAt: now, updatedAt: now,
        }),
      );
    } finally { db.close(); }
    init(appId);
    expect(ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: {
        sourcePrincipalKey: legacy.sourcePrincipalKey,
        sourceRevision: legacy.revision,
        sourceLaneRevision: ready.lane.revision,
        workspaceEpoch: legacy.workspaceEpoch,
        canonicalCwd: legacy.canonicalCwd,
        workspaceGroupId: legacy.workspaceGroupId,
        workspaceGroupKeyVersion: undefined,
        displayTarget: legacy.displayTarget,
      },
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'quarantined', reason: 'group:identity_collision' });

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_groups WHERE phase = 'quarantined'",
      ).get() as { n: number }).n).toBe(2);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'conflict'",
      ).get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(0);
      const sourceRow = JSON.parse((verify.prepare(
        'SELECT row FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { row: string }).row);
      const sessionRow = JSON.parse((verify.prepare(
        'SELECT row FROM sessions WHERE session_id = ?',
      ).get(source.sessionId) as { row: string }).row);
      expect(sourceRow.workspaceGroupId).toBe(legacy.workspaceGroupId);
      expect(sourceRow.workspaceGroupKeyVersion).toBeUndefined();
      expect(sessionRow.principalLaneSource).toEqual(sourceRow);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lanes')
        .get() as { n: number }).n).toBe(1);
    } finally { verify.close(); }
  });

  it('rolls back group, members and source migration together on a member write failure', () => {
    const source = sourceSession('root-workspace-rollback', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const legacy = downgradeWorkspaceMembershipToLegacyV1(source.sessionId);
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_workspace_member BEFORE INSERT ON principal_workspace_members
        BEGIN SELECT RAISE(ABORT, 'synthetic member failure'); END;
      `);
    } finally { db.close(); }
    init(appId);
    expect(() => ensurePrincipalWorkspaceMembershipV2({
      sourceSessionId: source.sessionId,
      expectedSource: {
        sourcePrincipalKey: legacy.sourcePrincipalKey,
        sourceRevision: legacy.revision,
        sourceLaneRevision: ready.lane.revision,
        workspaceEpoch: legacy.workspaceEpoch,
        canonicalCwd: legacy.canonicalCwd,
        workspaceGroupId: legacy.workspaceGroupId,
        workspaceGroupKeyVersion: undefined,
        displayTarget: legacy.displayTarget,
      },
      now: '2026-09-19T08:02:00.000Z',
    })).toThrow('synthetic member failure');

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups')
        .get() as { n: number }).n).toBe(0);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(0);
      const row = JSON.parse((verify.prepare(
        'SELECT row FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { row: string }).row);
      expect(row.workspaceGroupKeyVersion).toBeUndefined();
    } finally { verify.close(); }
  });

  it('serializes two-process workspace migration so exactly one old-fence caller wins', async () => {
    const source = sourceSession('root-workspace-migration-race', 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source');
    const shadow = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (shadow.status !== 'ready') throw new Error('expected ready shadow');
    const legacy = downgradeWorkspaceMembershipToLegacyV1(source.sessionId);
    const oldFence = {
      sourcePrincipalKey: legacy.sourcePrincipalKey,
      sourceRevision: legacy.revision,
      sourceLaneRevision: ready.lane.revision,
      workspaceEpoch: legacy.workspaceEpoch,
      canonicalCwd: legacy.canonicalCwd,
      workspaceGroupId: legacy.workspaceGroupId,
      displayTarget: legacy.displayTarget,
    };
    init();
    const code = `
      import { init, ensurePrincipalWorkspaceMembershipV2 } from './src/services/session-store.js';
      init(${JSON.stringify(appId)});
      const result = ensurePrincipalWorkspaceMembershipV2({
        sourceSessionId: ${JSON.stringify(source.sessionId)},
        expectedSource: { ...${JSON.stringify(oldFence)}, workspaceGroupKeyVersion: undefined },
        now: '2026-09-19T08:02:00.000Z',
      });
      console.log('MIGRATION_RESULT=' + JSON.stringify(result));
    `;
    const runMigrator = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(code, {
        env: { ...process.env, SESSION_DATA_DIR: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ code: exitCode, output }));
    });
    const outcomes = await Promise.all([runMigrator(), runMigrator()]);
    for (const outcome of outcomes) {
      expect(outcome.code, outcome.output).toBe(0);
      expect(outcome.output).toContain('MIGRATION_RESULT=');
    }
    const results = outcomes.map(outcome => JSON.parse(
      outcome.output.split('MIGRATION_RESULT=')[1]!.trim().split('\n')[0]!,
    ));
    expect(results.filter(result => result.status === 'ready' && result.migrated).length).toBe(1);
    expect(results.filter(result => result.status === 'retry'
      && result.reason === 'stale_authority').length).toBe(1);

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_groups')
        .get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(2);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM principal_workspace_migration_audit WHERE event = 'migrated'",
      ).get() as { n: number }).n).toBe(1);
      expect((db.prepare(
        'SELECT COUNT(DISTINCT lane_id) AS n FROM principal_workspace_members',
      ).get() as { n: number }).n).toBe(2);
    } finally { db.close(); }
  });

  it('durably disables only principal lanes when the legacy owner is unproven', () => {
    const session = sourceSession('root-disabled', 'on_a', 'ou_a');
    expect(ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_b' },
      now,
    })).toEqual({ status: 'disabled', reason: 'caller_identity_unproven' });
    expect(getOwnedSession(session.sessionId)).toMatchObject({
      status: 'active',
      principalLaneDisabledReason: 'caller_identity_unproven',
    });
    expect(getOwnedSession(session.sessionId)?.principalLane).toBeUndefined();

    // No later first-speaker retry can silently replace the durable decision.
    expect(ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_a' },
      now,
    })).toEqual({ status: 'disabled', reason: 'caller_identity_unproven' });
  });

  it('does not let a B first message consume source bootstrap or fall back to A', () => {
    const session = sourceSession('root-bootstrap-owner', 'on_a', 'ou_a');
    expect(bootstrapPrincipalLaneSourceForIngress({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_b' },
      now,
    })).toEqual({ status: 'retry', reason: 'source_owner_mismatch' });
    expect(getOwnedSession(session.sessionId)?.principalLaneDisabledReason).toBeUndefined();
    expect(readPrincipalLaneSource(session.sessionId)).toBeUndefined();

    expect(bootstrapPrincipalLaneSourceForIngress({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_a' },
      now,
    })).toMatchObject({ status: 'ready', lane: { laneId: 'source' } });
  });

  it('never lets a bot inbound disable or initialize a human source lane', () => {
    const session = sourceSession('root-bot', 'on_a', 'ou_a');
    expect(() => ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'bot', kind: 'union', unionId: 'on_bot' },
      now,
    })).toThrow('bot principal cannot initialize');
    expect(getOwnedSession(session.sessionId)?.principalLaneDisabledReason).toBeUndefined();
    expect(readPrincipalLaneSource(session.sessionId)).toBeUndefined();
  });

  it('durably quarantines malformed source scope without closing the legacy session', () => {
    const session = sourceSession('root-scope', 'on_scope', 'ou_scope');
    session.scope = 'invalid' as any;
    updateSession(session);
    init(appId);
    expect(readPrincipalLaneSource(session.sessionId)).toEqual({
      status: 'quarantined', reason: 'invalid_source_display_target',
    });
    expect(getOwnedSession(session.sessionId)).toMatchObject({
      status: 'active',
      principalLaneQuarantineReason: 'invalid_source_display_target',
    });

    init(appId);
    expect(ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_scope' },
      now,
    })).toEqual({
      status: 'quarantined', reason: 'invalid_source_display_target',
    });
  });

  it('quarantines one malformed lane while another source remains restorable', () => {
    const first = sourceSession('root-q1', 'on_q1', 'ou_q1');
    const second = sourceSession('root-q2', 'on_q2', 'ou_q2');
    expect(ensurePrincipalLaneSource({
      sourceSessionId: first.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_q1' },
      now,
    }).status).toBe('ready');
    expect(ensurePrincipalLaneSource({
      sourceSessionId: second.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_q2' },
      now,
    }).status).toBe('ready');

    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const hit = db.prepare(
        "SELECT row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(first.sessionId) as { row: string };
      const malformed = JSON.parse(hit.row);
      delete malformed.principal;
      db.prepare(
        "UPDATE principal_lanes SET row = ? WHERE source_session_id = ? AND lane_id = 'source'",
      ).run(JSON.stringify(malformed), first.sessionId);
    } finally { db.close(); }

    expect(readPrincipalLaneSource(first.sessionId)).toEqual({
      status: 'quarantined', reason: 'lane:invalid_principal',
    });
    expect(readPrincipalLaneSource(first.sessionId)).toEqual({
      status: 'quarantined', reason: 'lane:stored_quarantine',
    });
    expect(readPrincipalLaneSource(second.sessionId)).toMatchObject({ status: 'ready' });

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        "SELECT phase FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(first.sessionId) as { phase: string }).phase).toBe('quarantined');
      expect((verify.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(first.sessionId) as { phase: string }).phase).toBe('active');
      expect((verify.prepare(
        "SELECT phase FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(second.sessionId) as { phase: string }).phase).toBe('active');
    } finally { verify.close(); }
  });

  it('fails closed when indexed lane authority disagrees with the durable JSON', () => {
    const session = sourceSession('root-index', 'on_index', 'ou_index');
    expect(ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_index' },
      now,
    }).status).toBe('ready');

    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "UPDATE principal_lanes SET principal_key = ? WHERE source_session_id = ? AND lane_id = 'source'",
      ).run('user:union:on_other', session.sessionId);
    } finally { db.close(); }

    expect(readPrincipalLaneSource(session.sessionId)).toEqual({
      status: 'quarantined', reason: 'lane:indexed_value_mismatch',
    });
  });

  it('atomically creates an idempotent shadow lane from a strict runtime whitelist', () => {
    const source = sourceSession('root-shadow', 'on_source', 'ou_source');
    source.cliId = 'codex';
    source.backendType = 'tmux';
    source.model = 'gpt-5';
    source.reasoningEffort = 'high';
    source.sandbox = true;
    source.sandboxPaths = { readWrite: [tempDir], readOnly: ['/tmp/read-only'] };
    source.mojoIdentity = { controlPlane: 'host', endpoint: 'https://runtime.example' } as any;
    source.persistentBackendTarget = { type: 'tmux', name: 'source-pane' } as any;
    source.cliSessionId = 'must-not-copy';
    source.replyTargets = {
      turn: { senderOpenId: 'ou_source', updatedAt: now },
    };
    source.crossPrincipalInterruptions = [{
      id: 'xpi-source',
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      proposer: { openId: 'ou_source' },
      message: { turnId: 'turn-source', text: 'private source input' },
    } as any];
    source.adoptedFrom = { source: 'tmux', tmuxTarget: 'source-pane', cwd: tempDir };
    source.xpiSharedCwdAdmissionGroupId = 'source-runtime-group';
    (source as any).liveCardMessageId = 'card-source';
    (source as any).schedule = { id: 'schedule-source' };
    updateSession(source);
    expect(ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    }).status).toBe('ready');

    const first = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      title: 'B 独立任务',
      now: '2026-09-19T08:01:00.000Z',
    });
    expect(first).toMatchObject({
      status: 'ready',
      created: true,
      lane: {
        principalKey: 'user:union:on_b',
        sourceSessionId: source.sessionId,
        displayTarget: {
          larkAppId: appId,
          scope: 'thread',
          chatId: 'chat-root-shadow',
          rootMessageId: 'root-shadow',
        },
      },
      session: {
        ownerUnionId: 'on_b',
        ownerOpenId: 'ou_b',
        creatorOpenId: 'ou_b',
        lastCallerOpenId: 'ou_b',
        cliId: 'codex',
        backendType: 'tmux',
        model: 'gpt-5',
        reasoningEffort: 'high',
        sandbox: true,
        mojoIdentity: { controlPlane: 'host', endpoint: 'https://runtime.example' },
      },
    });
    if (first.status !== 'ready') throw new Error('expected ready shadow lane');
    expect(first.session.workingDir).toBe(realpathSync(tempDir));
    expect(first.lane.routingAnchor).toMatch(/^principal-lane:[a-f0-9]{32}$/);
    expect(first.lane.routingAnchor).not.toContain('on_b');
    expect(first.lane.routingAnchor).not.toContain('ou_b');
    expect(first.lane.routingAnchor).not.toBe(first.lane.displayTarget.rootMessageId);
    expect(first.session.cliSessionId).toBeUndefined();
    expect(first.session.replyTargets).toBeUndefined();
    expect(first.session.crossPrincipalInterruptions).toBeUndefined();
    expect(first.session.adoptedFrom).toBeUndefined();
    expect(first.session.persistentBackendTarget).toBeUndefined();
    expect(first.session.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect((first.session as any).liveCardMessageId).toBeUndefined();
    expect((first.session as any).schedule).toBeUndefined();

    const second = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      title: 'ignored on reuse',
      now: '2026-09-19T08:02:00.000Z',
    });
    expect(second).toMatchObject({
      status: 'ready', created: false,
      lane: { laneId: first.lane.laneId },
      session: { sessionId: first.session.sessionId },
    });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(2);
      expect((db.prepare(
        'SELECT COUNT(*) AS n FROM principal_lane_aliases WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, first.lane.laneId) as { n: number }).n).toBe(2);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM principal_lane_identity_audit WHERE event = 'created'",
      ).get() as { n: number }).n).toBe(1);
      expect((db.prepare(
        'SELECT COUNT(*) AS n FROM principal_workspace_members WHERE source_session_id = ?',
      ).get(source.sessionId) as { n: number }).n).toBe(2);
    } finally { db.close(); }
  });

  it('publishes one isolated worktree proof atomically and hydrates only that shadow cwd', async () => {
    const source = sourceSession('root-worktree', 'on_source', 'ou_source');
    const sourceReady = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (sourceReady.status !== 'ready') throw new Error('expected ready source');
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    expect(created).toMatchObject({
      status: 'ready', created: true,
      session: {
        workingDir: materialization.workingDir,
        principalLaneWorktree: {
          materializationId: materialization.materializationId,
          sourceCanonicalCwd: realpathSync(tempDir),
          worktreeRoot: materialization.worktreeRoot,
        },
      },
      worktree: { materializationId: materialization.materializationId },
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    expect(await hydratePrincipalLaneForIngress(
      source.sessionId, created.lane.laneId,
    )).toMatchObject({
      status: 'ready',
      runtimeRoutingAnchor: created.lane.routingAnchor,
      session: { sessionId: created.session.sessionId, workingDir: materialization.workingDir },
      worktree: { materializationId: materialization.materializationId },
    });
    expect(await hydratePrincipalLaneForIngress(source.sessionId, 'source')).toMatchObject({
      status: 'ready', lane: { laneId: 'source' }, session: { sessionId: source.sessionId },
    });

    const reused = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: { ...materialization, baseRef: materialization.branch },
      now: '2026-09-19T08:02:00.000Z',
    });
    expect(reused).toMatchObject({
      status: 'ready', created: false,
      lane: { laneId: created.lane.laneId },
      session: { sessionId: created.session.sessionId },
      worktree: { materializationId: materialization.materializationId, baseRef: 'HEAD' },
    });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_worktrees')
        .get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('retires only a closed shadow lane while preserving its closed session audit row', async () => {
    const source = sourceSession('root-retire-worktree', 'on_source', 'ou_source');
    const sourceReady = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (sourceReady.status !== 'ready') throw new Error('expected ready source');
    const materialization = worktreeMaterialization({
      sourceSessionId: source.sessionId,
      suffix: 'retire',
    });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready' || !created.worktree) {
      throw new Error('expected materialized lane');
    }
    const retireArgs = {
      sourceSessionId: source.sessionId,
      laneId: created.lane.laneId,
      sessionId: created.session.sessionId,
      materializationId: created.worktree.materializationId,
    };
    expect(retirePrincipalLane({ ...retireArgs, dryRun: true })).toEqual({ status: 'ready' });
    expect(retirePrincipalLane(retireArgs)).toEqual({
      status: 'retry', reason: 'session_not_closed',
    });

    closeSession(created.session.sessionId);
    expect(retirePrincipalLane(retireArgs)).toEqual({ status: 'retired' });
    expect(getOwnedSession(created.session.sessionId)).toMatchObject({ status: 'closed' });
    expect(await hydratePrincipalLaneForIngress(source.sessionId, created.lane.laneId)).toEqual({
      status: 'missing', reason: 'lane_missing',
    });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      for (const table of ['principal_lanes', 'principal_lane_aliases', 'principal_lane_worktrees', 'principal_workspace_members']) {
        expect((db.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE source_session_id = ? AND lane_id = ?`,
        ).get(source.sessionId, created.lane.laneId) as { n: number }).n).toBe(0);
      }
      expect((db.prepare(
        'SELECT status FROM sessions WHERE session_id = ?',
      ).get(created.session.sessionId) as { status: string }).status).toBe('closed');
    } finally { db.close(); }
  });

  it('refuses retirement when the materialization proof is tampered under the same id', () => {
    const source = sourceSession('root-retire-tampered-proof', 'on_source', 'ou_source');
    const sourceReady = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (sourceReady.status !== 'ready') throw new Error('expected ready source');
    const materialization = worktreeMaterialization({
      sourceSessionId: source.sessionId,
      suffix: 'retire-tampered',
    });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready' || !created.worktree) {
      throw new Error('expected materialized lane');
    }
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      const hit = db.prepare(
        'SELECT row FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(created.worktree.materializationId) as { row: string };
      const tampered = JSON.parse(hit.row) as Record<string, unknown>;
      tampered.branch = 'wt/tampered-under-same-materialization-id';
      db.prepare(
        'UPDATE principal_lane_worktrees SET row = ? WHERE materialization_id = ?',
      ).run(JSON.stringify(tampered), created.worktree.materializationId);
    } finally { db.close(); }

    closeSession(created.session.sessionId);
    expect(retirePrincipalLane({
      sourceSessionId: source.sessionId,
      laneId: created.lane.laneId,
      sessionId: created.session.sessionId,
      materializationId: created.worktree.materializationId,
    })).toEqual({ status: 'quarantined', reason: 'lane_retirement_authority_mismatch' });

    const verify = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((verify.prepare(
        'SELECT COUNT(*) AS n FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(created.worktree.materializationId) as { n: number }).n).toBe(1);
      expect((verify.prepare(
        'SELECT COUNT(*) AS n FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, created.lane.laneId) as { n: number }).n).toBe(1);
    } finally { verify.close(); }
  });

  it('keeps the event loop and another lane admission moving during a slow Git probe', async () => {
    const source = sourceSession('root-slow-git-probe', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    let releaseGit!: () => void;
    let reportEntered!: () => void;
    const gitGate = new Promise<void>(resolve => { releaseGit = resolve; });
    const gitEntered = new Promise<void>(resolve => { reportEntered = resolve; });
    __testOnly_setBeforePrincipalLaneGitIdentity(async () => {
      reportEntered();
      await gitGate;
    });
    const hydration = hydratePrincipalLaneForIngress(source.sessionId, created.lane.laneId);
    await gitEntered;
    let timerAdvanced = false;
    await new Promise<void>(resolveTimer => setTimeout(() => {
      timerAdvanced = true;
      resolveTimer();
    }, 0));
    const otherLane = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_c', openId: 'ou_c' },
      now: '2026-09-19T08:01:30.000Z',
    });
    expect(timerAdvanced).toBe(true);
    expect(otherLane).toMatchObject({ status: 'ready', created: true });
    releaseGit();
    try {
      expect(await hydration).toMatchObject({ status: 'ready' });
    } finally {
      __testOnly_setBeforePrincipalLaneGitIdentity(undefined);
    }
  });

  it('refuses on-demand hydration of a legacy shadow that still shares source cwd', async () => {
    const source = sourceSession('root-legacy-hydrate', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const legacy = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (legacy.status !== 'ready') throw new Error('expected legacy shadow');
    expect(await hydratePrincipalLaneForIngress(source.sessionId, legacy.lane.laneId)).toEqual({
      status: 'retry', reason: 'worktree_not_materialized',
    });
  });

  it('migrates the parent worktree schema without guessing proof for old rows', async () => {
    const source = sourceSession('root-old-worktree-schema', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const ordinary = createSession('chat-ordinary', 'root-ordinary', 'ordinary-session');
    ordinary.larkAppId = appId;
    updateSession(ordinary);
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    init();
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const old = new DatabaseSync(dbPath);
    try {
      const proofHit = old.prepare(
        'SELECT row FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId) as { row: string };
      const oldProof = JSON.parse(proofHit.row);
      delete oldProof.sourceGitCommonDir;
      delete oldProof.worktreeGitCommonDir;
      old.prepare('UPDATE principal_lane_worktrees SET row = ? WHERE materialization_id = ?')
        .run(JSON.stringify(oldProof), materialization.materializationId);
      const childHit = old.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(created.session.sessionId) as { row: string };
      const oldChild = JSON.parse(childHit.row);
      delete oldChild.principalLaneWorktree.sourceGitCommonDir;
      delete oldChild.principalLaneWorktree.worktreeGitCommonDir;
      old.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
        .run(JSON.stringify(oldChild), created.session.sessionId);
      old.exec(`
        ALTER TABLE principal_lane_worktrees RENAME TO principal_lane_worktrees_newer;
        CREATE TABLE principal_lane_worktrees (
          materialization_id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          lane_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          principal_key TEXT NOT NULL,
          workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch >= 1),
          source_repo_root TEXT NOT NULL,
          worktree_root TEXT NOT NULL UNIQUE,
          working_dir TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('ready', 'quarantined')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          row TEXT NOT NULL,
          UNIQUE(source_session_id, lane_id),
          UNIQUE(source_session_id, principal_key)
        );
        INSERT INTO principal_lane_worktrees (
          materialization_id, source_session_id, lane_id, session_id, principal_key,
          workspace_epoch, source_repo_root, worktree_root, working_dir, branch,
          phase, revision, row
        ) SELECT
          materialization_id, source_session_id, lane_id, session_id, principal_key,
          workspace_epoch, source_repo_root, worktree_root, working_dir, branch,
          phase, revision, row
        FROM principal_lane_worktrees_newer;
        DROP TABLE principal_lane_worktrees_newer;
      `);
    } finally { old.close(); }

    init(appId);
    expect(getSession(ordinary.sessionId)).toMatchObject({ sessionId: ordinary.sessionId });
    const migrated = new DatabaseSync(dbPath);
    try {
      const columns = migrated.prepare('PRAGMA table_info(principal_lane_worktrees)')
        .all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
        'source_git_common_dir', 'worktree_git_common_dir',
      ]));
      expect(migrated.prepare(
        'SELECT source_git_common_dir, worktree_git_common_dir '
        + 'FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId)).toMatchObject({
        source_git_common_dir: null,
        worktree_git_common_dir: null,
      });
    } finally { migrated.close(); }
    expect(await hydratePrincipalLaneForIngress(
      source.sessionId, created.lane.laneId,
    )).toMatchObject({ status: 'quarantined', reason: expect.stringContaining('worktree:') });
  });

  it('reports malformed worktree proof during hydration without quarantine writes', async () => {
    const source = sourceSession('root-proof-readonly', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const writer = new DatabaseSync(dbPath);
    try {
      const hit = writer.prepare(
        'SELECT row FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId) as { row: string };
      const row = JSON.parse(hit.row);
      row.workingDir = `${row.workingDir}-tampered`;
      writer.prepare(
        'UPDATE principal_lane_worktrees SET row = ? WHERE materialization_id = ?',
      ).run(JSON.stringify(row), materialization.materializationId);
    } finally { writer.close(); }
    const observer = new DatabaseSync(dbPath);
    try {
      const dataVersion = (observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version;
      expect(await hydratePrincipalLaneForIngress(
        source.sessionId, created.lane.laneId,
      )).toMatchObject({ status: 'quarantined', reason: expect.stringContaining('worktree:') });
      expect((observer.prepare(
        'SELECT phase FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId) as { phase: string }).phase).toBe('ready');
      expect((observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version).toBe(dataVersion);
    } finally { observer.close(); }
  });

  it('fails hydration read-only when the published worktree path is replaced by another repo', async () => {
    const source = sourceSession('root-worktree-replaced', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    rmSync(materialization.worktreeRoot, { recursive: true, force: true });
    mkdirSync(materialization.worktreeRoot, { recursive: true });
    execFileSync('git', ['init', '-b', materialization.branch], {
      cwd: materialization.worktreeRoot,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const observer = new DatabaseSync(dbPath);
    try {
      const dataVersion = (observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version;
      expect(await hydratePrincipalLaneForIngress(
        source.sessionId, created.lane.laneId,
      )).toMatchObject({ status: 'quarantined', reason: 'worktree_session_sidecar_mismatch' });
      expect((observer.prepare(
        'SELECT phase FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId) as { phase: string }).phase).toBe('ready');
      expect((observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version).toBe(dataVersion);
    } finally { observer.close(); }
  });

  it('fails hydration read-only when the linked worktree leaves its published branch', async () => {
    const source = sourceSession('root-worktree-branch', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected materialized lane');
    execFileSync('git', ['switch', '-c', 'wt/principal-lane-other'], {
      cwd: materialization.worktreeRoot,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const observer = new DatabaseSync(dbPath);
    try {
      const dataVersion = (observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version;
      expect(await hydratePrincipalLaneForIngress(
        source.sessionId, created.lane.laneId,
      )).toMatchObject({ status: 'quarantined', reason: 'worktree_session_sidecar_mismatch' });
      expect((observer.prepare(
        'SELECT phase FROM principal_lane_worktrees WHERE materialization_id = ?',
      ).get(materialization.materializationId) as { phase: string }).phase).toBe('ready');
      expect((observer.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version).toBe(dataVersion);
    } finally { observer.close(); }
  });

  it('returns retry only after a proven pre-commit rollback with zero lane, proof, or cache publication', () => {
    const source = sourceSession('root-worktree-rollback', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    __testOnly_setBeforePrincipalLaneWorktreeCommit(() => {
      throw new Error('synthetic pre-commit failure');
    });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      worktree: materialization,
      now: '2026-09-19T08:01:00.000Z',
    })).toEqual({ status: 'retry', reason: 'worktree_not_committed' });
    __testOnly_setBeforePrincipalLaneWorktreeCommit(undefined);
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_worktrees')
        .get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_identity_audit')
        .get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it('reports a created directory as an orphan when integrated publication rolls back', async () => {
    execFileSync('git', ['init', '-b', 'master'], { cwd: tempDir });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], {
      cwd: tempDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    const source = sourceSession('root-worktree-orphan', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    __testOnly_setBeforePrincipalLaneWorktreeCommit(() => {
      throw new Error('synthetic publication rollback');
    });
    const result = await prepareShadowPrincipalLaneForIngress({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    __testOnly_setBeforePrincipalLaneWorktreeCommit(undefined);
    expect(result).toMatchObject({
      status: 'retry', reason: 'worktree_not_committed',
      orphan: {
        worktreePath: expect.stringContaining('-wt-principal-lane-'),
        branch: expect.stringMatching(/^wt\/principal-lane-/),
      },
    });
    if (!('orphan' in result) || !result.orphan) throw new Error('expected orphan report');
    expect(existsSync(result.orphan.worktreePath)).toBe(true);
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_worktrees')
        .get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
    rmSync(result.orphan.worktreePath, { recursive: true, force: true });
  });

  it('converges a post-commit exception by asynchronous read-only proof recovery', async () => {
    initializeSourceGitRepository();
    const source = sourceSession('root-worktree-unknown', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    __testOnly_setAfterPrincipalLaneWorktreeCommit(() => {
      throw new Error('synthetic commit outcome unknown');
    });
    let recovered;
    try {
      recovered = await prepareShadowPrincipalLaneForIngress({
        sourceSessionId: source.sessionId,
        identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
        now: '2026-09-19T08:01:00.000Z',
      });
    } finally {
      __testOnly_setAfterPrincipalLaneWorktreeCommit(undefined);
    }
    expect(recovered).toMatchObject({
      status: 'ready', created: false,
      worktree: { materializationId: expect.stringMatching(/^principal-lane-worktree:v1:/) },
      session: { workingDir: expect.stringContaining('-wt-principal-lane-') },
    });
  });

  it('keeps commit outcome unknown when read-only recovery sees partial proof traces', async () => {
    initializeSourceGitRepository();
    const source = sourceSession('root-worktree-unproven', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    __testOnly_setAfterPrincipalLaneWorktreeCommit(() => {
      const tamper = new DatabaseSync(dbPath);
      try {
        tamper.prepare('DELETE FROM principal_lane_worktrees').run();
      } finally { tamper.close(); }
      throw new Error('synthetic unprovable commit outcome');
    });
    try {
      expect(await prepareShadowPrincipalLaneForIngress({
        sourceSessionId: source.sessionId,
        identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
        now: '2026-09-19T08:01:00.000Z',
      })).toMatchObject({ status: 'unknown', reason: 'worktree_publication_unknown' });
    } finally {
      __testOnly_setAfterPrincipalLaneWorktreeCommit(undefined);
    }
  });

  it.each([
    ['lane session index is rebound', (db: DatabaseSync) => {
      const proof = db.prepare(
        'SELECT source_session_id, lane_id, session_id FROM principal_lane_worktrees '
        + 'LIMIT 1',
      ).get() as {
        source_session_id: string; lane_id: string; session_id: string;
      };
      const hit = db.prepare('SELECT status, row FROM sessions WHERE session_id = ?')
        .get(proof.session_id) as { status: string; row: string };
      const wrongSessionId = `${proof.session_id}-wrong`;
      const wrong = JSON.parse(hit.row);
      wrong.sessionId = wrongSessionId;
      db.prepare('INSERT INTO sessions (session_id, status, row) VALUES (?, ?, ?)')
        .run(wrongSessionId, hit.status, JSON.stringify(wrong));
      db.prepare(
        'UPDATE principal_lanes SET session_id = ? WHERE source_session_id = ? AND lane_id = ?',
      ).run(wrongSessionId, proof.source_session_id, proof.lane_id);
    }],
    ['embedded lane is rebound', (db: DatabaseSync) => {
      const proof = db.prepare(
        'SELECT session_id FROM principal_lane_worktrees LIMIT 1',
      ).get() as { session_id: string };
      const hit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(proof.session_id) as { row: string };
      const row = JSON.parse(hit.row);
      row.principalLane.routingAnchor = 'principal-lane:v1:wrong';
      db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
        .run(JSON.stringify(row), proof.session_id);
    }],
    ['workspace member is missing', (db: DatabaseSync) => {
      const proof = db.prepare(
        'SELECT source_session_id, lane_id FROM principal_lane_worktrees LIMIT 1',
      ).get() as { source_session_id: string; lane_id: string };
      db.prepare(
        'DELETE FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = ?',
      ).run(proof.source_session_id, proof.lane_id);
    }],
  ])('keeps commit outcome unknown when %s', async (_name, tamper) => {
    initializeSourceGitRepository();
    const source = sourceSession(`root-recovery-${_name}`, 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    let observer: DatabaseSync | undefined;
    let postTamperDataVersion: number | undefined;
    __testOnly_setAfterPrincipalLaneWorktreeCommit(() => {
      const db = new DatabaseSync(dbPath);
      try { tamper(db); }
      finally { db.close(); }
      observer = new DatabaseSync(dbPath);
      postTamperDataVersion = (observer.prepare('PRAGMA data_version').get() as {
        data_version: number;
      }).data_version;
      throw new Error('synthetic commit outcome with partial authority');
    });
    try {
      expect(await prepareShadowPrincipalLaneForIngress({
        sourceSessionId: source.sessionId,
        identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
        now: '2026-09-19T08:01:00.000Z',
      })).toMatchObject({ status: 'unknown', reason: 'worktree_publication_unknown' });
      expect((observer!.prepare('PRAGMA data_version').get() as { data_version: number })
        .data_version).toBe(postTamperDataVersion);
      expect((observer!.prepare(
        'SELECT phase FROM principal_lane_worktrees LIMIT 1',
      ).get() as { phase: string }).phase).toBe('ready');
    } finally {
      observer?.close();
      __testOnly_setAfterPrincipalLaneWorktreeCommit(undefined);
    }
  });

  it('rolls back both the child Session and lane when either write fails', () => {
    const source = sourceSession('root-rollback', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_shadow_lane BEFORE INSERT ON principal_lanes
        WHEN NEW.lane_id <> 'source'
        BEGIN SELECT RAISE(ABORT, 'synthetic lane failure'); END;
      `);
    } finally { db.close(); }

    expect(() => ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_lane_fail', openId: 'ou_lane_fail' },
      now: '2026-09-19T08:01:00.000Z',
    })).toThrow('synthetic lane failure');
    let verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lane_aliases').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(1);
      verify.exec('DROP TRIGGER fail_shadow_lane;');
    } finally { verify.close(); }

    __testOnly_setBeforeRowPersist(sessionId => {
      if (sessionId !== source.sessionId) throw new Error('synthetic child session failure');
    });
    expect(() => ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_session_fail', openId: 'ou_session_fail' },
      now: '2026-09-19T08:02:00.000Z',
    })).toThrow('synthetic child session failure');
    __testOnly_setBeforeRowPersist(undefined);

    verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_lane_aliases').get() as { n: number }).n).toBe(1);
      expect((verify.prepare('SELECT COUNT(*) AS n FROM principal_workspace_members')
        .get() as { n: number }).n).toBe(1);
      expect((verify.prepare(
        "SELECT COUNT(*) AS n FROM principal_lane_identity_audit WHERE event = 'created'",
      ).get() as { n: number }).n).toBe(0);
    } finally { verify.close(); }
  });

  it('atomically upgrades app-open identity evidence to union without duplicating a lane', () => {
    const source = sourceSession('root-upgrade', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const openOnly = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    expect(openOnly).toMatchObject({
      status: 'ready', created: true,
      lane: { principalKey: `user:app:${appId}:open:ou_b` },
    });
    if (openOnly.status !== 'ready') throw new Error('expected open-id lane');

    const upgraded = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:02:00.000Z',
    });
    expect(upgraded).toMatchObject({
      status: 'ready', created: false,
      lane: { laneId: openOnly.lane.laneId, principalKey: 'user:union:on_b' },
      session: {
        sessionId: openOnly.session.sessionId,
        ownerUnionId: 'on_b',
        ownerOpenId: 'ou_b',
      },
    });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(2);
      expect((db.prepare(
        'SELECT COUNT(*) AS n FROM principal_lane_aliases WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, openOnly.lane.laneId) as { n: number }).n).toBe(2);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM principal_lane_identity_audit WHERE event = 'upgraded'",
      ).get() as { n: number }).n).toBe(1);
      expect(db.prepare(
        'SELECT session_id, group_id, workspace_epoch FROM principal_workspace_members '
        + 'WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, openOnly.lane.laneId)).toMatchObject({
        session_id: openOnly.session.sessionId,
        workspace_epoch: 1,
      });
    } finally { db.close(); }
  });

  it('persistently fails closed when union and app-open evidence resolve to different lanes', () => {
    const source = sourceSession('root-conflict', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const openLane = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    const unionLane = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b' },
      now: '2026-09-19T08:02:00.000Z',
    });
    expect(openLane).toMatchObject({ status: 'ready', created: true });
    expect(unionLane).toMatchObject({ status: 'ready', created: true });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:03:00.000Z',
    })).toEqual({ status: 'identity_conflict', reason: 'identity_evidence_conflict' });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, openId: 'ou_b' },
      now: '2026-09-19T08:04:00.000Z',
    })).toEqual({ status: 'identity_conflict', reason: 'identity_evidence_conflict' });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b' },
      now: '2026-09-19T08:05:00.000Z',
    })).toEqual({ status: 'identity_conflict', reason: 'identity_evidence_conflict' });

    init(appId);
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:06:00.000Z',
    })).toEqual({ status: 'identity_conflict', reason: 'identity_evidence_conflict' });
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare(
        'SELECT COUNT(*) AS n FROM principal_lane_identity_conflicts WHERE source_session_id = ?',
      ).get(source.sessionId) as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(3);
    } finally { db.close(); }
  });

  it('returns retry without a half-created lane when source authority changes after snapshot', () => {
    const source = sourceSession('root-authority', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    __testOnly_setBeforePrincipalLaneCreateTransaction(() => {
      const db = new DatabaseSync(dbPath);
      try {
        const hit = db.prepare(
          'SELECT revision, row FROM principal_lane_sources WHERE source_session_id = ?',
        ).get(source.sessionId) as { revision: number; row: string };
        const row = JSON.parse(hit.row);
        row.revision = hit.revision + 1;
        row.updatedAt = '2026-09-19T08:00:30.000Z';
        db.prepare(
          'UPDATE principal_lane_sources SET revision = ?, row = ? WHERE source_session_id = ?',
        ).run(row.revision, JSON.stringify(row), source.sessionId);
        const sessionHit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
          .get(source.sessionId) as { row: string };
        const sourceRow = JSON.parse(sessionHit.row);
        sourceRow.principalLaneSource = row;
        db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
          .run(JSON.stringify(sourceRow), source.sessionId);
      } finally { db.close(); }
    });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    })).toEqual({ status: 'retry', reason: 'source_authority_changed' });
    __testOnly_setBeforePrincipalLaneCreateTransaction(undefined);

    const db = new DatabaseSync(dbPath);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_aliases').get() as { n: number }).n).toBe(1);
      expect((db.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { db.close(); }
  });

  it.each([
    ['source lane revision', 'lane-revision'],
    ['source workspace group', 'workspace-group'],
  ])('rechecks the complete pre-transaction %s authority snapshot', (_label, mutation) => {
    const source = sourceSession(`root-${mutation}`, 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    __testOnly_setBeforePrincipalLaneCreateTransaction(() => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionHit = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
          .get(source.sessionId) as { row: string };
        const sourceRow = JSON.parse(sessionHit.row);
        if (mutation === 'lane-revision') {
          const laneHit = db.prepare(
            "SELECT revision, row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
          ).get(source.sessionId) as { revision: number; row: string };
          const laneRow = JSON.parse(laneHit.row);
          laneRow.revision = laneHit.revision + 1;
          laneRow.updatedAt = '2026-09-19T08:00:30.000Z';
          db.prepare(
            "UPDATE principal_lanes SET revision = ?, row = ? WHERE source_session_id = ? AND lane_id = 'source'",
          ).run(laneRow.revision, JSON.stringify(laneRow), source.sessionId);
          sourceRow.principalLane = laneRow;
        } else {
          const stateHit = db.prepare(
            'SELECT row FROM principal_lane_sources WHERE source_session_id = ?',
          ).get(source.sessionId) as { row: string };
          const stateRow = JSON.parse(stateHit.row);
          stateRow.canonicalCwd = realpathSync(dirname(tempDir));
          stateRow.workspaceGroupId = principalWorkspaceGroupIdV2(appId, stateRow.canonicalCwd);
          db.prepare(
            'UPDATE principal_lane_sources SET canonical_cwd = ?, workspace_group_id = ?, row = ? '
            + 'WHERE source_session_id = ?',
          ).run(
            stateRow.canonicalCwd, stateRow.workspaceGroupId,
            JSON.stringify(stateRow), source.sessionId,
          );
          sourceRow.principalLaneSource = stateRow;
        }
        db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
          .run(JSON.stringify(sourceRow), source.sessionId);
      } finally { db.close(); }
    });

    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    })).toEqual({ status: 'retry', reason: 'source_authority_changed' });
    __testOnly_setBeforePrincipalLaneCreateTransaction(undefined);

    const db = new DatabaseSync(dbPath);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_aliases').get() as { n: number }).n).toBe(1);
      expect((db.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
      expect((db.prepare(
        "SELECT phase FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { db.close(); }
  });

  it.each([
    ['source revision', { sourceRevision: 99 }],
    ['source lane revision', { sourceLaneRevision: 99 }],
  ])('refuses materialization under a stale ingress %s fence', (_label, override) => {
    const source = sourceSession(`root-stale-${_label.replaceAll(' ', '-')}`, 'on_source', 'ou_source');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    if (ready.status !== 'ready') throw new Error('expected ready source lane');
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
      expectedSource: {
        sourcePrincipalKey: ready.source.sourcePrincipalKey,
        sourceRevision: ready.source.revision,
        sourceLaneRevision: ready.lane.revision,
        workspaceEpoch: ready.source.workspaceEpoch,
        canonicalCwd: ready.source.canonicalCwd,
        workspaceGroupId: ready.source.workspaceGroupId,
        workspaceGroupKeyVersion: ready.source.workspaceGroupKeyVersion,
        displayTarget: ready.source.displayTarget,
        ...override,
      },
    })).toEqual({ status: 'retry', reason: 'source_authority_changed' });

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_aliases').get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('serializes concurrent creators and makes the loser validate and reuse the winner', async () => {
    const source = sourceSession('root-concurrent', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    // Release this process's connection before the two independent creators race.
    init();
    const code = `
      import { init, ensureShadowPrincipalLane } from './src/services/session-store.js';
      init(${JSON.stringify(appId)});
      const result = ensureShadowPrincipalLane({
        sourceSessionId: ${JSON.stringify(source.sessionId)},
        identity: { larkAppId: ${JSON.stringify(appId)}, unionId: 'on_b', openId: 'ou_b' },
        title: 'B concurrent lane',
        now: '2026-09-19T08:01:00.000Z',
      });
      console.log('SHADOW_RESULT=' + JSON.stringify(result));
    `;
    const runCreator = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(code, {
        env: { ...process.env, SESSION_DATA_DIR: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ code: exitCode, output }));
    });
    const outcomes = await Promise.all([runCreator(), runCreator()]);
    for (const outcome of outcomes) {
      expect(outcome.code, outcome.output).toBe(0);
      expect(outcome.output).toContain('SHADOW_RESULT=');
    }
    const results = outcomes.map(outcome => JSON.parse(
      outcome.output.split('SHADOW_RESULT=')[1]!.trim().split('\n')[0]!,
    ));
    expect(results.map(result => result.status)).toEqual(['ready', 'ready']);
    expect(new Set(results.map(result => result.lane.laneId)).size).toBe(1);
    expect(new Set(results.map(result => result.session.sessionId)).size).toBe(1);
    expect(results.filter(result => result.created).length).toBe(1);

    init(appId);
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(2);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM principal_lane_identity_audit WHERE event = 'created'",
      ).get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('converges two-process worktree publication to one lane, session, and proof', async () => {
    const source = sourceSession('root-concurrent-worktree', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const materialization = worktreeMaterialization({ sourceSessionId: source.sessionId });
    init();
    const code = `
      import { init, ensureShadowPrincipalLane } from './src/services/session-store.js';
      init(${JSON.stringify(appId)});
      const result = ensureShadowPrincipalLane({
        sourceSessionId: ${JSON.stringify(source.sessionId)},
        identity: { larkAppId: ${JSON.stringify(appId)}, unionId: 'on_b', openId: 'ou_b' },
        worktree: ${JSON.stringify(materialization)},
        now: '2026-09-19T08:01:00.000Z',
      });
      console.log('WORKTREE_RESULT=' + JSON.stringify(result));
    `;
    const runCreator = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(code, {
        env: { ...process.env, SESSION_DATA_DIR: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', exitCode => resolve({ code: exitCode, output }));
    });
    const outcomes = await Promise.all([runCreator(), runCreator()]);
    const results = outcomes.map(outcome => {
      expect(outcome.code, outcome.output).toBe(0);
      return JSON.parse(
        outcome.output.split('WORKTREE_RESULT=')[1]!.trim().split('\n')[0]!,
      );
    });
    expect(results.map(result => result.status)).toEqual(['ready', 'ready']);
    expect(new Set(results.map(result => result.lane.laneId)).size).toBe(1);
    expect(new Set(results.map(result => result.session.sessionId)).size).toBe(1);
    expect(new Set(results.map(result => result.worktree.materializationId)).size).toBe(1);

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(2);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lane_worktrees')
        .get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it('quarantines only a corrupt existing shadow lane when the reuse loser validates it', () => {
    const source = sourceSession('root-corrupt-shadow', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected ready shadow lane');
    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      const child = db.prepare('SELECT row FROM sessions WHERE session_id = ?')
        .get(created.session.sessionId) as { row: string };
      const row = JSON.parse(child.row);
      row.chatId = 'chat-other';
      db.prepare('UPDATE sessions SET row = ? WHERE session_id = ?')
        .run(JSON.stringify(row), created.session.sessionId);
    } finally { db.close(); }

    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'quarantined', reason: 'lane_session_mismatch' });
    const verify = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((verify.prepare(
        'SELECT phase FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, created.lane.laneId) as { phase: string }).phase).toBe('quarantined');
      expect((verify.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { verify.close(); }
  });

  it('quarantines only a corrupt workspace member without quarantining its principal lane', () => {
    const source = sourceSession('root-corrupt-member', 'on_source', 'ou_source');
    ensurePrincipalLaneSource({
      sourceSessionId: source.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_source' },
      now,
    });
    const created = ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:01:00.000Z',
    });
    if (created.status !== 'ready') throw new Error('expected ready shadow lane');
    const dbPath = join(tempDir, 'session-stores', appId, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      const hit = db.prepare(
        'SELECT row FROM principal_workspace_members WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, created.lane.laneId) as { row: string };
      const row = JSON.parse(hit.row);
      row.sessionId = 'session-other';
      db.prepare(
        'UPDATE principal_workspace_members SET row = ? '
        + 'WHERE source_session_id = ? AND lane_id = ?',
      ).run(JSON.stringify(row), source.sessionId, created.lane.laneId);
    } finally { db.close(); }

    expect(readPrincipalWorkspaceMembershipV2(source.sessionId)).toEqual({
      status: 'quarantined', target: 'member', reason: 'member:indexed_value_mismatch',
    });
    expect(ensureShadowPrincipalLane({
      sourceSessionId: source.sessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      now: '2026-09-19T08:02:00.000Z',
    })).toEqual({ status: 'quarantined', reason: 'member:stored_quarantine' });

    const verify = new DatabaseSync(dbPath);
    try {
      expect((verify.prepare(
        'SELECT membership_phase FROM principal_workspace_members '
        + 'WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, created.lane.laneId) as { membership_phase: string })
        .membership_phase).toBe('quarantined');
      expect((verify.prepare(
        'SELECT phase FROM principal_lanes WHERE source_session_id = ? AND lane_id = ?',
      ).get(source.sessionId, created.lane.laneId) as { phase: string }).phase).toBe('active');
      expect((verify.prepare(
        'SELECT phase FROM principal_lane_sources WHERE source_session_id = ?',
      ).get(source.sessionId) as { phase: string }).phase).toBe('active');
    } finally { verify.close(); }
  });

  it('records provenance idempotently and refuses conflicts or trust elevation', () => {
    const session = sourceSession('root-p', 'on_p', 'ou_p');
    const ready = ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: 'on_p' },
      now,
    });
    expect(ready.status).toBe('ready');
    const trusted = {
      messageId: 'om_out',
      larkAppId: appId,
      chatId: 'chat-root-p',
      displayRootId: 'root-p',
      sourceSessionId: session.sessionId,
      laneId: 'source',
      sessionId: session.sessionId,
      turnId: 'om_turn',
      principalKey: 'user:union:on_p',
      workerGeneration: 1,
      direction: 'outbound' as const,
      trustState: 'trusted' as const,
      createdAt: now,
      updatedAt: now,
    };
    expect(recordMessageProvenance(trusted)).toEqual(trusted);
    expect(recordMessageProvenance(trusted)).toEqual(trusted);
    expect(readTrustedMessageProvenance('om_out', session.sessionId)).toEqual(trusted);
    const retriedCreatedAt = '2026-09-19T08:00:00.016Z';
    expect(recordMessageProvenance({
      ...trusted,
      createdAt: retriedCreatedAt,
      updatedAt: retriedCreatedAt,
    })).toEqual({
      ...trusted,
      updatedAt: retriedCreatedAt,
    });
    expect(readTrustedMessageProvenance('om_out', session.sessionId)).toEqual({
      ...trusted,
      updatedAt: retriedCreatedAt,
    });
    const newerUpdatedAt = '2026-09-19T09:00:00.000Z';
    expect(recordMessageProvenance({ ...trusted, updatedAt: newerUpdatedAt })).toMatchObject({
      updatedAt: newerUpdatedAt,
    });
    expect(recordMessageProvenance(trusted)).toMatchObject({ updatedAt: newerUpdatedAt });
    expect(() => recordMessageProvenance({ ...trusted, chatId: 'chat-other' }))
      .toThrow('display target mismatch');
    expect(() => recordMessageProvenance({ ...trusted, turnId: 'om_other' }))
      .toThrow('identity conflict');
    expect(readTrustedMessageProvenance('om_out', session.sessionId)).toBeUndefined();

    init(appId);
    expect(readTrustedMessageProvenance('om_out', session.sessionId)).toBeUndefined();
    const afterConflict = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((afterConflict.prepare(
        'SELECT trust_state, updated_at FROM message_provenance WHERE message_id = ?',
      ).get('om_out') as { trust_state: string; updated_at: string })).toEqual({
        trust_state: 'untrusted', updated_at: newerUpdatedAt,
      });
      expect((afterConflict.prepare(
        'SELECT COUNT(*) AS n FROM message_provenance_conflicts WHERE message_id = ?',
      ).get('om_out') as { n: number }).n).toBe(1);
    } finally { afterConflict.close(); }

    const authorityCases = [
      {
        messageId: 'om_principal_conflict',
        mutation: { principalKey: 'user:union:on_other' },
        error: 'lane authority mismatch',
      },
      {
        messageId: 'om_lane_conflict',
        mutation: { laneId: 'lane_other' },
        error: 'lane authority mismatch',
      },
      {
        messageId: 'om_session_conflict',
        mutation: { sessionId: 'session_other' },
        error: 'session authority mismatch',
      },
      {
        messageId: 'om_generation_conflict',
        mutation: { workerGeneration: 2 },
        error: 'identity conflict',
      },
    ] as const;
    for (const { messageId, mutation, error } of authorityCases) {
      const base = {
        ...trusted,
        messageId,
        turnId: `${messageId}_turn`,
      };
      expect(recordMessageProvenance(base)).toEqual(base);
      expect(() => recordMessageProvenance({
        ...base,
        ...mutation,
        updatedAt: newerUpdatedAt,
      })).toThrow(error);
    }

    const untrusted = {
      ...trusted,
      messageId: 'om_untrusted',
      trustState: 'untrusted' as const,
    };
    recordMessageProvenance(untrusted);
    expect(readTrustedMessageProvenance('om_untrusted', session.sessionId)).toBeUndefined();
    expect(() => recordMessageProvenance({ ...untrusted, trustState: 'trusted' }))
      .toThrow('trust elevation refused');

    const confirmed = { ...trusted, messageId: 'om_confirmed' };
    settlePrincipalLaneOutboundProvenance(confirmed, {
      beginTrustAttempt: beginMessageProvenanceTrustAttempt,
      recordTrusted: recordMessageProvenance,
      completeTrustAttempt: completeMessageProvenanceTrustAttempt,
      abortTrustAttempt: abortMessageProvenanceTrustAttempt,
      markUntrusted: markMessageProvenanceUntrusted,
      warn: () => {},
    });
    expect(readTrustedMessageProvenance('om_confirmed', session.sessionId))
      .toMatchObject({ messageId: 'om_confirmed', trustState: 'trusted' });

    settlePrincipalLaneOutboundProvenance(confirmed, {
      beginTrustAttempt: beginMessageProvenanceTrustAttempt,
      recordTrusted: () => { throw new SessionStoreBusyError(new Error('synthetic busy')); },
      completeTrustAttempt: completeMessageProvenanceTrustAttempt,
      abortTrustAttempt: abortMessageProvenanceTrustAttempt,
      markUntrusted: markMessageProvenanceUntrusted,
      warn: () => {},
    });
    expect(readTrustedMessageProvenance('om_confirmed', session.sessionId))
      .toMatchObject({ messageId: 'om_confirmed', trustState: 'trusted' });
    const busyRetryDb = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((busyRetryDb.prepare(
        'SELECT COUNT(*) AS n FROM message_provenance_trust_fences WHERE message_id = ?',
      ).get('om_confirmed') as { n: number }).n).toBe(0);
    } finally { busyRetryDb.close(); }

    const exactAttempt = { ...trusted, messageId: 'om_exact_attempt' };
    const exactAttemptId = beginMessageProvenanceTrustAttempt(exactAttempt);
    expect(() => completeMessageProvenanceTrustAttempt(exactAttempt, 'wrong-attempt'))
      .toThrow('fenced by an unresolved trust attempt');
    expect(() => recordMessageProvenance(exactAttempt))
      .toThrow('fenced by an unresolved trust attempt');
    recordMessageProvenance(exactAttempt, exactAttemptId);
    completeMessageProvenanceTrustAttempt(exactAttempt, exactAttemptId);
    expect(readTrustedMessageProvenance('om_exact_attempt', session.sessionId))
      .toMatchObject({ trustState: 'trusted' });

    const busyAttempt = { ...trusted, messageId: 'om_busy_attempt' };
    const busyAttemptId = beginMessageProvenanceTrustAttempt(busyAttempt);
    const busyWriter = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    busyWriter.exec('PRAGMA busy_timeout = 0;');
    busyWriter.exec('BEGIN IMMEDIATE;');
    try {
      expect(() => recordMessageProvenance(busyAttempt, busyAttemptId))
        .toThrow(SessionStoreBusyError);
    } finally {
      busyWriter.exec('ROLLBACK;');
      busyWriter.close();
    }
    abortMessageProvenanceTrustAttempt(busyAttempt, busyAttemptId);
    expect(readTrustedMessageProvenance('om_busy_attempt', session.sessionId)).toBeUndefined();

    const deliveredButUnproved = { ...trusted, messageId: 'om_commit_unknown' };
    settlePrincipalLaneOutboundProvenance(deliveredButUnproved, {
      beginTrustAttempt: beginMessageProvenanceTrustAttempt,
      recordTrusted: (value, attemptId) => {
        recordMessageProvenance(value, attemptId);
        throw new Error('simulated trusted COMMIT unknown');
      },
      completeTrustAttempt: completeMessageProvenanceTrustAttempt,
      abortTrustAttempt: abortMessageProvenanceTrustAttempt,
      markUntrusted: value => {
        __testOnly_setAfterProvenanceDenyFence(() => {
          throw new Error('simulated downgrade write failure');
        });
        try { markMessageProvenanceUntrusted(value); }
        finally { __testOnly_setAfterProvenanceDenyFence(undefined); }
      },
      warn: () => {},
    });
    const uncertainDb = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((uncertainDb.prepare(
        'SELECT trust_state FROM message_provenance WHERE message_id = ?',
      ).get('om_commit_unknown') as { trust_state: string }).trust_state).toBe('trusted');
      expect((uncertainDb.prepare(
        'SELECT COUNT(*) AS n FROM message_provenance_trust_fences WHERE message_id = ?',
      ).get('om_commit_unknown') as { n: number }).n).toBe(1);
    } finally { uncertainDb.close(); }
    expect(readTrustedMessageProvenance('om_commit_unknown', session.sessionId)).toBeUndefined();
    init(appId);
    expect(readTrustedMessageProvenance('om_commit_unknown', session.sessionId)).toBeUndefined();
    expect(() => beginMessageProvenanceTrustAttempt(deliveredButUnproved))
      .toThrow('fenced by an unresolved trust attempt');
    // A stale retry and its compensation must neither release the old fence
    // nor downgrade the already-committed trusted row.
    markMessageProvenanceUntrusted({ ...deliveredButUnproved, trustState: 'untrusted' });
    const stillFencedDb = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      expect((stillFencedDb.prepare(
        'SELECT trust_state FROM message_provenance WHERE message_id = ?',
      ).get('om_commit_unknown') as { trust_state: string }).trust_state).toBe('trusted');
      expect((stillFencedDb.prepare(
        'SELECT COUNT(*) AS n FROM message_provenance_trust_fences WHERE message_id = ?',
      ).get('om_commit_unknown') as { n: number }).n).toBe(1);
    } finally { stillFencedDb.close(); }

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      db.prepare(
        "UPDATE principal_lanes SET phase = 'quarantined' WHERE source_session_id = ? AND lane_id = 'source'",
      ).run(session.sessionId);
    } finally { db.close(); }
    expect(readTrustedMessageProvenance('om_out', session.sessionId)).toBeUndefined();
    expect(() => recordMessageProvenance({ ...trusted, messageId: 'om_after_quarantine' }))
      .toThrow('principal-lane source is not ready');
  });

  it.each([
    ['stale workspace epoch', 'epoch'],
    ['closed phase', 'closed'],
  ])('refuses trusted provenance authority from a %s lane', (_label, mutation) => {
    const session = sourceSession(`root-${mutation}`, `on_${mutation}`, `ou_${mutation}`);
    ensurePrincipalLaneSource({
      sourceSessionId: session.sessionId,
      caller: { senderType: 'user', kind: 'union', unionId: `on_${mutation}` },
      now,
    });
    const provenance = {
      messageId: `om_${mutation}`,
      larkAppId: appId,
      chatId: `chat-root-${mutation}`,
      displayRootId: `root-${mutation}`,
      sourceSessionId: session.sessionId,
      laneId: 'source',
      sessionId: session.sessionId,
      turnId: `om_turn_${mutation}`,
      principalKey: `user:union:on_${mutation}`,
      workerGeneration: 1,
      direction: 'outbound' as const,
      trustState: 'trusted' as const,
      createdAt: now,
      updatedAt: now,
    };
    recordMessageProvenance(provenance);

    const db = new DatabaseSync(join(tempDir, 'session-stores', appId, 'sessions.db'));
    try {
      const hit = db.prepare(
        "SELECT row FROM principal_lanes WHERE source_session_id = ? AND lane_id = 'source'",
      ).get(session.sessionId) as { row: string };
      const row = JSON.parse(hit.row);
      if (mutation === 'epoch') {
        row.workspaceEpoch = 2;
        db.prepare(
          "UPDATE principal_lanes SET workspace_epoch = 2, row = ? WHERE source_session_id = ? AND lane_id = 'source'",
        ).run(JSON.stringify(row), session.sessionId);
      } else {
        row.phase = 'closed';
        db.prepare(
          "UPDATE principal_lanes SET phase = 'closed', row = ? WHERE source_session_id = ? AND lane_id = 'source'",
        ).run(JSON.stringify(row), session.sessionId);
      }
    } finally { db.close(); }

    expect(readTrustedMessageProvenance(provenance.messageId, session.sessionId)).toBeUndefined();
    expect(() => recordMessageProvenance({ ...provenance, messageId: `${provenance.messageId}_new` }))
      .toThrow(/principal-lane source is not ready|lane is not admissible/);
  });
});

describe('mutateOwnedSessionsAtomically()', () => {
  it('publishes a multi-row authority change only after every row commits', () => {
    const first = createSession('chat-a', 'root-a', 'A');
    const second = createSession('chat-b', 'root-b', 'B');

    const outcome = mutateOwnedSessionsAtomically([first.sessionId, second.sessionId], rows => {
      rows.get(first.sessionId)!.xpiSharedCwdAdmissionCoordinatorSessionId = second.sessionId;
      rows.get(second.sessionId)!.xpiSharedCwdAdmissionCoordinatorSessionId = second.sessionId;
      return 'committed' as const;
    });

    expect(outcome.result).toBe('committed');
    expect(getOwnedSession(first.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBe(second.sessionId);
    expect(getOwnedSession(second.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBe(second.sessionId);
    init();
    expect(getOwnedSession(first.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBe(second.sessionId);
    expect(getOwnedSession(second.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBe(second.sessionId);
  });

  it('rolls back disk and cache together when the second row cannot persist', () => {
    const first = createSession('chat-a', 'root-a', 'A');
    const second = createSession('chat-b', 'root-b', 'B');
    __testOnly_setBeforeRowPersist(sessionId => {
      if (sessionId === second.sessionId) throw new Error('synthetic second-row failure');
    });

    expect(() => mutateOwnedSessionsAtomically([first.sessionId, second.sessionId], rows => {
      rows.get(first.sessionId)!.xpiSharedCwdAdmissionCoordinatorSessionId = second.sessionId;
      rows.get(second.sessionId)!.xpiSharedCwdAdmissionCoordinatorSessionId = second.sessionId;
    })).toThrow('synthetic second-row failure');

    expect(first.xpiSharedCwdAdmissionCoordinatorSessionId).toBeUndefined();
    expect(second.xpiSharedCwdAdmissionCoordinatorSessionId).toBeUndefined();
    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getOwnedSession(first.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBeUndefined();
    expect(getOwnedSession(second.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId).toBeUndefined();
  });

  it('fails fast without publishing cache or disk when nonblocking lock acquisition is busy', () => {
    const first = createSession('chat-a', 'root-a', 'A');
    const writer = new DatabaseSync(join(tempDir, 'sessions.db'));
    writer.exec('PRAGMA busy_timeout = 0;');
    writer.exec('BEGIN IMMEDIATE;');
    const startedAt = performance.now();
    try {
      expect(() => mutateOwnedSessionsAtomically([first.sessionId], rows => {
        rows.get(first.sessionId)!.xpiSharedCwdAdmissionGroupId = 'must-not-publish';
      }, { nonblocking: true })).toThrow(SessionStoreBusyError);
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(first.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    } finally {
      writer.exec('ROLLBACK;');
      writer.close();
    }

    mutateOwnedSessionsAtomically([first.sessionId], rows => {
      rows.get(first.sessionId)!.xpiSharedCwdAdmissionGroupId = 'after-lock-release';
    }, { nonblocking: true });
    expect(first.xpiSharedCwdAdmissionGroupId).toBe('after-lock-release');
    init();
    expect(getOwnedSession(first.sessionId)?.xpiSharedCwdAdmissionGroupId).toBe('after-lock-release');
  });
});

describe('createSessionWithOwnedMutation()', () => {
  it('publishes the child and parent-side authority in one commit', () => {
    const parent = createSession('chat-a', 'root-a', 'parent');
    const created = createSessionWithOwnedMutation({
      chatId: 'chat-a',
      rootMessageId: 'root-child',
      title: 'child',
      scope: 'thread',
      ownedSessionIds: [parent.sessionId],
    }, (rows, child) => {
      rows.get(parent.sessionId)!.xpiSharedCwdAdmissionGroupId = 'group-a';
      child.xpiSharedCwdAdmissionGroupId = 'group-a';
      return child.sessionId;
    });

    expect(created.result).toBe(created.session.sessionId);
    expect(getOwnedSession(parent.sessionId)?.xpiSharedCwdAdmissionGroupId).toBe('group-a');
    expect(getOwnedSession(created.session.sessionId)?.xpiSharedCwdAdmissionGroupId).toBe('group-a');
    init();
    expect(getOwnedSession(parent.sessionId)?.xpiSharedCwdAdmissionGroupId).toBe('group-a');
    expect(getOwnedSession(created.session.sessionId)?.xpiSharedCwdAdmissionGroupId).toBe('group-a');
  });

  it('captures group model defaults through the atomic child creation path', () => {
    init('atomic-model-defaults', {
      groupDefaultModels: chatId => chatId === 'chat-a' ? { codex: 'gpt-5.6-sol' } : undefined,
    });
    const parent = createSession('chat-a', 'root-a', 'parent');

    const created = createSessionWithOwnedMutation({
      chatId: 'chat-a',
      rootMessageId: 'root-child',
      title: 'child',
      chatType: 'group',
      scope: 'thread',
      ownedSessionIds: [parent.sessionId],
    }, rows => {
      rows.get(parent.sessionId)!.xpiSharedCwdAdmissionGroupId = 'group-a';
    });

    expect(created.session.groupDefaultModels).toEqual({ codex: 'gpt-5.6-sol' });
    expect(getOwnedSession(created.session.sessionId)?.groupDefaultModels)
      .toEqual({ codex: 'gpt-5.6-sol' });
  });

  it('rolls back the parent when the child insert fails after the parent write', () => {
    const parent = createSession('chat-a', 'root-a', 'parent');
    let childId: string | undefined;
    __testOnly_setBeforeRowPersist(sessionId => {
      if (sessionId === childId) throw new Error('synthetic child insert failure');
    });

    expect(() => createSessionWithOwnedMutation({
      chatId: 'chat-a',
      rootMessageId: 'root-child',
      title: 'child',
      scope: 'thread',
      ownedSessionIds: [parent.sessionId],
    }, (rows, child) => {
      childId = child.sessionId;
      rows.get(parent.sessionId)!.xpiSharedCwdAdmissionGroupId = 'group-a';
      child.xpiSharedCwdAdmissionGroupId = 'group-a';
    })).toThrow('synthetic child insert failure');

    expect(getOwnedSession(parent.sessionId)?.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(childId && getOwnedSession(childId)).toBeUndefined();
    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getOwnedSession(parent.sessionId)?.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(childId && getOwnedSession(childId)).toBeUndefined();
  });

  it('does not publish a child or parent mutation when nonblocking BEGIN is busy', () => {
    const parent = createSession('chat-a', 'root-a', 'parent');
    const beforeIds = listSessionsStrict().map(session => session.sessionId);
    const writer = new DatabaseSync(join(tempDir, 'sessions.db'));
    writer.exec('PRAGMA busy_timeout = 0;');
    writer.exec('BEGIN IMMEDIATE;');
    const startedAt = performance.now();
    try {
      expect(() => createSessionWithOwnedMutation({
        chatId: 'chat-a',
        rootMessageId: 'root-child',
        title: 'child',
        scope: 'thread',
        ownedSessionIds: [parent.sessionId],
        nonblocking: true,
      }, (rows, child) => {
        rows.get(parent.sessionId)!.xpiSharedCwdAdmissionGroupId = 'must-not-publish';
        child.xpiSharedCwdAdmissionGroupId = 'must-not-publish';
      })).toThrow(SessionStoreBusyError);
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(parent.xpiSharedCwdAdmissionGroupId).toBeUndefined();
      expect(listSessionsStrict().map(session => session.sessionId)).toEqual(beforeIds);
    } finally {
      writer.exec('ROLLBACK;');
      writer.close();
    }
  });
});

// ─── init() ───────────────────────────────────────────────────────────────

describe('init()', () => {
  it('migrates legacy stores by creating principal-lane sidecars without rewriting session rows', () => {
    const legacy = createSession('chat-legacy', 'root-legacy', 'legacy');
    const before = JSON.stringify(readPersistedRows(tempDir)[legacy.sessionId]);

    const db = new DatabaseSync(join(tempDir, 'sessions.db'));
    try {
      const tables = new Set((db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map(row => row.name));
      for (const table of [
        'sessions',
        'principal_lane_sources',
        'principal_lanes',
        'principal_lane_aliases',
        'principal_lane_identity_audit',
        'principal_lane_identity_conflicts',
        'message_provenance',
        'message_provenance_conflicts',
        'principal_lane_migration_audit',
      ]) expect(tables.has(table)).toBe(true);
      expect((db.prepare('SELECT COUNT(*) AS n FROM principal_lanes').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM message_provenance').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }

    expect(JSON.stringify(readPersistedRows(tempDir)[legacy.sessionId])).toBe(before);
    expect(getOwnedSession(legacy.sessionId)?.principalLane).toBeUndefined();
    expect(getOwnedSession(legacy.sessionId)?.principalLaneSource).toBeUndefined();
  });

  it('keeps cross-file discovery read-only and exposes owner-scoped lookup separately', () => {
    init('app-A');
    const ownedByA = createSession('chat1', 'root1', 'Bot A');

    init('app-B');
    expect(getSession(ownedByA.sessionId)?.sessionId).toBe(ownedByA.sessionId);
    expect(getOwnedSession(ownedByA.sessionId)).toBeUndefined();
  });

  it('should create the data directory on first operation if it does not exist', () => {
    const subDir = join(tempDir, 'nested', 'data');
    tempDir = subDir;
    init();
    // The directory is created lazily on first load (e.g. createSession)
    createSession('chat1', 'root1', 'Test');
    expect(existsSync(subDir)).toBe(true);
  });

  it('should load existing sessions from disk', () => {
    // Write a session file manually
    mkdirSync(tempDir, { recursive: true });
    const session = {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r1',
        title: 'Pre-existing',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify(session));

    // Re-init to pick up the file
    init();
    const loaded = getSession('s1');
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Pre-existing');
    expect(loaded!.status).toBe('active');
  });

  it('repairs only the scope-less oc_=root chat corruption signature', () => {
    mkdirSync(tempDir, { recursive: true });
    const records = {
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      legacyThread: {
        sessionId: 'legacyThread',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        title: 'Legacy thread',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify(records));

    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('legacyThread')?.scope).toBeUndefined();
    const persisted = readPersistedRows(tempDir);
    expect(persisted.broken.scope).toBe('chat');
    expect(persisted.legacyThread.scope).toBeUndefined();
  });

  it('ignores malformed entries while repairing healthy sessions', () => {
    mkdirSync(tempDir, { recursive: true });
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify({
      missingChatId: { sessionId: 'missing-chat-id' },
      primitive: 'not-a-session',
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      healthy: {
        sessionId: 'healthy',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        scope: 'thread',
        title: 'Healthy thread',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    }));

    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('healthy')?.title).toBe('Healthy thread');
    expect(listSessions()).toHaveLength(4);
  });

  it('repairs the corruption signature through the shared deserialization helper', () => {
    const record: Record<string, unknown> = {
      sessionId: 'broken',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
    };

    expect(repairMissingChatScope(record)).toBe(true);
    expect(record.scope).toBe('chat');
    expect(repairMissingChatScope(record)).toBe(false);
    expect(repairMissingChatScope(null)).toBe(false);
    expect(repairMissingChatScope({ sessionId: 'malformed' })).toBe(false);
  });

  it('keeps loaded sessions available when persisting a scope repair fails', () => {
    mkdirSync(tempDir, { recursive: true });
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify({
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      healthy: {
        sessionId: 'healthy',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        scope: 'thread',
        title: 'Healthy thread',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    }));

    fsControl.failSessionWrite = true;
    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('healthy')?.title).toBe('Healthy thread');
    expect(listSessions()).toHaveLength(2);
    expect(JSON.parse(readFileSync(fp, 'utf-8')).broken.scope).toBeUndefined();
  });

  it('should reset state when called again', () => {
    createSession('chat1', 'root1', 'Session A');
    expect(listSessions()).toHaveLength(1);

    // Re-init without appId clears in-memory state; because we have no file
    // for a different appId context, it starts fresh
    init('different-app');
    expect(listSessions()).toHaveLength(0);
  });
});

// ─── createSession() ─────────────────────────────────────────────────────

describe('createSession()', () => {
  it('should create a session with correct fields', () => {
    const session = createSession('chat1', 'root1', 'My Title', 'group');
    expect(session.sessionId).toBeDefined();
    expect(session.chatId).toBe('chat1');
    expect(session.rootMessageId).toBe('root1');
    expect(session.title).toBe('My Title');
    expect(session.chatType).toBe('group');
    expect(session.status).toBe('active');
    expect(session.createdAt).toBeDefined();
    expect(session.closedAt).toBeUndefined();
  });

  it('should assign unique session IDs', () => {
    const s1 = createSession('chat1', 'root1', 'A');
    const s2 = createSession('chat2', 'root2', 'B');
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('should persist session to disk', () => {
    const session = createSession('chat1', 'root1', 'Persisted');
    expect(persistedStoreExists(tempDir)).toBe(true);
    const data = readPersistedRows(tempDir);
    expect(data[session.sessionId]).toBeDefined();
    expect(data[session.sessionId].title).toBe('Persisted');
  });

  it('should default chatType to undefined when not provided', () => {
    const session = createSession('chat1', 'root1', 'No ChatType');
    expect(session.chatType).toBeUndefined();
  });
});

// ─── getSession() ─────────────────────────────────────────────────────────

describe('getSession()', () => {
  it('should retrieve an existing session by sessionId', () => {
    const created = createSession('chat1', 'root1', 'Findable');
    const found = getSession(created.sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Findable');
  });

  it('should return undefined for a non-existent sessionId', () => {
    const found = getSession('nonexistent-id');
    expect(found).toBeUndefined();
  });

  it('should find a session stored in a different appId file (cross-file lookup)', () => {
    // Create a session under appId "app-A"
    init('app-A');
    const session = createSession('chat1', 'root1', 'Cross-file');

    // Switch to appId "app-B"
    init('app-B');

    // Should still find the session from app-A's file
    const found = getSession(session.sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Cross-file');
  });
});

// ─── listSessions() ──────────────────────────────────────────────────────

describe('listSessions()', () => {
  it('should return all sessions', () => {
    createSession('c1', 'r1', 'A');
    createSession('c2', 'r2', 'B');
    createSession('c3', 'r3', 'C');
    const all = listSessions();
    expect(all).toHaveLength(3);
  });

  it('should return an empty array when no sessions exist', () => {
    expect(listSessions()).toEqual([]);
  });

  it('should include both active and closed sessions', () => {
    const s1 = createSession('c1', 'r1', 'Active');
    createSession('c2', 'r2', 'Will Close');
    const all = listSessions();
    closeSession(all.find(s => s.title === 'Will Close')!.sessionId);

    const afterClose = listSessions();
    expect(afterClose).toHaveLength(2);
    const statuses = afterClose.map(s => s.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('closed');
  });
});

describe('listSessionsStrict()', () => {
  it('returns a healthy empty projection when no store exists', () => {
    expect(listSessionsStrict()).toEqual([]);
  });

  it('rejects a malformed store instead of treating it as safely empty', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '{not-json');
    init();

    // Preserve the compatibility reader for non-transactional callers.
    expect(listSessions()).toEqual([]);
    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
    expect(() => listSessionsStrict()).toThrow(/session store is unavailable/i);
  });

  it('stays unhealthy until an explicit init reloads the repaired projection', () => {
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, '{not-json');
    init();

    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
    writeFileSync(fp, '{}');
    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);

    init();
    expect(listSessionsStrict()).toEqual([]);
  });

  it('rejects a malformed legacy projection during per-bot migration', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '{broken-legacy');
    init('app-A');

    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
  });

  it('rejects a JSON value that is not a session-record projection', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '[]');
    init();

    expect(() => listSessionsStrict()).toThrow(/invalid sessions projection/i);
  });
});

// ─── closeSession() ──────────────────────────────────────────────────────

describe('write health gate', () => {
  const corruptCurrentStore = (): { session: ReturnType<typeof createSession>; fp: string } => {
    const session = createSession('chat-write-gate', 'root-write-gate', 'Write Gate');
    session.backendType = 'mojo';
    updateSession(session);
    // Close the live SQLite connection before overwriting the active store;
    // corrupting the frozen JSON would not trip the engine now in use.
    init();
    const fp = persistedStorePath(tempDir);
    if (!fp) throw new Error('expected a persisted store after createSession');
    writeFileSync(fp, '{not-json');
    init();
    return { session, fp };
  };

  it.each([
    ['createSession', (_session: ReturnType<typeof createSession>) => {
      createSession('chat-new', 'root-new', 'Must Not Create');
    }],
    ['updateSession', (session: ReturnType<typeof createSession>) => {
      updateSession({ ...session, title: 'Must Not Update' });
    }],
    ['updateSessionPid', (session: ReturnType<typeof createSession>) => {
      updateSessionPid(session.sessionId, 12345);
    }],
    ['closeSession', (session: ReturnType<typeof createSession>) => {
      closeSession(session.sessionId);
    }],
    ['reactivateClosedSession', (session: ReturnType<typeof createSession>) => {
      reactivateClosedSession(session.sessionId);
    }],
    ['Mojo close journal', (session: ReturnType<typeof createSession>) => {
      beginMojoCloseJournal(session.sessionId, 'request-write-gate');
    }],
    ['single Riff lineage CAS', (session: ReturnType<typeof createSession>) => {
      persistActiveRemoteLineageExact(session.sessionId, 'task-next');
    }],
    ['batch Riff lineage CAS', (session: ReturnType<typeof createSession>) => {
      persistActiveRemoteLineagesExactBatch([{
        sessionId: session.sessionId,
        taskId: null,
        owner: { pid: null, larkAppId: null, backendType: 'mojo' },
        targetTaskId: 'task-next',
        expectedCurrentTaskIds: [null],
      }]);
    }],
  ])('rejects %s after a malformed current store load without changing disk or cache', (_name, mutate) => {
    const { session, fp } = corruptCurrentStore();

    expect(() => mutate(session)).toThrow(SessionStoreUnavailableError);
    expect(readFileSync(fp, 'utf-8')).toBe('{not-json');
    expect(listSessions()).toEqual([]);
  });

  it('keeps the write fence sticky after external repair until init reloads the store', () => {
    const { fp } = corruptCurrentStore();
    expect(() => createSession('chat-blocked', 'root-blocked', 'Blocked')).toThrow(
      SessionStoreUnavailableError,
    );

    rmSync(fp, { force: true });
    new DatabaseSync(fp).close();
    expect(() => createSession('chat-still-blocked', 'root-still-blocked', 'Still Blocked')).toThrow(
      SessionStoreUnavailableError,
    );
    expect(existsSync(fp)).toBe(true);

    init();
    expect(createSession('chat-reloaded', 'root-reloaded', 'Reloaded').status).toBe('active');
  });

  it('does not create a per-bot projection after malformed legacy migration input', () => {
    const legacyFp = join(tempDir, 'sessions.json');
    const botFp = join(tempDir, 'sessions-app-A.json');
    writeFileSync(legacyFp, '{broken-legacy');
    init('app-A');

    expect(() => createSession('chat-app-a', 'root-app-a', 'App A')).toThrow(
      SessionStoreUnavailableError,
    );
    expect(readFileSync(legacyFp, 'utf-8')).toBe('{broken-legacy');
    expect(existsSync(botFp)).toBe(false);
  });

  it('rejects writes after a valid JSON value that is not a session projection', () => {
    const session = createSession('chat-array', 'root-array', 'Array Projection');
    init();
    const fp = persistedStorePath(tempDir);
    if (!fp) throw new Error('expected a persisted store after createSession');
    writeFileSync(fp, '[]');
    init();

    expect(() => updateSession({ ...session, title: 'Must Not Overwrite Array' })).toThrow(
      SessionStoreUnavailableError,
    );
    expect(readFileSync(fp, 'utf-8')).toBe('[]');
  });
});

describe('closeSession()', () => {
  it.each(['active', 'closed'] as const)('cancels staged XPI work when closing a %s session', (status) => {
    const session = createSession('chat-xpi-close', 'root-xpi-close', 'Cancel protocol work');
    session.status = status;
    session.crossPrincipalInterruptions = [{
      version: 1, id: 'xpi_pending', ownerTurnId: 'om_owner', phase: 'awaiting_classification',
      owner: { requestUserOpenId: 'ou_owner', senderType: 'user' },
      proposer: { requestUserOpenId: 'ou_peer', senderType: 'bot' }, messages: [],
    }];
    updateSession(session);

    closeSession(session.sessionId);
    init();

    expect(getSession(session.sessionId)?.status).toBe('closed');
    expect(getSession(session.sessionId)?.crossPrincipalInterruptions).toBeUndefined();
  });

  it('should set status to closed and add closedAt timestamp', () => {
    const session = createSession('chat1', 'root1', 'To Close');
    closeSession(session.sessionId);

    const closed = getSession(session.sessionId);
    expect(closed!.status).toBe('closed');
    expect(closed!.closedAt).toBeDefined();
  });

  it('should persist the closed state to disk', () => {
    const session = createSession('chat1', 'root1', 'Persist Close');
    closeSession(session.sessionId);

    // Re-init and reload from disk
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded!.status).toBe('closed');
    expect(reloaded!.closedAt).toBeDefined();
  });

  it('snapshots token usage in the same durable close write', () => {
    const tokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'claude-test',
    };
    costCalculatorMock.getSessionTokenUsage.mockReturnValue(tokenUsage);
    const session = createSession('chat1', 'root1', 'Close With Usage');
    session.cliId = 'claude-code';
    session.cliSessionId = 'native-1';
    session.workingDir = '/repo';
    session.larkAppId = 'cli_app';
    updateSession(session);

    closeSession(session.sessionId);

    expect(costCalculatorMock.getSessionTokenUsage).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: session.sessionId,
      cliSessionId: 'native-1',
      cwd: '/repo',
      larkAppId: 'cli_app',
      fresh: true,
    });
    expect(getSession(session.sessionId)?.tokenUsage).toEqual(tokenUsage);
    init();
    expect(getSession(session.sessionId)?.tokenUsage).toEqual(tokenUsage);
    expect(readPersistedRows(tempDir)[session.sessionId].tokenUsage).toEqual(tokenUsage);
  });

  it('preserves existing token usage when close-time usage scan returns empty', () => {
    const existingTokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'previous-model',
    };
    costCalculatorMock.getSessionTokenUsage.mockReturnValue(null);
    const session = createSession('chat1', 'root1', 'Close With Existing Usage');
    session.tokenUsage = existingTokenUsage;
    updateSession(session);

    closeSession(session.sessionId);

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: existingTokenUsage,
    });
    init();
    expect(getSession(session.sessionId)?.tokenUsage).toEqual(existingTokenUsage);
  });

  it('does not fail close or overwrite existing token usage when close-time scan throws', () => {
    const existingTokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'previous-model',
    };
    costCalculatorMock.getSessionTokenUsage.mockImplementation(() => {
      throw new Error('transcript unavailable');
    });
    const session = createSession('chat1', 'root1', 'Close With Throwing Usage');
    session.tokenUsage = existingTokenUsage;
    updateSession(session);

    expect(() => closeSession(session.sessionId)).not.toThrow();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: existingTokenUsage,
    });
    init();
    expect(getSession(session.sessionId)?.tokenUsage).toEqual(existingTokenUsage);
  });

  it('clears Riff lineage atomically with the durable closed row', () => {
    const session = createSession('chat1', 'root1', 'Close Riff');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task-prepared';
    updateSession(session);

    closeSession(session.sessionId, { clearRiffParentTaskId: true });
    init();

    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('restores Riff close state in memory when the atomic save fails', () => {
    const session = createSession('chat1', 'root1', 'Close Riff Save Failure');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task-retry';
    updateSession(session);
    // SQLite 行写不经过 node:fs，失败注入改走 store 的 test-only 钩子。
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'riff-task-retry',
    });
    expect(mockDeleteFrozenCards).not.toHaveBeenCalled();

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'riff-task-retry',
    });
  });

  // `previewTarget` is the literal loopback (host, port) an agent registered
  // with `botmux preview <port>`; the dashboard proxy dials it by host/port
  // alone. A closed session owns no port any more, and the OS may hand that
  // number to an unrelated local server — so it must not survive in the row.
  it('clears the registered preview target from the closed row data', () => {
    const session = createSession('chat1', 'root1', 'Close Preview');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);

    closeSession(session.sessionId);

    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.previewTarget).toBeUndefined();

    // Atomic with status='closed': neither the parsed row nor the raw file
    // (read by offline/cross-store row readers) may still carry the target.
    init();
    expect(getSession(session.sessionId)?.previewTarget).toBeUndefined();
    const persisted = readPersistedRows(tempDir)[session.sessionId];
    expect(persisted.previewTarget).toBeUndefined();
    const raw = JSON.stringify(persisted);
    expect(raw).not.toContain('previewTarget');
    expect(raw).not.toContain('4173');
  });

  it('keeps the preview target in memory when the atomic close save fails', () => {
    const session = createSession('chat1', 'root1', 'Close Preview Save Failure');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(session.sessionId))
      .toThrow(/simulated session repair write failure/);

    // The close did not happen, so the still-active session keeps proxying its
    // own live port — rollback must restore the field with the rest of the row.
    expect(getSession(session.sessionId)).toMatchObject({ status: 'active' });
    expect(getSession(session.sessionId)?.previewTarget).toEqual({
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it('parks an uncancellable mojo lineage in the same transaction as the close', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Park');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-1';
    updateSession(session);

    closeSession(session.sessionId, {
      parkMojoLineage: 'mojo-sid-1',
      clearRiffParentTaskId: true,
    });

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      mojoQuarantinedLineage: 'mojo-sid-1',
      mojoQuarantineNoticePending: true,
    });
    // The active slot is cleared in the same write; the parked slot is the handle.
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('keeps BOTH ids when a different lineage was already parked', () => {
    // Each id is the only handle left for manual cleanup of its own remote
    // session, so the second must not overwrite the first.
    const session = createSession('chat1', 'root1', 'Close Mojo Park Merge');
    session.backendType = 'mojo';
    session.mojoQuarantinedLineage = 'mojo-old';
    session.riffParentTaskId = 'mojo-new';
    updateSession(session);

    closeSession(session.sessionId, {
      parkMojoLineage: 'mojo-new',
      clearRiffParentTaskId: true,
    });

    expect(getSession(session.sessionId)?.mojoQuarantinedLineage).toBe('mojo-old,mojo-new');
  });

  it('restores the mojo park fields when the atomic save fails', () => {
    // The rollback is the whole point of doing the park inside this transaction:
    // a FAILED close must not leave the row parked, or the next turn treats a
    // still-live remote session as quarantined and silently starts a new one.
    const session = createSession('chat1', 'root1', 'Close Mojo Save Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-retry';
    updateSession(session);
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { parkMojoLineage: 'mojo-sid-retry', clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);

    const inMemory = getSession(session.sessionId);
    expect(inMemory).toMatchObject({ status: 'active', riffParentTaskId: 'mojo-sid-retry' });
    expect(inMemory?.mojoQuarantinedLineage).toBeUndefined();
    expect(inMemory?.mojoQuarantineNoticePending).toBeUndefined();

    // ...and the same must be true of what is actually on disk.
    __testOnly_setBeforeRowPersist(undefined);
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded).toMatchObject({ status: 'active', riffParentTaskId: 'mojo-sid-retry' });
    expect(reloaded?.mojoQuarantinedLineage).toBeUndefined();
    expect(reloaded?.mojoQuarantineNoticePending).toBeUndefined();
  });

  it('journals Mojo prepare/proof and clears it atomically with close', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Journal');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);

    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });
    markMojoClosePrepared(session.sessionId, 'request-1', 'mojo-sid-journal');
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      taskId: 'mojo-sid-journal',
    });

    closeSession(session.sessionId, { clearRiffParentTaskId: true });
    init();
    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('never accepts a Mojo close journal as authority for another backend', () => {
    const session = createSession('chat1', 'root1', 'Non Mojo Journal');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task';
    updateSession(session);

    expect(() => beginMojoCloseJournal(
      session.sessionId,
      'request-1',
      'riff-task',
    )).toThrow(/non-Mojo session/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      backendType: 'riff',
      riffParentTaskId: 'riff-task',
    });
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('keeps a prepared Mojo journal in memory and on disk when close commit fails', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Journal Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    markMojoClosePrepared(session.sessionId, 'request-1', 'mojo-sid-journal');
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-journal',
      mojoCloseJournal: { phase: 'prepared', requestId: 'request-1' },
    });

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-journal',
      mojoCloseJournal: { phase: 'prepared', requestId: 'request-1' },
    });
  });

  it('rolls back a failed journal transition without publishing false proof', () => {
    const session = createSession('chat1', 'root1', 'Mojo Journal Transition Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => markMojoClosePrepared(
      session.sessionId,
      'request-1',
      'mojo-sid-journal',
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });
  });

  it('never rewrites a prepared proof to a different remote lineage', () => {
    const session = createSession('chat1', 'root1', 'Mojo Journal Lineage CAS');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-original';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-original');

    expect(() => markMojoClosePrepared(
      session.sessionId,
      'request-1',
      'mojo-different',
    )).toThrow(/journal lineage/);
    expect(getSession(session.sessionId)).toMatchObject({
      riffParentTaskId: 'mojo-original',
      mojoCloseJournal: {
        phase: 'preparing',
        requestId: 'request-1',
        taskId: 'mojo-original',
      },
    });
  });

  it('clears a failed prepare only after admission restore, otherwise persists uncertainty', () => {
    const session = createSession('chat1', 'root1', 'Abort Mojo Journal');
    session.backendType = 'mojo';
    updateSession(session);

    beginMojoCloseJournal(session.sessionId, 'request-1');
    finishMojoCloseAbort(session.sessionId, 'request-1', {
      admissionRestored: false,
      taskId: 'mojo-late-id',
    });
    expect(getSession(session.sessionId)).toMatchObject({
      riffParentTaskId: 'mojo-late-id',
      mojoCloseJournal: { phase: 'uncertain', taskId: 'mojo-late-id' },
    });

    finishMojoCloseAbort(session.sessionId, 'request-1', {
      admissionRestored: true,
      taskId: 'mojo-late-id',
    });
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
    expect(getSession(session.sessionId)?.riffParentTaskId).toBe('mojo-late-id');
  });

  it('should call deleteFrozenCards with the sessionId', () => {
    const session = createSession('chat1', 'root1', 'Frozen');
    closeSession(session.sessionId);
    expect(mockDeleteFrozenCards).toHaveBeenCalledWith(session.sessionId);
  });

  it('should be a no-op for a non-existent sessionId', () => {
    // Should not throw
    closeSession('nonexistent-id');
    expect(mockDeleteFrozenCards).not.toHaveBeenCalled();
  });

  it('should handle double close without error', () => {
    const session = createSession('chat1', 'root1', 'Double Close');
    closeSession(session.sessionId);
    const firstClosedAt = getSession(session.sessionId)!.closedAt;

    // Close again
    closeSession(session.sessionId);
    const secondClosedAt = getSession(session.sessionId)!.closedAt;

    // Re-close is a noop: original closedAt is kept.
    expect(secondClosedAt).toBe(firstClosedAt);
    expect(getSession(session.sessionId)!.status).toBe('closed');
  });

  it('parks a residual on an already-closed row without refreshing closedAt', () => {
    const session = createSession('chat1', 'root1', 'Reclose Park Residual');
    closeSession(session.sessionId);
    const firstClosedAt = getSession(session.sessionId)!.closedAt;

    closeSession(session.sessionId, {
      parkLocalResidual: 'local_subtree_boundary_unproven',
      parkMojoLineage: 'mojo-late',
    });

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      closedAt: firstClosedAt,
      mojoLocalResidual: 'local_subtree_boundary_unproven',
      mojoQuarantinedLineage: 'mojo-late',
      mojoQuarantineNoticePending: true,
    });
  });
});

describe('reactivateClosedSession()', () => {
  it.each(['awaiting_classification', 'terminal_notice_pending'] as const)(
    'does not revive %s XPI work left on a legacy closed row', (phase) => {
      const session = createSession('chat-xpi-resume', 'root-xpi-resume', 'Legacy Closed XPI');
      closeSession(session.sessionId);
      // Older builds persisted this queue on close; resume skips applyClose.
      const legacy = getSession(session.sessionId)!;
      legacy.crossPrincipalInterruptions = [{
        version: 1, id: 'xpi_legacy', ownerTurnId: 'om_owner', phase,
        owner: { requestUserOpenId: 'ou_owner', senderType: 'user' },
        proposer: { requestUserOpenId: 'ou_peer', senderType: 'user' },
        messages: [{ turnId: 'om_legacy', text: 'legacy input', userPrompt: 'legacy input', createdAt: legacy.createdAt }],
      }];
      updateSession(legacy);
      init();

      const result = reactivateClosedSession(session.sessionId);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.session.crossPrincipalInterruptions).toBeUndefined();

      init();
      const reloaded = getSession(session.sessionId)!;
      expect(reloaded.status).toBe('active');
      expect(reloaded.crossPrincipalInterruptions).toBeUndefined();
    },
  );

  it('sanitizes queued/setup state left on a legacy closed row', () => {
    const session = createSession('chat1', 'root1', 'Legacy Closed Queue');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.queued = true;
    legacy.queuedPrompt = 'legacy backlog';
    legacy.pendingRepoSetup = { mode: 'picker', prompt: 'legacy picker' };
    legacy.queuedActivationPending = true;
    legacy.queuedActivationToken = 'legacy-token';
    legacy.queuedActivationInput = { content: 'legacy head' };
    legacy.queuedActivationTail = [{
      id: 'legacy-tail', order: 1, userPrompt: 'tail', cliInput: { content: 'legacy tail' }, turnId: 'tail-turn',
    }];
    legacy.queuedActivationTailNextOrder = 2;
    legacy.principalLaneQueuedTurns = [{
      version: 1,
      turnId: 'legacy-lane-tail',
      caller: { requestUserOpenId: 'ou_b', senderType: 'user' },
      userPrompt: 'legacy lane tail',
      title: 'legacy lane tail',
      cliInput: { content: 'legacy lane tail' },
      createdAt: '2026-01-01T00:00:00.000Z',
      resume: true,
      dispatchState: 'attempting',
    }];
    updateSession(legacy);

    const result = reactivateClosedSession(session.sessionId);
    expect(result.ok).toBe(true);
    init();

    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.status).toBe('active');
    expect(reloaded.closedAt).toBeUndefined();
    expect(reloaded.queued).toBeUndefined();
    expect(reloaded.pendingRepoSetup).toBeUndefined();
    expect(reloaded.queuedActivationPending).toBeUndefined();
    expect(reloaded.queuedActivationToken).toBeUndefined();
    expect(reloaded.queuedActivationInput).toBeUndefined();
    expect(reloaded.queuedActivationTail).toBeUndefined();
    expect(reloaded.principalLaneQueuedTurns).toBeUndefined();
  });

  it('does not revive a preview target left on a legacy closed row', () => {
    const session = createSession('chat1', 'root1', 'Legacy Closed Preview');
    closeSession(session.sessionId);
    // Rows closed by a build older than the close-path cleanup still carry the
    // target on disk. Resume starts a new worker generation that has registered
    // no port, so reactivation must not hand the proxy the old host/port.
    const legacy = getSession(session.sessionId)!;
    legacy.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(legacy);

    const result = reactivateClosedSession(session.sessionId);
    expect(result.ok).toBe(true);

    init();
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.status).toBe('active');
    expect(reloaded.previewTarget).toBeUndefined();
  });

  it('clears a closed token usage snapshot when starting a new lifecycle', () => {
    const session = createSession('chat1', 'root1', 'Legacy Closed Usage');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.tokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'closed-lifecycle',
    };
    updateSession(legacy);

    const result = reactivateClosedSession(session.sessionId);
    expect(result.ok).toBe(true);

    init();
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.status).toBe('active');
    expect(reloaded.closedAt).toBeUndefined();
    expect(reloaded.tokenUsage).toBeUndefined();
  });

  it('restores token usage if reactivation persistence fails', () => {
    const existingTokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'closed-lifecycle',
    };
    const session = createSession('chat1', 'root1', 'Legacy Closed Usage Rollback');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.tokenUsage = existingTokenUsage;
    updateSession(legacy);
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated reactivate write failure'); });

    expect(() => reactivateClosedSession(session.sessionId)).toThrow(/simulated reactivate write failure/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: existingTokenUsage,
    });

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: existingTokenUsage,
    });
  });

  it('does not carry a previous lifecycle token snapshot into a second close', () => {
    const session = createSession('chat1', 'root1', 'Second Lifecycle Usage');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.tokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'closed-lifecycle',
    };
    updateSession(legacy);

    expect(reactivateClosedSession(session.sessionId).ok).toBe(true);
    costCalculatorMock.getSessionTokenUsage.mockReturnValue(null);
    closeSession(session.sessionId);

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: null,
    });
  });

  it('does not restore a previous lifecycle token snapshot when the second close scan throws', () => {
    const session = createSession('chat1', 'root1', 'Second Lifecycle Throwing Usage');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.tokenUsage = {
      in: 20,
      out: 5,
      inputTokens: 18,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'closed-lifecycle',
    };
    updateSession(legacy);

    expect(reactivateClosedSession(session.sessionId).ok).toBe(true);
    costCalculatorMock.getSessionTokenUsage.mockImplementation(() => {
      throw new Error('new lifecycle transcript unavailable');
    });
    closeSession(session.sessionId);

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      tokenUsage: null,
    });
  });
});

// ─── updateSession() ─────────────────────────────────────────────────────

describe('updateSession()', () => {
  it('should update a session in place', () => {
    const session = createSession('chat1', 'root1', 'Original');
    session.title = 'Updated Title';
    session.workingDir = '/tmp/work';
    updateSession(session);

    const found = getSession(session.sessionId);
    expect(found!.title).toBe('Updated Title');
    expect(found!.workingDir).toBe('/tmp/work');
  });

  it('should persist updates to disk', () => {
    const session = createSession('chat1', 'root1', 'Will Update');
    session.webPort = 9999;
    updateSession(session);

    // Re-init to reload from disk
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded!.webPort).toBe(9999);
  });

  it('persists the explicitly registered preview target across a store restart', () => {
    const session = createSession('chat1', 'root1', 'Preview target');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);

    init();
    expect(getSession(session.sessionId)?.previewTarget).toEqual({
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it('skips the disk write when an update produces byte-identical content', () => {
    // 行级写落在 WAL（append-only），每次 REAL write 都让 sessions.db-wal 变长；
    // 被跳过的冗余写不开事务，WAL 长度保持不变。
    const walFp = join(tempDir, 'sessions.db-wal');
    const session = createSession('chat1', 'root1', 'NoChange');
    const walAfterCreate = statSync(walFp).size;

    // A redundant update with no field change → must be skipped (WAL stable).
    updateSession(session);
    expect(statSync(walFp).size).toBe(walAfterCreate);
    updateSession(session); // and again — still no write
    expect(statSync(walFp).size).toBe(walAfterCreate);

    // A real change → the row is rewritten (WAL grows).
    session.title = 'Changed';
    updateSession(session);
    expect(statSync(walFp).size).toBeGreaterThan(walAfterCreate);

    // Content is still correct after the skip/write sequence.
    init();
    expect(getSession(session.sessionId)!.title).toBe('Changed');
  });

  it('should allow adding a new session via updateSession', () => {
    const newSession = {
      sessionId: 'manual-id',
      chatId: 'chat-x',
      rootMessageId: 'root-x',
      title: 'Manually Added',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    };
    updateSession(newSession);

    const found = getSession('manual-id');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Manually Added');
  });
});

// ─── updateSessionPid() ──────────────────────────────────────────────────

describe('updateSessionPid()', () => {
  it('should set the pid on a session', () => {
    const session = createSession('chat1', 'root1', 'PID Test');
    updateSessionPid(session.sessionId, 12345);

    const found = getSession(session.sessionId);
    expect(found!.pid).toBe(12345);
  });

  it('should clear the pid when passed null', () => {
    const session = createSession('chat1', 'root1', 'PID Clear');
    updateSessionPid(session.sessionId, 42);
    updateSessionPid(session.sessionId, null);

    const found = getSession(session.sessionId);
    expect(found!.pid).toBeUndefined();
  });

  it('should be a no-op for a non-existent sessionId', () => {
    // Should not throw
    updateSessionPid('nonexistent-id', 123);
  });
});

// ─── Multi-bot isolation (appId scoping) ─────────────────────────────────

describe('Multi-bot isolation', () => {
  it('should store sessions in separate files per appId', () => {
    init('app-alpha');
    createSession('c1', 'r1', 'Alpha Session');

    init('app-beta');
    createSession('c2', 'r2', 'Beta Session');

    expect(persistedStoreExists(tempDir, 'app-alpha')).toBe(true);
    expect(persistedStoreExists(tempDir, 'app-beta')).toBe(true);
  });

  it('should only list sessions belonging to the current appId', () => {
    init('app-alpha');
    createSession('c1', 'r1', 'Alpha 1');
    createSession('c1', 'r1', 'Alpha 2');

    init('app-beta');
    createSession('c2', 'r2', 'Beta 1');

    // Only beta sessions should be visible
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0].title).toBe('Beta 1');

    // Switch back to alpha
    init('app-alpha');
    expect(listSessions()).toHaveLength(2);
  });

  it('should use legacy sessions.json when no appId is set', () => {
    init();
    createSession('c1', 'r1', 'Legacy');
    expect(persistedStoreExists(tempDir)).toBe(true);
    expect(readPersistedRows(tempDir)).not.toEqual({});
  });

  it('should migrate matching sessions from legacy file to per-bot file', () => {
    // Write a legacy sessions.json with sessions from two different apps
    mkdirSync(tempDir, { recursive: true });
    const legacyData = {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r1',
        title: 'App A Session',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: 'app-A',
      },
      s2: {
        sessionId: 's2',
        chatId: 'c2',
        rootMessageId: 'r2',
        title: 'App B Session',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: 'app-B',
      },
    };
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify(legacyData));

    // Init with app-A; should migrate only app-A sessions
    init('app-A');
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('App A Session');
    expect(persistedStoreExists(tempDir, 'app-A')).toBe(true);
  });
});

// ─── findActiveSessionsByRoot() — cross-bot lookup ───────────────────────

describe('findActiveSessionsByWorkingDirStrict()', () => {
  it('finds active sessions across stores by canonical worktree path', () => {
    const worktree = join(tempDir, 'repo-wt');
    const nested = join(worktree, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    const alias = nested;

    init('app-A');
    const sA = createSession('chat1', 'root-a', 'Bot A');
    sA.workingDir = alias;
    sA.larkAppId = 'app-A';
    updateSession(sA);

    init('app-B');
    const sB = createSession('chat1', 'root-b', 'Bot B');
    sB.workingDir = worktree;
    sB.larkAppId = 'app-B';
    updateSession(sB);

    const found = findActiveSessionsByWorkingDirStrict(worktree);
    expect(found.map(s => s.sessionId).sort()).toEqual([sA.sessionId, sB.sessionId].sort());
  });

  it('fails closed when the cross-store inventory cannot be enumerated', () => {
    init('app-A');
    fsControl.failReaddir = true;

    expect(() => findActiveSessionsByWorkingDirStrict(tempDir))
      .toThrow(/simulated readdir denial/);
  });

  it('fails closed when another legacy JSON store has a malformed active row', () => {
    init('app-B');
    writeFileSync(join(tempDir, 'sessions-app-A.json'), JSON.stringify({
      broken: { status: 'active', workingDir: tempDir },
    }));

    expect(() => findActiveSessionsByWorkingDirStrict(tempDir))
      .toThrow(/malformed active session row/i);
  });

  it('fails closed when another SQLite store has a malformed active row', () => {
    init('app-A');
    const session = createSession('chat1', 'root-a', 'Bot A');
    const dbPath = persistedStorePath(tempDir, 'app-A');
    expect(dbPath?.endsWith('.db')).toBe(true);
    const db = new DatabaseSync(dbPath!);
    try {
      db.prepare("UPDATE sessions SET row = ? WHERE session_id = ?")
        .run('{}', session.sessionId);
    } finally {
      db.close();
    }

    init('app-B');

    expect(() => findActiveSessionsByWorkingDirStrict(tempDir))
      .toThrow(/malformed active session row/i);
  });
});

describe('findActiveSessionsByRoot()', () => {
  it('finds active sessions across per-bot files for the same rootMessageId', () => {
    // Bot A pins workdir for thread root-x
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Bot A');
    sA.workingDir = '/repo/foo';
    sA.larkAppId = 'app-A';
    updateSession(sA);

    // Bot B pins different workdir for the same thread
    init('app-B');
    const sB = createSession('chat1', 'root-x', 'Bot B');
    sB.workingDir = '/repo/bar';
    sB.larkAppId = 'app-B';
    updateSession(sB);

    // From Bot C's perspective, both peers should be visible
    init('app-C');
    const found = findActiveSessionsByRoot('root-x');
    expect(found.map(s => s.sessionId).sort()).toEqual([sA.sessionId, sB.sessionId].sort());
    expect(found.find(s => s.sessionId === sA.sessionId)?.workingDir).toBe('/repo/foo');
    expect(found.find(s => s.sessionId === sB.sessionId)?.workingDir).toBe('/repo/bar');
  });

  it('skips closed sessions', () => {
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Bot A');
    closeSession(sA.sessionId);

    init('app-B');
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toEqual([]);
  });

  it('skips sessions for unrelated threads', () => {
    init('app-A');
    createSession('chat1', 'root-x', 'Match');
    createSession('chat1', 'root-y', 'No Match');

    init('app-B');
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('Match');
  });

  it('also returns sessions from the current bot file', () => {
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Self');
    // Don't switch — stay on app-A
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe(sA.sessionId);
  });

  it('returns empty when no session matches the root', () => {
    init('app-A');
    createSession('chat1', 'root-x', 'A');
    init('app-B');
    expect(findActiveSessionsByRoot('root-nonexistent')).toEqual([]);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('should handle corrupted JSON gracefully', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), 'NOT VALID JSON!!!');

    init();
    // Should not throw, should start with empty sessions
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('should survive multiple inits without data loss (same appId)', () => {
    init();
    createSession('c1', 'r1', 'First');
    createSession('c2', 'r2', 'Second');

    init(); // re-init loads from disk
    expect(listSessions()).toHaveLength(2);
  });

  it('should handle atomic writes (tmp file rename)', () => {
    const session = createSession('c1', 'r1', 'Atomic');
    // The .tmp file should not persist after save
    const tmpFp = join(tempDir, 'sessions.json.tmp');
    expect(existsSync(tmpFp)).toBe(false);
  });
});

// ─── legacy field sanitization ───────────────────────────────────────────────

describe('import-time convergence', () => {
  it('strips pendingResponseCard* fields while importing, so no written row carries them', () => {
    // A session persisted before the「处理中」placeholder card was removed still
    // carries the three legacy fields. The import drops them once; nothing can
    // reintroduce them (the fields no longer exist on `Session`), which is why
    // the write paths no longer re-check.
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify({
      s1: {
        sessionId: 's1', chatId: 'c1', rootMessageId: 'r1', title: 'Legacy',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        pendingResponseCardId: 'om_old', pendingResponseCardState: 'open',
        lastPatchedResponseCardId: 'om_prev',
      },
    }));

    init();
    const loaded = getSession('s1')!;
    updateSession({ ...loaded, title: 'Touched' });

    const onDisk = readPersistedRows(tempDir);
    expect(onDisk.s1.title).toBe('Touched');
    expect(onDisk.s1).not.toHaveProperty('pendingResponseCardId');
    expect(onDisk.s1).not.toHaveProperty('pendingResponseCardState');
    expect(onDisk.s1).not.toHaveProperty('lastPatchedResponseCardId');
  });

  it('never lets a duplicate-sessionId ghost overwrite the live row', () => {
    // Two entries can carry the SAME sessionId under different file keys.
    // Importing under `row.sessionId` would collapse them and let whichever
    // comes last win — a stale closed ghost silently replacing the live row,
    // irreversibly (the import runs once, the JSON is frozen afterwards).
    // Rows are imported under their own file key; a mis-keyed row stays inert.
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify({
      realId: {
        sessionId: 'realId', chatId: 'c1', rootMessageId: 'r1', title: 'CURRENT',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
      },
      wrongKey: {
        sessionId: 'realId', chatId: 'c1', rootMessageId: 'r1', title: 'STALE-DUP',
        status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
      },
    }));

    init();
    expect(getSession('realId')?.title).toBe('CURRENT');
    expect(getSession('realId')?.status).toBe('active');
    const onDisk = readPersistedRows(tempDir);
    expect(onDisk.realId.title).toBe('CURRENT');
    expect(onDisk.wrongKey.title).toBe('STALE-DUP');
  });
});

// ─── cross-process offline access ────────────────────────────────────────────
// The absorbed CLI-side persistence (formerly cli.ts loadSessions /
// mutateSessionOffline / saveSession) and the daemon/provenance direct reads.

/** Pre-SQLite JSON — an IMPORT SOURCE only; the store never reads it at runtime. */
function seedFile(name: string, rows: Record<string, unknown>): void {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, name), JSON.stringify(rows, null, 2));
}

/** Seed a real store on disk — what "another bot's daemon already wrote" means. */
function seedStore(appId: string | undefined, rows: Record<string, unknown>): string {
  return seedPersistedSessionRows(tempDir, appId, rows);
}

function row(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, chatId: 'oc_chat', rootMessageId: `om_${sessionId}`, title: sessionId,
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

describe('loadAllSessionsSnapshot()', () => {
  it('merges the legacy store + per-bot stores, per-bot wins duplicates and gets larkAppId stamped', () => {
    seedStore(undefined, {
      legacy1: row('legacy1'),
      dup: row('dup', { title: 'legacy copy' }),
    });
    seedStore('appA', {
      dup: row('dup', { title: 'per-bot copy' }),
      a1: row('a1'),
    });

    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect(snapshot.size).toBe(3);
    expect(snapshot.get('legacy1')?.larkAppId).toBeUndefined();
    expect(snapshot.get('dup')?.title).toBe('per-bot copy');
    expect(snapshot.get('dup')?.larkAppId).toBe('appA');
    expect(snapshot.get('a1')?.larkAppId).toBe('appA');
  });

  it('skips malformed rows', () => {
    seedStore(undefined, {
      broken: { notASession: true },
      ok: row('ok'),
    });
    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect([...snapshot.keys()]).toEqual(['ok']);
  });

  it('falls back to the exact per-bot store when the data dir cannot be enumerated', () => {
    seedStore('appB', { b1: row('b1') });
    seedStore('appC', { c1: row('c1') });
    fsControl.failReaddir = true;
    try {
      const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir, fallbackAppId: 'appB' });
      // The sandboxed fallback loads only the injected bot's own store.
      expect([...snapshot.keys()]).toEqual(['b1']);
      expect(snapshot.get('b1')?.larkAppId).toBe('appB');
    } finally {
      fsControl.failReaddir = false;
    }
  });

  it('never creates a store it was only asked to read', () => {
    mkdirSync(tempDir, { recursive: true });
    expect(loadAllSessionsSnapshot({ dataDir: tempDir }).size).toBe(0);
    // A read-write SQLite open would have CREATED this file, and its mere
    // existence disables the owning daemon's one-shot JSON import.
    expect(existsSync(sessionStorePath(tempDir))).toBe(false);
  });

  it('still reads a store whose owning daemon has not imported it yet', () => {
    // Upgrade window: npm already replaced dist and repointed the launcher, but
    // the daemon that owns these rows still runs the pre-SQLite build and keeps
    // writing the JSON. Every live session's `botmux send` resolves itself
    // through here — going db-only would leave the agent unable to reply until
    // someone restarts the daemon, which nothing forces them to do.
    seedFile('sessions-appB.json', { b1: row('b1') });
    seedStore('appA', { a1: row('a1') });
    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect([...snapshot.keys()].sort()).toEqual(['a1', 'b1']);
    expect(snapshot.get('b1')?.larkAppId).toBe('appB');
  });
});

describe('readSessionRowFromDisk()', () => {
  it('prefers the owning per-bot store and falls back to legacy', () => {
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    seedStore('appA', { s1: row('s1', { title: 'per-bot' }) });
    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.title).toBe('per-bot');
    expect(readSessionRowFromDisk('s1', 'appMissing', tempDir)?.title).toBe('legacy');
    expect(readSessionRowFromDisk('s1', undefined, tempDir)?.title).toBe('legacy');
    expect(readSessionRowFromDisk('nope', 'appA', tempDir)).toBeUndefined();
  });

  it('skips a corrupt per-bot store and still reads the legacy copy', () => {
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'), 'not a database');
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.title).toBe('legacy');
  });
});

describe('readSessionRowCopiesAcrossStores()', () => {
  it('returns one entry per store that holds the id', () => {
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    seedStore('appA', { s1: row('s1', { title: 'per-bot' }) });
    seedStore('appB', { other: row('other') });
    const copies = readSessionRowCopiesAcrossStores('s1', tempDir);
    expect(copies.map(c => c.title).sort()).toEqual(['legacy', 'per-bot']);
    expect(readSessionRowCopiesAcrossStores('other', tempDir)).toHaveLength(1);
    expect(readSessionRowCopiesAcrossStores('missing', tempDir)).toHaveLength(0);
  });

  it('skips corrupt stores and key-mismatched rows without failing the scan', () => {
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'), 'not a database');
    seedStore('appB', { s1: row('someOtherId') }); // key ≠ row.sessionId
    seedStore(undefined, { s1: row('s1') });
    const copies = readSessionRowCopiesAcrossStores('s1', tempDir);
    expect(copies).toHaveLength(1);
  });

  it('a frozen pre-SQLite JSON is not a second copy of an imported store', () => {
    // The identity scan authorises only when a row resolves EXACTLY once. The
    // frozen import source must not read as a second store, or every migrated
    // session would be refused as ambiguous.
    seedFile('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions(); // import → .db, JSON frozen in place
    init();
    expect(readSessionRowCopiesAcrossStores('s1', tempDir)).toHaveLength(1);
  });

  it('throws when the data dir itself cannot be listed (fail-closed identity scan)', () => {
    expect(() => readSessionRowCopiesAcrossStores('s1', join(tempDir, 'no-such-dir')))
      .toThrow();
  });
});

describe('applySessionCommandUnowned() / readSessionRowUnowned()', () => {
  it('applies the command to the FRESH on-disk row, never the caller snapshot (stale-clobber regression)', () => {
    // The row gained a newer field on disk after the caller took its snapshot.
    // The old cli.ts saveSession() would have written the stale snapshot back,
    // erasing workerGeneration; the exclusive row apply must preserve it.
    seedStore('appA', { s1: row('s1', { workerGeneration: 7, larkAppId: 'appA' }) });

    const published = applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir },
    );

    expect(published).toMatchObject({ outcome: 'applied', row: { status: 'closed', workerGeneration: 7 } });
    const onDisk = readPersistedSessionRows(tempDir, 'appA');
    expect(onDisk.s1.status).toBe('closed');
    expect(onDisk.s1.closedAt).toBeTruthy();
    expect(onDisk.s1.workerGeneration).toBe(7);
  });

  it('reads the fresh row without writing', () => {
    seedStore('appA', { s1: row('s1', { larkAppId: 'appA' }) });
    const read = readSessionRowUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { dataDir: tempDir },
    );
    expect(read).toMatchObject({ outcome: 'ok', row: { sessionId: 's1', status: 'active' } });
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('a re-applied close is a noop that keeps the original closedAt', () => {
    seedStore('appA', { s1: row('s1', { larkAppId: 'appA', status: 'closed', closedAt: '2026-08-13T00:00:00.000Z' }) });
    const result = applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir },
    );
    expect(result).toMatchObject({ outcome: 'noop', row: { status: 'closed', closedAt: '2026-08-13T00:00:00.000Z' } });
    expect(readPersistedSessionRows(tempDir, 'appA').s1.closedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('refuses with row_changed when the adoption precondition no longer holds', () => {
    seedStore('appA', { s1: row('s1', { larkAppId: 'appA', adoptedFrom: { source: 'tmux', tmuxTarget: 'u:1.0' } }) });
    const result = applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir, expectAdopted: false },
    );
    expect(result).toMatchObject({ outcome: 'refused', reason: 'row_changed' });
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('reports missing for an absent row', () => {
    seedStore('appA', { s1: row('s1') });
    expect(applySessionCommandUnowned(
      { sessionId: 'ghost', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir },
    )).toEqual({ outcome: 'missing' });
    expect(readSessionRowUnowned(
      { sessionId: 'ghost', larkAppId: 'appA' },
      { dataDir: tempDir },
    )).toEqual({ outcome: 'missing' });
  });

  it('yields owned untouched when abortIf trips at entry — for the read as well as the apply', () => {
    seedStore('appA', { s1: row('s1') });
    expect(applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir, abortIf: () => true },
    )).toEqual({ outcome: 'owned' });
    expect(readSessionRowUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { dataDir: tempDir, abortIf: () => true },
    )).toEqual({ outcome: 'owned' });
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('re-checks abortIf immediately before publication and leaves the row untouched', () => {
    // A daemon that appears during the read/decision phase becomes
    // authoritative — the second probe must catch it. SQLite's own locking
    // orders writers but cannot see a daemon holding a stale in-memory cache.
    seedStore('appA', { s1: row('s1') });
    let probes = 0;
    const result = applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir, abortIf: () => ++probes > 1 },
    );
    expect(result).toEqual({ outcome: 'owned' });
    expect(probes).toBe(2);
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('targets the legacy store when the row carries no larkAppId', () => {
    seedStore(undefined, { s1: row('s1') });
    const published = applySessionCommandUnowned(
      { sessionId: 's1' },
      { type: 'close' },
      { dataDir: tempDir },
    );
    expect(published).toMatchObject({ outcome: 'applied', row: { status: 'closed' } });
    expect(readPersistedSessionRows(tempDir).s1.status).toBe('closed');
  });

  it('never creates the store — an empty one would disable the daemon import gate', () => {
    // A read-write SQLite open CREATES the file. If an offline write planted an
    // empty store here, the owning daemon's `existsSync(db)` gate would skip
    // the one-shot JSON import and silently discard every pre-SQLite row.
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    expect(applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir },
    )).toEqual({ outcome: 'missing' });
    expect(existsSync(sessionStorePath(tempDir, 'appA'))).toBe(false);
  });

  it('writes the JSON store while its owning daemon has not imported it yet', () => {
    // Upgrade window: the pre-SQLite daemon still owns these rows and reads the
    // JSON, so an offline close has to land there. Creating a .db here would
    // fork the two representations behind that daemon's back — and the empty
    // store would also disable its one-shot import gate.
    seedFile('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    const published = applySessionCommandUnowned(
      { sessionId: 's1', larkAppId: 'appA' },
      { type: 'close' },
      { dataDir: tempDir },
    );
    expect(published).toMatchObject({ outcome: 'applied', row: { status: 'closed' } });
    expect(JSON.parse(readFileSync(join(tempDir, 'sessions-appA.json'), 'utf-8')).s1.status).toBe('closed');
    expect(existsSync(sessionStorePath(tempDir, 'appA'))).toBe(false);
  });

  it('reports contended (not missing) when the JSON store file lock is held past its wait', () => {
    seedFile('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    const held = withFileLockSync(
      join(tempDir, 'sessions-appA.json'),
      () => applySessionCommandUnowned(
        { sessionId: 's1', larkAppId: 'appA' },
        { type: 'close' },
        { dataDir: tempDir },
      ),
    );
    expect(held).toEqual({ outcome: 'contended' });
    expect(JSON.parse(readFileSync(join(tempDir, 'sessions-appA.json'), 'utf-8')).s1.status).toBe('active');
  }, 15_000);
});

it('captures group model defaults only for new topics and persists independent snapshots', () => {
  const groups = { oc_a: { codex: 'first', 'claude-code': 'sonnet' }, oc_b: { codex: 'other' } };
  init('model-test', { groupDefaultModels: chatId => groups[chatId as keyof typeof groups] });
  const first = createSession('oc_a', 'root-one', 'one', 'group');
  const other = createSession('oc_b', 'root-two', 'two', 'group');
  groups.oc_a.codex = 'changed';
  const next = createSession('oc_a', 'root-three', 'three', 'group');
  expect(first.groupDefaultModels?.codex).toBe('first');
  expect(other.groupDefaultModels?.codex).toBe('other');
  expect(next.groupDefaultModels?.codex).toBe('changed');
  expect(createSession('oc_a', 'p2p', 'dm', 'p2p').groupDefaultModels).toBeUndefined();
  expect(createSession('oc_a', 'chat', 'chat', 'group', 'chat').groupDefaultModels).toBeUndefined();
  init('model-test');
  expect(getSession(first.sessionId)?.groupDefaultModels).toEqual({ codex: 'first', 'claude-code': 'sonnet' });
  expect(createSession('oc_a', 'legacy', 'no resolver', 'group').groupDefaultModels).toBeUndefined();
});


it('deeply snapshots group model and effort without changing runtime identity', () => {
  const models = {codex:{model:'gpt-5.6-sol',reasoningEffort:'ultra' as const},'claude-code':{model:'sonnet',reasoningEffort:'high' as const}};
  init('effort-test', {groupDefaultModels:()=>models});
  const session=createSession('oc_group','root-effort','effort','group');
  expect(session.reasoningEffort).toBeUndefined();
  expect(session.cliId).toBeUndefined();
  models.codex.model='changed';
  expect(session.groupDefaultModels?.codex).toEqual({model:'gpt-5.6-sol',reasoningEffort:'ultra'});
  init('effort-test');
  expect(getSession(session.sessionId)?.groupDefaultModels?.codex).toEqual({model:'gpt-5.6-sol',reasoningEffort:'ultra'});
});
