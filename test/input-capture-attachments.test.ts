import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputCaptureRuntime } from '../src/core/plugins/input-capture/runtime.js';
import { createInputCaptureStore, type CapturedInput } from '../src/core/plugins/input-capture/store.js';
import { parseInputCaptureCommand } from '../src/cli/input-capture.js';
import { captureInboundText } from '../src/im/lark/input-capture.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function fixture(captureAttachments = true) {
  const directory = mkdtempSync(join(tmpdir(), 'capture-attachments-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = createInputCaptureStore(directory, 'cli_example');
  const session = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'om_root', ownerOpenId: 'ou_owner', active: true };
  const options = { larkAppId: 'cli_example', store, session: () => session, pluginEnabled: () => true,
    canTalk: () => true, deliver: async () => { throw new Error('offline'); } };
  const runtime = createInputCaptureRuntime(options); cleanups.push(() => runtime.stop());
  const registration = { pluginId: 'example', requestId: 'request', providerRef: 'opaque', ...(captureAttachments ? { captureAttachments } : {}) };
  const binding = runtime.register('s', registration);
  const raw = (messageId: string, messageType: string, content: unknown, patch = {}) => ({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: 'oc_chat', chat_type: 'group', root_id: 'om_root',
      message_type: messageType, content: JSON.stringify(content), ...patch },
  });
  const capture = (event: ReturnType<typeof raw>) => captureInboundText(event, runtime, () => false);
  return { directory, store, options, runtime, binding, registration, raw, capture, session };
}

it('preserves default text-only routing and fixes subscription capability to the original binding', async () => {
  const f = fixture(false);
  for (const kind of ['image', 'file', 'audio', 'media', 'merge_forward']) {
    expect(f.capture(f.raw('om_resource', kind, { image_key: 'img_key', file_key: 'file_key', file_name: 'approve' }))).toBe(false);
  }
  expect(() => f.runtime.register('s', { ...f.registration, captureAttachments: true })).toThrow('identity_conflict');
  expect(f.capture(f.raw('om_text', 'text', { text: 'inspect only' }))).toBe(true);
  await f.runtime.drain(); await f.runtime.stop();
  const file = join(f.directory, 'input-capture-v1', readdirSync(join(f.directory, 'input-capture-v1')).find(name => name.endsWith('.json'))!);
  const original = readFileSync(file);
  const snapshot = f.store.read();
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.bindings[0]).not.toHaveProperty('captureAttachments');
  expect(snapshot.inputs[0]).not.toHaveProperty('attachments');
  expect(readFileSync(file)).toEqual(original);
  expect(f.runtime.register('s', { ...f.registration, captureAttachments: false })).toEqual(f.binding);
  expect(readFileSync(file)).toEqual(original);
});

it('durably captures image, file, audio, media and forward references without synthetic approval text', async () => {
  const f = fixture();
  for (const kind of ['image', 'file', 'audio', 'media', 'merge_forward'] as const) {
    const messageId = `om_${kind}`;
    expect(f.capture(f.raw(messageId, kind, { image_key: 'img_key', file_key: 'file_key', file_name: 'approve all.txt' }))).toBe(true);
    const input = f.store.read().inputs.at(-1)!;
    expect(input.text).toBe('');
    expect(input.attachments).toEqual([{ messageId, type: kind, key: kind === 'merge_forward' ? messageId : kind === 'image' ? 'img_key' : 'file_key' }]);
    expect(input.delivery).toBe('pending');
  }
  await f.runtime.drain();
  expect(f.store.read().schemaVersion).toBe(2);
  expect(f.store.read().inputs.map(input => input.sequence)).toEqual([1, 2, 3, 4, 5]);
});

