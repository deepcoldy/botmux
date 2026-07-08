/**
 * Unit tests for scheduler: parseNaturalSchedule().
 *
 * Covers Chinese natural language time expressions parsed into cron,
 * including daily, weekly, monthly, hourly, minute-based patterns,
 * workday schedules, various time formats, and edge cases.
 *
 * Run:  pnpm vitest run test/scheduler.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseNaturalSchedule, parseSchedule, computeNextRun, extractDeliveryMode, planCronRealign } from '../src/core/scheduler.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Shorthand: assert a successful parse returns expected cron + prompt. */
function expectParse(input: string, cron: string, prompt: string) {
  const result = parseNaturalSchedule(input);
  expect(result).not.toBeNull();
  expect(result!.parsed.kind).toBe('cron');
  expect(result!.parsed.expr).toBe(cron);
  expect(result!.prompt).toBe(prompt);
}

// ─── 每天 / 每日 (daily) ─────────────────────────────────────────────────────

describe('Daily schedules (每天/每日)', () => {
  it('每天 with HH:MM colon format', () => {
    expectParse('每天9:00 检查服务状态', '0 9 * * *', '检查服务状态');
  });

  it('每日 with HH:MM colon format', () => {
    // 给我 is stripped but 帮我 remains (regex only removes one leading [给帮]我)
    expectParse('每日17:50给我帮我看看AI新闻', '50 17 * * *', '帮我看看AI新闻');
  });

  it('每天 with full-width colon', () => {
    expectParse('每天17：50 检查状态', '50 17 * * *', '检查状态');
  });

  it('每天 with X点Y分 format', () => {
    expectParse('每天9点30分 发日报', '30 9 * * *', '发日报');
  });

  it('每天 with X点Y (no 分)', () => {
    expectParse('每天9点30 开会提醒', '30 9 * * *', '开会提醒');
  });

  it('每天 with whole hour X点', () => {
    expectParse('每天9点 检查邮件', '0 9 * * *', '检查邮件');
  });

  it('每日 midnight edge case', () => {
    expectParse('每日0:00 清理缓存', '0 0 * * *', '清理缓存');
  });

  it('每天 23:59 end-of-day edge case', () => {
    expectParse('每天23:59 备份数据', '59 23 * * *', '备份数据');
  });
});

// ─── 工作日 (weekday / Mon-Fri) ──────────────────────────────────────────────

describe('Workday schedules (工作日)', () => {
  it('每个工作日 HH:MM', () => {
    expectParse('每个工作日9:00 检查邮件', '0 9 * * 1-5', '检查邮件');
  });

  it('工作日每天 HH:MM', () => {
    expectParse('工作日每天9:00 检查邮件', '0 9 * * 1-5', '检查邮件');
  });

  it('工作日每日 HH:MM', () => {
    expectParse('工作日每日18:00 写日报', '0 18 * * 1-5', '写日报');
  });

  it('每工作日 HH:MM', () => {
    expectParse('每工作日9:30 站会', '30 9 * * 1-5', '站会');
  });
});

// ─── 每周X (weekly) ──────────────────────────────────────────────────────────

describe('Weekly schedules (每周X)', () => {
  it('每周一', () => {
    expectParse('每周一10:30 生成周报', '30 10 * * 1', '生成周报');
  });

  it('每周二', () => {
    expectParse('每周二14:00 代码审查', '0 14 * * 2', '代码审查');
  });

  it('每周三', () => {
    expectParse('每周三9:00 团队会议', '0 9 * * 3', '团队会议');
  });

  it('每周四', () => {
    expectParse('每周四15:00 复盘', '0 15 * * 4', '复盘');
  });

  it('每周五', () => {
    expectParse('每周五17:00 提交周报', '0 17 * * 5', '提交周报');
  });

  it('每周六', () => {
    expectParse('每周六10:00 学习', '0 10 * * 6', '学习');
  });

  it('每周日 (maps to 0)', () => {
    expectParse('每周日8:00 整理', '0 8 * * 0', '整理');
  });

  it('每周天 (alias for 日, maps to 0)', () => {
    expectParse('每周天8:00 整理', '0 8 * * 0', '整理');
  });

  it('weekly with X点Y分 time format', () => {
    expectParse('每周一9点30分 站会提醒', '30 9 * * 1', '站会提醒');
  });
});

