/** Strict source-run boundary for parameter distillation. */

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';

import { readJournal } from './journal.js';
import { isValidRunId } from './ops-projection.js';
import {
  loadAuthorizedV3Run,
  sha256Bytes,
  type LoadedAuthorizedV3Run,
  type Sha256Digest,
} from './run-envelope.js';
import { materialize } from './state.js';

export interface V3DistillationActorContext {
  ownerOpenId: string;
  larkAppId: string;
  chatId: string;
}

export interface V3DistillationSourceIdentity extends V3DistillationActorContext {
  runId: string;
  runEnvelopeSha256: Sha256Digest;
  dagSha256: Sha256Digest;
  specSha256: Sha256Digest;
  botSnapshotsSha256: Sha256Digest;
}

export interface LoadedV3DistillationSource {
  runDir: string;
  loaded: LoadedAuthorizedV3Run & {
    spec: NonNullable<LoadedAuthorizedV3Run['spec']>;
    botSnapshots: NonNullable<LoadedAuthorizedV3Run['botSnapshots']>;
  };
  identity: V3DistillationSourceIdentity;
}

export type V3DistillationSourceErrorCode =
  | 'invalid_source'
  | 'source_not_found'
  | 'source_not_ad_hoc'
  | 'source_not_succeeded'
  | 'source_not_owned';

export class V3DistillationSourceError extends Error {
  constructor(public readonly code: V3DistillationSourceErrorCode) {
    super(`Workflow distillation source rejected (${code})`);
    this.name = 'V3DistillationSourceError';
  }
}

function requireContext(context: V3DistillationActorContext): void {
  if (!context.ownerOpenId || !context.larkAppId || !context.chatId) {
    throw new V3DistillationSourceError('invalid_source');
  }
}

export function loadV3DistillationSource(
  runDir: string,
  context: V3DistillationActorContext,
): LoadedV3DistillationSource {
  requireContext(context);
  const runId = basename(runDir);
  if (!isValidRunId(runId)) throw new V3DistillationSourceError('invalid_source');
  let loaded: LoadedAuthorizedV3Run;
  try {
    loaded = loadAuthorizedV3Run(runDir, {
      expectedRunId: runId,
      allowedSources: ['ad_hoc'],
    });
  } catch {
    throw new V3DistillationSourceError('source_not_ad_hoc');
  }
  const binding = loaded.envelope.chatBinding;
  if (
    !binding?.ownerOpenId ||
    binding.ownerOpenId !== context.ownerOpenId ||
    binding.larkAppId !== context.larkAppId ||
    binding.chatId !== context.chatId
  ) {
    throw new V3DistillationSourceError('source_not_owned');
  }
  if (!loaded.spec || loaded.botSnapshots === undefined) {
    throw new V3DistillationSourceError('invalid_source');
  }
  let events;
  try { events = readJournal(join(runDir, 'journal.ndjson')); }
  catch { throw new V3DistillationSourceError('source_not_succeeded'); }
  const starts = events.filter((event) => event.type === 'runStarted');
  if (starts.length !== 1 || starts[0]!.runId !== runId || materialize(events).runStatus !== 'succeeded') {
    throw new V3DistillationSourceError('source_not_succeeded');
  }
  const artifacts = loaded.envelope.artifacts;
  if (!('spec' in artifacts) || !artifacts.spec || !('botSnapshots' in artifacts) || !artifacts.botSnapshots) {
    throw new V3DistillationSourceError('invalid_source');
  }
  return {
    runDir,
    loaded: loaded as LoadedV3DistillationSource['loaded'],
    identity: {
      runId,
      runEnvelopeSha256: sha256Bytes(loaded.bytes.runEnvelope),
      dagSha256: artifacts.dag.sha256,
      specSha256: artifacts.spec.sha256,
      botSnapshotsSha256: artifacts.botSnapshots.sha256,
      ...context,
    },
  };
}

/** Resolve last only inside the authenticated owner/app/chat scope. */
export async function resolveV3DistillationSourceRunDir(input: {
  baseDir: string;
  source: 'last' | string;
  context: V3DistillationActorContext;
}): Promise<string> {
  requireContext(input.context);
  if (input.source !== 'last') {
    if (!isValidRunId(input.source)) throw new V3DistillationSourceError('invalid_source');
    const runDir = join(input.baseDir, input.source);
    try {
      const stat = await fs.lstat(runDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not-dir');
    } catch {
      throw new V3DistillationSourceError('source_not_found');
    }
    loadV3DistillationSource(runDir, input.context);
    return runDir;
  }

  let entries: string[];
  try { entries = await fs.readdir(input.baseDir); }
  catch { throw new V3DistillationSourceError('source_not_found'); }
  const matches: Array<{ runDir: string; createdAt: string; runId: string }> = [];
  for (const runId of entries) {
    if (!isValidRunId(runId)) continue;
    const runDir = join(input.baseDir, runId);
    try {
      const stat = await fs.lstat(runDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const source = loadV3DistillationSource(runDir, input.context);
      matches.push({ runDir, createdAt: source.loaded.envelope.createdAt, runId });
    } catch { /* another actor/source/state is not a last-candidate */ }
  }
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  if (!matches[0]) throw new V3DistillationSourceError('source_not_found');
  return matches[0].runDir;
}
