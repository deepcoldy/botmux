import type { LongTaskExecution } from '../core/long-task-reminder.js';
import { frozenReplyContextForTurn } from '../core/reply-target.js';
import { replyMessage, sendMessage } from '../im/lark/client.js';

/** Build a standalone status card without changing the task's streaming reply. */
export function longTaskReminderCard(task: LongTaskExecution, elapsedMinutes: number): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '任务仍在执行' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: task.session.session.title || '当前任务' } },
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
