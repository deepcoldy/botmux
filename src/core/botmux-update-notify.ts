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

export interface BotmuxUpdateRecipientState {
  nextCheckAt?: number;
  lastNotifiedVersion?: string;
  pending?: { version: string; uuid: string; createdAt: number };
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
        || !Number.isFinite(value.pending.createdAt) || value.pending.createdAt < 0))) {
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
  /** beforeWrite is rechecked by the transport after every rate-limit/retry wait. */
  send: (notice: BotmuxUpdateNotice, beforeWrite: () => void) => Promise<void>;
  now?: () => number;
  writeState?: typeof writeBotmuxUpdateNotifyState;
  log?: (message: string) => void;
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
          state.nextCheckAt = now() + BOTMUX_UPDATE_RETRY_MS;
          write(path, ledger); // Preserve pending UUID across transient lookup failures.
          return;
        }
        state.nextCheckAt = now() + BOTMUX_UPDATE_CHECK_MS;
        // A mirror regression must not overwrite an unresolved newer delivery
        // or discard its UUID. Retry the lookup within the dedupe window.
        if (state.pending && isNewerVersion(state.pending.version, latest)) {
          if (now() - state.pending.createdAt < BOTMUX_UPDATE_DEDUPE_MS) {
            state.nextCheckAt = now() + BOTMUX_UPDATE_RETRY_MS;
          }
          write(path, ledger);
          return;
        }
        if (!isNewerVersion(latest, currentVersion())
          || (state.lastNotifiedVersion && !isNewerVersion(latest, state.lastNotifiedVersion))) {
          write(path, ledger);
          return;
        }
        if (state.pending?.version === latest && now() - state.pending.createdAt >= BOTMUX_UPDATE_DEDUPE_MS) {
          write(path, ledger);
          deps.log?.(`delivery of v${latest} remains uncertain; automatic retry suspended`);
          return;
        }
        const beforeWrite = () => {
          if (stopped || !deps.enabled() || deps.ownerOpenId() !== owner
            || !parseVersion(currentVersion()) || !isNewerVersion(latest, currentVersion())
            || (state.pending?.version === latest && now() - state.pending.createdAt >= BOTMUX_UPDATE_DEDUPE_MS)) {
            throw new Error('update notification no longer applicable');
          }
        };
        beforeWrite();
        // Prepare durably before sending; retries reuse the Lark UUID even if the
        // response or the final ledger write is lost. Lark dedupes UUIDs for 1h.
        if (state.pending?.version !== latest) state.pending = { version: latest, uuid: randomUUID(), createdAt: now() };
        state.nextCheckAt = now() + BOTMUX_UPDATE_RETRY_MS;
        write(path, ledger);
        await deps.send({ ownerOpenId: owner, current: currentVersion(), latest, uuid: state.pending.uuid }, beforeWrite);
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
