/**
 * One shared-backend outage, handled once.
 *
 * Every managed tmux session of every bot lives on ONE tmux server
 * (`-L botmux`). When that server dies (2026-11-19: tmux 3.3a SIGSEGV on a
 * paste into a dead pane, see tmux-pipe-backend.ts), every pane on it is gone
 * at once. Each worker used to report that as its own CLI crash, so 104
 * sessions each ran the per-session crash-loop policy: they all restarted at
 * the same moment into a server that was still crashing, failed 345 times in
 * total, and dozens of chats each received "⚠️ Codex 在 1 分钟内崩溃 4 次，已停
 * 止自动重启" (plus start-failure / interruption notices) within two minutes.
 *
 * The worker now tells a server loss apart from a CLI exit
 * (`claude_exit.backendLost`). This coordinator turns all such exits of one
 * server into ONE episode:
 *  - none of them counts toward the per-session crash loop, and no crash-loop
 *    notice is posted for them;
 *  - after a short gather window the server is probed; if it is not back, ONE
 *    session (the canary) is restarted to bring it back, with backoff between
 *    tries; only once the server answers are the other sessions restarted, a
 *    few at a time;
 *  - every affected topic gets at most ONE status card, patched in place:
 *    interrupted → recovering → recovered / recovery failed. Start-failure,
 *    restart-interruption and resume-fallback notices of a member are folded
 *    into that card instead of being posted separately;
 *  - when the episode has settled the bot owner gets ONE summary.
 *
 * Everything with side effects (timers, restarts, IM, tmux) is injected, so
 * the whole state machine runs under a fake clock in unit tests.
 */

/** What restart a member is in (mirrors RestartObserverStatus terminals). */
export type RecoveryRestartStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export type OutageMemberState =
  /** Lost with the server; waiting for the server / its turn to restart. */
  | 'interrupted'
  /** A recovery restart is in flight. */
  | 'recovering'
  | 'recovered'
  | 'failed'
  /** Dropped without a result: the session was closed / replaced meanwhile. */
  | 'stopped'
  /** Deliberately put to sleep meanwhile (idle reclaim, terminal service
   *  switch, crash-diagnostic park): left cold for the user's next message,
   *  never restarted by the outage. */
  | 'dormant';

export type OutageFailureReason =
  /** The server did not come back within the backoff budget. */
  | 'server_unavailable'
  /** The server is back, but this session's CLI failed to restart. */
  | 'cli_failed'
  /** This session lost its server too often in a short window. */
  | 'repeated'
  /** The CLI did not reach its prompt within the restart deadline. */
  | 'timed_out'
  /** The session could not be restarted (transferring, closed, …). */
  | 'restart_refused';

export type ServerLossKind = 'replaced' | 'gone' | 'unreachable';

/** Everything the card renderer needs for one topic. */
export interface OutageCardView {
  state: OutageMemberState;
  cliName: string;
  /** Human label of the lost server, e.g. `botmux`. */
  serverLabel: string;
  /** A turn was running in this topic when the server was lost. */
  turnInFlight: boolean;
  /** Failed server recoveries so far (shown while waiting for a retry). */
  serverRetries: number;
  failure?: OutageFailureReason;
  /** Short evidence for a CLI-level failure (exit code / last output). */
  failureDetail?: string;
  /** Notices of this session folded into the card, oldest first. */
  notices: string[];
}

export interface OutageSummaryMember {
  sessionId: string;
  title: string;
  state: OutageMemberState;
  failure?: OutageFailureReason;
  turnInFlight: boolean;
}

export interface OutageSummary {
  larkAppId: string;
  serverLabel: string;
  startedAt: number;
  endedAt: number;
  /** Failed server recoveries during the episode (0 = back on the first try). */
  serverRetries: number;
  members: OutageSummaryMember[];
}

/** Facts about one session at the moment it lost its server. */
export interface ServerLossReport {
  larkAppId: string;
  /** Socket name of the lost server (`undefined` = tmux default socket). */
  socketName?: string;
  kind: ServerLossKind;
  cliName: string;
  title: string;
  turnInFlight: boolean;
  /** The worker can keep a diagnostic shell if recovery gives up. */
  canPark: boolean;
  /** No IM transport for this session's auxiliary UI (silent / apiOnly). */
  silent: boolean;
}

/** Whether a member may be restarted right now: `later` = not now, ask again
 *  (e.g. a relay is in progress); `never` = closed or replaced, drop it;
 *  `dormant` = deliberately suspended cold, leave it for the user's next
 *  message (restarting it would undo the suspension). */
export type RecoveryEligibility = 'now' | 'later' | 'never' | 'dormant';

/** Whether a member may be restarted, from the daemon's facts about it. A
 *  relay in progress may still fail and leave the session where it was, so
 *  it is asked again later rather than dropped. */
