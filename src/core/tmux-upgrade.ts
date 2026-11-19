/**
 * tmux upgrade advisor: tells the primary bot's owner when the host tmux is
 * below TMUX_RECOMMENDED_MIN, upgrades it on an admin's click, and moves the
 * botmux tmux server onto the new binary only when the owner says so.
 *
 * Shaped after the Codex update monitor (cli-runtime-update.ts): primary daemon
 * only, a short initial delay then a periodic local check, one owner DM per
 * distinct situation (persisted watermark — never re-nagged), DM card built by
 * a pure builder. Unlike Codex it can act: the card carries buttons, guarded
 * like the host-overload card (admin gate + per-card nonce + one job at a time).
 *
 * Two separate steps, because they have very different blast radii:
 *
 *  1. Upgrade the BINARY (package manager that owns it — tmux-upgrade-plan.ts).
 *     Running sessions are untouched: a live tmux server keeps executing the
 *     old program image, so this alone changes nothing for them.
 *  2. Switch the SERVER. A tmux server only becomes the new version when it is
 *     recreated, and recreating it stops every session on it. Never automatic:
 *       - "switch when idle": once EVERY session on the server has been idle
 *         for TMUX_IDLE_SWITCH_MINUTES, suspend them all (the existing strict
 *         idle-suspend path; resumes on the next message). The emptied server
 *         exits on its own and the next session boots the new binary. Never
 *         interrupts a reply; never kills the server while it has sessions.
 *       - "switch now" (button + confirm dialog): suspend whatever is idle,
 *         then `kill-server` the botmux server for the rest — sessions mid-reply
 *         are interrupted and recover through the server-loss restart path.
 *     The shared DEFAULT tmux server (BOTMUX_TMUX_SOCKET=default) also hosts the
 *     user's own sessions, so it is never switched by botmux.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { t, type Locale } from '../i18n/index.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';
import {
  TMUX_RECOMMENDED_MIN,
  isTmuxBelowRecommended,
  tmuxRecommendationWarning,
  tmuxReleaseLabel,
  type TmuxRecommendation,
} from '../setup/tmux-recommended.js';
import type { TmuxUpgradeExecution, TmuxUpgradePlan } from '../setup/tmux-upgrade-plan.js';
import { tmuxSocketArgs } from '../adapters/backend/tmux-socket.js';
import {
  OPEN_TMUX_UPGRADE_PHASES,
  TMUX_IDLE_SWITCH_MINUTES,
  TMUX_UPGRADE_ACTIONS,
  TMUX_UPGRADE_ACTION_NOOP,
  TMUX_UPGRADE_ACTION_RUN,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL,
  TMUX_UPGRADE_ACTION_SWITCH_NOW,
  buildTmuxUpgradeCard,
  type TmuxUpgradeCardModel,
  type TmuxUpgradePhase,
  type TmuxUpgradePlanView,
} from './tmux-upgrade-card.js';
import type { TmuxSwitchSuspendRequest } from './tmux-switch-candidates.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { fetchDaemonIpc } from './daemon-ipc-auth.js';

export const TMUX_UPGRADE_INITIAL_DELAY_MS = 20_000;
export const TMUX_UPGRADE_TICK_MS = 60_000;
export const TMUX_IDLE_SWITCH_MS = TMUX_IDLE_SWITCH_MINUTES * 60_000;
/** How long a switch waits for the emptied server to exit on its own. */
export const TMUX_SERVER_EXIT_WAIT_MS = 20_000;
/** Minimum spacing between two progress patches of the same card. */
export const TMUX_PROGRESS_PATCH_MS = 2_000;

// ─── Facts ──────────────────────────────────────────────────────────────────

export interface TmuxFacts {
  /** Installed tmux (`tmux -V`, release label); null = missing / unreadable. */
  client: string | null;
  /** A server answers on the botmux socket. */
  serverRunning: boolean;
  /** Release of that server; null when none runs or it was unreadable. */
  server: string | null;
  /** The probe could not tell (timeout, unreadable version): decide nothing. */
  serverUnknown: boolean;
  /** Sessions on the server (any name), 0 when none runs. */
  sessions: number;
}

export type TmuxFactPhase = 'needs_upgrade' | 'pending_switch' | 'done';

/** What the host needs right now; null = not enough information to say. */
export function deriveTmuxFactPhase(
  facts: TmuxFacts,
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
): TmuxFactPhase | null {
  if (!facts.client) return null;
  if (isTmuxBelowRecommended(facts.client, recommendation)) return 'needs_upgrade';
  if (facts.serverUnknown) return null;
  if (facts.serverRunning && facts.server && isTmuxBelowRecommended(facts.server, recommendation)) return 'pending_switch';
  return 'done';
}

