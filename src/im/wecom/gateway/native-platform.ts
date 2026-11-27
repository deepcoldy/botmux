import { createHash } from 'node:crypto';
import { realpathSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { wecomPathInside } from './path-inside.js';
import type { WecomInboundMessage, WecomTemplateCard } from '../protocol/types.js';
import type { FeedbackPolicy } from '../../../services/feedback-policy.js';
import {
  WECOM_SUMMARY_DEFAULT_LIMIT,
  WECOM_SUMMARY_DEFAULT_SINCE_HOURS,
  type WecomNativePlatformConfig,
} from '../config/native-platform-config.js';
import { wecomHelpEntries } from './native-commands.js';

export interface ObservedTask {
  message: WecomInboundMessage;
  route?: string;
  createdAt?: number;
  completedAt?: number;
  delivered?: boolean;
  revoked?: boolean;
  result?: string;
  /** Completed without a reply (see bridge/types.ts Task.silent). */
  silent?: boolean;
  sessionId?: string;
  triggerId?: string;
  request?: unknown;
}

export interface WecomPlatformState {
  summaryCursors?: Record<string, string>;
  summaryMemoryByRoute?: Record<string, { content: string; cursor?: string; updatedAt: number }>;
  tasks: Record<string, ObservedTask>;
}

export function wecomFeedbackPolicy(
  policy: WecomNativePlatformConfig & { feedback?: FeedbackPolicy | { enabled?: false } },
  conversation: string,
) {
  return policy.chatFeedbackPolicies?.[conversation] ?? policy.feedback;
}

/** The bot's side of an observed turn in a /summary prompt. A silent turn is
 *  marked, never shown as an empty line. */
function observedBotLine(task: ObservedTask): string {
  if (task.silent) {
    return '（本轮无需回复，未发送消息）';
  }
  return task.result ?? '（尚未完成）';
}

/** The range one /summary covers: the configured bounds, the Feishu defaults (50 turns, 24 hours) where unset. */
export function summaryRange(policy: WecomNativePlatformConfig): { limit: number; sinceHours: number } {
  return {
    limit: policy.summaryRange?.limit ?? WECOM_SUMMARY_DEFAULT_LIMIT,
    sinceHours: policy.summaryRange?.sinceHours ?? WECOM_SUMMARY_DEFAULT_SINCE_HOURS,
  };
}

export function wecomObservedSummary(
  message: WecomInboundMessage,
  policy: WecomNativePlatformConfig,
  state: WecomPlatformState,
  now = Date.now(),
  route?: string,
): { prompt: string; cursor?: string } {
  const range = summaryRange(policy);
  const tasks = Object.entries(state.tasks)
    .filter(([, task]) => !task.revoked
      && task.message.conversationId === message.conversationId
      && task.message.chatType === message.chatType
      && (route ? task.route === route : task.message.userId === message.userId)
      && task.createdAt !== undefined
      && task.createdAt >= now - range.sinceHours * 3600000)
    .sort((a, b) => a[1].createdAt! - b[1].createdAt!)
    .slice(-range.limit);
  const memory = policy.summaryMemory && route ? state.summaryMemoryByRoute?.[route] : undefined;
  const remaining = memory?.cursor && tasks.some(([id]) => id === memory.cursor)
    ? tasks.slice(tasks.findIndex(([id]) => id === memory.cursor) + 1)
    : tasks;
  return {
    prompt: [
      '请总结以下本地已观测的机器人对话。范围仅限平台已投递且通过授权的当前会话消息，不含未投递的全群历史；不要推断遗漏消息。',
      memory ? `先前已观测范围摘要（游标 ${memory.cursor ?? 'unknown'}）：\n${memory.content}` : '',
      ...remaining.map(([, task]) =>
        `[${new Date(task.createdAt!).toISOString()}] 用户 ${task.message.userId}：${task.message.text}\n机器人：${observedBotLine(task)}`),
    ].join('\n\n'),
    cursor: tasks.at(-1)?.[0],
  };
}

/** Workspace confinement follows real parent paths, rejecting symlink escapes. */
export function writeWecomSummaryMemory(workspace: string, path: string, text: string): void {
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  if (isAbsolute(path) || !wecomPathInside(root, target)) {
    throw new Error('wecom_summary_path_escape');
  }
  let parent = dirname(target);
  const missing: string[] = [];
  while (true) {
    try {
      const actual = realpathSync(parent);
      if (!wecomPathInside(root, actual)) {
        throw new Error('wecom_summary_path_escape');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      missing.push(parent);
      const next = dirname(parent);
      if (next === parent) {
        throw error;
      }
      parent = next;
    }
  }
  for (const dir of missing.reverse()) {
    mkdirSync(dir, { mode: 0o700 });
  }
  atomicWriteFileSync(target, text, { mode: 0o600, durable: true, followTargetSymlink: false });
}

/**
 * Template card text fields (`sub_title_text`, a vertical item's `desc`) and the
 * number of vertical items, per the WeCom template card limits. The help card
 * fills them with whole lines and never cuts a line, so a command name is never
 * truncated; help that does not fit goes out as text instead.
 */
const WECOM_CARD_TEXT_MAX = 112;
const WECOM_CARD_VERTICAL_MAX = 4;

/** One help line per command: usage and description, from the command data (native-commands.ts). */
function wecomHelpLines(): string[] {
  return wecomHelpEntries().map(entry => `${entry.usage}：${entry.description}`);
}

/** The help as a text reply: the same lines as the card. */
function wecomHelpText(): string {
  return ['可用命令：', ...wecomHelpLines()].join('\n');
}

/**
 * The help as a template card, or undefined when the lines do not fit: whole
 * lines packed into the subtitle, then up to four vertical items.
 */
function buildWecomHelpCard(taskId: string): WecomTemplateCard | undefined {
  const chunks: string[] = [];
  for (const line of wecomHelpLines()) {
    if (line.length > WECOM_CARD_TEXT_MAX) {
      return undefined;
    }
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= WECOM_CARD_TEXT_MAX) {
      chunks[chunks.length - 1] = `${last}\n${line}`;
    } else {
      chunks.push(line);
    }
  }
  const [subtitle, ...rest] = chunks;
  if (rest.length > WECOM_CARD_VERTICAL_MAX) {
    return undefined;
  }
  return {
    card_type: 'text_notice',
    task_id: taskId,
    main_title: { title: '命令帮助', desc: '仅处理企业微信实际投递的消息' },
    sub_title_text: subtitle,
    ...(rest.length ? { vertical_content_list: rest.map(desc => ({ title: '更多命令', desc })) } : {}),
    card_action: { type: 0 },
  };
}

export async function platformReceive(ctx: {
  message: WecomInboundMessage;
  transport: {
    reply(message: WecomInboundMessage, text: string): Promise<void>;
    sendCard?(conversation: string, card: WecomTemplateCard): Promise<void>;
  };
  save(): void;
}): Promise<boolean> {
  const command = ctx.message.text.trim().toLowerCase();
  if (command === '/help' || command === '/commands') {
    ctx.save();
    const card = ctx.transport.sendCard
      ? buildWecomHelpCard(`help_${createHash('sha256').update(ctx.message.messageId).digest('hex').slice(0, 32)}`)
      : undefined;
    if (card) {
      await ctx.transport.sendCard!(ctx.message.conversationId, card);
    } else {
      await ctx.transport.reply(ctx.message, wecomHelpText());
    }
    return true;
  }
  return false;
}

/** Durable rolling memory follows the bridge task save, not model/tool writes. */
export function rememberWecomSummary(state: WecomPlatformState, route: string, content: string, now = Date.now()): string {
  const cursor = state.summaryCursors?.[route];
  (state.summaryMemoryByRoute ??= {})[route] = { content, cursor, updatedAt: now };
  return `# 企业微信已观测对话摘要\n\n覆盖范围：仅当前已授权机器人会话；不含未投递群消息。\n来源会话键：${route}\n最后消费游标：${cursor ?? '无'}\n更新时间：${new Date(now).toISOString()}\n\n${content}`;
}
