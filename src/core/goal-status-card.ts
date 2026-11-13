import { createHash, randomUUID } from 'node:crypto';
import type { NativeGoalState } from '../services/native-goal-state.js';

export interface GoalStatusCardRecord {
  binding?: string;
  goal: NativeGoalState;
  uuid: string;
  messageId?: string;
  turnId?: string;
  postState: 'prepared' | 'sending' | 'sent' | 'uncertain';
  pendingPatch: boolean;
  sequence?: number;
  /** The stored message can never accept another write (withdrawn, or its
   *  topic is gone). The goal it shows stays frozen there; only a different
   *  goal opens a new card. */
  dead?: boolean;
  /** Identity of the goal the message last displayed (or was posted with, while
   *  the POST is unconfirmed). A goal the message never showed is not frozen
   *  with it when the message turns out dead or its POST unconfirmed. */
  shownGoal?: GoalIdentity;
}

type GoalIdentity = Pick<NativeGoalState, 'goalId' | 'createdAt'>;

/** Retry delay after consecutive failed PATCHes doubles from the 2 s tick up to
 *  5 minutes. The Lark gate already retries rate limits inside each call; what
 *  fails here is an outage (minutes) or a message that can no longer be written
 *  (e.g. past its edit window). Never giving up lets a pending completion land
 *  after an outage; the cap keeps a permanently broken card at ~12 calls/hour. */
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60_000;

/** The same native goal across objective edits and status changes. */
function sameGoalIdentity(a: GoalIdentity, b: GoalIdentity): boolean {
  return a.goalId && b.goalId ? a.goalId === b.goalId : a.createdAt === b.createdAt;
}

function goalIdentity(goal: NativeGoalState): GoalIdentity {
  return goal.goalId ? { goalId: goal.goalId, createdAt: goal.createdAt } : { createdAt: goal.createdAt };
}

function sameGoalState(a: NativeGoalState, b: NativeGoalState): boolean {
  return a.goalId === b.goalId && a.objective === b.objective && a.status === b.status
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.timeUsedSeconds === b.timeUsedSeconds;
}

export interface GoalStatusCardOrigin {
  key: string;
  binding: string;
  createdAt?: number;
  goalId?: string;
  turnId?: string;
  dispatchAttempt?: number;
  hidden: boolean;
}

export function goalStatusCardOrigin(previous: GoalStatusCardOrigin | undefined, goal: NativeGoalState,
  input: Omit<GoalStatusCardOrigin, 'key' | 'goalId'>): GoalStatusCardOrigin {
  const key = createHash('sha256').update(`${goal.createdAt}\0${goal.objective}`).digest('hex');
  const sameGoal = !!previous && (goal.goalId && previous.goalId
    ? goal.goalId === previous.goalId
    : previous.createdAt === goal.createdAt || previous.key === key);
  if (!sameGoal || previous!.binding !== input.binding) {
    return { ...input, key, createdAt: goal.createdAt, goalId: goal.goalId,
      hidden: input.hidden || sameGoal && previous?.hidden === true };
  }
  // Goal IDs retain their birth visibility through edits. A suppressed edit
  // may make a public goal hidden, but a normal edit cannot expose a hidden goal.
  return { ...previous!, key, createdAt: goal.createdAt, goalId: previous!.goalId ?? goal.goalId,
    hidden: previous!.hidden || input.hidden && previous!.key !== key };
}

export function goalElapsedSeconds(goal: NativeGoalState): number {
  return Math.floor(goal.timeUsedSeconds);
}

