import { describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  RunEnvelopeConflictError,
  RunEnvelopeIntegrityError,
  RunEnvelopeValidationError,
  V3_RUN_ENVELOPE_FILE,
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  makeLegacyV3RunEnvelope,
  makeManualCliRunEnvelope,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  serializeRunEnvelope,
  sha256Bytes,
  validateRunEnvelope,
  type V3AdHocRunEnvelope,
} from '../src/workflows/v3/run-envelope.js';

const CREATED_AT = '2026-07-10T08:00:00.000Z';
const AUTHORIZED_AT = '2026-07-10T08:01:00.000Z';

function freshRun(runId = 'run-001'): { base: string; runDir: string; runId: string } {
  const base = mkdtempSync(join(tmpdir(), 'v3-envelope-'));
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  return { base, runDir, runId };
}

function dag(runId: string) {
  return {
    runId,
    nodes: [
      { id: 'work', type: 'goal', goal: '完成工作', depends: [], inputs: [] },
    ],
  };
}

function spec(runId: string) {
  return {
    schemaVersion: 1,
    runId,
    title: '示例流程',
    requirement: '完成一项明确工作',
    nodes: [
      {
        sketchId: 'work',
        goal: '完成工作',
        input_needs: [],
        expected_outputs: ['报告'],
        acceptance: '报告存在',
        risk_gate: false,
        unknowns: [],
      },
    ],
  };
}

function writeJson(path: string, value: unknown, space = 2): void {
  writeFileSync(path, JSON.stringify(value, null, space) + '\n');
}

function seedAdHocArtifacts(runDir: string, runId: string): V3AdHocRunEnvelope['artifacts'] {
  writeJson(join(runDir, 'dag.json'), dag(runId));
  writeJson(join(runDir, 'spec.json'), spec(runId));
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: 'cli_test', cliId: 'codex', workingDir: '/work' },
  });
  return {
    dag: artifactRef(runDir, 'dag.json'),
    spec: artifactRef(runDir, 'spec.json'),
    botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
  };
}

function adHocEnvelope(runDir: string, runId: string) {
  return makeAdHocRunEnvelope({
    runId,
    createdAt: CREATED_AT,
    authorizedAt: AUTHORIZED_AT,
    authorizedByOpenId: 'ou_owner',
    chatBinding: {
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      ownerOpenId: 'ou_owner',
    },
    artifacts: seedAdHocArtifacts(runDir, runId),
  });
}

