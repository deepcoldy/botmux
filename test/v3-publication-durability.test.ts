import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const durabilityCalls = vi.hoisted(() => ({
  directories: [] as string[],
  fileBatches: [] as Array<{ directory: string; files: string[] }>,
}));

vi.mock('../src/utils/fs-durability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/fs-durability.js')>();
  return {
    ...actual,
    fsyncDirectorySyncPortable(directory: string): void {
      durabilityCalls.directories.push(directory);
      actual.fsyncDirectorySyncPortable(directory);
    },
    fsyncFilesAndDirectorySync(directory: string, files: readonly string[]): void {
      durabilityCalls.fileBatches.push({ directory, files: [...files] });
      actual.fsyncFilesAndDirectorySync(directory, files);
    },
  };
});

import { materializeSavedWorkflowRun } from '../src/workflows/v3/library-materialize.js';
import {
  artifactRef,
  makeManualCliRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import type {
  LoadedSavedWorkflowRevision,
  SavedWorkflowMetadata,
} from '../src/workflows/v3/library-schema.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
  durabilityCalls.directories.length = 0;
  durabilityCalls.fileBatches.length = 0;
});

describe('v3 run publication crash durability', () => {
  it('fsyncs every referenced artifact and the run directory before publishing run.json', () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-publish-durable-'));
    const runId = 'manual-durable-001';
    const runDir = join(base, runId);
    try {
      mkdirSync(runDir);
      writeJson(join(runDir, 'dag.json'), {
        runId,
        nodes: [{ id: 'work', type: 'goal', goal: 'work', depends: [], inputs: [] }],
      });
      writeJson(join(runDir, 'bots.snapshot.json'), {
        '': { larkAppId: 'cli_test', cliId: 'codex', workingDir: '/work' },
      });
      const envelope = makeManualCliRunEnvelope({
        runId,
        createdAt: '2026-07-10T10:00:00.000Z',
        authorizedAt: '2026-07-10T10:00:00.000Z',
        artifacts: {
          dag: artifactRef(runDir, 'dag.json'),
          botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
        },
      });

      publishRunEnvelopeOnce(runDir, envelope);

      expect(durabilityCalls.fileBatches).toEqual([{
        directory: runDir,
        files: [join(runDir, 'dag.json'), join(runDir, 'bots.snapshot.json')],
      }]);
      expect(durabilityCalls.directories).toEqual([runDir]);
      expect(existsSync(join(runDir, 'run.json'))).toBe(true);

      // An exact retry re-syncs old artifacts/directory as a healing path, but
      // never republishes the immutable envelope inode.
      durabilityCalls.directories.length = 0;
      durabilityCalls.fileBatches.length = 0;
      expect(publishRunEnvelopeOnce(runDir, envelope).created).toBe(false);
      expect(durabilityCalls.fileBatches).toHaveLength(1);
      expect(durabilityCalls.directories).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('fsyncs the runs root after moving a fully durable Saved run into place', () => {
    const root = mkdtempSync(join(tmpdir(), 'v3-saved-rename-durable-'));
    const baseDir = join(root, 'runs');
    const workflowId = 'wf_11111111111111111111111111111111';
    const revisionId = `rev_${'a'.repeat(64)}`;
    const now = '2026-07-10T10:00:00.000Z';
    const metadata: SavedWorkflowMetadata = {
      schemaVersion: 1,
      workflowId,
      displayName: 'durable saved workflow',
      aliases: [],
      owner: { openId: 'ou_owner', larkAppId: 'cli_test' },
      scope: { kind: 'global' },
      status: 'active',
      latestRevision: revisionId,
      publishedRevision: revisionId,
      createdAt: now,
      updatedAt: now,
    };
    const revision: LoadedSavedWorkflowRevision = {
      revisionId,
      contentHash: `sha256:${'b'.repeat(64)}`,
      storedSchemaVersion: 1,
      schemaVersion: 1,
      migrated: false,
      payload: {
        workflowId,
        humanVersion: 1,
        createdAt: now,
        createdBy: metadata.owner,
        inputs: {},
        contextRefs: [],
        specTemplate: {
          schemaVersion: 1,
          title: 'durable workflow',
          requirement: 'complete the work',
          nodes: [{
            sketchId: 'work',
            goal: 'complete the work',
            input_needs: [],
            expected_outputs: ['report'],
            acceptance: 'report exists',
            risk_gate: false,
            unknowns: [],
          }],
        },
        specStatus: 'current',
        dagTemplate: {
          nodes: [{ id: 'work', type: 'goal', goal: 'complete the work', depends: [], inputs: [] }],
        },
        safety: { gateDigest: `sha256:${'c'.repeat(64)}`, sideEffects: [] },
      },
    };

    try {
      const materialized = materializeSavedWorkflowRun({
        metadata,
        revision,
        context: {
          initiatorOpenId: metadata.owner.openId,
          chatBinding: {
            larkAppId: metadata.owner.larkAppId,
            chatId: 'oc_test',
            ownerOpenId: metadata.owner.openId,
          },
        },
        bots: [{
          larkAppId: 'cli_test',
          larkAppSecret: 'secret',
          cliId: 'codex',
          workingDir: '/work',
        } as any],
        baseDir,
        runId: 'saved-durable-001',
        now: new Date(now),
      });

      expect(existsSync(materialized.runDir)).toBe(true);
      expect(durabilityCalls.fileBatches).toHaveLength(1);
      expect(durabilityCalls.fileBatches[0]!.files.map((path) => basename(path)).sort()).toEqual([
        'bots.snapshot.json',
        'dag.json',
        'definition.snapshot.json',
        'params.resolved.json',
        'spec.json',
      ]);
      // First direct sync commits staged run.json; the final one commits the
      // stagedRunDir -> baseDir/runId rename that makes the run discoverable.
      expect(durabilityCalls.directories.at(-1)).toBe(baseDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
