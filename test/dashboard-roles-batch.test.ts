import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ROLE_BATCH_TARGETS,
  aggregateRoleBatch,
  parseRoleBatchTargets,
} from '../src/dashboard/roles-batch.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dashboard role batch aggregation', () => {
  it('validates and de-duplicates targets', () => {
    expect(parseRoleBatchTargets({
      targets: [
        { larkAppId: 'cli_a', chatId: 'oc_one' },
        { larkAppId: 'cli_a', chatId: 'oc_one' },
        { larkAppId: 'cli_b', chatId: 'om_two' },
      ],
    })).toEqual({
      ok: true,
      targets: [
        { larkAppId: 'cli_a', chatId: 'oc_one' },
        { larkAppId: 'cli_b', chatId: 'om_two' },
      ],
    });
    expect(parseRoleBatchTargets({ targets: [{ larkAppId: '../bad', chatId: 'oc_one' }] }))
      .toEqual({ ok: false, error: 'invalid_target' });
    expect(parseRoleBatchTargets({
      targets: Array.from({ length: MAX_ROLE_BATCH_TARGETS + 1 }, () => ({ larkAppId: 'cli_a', chatId: 'oc_one' })),
    })).toEqual({ ok: false, error: 'too_many_targets' });
  });

  it('fans out once per daemon and preserves partial results', async () => {
    const proxy = vi.fn(async (larkAppId: string, path: string, init: RequestInit) => {
      expect(path).toBe('/api/roles/batch');
      if (larkAppId === 'cli_b') return response(503, { error: 'daemon_offline' });
      expect(JSON.parse(String(init.body))).toEqual({ chatIds: ['oc_one', 'oc_two'] });
      return response(200, {
        roles: [
          { chatId: 'oc_one', content: 'one', hasRole: true },
          { chatId: 'oc_two', content: 'two', hasRole: true },
        ],
      });
    });

    const result = await aggregateRoleBatch([
      { larkAppId: 'cli_a', chatId: 'oc_one' },
      { larkAppId: 'cli_a', chatId: 'oc_two' },
      { larkAppId: 'cli_b', chatId: 'oc_three' },
    ], proxy);

    expect(proxy).toHaveBeenCalledTimes(2);
    expect(result.roles).toEqual([
      { larkAppId: 'cli_a', chatId: 'oc_one', content: 'one', hasRole: true },
      { larkAppId: 'cli_a', chatId: 'oc_two', content: 'two', hasRole: true },
    ]);
    expect(result.errors).toEqual([{
      larkAppId: 'cli_b',
      status: 503,
      error: 'upstream_http_503',
    }]);
  });
});
