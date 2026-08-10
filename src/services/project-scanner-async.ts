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
// repo scan. Bound each scan so a wedge is surfaced as a normal failure
// (progress card withdrawn + `/repo` text recovery) and the queue drains.
//
// The default must sit ABOVE the real-world upper bound: the reference
// deployment scans 134 repos in ~76s, so a 60s budget would guillotine the
// core case before it finishes and leave it permanently on the text fallback.
// 180s gives that ~2.4x headroom; BOTMUX_REPO_SCAN_TIMEOUT_MS can tighten it for
// diagnosis or loosen it for pathologically large trees.
const DEFAULT_SCAN_TIMEOUT_MS = 180_000;
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

    // The parent OWNS settlement — it must never depend on the child's 'close'
    // event to unblock the serialized queue. Under uninterruptible I/O (hung NFS)
    // even SIGKILL can stay pending indefinitely, so 'close' may never arrive.
    // settle() therefore resolves/rejects exactly once and detaches every child
    // listener so a later (or never) 'close' cannot double-settle or leak.
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Deliberately do NOT clear killTimer here: settlement only unblocks the
      // queue, it must never cancel the pending SIGKILL escalation. A child that
      // ignores SIGTERM (exactly the wedge case) would otherwise leak forever —
      // SIGTERM does nothing and the SIGKILL we just scheduled would be cancelled
      // by our own cleanup. The reap timer runs to completion and clears itself.
      child.removeAllListeners('message');
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      if (failure) {
        reject(failure);
      } else if (!response) {
        reject(new Error('Project scanner child produced no response'));
      } else if (!response.ok) {
        reject(new Error(response.error));
      } else {
        resolve(response.projects);
      }
    };

    // Bound the child: on timeout record a failure, SIGTERM it, schedule a
    // SIGKILL escalation, then settle the Promise immediately — WITHOUT waiting
    // for 'close'. The serialized queue drains right away; the SIGKILL still
    // fires after the grace period to reap a child that ignores SIGTERM, so no
    // wedged process is left behind.
    timeoutTimer = setTimeout(() => {
      failure ??= new Error(`Project scanner child timed out after ${scanTimeoutMs()}ms`);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, SCAN_KILL_GRACE_MS);
      killTimer.unref?.();
      settle();
    }, scanTimeoutMs());
    timeoutTimer.unref?.();

    // A clean exit (message/error/close before timeout) means the child is
    // already gone, so the pending reap timer — if any — is unnecessary. Clear it
    // only on the child's own 'close', never as part of settle().
    child.once('message', (message) => {
      response = message as ScanResponse;
      settle();
    });
    child.once('error', (error) => {
      failure ??= error;
      settle();
    });
    child.once('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (!failure && !response) {
        failure = new Error(`Project scanner child exited without a response (code=${code}, signal=${signal ?? 'none'})`);
      } else if (response?.ok && code !== 0 && code !== null) {
        failure ??= new Error(`Project scanner child exited with code ${code}`);
        response = undefined;
      }
      settle();
    });

    try {
      child.send(request, (error) => {
        if (!error) return;
        failure ??= error;
        try { child.kill(); } catch { /* already gone */ }
        settle();
      });
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      try { child.kill(); } catch { /* already gone */ }
      settle();
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
