import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
}));

// rmwBotEntry is the real bots.json read-modify-write; here it just runs the
// mutation against an in-memory entry so the tests assert the SHAPE that would
// be persisted.
let entry: any;
vi.mock('../src/services/config-store.js', () => ({
  rmwBotEntry: async (_id: string, mutate: (e: any, raw: any[]) => any) => {
    const out = mutate(entry, [entry]);
    return { ok: true, result: out.result };
  },
}));

const {
  validateCommandTriggerUpdate,
  updateCommandTriggerConfig,
  setCommandTriggerChatEnabled,
} = await import('../src/services/command-trigger-store.js');
const { MAX_COMMAND_TRIGGER_PROMPT_BYTES } = await import('../src/services/command-trigger-normalize.js');

beforeEach(() => {
  entry = {};
  mockGetBot.mockReturnValue({ config: {} });
});

describe('validateCommandTriggerUpdate', () => {
  it('accepts a plain command list', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/solve', '/triage'] }))
      .toEqual({ ok: true });
  });

  it('rejects botmux daemon commands', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/solve', '/close'] }))
      .toEqual({ ok: false, reason: 'reserved_command', conflicts: [{ cmd: '/close', kind: 'daemon' }] });
  });

  it('rejects passthrough commands relayed to the CLI', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/clear'] }))
      .toEqual({ ok: false, reason: 'reserved_command', conflicts: [{ cmd: '/clear', kind: 'passthrough' }] });
  });

  it('rejects the /t routing meta-command', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/t'] }))
      .toEqual({ ok: false, reason: 'reserved_command', conflicts: [{ cmd: '/t', kind: 'force-topic' }] });
  });

  it('rejects a CLI-specific passthrough command when the caller supplies the set', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/goal'] })).toEqual({ ok: true });
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['/goal'] }, new Set(['/goal'])))
      .toEqual({ ok: false, reason: 'reserved_command', conflicts: [{ cmd: '/goal', kind: 'passthrough' }] });
  });

  it('rejects malformed command tokens', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: ['solve', '/a b'] }))
      .toEqual({ ok: false, reason: 'invalid_command', invalid: ['solve', '/a b'] });
    expect(validateCommandTriggerUpdate({ enabled: true, commands: [{ cmd: 'solve', prompt: 'x' }] }))
      .toEqual({ ok: false, reason: 'invalid_command', invalid: ['solve'] });
  });

  it('accepts a command carrying a prompt template', () => {
    expect(validateCommandTriggerUpdate({
      enabled: true,
      commands: [{ cmd: '/solve', prompt: '先复现再改：{args}' }],
    })).toEqual({ ok: true });
  });

  // 归一化会截断超长模板；写入路径不该悄悄截，得让人知道没存全。
  it('rejects an oversized prompt template instead of silently truncating', () => {
    expect(validateCommandTriggerUpdate({
      enabled: true,
      commands: [{ cmd: '/solve', prompt: 'x'.repeat(MAX_COMMAND_TRIGGER_PROMPT_BYTES + 1) }],
    })).toEqual({ ok: false, reason: 'prompt_too_large', oversized: ['/solve'] });
  });

  it('rejects an enabled config with no command', () => {
    expect(validateCommandTriggerUpdate({ enabled: true, commands: [] }))
      .toEqual({ ok: false, reason: 'commands_required' });
  });

  it('allows a disabled empty config (that is a delete)', () => {
    expect(validateCommandTriggerUpdate({ enabled: false, commands: [] })).toEqual({ ok: true });
  });
});

describe('updateCommandTriggerConfig', () => {
  it('persists a normalized config and mirrors it onto the live bot', async () => {
    const bot = { config: {} as any };
    mockGetBot.mockReturnValue(bot);
    const res = await updateCommandTriggerConfig('app', {
      enabled: true,
      commands: [{ cmd: '/Solve', prompt: '先复现再改：{args}' }, '/solve'],
      chats: ['oc_a'],
    });
    const expected = {
      enabled: true,
      commands: [{ cmd: '/solve', prompt: '先复现再改：{args}' }],
      chats: ['oc_a'],
    };
    expect(res).toEqual({ ok: true, config: expected });
    expect(entry.commandTriggers).toEqual(expected);
    expect(bot.config.commandTriggers).toEqual(expected);
  });

  it('deletes the entry when the command list empties out', async () => {
    entry = { commandTriggers: { enabled: true, commands: [{ cmd: '/solve' }] } };
    const res = await updateCommandTriggerConfig('app', { enabled: false, commands: [] });
    expect(res).toEqual({ ok: true, config: null });
    expect(entry).not.toHaveProperty('commandTriggers');
  });

  it('refuses a reserved command instead of writing it', async () => {
    const res = await updateCommandTriggerConfig('app', { enabled: true, commands: ['/close'] });
    expect(res).toMatchObject({ ok: false, reason: 'reserved_command' });
    expect(entry).not.toHaveProperty('commandTriggers');
  });
});

describe('setCommandTriggerChatEnabled', () => {
  it('adds/removes from the allow-list in allow-list mode', async () => {
    const bot = { config: { commandTriggers: { enabled: true, commands: [{ cmd: '/solve' }], chats: ['oc_a'] } } };
    mockGetBot.mockReturnValue(bot);
    entry = { commandTriggers: { ...bot.config.commandTriggers } };

    await setCommandTriggerChatEnabled('app', 'oc_b', true);
    expect(entry.commandTriggers.chats).toEqual(['oc_a', 'oc_b']);

    bot.config.commandTriggers = entry.commandTriggers;
    await setCommandTriggerChatEnabled('app', 'oc_a', false);
    expect(entry.commandTriggers.chats).toEqual(['oc_b']);
  });

  // 清空白名单会静默变成「所有群」——语义反转，必须挡住。
  it('refuses to empty the allow-list', async () => {
    mockGetBot.mockReturnValue({ config: { commandTriggers: { enabled: true, commands: [{ cmd: '/solve' }], chats: ['oc_a'] } } });
    expect(await setCommandTriggerChatEnabled('app', 'oc_a', false))
      .toEqual({ ok: false, reason: 'last_chat_in_scope' });
  });

  it('adds/removes from the block-list in all-groups mode', async () => {
    const bot = { config: { commandTriggers: { enabled: true, commands: [{ cmd: '/solve' }] } } };
    mockGetBot.mockReturnValue(bot);
    entry = { commandTriggers: { ...bot.config.commandTriggers } };

    await setCommandTriggerChatEnabled('app', 'oc_a', false);
    expect(entry.commandTriggers.excludedChats).toEqual(['oc_a']);

    bot.config.commandTriggers = entry.commandTriggers;
    await setCommandTriggerChatEnabled('app', 'oc_a', true);
    expect(entry.commandTriggers).not.toHaveProperty('excludedChats');
  });

  it('needs an existing config', async () => {
    mockGetBot.mockReturnValue({ config: {} });
    expect(await setCommandTriggerChatEnabled('app', 'oc_a', true))
      .toEqual({ ok: false, reason: 'not_configured' });
  });
});
