import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot-registry.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import {
  commitLegacyWorkflowMigration,
  LegacyWorkflowConversionError,
  LegacyWorkflowMigrationConflictError,
  type LegacyMigrationCommitPhase,
} from '../src/workflows/migration/v2-migration-service.js';
import {
  commitLegacyMigration,
  computeLegacyConversionHash,
  findLegacyMigration,
  legacyDefinitionIdentity,
  migratedSavedWorkflowId,
  prepareLegacyMigration,
  readLegacyMigrationLedger,
} from '../src/workflows/migration/v2-ledger.js';
import { convertLegacyWorkflowDefinition } from '../src/workflows/migration/v2-to-v3.js';
import {
  SavedWorkflowNotFoundError,
  appendSavedWorkflowRevision,
  createSavedWorkflow,
  loadCurrentSavedWorkflow,
  readSavedWorkflowRevision,
} from '../src/workflows/v3/library-store.js';

const BOT: BotConfig = {
  larkAppId: 'cli_goal',
  larkAppSecret: 'secret',
  cliId: 'codex',
  workingDir: '/repo',
};
const OWNER = { openId: 'ou_owner', larkAppId: 'cli_owner' };

function definition(version = 1, prompt = 'write report'): WorkflowDefinition {
  return {
    workflowId: 'legacy-report',
    version,
    nodes: {
      work: { type: 'subagent', bot: BOT.larkAppId, prompt },
    },
  };
}

