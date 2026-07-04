import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export interface DaemonInfo {
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
    const now = Date.now();
    return [...this.items.values()].filter(d => now - d.lastHeartbeat <= STALE_MS);
  }

  getByAppId(id: string): DaemonInfo | undefined {
    const d = this.items.get(id);
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
        const d = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as DaemonInfo;
        next.set(d.larkAppId, d);
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
