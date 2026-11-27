import type { CoreOnlyProgress } from '../../../core/core-only-progress.js';
import type { CoreOnlyReminderState } from '../../../core/core-only-reminder-state.js';
import { isOwnerReminderQuietTime } from '../../../core/session-owner-reminder-quiet-hours.js';
import type { WecomMessageConfig } from '../config/message-config.js';
import type { WecomInboundMessage } from '../protocol/types.js';
import { deliverLatchedNotice } from './bridge/outbox.js';

export interface NativeSessionOwner {
  userId: string;
  createdByTask: string;
}

export interface ReminderDelivery {
  lastAt?: number;
  retryAt?: number;
  status?: 'sending' | 'sent' | 'uncertain';
}

export interface OwnerReminderCycle extends ReminderDelivery {
  identity: string;
  since: number;
  lastActivityAt: number;
}

export interface LongReminderCycle extends ReminderDelivery {
  identity: string;
}

export interface WecomReminderState {
  sessionLocks?: Record<string, string>;
  sessionOwners?: Record<string, NativeSessionOwner>;
  ownerReminderCycles?: Record<string, OwnerReminderCycle>;
}

export interface ReminderTask {
  streamId: string;
  sessionId?: string;
  triggerId?: string;
  route: string;
  message: WecomInboundMessage;
  delivered?: boolean;
  revoked?: boolean;
  stopRequested?: boolean;
  longReminder?: LongReminderCycle;
  progressGeneration?: number;
}

interface ReminderDeps {
  state: WecomReminderState;
  tasks(): ReminderTask[];
  policy(): WecomMessageConfig;
  allowed(userId: string): boolean;
  current(task: ReminderTask): boolean;
  recipient?(task: ReminderTask): string;
  reminderState?(sessionId: string, triggerId: string): Promise<CoreOnlyReminderState | undefined>;
  send(recipient: string, text: string): Promise<void>;
  sanitize(text: string): string;
  save(): void;
  now(): number;
}

/** Native identity and cycle ledger. No Lark owner identity is synthesized. */
export class WecomReminderController {
  constructor(private readonly deps: ReminderDeps) {}

  /** Called only after the fresh, authenticated task receives its real SID. */
  rememberOwner(task: ReminderTask, fresh: boolean): void {
    if (!fresh || !task.sessionId) {
      return;
    }
    const owners = this.deps.state.sessionOwners ??= {};
    owners[task.sessionId] ??= { userId: task.message.userId, createdByTask: task.streamId };
  }

  /** One latched notice (bridge/outbox.ts) whose record is the cycle itself. */
  private async deliver(cycle: ReminderDelivery, recipient: string, text: string): Promise<void> {
    const prior = cycle.lastAt;
    await deliverLatchedNotice({
      intend: () => {
        cycle.lastAt = this.deps.now();
        cycle.status = 'sending';
        delete cycle.retryAt;
      },
      send: () => this.deps.send(recipient, this.deps.sanitize(text)),
      sent: () => {
        cycle.lastAt = this.deps.now();
        cycle.status = 'sent';
      },
      uncertain: () => {
        cycle.status = 'uncertain';
      },
      failed: retryAt => {
        cycle.lastAt = prior;
        cycle.retryAt = retryAt;
        delete cycle.status;
      },
    }, this.deps);
  }

