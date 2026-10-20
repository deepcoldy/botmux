import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { captureCodexCleanupRelease } from '../src/services/codex-cleanup-release.js';
const identity = { sessionId: 'mock-session', threadId: 'mock-thread', workerGeneration: 3 };
describe('native release ticket', () => {
  it('binds nonce/thread/generation and ignores wrong or duplicate messages', async () => {
    const worker = new EventEmitter(); const ticket = captureCodexCleanupRelease(worker as any, identity);
    let released = false; void ticket.released.then(() => { released = true; });
    for (const override of [{ nonce: 'other' }, { threadId: 'other' }, { workerGeneration: 2 }])
      worker.emit('message', { type: 'codex_cleanup_released', ...ticket.request, ...override, released: true });
    await Promise.resolve(); expect(released).toBe(false);
    const proof = { type: 'codex_cleanup_released', ...ticket.request, released: true };
    worker.emit('message', proof); worker.emit('message', proof);
    expect(await ticket.released).toEqual(ticket.request);
    expect(worker.listenerCount('message')).toBe(0);
  });
  it.each([0, 1, null])('rejects wrapper exit without native proof (%s)', async code => {
    const worker = new EventEmitter(); const ticket = captureCodexCleanupRelease(worker as any, identity);
    worker.emit('exit', code, null); await expect(ticket.released).rejects.toThrow('codex_native_release_unverified');
  });
  it('bounds a missing proof and removes listeners', async () => {
    const worker = new EventEmitter(); const ticket = captureCodexCleanupRelease(worker as any, identity, 10);
    await expect(ticket.released).rejects.toThrow('codex_native_release_timeout');
    expect(worker.listenerCount('message')).toBe(0);
  });
});
