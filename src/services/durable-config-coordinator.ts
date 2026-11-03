import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DurableAuxiliaryStateRecord,
  DurableAuxiliaryStateStore,
  DurableJson,
  DurableSessionLeaseStore,
  SessionLease,
} from './durable-coordination.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';

const RECORD_TYPE = 'botmux.config.cas';
const LEGACY_RECORD_VERSION = 1;
const RECORD_VERSION = 2;
const MAX_AUDIT_ENTRIES = 64;
const LEASE_DURATION_MS = 300_000;

export type DurableConfigScope = 'bots' | 'global' | 'group-context';

interface ConfigAuditEntry {
  operationId: string;
  writerId: string;
  outcome: 'committed' | 'recovered_changed' | 'recovered_unchanged' | 'failed_changed' | 'failed_unchanged';
  baseSha256: string;
  contentSha256: string;
  changedPaths: string[];
  committedAt: number;
}

interface DurableConfigCasValueBase {
  type: typeof RECORD_TYPE;
  scope: DurableConfigScope;
  phase: 'prepared' | 'committed';
  operationId: string;
  baseSha256: string;
  contentSha256: string;
  updatedAt: number;
  audit: ConfigAuditEntry[];
}

interface LegacyDurableConfigCasValue extends DurableConfigCasValueBase {
  version: typeof LEGACY_RECORD_VERSION;
}

interface DurableConfigCasValue extends DurableConfigCasValueBase {
  version: typeof RECORD_VERSION;
  /** SHA-256 of the normalized absolute file path; never persist the path itself. */
  pathSha256: string;
}

type ParsedDurableConfigCasValue = LegacyDurableConfigCasValue | DurableConfigCasValue;

type DurableConfigStore = DurableSessionLeaseStore & DurableAuxiliaryStateStore;

export interface DurableConfigCoordinator {
  run<T>(input: {
    scope: DurableConfigScope;
    path: string;
    mutation: () => Promise<T>;
  }): Promise<T>;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseConfigBytes(scope: DurableConfigScope, bytes: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`durable_${scope}_config_invalid_json`);
  }
  if (scope === 'bots') {
    if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('durable_bots_config_invalid_shape');
    }
  } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(scope === 'global'
      ? 'durable_global_config_invalid_shape'
      : 'durable_group_context_config_invalid_shape');
  }
  return parsed;
}

async function snapshot(scope: DurableConfigScope, path: string): Promise<{
  sha256: string;
  parsed: unknown;
}> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    bytes = Buffer.from(scope === 'bots'
      ? '[]\n'
      : scope === 'group-context'
        ? '{"schemaVersion":1,"configs":{}}\n'
        : '{}\n', 'utf8');
  }
  return { sha256: sha256(bytes), parsed: parseConfigBytes(scope, bytes) };
}

function configMap(scope: DurableConfigScope, value: unknown): Map<string, unknown> {
  if (scope === 'global') {
    return new Map(Object.entries(value as Record<string, unknown>));
  }
  if (scope === 'group-context') {
    const registry = value as Record<string, unknown>;
    const configs = registry.configs && typeof registry.configs === 'object' && !Array.isArray(registry.configs)
      ? registry.configs as Record<string, unknown>
      : {};
    const out = new Map<string, unknown>();
    out.set('schemaVersion', registry.schemaVersion);
    for (const [chatId, settings] of Object.entries(configs)) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        out.set(`configs.${chatId}`, settings);
        continue;
      }
      for (const [key, field] of Object.entries(settings)) {
        out.set(`configs.${chatId}.${key}`, field);
      }
    }
    return out;
  }
  const entries = value as Array<Record<string, unknown>>;
  const out = new Map<string, unknown>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const appId = typeof entry.larkAppId === 'string' && entry.larkAppId
      ? entry.larkAppId
      : `index-${index}`;
    for (const [key, field] of Object.entries(entry)) out.set(`${appId}.${key}`, field);
  }
  return out;
}

