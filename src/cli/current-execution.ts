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
  identityTurnId?: string;
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
    && (d.identityTurnId === undefined || identifier(d.identityTurnId))
    && Object.keys(d).every(key => ['schema', 'status', 'larkAppId', 'sessionId', 'chatId',
      'turnId', 'workerGeneration', 'dispatchAttempt', 'identityTurnId'].includes(key));
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

export const CURRENT_EXECUTION_IDENTITY_SCHEMA = 'botmux.current-execution-identity.v1' as const;
export const CURRENT_EXECUTION_IDENTITY_ROUTE = '/api/current-execution-identity';

const IDENTITY_TOOLS = ['lark-cli', 'bytedcli', 'codebase'] as const;
type IdentityToolName = typeof IDENTITY_TOOLS[number];
const identityTool = (value: unknown): value is IdentityToolName =>
  typeof value === 'string' && (IDENTITY_TOOLS as readonly string[]).includes(value);

export interface CurrentExecutionIdentityDocument {
  schema: typeof CURRENT_EXECUTION_IDENTITY_SCHEMA;
  status: 'verified';
  larkAppId: string;
  sessionId: string;
  tool: typeof IDENTITY_TOOLS[number];
  /** Turn whose identity is being served; always present in a verified reply. */
  identityTurnId: string;
  /** Rendered env assignment body the wrapper evals. Bounded: an identity is a
   *  couple of quoted values plus (for a denial) its human-readable message. */
  env: string;
}

export function isCurrentExecutionIdentityDocument(value: unknown): value is CurrentExecutionIdentityDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return d.schema === CURRENT_EXECUTION_IDENTITY_SCHEMA && d.status === 'verified'
    && identifier(d.larkAppId) && identifier(d.sessionId) && identityTool(d.tool)
    && identifier(d.identityTurnId)
    && typeof d.env === 'string' && d.env.length > 0 && d.env.length <= 16_384
    && Object.keys(d).every(key => ['schema', 'status', 'larkAppId', 'sessionId', 'tool',
      'identityTurnId', 'env'].includes(key));
}

/** Fetch the identity env BODY for the tool, proven by loopback process
 *  lineage. Distinct failures:
 *  - current_execution_route_unavailable: bad local arguments
 *  - current_execution_unverified: caller is not the current execution (403)
 *  - identity_material_unavailable: lineage proven, but no identity is
 *    published for this turn/tool (GC, daemon restart, not prepared)
 */
export async function resolveCurrentExecutionIdentity(options: {
  ipcPort: number;
  sessionId: string;
  larkAppId: string;
  tool: string;
  fetchImpl?: typeof fetch;
}): Promise<CurrentExecutionIdentityDocument> {
  if (!Number.isSafeInteger(options.ipcPort) || options.ipcPort <= 0 || options.ipcPort > 65535
    || !identifier(options.sessionId) || !identifier(options.larkAppId)
    || !identityTool(options.tool)) {
    throw new Error('current_execution_route_unavailable');
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${options.ipcPort}${CURRENT_EXECUTION_IDENTITY_ROUTE}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: options.sessionId, tool: options.tool }),
        redirect: 'error', signal: AbortSignal.timeout(5000),
      },
    );
  } catch (error) {
    // Network reachability failures are indistinguishable here from a refused
    // connection; fail closed. A loopback-isolated sandbox is rendered into
    // the single model upstream and never reaches this code.
    throw new Error('current_execution_unverified', { cause: error });
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) throw new Error('identity_material_unavailable');
  if (!response.ok || !isCurrentExecutionIdentityDocument(body)
    || body.sessionId !== options.sessionId || body.larkAppId !== options.larkAppId
    || body.tool !== options.tool) {
    throw new Error('current_execution_unverified');
  }
  return body;
}
