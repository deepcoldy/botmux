import { describe, expect, it } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { classifySlash, type SlashRouteInput } from '../src/core/command-router.js';
import { PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';

describe.each([
  ['TRAE CLI', createTraexAdapter],
  ['Codex', createCodexAdapter],
] as const)('%s native goal routing', (_name, createAdapter) => {
  function input(text: string): SlashRouteInput {
    const adapter = createAdapter();
    const defaults = adapter.defaultPassthroughCommands ?? [];
    return {
      cliId: adapter.id,
      text,
      context: 'new-topic',
      phase: 'none',
      passthrough: new Set([...PASSTHROUGH_COMMANDS, ...defaults]),
      coldStartPassthrough: new Set(defaults),
      senderIsBot: false,
      acceptSlashFromBots: false,
    };
  }

  it('cold-starts a topic with the literal goal command', () => {
    expect(classifySlash(input('/goal 修复登录并通过测试'))).toEqual({
      kind: 'passthrough', cmd: '/goal',
      content: '/goal 修复登录并通过测试', delivery: 'cold_start',
    });
  });

  it.each(['/goal', '/goal pause', '/goal resume', '/goal clear'])('relays %s to an existing session', text => {
    expect(classifySlash({ ...input(text), context: 'thread', phase: 'running' })).toEqual({
      kind: 'passthrough', cmd: '/goal', content: text, delivery: 'to_session',
    });
  });

  it('honors the bot slash-command gate before cold-starting', () => {
    expect(classifySlash({ ...input('/goal fix login'), senderIsBot: true })).toEqual({
      kind: 'forward', reason: 'bot_gated',
    });
  });
});
