/**
 * Budget tracker tests — per-bot monthly spend accumulation, edge-triggered
 * threshold alerting with de-dup, month rollover, hard-stop checks and
 * ledger rebuild on state loss.
 *
 * Run:  pnpm vitest run test/budget-tracker.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  parseBudgetConfig,
  trackBudgetSpend,
  getBudgetStatus,
  isBudgetHardStopped,
  formatBudgetAlert,
  _resetBudgetTrackerForTest,
  type BudgetConfig,
} from '../src/services/budget-tracker.js';

const AUG = new Date('2026-08-15T00:00:00Z');
const SEP = new Date('2026-09-02T00:00:00Z');

function budget(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return { monthlyCny: 100, alertThresholdPercent: [80], hardStop: false, ...overrides };
}

function stateFile(dir: string, appId = 'cli_a'): string {
  return join(dir, `budget-state-${appId}.json`);
}

function readState(dir: string, appId = 'cli_a'): any {
  return JSON.parse(readFileSync(stateFile(dir, appId), 'utf8'));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'budget-tracker-'));
  _resetBudgetTrackerForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseBudgetConfig', () => {
  it('parses a full valid config', () => {
    expect(parseBudgetConfig({ monthlyCny: 100, alertThresholdPercent: [50, 80], hardStop: true }))
      .toEqual({ monthlyCny: 100, alertThresholdPercent: [50, 80], hardStop: true });
  });

  it('returns null when monthlyCny is missing', () => {
    expect(parseBudgetConfig({ alertThresholdPercent: [80] })).toBeNull();
  });

  it.each([0, -5, NaN, '100', Infinity])('returns null for non-positive/non-finite monthlyCny (%s)', (v) => {
    expect(parseBudgetConfig({ monthlyCny: v })).toBeNull();
  });

  it('defaults thresholds to [80] when absent', () => {
    expect(parseBudgetConfig({ monthlyCny: 100 })).toEqual({ monthlyCny: 100, alertThresholdPercent: [80], hardStop: false });
  });

  it('filters invalid thresholds, dedupes and sorts', () => {
    expect(parseBudgetConfig({ monthlyCny: 100, alertThresholdPercent: [80, '50', -1, 0, 1001, NaN, 50, 80] }))
      .toEqual({ monthlyCny: 100, alertThresholdPercent: [50, 80], hardStop: false });
  });

  it('falls back to [80] when all thresholds are invalid', () => {
    expect(parseBudgetConfig({ monthlyCny: 100, alertThresholdPercent: ['x', -1, 2000] }))
      .toEqual({ monthlyCny: 100, alertThresholdPercent: [80], hardStop: false });
  });

  it('defaults hardStop to false', () => {
    expect(parseBudgetConfig({ monthlyCny: 100, hardStop: 'yes' })?.hardStop).toBe(false);
  });

  // Tuple-wrapped: a bare `[]` row spreads to zero arguments, so a callback with a
  // declared parameter reads as wanting a `done` callback and `bun test` hangs until
  // the timeout. See the same note in test/bot-description-schema.test.ts.
  it.each([[null], [undefined], ['str'], [[]], [42], [true]])('returns null for garbage input (%s)', (raw) => {
    expect(parseBudgetConfig(raw)).toBeNull();
  });
});

describe('trackBudgetSpend', () => {
  it('accumulates spend across calls and persists the state file', () => {
    trackBudgetSpend('cli_a', 100, { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 1000 }) });
    trackBudgetSpend('cli_a', 200, { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 1000 }) });

    expect(getBudgetStatus('cli_a', { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 1000 }) }))
      .toMatchObject({ month: '2026-08', spentCny: 300 });

    // temp+rename durability: final file exists, no tmp leftovers.
    expect(existsSync(stateFile(dir))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(readState(dir)).toMatchObject({ month: '2026-08', spentCny: 300, alertedThresholds: [] });
  });

  it('alerts once per threshold and never re-fires on lingering spend', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80] });
    const first = trackBudgetSpend('cli_a', 85, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(first).toMatchObject({ threshold: 80, percent: 85, spentCny: 85, monthlyCny: 100, hardStop: false });

    // Still above 80% — no second alert.
    expect(trackBudgetSpend('cli_a', 1, { now: AUG, ledgerDir: dir, budget: cfg })).toBeNull();
    expect(readState(dir).alertedThresholds).toEqual([80]);
  });

  it('fires a single alert on a multi-threshold jump, carrying the highest crossed threshold', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [50, 80, 90] });
    const alert = trackBudgetSpend('cli_a', 95, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(alert).toMatchObject({ threshold: 90, percent: 95 });
    // All crossed thresholds are marked, so none can re-fire later.
    expect(readState(dir).alertedThresholds.sort((a, b) => a - b)).toEqual([50, 80, 90]);

    expect(trackBudgetSpend('cli_a', 1, { now: AUG, ledgerDir: dir, budget: cfg })).toBeNull();
  });

  it('implies a 100% threshold when hardStop is enabled', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80], hardStop: true });
    const alert = trackBudgetSpend('cli_a', 100, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(alert).toMatchObject({ threshold: 100, hardStop: true, percent: 100 });
    expect(readState(dir).alertedThresholds.sort((a, b) => a - b)).toEqual([80, 100]);
  });

  it('rolls over lazily when the month changes', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80] });
    expect(trackBudgetSpend('cli_a', 90, { now: AUG, ledgerDir: dir, budget: cfg }))
      .toMatchObject({ threshold: 80 });

    // New month: spend resets, August's alerted state does not leak through.
    const sepAlert = trackBudgetSpend('cli_a', 10, { now: SEP, ledgerDir: dir, budget: cfg });
    expect(sepAlert).toBeNull();
    expect(getBudgetStatus('cli_a', { now: SEP, ledgerDir: dir, budget: cfg }))
      .toMatchObject({ month: '2026-09', spentCny: 10, percent: 10 });
  });

  it('accumulates without a budget but never alerts', () => {
    expect(trackBudgetSpend('cli_a', 5, { now: AUG, ledgerDir: dir, budget: null })).toBeNull();
    const status = getBudgetStatus('cli_a', { now: AUG, ledgerDir: dir, budget: null });
    expect(status).toMatchObject({ month: '2026-08', spentCny: 5, hardStop: false });
    expect(status!.monthlyCny).toBeUndefined();
    expect(status!.percent).toBeUndefined();
  });

  it('ignores non-finite cost', () => {
    expect(trackBudgetSpend('cli_a', NaN, { now: AUG, ledgerDir: dir, budget: budget() })).toBeNull();
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it('rebuilds spend from the current month ledger when the state file is missing', () => {
    writeFileSync(join(dir, 'usage-2026-08-10.jsonl'), [
      JSON.stringify({ larkAppId: 'cli_a', costCny: 1.5 }),
      JSON.stringify({ larkAppId: 'cli_a', costCny: 2.5 }),
      JSON.stringify({ larkAppId: 'cli_a' }), // 升级前旧记录：无 costCny → 计 0
      JSON.stringify({ larkAppId: 'cli_b', costCny: 99 }), // 他 bot 不计入
      '',
    ].join('\n'));
    // 上月记录不参与当月重建。
    writeFileSync(join(dir, 'usage-2026-07-31.jsonl'), JSON.stringify({ larkAppId: 'cli_a', costCny: 7 }) + '\n');

    const alert = trackBudgetSpend('cli_a', 1, {
      now: AUG,
      ledgerDir: dir,
      budget: budget({ monthlyCny: 10, alertThresholdPercent: [50] }),
    });
    // rebuilt 4.0 + 1.0 = 5.0 → 50% 线
    expect(alert).toMatchObject({ threshold: 50, spentCny: 5.0, monthlyCny: 10, percent: 50 });
    expect(readState(dir)).toMatchObject({ month: '2026-08', spentCny: 5.0 });
  });
});

describe('getBudgetStatus', () => {
  it('returns null with neither budget nor spend', () => {
    expect(getBudgetStatus('cli_a', { now: AUG, ledgerDir: dir, budget: null })).toBeNull();
  });

  it('returns zero values with a budget but no spend', () => {
    expect(getBudgetStatus('cli_a', { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 100 }) }))
      .toEqual({ month: '2026-08', spentCny: 0, monthlyCny: 100, percent: 0, hardStop: false });
  });

  it('omits monthlyCny/percent with spend but no budget', () => {
    trackBudgetSpend('cli_a', 5, { now: AUG, ledgerDir: dir, budget: null });
    const status = getBudgetStatus('cli_a', { now: AUG, ledgerDir: dir, budget: null });
    expect(status).toEqual({ month: '2026-08', spentCny: 5, hardStop: false });
  });
});

describe('isBudgetHardStopped', () => {
  it('is false when hardStop is disabled even past the budget', () => {
    trackBudgetSpend('cli_a', 150, { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 100 }) });
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: budget({ monthlyCny: 100 }) })).toBe(false);
  });

  it('is false when enabled but not yet over', () => {
    const cfg = budget({ monthlyCny: 100, hardStop: true });
    trackBudgetSpend('cli_a', 99.99, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: cfg })).toBe(false);
  });

  it('is true when enabled and spent >= budget', () => {
    const cfg = budget({ monthlyCny: 100, hardStop: true });
    trackBudgetSpend('cli_a', 100, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: cfg })).toBe(true);
  });

  it('fails open on a corrupt state file', () => {
    const cfg = budget({ monthlyCny: 100, hardStop: true });
    trackBudgetSpend('cli_a', 150, { now: AUG, ledgerDir: dir, budget: cfg });
    writeFileSync(stateFile(dir), '{not json');
    // 模拟新进程读盘：清掉内存缓存，避免同 mtime tick 命中陈旧状态
    _resetBudgetTrackerForTest();
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: cfg })).toBe(false);
  });

  it('is false after the month rolls over', () => {
    const cfg = budget({ monthlyCny: 100, hardStop: true });
    trackBudgetSpend('cli_a', 150, { now: AUG, ledgerDir: dir, budget: cfg });
    expect(isBudgetHardStopped('cli_a', { now: SEP, ledgerDir: dir, budget: cfg })).toBe(false);
  });

  it('is false without a budget', () => {
    trackBudgetSpend('cli_a', 150, { now: AUG, ledgerDir: dir, budget: null });
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: null })).toBe(false);
  });
});

describe('formatBudgetAlert', () => {
  it('renders the exhausted message for hardStop at the 100% line', () => {
    const msg = formatBudgetAlert({
      larkAppId: 'cli_a', month: '2026-08', spentCny: 105, monthlyCny: 100,
      percent: 105, threshold: 100, hardStop: true,
    });
    expect(msg).toContain('🚫');
    expect(msg).toContain('¥105.00 / ¥100.00');
    // 必须说明「不会自动拒绝」并给出人工动作：hardStop 只有判定原语，
    // 没有任何 turn 准入路径调用 isBudgetHardStopped。
    expect(msg).toContain('不会自动拒绝新任务');
    expect(msg).toContain('请人工关注');
  });

  // 防回归：hardStop 真接入准入路径之前，文案不得承诺拦截。owner 以为
  // 已被自动保护而停止人工关注，比不发告警更糟。真落地拦截时连同
  // isBudgetHardStopped 的调用点一起改这条断言。
  it('never promises rejection while hardStop enforcement is unwired', () => {
    for (const hardStop of [true, false]) {
      for (const threshold of [80, 100]) {
        const msg = formatBudgetAlert({
          larkAppId: 'cli_a', month: '2026-08', spentCny: 105, monthlyCny: 100,
          percent: 105, threshold, hardStop,
        });
        expect(msg, `hardStop=${hardStop} threshold=${threshold}`).not.toContain('新任务将被拒绝');
        expect(msg, `hardStop=${hardStop} threshold=${threshold}`).not.toContain('自动恢复');
      }
    }
  });

  it('renders the threshold message for regular alerts', () => {
    const msg = formatBudgetAlert({
      larkAppId: 'cli_a', month: '2026-08', spentCny: 85, monthlyCny: 100,
      percent: 85, threshold: 80, hardStop: false,
    });
    expect(msg).toContain('⚠️');
    expect(msg).toContain('越过 80% 告警线');
    expect(msg).toContain('¥85.00 / ¥100.00');
  });
});

// ─── ledger sink → tracker → owner alert (the daemon's wiring, end to end) ────
// daemon 的 setUsageLedgerRecordSink 回调把每条正 delta ledger 记录喂进
// trackBudgetSpend，超阈值时把 formatBudgetAlert 的文案私聊 owner。这里复刻
// 那段 glue（同样的守卫顺序），确保「记录落盘 → 累加 → 告警文案」这条链不会
// 在任何一环静默断掉——之前整条链没有任何测试。

describe('record sink → trackBudgetSpend → formatBudgetAlert (daemon wiring)', () => {
  /** 复刻 daemon.ts 的 sink 回调：守卫 + 累加 + 生成告警文案。 */
  function daemonSink(
    record: { larkAppId?: string; costCny?: number },
    cfg: BudgetConfig | undefined,
    now: Date,
  ): string | null {
    if (!record.larkAppId || !record.costCny || record.costCny <= 0) return null;
    if (!cfg) return null;
    const alert = trackBudgetSpend(record.larkAppId, record.costCny, {
      now, ledgerDir: dir, budget: cfg,
    });
    return alert ? formatBudgetAlert(alert) : null;
  }

  it('accumulates across records and alerts once when a threshold is crossed', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80] });
    // 三条记录累加到 85 → 越过 80% 告警线，只在跨线那条上告警。
    expect(daemonSink({ larkAppId: 'cli_a', costCny: 40 }, cfg, AUG)).toBeNull();
    expect(daemonSink({ larkAppId: 'cli_a', costCny: 30 }, cfg, AUG)).toBeNull();
    const msg = daemonSink({ larkAppId: 'cli_a', costCny: 15 }, cfg, AUG);
    expect(msg).toContain('⚠️');
    expect(msg).toContain('¥85.00 / ¥100.00');
    // 同阈值不重复告警。
    expect(daemonSink({ larkAppId: 'cli_a', costCny: 1 }, cfg, AUG)).toBeNull();
    expect(readState(dir).spentCny).toBeCloseTo(86, 6);
  });

  it('skips records the daemon guards out (no appId / no cost / non-positive)', () => {
    const cfg = budget({ monthlyCny: 10, alertThresholdPercent: [1] });
    expect(daemonSink({ costCny: 100 }, cfg, AUG)).toBeNull();          // 无 larkAppId
    expect(daemonSink({ larkAppId: 'cli_a' }, cfg, AUG)).toBeNull();     // 无 costCny（未定价）
    expect(daemonSink({ larkAppId: 'cli_a', costCny: 0 }, cfg, AUG)).toBeNull();
    expect(daemonSink({ larkAppId: 'cli_a', costCny: -5 }, cfg, AUG)).toBeNull();
    // 一条都没记账 → 状态文件根本没被创建。
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it('does nothing when the bot has no budget configured', () => {
    expect(daemonSink({ larkAppId: 'cli_a', costCny: 999 }, undefined, AUG)).toBeNull();
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it('keeps per-bot spend isolated', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80] });
    daemonSink({ larkAppId: 'cli_a', costCny: 90 }, cfg, AUG);
    // cli_b 自己的账本是空的 → 同样金额也只算它自己的第一笔。
    const msgB = daemonSink({ larkAppId: 'cli_b', costCny: 85 }, cfg, AUG);
    expect(msgB).toContain('¥85.00 / ¥100.00');
    expect(readState(dir, 'cli_a').spentCny).toBeCloseTo(90, 6);
    expect(readState(dir, 'cli_b').spentCny).toBeCloseTo(85, 6);
  });

  it('the exhausted alert it emits never promises rejection (hardStop unwired)', () => {
    const cfg = budget({ monthlyCny: 100, alertThresholdPercent: [80], hardStop: true });
    const msg = daemonSink({ larkAppId: 'cli_a', costCny: 120 }, cfg, AUG);
    // hardStop 隐含 100% 线 → 走「已用尽」分支，但必须说实话。
    expect(msg).toContain('🚫');
    expect(msg).toContain('不会自动拒绝新任务');
    expect(msg).not.toContain('新任务将被拒绝');
    // 而且确实没有任何拦截发生：判定原语此刻为 true，却无人调用它。
    expect(isBudgetHardStopped('cli_a', { now: AUG, ledgerDir: dir, budget: cfg })).toBe(true);
  });
});
