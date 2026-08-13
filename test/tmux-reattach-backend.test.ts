import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/adapters/backend/pty-backend.js', () => ({
  PtyBackend: class MockPtyBackend {},
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class MockTmuxBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static hasSession = vi.fn();
    static probeSessionWithRetry = vi.fn();
    constructor(public sessionName: string) {}
  },
}));

vi.mock('../src/adapters/backend/tmux-pipe-backend.js', () => ({
  TmuxPipeBackend: class MockTmuxPipeBackend {
    constructor(public paneTarget: string, public opts?: unknown) {}
  },
}));

vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: class MockHerdrBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static managedSessionName = vi.fn(() => 'botmux');
    static hasSession = vi.fn(() => false);
    static probeSession = vi.fn(() => 'missing');
    static hasAgent = vi.fn(() => false);
    static probeAgent = vi.fn(() => 'missing');
    static killAgent = vi.fn();
    constructor(public sessionName: string, public opts?: unknown) {}
  },
}));

vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: class MockZellijBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static hasSession = vi.fn(() => false);
    constructor(public sessionName: string, public opts?: unknown) {}
  },
}));

vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: class MockZmxBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static hasSession = vi.fn(() => false);
    constructor(public sessionName: string, public opts?: unknown) {}
  },
}));

import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';
import { ZellijBackend } from '../src/adapters/backend/zellij-backend.js';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import {
  backendSandboxCompatibilityError,
  isStrongManagedHerdrAgentName,
  managedHerdrAgentName,
  retireSupersededRecordedHerdrTarget,
  selectSessionBackend,
} from '../src/adapters/backend/session-backend-selector.js';

