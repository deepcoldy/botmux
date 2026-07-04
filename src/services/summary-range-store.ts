import {
  getBot,
  type BotConfig,
  type ContentTriggerConfig,
  type SummaryRangeConfig,
} from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

export const LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME = 'dashboard-default-summary-trigger';
export const DEFAULT_SUMMARY_LIMIT = 50;
export const DEFAULT_SUMMARY_SINCE_HOURS = 24;
export const DEFAULT_SUMMARY_PROMPT =
  '请根据当前会话历史生成总结。若是话题群，请总结当前话题；若是普通群，请总结配置范围内的群聊历史。总结需包含：背景、关键讨论、结论、待办事项。避免泄露无关隐私信息。';

export interface SummaryRangePrefs {
  limit: number;
  sinceHours: number;
}

export type SummaryRangeUpdateResult = {
  ok: true;
  summaryRange: SummaryRangePrefs;
} | {
  ok: false;
  reason: string;
};

function toNonNegativeInt(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

function normalizedRangeFromConfig(raw: SummaryRangeConfig | undefined): SummaryRangePrefs | undefined {
  if (!raw) return undefined;
  return {
    limit: toNonNegativeInt(raw.limit, DEFAULT_SUMMARY_LIMIT),
    sinceHours: toNonNegativeInt(raw.sinceHours, DEFAULT_SUMMARY_SINCE_HOURS),
  };
}

export function defaultSummaryRangePrefs(): SummaryRangePrefs {
  return {
    limit: DEFAULT_SUMMARY_LIMIT,
    sinceHours: DEFAULT_SUMMARY_SINCE_HOURS,
  };
}

export function summaryRangeFromLegacyContentTriggers(
  triggers: readonly ContentTriggerConfig[] | undefined,
): SummaryRangePrefs | undefined {
  const trigger = triggers?.find(t => t.name === LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME);
  if (!trigger) return undefined;
  return {
    limit: toNonNegativeInt(trigger.history.regularGroup.limit, DEFAULT_SUMMARY_LIMIT),
    sinceHours: toNonNegativeInt(trigger.history.regularGroup.sinceHours, DEFAULT_SUMMARY_SINCE_HOURS),
  };
}

export function summaryRangeFromBotConfig(config: Pick<BotConfig, 'summaryRange' | 'contentTriggers'>): SummaryRangePrefs {
  return normalizedRangeFromConfig(config.summaryRange)
    ?? summaryRangeFromLegacyContentTriggers(config.contentTriggers)
    ?? defaultSummaryRangePrefs();
}

type NormalizeSummaryRangeResult =
  | { ok: true; prefs: SummaryRangePrefs }
  | { ok: false; reason: string };

function normalizeSummaryRangePrefs(raw: unknown): NormalizeSummaryRangeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_json' };
  const body = raw as Record<string, unknown>;
  const limit = body.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return { ok: false, reason: 'invalid_limit' };
  const sinceHours = body.sinceHours;
  if (typeof sinceHours !== 'number' || !Number.isInteger(sinceHours) || sinceHours < 0) {
    return { ok: false, reason: 'invalid_since_hours' };
  }
  return { ok: true, prefs: { limit, sinceHours } };
}

function withoutLegacyDashboardSummaryTrigger(
  triggers: readonly ContentTriggerConfig[] | undefined,
): ContentTriggerConfig[] | undefined {
  if (!triggers) return undefined;
  const next = triggers.filter(t => t.name !== LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME);
  return next.length > 0 ? next : undefined;
}

export async function updateDashboardSummaryRange(
  larkAppId: string,
  rawBody: unknown,
): Promise<SummaryRangeUpdateResult> {
  const normalized = normalizeSummaryRangePrefs(rawBody);
  if (!normalized.ok) return normalized;
  const prefs = normalized.prefs;

  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const nextLegacyTriggers = withoutLegacyDashboardSummaryTrigger(bot.config.contentTriggers);
  const r = await rmwBotEntry<SummaryRangePrefs>(larkAppId, (entry) => {
    entry.summaryRange = { limit: prefs.limit, sinceHours: prefs.sinceHours };
    if (Array.isArray(entry.contentTriggers)) {
      const nextRaw = entry.contentTriggers.filter((t: unknown) =>
        !t || typeof t !== 'object' || Array.isArray(t) || (t as Record<string, unknown>).name !== LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME,
      );
      if (nextRaw.length > 0) entry.contentTriggers = nextRaw;
      else delete entry.contentTriggers;
    }
    return { write: true, result: prefs };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.summaryRange = { limit: prefs.limit, sinceHours: prefs.sinceHours };
  bot.config.contentTriggers = nextLegacyTriggers;
  logger.info(`[summary-range:${larkAppId}] dashboard summary range saved limit=${prefs.limit} sinceHours=${prefs.sinceHours}`);
  return { ok: true, summaryRange: summaryRangeFromBotConfig(bot.config) };
}
