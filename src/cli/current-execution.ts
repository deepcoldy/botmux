import { loopbackFetchImpl } from '../core/loopback-fetch.js';

export const CURRENT_EXECUTION_SCHEMA = 'botmux.current-execution.v1' as const;
export const CURRENT_EXECUTION_ROUTE = '/api/current-execution';

export interface CurrentExecutionDocument {
  schema: typeof CURRENT_EXECUTION_SCHEMA;
  status: 'verified';
  larkAppId: string;
  sessionId: string;
  chatId: string;
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
}

const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0;

export function isCurrentExecutionDocument(value: unknown): value is CurrentExecutionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return d.schema === CURRENT_EXECUTION_SCHEMA && d.status === 'verified'
    && ['larkAppId', 'sessionId', 'chatId', 'turnId'].every(key => identifier(d[key]))
    && positive(d.workerGeneration)
    && (d.dispatchAttempt === undefined || positive(d.dispatchAttempt))
    && Object.keys(d).every(key => ['schema', 'status', 'larkAppId', 'sessionId', 'chatId',
      'turnId', 'workerGeneration', 'dispatchAttempt'].includes(key));
}

export function parseCurrentExecutionArgs(args: string[]): boolean {
  return args.length === 2 && args[0] === 'current' && args[1] === '--json';
}

/** Routing comes from the existing ancestor resolver. The daemon derives the
 * execution from its live socket peer; no spawn-time turn or capability is sent. */
export async function resolveCurrentExecution(options: {
  ipcPort: number;
  sessionId: string;
  larkAppId: string;
  fetchImpl?: typeof fetch;
}): Promise<CurrentExecutionDocument> {
  if (!Number.isSafeInteger(options.ipcPort) || options.ipcPort <= 0 || options.ipcPort > 65535
    || !identifier(options.sessionId) || !identifier(options.larkAppId)) {
    throw new Error('current_execution_route_unavailable');
  }
  const response = await (options.fetchImpl ?? loopbackFetchImpl)(
    `http://127.0.0.1:${options.ipcPort}${CURRENT_EXECUTION_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: options.sessionId }),
      redirect: 'error', signal: AbortSignal.timeout(5000),
    },
  );
  const body: unknown = await response.json();
  if (!response.ok || !isCurrentExecutionDocument(body)
    || body.sessionId !== options.sessionId || body.larkAppId !== options.larkAppId) {
    throw new Error('current_execution_unverified');
  }
  return body;
}
