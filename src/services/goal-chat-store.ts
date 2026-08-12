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
import { withFileLockSync } from '../utils/file-lock.js';
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
  /** Explicit user-start only: clear a prior cleanup tombstone. */
  reopen?: boolean;
}

export interface CloseGoalChatInput {
  now?: number;
  closedBy?: string;
}

export type ClaimGoalReviveResult =
  | { ok: true; record: GoalChatRecord; claimedAt: string }
  | { ok: false; errorCode: string; error: string };

let loadedFrom: string | null = null;
let loadedStatKey = '';
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
  let statKey = 'missing';
  try {
    if (existsSync(path)) {
      const stat = statSync(path);
      statKey = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    }
  } catch {
    statKey = 'unreadable';
  }
  if (loadedFrom === path && loadedStatKey === statKey) return;
  const file = readFile(path);
  goalChats = new Map(file.goals.map((g) => [g.chatId, g]));
  loadedFrom = path;
  loadedStatKey = statKey;
}

function writeFile(next: Map<string, GoalChatRecord>): void {
  const path = storePath();
  mkdirSync(join(config.session.dataDir, 'verified-delivery'), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ goals: [...next.values()] }, null, 2) + '\n');
  loadedFrom = null;
  loadIfNeeded();
}

function mutateGoalChats<T>(fn: (current: Map<string, GoalChatRecord>) => { next: Map<string, GoalChatRecord>; result: T }): T {
  if (testOverride) {
    const mutation = fn(new Map(goalChats));
    goalChats = mutation.next;
    return mutation.result;
  }
  const path = storePath();
  mkdirSync(join(config.session.dataDir, 'verified-delivery'), { recursive: true });
  return withFileLockSync(path, () => {
    const current = new Map(readFile(path).goals.map((record) => [record.chatId, record]));
    const mutation = fn(current);
    if (mutation.next !== current) {
      writeFile(mutation.next);
    } else {
      goalChats = current;
      loadedFrom = null;
      loadedStatKey = '';
    }
    return mutation.result;
  });
}

export function registerGoalChat(chatId: string, input: RegisterGoalChatInput = {}): GoalChatRecord {
  testOverride = false;
  const id = chatId.trim();
  if (!id) throw new Error('goal chatId is required');
  return mutateGoalChats((current) => {
    const nowIso = new Date(input.now ?? Date.now()).toISOString();
    const prev = current.get(id);
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
      closedAt: input.reopen ? undefined : prev?.closedAt,
      closedBy: input.reopen ? undefined : prev?.closedBy,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    const next = new Map(current);
    next.set(id, rec);
    return { next, result: rec };
  });
}

export function closeGoalChat(chatId: string | undefined, input: CloseGoalChatInput = {}): GoalChatRecord | undefined {
  const id = chatId?.trim();
  if (!id) return undefined;
  return mutateGoalChats((current) => {
    const prev = current.get(id);
    if (!prev) return { next: current, result: undefined };
    const nowIso = new Date(input.now ?? Date.now()).toISOString();
    const rec: GoalChatRecord = {
      ...prev,
      closedAt: nowIso,
      closedBy: input.closedBy?.trim() || prev.closedBy,
      updatedAt: nowIso,
    };
    const next = new Map(current);
    next.set(id, rec);
    return { next, result: rec };
  });
}

export function claimGoalChatRevive(input: {
  chatId: string;
  larkAppId: string;
  now: number;
  cooldownMs: number;
  windowMs: number;
  maxAttempts: number;
}): ClaimGoalReviveResult {
  const id = input.chatId.trim();
  if (!id) return { ok: false, errorCode: 'goal_not_registered', error: 'goal chat is not registered' };
  return mutateGoalChats<ClaimGoalReviveResult>((current) => {
    const prev = current.get(id);
    if (!prev) {
      return { next: current, result: { ok: false, errorCode: 'goal_not_registered', error: 'goal chat is not registered' } };
    }
    if (prev.closedAt) {
      return { next: current, result: { ok: false, errorCode: 'goal_closed', error: `goal chat was closed at ${prev.closedAt}` } };
    }
    if (prev.larkAppId && prev.larkAppId !== input.larkAppId) {
      return { next: current, result: { ok: false, errorCode: 'not_owner_daemon', error: `goal is owned by ${prev.larkAppId}` } };
    }
    if (!prev.parentChatId) {
      return { next: current, result: { ok: false, errorCode: 'incomplete_goal_record', error: 'goal registry has no parentChatId' } };
    }
    const recent = (prev.reviveAttempts ?? []).filter((value) => {
      const at = Date.parse(value);
      return Number.isFinite(at) && input.now - at < input.windowMs;
    });
    const lastRevive = prev.lastReviveAt ? Date.parse(prev.lastReviveAt) : undefined;
    if (lastRevive !== undefined && Number.isFinite(lastRevive) && input.now - lastRevive < input.cooldownMs) {
      return {
        next: current,
        result: { ok: false, errorCode: 'revive_cooldown', error: `last revive was ${input.now - lastRevive}ms ago` },
      };
    }
    if (recent.length >= input.maxAttempts) {
      return {
        next: current,
        result: {
          ok: false,
          errorCode: 'revive_budget_exhausted',
          error: `goal supervisor revived ${recent.length} time(s) in ${input.windowMs}ms`,
        },
      };
    }
    const claimedAt = new Date(input.now).toISOString();
    const record: GoalChatRecord = {
      ...prev,
      larkAppId: prev.larkAppId ?? input.larkAppId,
      lastReviveAt: claimedAt,
      reviveAttempts: [...recent, claimedAt],
      updatedAt: claimedAt,
    };
    const next = new Map(current);
    next.set(id, record);
    return { next, result: { ok: true, record, claimedAt } };
  });
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
  loadedStatKey = '';
  goalChats = new Map(records.map((r) => [r.chatId, r]));
}