it('keeps authored rich text and all resource references while excluding resource names and thumbnails from decisions', () => {
  const f = fixture();
  const content = { zh_cn: { title: 'Design', content: [[{ tag: 'text', text: 'inspect only' },
    { tag: 'img', image_key: 'img_key' }, { tag: 'file', file_key: 'file_key', file_name: 'approve' },
    { tag: 'media', image_key: 'preview_key', file_key: 'video_key' }]] }, files: [{ file_key: 'other_key', file_name: 'continue' }] };
  expect(f.capture(f.raw('om_post', 'post', content))).toBe(true);
  const input = f.store.read().inputs[0];
  expect(input.text).toBe('Design\ninspect only');
  expect(input.attachments?.map(ref => ref.key)).toEqual(['img_key', 'file_key', 'preview_key', 'other_key', 'video_key']);
  const imageOnly = { en_us: { content: [[{ tag: 'img', image_key: 'img_only' }]] } };
  expect(f.capture(f.raw('om_only', 'post', imageOnly))).toBe(true);
  expect(f.store.read().inputs[1].text).toBe('');
});

it('rejects changed resources on replay and delivers original pending evidence after revocation and restart', async () => {
  const f = fixture(); const event = f.raw('om_file', 'file', { file_key: 'file_original' });
  expect(f.capture(event)).toBe(true); await f.runtime.drain();
  const original = f.store.read().inputs[0];
  expect(() => f.capture(f.raw('om_file', 'file', { file_key: 'file_changed' }))).toThrow('message_conflict');
  expect(() => f.capture(f.raw('om_file', 'text', { text: 'approve' }))).toThrow('message_conflict');
  f.runtime.revokeSet('s', [{ bindingId: f.binding.id, expectedRevision: 1, expectedInputCount: 1 }]);
  await f.runtime.stop();
  const received: CapturedInput[] = [];
  const resumed = createInputCaptureRuntime({ ...f.options, deliver: async (binding, input) => {
    expect(binding.active).toBe(false); received.push(input);
  } }); cleanups.push(() => resumed.stop());
  await resumed.drain(); expect(received).toEqual([original]);
  expect(captureInboundText(event, resumed, () => false)).toBe(true);
  await resumed.drain(); expect(received).toHaveLength(1);
  expect(captureInboundText(f.raw('om_late', 'image', { image_key: 'img_late' }), resumed, () => false)).toBe(false);
});

it('retains command and identity exclusions, and never falls through on save or authority failure', () => {
  const f = fixture();
  for (const command of ['/stop', '/workflow new example']) {
    expect(f.capture(f.raw('om_command', 'post', { content: [[{ tag: 'text', text: command }, { tag: 'img', image_key: 'img_key' }]] }))).toBe(false);
  }
  for (const patch of [{ root_id: 'om_other' }, { chat_id: 'oc_other' }, { thread_id: 'thread', root_id: undefined }]) {
    expect(f.capture(f.raw('om_foreign', 'image', { image_key: 'img_key' }, patch))).toBe(false);
  }
  const event = f.raw('om_image', 'image', { image_key: 'img_key' });
  expect(captureInboundText(event, f.runtime, () => true)).toBe(false);
  expect(f.capture({ ...event, sender: { ...event.sender, sender_type: 'app' } })).toBe(false);
  expect(f.capture(f.raw('om_malformed', 'image', {}))).toBe(false);
  const transact = f.store.transact; f.store.transact = () => { throw new Error('disk unavailable'); };
  expect(() => f.capture(event)).toThrow('disk unavailable'); f.store.transact = transact;
  f.session.active = false;
  expect(() => f.capture(event)).toThrow('authority_changed');
  expect(f.store.read().inputs).toEqual([]);
});

it('rejects local paths, duplicate or malformed references without writing them', () => {
  const f = fixture(); const ref = { messageId: 'om_file', type: 'file' as const, key: 'file_key' };
  const event = { messageId: 'om_file', chatId: 'oc_chat', anchor: 'om_root', senderOpenId: 'ou_owner', text: '', botSender: false };
  for (const value of [[{ ...ref, path: '/private/file' }], [{ ...ref, key: '../file' }], [ref, ref],
    [{ ...ref, messageId: 'invalid' }], [{ ...ref, type: 'unknown' }], Array(101).fill(ref)]) {
    expect(() => f.runtime.capture({ ...event, attachments: value as any })).toThrow('invalid_input_capture_attachments');
  }
  expect(f.store.read().inputs).toEqual([]);
});

