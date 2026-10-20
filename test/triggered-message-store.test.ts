/**
 * triggered-message-store: 记录「已触发过任务」的消息（按 message_id 持久化），
 * 供 im.message.updated_v1（编辑消息补 @）做幂等。
 *
 * Run: bun vitest run test/triggered-message-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTriggeredMessage, markMessageTriggered, _resetCacheForTest } from '../src/services/triggered-message-store.js';

const APP = 'app-test';
const HOUR = 60 * 60_000;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-triggered-msg-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetCacheForTest();
});

afterEach(() => {
  _resetCacheForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('triggered-message-store', () => {
  it('unmarked message is not triggered; after marking it is', () => {
    expect(hasTriggeredMessage(APP, 'om_1')).toBe(false);
    markMessageTriggered(APP, 'om_1');
    expect(hasTriggeredMessage(APP, 'om_1')).toBe(true);
  });

  it('empty message_id is never considered triggered (never drops a real trigger)', () => {
    markMessageTriggered(APP, '');
    expect(hasTriggeredMessage(APP, '')).toBe(false);
  });

  it('persists to disk under the app-namespaced file', () => {
    markMessageTriggered(APP, 'om_disk');
    expect(existsSync(join(dataDir, 'dedup', `triggered-messages-${APP}.json`))).toBe(true);
  });

  it('CORE: the record survives a daemon restart (reloads from disk)', () => {
    markMessageTriggered(APP, 'om_persist');
    _resetCacheForTest(); // 模拟 daemon 重启：内存清空，盘上还在
    expect(hasTriggeredMessage(APP, 'om_persist')).toBe(true);
  });

  it('record expires after 8h', () => {
    const t0 = 1_000_000_000_000;
    markMessageTriggered(APP, 'om_ttl', t0);
    expect(hasTriggeredMessage(APP, 'om_ttl', t0 + 7 * HOUR)).toBe(true);
    expect(hasTriggeredMessage(APP, 'om_ttl', t0 + 8 * HOUR + 1)).toBe(false);
  });

  it('different apps with the same message_id do not collide', () => {
    markMessageTriggered('app-x', 'om_same');
    expect(hasTriggeredMessage('app-x', 'om_same')).toBe(true);
    expect(hasTriggeredMessage('app-y', 'om_same')).toBe(false);
  });

  it('a corrupt store file is treated as empty (never throws)', () => {
    markMessageTriggered(APP, 'om_seed');
    _resetCacheForTest();
    const file = join(dataDir, 'dedup', `triggered-messages-${APP}.json`);
    writeFileSync(file, 'not json at all');
    expect(hasTriggeredMessage(APP, 'om_after_corrupt')).toBe(false);
  });
});