// ─── 每月X号 (monthly) ───────────────────────────────────────────────────────

describe('Monthly schedules (每月X号)', () => {
  it('每月1号', () => {
    expectParse('每月1号9:00 生成月报', '0 9 1 * *', '生成月报');
  });

  it('每月15号', () => {
    expectParse('每月15号10:00 发工资提醒', '0 10 15 * *', '发工资提醒');
  });

  it('每月31号 boundary', () => {
    expectParse('每月31号23:59 月末统计', '59 23 31 * *', '月末统计');
  });

  it('每月X日 (日 variant)', () => {
    expectParse('每月5日9:00 检查', '0 9 5 * *', '检查');
  });
});

// ─── 每小时 / 每N小时 (hourly) ──────────────────────────────────────────────

describe('Hourly schedules', () => {
  it('每小时', () => {
    expectParse('每小时 检查服务', '0 * * * *', '检查服务');
  });

  it('每1小时 (same as 每小时)', () => {
    expectParse('每1小时 检查服务', '0 * * * *', '检查服务');
  });

  it('每2小时', () => {
    expectParse('每2小时 巡检', '0 */2 * * *', '巡检');
  });

  it('每6小时', () => {
    expectParse('每6小时 同步数据', '0 */6 * * *', '同步数据');
  });

  it('每12小时', () => {
    expectParse('每12小时 备份', '0 */12 * * *', '备份');
  });
});

// ─── 每N分钟 (minute-based) ──────────────────────────────────────────────────

describe('Minute-based schedules', () => {
  it('每30分钟', () => {
    expectParse('每30分钟 ping', '*/30 * * * *', 'ping');
  });

  it('每5分钟', () => {
    expectParse('每5分钟 健康检查', '*/5 * * * *', '健康检查');
  });

  it('每1分钟', () => {
    expectParse('每1分钟 心跳', '*/1 * * * *', '心跳');
  });

  it('每15分钟', () => {
    expectParse('每15分钟 刷新缓存', '*/15 * * * *', '刷新缓存');
  });
});

// ─── Prompt cleaning (给我/帮我 prefix removal, quote stripping) ─────────────

describe('extractDeliveryMode (新话题 keyword)', () => {
  it('strips leading 新话题 and resolves new-topic', () => {
    expect(extractDeliveryMode('新话题 帮我看AI新闻')).toEqual({ deliver: 'new-topic', prompt: '帮我看AI新闻' });
  });

  it('accepts 每次新话题 variant', () => {
    expect(extractDeliveryMode('每次新话题：生成日报')).toEqual({ deliver: 'new-topic', prompt: '生成日报' });
  });

  it('accepts 新开话题 variant', () => {
    expect(extractDeliveryMode('新开话题 跑构建')).toEqual({ deliver: 'new-topic', prompt: '跑构建' });
  });

  it('accepts 开新话题 (开 before 新)', () => {
    expect(extractDeliveryMode('开新话题 生成日报')).toEqual({ deliver: 'new-topic', prompt: '生成日报' });
  });

  it('accepts 每次开新话题 (Codex P2 missed variant)', () => {
    expect(extractDeliveryMode('每次开新话题 生成日报')).toEqual({ deliver: 'new-topic', prompt: '生成日报' });
  });

  it('accepts 每次开一个新话题 (Codex P2 missed variant)', () => {
    expect(extractDeliveryMode('每次开一个新话题 生成日报')).toEqual({ deliver: 'new-topic', prompt: '生成日报' });
  });

  it('accepts 新开一个话题 variant', () => {
    expect(extractDeliveryMode('新开一个话题 跑构建')).toEqual({ deliver: 'new-topic', prompt: '跑构建' });
  });

  it('accepts 每天/每日 prefix variants', () => {
    expect(extractDeliveryMode('每天新话题 早报')).toEqual({ deliver: 'new-topic', prompt: '早报' });
    expect(extractDeliveryMode('每日开新话题 晚报')).toEqual({ deliver: 'new-topic', prompt: '晚报' });
  });

  it('does NOT match 新闻话题 (新 not immediately tied to 话题)', () => {
    expect(extractDeliveryMode('新闻话题汇总')).toEqual({ deliver: 'origin', prompt: '新闻话题汇总' });
  });

  it('accepts english new-topic / new topic', () => {
    expect(extractDeliveryMode('new-topic: daily report')).toEqual({ deliver: 'new-topic', prompt: 'daily report' });
    expect(extractDeliveryMode('new topic - run build')).toEqual({ deliver: 'new-topic', prompt: 'run build' });
  });

  it('leaves normal prompt as origin, unchanged', () => {
    expect(extractDeliveryMode('帮我看AI新闻')).toEqual({ deliver: 'origin', prompt: '帮我看AI新闻' });
  });

  it('does not treat a prompt that merely mentions 话题 mid-sentence as new-topic', () => {
    expect(extractDeliveryMode('总结这个话题的讨论')).toEqual({ deliver: 'origin', prompt: '总结这个话题的讨论' });
  });

  it('keyword with nothing after it stays origin (degenerate)', () => {
    expect(extractDeliveryMode('新话题')).toEqual({ deliver: 'origin', prompt: '新话题' });
  });
});

