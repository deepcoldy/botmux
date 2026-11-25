import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import {
  hasNonActivationSessionMutationOwnership,
  hasProtectedSessionMutationOwnership,
  protectedSessionMutationReasons,
} from '../src/core/session-mutation-guard.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'guard-session',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    title: 'guard',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('hasProtectedSessionMutationOwnership', () => {
  it.each([
    ['generic activation head', { queuedActivationPending: true }],
    ['durable successor tail', {
      queuedActivationTail: [{
        id: 'tail-1', order: 1, userPrompt: 'N+1',
        cliInput: { content: 'N+1' }, turnId: 'turn-n-plus-1',
      }],
    }],
    ['principal-lane full-turn tail', {
      principalLaneQueuedTurns: [{
        version: 1,
        turnId: 'om_b2',
        caller: { requestUserOpenId: 'ou_b', senderType: 'user' },
        userPrompt: 'B2',
        title: 'B2',
        cliInput: { content: 'B2' },
        createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
        resume: true,
        dispatchState: 'queued',
      }],
    }],
    ['pending repository setup', {
      pendingRepoSetup: { mode: 'picker', prompt: 'OPENING_N' },
    }],
    ['dashboard backlog', { queued: true, queuedPrompt: 'OPENING_N' }],
    ['Codex App ledger', {
      cliId: 'codex-app',
      codexAppDispatchLedger: [{
        dispatchId: 'dispatch-n', turnId: 'turn-n', state: 'accepted', content: 'N',
      }],
    }],
  ] as const)('protects %s', (_name, overrides) => {
    expect(hasProtectedSessionMutationOwnership(session(overrides as Partial<Session>))).toBe(true);
  });

  it('protects a runtime-only opening claim but leaves a truly idle row mutable', () => {
    const ds = {
      session: session(),
      initialStartPending: true,
    } as DaemonSession;
    expect(hasProtectedSessionMutationOwnership(ds)).toBe(true);
    expect(hasProtectedSessionMutationOwnership(session())).toBe(false);
  });

  it('classifies backend-neutral ownership separately from Codex App dispatches', () => {
    expect(protectedSessionMutationReasons(session({
      cliId: 'traex',
      queued: true,
      pendingRepoSetup: { mode: 'picker', prompt: 'OPENING_N' },
    }))).toEqual(['queued_todo', 'repository_setup']);
    expect(protectedSessionMutationReasons(session({
      cliId: 'codex-app',
      codexAppDispatchLedger: [{
        dispatchId: 'dispatch-n', turnId: 'turn-n', state: 'accepted', content: 'N',
      }],
    }))).toEqual(['codex_app_dispatch']);
  });
});

describe('hasNonActivationSessionMutationOwnership', () => {
  it('allows activation-only restart ownership while preserving every other protected gate', () => {
    const activationOnly = {
      session: session({
        queuedActivationPending: true,
        queuedActivationTail: [{
          id: 'tail-1', order: 1, userPrompt: 'N+1',
          cliInput: { content: 'N+1' }, turnId: 'turn-n-plus-1',
        }],
      }),
      initialStartPending: true,
    } as DaemonSession;
    expect(hasProtectedSessionMutationOwnership(activationOnly)).toBe(true);
    expect(hasNonActivationSessionMutationOwnership(activationOnly)).toBe(false);
    expect(hasNonActivationSessionMutationOwnership({ session: session() })).toBe(false);
    // A bare start reservation or an unpromoted tail has no live replay observer.
    expect(hasNonActivationSessionMutationOwnership({ session: session(), initialStartPending: true })).toBe(true);
    expect(hasNonActivationSessionMutationOwnership({
      session: session({
        queuedActivationTail: [{
          id: 'tail-1', order: 1, userPrompt: 'N+1', cliInput: { content: 'N+1' }, turnId: 'turn-n-plus-1',
        }],
      }),
      initialStartPending: true,
    })).toBe(true);
    for (const overrides of [
      { queued: true },
      { pendingRepoSetup: { mode: 'picker', prompt: 'OPENING_N' } },
      { principalLaneQueuedTurns: [{ turnId: 'om_b2' }] },
      { codexAppDispatchLedger: [{ dispatchId: 'dispatch-n', turnId: 'turn-n', state: 'accepted', content: 'N' }] },
    ] as const) {
      expect(hasNonActivationSessionMutationOwnership({ session: session(overrides as Partial<Session>) })).toBe(true);
    }
  });
});
