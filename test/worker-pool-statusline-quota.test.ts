/**
 * getDaemonSessionUsageSnapshot 是回复卡页脚 / 流式卡用量行 / IPC `/usage` 三个读取点的
 * 唯一汇合处：Claude Code statusline 快照（ctx / 5h / 7d）只在这里合并一次。
 * 无快照 / 陈旧 / 非 claude-code ⇒ 原样返回 transcript 快照（同一对象，不带 quota key），
 * 保证卡片与无 statusline 时逐字节相同。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as costCalculator from '../src/core/cost-calculator.js';
import { getDaemonSessionUsageSnapshot } from '../src/core/worker-pool.js';
import {
  __testOnly_resetStatuslineCache,
  STATUSLINE_STALE_MS,
  writeStatuslineSnapshot,
} from '../src/services/statusline-snapshot.js';

let dataDir: string;
let prevDataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-wp-statusline-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  __testOnly_resetStatuslineCache();
});
afterEach(() => {
  config.session.dataDir = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// 不带 larkAppId：pricing 解析短路为 undefined，且 cliId 由显式参数给出，不触碰 bot registry。
const ds = (sessionId: string) => ({ session: { sessionId }, workingDir: '/repo' }) as any;

describe('getDaemonSessionUsageSnapshot × Claude statusline quota', () => {
  it('merges the on-disk statusline snapshot for claude-code (rounded percentages)', () => {
    const base = { context: { usedTokens: 12_345 }, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's1', { ts: Date.now(), contextPercent: 23.4, fiveHourPercent: 18, sevenDayPercent: 5.4 });
    expect(getDaemonSessionUsageSnapshot(ds('s1'), 'claude-code')).toEqual({
      ...base,
      quota: { contextPercent: 23, fiveHourPercent: 18, sevenDayPercent: 5 },
    });
  });

  it('returns the transcript snapshot untouched (same object, no quota key) when no snapshot exists', () => {
    const base = { context: { usedTokens: 12_345 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    const out = getDaemonSessionUsageSnapshot(ds('s2'), 'claude-code');
    expect(out).toBe(base);
    expect('quota' in out).toBe(false);
  });

  it('ignores the snapshot for non-claude-code CLIs even when a file exists', () => {
    const base = { context: null, tokens: { in: 1, out: 2 } };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's3', { ts: Date.now(), fiveHourPercent: 18 });
    expect(getDaemonSessionUsageSnapshot(ds('s3'), 'codex' as any)).toBe(base);
  });

  it('drops a stale snapshot (older than STATUSLINE_STALE_MS) → no quota key', () => {
    const base = { context: { usedTokens: 1 }, tokens: null };
    vi.spyOn(costCalculator, 'getSessionUsageSnapshot').mockReturnValue(base as any);
    writeStatuslineSnapshot(dataDir, 's4', { ts: Date.now() - STATUSLINE_STALE_MS - 1, contextPercent: 50 });
    expect(getDaemonSessionUsageSnapshot(ds('s4'), 'claude-code')).toBe(base);
  });
});
