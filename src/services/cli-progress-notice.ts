import type { FrozenSessionReplyTarget } from '../types.js';
/** Notification-only state machine. No model request, restart or task replay. */
export type ProgressStage = 'input_started' | 'model_output' | 'tool_started' | 'tool_returned';
export interface CliProgressNotice {
  turnId: string;
  attempt?: number;
  caller: string;
  target?: FrozenSessionReplyTarget;
  generation: number;
  progressAt: number;
  stage: ProgressStage;
  /** Claimed before sending: unknown delivery never permits another send. */
  claimed: number;
  messages: string[];
  /** Written before transport; only a confirmed ACK clears it. */
  deliveryPending?: boolean;
  stalled?: boolean;
  settled?: boolean;
  paused?: boolean;
  dirty?: boolean;
}
export interface CliProgressNoticeDeps {
  records: CliProgressNotice[];
  now: () => number;
  persist: () => void;
  allowed: (r: CliProgressNotice) => boolean;
  waiting: (r: CliProgressNotice) => boolean;
  timeout: () => number;
  send: (r: CliProgressNotice, level: number, beforeWrite: () => void) => Promise<string>;
  update: (r: CliProgressNotice, messageId: string, beforeWrite: () => void) => Promise<void>;
  error: (error: unknown) => void;
}
export class CliProgressNotifier {
  private busy = false;
  private disposed = false;
  private persistedAt = new Map<string, number>();
  constructor(private readonly deps: CliProgressNoticeDeps) {}
  begin(turnId: string, attempt: number | undefined, caller: string, generation: number, target?: FrozenSessionReplyTarget): void {
    const old = this.find(turnId, attempt);
    if (old) { // A repeated ACK/reconnect cannot erase receipts or revive a terminal.
      if (!old.settled) { old.generation = generation; this.deps.persist(); }
      return;
    }
    if (this.deps.records.length >= 64) {
      const i = this.deps.records.findIndex(r => r.settled);
      if (i < 0) return; // Do not evict an in-flight receipt and later resend it.
      this.deps.records.splice(i, 1);
    }
    this.deps.records.push({ turnId, attempt, caller, target, generation, progressAt: this.deps.now(),
      stage: 'input_started', claimed: 0, messages: [] });
    this.deps.persist();
  }
  private find(turn: string, attempt?: number) {
    return this.deps.records.find(r => r.turnId === turn && r.attempt === attempt);
  }
  progress(turn: string, attempt: number | undefined, generation: number, stage: ProgressStage): void {
    const r = this.find(turn, attempt);
    if (!r || r.settled || r.generation !== generation) return;
    const changed = r.stage !== stage || !!r.stalled;
    const key = JSON.stringify([turn, attempt]);
    const previous = this.persistedAt.get(key) ?? 0;
    r.progressAt = this.deps.now(); r.stage = stage;
    if (r.stalled) { r.stalled = false; r.dirty = true; }
    if (changed || r.progressAt - previous >= 10_000) {
      this.deps.persist(); this.persistedAt.set(key, r.progressAt);
    }
  }
  reply(turn: string, final: boolean): void {
    for (const r of this.deps.records.filter(r => r.turnId === turn && !r.settled)) {
      if (final) this.finish(r.turnId, r.attempt);
      else this.progress(r.turnId, r.attempt, r.generation, r.stage);
    }
  }
  finish(turn: string, attempt?: number): void {
    const r = this.find(turn, attempt);
    if (!r || r.settled) return;
    r.settled = true; r.stalled = false; r.dirty = true;
    this.persistedAt.delete(JSON.stringify([turn, attempt])); this.deps.persist();
  }
  dispose(): void { this.disposed = true; }
  async poll(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      for (const r of this.deps.records) {
        if (this.disposed || !this.deps.allowed(r)) continue;
        if (r.dirty && r.messages.length) {
          r.dirty = false; this.deps.persist();
          for (const id of r.messages) {
            try { await this.deps.update(r, id, () => this.guard(r)); }
            catch (e) { this.deps.error(e); }
          }
        }
        if (r.settled) continue;
        if (this.deps.waiting(r)) {
          if (!r.paused) { r.paused = true; this.deps.persist(); }
          continue;
        }
        if (r.paused) { r.paused = false; r.progressAt = this.deps.now(); this.deps.persist(); }
        const idle = this.deps.now() - r.progressAt;
        const first = this.deps.timeout();
        const level = idle >= Math.max(900_000, first * 3) ? 2 : idle >= first ? 1 : 0;
        if (!level || level <= r.claimed || r.deliveryPending) continue;
        r.claimed = level; r.stalled = true; r.deliveryPending = true;
        this.deps.persist(); // Failure here prevents publication.
        const observedAt = r.progressAt;
        try {
          const id = await this.deps.send(r, level, () => {
            this.guard(r);
            if (r.settled || !r.stalled || r.progressAt !== observedAt || this.deps.waiting(r)) {
              throw new Error('stale progress notification');
            }
          });
          r.messages.push(id); r.deliveryPending = false;
          // An actual result may race the API acknowledgement; patch, do not resend.
          if (r.settled || !r.stalled || r.progressAt !== observedAt) r.dirty = true;
          this.deps.persist();
        } catch (e) {
          // The transport may have accepted the message before losing its ACK.
          // Suppress escalation too: no new post until delivery is reconciled.
          r.claimed = 2; this.deps.persist(); this.deps.error(e);
        }
      }
    } finally { this.busy = false; }
  }
  private guard(r: CliProgressNotice) {
    if (this.disposed || !this.deps.allowed(r)) throw new Error('retired progress notification');
  }
}

