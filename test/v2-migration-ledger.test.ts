import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowDefinition } from '../src/workflows/definition.js';
import {
  commitLegacyMigration,
  computeLegacyConversionHash,
  findLegacyMigration,
  legacyDefinitionIdentity,
  legacyMigrationLedgerPath,
  migratedSavedWorkflowId,
  prepareLegacyMigration,
  readLegacyMigrationLedger,
} from '../src/workflows/migration/v2-ledger.js';

const OWNER = { openId: 'ou_owner', larkAppId: 'cli_owner' };

function definition(version = 1): WorkflowDefinition {
  return {
    workflowId: 'legacy-demo',
    version,
    nodes: {
      work: { type: 'subagent', bot: 'cli_bot', prompt: 'do work' },
    },
  };
}

describe('v2 migration ledger', () => {
  let root: string;
  let dataDir: string;
  let sourcePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-v2-ledger-'));
    dataDir = join(root, 'data');
    sourcePath = join(root, 'legacy-demo.workflow.json');
    writeFileSync(sourcePath, JSON.stringify(definition()), 'utf-8');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function prepare(version = 1) {
    const def = definition(version);
    writeFileSync(sourcePath, JSON.stringify(def), 'utf-8');
    const identity = legacyDefinitionIdentity(sourcePath, def);
    const target = {
      workflowId: migratedSavedWorkflowId(identity),
      owner: OWNER,
      scope: { kind: 'global' as const },
    };
    const prepared = prepareLegacyMigration(dataDir, {
      identity,
      target,
      conversionHash: computeLegacyConversionHash({ version }),
      targetRevisionId: `rev_${String(version).padStart(64, 'a').slice(-64)}`,
      targetHumanVersion: version,
      targetCreatedAt: `2026-07-${String(version).padStart(2, '0')}T00:00:00.000Z`,
      ...(version > 1 ? { expectedLatestRevision: `rev_${'a'.repeat(64)}` } : {}),
      now: new Date(`2026-07-${String(version).padStart(2, '0')}T00:00:00.000Z`),
    });
    return { identity, target, prepared };
  }

  it('binds pending then committed to exact path/id/content and stable target', () => {
    const first = prepare(1);
    expect(findLegacyMigration(dataDir, first.identity)).toMatchObject({
      kind: 'exact',
      revision: { state: 'pending' },
    });

    const committed = commitLegacyMigration(dataDir, first.identity, new Date('2026-07-02T00:00:00.000Z'));
    expect(committed.revision.state).toBe('committed');
    expect(findLegacyMigration(dataDir, first.identity)).toMatchObject({
      kind: 'exact',
      revision: { state: 'committed' },
    });

    const secondDef = definition(2);
    writeFileSync(sourcePath, JSON.stringify(secondDef), 'utf-8');
    const secondIdentity = legacyDefinitionIdentity(sourcePath, secondDef);
    expect(migratedSavedWorkflowId(secondIdentity)).toBe(first.target.workflowId);
    expect(findLegacyMigration(dataDir, secondIdentity)).toMatchObject({
      kind: 'changed_after_migration',
      currentContentHash: secondIdentity.contentHash,
    });
  });

  it('is idempotent but rejects a different frozen target allocation', () => {
    const first = prepare(1);
    const replay = prepareLegacyMigration(dataDir, {
      identity: first.identity,
      target: first.target,
      conversionHash: first.prepared.revision.conversionHash,
      targetRevisionId: first.prepared.revision.targetRevisionId,
      targetHumanVersion: 1,
      targetCreatedAt: first.prepared.revision.targetCreatedAt,
      now: new Date('2026-07-03T00:00:00.000Z'),
    });
    expect(replay.created).toBe(false);
    expect(replay.revision).toEqual(first.prepared.revision);

    expect(() => prepareLegacyMigration(dataDir, {
      identity: first.identity,
      target: first.target,
      conversionHash: first.prepared.revision.conversionHash,
      targetRevisionId: `rev_${'b'.repeat(64)}`,
      targetHumanVersion: 1,
      targetCreatedAt: first.prepared.revision.targetCreatedAt,
    })).toThrow(/does not match the reconstructed conversion/);
  });

  it('preserves multiple source records across locked read-modify-write', () => {
    const first = prepare(1);
    const otherPath = join(root, 'other.workflow.json');
    const otherDef: WorkflowDefinition = {
      workflowId: 'other',
      version: 1,
      nodes: { work: { type: 'subagent', bot: 'cli_bot', prompt: 'other' } },
    };
    writeFileSync(otherPath, JSON.stringify(otherDef), 'utf-8');
    const otherIdentity = legacyDefinitionIdentity(otherPath, otherDef);
    prepareLegacyMigration(dataDir, {
      identity: otherIdentity,
      target: {
        workflowId: migratedSavedWorkflowId(otherIdentity),
        owner: OWNER,
        scope: { kind: 'global' },
      },
      conversionHash: computeLegacyConversionHash({ other: true }),
      targetRevisionId: `rev_${'c'.repeat(64)}`,
      targetHumanVersion: 1,
      targetCreatedAt: '2026-07-04T00:00:00.000Z',
    });
    const ledger = readLegacyMigrationLedger(dataDir);
    expect(Object.keys(ledger.sources)).toHaveLength(2);
    expect(findLegacyMigration(dataDir, first.identity).kind).toBe('exact');
    expect(findLegacyMigration(dataDir, otherIdentity).kind).toBe('exact');
  });

  it('fails closed on malformed, broad-permission, or symlink ledger files', () => {
    const ledgerPath = legacyMigrationLedgerPath(dataDir);
    mkdirSync(join(dataDir, 'workflow-migrations'), { recursive: true });
    writeFileSync(ledgerPath, '{broken', { mode: 0o600 });
    expect(() => readLegacyMigrationLedger(dataDir)).toThrow(/cannot parse/);

    writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, sources: {} }), { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(ledgerPath, 0o644);
      expect(() => readLegacyMigrationLedger(dataDir)).toThrow(/permissions must be 0600/);
      rmSync(ledgerPath);
      const target = join(root, 'target.json');
      writeFileSync(target, '{}', { mode: 0o600 });
      symlinkSync(target, ledgerPath);
      expect(() => readLegacyMigrationLedger(dataDir)).toThrow(/regular file/);
    }
  });
});
