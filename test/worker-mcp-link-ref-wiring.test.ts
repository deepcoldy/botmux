import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('worker MCP LinkRef resolve wiring', () => {
  it('carries the trusted delivery response kind to the daemon request', async () => {
    const pending = new Map<string, {
      resolve(value: { text: string; refCount: number }): void;
      reject(error: unknown): void;
    }>();
    const sent: Array<Record<string, unknown>> = [];
    const resolveThroughHost = loadWorkerFunction<(input: {
      identity: { turnId: string; dispatchAttempt: number; linkRefMode: 'enabled' };
      payload: { text: string };
      responseKind: 'final' | 'auxiliary';
    }) => Promise<{ text?: string; refCount: number }>>('resolveMcpLinkRefsThroughHost', {
      assertBoundedLinkRefIpcValue: vi.fn(),
      LINK_REF_RESOLVE_MAX_BODY_BYTES: 1024,
      randomUUID: () => 'request-id',
      pendingLinkRefResolutions: pending,
      sessionId: 'session-id',
      send: (message: Record<string, unknown>) => {
        sent.push(message);
        queueMicrotask(() => pending.get('request-id')!.resolve({ text: 'resolved', refCount: 1 }));
      },
    });

    await expect(resolveThroughHost({
      identity: { turnId: 'turn-id', dispatchAttempt: 3, linkRefMode: 'enabled' },
      payload: { text: 'draft' },
      responseKind: 'final',
    })).resolves.toEqual({ text: 'resolved', refCount: 1 });
    expect(sent).toEqual([expect.objectContaining({
      type: 'link_ref_resolve',
      requestId: 'request-id',
      sessionId: 'session-id',
      turnId: 'turn-id',
      dispatchAttempt: 3,
      responseKind: 'final',
      payload: { text: 'draft' },
    })]);
  });
});
