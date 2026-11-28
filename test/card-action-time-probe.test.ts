import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as Lark from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCardActionTimeProbe, type CardActionTimeSample } from '../src/im/lark/card-action-time-probe.js';

const messageId = 'om_synthetic_test_card';
function callback(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { context: { open_message_id: messageId },
    action: { value: { action: 'ask_select', option_key: 'probe' } }, ...extra };
}
function envelope(event = callback(), header: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: '2.0', header: { event_type: 'card.action.trigger', ...header }, event };
}
function setup() {
  const samples: CardActionTimeSample[] = [];
  const options = { messageId, emit: (sample: CardActionTimeSample) => { samples.push(sample); } };
  return { samples, options, probe: createCardActionTimeProbe(options) };
}
function field(sample: CardActionTimeSample, path: string) {
  return sample.fields.find(item => item.path === path);
}
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('host-selected native card time probe', () => {
  it.each([
    callback({ context: { open_message_id: 'om_unrelated' } }),
    { action: { value: { context: { open_message_id: messageId }, messageId } } },
    callback({ open_message_id: 'om_conflicting' }),
    { context: Object.create({ open_message_id: messageId }) },
    Object.create(callback()),
    null,
  ])('does not sample a non-selected or ambiguous callback %#', input => {
    const { samples, probe } = setup();
    probe.observe(input);
    expect(samples).toEqual([]);
  });

  it('does not collect another SDK event even when it mentions the selected card', () => {
    const { samples, probe } = setup();
    const ack = {};
    expect(probe.invoke(envelope(callback(), { event_type: 'im.message.receive_v1' }), () => ack)).toBe(ack);
    expect(samples).toEqual([]);
  });

  it('records missing time fields as missing even when the local receive time is available', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1900000000000);
    const { samples, probe } = setup();
    const input = envelope();
    probe.invoke(input, () => probe.observe(callback()));
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample.fields).toHaveLength(12);
      expect(sample.fields.every(value => value.status === 'missing' && !Object.hasOwn(value, 'raw'))).toBe(true);
      expect(sample.local).toEqual({ receivedAtMs: 1900000000000, observedAtMs: 1900000000000 });
    }
  });

  it.each([0, -1, 1.5, null, '0', '-1', '1.5'])('retains a safe invalid scalar without replacing it with a time: %s', raw => {
    const { samples, probe } = setup();
    probe.observe(callback({ create_time: raw }));
    expect(field(samples[0], 'create_time')).toEqual({ path: 'create_time', raw,
      type: raw === null ? 'null' : typeof raw, status: 'invalid' });
  });

  it.each([NaN, Infinity, -Infinity, 'ou_private', 'verification-secret', '1e20',
    '123456789012345678901234567890', { token: 'nested-secret' }, ['business-content']])(
    'does not serialize unsafe or non-numeric time input %#', raw => {
      const { samples, probe } = setup();
      probe.observe(callback({ timestamp: raw }));
      expect(field(samples[0], 'timestamp')).toMatchObject({ status: 'invalid' });
      expect(field(samples[0], 'timestamp')).not.toHaveProperty('raw');
      const output = JSON.stringify(samples);
      for (const privateValue of ['ou_private', 'verification-secret', 'nested-secret', 'business-content']) {
        expect(output).not.toContain(privateValue);
      }
    },
  );

  it('never reads time values or the host selection from test action parameters', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1900000000000);
    const { samples, probe, options } = setup();
    options.messageId = 'om_attacker_choice';
    const data = callback({ create_time: '1700000000001',
      event_id: 'evt_sensitive', token: 'card-secret', operator: { open_id: 'ou_sensitive' },
      action: { value: { messageId: 'om_attacker_choice', create_time: '9999999999999',
        correlationKey: 'attacker-key', receivedAtMs: 1, stage: 'sdk-invoke',
        token: 'action-secret', signature: 'signature-secret', content: 'business-secret' } } });
    probe.observe(data);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ stage: 'card-action-trigger', local: { receivedAtMs: null, observedAtMs: 1900000000000 } });
    expect(field(samples[0], 'create_time')?.raw).toBe('1700000000001');
    const output = JSON.stringify(samples);
    for (const secret of [messageId, 'evt_sensitive', 'ou_sensitive', 'card-secret', 'action-secret',
      'signature-secret', 'business-secret', 'attacker-key', '9999999999999']) expect(output).not.toContain(secret);
    probe.observe(callback({ context: { open_message_id: 'om_attacker_choice' } }));
    expect(samples).toHaveLength(1);
  });

  it('leaves SDK entry time missing when only the callback entry was observed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1900000000000);
    const { samples, probe } = setup();
    probe.observe(callback());
    expect(samples[0].local).toEqual({ receivedAtMs: null, observedAtMs: 1900000000000 });
  });

  it('does not invoke getters while inspecting host fields', () => {
    const { samples, probe } = setup();
    const input = callback();
    Object.defineProperty(input, 'timestamp', { get() { throw new Error('private getter'); } });
    probe.observe(input);
    expect(field(samples[0], 'timestamp')).toMatchObject({ status: 'missing' });
  });

  it('does not change the SDK return identity or error when the sink throws', async () => {
    const probe = createCardActionTimeProbe({ messageId, emit() { throw new Error('offline sink unavailable'); } });
    const result = Promise.resolve({ toast: { type: 'success', content: 'same ACK' } });
    expect(probe.invoke(envelope(), () => { probe.observe(callback()); return result; })).toBe(result);
    await expect(result).resolves.toEqual({ toast: { type: 'success', content: 'same ACK' } });
    const failure = new Error('original SDK failure');
    expect(() => probe.invoke(envelope(), () => { throw failure; })).toThrow(failure);
  });

  it('does not turn an asynchronous sink failure into an unhandled process error', async () => {
    const probe = createCardActionTimeProbe({ messageId, async emit() { throw new Error('offline async sink unavailable'); } });
    const ack = { toast: { type: 'success', content: 'original ACK' } };
    expect(probe.invoke(envelope(), () => ack)).toBe(ack);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('passes malformed observation input to the original SDK unchanged', () => {
    const { samples, probe } = setup();
    const input = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('malformed'); } });
    const original = vi.fn((data: unknown) => data);
    expect(probe.invoke(input, original)).toBe(input);
    expect(samples).toEqual([]);
  });

  it('keeps concurrent SDK calls separate even without a native event id', async () => {
    const { samples, probe } = setup();
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = probe.invoke(envelope(callback(), { create_time: '1700000000001' }), async () => {
      await gate; probe.observe(callback({ create_time: '1700000000001' }));
    });
    await probe.invoke(envelope(callback(), { create_time: '1700000000002' }), async () => {
      await Promise.resolve(); probe.observe(callback({ create_time: '1700000000002' }));
    });
    releaseFirst(); await first;
    const raw = samples.filter(sample => sample.stage === 'sdk-invoke');
    expect(new Set(raw.map(sample => sample.correlationKey)).size).toBe(2);
    for (const sample of raw) {
      const other = samples.find(value => value.stage === 'card-action-trigger' && value.correlationKey === sample.correlationKey)!;
      expect(field(other, 'create_time')?.raw).toBe(field(sample, 'header.create_time')?.raw);
    }
  });
});

