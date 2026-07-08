/**
 * 用户定时任务(scheduler)统一使用的时区。
 *
 * 解析优先级（scheduleTimeZone）：
 *   1. `BOTMUX_SCHEDULE_TIMEZONE` 环境变量（逃生阀/显式覆盖，与其它设置一致）
 *   2. dashboard 配置 `~/.botmux/config.json` 的 `scheduleTimeZone`（用户在 Settings 页填写）
 *   3. 主机系统本地时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`，遵循 `TZ`）
 *
 * 背景：cron 触发与各处显示历史上写死 'Asia/Shanghai'，而一次性「明天HH:MM」用
 * `Date.setHours()` 走系统本地时间，两者在非 +8 主机上错开一个时差。改走本函数后，
 * cron 触发、一次性「明天」解析、CLI/卡片显示、dashboard next-run 预览全部跟随同一个
 * 解析结果。默认跟主机时区（没有别的可靠办法确定用户时区）；主机时区被误配/不是用户
 * 想要的时区时，可在 dashboard 里显式指定（例如主机是 America/Los_Angeles 但用户在
 * 北京，填 `Asia/Shanghai` 即可）。
 *
 * 以函数（而非常量）导出：每次调用实时解析，便于测试注入，也不把值冻结在模块导入期。
 * 注：维护窗口(maintenance-schedule.ts 的 MAINTENANCE_TZ)是独立子系统，刻意不走这里。
 */

import { Cron } from 'croner';
import { readGlobalConfig } from '../global-config.js';

/**
 * 把 `Intl.DateTimeFormat().resolvedOptions().timeZone` 解析出的原始值归一成一个
 * **一定能被 croner / `toLocaleString({ timeZone })` 接受** 的 IANA 名。
 *
 * 边界：某些主机（如 `TZ` 被导出成空串）下 Node 会把本地时区报成哨兵 `Etc/Unknown`，
 * 它既不是合法 IANA 名 —— croner 会抛 `Invalid timezone` 让 cron next-run 变 null、
 * `toLocaleString` 会抛 RangeError 让定时任务列表渲染崩。这类不可用值一律回退到 UTC
 * （对所有消费方都合法、且确定性）。纯函数，便于单测。
 */
export function normalizeScheduleTimeZone(raw: string | undefined | null): string {
  if (!raw || raw === 'Etc/Unknown') return 'UTC';
  return raw;
}

/**
 * 校验 `tz` 是否是一个 **croner / Intl 都能接受** 的合法 IANA 名。用于：
 *   - dashboard 写入前校验用户填的值（非法则拒绝，返回 invalid_scheduleTimeZone）
 *   - scheduleTimeZone() 解析时兜底（配置/env 里若是非法值，跳过、回退主机时区）
 */
export function isValidTimeZone(tz: string | undefined | null): boolean {
  if (!tz || tz === 'Etc/Unknown') return false;
  try {
    // Throws RangeError on an unknown/malformed zone — same check croner relies on.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 主机系统本地时区（经 Intl 解析，遵循 TZ 环境变量），已归一为可用 IANA 名。 */
export function hostLocalTimeZone(): string {
  return normalizeScheduleTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * 定时任务统一使用的时区。优先级：env → dashboard 配置 → 主机本地时区。
 * 每一层都经过 `isValidTimeZone` 校验，非法值直接跳到下一层，保证返回的一定是可用
 * IANA 名（最终兜底 `hostLocalTimeZone()` 里的 `Etc/Unknown → UTC`）。
 */
export function scheduleTimeZone(): string {
  const envTz = process.env.BOTMUX_SCHEDULE_TIMEZONE?.trim();
  if (envTz && isValidTimeZone(envTz)) return envTz;

  const configured = readGlobalConfig().scheduleTimeZone;
  if (configured && isValidTimeZone(configured)) return configured;

  return hostLocalTimeZone();
}

// ─── tz-aware「明天 HH:MM」→ UTC 瞬时 ────────────────────────────────────────
// 一次性「明天HH:MM」是**挂钟时间**：需要「目标时区某墙上时刻 → UTC 瞬时」的换算。
// JS 原生 `Date.setHours()` 走主机本地时区，在非目标时区主机上会算错；而手写偏移换算
// 又很难在所有时区正确处理 DST gap/fall-back（且要与 cron 的语义完全一致）。
// 所以这里**直接复用 croner**（cron 任务触发用的同一个引擎）：把「明天 HH:MM」表达成
// 一个「指定日+月」的 cron，取 nextRun。这样一次性与同表达式 cron 在 DST 边界上**天然一致**。

/** 目标时区 `tz` 在 UTC 瞬时 `utcMs` 处的当地日期 (year, month, day)。 */
function zonedDateParts(tz: string, utcMs: number): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') f[p.type] = Number(p.value);
  }
  return { year: f.year, month: f.month, day: f.day };
}

/**
 * 「明天 HH:MM」（时区 `tz` 下）对应的 UTC Date。「明天」= `tz` 里今天日期的次日。
 *
 * 用 croner 求解（与 cron 任务同源），因此 DST spring-forward（不存在的墙钟前向推进）
 * 与 fall-back（重复墙钟取首次）语义与同表达式 cron **完全一致**，且对正/负 offset 时区
 * 都正确。`nowMs` 可注入以便单测；默认取当前时刻。
 */
export function zonedTomorrowAt(
  tz: string,
  hour: number,
  minute: number,
  nowMs: number = Date.now(),
): Date {
  // 次日日期（在 tz 日历下），用 Date.UTC 仅做跨月/跨年进位归一。
  const today = zonedDateParts(tz, nowMs);
  const nextCal = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const day = nextCal.getUTCDate();
  const month = nextCal.getUTCMonth() + 1;
  // cron 字段：minute hour dayOfMonth month *（day-of-week 通配）。croner 从 now 向前找到
  // 下一个匹配 = 明天该墙钟（明天是未来 1 天内，一定是最近的匹配）。
  const next = new Cron(`${minute} ${hour} ${day} ${month} *`, { timezone: tz }).nextRun(new Date(nowMs));
  if (next) return next;
  // 理论不可达（明天是合法未来日期）；兜底把墙钟当 tz-naive UTC。
  return new Date(Date.UTC(nextCal.getUTCFullYear(), month - 1, day, hour, minute, 0, 0));
}
