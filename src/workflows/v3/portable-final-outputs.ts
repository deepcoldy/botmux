/**
 * Secure, host-neutral projection of terminal workflow artifacts.
 *
 * Journal entries are audit data, not filesystem authority. This module
 * derives the only allowed artifact paths from the validated attempt identity,
 * revalidates the manifest, and returns hash-bound snapshots for consumers.
 */

import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';

import type { Manifest, ValidateManifest } from './artifact-contract.js';
import type { V3Dag } from './dag.js';
import { readJournal } from './journal.js';
import { findSinks } from './orchestrator.js';
import {
  assertArtifactDirectoryBinding,
  bindArtifactDirectory,
  readStableArtifactFile,
  type DirectoryBinding,
  type FileSnapshot,
} from './portable-artifact-snapshot.js';
import { materialize } from './state.js';

export interface PortableWorkflowFinalOutput {
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  /** Canonical path to the revalidated sink manifest. */
  manifestPath: string;
  /** SHA-256 of the exact manifest bytes validated for this projection. */
  manifestSha256: string;
  /** A detached snapshot of the validated manifest. */
  manifest: Manifest;
  /** Canonical directory containing the sink's validated files. */
  outputDir: string;
  /** Canonical path when the sink manifest publishes `result.json`. */
  resultPath?: string;
  /** SHA-256 of the exact `result.json` bytes captured by this projection. */
  resultSha256?: string;
  /** Parsed snapshot of `result.json`; prefer this over reopening resultPath. */
  resultJson?: unknown;
}

const ATTEMPT_NUMBER_RE = /^\d{3}$/;

