/**
 * 任务分配页面（#/assign）与 Dashboard 后端 `/api/task-routing/*` 的请求封装。
 */

import { controlCsrfHeaders } from './control-csrf.js';
import type { TaskRoutingOutcome } from '../../core/task-routing/model.js';
import type {
  TaskRoutingHistoryResponse,
  TaskRoutingRecommendResponse,
  TaskRoutingStatusResponse,
} from './task-routing-model.js';

export class TaskRoutingApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TaskRoutingApiError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/task-routing';

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => undefined) as {
    ok?: boolean;
    error?: unknown;
    message?: unknown;
  } | undefined;
  if (!response.ok || !body || body.ok === false) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    const message = typeof body?.message === 'string' && body.message
      ? body.message
      : code || `HTTP ${response.status}`;
    throw new TaskRoutingApiError(message, response.status, code);
  }
  return body as T;
}

export function fetchTaskRoutingStatus(): Promise<TaskRoutingStatusResponse> {
  return requestJson<TaskRoutingStatusResponse>(`${BASE}/status`);
}

export function fetchTaskRoutingHistory(opts: {
  limit?: number;
  bot?: string;
  outcome?: TaskRoutingOutcome;
} = {}): Promise<TaskRoutingHistoryResponse> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.bot?.trim()) qs.set('bot', opts.bot.trim());
  if (opts.outcome) qs.set('outcome', opts.outcome);
  const query = qs.toString();
  return requestJson<TaskRoutingHistoryResponse>(`${BASE}/history${query ? `?${query}` : ''}`);
}

export function requestTaskRoutingRecommend(input: {
  task: string;
  prefer?: string;
  only?: string[];
  exclude?: string[];
  noLlm?: boolean;
}): Promise<TaskRoutingRecommendResponse> {
  return requestJson<TaskRoutingRecommendResponse>(`${BASE}/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...controlCsrfHeaders() },
    body: JSON.stringify(input),
  });
}
