import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OncallPrivateIntakeStore, type OncallPrivateIntake } from '../src/services/oncall-private-intake.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oncall-private-intake-')); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('OncallPrivateIntakeStore delivery settlement', () => {
  it('settles a failed unbound delivery and reopens only its explicit retry', () => {
    const store = new OncallPrivateIntakeStore(dir);
    const delivery = { appId: 'app', ownerOpenId: 'ou_owner', groupMessageId: 'om_group' };
    expect(store.beginDelivery(delivery.appId, delivery.ownerOpenId, delivery.groupMessageId)).toBeUndefined();
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(true);
    store.finishDelivery(delivery);
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(false);

    expect(store.beginDelivery(delivery.appId, delivery.ownerOpenId, delivery.groupMessageId)).toBeUndefined();
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(true);
    const binding: OncallPrivateIntake = {
      ...delivery, groupChatId: 'oc_group', chatId: 'oc_dm', rootMessageId: 'om_root', createdAtMs: Date.now(),
    };
    store.record(binding);
    store.finishDelivery(binding);
    expect(store.beginDelivery(delivery.appId, delivery.ownerOpenId, delivery.groupMessageId)).toEqual(binding);
    expect(store.isStarting(binding)).toBe(false);
  });

  it('keeps a commit-unknown delivery unresolved until a trusted binding replaces it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new OncallPrivateIntakeStore(dir);
    const delivery = { appId: 'app', ownerOpenId: 'ou_owner', groupMessageId: 'om_unknown' };
    store.beginDelivery(delivery.appId, delivery.ownerOpenId, delivery.groupMessageId);
    store.markDeliveryUncertain(delivery);
    vi.setSystemTime(Date.now() + 61_000);
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(true);
    // A later definite failure or generic cleanup cannot erase this history.
    store.finishDelivery(delivery);
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(true);
    const binding: OncallPrivateIntake = {
      ...delivery, groupChatId: 'oc_group', chatId: 'oc_dm', rootMessageId: 'om_unknown_dm', createdAtMs: Date.now(),
    };
    store.record(binding);
    store.finishDelivery(binding);
    expect(store.awaitingReceipt(delivery.appId, delivery.ownerOpenId)).toBe(false);
  });
});
