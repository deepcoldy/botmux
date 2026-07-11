import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  normalizePlatformDescriptor,
  platformDescriptorKey,
  type DescriptorCapabilities,
  type DescriptorPlatformRef,
} from '../im/platform-descriptor.js';

export interface DaemonInfo {
  platform: string;
  instanceId: string;
  capabilities?: DescriptorCapabilities;
  /** Legacy compatibility identity. Prefer platform + instanceId. */
  larkAppId: string;
  botName: string;
  /** CLI adapter id from bots.json, e.g. codex / claude-code / traex. */
  cliId?: string;
  /** Lark app avatar URL (from /bot/v3/info); absent until the open_id probe lands. */
  botAvatarUrl?: string;
  botIndex: number;
  ipcPort: number;
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
  /**
   * open_ids of users the bot's allowedUsers list was resolved to (post-email
   * resolution). Used by dashboard's "Create new group" flow to pick a creator
   * bot whose scope contains the operator. Emails are stripped — only resolved
   * open_ids appear here. May be empty for bots with no allowlist configured.
   */
  resolvedAllowedUsers?: string[];
}

const STALE_MS = 90_000;
const DEFAULT_REFRESH_MS = 15_000;

export type RegistryListener = (online: DaemonInfo[]) => void;

export interface DaemonRegistryOptions {
  refreshIntervalMs?: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value);
}

function validPort(value: unknown): value is number {
  return integer(value) && value > 0 && value <= 65_535;
}

function normalizeDaemonInfo(raw: unknown): DaemonInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const identity = normalizePlatformDescriptor(record);
  if (!identity) return null;
  if (typeof record.botName !== 'string' || !record.botName.trim()) return null;
  if (!integer(record.botIndex) || !validPort(record.ipcPort) || !integer(record.pid)) return null;
  if (!finiteNumber(record.startedAt) || !finiteNumber(record.lastHeartbeat)) return null;

  let resolvedAllowedUsers: string[] | undefined;
  if (record.resolvedAllowedUsers !== undefined) {
    if (!Array.isArray(record.resolvedAllowedUsers)
      || !record.resolvedAllowedUsers.every((entry) => typeof entry === 'string')) return null;
    resolvedAllowedUsers = [...record.resolvedAllowedUsers];
  }

  return {
    ...identity,
    botName: record.botName.trim(),
    ...(typeof record.cliId === 'string' && record.cliId.trim() ? { cliId: record.cliId.trim() } : {}),
    ...(typeof record.botAvatarUrl === 'string' && record.botAvatarUrl.trim()
      ? { botAvatarUrl: record.botAvatarUrl.trim() }
      : {}),
    botIndex: record.botIndex,
    ipcPort: record.ipcPort,
    pid: record.pid,
    startedAt: record.startedAt,
    lastHeartbeat: record.lastHeartbeat,
    ...(resolvedAllowedUsers === undefined ? {} : { resolvedAllowedUsers }),
  };
}

/**
 * Watches the dashboard-daemons descriptor directory and exposes the
 * currently-online daemons (filtered by 90s heartbeat staleness).
 */
export class DaemonRegistry {
  private items = new Map<string, DaemonInfo>();
  private listeners = new Set<RegistryListener>();
  private watcher?: FSWatcher;
  private poller?: ReturnType<typeof setInterval>;
  private refreshIntervalMs: number;

  constructor(private dir: string, options: DaemonRegistryOptions = {}) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  }

  async start(): Promise<void> {
    this.refresh();
    if (!this.poller && this.refreshIntervalMs > 0) {
      this.poller = setInterval(() => this.refresh(), this.refreshIntervalMs);
      this.poller.unref?.();
    }
    try {
      this.watcher = watch(this.dir, { persistent: true }, () => this.refresh());
    } catch {
      // Directory may not exist yet — caller is expected to ensure it exists
      // or the dashboard runs with an empty registry until the daemon writes.
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  list(): DaemonInfo[] {
    // Preserve the legacy dashboard contract: every existing consumer routes
    // through larkAppId and invokes Lark-only RPCs. Generic callers must opt in
    // to listAll()/getByRef() until those wire contracts become platform-aware.
    return this.listAll().filter(d => d.platform === 'lark');
  }

  listAll(): DaemonInfo[] {
    const now = Date.now();
    return [...this.items.values()].filter(d => now - d.lastHeartbeat <= STALE_MS);
  }

  getByAppId(id: string): DaemonInfo | undefined {
    const d = [...this.items.values()].find(item => item.platform === 'lark' && item.larkAppId === id);
    if (!d) return undefined;
    return Date.now() - d.lastHeartbeat > STALE_MS ? undefined : d;
  }

  /** Look up a daemon by the complete platform-neutral instance identity. */
  getByRef(ref: DescriptorPlatformRef): DaemonInfo | undefined {
    const platform = typeof ref?.platform === 'string' ? ref.platform.trim() : '';
    const instanceId = typeof ref?.instanceId === 'string' ? ref.instanceId.trim() : '';
    if (!platform || !instanceId) return undefined;
    const d = this.items.get(platformDescriptorKey({ platform, instanceId }));
    if (!d) return undefined;
    return Date.now() - d.lastHeartbeat > STALE_MS ? undefined : d;
  }

  on(fn: RegistryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private refresh(): void {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return; }
    const next = new Map<string, DaemonInfo>();
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const d = normalizeDaemonInfo(JSON.parse(readFileSync(join(this.dir, n), 'utf8')));
        if (!d) continue;
        next.set(platformDescriptorKey(d), d);
      } catch {
        // Skip malformed / partially-written files
      }
    }
    this.items = next;
    const online = this.list();
    for (const fn of this.listeners) {
      try { fn(online); } catch { /* swallow */ }
    }
  }
}
