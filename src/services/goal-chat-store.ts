/**
 * Goal chat registry.
 *
 * A goal group is an oncall working group, but it must not inherit oncall's
 * legacy "any group member can talk to every bot" shortcut. The registry is
 * an explicit, cheap truth source for the talk gate: `goal supervise` marks a
 * chat as a goal, and `evaluateTalk` checks the in-memory set.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export interface GoalChatRecord {
  chatId: string;
  title?: string;
  brief?: string;
  larkAppId?: string;
  parentChatId?: string;
  parentRoot?: string;
  parentSessionId?: string;
  workingDir?: string;
  supervisorSessionId?: string;
  supervisorCreatedAt?: string;
  lastReviveAt?: string;
  reviveAttempts?: string[];
  closedAt?: string;
  closedBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface GoalChatFile {
  goals: GoalChatRecord[];
}

export interface RegisterGoalChatInput {
  title?: string;
  brief?: string;
  now?: number;
  larkAppId?: string;
  parentChatId?: string;
  parentRoot?: string;
  parentSessionId?: string;
  workingDir?: string;
  supervisorSessionId?: string;
  supervisorCreatedAt?: string;
  lastReviveAt?: string;
  reviveAttempts?: string[];
}

export interface CloseGoalChatInput {
  now?: number;
  closedBy?: string;
}

let loadedFrom: string | null = null;
let loadedMtimeMs = -1;
let goalChats = new Map<string, GoalChatRecord>();
let testOverride = false;

function storePath(): string {
  return join(config.session.dataDir, 'verified-delivery', 'goal-chats.json');
}

function readFile(path: string): GoalChatFile {
  if (!existsSync(path)) return { goals: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GoalChatFile>;
    return {
      goals: Array.isArray(parsed.goals)
        ? parsed.goals
          .filter((g): g is GoalChatRecord =>
            !!g && typeof g.chatId === 'string' && typeof g.createdAt === 'string' && typeof g.updatedAt === 'string')
          .map((g) => ({
            ...g,
            reviveAttempts: Array.isArray(g.reviveAttempts)
              ? g.reviveAttempts.filter((v): v is string => typeof v === 'string')
              : undefined,
          }))
        : [],
    };
  } catch (err) {
    logger.warn(`[goal-chat-store] failed to read registry: ${err instanceof Error ? err.message : String(err)}`);
    return { goals: [] };
  }
}

function loadIfNeeded(): void {
  if (testOverride) return;
  const path = storePath();
  let mtimeMs = -1;
  try {
    if (existsSync(path)) mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (loadedFrom === path && loadedMtimeMs === mtimeMs) return;
  const file = readFile(path);
  goalChats = new Map(file.goals.map((g) => [g.chatId, g]));
  loadedFrom = path;
  loadedMtimeMs = mtimeMs;
}

function writeFile(next: Map<string, GoalChatRecord>): void {
  const path = storePath();
  mkdirSync(join(config.session.dataDir, 'verified-delivery'), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ goals: [...next.values()] }, null, 2) + '\n');
  loadedFrom = null;
  loadIfNeeded();
}

function persist(next: Map<string, GoalChatRecord>): void {
  if (testOverride) {
    goalChats = next;
    return;
  }
  writeFile(next);
}

export function registerGoalChat(chatId: string, input: RegisterGoalChatInput = {}): GoalChatRecord {
  testOverride = false;
  const id = chatId.trim();
  if (!id) throw new Error('goal chatId is required');
  loadIfNeeded();
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  const prev = goalChats.get(id);
  const rec: GoalChatRecord = {
    chatId: id,
    title: input.title?.trim() || prev?.title,
    brief: input.brief ?? prev?.brief,
    larkAppId: input.larkAppId ?? prev?.larkAppId,
    parentChatId: input.parentChatId ?? prev?.parentChatId,
    parentRoot: input.parentRoot ?? prev?.parentRoot,
    parentSessionId: input.parentSessionId ?? prev?.parentSessionId,
    workingDir: input.workingDir ?? prev?.workingDir,
    supervisorSessionId: input.supervisorSessionId ?? prev?.supervisorSessionId,
    supervisorCreatedAt: input.supervisorCreatedAt ?? prev?.supervisorCreatedAt,
    lastReviveAt: input.lastReviveAt ?? prev?.lastReviveAt,
    reviveAttempts: input.reviveAttempts ?? prev?.reviveAttempts,
    createdAt: prev?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  const next = new Map(goalChats);
  next.set(id, rec);
  writeFile(next);
  return rec;
}

export function closeGoalChat(chatId: string | undefined, input: CloseGoalChatInput = {}): GoalChatRecord | undefined {
  const id = chatId?.trim();
  if (!id) return undefined;
  loadIfNeeded();
  const prev = goalChats.get(id);
  if (!prev) return undefined;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  const rec: GoalChatRecord = {
    ...prev,
    closedAt: nowIso,
    closedBy: input.closedBy?.trim() || prev.closedBy,
    updatedAt: nowIso,
  };
  const next = new Map(goalChats);
  next.set(id, rec);
  persist(next);
  return rec;
}

export function getGoalChat(chatId: string | undefined): GoalChatRecord | undefined {
  if (!chatId) return undefined;
  loadIfNeeded();
  return goalChats.get(chatId);
}

export function isGoalChat(chatId: string | undefined): boolean {
  if (!chatId) return false;
  loadIfNeeded();
  return goalChats.has(chatId);
}

export function listGoalChats(): GoalChatRecord[] {
  loadIfNeeded();
  return [...goalChats.values()];
}

export function _resetGoalChatStoreForTest(records: GoalChatRecord[] = []): void {
  testOverride = true;
  loadedFrom = null;
  loadedMtimeMs = -1;
  goalChats = new Map(records.map((r) => [r.chatId, r]));
}
