import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isExecutable } from '../utils/executable.js';

const ORCA_TIMEOUT_MS = 8_000;
const ORCA_MAX_BUFFER = 16 * 1024 * 1024;

export interface OrcaTerminalIdentity {
  handle: string;
  ptyId?: string | null;
  incarnationId?: string | null;
  executionHostId?: string;
  worktreeId: string;
  agentIdentity?: string;
  connected: boolean;
  writable: boolean;
}

export interface OrcaExpectedTerminalIdentity {
  terminalHandle: string;
  ptyId?: string;
  incarnationId?: string;
  executionHostId?: string;
  worktreeId: string;
  agentIdentity: string;
}

export function hasStableOrcaTerminalIdentity(
  terminal: Pick<OrcaTerminalIdentity, 'ptyId' | 'incarnationId'>,
): boolean {
  return !!(terminal.incarnationId || terminal.ptyId);
}

export function matchesOrcaTerminalIdentity(
  terminal: OrcaTerminalIdentity,
  expected: OrcaExpectedTerminalIdentity,
): boolean {
  if (!hasStableOrcaTerminalIdentity(expected)) return false;
  return terminal.connected === true
    && terminal.writable === true
    && terminal.handle === expected.terminalHandle
    && terminal.worktreeId === expected.worktreeId
    && terminal.agentIdentity === expected.agentIdentity
    && (!expected.ptyId || terminal.ptyId === expected.ptyId)
    && (!expected.incarnationId || terminal.incarnationId === expected.incarnationId)
    && (!expected.executionHostId || terminal.executionHostId === expected.executionHostId);
}

export type OrcaCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'missing' | 'unavailable' | 'error'; message: string };

interface OrcaEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: { code?: unknown; message?: unknown };
}

export function resolveOrcaBinary(): string {
  const candidates = [
    process.env.ORCA_REMOTE_CLI_BIN_DIR && join(process.env.ORCA_REMOTE_CLI_BIN_DIR, 'orca'),
    join(homedir(), '.orca-relay', 'bin', 'orca'),
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return 'orca';
}

function classifyFailure(message: string): OrcaCallResult<never> {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('terminal_not_found')
    || normalized.includes('terminal handle stale')
    || normalized.includes('terminal_handle_stale')
  ) {
    return { ok: false, kind: 'missing', message };
  }
  if (
    normalized.includes('runtime_unavailable')
    || normalized.includes('could not connect')
    || normalized.includes('cannot find the relay socket')
    || normalized.includes('connection timed out')
    || normalized.includes('socket error')
  ) {
    return { ok: false, kind: 'unavailable', message };
  }
  return { ok: false, kind: 'error', message };
}

function parseEnvelope<T>(stdout: string, stderr = ''): OrcaCallResult<T> {
  try {
    const parsed = JSON.parse(stdout) as OrcaEnvelope<T>;
    if (parsed.ok === true && parsed.result !== undefined) return { ok: true, value: parsed.result };
    const message = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : stderr.trim() || 'Orca command failed';
    return classifyFailure(message);
  } catch {
    return classifyFailure(stderr.trim() || stdout.trim() || 'Invalid Orca JSON response');
  }
}

function commandArgs(args: readonly string[]): string[] {
  return args.includes('--json') ? [...args] : [...args, '--json'];
}

export function callOrcaSync<T>(
  args: readonly string[],
  timeoutMs = ORCA_TIMEOUT_MS,
): OrcaCallResult<T> {
  try {
    const stdout = execFileSync(resolveOrcaBinary(), commandArgs(args), {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: ORCA_MAX_BUFFER,
    });
    return parseEnvelope<T>(stdout);
  } catch (error: any) {
    return parseEnvelope<T>(
      typeof error?.stdout === 'string' ? error.stdout : error?.stdout?.toString?.() ?? '',
      typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.() ?? error?.message ?? '',
    );
  }
}

export function callOrca<T>(
  args: readonly string[],
  timeoutMs = ORCA_TIMEOUT_MS,
): Promise<OrcaCallResult<T>> {
  return new Promise((resolve) => {
    execFile(resolveOrcaBinary(), commandArgs(args), {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: ORCA_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      resolve(parseEnvelope<T>(stdout ?? '', stderr || error?.message || ''));
    });
  });
}
