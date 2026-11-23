import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DaemonToWorker } from '../src/types.js';
import { fixture, rows, useTraexAutoModelIntegrationCleanup } from './helpers/traex-auto-model-integration.js';

useTraexAutoModelIntegrationCleanup();

describe('catalog cleanup through real Worker IPC and PTY', () => {
  it('removes a retired first model before the only CLI launch and submits once', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, true,
      'working', 0, 0, false, false, undefined, undefined,
      { enabled: false, initialPrompt: 'synthetic catalog startup', catalogModels: ['backup', 'last'] });
    await f.wait(() => rows(f.submissions).length === 1, 'synthetic input committed');
    expect(rows(f.launches).map(row => row.model)).toEqual(['backup']);
    expect(rows(f.submissions)).toEqual([expect.objectContaining({
      model: 'backup', text: 'synthetic catalog startup',
    })]);
    expect(JSON.parse(readFileSync(f.poolConfigPath, 'utf8'))[0].traexAutoModel.models)
      .toEqual(['backup', 'last']);
    expect(f.noticeDeliveries).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'traex_model_pool_prune')).toHaveLength(1);
  }, 60_000);

  it('keeps the exact native history when repairing a retired restored model', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false,
      'working', 0, 0, false, false, undefined, undefined,
      { enabled: false, catalogModels: ['backup', 'last'] });
    expect(rows(f.launches).map(row => row.model)).toEqual(['backup']);
    expect(rows(f.launches)[0].args).toContain(f.nativeId);
    f.child.send({ type: 'message', content: 'synthetic restored input', turnId: 'om_catalog_restore' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'restored input committed');
    expect(rows(f.submissions)[0]).toMatchObject({ model: 'backup' });
    expect(JSON.parse(readFileSync(f.poolConfigPath, 'utf8'))[0].traexAutoModel.models)
      .toEqual(['backup', 'last']);
  }, 60_000);

  it('cleans a model removed during a queued turn and resumes without replaying the original ask', async () => {
    const f = await fixture(true, 'ordered', false, undefined, false, undefined, false,
      undefined, 0, 0, false, false, undefined, undefined,
      { enabled: false, initialPrompt: 'synthetic mid-turn retirement', catalogAfterStart: ['backup', 'last'] });
    await f.wait(() => rows(f.launches).some(row => row.model === 'last'), 'remaining models resumed', 50_000);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.launches).every(row => row.args.includes(f.nativeId))).toBe(true);
    expect(rows(f.submissions).filter(row => row.text.startsWith('synthetic mid-turn retirement'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.poolConfigPath, 'utf8'))[0].traexAutoModel.models)
      .toEqual(['backup', 'last']);
    expect(f.noticeDeliveries).toHaveLength(1);
  }, 75_000);
});