  async longTask(task: ReminderTask, progress: CoreOnlyProgress): Promise<void> {
    const policy = this.deps.policy().longTaskReminder;
    if (!policy?.enabled
      || (task.sessionId && this.deps.state.sessionLocks?.[task.sessionId] === 'suspended')
      || task.delivered
      || task.revoked
      || task.stopRequested
      || !this.deps.current(task)
      || !this.deps.allowed(task.message.userId)
      || progress.turnId !== task.triggerId
      || progress.workerGeneration !== task.progressGeneration
      || progress.executionStartedAtMs === undefined
      || !Number.isFinite(progress.executionStartedAtMs)
      || progress.executionStartedAtMs < 0
      || progress.executionStartedAtMs > this.deps.now()
      || !progress.workerGeneration) {
      delete task.longReminder;
      return;
    }
    const identity = JSON.stringify([
      progress.turnId,
      progress.workerGeneration,
      progress.dispatchAttempt ?? null,
      progress.executionStartedAtMs,
    ]);
    if (task.longReminder?.identity !== identity) {
      task.longReminder = { identity };
    }
    const cycle = task.longReminder;
    const base = cycle.lastAt ?? progress.executionStartedAtMs;
    const minutes = cycle.lastAt === undefined ? policy.thresholdMinutes : policy.intervalMinutes;
    if (this.deps.now() < (cycle.retryAt ?? 0) || this.deps.now() - base < minutes * 60_000) {
      return;
    }
    // All policy/ACL/route/stop reads occur after the awaited core projection and
    // immediately before synchronous enqueue to the native transport.
    const current = this.deps.policy().longTaskReminder;
    if (!current?.enabled
      || !this.deps.current(task)
      || task.delivered
      || task.revoked
      || task.stopRequested
      || !this.deps.allowed(task.message.userId)) {
      return;
    }
    const dueMinutes = cycle.lastAt === undefined ? current.thresholdMinutes : current.intervalMinutes;
    if (this.deps.now() - base < dueMinutes * 60_000) {
      return;
    }
    await this.deliver(
      cycle,
      this.deps.recipient?.(task) ?? task.message.conversationId,
      `任务已执行 ${Math.floor((this.deps.now() - progress.executionStartedAtMs) / 60_000)} 分钟，仍在运行。`,
    );
  }

  clearLongTask(task: ReminderTask): void {
    delete task.longReminder;
  }

  async owners(): Promise<void> {
    for (const task of this.deps.tasks()) {
      if (task.delivered || task.revoked || task.stopRequested) {
        delete task.longReminder;
      }
    }
    const cycles = this.deps.state.ownerReminderCycles ??= {};
    if (!this.deps.policy().sessionOwnerReminder?.enabled || !this.deps.reminderState) {
      for (const key of Object.keys(cycles)) {
        delete cycles[key];
      }
      this.deps.save();
      return;
    }
    const latest = new Map<string, ReminderTask>();
    for (const task of this.deps.tasks()) {
      if (task.sessionId && task.triggerId) {
        latest.set(task.sessionId, task);
      }
    }
    const seen = new Set<string>();
    for (const [sessionId, task] of latest) {
      const owner = this.deps.state.sessionOwners?.[sessionId];
      if (!owner || task.revoked || !this.deps.current(task) || !this.deps.allowed(owner.userId)) {
        delete cycles[sessionId];
        continue;
      }
      let state: CoreOnlyReminderState | undefined;
      try {
        state = await this.deps.reminderState(sessionId, task.triggerId!);
      } catch {
        continue;
      }
      const policy = this.deps.policy().sessionOwnerReminder;
      if (!policy?.enabled
        || (this.deps.state.sessionLocks?.[sessionId] === 'suspended' && !state?.states.includes('dormant'))
        || !state?.active
        || state.sessionId !== sessionId
        || state.triggerId !== task.triggerId
        || (!state.workerGeneration && !state.states.includes('pending_repo'))
        || task.revoked
        || !this.deps.current(task)
        || !this.deps.allowed(owner.userId)
        || this.deps.state.sessionOwners?.[sessionId]?.userId !== owner.userId
        || !state.states.some(value => policy.states.includes(value))) {
        delete cycles[sessionId];
        continue;
      }
      seen.add(sessionId);
      const identity = JSON.stringify([owner.createdByTask, state.triggerId, state.workerGeneration, state.fingerprint]);
      let cycle = cycles[sessionId];
      if (!cycle || cycle.identity !== identity || state.lastActivityAt > cycle.lastActivityAt) {
        cycles[sessionId] = { identity, since: this.deps.now(), lastActivityAt: state.lastActivityAt };
        this.deps.save();
        continue;
      }
      const base = cycle.lastAt ?? cycle.since;
      if (this.deps.now() < (cycle.retryAt ?? 0) || this.deps.now() - base < policy.intervalMinutes * 60_000) {
        continue;
      }
      // Quiet hours defer delivery only, as on Lark: activity and eligibility are
      // still observed above and the cycle keeps no lastAt, so the first tick after
      // the quiet period sends the reminder if it is still due.
      if (isOwnerReminderQuietTime(policy.quietHours, this.deps.now())) {
        continue;
      }
      // Private native DM to the authenticated creator, never the latest speaker.
      await this.deliver(cycle, owner.userId, `${policy.text}\n等待状态：${state.states.join('、')}`);
    }
    for (const key of Object.keys(cycles)) {
      if (!seen.has(key) && !latest.has(key)) {
        delete cycles[key];
      }
    }
    this.deps.save();
  }
}
