import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDurableGroupContextRecallFacade,
  durableGroupContextRecallKey,
  readDurableGroupContextRecalls,
  recordDurableGroupContextRecall,
} from '../src/services/durable-group-context-recall.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

const dirs: string[] = [];

function fixture() {
  let now = 1_800_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-recall-'));
  dirs.push(dir);
  const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
  const facade = createDurableGroupContextRecallFacade({ store, ownerId: 'recall-test' });
  return { store, facade, now: () => now, advance: (ms: number) => { now += ms; } };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable group-context recall log', () => {
  it('persists, deduplicates, and reads recalled message ids by app and chat', async () => {
    const { store, facade, now, advance } = fixture();
    await recordDurableGroupContextRecall({
      facade, larkAppId: 'cli_test', chatId: 'oc_room', messageId: 'om_one', deletedAt: now(), now,
    });
    advance(10);
    await recordDurableGroupContextRecall({
      facade, larkAppId: 'cli_test', chatId: 'oc_room', messageId: 'om_one', deletedAt: now(), now,
    });
    advance(10);
    await recordDurableGroupContextRecall({
      facade, larkAppId: 'cli_test', chatId: 'oc_room', messageId: 'om_two', deletedAt: now(), now,
    });

    await expect(readDurableGroupContextRecalls({
      store, larkAppId: 'cli_test', chatId: 'oc_room',
    })).resolves.toEqual([
      { messageId: 'om_one', deletedAt: 1_800_000_000_010 },
      { messageId: 'om_two', deletedAt: 1_800_000_000_020 },
    ]);
    expect(await store.readAuxiliaryState(durableGroupContextRecallKey('cli_test', 'oc_room')))
      .toMatchObject({ revision: 3 });
    await expect(store.listSessions({ limit: 10 })).resolves.toEqual({ records: [] });
    await facade.stop();
    await store.close();
  });

  it('rejects a malformed record instead of dropping an existing recall set', async () => {
    const { store, facade, now } = fixture();
    const key = durableGroupContextRecallKey('cli_test', 'oc_room');
    const lease = await store.acquireSessionLease({ sessionKey: key, ownerId: 'seed', leaseDurationMs: 1_000 });
    if (lease.kind !== 'acquired') throw new Error('expected lease');
    await store.writeAuxiliaryState({ lease: lease.lease, expectedRevision: null, value: { type: 'wrong' } });
    await store.releaseSessionLease(lease.lease);

    await expect(recordDurableGroupContextRecall({
      facade, larkAppId: 'cli_test', chatId: 'oc_room', messageId: 'om_one', deletedAt: now(), now,
    })).rejects.toThrow(/invalid envelope/);
    await facade.stop();
    await store.close();
  });
});
