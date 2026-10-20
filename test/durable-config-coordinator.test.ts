import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDurableConfigCoordinator } from '../src/services/durable-config-coordinator.js';
import {
  assertDurableConfigMutationAllowed,
  runDurableConfigMutation,
  setDurableConfigCoordinator,
} from '../src/services/durable-config-mutation.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { invalidateGlobalConfigCache, mergeGlobalConfig } from '../src/global-config.js';

const dirs: string[] = [];

function contentSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pathSha256(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

async function seedLegacyRecord(
  store: SqliteDurableCoordinationStore,
  input: { scope: 'global'; path: string; phase: 'prepared' | 'committed' },
): Promise<void> {
  const key = `auxiliary::config-cas::${input.scope}`;
  const acquired = await store.acquireSessionLease({
    sessionKey: key,
    ownerId: 'legacy-seed',
    leaseDurationMs: 300_000,
  });
  if (acquired.kind !== 'acquired') throw new Error('failed to seed legacy record');
  const digest = contentSha256(input.path);
  await store.writeAuxiliaryState({
    lease: acquired.lease,
    expectedRevision: null,
    value: {
      version: 1,
      type: 'botmux.config.cas',
      scope: input.scope,
      phase: input.phase,
      operationId: 'legacy-operation',
      baseSha256: digest,
      contentSha256: digest,
      updatedAt: 1,
      audit: [],
    },
  });
  await store.releaseSessionLease(acquired.lease);
}

function fixture() {
  let now = 1_800_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ dashboard: { publicReadOnly: false }, secret: 'must-not-leak' }) + '\n');
  const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
  const coordinator = createDurableConfigCoordinator({ store, ownerId: 'config-test', now: () => now });
  return { path, store, coordinator, advance: (ms: number) => { now += ms; } };
}

