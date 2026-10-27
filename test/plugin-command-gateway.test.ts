import { describe, expect, it, vi } from 'vitest';
import {
  createPluginCommandGateway,
  resolvePluginCommandTable,
  type PluginCommandInvocation,
} from '../src/core/plugins/commands/gateway.js';
import type {
  InstalledPluginRecord,
  PluginRegistryFile,
  PluginServiceState,
} from '../src/core/plugins/types.js';
import { PLUGIN_COMMAND_REQUEST_MAX_BYTES, PLUGIN_COMMAND_RESPONSE_MAX_BYTES, PLUGIN_COMMAND_REPLY_TEXT_MAX } from '../src/core/plugins/commands/protocol.js';

const makeRecord = (
  id: string,
  options: { commands?: Array<{ name: string; description?: string }>; cardActions?: string[] } = {},
): InstalledPluginRecord => ({
  id,
  packageName: `@botmux-ai/plugin-${id}`,
  version: '1.0.0',
  source: { type: 'local', spec: `/plugins/${id}` },
  manifest: { schemaVersion: 1, id, service: { mode: 'auto' } },
  contributions: {
    service: { entry: 'service/index.js', mode: 'auto' },
    ...(options.commands
      ? { commands: { schemaVersion: 1, endpoint: '/botmux/commands/v1', commands: options.commands } }
      : {}),
    ...(options.cardActions
      ? { cardActions: { schemaVersion: 1, actions: options.cardActions, endpoint: '/botmux/card-actions/v1' } }
      : {}),
  },
  installedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const registryOf = (...records: InstalledPluginRecord[]): PluginRegistryFile => ({
  schemaVersion: 1,
  plugins: Object.fromEntries(records.map(record => [record.id, record])),
});

const onlineState = (pluginId: string, port = 43210): PluginServiceState => ({
  pluginId,
  updatedAt: new Date(0).toISOString(),
  status: 'online',
  port,
});

const invocation = (command = '/work-bind'): PluginCommandInvocation => ({
  eventId: 'om_trigger',
  larkAppId: 'cli_app',
  command,
  args: 'bind',
  chat: { chatId: 'oc_chat', chatType: 'group', anchor: 'om_trigger' },
  sender: { openId: 'ou_sender', unionId: 'on_sender' },
  privileges: { canOperate: true, canTalk: true },
  locale: 'zh',
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const testLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const gatewayWith = (
  records: InstalledPluginRecord[],
  request: (url: string, init: any) => Promise<Response>,
  timeoutMs?: number,
) => createPluginCommandGateway({
  resolvePluginIds: () => records.map(record => record.id),
  readRegistry: () => registryOf(...records),
  readServiceState: pluginId => onlineState(pluginId),
  readToken: () => 'secret-token',
  request,
  timeoutMs,
  log: testLog(),
});

describe('plugin command gateway', () => {
  const records = [makeRecord('work-ledger', { commands: [{ name: '/work-bind' }], cardActions: ['work-ledger.bind'] })];

  it('posts the host-built invocation and returns a card using only its own callbacks', async () => {
    const card = { schema: '2.0', body: { elements: [{ tag: 'button', behaviors: [{ type: 'callback', value: { action: 'work-ledger.bind' } }] }] } };
    const request = vi.fn(async () => jsonResponse({ schemaVersion: 1, reply: { card } }));
    const outcome = await gatewayWith(records, request).execute('work-ledger', invocation());
    expect(outcome).toEqual({ ok: true, reply: { kind: 'card', card } });
    const [url, init] = request.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('http://127.0.0.1:43210/botmux/commands/v1');
    expect(init.headers.authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: 1, ...invocation() });
  });

  it('fails closed on conflicting declarations and on cards with foreign callbacks', async () => {
    expect([...resolvePluginCommandTable([
      makeRecord('a', { commands: [{ name: '/work-bind' }] }),
      makeRecord('b', { commands: [{ name: '/work-bind' }] }),
    ])]).toEqual([['/work-bind', null]]);
    const card = { schema: '2.0', body: { elements: [{ tag: 'button', behaviors: [{ type: 'callback', value: { action: 'someone-else.do' } }] }] } };
    const request = vi.fn(async () => jsonResponse({ schemaVersion: 1, reply: { card } }));
    expect(await gatewayWith(records, request).execute('work-ledger', invocation()))
      .toEqual({ ok: false, error: 'invalid_plugin_command_reply_card_callback' });
  });

  it('re-checks ownership at execution time instead of trusting the routing decision', async () => {
    // Routing saw only work-ledger; by execution a second plugin claims the same name.
    const request = vi.fn(async () => jsonResponse({ schemaVersion: 1 }));
    const nowConflicting = [...records, makeRecord('rival', { commands: [{ name: '/work-bind' }] })];
    expect(await gatewayWith(nowConflicting, request).execute('work-ledger', invocation()))
      .toEqual({ ok: false, error: 'plugin_command_not_routable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects oversized UTF-8 requests before any network call', async () => {
    const request = vi.fn(async () => jsonResponse({ schemaVersion: 1 }));
    expect(await gatewayWith(records, request).execute('work-ledger', {
      ...invocation(), args: '界'.repeat(Math.ceil(PLUGIN_COMMAND_REQUEST_MAX_BYTES / 3)),
    })).toEqual({ ok: false, error: 'plugin_command_request_too_large' });
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts timed-out requests without retrying', async () => {
    const request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    expect(await gatewayWith(records, request, 5).execute('work-ledger', invocation()))
      .toEqual({ ok: false, error: 'plugin_command_timeout' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('isolates redirects, HTTP failures and malformed JSON', async () => {
    for (const status of [302, 503]) {
      const response = new Response('private failure', { status });
      const request = vi.fn(async () => response);
      expect(await gatewayWith(records, request).execute('work-ledger', invocation())).toEqual({
        ok: false, error: `plugin_command_${status === 302 ? 'redirect' : 'http_status'}:${status}`,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(response.bodyUsed).toBe(true);
    }
    expect(await gatewayWith(records, async () => new Response('not JSON')).execute('work-ledger', invocation()))
      .toEqual({ ok: false, error: 'invalid_plugin_command_response_json' });
  });

  it('limits both declared and streamed response bytes', async () => {
    for (const response of [
      new Response('{}', { headers: { 'content-length': String(PLUGIN_COMMAND_RESPONSE_MAX_BYTES + 1) } }),
      new Response(' '.repeat(PLUGIN_COMMAND_RESPONSE_MAX_BYTES + 1)),
    ]) {
      expect(await gatewayWith(records, async () => response).execute('work-ledger', invocation()))
        .toEqual({ ok: false, error: 'plugin_command_response_too_large' });
    }
  });

  it('requires exactly one reply kind and bounds text without rejecting valid text', async () => {
    const executeReply = (reply: unknown) => gatewayWith(records, async () => jsonResponse({ schemaVersion: 1, reply }))
      .execute('work-ledger', invocation());
    expect(await executeReply({ text: 'ok', card: {} }))
      .toEqual({ ok: false, error: 'invalid_plugin_command_reply_shape' });
    expect(await executeReply({}))
      .toEqual({ ok: false, error: 'invalid_plugin_command_reply_shape' });
    expect(await executeReply({ text: 'a'.repeat(PLUGIN_COMMAND_REPLY_TEXT_MAX + 1) }))
      .toEqual({ ok: false, error: 'invalid_plugin_command_reply_text' });
    const text = 'a'.repeat(PLUGIN_COMMAND_REPLY_TEXT_MAX);
    expect(await executeReply({ text })).toEqual({ ok: true, reply: { kind: 'text', text } });
  });
});
