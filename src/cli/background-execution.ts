import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotmuxAncestorContext } from './current-actor.js';
import { resolveEntrySpawn } from '../core/self-spawn.js';
import { loopbackFetchImpl } from '../core/loopback-fetch.js';
import { findOnlineDaemon, parseDaemonIpcPort } from '../utils/daemon-discovery.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';

export const BACKGROUND_REGISTRATION_ROUTE = '/api/current-execution-background';
export const BACKGROUND_REVOKE_ROUTE = '/api/current-execution-background/revoke';
type Launch = { kind: 'launch'; command: string[]; ttlSeconds: number };
type Revoke = { kind: 'revoke'; jobId: string };
export function parseBackgroundExecutionArgs(args: string[]): Launch | Revoke | null {
  if (args.length === 3 && args[0] === 'background-revoke' && args[2] === '--json'
    && /^[0-9a-f-]{36}$/.test(args[1])) return { kind: 'revoke', jobId: args[1] };
  if (args[0] !== 'background') return null;
  let offset = 1, ttlSeconds = 86_400;
  if (args[offset] === '--ttl-seconds') {
    ttlSeconds = Number(args[offset + 1]); offset += 2;
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 86_400
    || args[offset] !== '--' || !args[offset + 1] || args.slice(offset + 1).some(a => a.includes('\0'))) return null;
  return { kind: 'launch', command: args.slice(offset + 1), ttlSeconds };
}

interface BackgroundStarted {
  ok: true; jobId: string; sessionId: string; larkAppId: string; pid: number; expiresAt: number;
}
function isStarted(value: unknown, context: BotmuxAncestorContext): value is BackgroundStarted {
  const d = value as Partial<BackgroundStarted> | null;
  return !!d && d.ok === true && typeof d.jobId === 'string' && /^[0-9a-f-]{36}$/.test(d.jobId)
    && d.sessionId === context.sessionId && d.larkAppId === context.larkAppId
    && Number.isSafeInteger(d.pid) && d.pid! > 1 && Number.isFinite(d.expiresAt) && d.expiresAt! > Date.now();
}
async function request(context: BotmuxAncestorContext, route: string, body: object): Promise<unknown> {
  const port = parseDaemonIpcPort(findOnlineDaemon(context.larkAppId)?.ipcPort) ?? context.ipcPort;
  const response = await loopbackFetchImpl(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(10_000), body: JSON.stringify({ sessionId: context.sessionId, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error('background_execution_unverified');
  return data;
}
export async function revokeBackgroundExecution(context: BotmuxAncestorContext, jobId: string): Promise<void> {
  const response = await request(context, BACKGROUND_REVOKE_ROUTE, { jobId }) as { ok?: unknown };
  if (response?.ok !== true) throw new Error('background_execution_unverified');
}

/** Parent stays alive until the registered supervisor has actually spawned the job. */
export async function launchBackgroundExecution(context: BotmuxAncestorContext, launch: Launch,
  spawnEntry = resolveEntrySpawn('background-execution-runner', fileURLToPath(new URL('../', import.meta.url))),
): Promise<BackgroundStarted & { logPath: string }> {
  const logPath = join(mkdtempSync(join(tmpdir(), 'botmux-background-')), 'output.log');
  const fd = openSync(logPath, 'wx', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(spawnEntry.command, spawnEntry.args, { detached: true, stdio: ['ignore', fd, fd, 'ipc'],
      env: { ...process.env, BOTMUX: '1', BOTMUX_SESSION_ID: context.sessionId,
        BOTMUX_LARK_APP_ID: context.larkAppId, BOTMUX_DAEMON_IPC_PORT: String(context.ipcPort),
        BOTMUX_BACKGROUND_EXECUTION: JSON.stringify({ context, launch }) } });
  } finally { closeSync(fd); }
  const interrupt = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const started = await new Promise<BackgroundStarted>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('background_start_timeout')); }, 20_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', () => fail(new Error('background_start_failed')));
      child.on('message', value => {
        if (!isStarted(value, context) || value.pid !== child.pid) return;
        clearTimeout(timer); resolve(value);
      });
    });
    child.disconnect(); child.unref();
    return { ...started, logPath };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}

/** Runs as the persistent registered process root, not as a fleet daemon. */
export async function runBackgroundExecution(): Promise<void> {
  const bootstrap = process.env.BOTMUX_BACKGROUND_EXECUTION;
  delete process.env.BOTMUX_BACKGROUND_EXECUTION;
  if (!bootstrap || !process.send) throw new Error('background_launch_channel_required');
  const { context, launch } = JSON.parse(bootstrap) as { context: BotmuxAncestorContext; launch: Launch };
  if (!context || !Number.isSafeInteger(context.ipcPort) || context.ipcPort < 1 || context.ipcPort > 65535
    || typeof context.sessionId !== 'string' || typeof context.larkAppId !== 'string'
    || !launch || !Array.isArray(launch.command) || !launch.command.length
    || launch.command.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('invalid_background_launch');
  const job = await request(context, BACKGROUND_REGISTRATION_ROUTE, { ttlSeconds: launch.ttlSeconds });
  if (!isStarted(job, context) || job.pid !== process.pid) throw new Error('background_registration_failed');
  let child: ChildProcess | undefined;
  let childBirth: string | undefined;
  let stopping = false;
  let stopCompletion: Promise<void> | undefined;
  const settleGroup = async (signal: NodeJS.Signals): Promise<void> => {
    const pid = child?.pid;
    if (!pid) return;
    const stillOwned = () => {
      const currentBirth = readProcessStartIdentity(pid);
      // If the group leader has gone, its remaining group still reserves that
      // PID. If a live leader exists it must be the child we actually spawned.
      if (currentBirth && (!childBirth || currentBirth !== childBirth)) return false;
      try { process.kill(-pid, 0); return true; } catch { return false; }
    };
    if (!stillOwned()) return;
    try { process.kill(-pid, signal); } catch { return; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && stillOwned()) await new Promise(resolve => setTimeout(resolve, 25));
    if (stillOwned()) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    void revokeBackgroundExecution(context, job.jobId).catch(() => {});
    stopCompletion = settleGroup(signal);
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  try {
    child = spawn(launch.command[0], launch.command.slice(1), { stdio: 'inherit', detached: true });
    const code = await new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', value => resolve(value ?? 1));
      child!.once('spawn', () => {
        childBirth = readProcessStartIdentity(child!.pid!);
        process.send?.(job);
      });
    });
    if (!stopping) process.exitCode = code;
  } finally {
    try { await revokeBackgroundExecution(context, job.jobId); } catch { /* death/expiry still fences the record */ }
    // Keep the supervisor alive until its separate work group is settled,
    // even when the direct child exits normally before a grandchild.
    await (stopCompletion ?? settleGroup('SIGTERM'));
    if (process.connected) process.disconnect();
  }
}
