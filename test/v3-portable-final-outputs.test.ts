import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type Manifest,
  type ValidateManifest,
} from '../src/workflows/v3/artifact-contract.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import {
  readPortableWorkflowFinalOutputs,
} from '../src/workflows/v3/portable-final-outputs.js';

const passthroughValidator: ValidateManifest = async (manifestPath) => ({
  ok: true,
  manifest: JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest,
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function successfulRun(
  baseDir: string,
  options: {
    manifestPath?: string;
    resultContent?: string;
  } = {},
) {
  const dag = validateDag({
    runId: 'secure-final-output',
    nodes: [{ id: 'deliver', type: 'goal', goal: 'deliver' }],
  });
  const runDir = join(baseDir, dag.runId);
  const attemptId = 'deliver#001/attempts/001';
  const attemptDir = join(runDir, 'deliver#001', 'attempts', '001');
  const outputDir = join(attemptDir, 'work');
  mkdirSync(outputDir, { recursive: true });
  const resultContent = options.resultContent ?? JSON.stringify({ delivered: true });
  writeFileSync(join(outputDir, 'result.json'), resultContent);
  const manifest: Manifest = {
    schemaVersion: 1,
    status: 'ok',
    summary: 'delivered',
    files: [{
      name: 'result',
      path: 'result.json',
      kind: 'json',
      bytes: Buffer.byteLength(resultContent),
      sha256: sha256(resultContent),
      mime: 'application/json',
    }],
  };
  const manifestPath = join(attemptDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'runStarted',
    runId: dag.runId,
  });
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'nodeDispatched',
    nodeId: 'deliver',
    instanceId: 'deliver#001',
    attemptId,
  });
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'nodeSucceeded',
    nodeId: 'deliver',
    instanceId: 'deliver#001',
    attemptId,
    manifestPath: options.manifestPath ?? manifestPath,
  });
  return { attemptDir, dag, manifest, manifestPath, outputDir, runDir };
}

describe('portable workflow final outputs', () => {
  it('returns canonical hash-bound manifest and result snapshots', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-final-output-'));
    try {
      const fixture = successfulRun(baseDir);
      const outputs = await readPortableWorkflowFinalOutputs(
        fixture.dag,
        fixture.runDir,
        passthroughValidator,
      );

      expect(outputs).toEqual([expect.objectContaining({
        nodeId: 'deliver',
        instanceId: 'deliver#001',
        attemptId: 'deliver#001/attempts/001',
        manifestPath: realpathSync(fixture.manifestPath),
        manifestSha256: sha256(JSON.stringify(fixture.manifest)),
        manifest: fixture.manifest,
        outputDir: realpathSync(fixture.outputDir),
        resultPath: realpathSync(join(fixture.outputDir, 'result.json')),
        resultSha256: fixture.manifest.files[0]!.sha256,
        resultJson: { delivered: true },
      })]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects a journal manifest path outside the owning attempt', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-final-path-'));
    try {
      const outsideDir = join(baseDir, 'outside');
      mkdirSync(outsideDir);
      const outsideManifest = join(outsideDir, 'manifest.json');
      writeFileSync(outsideManifest, JSON.stringify({
        schemaVersion: 1,
        status: 'ok',
        summary: 'forged',
        files: [],
      }));
      const fixture = successfulRun(baseDir, { manifestPath: outsideManifest });

      await expect(readPortableWorkflowFinalOutputs(
        fixture.dag,
        fixture.runDir,
        passthroughValidator,
      )).rejects.toThrow(/journal manifest path is not bound to attempt/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects result.json symlinks even when a weak validator accepts them', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-final-symlink-'));
    try {
      const outsideResult = join(baseDir, 'outside.json');
      const outsideContent = JSON.stringify({ stolen: true });
      writeFileSync(outsideResult, outsideContent);
      const fixture = successfulRun(baseDir, { resultContent: outsideContent });
      rmSync(join(fixture.outputDir, 'result.json'));
      symlinkSync(outsideResult, join(fixture.outputDir, 'result.json'));

      await expect(readPortableWorkflowFinalOutputs(
        fixture.dag,
        fixture.runDir,
        passthroughValidator,
      )).rejects.toThrow(/result\.json must be a real regular file/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects artifact replacement after delegated validation', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-final-replace-'));
    try {
      const fixture = successfulRun(baseDir);
      const replacingValidator: ValidateManifest = async (manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
        writeFileSync(
          join(fixture.outputDir, 'result.json'),
          JSON.stringify({ delivered: false }),
        );
        return { ok: true, manifest };
      };

      await expect(readPortableWorkflowFinalOutputs(
        fixture.dag,
        fixture.runDir,
        replacingValidator,
      )).rejects.toThrow(/result\.json no longer matches the validated manifest/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects manifest replacement during delegated validation', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-final-manifest-replace-'));
    try {
      const fixture = successfulRun(baseDir);
      const replacingValidator: ValidateManifest = async (manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
        writeFileSync(manifestPath, JSON.stringify({
          ...manifest,
          summary: 'replaced',
        }));
        return { ok: true, manifest };
      };

      await expect(readPortableWorkflowFinalOutputs(
        fixture.dag,
        fixture.runDir,
        replacingValidator,
      )).rejects.toThrow(/manifest changed during revalidation/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
