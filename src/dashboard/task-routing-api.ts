/**
 * Dashboard 任务分配只读 / 试算接口（`/api/task-routing/*`）。
 *
 * 权限与默认关闭边界：
 * - 不在 `PUBLIC_READ_PATHS`，且 handler 内额外要求 `canManageHost === true`（未认证或
 *   只读/H5 访客一律 401，避免暴露本机 Bot 画像、实时负载和任务派发历史）。
 * - 全局 `taskRouting.enabled !== true` 时（合码标准 3.1）：
 *   - `GET /status`、`GET /history` 返回 200 `{ ok: true, enabled: false, ... }`，
 *     不探测 daemon，不创建 `task-routing.sqlite`；
 *   - `POST /recommend` 返回 403 `task_routing_disabled`（仅试算，不建群不写记录）。
 * - 全局配置（开关、全局派活原则、语义裁判）写入继续走 `PUT /api/settings`
 *   （`settings-write-applier.ts` + `patchGlobalTaskRoutingConfig` 共享文件锁），
 *   每 Bot 画像写入继续走 `PUT /api/bots/:appId/task-routing`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readGlobalTaskRoutingConfigLive } from '../global-config.js';
import {
  TASK_ROUTING_LIMITS,
  type TaskRoutingGlobalConfig,
  type TaskRoutingOutcome,
} from '../core/task-routing/model.js';
import {
  TaskRoutingError,
  getTaskRoutingStatus,
  listTaskRoutingHistory,
  recommendBotForTask,
  type TaskRoutingServiceDeps,
} from '../core/task-routing/service.js';

const PREFIX = '/api/task-routing';
const RECOMMEND_BODY_MAX_BYTES = 64 * 1024;
const VALID_OUTCOMES = new Set<TaskRoutingOutcome>(['pending', 'dispatched', 'fallback_dispatched', 'failed']);

export interface TaskRoutingApiDeps {
  canManageHost: boolean;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  dataDir?: string;
  readGlobalTaskRouting?: () => TaskRoutingGlobalConfig | undefined;
  serviceDeps?: Omit<TaskRoutingServiceDeps, 'dataDir' | 'readGlobalTaskRouting'>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function isJsonRequest(req: IncomingMessage): boolean {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function parseStringArray(raw: unknown): string[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export async function handleTaskRoutingApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: TaskRoutingApiDeps,
): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  if (!deps.canManageHost) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const tail = url.pathname.slice(PREFIX.length);
  const readGlobal = deps.readGlobalTaskRouting ?? readGlobalTaskRoutingConfigLive;
  const serviceDeps: TaskRoutingServiceDeps = {
    ...(deps.serviceDeps ?? {}),
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    readGlobalTaskRouting: readGlobal,
  };

  if (method === 'GET' && tail === '/status') {
    const cfg = readGlobal();
    if (cfg?.enabled !== true) {
      json(res, 200, {
        ok: true,
        enabled: false,
        matcherMode: cfg?.matcher?.mode ?? 'rule',
        matcherBotAppId: cfg?.matcher?.botAppId ?? null,
        matcherTimeoutMs: cfg?.matcher?.timeoutMs ?? TASK_ROUTING_LIMITS.defaultMatcherTimeoutMs,
        policy: cfg?.policy ?? '',
        eligible: [],
        excluded: [],
      });
      return true;
    }
    try {
      const status = await getTaskRoutingStatus(serviceDeps);
      const matcherBot = status.matcherBotAppId
        ? [...status.eligible, ...status.excluded].find(item => item.larkAppId === status.matcherBotAppId)
        : undefined;
      json(res, 200, {
        ok: true,
        enabled: true,
        matcherMode: status.matcherMode,
        matcherBotAppId: status.matcherBotAppId ?? null,
        matcherBotName: matcherBot?.name ?? null,
        matcherTimeoutMs: status.matcherTimeoutMs ?? TASK_ROUTING_LIMITS.defaultMatcherTimeoutMs,
        policy: status.policy ?? '',
        eligible: status.eligible,
        excluded: status.excluded,
      });
    } catch (err) {
      if (err instanceof TaskRoutingError) {
        json(res, err.status, { ok: false, error: err.code, message: err.message });
      } else {
        json(res, 500, { ok: false, error: 'task_routing_status_failed', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  }

  if (method === 'GET' && tail === '/history') {
    const cfg = readGlobal();
    if (cfg?.enabled !== true) {
      json(res, 200, { ok: true, enabled: false, records: [] });
      return true;
    }
    const limit = parseLimit(url.searchParams.get('limit'));
    const botRef = url.searchParams.get('bot')?.trim() || undefined;
    const rawOutcome = url.searchParams.get('outcome')?.trim() || undefined;
    let outcome: TaskRoutingOutcome | undefined;
    if (rawOutcome) {
      if (!VALID_OUTCOMES.has(rawOutcome as TaskRoutingOutcome)) {
        json(res, 400, { ok: false, error: 'invalid_outcome', message: `unsupported outcome filter: ${rawOutcome}` });
        return true;
      }
      outcome = rawOutcome as TaskRoutingOutcome;
    }
    try {
      const records = await listTaskRoutingHistory({ limit, botRef, outcome }, serviceDeps);
      json(res, 200, { ok: true, enabled: true, records });
    } catch (err) {
      if (err instanceof TaskRoutingError) {
        json(res, err.status, { ok: false, error: err.code, message: err.message });
      } else {
        json(res, 500, { ok: false, error: 'task_routing_history_failed', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  }

  if (method === 'POST' && tail === '/recommend') {
    if (!isJsonRequest(req)) {
      json(res, 400, { ok: false, error: 'bad_content_type', message: 'Content-Type must be application/json' });
      return true;
    }
    let body: unknown;
    try {
      body = await deps.readJsonBody(req, RECOMMEND_BODY_MAX_BYTES);
    } catch {
      json(res, 400, { ok: false, error: 'bad_json', message: 'Invalid JSON request body' });
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'Request body must be a JSON object' });
      return true;
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.task !== 'string' || !obj.task.trim()) {
      json(res, 400, { ok: false, error: 'empty_task', message: '任务描述不能为空' });
      return true;
    }
    if (obj.prefer !== undefined && obj.prefer !== null && typeof obj.prefer !== 'string') {
      json(res, 400, { ok: false, error: 'invalid_prefer', message: 'prefer must be a string' });
      return true;
    }
    if (obj.noLlm !== undefined && typeof obj.noLlm !== 'boolean') {
      json(res, 400, { ok: false, error: 'invalid_noLlm', message: 'noLlm must be a boolean' });
      return true;
    }
    const only = parseStringArray(obj.only);
    if (only === null) {
      json(res, 400, { ok: false, error: 'invalid_only', message: 'only must be an array of strings' });
      return true;
    }
    const exclude = parseStringArray(obj.exclude);
    if (exclude === null) {
      json(res, 400, { ok: false, error: 'invalid_exclude', message: 'exclude must be an array of strings' });
      return true;
    }
    const prefer = typeof obj.prefer === 'string' && obj.prefer.trim() ? obj.prefer.trim() : undefined;

    try {
      const result = await recommendBotForTask(
        {
          task: obj.task,
          constraints: {
            ...(prefer ? { prefer } : {}),
            ...(only ? { only } : {}),
            ...(exclude ? { exclude } : {}),
          },
          noLlm: obj.noLlm === true,
        },
        serviceDeps,
      );
      json(res, 200, { ok: true, decision: result.decision, constraints: result.constraints });
    } catch (err) {
      if (err instanceof TaskRoutingError) {
        json(res, err.status, { ok: false, error: err.code, message: err.message });
      } else {
        json(res, 500, { ok: false, error: 'task_routing_recommend_failed', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}
