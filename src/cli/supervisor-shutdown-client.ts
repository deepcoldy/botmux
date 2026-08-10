import { spawnSync } from 'node:child_process';
import { daemonIpcAuthHeaders } from '../core/daemon-ipc-auth.js';
import { readSupervisorProcessStartIdentity } from '../core/process-start-identity.js';
import { SUPERVISOR_SHUTDOWN_ROUTE } from '../core/supervisor-shutdown-ipc.js';
import type { AttestedPm2DaemonShutdownTarget } from './pm2-shutdown-capability.js';

export interface SupervisorShutdownHttpResult {
  status?: number;
  bodyRaw?: string;
  error?: string;
}

export interface SupervisorShutdownHttpInput {
  port: number;
  path: string;
  headers: Record<string, string>;
  bodyRaw: string;
  timeoutMs: number;
}

export interface SupervisorShutdownClientRuntime {
  readStartIdentity(pid: number): string | undefined;
  postMany(inputs: SupervisorShutdownHttpInput[]): SupervisorShutdownHttpResult[];
}

const SYNC_HTTP_SCRIPT = String.raw`
const http = require('node:http');
const inputs = JSON.parse(process.env.BOTMUX_SUPERVISOR_HTTP_REQUESTS);
function post(input) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = http.request({
      host: '127.0.0.1', port: input.port, path: input.path, method: 'POST', headers: input.headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => finish({ status: res.statusCode || 0, bodyRaw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(input.timeoutMs, () => req.destroy(new Error('supervisor shutdown request timed out')));
    req.on('error', err => finish({ error: String(err && err.message || err) }));
    req.end(input.bodyRaw);
  });
}
Promise.all(inputs.map(post)).then(results => process.stdout.write(JSON.stringify(results)));
`;

const defaultRuntime: SupervisorShutdownClientRuntime = {
  readStartIdentity: readSupervisorProcessStartIdentity,
  postMany(inputs): SupervisorShutdownHttpResult[] {
    if (inputs.length === 0) return [];
    const timeoutMs = Math.max(...inputs.map(input => input.timeoutMs));
    const result = spawnSync(process.execPath, ['-e', SYNC_HTTP_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs + 1_000,
      env: {
        ...process.env,
        BOTMUX_SUPERVISOR_HTTP_REQUESTS: JSON.stringify(inputs),
      },
    });
    if (result.status !== 0 || result.error) {
      throw new Error(
        result.error?.message
        ?? String(result.stderr || `synchronous HTTP helper exited ${result.status}`).trim(),
      );
    }
    try {
      const parsed = JSON.parse(String(result.stdout)) as SupervisorShutdownHttpResult[];
      if (!Array.isArray(parsed) || parsed.length !== inputs.length) {
        throw new Error('invalid helper result');
      }
      return parsed;
    } catch (error) {
      throw new Error(`invalid supervisor shutdown response transport: ${String(error)}`);
    }
  },
};

export interface SupervisorShutdownAttempt {
  target: AttestedPm2DaemonShutdownTarget;
  ok: boolean;
  error?: string;
}

function requestInput(
  target: AttestedPm2DaemonShutdownTarget,
  secret: string,
): SupervisorShutdownHttpInput {
  const bodyRaw = JSON.stringify({
    larkAppId: target.larkAppId,
    bootInstanceId: target.bootInstanceId,
    processStartIdentity: target.processStartIdentity,
  });
  const headers = daemonIpcAuthHeaders({
    secret,
    port: target.ipcPort,
    method: 'POST',
    path: SUPERVISOR_SHUTDOWN_ROUTE,
    headers: { 'content-type': 'application/json' },
  });
  return {
    port: target.ipcPort,
    path: SUPERVISOR_SHUTDOWN_ROUTE,
    headers: Object.fromEntries(headers.entries()),
    bodyRaw,
    timeoutMs: 4_000,
  };
}

function exactAck(
  target: AttestedPm2DaemonShutdownTarget,
  response: SupervisorShutdownHttpResult,
): boolean {
  if (response.status !== 202 || typeof response.bodyRaw !== 'string') return false;
  let body: Record<string, unknown> | undefined;
  try { body = JSON.parse(response.bodyRaw) as Record<string, unknown>; }
  catch { return false; }
  return body.ok === true
    && body.accepted === true
    && body.larkAppId === target.larkAppId
    && body.bootInstanceId === target.bootInstanceId
    && body.processStartIdentity === target.processStartIdentity;
}

/** Dispatch one bounded helper containing concurrent HTTP requests for the
 * whole initial fleet. One hung endpoint cannot delay request delivery to its
 * peers or consume N times the fleet budget. */
export function requestAttestedDaemonShutdownBatch(
  targets: readonly AttestedPm2DaemonShutdownTarget[],
  secret: string,
  runtime: SupervisorShutdownClientRuntime = defaultRuntime,
): SupervisorShutdownAttempt[] {
  const attempts = targets.map(target => ({ target, ok: false } as SupervisorShutdownAttempt));
  const eligible: Array<{ index: number; target: AttestedPm2DaemonShutdownTarget }> = [];
  for (const [index, target] of targets.entries()) {
    const currentStart = runtime.readStartIdentity(target.pid);
    if (!currentStart) {
      attempts[index]!.error = `daemon ${target.name}/${target.pid} exited before shutdown request`;
    } else if (currentStart !== target.processStartIdentity) {
      attempts[index]!.error = `daemon ${target.name}/${target.pid} process generation changed before shutdown request`;
    } else {
      eligible.push({ index, target });
    }
  }
  if (eligible.length === 0) return attempts;

  let responses: SupervisorShutdownHttpResult[];
  try {
    responses = runtime.postMany(eligible.map(({ target }) => requestInput(target, secret)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const { index } of eligible) attempts[index]!.error = message;
    return attempts;
  }
  for (let i = 0; i < eligible.length; i++) {
    const { index, target } = eligible[i]!;
    const response = responses[i] ?? { error: 'missing helper response' };
    if (exactAck(target, response)) {
      attempts[index] = { target, ok: true };
    } else {
      attempts[index]!.error = response.error
        ?? `daemon ${target.name}/${target.pid} rejected exact supervisor shutdown `
          + `(status ${response.status ?? 'transport-error'})`;
    }
  }
  return attempts;
}

/** Send a trusted-host request to the exact daemon boot/birth generation.
 * The receiving process performs the decisive in-process comparison; a
 * successor inheriting the port rejects rather than inheriting authority. */
export function requestAttestedDaemonShutdown(
  target: AttestedPm2DaemonShutdownTarget,
  secret: string,
  runtime: SupervisorShutdownClientRuntime = defaultRuntime,
): void {
  const attempt = requestAttestedDaemonShutdownBatch([target], secret, runtime)[0]!;
  if (!attempt.ok) throw new Error(attempt.error ?? `daemon ${target.name}/${target.pid} shutdown failed`);
}
