import * as sessionStore from '../src/services/session-store.js';
import { admitQueuedActivationTail } from '../src/core/worker-pool.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFollowUpCliInput, buildNewTopicCliInput, buildReforkCliInput } from '../src/core/session-manager.js';
import { registerBot } from '../src/bot-registry.js';
import { admitDelegatedSlashTurn, queuedOpeningHasTail, sessionDelegatedSlashCommands } from '../src/core/remote-runner-slash.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CliTurnPayload } from '../src/types.js';

const caller = { requestUserOpenId: 'ou_operator', requestLarkAppId: 'cli_accepted', senderType: 'user' as const };
const command: CliTurnPayload = { content: '/ADOPT  remote:alpha', trustedCaller: caller };

function remoteSession(): DaemonSession {
  return { larkAppId: 'cli_accepted', chatId: 'oc_accepted', session: {
    sessionId: 'accepted-session', chatId: 'oc_accepted', cliId: 'remote-runner', backendType: 'remote-runner',
    status: 'active', title: 'accepted', rootMessageId: 'om_root', createdAt: new Date().toISOString(),
  } } as DaemonSession;
}
registerBot({ larkAppId: 'cli_accepted', larkAppSecret: 's', cliId: 'remote-runner', backendType: 'remote-runner', linkRefs: { mode: 'enabled' } });

describe('host accepted input finalization', () => {
  it('preserves exact command, caller and LinkRefs through all input builders', () => {
    const options = { acceptedInput: command, cliId: 'remote-runner' as const,
      larkAppId: 'cli_accepted', linkRefMode: 'enabled' as const };
    const opening = buildNewTopicCliInput('decorated message', 'accepted-session', 'remote-runner',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, options);
    const followup = buildFollowUpCliInput('decorated message', 'accepted-session', options);
    const refork = buildReforkCliInput(remoteSession(), 'decorated message', { acceptedInput: command, cliId: 'remote-runner' });
    for (const payload of [opening, followup, refork]) {
      expect(payload.content).toBe(command.content);
      expect(payload.trustedCaller).toEqual(caller);
      expect(payload.linkRefs).toBeDefined();
    }
    expect(opening.linkRefs?.mode).toBe('enabled');
    expect(followup.linkRefs?.mode).toBe('enabled');
  });

  it('does not import unrelated CLI sidecars or controller flags from accepted input', () => {
    const oversized: CliTurnPayload = { ...command, codexAppInput: { text: 'unrelated sidecar' },
      nativeSessionTitle: 'unrelated title', codexAppSteerable: true,
      trustedController: { ...caller, requestUserOpenId: 'ou_other_controller' } };
    const payload = buildFollowUpCliInput('decorated task', 'accepted-session', {
      acceptedInput: oversized, cliId: 'remote-runner', larkAppId: 'cli_accepted',
    });
    expect(payload.content).toBe(command.content);
    expect(payload.trustedCaller).toEqual(caller);
    expect(payload.codexAppInput).toBeUndefined();
    expect(payload.nativeSessionTitle).toBeUndefined();
    expect(payload.codexAppSteerable).toBeUndefined();
    expect(payload.trustedController).toBeUndefined();
  });

  it('refuses to splice accepted provider input into any other CLI', () => {
    for (const cliId of ['codex', 'claude-code', undefined] as const) {
      expect(() => buildFollowUpCliInput('decorated message', 'accepted-session', {
        acceptedInput: command, cliId, larkAppId: 'cli_accepted',
      })).toThrow(/different CLI/);
    }
    expect(() => buildNewTopicCliInput('decorated message', 'accepted-session', 'codex',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { acceptedInput: command, larkAppId: 'cli_accepted' })).toThrow(/different CLI/);
  });

  it('keeps local refork payloads unchanged when no accepted input exists', () => {
    const ds = remoteSession();
    ds.session.cliId = 'codex';
    ds.session.backendType = 'tmux';
    ds.session.promptInjection = 'none';
    const payload = buildReforkCliInput(ds, 'ordinary task', { cliId: 'codex', locale: 'en' });
    expect(payload.content).toBe('ordinary task');
    expect(payload.trustedCaller).toBeUndefined();
  });
});

