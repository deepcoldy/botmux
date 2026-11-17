import { describe, expect, it } from 'vitest';
import { classifySlash, isCommandDecision, type SlashRouteInput } from '../src/core/command-router.js';
import { resolveDelegatedSlashCommands } from '../src/adapters/backend/remote-runner-config.js';
import { SESSION_PHASES } from '../src/core/session-phase.js';

const base: SlashRouteInput = {
  cliId: 'remote-runner', text: '/adopt', context: 'thread', phase: 'none',
  passthrough: new Set(['/compact']), coldStartPassthrough: new Set(),
  senderIsBot: false, acceptSlashFromBots: true,
};
const enabled = resolveDelegatedSlashCommands({ delegatedSlashCommands: ['/adopt', '/detach'] }, 'remote-runner');

describe('provider-owned structured slash turns', () => {
  for (const context of ['new-topic', 'thread'] as const) {
    for (const phase of SESSION_PHASES) {
      it(`${context}/${phase}: applies distinct adopt/detach session policies and retains original text`, () => {
        for (const text of ['/ADOPT  remote:alpha', '/detach', '/DISCONNECT']) {
          const decision = classifySlash({ ...base, context, phase, text, delegatedCommands: enabled });
          expect(decision).toEqual({ kind: 'delegated_turn', cmd: text.split(/\s/)[0]!.toLowerCase(), content: text,
            sessionPolicy: phase !== 'none' && phase !== 'closed' ? 'existing'
              : text.toLowerCase().startsWith('/adopt') ? 'precreate' : 'unbound' });
          expect(isCommandDecision(decision)).toBe(true);
        }
      });
    }
  }
  it.each(['pty', 'tmux', 'riff', 'mojo', 'codex-app', undefined])('keeps other backend routes unchanged: %s', backend => {
    for (const text of ['/adopt alpha', '/detach', '/disconnect', '/stop', '/close', '/compact', '/new', '/fork']) {
      const plain = classifySlash({ ...base, text });
      expect(classifySlash({ ...base, text, delegatedCommands:
        resolveDelegatedSlashCommands({ delegatedSlashCommands: ['/adopt', '/detach'] }, backend) })).toEqual(plain);
    }
  });
  it('defaults off, respects per-command opt-in and cannot delegate arbitrary commands', () => {
    for (const delegatedCommands of [undefined, new Set<string>(), new Set(['/close', '/stop'])]) {
      for (const text of ['/adopt', '/detach', '/close', '/stop']) {
        expect(classifySlash({ ...base, text, delegatedCommands })).toEqual(classifySlash({ ...base, text }));
      }
    }
    expect(classifySlash({ ...base, text: '/disconnect', delegatedCommands: new Set(['/adopt']) }).kind).toBe('daemon');
  });
  it('preserves bot gating and discussion parsing before delegation', () => {
    expect(classifySlash({ ...base, delegatedCommands: enabled, senderIsBot: true, acceptSlashFromBots: false }))
      .toEqual({ kind: 'forward', reason: 'bot_gated' });
    for (const text of ['/adopt <target>', '/adopt\n/detach', '/adopt\nexplanation']) {
      expect(classifySlash({ ...base, delegatedCommands: enabled, text })).toEqual({ kind: 'forward', reason: 'discussion' });
    }
  });
});
