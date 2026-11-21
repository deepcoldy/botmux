import fs, { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [mode, dataDir, readyFile, releaseFile] = process.argv.slice(2);
if (!dataDir || !readyFile || !releaseFile) throw new Error('usage: replay|off <dataDir> <ready> <release>');

if (mode === 'replay') {
  const { ensureCrossChatFollowThreadAtBinding } = await import('../../src/services/cross-chat-follow-thread-store.js');
  const actualRead = readFileSync;
  const gateRead = (path: Parameters<typeof readFileSync>[0], options: Parameters<typeof readFileSync>[1]) => {
    if (String(path).includes('.dashboard-secret.cross-chat-follow-thread')) {
      writeFileSync(readyFile, 'reading');
      while (!existsSync(releaseFile)) { /* cross-process rendezvous */ }
    }
    return actualRead(path, options);
  };
  fs.readFileSync = gateRead as typeof readFileSync;
  syncBuiltinESMExports();
  const bound = ensureCrossChatFollowThreadAtBinding({
    dataDir, sessionId: 'sess-a', sentAtMs: 1000, messageId: 'om_root_b', targetChatId: 'oc_followed',
  });
  console.log(JSON.stringify({ bound }));
} else if (mode === 'off') {
  const { recordCrossChatFollowThreadBinding } = await import('../../src/services/cross-chat-follow-thread-store.js');
  writeFileSync(readyFile, 'off-ready');
  const bound = recordCrossChatFollowThreadBinding(dataDir, 'sess-a', {
    sentAtMs: 2000, deliveryKind: 'detoured_send', targetRootMessageId: 'om_root_b',
    targetChatId: 'oc_followed', crossChatFollowThread: 'off',
  });
  console.log(JSON.stringify({ bound }));
} else {
  throw new Error(`unknown mode ${mode}`);
}