describe('Prompt cleaning', () => {
  it('removes 给我 prefix', () => {
    expectParse('每天9:00 给我查看状态', '0 9 * * *', '查看状态');
  });

  it('removes 帮我 prefix', () => {
    expectParse('每天9:00 帮我检查日志', '0 9 * * *', '检查日志');
  });

  it('removes 给我帮我 combined prefix (from regex)', () => {
    // The regex removes leading 给我 or 帮我. "给我帮我看看" -> first removes "给我" -> "帮我看看" stays.
    // Actually the regex is /^[给帮]我\s*/ which matches one of 给我 or 帮我 at the start.
    const result = parseNaturalSchedule('每天9:00 给我 看看新闻');
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('看看新闻');
  });

  it('strips surrounding double quotes', () => {
    expectParse('每天9:00 "检查服务"', '0 9 * * *', '检查服务');
  });

  it('strips surrounding single quotes', () => {
    expectParse("每天9:00 '检查服务'", '0 9 * * *', '检查服务');
  });

  it('strips surrounding Chinese quotes 「」', () => {
    expectParse('每天9:00 「检查服务」', '0 9 * * *', '检查服务');
  });

  it('does NOT strip curly double quotes \u201c\u201d (not in regex)', () => {
    // The regex only handles ASCII quotes and 「」, not Unicode curly quotes
    expectParse('每天9:00 \u201c检查服务\u201d', '0 9 * * *', '\u201c检查服务\u201d');
  });

  it('does NOT strip curly single quotes \u2018\u2019 (not in regex)', () => {
    expectParse('每天9:00 \u2018检查服务\u2019', '0 9 * * *', '\u2018检查服务\u2019');
  });
});

// ─── Auto-generated name ─────────────────────────────────────────────────────

describe('Auto-generated name', () => {
  it('short prompt used as-is for name', () => {
    const result = parseNaturalSchedule('每天9:00 检查');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('检查');
  });

  it('name truncated to 20 chars with ellipsis for long prompt', () => {
    const longPrompt = '这是一段超过二十个字符的很长的提示文本用来测试截断';
    const result = parseNaturalSchedule(`每天9:00 ${longPrompt}`);
    expect(result).not.toBeNull();
    expect(result!.name).toBe(longPrompt.substring(0, 20) + '...');
    expect(result!.name.length).toBe(23); // 20 chars + "..."
  });

  it('exactly 20-char prompt is not truncated', () => {
    const prompt20 = '12345678901234567890'; // exactly 20
    const result = parseNaturalSchedule(`每天9:00 ${prompt20}`);
    expect(result).not.toBeNull();
    expect(result!.name).toBe(prompt20);
  });

  it('21-char prompt is truncated', () => {
    const prompt21 = '123456789012345678901'; // 21 chars
    const result = parseNaturalSchedule(`每天9:00 ${prompt21}`);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('12345678901234567890...');
  });
});

// ─── Edge cases & invalid input ──────────────────────────────────────────────

