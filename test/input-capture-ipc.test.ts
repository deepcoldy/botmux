import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, setIpcAuthSecret } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { createInputCaptureStore } from '../src/core/plugins/input-capture/store.js';
import { createInputCaptureRuntime, setInputCaptureRuntime } from '../src/core/plugins/input-capture/runtime.js';
import { captureInboundText } from '../src/im/lark/input-capture.js';
import { parseInputCaptureCommand } from '../src/cli/input-capture.js';
import type { InputBinding } from '../src/core/plugins/input-capture/store.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function setup(ownerless = false) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-ipc-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, 'cli_capture');
  const runtime = createInputCaptureRuntime({ larkAppId: 'cli_capture', store,
    session: id => id === 's' ? { sessionId: 's', larkAppId: 'cli_capture', chatId: 'oc_chat', anchor: 'oc_chat', ownerOpenId: ownerless ? '' : 'ou_owner', active: true, scope: 'chat', chatType: 'group' } : undefined,
    pluginEnabled: id => id === 'example', canTalk: () => true, deliver: async () => { throw new Error('offline'); } });
  cleanup.push(() => runtime.stop()); return { runtime, store };
}
it('authenticates and validates paged inspect through the production CLI and IPC route', async () => {
  const f = setup(); setInputCaptureRuntime('cli_capture', f.runtime); setLarkAppId('cli_capture'); setIpcAuthSecret('capture-test-secret');
  const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanup.push(() => server.close());
  const binding = f.runtime.register('s', { pluginId: 'example', requestId: 'page', providerRef: 'opaque' });
  for (let i = 0; i < 3; i++) f.runtime.capture({ messageId: `om_page${i}`, chatId: 'oc_chat', anchor: 'oc_chat',
    senderOpenId: 'ou_owner', text: 'x'.repeat(64 * 1024), botSender: false });
  const args = ['inspect', '--bot', 'cli_capture', '--session', 's', '--binding', binding.id];
  const first = parseInputCaptureCommand([...args, '--after', '0']);
  expect((await fetch(`http://127.0.0.1:${server.port}${first.path}`, first.init)).status).toBe(401);
  const response = await fetchDaemonIpc(server.port, first.path, first.init, 'capture-test-secret');
  expect(response.status).toBe(200);
  const page = (await response.json()).result;
  expect(page).toMatchObject({ throughSequence: 3, nextSequence: 1 }); expect(page.inputs).toHaveLength(1);
  const next = parseInputCaptureCommand([...args, '--after', '1', '--through', '3']);
  const nextPage = (await (await fetchDaemonIpc(server.port, next.path, next.init, 'capture-test-secret')).json()).result;
  expect(nextPage.inputs[0].sequence).toBe(2); expect(nextPage.throughSequence).toBe(3);
  for (const patch of [{ after: '0' }, { after: -1 }, { after: 0, through: 4 }, { after: 0, through: null }]) {
    const invalid = await fetchDaemonIpc(server.port, first.path, { ...first.init,
      body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'inspect', bindingId: binding.id, ...patch }) }, 'capture-test-secret');
    expect(invalid.status).toBe(400); expect((await invalid.json()).error).toBe('invalid_input_capture_page');
  }
  expect(f.store.read().inputs).toHaveLength(3);
});
it('requires real host HMAC before register and keeps query / revoke bound to the source session', async () => {
  const f = setup(); setInputCaptureRuntime('cli_capture', f.runtime); setLarkAppId('cli_capture'); setIpcAuthSecret('capture-test-secret');
  const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanup.push(() => server.close());
  const path = '/api/sessions/s/input-capture';
  const init = parseInputCaptureCommand(['register', '--bot', 'cli_capture', '--session', 's', '--plugin', 'example',
    '--request', 'r', '--ref', 'opaque', '--input-anchor', 'om_card', '--capture-attachments', 'true']).init;
  expect((await fetch(`http://127.0.0.1:${server.port}${path}`, init)).status).toBe(401);
  expect(f.store.read().bindings).toEqual([]);
  const registered = await fetchDaemonIpc(server.port, path, init, 'capture-test-secret'); expect(registered.status).toBe(200);
  const body = await registered.json(); expect(body.result).toMatchObject({ anchor: 'om_card', sourceAnchor: 'oc_chat', captureAttachments: true });
  expect(captureInboundText({ sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: 'om_upload', chat_id: 'oc_chat', chat_type: 'group', root_id: 'om_card',
      message_type: 'file', content: JSON.stringify({ file_key: 'file_material', file_name: 'approve.txt' }) } }, f.runtime, () => false)).toBe(true);
  expect(f.store.read().inputs[0]).toMatchObject({ text: '', attachments: [{ messageId: 'om_upload', type: 'file', key: 'file_material' }] });
  const inspect = { ...init, body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'inspect', bindingId: body.result.id }) };
  expect((await fetchDaemonIpc(server.port, '/api/sessions/other/input-capture', inspect, 'capture-test-secret')).status).toBe(404);
  const revoked = await fetchDaemonIpc(server.port, path, { ...init, body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'revoke', bindingId: body.result.id, expectedRevision: 1 }) }, 'capture-test-secret');
  expect((await revoked.json()).result.active).toBe(false);
});
it('captures a plugin card reply synchronously while preserving commands, attachments and other topics', async () => {
  const f = setup(); f.runtime.register('s', { pluginId: 'example', requestId: 'r', providerRef: 'opaque', inputAnchor: 'om_card' });
  const event = (text: string, patch = {}) => ({ sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: 'om_reply', chat_id: 'oc_chat', chat_type: 'group', root_id: 'om_card', message_type: 'text', content: JSON.stringify({ text }), ...patch } });
  for (const text of ['/stop', '/workflow new inspect']) expect(captureInboundText(event(text), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('file', { message_type: 'file', content: JSON.stringify({ file_key: 'f', file_name: 'input.txt' }) }), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('other', { root_id: 'om_other' }), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('inspect only'), f.runtime, () => false)).toBe(true);
  // No await between the production ingress handler and this disk read.
  expect(f.store.read().inputs[0].text).toBe('inspect only');
  await f.runtime.drain(); f.runtime.revoke('s', f.store.read().bindings[0].id, 1);
  expect(captureInboundText(event('inspect only'), f.runtime, () => false)).toBe(true);
  expect(f.store.read().inputs).toHaveLength(1);
});
it('authenticates batch revocation and reports atomic conflicts through the real CLI request shape', async () => {
  const f = setup(); setInputCaptureRuntime('cli_capture', f.runtime); setLarkAppId('cli_capture'); setIpcAuthSecret('capture-test-secret');
  const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanup.push(() => server.close());
  const bindings: InputBinding[] = [];
  for (const anchor of ['oc_chat', 'om_card']) {
    const command = parseInputCaptureCommand(['register', '--bot', 'cli_capture', '--session', 's', '--plugin', 'example', '--request', anchor, '--ref', 'opaque',
      ...(anchor === 'om_card' ? ['--input-anchor', anchor] : [])]);
    const response = await fetchDaemonIpc(server.port, command.path, command.init, 'capture-test-secret');
    expect(response.status).toBe(200); bindings.push((await response.json()).result);
  }
  const commandFor = (counts: number[]) => parseInputCaptureCommand(['revoke-set', '--bot', 'cli_capture', '--session', 's', '--bindings',
    JSON.stringify(bindings.map((binding, index) => ({ bindingId: binding.id, expectedRevision: 1, expectedInputCount: counts[index] })))]);
  const stale = commandFor([0, 0]);
  expect((await fetch(`http://127.0.0.1:${server.port}${stale.path}`, stale.init)).status).toBe(401);
  f.runtime.capture({ messageId: 'om_new', chatId: 'oc_chat', anchor: 'om_card', senderOpenId: 'ou_owner', text: 'new input', botSender: false });
  await f.runtime.drain();
  const conflict = await fetchDaemonIpc(server.port, stale.path, stale.init, 'capture-test-secret');
  expect(conflict.status).toBe(409); expect((await conflict.json()).error).toBe('input_capture_inputs_conflict');
  expect(f.store.read().bindings.map(binding => binding.active)).toEqual([true, true]);
  const invalid = await fetchDaemonIpc(server.port, stale.path, { ...stale.init,
    body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'revoke-set', bindings: [] }) }, 'capture-test-secret');
  expect(invalid.status).toBe(400); expect((await invalid.json()).error).toBe('invalid_input_capture_conditions');
  const current = commandFor([0, 1]);
  expect((await fetchDaemonIpc(server.port, '/api/sessions/other/input-capture', current.init, 'capture-test-secret')).status).toBe(409);
  const revoked = await fetchDaemonIpc(server.port, current.path, current.init, 'capture-test-secret');
  expect(revoked.status).toBe(200);
  const result = (await revoked.json()).result;
  expect(result.bindings.map((row: { binding: InputBinding; inputCount: number }) => [row.binding.id, row.binding.active, row.inputCount])).toEqual([
    [bindings[0].id, false, 0], [bindings[1].id, false, 1],
  ]);
  expect(f.store.read().inputs).toHaveLength(1);
});