describe('selectSessionBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(TmuxBackend.hasSession).mockReset();
    vi.mocked(TmuxBackend.probeSessionWithRetry).mockReset();
    vi.mocked(TmuxBackend.sessionName).mockClear();
    vi.mocked(HerdrBackend.hasSession).mockReturnValue(false);
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('missing');
    vi.mocked(HerdrBackend.hasAgent).mockReturnValue(false);
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('missing');
    vi.mocked(HerdrBackend.killAgent).mockReset();
  });

  it('uses owned pipe backend when reattaching to an existing tmux session', () => {
    vi.mocked(TmuxBackend.probeSessionWithRetry).mockReturnValue('exists');

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'tmux' });

    expect(selected.isTmuxMode).toBe(true);
    expect(selected.isPipeMode).toBe(true);
    expect(selected.backend.constructor.name).toBe('MockTmuxPipeBackend');
    expect((selected.backend as any).paneTarget).toBe('bmx-9cfa0024');
    expect((selected.backend as any).opts).toEqual({ ownsSession: true, isReattach: true });
    expect(selected.persistentBackendTarget).toEqual({
      backendType: 'tmux',
      sessionName: 'bmx-9cfa0024',
    });
  });

  it('uses managed pipe backend for a new tmux session', () => {
    vi.mocked(TmuxBackend.probeSessionWithRetry).mockReturnValue('missing');

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'tmux' });

    expect(selected.isTmuxMode).toBe(true);
    expect(selected.isPipeMode).toBe(true);
    expect(selected.backend.constructor.name).toBe('MockTmuxPipeBackend');
    expect((selected.backend as any).paneTarget).toBe('bmx-9cfa0024');
    expect((selected.backend as any).opts).toEqual({ createSession: true, ownsSession: true });
  });

  /**
   * Regression: 2026-08-12. An indeterminate probe (has-session timed out under
   * host load) must take the create branch, because createDetachedSession
   * absorbs a "duplicate session" error as a reattach. Choosing reattach here
   * would be unrecoverable if the session were genuinely gone: pipe-pane would
   * have no pane to subscribe to.
   */
  it('takes the create branch when existence is indeterminate (unknown, not missing)', () => {
    vi.mocked(TmuxBackend.probeSessionWithRetry).mockReturnValue('unknown');

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'tmux' });

    expect((selected.backend as any).opts).toEqual({ createSession: true, ownsSession: true });
  });

  it('uses pty backend when backend is pty', () => {
    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'pty' });

    expect(selected.isTmuxMode).toBe(false);
    expect(selected.isPipeMode).toBe(false);
    expect(selected.isZellijMode).toBe(false);
    expect('tmuxBackend' in selected).toBe(false);
  });

  it('creates the machine-wide botmux Herdr host and a topic-specific agent', () => {
    const selected = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
    });

    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts).toEqual({
      createSession: true,
      agentName: 'botmux-9ak8itbj1fuif1tinpg625vnk',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
    });
    expect(selected.persistentBackendTarget).toEqual({
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: 'botmux-9ak8itbj1fuif1tinpg625vnk',
    });
    expect(selected.createdHerdrSessionName).toBe('botmux');
  });

  it('uses the full UUID identity within Herdr 0.7.5 naming limits', () => {
    vi.mocked(HerdrBackend.hasSession).mockImplementation(name => name === 'botmux');
    const first = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
    });
    const second = selectSessionBackend({
      sessionId: '9cfa0024-ffff-4781-845b-c541dceb8980',
      backendType: 'herdr',
    });

    const firstName = first.persistentBackendTarget?.backendType === 'herdr'
      ? first.persistentBackendTarget.agentName
      : undefined;
    const secondName = second.persistentBackendTarget?.backendType === 'herdr'
      ? second.persistentBackendTarget.agentName
      : undefined;
    expect(firstName).toMatch(/^botmux-[0-9a-z]{25}$/);
    expect(secondName).toMatch(/^botmux-[0-9a-z]{25}$/);
    expect(firstName).toHaveLength(32);
    expect(secondName).not.toBe(firstName);
    expect(HerdrBackend.hasAgent).toHaveBeenNthCalledWith(
      1,
      'botmux',
      'botmux-9ak8itbj1fuif1tinpg625vnk',
    );
    expect(HerdrBackend.hasAgent).toHaveBeenNthCalledWith(
      2,
      'botmux',
      'botmux-9ak8itig13ioazl4vy0ks7vy8',
    );
  });

  it('puts another bot or topic agent in the same machine-wide botmux host', () => {
    vi.mocked(HerdrBackend.hasSession).mockImplementation(name => name === 'botmux');

    const selected = selectSessionBackend({
      sessionId: 'fedcba98-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
    });

    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts).toEqual({
      createSession: false,
      agentName: 'botmux-f36n7gsju73m9n07tm5ajhdhc',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
    });
    expect(selected.createdHerdrSessionName).toBeUndefined();
  });

  it('reattaches a persisted legacy short Herdr target even when current/default changed', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('exists');
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('exists');
    // A stray deterministic session must not outrank the durable shared target
    // selected by the prior worker generation.
    vi.mocked(HerdrBackend.hasSession).mockReturnValue(true);

    const selected = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'original-work',
        agentName: 'botmux-9cfa0024',
      },
    });

    expect((selected.backend as any).sessionName).toBe('original-work');
    expect((selected.backend as any).opts).toEqual({
      agentName: 'botmux-9cfa0024',
      isReattach: true,
      ownsSession: false,
      ownsAgent: true,
    });
    expect(selected.persistentBackendTarget).toEqual({
      backendType: 'herdr',
      sessionName: 'original-work',
      agentName: 'botmux-9cfa0024',
    });
  });

  it('fails closed when the recorded shared Herdr target cannot be probed', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('unknown');

    expect(() => selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'original-work',
        agentName: 'botmux-9cfa0024',
      },
    })).toThrow('recorded herdr session original-work probe inconclusive');
  });

  it('recreates a missing persisted legacy short agent in its recorded shared Herdr host', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('exists');
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('missing');

    const selected = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'original-work',
        agentName: 'botmux-9cfa0024',
      },
    });

    expect((selected.backend as any).sessionName).toBe('original-work');
    expect((selected.backend as any).opts).toEqual({
      agentName: 'botmux-9cfa0024',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
    });
  });

  it('moves to the scoped shared target when reuse is disabled and the legacy host is absent', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('missing');
    vi.mocked(HerdrBackend.hasSession).mockImplementation(name => name === 'botmux');

    const selected = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      herdrOwnershipScope: '/tmp/botmux-root-a',
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'original-work',
        agentName: 'botmux-9cfa0024',
      },
    });

    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts).toMatchObject({
      agentName: managedHerdrAgentName(
        '9cfa0024-197d-4781-845b-c541dceb8980',
        '/tmp/botmux-root-a',
      ),
      ownsSession: false,
      ownsAgent: true,
    });
    expect(HerdrBackend.probeSession).toHaveBeenCalledWith('bmx-9cfa0024');
    expect(HerdrBackend.probeAgent).not.toHaveBeenCalled();
  });

  it('refuses isolation/MCP migration while a legacy exclusive Herdr host is live', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('exists');

    expect(() => selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      herdrOwnershipScope: '/tmp/botmux-root-a',
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'bmx-9cfa0024',
      },
    })).toThrow('legacy herdr session bmx-9cfa0024 is still live');
    expect(HerdrBackend.hasSession).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy exclusive Herdr host cannot be probed during migration', () => {
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('unknown');

    expect(() => selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      herdrOwnershipScope: '/tmp/botmux-root-a',
      reuseRecordedHerdrTarget: false,
    })).toThrow('legacy herdr session bmx-9cfa0024 probe inconclusive');
    expect(HerdrBackend.hasSession).not.toHaveBeenCalled();
  });

  it('uses zellij backend when backend is zellij', () => {
    vi.mocked(ZellijBackend.hasSession).mockReturnValue(false);

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'zellij' });

    expect(selected.isZellijMode).toBe(true);
    expect(selected.isTmuxMode).toBe(false);
    expect(selected.isPipeMode).toBe(false);
    expect(selected.backend.constructor.name).toBe('MockZellijBackend');
    expect((selected.backend as any).opts).toEqual({ ownsSession: true, isReattach: false });
  });

  it('marks an existing zellij session as reattach without making it pipe mode', () => {
    vi.mocked(ZellijBackend.hasSession).mockReturnValue(true);

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'zellij' });

    expect(selected.isZellijMode).toBe(true);
    expect(selected.isPipeMode).toBe(false);
    expect((selected.backend as any).opts).toEqual({ ownsSession: true, isReattach: true });
  });

  it('uses zmx tail signals, history snapshots, and send as a managed pipe backend', () => {
    vi.mocked(ZmxBackend.hasSession).mockReturnValue(true);

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'zmx' });

    expect(selected.isZellijMode).toBe(false);
    expect(selected.isTmuxMode).toBe(false);
    expect(selected.isPipeMode).toBe(true);
    expect(selected.backend.constructor.name).toBe('MockZmxBackend');
    expect((selected.backend as any).opts).toEqual({
      ownsSession: true,
      isReattach: true,
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
    });
  });
});