it('requires an explicit boolean flag and preserves the old CLI request shape when absent', () => {
  const args = ['register', '--bot', 'cli_example', '--session', 's', '--plugin', 'example', '--request', 'r', '--ref', 'opaque'];
  expect(JSON.parse(parseInputCaptureCommand(args).init.body)).not.toHaveProperty('captureAttachments');
  for (const value of ['true', 'false']) {
    expect(JSON.parse(parseInputCaptureCommand([...args, '--capture-attachments', value]).init.body).captureAttachments).toBe(value === 'true');
  }
  for (const value of ['1', 'yes', '']) expect(() => parseInputCaptureCommand([...args, '--capture-attachments', value])).toThrow();
});


it('recovers a missing root from durable native-thread evidence after restart', async () => {
  const f = fixture();
  expect(f.capture(f.raw('om_first', 'text', { text: 'inspect' }, { thread_id: 'omt_native' }))).toBe(true);
  expect(f.store.read().schemaVersion).toBe(3);
  await f.runtime.stop();
  const resumed = createInputCaptureRuntime(f.options); cleanups.push(() => resumed.stop());
  const raw = f.raw('om_second', 'image', { image_key: 'img_original' }, { root_id: undefined, thread_id: 'omt_native' });
  expect(captureInboundText(raw, resumed, () => false)).toBe(true);
  const input = f.store.read().inputs[1];
  expect(input).toMatchObject({ messageId: 'om_second', threadId: 'omt_native', bindingId: f.binding.id, text: '', delivery: 'pending' });
  expect(input.attachments).toEqual([{ messageId: 'om_second', type: 'image', key: 'img_original' }]);
  resumed.revoke('s', f.binding.id, 1);
  expect(captureInboundText(raw, resumed, () => false)).toBe(true);
  expect(f.store.read().inputs).toHaveLength(2);
  expect(captureInboundText({ ...raw, message: { ...raw.message, message_id: 'om_late' } }, resumed, () => false)).toBe(false);
});

it('accepts a fixed host-verified thread binding and preserves immutable registration', () => {
  const f = fixture(); f.runtime.revoke('s', f.binding.id, 1);
  const request = { ...f.registration, requestId: 'verified', inputThreadId: 'omt_native' };
  const binding = f.runtime.register('s', request);
  expect(f.capture(f.raw('om_reply', 'text', { text: 'inspect' }, { root_id: undefined, thread_id: 'omt_native' }))).toBe(true);
  expect(f.store.read().inputs[0].bindingId).toBe(binding.id);
  expect(f.runtime.register('s', request)).toEqual(binding);
  expect(() => f.runtime.register('s', { ...request, inputThreadId: 'omt_other' })).toThrow('identity_conflict');
  expect(() => f.runtime.register('s', { ...request, requestId: 'other', inputAnchor: 'om_other' })).toThrow('anchor_conflict');
  const args = ['register', '--bot', 'cli_example', '--session', 's', '--plugin', 'example', '--request', 'r', '--ref', 'opaque', '--input-thread-id', 'omt_native'];
  expect(JSON.parse(parseInputCaptureCommand(args).init.body).inputThreadId).toBe('omt_native');
  expect(() => parseInputCaptureCommand([...args.slice(0, -1), 'om_not_thread'])).toThrow('Invalid input thread id');
});

