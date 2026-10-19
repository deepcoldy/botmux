import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHerdrState = {
  sessions: new Set<string>(['botmux', 'default']),
  agents: new Set<string>(),
  killedAgents: [] as Array<{ session: string; agent: string }>,
};

vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: class MockHerdrBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static managedSessionName = vi.fn(() => 'botmux');
    static defaultAgentName = vi.fn(() => 'botmux');
    static hasSession = vi.fn((name: string) => mockHerdrState.sessions.has(name));
    static probeSession = vi.fn((name: string) => mockHerdrState.sessions.has(name) ? 'exists' : 'missing');
    static hasAgent = vi.fn((session: string, agent: string) => mockHerdrState.agents.has(`${session}/${agent}`));
    static probeAgent = vi.fn((session: string, agent: string) => mockHerdrState.agents.has(`${session}/${agent}`) ? 'exists' : 'missing');
    static killAgent = vi.fn((session: string, agent: string) => {
      mockHerdrState.killedAgents.push({ session, agent });
      mockHerdrState.agents.delete(`${session}/${agent}`);
    });
    constructor(public sessionName: string, public opts?: any) {}
  },
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class MockTmuxBackend {
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

vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: class MockZmxBackend {
    static sessionName = vi.fn((id: string) => `bmx-${id.slice(0, 8)}`);
    static hasSession = vi.fn(() => false);
    constructor(public sessionName: string, public opts?: unknown) {}
  },
}));

import {
  selectSessionBackend,
  retireSupersededRecordedHerdrTarget,
} from '../src/adapters/backend/session-backend-selector.js';

describe('selectSessionBackend with Herdr placement config', () => {
  beforeEach(() => {
    mockHerdrState.sessions = new Set(['botmux', 'default']);
    mockHerdrState.agents = new Set();
    mockHerdrState.killedAgents = [];
  });

  it('defaults to machine-wide "botmux" session when no herdrConfig is provided', () => {
    const selected = selectSessionBackend({
      sessionId: 'test-session-1234',
      backendType: 'herdr',
    });
    expect(selected.persistentSessionName).toBe('botmux');
    expect(selected.persistentBackendTarget).toMatchObject({
      backendType: 'herdr',
      sessionName: 'botmux',
    });
    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts?.isCustomHost).toBeUndefined();
    expect((selected.backend as any).opts?.herdrConfig).toBeUndefined();
  });

  it('selects custom running session (e.g. "default") when herdrConfig specifies sessionName', () => {
    const selected = selectSessionBackend({
      sessionId: 'test-session-1234',
      backendType: 'herdr',
      herdrConfig: {
        sessionName: 'default',
        placement: 'split',
        tab: '3 其他',
        splitDirection: 'right',
      },
    });
    expect(selected.persistentSessionName).toBe('default');
    expect(selected.persistentBackendTarget).toMatchObject({
      backendType: 'herdr',
      sessionName: 'default',
    });
    expect((selected.backend as any).sessionName).toBe('default');
    expect((selected.backend as any).opts?.isCustomHost).toBe(true);
    expect((selected.backend as any).opts?.herdrConfig).toMatchObject({
      sessionName: 'default',
      placement: 'split',
      tab: '3 其他',
      splitDirection: 'right',
    });
  });

  it('throws helpful error when custom herdr session is not running', () => {
    expect(() => {
      selectSessionBackend({
        sessionId: 'test-session-1234',
        backendType: 'herdr',
        herdrConfig: {
          sessionName: 'not-running-session',
        },
      });
    }).toThrow('herdr session "not-running-session" is not running');
  });

  it('keeps the configured placement when a recorded target in that host is restarted', () => {
    // A crashed first launch leaves a recorded target whose agent is gone; the
    // replacement must land in the same Tab/split, not a new workspace.
    const herdrConfig = { sessionName: 'default', placement: 'split' as const, tab: '3', splitDirection: 'right' as const };
    const selected = selectSessionBackend({
      sessionId: 'test-session-1234',
      backendType: 'herdr',
      herdrConfig,
      persistentBackendTarget: { backendType: 'herdr', sessionName: 'default', agentName: 'botmux-recorded' },
    });
    expect(selected.isReattach).toBe(false);
    expect((selected.backend as any).sessionName).toBe('default');
    expect((selected.backend as any).opts).toMatchObject({
      agentName: 'botmux-recorded',
      isReattach: false,
      ownsSession: false,
      ownsAgent: true,
      herdrConfig,
      isCustomHost: true,
    });
  });

  it('does not apply the placement to a recorded target in a different host', () => {
    const selected = selectSessionBackend({
      sessionId: 'test-session-1234',
      backendType: 'herdr',
      herdrConfig: { sessionName: 'default', placement: 'split', tab: '3' },
      persistentBackendTarget: { backendType: 'herdr', sessionName: 'botmux', agentName: 'botmux-recorded' },
    });
    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts?.herdrConfig).toBeUndefined();
    expect((selected.backend as any).opts?.isCustomHost).toBeUndefined();
  });

  it('does not retire target when recorded target matches configured custom session', () => {
    const agentName = 'botmux-0000000000000000000000000';
    mockHerdrState.agents.add(`default/${agentName}`);
    retireSupersededRecordedHerdrTarget({
      sessionId: '12345678-1234-1234-1234-123456789012',
      reuseRecordedHerdrTarget: false,
      herdrConfig: { sessionName: 'default' },
      persistentBackendTarget: {
        backendType: 'herdr',
        sessionName: 'default',
        agentName: 'botmux-0r9uvsks16z3s6v78280j6q8o', // hash-based managed name
      },
    });
    expect(mockHerdrState.killedAgents).toHaveLength(0);
  });
});
