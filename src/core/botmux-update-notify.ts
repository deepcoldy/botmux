/** Opt-in, host-wide version reminders. Never installs or restarts anything. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { botmuxInstallRoot, botmuxVersion } from '../utils/install-info.js';
import { currentUpdateStrategy } from './binary-install-shape.js';
import { fetchLatestVersion, fetchReleaseLatestVersion, isNewerVersion, parseVersion } from './update-check.js';
import { releasesUrl } from './restart-report.js';
import { t, type Locale } from '../i18n/index.js';

export const BOTMUX_UPDATE_CHECK_MS = 60 * 60_000;
export const BOTMUX_UPDATE_RETRY_MS = 5 * 60_000;
// Keep uncertain retries inside Lark's 1h UUID retention, including gate waits.
export const BOTMUX_UPDATE_DEDUPE_MS = 55 * 60_000;

export interface BotmuxUpdateNotice {
  ownerOpenId: string;
  current: string;
  latest: string;
  uuid: string;
}

export interface BotmuxUpdatePending {
  version: string;
  uuid: string;
  createdAt: number;
  /** Durable start of the uncertainty window. Fresh records use the first
   *  transport-guard passage; pre-existing records retain their original
   *  createdAt so an upgrade cannot extend the provider's UUID window.
   *  Its presence means a POST may have landed. */
  egressStartedAt?: number;
}

export interface BotmuxUpdateRecipientState {
  nextCheckAt?: number;
  lastNotifiedVersion?: string;
  pending?: BotmuxUpdatePending;
}

export interface BotmuxUpdateNotifyState {
  entries: Record<string, BotmuxUpdateRecipientState>;
}

export function readBotmuxUpdateNotifyState(path: string): BotmuxUpdateNotifyState {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: {} };
    throw error; // An unreadable delivery ledger must not silently lose deduplication.
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid update notification state');
  const ledger = raw as BotmuxUpdateNotifyState;
  if (!ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)) {
    throw new Error('invalid update notification state');
  }
  for (const value of Object.values(ledger.entries)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.nextCheckAt !== undefined && (!Number.isFinite(value.nextCheckAt) || value.nextCheckAt < 0))
      || (value.lastNotifiedVersion !== undefined && !parseVersion(value.lastNotifiedVersion))
      || (value.pending !== undefined && (!value.pending || !parseVersion(value.pending.version)
        || typeof value.pending.uuid !== 'string' || !/^[0-9a-f-]{36}$/.test(value.pending.uuid)
        || !Number.isFinite(value.pending.createdAt) || value.pending.createdAt < 0
        || (value.pending.egressStartedAt !== undefined
          && (!Number.isFinite(value.pending.egressStartedAt) || value.pending.egressStartedAt < 0))))) {
      throw new Error('invalid update notification state');
    }
  }
  return ledger;
}

export function writeBotmuxUpdateNotifyState(path: string, state: BotmuxUpdateNotifyState): void {
  atomicWriteFileSync(path, JSON.stringify(state) + '\n', { mode: 0o600, durable: true });
}

/** Matches the Dashboard's install-specific latest-version selection. */
export async function probeBotmuxLatestVersion(): Promise<string | null> {
  const strategy = currentUpdateStrategy(botmuxInstallRoot());
  return strategy.kind === 'self-replace' || strategy.kind === 'install-release'
    ? (await fetchReleaseLatestVersion()).version
    : fetchLatestVersion();
}

export function buildBotmuxUpdateNoticeCard(
  notice: Pick<BotmuxUpdateNotice, 'current' | 'latest'>,
  options: { dashboardUrl?: string; locale?: Locale } = {},
): string {
  const lines = [
    t('updateNotice.available', { version: `v${notice.latest}` }, options.locale),
    t('updateNotice.current', { version: `v${notice.current}` }, options.locale),
    t('updateNotice.release', { url: releasesUrl(notice.latest) }, options.locale),
  ];
  if (options.dashboardUrl) lines.push(t('restart.dashboard', { url: options.dashboardUrl }, options.locale));
  lines.push(t('updateNotice.manual', undefined, options.locale));
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: t('updateNotice.title', undefined, options.locale) } },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  });
}