describe('v2 migration commit service', () => {
  let root: string;
  let dataDir: string;
  let sourcePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v2-migrate-service-'));
    dataDir = join(root, 'data');
    sourcePath = join(root, 'legacy-report.workflow.json');
    writeFileSync(sourcePath, JSON.stringify(definition()), 'utf-8');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function commit(overrides: Partial<Parameters<typeof commitLegacyWorkflowMigration>[0]> = {}) {
    return commitLegacyWorkflowMigration({
      dataDir,
      sourcePath,
      bots: [BOT],
      owner: OWNER,
      scope: { kind: 'global' },
      now: new Date('2026-07-11T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('creates one published target and replays idempotently', async () => {
    const first = await commit();
    expect(first.createdWorkflow).toBe(true);
    expect(first.appendedRevision).toBe(false);
    expect(first.revisionRecord.state).toBe('committed');
    expect(first.metadata.status).toBe('active');
    expect(first.metadata.publishedRevision).toBe(first.revision.revisionId);
    expect(first.revision.payload.humanVersion).toBe(1);

    const second = await commit({ now: new Date('2026-07-12T00:00:00.000Z') });
    expect(second.metadata.workflowId).toBe(first.metadata.workflowId);
    expect(second.revision.revisionId).toBe(first.revision.revisionId);
    expect(second.createdWorkflow).toBe(false);
    expect(second.appendedRevision).toBe(false);
    expect(Object.keys(readLegacyMigrationLedger(dataDir).sources)).toHaveLength(1);

    writeFileSync(sourcePath, `${JSON.stringify(definition(), null, 2)}\n`, 'utf-8');
    const whitespaceOnly = await commit({ now: new Date('2026-07-14T00:00:00.000Z') });
    expect(whitespaceOnly.revision.revisionId).toBe(first.revision.revisionId);
    expect(whitespaceOnly.appendedRevision).toBe(false);
  });

  it('appends a changed legacy revision to the same Saved Workflow', async () => {
    const first = await commit();
    const nextDef = definition(2, 'write a better report');
    writeFileSync(sourcePath, JSON.stringify(nextDef), 'utf-8');
    const second = await commit({ now: new Date('2026-07-12T00:00:00.000Z') });
    expect(second.metadata.workflowId).toBe(first.metadata.workflowId);
    expect(second.revision.revisionId).not.toBe(first.revision.revisionId);
    expect(second.revision.payload.humanVersion).toBe(2);
    expect(second.appendedRevision).toBe(true);
    const source = Object.values(readLegacyMigrationLedger(dataDir).sources)[0]!;
    expect(Object.keys(source.revisions)).toHaveLength(2);
    expect(Object.values(source.revisions).every((entry) => entry.state === 'committed')).toBe(true);
  });

  for (const phase of ['after-pending', 'after-library-write', 'after-publish'] as const) {
    it(`recovers idempotently after an injected crash ${phase}`, async () => {
      await expect(commit({
        onPhase(current) {
          if (current === phase) throw new Error(`crash:${phase}`);
        },
      })).rejects.toThrow(`crash:${phase}`);

      const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as WorkflowDefinition;
      const identity = legacyDefinitionIdentity(sourcePath, parsed);
      expect(findLegacyMigration(dataDir, identity)).toMatchObject({
        kind: 'exact',
        revision: { state: 'pending' },
      });

      const recovered = await commit({ now: new Date('2026-07-13T00:00:00.000Z') });
      expect(recovered.revisionRecord.state).toBe('committed');
      expect(recovered.metadata.status).toBe('active');
      expect(recovered.metadata.publishedRevision).toBe(recovered.revision.revisionId);
      const current = await loadCurrentSavedWorkflow(dataDir, recovered.metadata.workflowId);
      expect(current.revision.revisionId).toBe(recovered.revision.revisionId);
    });
  }

  it('leaves a fail-closed pending record when source changes before publish', async () => {
    await expect(commit({
      onPhase(phase: LegacyMigrationCommitPhase) {
        if (phase === 'after-library-write') {
          writeFileSync(sourcePath, JSON.stringify(definition(2, 'edited during migration')), 'utf-8');
        }
      },
    })).rejects.toThrow(/changed during migration/);
    const edited = definition(2, 'edited during migration');
    const editedIdentity = legacyDefinitionIdentity(sourcePath, edited);
    expect(findLegacyMigration(dataDir, editedIdentity).kind).toBe('changed_after_migration');
    await expect(commit()).rejects.toThrow(LegacyWorkflowMigrationConflictError);
  });

  it('requires explicit acknowledgement for dropped warning fields', async () => {
    const warned = definition();
    warned.defaults = { maxOutputBytes: 1024 };
    writeFileSync(sourcePath, JSON.stringify(warned), 'utf-8');
    await expect(commit()).rejects.toThrow(LegacyWorkflowConversionError);
    expect(readLegacyMigrationLedger(dataDir).sources).toEqual({});

    const migrated = await commit({ acknowledgeWarnings: true });
    expect(migrated.issues.map((item) => item.code)).toContain('MAX_OUTPUT_BYTES_DROPPED');
  });

  it('never changes the owner/scope of an existing deterministic target', async () => {
    await commit();
    writeFileSync(sourcePath, JSON.stringify(definition(2, 'new revision')), 'utf-8');
    await expect(commit({
      owner: { openId: 'ou_other', larkAppId: 'cli_owner' },
    })).rejects.toThrow(/another owner|different owner|owner, scope/);
  });

  it('never rebuilds a missing target over committed historical revisions', async () => {
    const first = await commit();
    rmSync(join(dataDir, 'workflow-library', first.metadata.workflowId), {
      recursive: true,
      force: true,
    });
    writeFileSync(sourcePath, JSON.stringify(definition(2, 'new revision')), 'utf-8');
    await expect(commit()).rejects.toThrow(/metadata is missing.*prior revisions/);
  });

  it('explicitly supersedes only an unmaterialized stale pending allocation and keeps audit', async () => {
    const first = await commit();
    writeFileSync(sourcePath, JSON.stringify(definition(2, 'migrated second revision')), 'utf-8');
    await expect(commit({
      onPhase(phase) {
        if (phase === 'after-pending') throw new Error('crash-after-pending');
      },
      now: new Date('2026-07-12T00:00:00.000Z'),
    })).rejects.toThrow('crash-after-pending');

    const pendingBefore = Object.values(readLegacyMigrationLedger(dataDir).sources)[0]!
      .revisions[legacyDefinitionIdentity(sourcePath, definition(2, 'migrated second revision')).contentHash]!;
    const current = await loadCurrentSavedWorkflow(dataDir, first.metadata.workflowId);
    await appendSavedWorkflowRevision(dataDir, first.metadata.workflowId, {
      actor: OWNER,
      revision: {
        inputs: current.revision.payload.inputs,
        contextRefs: current.revision.payload.contextRefs,
        specTemplate: { ...current.revision.payload.specTemplate, title: 'owner edit' },
        specStatus: current.revision.payload.specStatus,
        dagTemplate: current.revision.payload.dagTemplate,
        safety: current.revision.payload.safety,
      },
      publish: true,
      expectedLatestRevision: current.metadata.latestRevision,
      now: new Date('2026-07-12T01:00:00.000Z'),
    });

    await expect(commit({ now: new Date('2026-07-12T02:00:00.000Z') }))
      .rejects.toThrow(/--supersede-pending/);
    const recovered = await commit({
      supersedePending: true,
      now: new Date('2026-07-12T03:00:00.000Z'),
    });
    expect(recovered.revisionRecord.state).toBe('committed');
    expect(recovered.revisionRecord.supersededAllocations).toMatchObject([{
      targetRevisionId: pendingBefore.targetRevisionId,
      reason: 'target_latest_changed_before_materialization',
    }]);
    expect(recovered.revision.payload.humanVersion).toBe(3);
    await expect(readSavedWorkflowRevision(
      dataDir,
      first.metadata.workflowId,
      pendingBefore.targetRevisionId,
    )).rejects.toBeInstanceOf(SavedWorkflowNotFoundError);
  });

  it('verifies a committed target against its ledger instead of rejecting converter drift', async () => {
    const parsed = definition();
    const identity = legacyDefinitionIdentity(sourcePath, parsed);
    const converted = convertLegacyWorkflowDefinition({
      definition: parsed,
      bots: [BOT],
      target: { owner: OWNER, scope: { kind: 'global' } },
    });
    if (!converted.ok) throw new Error('test fixture must convert');
    const historicalDraft = {
      ...converted.revision,
      specTemplate: { ...converted.revision.specTemplate, title: 'historical converter output' },
    };
    const targetWorkflowId = migratedSavedWorkflowId(identity);
    const created = await createSavedWorkflow(dataDir, {
      workflowId: targetWorkflowId,
      displayName: parsed.workflowId,
      owner: OWNER,
      scope: { kind: 'global' },
      revision: historicalDraft,
      publish: true,
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    prepareLegacyMigration(dataDir, {
      identity,
      target: {
        workflowId: targetWorkflowId,
        owner: OWNER,
        scope: { kind: 'global' },
      },
      conversionHash: computeLegacyConversionHash(historicalDraft),
      targetRevisionId: created.revision.revisionId,
      targetHumanVersion: created.revision.payload.humanVersion,
      targetCreatedAt: created.revision.payload.createdAt,
      expectedLatestRevision: created.metadata.latestRevision,
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    commitLegacyMigration(dataDir, identity, new Date('2026-07-10T00:01:00.000Z'));

    const replay = await commit();
    expect(replay.revision.revisionId).toBe(created.revision.revisionId);
    expect(replay.issues).toMatchObject([{
      severity: 'warning',
      code: 'CONVERTER_CHANGED_AFTER_COMMIT',
    }]);
  });
});
