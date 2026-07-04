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
    static hasSession = vi.fn(() => false);
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
import { ZellijBackend } from '../src/adapters/backend/zellij-backend.js';
import { selectSessionBackend } from '../src/adapters/backend/session-backend-selector.js';

describe('selectSessionBackend', () => {
  beforeEach(() => {
    vi.mocked(TmuxBackend.hasSession).mockReset();
    vi.mocked(TmuxBackend.sessionName).mockClear();
  });

  it('uses owned pipe backend when reattaching to an existing tmux session', () => {
    vi.mocked(TmuxBackend.hasSession).mockReturnValue(true);

    const selected = selectSessionBackend({ sessionId: '9cfa0024-197d-4781-845b-c541dceb8980', backendType: 'tmux' });

    expect(selected.isTmuxMode).toBe(true);
    expect(selected.isPipeMode).toBe(true);
    expect(selected.backend.constructor.name).toBe('MockTmuxPipeBackend');
    expect((selected.backend as any).paneTarget).toBe('bmx-9cfa0024');
    expect((selected.backend as any).opts).toEqual({ ownsSession: true, isReattach: true });
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