describe('superseded Herdr target retirement', () => {
  const sessionId = '9cfa0024-197d-4781-845b-c541dceb8980';
  const ownershipScope = '/tmp/botmux-root-a';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(HerdrBackend.probeAgent).mockReset();
    vi.mocked(HerdrBackend.killAgent).mockReset();
  });

  it('closes only the exact live strongly-owned agent and verifies it disappeared', () => {
    const agentName = managedHerdrAgentName(sessionId, ownershipScope);
    vi.mocked(HerdrBackend.probeAgent)
      .mockReturnValueOnce('exists')
      .mockReturnValueOnce('missing');

    expect(() => retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'old-shared-host',
        agentName,
      },
    })).not.toThrow();

    expect(HerdrBackend.killAgent).toHaveBeenCalledOnce();
    expect(HerdrBackend.killAgent).toHaveBeenCalledWith('old-shared-host', agentName);
    expect(HerdrBackend.probeAgent).toHaveBeenNthCalledWith(
      1,
      'old-shared-host',
      agentName,
    );
    expect(HerdrBackend.probeAgent).toHaveBeenNthCalledWith(
      2,
      'old-shared-host',
      agentName,
    );
  });

  it('fails closed when exact strong-agent teardown cannot be verified', () => {
    const agentName = managedHerdrAgentName(sessionId, ownershipScope);
    vi.mocked(HerdrBackend.probeAgent)
      .mockReturnValueOnce('exists')
      .mockReturnValueOnce('unknown');

    expect(() => retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'old-shared-host',
        agentName,
      },
    })).toThrow(/could not verify.*old-shared-host/);

    expect(HerdrBackend.killAgent).toHaveBeenCalledWith('old-shared-host', agentName);
  });

  it('does not infer destructive authority over a live legacy short agent', () => {
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('exists');

    expect(() => retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'user-workspace',
        agentName: 'botmux-9cfa0024',
      },
    })).toThrow(/legacy Herdr target.*user-workspace\/botmux-9cfa0024/);

    expect(HerdrBackend.killAgent).not.toHaveBeenCalled();
  });

  it('does not kill a strong agent owned by another Botmux data root', () => {
    const otherRootAgent = managedHerdrAgentName(sessionId, '/tmp/botmux-root-b');
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('exists');

    expect(() => retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'other-botmux-host',
        agentName: otherRootAgent,
      },
    })).toThrow(/does not match this Botmux data root/);

    expect(HerdrBackend.killAgent).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown'] as const)(
    'handles an untrusted legacy target probe of %s without destructive cleanup',
    (probe) => {
      vi.mocked(HerdrBackend.probeAgent).mockReturnValue(probe);
      const run = () => retireSupersededRecordedHerdrTarget({
        sessionId,
        ownershipScope,
        reuseRecordedHerdrTarget: false,
        persistentBackendTarget: {
          backendType: 'herdr' as const,
          sessionName: 'user-workspace',
          agentName: 'botmux-9cfa0024',
        },
      });

      if (probe === 'missing') {
        expect(run).not.toThrow();
      } else {
        expect(run).toThrow(/probe inconclusive.*user-workspace\/botmux-9cfa0024/);
      }
      expect(HerdrBackend.killAgent).not.toHaveBeenCalled();
    },
  );

  it('leaves the replacement target and ordinary reuse paths untouched', () => {
    const agentName = managedHerdrAgentName(sessionId, ownershipScope);
    const target = {
      backendType: 'herdr' as const,
      sessionName: 'botmux',
      agentName,
    };

    retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: target,
    });
    retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: true,
      persistentBackendTarget: {
        ...target,
        sessionName: 'old-shared-host',
      },
    });

    expect(HerdrBackend.probeAgent).not.toHaveBeenCalled();
    expect(HerdrBackend.killAgent).not.toHaveBeenCalled();
  });
});

