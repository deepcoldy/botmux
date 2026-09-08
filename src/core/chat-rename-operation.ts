import type { RenameChatResult } from '../services/groups-store.js';
import type { Session } from '../types.js';

export interface ActiveChatSession {
  chatId: string;
  session: Session;
}

export interface ChatRenameOperationDeps {
  renameChat: (
    larkAppId: string,
    chatId: string,
    newName: string,
    opts?: {
      beforeUpdate?: () =>
        | { ok: true }
        | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };
    },
  ) => Promise<RenameChatResult>;
  activeSessions: () => Iterable<ActiveChatSession>;
  persistSession: (session: Session) => void;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

export interface ChatRenameOperationInput {
  larkAppId: string;
  chatId: string;
  name: string;
  trigger: 'ai_proactive' | 'user_explicit' | 'host_api';
  sessionId?: string;
  botOpenId?: string;
  beforeUpdate?: () =>
    | { ok: true }
    | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };
}

export interface ChatRenameOperationResponse {
  status: number;
  body:
    | (Extract<RenameChatResult, { ok: true }> & { chatId: string })
    | Extract<RenameChatResult, { ok: false }>;
}

function failureStatus(result: Extract<RenameChatResult, { ok: false }>): number {
  if (result.error === 'bot_not_in_chat' || result.error === 'permission_denied') return 403;
  if (result.error === 'rate_limited') return 429;
  return 502;
}

function auditContext(input: ChatRenameOperationInput): string {
  return [
    input.sessionId ? `session=${JSON.stringify(input.sessionId)}` : undefined,
    `chat=${JSON.stringify(input.chatId)}`,
    `app=${JSON.stringify(input.larkAppId)}`,
    `botOpenId=${JSON.stringify(input.botOpenId ?? '-')}`,
    `trigger=${input.trigger}`,
  ].filter(Boolean).join(' ');
}

/**
 * Execute one exact-bot chat rename and keep every active session projection in
 * sync. Both the session-scoped Skill route and host integrations use this
 * application seam so Lark errors, audit records, and cache behavior cannot
 * drift apart.
 */
export async function executeChatRename(
  input: ChatRenameOperationInput,
  deps: ChatRenameOperationDeps,
): Promise<ChatRenameOperationResponse> {
  const result = await deps.renameChat(input.larkAppId, input.chatId, input.name, {
    beforeUpdate: input.beforeUpdate,
  });
  const context = auditContext(input);

  if (!result.ok) {
    deps.logger.warn(
      `[chat-rename:audit] result=failed ${context} `
      + `old=${JSON.stringify(result.oldName ?? null)} new=${JSON.stringify(result.newName ?? input.name)} `
      + `error=${result.error} larkCode=${result.larkCode ?? '-'} detail=${JSON.stringify(result.detail ?? '-')}`,
    );
    // Preserve the existing session-route error contract. A failed mutation
    // does not gain response fields merely because it used the shared seam.
    return { status: failureStatus(result), body: result };
  }

  if (result.changed) {
    for (const active of deps.activeSessions()) {
      if (active.chatId !== input.chatId) continue;
      active.session.chatDisplayName = result.newName;
      try {
        deps.persistSession(active.session);
      } catch (error) {
        deps.logger.warn(
          `[chat-rename:audit] cache_refresh_failed session=${JSON.stringify(active.session.sessionId)} `
          + `chat=${JSON.stringify(input.chatId)} app=${JSON.stringify(input.larkAppId)} `
          + `detail=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
    deps.logger.info(
      `[chat-rename:audit] result=success ${context} `
      + `old=${JSON.stringify(result.oldName)} new=${JSON.stringify(result.newName)} larkCode=0`,
    );
  }

  return { status: 200, body: { ...result, chatId: input.chatId } };
}
