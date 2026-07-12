import type { ResourceRankReason, ResourceSessionCurrent } from './types.js';

export interface TopSelectionInput {
  rows: ResourceSessionCurrent[];
  previous: Map<string, number>;
  nowMs: number;
  limit: number;
  graceMs: number;
  perReasonLimit: number;
}

export interface TopSelectionResult {
  trackedIds: string[];
  reasonsBySession: Map<string, ResourceRankReason[]>;
  topCpu: string[];
  topRss: string[];
  topGrowth: string[];
}

function topBy(rows: ResourceSessionCurrent[], limit: number, score: (row: ResourceSessionCurrent) => number): string[] {
  return [...rows]
    .filter(row => score(row) > 0)
    .sort((a, b) => score(b) - score(a) || a.sessionId.localeCompare(b.sessionId))
    .slice(0, Math.max(0, limit))
    .map(row => row.sessionId);
}

function addReason(reasonsBySession: Map<string, ResourceRankReason[]>, id: string, reason: ResourceRankReason): void {
  const reasons = reasonsBySession.get(id) ?? [];
  if (!reasons.includes(reason)) reasons.push(reason);
  reasonsBySession.set(id, reasons);
}

function addTracked(trackedIds: string[], id: string, limit: number): void {
  if (trackedIds.length >= limit || trackedIds.includes(id)) return;
  trackedIds.push(id);
}

export function selectTrackedSessions(input: TopSelectionInput): TopSelectionResult {
  const limit = Math.max(0, input.limit);
  const perReasonLimit = Math.max(0, input.perReasonLimit);
  const topCpu = topBy(input.rows, perReasonLimit, row => row.current.cpu1mPct);
  const topRss = topBy(input.rows, perReasonLimit, row => row.current.rssBytes);
  const topGrowth = topBy(input.rows, perReasonLimit, row => row.current.rssGrowth5mBytes);
  const reasonsBySession = new Map<string, ResourceRankReason[]>();
  for (const id of topCpu) addReason(reasonsBySession, id, 'cpu');
  for (const id of topRss) addReason(reasonsBySession, id, 'rss');
  for (const id of topGrowth) addReason(reasonsBySession, id, 'rssGrowth');

  const trackedIds: string[] = [];
  const lists = [topCpu, topRss, topGrowth];
  const maxLen = Math.max(...lists.map(list => list.length), 0);
  for (let i = 0; i < maxLen && trackedIds.length < limit; i++) {
    for (const list of lists) {
      const id = list[i];
      if (id) addTracked(trackedIds, id, limit);
      if (trackedIds.length >= limit) break;
    }
  }

  const currentIds = new Set(input.rows.map(row => row.sessionId));
  for (const [id, lastTrackedAt] of input.previous) {
    if (trackedIds.length >= limit) break;
    if (trackedIds.includes(id) || !currentIds.has(id)) continue;
    if (input.nowMs - lastTrackedAt <= input.graceMs) {
      addTracked(trackedIds, id, limit);
      addReason(reasonsBySession, id, 'grace');
    }
  }

  return { trackedIds, reasonsBySession, topCpu, topRss, topGrowth };
}
