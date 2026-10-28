/**
 * SQLite 授权库的 GrantTx 实现必须与对象实现（bots.json 条目 / 内存缓存）逐操作等价：
 * 同一串操作打到两边，每一步的返回值与最终状态都一致。
 * 本文件不用 vi.resetModules，因此 vitest（node:sqlite）与 bun 腿（bun:sqlite）都会跑，
 * 两个 SQLite 引擎在「查无此行」等细节上的差异由这里兜住。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteGrantStateStore } from '../src/services/grant-state-store.js';
import { objectGrantTx, type GrantStateFields, type GrantTx } from '../src/services/grant-state.js';

let dir: string;
let store: SqliteGrantStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-grant-sqlite-'));
  store = SqliteGrantStateStore.open(dir);
});
afterEach(() => { store.close(); });

/** 成员顺序无语义：SQLite 按主键序读出，对象实现按追加序。 */
function canonical(state: GrantStateFields): GrantStateFields {
  const out: GrantStateFields = { ...state };
  if (out.chatGrants) out.chatGrants = Object.fromEntries(Object.entries(out.chatGrants).map(([c, ids]) => [c, [...ids].sort()]));
  if (out.globalGrants) out.globalGrants = [...out.globalGrants].sort();
  return out;
}

function objectState(o: Record<string, unknown>): GrantStateFields {
  const { chatGrants, globalGrants, quotaState, grantExpiryState, dispatchLaunchQuotaReceipts } = o as GrantStateFields;
  return Object.fromEntries(Object.entries({ chatGrants, globalGrants, quotaState, grantExpiryState, dispatchLaunchQuotaReceipts })
    .filter(([, v]) => v !== undefined)) as GrantStateFields;
}

describe('SqliteGrantStateStore', () => {
  it('matches the object implementation call-for-call on a random workload', () => {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const obj: Record<string, unknown> = {};
    const reference = objectGrantTx(obj);
    const keys = ['chat:oc_1:ou_a', 'chat:oc_2:ou_b', 'global:ou_a'];

    for (let step = 0; step < 400; step++) {
      const chat = pick(['oc_1', 'oc_2']);
      const user = pick(['ou_a', 'ou_b', 'ou_c']);
      const key = pick(keys);
      const op = pick(['chatAdd', 'chatRemove', 'chatHas', 'globalAdd', 'globalRemove', 'globalHas',
        'quotaSet', 'quotaClear', 'quotaGet', 'expirySet', 'expiryClear', 'expiryGet', 'receiptSet', 'receiptGet'] as const);
      const apply = (tx: GrantTx): unknown => {
        switch (op) {
          case 'chatAdd': return tx.chatAdd(chat, user);
          case 'chatRemove': return tx.chatRemove(chat, user);
          case 'chatHas': return tx.chatHas(chat, user);
          case 'globalAdd': return tx.globalAdd(user);
          case 'globalRemove': return tx.globalRemove(user);
          case 'globalHas': return tx.globalHas(user);
          case 'quotaSet': return tx.quotaSet(key, { limit: 3, used: step % 4 });
          case 'quotaClear': return tx.quotaSet(key, null);
          case 'quotaGet': return tx.quotaGet(key);
          case 'expirySet': return tx.expirySet(key, 1_000 + step);
          case 'expiryClear': return tx.expirySet(key, null);
          case 'expiryGet': return tx.expiryGet(key);
          case 'receiptSet': return tx.receiptSet(`quota_${String(step % 3).padStart(32, '0')}`, { allow: step % 2 === 0, chargedAt: '2026-10-22T00:00:00.000Z' });
          case 'receiptGet': return tx.receiptGet(`quota_${String(step % 3).padStart(32, '0')}`);
        }
      };
      const want = apply(reference);
      const got = store.transact('a1', tx => ({ write: true, result: apply(tx) })).result;
      expect(got, `step ${step} ${op}`).toEqual(want);
    }
    expect(canonical(store.loadState('a1'))).toEqual(canonical(objectState(obj)));
    expect(Object.keys(store.loadState('a1')).length).toBeGreaterThan(0);
  });

  it('rolls back everything a transaction wrote when it reports write:false or throws', () => {
    store.transact('a1', tx => { tx.chatAdd('oc_1', 'ou_a'); return { write: false, result: null }; });
    expect(() => store.transact('a1', tx => { tx.globalAdd('ou_a'); throw new Error('boom'); })).toThrow('boom');
    expect(store.loadState('a1')).toEqual({});
  });

  it('partitions state by app id', () => {
    store.transact('a1', tx => { tx.chatAdd('oc_1', 'ou_a'); tx.quotaSet('global:ou_a', { limit: 2, used: 0 }); return { write: true, result: null }; });
    expect(store.transact('a2', tx => ({ write: false, result: tx.chatHas('oc_1', 'ou_a') })).result).toBe(false);
    expect(store.loadState('a2')).toEqual({});
    expect(store.loadState('a1')).toEqual({ chatGrants: { oc_1: ['ou_a'] }, quotaState: { 'global:ou_a': { limit: 2, used: 0 } } });
  });

  it('commits are visible to another connection on the same file (one connection per daemon)', () => {
    const other = SqliteGrantStateStore.open(dir);
    try {
      store.transact('a1', tx => ({ write: tx.chatAdd('oc_1', 'ou_a'), result: null }));
      expect(other.loadState('a1')).toEqual({ chatGrants: { oc_1: ['ou_a'] } });
      other.transact('a1', tx => ({ write: tx.chatRemove('oc_1', 'ou_a'), result: null }));
      expect(store.loadState('a1')).toEqual({});
    } finally {
      other.close();
    }
  });

  it('importFields only fills gaps and reports the rows it added', () => {
    store.transact('a1', tx => { tx.chatAdd('oc_1', 'ou_a'); tx.quotaSet('chat:oc_1:ou_a', { limit: 3, used: 2 }); return { write: true, result: null }; });
    const added = store.importFields('a1', {
      chatGrants: { oc_1: ['ou_a', 'ou_b'] },
      quotaState: { 'chat:oc_1:ou_a': { limit: 9, used: 0 } },
      grantExpiryState: { 'chat:oc_1:ou_b': { expiresAt: 5_000 } },
    });
    expect(added).toBe(2);
    expect(store.loadState('a1')).toEqual({
      chatGrants: { oc_1: ['ou_a', 'ou_b'] },
      quotaState: { 'chat:oc_1:ou_a': { limit: 3, used: 2 } },
      grantExpiryState: { 'chat:oc_1:ou_b': { expiresAt: 5_000 } },
    });
  });
});
