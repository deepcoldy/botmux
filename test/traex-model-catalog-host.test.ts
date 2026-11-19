import { describe, expect, it, vi } from 'vitest';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

describe('host catalog cleanup before executor bootstrap', () => {
  it('routes catalog maintenance through the authenticated child channel before an executor is bound', async () => {
    const handleLegacyWorkerMessage = vi.fn(async () => {});
    const handle = loadWorkerPoolClosure<(msg: any) => Promise<void>>('handleWorkerMessage', {
      sessionController: {}, contractWorker: {}, handleLegacyWorkerMessage,
    });
    const msg = { type: 'traex_model_pool_prune', requestId: 'synthetic', availableModels: ['core'] };
    await handle(msg);
    expect(handleLegacyWorkerMessage).toHaveBeenCalledExactlyOnceWith(msg);
  });
});
