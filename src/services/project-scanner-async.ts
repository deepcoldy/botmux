import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ProjectInfo, ProjectScanOptions } from './project-scanner.js';

interface ScanRequest {
  baseDirs: string[];
  maxDepth: number;
  options: ProjectScanOptions;
}

// A scan child that loads and then wedges on a synchronous fs call (hung NFS
// mount, pathological directory tree — exactly the slow-scan case this async
// subsystem exists to isolate) never emits message/error/close, so runScan's
// Promise would otherwise never settle. Because scans are globally serialized
// (scanQueue), one wedged child would permanently block every later session's
// repo scan. Bound each scan so a wedge is killed and surfaced as a normal
// failure (progress card withdrawn + `/repo` text recovery) and the queue drains.
const DEFAULT_SCAN_TIMEOUT_MS = 60_000;
// After SIGTERM, give the child a brief grace period to unwind before SIGKILL —
// a child truly wedged in a blocking syscall may ignore SIGTERM.
const SCAN_KILL_GRACE_MS = 2_000;

function scanTimeoutMs(): number {
  const raw = Number(process.env.BOTMUX_REPO_SCAN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SCAN_TIMEOUT_MS;
}

type ScanResponse =
  | { ok: true; projects: ProjectInfo[] }
  | { ok: false; error: string };

function childEntryPoint(): { path: string; execArgv: string[] } {
  // Test/override seam: point the scanner at an alternate child entry (e.g. a
  // deliberately-hanging script) to exercise the timeout path without waiting on
  // a real wedge. Not used in production.
  const override = process.env.BOTMUX_REPO_SCANNER_CHILD;
  if (override && existsSync(override)) return { path: override, execArgv: [] };

  const compiledPath = fileURLToPath(new URL('./project-scanner-child.js', import.meta.url));
  if (existsSync(compiledPath)) return { path: compiledPath, execArgv: [] };

  return {
    path: fileURLToPath(new URL('./project-scanner-child.ts', import.meta.url)),
    execArgv: ['--import', 'tsx'],
  };
}

function runScan(request: ScanRequest): Promise<ProjectInfo[]> {
  return new Promise((resolve, reject) => {
    const entryPoint = childEntryPoint();
    const child = fork(entryPoint.path, [], {
      execArgv: entryPoint.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let response: ScanResponse | undefined;
    let failure: Error | undefined;

    // Bound the child: on timeout SIGTERM it, escalate to SIGKILL if it ignores
    // that, and record a timeout failure so the 'close' handler rejects. Killing
    // guarantees a 'close' event, which is what settles this Promise and lets the
    // serialized scanQueue drain past a wedged child.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      failure ??= new Error(`Project scanner child timed out after ${scanTimeoutMs()}ms`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, SCAN_KILL_GRACE_MS);
      killTimer.unref?.();
    }, scanTimeoutMs());
    timeoutTimer.unref?.();
    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.once('message', (message) => {
      response = message as ScanResponse;
    });
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code, signal) => {
      clearTimers();
      if (failure) {
        reject(failure);
      } else if (!response) {
        reject(new Error(`Project scanner child exited without a response (code=${code}, signal=${signal ?? 'none'})`));
      } else if (!response.ok) {
        reject(new Error(response.error));
      } else if (code !== 0) {
        reject(new Error(`Project scanner child exited with code ${code}`));
      } else {
        resolve(response.projects);
      }
    });

    try {
      child.send(request, (error) => {
        if (!error) return;
        failure ??= error;
        child.kill();
      });
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      child.kill();
    }
  });
}

let scanQueue: Promise<void> = Promise.resolve();

export function scanMultipleProjectsAsync(
  baseDirs: string[],
  maxDepth: number = 3,
  options: ProjectScanOptions = {},
): Promise<ProjectInfo[]> {
  const request: ScanRequest = {
    baseDirs: [...baseDirs],
    maxDepth,
    options: { ...options },
  };
  const result = scanQueue.then(() => runScan(request));
  scanQueue = result.then(() => undefined, () => undefined);
  return result;
}