it.each([
  'Task /th inspect', 'Task /tw inspect', 'Task /t here inspect',
  'Task /topic worktree inspect', 'Task /t /repo wt demo feature/fix inspect',
  'Task /t /repo wt', 'Task /t /model',
])('leaves titled topic commands and invalid headers with the native router: %s', async text => {
  const f = setup(); f.runtime.register('s', { pluginId: 'example', requestId: 'r', providerRef: 'opaque', inputAnchor: 'om_card', captureAttachments: true });
  const event = (messageId: string, messageType: string, content: unknown) => ({ sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: 'oc_chat', chat_type: 'group', root_id: 'om_card', message_type: messageType, content: JSON.stringify(content) } });
  expect(captureInboundText(event('om_text', 'text', { text }), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('om_post', 'post', { content: [[{ tag: 'text', text }, { tag: 'img', image_key: 'img_example' }]] }), f.runtime, () => false)).toBe(false);
  expect(f.store.read().inputs).toHaveLength(0);
  expect(captureInboundText(event('om_answer', 'text', { text: 'Inspect only after Review passes' }), f.runtime, () => false)).toBe(true);
  expect(f.store.read().inputs).toHaveLength(1);
  expect(f.store.read().inputs[0].text).toBe('Inspect only after Review passes');
  await f.runtime.drain();
});

it('uses the explicit group actor through the real host-authenticated CLI/IPC registration', async () => {
  const f = setup(true); setInputCaptureRuntime('cli_capture', f.runtime); setLarkAppId('cli_capture'); setIpcAuthSecret('capture-test-secret');
  const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanup.push(() => server.close());
  const command = parseInputCaptureCommand(['register', '--bot', 'cli_capture', '--session', 's', '--plugin', 'example',
    '--request', 'group', '--ref', 'question:group', '--actor', 'ou_owner']);
  expect((await fetch(`http://127.0.0.1:${server.port}${command.path}`, command.init)).status).toBe(401);
  const response = await fetchDaemonIpc(server.port, command.path, command.init, 'capture-test-secret');
  expect(response.status).toBe(200);
  expect((await response.json()).result).toMatchObject({ ownerOpenId: 'ou_owner', anchor: 'oc_chat' });
  expect(captureInboundText({ sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: 'om_group_answer', chat_id: 'oc_chat', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: 'confirmed scope only' }) } }, f.runtime, () => false)).toBe(true);
  expect(f.store.read().inputs).toHaveLength(1);
});
