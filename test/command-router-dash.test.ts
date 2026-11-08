import { describe, expect, it } from 'vitest';

import {
  DAEMON_COMMANDS,
  SESSIONLESS_DAEMON_COMMANDS,
  commandSpec,
  isBuiltinMentionlessInvocation,
} from '../src/core/command-schema.js';
import {
  classifySlash,
  parseSlashCommandInvocation,
} from '../src/core/command-router.js';
import { reservedCommandKind } from '../src/services/command-trigger.js';

function baseInput(over: Partial<Parameters<typeof classifySlash>[0]> = {}): Parameters<typeof classifySlash>[0] {
  return {
    text: '/dash',
    context: 'new-topic',
    phase: 'none',
    passthrough: new Set(),
    coldStartPassthrough: new Set(),
    senderIsBot: false,
    acceptSlashFromBots: true,
    ...over,
  };
}

describe('/dash native daemon command', () => {
  it('is registered as a sessionless daemon command (with /dashboard link sharing the policy)', () => {
    expect(DAEMON_COMMANDS.has('/dash')).toBe(true);
    expect(SESSIONLESS_DAEMON_COMMANDS.has('/dash')).toBe(true);
    expect(commandSpec('/dash')?.sessionPolicy).toBe('sessionless');
    expect(commandSpec('/dashboard')?.sessionPolicy).toBe('sessionless');
  });

  it.each([
    { where: 'topic-group top-level seed', context: 'new-topic' as const, phase: 'none' as const },
    { where: 'topic reply without session', context: 'thread' as const, phase: 'none' as const },
    { where: 'topic reply in a closed session', context: 'thread' as const, phase: 'closed' as const },
  ])('is classified sessionless daemon for $where', ({ context, phase }) => {
    const d = classifySlash(baseInput({ context, phase }));
    expect(d).toEqual({ kind: 'daemon', cmd: '/dash', content: '/dash', sessionPolicy: 'sessionless' });
  });

  it('classifies /dashboard link as the sessionless /dashboard daemon command', () => {
    const d = classifySlash(baseInput({ text: '/dashboard link' }));
    expect(d).toMatchObject({ kind: 'daemon', cmd: '/dashboard', sessionPolicy: 'sessionless' });
  });

  it('is a reserved command, so custom commandTriggers can never hijack it', () => {
    expect(reservedCommandKind('/dash')).toBe('daemon');
    // Even with a CLI whose passthrough set (incorrectly) contains it, reserved wins.
    expect(reservedCommandKind('/dash', new Set(['/dash']))).toBe('daemon');
  });

  it('parses bare / mention-stripped / whitespace-padded invocations identically', () => {
    expect(parseSlashCommandInvocation('/dash')?.cmd).toBe('/dash');
    expect(parseSlashCommandInvocation('/dash ')?.cmd).toBe('/dash');
    expect(parseSlashCommandInvocation(' /dash')?.cmd).toBe('/dash');
    expect(parseSlashCommandInvocation('\t/dash\r\n')?.cmd).toBe('/dash');
    expect(parseSlashCommandInvocation('/DASH')?.cmd).toBe('/dash');
    // The dispatcher strips leading structured @mentions before parsing;
    // whatever whitespace remains must not defeat recognition.
    expect(parseSlashCommandInvocation(' /dash  ')?.cmd).toBe('/dash');
  });

  it('mention-free built-in gate covers /dash and /dashboard link, but no other /dashboard subcommand', () => {
    expect(isBuiltinMentionlessInvocation('/dash', '/dash')).toBe(true);
    expect(isBuiltinMentionlessInvocation('/dashboard', '/dashboard link')).toBe(true);
    expect(isBuiltinMentionlessInvocation('/dashboard', '  /dashboard link  ')).toBe(true);
    expect(isBuiltinMentionlessInvocation('/dashboard', '/dashboard sessions')).toBe(false);
    expect(isBuiltinMentionlessInvocation('/dashboard', '/dashboard links')).toBe(false);
    expect(isBuiltinMentionlessInvocation('/dashboard', '/dashboard')).toBe(false);
    expect(isBuiltinMentionlessInvocation('/close', '/close')).toBe(false);
    expect(isBuiltinMentionlessInvocation(undefined, '/dash')).toBe(false);
  });
});
