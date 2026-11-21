const THROTTLE_MS = 2_000;
const FULL_CHECK_MS = 60_000;
const DIRECTORIES = ['queues','turn-sends','group-context','output-delivery-journals'];
export interface IndexerClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
export interface IndexerWatch { close(): void }
export interface IndexerSchedulerOptions {
  clock: IndexerClock;
  watch(path: string, changed: (filename?: string) => void, failed: () => void): IndexerWatch | undefined;
  sync(options: { paths?: readonly string[]; shouldStop: () => boolean }): Promise<unknown>;
  onError(error: unknown): void;
  parentPid: number;
  readParentPid(): number;
  onParentLost(): void;
}

/** Scheduling has no filesystem, process or real-clock dependencies. */
export function createIndexerScheduler(options: IndexerSchedulerOptions): { start(): void; stop(): Promise<void> } {
  let stopping = false;
  let started = false;
  let running = false;
  let full = false;
  const paths = new Set<string>();
  const watches = new Map<string,IndexerWatch>();
  let throttle: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const pending = () => full || paths.size > 0;
  const shutdown = () => {
    stopping = true;
    if (throttle !== undefined) options.clock.clearTimeout(throttle);
    if (fallback !== undefined) options.clock.clearTimeout(fallback);
    for (const watcher of watches.values()) watcher.close();
    watches.clear();
  };
  const request = (path?: string) => {
    if (stopping) return;
    if (path === undefined) { full = true; paths.clear(); } else if (!full) paths.add(path);
    if (!running && throttle === undefined) throttle = options.clock.setTimeout(() => {
      throttle = undefined; drain();
    },THROTTLE_MS);
  };
  function attach(): void {
    if (stopping) return;
    for (const directory of ['',...DIRECTORIES]) {
      if (watches.has(directory)) continue;
      const watcher = options.watch(directory, filename => {
        if (!directory) {
          if (filename && DIRECTORIES.includes(filename)) {
            watches.get(filename)?.close(); watches.delete(filename);
            attach(); request();
          }
          return;
        }
        const name = filename?.replace(/-(wal|shm)$/,'');
        const extension = directory === 'group-context' ? 'sqlite' : directory === 'output-delivery-journals' ? 'db' : 'jsonl';
        if (name === undefined) request();
        else if (new RegExp(`^[A-Za-z0-9_-]+\\.${extension}$`).test(name)) request(`${directory}/${name}`);
      }, () => {
        watches.get(directory)?.close(); watches.delete(directory); request();
      });
      if (watcher) watches.set(directory,watcher);
    }
  }
  function drain(): void {
    if (running || stopping || !pending()) return;
    if (throttle !== undefined) { options.clock.clearTimeout(throttle); throttle = undefined; }
    running = true;
    active = (async () => {
      try {
        if (!stopping && pending()) {
          if (options.readParentPid() !== options.parentPid) { shutdown(); options.onParentLost(); return; }
          const selected = full ? undefined : [...paths];
          full = false; paths.clear();
          try { await options.sync({ paths: selected,shouldStop: () => stopping }); }
          catch (error) { options.onError(error); }
          attach();
        }
      } finally {
        running = false;
        if (!stopping && pending() && throttle === undefined) {
          throttle = options.clock.setTimeout(() => { throttle = undefined; drain(); },THROTTLE_MS);
        }
      }
    })();
  }
  const tick = () => {
    if (stopping) return;
    attach(); request();
    if (!stopping) fallback = options.clock.setTimeout(tick,FULL_CHECK_MS);
  };
  return {
    start() {
      if (started || stopping) return;
      started = true; attach(); full = true; drain();
      if (!stopping) fallback = options.clock.setTimeout(tick,FULL_CHECK_MS);
    },
    async stop() {
      shutdown(); await active;
    },
  };
}
