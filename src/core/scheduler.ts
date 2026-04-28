import { Cron } from 'croner';
import * as scheduleStore from '../services/schedule-store.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTask, ParsedSchedule } from '../types.js';

// Callback set by daemon to execute a scheduled task
let executeCallback: ((task: ScheduledTask) => Promise<void>) | null = null;
let tickTimer: NodeJS.Timeout | null = null;

/** Owner-filter state — each daemon process runs its own scheduler but only
 *  executes tasks whose larkAppId matches.  Legacy tasks without a larkAppId
 *  fall through to the "primary" daemon (bot-0), matching pre-refactor behavior. */
let ownerAppId: string | null = null;
let ownerIsPrimary = false;

const TICK_INTERVAL_MS = 30_000;          // poll every 30s
const ONESHOT_GRACE_SECONDS = 120;        // one-shots fire even if <2min late
const MIN_GRACE_SECONDS = 120;            // catch-up window lower bound
const MAX_GRACE_SECONDS = 2 * 60 * 60;    // catch-up window upper bound (2h)

export function setExecuteCallback(cb: (task: ScheduledTask) => Promise<void>): void {
  executeCallback = cb;
}

/**
 * Bind the scheduler to a specific bot (larkAppId).  In multi-bot setups every
 * daemon process runs its own scheduler; this filter prevents double-execution
 * by ensuring each task is only handled by the daemon whose bot is actually
 * a member of the task's origin chat.
 *
 * @param larkAppId — this daemon's bot app id
 * @param isPrimary — true only for bot-0; legacy tasks without larkAppId are
 *                    routed here as a compatibility fallback
 */
export function setOwnerFilter(larkAppId: string, isPrimary: boolean): void {
  ownerAppId = larkAppId;
  ownerIsPrimary = isPrimary;
}

function taskBelongsToThisDaemon(task: ScheduledTask): boolean {
  if (ownerAppId === null) return true; // filter not configured — act like legacy (run all)
  if (task.larkAppId) return task.larkAppId === ownerAppId;
  // No larkAppId on task (legacy) — only the primary (bot-0) handles it.
  return ownerIsPrimary;
}

// ─── Chinese NL parsing (schedule portion only, returns ParsedSchedule) ─────

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
};

function parseTimeHM(s: string): { hour: number; minute: number; rest: string } | null {
  let m = s.match(/^(\d{1,2})[::：](\d{2})\s*(.*)/s);
  if (m) return { hour: parseInt(m[1]), minute: parseInt(m[2]), rest: m[3] };
  m = s.match(/^(\d{1,2})点(\d{1,2})分?\s*(.*)/s);
  if (m) return { hour: parseInt(m[1]), minute: parseInt(m[2]), rest: m[3] };
  m = s.match(/^(\d{1,2})点\s*(.*)/s);
  if (m) return { hour: parseInt(m[1]), minute: 0, rest: m[2] };
  return null;
}

