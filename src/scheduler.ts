import { Cron } from 'croner';
import * as scheduleStore from './services/schedule-store.js';
import { logger } from './utils/logger.js';
import type { ScheduledTask } from './types.js';

// ─── Active cron instances ──────────────────────────────────────────────────

const cronJobs = new Map<string, Cron>();

// Callback set by daemon to execute a scheduled task
let executeCallback: ((task: ScheduledTask) => Promise<void>) | null = null;

export function setExecuteCallback(cb: (task: ScheduledTask) => Promise<void>): void {
  executeCallback = cb;
}

// ─── Natural language → cron parser ─────────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
  '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0,
};

interface ParseResult {
  cron: string;
  type: ScheduledTask['type'];
  prompt: string;
  name: string;
}

/**
 * Parse natural language schedule expression into cron + prompt.
 *
 * Examples:
 *   "每日17:50给我帮我看看AI新闻"       → { cron: "50 17 * * *", prompt: "帮我看看AI新闻" }
 *   "每天9:00 检查服务状态"              → { cron: "0 9 * * *",  prompt: "检查服务状态" }
 *   "每周一10:30 生成周报"               → { cron: "30 10 * * 1", prompt: "生成周报" }
 *   "工作日每天9:00 检查邮件"            → { cron: "0 9 * * 1-5", prompt: "检查邮件" }
 *   "每小时 检查服务"                    → { cron: "0 * * * *",  prompt: "检查服务" }
 *   "每30分钟 ping"                     → { cron: "*\/30 * * * *", prompt: "ping" }
 *   "每月1号9:00 生成月报"               → { cron: "0 9 1 * *",  prompt: "生成月报" }
 */
export function parseNaturalSchedule(input: string): ParseResult | null {
  let rest = input.trim();
  let cron = '';
  let type: ScheduledTask['type'] = 'cron';

  // Helper: parse time like "17:50", "17：50", "9点", "9点30", "17点30分"
  function parseTime(s: string): { hour: number; minute: number; rest: string } | null {
    // HH:MM or HH：MM
    let tm = s.match(/^(\d{1,2})[::：](\d{2})\s*(.*)/s);
    if (tm) return { hour: parseInt(tm[1]), minute: parseInt(tm[2]), rest: tm[3] };
    // X点Y分 or X点Y
    tm = s.match(/^(\d{1,2})点(\d{1,2})分?\s*(.*)/s);
    if (tm) return { hour: parseInt(tm[1]), minute: parseInt(tm[2]), rest: tm[3] };
    // X点 (whole hour)
    tm = s.match(/^(\d{1,2})点\s*(.*)/s);
    if (tm) return { hour: parseInt(tm[1]), minute: 0, rest: tm[2] };
    return null;
  }

  // Pattern: 工作日/每个工作日 HH:MM
  let m = rest.match(/^(?:每个?工作日|工作日每[天日])\s*(.*)/);
  if (m) {
    const t = parseTime(m[1]);
    if (t) {
      cron = `${t.minute} ${t.hour} * * 1-5`;
      rest = t.rest;
    }
  }

  // Pattern: 每日/每天 HH:MM
  if (!cron) {
    m = rest.match(/^每[天日]\s*(.*)/);
    if (m) {
      const t = parseTime(m[1]);
      if (t) {
        cron = `${t.minute} ${t.hour} * * *`;
        rest = t.rest;
      }
    }
  }

  // Pattern: 每周X HH:MM
  if (!cron) {
    m = rest.match(/^每周([一二三四五六日天])\s*(.*)/);
    if (m) {
      const day = WEEKDAY_MAP[m[1]] ?? 1;
      const t = parseTime(m[2]);
      if (t) {
        cron = `${t.minute} ${t.hour} * * ${day}`;
        rest = t.rest;
      }
    }
  }

  // Pattern: 每月X号 HH:MM
  if (!cron) {
    m = rest.match(/^每月(\d{1,2})[号日]\s*(.*)/);
    if (m) {
      const dayOfMonth = parseInt(m[1]);
      const t = parseTime(m[2]);
      if (t) {
        cron = `${t.minute} ${t.hour} ${dayOfMonth} * *`;
        rest = t.rest;
      }
    }
  }

  // Pattern: 每N小时
  if (!cron) {
    m = rest.match(/^每(\d+)小时\s*(.*)/);
    if (m) {
      const hours = parseInt(m[1]);
      cron = hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
      rest = m[2];
    }
  }

  // Pattern: 每小时
  if (!cron) {
    m = rest.match(/^每小时\s*(.*)/);
    if (m) {
      cron = '0 * * * *';
      rest = m[1];
    }
  }

  // Pattern: 每N分钟
  if (!cron) {
    m = rest.match(/^每(\d+)分钟\s*(.*)/);
    if (m) {
      cron = `*/${parseInt(m[1])} * * * *`;
      rest = m[2];
    }
  }

  if (!cron) return null;

  // Clean prompt: remove leading connectors like "给我" "帮我" etc.
  let prompt = rest.replace(/^[给帮]我\s*/, '').trim();
  // Remove surrounding quotes
  prompt = prompt.replace(/^["'"「](.+?)["'"」]$/, '$1').trim();

  if (!prompt) return null;

  // Auto-generate name from prompt (first 20 chars)
  const name = prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt;

  return { cron, type, prompt, name };
}

