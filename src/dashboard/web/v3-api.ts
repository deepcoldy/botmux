import type { RunSummary, RunView } from '../../workflows/v3/ops-projection.js';
import type { V3RunStatus } from '../../workflows/v3/state.js';

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

export type V3RunCancelResult =
  | {
    ok: true;
    runId?: string;
    runStatus?: V3RunStatus;
    alreadyTerminal?: boolean;
  }
  | {
    ok: false;
    status: number;
    error: string;
  };

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

export async function cancelV3Run(runId: string, fetcher: V3Fetch = fetch): Promise<V3RunCancelResult> {
  const response = await fetcher(`/api/v3/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // The auth wall can return HTML; preserve only the HTTP status below.
  }
  if (!response.ok || body.ok === false) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === 'string' ? body.error : `http_${response.status}`,
    };
  }
  const rawStatus = body.status;
  return {
    ok: true,
    ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
    ...(isV3RunStatus(rawStatus) ? { runStatus: rawStatus } : {}),
    ...(body.alreadyTerminal === true ? { alreadyTerminal: true } : {}),
  };
}

function isV3RunStatus(value: unknown): value is V3RunStatus {
  return value === 'running' || value === 'cancelling' || value === 'cancelled' ||
    value === 'succeeded' || value === 'failed' || value === 'blocked';
}