function parseManifest(snapshot: FileSnapshot): Manifest {
  try {
    return JSON.parse(snapshot.bytes.toString('utf-8')) as Manifest;
  } catch (error) {
    throw new Error(
      `v3 final outputs: manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function attemptParts(
  attemptId: string,
  expectedOwner: string,
): { owner: string; number: string } {
  const parts = attemptId.split('/');
  if (
    parts.length !== 3
    || parts[0] !== expectedOwner
    || parts[1] !== 'attempts'
    || !ATTEMPT_NUMBER_RE.test(parts[2] ?? '')
  ) {
    throw new Error(
      `v3 final outputs: invalid attempt identity for ${expectedOwner}: ${attemptId}`,
    );
  }
  return { owner: parts[0]!, number: parts[2]! };
}

async function validatedManifestSnapshot(
  manifestPath: string,
  attempt: DirectoryBinding,
  output: DirectoryBinding,
  validateManifest: ValidateManifest,
): Promise<{ snapshot: FileSnapshot; manifest: Manifest }> {
  const before = readStableArtifactFile(manifestPath, 'manifest', attempt);
  const verdict = await validateManifest(before.path, output.realPath);
  if (!verdict.ok || !verdict.manifest) {
    throw new Error(
      `v3 final outputs: manifest revalidation failed: ${(verdict.problems ?? []).join('; ') || 'unknown error'}`,
    );
  }

  const after = readStableArtifactFile(manifestPath, 'manifest', attempt);
  if (before.sha256 !== after.sha256) {
    throw new Error('v3 final outputs: manifest changed during revalidation');
  }
  const parsed = parseManifest(after);
  if (!isDeepStrictEqual(parsed, verdict.manifest)) {
    throw new Error('v3 final outputs: validator result is not bound to the manifest bytes');
  }
  if (parsed.status !== 'ok') {
    throw new Error(`v3 final outputs: successful sink manifest has status "${parsed.status}"`);
  }
  return { snapshot: after, manifest: parsed };
}

/**
 * Reconstruct final sink artifacts without trusting journal-supplied paths.
 *
 * This intentionally fails closed when a successful sink's artifact binding
 * cannot be reproved. Callers receive parsed/hash-bound snapshots so a later
 * filesystem replacement cannot silently change the delivered result.
 */
export async function readPortableWorkflowFinalOutputs(
  dag: V3Dag,
  runDir: string,
  validateManifest: ValidateManifest,
): Promise<PortableWorkflowFinalOutput[]> {
  const run = bindArtifactDirectory(runDir, 'run directory');
  const journalPath = join(run.realPath, 'journal.ndjson');
  const journal = readStableArtifactFile(journalPath, 'journal', run);
  const events = readJournal(journal.path);
  const journalAfterRead = readStableArtifactFile(journalPath, 'journal', run);
  if (journal.sha256 !== journalAfterRead.sha256) {
    throw new Error('v3 final outputs: journal changed during projection');
  }
  assertArtifactDirectoryBinding(run, 'run directory');
  const state = materialize(events);
  const outputs: PortableWorkflowFinalOutput[] = [];

  for (const nodeId of findSinks(dag)) {
    const nodeState = state.nodes.get(nodeId);
    if (nodeState?.status !== 'done') continue;
    const effectiveInstanceId = nodeState.effectiveInstanceId;
    const success = [...events].reverse().find((event) =>
      event.type === 'nodeSucceeded'
      && event.nodeId === nodeId
      && (
        effectiveInstanceId === undefined
        || event.instanceId === effectiveInstanceId
      ));
    if (!success || success.type !== 'nodeSucceeded') {
      throw new Error(`v3 final outputs: no successful attempt found for sink ${nodeId}`);
    }

    const owner = success.instanceId ?? nodeId;
    const parts = attemptParts(success.attemptId, owner);
    const attempt = bindArtifactDirectory(
      join(run.realPath, parts.owner, 'attempts', parts.number),
      `attempt ${success.attemptId}`,
      run,
    );
    const output = bindArtifactDirectory(
      join(attempt.realPath, 'work'),
      'output directory',
      attempt,
    );
    const expectedManifestPath = join(attempt.realPath, 'manifest.json');
    const journalManifestPath = isAbsolute(success.manifestPath)
      ? success.manifestPath
      : resolve(run.realPath, success.manifestPath);
    const journalManifestRealPath = realpathSync(journalManifestPath);
    if (journalManifestRealPath !== realpathSync(expectedManifestPath)) {
      throw new Error(
        `v3 final outputs: journal manifest path is not bound to attempt ${success.attemptId}`,
      );
    }

    const validated = await validatedManifestSnapshot(
      expectedManifestPath,
      attempt,
      output,
      validateManifest,
    );
    const resultEntries = validated.manifest.files.filter(
      (file) => file.path === 'result.json',
    );
    if (resultEntries.length > 1) {
      throw new Error('v3 final outputs: manifest publishes result.json more than once');
    }

    const projected: PortableWorkflowFinalOutput = {
      nodeId,
      ...(success.instanceId ? { instanceId: success.instanceId } : {}),
      attemptId: success.attemptId,
      manifestPath: validated.snapshot.path,
      manifestSha256: validated.snapshot.sha256,
      manifest: validated.manifest,
      outputDir: output.realPath,
    };
    const resultEntry = resultEntries[0];
    if (resultEntry) {
      if (resultEntry.kind !== 'json') {
        throw new Error('v3 final outputs: result.json must use manifest kind "json"');
      }
      const result = readStableArtifactFile(
        join(output.realPath, 'result.json'),
        'result.json',
        output,
      );
      if (result.bytes.length !== resultEntry.bytes || result.sha256 !== resultEntry.sha256) {
        throw new Error('v3 final outputs: result.json no longer matches the validated manifest');
      }
      let resultJson: unknown;
      try {
        resultJson = JSON.parse(result.bytes.toString('utf-8'));
      } catch (error) {
        throw new Error(
          `v3 final outputs: result.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      projected.resultPath = result.path;
      projected.resultSha256 = result.sha256;
      projected.resultJson = resultJson;
    }
    assertArtifactDirectoryBinding(output, 'output directory');
    assertArtifactDirectoryBinding(attempt, `attempt ${success.attemptId}`);
    assertArtifactDirectoryBinding(run, 'run directory');
    outputs.push(projected);
  }
  return outputs;
}
