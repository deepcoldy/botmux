import { getBot } from '../bot-registry.js';
import type { LongTaskExecution } from '../core/long-task-reminder.js';
import { frozenReplyContextForTurn } from '../core/reply-target.js';
import { replyMessage, sendMessage } from '../im/lark/client.js';

const DEFAULT_REMINDER_TITLE = '当前任务';
const DEFAULT_REMINDER_TITLE_MAX_CHARS = 40;

function resolveBotName(larkAppId: string | undefined): string | undefined {
  if (!larkAppId) return undefined;
  try {
    return getBot(larkAppId).botName;
  } catch {
    return undefined;
  }
}

/** Sanitize a raw session title for display on a reminder card: strip leading
 *  `@<botName>` (which may contain spaces or be truncated mid-name in 50-char
 *  group titles) and generic leading `@mention` prefixes, collapse whitespace,
 *  and truncate safely by Unicode code points with an ellipsis. */
export function formatLongTaskReminderTitle(
  rawTitle?: string,
  botName?: string,
  maxChars = DEFAULT_REMINDER_TITLE_MAX_CHARS,
): string {
  let text = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return DEFAULT_REMINDER_TITLE;

  const normalizedBotName = botName?.replace(/\s+/g, ' ').trim();
  const botMention = normalizedBotName ? `@${normalizedBotName}` : undefined;
  const botMentionLower = botMention?.toLowerCase();
  const botEndsWithAsciiWord = normalizedBotName ? /[A-Za-z0-9]$/.test(normalizedBotName) : false;

  while (text.startsWith('@')) {
    if (botMention && botMentionLower) {
      const textLower = text.toLowerCase();
      if (textLower.startsWith(botMentionLower)) {
        const nextChar = text.slice(botMention.length, botMention.length + 1);
        const boundaryMatches = !nextChar
          || /[\s:：,，(（[【]/.test(nextChar)
          || (botEndsWithAsciiWord && !/[A-Za-z0-9_-]/.test(nextChar));
        if (boundaryMatches) {
          text = text.slice(botMention.length).replace(/^[\s:：,，]+/, '');
          continue;
        }
      } else if (text.length > 1 && botMentionLower.startsWith(textLower)) {
        // The 50-char session title was truncated mid-way through @<botName>.
        text = '';
        break;
      }
    }
    // Strip a generic leading @mention token (excluding scoped package names
    // containing `/` such as `@scope/pkg`, and stopping at CJK/ASCII separator
    // punctuation so `@Bot，正文` preserves `正文`).
    const generic = text.match(/^@[^/\s,，:：;；!！?？(（[【]+(?:[\s,，:：]+|$)/);
    if (!generic) break;
    text = text.slice(generic[0].length).trimStart();
  }

  text = text.trim();
  if (!text) return DEFAULT_REMINDER_TITLE;

  const limit = Math.max(1, Math.floor(maxChars));
  const chars = Array.from(text);
  if (chars.length > limit) {
    return `${chars.slice(0, limit).join('').trimEnd()}…`;
  }
  return text;
}

/** Build a standalone status card without changing the task's streaming reply. */
export function longTaskReminderCard(task: LongTaskExecution, elapsedMinutes: number, botName?: string): string {
  const title = formatLongTaskReminderTitle(
    task.session.session.title,
    botName ?? resolveBotName(task.session.larkAppId),
  );
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '任务仍在执行' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: title } },
      { tag: 'div', text: { tag: 'lark_md', content: `已运行 **${elapsedMinutes} 分钟**，任务尚未结束。完成或取消后将停止提醒。` } },
    ],
  });
}

/** Deliver to this turn's frozen destination, preserving chat/topic routing. */
export async function sendLongTaskReminder(
  task: LongTaskExecution,
  elapsedMinutes: number,
  uuid: string,
  beforeWrite: () => void,
): Promise<void> {
  /** Freeze the destination before any asynchronous authorization/gate wait. */
  const target = frozenReplyContextForTurn(task.session, task.turnId).target;
  /** Plain task text stays plain_text, so user input cannot inject card markup. */
  const card = longTaskReminderCard(task, elapsedMinutes);
  if (target.mode === 'plain') {
    await sendMessage(task.session.larkAppId, target.chatId, card, 'interactive', uuid, undefined, { beforeWrite, suppressHook: true });
  } else {
    await replyMessage(task.session.larkAppId, target.rootMessageId, card, 'interactive', target.mode === 'thread', uuid, undefined, { beforeWrite, suppressHook: true });
  }
}
