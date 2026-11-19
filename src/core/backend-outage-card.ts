/**
 * Rendering for backend-outage-coordinator.ts: the one status card each
 * affected topic gets (patched in place) and the one summary its bot owner
 * gets. Pure; the coordinator owns when and where they are delivered.
 */
import { cardHeader, larkMdDiv, wideCard, type CardHeaderTemplate } from '../im/lark/card-primitives.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import type { OutageCardView, OutageMemberState, OutageSummary } from './backend-outage-coordinator.js';

const HEADER_TEMPLATE: Record<OutageMemberState, CardHeaderTemplate> = {
  interrupted: 'orange',
  recovering: 'blue',
  recovered: 'green',
  failed: 'red',
  stopped: 'grey',
  dormant: 'grey',
};

function stateBody(view: OutageCardView, locale: Locale | undefined): string {
  const vars = { cliName: view.cliName, count: view.serverRetries };
  switch (view.state) {
    case 'interrupted':
      return view.serverRetries > 0
        ? t('card.outage.body_interrupted_retry', vars, locale)
        : t('card.outage.body_interrupted', vars, locale);
    case 'recovering':
      return t('card.outage.body_recovering', vars, locale);
    case 'recovered':
      return t('card.outage.body_recovered', vars, locale);
    case 'failed':
      return t(`card.outage.body_failed_${view.failure ?? 'cli_failed'}`, vars, locale);
    case 'stopped':
      return t('card.outage.body_stopped', vars, locale);
    case 'dormant':
      return t('card.outage.body_dormant', vars, locale);
  }
}

/** What happened to the turn that was running when the server went down.
 *  The restart-interruption notice the resumed CLI reports (folded into
 *  `notices`) is the authoritative answer once it arrives. */
function turnLine(view: OutageCardView, locale: Locale | undefined): string | undefined {
  if (!view.turnInFlight) return undefined;
  const vars = { cliName: view.cliName };
  if (view.state === 'interrupted' || view.state === 'recovering') return t('card.outage.turn_pending', vars, locale);
  if (view.state === 'recovered') return view.notices.length > 0 ? undefined : t('card.outage.turn_unknown', vars, locale);
  if (view.state === 'failed') return t('card.outage.turn_failed', vars, locale);
  if (view.state === 'dormant') return t('card.outage.turn_dormant', vars, locale);
  return undefined;
}

export function buildBackendOutageCard(view: OutageCardView, locale?: Locale): string {
  const elements: unknown[] = [
    larkMdDiv(t('card.outage.cause', { server: view.serverLabel, cliName: view.cliName }, locale)),
    larkMdDiv(stateBody(view, locale)),
  ];
  const turn = turnLine(view, locale);
  if (turn) elements.push(larkMdDiv(turn));
  for (const notice of view.notices) elements.push(larkMdDiv(notice));
  if (view.state === 'failed' && view.failure === 'cli_failed' && view.failureDetail) {
    elements.push(larkMdDiv(`${t('card.outage.failure_detail', undefined, locale)}\n${view.failureDetail}`));
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: t('card.outage.footnote', undefined, locale) }] });
  return JSON.stringify(wideCard({
    header: cardHeader(t(`card.outage.title_${view.state}`, { cliName: view.cliName }, locale), HEADER_TEMPLATE[view.state]),
    elements,
    // Patched in place for everyone in the chat, not just the viewer.
    extraConfig: { update_multi: true },
  }));
}

const SUMMARY_FAILED_LIST_MAX = 10;

function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The owner's one message for one outage episode (plain text). */
export function formatBackendOutageSummary(summary: OutageSummary, botName: string, locale?: Locale): string {
  const affected = summary.members.filter(m => m.state !== 'stopped');
  const recovered = affected.filter(m => m.state === 'recovered');
  const failed = affected.filter(m => m.state === 'failed');
  const dormant = affected.filter(m => m.state === 'dormant').length;
  const stopped = summary.members.length - affected.length;
  const lines = [
    t('owner.outage.summary_title', { bot: botName }, locale),
    t('owner.outage.summary_body', { server: summary.serverLabel, start: clock(summary.startedAt), total: affected.length }, locale),
    t('owner.outage.summary_result', {
      recovered: recovered.length,
      failed: failed.length,
      dormant: dormant > 0 ? t('owner.outage.summary_dormant', { count: dormant }, locale) : '',
      stopped: stopped > 0 ? t('owner.outage.summary_stopped', { count: stopped }, locale) : '',
    }, locale),
  ];
  const serverBack = recovered.length > 0 || failed.some(m => m.failure !== 'server_unavailable');
  lines.push(summary.serverRetries === 0 && serverBack
    ? t('owner.outage.summary_server_first', undefined, locale)
    : serverBack
      ? t('owner.outage.summary_server_retried', { count: summary.serverRetries }, locale)
      : t('owner.outage.summary_server_failed', { count: summary.serverRetries }, locale));
  const turns = affected.filter(m => m.turnInFlight).length;
  if (turns > 0) lines.push(t('owner.outage.summary_turns', { count: turns }, locale));
  if (failed.length > 0) {
    lines.push(t('owner.outage.summary_failed_list', undefined, locale));
    for (const m of failed.slice(0, SUMMARY_FAILED_LIST_MAX)) {
      const reason = t(`owner.outage.reason.${m.failure ?? 'cli_failed'}`, undefined, locale);
      const title = m.title || m.sessionId.slice(0, 8);
      lines.push(locale === 'en' ? `· ${title} (${reason})` : `· ${title}（${reason}）`);
    }
    if (failed.length > SUMMARY_FAILED_LIST_MAX) {
      lines.push(t('owner.outage.summary_more', { count: failed.length - SUMMARY_FAILED_LIST_MAX }, locale));
    }
  }
  return lines.join('\n');
}