describe('locked Lark SDK offline callback boundary', () => {
  it('uses the public lock version 1.73.0', () => {
    const sdkPackage = JSON.parse(readFileSync(new URL('../node_modules/@larksuiteoapi/node-sdk/package.json', import.meta.url), 'utf8'));
    expect(sdkPackage.version).toBe('1.73.0');
  });

  it('observes header/body name collisions before flattening without modifying the event', async () => {
    const { samples, probe } = setup();
    const sdk = new Lark.EventDispatcher({ logger: quietLogger }).register({ 'card.action.trigger': (data: unknown) => {
      probe.observe(data); return { toast: { type: 'success', content: 'unchanged' } };
    } });
    const input = envelope(callback({ create_time: 1700000000999, event_id: 'body-event' }),
      { create_time: '1700000000123', event_id: 'header-event' });
    const bytes = JSON.stringify(input);
    const ack = await probe.invoke(input, data => sdk.invoke(data));
    expect(ack).toEqual({ toast: { type: 'success', content: 'unchanged' } });
    expect(JSON.stringify(input)).toBe(bytes);
    expect(samples).toHaveLength(2);
    expect(samples[0].correlationKey).toBe(samples[1].correlationKey);
    expect(field(samples[0], 'header.create_time')?.raw).toBe('1700000000123');
    expect(field(samples[0], 'event.create_time')?.raw).toBe(1700000000999);
    expect(field(samples[1], 'create_time')?.raw).toBe(1700000000999);
  });

  it('keeps the real SDK signature check intact for accepted and rejected envelopes', async () => {
    const { samples, probe } = setup();
    const accepted = vi.fn((data: unknown) => { probe.observe(data); return { toast: { type: 'success', content: 'accepted' } }; });
    const sdk = new Lark.EventDispatcher({ encryptKey: 'offline-key', logger: quietLogger }).register({ 'card.action.trigger': accepted });
    function signedInput(valid: boolean) {
      const headers = { 'x-lark-request-timestamp': '1700000000', 'x-lark-request-nonce': 'offline-nonce', 'x-lark-signature': '' };
      const input = Object.assign(Object.create({ headers }), envelope());
      headers['x-lark-signature'] = valid
        ? createHash('sha256').update('1700000000offline-nonceoffline-key' + JSON.stringify(input)).digest('hex') : 'invalid-signature';
      return input;
    }
    await expect(probe.invoke(signedInput(false), data => sdk.invoke(data))).resolves.toBeUndefined();
    expect(accepted).not.toHaveBeenCalled();
    expect(samples.map(sample => sample.stage)).toEqual(['sdk-invoke']);
    samples.length = 0;
    await expect(probe.invoke(signedInput(true), data => sdk.invoke(data))).resolves.toEqual({ toast: { type: 'success', content: 'accepted' } });
    expect(samples.map(sample => sample.stage)).toEqual(['sdk-invoke', 'card-action-trigger']);
    expect(JSON.stringify(samples)).not.toContain('offline-key');
    expect(JSON.stringify(samples)).not.toContain('invalid-signature');
  });
});
