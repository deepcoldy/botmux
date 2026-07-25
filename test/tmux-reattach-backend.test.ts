import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/adapters/backend/pty-backend.js', () => ({
  PtyBackend: class MockPtyBackend {},
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class MockTmuxBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static hasSession = vi.fn();
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

import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';
import { ZellijBackend } from '../src/adapters/backend/zellij-backend.js';
import { selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';

describe('selectSessionBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(TmuxBackend.hasSession).mockReset();
    vi.mocked(TmuxBackend.sessionName).mockClear();
    vi.mocked(HerdrBackend.hasSession).mockReturnValue(false);
    vi.mocked(HerdrBackend.probeSession).mockReturnValue('missing');
    vi.mocked(HerdrBackend.hasAgent).mockReturnValue(false);
    vi.mocked(HerdrBackend.probeAgent).mockReturnValue('missing');
  });

  it('uses owned pipe backend when reattaching to an existing tmux session', () => {
    vi.mocked(TmuxBackend.hasSession).mockReturnValue(true);

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
    vi.mocked(TmuxBackend.hasSession).mockReturnValue(false);

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'tmux' });

    expect(selected.isTmuxMode).toBe(true);
    expect(selected.isPipeMode).toBe(true);
    expect(selected.backend.constructor.name).toBe('MockTmuxPipeBackend');
    expect((selected.backend as any).paneTarget).toBe('bmx-9cfa0024');
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
      agentName: 'botmux-9cfa0024',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
    });
    expect(selected.persistentBackendTarget).toEqual({
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: 'botmux-9cfa0024',
    });
    expect(selected.createdHerdrSessionName).toBe('botmux');
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
      agentName: 'botmux-fedcba98',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
    });
    expect(selected.createdHerdrSessionName).toBeUndefined();
  });

  it('reattaches the recorded shared Herdr agent even when current/default changed', () => {
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

  it('recreates a missing managed agent in its recorded shared Herdr host', () => {
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

  it('ignores a recorded shared Herdr target when shared reuse is disabled', () => {
    vi.mocked(HerdrBackend.hasSession).mockReturnValue(true);

    const selected = selectSessionBackend({
      sessionId: '9cfa0024-197d-4781-845b-c541dceb8980',
      backendType: 'herdr',
      reuseRecordedHerdrTarget: false,
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'original-work',
        agentName: 'botmux-9cfa0024',
      },
    });

    expect((selected.backend as any).sessionName).toBe('bmx-9cfa0024');
    expect(HerdrBackend.probeSession).not.toHaveBeenCalled();
    expect(HerdrBackend.probeAgent).not.toHaveBeenCalled();
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
});
