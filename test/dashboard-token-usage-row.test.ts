import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => ({
    in: 1234,
    out: 567,
    inputTokens: 1200,
    outputTokens: 567,
    cacheReadTokens: 30,
    cacheCreateTokens: 4,
    turns: 3,
    model: 'test-model',
  })),
}));

import { getSessionTokenUsage } from '../src/core/cost-calculator.js';
import { composeRowFromActive, composeRowFromClosed } from '../src/core/dashboard-rows.js';

function makeDs(): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1',
      cliSessionId: 'cli-sess-1',
      cliId: 'claude-code',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 't',
      status: 'active',
      createdAt: new Date(1000).toISOString(),
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1000,
    cliVersion: 'test',
    lastMessageAt: 1000,
    hasHistory: false,
    workingDir: '/repo',
  } as DaemonSession;
}

describe('dashboard SessionRow token usage', () => {
  it('carries native token in/out totals for the sessions table', () => {
    const row = composeRowFromActive(makeDs());

    expect(getSessionTokenUsage).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: 'sess-1',
      cliSessionId: 'cli-sess-1',
      cwd: '/repo',
    });
    expect(row.tokenUsage).toEqual({
      in: 1234,
      out: 567,
      inputTokens: 1200,
      outputTokens: 567,
      cacheReadTokens: 30,
      cacheCreateTokens: 4,
      turns: 3,
      model: 'test-model',
    });
  });

  it('carries chatType for active and closed rows', () => {
    const active = makeDs();
    active.chatType = 'p2p';
    active.session.chatType = 'p2p';
    active.session.chatDisplayName = '韩毅';

    expect(composeRowFromActive(active).chatType).toBe('p2p');
    expect(composeRowFromActive(active).chatDisplayName).toBe('韩毅');
    expect(composeRowFromClosed({
      sessionId: 'closed-1',
      chatId: 'oc_group',
      chatType: 'group',
      rootMessageId: 'om_root',
      title: 'closed',
      status: 'closed',
      createdAt: new Date(1000).toISOString(),
    }).chatType).toBe('group');
  });
});