describe('managed Herdr agent identity', () => {
  it('uses a deterministic strong fallback for imported non-UUID session ids', () => {
    const first = managedHerdrAgentName('imported-session-id');
    const second = managedHerdrAgentName('imported-session-id');

    expect(first).toBe(second);
    expect(first).toMatch(/^botmux-[0-9a-z]{25}$/);
    expect(isStrongManagedHerdrAgentName(first)).toBe(true);
  });

  it('separates the same complete session id across independent data roots', () => {
    const sessionId = '9cfa0024-197d-4781-845b-c541dceb8980';
    const first = managedHerdrAgentName(sessionId, '/tmp/botmux-root-a');
    const second = managedHerdrAgentName(sessionId, '/tmp/botmux-root-b');

    expect(first).toMatch(/^botmux-[0-9a-z]{25}$/);
    expect(first).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it('distinguishes strong identities from persisted legacy short names', () => {
    expect(isStrongManagedHerdrAgentName('botmux-9ak8itbj1fuif1tinpg625vnk')).toBe(true);
    expect(isStrongManagedHerdrAgentName('botmux-9cfa0024')).toBe(false);
    expect(isStrongManagedHerdrAgentName('botmux-9ak8itbj1fuif1tinpg625vn')).toBe(false);
    expect(isStrongManagedHerdrAgentName('botmux-9AK8ITBJ1FUIF1TINPG625VNK')).toBe(false);
  });
});

describe('backendSandboxCompatibilityError', () => {
  it('fails closed for local persistent backends outside the isolation wrapper', () => {
    for (const backendType of ['herdr', 'zellij', 'zmx'] as const) {
      expect(backendSandboxCompatibilityError({
        backendType,
        fileSandboxRequested: true,
        effectiveReadIsolationRequested: false,
      })).toContain(`backend "${backendType}"`);
      expect(backendSandboxCompatibilityError({
        backendType,
        fileSandboxRequested: false,
        effectiveReadIsolationRequested: true,
      })).toContain(`backend "${backendType}"`);
    }
  });

  it('allows unsandboxed persistent backends, wrapper-owned local backends, and remote Riff', () => {
    expect(backendSandboxCompatibilityError({
      backendType: 'zmx',
      fileSandboxRequested: false,
      effectiveReadIsolationRequested: false,
    })).toBeUndefined();
    expect(backendSandboxCompatibilityError({
      backendType: 'tmux',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: true,
    })).toBeUndefined();
    expect(backendSandboxCompatibilityError({
      backendType: 'pty',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: true,
    })).toBeUndefined();
    expect(backendSandboxCompatibilityError({
      backendType: 'riff',
      fileSandboxRequested: true,
      effectiveReadIsolationRequested: true,
    })).toBeUndefined();
  });
});
