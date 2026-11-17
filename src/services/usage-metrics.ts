import type { UsageBreakdown, UsageGroup, UsageMetrics, UsageTotals } from '../dashboard/usage-types.js';

export function emptyUsageMetrics(rateWindowEnd: string): UsageMetrics {
  return { rateWindowEnd, elapsedMinutes: null, activeMinutes: 0, averageTpm: null,
    averageOutputTpm: null, activeMinuteAverageTpm: null, peakMinuteTpm: null, peakMinuteAt: null,
    tokensPerRecordMean: null, tokensPerRecordP50: null, tokensPerRecordP95: null,
    tokensPerRecordMax: null, tokensPerSessionMean: null, cacheReadShare: null,
    outputInputRatio: null, pricedTokenShare: null, costPerMillionTokens: null };
}

const divide = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;
export function usageBreakdown(group: UsageGroup, elapsedMinutes: number): UsageBreakdown {
  return { ...group, averageTpm: divide(group.totalTokens, elapsedMinutes),
    cacheReadShare: divide(group.cacheReadTokens, group.inputTokens + group.cacheReadTokens + group.cacheCreateTokens) };
}

/** Samples have already passed ledger validation, time filtering and deduplication. */
export class UsageMetricsAccumulator {
  private readonly minutes = new Map<number, number>();
  private readonly recordTokens: number[] = [];
  private pricedTokens = 0;

  add(sample: { ts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; costCny: number | null }): void {
    const tokens = sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheCreateTokens;
    this.recordTokens.push(tokens);
    if (sample.costCny !== null) this.pricedTokens += tokens;
    if (tokens > 0) {
      // UTC epoch minutes distinguish the repeated local hour at a DST change.
      const minute = Math.floor(sample.ts / 60000) * 60000;
      this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + tokens);
    }
  }

  finish(summary: UsageTotals, sessionCount: number, fromMs: number, endMs: number): UsageMetrics {
    const metrics = emptyUsageMetrics(new Date(endMs).toISOString());
    const elapsedMinutes = Math.max(0, (endMs - fromMs) / 60000);
    metrics.elapsedMinutes = elapsedMinutes;
    metrics.averageTpm = divide(summary.totalTokens, elapsedMinutes);
    metrics.averageOutputTpm = divide(summary.outputTokens, elapsedMinutes);
    metrics.activeMinutes = this.minutes.size;
    metrics.activeMinuteAverageTpm = divide(summary.totalTokens, this.minutes.size);
    let peak: number | null = null;
    for (const [minute, tokens] of this.minutes) {
      if (metrics.peakMinuteTpm === null || tokens > metrics.peakMinuteTpm
        || (tokens === metrics.peakMinuteTpm && minute < peak!)) {
        peak = minute; metrics.peakMinuteTpm = tokens;
      }
    }
    metrics.peakMinuteAt = peak === null ? null : new Date(peak).toISOString();
    metrics.tokensPerRecordMean = divide(summary.totalTokens, summary.records);
    metrics.tokensPerSessionMean = divide(summary.totalTokens, sessionCount);
    const values = this.recordTokens.sort((a, b) => a - b), n = values.length;
    if (n) {
      metrics.tokensPerRecordP50 = n % 2 ? values[Math.floor(n / 2)]! : (values[n / 2 - 1]! + values[n / 2]!) / 2;
      metrics.tokensPerRecordP95 = values[Math.ceil(n * .95) - 1]!;
      metrics.tokensPerRecordMax = values[n - 1]!;
    }
    const input = summary.inputTokens + summary.cacheReadTokens + summary.cacheCreateTokens;
    metrics.cacheReadShare = divide(summary.cacheReadTokens, input);
    metrics.outputInputRatio = divide(summary.outputTokens, input);
    metrics.pricedTokenShare = divide(this.pricedTokens, summary.totalTokens);
    const unitCost = summary.costCny === null || this.pricedTokens === 0 ? NaN
      : summary.costCny / this.pricedTokens * 1_000_000;
    metrics.costPerMillionTokens = Number.isFinite(unitCost) ? unitCost : null;
    return metrics;
  }
}
