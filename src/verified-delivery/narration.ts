import { sendMessage as defaultSendMessage } from '../im/lark/client.js';
import { BoundedMap } from '../utils/bounded-map.js';

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
    };

export interface EmitGoalNarrationInput {
  larkAppId: string;
  goalChatId?: string;
  event: GoalNarrationEvent;
}

export interface EmitGoalNarrationDeps {
  sendMessage?: (larkAppId: string, chatId: string, content: string, msgType?: string) => Promise<string>;
}

function cleanLine(text: string | undefined, fallback = ''): string {
  return (text ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

export function buildGoalNarrationText(event: GoalNarrationEvent): string {
  if (event.type === 'human-decision') {
    return [
      '👤 人类决策已送达监管者',
      `决策：${cleanLine(event.decisionText, '(空)')}`,
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
      '待 worker 修复后重新 report',
    ].join('\n');
  }
  if (event.type === 'escalated') {
    return [
      `⚠️ 升级给人 · ${event.taskId}`,
      `原因：${cleanLine(event.reason, '未说明')}`,
      '已通过中控通知主群，等人拍板',
    ].join('\n');
  }
  return [
    `🆘 求助 · ${event.taskId}`,
    cleanLine(event.detail, 'worker 请求监管者协助'),
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
    const messageId = await sendMessage(input.larkAppId, input.goalChatId, buildGoalNarrationText(input.event), 'text');
    return { sent: true, messageId };
  } catch (err) {
    sentNarrations.delete(key);
    throw err;
  }
}

