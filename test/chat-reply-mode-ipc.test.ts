import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

describe('chat reply mode daemon IPC', () => {
  let dir: string;
  let configPath: string;
  let handle: IpcServerHandle | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-chat-reply-mode-ipc-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_reply_mode_ipc',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      regularGroupReplyMode: 'new-topic',
    }], null, 2));
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    delete process.env.BOTS_CONFIG;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('supports GET status, strict PUT set, compatible POST set, and DELETE inherit', async () => {
    const registry = await import('../src/bot-registry.js');
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    const larkClient = await import('../src/im/lark/client.js');
    const chatModeSpy = vi.spyOn(larkClient, 'getChatModeStrict').mockResolvedValue('group');
    const ipc = await import('../src/core/dashboard-ipc-server.js');
    ipc.setLarkAppId('app_reply_mode_ipc');
    handle = await ipc.startIpcServer({ port: 0, host: '127.0.0.1' });
    const endpoint = `http://127.0.0.1:${handle.port}/api/chat-reply-mode?chatId=oc_ipc`;

    const initial = await fetch(endpoint);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      ok: true,
      chatId: 'oc_ipc',
      override: null,
      default: 'new-topic',
      effective: 'new-topic',
      inherited: true,
    });

    const set = await fetch(`http://127.0.0.1:${handle.port}/api/chat-reply-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_ipc', mode: 'topic' }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      ok: true,
      chatId: 'oc_ipc',
      mode: 'shared',
      override: 'shared',
      default: 'new-topic',
      effective: 'shared',
      inherited: false,
    });

    chatModeSpy.mockResolvedValueOnce('topic');
    const rejectedTopic = await fetch(`http://127.0.0.1:${handle.port}/api/chat-reply-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_topic', mode: 'chat' }),
    });
    expect(rejectedTopic.status).toBe(409);
    expect(await rejectedTopic.json()).toEqual({ ok: false, reason: 'topic_group_not_configurable' });

    chatModeSpy.mockResolvedValueOnce('unknown');
    const rejectedUnknown = await fetch(`http://127.0.0.1:${handle.port}/api/chat-reply-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_unknown', mode: 'chat' }),
    });
    expect(rejectedUnknown.status).toBe(503);
    expect(await rejectedUnknown.json()).toEqual({ ok: false, reason: 'chat_mode_unconfirmed' });

    chatModeSpy.mockClear();
    const compatiblePost = await fetch(`http://127.0.0.1:${handle.port}/api/chat-reply-mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_vc_consumer', mode: 'chat' }),
    });
    expect(compatiblePost.status).toBe(200);
    expect(chatModeSpy).not.toHaveBeenCalled();

    chatModeSpy.mockResolvedValueOnce('topic');
    const cleared = await fetch(endpoint, { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      ok: true,
      chatId: 'oc_ipc',
      cleared: true,
      override: null,
      effective: 'new-topic',
      inherited: true,
    });
    // Clear is a safe local cleanup and deliberately does not query topology,
    // even when the chat is now a topic group or the API is unavailable.
    expect(chatModeSpy).not.toHaveBeenCalled();
  });

  it('validates chatId for GET and DELETE', async () => {
    const registry = await import('../src/bot-registry.js');
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));
    const ipc = await import('../src/core/dashboard-ipc-server.js');
    ipc.setLarkAppId('app_reply_mode_ipc');
    handle = await ipc.startIpcServer({ port: 0, host: '127.0.0.1' });
    const endpoint = `http://127.0.0.1:${handle.port}/api/chat-reply-mode`;

    expect((await fetch(endpoint)).status).toBe(400);
    expect((await fetch(endpoint, { method: 'DELETE' })).status).toBe(400);
  });
});
