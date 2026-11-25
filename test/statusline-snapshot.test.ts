/**
 * statusline-snapshot — Claude Code statusline 快照的 parse / 落盘 / 读取 / 缓存 / 陈旧判定。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __testOnly_resetStatuslineCache,
  clearStatuslineSnapshot,
  isStatuslineModelCompatible,
  parseStatuslinePayload,
  readStatuslineSnapshot,
  removeStatuslineDir,
  statuslineDir,
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
        'gemini-weekly': { remaining_fraction: 0.5, reset_time: new Date(NOW - 1000).toISOString() },
        'gemini-argon-wtu-weekly': { remaining_fraction: 0.1, disabled: true },
      },
    }, NOW)!;
    expect(s.fiveHourPercent).toBe(100);
    expect(s.fiveHourResetsAtMs).toBe(NOW + 120_000);
    expect(s.fiveHourResetRelative).toBe(true);
    expect(s.sevenDayPercent).toBe(50);
    expect(s.sevenDayResetsAtMs).toBe(NOW - 1000);
    expect(s.sevenDayResetRelative).toBeUndefined();

    // Rolled-over ISO reset_time drops only sevenDayPercent on read
    writeStatuslineSnapshot(dataDir, 'agy-rollover', s);
    const read = readStatuslineSnapshot(dataDir, 'agy-rollover', { now: NOW })!;
    expect(read.fiveHourPercent).toBe(100);
    expect(read.sevenDayPercent).toBeUndefined();
  });

  it('fails closed on empty or unknown model for family-scoped buckets, while still accepting unscoped generic buckets', () => {
    for (const model of [undefined, {}, { id: '' }, { id: 'llama-4-maverick' }]) {
      const both = parseStatuslinePayload({ product: 'antigravity', model, quota: AGY_QUOTA }, NOW)!;
      expect(both.fiveHourPercent).toBeUndefined();
      expect(both.sevenDayPercent).toBeUndefined();

      const only3p = parseStatuslinePayload({
        product: 'antigravity',
        model,
        quota: { '3p-5h': AGY_QUOTA['3p-5h'], '3p-weekly': AGY_QUOTA['3p-weekly'] },
      }, NOW)!;
      expect(only3p.fiveHourPercent).toBeUndefined();
      expect(only3p.sevenDayPercent).toBeUndefined();

      const onlyGemini = parseStatuslinePayload({
        product: 'antigravity',
        model,
        quota: { 'gemini-5h': AGY_QUOTA['gemini-5h'], 'gemini-weekly': AGY_QUOTA['gemini-weekly'] },
      }, NOW)!;
      expect(onlyGemini.fiveHourPercent).toBeUndefined();
      expect(onlyGemini.sevenDayPercent).toBeUndefined();

      const generic = parseStatuslinePayload({
        product: 'antigravity',
        model,
        quota: {
          '5h': { remaining_fraction: 0.7, reset_time: RESET_5H_ISO },
          weekly: { remaining_fraction: 0.9, reset_time: RESET_7D_ISO },
        },
      }, NOW)!;
      expect(generic.fiveHourPercent).toBeCloseTo(30, 6);
      expect(generic.sevenDayPercent).toBeCloseTo(10, 6);
    }
  });

  it('fails closed on cross-variant Gemini fallback and cross-vendor 3P fallback when canonical buckets are absent or disabled', () => {
    // Gemini Neon missing/disabled gemini-weekly must never fall back to Argon or unknown sub-buckets
    const neonNoCanonical = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Gemini 4 Neon (High)' },
      quota: {
        'gemini-5h': AGY_QUOTA['gemini-5h'],
        'gemini-weekly': { remaining_fraction: 0.9, disabled: true },
        'gemini-argon-wtu-weekly': AGY_QUOTA['gemini-argon-wtu-weekly'],
        'gemini-fallback-weekly': { remaining_fraction: 0.2, reset_time: RESET_7D_ISO },
      },
    }, NOW)!;
    expect(neonNoCanonical.fiveHourPercent).toBeCloseTo(21, 6);
    expect(neonNoCanonical.sevenDayPercent).toBeUndefined();

    // Orchestrator (Argon) codename takes precedence over `pro` in id and never falls back to gemini-pro-weekly
    const orchestratorArgonNoCanonical = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'gemini-pro-orchestrator-g1-pro', display_name: 'Orchestrator (Argon)' },
      quota: {
        'gemini-pro-weekly': { remaining_fraction: 0.25, reset_time: RESET_7D_ISO },
      },
    }, NOW)!;
    expect(orchestratorArgonNoCanonical.sevenDayPercent).toBeUndefined();

    // Slug-only `gemini-pro-orchestrator-g1-pro` (without display_name) still resolves to argon, not pro
    const slugOnlyOrchestratorArgon = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'gemini-pro-orchestrator-g1-pro' },
      quota: {
        'gemini-argon-wtu-weekly': AGY_QUOTA['gemini-argon-wtu-weekly'],
        'gemini-pro-weekly': { remaining_fraction: 0.2, reset_time: RESET_7D_ISO },
        'gemini-weekly': AGY_QUOTA['gemini-weekly'],
      },
    }, NOW)!;
    expect(slugOnlyOrchestratorArgon.sevenDayPercent).toBeCloseTo(45, 6);

    // Active sibling bucket must not be shadowed by an expired 100% sibling bucket
    const activeOverExpired = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Claude Opus 5.5 (High)' },
      quota: {
        'claude-5h': { remaining_fraction: 0, reset_in_seconds: 0 },
        'anthropic-5h': { remaining_fraction: 0.4, reset_in_seconds: 3600 },
      },
    }, NOW)!;
    expect(activeOverExpired.fiveHourPercent).toBeCloseTo(60, 6);
    expect(activeOverExpired.fiveHourResetsAtMs).toBe(NOW + 3_600_000);

    // 3P Claude must never fall back to GPT buckets, and GPT must never fall back to Claude buckets
    const claudeWithGptOnly = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Claude Opus 5.5 (High)' },
      quota: {
        'gpt-5h': { remaining_fraction: 0.3, reset_time: RESET_5H_ISO },
        'openai-weekly': { remaining_fraction: 0.4, reset_time: RESET_7D_ISO },
      },
    }, NOW)!;
    expect(claudeWithGptOnly.fiveHourPercent).toBeUndefined();
    expect(claudeWithGptOnly.sevenDayPercent).toBeUndefined();

    const gptWithClaudeOnly = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'gpt-oss-120b-medium' },
      quota: {
        'claude-5h': { remaining_fraction: 0.3, reset_time: RESET_5H_ISO },
        'anthropic-weekly': { remaining_fraction: 0.4, reset_time: RESET_7D_ISO },
      },
    }, NOW)!;
    expect(gptWithClaudeOnly.fiveHourPercent).toBeUndefined();
    expect(gptWithClaudeOnly.sevenDayPercent).toBeUndefined();

    // Matching vendor-specific canonical bucket still works
    const claudeSpecific = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Claude Opus 5.5 (High)' },
      quota: {
        'claude-5h': { remaining_fraction: 0.2, reset_time: RESET_5H_ISO },
        '3p-5h': { remaining_fraction: 0.8, reset_time: RESET_5H_ISO },
      },
    }, NOW)!;
    expect(claudeSpecific.fiveHourPercent).toBeCloseTo(80, 6);
  });

  it.each([0, -30, -1e20, -1e308])('marks relative reset_in_seconds=%s (without reset_time) as expired so 100%% exhausted value is dropped on read (even on NTP step-back)', (resetInSec) => {
    const s = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Gemini 4 Neon (High)' },
      quota: {
        'gemini-5h': { remaining_fraction: 0, reset_in_seconds: resetInSec },
        'gemini-weekly': { remaining_fraction: 0.8, reset_in_seconds: 3600 },
      },
    }, NOW)!;
    expect(s.fiveHourResetsAtMs).toBeGreaterThanOrEqual(1);
    expect(s.fiveHourResetsAtMs).toBeLessThanOrEqual(NOW);
    expect(s.fiveHourResetRelative).toBe(true);
    expect(s.sevenDayResetsAtMs).toBe(NOW + 3_600_000);
    expect(s.sevenDayResetRelative).toBe(true);

    writeStatuslineSnapshot(dataDir, `agy-rel-exp-${resetInSec}`, s);
    const read = readStatuslineSnapshot(dataDir, `agy-rel-exp-${resetInSec}`, { now: NOW })!;
    expect(read.fiveHourPercent).toBeUndefined();
    expect(read.fiveHourResetsAtMs).toBe(s.fiveHourResetsAtMs);
    expect(read.sevenDayPercent).toBeCloseTo(20, 6);

    // NTP step-back (`now < snap.ts`) must not resurrect an already-expired 100% bucket
    const steppedBack = readStatuslineSnapshot(dataDir, `agy-rel-exp-${resetInSec}`, { now: NOW - 2_000 })!;
    expect(steppedBack.fiveHourPercent).toBeUndefined();
    expect(steppedBack.sevenDayPercent).toBeCloseTo(20, 6);
  });

  it('drops overflowing positive reset_in_seconds (Infinity) without setting orphaned relative marker', () => {
    const s = parseStatuslinePayload({
      product: 'antigravity',
      model: { id: 'Gemini 4 Neon (High)' },
      quota: {
        'gemini-5h': { remaining_fraction: 0.5, reset_in_seconds: 1e308 },
      },
    }, NOW)!;
    expect(s.fiveHourPercent).toBe(50);
    expect(s.fiveHourResetsAtMs).toBeUndefined();
    expect(s.fiveHourResetRelative).toBeUndefined();
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
  it('clearStatuslineSnapshot removes latest.json and cache while preserving the directory inode', () => {
    writeStatuslineSnapshot(dataDir, 'sid-7', { ts: NOW, contextPercent: 12 });
    const dir = statuslineDir(dataDir, 'sid-7');
    const dirInode = statSync(dir).ino;
    expect(readStatuslineSnapshot(dataDir, 'sid-7', { now: NOW })?.contextPercent).toBe(12);
    clearStatuslineSnapshot(dataDir, 'sid-7');
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).ino).toBe(dirInode);
    expect(existsSync(statuslineFilePath(dataDir, 'sid-7'))).toBe(false);
    expect(readStatuslineSnapshot(dataDir, 'sid-7', { now: NOW })).toBeUndefined();
  });
  it('notBefore rejects snapshots older than the launch boundary and accepts newer ones', () => {
    writeStatuslineSnapshot(dataDir, 'sid-8', { ts: NOW - 1, fiveHourPercent: 55 });
    expect(readStatuslineSnapshot(dataDir, 'sid-8', { now: NOW, notBefore: NOW })).toBeUndefined();
    expect(readStatuslineSnapshot(dataDir, 'sid-8', { now: NOW, notBefore: NOW - 1 })?.fiveHourPercent).toBe(55);
  });
  it('launchGen rejects snapshots from a prior CLI generation and accepts the current generation', () => {
    writeStatuslineSnapshot(dataDir, 'sid-gen', { ts: NOW, fiveHourPercent: 40, launchGen: 'gen-1' });
    expect(readStatuslineSnapshot(dataDir, 'sid-gen', { now: NOW, launchGen: 'gen-2' })).toBeUndefined();
    expect(readStatuslineSnapshot(dataDir, 'sid-gen', { now: NOW, launchGen: 'gen-1' })?.fiveHourPercent).toBe(40);
    expect(readStatuslineSnapshot(dataDir, 'sid-gen', { now: NOW })?.fiveHourPercent).toBe(40);
  });
  it('busts the cache on same-mtime equal-size atomic replacement (new inode)', () => {
    const path = statuslineFilePath(dataDir, 'sid-ino');
    const fixedTime = new Date(NOW);
    writeStatuslineSnapshot(dataDir, 'sid-ino', { ts: NOW, fiveHourPercent: 90 });
    utimesSync(path, fixedTime, fixedTime);
    const ino1 = statSync(path).ino;
    expect(readStatuslineSnapshot(dataDir, 'sid-ino', { now: NOW })?.fiveHourPercent).toBe(90);

    // Atomic replacement creates a new inode with identical byte length and mtime
    writeStatuslineSnapshot(dataDir, 'sid-ino', { ts: NOW, fiveHourPercent: 12 });
    utimesSync(path, fixedTime, fixedTime);
    expect(statSync(path).ino).not.toBe(ino1);
    expect(readStatuslineSnapshot(dataDir, 'sid-ino', { now: NOW })?.fiveHourPercent).toBe(12);
  });
});

describe('isStatuslineModelCompatible', () => {
  it('matches Antigravity slugs with display names and rejects cross-family / cross-variant switches', () => {
    expect(isStatuslineModelCompatible('antigravity', 'Gemini 4 Neon (XHigh)', 'gemini-4-neon-xhigh')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Gemini 4 Neon (High)', 'gemini-4-neon-xhigh')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Gemini 4 Argon (High)', 'gemini-4-argon-high')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Orchestrator (Argon)', 'gemini-pro-orchestrator-g1-pro')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Orchestrator (Neon)', 'gemini-pro-orchestrator-neon')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Claude Opus 5.5 (High)', 'claude-opus-5-5-high')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium')).toBe(true);

    expect(isStatuslineModelCompatible('antigravity', 'Gemini 4 Argon (High)', 'gemini-4-neon-xhigh')).toBe(false);
    expect(isStatuslineModelCompatible('antigravity', 'Claude Opus 5.5 (High)', 'gemini-4-neon-xhigh')).toBe(false);
    expect(isStatuslineModelCompatible('antigravity', 'Orchestrator (Argon)', 'gemini-pro-orchestrator-neon')).toBe(false);
    expect(isStatuslineModelCompatible('antigravity', 'Claude Sonnet 5.5 (High)', 'claude-opus-5-5-high')).toBe(false);
  });

  it('supports Claude Code aliases and rejects cross-family mismatches', () => {
    expect(isStatuslineModelCompatible('claude-code', 'claude-opus-5[1m]', 'opus')).toBe(true);
    expect(isStatuslineModelCompatible('claude-code', 'us.anthropic.claude-sonnet-4-6-v1', 'sonnet')).toBe(true);
    expect(isStatuslineModelCompatible('claude-code', 'claude-sonnet-5', 'default')).toBe(true);
    expect(isStatuslineModelCompatible('claude-code', 'claude-opus-5', 'opusplan')).toBe(true);
    expect(isStatuslineModelCompatible('claude-code', 'claude-sonnet-5', 'custom-corp-endpoint')).toBe(true);

    expect(isStatuslineModelCompatible('claude-code', 'claude-sonnet-5', 'opus')).toBe(false);
    expect(isStatuslineModelCompatible('claude-code', 'claude-fable-5', 'claude-sonnet-5')).toBe(false);
  });

  it('allows snapshots when either side omits model info', () => {
    expect(isStatuslineModelCompatible('antigravity', undefined, 'gemini-4-neon-xhigh')).toBe(true);
    expect(isStatuslineModelCompatible('antigravity', 'Gemini 4 Neon (XHigh)', undefined)).toBe(true);
    expect(isStatuslineModelCompatible('claude-code', undefined, 'opus')).toBe(true);
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
  it('omits 5h / 7d rate limits when includeRateLimits is false while keeping context metrics', () => {
    expect(toCardQuota(parseStatuslinePayload(SAMPLE, NOW)!, { includeRateLimits: false })).toEqual({
      contextPercent: 23,
      contextWindowTokens: 1_000_000,
    });
    expect(toCardQuota({ ts: NOW, fiveHourPercent: 21, sevenDayPercent: 7 }, { includeRateLimits: false })).toBeUndefined();
  });
});
