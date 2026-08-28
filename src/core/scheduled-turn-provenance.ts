/**
 * Scheduled-turn authentication shared by the CLI-side provenance resolver
 * (current-turn-provenance) and the daemon-side relay authorizer
 * (workflows/v3/session-relay).
 *
 * Threat model: a scheduled turn has no human inbound message, so the usual
 * quoteTargetId/lastCallerOpenId generation join cannot authenticate it. The
 * turn id `schedule:<taskId>:<uuid>` is minted by the daemon per fire and
 * written into the worker's authenticated process-tree marker; the random uuid
 * makes it unguessable and single-fire. Presenting it inside the authenticated
 * process tree therefore proves the daemon fired this task.
 *
 * What this module authenticates:
 *   1. The turn id is a well-formed scheduled turn.
 *   2. The task still exists, is enabled, and carries a creator (ownerOpenId).
 *   3. The session presenting the turn is bound to the task's target
 *      (larkAppId/chatId) — the task cannot authorize a workflow command in a
 *      session belonging to another chat/bot.
 *   4. The injected owner gate still accepts the task's creator. The daemon
 *      (session-relay) injects the live resolvedAllowedUsers check, so a
 *      creator removed from the bot loses workflow authority immediately. The
 *      sandboxed CLI cannot read bots.json and injects a pass-through; the
 *      daemon re-checks before every mutation on the relay path. Note: the
 *      signed-envelope route (non-sandboxed CLIs with .dashboard-secret)
 *      verifies the shared secret but does not re-check owner membership —
 *      a removed creator's scheduled task can still start/cancel/retry runs
 *      in that configuration. This is a known limitation, not a regression:
 *      scheduled tasks themselves (prompt execution) never checked owner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import type { ScheduledTask } from '../types.js';

/** Scheduled turn ids: `schedule:<8-hex-taskId>:<uuid>`. Task ids are minted
 *  by schedule-store as `randomUUID().substring(0, 8)`; the strict shape keeps
 *  a crafted marker turnId from smuggling through the exemption. */
const SCHEDULED_TURN_RE = /^schedule:([0-9a-f]{8}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns the task id embedded in a scheduled turn id, or null for any other
 *  turn id shape. */
export function parseScheduledTurnId(turnId: string): string | null {
  const match = SCHEDULED_TURN_RE.exec(turnId);
  return match ? match[1]! : null;
}

/**
 * Read a task straight from the per-bot schedules.json
 * (`<botmuxHome>/bots/<appId>/schedules.json`). Read-only, no global store
 * state — safe inside the sandboxed CLI (the file lives under the bot's own
 * home dir, same as `botmux schedule list`) and in tests (takes the dataDir
 * explicitly instead of the global config).
 */
export function readScheduledTaskForProvenance(
  dataDir: string,
  larkAppId: string,
  taskId: string,
): ScheduledTask | undefined {
  const filePath = join(botHomePath(dirname(dataDir), larkAppId), 'schedules.json');
  if (!existsSync(filePath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const raw = (data as Record<string, unknown>)[taskId];
    return raw && typeof raw === 'object' ? (raw as ScheduledTask) : undefined;
  } catch {
    // Corrupt/unreadable schedules.json must not grant an exemption — the
    // caller falls back to the ordinary (failing) human-turn checks.
    return undefined;
  }
}

export type ScheduledTurnAuthError =
  | 'task_not_found'
  | 'task_disabled'
  | 'task_owner_missing'
  | 'owner_revoked'
  | 'binding_mismatch';

export interface ScheduledTurnAuth {
  task: ScheduledTask;
  ownerOpenId: string;
  taskLarkAppId: string;
}

/**
 * Authenticate a scheduled turn against its task and the presenting session.
 * Fail-closed: every rejection returns an error code instead of throwing, so
 * each caller can map it to its own error shape (CurrentTurnProvenanceError
 * for the CLI resolver, a 403 relay status for the daemon).
 */
export function authorizeScheduledTurn(input: {
  turnId: string;
  dataDir: string;
  sessionLarkAppId: string;
  sessionChatId: string;
  isOwnerAllowed: (larkAppId: string, ownerOpenId: string) => boolean;
}): ScheduledTurnAuth | { error: ScheduledTurnAuthError } {
  const taskId = parseScheduledTurnId(input.turnId);
  if (!taskId) return { error: 'task_not_found' };
  if (!input.sessionLarkAppId || !input.sessionChatId) return { error: 'binding_mismatch' };

  const task = readScheduledTaskForProvenance(input.dataDir, input.sessionLarkAppId, taskId);
  if (!task) return { error: 'task_not_found' };
  if (task.enabled === false) return { error: 'task_disabled' };

  const ownerOpenId = typeof task.ownerOpenId === 'string' ? task.ownerOpenId.trim() : '';
  if (!ownerOpenId) return { error: 'task_owner_missing' };

  // The task must be bound to the presenting session's bot/chat. A task
  // persisted without larkAppId (legacy) was read from THIS bot's own store,
  // so the store path already binds it; only an explicit mismatch is rejected.
  if (task.larkAppId && task.larkAppId !== input.sessionLarkAppId) {
    return { error: 'binding_mismatch' };
  }
  if (task.chatId !== input.sessionChatId) {
    return { error: 'binding_mismatch' };
  }

  const taskLarkAppId = task.larkAppId ?? input.sessionLarkAppId;
  if (!input.isOwnerAllowed(taskLarkAppId, ownerOpenId)) {
    return { error: 'owner_revoked' };
  }

  return { task, ownerOpenId, taskLarkAppId };
}

/** Human-readable Chinese explanation for each rejection (CLI resolver). */
export function scheduledTurnAuthErrorMessage(code: ScheduledTurnAuthError): string {
  switch (code) {
    case 'task_not_found':
      return '定时任务不存在或已被删除，拒绝授权当前命令';
    case 'task_disabled':
      return '定时任务已被禁用，拒绝授权当前命令';
    case 'task_owner_missing':
      return '定时任务缺少创建者身份（ownerOpenId），拒绝授权当前命令；请重新创建该定时任务';
    case 'owner_revoked':
      return '定时任务创建者已不在 Bot 授权名单中，拒绝授权当前命令';
    case 'binding_mismatch':
      return '定时任务与会话绑定不一致，拒绝授权当前命令';
  }
}
