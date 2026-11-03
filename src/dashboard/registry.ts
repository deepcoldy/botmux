import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_HEARTBEAT_STALE_MS } from '../utils/daemon-heartbeat.js';

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
  /** Random per-process audience for authenticated Workflow v3 mutations. */
  bootInstanceId?: string;
  /** Auth protocol advertised atomically with the boot identity. */
  workflowIpcProtocol?: string;
  /** Presence-based session-store capability. Copy only; never a write permit. */
  sessionStoreProtocol?: string;
  /** Running binary version. Copy only; never compared by size. */
  botmuxVersion?: string;
  lastHeartbeat: number;
  /**
   * open_ids of users the bot's allowedUsers list was resolved to (post-email
   * resolution). Used by dashboard's "Create new group" flow to pick a creator
   * bot whose scope contains the operator. Emails are stripped — only resolved
   * open_ids appear here. May be empty for bots with no allowlist configured.
   */
  resolvedAllowedUsers?: string[];
}

const STALE_MS = DAEMON_HEARTBEAT_STALE_MS;
const DEFAULT_REFRESH_MS = 15_000;

export type RegistryListener = (online: DaemonInfo[]) => void;

/**
 * Stable roster fingerprint used to tell a real roster change (bot added /
 * removed / renamed / re-indexed) apart from the 15s no-op poll and the 30s
 * heartbeat rewrites. Only fields the dashboard's Bot 配置 list keys off of are
 * included — a pure heartbeat bump (lastHeartbeat) must NOT change it, or the
 * `/events` bots.changed emitter would fire every poll. Order-independent.
 */
export function botsRosterSignature(online: DaemonInfo[]): string {
  return [...online]
    .map(d => `${d.larkAppId}:${d.botName ?? ''}:${d.cliId ?? ''}:${d.botIndex}`)
    .sort()
    .join('|');
}

/**
 * 名册的短摘要，只用来比「断线前后变没变」。`/events` 每条连接一建立就推一帧
 * `bots.roster` 带上它，前端拿它和断线前记住的值比对，决定要不要补发 `bots.changed`。
 *
 * 比 {@link botsRosterSignature} 多算进每个 daemon 的进程代次（bootInstanceId / pid /
 * startedAt）：标签页挂起期间某个 bot 停掉、改了配置再起来，签名前后一模一样，可配置
 * 已经变了——只比签名就会漏补发，Bot 配置页继续显示旧值。心跳时间仍不算进来。
 * 只发摘要不发明文：这一帧每条连接都会收到，没必要把名册本身多送一遍。
 */
export function botsRosterDigest(online: DaemonInfo[]): string {
  const generations = [...online]
    .map(d => `${d.larkAppId}:${d.bootInstanceId ?? ''}:${d.pid}:${d.startedAt}`)
    .sort()
    .join('|');
  return createHash('sha256')
    .update(`${botsRosterSignature(online)}\n${generations}`)
    .digest('hex')
    .slice(0, 16);
}

/** `/events` 上关于 Bot 名册的一帧。 */
export type RosterFrame =
  | { event: 'bots.changed'; body: { signature: string; digest: string } }
  /**
   * `phase: 'connect'`：建流时的对账摘要，前端拿它和断线前的基线比，变了才补发
   * bots.changed。`phase: 'live'`：连接期间 daemon 原地重启（签名没变、代次变了），
   * 只同步基线、不触发刷新——否则下次挂起恢复会拿着过期基线白白补发一次，Bot 配置页
   * 重拉会卸掉编辑器、丢掉未保存的草稿。
   */
  | { event: 'bots.roster'; body: { digest: string; phase: 'connect' | 'live' } };

/**
 * 一条 `/events` 流的名册帧状态机：建流先给对账摘要；之后签名变了推 bots.changed
 * （行为同以往：只有名册真的变了才让页面重拉），签名没变但代次变了推 live 摘要，
 * 纯心跳变化什么都不推。
 */
export function trackRosterFrames(online: DaemonInfo[]): {
  connect: RosterFrame;
  next(online: DaemonInfo[]): RosterFrame | null;
} {
  let signature = botsRosterSignature(online);
  let digest = botsRosterDigest(online);
  return {
    connect: { event: 'bots.roster', body: { digest, phase: 'connect' } },
    next(current) {
      const nextSignature = botsRosterSignature(current);
      const nextDigest = botsRosterDigest(current);
      if (nextSignature !== signature) {
        signature = nextSignature;
        digest = nextDigest;
        return { event: 'bots.changed', body: { signature, digest } };
      }
      if (nextDigest === digest) return null;
      digest = nextDigest;
      return { event: 'bots.roster', body: { digest, phase: 'live' } };
    },
  };
}

export interface DaemonRegistryOptions {
  refreshIntervalMs?: number;
  /**
   * Coalescing window for fs.watch-triggered refreshes: the first event arms one
   * refresh this many ms later and every further event inside the window is
   * absorbed by it (default DEFAULT_WATCH_DEBOUNCE_MS; 0 = refresh on every
   * event, test-only). Fixed-delay rather than trailing so a long burst still
   * refreshes every window instead of being pushed out indefinitely.
   *
   * Every daemon rewrites its descriptor every 30s (heartbeat), atomically —
   * each rewrite is 2–4 watch events, and a fleet that started together
   * heartbeats together. On a 55-bot host that was ~220 watcher callbacks in a
   * 3–4s window every 30s, each one re-reading and re-parsing all 55 files and
   * fanning out to every listener: ~12,000 synchronous reads per burst on the
   * dashboard's event loop (measured with strace), the single largest stall on
   * that process. One refresh per quiet window sees the same final state.
   */
  watchDebounceMs?: number;
}

const DEFAULT_WATCH_DEBOUNCE_MS = 250;

/**
 * Watches the dashboard-daemons descriptor directory and exposes the
 * currently-online daemons (filtered by 90s heartbeat staleness).
 */
export class DaemonRegistry {
  private items = new Map<string, DaemonInfo>();
  private listeners = new Set<RegistryListener>();
  private watcher?: FSWatcher;
  private poller?: ReturnType<typeof setInterval>;
  private pendingWatchRefresh?: ReturnType<typeof setTimeout>;
  private refreshIntervalMs: number;
  private watchDebounceMs: number;

  constructor(private dir: string, options: DaemonRegistryOptions = {}) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  async start(): Promise<void> {
    this.refresh();
    if (!this.poller && this.refreshIntervalMs > 0) {
      this.poller = setInterval(() => this.refresh(), this.refreshIntervalMs);
      this.poller.unref?.();
    }
    try {
      this.watcher = watch(this.dir, { persistent: true }, () => this.scheduleWatchRefresh());
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
    if (this.pendingWatchRefresh) {
      clearTimeout(this.pendingWatchRefresh);
      this.pendingWatchRefresh = undefined;
    }
  }

  /** Coalesce a burst of watch events into one refresh after the burst goes quiet. */
  private scheduleWatchRefresh(): void {
    if (this.watchDebounceMs <= 0) { this.refresh(); return; }
    if (this.pendingWatchRefresh) return; // already armed — the refresh will see this event's effect too
    this.pendingWatchRefresh = setTimeout(() => {
      this.pendingWatchRefresh = undefined;
      this.refresh();
    }, this.watchDebounceMs);
    this.pendingWatchRefresh.unref?.();
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
        if (typeof d.sessionStoreProtocol !== 'string' || !d.sessionStoreProtocol) {
          delete d.sessionStoreProtocol;
        }
        if (typeof d.botmuxVersion !== 'string' || !d.botmuxVersion) {
          delete d.botmuxVersion;
        }
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
