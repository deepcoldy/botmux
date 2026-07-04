/**
 * seen-message-store: 按 message_id 的**持久化**去重。
 *
 * 重点验证它相对旧的内存去重 (event_id, 2h, 重启即清空) 补上的两个缺口：
 *  - 跨「daemon 重启」仍去重（_resetCacheForTest 模拟重启从盘重载）；
 *  - 8h TTL 盖住飞书 6h 那一档重推（旧的 2h 盖不住）。
 *
 * Run: pnpm vitest run test/seen-message-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimMessageOnce, _resetCacheForTest } from '../src/services/seen-message-store.js';

const APP = 'app-test';
const HOUR = 60 * 60_000;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-seen-msg-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetCacheForTest();
});

afterEach(() => {
  _resetCacheForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('seen-message-store', () => {
  it('first claim processes, immediate duplicate is suppressed', () => {
    expect(claimMessageOnce(APP, 'om_1')).toBe(true);
    expect(claimMessageOnce(APP, 'om_1')).toBe(false);
  });

  it('distinct message_ids are independent', () => {
    expect(claimMessageOnce(APP, 'om_a')).toBe(true);
    expect(claimMessageOnce(APP, 'om_b')).toBe(true);
  });

  it('empty message_id can never be deduped (never silently drops)', () => {
    expect(claimMessageOnce(APP, '')).toBe(true);
    expect(claimMessageOnce(APP, '')).toBe(true);
  });

  it('persists the claim to disk under the app-namespaced file', () => {
    claimMessageOnce(APP, 'om_disk');
    expect(existsSync(join(dataDir, 'dedup', `seen-messages-${APP}.json`))).toBe(true);
  });

  it('CORE: dedup survives a daemon restart (reloads from disk)', () => {
    expect(claimMessageOnce(APP, 'om_persist')).toBe(true);
    _resetCacheForTest(); // 模拟 daemon 重启 / 崩溃循环：内存表清空，但盘上还在
    expect(claimMessageOnce(APP, 'om_persist')).toBe(false);
  });

  it('CORE: suppresses the 6h re-push tier (beyond the old 2h TTL)', () => {
    const t0 = 1_000_000_000_000;
    expect(claimMessageOnce(APP, 'om_6h', t0)).toBe(true);
    // 旧实现 2h TTL 在这里会漏；新实现 8h TTL 仍挡住。
    expect(claimMessageOnce(APP, 'om_6h', t0 + 6 * HOUR)).toBe(false);
  });

  it('lets a genuinely old (>8h) re-arrival through after TTL expiry', () => {
    const t0 = 1_000_000_000_000;
    expect(claimMessageOnce(APP, 'om_ttl', t0)).toBe(true);
    expect(claimMessageOnce(APP, 'om_ttl', t0 + 8 * HOUR + 1)).toBe(true);
  });

  it('expired entries are dropped on reload, not resurrected', () => {
    const t0 = 1_000_000_000_000;
    claimMessageOnce(APP, 'om_exp', t0);
    _resetCacheForTest();
    // 重载时已过期 → 当作没见过 → 放行。
    expect(claimMessageOnce(APP, 'om_exp', t0 + 9 * HOUR)).toBe(true);
  });

  it('different apps with the same message_id do not collide', () => {
    expect(claimMessageOnce('app-x', 'om_same')).toBe(true);
    expect(claimMessageOnce('app-y', 'om_same')).toBe(true);
    expect(claimMessageOnce('app-x', 'om_same')).toBe(false);
  });

  it('a corrupt store file is treated as empty (never throws, never drops)', () => {
    claimMessageOnce(APP, 'om_seed'); // create the file
    _resetCacheForTest();
    // 覆写成损坏内容
    const file = join(dataDir, 'dedup', `seen-messages-${APP}.json`);
    writeFileSync(file, 'not json at all');
    expect(claimMessageOnce(APP, 'om_after_corrupt')).toBe(true);
  });
});
