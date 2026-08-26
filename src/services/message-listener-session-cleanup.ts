import type { MessageListenerConfig } from '../bot-registry.js';
import type { Session } from '../types.js';

export const DEFAULT_MESSAGE_LISTENER_CLEANUP_RETENTION_HOURS = 168;
export const MESSAGE_LISTENER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface MessageListenerCleanupConfig {
  enabled: boolean;
  retentionHours: number;
}

export function normalizeMessageListenerCleanupConfig(raw: unknown): MessageListenerCleanupConfig {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const enabled = entry.enabled === false ? false : true;
  const retentionHours = normalizePositiveHour(entry.retentionHours)
    ?? DEFAULT_MESSAGE_LISTENER_CLEANUP_RETENTION_HOURS;
  return { enabled, retentionHours };
}

function normalizePositiveHour(raw: unknown): number | undefined {
  const value = typeof raw === 'string' && raw.trim()
    ? Number(raw.trim())
    : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function sessionText(session: Session): string {
  return [
    session.title,
    session.nativeSessionTitle,
    session.lastUserPrompt,
    session.lastCliInput,
  ].filter((value): value is string => typeof value === 'string').join('\n');
}

export function isMessageListenerSession(session: Session): boolean {
  if (session.messageListener) return true;
  return sessionText(session).includes('<message_listener>');
}

function activityTimeMs(session: Session): number | undefined {
  const candidates = [session.lastMessageAt, session.createdAt];
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export function selectExpiredMessageListenerSessions(input: {
  sessions: Session[];
  listeners: Record<string, MessageListenerConfig> | undefined;
  nowMs?: number;
}): Session[] {
  const nowMs = input.nowMs ?? Date.now();
  const listeners = input.listeners ?? {};
  return input.sessions.filter(session => {
    if (session.status !== 'active') return false;
    if (!isMessageListenerSession(session)) return false;
    const listener = listeners[session.messageListener?.chatId ?? session.chatId];
    if (!listener?.enabled) return false;
    const cleanup = normalizeMessageListenerCleanupConfig(listener.cleanup);
    if (!cleanup.enabled) return false;
    const lastActivityMs = activityTimeMs(session);
    if (lastActivityMs === undefined) return false;
    return nowMs - lastActivityMs >= cleanup.retentionHours * 60 * 60 * 1000;
  });
}