/** Parse Chinese NL → { parsed, rest } where rest is the remaining text after schedule. */
function parseChineseSchedule(input: string): { parsed: ParsedSchedule; rest: string } | null {
  const s = input.trim();

  // 工作日每天 HH:MM
  let m = s.match(/^(?:每个?工作日|工作日每[天日])\s*(.*)/);
  if (m) {
    const t = parseTimeHM(m[1]);
    if (t) return { parsed: cronPS(`${t.minute} ${t.hour} * * 1-5`, `工作日 ${t.hour}:${String(t.minute).padStart(2,'0')}`), rest: t.rest };
  }

  // 每天/每日 HH:MM
  m = s.match(/^每[天日]\s*(.*)/);
  if (m) {
    const t = parseTimeHM(m[1]);
    if (t) return { parsed: cronPS(`${t.minute} ${t.hour} * * *`, `每天 ${t.hour}:${String(t.minute).padStart(2,'0')}`), rest: t.rest };
  }

  // 每周X HH:MM
  m = s.match(/^每周([一二三四五六日天])\s*(.*)/);
  if (m) {
    const day = WEEKDAY_MAP[m[1]] ?? 1;
    const t = parseTimeHM(m[2]);
    if (t) return { parsed: cronPS(`${t.minute} ${t.hour} * * ${day}`, `每周${m[1]} ${t.hour}:${String(t.minute).padStart(2,'0')}`), rest: t.rest };
  }

  // 每月X号 HH:MM
  m = s.match(/^每月(\d{1,2})[号日]\s*(.*)/);
  if (m) {
    const dom = parseInt(m[1]);
    const t = parseTimeHM(m[2]);
    if (t) return { parsed: cronPS(`${t.minute} ${t.hour} ${dom} * *`, `每月${dom}号 ${t.hour}:${String(t.minute).padStart(2,'0')}`), rest: t.rest };
  }

  // 每N小时 — keep as cron to preserve wall-clock alignment ("0 */N * * *")
  m = s.match(/^每(\d+)小时\s*(.*)/);
  if (m) {
    const h = parseInt(m[1]);
    const expr = h === 1 ? '0 * * * *' : `0 */${h} * * *`;
    return { parsed: cronPS(expr, `每 ${h} 小时`), rest: m[2] };
  }

  // 每小时
  m = s.match(/^每小时\s*(.*)/);
  if (m) return { parsed: cronPS('0 * * * *', '每小时'), rest: m[1] };

  // 每N分钟 — keep as cron for wall-clock alignment ("*/N * * * *")
  m = s.match(/^每(\d+)分钟\s*(.*)/);
  if (m) {
    const min = parseInt(m[1]);
    return { parsed: cronPS(`*/${min} * * * *`, `每 ${min} 分钟`), rest: m[2] };
  }

  // N分钟后
  m = s.match(/^(\d+)\s*分钟后\s*(.*)/);
  if (m) {
    const min = parseInt(m[1]);
    const runAt = new Date(Date.now() + min * 60_000).toISOString();
    return { parsed: { kind: 'once', runAt, display: `${min} 分钟后` }, rest: m[2] };
  }

  // N小时后
  m = s.match(/^(\d+)\s*小时后\s*(.*)/);
  if (m) {
    const h = parseInt(m[1]);
    const runAt = new Date(Date.now() + h * 3600_000).toISOString();
    return { parsed: { kind: 'once', runAt, display: `${h} 小时后` }, rest: m[2] };
  }

  // 明天 HH:MM
  m = s.match(/^明天\s*(.*)/);
  if (m) {
    const t = parseTimeHM(m[1]);
    if (t) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(t.hour, t.minute, 0, 0);
      return { parsed: { kind: 'once', runAt: d.toISOString(), display: `明天 ${t.hour}:${String(t.minute).padStart(2,'0')}` }, rest: t.rest };
    }
  }

  return null;
}

function cronPS(expr: string, display: string): ParsedSchedule {
  return { kind: 'cron', expr, display };
}

// ─── Public parser: arbitrary schedule string → ParsedSchedule ──────────────

/**
 * Parse a bare schedule string (no prompt).  Supports:
 *   - Chinese NL: "每日17:50" / "每周一10:00" / "30分钟后" / "明天9:00"
 *   - English duration: "30m", "2h", "1d" (one-shot from now)
 *   - English interval: "every 30m", "every 2h"
 *   - Cron expression: "0 9 * * *" (5 space-separated fields)
 *   - ISO timestamp: "2026-05-01T10:00:00" (one-shot at time)
 */
export function parseSchedule(input: string): ParsedSchedule {
  const s = input.trim();
  if (!s) throw new Error('empty schedule');

  // Chinese NL (match only the schedule portion — prompt is separate)
  const zh = parseChineseSchedule(s);
  if (zh && !zh.rest.trim()) return zh.parsed;
  if (zh && zh.rest.trim()) {
    // Caller passed "每日17:50" without prompt — rest should be empty for bare parse
    return zh.parsed;
  }

  // "every Xm/h/d"
  let m = s.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (m) {
    const minutes = durationToMinutes(m[1], m[2]);
    return { kind: 'interval', minutes, display: `every ${minutes}m` };
  }

  // Cron (5 fields, all cron chars)
  const parts = s.split(/\s+/);
  if (parts.length === 5 && parts.every(p => /^[\d*\-,/]+$/.test(p))) {
    try {
      new Cron(s);
      return { kind: 'cron', expr: s, display: s };
    } catch (err: any) {
      throw new Error(`invalid cron expression '${s}': ${err.message}`);
    }
  }

  // ISO timestamp
  if (/^\d{4}-\d{2}-\d{2}(T| |$)/.test(s)) {
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      return { kind: 'once', runAt: dt.toISOString(), display: `once at ${dt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` };
    }
  }

  // English duration "30m" / "2h" / "1d"
  m = s.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (m) {
    const minutes = durationToMinutes(m[1], m[2]);
    const runAt = new Date(Date.now() + minutes * 60_000).toISOString();
    return { kind: 'once', runAt, display: `once in ${s}` };
  }

  throw new Error(`invalid schedule '${input}'. Use '30m' / 'every 2h' / '0 9 * * *' / '2026-05-01T10:00' / 每日17:50`);
}