/** One DM per distinct situation; a new installed or running version re-arms it. */
export function tmuxNoticeKey(phase: TmuxFactPhase, facts: TmuxFacts, min: string): string {
  return phase === 'pending_switch'
    ? `pending_switch|client=${facts.client}|server=${facts.server}|min=${min}`
    : `${phase}|client=${facts.client}|min=${min}`;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface TmuxUpgradeCardRef {
  larkAppId: string;
  messageId: string;
  nonce: string;
  model: TmuxUpgradeCardModel;
  updatedAt: number;
  /** `model` is not on the message yet (a patch failed); re-deliver it. */
  dirty?: boolean;
  /** Consecutive failed patches; past a bound the card is replaced. */
  dirtyFailures?: number;
}

/** Consecutive failed patches after which a fresh card is sent instead. */
export const TMUX_CARD_PATCH_GIVE_UP = 10;

export interface TmuxUpgradeJobRef {
  kind: 'upgrade' | 'switch';
  pid: number;
  /** Process start identity, so a recycled pid is not mistaken for the owner. */
  pidStart?: string;
  startedAt: number;
  /** The package manager process (own process group). It outlives a daemon
   *  restart on purpose, and while it runs the job is still in progress. */
  installerPid?: number;
  installerStart?: string;
}

export interface TmuxUpgradeStore {
  /** Situation the owner was last told about (see tmuxNoticeKey). */
  notifiedKey?: string;
  card?: TmuxUpgradeCardRef;
  /** The owner armed "switch when idle". */
  idleSwitch?: { requestedAt: number; requestedBy: string };
  /** In-flight upgrade / switch. Cleared when it ends. */
  job?: TmuxUpgradeJobRef;
  /** Last failed attempt to send a NEW DM (backs off retries). */
  notifyFailedAt?: number;
}

/** After a failed DM send, wait this long before trying again. */
export const TMUX_NOTIFY_RETRY_MS = 60 * 60_000;

class TmuxNotifyBackoffError extends Error {
  constructor() { super('owner DM is backing off after a failed send'); }
}

const STORE_FILE = 'tmux-upgrade.json';
const PHASES: ReadonlySet<string> = new Set([
  'needs_upgrade', 'upgrading', 'upgrade_failed', 'pending_switch', 'awaiting_idle', 'switching', 'switch_failed', 'done',
]);

export function tmuxUpgradeStorePathIn(dataDir: string): string {
  return join(dataDir, STORE_FILE);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Defensive read: anything malformed degrades to "no state" field by field. */
export function readTmuxUpgradeStoreFrom(dataDir: string): TmuxUpgradeStore {
  const path = tmuxUpgradeStorePathIn(dataDir);
  if (!existsSync(path)) return {};
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const out: TmuxUpgradeStore = {};
  if (str(raw.notifiedKey)) out.notifiedKey = raw.notifiedKey;
  const c = raw.card;
  if (c && typeof c === 'object' && str(c.larkAppId) && str(c.messageId) && str(c.nonce)
    && c.model && typeof c.model === 'object' && PHASES.has(c.model.phase)) {
    out.card = {
      larkAppId: c.larkAppId,
      messageId: c.messageId,
      nonce: c.nonce,
      model: c.model as TmuxUpgradeCardModel,
      updatedAt: num(c.updatedAt) ?? 0,
      ...(c.dirty === true ? { dirty: true } : {}),
      ...(num(c.dirtyFailures) !== undefined ? { dirtyFailures: c.dirtyFailures } : {}),
    };
  }
  if (num(raw.notifyFailedAt) !== undefined) out.notifyFailedAt = raw.notifyFailedAt;
  const idle = raw.idleSwitch;
  if (idle && typeof idle === 'object' && num(idle.requestedAt) !== undefined && str(idle.requestedBy)) {
    out.idleSwitch = { requestedAt: idle.requestedAt, requestedBy: idle.requestedBy };
  }
  const job = raw.job;
  if (job && typeof job === 'object' && (job.kind === 'upgrade' || job.kind === 'switch')
    && num(job.pid) !== undefined && num(job.startedAt) !== undefined) {
    out.job = {
      kind: job.kind,
      pid: job.pid,
      startedAt: job.startedAt,
      ...(str(job.pidStart) ? { pidStart: job.pidStart } : {}),
      ...(num(job.installerPid) !== undefined ? { installerPid: job.installerPid } : {}),
      ...(str(job.installerStart) ? { installerStart: job.installerStart } : {}),
    };
  }
  return out;
}

export function writeTmuxUpgradeStoreTo(dataDir: string, store: TmuxUpgradeStore): void {
  const path = tmuxUpgradeStorePathIn(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// ─── Advisor ────────────────────────────────────────────────────────────────

export interface TmuxFanOutResult {
  /** Sessions that met the idle selector, summed over daemons that answered. */
  candidates: number;
  /** Sessions actually suspended (0 for dry runs). */
  affected: number;
  /** Daemons that did not answer. */
  failed: number;
}

export interface TmuxUpgradeAdvisorDeps {
  dataDir: string;
  /** The bot whose owner gets the DM (the primary daemon's bot). */
  larkAppId: string;
  ownerOpenId: () => string | undefined;
  isAdmin: (larkAppId: string, openId: string | undefined) => boolean;
  locale: () => Locale;
  now: () => number;
  /** Does any configured bot run sessions on tmux at all? */
  tmuxBackendInUse: () => boolean;
  /** Server NEW managed sessions use; undefined = the shared default server. */
  socketName: () => string | undefined;
  probeFacts: (socketName: string | undefined) => Promise<TmuxFacts>;
  plan: (locale: Locale) => Promise<TmuxUpgradePlan>;
  executeUpgrade: (
    plan: Extract<TmuxUpgradePlan, { auto: true }>,
    onLine: (line: string) => void,
    onSpawn: (pid: number) => void,
  ) => Promise<TmuxUpgradeExecution>;
  /** Drop process-local tmux version caches after the binary changed. */
  onBinaryChanged?: () => void;
  sendCard: (openId: string, cardJson: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  /** The message is too old to patch (Lark's update window has passed). */
  isUpdateExpired: (err: unknown) => boolean;
  fanOutSuspend: (request: TmuxSwitchSuspendRequest) => Promise<TmuxFanOutResult>;
  /** `tmux -L <socket> kill-server` — only ever called with a dedicated socket. */
  killServer: (socketName: string) => Promise<void>;
  /** `tmux -L <socket> set -s exit-empty on`: an EMPTY server exits at once,
   *  atomically with respect to a session that is just being created. */
  retireEmptyServer: (socketName: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Process start identity of `pid` (undefined = gone). */
  processStart: (pid: number) => string | undefined;
  log: (message: string) => void;
  newNonce?: () => string;
  recommendation?: TmuxRecommendation;
  /** Patch throttle; tests set 0. */
  progressPatchMs?: number;
  /** Poll step while waiting for a server to exit; tests set it tiny. */
  serverPollMs?: number;
  /** A job's final card is never patched sooner than this after the click,
   *  so Lark cannot apply the click's own (earlier) card response on top. */
  minFinalPatchDelayMs?: number;
  /** Upper bound on one fan-out, whatever `fanOutSuspend` does internally. */
  fanOutTimeoutMs?: { dry: number; run: number };
}

export type TmuxCardActionResult =
  | { toast: { type: 'info' | 'success' | 'warning' | 'error'; content: string } }
  | { card: { type: 'raw'; data: unknown }; afterAck?: () => Promise<void> };

export interface TmuxCardActionInput {
  action: string;
  nonce: unknown;
  messageId: string | undefined;
  operatorOpenId: string | undefined;
  larkAppId: string;
}

export function isTmuxUpgradeAction(action: unknown): action is string {
  return typeof action === 'string' && TMUX_UPGRADE_ACTIONS.includes(action);
}

function planView(plan: TmuxUpgradePlan): TmuxUpgradePlanView {
  return plan.auto
    ? { auto: true, display: plan.display, tmuxPath: plan.tmuxPath, ...(plan.candidate ? { candidate: plan.candidate } : {}) }
    : {
        auto: false,
        reason: plan.reason,
        ...(plan.tmuxPath ? { tmuxPath: plan.tmuxPath } : {}),
        ...(plan.manualCommand ? { manualCommand: plan.manualCommand } : {}),
        ...(plan.hint ? { hint: plan.hint } : {}),
        ...(plan.candidate ? { candidate: plan.candidate } : {}),
      };
}

/** Strip terminal control sequences; keep the tail short enough for a card. */
function cleanLogLine(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd();
}

export class TmuxUpgradeAdvisor {
  private queue: Promise<unknown> = Promise.resolve();
  private jobRunning = false;
  private ticking = false;
  private readonly rec: TmuxRecommendation;

  constructor(private readonly deps: TmuxUpgradeAdvisorDeps) {
    this.rec = deps.recommendation ?? TMUX_RECOMMENDED_MIN;
  }

  /**
   * Serialize store read-modify-write sections inside this process. Slow I/O
   * (tmux probes, the cross-daemon dry run, the installer, the server switch)
   * runs OUTSIDE this queue so a click is always answered promptly; whoever
   * writes after an await re-reads the store first, and every other writer
   * backs off while a job is in flight (`jobRunning` / `store.job`).
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private read(): TmuxUpgradeStore { return readTmuxUpgradeStoreFrom(this.deps.dataDir); }
  private write(store: TmuxUpgradeStore): void { writeTmuxUpgradeStoreTo(this.deps.dataDir, store); }

  private baseModel(facts: TmuxFacts | undefined, phase: TmuxUpgradePhase, locale: Locale): TmuxUpgradeCardModel {
    return {
      phase,
      min: this.rec.version,
      why: this.rec.why[locale] ?? this.rec.why.zh,
      client: facts?.client ?? null,
      server: facts?.server ?? null,
      ...(facts && !facts.serverUnknown ? { serverSessions: facts.sessions } : {}),
      ...(this.deps.socketName() === undefined ? { sharedServer: true } : {}),
    };
  }

  private render(model: TmuxUpgradeCardModel, nonce: string): string {
    return buildTmuxUpgradeCard(model, nonce, this.deps.locale());
  }

  private alive(pid: number | undefined, start: string | undefined): boolean {
    if (pid === undefined) return false;
    const now = this.deps.processStart(pid);
    return now !== undefined && (start === undefined || now === start);
  }

  /** Is the persisted job still in progress somewhere? Its owner process is
   *  alive, or the installer it started (which survives a daemon restart). */
  private jobAlive(job: TmuxUpgradeJobRef | undefined): boolean {
    if (!job) return false;
    if (this.alive(job.installerPid, job.installerStart)) return true;
    if (job.pid === process.pid) return this.jobRunning;
    return this.alive(job.pid, job.pidStart);
  }

  private ownCard(store: TmuxUpgradeStore): TmuxUpgradeCardRef | undefined {
    return store.card && store.card.larkAppId === this.deps.larkAppId ? store.card : undefined;
  }

  /** Fan out with a hard deadline: a daemon that never answers must not wedge
   *  a tick (dry run → counted as failed) or a job (real run → throws). */
  private async fanOut(request: TmuxSwitchSuspendRequest): Promise<TmuxFanOutResult> {
    const limits = this.deps.fanOutTimeoutMs ?? { dry: TMUX_FANOUT_DRY_TIMEOUT_MS + 5_000, run: TMUX_FANOUT_RUN_TIMEOUT_MS + 30_000 };
    const ms = request.dryRun ? limits.dry : limits.run;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
    try {
      const result = await Promise.race([this.deps.fanOutSuspend(request), timeout]);
      if (result !== 'timeout') return result;
      if (request.dryRun) return { candidates: 0, affected: 0, failed: 1 };
      throw new Error(t('tmux_upgrade.error.fanout_timeout', undefined, this.deps.locale()));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Put `model` on the owner's card: patch the existing message, or send a new
   * one when there is none, it is too old to patch, or patching has failed
   * TMUX_CARD_PATCH_GIVE_UP times in a row. A failed patch keeps the model
   * marked `dirty` so the next tick retries it. A failed SEND throws.
   */
  private async deliver(store: TmuxUpgradeStore, model: TmuxUpgradeCardModel): Promise<TmuxUpgradeCardRef> {
    const existing = this.ownCard(store);
    if (existing) {
      const attempt = async (m: TmuxUpgradeCardModel) => {
        await this.deps.updateCard(existing.messageId, this.render(m, existing.nonce));
      };
      try {
        try {
          await attempt(model);
        } catch (err) {
          // Installer output is the only free text on the card; a content
          // check that rejects it must not freeze the card on a stale state.
          if (this.deps.isUpdateExpired(err) || !model.log?.length) throw err;
          await attempt({ ...model, log: undefined });
        }
        return { ...existing, model, updatedAt: this.deps.now(), dirty: undefined, dirtyFailures: undefined };
      } catch (err) {
        const failures = (existing.dirtyFailures ?? 0) + 1;
        if (!this.deps.isUpdateExpired(err) && failures < TMUX_CARD_PATCH_GIVE_UP) {
          this.deps.log(`card patch failed (${failures}): ${err instanceof Error ? err.message : String(err)}`);
          return { ...existing, model, updatedAt: this.deps.now(), dirty: true, dirtyFailures: failures };
        }
        this.deps.log('card can no longer be patched; sending a fresh one');
      }
    }
    if (store.notifyFailedAt !== undefined && this.deps.now() - store.notifyFailedAt < TMUX_NOTIFY_RETRY_MS) {
      throw new TmuxNotifyBackoffError();
    }
    const owner = this.deps.ownerOpenId();
    if (!owner) throw new Error('no primary owner configured');
    const nonce = this.deps.newNonce?.() ?? randomBytes(9).toString('base64url');
    const messageId = await this.deps.sendCard(owner, this.render(model, nonce));
    return { larkAppId: this.deps.larkAppId, messageId, nonce, model, updatedAt: this.deps.now() };
  }

  /** Deliver `model` and persist it (plus `patch`) in one write. */
  private async show(store: TmuxUpgradeStore, model: TmuxUpgradeCardModel, patch: Partial<TmuxUpgradeStore> = {}): Promise<TmuxUpgradeStore> {
    let card: TmuxUpgradeCardRef;
    try {
      card = await this.deliver(store, model);
    } catch (err) {
      // Only a failed NEW send gets here (patch failures come back dirty).
      // Back off so a host whose owner cannot be DM'd is not retried every tick.
      if (!(err instanceof TmuxNotifyBackoffError)) this.write({ ...store, notifyFailedAt: this.deps.now() });
      throw err;
    }
    const next: TmuxUpgradeStore = { ...store, ...patch, card };
    if (card.messageId !== store.card?.messageId) delete next.notifyFailedAt;
    this.write(next);
    return next;
  }

  // ── periodic check ────────────────────────────────────────────────────────

  tick(): Promise<void> {
    if (this.ticking) return Promise.resolve();
    this.ticking = true;
    return this.tickInner()
      .catch(err => { this.deps.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`); })
      .finally(() => { this.ticking = false; });
  }

  private async tickInner(): Promise<void> {
    if (!this.deps.tmuxBackendInUse()) return;
    // Slow, read-only work first, outside the serialized section.
    const pre = this.read();
    if (this.jobRunning || (pre.job && this.jobAlive(pre.job))) return;
    const socketName = this.deps.socketName();
    const facts = await this.deps.probeFacts(socketName);
    const phase = deriveTmuxFactPhase(facts, this.rec);
    let dry: TmuxFanOutResult | undefined;
    if (phase === 'pending_switch' && pre.idleSwitch && socketName !== undefined
      && this.ownCard(pre) && facts.sessions > 0) {
      dry = await this.fanOut({ socketName, olderThanMs: TMUX_IDLE_SWITCH_MS, dryRun: true });
    }
    await this.serial(() => this.tickApply(socketName, facts, phase, dry));
  }

  private async tickApply(
    socketName: string | undefined,
    facts: TmuxFacts,
    phase: TmuxFactPhase | null,
    dry: TmuxFanOutResult | undefined,
  ): Promise<void> {
    let store = this.read();
    const locale = this.deps.locale();

    // A job recorded by a process that is gone (daemon restart mid-upgrade,
    // installer finished meanwhile): its card is frozen on "upgrading" /
    // "switching". Drop the job and re-render from fresh facts below.
    let interruptedByRestart = false;
    if (store.job && !this.jobAlive(store.job)) {
      this.deps.log(`clearing ${store.job.kind} job left by pid ${store.job.pid}`);
      store = { ...store, job: undefined };
      this.write(store);
      interruptedByRestart = true;
    }
    if (store.job || this.jobRunning) return;

    // A patch that failed earlier: put the intended state on the card first.
    const pending = this.ownCard(store);
    if (pending?.dirty) {
      store = await this.show(store, pending.model);
      if (this.ownCard(store)?.dirty) return;
    }

    if (!phase) return;
    const key = tmuxNoticeKey(phase, facts, this.rec.version);
    const card = this.ownCard(store);
    const cardPhase = card?.model.phase;
    const cardActive = !!card && (OPEN_TMUX_UPGRADE_PHASES.has(cardPhase!)
      || cardPhase === 'upgrading' || cardPhase === 'switching');

    // An armed "switch when idle" belongs to the card it was armed on and only
    // means something while that card is waiting for a switch.
    if (store.idleSwitch && (phase !== 'pending_switch' || !cardActive || socketName === undefined)) {
      store = { ...store, idleSwitch: undefined };
      this.write(store);
    }

    if (phase === 'done') {
      if (card && cardActive) {
        await this.show(store, {
          ...this.baseModel(facts, 'done', locale),
          ...(interruptedByRestart ? { interruptedByRestart } : {}),
        }, { notifiedKey: key });
      }
      return;
    }

    if (phase === 'pending_switch' && store.idleSwitch && socketName !== undefined) {
      await this.tryIdleSwitch(store, facts, socketName, dry);
      return;
    }

    if (cardActive) {
      // Reconcile the open card with what is true now. Re-render only on a
      // real change, so an unchanged host costs zero Lark writes per tick.
      const keepFailure = !interruptedByRestart
        && ((phase === 'needs_upgrade' && cardPhase === 'upgrade_failed')
          || (phase === 'pending_switch' && cardPhase === 'switch_failed'));
      const wanted: TmuxUpgradePhase = keepFailure ? cardPhase! : phase;
      const changed = wanted !== cardPhase
        || card!.model.client !== facts.client
        || (phase === 'pending_switch' && card!.model.server !== facts.server)
        || interruptedByRestart;
      if (!changed) {
        if (store.notifiedKey !== key) this.write({ ...store, notifiedKey: key });
        return;
      }
      const model: TmuxUpgradeCardModel = {
        ...(wanted === cardPhase ? card!.model : {}),
        ...this.baseModel(facts, wanted, locale),
        ...(phase === 'needs_upgrade' ? { plan: planView(await this.deps.plan(locale)) } : {}),
        ...(interruptedByRestart ? { interruptedByRestart } : {}),
      };
      await this.show(this.read(), model, { notifiedKey: key });
      return;
    }

    // The open card is the usual de-duplication; the watermark also covers a
    // lost card reference. A card owned by another bot (the primary changed)
    // does not count: the current primary's owner gets its own DM.
    if (store.notifiedKey === key && (!store.card || store.card.larkAppId === this.deps.larkAppId)) return;
    // Do not even build the card (plan() spawns package tools) while backing off.
    if (store.notifyFailedAt !== undefined && this.deps.now() - store.notifyFailedAt < TMUX_NOTIFY_RETRY_MS) return;
    const model: TmuxUpgradeCardModel = {
      ...this.baseModel(facts, phase, locale),
      ...(phase === 'needs_upgrade' ? { plan: planView(await this.deps.plan(locale)) } : {}),
    };
    try {
      // A finished card (or one owned by another bot) is history: a new
      // situation gets a new DM.
      await this.show({ ...this.read(), card: undefined }, model, { notifiedKey: key, notifyFailedAt: undefined });
      this.deps.log(`owner notified: ${key}`);
    } catch (err) {
      this.deps.log(`owner notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Switch when idle": go only when EVERY session on the server is idle-ready
   *  and every daemon answered the dry run. */
  private async tryIdleSwitch(
    store: TmuxUpgradeStore,
    facts: TmuxFacts,
    socketName: string,
    dry: TmuxFanOutResult | undefined,
  ): Promise<void> {
    const locale = this.deps.locale();
    const complete = facts.sessions === 0
      || (!!dry && dry.failed === 0 && dry.candidates >= facts.sessions);
    if (!complete) {
      const ready = dry?.candidates ?? 0;
      const prev = this.ownCard(store)?.model;
      if (!prev || prev.phase !== 'awaiting_idle' || prev.idleReady !== ready || prev.serverSessions !== facts.sessions
        || prev.server !== facts.server) {
        await this.show(store, {
          ...this.baseModel(facts, 'awaiting_idle', locale),
          idleReady: ready,
          idleCheckedAt: this.deps.now(),
        });
      }
      return;
    }
    const startedAt = this.deps.now();
    store = this.claim(store, 'switch');
    try {
      await this.show(store, { ...this.baseModel(facts, 'switching', locale), startedAt, now: startedAt, log: [] });
    } catch (err) {
      this.deps.log(`switching card not shown: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Outside the serialized section: see serial().
    void this.runSwitch('idle', socketName, startedAt);
  }

  /** Record a job. Persist first: if the write fails nothing is claimed. */
  private claim(store: TmuxUpgradeStore, kind: TmuxUpgradeJobRef['kind']): TmuxUpgradeStore {
    const pidStart = this.deps.processStart(process.pid);
    const next: TmuxUpgradeStore = {
      ...store,
      job: { kind, pid: process.pid, startedAt: this.deps.now(), ...(pidStart ? { pidStart } : {}) },
    };
    this.write(next);
    this.jobRunning = true;
    return next;
  }

  /**
   * End the job: show its final card, then clear the job in the SAME write,
   * and only then let ticks/clicks back in. Clearing first would let a tick
   * see a job-less "upgrading" card and race the final render.
   */
  private async settleJob(
    model: TmuxUpgradeCardModel,
    facts: TmuxFacts | undefined,
    startedAt: number,
    patch: Partial<TmuxUpgradeStore> = {},
  ): Promise<void> {
    try {
      // The click's own card response must land before our final patch, or
      // Lark re-applies it on top (a fast job would look frozen mid-way).
      const wait = startedAt + (this.deps.minFinalPatchDelayMs ?? 1_500) - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      await this.serial(async () => {
        const store = this.read();
        const phase = facts ? deriveTmuxFactPhase(facts, this.rec) : null;
        const extra: Partial<TmuxUpgradeStore> = {
          ...patch,
          job: undefined,
          ...(phase ? { notifiedKey: tmuxNoticeKey(phase, facts!, this.rec.version) } : {}),
        };
        try {
          await this.show(store, model, extra);
        } catch (err) {
          // Even an undeliverable result must release the job.
          this.deps.log(`final card not delivered: ${err instanceof Error ? err.message : String(err)}`);
          const latest = this.read();
          const card = this.ownCard(latest);
          this.write({ ...latest, ...extra, ...(card ? { card: { ...card, model, dirty: true } } : {}) });
        }
      });
    } finally {
      this.jobRunning = false;
    }
  }

  // ── card buttons ──────────────────────────────────────────────────────────

  handleAction(input: TmuxCardActionInput): Promise<TmuxCardActionResult> {
    return this.serial(() => this.handleActionInner(input));
  }

  private async handleActionInner(input: TmuxCardActionInput): Promise<TmuxCardActionResult> {
    const locale = this.deps.locale();
    const toast = (type: 'info' | 'warning' | 'error', key: string) =>
      ({ toast: { type, content: t(key, undefined, locale) } });
    if (input.action === TMUX_UPGRADE_ACTION_NOOP) return toast('info', 'tmux_upgrade.toast.busy');
    if (!this.deps.isAdmin(input.larkAppId, input.operatorOpenId)) {
      this.deps.log(`${input.action} refused for non-admin ${input.operatorOpenId ?? '?'}`);
      return toast('error', 'tmux_upgrade.toast.admin_only');
    }
    let store = this.read();
    const card = store.card;
    if (!card || card.larkAppId !== input.larkAppId || card.larkAppId !== this.deps.larkAppId
      || card.messageId !== input.messageId || typeof input.nonce !== 'string' || input.nonce !== card.nonce) {
      return toast('warning', 'tmux_upgrade.toast.stale');
    }
    if (store.job && !this.jobAlive(store.job)) {
      store = { ...store, job: undefined };
      this.write(store);
    }
    if (store.job || this.jobRunning) return toast('info', 'tmux_upgrade.toast.busy');
    const operator = input.operatorOpenId!;
    const phase = card.model.phase;
    const now = this.deps.now();
    const respond = (model: TmuxUpgradeCardModel, afterAck?: () => Promise<void>): TmuxCardActionResult => ({
      card: { type: 'raw', data: JSON.parse(this.render(model, card.nonce)) },
      ...(afterAck ? { afterAck } : {}),
    });
    const tryClaim = (next: TmuxUpgradeStore, kind: TmuxUpgradeJobRef['kind']): boolean => {
      try {
        this.claim(next, kind);
        return true;
      } catch (err) {
        this.deps.log(`could not record the ${kind} job: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    switch (input.action) {
      case TMUX_UPGRADE_ACTION_RUN: {
        if (phase !== 'needs_upgrade' && phase !== 'upgrade_failed') return toast('warning', 'tmux_upgrade.toast.stale');
        const model: TmuxUpgradeCardModel = {
          ...card.model, phase: 'upgrading', startedAt: now, now, log: [],
          error: undefined, interruptedByRestart: undefined,
        };
        if (!tryClaim({ ...store, card: { ...card, model, updatedAt: now, dirty: undefined } }, 'upgrade')) {
          return toast('warning', 'tmux_upgrade.toast.unavailable');
        }
        this.deps.log(`upgrade started by ${operator}`);
        return respond(model, () => this.runUpgrade(now));
      }
      case TMUX_UPGRADE_ACTION_SWITCH_NOW: {
        if (phase !== 'pending_switch' && phase !== 'awaiting_idle' && phase !== 'switch_failed') {
          return toast('warning', 'tmux_upgrade.toast.stale');
        }
        const socketName = this.deps.socketName();
        if (socketName === undefined) return toast('warning', 'tmux_upgrade.toast.unavailable');
        const model: TmuxUpgradeCardModel = {
          ...card.model, phase: 'switching', startedAt: now, now, log: [],
          error: undefined, interruptedByRestart: undefined,
        };
        if (!tryClaim({
          ...store, idleSwitch: undefined, card: { ...card, model, updatedAt: now, dirty: undefined },
        }, 'switch')) {
          return toast('warning', 'tmux_upgrade.toast.unavailable');
        }
        this.deps.log(`switch-now confirmed by ${operator}`);
        return respond(model, () => this.runSwitch('now', socketName, now));
      }
      case TMUX_UPGRADE_ACTION_SWITCH_IDLE: {
        if (phase !== 'pending_switch' && phase !== 'switch_failed') return toast('warning', 'tmux_upgrade.toast.stale');
        if (this.deps.socketName() === undefined) return toast('warning', 'tmux_upgrade.toast.unavailable');
        const model: TmuxUpgradeCardModel = {
          ...card.model, phase: 'awaiting_idle', error: undefined, interruptedByRestart: undefined,
          idleReady: undefined, idleCheckedAt: undefined,
        };
        this.write({
          ...store,
          idleSwitch: { requestedAt: now, requestedBy: operator },
          card: { ...card, model, updatedAt: now, dirty: undefined },
        });
        this.deps.log(`idle switch armed by ${operator}`);
        // Evaluate right away instead of waiting up to a full tick.
        return respond(model, () => this.tick());
      }
      case TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL: {
        if (phase !== 'awaiting_idle' && !store.idleSwitch) return toast('warning', 'tmux_upgrade.toast.stale');
        const model: TmuxUpgradeCardModel = {
          ...card.model,
          phase: phase === 'awaiting_idle' ? 'pending_switch' : phase,
          idleReady: undefined,
          idleCheckedAt: undefined,
        };
        this.write({ ...store, idleSwitch: undefined, card: { ...card, model, updatedAt: now, dirty: undefined } });
        this.deps.log(`idle switch cancelled by ${operator}`);
        return respond(model);
      }
      default:
        return toast('warning', 'tmux_upgrade.toast.stale');
    }
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  /**
   * Throttled live patching of the job's card: at most one patch in flight and
   * one every `progressPatchMs`; the newest state waiting behind them is sent
   * as soon as the window opens, so the last lines before a pause are shown.
   */
  private progress(startedAt: number) {
    let last = 0;
    let pending: TmuxUpgradeCardModel | undefined;
    let inFlight: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const interval = this.deps.progressPatchMs ?? TMUX_PROGRESS_PATCH_MS;
    const schedule = () => {
      if (closed || !pending || inFlight || timer) return;
      const wait = interval - (this.deps.now() - last);
      if (wait <= 0) { flush(); return; }
      timer = setTimeout(() => { timer = undefined; schedule(); }, wait);
      timer.unref?.();
    };
    const flush = () => {
      if (closed || !pending || inFlight) return;
      const model = pending;
      pending = undefined;
      last = this.deps.now();
      const card = this.ownCard(this.read());
      if (!card) return;
      inFlight = this.deps.updateCard(card.messageId, this.render({ ...model, startedAt, now: this.deps.now() }, card.nonce))
        .catch(err => this.deps.log(`progress patch failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { inFlight = undefined; schedule(); });
    };
    return {
      push: (model: TmuxUpgradeCardModel) => {
        pending = model;
        schedule();
      },
      /** Stop progress and wait for an in-flight patch, so the final render is
       *  the last write to the message. */
      settle: async () => {
        closed = true;
        pending = undefined;
        if (timer) { clearTimeout(timer); timer = undefined; }
        while (inFlight) await inFlight;
      },
    };
  }

  /** Remember the installer so a restarted daemon knows it is still running. */
  private recordInstaller(pid: number): void {
    const installerStart = this.deps.processStart(pid);
    void this.serial(async () => {
      const store = this.read();
      if (store.job?.pid !== process.pid) return;
      this.write({ ...store, job: { ...store.job, installerPid: pid, ...(installerStart ? { installerStart } : {}) } });
    }).catch(err => this.deps.log(`installer pid not recorded: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async runUpgrade(startedAt: number): Promise<void> {
    const locale = this.deps.locale();
    const log: string[] = [];
    const progress = this.progress(startedAt);
    let model: TmuxUpgradeCardModel = { ...this.baseModel(undefined, 'upgrading', locale), log };
    let facts: TmuxFacts | undefined;
    let plan: TmuxUpgradePlan | undefined;
    let final: TmuxUpgradeCardModel;
    try {
      const socketName = this.deps.socketName();
      facts = await this.deps.probeFacts(socketName);
      model = { ...this.baseModel(facts, 'upgrading', locale), log };
      if (facts.client && !isTmuxBelowRecommended(facts.client, this.rec)) {
        // Someone upgraded it meanwhile: nothing to install.
        final = this.afterBinary(facts, locale);
      } else {
        plan = await this.deps.plan(locale);
        model = { ...model, plan: planView(plan) };
        if (!plan.auto) {
          final = { ...this.baseModel(facts, 'needs_upgrade', locale), plan: planView(plan) };
        } else {
          progress.push(model);
          const execution = await this.deps.executeUpgrade(plan, raw => {
            const line = cleanLogLine(raw);
            if (!line) return;
            log.push(line);
            if (log.length > 40) log.splice(0, log.length - 40);
            progress.push({ ...model, log: [...log] });
          }, pid => this.recordInstaller(pid));
          this.deps.onBinaryChanged?.();
          facts = await this.deps.probeFacts(socketName);
          if (facts.client && !isTmuxBelowRecommended(facts.client, this.rec)) {
            this.deps.log(`tmux upgraded to ${facts.client} (${execution.ran.join(' ; ')})`);
            final = this.afterBinary(facts, locale);
          } else {
            const error = !execution.ok
              ? execution.failure === 'no_candidate'
                ? t('tmux_upgrade.error.no_candidate', { min: this.rec.version, detail: execution.error ?? '' }, locale)
                : execution.failure === 'timed_out'
                  ? t('tmux_upgrade.error.timeout', { detail: execution.error ?? '' }, locale)
                  : t('tmux_upgrade.error.command', { detail: execution.error ?? '' }, locale)
              : t('tmux_upgrade.error.still_old', { client: facts.client ?? '?', min: this.rec.version }, locale);
            this.deps.log(`upgrade did not reach ${this.rec.version}: ${error}`);
            final = { ...this.baseModel(facts, 'upgrade_failed', locale), plan: planView(plan), log: [...log], error };
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.log(`upgrade failed: ${error}`);
      final = {
        ...this.baseModel(facts, 'upgrade_failed', locale),
        ...(plan ? { plan: planView(plan) } : {}),
        log: [...log],
        error,
      };
    }
    await progress.settle();
    await this.settleJob(final, facts, startedAt);
  }

  /** Card after the binary reached the recommendation. A server whose state
   *  could not be read is NOT assumed switched: the card keeps offering the
   *  switch and the next tick settles it from a readable probe. */
  private afterBinary(facts: TmuxFacts, locale: Locale): TmuxUpgradeCardModel {
    const phase = deriveTmuxFactPhase(facts, this.rec);
    return this.baseModel(facts, phase === 'done' ? 'done' : 'pending_switch', locale);
  }

  /** Poll until the old server is CONFIRMED gone (or replaced) or the time is
   *  up. An unreadable probe keeps polling; it never counts as "gone". */
  private async waitServerSettled(socketName: string, deadlineMs: number): Promise<TmuxFacts> {
    const step = this.deps.serverPollMs ?? 1_000;
    const deadline = this.deps.now() + deadlineMs;
    let facts = await this.deps.probeFacts(socketName);
    while (deriveTmuxFactPhase(facts, this.rec) !== 'done' && this.deps.now() < deadline) {
      await this.deps.sleep(step);
      facts = await this.deps.probeFacts(socketName);
    }
    return facts;
  }

  private async runSwitch(mode: 'now' | 'idle', socketName: string, startedAt: number): Promise<void> {
    const locale = this.deps.locale();
    const log: string[] = [];
    const progress = this.progress(startedAt);
    const note = (line: string, facts?: TmuxFacts) => {
      log.push(line);
      progress.push({ ...this.baseModel(facts, 'switching', locale), log: [...log] });
    };
    // The idle switch is disarmed on every outcome except "wait again": a
    // failure must not keep retrying (and re-killing) on its own.
    const disarm: Partial<TmuxUpgradeStore> = { idleSwitch: undefined };
    let facts: TmuxFacts | undefined;
    let final: TmuxUpgradeCardModel;
    let patch: Partial<TmuxUpgradeStore> = disarm;
    try {
      facts = await this.deps.probeFacts(socketName);
      const phase = deriveTmuxFactPhase(facts, this.rec);
      if (phase === 'needs_upgrade') {
        final = {
          ...this.baseModel(facts, 'switch_failed', locale),
          error: t('tmux_upgrade.error.client_old', { client: facts.client ?? '?' }, locale),
        };
      } else if (phase === 'done') {
        final = this.baseModel(facts, 'done', locale);
      } else if (phase === null) {
        throw new Error(t('tmux_upgrade.error.unknown_state', undefined, locale));
      } else {
        // 1. Take idle sessions off the server through the normal suspend path.
        const before = facts.sessions;
        const sweep = await this.fanOut({
          socketName,
          olderThanMs: mode === 'now' ? 1 : TMUX_IDLE_SWITCH_MS,
          dryRun: false,
        });
        note(t('tmux_upgrade.log.suspended', { affected: String(sweep.affected), total: String(before) }, locale), facts);
        if (sweep.failed) note(t('tmux_upgrade.error.fanout', { failed: String(sweep.failed) }, locale), facts);

        // 2. An emptied server exits by itself; give it a moment.
        facts = await this.waitServerSettled(socketName, TMUX_SERVER_EXIT_WAIT_MS);
        let interrupted = 0;
        let backToWaiting = false;
        let settled = deriveTmuxFactPhase(facts, this.rec);
        if (settled !== 'done' && settled !== 'needs_upgrade') {
          if (mode === 'idle') {
            if (settled === 'pending_switch' && facts.sessions === 0) {
              // Empty but still running (exit-empty off): let it exit. Unlike
              // kill-server this cannot take a session created meanwhile.
              await this.deps.retireEmptyServer(socketName);
              facts = await this.waitServerSettled(socketName, 5_000);
            }
            if (deriveTmuxFactPhase(facts, this.rec) !== 'done') {
              // Something is still on it (a session woke up, or the server
              // could not be read). Idle mode never kills: wait for the next
              // quiet moment with the switch still armed.
              note(t('tmux_upgrade.log.back_to_waiting', { sessions: String(facts.sessions) }, locale), facts);
              backToWaiting = true;
            }
          } else {
            // 3. Owner-confirmed "now": take the old server down; sessions
            //    still on it come back on the new binary through the
            //    server-loss restart path.
            interrupted = facts.serverUnknown ? 0 : facts.sessions;
            note(t('tmux_upgrade.log.stopping_server', { server: facts.server ?? '?', sessions: String(interrupted) }, locale), facts);
            await this.deps.killServer(socketName);
            facts = await this.waitServerSettled(socketName, 5_000);
          }
        }
        settled = deriveTmuxFactPhase(facts, this.rec);
        if (backToWaiting) {
          patch = {};
          final = { ...this.baseModel(facts, 'awaiting_idle', locale), idleReady: 0, idleCheckedAt: this.deps.now() };
        } else if (settled === 'done') {
          this.deps.log(`tmux server switched (${mode}): suspended=${sweep.affected} interrupted=${interrupted}`);
          final = { ...this.baseModel(facts, 'done', locale), suspended: sweep.affected, interrupted };
        } else {
          final = {
            ...this.baseModel(facts, 'switch_failed', locale),
            log: [...log],
            error: settled === null
              ? t('tmux_upgrade.error.unknown_state', undefined, locale)
              : t('tmux_upgrade.error.server_alive', { server: facts.server ?? '?' }, locale),
          };
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.log(`switch failed: ${error}`);
      final = { ...this.baseModel(facts, 'switch_failed', locale), log: [...log], error };
      patch = disarm;
    }
    await progress.settle();
    await this.settleJob(final, facts, startedAt, patch);
  }
}

// ─── Process-wide registration (primary daemon) ─────────────────────────────

let advisor: TmuxUpgradeAdvisor | undefined;
let initialTimer: NodeJS.Timeout | undefined;
let tickTimer: NodeJS.Timeout | undefined;

/** Card-handler entry: route a `tmux_upgrade_*` click to the advisor. */
export async function handleTmuxUpgradeCardAction(
  input: TmuxCardActionInput,
  locale: Locale,
): Promise<TmuxCardActionResult> {
  if (!advisor) return { toast: { type: 'warning', content: t('tmux_upgrade.toast.unavailable', undefined, locale) } };
  return advisor.handleAction(input);
}

export function startTmuxUpgradeMonitor(deps: TmuxUpgradeAdvisorDeps): TmuxUpgradeAdvisor {
  if (advisor) return advisor;
  advisor = new TmuxUpgradeAdvisor(deps);
  const current = advisor;
  initialTimer = setTimeout(() => {
    initialTimer = undefined;
    void current.tick();
  }, TMUX_UPGRADE_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  tickTimer = setInterval(() => { void current.tick(); }, TMUX_UPGRADE_TICK_MS);
  tickTimer.unref?.();
  deps.log(`monitor started (recommended tmux ≥ ${deps.recommendation?.version ?? TMUX_RECOMMENDED_MIN.version})`);
  return advisor;
}

/** Test reset hook (and a clean stop for an embedding host). */
export function stopTmuxUpgradeMonitor(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (tickTimer) clearInterval(tickTimer);
  initialTimer = undefined;
  tickTimer = undefined;
  advisor = undefined;
}

// ─── Production probes ──────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 8_000;

type TmuxExec = { ok: true; stdout: string } | { ok: false; timedOut: boolean; stderr: string };

function execTmux(args: string[]): Promise<TmuxExec> {
  return new Promise(resolve => {
    execFile('tmux', args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: tmuxEnv() }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: String(stdout ?? '') });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      resolve({ ok: false, timedOut: !!(e.killed || e.signal || e.code === 'ETIMEDOUT'), stderr: String(stderr ?? '') });
    });
  });
}

/** tmux's own words for "nothing is listening on this socket". Anything else
 *  (permissions, a crash mid-answer, a timeout) is "could not tell". */
export function isNoTmuxServerError(stderr: string): boolean {
  return /no server running/i.test(stderr)
    || /error connecting to .*\((?:No such file or directory|Connection refused)\)/i.test(stderr);
}

/**
 * Read-only facts about the installed tmux and the botmux server. Never starts
 * a server: list-sessions / display-message carry an implicit -N.
 */
export async function probeTmuxFacts(socketName: string | undefined): Promise<TmuxFacts> {
  const version = await execTmux(['-V']);
  const client = version.ok ? tmuxReleaseLabel(version.stdout) : null;
  const sock = tmuxSocketArgs(socketName);
  const list = await execTmux([...sock, 'list-sessions', '-F', '#{session_name}']);
  if (!list.ok) {
    const gone = !list.timedOut && isNoTmuxServerError(list.stderr);
    return { client, serverRunning: !gone, server: null, serverUnknown: !gone, sessions: 0 };
  }
  const sessions = list.stdout.split('\n').filter(line => line.trim()).length;
  const display = await execTmux([...sock, 'display-message', '-p', '#{version}']);
  const server = display.ok ? tmuxReleaseLabel(display.stdout) : null;
  return { client, serverRunning: true, server, serverUnknown: !server, sessions };
}

export async function killTmuxServer(socketName: string): Promise<void> {
  if (!socketName) throw new Error('refusing to kill the default tmux server');
  const r = await execTmux(['-L', socketName, 'kill-server']);
  // "no server running" after a race is fine; the caller re-probes either way.
  if (!r.ok && r.timedOut) throw new Error('tmux kill-server timed out');
}

/** Make an EMPTY server exit on its own (`exit-empty` is checked by tmux's
 *  single-threaded loop, so a session created meanwhile keeps it alive). */
export async function retireEmptyTmuxServer(socketName: string): Promise<void> {
  if (!socketName) throw new Error('refusing to touch the default tmux server');
  const r = await execTmux(['-L', socketName, 'set-option', '-s', 'exit-empty', 'on']);
  if (!r.ok && r.timedOut) throw new Error('tmux set-option timed out');
}

/** Per-daemon budget: a dry run only counts; a real run suspends sessions one
 *  by one behind each bot's turn gate. A daemon that does not answer in time
 *  counts as failed — the caller never hangs on it. */
export const TMUX_FANOUT_DRY_TIMEOUT_MS = 15_000;
export const TMUX_FANOUT_RUN_TIMEOUT_MS = 120_000;

/**
 * Ask EVERY online daemon to suspend (or, dry run, count) its idle tmux
 * sessions on `socketName`. Each daemon owns only its own bot's live workers,
 * so the server can only empty out if all of them take part; a daemon that
 * does not answer is reported in `failed` (the idle switch then waits, and
 * "switch now" falls through to kill-server for whatever is left).
 */
export async function fanOutTmuxSwitchSuspend(
  request: TmuxSwitchSuspendRequest,
  io: {
    listDaemons?: () => Array<{ ipcPort: number }>;
    fetchIpc?: typeof fetchDaemonIpc;
    timeoutMs?: number;
  } = {},
): Promise<TmuxFanOutResult> {
  const daemons = (io.listDaemons ?? listOnlineDaemons)();
  const fetchIpc = io.fetchIpc ?? fetchDaemonIpc;
  const timeoutMs = io.timeoutMs ?? (request.dryRun ? TMUX_FANOUT_DRY_TIMEOUT_MS : TMUX_FANOUT_RUN_TIMEOUT_MS);
  if (daemons.length === 0) return { candidates: 0, affected: 0, failed: 1 };
  const results = await Promise.all(daemons.map(async d => {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await Promise.race([
        fetchIpc(d.ipcPort, '/api/tmux-upgrade/suspend-idle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      }),
        // Belt and braces: do not trust every transport to honour the signal.
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
      ]);
      const body: any = await Promise.race([
        res.json().catch(() => ({})),
        new Promise(resolve => signal.addEventListener('abort', () => resolve({}), { once: true })),
      ]);
      if (res.ok && body?.ok && typeof body.candidates === 'number' && typeof body.affected === 'number') {
        return { candidates: body.candidates as number, affected: body.affected as number };
      }
      return null;
    } catch {
      return null;
    }
  }));
  let candidates = 0;
  let affected = 0;
  let failed = 0;
  for (const r of results) {
    if (!r) { failed++; continue; }
    candidates += r.candidates;
    affected += r.affected;
  }
  return { candidates, affected, failed };
}

/** `botmux status` line for the tmux situation, or null when all is well. */
export function formatTmuxStatusAdvice(
  facts: TmuxFacts,
  locale: Locale,
  recommendation: TmuxRecommendation = TMUX_RECOMMENDED_MIN,
): string | null {
  const phase = deriveTmuxFactPhase(facts, recommendation);
  if (phase === 'needs_upgrade') return tmuxRecommendationWarning(facts.client, locale, recommendation);
  if (phase === 'pending_switch') {
    return t('tmux_upgrade.status.pending_switch', {
      client: facts.client ?? '?',
      server: facts.server ?? '?',
      min: recommendation.version,
    }, locale);
  }
  return null;
}
