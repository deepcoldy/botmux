import { sendMessage as defaultSendMessage } from '../im/lark/client.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { recordGoalNarration } from '../services/goal-narration-store.js';

const sentNarrations: Map<string, number> = new BoundedMap(2000);

export type GoalNarrationEvent =
  | {
      type: 'human-decision';
      key: string;
      decisionText: string;
      source: '主群回复中控' | 'dashboard';
    }
  | {
      type: 'accepted';
      key: string;
      taskId: string;
      title?: string;
      mode: '自动对账' | '监管者验收' | '监管者代办';
    }
  | {
      type: 'rejected';
      key: string;
      taskId: string;
      reason: string;
    }
  | {
      type: 'escalated';
      key: string;
      taskId: string;
      reason: string;
    }
  | {
      type: 'help';
      key: string;
      taskId: string;
      detail: string;
    }
  | {
      type: 'cleanup';
      key: string;
      /** Total chat-scope sessions closed across all bots/daemons. */
      closed: number;
    }
  | {
      type: 'reassigned';
      key: string;
      taskId: string;
      /** Display name (or id) of the worker confirmed dead, if known. */
      deadWorker?: string;
    };

export interface EmitGoalNarrationInput {
  larkAppId: string;
  goalChatId?: string;
  event: GoalNarrationEvent;
}

export interface EmitGoalNarrationDeps {
  sendMessage?: (larkAppId: string, chatId: string, content: string, msgType?: string) => Promise<string>;
  /** Injectable so tests don't write to the real session data dir. */
  recordNarration?: (rec: Parameters<typeof recordGoalNarration>[0]) => void;
}

function cleanLine(text: string | undefined, fallback = ''): string {
  return (text ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

/**
 * Human replies routed back from the parent group auto-@ the panel/messenger
 * bot (and sometimes others); the raw content therefore leads with one or more
 * "@xxx " tokens. Strip those leading mentions so the narration shows just what
 * the human actually said, not the routing chrome (e.g. "@loopy-中控 A" → "A").
 */
function stripLeadingMentions(text: string | undefined): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = t.replace(/^@\S+\s+/, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

export function buildGoalNarrationText(event: GoalNarrationEvent): string {
  if (event.type === 'human-decision') {
    // Title stays neutral ("回复", not "决策"): a reply in the parent thread may
    // be a decision, a question, or a correction — the system can't (and
    // shouldn't) assert it's a decision. L2 reads it and decides what it is.
    return [
      '👤 人类回复已送达监管者',
      `内容：${cleanLine(stripLeadingMentions(event.decisionText), '(空)')}`,
      `来源：${event.source} → 监管者处理中`,
    ].join('\n');
  }
  if (event.type === 'accepted') {
    return [
      `✅ 已验收 · ${event.taskId}`,
      cleanLine(event.title),
      `方式：${event.mode}`,
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'rejected') {
    return [
      `❌ 已驳回 · ${event.taskId}`,
      `原因：${cleanLine(event.reason, '未说明')}`,
      '待执行者修复后重新提交结果',
    ].join('\n');
  }
  if (event.type === 'escalated') {
    return [
      `⚠️ 升级给人 · ${event.taskId}`,
      `原因：${cleanLine(event.reason, '未说明')}`,
      '已通过中控通知主群，等人拍板',
    ].join('\n');
  }
  if (event.type === 'cleanup') {
    return [
      `🧹 会话已清理 · 关闭 ${event.closed} 个会话`,
      '本机可管理的目标群会话已收尾（群保留，不退群/不删群）',
    ].join('\n');
  }
  if (event.type === 'reassigned') {
    return [
      `🔄 已自动重派 · ${event.taskId}`,
      `原执行者${event.deadWorker ? `（${cleanLine(event.deadWorker)}）` : ''}确认掉线，任务已重新派发`,
      '监管者继续盯，无需重复操作',
    ].join('\n');
  }
  return [
    `🆘 求助 · ${event.taskId}`,
    cleanLine(event.detail, '执行者请求监管者协助'),
    '监管者介入中',
  ].join('\n');
}

export async function emitGoalNarration(input: EmitGoalNarrationInput, deps: EmitGoalNarrationDeps = {}): Promise<{ sent: boolean; deduped?: boolean; skipped?: string; messageId?: string }> {
  if (!input.goalChatId) return { sent: false, skipped: 'missing_goal_chat' };
  const key = input.event.key;
  if (sentNarrations.has(key)) return { sent: false, deduped: true };
  sentNarrations.set(key, Date.now());
  try {
    const sendMessage = deps.sendMessage ?? defaultSendMessage;
    const text = buildGoalNarrationText(input.event);
    const messageId = await sendMessage(input.larkAppId, input.goalChatId, text, 'text');
    // Mirror to the per-goal narration log so the dashboard board shows the same
    // event stream as the chat (esp. 「人类决策到达」, which is not a ledger fact).
    // Best-effort: the store swallows its own errors and never throws.
    const taskId = 'taskId' in input.event ? input.event.taskId : undefined;
    const record = deps.recordNarration ?? recordGoalNarration;
    record({ goalChatId: input.goalChatId, type: input.event.type, taskId, text, ts: Date.now() });
    return { sent: true, messageId };
  } catch (err) {
    sentNarrations.delete(key);
    throw err;
  }
}
