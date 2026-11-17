/** Browser-safe contract for the read-only, host-local usage report. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  records: number;
  /** Sum of priced records only; null when none of the records are priced. */
  costCny: number | null;
  pricedRecords: number;
}

export interface UsageGroup extends UsageTotals {
  id: string;
}

export interface UsageSession extends UsageGroup {
  bot: string;
  title: string;
}

export interface UsageBreakdown extends UsageGroup {
  averageTpm: number | null;
  cacheReadShare: number | null;
}

/** Rates describe ledger settlement times, not model generation speed. */
export interface UsageMetrics {
  rateWindowEnd: string;
  elapsedMinutes: number | null;
  activeMinutes: number;
  averageTpm: number | null;
  averageOutputTpm: number | null;
  activeMinuteAverageTpm: number | null;
  peakMinuteTpm: number | null;
  peakMinuteAt: string | null;
  tokensPerRecordMean: number | null;
  tokensPerRecordP50: number | null;
  tokensPerRecordP95: number | null;
  tokensPerRecordMax: number | null;
  tokensPerSessionMean: number | null;
  cacheReadShare: number | null;
  outputInputRatio: number | null;
  pricedTokenShare: number | null;
  costPerMillionTokens: number | null;
}

export interface UsageQuery {
  from: string;
  to: string;
  timeZone: string;
  bot?: string;
  model?: string;
}

export interface UsageReport {
  query: UsageQuery;
  generatedAt: string;
  summary: UsageTotals;
  metrics: UsageMetrics;
  trend: UsageGroup[];
  bots: UsageBreakdown[];
  models: UsageBreakdown[];
  sessions: UsageSession[];
  sessionCount: number;
  options: { bots: string[]; models: string[] };
  coverage: {
    ledgerMissing: boolean;
    filesRead: number;
    invalidRecords: number;
    duplicateRecords: number;
    futureRecords: number;
    firstRecordAt: string | null;
    lastRecordAt: string | null;
  };
}