describe('Edge cases and invalid input', () => {
  it('returns null for empty string', () => {
    expect(parseNaturalSchedule('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseNaturalSchedule('   ')).toBeNull();
  });

  it('returns null for unrecognized pattern', () => {
    expect(parseNaturalSchedule('明天下午三点开会')).toBeNull();
  });

  it('returns null for random text', () => {
    expect(parseNaturalSchedule('hello world')).toBeNull();
  });

  it('returns null for raw cron expression (not handled by parser)', () => {
    expect(parseNaturalSchedule('0 9 * * *')).toBeNull();
  });

  it('returns null when no prompt is provided after time', () => {
    expect(parseNaturalSchedule('每天9:00')).toBeNull();
  });

  it('returns null when prompt is empty after cleaning', () => {
    expect(parseNaturalSchedule('每天9:00 给我')).toBeNull();
  });

  it('returns null when only 帮我 after time (cleaned to empty)', () => {
    expect(parseNaturalSchedule('每天9:00 帮我')).toBeNull();
  });

  it('returns null for 每周 without valid weekday char', () => {
    expect(parseNaturalSchedule('每周9:00 测试')).toBeNull();
  });

  it('returns null for 每月 without 号/日', () => {
    expect(parseNaturalSchedule('每月9:00 测试')).toBeNull();
  });

  it('handles leading/trailing whitespace in input', () => {
    expectParse('  每天9:00 检查状态  ', '0 9 * * *', '检查状态');
  });

  it('handles prompt with extra spaces', () => {
    expectParse('每天9:00  检查状态', '0 9 * * *', '检查状态');
  });
});

// ─── Time format variants ────────────────────────────────────────────────────

describe('Time format variants', () => {
  it('single-digit hour with colon', () => {
    expectParse('每天9:00 测试', '0 9 * * *', '测试');
  });

  it('double-digit hour with colon', () => {
    expectParse('每天09:00 测试', '0 9 * * *', '测试');
  });

  it('full-width colon ：', () => {
    expectParse('每天9：30 测试', '30 9 * * *', '测试');
  });

  it('X点 whole hour', () => {
    expectParse('每天9点 测试', '0 9 * * *', '测试');
  });

  it('X点Y分', () => {
    expectParse('每天9点30分 测试', '30 9 * * *', '测试');
  });

  it('X点Y without 分', () => {
    expectParse('每天9点30 测试', '30 9 * * *', '测试');
  });
});

// ─── WEEKDAY_MAP coverage ────────────────────────────────────────────────────

describe('WEEKDAY_MAP: all Chinese weekday names', () => {
  const weekdays: [string, number][] = [
    ['一', 1],
    ['二', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['日', 0],
    ['天', 0],
  ];

  for (const [char, num] of weekdays) {
    it(`每周${char} maps to weekday ${num}`, () => {
      expectParse(`每周${char}10:00 测试`, `0 10 * * ${num}`, '测试');
    });
  }
});

// ─── Return shape ────────────────────────────────────────────────────────────

describe('Return value shape', () => {
  it('includes all expected fields', () => {
    const result = parseNaturalSchedule('每天9:00 检查服务');
    expect(result).not.toBeNull();
    expect(result!.parsed.kind).toBe('cron');
    expect(result!.parsed.expr).toBe('0 9 * * *');
    expect(result!.prompt).toBe('检查服务');
    expect(result!.name).toBe('检查服务');
  });

  it('recurring patterns are cron', () => {
    const result = parseNaturalSchedule('每30分钟 ping');
    expect(result).not.toBeNull();
    expect(result!.parsed.kind).toBe('cron');
    expect(result!.parsed.expr).toBe('*/30 * * * *');
  });
});

// ─── New: Chinese one-shot patterns (N分钟后 / N小时后 / 明天X点) ─────────────

describe('One-shot Chinese patterns', () => {
  it('N分钟后 produces once schedule', () => {
    const result = parseNaturalSchedule('30分钟后 提醒我喝水');
    expect(result).not.toBeNull();
    expect(result!.parsed.kind).toBe('once');
    expect(result!.parsed.runAt).toBeTruthy();
    const runAt = new Date(result!.parsed.runAt!).getTime();
    const expected = Date.now() + 30 * 60_000;
    expect(Math.abs(runAt - expected)).toBeLessThan(5_000);
    expect(result!.prompt).toBe('提醒我喝水');
  });

  it('N小时后 produces once schedule', () => {
    const result = parseNaturalSchedule('2小时后 检查部署');
    expect(result).not.toBeNull();
    expect(result!.parsed.kind).toBe('once');
    const runAt = new Date(result!.parsed.runAt!).getTime();
    const expected = Date.now() + 2 * 3600_000;
    expect(Math.abs(runAt - expected)).toBeLessThan(5_000);
  });

  it('明天X点 produces once schedule at local tomorrow', () => {
    const result = parseNaturalSchedule('明天9:00 看下邮件');
    expect(result).not.toBeNull();
    expect(result!.parsed.kind).toBe('once');
    const runAt = new Date(result!.parsed.runAt!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(runAt.getDate()).toBe(tomorrow.getDate());
    expect(runAt.getHours()).toBe(9);
    expect(runAt.getMinutes()).toBe(0);
  });

  it('明天X点 honors an explicit schedule timezone (host-independent wall clock)', () => {
    // The one-shot「明天HH:MM」path now resolves to scheduleTimeZone() (env →
    // config → host), NOT host-local setHours(). With an explicit override the
    // wall clock must land at HH:MM in THAT zone regardless of the host TZ — the
    // exact bug being fixed (on a non-+8 host, cron used Asia/Shanghai while
    // one-shot used host-local, so they disagreed).
    const prev = process.env.BOTMUX_SCHEDULE_TIMEZONE;
    process.env.BOTMUX_SCHEDULE_TIMEZONE = 'Asia/Shanghai';
    try {
      const result = parseNaturalSchedule('明天9:00 看下邮件');
      expect(result).not.toBeNull();
      const runAt = new Date(result!.parsed.runAt!);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
      }).formatToParts(runAt);
      expect(parts.find(p => p.type === 'hour')!.value).toBe('09');
      expect(parts.find(p => p.type === 'minute')!.value).toBe('00');
      expect(runAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_SCHEDULE_TIMEZONE;
      else process.env.BOTMUX_SCHEDULE_TIMEZONE = prev;
    }
  });
});

// ─── New: parseSchedule() — bare schedule parser for CLI ─────────────────────

describe('parseSchedule (bare schedule strings)', () => {
  it('cron expression', () => {
    const p = parseSchedule('0 9 * * *');
    expect(p.kind).toBe('cron');
    expect(p.expr).toBe('0 9 * * *');
  });

  it('english "every 30m" → interval', () => {
    const p = parseSchedule('every 30m');
    expect(p.kind).toBe('interval');
    expect(p.minutes).toBe(30);
  });

  it('english "every 2h" → interval 120m', () => {
    const p = parseSchedule('every 2h');
    expect(p.kind).toBe('interval');
    expect(p.minutes).toBe(120);
  });

  it('duration "30m" → once in 30min', () => {
    const p = parseSchedule('30m');
    expect(p.kind).toBe('once');
    const runAtMs = new Date(p.runAt!).getTime();
    expect(Math.abs(runAtMs - (Date.now() + 30 * 60_000))).toBeLessThan(5_000);
  });

  it('ISO timestamp → once', () => {
    const p = parseSchedule('2099-01-01T10:00:00');
    expect(p.kind).toBe('once');
    expect(new Date(p.runAt!).getFullYear()).toBe(2099);
  });

  it('chinese "每日17:50" → cron', () => {
    const p = parseSchedule('每日17:50');
    expect(p.kind).toBe('cron');
    expect(p.expr).toBe('50 17 * * *');
  });

  it('throws on invalid', () => {
    expect(() => parseSchedule('not a schedule')).toThrow();
  });
});

// ─── New: computeNextRun() ───────────────────────────────────────────────────

describe('computeNextRun', () => {
  it('interval: first run is now + minutes', () => {
    const next = computeNextRun({ kind: 'interval', minutes: 10, display: '每 10 分钟' });
    expect(next).toBeTruthy();
    const nextMs = new Date(next!).getTime();
    expect(Math.abs(nextMs - (Date.now() + 10 * 60_000))).toBeLessThan(5_000);
  });

  it('interval: subsequent run is lastRun + minutes', () => {
    const lastRun = new Date('2026-04-17T10:00:00Z').toISOString();
    const next = computeNextRun({ kind: 'interval', minutes: 30, display: '每 30 分钟' }, lastRun);
    expect(new Date(next!).toISOString()).toBe('2026-04-17T10:30:00.000Z');
  });

  it('once: returns runAt if still in future/grace', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const next = computeNextRun({ kind: 'once', runAt: future, display: 'once' });
    expect(next).toBe(future);
  });

  it('once: returns null once already run', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const next = computeNextRun({ kind: 'once', runAt: future, display: 'once' }, new Date().toISOString());
    expect(next).toBeNull();
  });

  it('once: returns null if runAt is past beyond grace', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const next = computeNextRun({ kind: 'once', runAt: past, display: 'once' });
    expect(next).toBeNull();
  });

  it('cron: returns next wall-clock occurrence in the HOST-LOCAL timezone', () => {
    // 0 9 * * * — daily at 09:00. computeNextRun now uses the host's local timezone
    // (scheduleTimeZone()), matching how one-shot「明天9点」is parsed via setHours().
    // Pre-fix it was hard-coded to Asia/Shanghai, so on any non-+8 host getHours()
    // would NOT be 9. Host-independent assertion: both sides read the same local zone.
    const next = computeNextRun({ kind: 'cron', expr: '0 9 * * *', display: '每天 9:00' });
    expect(next).toBeTruthy();
    const nextDate = new Date(next!);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);
  });
});

