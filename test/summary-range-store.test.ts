import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_SINCE_HOURS,
  LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME,
  defaultSummaryRangePrefs,
  summaryRangeFromBotConfig,
  summaryRangeFromLegacyContentTriggers,
} from '../src/services/summary-range-store.js';
import type { ContentTriggerConfig } from '../src/bot-registry.js';

const legacyDashboardTrigger: ContentTriggerConfig = {
  name: LEGACY_DASHBOARD_SUMMARY_TRIGGER_NAME,
  enabled: false,
  scope: 'both',
  match: { type: 'keyword', pattern: '总结', caseSensitive: false },
  history: {
    topic: { mode: 'current-thread' },
    regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
  },
  action: { type: 'start-or-wake-session', prompt: 'legacy prompt' },
};

describe('dashboard summary range', () => {
  it('defaults to 50 messages and 24 hours', () => {
    expect(defaultSummaryRangePrefs()).toEqual({
      limit: DEFAULT_SUMMARY_LIMIT,
      sinceHours: DEFAULT_SUMMARY_SINCE_HOURS,
    });
    expect(summaryRangeFromBotConfig({})).toEqual(defaultSummaryRangePrefs());
  });

  it('reads the old dashboard-managed trigger as a compatibility fallback', () => {
    expect(summaryRangeFromLegacyContentTriggers([legacyDashboardTrigger])).toEqual({
      limit: 0,
      sinceHours: 0,
    });
    expect(summaryRangeFromBotConfig({ contentTriggers: [legacyDashboardTrigger] })).toEqual({
      limit: 0,
      sinceHours: 0,
    });
  });

  it('prefers explicit summaryRange over legacy contentTriggers', () => {
    expect(summaryRangeFromBotConfig({
      summaryRange: { limit: 12, sinceHours: 6 },
      contentTriggers: [legacyDashboardTrigger],
    })).toEqual({
      limit: 12,
      sinceHours: 6,
    });
  });
});