// ─── Cron management ────────────────────────────────────────────────────────

function scheduleCronJob(task: ScheduledTask): void {
  // Stop existing job if any
  stopCronJob(task.id);

  if (!task.enabled) return;

  try {
    const job = new Cron(task.schedule, { timezone: 'Asia/Shanghai' }, async () => {
      logger.info(`[scheduler] Task "${task.name}" (${task.id}) triggered`);
      scheduleStore.updateTask(task.id, { lastRunAt: new Date().toISOString() });

      if (executeCallback) {
        try {
          await executeCallback(task);
        } catch (err: any) {
          logger.error(`[scheduler] Failed to execute task "${task.name}": ${err.message}`);
        }
      }
    });

    cronJobs.set(task.id, job);
    const next = job.nextRun();
    logger.info(`[scheduler] Scheduled "${task.name}" (${task.id}): ${task.schedule}, next run: ${next?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) ?? 'N/A'}`);
  } catch (err: any) {
    logger.error(`[scheduler] Invalid cron expression for task "${task.name}": ${task.schedule} — ${err.message}`);
  }
}

function stopCronJob(taskId: string): void {
  const job = cronJobs.get(taskId);
  if (job) {
    job.stop();
    cronJobs.delete(taskId);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startScheduler(): void {
  const tasks = scheduleStore.listTasks();
  const enabled = tasks.filter(t => t.enabled);
  logger.info(`[scheduler] Starting with ${enabled.length}/${tasks.length} enabled tasks`);

  for (const task of enabled) {
    scheduleCronJob(task);
  }
}

export function stopScheduler(): void {
  for (const [id] of cronJobs) {
    stopCronJob(id);
  }
  logger.info('[scheduler] All cron jobs stopped');
}

export function addTask(params: {
  name: string;
  type: ScheduledTask['type'];
  schedule: string;
  prompt: string;
  workingDir: string;
  chatId: string;
}): ScheduledTask {
  const task = scheduleStore.createTask(params);
  scheduleCronJob(task);
  return task;
}

export function removeTask(id: string): boolean {
  stopCronJob(id);
  return scheduleStore.removeTask(id);
}

export function enableTask(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;
  scheduleStore.updateTask(id, { enabled: true });
  task.enabled = true;
  scheduleCronJob(task);
  return true;
}

export function disableTask(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;
  scheduleStore.updateTask(id, { enabled: false });
  stopCronJob(id);
  return true;
}

export function runTaskNow(id: string): boolean {
  const task = scheduleStore.getTask(id);
  if (!task) return false;

  logger.info(`[scheduler] Manual run of task "${task.name}" (${task.id})`);
  scheduleStore.updateTask(id, { lastRunAt: new Date().toISOString() });

  if (executeCallback) {
    executeCallback(task).catch(err => {
      logger.error(`[scheduler] Manual run failed for "${task.name}": ${err.message}`);
    });
  }
  return true;
}

export function getNextRun(id: string): Date | null {
  const job = cronJobs.get(id);
  return job?.nextRun() ?? null;
}
