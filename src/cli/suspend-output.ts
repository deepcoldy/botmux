/**
 * `botmux suspend` 排队时的说明：daemon 的 suspend 路由回 `reason: 'deferred'` 时
 * 带上 `waitingFor`（见 worker-pool 的 manualSuspendWaits），这里把它说成人话，
 * 让操作者知道这个会话在等什么、大概等多久，而不是只看到「排队」。
 */
export type SuspendWait = 'turn' | 'input' | 'reply';

const WAIT_TEXT: Record<SuspendWait, string> = {
  turn: 'CLI 答完当前这一轮',
  input: 'CLI 接收已发给它的消息并答完',
  reply: '上一轮回复发到飞书',
};

function isSuspendWait(value: unknown): value is SuspendWait {
  return typeof value === 'string' && Object.hasOwn(WAIT_TEXT, value);
}

function roughDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 120 ? `约 ${seconds} 秒` : `约 ${Math.ceil(seconds / 60)} 分钟`;
}

/** 「等 … 后自动挂起」。daemon 没给 waitingFor（旧版本）时只知道它判了忙。 */
export function deferredSuspendNote(
  body: { waitingFor?: unknown; replyHoldUntil?: unknown },
  now: number = Date.now(),
): string {
  const waits = Array.isArray(body.waitingFor) ? [...new Set(body.waitingFor.filter(isSuspendWait))] : [];
  if (waits.length === 0) return '等会话空闲后自动挂起';
  const parts = waits.map(wait => (
    wait === 'reply' && typeof body.replyHoldUntil === 'number' && Number.isFinite(body.replyHoldUntil)
      ? `${WAIT_TEXT.reply}（最多${roughDuration(body.replyHoldUntil - now)}）`
      : WAIT_TEXT[wait]
  ));
  const joined = parts.join('、');
  return `等${/^[A-Za-z]/.test(joined) ? ' ' : ''}${joined}后自动挂起`;
}

/** dry-run 只能从会话行的屏幕状态预告「正在出回复」这一种等待。 */
export const DRY_RUN_DEFER_NOTE = deferredSuspendNote({ waitingFor: ['turn'] });
