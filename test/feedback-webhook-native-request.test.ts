import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchWebhookAttempt } from '../src/services/feedback-webhook-dispatcher.js';

// Exercise the native transport's lookup callback, not the higher-level
// `request` test hook: that hook used to conceal the all:true contract bug.
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: transport.request }));

const event = { eventId: 'evt-native', type: 'turn.completed' as const, version: 1 as const,
  time: '2026-08-11T00:00:00.000Z', data: { status: 'completed' } };
const destination = { id: 'native', url: 'https://hook.example/feedback', secretRef: 'r', timeoutMs: 1000 };

beforeEach(() => { transport.request.mockReset(); });

describe('native feedback HTTPS DNS pinning', () => {
  for (const [address, family] of [['8.8.8.8', 4], ['2606:4700:4700::1111', 6]] as const) {
    for (const all of [true, false, undefined]) {
      it(`returns the pinned IPv${family} address with all=${all}`, async () => {
        let returned: unknown[] = [];
        const lookup = vi.fn(async () => [{ address, family }]);
        transport.request.mockImplementation((url, options, onResponse) => {
          expect(url.hostname).toBe('hook.example');
          expect(options.method).toBe('POST');
          const socketLookupOptions = all === undefined ? {} : { all };
          options.lookup('hook.example', socketLookupOptions, (...args: unknown[]) => { returned = args; });
          const req = new EventEmitter() as EventEmitter & { end: () => void };
          req.end = () => {
            const res = Object.assign(new EventEmitter(), { statusCode: 204, headers: {} });
            onResponse(res);
            res.emit('end');
          };
          return req;
        });
        const result = await dispatchWebhookAttempt({ destination, event, secret: 'test-secret', lookup });
        expect(result).toEqual({ kind: 'delivered', status: 204 });
        expect(returned).toEqual(all ? [null, [{ address, family }]] : [null, address, family]);
        // The transport must not redo DNS resolution after address validation.
        expect(lookup).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('rejects a mixed public/private DNS result before creating a socket', async () => {
    await expect(dispatchWebhookAttempt({ destination, event, secret: 'test-secret',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    })).rejects.toThrow('webhook_destination_address_blocked');
    expect(transport.request).not.toHaveBeenCalled();
  });
});
