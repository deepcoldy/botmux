import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Session } from '../../src/types.js';
export const mockCleanupRelease = (row: Pick<Session, 'sessionId' | 'cliSessionId'>) => ({
  sessionId: row.sessionId, threadId: row.cliSessionId!, workerGeneration: 1, nonce: 'mock-native-release-nonce',
});
export function nativeReleaseWorker() {
  const worker = Object.assign(new EventEmitter(), { killed: false,
    send: vi.fn((message: any) => { queueMicrotask(() => {
      if (message.codexCleanupRelease) worker.emit('message', { type: 'codex_cleanup_released', ...message.codexCleanupRelease, released: true });
      worker.emit('exit', 0, null);
    }); }), kill: vi.fn() });
  return worker;
}
