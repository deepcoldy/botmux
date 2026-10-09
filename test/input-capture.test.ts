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
function fixture(overrides: Partial<InputCaptureOptions> = {}, registration: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, 'cli_example');
  const session = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'om_root', ownerOpenId: 'ou_owner', active: true };
  const options: InputCaptureOptions = { larkAppId: 'cli_example', store, session: () => session,
    pluginEnabled: p => p === 'example', canTalk: () => true,
    deliver: async () => { throw new Error('offline'); }, ...overrides };
  const runtime = createInputCaptureRuntime(options); cleanups.push(() => runtime.stop());
  const binding = runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque', ...registration });
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

it('drains only pending inputs among retained inactive history and preserves order after lost ACK', async () => {
  const delivered: string[] = []; let loseAck = true;
  const f = fixture({ deliver: async (binding, input) => {
    expect(binding.active).toBe(false); delivered.push(input.id);
    if (loseAck) throw new Error('lost ack');
  } });
  f.store.transact(state => {
    state.bindings[0].active = false;
    for (let i = 0; i < 5000; i++) {
      const id = `history${i}`;
      state.bindings.push({ ...f.binding, id, active: false, anchor: `om_history${i}` });
      state.inputs.push({ id, bindingId: id, sequence: 1, messageId: `om_history${i}`,
        senderOpenId: 'ou_owner', text: 'retained', receivedAt: '2026-10-05T00:00:00Z', delivery: 'acknowledged' });
      if (i === 2000 || i === 4000) state.inputs.push({ id: `pending${i}`, bindingId: f.binding.id,
        sequence: i / 2000, messageId: `om_pending${i}`, senderOpenId: 'ou_owner', text: 'pending',
        receivedAt: '2026-10-05T00:00:00Z', delivery: 'pending' });
    }
  });
  const before = f.store.read();
  await f.runtime.drain(); expect(delivered).toEqual(['pending2000']);
  loseAck = false; await f.runtime.drain();
  expect(delivered).toEqual(['pending2000', 'pending2000', 'pending4000']);
  const after = f.store.read();
  expect(after.bindings).toEqual(before.bindings);
  expect(after.inputs.filter(i => i.bindingId !== f.binding.id)).toEqual(before.inputs.filter(i => i.bindingId !== f.binding.id));
  expect(after.inputs.every(i => i.delivery === 'acknowledged')).toBe(true);
  await f.runtime.drain(); expect(delivered).toHaveLength(3);
});

it.each(['duplicate', 'sequence', 'owner', 'attachments', 'thread', 'alias'])('rejects corrupted %s facts when building the capture index', async kind => {
  const f = fixture(); f.runtime.capture(f.event); await f.runtime.drain();
  f.store.transact(state => {
    const input = state.inputs[0], binding = state.bindings[0];
    if (kind === 'duplicate') state.bindings.push({ ...binding });
    if (kind === 'sequence') input.sequence = 3;
    if (kind === 'owner') input.bindingId = 'missing';
    if (kind === 'attachments') input.attachments = [{ messageId: 'om_reply', type: 'file', key: 'file_example' }];
    if (kind === 'thread') {
      state.schemaVersion = 3; binding.inputThreadId = 'omt_one'; input.threadId = 'omt_two';
    }
    if (kind === 'alias') {
      state.schemaVersion = 3; input.threadId = 'omt_one';
      state.bindings.push({ ...binding, id: 'another', inputThreadId: 'omt_one', anchor: 'om_another' });
    }
  });
  expect(() => f.store.read()).toThrow();
});

it('binds only the explicit permitted actor in an ownerless group and rechecks access on capture', async () => {
  const group = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'oc_chat',
    ownerOpenId: '', active: true, scope: 'chat', chatType: 'group' };
  expect(() => fixture({ session: () => group })).toThrow('session_unavailable');
  for (const patch of [{ scope: 'thread' }, { chatType: 'p2p' }, { anchor: 'om_root' }]) {
    expect(() => fixture({ session: () => ({ ...group, ...patch }) }, { actorOpenId: 'ou_owner' })).toThrow('session_unavailable');
  }
  let allowed = true;
  const f = fixture({ session: () => group, canTalk: () => allowed }, { actorOpenId: 'ou_owner' });
  expect(group.ownerOpenId).toBe('');
  expect(f.binding.ownerOpenId).toBe('ou_owner');
  const input = { ...f.event, anchor: 'oc_chat' };
  expect(f.runtime.capture({ ...input, senderOpenId: 'ou_other' })).toBe(false);
  expect(f.runtime.capture(input)).toBe(true);
  expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque',
    actorOpenId: 'ou_other' })).toThrow('identity_conflict');
  allowed = false;
  expect(() => f.runtime.capture({ ...input, messageId: 'om_revoked' })).toThrow('authority_changed');
  expect(f.store.read().inputs).toHaveLength(1);
  await f.runtime.drain();
});
it('keeps two actors on the same ownerless group anchor in separate input streams', async () => {
  const group = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'oc_chat',
    ownerOpenId: '', active: true, scope: 'chat', chatType: 'group' };
  const f = fixture({ session: () => group }, { actorOpenId: 'ou_owner' });
  const other = f.runtime.register('s', { pluginId: 'example', requestId: 'other', providerRef: 'opaque',
    actorOpenId: 'ou_other' });
  for (const actorOpenId of ['ou_owner', 'ou_other']) {
    expect(() => f.runtime.register('s', { pluginId: 'example', requestId: `duplicate-${actorOpenId}`,
      providerRef: 'opaque', actorOpenId })).toThrow('anchor_conflict');
  }
  const input = { ...f.event, anchor: 'oc_chat' };
  expect(f.runtime.capture(input)).toBe(true);
  expect(f.runtime.capture({ ...input, messageId: 'om_other', senderOpenId: 'ou_other' })).toBe(true);
  expect(f.runtime.capture({ ...input, messageId: 'om_unbound', senderOpenId: 'ou_unbound' })).toBe(false);
  await f.runtime.drain();
  for (const [binding, messageId, actor] of [[f.binding, 'om_reply', 'ou_owner'], [other, 'om_other', 'ou_other']] as const) {
    expect(f.runtime.inspect('s', binding.id)!.inputs).toEqual([
      expect.objectContaining({ bindingId: binding.id, messageId, senderOpenId: actor, sequence: 1 }),
    ]);
  }
  expect(group.ownerOpenId).toBe('');
});
it('an explicit actor cannot replace an owned topic principal', () => {
  const f = fixture();
  expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'other', providerRef: 'opaque',
    actorOpenId: 'ou_other' })).toThrow('session_unavailable');
  const args = ['register', '--bot', 'cli_example', '--session', 's', '--plugin', 'example', '--request', 'r', '--ref', 'opaque'];
  expect(JSON.parse(parseInputCaptureCommand([...args, '--actor', 'ou_owner']).init.body)).toHaveProperty('actorOpenId', 'ou_owner');
  expect(() => parseInputCaptureCommand([...args, '--actor', 'not_an_open_id'])).toThrow();
});
