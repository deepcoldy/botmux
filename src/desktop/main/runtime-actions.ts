import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import type { DashboardLocateResult, DesktopPaths, DesktopRuntimeState, LogTail } from '../shared/types.js';
import { listLogTargets, tailLogText } from './log-service.js';
import { validateDashboardCompat } from './dashboard-compat.js';
import type { createRuntimeService } from './runtime-service.js';

// Electron-free half of the desktop main process. Both the Electron IPC layer and
// the native-shell host (`botmux __desktop-host`) call these, so they must not
// import electron.
type RuntimeService = ReturnType<typeof createRuntimeService>;
type DashboardLocateFailureReason = Extract<DashboardLocateResult, { ok: false }>['reason'];

export interface RuntimeStateMonitor {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createRuntimeStateMonitor(args: {
  runtime: Pick<RuntimeService, 'getState'>;
  sendState: (state: DesktopRuntimeState) => void;
  intervalMs?: number;
}): RuntimeStateMonitor {
  const intervalMs = args.intervalMs ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const state = await args.runtime.getState();
        // Push complete state snapshots; the renderer validates the IPC payload
        // before trusting it to drive controls or dashboard navigation.
        args.sendState(state);
      } catch (error) {
        console.warn('[desktop] runtime state refresh failed', error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    refresh,
  };
}

export async function runRuntimeAction(
  action: () => ReturnType<RuntimeService['start']>,
  monitor: Pick<RuntimeStateMonitor, 'refresh'> | undefined,
) {
  const result = await action();
  // Action output returns immediately; the monitor refresh runs beside it so a
  // slow PM2/dashboard status path cannot keep renderer buttons disabled.
  void monitor?.refresh();
  return result;
}

export async function locateDashboard(runtime: RuntimeService): Promise<DashboardLocateResult> {
  const state = await runtime.getState();
  if (state.status !== 'running') {
    const message = state.message ?? 'Runtime is not running';
    const reason = state.status === 'degraded' ? classifyDashboardLocateFailure(message) : 'not_running';
    return {
      ok: false,
      reason: reason === 'unknown' ? 'not_running' : reason,
      message,
    };
  }

  const current = await runtime.currentDashboard();
  const currentUrl = current.code === 0 ? selectDesktopDashboardUrl(current.stdout) : '';
  if (currentUrl) return validateLocatedDashboard(currentUrl, 'current');
  if (!isNoActiveDashboardToken(current)) {
    const message = current.stderr.trim() || current.stdout.trim() || `Dashboard lookup failed with exit code ${current.code}`;
    return {
      ok: false,
      reason: classifyDashboardLocateFailure(message),
      message,
    };
  }

  const result = await runtime.dashboard();
  const url = result.code === 0 ? selectDesktopDashboardUrl(result.stdout) : '';
  if (url) {
    return validateLocatedDashboard(url, 'ensured');
  }

  const message = result.stderr.trim() || result.stdout.trim() || `Dashboard lookup failed with exit code ${result.code}`;
  return {
    ok: false,
    reason: classifyDashboardLocateFailure(message),
    message,
  };
}

export function selectDesktopDashboardUrl(output: string): string {
  const urls = extractHttpUrls(output);
  if (urls.length === 0) return output.trim();
  return urls.find(isLocalDashboardUrl) ?? urls[0] ?? output.trim();
}

function extractHttpUrls(output: string): string[] {
  return output
    .split(/\r?\n/)
    .flatMap(line => [...line.matchAll(/https?:\/\/[^\s]+/g)].map(match => trimUrlSuffix(match[0])))
    .filter(Boolean);
}

function trimUrlSuffix(url: string): string {
  return url.replace(/[),.;，。；）]+$/u, '');
}

function isLocalDashboardUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '[::1]'
      || isPrivateIpv4(host);
  } catch {
    return false;
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function validateLocatedDashboard(
  url: string,
  source: Extract<DashboardLocateResult, { ok: true }>['source'],
): Promise<DashboardLocateResult> {
  const compat = await validateDashboardCompat(url);
  if (!compat.ok) {
    return {
      ok: false,
      reason: compat.reason,
      message: compat.message,
    };
  }
  return { ok: true, url, source };
}

function isNoActiveDashboardToken(result: { stderr: string; stdout: string }): boolean {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return message.includes('no-active-token') || message.includes('no_active_token');
}

function classifyDashboardLocateFailure(message: string): DashboardLocateFailureReason {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('src/desktop/install-local.sh') ||
    normalized.includes('desktop 兼容') ||
    normalized.includes('兼容')
  ) return 'incompatible';
  if (normalized.includes('no-secret') || normalized.includes('.dashboard-secret') || normalized.includes('not initialised')) {
    return 'no_secret';
  }
  if (normalized.includes('wrong-service') || normalized.includes('不是 dashboard') || normalized.includes('not dashboard')) {
    return 'wrong_service';
  }
  if (
    normalized.includes('unreachable') ||
    normalized.includes('not reachable') ||
    normalized.includes('econnrefused') ||
    normalized.includes('timed out')
  ) {
    return 'unreachable';
  }
  return 'unknown';
}

export function listTargets(paths: DesktopPaths) {
  if (!existsSync(paths.logsDir)) return listLogTargets(paths.logsDir, []);
  try {
    const filenames = readdirSync(paths.logsDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
    return listLogTargets(paths.logsDir, filenames);
  } catch {
    return listLogTargets(paths.logsDir, []);
  }
}

export function tailLogTarget(paths: DesktopPaths, targetId: unknown): LogTail {
  // targetId is selected from a generated list, but validate again at the
  // bridge boundary because renderer state is not trusted.
  if (typeof targetId !== 'string') return { targetId: '', text: '', truncated: false };
  const target = listTargets(paths).find(candidate => candidate.id === targetId);
  if (!target) return { targetId, text: '', truncated: false };

  const text = target.files
    .flatMap(file => {
      try {
        return [`==> ${file}\n${readFileTail(file, 200_000)}`];
      } catch {
        return [];
      }
    })
    .join('\n');
  return { ...tailLogText(text, 200_000), targetId };
}

function readFileTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  const fd = openSync(file, 'r');
  try {
    // Read from the end of the file to keep large daemon logs responsive.
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    const actual = buffer.subarray(0, bytesRead);
    let start = 0;
    // Match log-service tailing and avoid returning invalid UTF-8 fragments.
    while (start < actual.length && (actual[start] & 0xc0) === 0x80) start += 1;
    return actual.subarray(start).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}
