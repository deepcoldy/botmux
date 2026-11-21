#!/usr/bin/env node
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import { scrubClaudeSessionMarkerEnv,scrubInvokerTerminalEnv,scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,scrubWorkflowWorkerEnv,stripDashboardH5Env } from './utils/child-env.js';
installStdioEpipeGuard();
stripDashboardH5Env(process.env);
scrubSessionTurnMarkerEnv(process.env);
scrubSessionCliHomeEnv(process.env);
scrubClaudeSessionMarkerEnv(process.env);
scrubWorkflowWorkerEnv(process.env);
scrubInvokerTerminalEnv(process.env);
const parentPid = process.ppid;

async function main(): Promise<void> {
  if (process.env.BOTMUX_TOPIC_SEARCH === '0') return;
  const { watch } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolveBotmuxDataDir } = await import('./core/data-dir.js');
  const { createIndexerScheduler } = await import('./services/topic-search/indexer-scheduler.js');
  const { syncTopicIndex,assertTopicIndexEngine } = await import('./services/topic-search/index-store.js');
  const { logger } = await import('./utils/logger.js');
  // An unsupported engine cannot recover on a later filesystem event.
  assertTopicIndexEngine();
  const dataDir = resolveBotmuxDataDir();
  const scheduler = createIndexerScheduler({
    clock: {
      setTimeout: (callback,delay) => setTimeout(callback,delay),
      clearTimeout: timer => clearTimeout(timer),
    },
    watch(path,changed,failed) {
      try {
        const watcher = watch(join(dataDir,path),(_event,name) => changed(name?.toString()));
        watcher.on('error',error => { logger.warn('[topic-index] watch failed',error.message); failed(); });
        return { close: () => watcher.close() };
      } catch { return undefined; }
    },
    sync: options => syncTopicIndex(dataDir,options),
    onError: error => logger.error('[topic-index] sync failed; retry on next change or full check',error instanceof Error ? error.message : String(error)),
    parentPid,readParentPid: () => process.ppid,onParentLost: () => process.exit(0),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true; void scheduler.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  scheduler.start(); logger.info('[topic-index] started');
}
main().catch(error => { console.error('[topic-index] startup failed',error); process.exit(1); });