export function recoveryEligibility(facts: {
  /** The session row is still active (not closed). */
  active: boolean;
  /** It is still the registered owner of its topic (not replaced). */
  current: boolean;
  /** A relay / transfer of the session is in progress. */
  transferring: boolean;
  /** The session was deliberately suspended cold (its next message resumes
   *  it from history). */
  dormant: boolean;
}): RecoveryEligibility {
  if (!facts.active || !facts.current) return 'never';
  if (facts.dormant) return 'dormant';
  return facts.transferring ? 'later' : 'now';
}

export interface BackendOutageDeps<S> {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Start one recovery restart of `ref`. `onSettled` fires once with the
   *  outcome. Returns false when no restart could be started at all. */
  restart(ref: S, onSettled: (status: RecoveryRestartStatus) => void): boolean;
  /** Whether a server answers on the socket right now. Must not start one. */
  serverUp(socketName: string | undefined): Promise<boolean>;
  eligible(ref: S): RecoveryEligibility;
  /** A cancelled recovery restart is owned by an external replacement
   *  generation (cold refork / transfer / another correlated restart). While
   *  this is true the coordinator waits for its prompt instead of restarting
   *  it again. The wait is bounded by externalRecoveryGraceMs. */
  externalRecoveryInFlight?(ref: S): boolean;
  /** Stop automatic restarts for a member that will not be recovered; the
   *  next user message starts it again (same contract as the crash loop).
   *  `keepTerminal`: also keep a diagnostic shell with the last output — only
   *  when the CLI itself failed on a working server. */
  giveUp(ref: S, opts: { keepTerminal: boolean }): void;
  render(ref: S, view: OutageCardView): string;
  /** Post the card. `uuid` is stable for one card, so a post retried after
   *  an ambiguous failure cannot create a second message. */
  post(ref: S, cardJson: string, uuid: string): Promise<string | undefined>;
  patch(ref: S, messageId: string, cardJson: string): Promise<void>;
  /** Whether a patch error means the card can never be patched again. */
  patchIsFinal?(err: unknown): boolean;
  summarize(summary: OutageSummary): void | Promise<void>;
  log(line: string): void;
}

export interface BackendOutageTimings {
  /** First losses → first recovery action: lets the first wave of workers
   *  report, and keeps a server that is crash-looping from being hit at once. */
  gatherMs: number;
  /** Extra gather time, a stable per-bot value in [0, gatherJitterMs): every
   *  bot daemon on the machine runs its own coordinator, and they should not
   *  all send a canary at the same instant. The first one brings the server
   *  back; the later ones find it up and skip their canary. */
  gatherJitterMs: number;
  /** Waits before each further server recovery try. Its length is the budget. */
  serverBackoffMs: readonly number[];
  /** While a canary restart runs, how often the server is asked whether it is
   *  back (the canary's CLI may need much longer to reach its prompt). */
  canaryServerPollMs: number;
  /** Member restarts in flight at once while the server is up. */
  maxConcurrentRestarts: number;
  /** Restart attempts per member once the server is up. */
  memberMaxAttempts: number;
  /** A member that cannot be restarted right now is asked again after this. */
  deferRecheckMs: number;
  /** A cancelled recovery restart defers to its external replacement for at
   *  most this long; if no prompt arrives, the coordinator retries itself. */
  externalRecoveryGraceMs: number;
  /** A session losing its server more than `maxLossesPerWindow` times within
   *  `lossWindowMs` stops being recovered (bounded like the crash loop). */
  lossWindowMs: number;
  maxLossesPerWindow: number;
  /** Quiet time after the last member settled before the owner summary. */
  summarySettleMs: number;
  /** A restart that only timed out may still reach its prompt: the summary
   *  waits this long after the timeout for it. */
  timedOutGraceMs: number;
  /** Retries of a card post/patch that failed transiently. */
  cardRetryDelaysMs: readonly number[];
  /** A topic's card is reused (patched) by a later episode within this time. */
  cardReuseMs: number;
}

export const DEFAULT_BACKEND_OUTAGE_TIMINGS: BackendOutageTimings = {
  gatherMs: 3_000,
  gatherJitterMs: 7_000,
  serverBackoffMs: [5_000, 15_000, 30_000, 60_000],
  canaryServerPollMs: 2_000,
  maxConcurrentRestarts: 4,
  memberMaxAttempts: 2,
  deferRecheckMs: 5_000,
  externalRecoveryGraceMs: 45_000,
  lossWindowMs: 10 * 60_000,
  maxLossesPerWindow: 3,
  summarySettleMs: 60_000,
  timedOutGraceMs: 120_000,
  cardRetryDelaysMs: [2_000, 5_000, 15_000],
  cardReuseMs: 10 * 60_000,
};

let cardSerial = 0;

/** One topic's status card: posted once, then patched in place. Updates are
 *  serialized and coalesced, so the card always ends on the latest view even
 *  when several updates race a slow post; a transient failure is retried a
 *  few times so the last state is not lost. */
class LiveCard<S> {
  private messageId: string | undefined;
  private version = 0;
  private flushedVersion = 0;
  private retries = 0;
  private retryTimer: unknown;
  private chain: Promise<void> = Promise.resolve();
  /** One uuid per card we mean to post; a replacement card gets a new one. */
  private uuid: string;
  private view: () => OutageCardView = () => { throw new Error('no view'); };
  private ref!: S;
  lastUpdatedAt = 0;

