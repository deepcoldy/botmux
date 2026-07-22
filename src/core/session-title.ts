import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import { dashboardEventBus } from './dashboard-events.js';
import { normalizeSessionTitle } from './session-board.js';

export type SessionTitleUpdateResult =
  | { ok: true; title: string }
  | { ok: false; error: 'bad_title' };

const BOTMUX_LARK_TITLE_PREFIX = '[BotMux·Lark]';
const BOTMUX_LARK_TITLE_MAX = 100;

/** 用首次话题内容生成 Codex 原生会话标题，不依赖 Lark SDK 类型。 */
export function buildBotmuxLarkNativeSessionTitle(
  rawContent: unknown,
  mentions?: readonly { name: string }[],
): string {
  let content = typeof rawContent === 'string' ? rawContent.trimStart() : '';
  const mentionNames = (mentions ?? [])
    .map(mention => mention.name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  if (mentionNames.length > 0) {
    let matched = true;
    while (matched) {
      matched = false;
      for (const name of mentionNames) {
        const tag = `@${name}`;
        if (content.startsWith(tag)) {
          content = content.slice(tag.length).trimStart();
          matched = true;
          break;
        }
      }
    }
  }

  const normalized = normalizeSessionTitle(content) ?? '新话题';
  const maxContentLength = BOTMUX_LARK_TITLE_MAX - Array.from(BOTMUX_LARK_TITLE_PREFIX).length - 1;
  const chars = Array.from(normalized);
  const displayContent = chars.length > maxContentLength
    ? `${chars.slice(0, maxContentLength - 1).join('').trimEnd()}…`
    : normalized;
  return `${BOTMUX_LARK_TITLE_PREFIX} ${displayContent}`;
}

/** Persist a display-title change and keep dashboard subscribers in sync. */
export function updateSessionTitle(session: Session, rawTitle: unknown): SessionTitleUpdateResult {
  const title = normalizeSessionTitle(rawTitle);
  if (!title) return { ok: false, error: 'bad_title' };

  session.title = title;
  session.nativeSessionTitle = title;
  session.nativeSessionTitleUserDefined = true;
  sessionStore.updateSession(session);
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: session.sessionId, patch: { title } },
  });
  return { ok: true, title };
}
