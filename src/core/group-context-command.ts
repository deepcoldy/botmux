import type { ChatMode } from '../im/lark/client.js';
import {
  getGroupContextSettings,
  setGroupContextSettings,
  type GroupContextSettings,
} from '../services/group-context-settings-store.js';
import {
  readGroupContextRecallStatus,
  type GroupContextRecallStatus,
} from '../services/group-context-health.js';

export type GroupContextSlashAction = 'on' | 'off' | 'status';

export type GroupContextSlashParseResult =
  | { ok: true; action: GroupContextSlashAction }
  | { ok: false; error: 'usage' }
  | { ok: false; error: 'unexpected_arguments'; detail: string };

export type GroupContextRecallState =
  | 'subscribed'
  | 'update_submitted'
  | 'session_unavailable'
  | 'unknown';

export interface GroupContextRecallDiagnostic {
  state: GroupContextRecallState;
  stale: boolean;
}

export type GroupContextSlashResult =
  | { kind: 'status'; settings: GroupContextSettings; recall: GroupContextRecallDiagnostic }
  | {
      kind: 'updated';
      enabled: boolean;
      changed: boolean;
      settings: GroupContextSettings;
      recall?: GroupContextRecallDiagnostic;
    }
  | {
      kind: 'error';
      error:
        | 'usage'
        | 'unexpected_arguments'
        | 'invalid_chat'
        | 'chat_lookup_failed'
        | 'group_required'
        | 'no_owner'
        | 'not_admin';
      detail?: string;
    };

export interface GroupContextSlashInput {
  content: string;
  larkAppId: string;
  chatId: string;
  senderId?: string;
  senderIsBot: boolean;
  resolvedAllowedUsers: readonly string[];
}

export interface GroupContextSlashDeps {
  dataDir: string;
  getChatMode(larkAppId: string, chatId: string): Promise<ChatMode | 'unknown'>;
  readRecallStatus?: (appId: string, dataDir?: string) => GroupContextRecallStatus;
}

function recallDiagnostic(
  appId: string,
  dataDir: string,
  readRecallStatus?: GroupContextSlashDeps['readRecallStatus'],
): GroupContextRecallDiagnostic {
  try {
    const status = (readRecallStatus ?? readGroupContextRecallStatus)(appId, dataDir);
    // `covered` alone is deliberately insufficient: verification requires the
    // health service's exact subscribed verdict and its current covered bit.
    // Never carry its free-form reason into user-visible output.
    if (status.reason === 'subscribed' && status.covered) {
      return { state: 'subscribed', stale: false };
    }
    if (status.reason === 'update_submitted' || status.updateSubmitted) {
      return { state: 'update_submitted', stale: status.stale };
    }
    if (status.reason === 'session_unavailable') {
      return { state: 'session_unavailable', stale: status.stale };
    }
    return { state: 'unknown', stale: status.stale };
  } catch {
    return { state: 'unknown', stale: false };
  }
}

export function parseGroupContextSlashCommand(content: string): GroupContextSlashParseResult {
  const match = content.trim().match(/^\/context-sharing(?:\s+(.+))?$/iu);
  if (!match?.[1]) return { ok: false, error: 'usage' };
  const tokens = match[1].trim().split(/\s+/u);
  const action = tokens[0]!.toLowerCase();
  if (tokens.length > 1) {
    return { ok: false, error: 'unexpected_arguments', detail: tokens.slice(1).join(' ') };
  }
  if (action !== 'on' && action !== 'off' && action !== 'status') {
    return { ok: false, error: 'usage' };
  }
  return { ok: true, action };
}

export async function runGroupContextSlashCommand(
  input: GroupContextSlashInput,
  deps: GroupContextSlashDeps,
): Promise<GroupContextSlashResult> {
  const parsed = parseGroupContextSlashCommand(input.content);
  if (!parsed.ok) {
    return parsed.error === 'unexpected_arguments'
      ? { kind: 'error', error: parsed.error, detail: parsed.detail }
      : { kind: 'error', error: parsed.error };
  }
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(input.chatId)) {
    return { kind: 'error', error: 'invalid_chat' };
  }

  // This changes what every managed bot may receive from the group. Use the
  // same fail-closed administrator source as /project: resolvedAllowedUsers
  // must be non-empty and contain the human sender. Talk grants and bot peers
  // are deliberately insufficient.
  if (input.resolvedAllowedUsers.length === 0) {
    return { kind: 'error', error: 'no_owner' };
  }
  if (input.senderIsBot || !input.senderId || !input.resolvedAllowedUsers.includes(input.senderId)) {
    return { kind: 'error', error: 'not_admin' };
  }

  let mode: ChatMode | 'unknown';
  try {
    mode = await deps.getChatMode(input.larkAppId, input.chatId);
  } catch {
    return { kind: 'error', error: 'chat_lookup_failed' };
  }
  if (mode === 'unknown') return { kind: 'error', error: 'chat_lookup_failed' };
  if (mode === 'p2p') return { kind: 'error', error: 'group_required' };

  const current = getGroupContextSettings(input.larkAppId, input.chatId, deps.dataDir);
  if (parsed.action === 'status') {
    return {
      kind: 'status',
      settings: current,
      recall: recallDiagnostic(input.larkAppId, deps.dataDir, deps.readRecallStatus),
    };
  }

  const enabled = parsed.action === 'on';
  const settings = await setGroupContextSettings(input.chatId, { enabled }, deps.dataDir);
  return {
    kind: 'updated',
    enabled,
    changed: current.enabled !== enabled,
    settings,
    ...(enabled
      ? { recall: recallDiagnostic(input.larkAppId, deps.dataDir, deps.readRecallStatus) }
      : {}),
  };
}
