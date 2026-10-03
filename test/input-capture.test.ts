import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputCaptureStore } from '../src/core/plugins/input-capture/store.js';
import { createInputCaptureRuntime, type InputCaptureOptions } from '../src/core/plugins/input-capture/runtime.js';
import { parseInputCaptureCommand } from '../src/cli/input-capture.js';
import { parseInputCaptureConditions } from '../src/core/plugins/input-capture/conditions.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(overrides: Partial<InputCaptureOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, 'cli_example');
  const session = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'om_root', ownerOpenId: 'ou_owner', active: true };
  const options: InputCaptureOptions = { larkAppId: 'cli_example', store, session: () => session,
    pluginEnabled: p => p === 'example', canTalk: () => true,
    deliver: async () => { throw new Error('offline'); }, ...overrides };
  const runtime = createInputCaptureRuntime(options); cleanups.push(() => runtime.stop());
  const binding = runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque' });
  const event = { messageId: 'om_reply', chatId: 'oc_chat', anchor: 'om_root', senderOpenId: 'ou_owner', text: 'continue only the first step', botSender: false };
  return { runtime, binding, event, options, store, session };
}

it('pages full source bytes at a fixed upper sequence across restart and rejects closing over new input', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.runtime.capture({ ...f.event, messageId: `om_long${i}`, text: 'x'.repeat(64 * 1024) });
  await f.runtime.drain();
  const original = f.runtime.inspect('s', f.binding.id)!;
  expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(512 * 1024);
  expect(Object.keys(original)).toEqual(['binding', 'inputs']);
  const first = f.runtime.inspect('s', f.binding.id, { after: 0 })!;
  expect(first.throughSequence).toBe(12); expect(first.inputs).toHaveLength(1);
  f.runtime.capture({ ...f.event, messageId: 'om_later', text: 'do not close yet' });
  await f.runtime.stop();
  const resumed = createInputCaptureRuntime(f.options); cleanups.push(() => resumed.stop());
  let page = first;
  const inputs = [...page.inputs];
  while (page.nextSequence !== null) {
    page = resumed.inspect('s', f.binding.id, { after: page.nextSequence, through: first.throughSequence })!;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
    expect(page.throughSequence).toBe(12); inputs.push(...page.inputs);
  }
  expect(inputs).toEqual(original.inputs);
  expect(() => resumed.revokeSet('s', [{ bindingId: f.binding.id, expectedRevision: 1, expectedInputCount: inputs.length }])).toThrow('inputs_conflict');
  expect(resumed.inspect('s', f.binding.id)!.binding.active).toBe(true);
  expect(resumed.inspect('s', f.binding.id)!.inputs).toHaveLength(13);
});

it('bounds short pages by count and returns a complete single input when JSON escaping exceeds the byte budget', async () => {
  const f = fixture();
  for (let i = 0; i < 66; i++) f.runtime.capture({ ...f.event, messageId: `om_short${i}` });
  const first = f.runtime.inspect('s', f.binding.id, { after: 0 })!;
  expect(first.inputs).toHaveLength(64); expect(first.nextSequence).toBe(64); expect(first.throughSequence).toBe(66);
  const text = 'x' + '\u0001'.repeat(64 * 1024 - 1);
  f.runtime.capture({ ...f.event, messageId: 'om_escaped', text });
  const tail = f.runtime.inspect('s', f.binding.id, { after: 66 })!;
  expect(tail.inputs[0].text).toBe(text); expect(tail.nextSequence).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(tail))).toBeGreaterThan(256 * 1024);
  expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(512 * 1024);
  expect(f.runtime.inspect('s', f.binding.id, { after: 0, through: 0 })).toMatchObject({ inputs: [], throughSequence: 0, nextSequence: null });
  expect(f.runtime.inspect('other', f.binding.id, { after: 0 })).toBeUndefined();
  for (const page of [{ after: -1 }, { after: 0.5 }, { after: '0' }, { after: null }, { through: 1 },
    { after: 0, through: 68 }, { after: 2, through: 1 }, { after: 0, through: null }]) {
    expect(() => f.runtime.inspect('s', f.binding.id, page)).toThrow('invalid_input_capture_page');
  }
  await f.runtime.drain();
});

