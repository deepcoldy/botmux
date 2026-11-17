import { CodexRpcEngine } from '../../src/codex-rpc-engine.js';
import { captureCodexNativeProcesses, waitForCodexNativeRelease } from '../../src/core/codex-native-release.js';
import { spawn } from 'node:child_process';

const mode = process.argv[3];
// "timeout" simulates a release budget too short to prove the group is gone:
// swallow the engine's group signals so its bounded cleanup cannot verify
// removal (a timing-based 10ms budget is nondeterministic now that stopAndWait
// escalates to SIGKILL immediately instead of arming a 2s timer). The reply
// callback then reaps the survivor with a REAL group SIGKILL outside the engine,
// so the test's process-exit assertions stay deterministic.
const dependencies = mode === 'timeout'
  ? {
      spawnProcess: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, options),
      killProcessGroup: () => { /* signal swallowed: release unprovable */ },
    }
  : undefined;
const engine = new CodexRpcEngine(
  { cliBin: process.argv[2], cwd: process.cwd(), env: process.env },
  dependencies,
);
await engine.start();
const threadId = await engine.startThread();
process.send?.({ nativePid: engine.appServerPid, threadId });
process.on('message', async (message: any) => {
  if (mode === 'legacy') { engine.stop(); process.exit(0); }
  const snapshot = captureCodexNativeProcesses([engine.appServerPid!]);
  // stopAndWait fails closed (throws) when a verified group cannot be proven
  // gone within the caller's budget; the timeout mode drives exactly that path,
  // so report "release not proven" instead of crashing before the ticket replies.
  let released = false;
  try {
    released = await engine.stopAndWait(mode === 'timeout' ? 10 : 3500)
      && await waitForCodexNativeRelease(snapshot);
  } catch {
    released = false;
  }
  process.send?.({ type: 'codex_cleanup_released', ...message.codexCleanupRelease, released }, () => {
    if (mode === 'timeout' && engine.appServerPid) {
      // Real reaping the engine was made unable to verify in this mode.
      try { process.kill(-engine.appServerPid, 'SIGKILL'); } catch { /* gone */ }
    }
    process.exit(0);
  });
});