function durationToMinutes(numStr: string, unit: string): number {
  const u = unit[0].toLowerCase();
  const mult = u === 'm' ? 1 : u === 'h' ? 60 : u === 'd' ? 1440 : NaN;
  if (isNaN(mult)) throw new Error(`unknown duration unit: ${unit}`);
  return parseInt(numStr) * mult;
}

// ─── NL schedule-with-prompt parser (for /schedule command) ─────────────────

interface ParseNLResult {
  parsed: ParsedSchedule;
  prompt: string;
  name: string;
}

/**
 * Parse a natural-language /schedule command, splitting the schedule portion
 * from the prompt (the task instruction).  Used by the /schedule command
 * handler where user types e.g. "/schedule 每日17:50 帮我看看AI新闻".
 */
export function parseNaturalSchedule(input: string): ParseNLResult | null {
  const zh = parseChineseSchedule(input.trim());
  if (!zh) return null;

  // Clean prompt: remove leading connectors and quotes
  let prompt = zh.rest.replace(/^[给帮]我\s*/, '').trim();
  prompt = prompt.replace(/^["'"「](.+?)["'"」]$/, '$1').trim();
  if (!prompt) return null;

  const name = prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt;
  return { parsed: zh.parsed, prompt, name };
}

// ─── next-run computation ───────────────────────────────────────────────────

