import { describe, expect, it, vi } from 'vitest';
import { runPluginSlashCommand, type PluginSlashCommandDeps, type PluginSlashCommandInput } from '../src/core/plugins/commands/execute.js';

const input = (overrides: Partial<PluginSlashCommandInput> = {}): PluginSlashCommandInput => ({
  cmd: '/work-bind',
  content: '/work-bind  status --all ',
  pluginId: 'work-ledger',
  larkAppId: 'cli_app',
  chatId: 'oc_chat',
  chatType: 'group',
  anchor: 'om_anchor',
  messageId: 'om_msg',
  senderOpenId: 'ou_sender',
  senderUnionId: 'on_sender',
  locale: 'zh',
  ...overrides,
});

const depsWith = (overrides: Partial<PluginSlashCommandDeps> = {}) => {
  const deps = {
    restrictedText: vi.fn(() => undefined),
    canTalk: vi.fn(() => true),
    canOperate: vi.fn(() => false),
    onAdmitted: vi.fn(),
    execute: vi.fn(async () => ({ ok: true as const, reply: { kind: 'card' as const, card: { schema: '2.0' } } })),
    reply: vi.fn(async () => undefined),
    text: vi.fn((key: string) => `text:${key}`),
    ...overrides,
  };
  return deps;
};

describe('runPluginSlashCommand', () => {
  it('forwards args and host privileges, then posts the plugin card', async () => {
    const deps = depsWith();
    await runPluginSlashCommand(input(), deps);
    expect(deps.execute).toHaveBeenCalledWith('work-ledger', {
      eventId: 'om_msg',
      larkAppId: 'cli_app',
      command: '/work-bind',
      args: 'status --all',
      chat: { chatId: 'oc_chat', chatType: 'group', anchor: 'om_anchor' },
      sender: { openId: 'ou_sender', unionId: 'on_sender' },
      privileges: { canOperate: false, canTalk: true },
      locale: 'zh',
    });
    expect(deps.reply).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ schema: '2.0' }), 'interactive');
  });

  it('never reaches the plugin when admission fails, in restricted → canTalk → conflict order', async () => {
    const restricted = depsWith({ restrictedText: vi.fn(() => 'restricted'), canTalk: vi.fn(() => false) });
    await runPluginSlashCommand(input({ pluginId: null }), restricted);
    expect(restricted.reply).toHaveBeenCalledExactlyOnceWith('restricted', 'text');

    const silenced = depsWith({ canTalk: vi.fn(() => false) });
    await runPluginSlashCommand(input({ pluginId: null }), silenced);
    expect(silenced.reply).toHaveBeenCalledExactlyOnceWith('text:daemon.cmd_allowed_users_only', 'text');

    const conflict = depsWith();
    await runPluginSlashCommand(input({ pluginId: null }), conflict);
    expect(conflict.reply).toHaveBeenCalledExactlyOnceWith('text:daemon.plugin_command_conflict', 'text');

    for (const deps of [restricted, silenced, conflict]) {
      expect(deps.execute).not.toHaveBeenCalled();
      expect(deps.onAdmitted).not.toHaveBeenCalled();
    }
  });

  it('marks admission before executing even when delivery fails or the plugin times out', async () => {
    const deps = depsWith({ reply: vi.fn(async () => { throw new Error('delivery failed'); }) });
    deps.execute.mockImplementation(async () => {
      expect(deps.onAdmitted).toHaveBeenCalledTimes(1);
      return { ok: true, reply: { kind: 'card', card: { schema: '2.0' } } };
    });
    await expect(runPluginSlashCommand(input(), deps)).rejects.toThrow('delivery failed');
    expect(deps.onAdmitted).toHaveBeenCalledTimes(1);

    const failed = depsWith({ execute: vi.fn(async () => ({ ok: false, error: 'plugin_command_timeout' })) });
    await runPluginSlashCommand(input(), failed);
    expect(failed.onAdmitted).toHaveBeenCalledTimes(1);
    expect(failed.onAdmitted.mock.invocationCallOrder[0]).toBeLessThan(failed.execute.mock.invocationCallOrder[0]);
    expect(failed.reply).toHaveBeenCalledExactlyOnceWith('text:daemon.plugin_command_unavailable', 'text');
  });

  it('posts text replies as text rather than interactive cards', async () => {
    const deps = depsWith({ execute: vi.fn(async () => ({ ok: true, reply: { kind: 'text', text: 'done' } })) });
    await runPluginSlashCommand(input(), deps);
    expect(deps.reply).toHaveBeenCalledExactlyOnceWith('done', 'text');
  });
});
