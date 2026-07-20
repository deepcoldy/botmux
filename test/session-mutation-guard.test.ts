import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import { hasProtectedSessionMutationOwnership } from '../src/core/session-mutation-guard.js';

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
    ['pending repository setup', {
      pendingRepoSetup: { mode: 'picker', prompt: 'OPENING_N' },
    }],
    ['Riff activation head', {
      cliId: 'riff', backendType: 'riff', queuedActivationPending: true,
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

  it.each([
    ['Riff close fence', { riffCloseState: { phase: 'prepared', requestId: 'close-1' } }],
    ['Riff shutdown fence', {
      riffShutdownState: { phase: 'prepared', requestId: 'shutdown-1', taskId: null },
    }],
  ])('protects runtime-only %s', (_label, state) => {
    const ds = { session: session(), ...state } as unknown as DaemonSession;
    expect(hasProtectedSessionMutationOwnership(ds)).toBe(true);
  });
});
