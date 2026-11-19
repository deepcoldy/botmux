/**
 * `/g --start <任务>`（或 bot 配置 `groupCreation.autoStart: true`）：/g 后面的正文
 * （或被引用的消息）当任务。默认关闭：没开启时 `/g <文字>` 保持已发版语义，只建群；
 * `--no-start` 单次关闭。
 *
 * 普通 /g 只建群不开工，因为群名不足以作为首轮输入；带任务时就有了可开工的
 * 内容。建群仍走 /g 原有流程（选主、邀请、群主转移、标签与头像），这里只负责
 * 建群之后的两步：把引用和附件转发进新群，再在新群为本 Bot 起一个全新会话。
 * 首轮输入只带用户原话和来源定位，不继承原会话上下文；Bot 按定位自行查看原文。
 */
import { t, type Locale } from '../i18n/index.js';
import { extractResources } from '../im/lark/message-parser.js';

/** Graphemes kept in the placeholder name before the AI title lands. */
export const GROUP_TASK_PLACEHOLDER_MAX = 20;

export interface GroupTaskSource {
  chatId: string;
  chatType?: 'group' | 'p2p';
  /** Display name of the source chat; absent for p2p or when the lookup failed. */
  chatName?: string;
  messageId: string;
  /** Lark thread_id; only real topic/thread replies carry it. */
  threadId?: string;
  rootId?: string;
  /** Message the user quoted when sending the command. */
  parentId?: string;
  /** The `/g` body with options and @-mentions removed. May be empty when quoting. */
  task: string;
}

/** First non-empty line of the task, cut by graphemes so emoji stay whole. */
export function groupTaskPlaceholder(task: string, maxLen = GROUP_TASK_PLACEHOLDER_MAX): string {
  const line = task.split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map(x => x.segment);
  return graphemes.length > maxLen ? `${graphemes.slice(0, maxLen).join('')}…` : line;
}

/** The message the user really quoted. Inside a topic Lark sets parent_id to
 *  the topic root even without a quote; that is not a quote (see quote-hint). */
export function groupTaskQuoteId(message: { messageId: string; rootId?: string; threadId?: string; parentId?: string }): string | undefined {
  const quoted = message.parentId;
  if (!quoted || quoted === message.messageId) return undefined;
  if (message.threadId && quoted === message.rootId) return undefined;
  return quoted;
}

/** Whether the command message itself carries media. Slash commands run
 *  before attachments are downloaded, so this reads the raw message shape. */
export function groupTaskHasMedia(message: { msgType: string; rawPostContent?: string }): boolean {
  if (message.msgType === 'post') {
    return !!message.rawPostContent && extractResources('post', message.rawPostContent).length > 0;
  }
  return message.msgType !== 'text';
}

/** Messages to forward into the new chat: the command itself only when it
 *  carries media (its text is already in the prompt), plus the quote. */
export function groupTaskForwardIds(message: { messageId: string; msgType: string; rawPostContent?: string; rootId?: string; threadId?: string; parentId?: string }): string[] {
  const quoted = groupTaskQuoteId(message);
  return [...new Set([
    ...(groupTaskHasMedia(message) ? [message.messageId] : []),
    ...(quoted ? [quoted] : []),
  ])];
}

/** First-turn input for the new session: the user's words plus where they came from. */
export function groupTaskPrompt(source: GroupTaskSource, loc: Locale): string {
  const chatLabel = source.chatName?.replace(/\s+/g, ' ').trim().slice(0, 120)
    || t(source.chatType === 'p2p' ? 'cmd.group.task_source_p2p' : 'cmd.group.task_source_group', undefined, loc);
  const lines = [
    t('ai.group_task.intro', undefined, loc),
    t('cmd.group.task_prompt_words', undefined, loc),
    source.task.trim() || t('cmd.group.task_prompt_quoted', undefined, loc),
    t('cmd.group.task_prompt_chat', { name: chatLabel, chatId: source.chatId }, loc),
    t('cmd.group.task_prompt_message', { id: source.messageId }, loc),
  ];
  if (source.threadId) lines.push(t('cmd.group.task_prompt_thread', { id: source.threadId }, loc));
  if (source.threadId && source.rootId && source.rootId !== source.messageId) {
    lines.push(t('cmd.group.task_prompt_root', { id: source.rootId }, loc));
  }
  if (source.parentId) lines.push(t('cmd.group.task_prompt_quote', { id: source.parentId }, loc));
  return lines.join('\n');
}

export interface GroupTaskStartDeps {
  forward: (messageId: string, chatId: string) => Promise<unknown>;
  startSession: (chatId: string, prompt: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface GroupTaskStartResult {
  /** Message ids that could not be forwarded; the session still starts. */
  forwardFailed: string[];
  /** Set when the new session could not be started; the chat is kept. */
  startError?: string;
  /** The session exists but waits for the user to pick a repository. */
  pendingRepo?: boolean;
}

/**
 * Run after the chat exists. Forwarding goes first so the context is already
 * in the chat when the session's first turn reads it; a failed forward never
 * blocks the start because the prompt also carries the message ids.
 */
export async function startGroupTask(
  chatId: string,
  forwardIds: readonly string[],
  prompt: string,
  deps: GroupTaskStartDeps,
): Promise<GroupTaskStartResult> {
  const forwardFailed: string[] = [];
  for (const id of forwardIds) {
    try { await deps.forward(id, chatId); } catch { forwardFailed.push(id); }
  }
  let startError: string | undefined;
  try {
    const started = await deps.startSession(chatId, prompt);
    if (!started.ok) startError = started.error;
  } catch (err: unknown) {
    startError = err instanceof Error ? err.message : String(err);
  }
  return { forwardFailed, ...(startError ? { startError } : {}) };
}
