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
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('keeps native effort.level=%s through disk', level => {
    const snap = parseStatuslinePayload({ ...SAMPLE, effort: { level } }, NOW)!;
    expect(snap.reasoningEffort).toBe(level);
    writeStatuslineSnapshot(dataDir, 'effort', snap);
    expect(readStatuslineSnapshot(dataDir, 'effort', { now: NOW })?.reasoningEffort).toBe(level);
  });

  it.each([undefined, null, 'high', {}, { level: 'ultracode' }, { level: 'default' }, { level: 3 }])(
    'omits absent or unsupported native effort without discarding model/quota (%j)', effort => {
      const snap = parseStatuslinePayload({ ...SAMPLE, effort }, NOW)!;
      expect(snap.reasoningEffort).toBeUndefined();
      expect(snap.model).toBe(SAMPLE.model.id);
      expect(snap.contextPercent).toBe(23.4);
    },
  );

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

describe('parseStatuslinePayload (Antigravity)', () => {
  const RESET_5H_ISO = '2026-11-19T12:00:00Z';
  const RESET_7D_ISO = '2026-11-26T00:00:00Z';
  const AGY_QUOTA = {
    '3p-5h': { remaining_fraction: 0.4, reset_time: RESET_5H_ISO, reset_in_seconds: 3600 },
    '3p-weekly': { remaining_fraction: 0.85, reset_time: RESET_7D_ISO, reset_in_seconds: 86_400 },
    'gemini-5h': { remaining_fraction: 0.79, reset_time: RESET_5H_ISO, reset_in_seconds: 3600 },
    'gemini-argon-wtu-weekly': { remaining_fraction: 0.55, reset_time: RESET_7D_ISO, reset_in_seconds: 86_400 },
    'gemini-weekly': { remaining_fraction: 0.93, reset_time: RESET_7D_ISO, reset_in_seconds: 86_400 },
  };
  const AGY_BASE = {
    product: 'antigravity',
    version: '1.5.12',
    session_id: 'agy-conv-id',
    model: { id: 'Gemini 4 Neon (XHigh)', display_name: 'Gemini 4 Neon (XHigh)', effort: 'xhigh' },
    context_window: { context_window_size: 1_048_576, used_percentage: 18.5, remaining_percentage: 81.5 },
    quota: AGY_QUOTA,
  };

  it('routes Gemini Neon to gemini-5h + gemini-weekly (not argon sub-bucket), converts remaining → used %, and omits claudeSessionId', () => {
    const s = parseStatuslinePayload(AGY_BASE, NOW)!;
    expect(s.contextPercent).toBe(18.5);
    expect(s.contextWindowTokens).toBe(1_048_576);
    expect(s.fiveHourPercent).toBeCloseTo(21, 6);
    expect(s.fiveHourResetsAtMs).toBe(Date.parse(RESET_5H_ISO));
    expect(s.sevenDayPercent).toBeCloseTo(7, 6);
    expect(s.sevenDayResetsAtMs).toBe(Date.parse(RESET_7D_ISO));
    expect(s.model).toBe('Gemini 4 Neon (XHigh)');
    expect(s.claudeSessionId).toBeUndefined();
    expect(s.reasoningEffort).toBeUndefined();
    expect(toCardQuota(s)).toEqual({
      contextPercent: 19,
      contextWindowTokens: 1_048_576,
      fiveHourPercent: 21,
      fiveHourResetsAtMs: Date.parse(RESET_5H_ISO),
      sevenDayPercent: 7,
      sevenDayResetsAtMs: Date.parse(RESET_7D_ISO),
    });
  });

  it('routes Gemini Argon and Orchestrator (Argon) to gemini-argon-wtu-weekly while keeping gemini-5h', () => {
    for (const model of [
      { id: 'Gemini 4 Argon (High)', display_name: 'Gemini 4 Argon (High)' },
      { id: 'gemini-pro-orchestrator-g1-pro', display_name: 'Orchestrator (Argon)' },
    ]) {
      const s = parseStatuslinePayload({ ...AGY_BASE, model }, NOW)!;
      expect(s.fiveHourPercent).toBeCloseTo(21, 6);
      expect(s.sevenDayPercent).toBeCloseTo(45, 6);
    }
  });

  it('routes 3P models (Claude / GPT) to 3p-5h + 3p-weekly and does not cross-pollute with gemini buckets', () => {
    for (const model of [
      { id: 'Claude Opus 5.5 (High)', display_name: 'Claude Opus 5.5 (High)' },
      { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
    ]) {
      const s = parseStatuslinePayload({ ...AGY_BASE, model }, NOW)!;
      expect(s.fiveHourPercent).toBeCloseTo(60, 6);
      expect(s.sevenDayPercent).toBeCloseTo(15, 6);
    }
    // When 3p buckets are absent, never show gemini quota for a Claude model
    const no3p = parseStatuslinePayload({
      ...AGY_BASE,
      model: { id: 'Claude Opus 5.5 (High)' },
      quota: { 'gemini-5h': AGY_QUOTA['gemini-5h'], 'gemini-weekly': AGY_QUOTA['gemini-weekly'] },
    }, NOW)!;
    expect(no3p.fiveHourPercent).toBeUndefined();
    expect(no3p.sevenDayPercent).toBeUndefined();
  });

  it('omits placeholder contextPercent=0 when resumed Antigravity reports context_window_size=0, while preserving quota', () => {
    const s = parseStatuslinePayload({
      ...AGY_BASE,
      context_window: { context_window_size: 0, used_percentage: 0, remaining_percentage: 100 },
    }, NOW)!;
    expect(s.contextPercent).toBeUndefined();
    expect(s.contextWindowTokens).toBeUndefined();
    expect(s.fiveHourPercent).toBeCloseTo(21, 6);
    expect(s.sevenDayPercent).toBeCloseTo(7, 6);
    expect(toCardQuota(s)).toEqual({
      fiveHourPercent: 21,
      fiveHourResetsAtMs: Date.parse(RESET_5H_ISO),
      sevenDayPercent: 7,
      sevenDayResetsAtMs: Date.parse(RESET_7D_ISO),
    });
  });

  it('skips disabled buckets, falls back to reset_in_seconds, clamps fractions, and rolls over past ISO reset_time', () => {
    const s = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Gemini 4 Neon (High)' },
      quota: {
        'gemini-5h': { remaining_fraction: -0.2, reset_in_seconds: 120 },
        'gemini-weekly': { remaining_fraction: 1.5, disabled: true },
        'gemini-fallback-weekly': { remaining_fraction: 0.5, reset_time: new Date(NOW - 1000).toISOString() },
      },
    }, NOW)!;
    expect(s.fiveHourPercent).toBe(100);
    expect(s.fiveHourResetsAtMs).toBe(NOW + 120_000);
    expect(s.sevenDayPercent).toBe(50);
    expect(s.sevenDayResetsAtMs).toBe(NOW - 1000);

    // Rolled-over ISO reset_time drops only sevenDayPercent on read
    writeStatuslineSnapshot(dataDir, 'agy-rollover', s);
    const read = readStatuslineSnapshot(dataDir, 'agy-rollover', { now: NOW })!;
    expect(read.fiveHourPercent).toBe(100);
    expect(read.sevenDayPercent).toBeUndefined();
  });

  it('handles empty quota (e.g. GEMINI_API_KEY mode) without quota percentages', () => {
    const s = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Gemini 3.8 Flash (High)' },
      context_window: { context_window_size: 1_048_576, used_percentage: 4 },
      quota: {},
    }, NOW)!;
    expect(s.contextPercent).toBe(4);
    expect(s.fiveHourPercent).toBeUndefined();
    expect(s.sevenDayPercent).toBeUndefined();
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
