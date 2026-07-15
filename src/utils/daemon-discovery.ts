/**
 * Lightweight cross-process discovery of online botmux daemons.
 *
 * Each daemon writes a descriptor file to `<dataDir>/dashboard-daemons/`
 * (containing larkAppId, ipcPort, pid, lastHeartbeat) and refreshes its
 * heartbeat periodically. Any other process — CLI subcommands, dashboard,
 * other daemons — can read this directory to discover live peers, no
 * shared in-memory state required.
 *
 * A daemon is considered offline if its heartbeat hasn't been refreshed in
 * the last STALE_MS (90s by default — matches dashboard/registry.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import {
  normalizePlatformDescriptor,
  type DescriptorCapabilities,
  type DescriptorPlatformRef,
} from '../im/platform-descriptor.js';

export interface OnlineDaemonInfo {
  platform: string;
  instanceId: string;
  capabilities?: DescriptorCapabilities;
  /** Legacy compatibility identity. Prefer platform + instanceId. */
  larkAppId: string;
  ipcPort: number;
  botName?: string;
  cliId?: string;
  pid?: number;
  lastHeartbeat?: number;
}

const STALE_MS = 90_000;

function registryDir(): string {
  return join(config.session.dataDir, 'dashboard-daemons');
}

function validPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= 65_535;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** List every daemon whose descriptor file is fresh (heartbeat within STALE_MS). */
export function listOnlinePlatformDaemons(): OnlineDaemonInfo[] {
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
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const identity = normalizePlatformDescriptor(parsed);
      if (!identity || !validPort(parsed.ipcPort) || !finiteNumber(parsed.lastHeartbeat)) continue;
      if (now - parsed.lastHeartbeat > STALE_MS) continue;
      out.push({
        ...identity,
        ipcPort: parsed.ipcPort,
        ...(typeof parsed.botName === 'string' && parsed.botName.trim() ? { botName: parsed.botName.trim() } : {}),
        ...(typeof parsed.cliId === 'string' && parsed.cliId.trim() ? { cliId: parsed.cliId.trim() } : {}),
        ...(finiteNumber(parsed.pid) ? { pid: parsed.pid } : {}),
        lastHeartbeat: parsed.lastHeartbeat,
      });
    } catch { /* malformed — skip */ }
  }
  return out;
}

/** Legacy Lark-only view used by A2A/relay callers keyed by larkAppId. */
export function listOnlineDaemons(): OnlineDaemonInfo[] {
  return listOnlinePlatformDaemons().filter(d => d.platform === 'lark');
}

/** Find a specific online daemon by larkAppId. Returns null if offline / not found. */
export function findOnlineDaemon(larkAppId: string): OnlineDaemonInfo | null {
  return listOnlineDaemons().find(d => d.platform === 'lark' && d.larkAppId === larkAppId) ?? null;
}

/** Find an online daemon by its complete platform-neutral instance identity. */
export function findOnlineDaemonByRef(ref: DescriptorPlatformRef): OnlineDaemonInfo | null {
  const platform = typeof ref?.platform === 'string' ? ref.platform.trim() : '';
  const instanceId = typeof ref?.instanceId === 'string' ? ref.instanceId.trim() : '';
  if (!platform || !instanceId) return null;
  return listOnlinePlatformDaemons().find(d => d.platform === platform && d.instanceId === instanceId) ?? null;
}
