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
 * the last STALE_MS (90s by default — matches dashboard/registry.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';

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
}

const STALE_MS = 90_000;

function registryDir(): string {
  return join(resolveBotmuxDataDir(), 'dashboard-daemons');
}

/** List every daemon whose descriptor file is fresh (heartbeat within STALE_MS). */
export function listOnlineDaemons(): OnlineDaemonInfo[] {
  const dir = registryDir();
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
      if (now - (d.lastHeartbeat ?? 0) > STALE_MS) continue;
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
      });
    } catch { /* malformed — skip */ }
  }
  return out;
}

/** Find a specific online daemon by larkAppId. Returns null if offline / not found. */
export function findOnlineDaemon(larkAppId: string): OnlineDaemonInfo | null {
  return listOnlineDaemons().find(d => d.larkAppId === larkAppId) ?? null;
}