describe('v3 run envelope — strict schema + builders', () => {
  it('builds an ad-hoc Gate-2 envelope and pins the approved artifact digests', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      expect(envelope.source).toEqual({ kind: 'ad_hoc', grillStatePath: 'grill.state.json' });
      expect(envelope.authorization).toMatchObject({
        kind: 'gate2',
        authorizedByOpenId: 'ou_owner',
        dagSha256: envelope.artifacts.dag.sha256,
        specSha256: envelope.artifacts.spec.sha256,
      });
      expect(validateRunEnvelope(envelope, runId)).toEqual(envelope);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects mutable phase/status fields and arbitrary artifact paths', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      expect(() => validateRunEnvelope({ ...envelope, phase: 'ready' })).toThrow(RunEnvelopeValidationError);
      expect(() => validateRunEnvelope({
        ...envelope,
        artifacts: { ...envelope.artifacts, dag: { ...envelope.artifacts.dag, path: '../dag.json' } },
      })).toThrow(RunEnvelopeValidationError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects authorization digests and saved-definition identity that drift from source/artifacts', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      const otherDigest = sha256Bytes('other');
      expect(() => validateRunEnvelope({
        ...envelope,
        authorization: { ...envelope.authorization, dagSha256: otherDigest },
      })).toThrow(/must match artifacts\.dag\.sha256/);

      writeJson(join(runDir, 'params.resolved.json'), { range: 7 });
      writeJson(join(runDir, 'definition.snapshot.json'), {
        workflowId: 'weekly-report', revisionId: 'sha256:revision', humanVersion: 1,
      });
      const saved = makeSavedDefinitionRunEnvelope({
        runId,
        workflowId: 'weekly-report',
        revisionId: 'sha256:revision',
        humanVersion: 1,
        createdAt: CREATED_AT,
        authorizedAt: AUTHORIZED_AT,
        artifacts: {
          ...seedAdHocArtifacts(runDir, runId),
          resolvedParams: artifactRef(runDir, 'params.resolved.json'),
          definitionSnapshot: artifactRef(runDir, 'definition.snapshot.json'),
        },
      });
      expect(() => validateRunEnvelope({
        ...saved,
        authorization: { ...saved.authorization, revisionId: 'sha256:different' },
      })).toThrow(/must match source\.revisionId/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('supports manual CLI and honest legacy envelopes without inventing a missing spec', () => {
    const { base, runDir, runId } = freshRun();
    try {
      writeJson(join(runDir, 'dag.json'), dag(runId));
      writeJson(join(runDir, 'bots.snapshot.json'), {
        '': { larkAppId: 'cli_test', cliId: 'codex', workingDir: '/work' },
      });
      const dagRef = artifactRef(runDir, 'dag.json');
      const botRef = artifactRef(runDir, 'bots.snapshot.json');
      const manual = makeManualCliRunEnvelope({
        runId,
        createdAt: CREATED_AT,
        authorizedAt: AUTHORIZED_AT,
        artifacts: { dag: dagRef, botSnapshots: botRef },
      });
      expect(manual.authorization.kind).toBe('local_cli');

      const legacy = makeLegacyV3RunEnvelope({
        runId,
        createdAt: CREATED_AT,
        backfilledAt: AUTHORIZED_AT,
        original: 'manual_cli',
        basis: 'runtime_started',
        artifacts: { dag: dagRef, botSnapshots: botRef },
      });
      expect(legacy.authorization).toMatchObject({
        kind: 'legacy_backfill',
        integrity: 'unverifiable_before_backfill',
      });
      expect('spec' in legacy.artifacts).toBe(false);
      expect('specSha256' in legacy.authorization).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe('v3 run envelope — exact-byte hashing + strict load', () => {
  it('hashes exact bytes, then validates and returns the very bytes it parsed', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      publishRunEnvelopeOnce(runDir, envelope);
      const loaded = loadAuthorizedV3Run(runDir, { allowedSources: ['ad_hoc'] });
      expect(loaded.dag.runId).toBe(runId);
      expect(loaded.spec?.runId).toBe(runId);
      expect(loaded.botSnapshots).toMatchObject({ '': { cliId: 'codex' } });
      expect(sha256Bytes(loaded.bytes.dag)).toBe(envelope.artifacts.dag.sha256);
      expect(loaded.bytes.dag.equals(readFileSync(join(runDir, 'dag.json')))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('detects even whitespace-only byte changes after authorization', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      publishRunEnvelopeOnce(runDir, envelope);
      // Semantically identical JSON, different exact bytes.
      writeJson(join(runDir, 'dag.json'), dag(runId), 0);
      expect(() => loadAuthorizedV3Run(runDir)).toThrowError(expect.objectContaining({
        name: 'RunEnvelopeIntegrityError',
        code: 'artifact_digest_mismatch',
        artifact: 'dag.json',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a validly-hashed DAG whose runId differs from the envelope/run directory', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const artifacts = seedAdHocArtifacts(runDir, runId);
      writeJson(join(runDir, 'dag.json'), dag('other-run'));
      const envelope = makeAdHocRunEnvelope({
        runId,
        createdAt: CREATED_AT,
        authorizedAt: AUTHORIZED_AT,
        artifacts: { ...artifacts, dag: artifactRef(runDir, 'dag.json') },
      });
      publishRunEnvelopeOnce(runDir, envelope);
      expect(() => loadAuthorizedV3Run(runDir)).toThrowError(expect.objectContaining({
        code: 'run_id_mismatch',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('enforces a caller source policy', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      publishRunEnvelopeOnce(runDir, envelope);
      expect(() => loadAuthorizedV3Run(runDir, { allowedSources: ['saved_definition'] })).toThrowError(
        expect.objectContaining({ code: 'source_not_allowed' }),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('loads all pinned saved-definition artifacts', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const ordinary = seedAdHocArtifacts(runDir, runId);
      writeJson(join(runDir, 'params.resolved.json'), { days: 7 });
      writeJson(join(runDir, 'definition.snapshot.json'), {
        workflowId: 'weekly-report', revisionId: 'sha256:revision', humanVersion: 1,
      });
      const envelope = makeSavedDefinitionRunEnvelope({
        runId,
        workflowId: 'weekly-report',
        revisionId: 'sha256:revision',
        humanVersion: 1,
        createdAt: CREATED_AT,
        authorizedAt: AUTHORIZED_AT,
        artifacts: {
          ...ordinary,
          resolvedParams: artifactRef(runDir, 'params.resolved.json'),
          definitionSnapshot: artifactRef(runDir, 'definition.snapshot.json'),
        },
      });
      publishRunEnvelopeOnce(runDir, envelope);
      const loaded = loadAuthorizedV3Run(runDir);
      expect(loaded.resolvedParams).toEqual({ days: 7 });
      expect(loaded.definitionSnapshot).toMatchObject({ workflowId: 'weekly-report' });
      expect(sha256Bytes(loaded.bytes.definitionSnapshot!)).toBe(
        envelope.artifacts.definitionSnapshot.sha256,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('v3 run envelope — create-once publication + read states', () => {
  it('distinguishes missing from invalid instead of silently treating corruption as legacy', () => {
    const { base, runDir } = freshRun();
    try {
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'missing' });
      writeFileSync(join(runDir, V3_RUN_ENVELOPE_FILE), '{broken');
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'invalid' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats dangling symlink run.json as invalid, not missing', () => {
    const { base, runDir } = freshRun();
    try {
      const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
      symlinkSync(join(runDir, 'does-not-exist.json'), envelopePath);
      // existsSync follows the dangling target and reports false; the reader
      // must still fail closed so callers cannot fall back to legacy grill.
      expect(existsSync(envelopePath)).toBe(false);
      const read = readRunEnvelope(runDir);
      expect(read.kind).toBe('invalid');
      if (read.kind === 'invalid') {
        expect(read.problems.join(' ')).toMatch(/regular file|ELOOP|EPERM/i);
      }
      expect(() => loadAuthorizedV3Run(runDir)).toThrowError(expect.objectContaining({
        code: 'envelope_invalid',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a resolvable symlink or non-regular run.json path as invalid', () => {
    const { base, runDir } = freshRun();
    try {
      const target = join(runDir, 'outside.json');
      writeFileSync(target, '{"schemaVersion":1}\n');
      symlinkSync(target, join(runDir, V3_RUN_ENVELOPE_FILE));
      expect(readRunEnvelope(runDir).kind).toBe('invalid');

      rmSync(join(runDir, V3_RUN_ENVELOPE_FILE), { force: true });
      mkdirSync(join(runDir, V3_RUN_ENVELOPE_FILE));
      expect(readRunEnvelope(runDir)).toMatchObject({
        kind: 'invalid',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats a post-lstat removal race as invalid, not missing', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      publishRunEnvelopeOnce(runDir, envelope);
      const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
      const enoent = Object.assign(
        new Error(`ENOENT: no such file or directory, open '${envelopePath}'`),
        { code: 'ENOENT', errno: -2, syscall: 'open', path: envelopePath },
      );
      // lstat observes the real regular file; the injected open ENOENT models
      // the path being removed in the lstat→open window. A missing-only
      // legacy fallback must not engage on a path that was just seen.
      vi.mocked(openSync).mockImplementationOnce(() => { throw enoent; });
      const read = readRunEnvelope(runDir);
      expect(read.kind).toBe('invalid');
      if (read.kind === 'invalid') {
        expect(read.problems.join(' ')).toMatch(/stable regular file \(ENOENT\)/);
      }
      // Only the raced call fails closed; the intact file still reads fine.
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // FIFO scenarios run in a subprocess with a hard timeout: if a regression
  // re-introduces a blocking open, the child is killed and execFileSync throws
  // ETIMEDOUT instead of the vitest worker hanging forever.
  function runEnvelopeDriver(mode: 'envelope' | 'load', runDir: string): Record<string, unknown> {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', join(__dirname, 'fixtures', 'read-run-envelope-cli.ts'), mode, runDir],
      { timeout: 15_000, encoding: 'utf8' },
    );
    return JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
  }

  it.runIf(process.platform !== 'win32')(
    'returns invalid immediately for a writerless FIFO run.json instead of blocking',
    () => {
      const { base, runDir } = freshRun();
      try {
        execFileSync('mkfifo', [join(runDir, V3_RUN_ENVELOPE_FILE)]);
        const result = runEnvelopeDriver('envelope', runDir);
        expect(result.kind).toBe('invalid');
        expect((result.problems as string[]).join(' ')).toMatch(/regular file/i);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'fails artifact verification immediately for a writerless FIFO artifact instead of blocking',
    () => {
      const { base, runDir, runId } = freshRun();
      try {
        const envelope = adHocEnvelope(runDir, runId);
        publishRunEnvelopeOnce(runDir, envelope);
        rmSync(join(runDir, 'dag.json'), { force: true });
        execFileSync('mkfifo', [join(runDir, 'dag.json')]);
        const result = runEnvelopeDriver('load', runDir);
        expect(result).toMatchObject({ threw: true, code: 'artifact_not_regular_file' });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('publishes once, accepts an exact semantic retry, and leaves no temp file', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      const first = publishRunEnvelopeOnce(runDir, envelope);
      expect(first.created).toBe(true);
      expect(existsSync(first.path)).toBe(true);

      // Formatting/order on disk is canonical; semantically identical repeats
      // are idempotent rather than replacing the immutable inode.
      const second = publishRunEnvelopeOnce(runDir, JSON.parse(JSON.stringify(envelope)));
      expect(second.created).toBe(false);
      expect(readRunEnvelope(runDir)).toMatchObject({ kind: 'ok', envelope });
      expect(readdirSync(runDir).filter((name) => name.includes('.tmp'))).toEqual([]);
      expect(readFileSync(first.path, 'utf-8')).toBe(serializeRunEnvelope(envelope));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never overwrites a previously-published envelope with different content', () => {
    const { base, runDir, runId } = freshRun();
    try {
      const envelope = adHocEnvelope(runDir, runId);
      const first = publishRunEnvelopeOnce(runDir, envelope);
      const originalBytes = readFileSync(first.path);
      const changed = makeAdHocRunEnvelope({
        runId,
        createdAt: CREATED_AT,
        authorizedAt: '2026-07-10T08:02:00.000Z',
        artifacts: envelope.artifacts,
      });
      expect(() => publishRunEnvelopeOnce(runDir, changed)).toThrow(RunEnvelopeConflictError);
      expect(readFileSync(first.path).equals(originalBytes)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('load fails loudly for a missing or corrupt envelope', () => {
    const { base, runDir } = freshRun();
    try {
      expect(() => loadAuthorizedV3Run(runDir)).toThrowError(expect.objectContaining({
        code: 'envelope_missing',
      }));
      writeFileSync(join(runDir, V3_RUN_ENVELOPE_FILE), '{}');
      expect(() => loadAuthorizedV3Run(runDir)).toThrowError(expect.objectContaining({
        code: 'envelope_invalid',
      }));
      expect(() => loadAuthorizedV3Run(runDir)).toThrow(RunEnvelopeIntegrityError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