describe('delegated slash policy seam', () => {
  it('shares backend and frozen configuration decisions with help', () => {
    const bot = { cliId: 'remote-runner' as const, backendType: 'remote-runner' as const,
      remoteRunner: { delegatedSlashCommands: ['/adopt', '/detach'] as Array<'/adopt' | '/detach'> } };
    const ds = remoteSession();
    expect([...sessionDelegatedSlashCommands(bot, ds, 'tmux')]).toEqual(['/adopt', '/detach']);
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.initConfig = { backendType: 'remote-runner', backendConfig: {} } as DaemonSession['initConfig'];
    expect([...sessionDelegatedSlashCommands(bot, ds, 'tmux')]).toEqual([]);
    ds.worker = null;
    expect([...sessionDelegatedSlashCommands(bot, ds, 'tmux')]).toEqual(['/adopt', '/detach']);
    ds.initConfig = undefined;
    ds.session.cliId = 'codex';
    ds.session.backendType = 'tmux';
    expect([...sessionDelegatedSlashCommands(bot, ds, 'tmux')]).toEqual([]);
  });

  it('admits one complete payload only after authorization and lifecycle checks', async () => {
    const replies: string[] = [];
    const context = { authorized: true, primary: false, caller, larkAppId: 'cli_accepted',
      reply: async (text: string) => { replies.push(text); } };
    const decision = { kind: 'delegated_turn' as const, cmd: '/adopt', content: command.content, sessionPolicy: 'precreate' as const };
    expect(await admitDelegatedSlashTurn(decision, context)).toEqual(command);
    expect(await admitDelegatedSlashTurn(decision, { ...context, authorized: false })).toBeUndefined();
    expect(await admitDelegatedSlashTurn({ ...decision, cmd: '/disconnect', sessionPolicy: 'existing' }, { ...context, primary: true })).toBeUndefined();
    expect(await admitDelegatedSlashTurn({ ...decision, cmd: '/detach', sessionPolicy: 'unbound' }, context)).toBeUndefined();
    expect(replies).toHaveLength(3);
  });
});


afterEach(() => vi.restoreAllMocks());
describe('accepted input backlog activation', () => {
  it('retains the backlog head and durably queues the authenticated command tail', () => {
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const ds = remoteSession();
    ds.session.queued = true;
    ds.session.queuedPrompt = 'EXISTING_BACKLOG_TASK';
    const separate = queuedOpeningHasTail(ds.session, command);
    if (separate) {
      const tail = buildFollowUpCliInput(command.content, ds.session.sessionId, {
        cliId: 'remote-runner', larkAppId: ds.larkAppId, acceptedInput: command, linkRefMode: 'enabled',
      });
      admitQueuedActivationTail(ds, { userPrompt: command.content, turnId: 'om_command', cliInput: tail });
    }
    const opening = buildReforkCliInput(ds, separate ? ds.session.queuedPrompt
      : ds.session.queuedPrompt + '\n\n' + command.content, {
      cliId: 'remote-runner', acceptedInput: separate ? undefined : command,
    });
    expect(opening.content).toContain('EXISTING_BACKLOG_TASK');
    expect(opening.content).not.toContain(command.content);
    expect(ds.session.queuedActivationTail).toEqual([expect.objectContaining({
      turnId: 'om_command', cliInput: expect.objectContaining({ content: command.content, trustedCaller: caller }),
    })]);
    expect(ds.session.queuedActivationTail?.[0]?.cliInput.linkRefs).toBeDefined();
  });
  it('retains ordinary backlog folding when no structured turn was admitted', () => {
    const ds = remoteSession();
    ds.session.queued = true;
    ds.session.queuedPrompt = 'EXISTING_BACKLOG_TASK';
    expect(queuedOpeningHasTail(ds.session)).toBe(false);
  });
});
