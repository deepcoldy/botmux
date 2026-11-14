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
  trend: UsageGroup[];
  bots: UsageGroup[];
  models: UsageGroup[];
  sessions: UsageSession[];
  sessionCount: number;
  options: { bots: string[]; models: string[] };
  coverage: {
    ledgerMissing: boolean;
    filesRead: number;
    invalidRecords: number;
    duplicateRecords: number;
    firstRecordAt: string | null;
    lastRecordAt: string | null;
  };
}