export function buildGoalStatusCard(goal: NativeGoalState, now = Date.now(), locale: 'zh' | 'en' = 'zh'): string {
  const completed = goal.status === 'complete';
  const labels = locale === 'en'
    ? { active: 'Goal in progress', complete: 'Goal completed', paused: 'Goal paused', blocked: 'Goal blocked', cleared: 'Goal cleared',
      usage_limited: 'Goal hit usage limits', budget_limited: 'Goal budget used up' }
    : { active: '目标进行中', complete: '目标已完成', paused: '目标已暂停', blocked: '目标受阻', cleared: '目标已清除',
      usage_limited: '目标已达用量上限', budget_limited: '目标预算已用完' };
  const seconds = goalElapsedSeconds(goal);
  const elapsed = `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const objective = Array.from(goal.objective.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim());
  const title = `${objective.slice(0, 40).join('')}${objective.length > 40 ? '…' : ''} — `
    + (labels[goal.status as keyof typeof labels] ?? (locale === 'en' ? 'Goal stopped' : '目标已停止'))
    + (goal.status === 'active' ? ` ${'·'.repeat(Math.floor(now / 2000) % 3 + 1)}` : '');
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title },
      template: completed ? 'green' : goal.status === 'active' ? 'blue' : 'orange' },
    body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: goal.objective.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4000) } },
      { tag: 'markdown', element_id: 'goal_elapsed', content: `${locale === 'en' ? 'Elapsed' : '已运行'}：${elapsed}` },
    ] } });
}

export interface GoalStatusCardDeps {
  binding?: string;
  read(): GoalStatusCardRecord | undefined;
  save(record: GoalStatusCardRecord): void;
  post(card: string, uuid: string, turnId?: string): Promise<string>;
  patch(messageId: string, card: string, sequence: number, uuid: string): Promise<unknown>;
  owns(): boolean;
  canDisplay?(): boolean;
  /** Errors that prove the message can never be written again (withdrawn,
   *  topic gone). The card is left as it is instead of retried or reposted. */
  isTerminalError?(error: unknown): boolean;
  warn(error: unknown): void;
  locale?: 'zh' | 'en';
  now?: () => number;
}

const cardWrites = new Map<string, Promise<void>>();

/** One persistent card per conversation; goal transitions PATCH the same message. */
export class GoalStatusCardController {
  private tail: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private rendered?: string;
  private failures = 0;
  private retryAt = 0;
  constructor(private deps: GoalStatusCardDeps) {
    const previous = deps.read();
    if (previous && deps.binding && previous.binding !== deps.binding) {
      deps.save({ goal: previous.goal, binding: deps.binding, uuid: randomUUID(), postState: 'prepared', pendingPatch: true });
    } else if (previous?.postState === 'sending' && !previous.messageId && !cardWrites.has(previous.uuid)) {
      deps.save({ ...previous, postState: 'uncertain' });
    }
  }

  update(goal: NativeGoalState | null, turnId?: string): void {
    if (!this.deps.owns() || this.deps.canDisplay?.() === false) return;
    const previous = this.deps.read();
    const now = this.deps.now?.() ?? Date.now();
    if (!goal) {
      // A replacement worker re-reports the same clear; the card already shows it.
      if (!previous || previous.goal.status === 'cleared' && !previous.pendingPatch) return;
      goal = { ...previous.goal, status: 'cleared', updatedAt: now / 1000,
        timeUsedSeconds: goalElapsedSeconds(previous.goal) };
    }
    if (previous && (goal.createdAt < previous.goal.createdAt
      || goal.createdAt === previous.goal.createdAt && goal.updatedAt < previous.goal.updatedAt
      || goal.createdAt === previous.goal.createdAt && goal.objective === previous.goal.objective
        && previous.goal.status === 'complete' && goal.status !== 'complete' && goal.updatedAt <= previous.goal.updatedAt)) return;
    // A replacement worker re-reports the goal it last saw. A settled card
    // already shows it, and re-PATCHing an old message can only fail.
    if (previous?.messageId && !previous.pendingPatch && goal.status !== 'active' && sameGoalState(goal, previous.goal)) return;
    this.failures = 0; this.retryAt = 0;
    const sameGoal = !!previous && sameGoalIdentity(goal, previous.goal);
    if (previous && (previous.dead || !previous.messageId && previous.postState === 'uncertain')) {
      // A dead card keeps the goal it last showed; reposting it would undo a
      // deliberate recall, and an unconfirmed POST may already exist. A
      // different goal is new content and gets its own card.
      if (sameGoalIdentity(goal, previous.shownGoal ?? previous.goal)) { this.deps.save({ ...previous, goal }); return; }
      this.deps.save({ goal, binding: this.deps.binding, uuid: randomUUID(), turnId, postState: 'prepared', pendingPatch: true });
    } else {
      this.deps.save({ ...previous, goal, binding: this.deps.binding, uuid: previous?.uuid ?? randomUUID(),
        turnId: sameGoal ? previous!.turnId ?? turnId : turnId ?? previous?.turnId,
        postState: previous?.postState ?? 'prepared', pendingPatch: true });
    }
    this.refresh();
  }

  refresh(): void {
    const uuid = this.deps.read()?.uuid;
    if (!uuid) return;
    const write = (cardWrites.get(uuid) ?? Promise.resolve()).catch(() => {}).then(() => this.flush());
    cardWrites.set(uuid, write);
    this.tail = write.catch(error => this.deps.warn(error)).finally(() => {
      if (cardWrites.get(uuid) === write) cardWrites.delete(uuid);
    });
    this.arm();
  }
  async settled(): Promise<void> { await this.tail; }
  get isDisposed(): boolean { return this.disposed; }
  suspend(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private arm(): void {
    if (this.disposed) return;
    const state = this.deps.read();
    if (!this.deps.owns() || this.deps.canDisplay?.() === false || !state || state.dead
      || !state.messageId && state.postState === 'uncertain'
      || state.goal.status !== 'active' && !state.pendingPatch) {
      if (this.timer) clearInterval(this.timer); this.timer = undefined; return;
    }
    if (!this.timer) { this.timer = setInterval(() => this.refresh(), 2000); this.timer.unref?.(); }
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.deps.owns()) { this.dispose(); return; }
    if (this.deps.canDisplay?.() === false) { this.suspend(); return; }
    let state = this.deps.read();
    if (!state) return;
    if (state.dead || state.messageId && state.goal.status !== 'active' && !state.pendingPatch) { this.arm(); return; }
    if (!state.messageId) {
      // A restart or unknown POST result must never create a second card.
      if (state.postState !== 'prepared') { this.arm(); return; }
      this.deps.save({ ...state, postState: 'sending', shownGoal: goalIdentity(state.goal) });
      let messageId: string;
      try { messageId = await this.deps.post(buildGoalStatusCard(state.goal, this.deps.now?.(), this.deps.locale), state.uuid, state.turnId); }
      catch (error) {
        const latest = this.deps.read();
        if (latest?.uuid === state.uuid) this.deps.save({ ...latest, postState: 'uncertain' });
        this.deps.warn(error); this.arm(); return;
      }
      const latest = this.deps.read();
      if (!latest || latest.uuid !== state.uuid) return;
      if (!messageId.startsWith('om_')) throw new Error('goal card post returned no real message ID');
      this.deps.save({ ...latest, messageId, postState: 'sent' });
      state = this.deps.read()!;
    }
    if (!this.deps.owns()) { this.dispose(); return; }
    if (this.deps.canDisplay?.() === false) { this.suspend(); return; }
    const card = buildGoalStatusCard(state.goal, this.deps.now?.(), this.deps.locale);
    if (card === this.rendered) {
      if (state.pendingPatch) this.deps.save({ ...state, pendingPatch: false });
      this.arm(); return;
    }
    if ((this.deps.now?.() ?? Date.now()) < this.retryAt) { this.arm(); return; }
    const sequence = (state.sequence ?? 0) + 1;
    const sentState = { ...state, sequence };
    this.deps.save(sentState);
    try {
      await this.deps.patch(state.messageId!, card, sequence, `${state.uuid}-${sequence}`);
      this.rendered = card;
      this.failures = 0;
      const latest = this.deps.read();
      // A newer change that arrived meanwhile stays pending, but this goal is now on the card.
      if (latest?.uuid === state.uuid) {
        this.deps.save({ ...latest, shownGoal: goalIdentity(state.goal), ...(latest === sentState ? { pendingPatch: false } : {}) });
      }
    } catch (error) {
      this.deps.warn(error);
      const latest = this.deps.read();
      if (latest?.uuid === state.uuid) {
        if (this.deps.isTerminalError?.(error)) {
          if (latest.shownGoal && !sameGoalIdentity(latest.goal, latest.shownGoal)) {
            // The dead message never showed this goal: give it its own card.
            this.deps.save({ goal: latest.goal, binding: latest.binding, uuid: randomUUID(), turnId: latest.turnId,
              postState: 'prepared', pendingPatch: true });
          } else this.deps.save({ ...latest, dead: true, pendingPatch: false });
        } else {
          // Keep pendingPatch so a completion still lands after an outage.
          this.failures++;
          this.retryAt = (this.deps.now?.() ?? Date.now()) + Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
        }
      }
    }
    this.arm();
  }
}
