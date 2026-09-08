/**
 * Lightweight cross-process discovery of online botmux daemons.
 *
 * Each daemon writes a descriptor file to `<dataDir>/dashboard-daemons/`
 * (containing larkAppId, ipcPort, pid, lastHeartbeat, and optional protocol
 * audiences) and refreshes its heartbeat periodically. Any other process —
 * CLI subcommands, dashboard, other daemons — can read this directory to
 * discover live peers, no shared in-memory state required.
 *
 * A daemon is considered offline if its heartbeat hasn't been refreshed in
 * the last DAEMON_HEARTBEAT_STALE_MS (utils/daemon-heartbeat.ts — shared with
 * dashboard/registry.ts and the session-store occupancy lease TTL).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { DAEMON_HEARTBEAT_STALE_MS } from './daemon-heartbeat.js';

export interface OnlineDaemonInfo {
  larkAppId: string;
  ipcPort: number;
  /** Random per-process audience for authenticated Workflow v3 mutations. */
  bootInstanceId?: string;
  /** Auth protocol advertised atomically with bootInstanceId + ipcPort. */
  workflowIpcProtocol?: string;
  botName?: string;
  cliId?: string;
  pid?: number;
  lastHeartbeat?: number;
  /** botmux version of the process serving this daemon (from package.json).
   * Absent for daemons started by older builds. */
  version?: string;
}

/** `dataDir` lets a caller that already resolved a data dir keep the daemon
 *  probe and its store access on the SAME directory. Omitting it falls back to
 *  the process-wide resolution, which is what every host-CLI caller wants. */
function registryDir(dataDir?: string): string {
  return join(dataDir ?? resolveBotmuxDataDir(), 'dashboard-daemons');
}

/** Parse a loopback daemon IPC port from a descriptor or injected env value. */
export function parseDaemonIpcPort(value: unknown): number | undefined {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

/**
 * Prefer host-visible daemon discovery, then fall back to the port explicitly
 * injected into an isolated CLI. The fallback is only a loopback address
 * marker; individual daemon routes still authenticate their own requests.
 */
export function resolveDaemonIpcPort(
  discovered: unknown,
  injected: unknown,
): number | undefined {
  return parseDaemonIpcPort(discovered) ?? parseDaemonIpcPort(injected);
}

/** List every daemon whose descriptor file is fresh (heartbeat within STALE_MS). */
export function listOnlineDaemons(dataDir?: string): OnlineDaemonInfo[] {
  const dir = registryDir(dataDir);
  if (!existsSync(dir)) return [];
  const now = Date.now();
  const out: OnlineDaemonInfo[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const d = JSON.parse(raw) as Partial<OnlineDaemonInfo>;
      if (typeof d.ipcPort !== 'number' || typeof d.larkAppId !== 'string') continue;
      if (now - (d.lastHeartbeat ?? 0) > DAEMON_HEARTBEAT_STALE_MS) continue;
      out.push({
        larkAppId: d.larkAppId,
        ipcPort: d.ipcPort,
        ...(typeof d.bootInstanceId === 'string' && d.bootInstanceId
          ? { bootInstanceId: d.bootInstanceId }
          : {}),
        ...(typeof d.workflowIpcProtocol === 'string' && d.workflowIpcProtocol
          ? { workflowIpcProtocol: d.workflowIpcProtocol }
          : {}),
        ...(typeof d.botName === 'string' && d.botName.trim() ? { botName: d.botName.trim() } : {}),
        ...(typeof d.cliId === 'string' && d.cliId.trim() ? { cliId: d.cliId.trim() } : {}),
        pid: d.pid,
        lastHeartbeat: d.lastHeartbeat,
        ...(typeof d.version === 'string' && d.version.trim() ? { version: d.version.trim() } : {}),
      });
    } catch { /* malformed — skip */ }
  }
  return out;
}

/** Find a specific online daemon by larkAppId. Returns null if offline / not found. */
export function findOnlineDaemon(larkAppId: string, dataDir?: string): OnlineDaemonInfo | null {
  return listOnlineDaemons(dataDir).find(d => d.larkAppId === larkAppId) ?? null;
}

/**
 * Compare the running CLI's version against the versions advertised by online
 * daemons. Returns the first mismatching daemon version, or null when every
 * daemon matches or no meaningful comparison is possible.
 *
 * - Daemons started by older builds don't publish a version field — skipped
 *   (backward compat), never treated as a mismatch.
 * - A source checkout reports '0.0.0' (the real version is injected only at
 *   publish time). When the CLI itself runs from a checkout there is nothing
 *   sensible to compare, so the check is skipped entirely rather than emitting
 *   noise against daemons that may also be 0.0.0.
 */
export function detectDaemonVersionMismatch(
  cliVersion: string,
  daemons: OnlineDaemonInfo[],
): string | null {
  const cli = cliVersion.trim();
  if (!cli || cli === '0.0.0') return null;
  for (const d of daemons) {
    const daemonVersion = (d.version ?? '').trim();
    if (!daemonVersion) continue;
    if (daemonVersion !== cli) return daemonVersion;
  }
  return null;
}
