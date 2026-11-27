import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasBridgeReplyMarker,
  recordBridgeReplyMarker,
  withBridgeReplyMarkerLock,
} from '../../src/services/bridge-reply-marker.js';

const dataDir = process.env.BOTMUX_TEST_MARKER_DATA_DIR!;
const barrier = process.env.BOTMUX_TEST_MARKER_BARRIER!;
writeFileSync(join(barrier, `${process.pid}.ready`), 'ready');
const release = join(barrier, 'release');
const deadline = Date.now() + 15_000;
while (!existsSync(release)) {
  if (Date.now() >= deadline) throw new Error('marker race start barrier timed out');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
for (let attempt = 0; attempt < 20; attempt++) {
  // Deterministically overlap the existence checks. The production journal
  // lock serializes this window; removing it lets several writers see a miss.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  withBridgeReplyMarkerLock(dataDir, 'sid', () => {
    if (hasBridgeReplyMarker({
      dataDir, sessionId: 'sid', turnId: 'om_A', messageId: 'om_final', responseKind: 'final',
    })) return;
    recordBridgeReplyMarker({
      dataDir, sessionId: 'sid', sentAtMs: 1000, messageId: 'om_final',
      deliveryKind: 'current_session_send', content: 'done', responseKind: 'final', turnId: 'om_A',
    });
  });
}
console.log(`MARKER_RACE_DONE=${process.pid}`);