  constructor(private readonly deps: BackendOutageDeps<S>, private readonly timings: BackendOutageTimings, private readonly sessionId: string) {
    this.uuid = this.newUuid();
  }

  update(ref: S, view: () => OutageCardView, now: number): void {
    this.ref = ref;
    this.view = view;
    this.version += 1;
    this.retries = 0;
    this.lastUpdatedAt = now;
    this.enqueue();
  }

  /** Resolves once every update requested so far has been attempted (tests). */
  settled(): Promise<void> {
    return this.chain;
  }

  private newUuid(): string {
    cardSerial += 1;
    return `bmx-outage-${this.sessionId.slice(0, 8)}-${Date.now().toString(36)}-${cardSerial}`;
  }

  private enqueue(): void {
    this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
  }

  private retryLater(): void {
    const delay = this.timings.cardRetryDelaysMs[this.retries];
    if (delay === undefined || this.retryTimer !== undefined) return;
    this.retries += 1;
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = undefined;
      this.enqueue();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushedVersion === this.version) return;
    const target = this.version;
    const json = this.deps.render(this.ref, this.view());
    if (this.messageId) {
      try {
        await this.deps.patch(this.ref, this.messageId, json);
        this.flushedVersion = target;
        return;
      } catch (err) {
        this.deps.log(`outage card patch failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!this.deps.patchIsFinal?.(err)) {
          this.retryLater();
          return;
        }
        // Withdrawn / past its edit window: the outcome still has to be seen.
        this.messageId = undefined;
        this.uuid = this.newUuid();
      }
    }
    try {
      this.messageId = await this.deps.post(this.ref, json, this.uuid);
      if (this.messageId) this.flushedVersion = target;
      else this.retryLater();
    } catch (err) {
      this.deps.log(`outage card post failed: ${err instanceof Error ? err.message : String(err)}`);
      this.retryLater();
    }
  }
}

interface Member<S> {
  sessionId: string;
  ref: S;
  report: ServerLossReport;
  state: OutageMemberState;
  /** Restart attempts that ran while the server was up. */
  attempts: number;
  /** Bumped by every restart start / re-loss / settle; a callback carrying an
   *  older token is stale. */
  token: number;
  failure?: OutageFailureReason;
  failureDetail?: string;
  notices: string[];
  /** This member is the canary of the current server try. */
  canary: boolean;
  /** How often it has been the canary (the canary rotates). */
  canaryCount: number;
  /** A recovery restart was started and has not reported its outcome yet. */
  restartPending: boolean;
  /** The restart outcome arrived, but its server probe is still settling.
   *  A canary in this state must not let poll-driven progress choose another
   *  canary before the first outcome has been classified. */
  settling: boolean;
  /** A cancelled restart is owned by an external replacement until this
   *  deadline (or until its lifecycle finishes / reports a prompt). */
  externalRecoveryUntil?: number;
  /** When its restart timed out (summary grace). */
  timedOutAt?: number;
}

type EpisodePhase =
  /** A timer will (re)assess the server. */
  | 'waiting'
  /** Server presumed down; one canary restart is bringing it back. */
  | 'canary'
  /** Server answers; members are restarted a few at a time. */
  | 'up'
  /** Server recovery budget exhausted. */
  | 'failed';

interface Episode<S> {
  key: string;
  larkAppId: string;
  socketName: string | undefined;
  startedAt: number;
  phase: EpisodePhase;
  serverRetries: number;
  members: Map<string, Member<S>>;
  /** Next assessment of the server (gather, backoff, deferred recheck). */
  timer?: unknown;
  /** Server poll while a canary runs. */
  pollTimer?: unknown;
  summaryTimer?: unknown;
  /** Bumped on every phase decision; async probes from an older one are stale. */
  generation: number;
  /** One late down observation is being checked against the CURRENT server. */
  downProbe?: { generation: number };
}

export class BackendOutageCoordinator<S> {
  private readonly episodes = new Map<string, Episode<S>>();
  /** sessionId → episode key, for members of a live episode. */
  private readonly membership = new Map<string, string>();
  private readonly cards = new Map<string, LiveCard<S>>();
  private readonly lossHistory = new Map<string, number[]>();
  private readonly timings: BackendOutageTimings;

  constructor(private readonly deps: BackendOutageDeps<S>, timings: Partial<BackendOutageTimings> = {}) {
    this.timings = { ...DEFAULT_BACKEND_OUTAGE_TIMINGS, ...timings };
  }

  /** A session's CLI exit was its server being lost. Always absorbed: the
   *  caller must not run its crash-loop accounting or post exit notices. */
  onServerLost(ref: S, sessionId: string, report: ServerLossReport): void {
    const now = this.deps.now();
    const key = episodeKey(report.larkAppId, report.socketName);
    let episode = this.episodes.get(key);
    if (!episode) {
      episode = {
        key,
        larkAppId: report.larkAppId,
        socketName: report.socketName,
        startedAt: now,
        phase: 'waiting',
        serverRetries: 0,
        members: new Map(),
        generation: 0,
      };
      this.episodes.set(key, episode);
      this.deps.log(`backend outage opened: tmux ${serverLabel(report.socketName)} (${report.kind}) for ${report.larkAppId}`);
      this.schedule(episode, this.timings.gatherMs + stableJitter(report.larkAppId, this.timings.gatherJitterMs));
    }
    this.cancelSummary(episode);

    const history = (this.lossHistory.get(sessionId) ?? []).filter(at => now - at < this.timings.lossWindowMs);
    history.push(now);
    this.lossHistory.set(sessionId, history);

    let member = episode.members.get(sessionId);
    if (member) {
      member.ref = ref;
      member.report = { ...report, turnInFlight: member.report.turnInFlight || report.turnInFlight };
      member.token += 1;
      member.restartPending = false;
      member.settling = false;
      member.canary = false;
      member.externalRecoveryUntil = undefined;
      member.state = 'interrupted';
      member.failure = undefined;
      member.failureDetail = undefined;
      member.timedOutAt = undefined;
    } else {
      member = {
        sessionId, ref, report, state: 'interrupted', attempts: 0, token: 0, notices: [],
        canary: false, canaryCount: 0, restartPending: false, settling: false,
      };
      episode.members.set(sessionId, member);
      this.membership.set(sessionId, key);
    }
    this.deps.log(`session ${sessionId.slice(0, 8)} lost tmux ${serverLabel(report.socketName)} (${report.kind}); ${episode.members.size} session(s) in this outage`);

    if (history.length > this.timings.maxLossesPerWindow) {
      // Bounded like the crash loop: a session that keeps losing its server is
      // not restarted forever. One card says so; the next user message tries
      // again. The OUTAGE goes on for everyone else.
      this.fail(member, 'repeated');
    } else {
      this.renderCard(member);
    }

    // The report says what the server looked like when this pane was found
    // gone: `replaced` = a server answers again; `gone` / `unreachable` is a
    // HISTORICAL observation that may reach us after another member already
    // restored the server. Confirm the current state before starting another
    // down/backoff period; generation fences the answer against newer events.
    if ((episode.phase === 'up' || episode.phase === 'canary') && report.kind !== 'replaced') {
      this.confirmServerDown(episode);
    } else if (episode.phase === 'failed' && episode.timer === undefined) {
      // Budget spent, but give a late member one look at the server.
      this.schedule(episode, 0);
    }
    this.progress(episode);
  }

  /** An ordinary (not server-loss) CLI exit. True when the session is a member
   *  still being recovered: the outage owns it, so the caller must neither
   *  count it as a crash nor post a notice. The restart outcome reaches the
   *  coordinator through the restart observer. */
  onCliExit(sessionId: string, detail: { code: number | null; logTail?: string; canPark?: boolean }): boolean {
    const member = this.liveMember(sessionId);
    if (!member || (member.state !== 'interrupted' && member.state !== 'recovering')) return false;
    member.failureDetail = cliExitDetail(detail.code, detail.logTail);
    if (detail.canPark !== undefined) member.report = { ...member.report, canPark: detail.canPark };
    return true;
  }

  /** A start failure of a member still being recovered: absorbed (kept as the
   *  card's failure detail) instead of posted as its own notice. */
  onStartupFailure(sessionId: string, reason: string): boolean {
    const member = this.liveMember(sessionId);
    if (!member || (member.state !== 'interrupted' && member.state !== 'recovering')) return false;
    member.failureDetail = firstLines(reason, 6);
    return true;
  }

  /** Fold a notice for a session of a live episode into its card. */
  absorbNotice(sessionId: string, text: string): boolean {
    const member = this.liveMember(sessionId);
    if (!member || member.report.silent) return false;
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (!member.notices.includes(trimmed)) member.notices.push(trimmed);
    this.renderCard(member);
    return true;
  }

  /** The session's CLI reached its prompt: whoever started it (our restart, a
   *  user's /restart, a message after a give-up or after a dormant member was
   *  resumed, a late timed-out start), the session is back and must not be
   *  restarted again by the outage. */
  onPromptReady(sessionId: string): void {
    const member = this.liveMember(sessionId);
    if (!member || member.state === 'recovered' || member.state === 'stopped') return;
    const episode = this.episodes.get(this.membership.get(sessionId)!)!;
    this.markRecovered(episode, member);
  }

  /** Test seam: wait until every card update requested so far was attempted. */
  async cardsSettled(): Promise<void> {
    await Promise.all([...this.cards.values()].map(card => card.settled()));
  }

  /** Test seam: drop every episode and timer. */
  reset(): void {
    for (const episode of this.episodes.values()) this.clearTimers(episode);
    this.episodes.clear();
    this.membership.clear();
    this.cards.clear();
    this.lossHistory.clear();
  }

  // ─── episode state machine ───────────────────────────────────────────────

  private liveMember(sessionId: string): Member<S> | undefined {
    const key = this.membership.get(sessionId);
    return key ? this.episodes.get(key)?.members.get(sessionId) : undefined;
  }

  private clearTimers(episode: Episode<S>): void {
    for (const handle of [episode.timer, episode.pollTimer, episode.summaryTimer]) {
      if (handle !== undefined) this.deps.clearTimeout(handle);
    }
    episode.timer = undefined;
    episode.pollTimer = undefined;
    episode.summaryTimer = undefined;
  }

  private stopPolling(episode: Episode<S>): void {
    if (episode.pollTimer === undefined) return;
    this.deps.clearTimeout(episode.pollTimer);
    episode.pollTimer = undefined;
  }

  /** Re-assess the server after `delayMs` (keeps a spent budget spent). */
  private schedule(episode: Episode<S>, delayMs: number): void {
    if (episode.timer !== undefined) this.deps.clearTimeout(episode.timer);
    this.stopPolling(episode);
    if (episode.phase !== 'failed') episode.phase = 'waiting';
    episode.generation += 1;
    episode.timer = this.deps.setTimeout(() => {
      episode.timer = undefined;
      void this.assess(episode);
    }, delayMs);
  }

  /**
   * The one place that makes sure an episode never stalls: whatever just
   * happened, if members still wait for a restart, something is scheduled to
   * restart them, or the budget is spent and they are failed.
   */
  private progress(episode: Episode<S>): void {
    if (this.episodes.get(episode.key) !== episode) return;
    if (episode.downProbe) return; // wait for the current-server confirmation
    if (episode.timer !== undefined) return; // an assessment is due anyway
    if (episode.phase === 'failed') {
      for (const member of episode.members.values()) {
        if (member.state === 'interrupted' && !this.dropIfIneligible(member)) this.fail(member, 'server_unavailable');
      }
    } else if (episode.phase === 'canary') {
      // The canary itself may have been lost, failed or recovered elsewhere.
      if (![...episode.members.values()].some(m => m.canary && (m.restartPending || m.settling))) {
        this.schedule(episode, 0);
        return;
      }
      this.pollServer(episode);
    } else if (episode.phase === 'up') {
      this.pump(episode);
    }
    this.maybeSettle(episode);
  }

  /** Decide, from the server's own answer, whether to drain or send a canary. */
  private async assess(episode: Episode<S>): Promise<void> {
    if (this.episodes.get(episode.key) !== episode) return;
    const generation = ++episode.generation;
    const exhausted = episode.phase === 'failed';
    const up = await this.serverUp(episode);
    if (this.episodes.get(episode.key) !== episode || episode.generation !== generation || episode.timer !== undefined) return;
    if (up) {
      episode.phase = 'up';
      episode.generation += 1; // invalidate settlements based on an older server state
    } else if (!exhausted) {
      this.startCanary(episode);
      return;
    }
    this.progress(episode);
  }

  /** Bring the server back through ONE session; the rest wait for its answer.
   *  The canary rotates, so one session that cannot start never blocks the
   *  recovery of the others. */
  private startCanary(episode: Episode<S>): void {
    for (;;) {
      let candidate: Member<S> | undefined;
      let deferred = false;
      for (const member of episode.members.values()) {
        if (member.state !== 'interrupted') continue;
        const eligibility = this.deps.eligible(member.ref);
        if (this.dropIfIneligible(member, eligibility)) continue;
        if (eligibility === 'later') {
          deferred = true;
          continue;
        }
        if (this.waitsForExternalRecovery(member)) {
          deferred = true;
          continue;
        }
        if (!candidate || member.canaryCount < candidate.canaryCount) candidate = member;
      }
      if (!candidate) {
        if (deferred) {
          this.schedule(episode, this.timings.deferRecheckMs);
          return;
        }
        // Nobody left to bring the server back with.
        episode.phase = 'up';
        this.progress(episode);
        return;
      }
      episode.phase = 'canary';
      candidate.canary = true;
      candidate.canaryCount += 1;
      // A canary that only fails because the server is still down does not
      // spend its own attempt budget (see onRestartSettled).
      if (this.startRestart(candidate)) {
        this.pollServer(episode);
        return;
      }
    }
  }

  /** While the canary runs, ask the server whether it is back: the others can
   *  start as soon as it is, without waiting for the canary's CLI. */
  private pollServer(episode: Episode<S>): void {
    if (episode.phase !== 'canary' || episode.pollTimer !== undefined || episode.downProbe) return;
    const generation = episode.generation;
    episode.pollTimer = this.deps.setTimeout(() => {
      episode.pollTimer = undefined;
      void (async () => {
        if (this.episodes.get(episode.key) !== episode || episode.phase !== 'canary' || episode.generation !== generation) return;
        const up = await this.serverUp(episode);
        if (this.episodes.get(episode.key) !== episode || episode.phase !== 'canary' || episode.generation !== generation) return;
        if (up) {
          this.deps.log(`tmux ${serverLabel(episode.socketName)} answers again; restarting the remaining sessions`);
          episode.phase = 'up';
          episode.generation += 1; // a newer decision than any pending settlement
          this.stopPolling(episode);
        }
        this.progress(episode);
      })();
    }, this.timings.canaryServerPollMs);
  }

  /** Restart waiting members while the server is up, a few at a time. */
  private pump(episode: Episode<S>): void {
    if (episode.phase !== 'up') return;
    let deferred = false;
    for (const member of episode.members.values()) {
      if (inFlight(episode) >= this.timings.maxConcurrentRestarts) break;
      if (member.state !== 'interrupted') continue;
      const eligibility = this.deps.eligible(member.ref);
      if (this.dropIfIneligible(member, eligibility)) continue;
      if (eligibility === 'later') {
        deferred = true;
        continue;
      }
      if (this.waitsForExternalRecovery(member)) {
        deferred = true;
        continue;
      }
      this.startRestart(member);
    }
    // Only deferred members are left and nothing will settle to wake us up.
    if (deferred && inFlight(episode) === 0) this.schedule(episode, this.timings.deferRecheckMs);
  }

  private startRestart(member: Member<S>): boolean {
    member.state = 'recovering';
    member.attempts += 1;
    member.restartPending = true;
    member.settling = false;
    member.externalRecoveryUntil = undefined;
    member.failure = undefined;
    const token = ++member.token;
    this.renderCard(member);
    let started = false;
    try {
      started = this.deps.restart(member.ref, status => {
        void this.onRestartSettled(member, token, status);
      });
    } catch (err) {
      this.deps.log(`recovery restart of ${member.sessionId.slice(0, 8)} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!started && member.token === token && member.state === 'recovering') {
      member.canary = false;
      this.fail(member, 'restart_refused');
      return false;
    }
    return started;
  }

  private async onRestartSettled(member: Member<S>, token: number, status: RecoveryRestartStatus): Promise<void> {
    if (member.token !== token || member.state !== 'recovering' || !member.restartPending) return;
    const episode = this.episodes.get(this.membership.get(member.sessionId) ?? '');
    if (!episode || episode.members.get(member.sessionId) !== member) return;
    const generation = episode.generation;
    const wasCanary = member.canary;
    member.restartPending = false;
    member.settling = true;

    if (status === 'cancelled') {
      // Cancellation transfers ownership to another lifecycle generation. Do
      // not spend a CLI attempt or immediately restart that replacement. If
      // it never reaches a prompt, the bounded fallback below re-owns recovery.
      member.settling = false;
      member.canary = false;
      member.attempts = Math.max(0, member.attempts - 1);
      member.state = 'interrupted';
      member.externalRecoveryUntil = this.deps.now() + this.timings.externalRecoveryGraceMs;
      this.renderCard(member);
      this.progress(episode);
      return;
    }
    if (status === 'succeeded') {
      member.settling = false;
      this.markRecovered(episode, member);
      return;
    }

    const up = await this.serverUp(episode);
    // A re-loss, a prompt edge or the episode closing won meanwhile.
    if (member.token !== token || member.state !== 'recovering' || this.episodes.get(episode.key) !== episode) return;
    member.settling = false;
    member.canary = false;
    if (episode.generation !== generation) {
      // Only the PROBE is stale; the restart's terminal status still has to be
      // settled. Reclassify it against the current phase instead of blindly
      // returning the member to interrupted (which would bypass timed_out and
      // the per-member attempt budget).
      if (episode.phase === 'failed') {
        if (!this.dropIfIneligible(member)) this.fail(member, 'server_unavailable');
      } else if (episode.phase === 'waiting' || episode.phase === 'canary') {
        member.state = 'interrupted';
        member.attempts = Math.max(0, member.attempts - 1);
        this.renderCard(member);
      } else if (this.dropIfIneligible(member)) {
        // closed / replaced / put to sleep while its restart was settling
      } else if (status === 'timed_out') {
        this.fail(member, 'timed_out', { giveUp: false });
        member.timedOutAt = this.deps.now();
      } else if (member.attempts < this.timings.memberMaxAttempts) {
        member.token += 1;
        member.state = 'interrupted';
        this.renderCard(member);
      } else {
        this.fail(member, 'cli_failed');
      }
      this.progress(episode);
      return;
    }
    if (!up) {
      if (episode.phase === 'failed') {
        if (!this.dropIfIneligible(member)) this.fail(member, 'server_unavailable');
      } else {
        // The server is (still / again) down: not this session's fault.
        member.state = 'interrupted';
        member.attempts = Math.max(0, member.attempts - 1);
        this.renderCard(member);
        this.serverDown(episode);
      }
    } else {
      if (wasCanary && episode.phase === 'canary') {
        episode.phase = 'up';
        episode.generation += 1;
        this.stopPolling(episode);
      }
      if (this.dropIfIneligible(member)) {
        // closed / replaced / put to sleep while its restart was running
      } else if (status === 'timed_out') {
        // Not ready in time, not proven dead either: never kill a CLI that
        // may still be starting. A later prompt_ready flips the card.
        this.fail(member, 'timed_out', { giveUp: false });
        member.timedOutAt = this.deps.now();
      } else if (member.attempts < this.timings.memberMaxAttempts) {
        member.token += 1;
        member.state = 'interrupted';
        this.renderCard(member);
      } else {
        this.fail(member, 'cli_failed');
      }
    }
    this.progress(episode);
  }

  private markRecovered(episode: Episode<S>, member: Member<S>): void {
    member.token += 1;
    member.restartPending = false;
    member.settling = false;
    member.canary = false;
    member.externalRecoveryUntil = undefined;
    member.state = 'recovered';
    member.failure = undefined;
    member.failureDetail = undefined;
    member.timedOutAt = undefined;
    this.renderCard(member);
    if (episode.phase === 'canary') {
      this.deps.log(`tmux ${serverLabel(episode.socketName)} is back (session ${member.sessionId.slice(0, 8)} recovered)`);
      episode.phase = 'up';
      episode.generation += 1;
      this.stopPolling(episode);
    }
    this.progress(episode);
  }

  /** A report's down verdict is historical by the time it reaches us. Probe
   *  the current server before charging another retry; concurrent late reports
   *  share this one decision, and a newer phase decision invalidates the answer. */
  private confirmServerDown(episode: Episode<S>): void {
    if (episode.downProbe) return;
    const probe = { generation: episode.generation };
    episode.downProbe = probe;
    void (async () => {
      const up = await this.serverUp(episode);
      if (episode.downProbe === probe) episode.downProbe = undefined;
      if (this.episodes.get(episode.key) !== episode) return;
      if (probe.generation === episode.generation && !up) this.serverDown(episode);
      this.progress(episode);
    })();
  }

  /** True while a cancelled member's external replacement still owns recovery.
   *  Without daemon-specific evidence, cancellation itself is enough to wait
   *  for the bounded grace rather than risk restarting a healthy replacement. */
  private waitsForExternalRecovery(member: Member<S>): boolean {
    const until = member.externalRecoveryUntil;
    if (until === undefined) return false;
    const external = this.deps.externalRecoveryInFlight?.(member.ref) ?? true;
    if (this.deps.now() < until && external) return true;
    member.externalRecoveryUntil = undefined;
    return false;
  }

  /** The server is down: back off and try again, once per down period. */
  private serverDown(episode: Episode<S>): void {
    if (episode.phase === 'waiting' || episode.phase === 'failed') return;
    episode.serverRetries += 1;
    const delay = this.timings.serverBackoffMs[episode.serverRetries - 1];
    if (delay === undefined) {
      this.deps.log(`tmux ${serverLabel(episode.socketName)} did not come back after ${episode.serverRetries} tries; giving up`);
      episode.phase = 'failed';
      episode.generation += 1;
      this.stopPolling(episode);
      return; // progress() fails the waiting members
    }
    this.deps.log(`tmux ${serverLabel(episode.socketName)} still down; retry ${episode.serverRetries} in ${Math.round(delay / 1000)}s`);
    for (const member of episode.members.values()) {
      if (member.state === 'interrupted') this.renderCard(member);
    }
    this.schedule(episode, delay);
  }

  private fail(member: Member<S>, reason: OutageFailureReason, opts: { giveUp?: boolean } = {}): void {
    member.token += 1;
    member.restartPending = false;
    member.settling = false;
    member.canary = false;
    member.externalRecoveryUntil = undefined;
    member.state = 'failed';
    member.failure = reason;
    this.renderCard(member);
    if (opts.giveUp !== false && reason !== 'restart_refused') {
      try {
        // A parked diagnostic shell needs a server; never boot one for it
        // when the server itself is what failed.
        this.deps.giveUp(member.ref, { keepTerminal: member.report.canPark && reason === 'cli_failed' });
      } catch (err) {
        this.deps.log(`give-up of ${member.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Drop a member the daemon says must not be restarted (closed, replaced
   *  or deliberately put to sleep). True when it was dropped. */
  private dropIfIneligible(member: Member<S>, eligibility = this.deps.eligible(member.ref)): boolean {
    if (eligibility === 'never') {
      this.stop(member, 'stopped');
      return true;
    }
    if (eligibility === 'dormant') {
      this.stop(member, 'dormant');
      return true;
    }
    return false;
  }

  private stop(member: Member<S>, state: 'stopped' | 'dormant'): void {
    member.token += 1;
    member.restartPending = false;
    member.settling = false;
    member.canary = false;
    member.externalRecoveryUntil = undefined;
    member.state = state;
    // A closed topic needs no further card; only correct one already posted.
    // A sleeping one is still the user's: tell it how it comes back.
    if (state === 'dormant' || this.cards.has(member.sessionId)) this.renderCard(member);
  }

  private maybeSettle(episode: Episode<S>): void {
    if (this.episodes.get(episode.key) !== episode) return;
    if (episode.timer !== undefined || inFlight(episode) > 0 || episode.summaryTimer !== undefined) return;
    const now = this.deps.now();
    let delay = this.timings.summarySettleMs;
    for (const member of episode.members.values()) {
      if (member.state === 'interrupted' || member.state === 'recovering') return;
      if (member.timedOutAt !== undefined) delay = Math.max(delay, member.timedOutAt + this.timings.timedOutGraceMs - now);
    }
    episode.summaryTimer = this.deps.setTimeout(() => {
      episode.summaryTimer = undefined;
      this.close(episode);
    }, delay);
  }

  private cancelSummary(episode: Episode<S>): void {
    if (episode.summaryTimer === undefined) return;
    this.deps.clearTimeout(episode.summaryTimer);
    episode.summaryTimer = undefined;
  }

  private close(episode: Episode<S>): void {
    if (this.episodes.get(episode.key) !== episode) return;
    this.clearTimers(episode);
    this.episodes.delete(episode.key);
    for (const sessionId of episode.members.keys()) {
      if (this.membership.get(sessionId) === episode.key) this.membership.delete(sessionId);
    }
    const members = [...episode.members.values()];
    const summary: OutageSummary = {
      larkAppId: episode.larkAppId,
      serverLabel: serverLabel(episode.socketName),
      startedAt: episode.startedAt,
      endedAt: this.deps.now(),
      serverRetries: episode.serverRetries,
      members: members.map(m => ({
        sessionId: m.sessionId,
        title: m.report.title,
        state: m.state,
        ...(m.failure ? { failure: m.failure } : {}),
        turnInFlight: m.report.turnInFlight,
      })),
    };
    this.deps.log(
      `backend outage closed: tmux ${summary.serverLabel}, ${members.length} session(s), `
      + `${members.filter(m => m.state === 'recovered').length} recovered, `
      + `${members.filter(m => m.state === 'failed').length} failed, `
      + `${members.filter(m => m.state === 'dormant').length} dormant, ${episode.serverRetries} server retr${episode.serverRetries === 1 ? 'y' : 'ies'}`,
    );
    // Sessions that were closed before anything was shown are not "affected".
    if (summary.members.some(m => m.state !== 'stopped')) {
      void Promise.resolve()
        .then(() => this.deps.summarize(summary))
        .catch(err => this.deps.log(`outage summary failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const now = this.deps.now();
    for (const [sessionId, history] of this.lossHistory) {
      if (!this.membership.has(sessionId) && history.every(at => now - at >= this.timings.lossWindowMs)) {
        this.lossHistory.delete(sessionId);
      }
    }
    for (const [sessionId, card] of this.cards) {
      if (now - card.lastUpdatedAt >= this.timings.cardReuseMs && !this.membership.has(sessionId)) this.cards.delete(sessionId);
    }
  }

  private async serverUp(episode: Episode<S>): Promise<boolean> {
    try {
      return await this.deps.serverUp(episode.socketName);
    } catch {
      return false;
    }
  }

  private renderCard(member: Member<S>): void {
    if (member.report.silent) return;
    const now = this.deps.now();
    let card = this.cards.get(member.sessionId);
    if (card && now - card.lastUpdatedAt >= this.timings.cardReuseMs) card = undefined;
    if (!card) {
      card = new LiveCard(this.deps, this.timings, member.sessionId);
      this.cards.set(member.sessionId, card);
    }
    const key = this.membership.get(member.sessionId);
    card.update(member.ref, () => ({
      state: member.state,
      cliName: member.report.cliName,
      serverLabel: serverLabel(member.report.socketName),
      turnInFlight: member.report.turnInFlight,
      serverRetries: (key ? this.episodes.get(key)?.serverRetries : undefined) ?? 0,
      ...(member.failure ? { failure: member.failure } : {}),
      ...(member.failureDetail ? { failureDetail: member.failureDetail } : {}),
      notices: [...member.notices],
    }), now);
  }
}

function inFlight<S>(episode: Episode<S>): number {
  let n = 0;
  for (const member of episode.members.values()) if (member.restartPending) n += 1;
  return n;
}

function episodeKey(larkAppId: string, socketName: string | undefined): string {
  return `${larkAppId}\u0000tmux:${socketName ?? ''}`;
}

/** Stable value in [0, spread) for one key (FNV-1a). */
function stableJitter(key: string, spread: number): number {
  if (spread <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % spread;
}

/** `botmux` for `-L botmux`, `default` for the user's default server. */
export function serverLabel(socketName: string | undefined): string {
  if (!socketName) return 'default';
  const parts = socketName.split('/');
  return parts[parts.length - 1] || socketName;
}

function firstLines(text: string, lines: number): string {
  return text.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(0, lines).join('\n').slice(0, 800);
}

function cliExitDetail(code: number | null, logTail: string | undefined): string {
  const tail = logTail?.trim() ? `\n${firstLines(logTail.trim().split('\n').slice(-6).join('\n'), 6)}` : '';
  return `exit code ${code ?? 'null'}${tail}`;
}
