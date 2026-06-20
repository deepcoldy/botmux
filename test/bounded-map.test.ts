/**
 * BoundedMap：容量上限 + 插入序淘汰。验证它在做缓存时不会无限增长，
 * 同时保持 Map 的语义（get/has/delete、re-set 不增长、re-set 更新值）。
 * Run:  pnpm vitest run test/bounded-map.test.ts
 */
import { describe, it, expect } from 'vitest';
import { BoundedMap } from '../src/utils/bounded-map.js';

describe('BoundedMap', () => {
  it('caps entry count and evicts the oldest-inserted key', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1); m.set('b', 2); m.set('c', 3);
    expect(m.size).toBe(3);
    m.set('d', 4); // pushes over cap → evicts 'a' (oldest)
    expect(m.size).toBe(3);
    expect(m.has('a')).toBe(false);
    expect([...m.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('never exceeds the cap no matter how many distinct keys are added', () => {
    const m = new BoundedMap<number, number>(10);
    for (let i = 0; i < 10_000; i++) m.set(i, i);
    expect(m.size).toBe(10);
    // Only the most-recent 10 keys survive.
    expect(m.has(9999)).toBe(true);
    expect(m.has(9990)).toBe(true);
    expect(m.has(9989)).toBe(false);
  });

  it('re-setting an existing key updates the value WITHOUT growing or evicting', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1); m.set('b', 2);
    m.set('a', 99); // existing key → no eviction
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe(99);
    expect(m.has('b')).toBe(true); // 'b' not evicted by the re-set
  });

  it('honors standard Map operations (get/has/delete) and is an instanceof Map', () => {
    const m = new BoundedMap<string, string>(5);
    m.set('k', 'v');
    expect(m instanceof Map).toBe(true);
    expect(m.get('k')).toBe('v');
    expect(m.has('k')).toBe(true);
    expect(m.delete('k')).toBe(true);
    expect(m.has('k')).toBe(false);
    expect(m.get('missing')).toBeUndefined();
  });

  it('after delete, a freed slot is reusable without evicting survivors', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1); m.set('b', 2);
    m.delete('a');             // size 1
    m.set('c', 3);             // back to 2, no eviction needed
    expect(m.size).toBe(2);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('rejects a non-positive cap', () => {
    expect(() => new BoundedMap<string, number>(0)).toThrow();
    expect(() => new BoundedMap<string, number>(-1)).toThrow();
  });
});
