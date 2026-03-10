import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTask } from '../types.js';

let tasks: Map<string, ScheduledTask> = new Map();
let loaded = false;

function getFilePath(): string {
  return join(config.session.dataDir, 'schedules.json');
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      tasks = new Map(Object.entries(data));
      logger.info(`Loaded ${tasks.size} scheduled tasks from ${fp}`);
    } catch (err) {
      logger.error(`Failed to load schedules: ${err}`);
      tasks = new Map();
    }
  }
  loaded = true;
}

function save(): void {
  ensureDir();
  const fp = getFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, ScheduledTask> = {};
  for (const [k, v] of tasks) {
    obj[k] = v;
  }
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

export function createTask(params: {
  name: string;
  type: ScheduledTask['type'];
  schedule: string;
  prompt: string;
  workingDir: string;
  chatId: string;
}): ScheduledTask {
  load();
  const task: ScheduledTask = {
    id: randomUUID().substring(0, 8),
    name: params.name,
    type: params.type,
    schedule: params.schedule,
    prompt: params.prompt,
    workingDir: params.workingDir,
    chatId: params.chatId,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  tasks.set(task.id, task);
  save();
  logger.info(`Created scheduled task ${task.id}: "${task.name}" (${task.type}: ${task.schedule})`);
  return task;
}

export function getTask(id: string): ScheduledTask | undefined {
  load();
  return tasks.get(id);
}

export function removeTask(id: string): boolean {
  load();
  const existed = tasks.delete(id);
  if (existed) {
    save();
    logger.info(`Removed scheduled task ${id}`);
  }
  return existed;
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'enabled' | 'lastRunAt'>>): void {
  load();
  const task = tasks.get(id);
  if (task) {
    Object.assign(task, updates);
    save();
  }
}

export function listTasks(): ScheduledTask[] {
  load();
  return [...tasks.values()];
}