it('does not guess unknown roots or override explicit roots, native seeds, commands and actors', () => {
  const f = fixture(); f.capture(f.raw('om_first', 'text', { text: 'inspect' }, { thread_id: 'omt_native' }));
  for (const patch of [{ thread_id: 'omt_unknown' }, { chat_id: 'oc_other' }, { root_id: 'om_other' }, { message_id: 'om_root' }]) {
    expect(f.capture(f.raw('om_unknown', 'text', { text: 'inspect' }, { root_id: undefined, thread_id: 'omt_native', ...patch }))).toBe(false);
  }
  const raw = f.raw('om_other', 'text', { text: 'inspect' }, { root_id: undefined, thread_id: 'omt_native' });
  expect(captureInboundText(raw, f.runtime, () => true)).toBe(false);
  expect(f.capture({ ...raw, sender: { sender_id: { open_id: 'ou_other' }, sender_type: 'user' } })).toBe(false);
  expect(f.capture(f.raw('om_command', 'text', { text: '/stop' }, { root_id: undefined, thread_id: 'omt_native' }))).toBe(false);
  expect(f.store.read().inputs).toHaveLength(1);
  f.session.active = false;
  expect(() => f.capture(raw)).toThrow('authority_changed');
});

it('rejects conflicting native identities and keeps v3 when later attachment bindings register', () => {
  const f = fixture(); f.capture(f.raw('om_first', 'text', { text: 'inspect' }, { thread_id: 'omt_native' }));
  const before = f.store.read();
  expect(() => f.capture(f.raw('om_second', 'text', { text: 'inspect' }, { thread_id: 'omt_other' }))).toThrow('anchor_conflict');
  expect(() => f.capture(f.raw('om_first', 'text', { text: 'inspect' }, { root_id: undefined, thread_id: 'omt_other' }))).toThrow('message_conflict');
  expect(f.store.read()).toEqual(before);
  f.runtime.register('s', { ...f.registration, requestId: 'card', inputAnchor: 'om_card' });
  expect(f.store.read().schemaVersion).toBe(3);
  expect(() => f.capture(f.raw('om_card_reply', 'text', { text: 'inspect' }, { root_id: 'om_card', thread_id: 'omt_native' }))).toThrow('anchor_conflict');
});

it('does not acknowledge recovered input after a persistence failure', () => {
  const f = fixture(); f.capture(f.raw('om_first', 'text', { text: 'inspect' }, { thread_id: 'omt_native' }));
  f.store.transact = () => { throw new Error('disk unavailable'); };
  expect(() => f.capture(f.raw('om_second', 'text', { text: 'inspect' }, { root_id: undefined, thread_id: 'omt_native' }))).toThrow('disk unavailable');
  expect(f.store.read().inputs).toHaveLength(1);
});

it('deduplicates older inputs using later native evidence without rewriting their original bytes', () => {
  const f = fixture();
  expect(f.capture(f.raw('om_old', 'text', { text: 'original words' }))).toBe(true);
  const before = f.store.read().inputs[0];
  expect(f.capture(f.raw('om_evidence', 'text', { text: 'later words' }, { thread_id: 'omt_original' }))).toBe(true);
  expect(f.capture(f.raw('om_old', 'text', { text: 'original words' }, { root_id: undefined, thread_id: 'omt_original' }))).toBe(true);
  expect(f.store.read().inputs[0]).toEqual(before);
  expect(() => f.capture(f.raw('om_old', 'text', { text: 'original words' }, { thread_id: 'omt_other' }))).toThrow('message_conflict');
  expect(f.capture(f.raw('om_root', 'text', { text: 'original root' }, { thread_id: 'omt_original' }))).toBe(false);
  expect(f.store.read().inputs).toHaveLength(2);
});

it('rejects a journal with contradictory native aliases before resolving a route', () => {
  const f = fixture();
  expect(f.capture(f.raw('om_one', 'text', { text: 'one' }, { thread_id: 'omt_original' }))).toBe(true);
  f.store.transact(state => { state.inputs.push({ ...state.inputs[0], id: 'another', sequence: 2, messageId: 'om_two', threadId: 'omt_other' }); });
  expect(() => f.runtime.resolveThreadAnchor({ messageId: 'om_reply', chatId: 'oc_chat', senderOpenId: 'ou_owner', threadId: 'omt_original' })).toThrow('journal_invalid');
});
