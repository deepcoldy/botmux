import { getBotClient } from '../bot-registry.js';
import { larkGet } from '../im/lark/client.js';
import { withFileLock } from '../utils/file-lock.js';
import { managerLockPath, parseManagerDescription, readManagerClaim, writeManagerClaim } from './chat-manager-state.js';

export async function readManagerChat(app: string, chat: string) {
  const res = await larkGet(getBotClient(app), `/open-apis/im/v1/chats/${encodeURIComponent(chat)}`);
  if (res.code !== 0) throw new Error('chat_read_failed');
  if (res.data?.chat_mode !== 'group' || res.data?.group_message_type === 'thread') {
    throw new Error('regular_group_only');
  }
  if (typeof res.data?.name !== 'string' || typeof res.data?.description !== 'string') {
    throw new Error('incomplete_chat_metadata');
  }
  return { name: res.data.name as string, description: res.data.description as string };
}

/** A persisted owner opt-in AND a fresh shared claim are required, never just a marker. */
export async function isChatManager(app: string, chat: string): Promise<boolean> {
  try {
    if (!readManagerClaim(app, chat)?.enabled) return false;
    const remote = await readManagerChat(app, chat);
    return parseManagerDescription(remote.description).appId === app;
  } catch {
    // No stale-cache fallback: revocation/handover must work across deployments.
    return false;
  }
}

export type ManagerResult =
  | { ok: true; changed: boolean; managerAppId?: string; locallyEnabled: boolean }
  | { ok: false; reason: string };

const publicErrors = new Set([
  'chat_read_failed', 'regular_group_only', 'incomplete_chat_metadata', 'invalid_local_claim',
  'ambiguous_manager_marker', 'missing_bot_name', 'bot_name_too_long', 'invalid_app_id',
  'manager_already_set', 'not_current_manager', 'unowned_manager_marker', 'description_too_long',
  'chat_update_failed', 'chat_update_unconfirmed',
]);

function failure(error: unknown): { ok: false; reason: string } {
  // Transport/filesystem errors may contain URLs or private paths. Never echo
  // their raw message into a group; only expose our bounded public error codes.
  const reason = error instanceof Error && publicErrors.has(error.message)
    ? error.message : 'manager_operation_failed';
  return { ok: false, reason };
}

export async function getChatManagerStatus(app: string, chat: string): Promise<ManagerResult> {
  try {
    const remote = await readManagerChat(app, chat);
    const managerAppId = parseManagerDescription(remote.description).appId;
    return { ok: true, changed: false, managerAppId,
      locallyEnabled: managerAppId === app && !!readManagerClaim(app, chat)?.enabled };
  } catch (error) { return failure(error); }
}

function managedName(original: string, label: string): string {
  const suffix = ` · ${label.trim()}`;
  if (!label.trim()) throw new Error('missing_bot_name');
  const room = 100 - Array.from(suffix).length;
  if (room < 2) throw new Error('bot_name_too_long');
  const chars = Array.from(original);
  const base = chars.length <= room ? original : `${chars.slice(0, room - 1).join('')}…`;
  return `${base}${suffix}`;
}

/**
 * Called only after the incoming human has passed canOperate. No session-owner
 * fallback. Persist intent before the remote update so a lost HTTP response is
 * recoverable with status/retry. Intent alone never grants ambient addressing.
 * Lark has no compare-and-swap: this lock serializes a shared data directory,
 * while cross-host handovers require clear-old then set-new (not force takeover).
 */
export async function changeChatManager(
  app: string, chat: string, action: 'set' | 'clear', label: string,
): Promise<ManagerResult> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(app)) throw new Error('invalid_app_id');
    return await withFileLock(managerLockPath(chat), async (): Promise<ManagerResult> => {
      const remote = await readManagerChat(app, chat);
      const parsed = parseManagerDescription(remote.description);
      const local = readManagerClaim(app, chat);
      if (parsed.appId && parsed.appId !== app) {
        throw new Error(action === 'set' ? 'manager_already_set' : 'not_current_manager');
      }
      if (parsed.appId === app && !local?.enabled) throw new Error('unowned_manager_marker');
      if (action === 'set' && parsed.appId === app) {
        return { ok: true, changed: false, managerAppId: app, locallyEnabled: true };
      }
      if (action === 'clear' && !parsed.appId) {
        if (local?.enabled) writeManagerClaim({ ...local, enabled: false });
        return { ok: true, changed: false, locallyEnabled: false };
      }

      const description = action === 'set'
        ? `${remote.description}${remote.description ? '\n' : ''}[botmux:manager=${app}]`
        : parsed.humanText;
      if (Array.from(description).length > 100) throw new Error('description_too_long');
      const name = action === 'set' ? managedName(remote.name, label)
        : local && remote.name === local.managedName ? local.originalName : remote.name;
      if (action === 'set') writeManagerClaim({
        schemaVersion: 1, larkAppId: app, chatId: chat, enabled: true,
        originalName: remote.name, managedName: name,
      });

      const result = await getBotClient(app).im.v1.chat.update({
        path: { chat_id: chat }, data: { name, description },
      });
      if (result.code !== 0) throw new Error('chat_update_failed');
      const confirmed = await readManagerChat(app, chat);
      if (confirmed.name !== name || confirmed.description !== description) {
        throw new Error('chat_update_unconfirmed');
      }
      if (action === 'clear' && local) writeManagerClaim({ ...local, enabled: false });
      return { ok: true, changed: true, managerAppId: action === 'set' ? app : undefined,
        locallyEnabled: action === 'set' };
    });
  } catch (error) { return failure(error); }
}