it('validates optional inspect page flags without changing the legacy command', () => {
  const args = ['inspect', '--bot', 'cli_example', '--session', 's', '--binding', 'a'.repeat(64)];
  expect(JSON.parse(parseInputCaptureCommand(args).init.body)).not.toHaveProperty('after');
  expect(JSON.parse(parseInputCaptureCommand([...args, '--after', '0', '--through', '0']).init.body)).toMatchObject({ after: 0, through: 0 });
  for (const extra of [['--through', '1'], ['--after', '-1'], ['--after', '01'], ['--after', '1.5'],
    ['--after', '9007199254740992'], ['--after', '2', '--through', '1'], ['--after', '0', '--after', '1']]) {
    expect(() => parseInputCaptureCommand([...args, ...extra])).toThrow();
  }
});
describe('exact plugin input capture', () => {
  it('commits before acknowledging and preserves the original input across outage and restart', async () => {
    const f = fixture(); expect(f.runtime.capture(f.event)).toBe(true); await f.runtime.drain(); await f.runtime.stop();
    const saved = f.store.read(); expect(saved.inputs[0].delivery).toBe('pending');
    const received: string[] = [];
    const resumed = createInputCaptureRuntime({ ...f.options, deliver: async (_binding, input) => { received.push(input.text); } });
    cleanups.push(() => resumed.stop()); await resumed.drain();
    expect(received).toEqual([f.event.text]); expect(f.store.read().inputs[0].delivery).toBe('acknowledged');
    expect(resumed.capture(f.event)).toBe(true); await resumed.drain(); expect(received).toHaveLength(1);
  });
  it('keeps ordered delivery and idempotent input ids after a lost receiver acknowledgement', async () => {
    const delivered = new Set<string>(); let loseAck = true;
    const f = fixture({ deliver: async (_binding, input) => { delivered.add(input.id); if (loseAck) throw new Error('lost ack'); } });
    f.runtime.capture(f.event); f.runtime.capture({ ...f.event, messageId: 'om_second', text: 'correction: inspect only' });
    await f.runtime.drain(); expect(delivered.size).toBe(1); loseAck = false;
    await f.runtime.drain(); expect(delivered.size).toBe(2);
    expect(f.store.read().inputs.map(i => i.delivery)).toEqual(['acknowledged', 'acknowledged']);
  });
  it('does not capture another actor, anchor, chat or a bot and never falls through after the session becomes inactive', () => {
    const f = fixture();
    for (const patch of [{ senderOpenId: 'ou_other' }, { anchor: 'om_other' }, { chatId: 'oc_other' }, { botSender: true }]) {
      expect(f.runtime.capture({ ...f.event, ...patch })).toBe(false);
    }
    f.session.active = false;
    expect(() => f.runtime.capture(f.event)).toThrow('authority_changed'); expect(f.store.read().inputs).toEqual([]);
  });
  it('checks current talk permission on each new input while retaining previously accepted evidence', async () => {
    let canTalk = true;
    const f = fixture({ canTalk: () => canTalk });
    expect(f.runtime.capture(f.event)).toBe(true); await f.runtime.drain();
    canTalk = false;
    expect(() => f.runtime.capture({ ...f.event, messageId: 'om_after_revoke' })).toThrow('authority_changed');
    expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'second', providerRef: 'opaque' })).toThrow('session_unavailable');
    expect(f.runtime.capture(f.event)).toBe(true);
    expect(f.store.read().inputs).toHaveLength(1);
  });
  it('retains accepted input on revoke and rejects conflicting bindings and stale revisions', async () => {
    const f = fixture(); f.runtime.capture(f.event); await f.runtime.drain();
    expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'another', providerRef: 'x' })).toThrow('anchor_conflict');
    expect(() => f.runtime.revoke('s', f.binding.id, 9)).toThrow('revision_conflict');
    f.runtime.revoke('s', f.binding.id, 1);
    expect(f.runtime.capture({ ...f.event, messageId: 'om_later' })).toBe(false);
    expect(f.runtime.inspect('s', f.binding.id)?.inputs).toHaveLength(1);
    expect(f.runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque' }).active).toBe(false);
  });
  it('does not confirm input when persistence fails and does not rewrite acknowledged messages', async () => {
    const f = fixture(); const transact = f.store.transact;
    f.store.transact = () => { throw new Error('disk unavailable'); };
    expect(() => f.runtime.capture(f.event)).toThrow('disk unavailable'); f.store.transact = transact;
    expect(f.store.read().inputs).toEqual([]);
    f.runtime.capture(f.event); await f.runtime.drain();
    expect(() => f.runtime.capture({ ...f.event, text: 'different' })).toThrow('message_conflict');
    expect(f.store.read().inputs[0].text).toBe(f.event.text);
  });
  it('closes both routes only if neither has accepted another input since inspection', async () => {
    for (const anchor of ['om_root', 'om_card']) {
      const f = fixture();
      const card = f.runtime.register('s', { pluginId: 'example', requestId: 'card', providerRef: 'opaque', inputAnchor: 'om_card' });
      const conditions = [f.binding, card].map(binding => ({ bindingId: binding.id, expectedRevision: 1, expectedInputCount: 0 }));
      f.runtime.capture({ ...f.event, anchor }); await f.runtime.drain();
      const before = f.store.read();
      expect(() => f.runtime.revokeSet('s', conditions)).toThrow('input_capture_inputs_conflict');
      expect(f.store.read()).toEqual(before);
      const current = conditions.map(condition => ({ ...condition,
        expectedInputCount: f.runtime.inspect('s', condition.bindingId)!.inputs.length }));
      const result = f.runtime.revokeSet('s', current);
      expect(result.bindings.map(row => [row.binding.active, row.binding.revision])).toEqual([[false, 2], [false, 2]]);
      expect(result.bindings.reduce((total, row) => total + row.inputCount, 0)).toBe(1);
      for (const inputAnchor of ['om_root', 'om_card']) {
        expect(f.runtime.capture({ ...f.event, anchor: inputAnchor, messageId: 'om_later' })).toBe(false);
      }
      // A lost response is reconciled from the original IDs, without reactivation.
      expect(() => f.runtime.revokeSet('s', current)).toThrow('input_capture_revision_conflict');
      for (const binding of [f.binding, card]) expect(f.runtime.inspect('s', binding.id)?.binding.active).toBe(false);
    }
  });
  it('does not partially revoke on a stale revision, missing binding or wrong session', () => {
    const f = fixture();
    const card = f.runtime.register('s', { pluginId: 'example', requestId: 'card', providerRef: 'opaque', inputAnchor: 'om_card' });
    const conditions = [f.binding, card].map(binding => ({ bindingId: binding.id, expectedRevision: 1, expectedInputCount: 0 }));
    const before = f.store.read();
    for (const patch of [{ expectedRevision: 2 }, { bindingId: 'a'.repeat(64) }]) {
      expect(() => f.runtime.revokeSet('s', [conditions[0], { ...conditions[1], ...patch }])).toThrow('revision_conflict');
      expect(f.store.read()).toEqual(before);
    }
    expect(() => f.runtime.revokeSet('other', conditions)).toThrow('revision_conflict');
    expect(f.store.read()).toEqual(before);
  });
  it('keeps unacknowledged inputs and deduplication after batch revocation and restart', async () => {
    const accepted = new Set<string>();
    const f = fixture({ deliver: async (_binding, input) => { accepted.add(input.id); throw new Error('lost ack'); } });
    const card = f.runtime.register('s', { pluginId: 'example', requestId: 'card', providerRef: 'opaque', inputAnchor: 'om_card' });
    const events = [f.event, { ...f.event, anchor: 'om_card', messageId: 'om_card_reply' }];
    for (const event of events) f.runtime.capture(event);
    await f.runtime.drain(); await f.runtime.drain();
    expect(accepted.size).toBe(2);
    f.runtime.revokeSet('s', [f.binding, card].map(binding => ({ bindingId: binding.id, expectedRevision: 1, expectedInputCount: 1 })));
    await f.runtime.stop();
    expect(f.store.read().inputs.map(input => input.delivery)).toEqual(['pending', 'pending']);
    const replayed: string[] = [];
    const resumed = createInputCaptureRuntime({ ...f.options, deliver: async (binding, input) => {
      expect(binding.active).toBe(false); expect(accepted.has(input.id)).toBe(true); replayed.push(input.id);
    } });
    cleanups.push(() => resumed.stop()); await resumed.drain();
    expect(replayed).toEqual(f.store.read().inputs.map(input => input.id));
    expect(f.store.read().inputs.map(input => input.delivery)).toEqual(['acknowledged', 'acknowledged']);
    for (const event of events) expect(resumed.capture(event)).toBe(true);
    await resumed.drain(); expect(replayed).toHaveLength(2);
  });
  it('rejects ambiguous and oversized conditions without changing any binding', () => {
    const f = fixture();
    const condition = { bindingId: f.binding.id, expectedRevision: 1, expectedInputCount: 0 };
    const before = f.store.read();
    const invalid = [null, {}, [], [condition, condition], Array(33).fill(condition),
      [null], [[condition]], [{ ...condition, bindingId: [f.binding.id] }],
      [{ ...condition, bindingId: 123 }], [{ ...condition, bindingId: 'bad' }],
      ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => [{ ...condition, expectedRevision }]),
      ...[-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1].map(expectedInputCount => [{ ...condition, expectedInputCount }]),
      [{ ...condition, extra: true }], [{ bindingId: f.binding.id, expectedRevision: 1 }]];
    for (const value of invalid) {
      expect(() => f.runtime.revokeSet('s', value)).toThrow('invalid_input_capture_conditions');
      expect(f.store.read()).toEqual(before);
    }
    expect(parseInputCaptureConditions([condition])).toEqual([condition]);
  });
  it('parses batch revoke conditions and rejects conflicting CLI flags before contacting the host', () => {
    const conditions = [{ bindingId: 'a'.repeat(64), expectedRevision: 2, expectedInputCount: 3 }];
    const args = ['revoke-set', '--bot', 'cli_example', '--session', 's', '--bindings', JSON.stringify(conditions)];
    const command = parseInputCaptureCommand(args);
    expect(command.path).toBe('/api/sessions/s/input-capture');
    expect(JSON.parse(command.init.body)).toEqual({ larkAppId: 'cli_example', operation: 'revoke-set', bindings: conditions });
    for (const extra of [['--binding', 'a'.repeat(64)], ['--revision', '2'], ['--bindings', '[]']]) {
      expect(() => parseInputCaptureCommand([...args, ...extra])).toThrow();
    }
    for (const value of ['[]', 'not-json', JSON.stringify([{ ...conditions[0], approved: true }])]) {
      expect(() => parseInputCaptureCommand([...args.slice(0, -1), value])).toThrow();
    }
  });
  it('parses explicit host identities and rejects missing, duplicate and unsafe flags', () => {
    const command = parseInputCaptureCommand(['register', '--bot', 'cli_example', '--session', 's', '--plugin', 'example', '--request', 'r', '--ref', 'opaque']);
    expect(JSON.parse(command.init.body).operation).toBe('register');
    expect(() => parseInputCaptureCommand(['register', '--bot', 'cli_example'])).toThrow();
    expect(() => parseInputCaptureCommand(['revoke', '--bot', 'cli_example', '--session', 's', '--binding', 'id', '--revision', 'NaN'])).toThrow();
  });
});