// ─── Timezone-change re-alignment (Codex review finding #1) ──────────────────

describe('planCronRealign — recompute cron nextRunAt on timezone change', () => {
  const STALE = '2020-01-01T00:00:00.000Z'; // clearly in the past & wrong-zone
  const mk = (over: Record<string, unknown>) => ({
    id: 'x', name: 'x', enabled: true, nextRunAt: STALE, ...over,
  } as any);

  it('recomputes an enabled cron task to a future instant; skips interval/once/disabled', () => {
    const tasks = [
      mk({ id: 'cron1', parsed: { kind: 'cron', expr: '0 9 * * *', display: '每天 9:00' } }),
      mk({ id: 'interval1', parsed: { kind: 'interval', minutes: 30, display: 'every 30m' } }),
      mk({ id: 'once1', parsed: { kind: 'once', runAt: STALE, display: 'once' } }),
      mk({ id: 'cronDisabled', enabled: false, parsed: { kind: 'cron', expr: '0 9 * * *', display: '每天 9:00' } }),
    ];
    const plan = planCronRealign(tasks);
    // Only the enabled cron task is re-planned.
    expect(plan.map(p => p.id)).toEqual(['cron1']);
    expect(new Date(plan[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(plan[0].nextRunAt).not.toBe(STALE);
  });

  it('honors the ownership predicate (skips tasks another daemon owns)', () => {
    const tasks = [
      mk({ id: 'mine', parsed: { kind: 'cron', expr: '0 9 * * *', display: 'd' } }),
      mk({ id: 'theirs', parsed: { kind: 'cron', expr: '0 9 * * *', display: 'd' } }),
    ];
    const plan = planCronRealign(tasks, t => t.id === 'mine');
    expect(plan.map(p => p.id)).toEqual(['mine']);
  });

  it('is idempotent: a cron task already at the correct next-run is not re-planned', () => {
    const parsed = { kind: 'cron' as const, expr: '0 9 * * *', display: 'd' };
    const current = computeNextRun(parsed)!; // already the correct next occurrence
    const plan = planCronRealign([mk({ id: 'cron1', parsed, nextRunAt: current })]);
    expect(plan).toEqual([]);
  });

  it('startup future-only predicate skips PAST-DUE cron so catch-up is preserved', () => {
    // startScheduler() re-aligns only future-dated cron; a past-due nextRunAt is
    // left for the tick catch-up/fast-forward path (don't drop a missed run).
    const now = Date.now();
    const parsed = { kind: 'cron' as const, expr: '0 9 * * *', display: 'd' };
    const tasks = [
      mk({ id: 'future', parsed, nextRunAt: new Date(now + 3_600_000).toISOString() }),
      mk({ id: 'pastdue', parsed, nextRunAt: new Date(now - 3_600_000).toISOString() }),
    ];
    const plan = planCronRealign(tasks, t => !!t.nextRunAt && new Date(t.nextRunAt).getTime() > Date.now());
    expect(plan.map(p => p.id)).toEqual(['future']);
  });
});
