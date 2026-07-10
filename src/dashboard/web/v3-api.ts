import type { RunSummary, RunView } from '../../workflows/v3/ops-projection.js';

export type V3Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface V3RunDetailOk {
  ok: true;
  view: RunView;
}

export interface V3RunDetailErr {
  ok: false;
  status: number;
}

export type V3RunDetailResult = V3RunDetailOk | V3RunDetailErr;

export function shouldProbeLegacyV2Fallback(status: number, alreadyTried: boolean): boolean {
  return status === 404 && !alreadyTried;
}

export async function fetchV3Runs(fetcher: V3Fetch = fetch): Promise<RunSummary[]> {
  const response = await fetcher('/api/v3/runs');
  if (!response.ok) return [];
  const body = await response.json() as { runs?: unknown };
  return Array.isArray(body.runs) ? body.runs as RunSummary[] : [];
}

export async function fetchV3RunDetail(runId: string, fetcher: V3Fetch = fetch): Promise<V3RunDetailResult> {
  const response = await fetcher(`/api/v3/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, view: await response.json() as RunView };
}

export async function probeLegacyV2RunSnapshot(runId: string, fetcher: V3Fetch = fetch): Promise<boolean> {
  const response = await fetcher(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`);
  return response.ok;
}
