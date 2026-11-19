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
  /** Written before transport; cleared by ACK or a proven pre-transport abort. */
  deliveryPending?: boolean;
  stalled?: boolean;
  settled?: boolean;
  paused?: boolean;
  dirty?: boolean;
  /** Bounded, durable PATCH budget for each new display state. */
  patchAttempts?: number;
  patchRevision?: number;
}
export interface CliProgressNoticeDeps {
  records: (create?: boolean) => CliProgressNotice[];
  now: () => number;
  persist: () => void;
  allowed: (r: CliProgressNotice) => boolean;
  waiting: (r: CliProgressNotice) => boolean;
  timeout: () => number;
  send: (r: CliProgressNotice, level: number, beforeWrite: () => void) => Promise<string>;
  update: (r: CliProgressNotice, messageId: string, beforeWrite: () => void) => Promise<void>;
  error: (error: unknown) => void;
  warn: (message: string) => void;
}
// Only thrown by our beforeWrite callback, before the Lark API is entered.
class PreTransportAbortError extends Error {}
export class CliProgressNotifier {
  private activePoll?: Promise<void>;
  private closing = false;
  private disposed = false;
  private persistedAt = new Map<string, number>();
  constructor(private readonly deps: CliProgressNoticeDeps) {}
  begin(turnId: string, attempt: number | undefined, caller: string, generation: number, target?: FrozenSessionReplyTarget): void {
    if (this.disposed || this.closing) return;
    const old = this.find(turnId, attempt);
    if (old) { // A repeated ACK/reconnect cannot erase receipts or revive a terminal.
      if (!old.settled) {
        old.generation = generation;
        this.progress(turnId, attempt, generation, 'input_started');
        this.persist();
      }
      return;
    }
    if (this.deps.records().length >= 64) {
      let i = this.deps.records().findIndex(r => r.generation !== generation);
      if (i < 0) i = this.deps.records().findIndex(r => r.settled);
      if (i < 0) {
        this.deps.warn('CLI progress notice capacity exhausted; current receipts retained');
        return; // Never evict a current-generation in-flight receipt.
      }
      const [removed] = this.deps.records().splice(i, 1);
      this.persistedAt.delete(JSON.stringify([removed.turnId, removed.attempt]));
      if (removed.generation !== generation) this.deps.warn('Retired stale CLI progress notice record');
    }
    this.deps.records(true).push({ turnId, attempt, caller, target, generation, progressAt: this.deps.now(),
      stage: 'input_started', claimed: 0, messages: [] });
    this.persist();
  }
  private find(turn: string, attempt?: number) {
    return this.deps.records().find(r => r.turnId === turn && r.attempt === attempt);
  }
  progress(turn: string, attempt: number | undefined, generation: number, stage: ProgressStage): void {
    if (this.disposed || this.closing) return;
    const r = this.find(turn, attempt);
    if (!r || r.settled || r.generation !== generation) return;
    const changed = r.stage !== stage || !!r.stalled;
    const key = JSON.stringify([turn, attempt]);
    const previous = this.persistedAt.get(key) ?? 0;
    r.progressAt = this.deps.now(); r.stage = stage;
    if (r.stalled) { r.stalled = false; this.markDirty(r); }
    if (changed || r.progressAt - previous >= 10_000) {
      this.persist(); this.persistedAt.set(key, r.progressAt);
    }
  }
  reply(turn: string, final: boolean): void {
    if (this.disposed || this.closing) return;
    for (const r of this.deps.records().filter(r => r.turnId === turn && !r.settled)) {
      if (final) this.finish(r.turnId, r.attempt);
      else this.progress(r.turnId, r.attempt, r.generation, r.stage);
    }
  }
  finish(turn: string, attempt?: number): void {
    if (this.disposed) return;
    const r = this.find(turn, attempt);
    if (!r || r.settled) return;
    r.settled = true; r.stalled = false; this.markDirty(r);
    this.persistedAt.delete(JSON.stringify([turn, attempt])); this.persist();
  }
  dispose(): void { this.disposed = true; this.persistedAt.clear(); }
  private persist(): void {
    try { this.deps.persist(); }
    catch (error) {
      // updateSession may replace every session field from its durable row.
      // Stop this lifetime: neither a detached record nor a failed claim may
      // be used by later IPC/ticks. A new owner must re-read durable state.
      this.dispose();
      throw error;
    }
  }
  async close(timeoutMs = 2_000): Promise<void> {
    if (this.disposed) return;
    this.closing = true; // Guard any POST still waiting to enter transport.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const r of this.deps.records()) {
        if (this.deps.allowed(r)) this.finish(r.turnId, r.attempt);
      }
      await Promise.race([
        (async () => { await this.activePoll; await this.poll(); })(),
        new Promise<void>(resolve => { timer = setTimeout(() => { this.dispose(); resolve(); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); this.dispose(); }
  }
  poll(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.activePoll) return this.activePoll;
    const pending = this.runPoll();
    this.activePoll = pending;
    void pending.finally(() => { if (this.activePoll === pending) this.activePoll = undefined; }).catch(() => {});
    return pending;
  }
  private async runPoll(): Promise<void> {
    for (const r of this.deps.records()) {
      if (this.disposed || !this.deps.allowed(r)) continue;
      // Recovery retries must never patch an old card back to an @ warning
      // after a later silence window has already posted a new alert.
      if (r.dirty && r.messages.length && (!r.stalled || r.settled)) {
        const attempt = (r.patchAttempts ?? 0) + 1;
        if (attempt > 3) { r.dirty = false; this.persist(); }
        else {
          const revision = r.patchRevision ?? 0;
          r.patchAttempts = attempt;
          // Unlike POST, repeating an update to a known message is safe.
          // Keep dirty durable until ACK; a crash must not lose the recovery.
          this.persist();
          let failed = false;
          for (const id of r.messages) {
            if (this.disposed) return;
            try {
              await this.deps.update(r, id, () => {
                this.guard(r);
                if ((r.patchRevision ?? 0) !== revision) throw new Error('superseded progress patch');
              });
            } catch (e) { failed = true; this.deps.error(e); }
          }
          // A terminal/progress event may arrive during the API call. It owns
          // a fresh retry budget and must not be cleared by this old ACK.
          if (this.disposed || !this.deps.allowed(r) || !this.deps.records().includes(r)) return;
          if ((r.patchRevision ?? 0) === revision) r.dirty = failed && attempt < 3;
          this.persist();
        }
      }
      if (r.settled || this.closing || this.disposed) continue;
      if (this.deps.waiting(r)) {
        if (!r.paused) { r.paused = true; this.persist(); }
        continue;
      }
      if (r.paused) { r.paused = false; r.progressAt = this.deps.now(); this.persist(); }
      const idle = this.deps.now() - r.progressAt;
      const first = this.deps.timeout();
      const level = idle >= Math.max(900_000, first * 3) ? 2 : idle >= first ? 1 : 0;
      if (!level || level <= r.claimed || r.deliveryPending) continue;
      const previousClaim = r.claimed;
      r.claimed = level; r.stalled = true; r.deliveryPending = true;
      this.persist(); // Failure here prevents publication.
      const observedAt = r.progressAt;
      let enteredTransport = false;
      try {
        const id = await this.deps.send(r, level, () => {
          try {
            this.guard(r);
            if (this.closing || r.settled || !r.stalled || r.progressAt !== observedAt || this.deps.waiting(r)) {
              throw new Error('stale progress notification');
            }
          } catch { throw new PreTransportAbortError('CLI progress send cancelled before transport'); }
          // The API gate may retry after an ambiguous network/5xx failure.
          // A later beforeWrite abort cannot prove the earlier attempt unsent.
          enteredTransport = true;
        });
        if (this.disposed || !this.deps.allowed(r) || !this.deps.records().includes(r)) return;
        r.messages.push(id); r.deliveryPending = false;
        // An actual result may race the API acknowledgement; patch, do not resend.
        if (r.settled || !r.stalled || r.progressAt !== observedAt) this.markDirty(r);
        this.persist();
      } catch (e) {
        if (this.disposed) throw e;
        if (!this.deps.allowed(r) || !this.deps.records().includes(r)) return;
        if (e instanceof PreTransportAbortError && !enteredTransport) {
          // Definitely no POST: undo only this claim, not a racing progress/
          // terminal event or previous delivery receipts. Waiting starts a
          // fresh quiet window even if it ends before the next tick.
          r.claimed = previousClaim; r.deliveryPending = false; r.stalled = false;
          if (this.deps.waiting(r)) r.paused = true;
          if (r.messages.length && !r.dirty) this.markDirty(r);
          this.persist();
          continue;
        }
        // The transport may have accepted the message before losing its ACK.
        // deliveryPending fences a crash/ACK loss from the pre-send claim.
        // Never escalate after a transport error (including a guard rejection
        // during an API-gate retry). Persistence failure retires this notifier.
        r.claimed = 2; this.persist(); this.deps.error(e);
      }
    }
  }
  private markDirty(r: CliProgressNotice): void {
    r.dirty = true; r.patchAttempts = 0;
    r.patchRevision = (r.patchRevision ?? 0) + 1;
  }
  private guard(r: CliProgressNotice) {
    if (this.disposed || !this.deps.allowed(r) || !this.deps.records().includes(r)) throw new Error('retired progress notification');
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
  return JSON.stringify({ schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template: active ? 'orange' : 'grey' },
    body: { elements: [{ tag: 'markdown', content: body }] } });
}