/** Deliberately no free-form model/tool text. This is observation, not diagnosis. */
export function cliProgressNoticeCard(r: CliProgressNotice, now: number, level = r.claimed, english = false): string {
  const minutes = Math.max(1, Math.floor((now - r.progressAt) / 60_000));
  const stage = english ? {
    input_started: 'Input submission started; no subsequent execution progress confirmed.',
    model_output: 'Model output observed; no new progress since then.',
    tool_started: 'A tool call was observed; its completion has not been confirmed. It may still be running.',
    tool_returned: 'A tool response was observed; this does not prove that the task succeeded.',
  }[r.stage] : {
    input_started: '执行端已开始提交本轮输入；尚未确认后续执行进展。',
    model_output: '曾收到模型输出；之后未观察到新进展。',
    tool_started: '曾观察到工具调用；尚未确认其结束，工具可能仍在运行。',
    tool_returned: '曾观察到工具返回；不代表整个任务已成功。',
  }[r.stage];
  const active = r.stalled && !r.settled;
  const title = english ? (active ? 'No recent execution progress' : 'Execution status updated')
    : (active ? '暂未观察到新的执行进展' : '执行状态已更新');
  const body = active ? (english
    ? `<at id="${r.caller}"></at> No new observable progress for ${minutes} minutes.\nLast confirmed: ${stage}\n${level === 2 ? 'Do not assume the task is still making progress. ' : ''}Check this session before deciding whether to resume. Reconcile any existing write results first; do not blindly repeat creation or submission.\nThis notice has not restarted, interrupted or retried the task. The model may still be processing.`
    : `<at id="${r.caller}"></at> 已连续 ${minutes} 分钟没有可确认的新进展。\n最后确认：${stage}\n${level === 2 ? '不建议继续把此状态当作正常执行等待。' : ''}建议先检查当前会话状态，再决定是否恢复；恢复前核对已有写入结果，避免重复创建或提交。\n本次提醒未重启、中断或重试任务；不能据此断言模型已停止。`)
    : english ? (r.settled ? 'Monitoring for this turn has ended. Consult the task result; this status does not imply success.' : 'New execution progress has been observed. The task is not yet confirmed complete.')
      : r.settled ? '本轮监测已结束，请以任务结果为准；此状态不代表业务成功。' : '已观察到新的执行进展；任务尚未确认完成。';
  return JSON.stringify({ schema: '2.0', header: { title: { tag: 'plain_text', content: title }, template: active ? 'orange' : 'grey' },
    body: { elements: [{ tag: 'markdown', content: body }] } });
}
