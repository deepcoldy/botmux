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
  managedHerdrAgentName,
  selectSessionBackend,
  retireSupersededRecordedHerdrTarget,
} from '../src/adapters/backend/session-backend-selector.js';
import {
  herdrConfigForChatType,
  herdrConfigForSession,
  normalizeHerdrBackendConfig,
  normalizeHerdrChatTypes,
  resolveHerdrBackendConfig,
} from '../src/adapters/backend/types.js';

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

  describe('an isolated restart whose recorded agent is already its own', () => {
    // Sandbox/MCP incarnations disable shared reuse, so retirement runs; when
    // the recorded pane is exactly the agent this session would launch in the
    // configured host, it is the live pane to resume, not one to retire.
    const sessionId = '12345678-1234-1234-1234-123456789012';
    const ownershipScope = '/tmp/botmux-herdr-scope';
    const agentName = managedHerdrAgentName(sessionId, ownershipScope);
    const retire = (herdrConfig?: { sessionName: string }) => retireSupersededRecordedHerdrTarget({
      sessionId,
      ownershipScope,
      reuseRecordedHerdrTarget: false,
      herdrConfig,
      persistentBackendTarget: { backendType: 'herdr', sessionName: 'default', agentName },
    });

    it('keeps the live pane when it sits in the configured session', () => {
      mockHerdrState.agents.add(`default/${agentName}`);
      retire({ sessionName: 'default' });
      expect(mockHerdrState.killedAgents).toHaveLength(0);
    });

    it('retires it once the configured session is the default host instead', () => {
      mockHerdrState.agents.add(`default/${agentName}`);
      retire(undefined);
      expect(mockHerdrState.killedAgents).toEqual([{ session: 'default', agent: agentName }]);
    });
  });
});

describe('Herdr placement chatTypes', () => {
  it('normalizes bots.json arrays and comma-separated env values', () => {
    expect(normalizeHerdrChatTypes(['group'])).toEqual(['group']);
    expect(normalizeHerdrChatTypes(' group, p2p ,group')).toEqual(['group', 'p2p']);
    // Nothing valid left means unset, i.e. the placement applies to every chat.
    expect(normalizeHerdrChatTypes(['dm', 7])).toBeUndefined();
    expect(normalizeHerdrChatTypes([])).toBeUndefined();
    expect(normalizeHerdrChatTypes(undefined)).toBeUndefined();
  });

  it('applies the placement to every session when chatTypes is unset', () => {
    const config = { sessionName: 'default', placement: 'split' as const };
    expect(herdrConfigForChatType(config, 'p2p')).toBe(config);
    expect(herdrConfigForChatType(config, undefined)).toBe(config);
  });

  it('keeps excluded chat types on the default host', () => {
    const config = { sessionName: 'default', placement: 'split' as const, chatTypes: ['group' as const] };
    expect(herdrConfigForChatType(config, 'group')).toBe(config);
    expect(herdrConfigForChatType(config, 'p2p')).toBeUndefined();
    expect(herdrConfigForChatType(config, undefined)).toBeUndefined();
    expect(herdrConfigForChatType(undefined, 'group')).toBeUndefined();
  });
});

describe('Herdr placement from worker decision to backend selection', () => {
  beforeEach(() => {
    mockHerdrState.sessions = new Set(['botmux', 'default']);
    mockHerdrState.agents = new Set();
    mockHerdrState.killedAgents = [];
  });

  // Same wiring as worker.ts: the full herdr block arrives as backendConfig,
  // the worker decides the placement for this chat, the selector only obeys it.
  const backendConfig = { sessionName: 'default', placement: 'split' as const, tab: '3', chatTypes: ['group' as const] };
  const select = (chatType: 'group' | 'p2p') => selectSessionBackend({
    sessionId: 'test-session-1234',
    backendType: 'herdr',
    backendConfig,
    herdrConfig: herdrConfigForSession(backendConfig, chatType),
  });

  it('keeps an excluded chat type on the default host even though backendConfig carries the block', () => {
    const selected = select('p2p');
    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts?.herdrConfig).toBeUndefined();
    expect((selected.backend as any).opts?.isCustomHost).toBeUndefined();
  });

  it('places an included chat type in the configured session', () => {
    const selected = select('group');
    expect((selected.backend as any).sessionName).toBe('default');
    expect((selected.backend as any).opts?.herdrConfig).toBe(backendConfig);
    expect((selected.backend as any).opts?.isCustomHost).toBe(true);
  });

  it('never re-derives placement from backendConfig alone', () => {
    const selected = selectSessionBackend({
      sessionId: 'test-session-1234',
      backendType: 'herdr',
      backendConfig: { sessionName: 'default', placement: 'split' },
    });
    expect((selected.backend as any).sessionName).toBe('botmux');
    expect((selected.backend as any).opts?.herdrConfig).toBeUndefined();
  });

  it('reads no placement from a non-herdr backendConfig', () => {
    expect(herdrConfigForSession({ baseUrl: 'https://riff.example' }, 'group')).toBeUndefined();
    expect(herdrConfigForSession(undefined, 'group')).toBeUndefined();
  });
});

describe('Herdr config layering', () => {
  it('keeps only the fields that are set, from bots.json or env strings', () => {
    expect(normalizeHerdrBackendConfig({
      sessionName: ' default ',
      placement: 'split',
      tab: '',
      splitDirection: 'sideways',
      chatTypes: 'group',
    })).toEqual({ sessionName: 'default', placement: 'split', chatTypes: ['group'] });
    expect(normalizeHerdrBackendConfig({})).toBeUndefined();
    expect(normalizeHerdrBackendConfig({ sessionName: undefined, placement: undefined })).toBeUndefined();
    expect(normalizeHerdrBackendConfig(undefined)).toBeUndefined();
  });

  it('layers the bot block over the env block field by field', () => {
    const env = { sessionName: 'default', placement: 'split' as const, tab: '9' };
    expect(resolveHerdrBackendConfig(env, { tab: '3' })).toEqual({ sessionName: 'default', placement: 'split', tab: '3' });
    // An empty bot block (normalized to undefined) hides nothing.
    expect(resolveHerdrBackendConfig(env, normalizeHerdrBackendConfig({}))).toEqual(env);
    expect(resolveHerdrBackendConfig(undefined, { sessionName: 'default' })).toEqual({ sessionName: 'default' });
  });

  it('stays inactive until a session or placement is named', () => {
    expect(resolveHerdrBackendConfig({ splitDirection: 'down' }, undefined)).toBeUndefined();
    expect(resolveHerdrBackendConfig(undefined, { tab: '3' })).toBeUndefined();
    expect(resolveHerdrBackendConfig({ splitDirection: 'down' }, { placement: 'split' })).toEqual({ splitDirection: 'down', placement: 'split' });
    expect(resolveHerdrBackendConfig(undefined, undefined)).toBeUndefined();
  });
});
