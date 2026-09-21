/**
 * statusline-snapshot — Claude Code statusline 快照的 parse / 落盘 / 读取 / 缓存 / 陈旧判定。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __testOnly_resetStatuslineCache,
  parseStatuslinePayload,
  readStatuslineSnapshot,
  removeStatuslineDir,
  statuslineFilePath,
  toCardQuota,
  writeStatuslineSnapshot,
  STATUSLINE_STALE_MS,
} from '../src/services/statusline-snapshot.js';

const NOW = 1_788_000_000_000;
const SAMPLE = {
  session_id: 'claude-sid',
  transcript_path: '/home/u/.claude/projects/x/claude-sid.jsonl',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  context_window: { used_percentage: 23.4, context_window_size: 1_000_000, total_input_tokens: 234_000 },
  rate_limits: {
    five_hour: { used_percentage: 14.000000000000002, resets_at: Math.floor(NOW / 1000) + 3600 },
    seven_day: { used_percentage: 5, resets_at: Math.floor(NOW / 1000) + 86_400 },
  },
};

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bmx-statusline-'));
  __testOnly_resetStatuslineCache();
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parseStatuslinePayload', () => {
  it('maps every field; resets_at seconds → ms', () => {
    const s = parseStatuslinePayload(SAMPLE, NOW)!;
    expect(s).toEqual({
      ts: NOW,
      contextPercent: 23.4,
      contextWindowTokens: 1_000_000,
      fiveHourPercent: 14.000000000000002,
      fiveHourResetsAtMs: (Math.floor(NOW / 1000) + 3600) * 1000,
      sevenDayPercent: 5,
      sevenDayResetsAtMs: (Math.floor(NOW / 1000) + 86_400) * 1000,
      model: 'claude-opus-5',
      transcriptPath: SAMPLE.transcript_path,
      claudeSessionId: 'claude-sid',
    });
  });
  it('accepts resets_at already in ms', () => {
    const s = parseStatuslinePayload({ rate_limits: { five_hour: { used_percentage: 1, resets_at: NOW + 10 } } }, NOW)!;
    expect(s.fiveHourResetsAtMs).toBe(NOW + 10);
  });
  it('drops malformed fields independently; clamps percentages', () => {
    const s = parseStatuslinePayload({
      context_window: { used_percentage: '23', context_window_size: -1 },
      rate_limits: { five_hour: { used_percentage: 130, resets_at: 'soon' }, seven_day: null },
      model: 'not-an-object',
    }, NOW)!;
    expect(s).toEqual({ ts: NOW, fiveHourPercent: 100 });
  });
  it('non-object → null', () => {
    expect(parseStatuslinePayload(null, NOW)).toBeNull();
    expect(parseStatuslinePayload('x', NOW)).toBeNull();
    expect(parseStatuslinePayload([1], NOW)).toBeNull();
  });
});

describe('write + read', () => {
  it('round-trips through disk', () => {
    const snap = parseStatuslinePayload(SAMPLE, NOW)!;
    writeStatuslineSnapshot(dataDir, 'sid-1', snap);
    expect(readStatuslineSnapshot(dataDir, 'sid-1', { now: NOW })).toEqual(snap);
  });
  it('missing file → undefined', () => {
    expect(readStatuslineSnapshot(dataDir, 'nope', { now: NOW })).toBeUndefined();
  });
  it('corrupt JSON → undefined, no throw', () => {
    writeStatuslineSnapshot(dataDir, 'sid-2', { ts: NOW, contextPercent: 1 });
    writeFileSync(statuslineFilePath(dataDir, 'sid-2'), '{not json');
    expect(readStatuslineSnapshot(dataDir, 'sid-2', { now: NOW })).toBeUndefined();
  });
  it('stale ts → undefined', () => {
    writeStatuslineSnapshot(dataDir, 'sid-3', { ts: NOW - STATUSLINE_STALE_MS - 1, contextPercent: 1 });
    expect(readStatuslineSnapshot(dataDir, 'sid-3', { now: NOW })).toBeUndefined();
    expect(readStatuslineSnapshot(dataDir, 'sid-3', { now: NOW, maxAgeMs: 24 * 3600_000 })?.contextPercent).toBe(1);
  });
  it('rolled window drops that bucket percent only', () => {
    writeStatuslineSnapshot(dataDir, 'sid-4', {
      ts: NOW,
      fiveHourPercent: 40, fiveHourResetsAtMs: NOW - 1,
      sevenDayPercent: 9, sevenDayResetsAtMs: NOW + 1,
    });
    const s = readStatuslineSnapshot(dataDir, 'sid-4', { now: NOW })!;
    expect(s.fiveHourPercent).toBeUndefined();
    expect(s.fiveHourResetsAtMs).toBe(NOW - 1);
    expect(s.sevenDayPercent).toBe(9);
  });
  it('caches by mtime/size and re-reads when the file changes', () => {
    writeStatuslineSnapshot(dataDir, 'sid-5', { ts: NOW, contextPercent: 10 });
    expect(readStatuslineSnapshot(dataDir, 'sid-5', { now: NOW })?.contextPercent).toBe(10);
    // 同 mtime、同 size 的覆盖写不会被重读（证明缓存生效）——size 相同的两位数百分比
    const path = statuslineFilePath(dataDir, 'sid-5');
    const stale = JSON.stringify({ ts: NOW, contextPercent: 20 });
    writeFileSync(path, stale);
    utimesSync(path, new Date(NOW / 1000), new Date(NOW / 1000));
    const first = readStatuslineSnapshot(dataDir, 'sid-5', { now: NOW })!;
    // mtime 被改到 NOW（与首次写入不同），所以会重读；这里断言的是「变了就重读」
    expect(first.contextPercent).toBe(20);
    // 再次读取：mtime/size 未变 → 缓存命中，不 parse（写坏文件也读到旧值）
    writeFileSync(path, '{broken');
    utimesSync(path, new Date(NOW / 1000), new Date(NOW / 1000));
    // size 变了会触发重读；把内容长度补到一致以证明 size+mtime 同则命中
    const padded = '{broken'.padEnd(stale.length, ' ');
    writeFileSync(path, padded);
    utimesSync(path, new Date(NOW / 1000), new Date(NOW / 1000));
    expect(readStatuslineSnapshot(dataDir, 'sid-5', { now: NOW })?.contextPercent).toBe(20);
  });
  it('removeStatuslineDir clears disk and cache', () => {
    writeStatuslineSnapshot(dataDir, 'sid-6', { ts: NOW, contextPercent: 3 });
    expect(readStatuslineSnapshot(dataDir, 'sid-6', { now: NOW })).toBeDefined();
    removeStatuslineDir(dataDir, 'sid-6');
    expect(readStatuslineSnapshot(dataDir, 'sid-6', { now: NOW })).toBeUndefined();
  });
});

describe('toCardQuota', () => {
  it('rounds percentages and omits missing fields', () => {
    expect(toCardQuota(parseStatuslinePayload(SAMPLE, NOW)!)).toEqual({
      contextPercent: 23,
      contextWindowTokens: 1_000_000,
      fiveHourPercent: 14,
      fiveHourResetsAtMs: (Math.floor(NOW / 1000) + 3600) * 1000,
      sevenDayPercent: 5,
      sevenDayResetsAtMs: (Math.floor(NOW / 1000) + 86_400) * 1000,
    });
  });
  it('undefined when nothing usable', () => {
    expect(toCardQuota(undefined)).toBeUndefined();
    expect(toCardQuota({ ts: NOW })).toBeUndefined();
    expect(toCardQuota({ ts: NOW, model: 'x' })).toBeUndefined();
  });
});