function changedPaths(scope: DurableConfigScope, before: unknown, after: unknown): string[] {
  const left = configMap(scope, before);
  const right = configMap(scope, after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter(key => !left.has(key) || !right.has(key) || hash(left.get(key)) !== hash(right.get(key)))
    .sort()
    .slice(0, 256);
}

function boundedString(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`durable config ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`durable config ${label} is invalid`);
  return result;
}

function parseAudit(value: unknown): ConfigAuditEntry[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_ENTRIES) {
    throw new Error('durable config audit is invalid');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`durable config audit[${index}] is invalid`);
    }
    const raw = entry as Record<string, unknown>;
    if (!['committed', 'recovered_changed', 'recovered_unchanged', 'failed_changed', 'failed_unchanged']
      .includes(String(raw.outcome))) {
      throw new Error(`durable config audit[${index}] outcome is invalid`);
    }
    if (!Array.isArray(raw.changedPaths)
        || raw.changedPaths.length > 256
        || raw.changedPaths.some(path => typeof path !== 'string' || !path || path.length > 512)) {
      throw new Error(`durable config audit[${index}] changedPaths is invalid`);
    }
    const committedAt = Number(raw.committedAt);
    if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
      throw new Error(`durable config audit[${index}] committedAt is invalid`);
    }
    return {
      operationId: boundedString(raw.operationId, `audit[${index}].operationId`),
      writerId: boundedString(raw.writerId, `audit[${index}].writerId`),
      outcome: raw.outcome as ConfigAuditEntry['outcome'],
      baseSha256: digest(raw.baseSha256, `audit[${index}].baseSha256`),
      contentSha256: digest(raw.contentSha256, `audit[${index}].contentSha256`),
      changedPaths: [...raw.changedPaths] as string[],
      committedAt,
    };
  });
}

function parseRecord(
  record: DurableAuxiliaryStateRecord,
  scope: DurableConfigScope,
): ParsedDurableConfigCasValue {
  const raw = record.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('durable config CAS record is invalid');
  }
  const value = raw as Record<string, unknown>;
  if ((value.version !== LEGACY_RECORD_VERSION && value.version !== RECORD_VERSION)
      || value.type !== RECORD_TYPE || value.scope !== scope
      || (value.phase !== 'prepared' && value.phase !== 'committed')) {
    throw new Error('durable config CAS record is invalid');
  }
  const updatedAt = Number(value.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('durable config CAS updatedAt is invalid');
  }
  const base: DurableConfigCasValueBase = {
    type: RECORD_TYPE,
    scope,
    phase: value.phase,
    operationId: boundedString(value.operationId, 'operationId'),
    baseSha256: digest(value.baseSha256, 'baseSha256'),
    contentSha256: digest(value.contentSha256, 'contentSha256'),
    updatedAt,
    audit: parseAudit(value.audit),
  };
  if (value.version === LEGACY_RECORD_VERSION) {
    return { ...base, version: LEGACY_RECORD_VERSION };
  }
  return {
    ...base,
    version: RECORD_VERSION,
    pathSha256: digest(value.pathSha256, 'pathSha256'),
  };
}

function stateKey(scope: DurableConfigScope): string {
  return `auxiliary::config-cas::${scope}`;
}

function appendAudit(value: ParsedDurableConfigCasValue, entry: ConfigAuditEntry): ConfigAuditEntry[] {
  return [...value.audit, entry].slice(-MAX_AUDIT_ENTRIES);
}

export function createDurableConfigCoordinator(input: {
  store: DurableConfigStore;
  ownerId: string;
  now?: () => number;
}): DurableConfigCoordinator {
  const ownerId = boundedString(input.ownerId, 'ownerId');
  const now = input.now ?? Date.now;
  const localTails = new Map<DurableConfigScope, Promise<void>>();

  async function commit(inputValue: {
    lease: SessionLease;
    expectedRevision: number | null;
    value: DurableConfigCasValue;
  }): Promise<DurableAuxiliaryStateRecord> {
    const result = await input.store.writeAuxiliaryState({
      lease: inputValue.lease,
      expectedRevision: inputValue.expectedRevision,
      value: inputValue.value as unknown as DurableJson,
    });
    if (result.kind !== 'written') throw new Error(`durable_config_cas_${result.kind}`);
    return result.record;
  }

  return {
    async run<T>({ scope, path, mutation }: {
      scope: DurableConfigScope;
      path: string;
      mutation: () => Promise<T>;
    }): Promise<T> {
      const normalizedPath = resolve(path);
      const pathSha256 = sha256(Buffer.from(normalizedPath, 'utf8'));
      const previous = localTails.get(scope) ?? Promise.resolve();
      let releaseLocal!: () => void;
      const localGate = new Promise<void>(resolve => { releaseLocal = resolve; });
      const localTail = previous.catch(() => undefined).then(() => localGate);
      localTails.set(scope, localTail);
      await previous.catch(() => undefined);
      try {
        const key = stateKey(scope);
        const acquired = await input.store.acquireSessionLease({
          sessionKey: key,
          ownerId,
          leaseDurationMs: LEASE_DURATION_MS,
        });
        if (acquired.kind !== 'acquired') throw new Error('durable_config_busy');
        const lease = acquired.lease;
        try {
          const before = await snapshot(scope, path);
          let record = await input.store.readAuxiliaryState(key);
          let current = record ? parseRecord(record, scope) : undefined;

          if (current?.version === RECORD_VERSION && current.pathSha256 !== pathSha256) {
            throw new Error('durable_config_path_mismatch');
          }

          if (current?.version === LEGACY_RECORD_VERSION) {
            // v1 records predate path identity. A committed record can only be
            // bound when the candidate file still has exactly the committed
            // bytes. An interrupted prepared record is ambiguous: its bytes may
            // belong to a different path, so never guess during migration.
            if (current.phase === 'prepared') {
              throw new Error('durable_config_path_identity_unbound');
            }
            if (current.contentSha256 !== before.sha256) {
              throw new Error('durable_config_content_drift');
            }
            const upgraded: DurableConfigCasValue = {
              ...current,
              version: RECORD_VERSION,
              pathSha256,
              updatedAt: now(),
            };
            record = await commit({ lease, expectedRevision: record!.revision, value: upgraded });
            current = upgraded;
          }

          if (current?.phase === 'prepared') {
            const recoveredChanged = before.sha256 !== current.baseSha256;
            const recovered: DurableConfigCasValue = {
              ...current,
              phase: 'committed',
              contentSha256: before.sha256,
              updatedAt: now(),
              audit: appendAudit(current, {
                operationId: current.operationId,
                writerId: ownerId,
                outcome: recoveredChanged ? 'recovered_changed' : 'recovered_unchanged',
                baseSha256: current.baseSha256,
                contentSha256: before.sha256,
                changedPaths: recoveredChanged ? ['<recovered>'] : [],
                committedAt: now(),
              }),
            };
            record = await commit({ lease, expectedRevision: record!.revision, value: recovered });
            current = recovered;
          }

          if (current?.phase === 'committed' && current.contentSha256 !== before.sha256) {
            throw new Error('durable_config_content_drift');
          }

          const operationId = randomUUID();
          const prepared: DurableConfigCasValue = {
            version: RECORD_VERSION,
            type: RECORD_TYPE,
            scope,
            pathSha256,
            phase: 'prepared',
            operationId,
            baseSha256: before.sha256,
            contentSha256: before.sha256,
            updatedAt: now(),
            audit: current?.audit ?? [],
          };
          record = await commit({ lease, expectedRevision: record?.revision ?? null, value: prepared });

          let result: T;
          let failure: unknown;
          try {
            result = await mutation();
          } catch (error) {
            failure = error;
            result = undefined as T;
          }

          const after = await snapshot(scope, path);
          const didChange = before.sha256 !== after.sha256;
          const committedAt = now();
          const committed: DurableConfigCasValue = {
            ...prepared,
            phase: 'committed',
            contentSha256: after.sha256,
            updatedAt: committedAt,
            audit: appendAudit(prepared, {
              operationId,
              writerId: ownerId,
              outcome: failure
                ? didChange ? 'failed_changed' : 'failed_unchanged'
                : 'committed',
              baseSha256: before.sha256,
              contentSha256: after.sha256,
              changedPaths: changedPaths(scope, before.parsed, after.parsed),
              committedAt,
            }),
          };
          await commit({ lease, expectedRevision: record.revision, value: committed });
          if (failure) throw failure;
          return result;
        } finally {
          await input.store.releaseSessionLease(lease).catch(() => undefined);
        }
      } finally {
        releaseLocal();
        if (localTails.get(scope) === localTail) localTails.delete(scope);
      }
    },
  };
}
