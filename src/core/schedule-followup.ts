import type { ScheduledTask } from '../types.js';

export function scheduleCreatePlacement(input: {
  newTopic: boolean; topLevel: boolean; topic: boolean; followActive: boolean; untilDone: boolean;
  chatId: string; currentChatId?: string; currentChatType?: 'group' | 'p2p'; currentScope?: 'chat' | 'thread'; rootMessageId?: string;
}): { position: 'top-level' | 'topic' | 'new-topic'; inferredFollowup: boolean } {
  if (input.newTopic) return { position: 'new-topic', inferredFollowup: false };
  if (input.topLevel) return { position: 'top-level', inferredFollowup: false };
  if (input.topic || input.followActive) return { position: 'topic', inferredFollowup: false };
  const currentTopic = input.chatId === input.currentChatId && input.currentScope === 'thread'
    && typeof input.rootMessageId === 'string' && /^om_/.test(input.rootMessageId);
  if (input.untilDone && currentTopic) return { position: 'topic', inferredFollowup: true };
  if (input.currentChatType === 'p2p' && input.currentScope !== 'chat' && input.rootMessageId) {
    return { position: 'topic', inferredFollowup: false };
  }
  return { position: 'top-level', inferredFollowup: false };
}

export type ScheduleSupportInput = Partial<Pick<ScheduledTask, 'executionPosition' | 'scope' | 'rootMessageId' | 'parsed' | 'notify' | 'ownerOpenId' | 'untilDone' | 'runStats' | 'lastRunAt' | 'lastStatus' | 'lastError' | 'repeat'>> & { consecutiveFailures?: number };

export function scheduleSupportDetails(task: ScheduleSupportInput) {
  const position = task.executionPosition ?? (task.scope === 'thread' && task.rootMessageId ? 'topic' : 'top-level');
  const until = task.untilDone;
  const stop = until ? { kind: 'until-done' as const, status: until.status, deadline: until.deadline,
    note: until.doneNote, completedAt: until.doneAt, expiredAt: until.expiredAt }
    : task.repeat?.times != null ? { kind: 'repeat' as const, remaining: Math.max(0, task.repeat.times - task.repeat.completed) }
      : task.parsed?.kind === 'once' ? { kind: 'once' as const } : { kind: 'manual' as const };
  return { position, frequency: task.parsed?.display ?? '',
    retryMinutes: until && task.parsed?.kind === 'once' ? until.retryMinutes ?? 24 * 60 : undefined,
    notify: task.notify ?? [], notificationOwner: task.ownerOpenId, stop,
    lastRunAt: task.lastRunAt, lastStatus: task.lastStatus,
    outcome: until?.status === 'done' ? 'completed' : until?.status === 'expired' ? 'expired' : task.lastStatus,
    expiredReason: until?.status === 'expired' ? 'deadline_reached' : undefined,
    lastError: task.lastError,
    // An ok dispatch is not a confirmed business result. Completion notes remain explicit.
    lastResultNote: until?.status === 'done' ? until.doneNote : undefined,
    consecutiveFailures: task.runStats?.consecutiveFailures ?? task.consecutiveFailures };
}

/** The same readable contract is shown in Lark and the Web UI. */
export function scheduleSupportLines(task: ScheduleSupportInput, locale: 'zh' | 'en' = 'zh'): string[] {
  const info = scheduleSupportDetails(task);
  const en = locale === 'en';
  const positions = en ? { topic: 'original topic', 'top-level': 'group top-level', 'new-topic': 'new topic each run', task: 'dedicated task topic' }
    : { topic: '原话题', 'top-level': '群消息顶层', 'new-topic': '每次新话题', task: '任务独立话题' };
  const stop = info.stop.kind === 'until-done'
    ? (en ? 'confirmed completion or deadline' : '确认完成或达到截止时间') + (info.stop.deadline ? ` (${info.stop.deadline})` : '')
    : info.stop.kind === 'repeat' ? (en ? `${info.stop.remaining} runs remaining` : `剩余 ${info.stop.remaining} 次`)
      : info.stop.kind === 'once' ? (en ? 'after one run' : '一次执行后停止') : (en ? 'manual stop' : '手动停止');
  const last = info.outcome === 'completed' ? info.lastResultNote ?? (en ? 'confirmed completion' : '已确认完成')
    : info.outcome === 'expired' ? (en ? 'deadline reached; completion not confirmed' : '已到截止时间；尚未确认完成')
    : info.lastStatus === 'error' && info.lastError ? info.lastError.slice(0, 500)
    : (info.lastStatus === 'ok' ? (en ? 'check dispatched; outcome not confirmed' : '检查已派发；业务结果未确认')
    : info.lastStatus === 'running' ? (en ? 'running' : '运行中') : info.lastStatus ?? (en ? 'not recorded' : '未记录'));
  const frequency = info.retryMinutes === undefined ? info.frequency
    : (en ? `first: ${info.frequency}; retry every ${info.retryMinutes} min` : `首次：${info.frequency}；之后每 ${info.retryMinutes} 分钟检查`);
  const notifications = info.notify.map(event => event === 'failing' ? (en ? 'consecutive failures' : '连续失败') : (en ? 'deadline reached' : '到期'));
  return [
    `${en ? 'Execution' : '执行位置'}: ${positions[info.position]}`,
    `${en ? 'Frequency' : '检查频率'}: ${frequency || '—'}`,
    `${en ? 'Notification recipient' : '通知对象'}: ${info.notify.length ? (info.notificationOwner ?? (en ? 'creator identity not recorded' : '创建人身份未记录')) : (en ? 'no automatic notification' : '无自动通知')}`,
    `${en ? 'Notification conditions' : '通知条件'}: ${notifications.length ? notifications.join(', ') : '—'}`,
    `${en ? 'Stop condition' : '停止条件'}: ${stop}`,
    `${en ? 'Last result' : '上次结果'}: ${last}`,
    `${en ? 'Consecutive failures' : '连续失败'}: ${info.consecutiveFailures ?? (en ? 'not recorded' : '未记录')}`,
    ...(info.stop.kind === 'until-done' && info.stop.status === 'expired'
      ? [`${en ? 'Expiry reason' : '到期原因'}: ${en ? 'deadline reached' : '已到截止时间'}`, `${en ? 'Expired at' : '到期时间'}: ${info.stop.expiredAt ?? info.stop.deadline ?? '—'}`] : []),
  ];
}
