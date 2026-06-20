/**
 * Restart-report DM: after an *intentional* restart (manual /
 * auto-update), the primary daemon (bot-0) privately messages the owner a
 * summary — dashboard link, unfinished-session count, version, and (for an
 * update) the changelog. This replaces re-posting streaming cards into the
 * groups on restart (those stay silent now). See core/maintenance.ts and the
 * daemon startup wiring.
 */
import type { RestartKind } from '../services/restart-intent-store.js';
import { consumeRestartIntent } from '../services/restart-intent-store.js';
import { countActiveSessionsOnDisk } from '../services/session-store.js';
import { botmuxVersion } from '../utils/install-info.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';

export const GITHUB_REPO = 'deepcoldy/botmux';

export interface RestartReportInput {
  kind: RestartKind;
  /** Current (post-restart) botmux version. */
  version: string;
  /** Unfinished sessions across all bots. */
  sessionCount: number;
  dashboardUrl?: string;
  /** kind==='update' only: the version delta + changelog body. */
  oldVersion?: string;
  newVersion?: string;
  changelog?: string;
}

function vtag(v: string): string {
  return v.startsWith('v') ? v : `v${v}`;
}

/** The human-facing markdown body of the report. Pure — unit tested. */
export function buildRestartReportText(input: RestartReportInput, locale?: Locale): string {
  const lines: string[] = [];
  lines.push(input.kind === 'update'
    ? t('restart.updated_restarted', undefined, locale)
    : t('restart.restarted', undefined, locale));

  if (input.kind === 'update' && input.oldVersion && input.newVersion) {
    lines.push(t('restart.version_delta', { old: vtag(input.oldVersion), new: vtag(input.newVersion) }, locale));
  } else {
    lines.push(t('restart.version', { version: vtag(input.version) }, locale));
  }

  lines.push(t('restart.unfinished_sessions', { count: input.sessionCount }, locale));
  if (input.dashboardUrl) lines.push(t('restart.dashboard', { url: input.dashboardUrl }, locale));

  if (input.kind === 'update' && input.changelog && input.changelog.trim()) {
    lines.push('');
    lines.push(t('restart.changelog_label', undefined, locale));
    lines.push(input.changelog.trim());
  }
  return lines.join('\n');
}

/** Wrap the report body in a minimal Lark interactive card (JSON string). */
export function buildRestartReportCard(input: RestartReportInput, locale?: Locale): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: input.kind === 'update' ? 'green' : 'blue',
      title: { tag: 'plain_text', content: t('restart.card_title', undefined, locale) },
    },
    elements: [{ tag: 'markdown', content: buildRestartReportText(input, locale) }],
  });
}

export function releasesUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/tag/${vtag(version)}`;
}

export interface RestartReportWiring {
  /** Primary bot (bot-0) app id — the DM sender. */
  primaryLarkAppId: string;
  /** Owner to DM (bot-0's first resolved allowedUser); undefined → skip the DM. */
  ownerOpenId: string | undefined;
  dashboardUrl: string | undefined;
  /** Send the interactive card as a p2p DM to the owner. */
  sendCard: (openId: string, cardJson: string) => Promise<void>;
  now?: number;
  log?: (msg: string) => void;
}

/**
 * If an intentional-restart breadcrumb is pending, DM the owner a restart
 * summary (exactly once — the breadcrumb is consumed). A crash / pm2
 * auto-restart leaves no breadcrumb, so this stays silent. Call only on the
 * primary daemon after sessions are restored.
 */
export async function sendRestartReportIfPending(w: RestartReportWiring): Promise<void> {
  const log = w.log ?? (() => {});
  const intent = consumeRestartIntent(w.now ?? Date.now());
  if (!intent) return; // no breadcrumb → crash/reboot → stay silent
  if (!w.ownerOpenId) { log('restart-report: no owner configured — skipping DM'); return; }

  const locale = localeForBot(w.primaryLarkAppId);
  const sessionCount = countActiveSessionsOnDisk();
  const version = botmuxVersion();
  let changelog: string | undefined;
  if (intent.kind === 'update' && intent.newVersion) {
    changelog = (await fetchChangelog(intent.newVersion))
      ?? t('restart.changelog_link_fallback', { url: releasesUrl(intent.newVersion) }, locale);
  }
  const card = buildRestartReportCard({
    kind: intent.kind,
    version,
    sessionCount,
    dashboardUrl: w.dashboardUrl,
    oldVersion: intent.oldVersion,
    newVersion: intent.newVersion,
    changelog,
  }, locale);
  try {
    await w.sendCard(w.ownerOpenId, card);
    log(`restart-report sent (kind=${intent.kind}, sessions=${sessionCount})`);
  } catch (e) {
    log(`restart-report send failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Best-effort GitHub release notes for a version. null on any failure (offline,
 *  rate-limited, release not yet published) — caller falls back to a link. */
export async function fetchChangelog(newVersion: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${vtag(newVersion)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'botmux' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { body?: string };
    const notes = (body?.body ?? '').trim();
    return notes || null;
  } catch {
    return null;
  }
}
