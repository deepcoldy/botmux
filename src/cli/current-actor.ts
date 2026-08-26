import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const CURRENT_ACTOR_SCHEMA = 'botmux.current-actor.v2' as const;
export const CURRENT_ACTOR_ROUTE = '/api/current-actor';

export interface CurrentActorDocument {
  schema: typeof CURRENT_ACTOR_SCHEMA;
  status: 'verified';
  actor: {
    email: string;
  };
}
export interface ResolveCurrentActorOptions {
  ipcPort: number;
  sessionId: string;
  fetchImpl?: typeof fetch;
}

export interface BotmuxAncestorContext {
  sessionId: string;
  larkAppId: string;
  ipcPort: number;
}

export class CurrentActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrentActorError';
  }
}

export function parseCurrentActorArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  return args.length === 2 && args[0] === 'current' && args[1] === '--json'
    ? { ok: true }
    : { ok: false, error: '用法: botmux actor current --json' };
}

export function normalizeActorEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CurrentActorError('current Lark actor has no verified email');
  }
  const email = value.trim().toLowerCase();
  const separator = email.indexOf('@');
  if (separator <= 0 || separator === email.length - 1 || email.indexOf('@', separator + 1) !== -1) {
    throw new CurrentActorError('current Lark actor email is invalid');
  }
  return email;
}

function parentPid(pid: number, procRoot: string): number | undefined {
  if (process.platform === 'linux' || procRoot !== '/proc') {
    try {
      const raw = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      const value = Number(fields[1]);
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }
  const ps = ['/usr/bin/ps', '/bin/ps'].find(existsSync);
  if (!ps) return undefined;
  try {
    const value = Number(execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

function processEnvironment(pid: number, procRoot: string): Record<string, string> | undefined {
  if (process.platform !== 'linux' && procRoot === '/proc') return undefined;
  try {
    const env: Record<string, string> = {};
    for (const item of readFileSync(`${procRoot}/${pid}/environ`).toString('utf8').split('\0')) {
      const separator = item.indexOf('=');
      if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1);
    }
    return env;
  } catch { return undefined; }
}

/** Read routing only from an already-running BotMux CLI ancestor. A child can
 * mutate its own env but cannot rewrite its parent's kernel-held environment. */
export function resolveBotmuxAncestorContext(
  startPid = process.ppid,
  procRoot = '/proc',
): BotmuxAncestorContext {
  if (process.platform !== 'linux' && procRoot === '/proc') {
    throw new CurrentActorError('current actor ancestor attestation is unsupported');
  }
  const contexts: BotmuxAncestorContext[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const env = processEnvironment(pid, procRoot);
    if (!env) throw new CurrentActorError('current actor ancestor attestation failed');
    if (env.BOTMUX === '1') {
      const ipcPort = Number(env.BOTMUX_DAEMON_IPC_PORT);
      if (!env.BOTMUX_SESSION_ID || !env.BOTMUX_LARK_APP_ID?.startsWith('cli_')
        || !Number.isSafeInteger(ipcPort) || ipcPort < 1 || ipcPort > 65_535) {
        throw new CurrentActorError('current actor ancestor attestation failed');
      }
      contexts.push({
        sessionId: env.BOTMUX_SESSION_ID,
        larkAppId: env.BOTMUX_LARK_APP_ID,
        ipcPort,
      });
    }
    const parent = parentPid(pid, procRoot);
    if (!parent) break;
    pid = parent;
  }
  if (contexts.length === 0 || contexts.some(context => (
    context.sessionId !== contexts[0].sessionId
    || context.larkAppId !== contexts[0].larkAppId
    || context.ipcPort !== contexts[0].ipcPort
  ))) {
    throw new CurrentActorError('current actor ancestor attestation failed');
  }
  return contexts[0];
}

function isCurrentActorDocument(value: unknown): value is CurrentActorDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.schema !== CURRENT_ACTOR_SCHEMA || document.status !== 'verified') return false;
  const actor = document.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
  const fields = actor as Record<string, unknown>;
  if (Object.keys(fields).length !== 1 || typeof fields.email !== 'string'
    || fields.email !== fields.email.trim()
    || fields.email !== fields.email.toLowerCase()) return false;
  try { return normalizeActorEmail(fields.email) === fields.email; }
  catch { return false; }
}

/**
 * Ask the owning daemon for the current human actor. The daemon identifies the
 * HTTP client through the live loopback socket, proves that process belongs to
 * the exact live CLI/worker generation, and reads sender identity from its
 * in-memory turn state. Environment values are routing hints only.
 */
export async function resolveCurrentActor(
  options: ResolveCurrentActorOptions,
): Promise<CurrentActorDocument> {
  if (!Number.isSafeInteger(options.ipcPort) || options.ipcPort <= 0 || options.ipcPort > 65_535) {
    throw new CurrentActorError('owning BotMux daemon port is unavailable');
  }
  if (!options.sessionId || options.sessionId.length > 256) {
    throw new CurrentActorError('current BotMux session is unavailable');
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `http://127.0.0.1:${options.ipcPort}${CURRENT_ACTOR_ROUTE}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: options.sessionId }),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    throw new CurrentActorError(
      `owning BotMux daemon is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CurrentActorError('owning BotMux daemon returned an invalid actor response');
  }
  if (!response.ok || !isCurrentActorDocument(payload)) {
    throw new CurrentActorError('current BotMux actor could not be verified by the owning daemon');
  }
  return payload;
}
