import { describe, expect, it } from 'vitest';
import { projectCoreOnlyHostFacts } from '../src/core/core-only-host-facts.js';

describe('core-only host facts', () => {
  it('keeps the persistent backend tri-state authoritative', () => {
    const facts = projectCoreOnlyHostFacts({
      sessionId: 'session-1',
      sessionStatus: 'active',
      cli: 'codex',
      backend: 'tmux',
      nativeSessionId: 'thread-1',
      activeTurnId: 'turn-logical',
      workerPresent: true,
      workerReady: true,
      workerGeneration: 3,
      backingProbe: 'unknown',
    });
    expect(facts).toEqual({
      protocolVersion: 1,
      sessionId: 'session-1',
      cli: 'codex',
      backend: 'tmux',
      sessionStatus: 'active',
      liveness: 'unknown',
      worker: { present: true, ready: true, generation: 3 },
      native: {
        sessionId: 'thread-1',
        activeTurnId: 'turn-logical',
        nativeTurnId: null,
      },
    });
  });

  it('reports a ready live PTY worker as exists without inventing native ids', () => {
    const facts = projectCoreOnlyHostFacts({
      sessionId: 'session-2',
      sessionStatus: 'active',
      cli: 'claude-code',
      backend: 'pty',
      nativeSessionId: null,
      activeTurnId: null,
      workerPresent: true,
      workerReady: true,
      workerGeneration: 1,
      backingProbe: null,
    });
    expect(facts.liveness).toBe('exists');
    expect(facts.native.nativeTurnId).toBeNull();
  });

  it('never treats an absent worker reference as proof that a session is missing', () => {
    const facts = projectCoreOnlyHostFacts({
      sessionId: 'session-3',
      sessionStatus: 'closed',
      cli: null,
      backend: null,
      nativeSessionId: null,
      activeTurnId: null,
      workerPresent: false,
      workerReady: false,
      workerGeneration: null,
      backingProbe: null,
    });
    expect(facts.liveness).toBe('unknown');
  });

  it('does not call a present but unready worker alive', () => {
    const facts = projectCoreOnlyHostFacts({
      sessionId: 'session-4',
      sessionStatus: 'active',
      cli: 'codex',
      backend: 'pty',
      nativeSessionId: null,
      activeTurnId: null,
      workerPresent: true,
      workerReady: false,
      workerGeneration: 4,
      backingProbe: null,
    });
    expect(facts.liveness).toBe('unknown');
    expect(facts.worker).toEqual({ present: true, ready: false, generation: 4 });
  });
});