export interface BotmuxUpdateNotifyDeps {
  dataDir: string;
  larkAppId: string;
  enabled: () => boolean;
  ownerOpenId: () => string | undefined;
  currentVersion?: () => string;
  fetchLatest?: () => Promise<string | null>;
  /** beforeWrite is rechecked by the transport after every rate-limit/retry wait;
   *  its first successful call also records possible provider egress durably. */
  send: (notice: BotmuxUpdateNotice, beforeWrite: () => void) => Promise<void>;
  now?: () => number;
  writeState?: typeof writeBotmuxUpdateNotifyState;
  log?: (message: string) => void;
}

class UpdateNotificationNotApplicableError extends Error {
  constructor() { super('update notification no longer applicable'); }
}

function isDeliveryUncertaintyExpired(pending: BotmuxUpdatePending | undefined, now: number): boolean {
  // A missing marker on a pre-existing record may come from an older writer
  // that already POSTed. Stay conservative; only this tick's freshly prepared
  // record is eligible for the pre-egress rollback below.
  const uncertaintyStartedAt = pending?.egressStartedAt ?? pending?.createdAt;
  return uncertaintyStartedAt !== undefined && now - uncertaintyStartedAt >= BOTMUX_UPDATE_DEDUPE_MS;
}

/** One controller per primary daemon. Disk lock also serializes overlapping processes. */
export function createBotmuxUpdateNotifier(deps: BotmuxUpdateNotifyDeps) {
  const path = join(deps.dataDir, 'botmux-update-notify.json');
  const now = deps.now ?? Date.now;
  const currentVersion = deps.currentVersion ?? botmuxVersion;
  const write = deps.writeState ?? writeBotmuxUpdateNotifyState;
  let inFlight = false;
  let stopped = false;
  let wasEnabled = false;
  let retryAfter = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    if (!deps.enabled()) { wasEnabled = false; return; }
    if (stopped || inFlight) return;
    const owner = deps.ownerOpenId();
    if (!owner) return;
    const force = !wasEnabled;
    wasEnabled = true;
    if (!force && retryAfter > now()) return;
    inFlight = true;
    try {
      mkdirSync(deps.dataDir, { recursive: true });
      await withFileLock(path, async () => {
        if (stopped || !deps.enabled() || deps.ownerOpenId() !== owner) return;
        const route = JSON.stringify([deps.larkAppId, owner]);
        const ledger = readBotmuxUpdateNotifyState(path);
        const state = ledger.entries[route] ??= {};
        if (!force && (state.nextCheckAt ?? 0) > now()) return;
        const current = currentVersion();
        if (!parseVersion(current)) return;
        const latest = await (deps.fetchLatest ?? probeBotmuxLatestVersion)();
        if (stopped || !deps.enabled() || deps.ownerOpenId() !== owner) return;
        if (!latest || !parseVersion(latest)) {
          const uncertaintyExpired = isDeliveryUncertaintyExpired(state.pending, now());
          state.nextCheckAt = now() + (uncertaintyExpired ? BOTMUX_UPDATE_CHECK_MS : BOTMUX_UPDATE_RETRY_MS);
          if (uncertaintyExpired) {
            deps.log?.(`delivery of v${state.pending!.version} remains uncertain while the version source is unavailable; automatic retry suspended`);
          }
          write(path, ledger); // Preserve pending UUID across transient lookup failures.
          return;
        }
        state.nextCheckAt = now() + BOTMUX_UPDATE_CHECK_MS;
        // A mirror regression must not overwrite an unresolved newer delivery
        // or discard its UUID. Retry the lookup within the dedupe window; once
        // the window has elapsed the suspension is logged like the same-version
        // path instead of staying silent on every later tick.
        if (state.pending && isNewerVersion(state.pending.version, latest)) {
          if (!isDeliveryUncertaintyExpired(state.pending, now())) {
            state.nextCheckAt = now() + BOTMUX_UPDATE_RETRY_MS;
          } else {
            deps.log?.(`delivery of v${state.pending.version} remains uncertain while the version source reports v${latest}; automatic retry suspended`);
          }
          write(path, ledger);
          return;
        }
        if (!isNewerVersion(latest, currentVersion())
          || (state.lastNotifiedVersion && !isNewerVersion(latest, state.lastNotifiedVersion))) {
          write(path, ledger);
          return;
        }
        if (state.pending?.version === latest && isDeliveryUncertaintyExpired(state.pending, now())) {
          write(path, ledger);
          deps.log?.(`delivery of v${latest} remains uncertain; automatic retry suspended`);
          return;
        }
        const assertApplicable = () => {
          if (stopped || !deps.enabled() || deps.ownerOpenId() !== owner
            || !parseVersion(currentVersion()) || !isNewerVersion(latest, currentVersion())
            || (state.pending?.version === latest && isDeliveryUncertaintyExpired(state.pending, now()))) {
            throw new UpdateNotificationNotApplicableError();
          }
        };
        assertApplicable();
        // Prepare durably before sending; retries reuse the Lark UUID even if the
        // response or the final ledger write is lost. Lark dedupes UUIDs for 1h.
        const preparedInThisTick = state.pending?.version !== latest;
        if (preparedInThisTick) state.pending = { version: latest, uuid: randomUUID(), createdAt: now() };
        state.nextCheckAt = now() + BOTMUX_UPDATE_RETRY_MS;
        write(path, ledger);
        const prepared = state.pending;
        if (!prepared) throw new Error('update notification pending state missing');
        const uuid = prepared.uuid;
        const beforeWrite = () => {
          assertApplicable();
          const pending = state.pending;
          if (!pending || pending.version !== latest || pending.uuid !== uuid) {
            throw new Error('update notification pending state changed');
          }
          if (pending.egressStartedAt === undefined) {
            // A crash after this durable write is conservatively treated as a
            // possible delivery, even if the process died before the actual POST.
            // Backfilling an older record must never extend its original UUID
            // retention window, so retain createdAt instead of restarting at now.
            pending.egressStartedAt = preparedInThisTick ? now() : pending.createdAt;
            write(path, ledger);
          }
        };
        try {
          await deps.send({ ownerOpenId: owner, current: currentVersion(), latest, uuid }, beforeWrite);
        } catch (error) {
          // A guard rejected the very first provider attempt for a record that
          // this tick created. Only that record is known not to carry a legacy
          // or mixed-version delivery, so its unused UUID can be rolled back.
          if (preparedInThisTick && error instanceof UpdateNotificationNotApplicableError
            && state.pending?.version === latest && state.pending.uuid === uuid
            && state.pending.egressStartedAt === undefined) {
            delete state.pending;
            write(path, ledger);
          }
          throw error;
        }
        state.lastNotifiedVersion = latest;
        delete state.pending;
        state.nextCheckAt = now() + BOTMUX_UPDATE_CHECK_MS;
        write(path, ledger);
        deps.log?.(`notified owner of v${latest}`);
      });
    } catch (error) {
      retryAfter = now() + BOTMUX_UPDATE_RETRY_MS;
      deps.log?.(`check/notification failed: ${error instanceof Error ? error.message : error}`);
    } finally { inFlight = false; }
  }

  return {
    tick,
    start() {
      if (timer) return;
      stopped = false;
      initialTimer = setTimeout(() => { initialTimer = undefined; void tick(); }, 20_000);
      initialTimer.unref?.();
      timer = setInterval(() => { void tick(); }, 60_000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (initialTimer) clearTimeout(initialTimer);
      timer = initialTimer = undefined;
    },
  };
}