/** Compute the next run time for a parsed schedule. Returns ISO string, or null if exhausted. */
export function computeNextRun(parsed: ParsedSchedule, lastRunAt?: string): string | null {
  const now = Date.now();

  if (parsed.kind === 'once') {
    if (lastRunAt) return null; // one-shot has already run
    if (!parsed.runAt) return null;
    const runAtMs = new Date(parsed.runAt).getTime();
    // Allow ONESHOT_GRACE_SECONDS for late firing
    if (runAtMs >= now - ONESHOT_GRACE_SECONDS * 1000) return parsed.runAt;
    return null;
  }

  if (parsed.kind === 'interval') {
    if (!parsed.minutes) return null;
    const base = lastRunAt ? new Date(lastRunAt).getTime() : now;
    return new Date(base + parsed.minutes * 60_000).toISOString();
  }

  if (parsed.kind === 'cron') {
    if (!parsed.expr) return null;
    try {
      const job = new Cron(parsed.expr, { timezone: 'Asia/Shanghai' });
      const next = job.nextRun(new Date(now));
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** Compute grace window (how late a missed run can be and still catch up) */
function computeGraceSeconds(parsed: ParsedSchedule): number {
  let periodSec: number;
  if (parsed.kind === 'interval' && parsed.minutes) {
    periodSec = parsed.minutes * 60;
  } else if (parsed.kind === 'cron' && parsed.expr) {
    try {
      const job = new Cron(parsed.expr, { timezone: 'Asia/Shanghai' });
      const first = job.nextRun(new Date());
      const second = first ? job.nextRun(first) : null;
      periodSec = first && second ? (second.getTime() - first.getTime()) / 1000 : MIN_GRACE_SECONDS;
    } catch {
      periodSec = MIN_GRACE_SECONDS;
    }
  } else {
    return MIN_GRACE_SECONDS;
  }
  const grace = Math.floor(periodSec / 2);
  return Math.max(MIN_GRACE_SECONDS, Math.min(grace, MAX_GRACE_SECONDS));
}

// ─── Tick loop ──────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const tasks = scheduleStore.listTasks();
  const now = Date.now();

  for (const task of tasks) {
    if (!task.enabled) continue;
    if (!taskBelongsToThisDaemon(task)) continue;

    let nextRunAt = task.nextRunAt;
    if (!nextRunAt) {
      // Recover: compute from parsed + lastRunAt
      const recovered = computeNextRun(task.parsed, task.lastRunAt);
      if (!recovered) continue;
      nextRunAt = recovered;
      scheduleStore.updateTask(task.id, { nextRunAt });
    }

    const nextMs = new Date(nextRunAt).getTime();
    if (nextMs > now) continue;

    // Recurring: fast-forward if stale beyond grace window
    if (task.parsed.kind !== 'once') {
      const grace = computeGraceSeconds(task.parsed);
      if ((now - nextMs) / 1000 > grace) {
        const newNext = computeNextRun(task.parsed, new Date(now).toISOString());
        if (newNext) {
          logger.info(`[scheduler] Task "${task.name}" missed window (${Math.round((now-nextMs)/1000)}s late, grace=${grace}s), fast-forward to ${newNext}`);
          scheduleStore.updateTask(task.id, { nextRunAt: newNext });
          continue;
        }
      }
    }

    // At-most-once: advance next_run BEFORE execution so crash mid-run doesn't re-fire
    if (task.parsed.kind !== 'once') {
      const newNext = computeNextRun(task.parsed, new Date(now).toISOString());
      if (newNext) scheduleStore.updateTask(task.id, { nextRunAt: newNext });
    }

    // Execute
    logger.info(`[scheduler] Task "${task.name}" (${task.id}) triggered (kind=${task.parsed.kind})`);
    scheduleStore.updateTask(task.id, { lastRunAt: new Date().toISOString() });

    if (executeCallback) {
      executeCallback(task)
        .then(() => scheduleStore.markRun(task.id, true))
        .catch(err => {
          logger.error(`[scheduler] Task "${task.name}" failed: ${err.message}`);
          scheduleStore.markRun(task.id, false, err.message);
        });
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startScheduler(): void {
  const tasks = scheduleStore.listTasks();
  const enabled = tasks.filter(t => t.enabled);
  logger.info(`[scheduler] Starting with ${enabled.length}/${tasks.length} enabled tasks (tick every ${TICK_INTERVAL_MS/1000}s)`);

  // Ensure next_run_at exists for all enabled tasks
  for (const task of enabled) {
    if (!task.nextRunAt) {
      const next = computeNextRun(task.parsed, task.lastRunAt);
      if (next) scheduleStore.updateTask(task.id, { nextRunAt: next });
    }
  }

  // Run first tick shortly after startup, then on interval
  setTimeout(() => { tick().catch(err => logger.error(`[scheduler] tick error: ${err.message}`)); }, 5000);
  tickTimer = setInterval(() => {
    tick().catch(err => logger.error(`[scheduler] tick error: ${err.message}`));
  }, TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  logger.info('[scheduler] Stopped');
}

export function addTask(params: {
  name: string;
  schedule: string;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  chatType?: 'group' | 'p2p' | 'topic_group';
  larkAppId?: string;
  creatorChatId?: string;
  creatorRootMessageId?: string;
  creatorLarkAppId?: string;
  parsed?: ParsedSchedule;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local';
}): ScheduledTask {
  const parsed = params.parsed ?? parseSchedule(params.schedule);
  const nextRunAt = computeNextRun(parsed) ?? undefined;
  const task = scheduleStore.createTask({
    name: params.name,
    schedule: params.schedule,
    parsed,
    prompt: params.prompt,
    workingDir: params.workingDir,
    chatId: params.chatId,
    rootMessageId: params.rootMessageId,
    chatType: params.chatType,
    larkAppId: params.larkAppId,
    creatorChatId: params.creatorChatId,
    creatorRootMessageId: params.creatorRootMessageId,
    creatorLarkAppId: params.creatorLarkAppId,
    nextRunAt,
    repeat: params.repeat,
    deliver: params.deliver ?? 'origin',
  });
  logger.info(`[scheduler] Added task "${task.name}" (${task.id}) — ${parsed.display}, next: ${nextRunAt ?? 'N/A'}`);
  return task;
}

export function removeTask(id: string): boolean {
  return scheduleStore.removeTask(id);
}

export function enableTask(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;
  const next = computeNextRun(task.parsed);
  scheduleStore.updateTask(id, { enabled: true, nextRunAt: next ?? undefined });
  return true;
}

export function disableTask(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;
  scheduleStore.updateTask(id, { enabled: false });
  return true;
}

export function runTaskNow(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;
  // Ask the owning daemon to execute ASAP by advancing nextRunAt.  Its tick
  // (< 30s) will pick it up.  Previously we invoked executeCallback inline,
  // which was wrong in multi-bot setups — the callback on this daemon may
  // not even be the right bot for this task.
  logger.info(`[scheduler] Marked "${task.name}" (${task.id}) for immediate run`);
  scheduleStore.updateTask(id, { nextRunAt: new Date().toISOString() });
  return true;
}

export function getNextRun(id: string): Date | null {
  const task = scheduleStore.getTask(id);
  if (!task?.nextRunAt) return null;
  return new Date(task.nextRunAt);
}
