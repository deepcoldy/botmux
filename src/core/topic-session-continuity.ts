/**
 * Topic session continuity: what happens when a message reaches a topic whose
 * session for this bot has already been closed.
 *
 * Before this module the daemon always auto-created a FRESH session there. In
 * lead-only (forward-only) groups that silently threw away the executor's
 * context: the lead closes a finished task, later sends a follow-up with
 * `botmux dispatch --into <root>`, and a brand-new CLI session (new
 * `--session-id`, no `--resume`) answers it with no memory of the earlier
 * work. Observed on one host: 8 of 89 auto-created topics were re-created this
 * way, 11 extra fresh sessions, e.g. the same executor in the same topic got
 * three unrelated sessions within 18 hours.
 *
 * Now:
 *  - default: resume the most recent closed session of this bot in this topic
 *    (the existing `resumeSession`, the same path `/resume` and the card button
 *    use), unless a human closed it explicitly (`/close`, card "close") — that
 *    intent is kept and a fresh session starts as before;
 *  - a peer bot may ask for a choice with a first-line `@session resume|fresh`
 *    directive (`botmux dispatch --into … --session-mode …` writes it);
 *  - every non-trivial outcome is recorded on the session (`continuity`) and
 *    shown in `botmux observe`, so a lead can tell "continued" from "started
 *    over" instead of guessing.
 */
import type { Session } from '../types.js';
import { storedSessionAnchorId } from './types.js';

export type TopicSessionMode = 'resume' | 'fresh';

export interface ParsedBotSessionDirective {
  mode?: TopicSessionMode;
  /** Message body with the control directive removed. */
  content: string;
}

/**
 * Consume the bot-to-bot `@session resume|fresh` directive. Same placement rule
 * as `@steer`: the first semantic line, optionally after leading @recipient
 * lines (which may include `@steer`). Only `resume` and `fresh` are recognised;
 * anything else is left as model content.
 */
export function parseBotSessionDirective(content: string): ParsedBotSessionDirective {
  const lines = content.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index++;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    const match = /^@session\s+(resume|fresh)(?:\s+(.*))?$/i.exec(line);
    if (match) {
      const inline = match[2]?.trim();
      if (inline) lines[index] = inline;
      else lines.splice(index, 1);
      return { mode: match[1]!.toLowerCase() as TopicSessionMode, content: lines.join('\n') };
    }
    if (!line.startsWith('@')) break;
    index++;
    while (index < lines.length && !lines[index]!.trim()) index++;
  }
  return { content };
}

/** Add the wire directive once (sender side of `dispatch --session-mode`). */
export function withBotSessionDirective(content: string, mode: TopicSessionMode): string {
  return parseBotSessionDirective(content).mode
    ? content
    : `@session ${mode}\n${content}`;
}

/** Why a closed session must not be resumed automatically, or undefined when it may be. */
export function topicResumeBlockReason(session: Session): string | undefined {
  if (session.status !== 'closed') return 'not_closed';
  if (session.userClosedAt) return 'user_closed';
  if (session.workspaceRetirement) return 'workspace_retired';
  if (session.title?.startsWith('Adopt:') || session.adoptedFrom) return 'adopt_unsupported';
  return undefined;
}

/**
 * The most recently closed thread-scope session of `larkAppId` in this chat +
 * topic that has conversation history. A shell a command pre-created (`/help`
 * and the like) is a closed row too; like `/resume` it must not shadow the real
 * conversation.
 */
export function findLatestClosedTopicSession(
  sessions: readonly Session[],
  target: { larkAppId: string; chatId: string; anchor: string },
): Session | undefined {
  let best: Session | undefined;
  let bestAt = -Infinity;
  for (const s of sessions) {
    if (s.status !== 'closed' || s.scope === 'chat') continue;
    if ((s.larkAppId ?? '') !== target.larkAppId || s.chatId !== target.chatId) continue;
    if (storedSessionAnchorId(s) !== target.anchor) continue;
    if (!(s.cliSessionId || s.lastCliInput || s.lastUserPrompt)) continue;
    const at = s.closedAt ? Date.parse(s.closedAt) : NaN;
    const rank = Number.isFinite(at) ? at : 0;
    if (!best || rank > bestAt) { best = s; bestAt = rank; }
  }
  return best;
}

export type TopicContinuityRecord = NonNullable<Session['continuity']>;
