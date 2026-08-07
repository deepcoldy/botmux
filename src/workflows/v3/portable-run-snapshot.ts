import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  computeInputHash,
} from '../../utils/canonical-input-hash.js';
import { validateDag, type V3Dag } from './dag.js';
import type { ExecutionProfileSnapshot } from './runtime-host-contract.js';

export const PORTABLE_RUN_SNAPSHOT_FILE = 'portable-run.snapshot.json';

interface FrozenExecutionProfile {
  selector: string;
  profile: ExecutionProfileSnapshot;
}

interface PortableRunSnapshot {
  schemaVersion: 1;
  dag: V3Dag;
  dagHash: string;
  executionProfiles: FrozenExecutionProfile[];
  executionProfilesHash: string;
  definitionHash: string;
}

export interface FrozenPortableRunDefinition {
  dag: V3Dag;
  executionProfiles: Map<string, ExecutionProfileSnapshot>;
}

const LEGACY_RUN_ARTIFACTS = [
  'journal.ndjson',
  'dag.json',
  'bots.snapshot.json',
  'STATE',
] as const;

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function normalizeProfiles(
  profiles: ReadonlyMap<string, ExecutionProfileSnapshot>,
): FrozenExecutionProfile[] {
  return [...profiles]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([selector, profile]) => ({
      selector,
      profile: canonicalClone(profile),
    }));
}

function createSnapshot(
  dag: V3Dag,
  profiles: ReadonlyMap<string, ExecutionProfileSnapshot>,
): PortableRunSnapshot {
  const normalizedDag = canonicalClone(validateDag(dag));
  const executionProfiles = normalizeProfiles(profiles);
  const dagHash = computeInputHash(normalizedDag);
  const executionProfilesHash = computeInputHash(executionProfiles);
  return {
    schemaVersion: 1,
    dag: normalizedDag,
    dagHash,
    executionProfiles,
    executionProfilesHash,
    definitionHash: computeInputHash({
      dagHash,
      executionProfilesHash,
    }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfile(
  raw: unknown,
  selector: string,
): ExecutionProfileSnapshot {
  if (!isObject(raw)) {
    throw new Error(`execution profile "${selector || '<default>'}" is not an object`);
  }
  const allowed = new Set([
    'profileId',
    'executorId',
    'workingDirectory',
    'model',
    'adapterData',
  ]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `execution profile "${selector || '<default>'}" has unknown fields: ${unknown.join(', ')}`,
    );
  }
  if (
    typeof raw.profileId !== 'string'
    || typeof raw.executorId !== 'string'
    || typeof raw.workingDirectory !== 'string'
    || (raw.model !== undefined && typeof raw.model !== 'string')
  ) {
    throw new Error(`execution profile "${selector || '<default>'}" is malformed`);
  }
  return {
    profileId: raw.profileId,
    executorId: raw.executorId,
    workingDirectory: raw.workingDirectory,
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.adapterData !== undefined
      ? { adapterData: canonicalClone(raw.adapterData) }
      : {}),
  };
}

function parseSnapshot(raw: unknown): PortableRunSnapshot {
  if (!isObject(raw) || raw.schemaVersion !== 1) {
    throw new Error('unsupported or malformed snapshot schema');
  }
  const dag = validateDag(raw.dag);
  if (!Array.isArray(raw.executionProfiles)) {
    throw new Error('executionProfiles must be an array');
  }
  const selectors = new Set<string>();
  const executionProfiles = raw.executionProfiles.map((entry, index) => {
    if (!isObject(entry) || typeof entry.selector !== 'string') {
      throw new Error(`executionProfiles[${index}] is malformed`);
    }
    if (selectors.has(entry.selector)) {
      throw new Error(`duplicate execution profile selector "${entry.selector}"`);
    }
    selectors.add(entry.selector);
    return {
      selector: entry.selector,
      profile: parseProfile(entry.profile, entry.selector),
    };
  });
  if (
    typeof raw.dagHash !== 'string'
    || typeof raw.executionProfilesHash !== 'string'
    || typeof raw.definitionHash !== 'string'
  ) {
    throw new Error('snapshot hashes are missing');
  }
  const snapshot: PortableRunSnapshot = {
    schemaVersion: 1,
    dag,
    dagHash: raw.dagHash,
    executionProfiles,
    executionProfilesHash: raw.executionProfilesHash,
    definitionHash: raw.definitionHash,
  };
  const actualDagHash = computeInputHash(snapshot.dag);
  const actualProfilesHash = computeInputHash(snapshot.executionProfiles);
  const actualDefinitionHash = computeInputHash({
    dagHash: actualDagHash,
    executionProfilesHash: actualProfilesHash,
  });
  if (
    snapshot.dagHash !== actualDagHash
    || snapshot.executionProfilesHash !== actualProfilesHash
    || snapshot.definitionHash !== actualDefinitionHash
  ) {
    throw new Error('snapshot integrity check failed');
  }
  return snapshot;
}

function readSnapshot(path: string): PortableRunSnapshot {
  try {
    return parseSnapshot(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
  } catch (error) {
    throw new Error(
      `v3 runtime: frozen portable run snapshot is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeSnapshotOnce(path: string, snapshot: PortableRunSnapshot): void {
  try {
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (
      typeof error !== 'object'
      || error === null
      || !('code' in error)
      || error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
}

/**
 * Freeze the complete portable execution contract before the journal starts.
 * A legacy run without this artifact cannot prove its original host profile,
 * so recovery fails closed instead of blessing the caller's current config.
 */
export function assertOrCreatePortableRunSnapshot(
  runDir: string,
  dag: V3Dag,
  profiles: ReadonlyMap<string, ExecutionProfileSnapshot>,
): FrozenPortableRunDefinition {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, PORTABLE_RUN_SNAPSHOT_FILE);
  const expected = createSnapshot(dag, profiles);
  if (!existsSync(path)) {
    const existingArtifact = LEGACY_RUN_ARTIFACTS.find((name) =>
      existsSync(join(runDir, name)));
    if (existingArtifact) {
      throw new Error(
        `v3 runtime: cannot safely resume run without ${PORTABLE_RUN_SNAPSHOT_FILE} `
        + `(found ${existingArtifact})`,
      );
    }
    writeSnapshotOnce(path, expected);
  }

  const stored = readSnapshot(path);
  if (stored.dagHash !== expected.dagHash) {
    throw new Error('v3 runtime: frozen workflow definition differs from this resume request');
  }
  if (stored.executionProfilesHash !== expected.executionProfilesHash) {
    throw new Error('v3 runtime: frozen execution profiles differ from this resume request');
  }
  return {
    dag: stored.dag,
    executionProfiles: new Map(
      stored.executionProfiles.map(({ selector, profile }) => [selector, profile]),
    ),
  };
}