afterEach(() => {
  setDurableConfigCoordinator(undefined);
  invalidateGlobalConfigCache();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable config coordinator', () => {
  it('serializes a mutation and records hash-only audit metadata', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({
      scope: 'global',
      path,
      mutation: async () => {
        const config = JSON.parse(readFileSync(path, 'utf8'));
        config.dashboard.publicReadOnly = true;
        writeFileSync(path, JSON.stringify(config) + '\n');
      },
    });

    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 2,
      value: { version: 2, phase: 'committed', pathSha256: pathSha256(path) },
    });
    expect(JSON.stringify(record)).not.toContain('must-not-leak');
    expect(JSON.stringify(record)).not.toContain(path);
    expect(record?.value).toMatchObject({
      audit: [expect.objectContaining({
        outcome: 'committed',
        changedPaths: ['dashboard'],
      })],
    });
    await store.close();
  });

  it('isolates group-context configuration from the global config CAS key', async () => {
    const { store, coordinator } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-group-context-'));
    dirs.push(dir);
    const path = join(dir, 'group-context-settings.json');
    await coordinator.run({
      scope: 'group-context',
      path,
      mutation: async () => {
        writeFileSync(path, JSON.stringify({
          schemaVersion: 1,
          configs: { oc_group: { enabled: true } },
        }) + '\n');
      },
    });

    expect(await store.readAuxiliaryState('auxiliary::config-cas::group-context'))
      .toMatchObject({ revision: 2, value: { phase: 'committed', scope: 'group-context' } });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global')).toBeUndefined();
    await store.close();
  });

  it('rejects another writer while the config lease is held', async () => {
    const { path, store, coordinator } = fixture();
    const peer = createDurableConfigCoordinator({ store, ownerId: 'config-peer' });
    let unblock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const first = coordinator.run({
      scope: 'global',
      path,
      mutation: async () => {
        entered();
        await blocked;
      },
    });
    await ready;
    await expect(peer.run({ scope: 'global', path, mutation: async () => undefined }))
      .rejects.toThrow('durable_config_busy');
    unblock();
    await first;
    await store.close();
  });

  it('recovers a prepared write after the file changed but the CAS commit failed', async () => {
    const { path, store } = fixture();
    let writes = 0;
    const faultStore = {
      acquireSessionLease: (value: Parameters<typeof store.acquireSessionLease>[0]) => store.acquireSessionLease(value),
      renewSessionLease: (value: Parameters<typeof store.renewSessionLease>[0]) => store.renewSessionLease(value),
      releaseSessionLease: (value: Parameters<typeof store.releaseSessionLease>[0]) => store.releaseSessionLease(value),
      readAuxiliaryState: (key: string) => store.readAuxiliaryState(key),
      writeAuxiliaryState: async (value: Parameters<typeof store.writeAuxiliaryState>[0]) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated commit loss');
        return store.writeAuxiliaryState(value);
      },
    };
    const first = createDurableConfigCoordinator({ store: faultStore, ownerId: 'config-fault' });
    await expect(first.run({
      scope: 'global',
      path,
      mutation: async () => writeFileSync(path, JSON.stringify({ recovered: true }) + '\n'),
    })).rejects.toThrow('simulated commit loss');

    const recovery = createDurableConfigCoordinator({ store, ownerId: 'config-recovery' });
    await recovery.run({ scope: 'global', path, mutation: async () => undefined });
    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record?.value).toMatchObject({
      phase: 'committed',
      audit: [
        expect.objectContaining({ outcome: 'recovered_changed', changedPaths: ['<recovered>'] }),
        expect.objectContaining({ outcome: 'committed', changedPaths: [] }),
      ],
    });
    await store.close();
  });

  it('fails closed when the shared file drifts after a committed revision', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    writeFileSync(path, JSON.stringify({ editedOutsideCoordinator: true }) + '\n');
    await expect(coordinator.run({ scope: 'global', path, mutation: async () => undefined }))
      .rejects.toThrow('durable_config_content_drift');
    await store.close();
  });

  it('binds a matching committed v1 record to the normalized path before continuing', async () => {
    const { path, store, coordinator } = fixture();
    await seedLegacyRecord(store, { scope: 'global', path, phase: 'committed' });

    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });

    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 4,
      value: { version: 2, phase: 'committed', pathSha256: pathSha256(path) },
    });
    await store.close();
  });

  it('refuses to guess a path for an interrupted v1 prepared record', async () => {
    const { path, store, coordinator } = fixture();
    await seedLegacyRecord(store, { scope: 'global', path, phase: 'prepared' });
    const mutation = vi.fn(async () => undefined);

    await expect(coordinator.run({ scope: 'global', path, mutation }))
      .rejects.toThrow('durable_config_path_identity_unbound');
    expect(mutation).not.toHaveBeenCalled();
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 1, value: { version: 1, phase: 'prepared' } });
    await store.close();
  });

  it('rejects another path without changing the binding or blocking the original path', async () => {
    const { path, store, coordinator } = fixture();
    const alternatePath = join(path, '..', 'alternate.json');
    writeFileSync(alternatePath, readFileSync(path));
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    const wrongMutation = vi.fn(async () => undefined);

    await expect(coordinator.run({ scope: 'global', path: alternatePath, mutation: wrongMutation }))
      .rejects.toThrow('durable_config_path_mismatch');
    expect(wrongMutation).not.toHaveBeenCalled();
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 2, value: { pathSha256: pathSha256(path) } });

    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 4, value: { pathSha256: pathSha256(path) } });
    await store.close();
  });

  it('fails closed when primary mode has no registered coordinator', async () => {
    const { path, store } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    await expect(runDurableConfigMutation({
      scope: 'global', path, mutation: async () => undefined,
    })).rejects.toThrow('durable_config_coordinator_unavailable');
    await store.close();
  });

  it('admits a primary write only inside the registered durable transaction context', async () => {
    const { path, store, coordinator } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    setDurableConfigCoordinator(coordinator);
    await runDurableConfigMutation({
      scope: 'global',
      path,
      mutation: async () => {
        expect(() => assertDurableConfigMutationAllowed('global')).not.toThrow();
        expect(() => assertDurableConfigMutationAllowed('bots'))
          .toThrow('durable_config_coordinator_required');
      },
    });
    await store.close();
  });

  it('allows the real global-config writer only through the durable primary transaction', async () => {
    const { path, store, coordinator } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', path);
    setDurableConfigCoordinator(coordinator);
    await runDurableConfigMutation({
      scope: 'global',
      path,
      mutation: async () => mergeGlobalConfig({ repoPickerMode: 'repos' }),
    });
    invalidateGlobalConfigCache();
    expect(JSON.parse(readFileSync(path, 'utf8')).repoPickerMode).toBe('repos');
    await store.close();
  });
});
