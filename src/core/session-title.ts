import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { normalizeSessionTitle } from './session-board.js';

export type SessionTitleSource = 'initial' | 'user' | 'agent' | 'cli' | 'dashboard' | 'system';

export type SessionTitleUpdateResult =
  | { ok: true; title: string; updatedAt: string; source: SessionTitleSource }
  | { ok: false; error: 'bad_title' };

const BOTMUX_LARK_TITLE_PREFIX = '[BotMux·Lark]';
const BOTMUX_LARK_TITLE_MAX = 200;
const BOTMUX_LARK_TITLE_PROMPT_MAX = 2_000;

function stripLeadingKnownMentions(
  rawContent: string,
  mentions?: readonly { name: string }[],
): string {
  let content = rawContent.trimStart();
  const mentionNames = (mentions ?? [])
    .map(mention => mention.name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let matched = true;
  while (matched) {
    matched = false;
    for (const name of mentionNames) {
      const atPrefix = content.match(/^@+/)?.[0];
      if (atPrefix && content.slice(atPrefix.length).startsWith(name)) {
        content = content.slice(atPrefix.length + name.length).trimStart();
        matched = true;
        break;
      }
    }
  }
  return content;
}

/** 从 Botmux 首轮输入中提取供语义标题模型使用的用户原文。 */
export function extractBotmuxLarkNativeSessionTitlePrompt(
  rawContent: unknown,
  mentions?: readonly { name: string }[],
): string | undefined {
  if (typeof rawContent !== 'string') return undefined;
  const userMessage = rawContent.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)?.[1]
    ?? rawContent;
  const content = stripLeadingKnownMentions(
    userMessage
      .replace(/^\s*\[用户引用了消息[^\n]*\]\s*$/gm, '')
      .replace(/^\s*\[来自[^\n]*@mention[^\n]*\]\s*$/gm, '')
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' '),
    mentions,
  ).trim();
  if (!content) return undefined;
  return Array.from(content).slice(0, BOTMUX_LARK_TITLE_PROMPT_MAX).join('');
}

/** 用首次话题内容生成 Codex 原生会话标题，不依赖 Lark SDK 类型。 */
export function buildBotmuxLarkNativeSessionTitle(
  rawContent: unknown,
  mentions?: readonly { name: string }[],
  emptyContentFallback?: unknown,
): string {
  const content = stripLeadingKnownMentions(
    typeof rawContent === 'string' ? rawContent : '',
    mentions,
  );

  const normalized = normalizeSessionTitle(content)
    ?? normalizeSessionTitle(emptyContentFallback)
    ?? '新话题';
  const maxContentLength = BOTMUX_LARK_TITLE_MAX - Array.from(BOTMUX_LARK_TITLE_PREFIX).length - 1;
  const chars = Array.from(normalized);
  const displayContent = chars.length > maxContentLength
    ? `${chars.slice(0, maxContentLength - 1).join('').trimEnd()}…`
    : normalized;
  return `${BOTMUX_LARK_TITLE_PREFIX} ${displayContent}`;
}

export function normalizeSessionTitleSource(value: unknown, fallback: SessionTitleSource): SessionTitleSource {
  if (
    value === 'initial' ||
    value === 'user' ||
    value === 'agent' ||
    value === 'cli' ||
    value === 'dashboard' ||
    value === 'system'
  ) {
    return value;
  }
  return fallback;
}

/** Persist a display-title change and keep dashboard subscribers in sync. */
export function updateSessionTitle(
  session: Session,
  rawTitle: unknown,
  source: SessionTitleSource,
): SessionTitleUpdateResult {
  const title = normalizeSessionTitle(rawTitle);
  if (!title) return { ok: false, error: 'bad_title' };

  const updatedAt = new Date().toISOString();
  session.title = title;
  session.nativeSessionTitle = title;
  session.nativeSessionTitleUserDefined = true;
  session.nativeSessionTitleAwaitingContent = undefined;
  session.titleUpdatedAt = updatedAt;
  session.titleSource = source;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: session.sessionId,
      patch: { title, titleUpdatedAt: updatedAt, titleSource: source },
    },
  });
  return { ok: true, title, updatedAt, source };
}
