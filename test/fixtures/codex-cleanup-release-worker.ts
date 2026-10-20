import { CodexRpcEngine } from '../../src/codex-rpc-engine.js';
import { captureCodexNativeProcesses, waitForCodexNativeRelease } from '../../src/core/codex-native-release.js';
const engine = new CodexRpcEngine({ cliBin: process.argv[2], cwd: process.cwd(), env: process.env });
await engine.start();
const threadId = await engine.startThread();
process.send?.({ nativePid: engine.appServerPid, threadId });
process.on('message', async (message: any) => {
  if (process.argv[3] === 'legacy') { engine.stop(); process.exit(0); }
  const snapshot = captureCodexNativeProcesses([engine.appServerPid!]);
  const released = await engine.stopAndWait(process.argv[3] === 'timeout' ? 10 : 3500) && await waitForCodexNativeRelease(snapshot);
  process.send?.({ type: 'codex_cleanup_released', ...message.codexCleanupRelease, released }, () => process.exit(0));
});
