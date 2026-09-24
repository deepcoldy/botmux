import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { composeRowFromActive, composeRowFromClosed, composeRowFromPersistedActive } from '../src/core/dashboard-rows.js';

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe('dashboard SessionRow status projection', () => {
  it('projects working (not starting) during a long first turn once the worker initialized', () => {
    // Regression: meeting-agent sessions are fed a transcript delivery right at
    // spawn, so the CLI runs a minutes-long first turn before its first idle
    // prompt — screen updates are suppressed until then (awaitingFirstPrompt),
    // leaving lastScreenStatus unset. These sessions used to sit in「启动中」the
    // whole time even though the CLI was actively working.
    const ds = makeDs();
    (ds as { worker: unknown }).worker = { killed: false };
    (ds as { workerReady?: boolean }).workerReady = true;
    expect(composeRowFromActive(ds).status).toBe('working');
  });

  it('keeps starting while the worker has not finished init', () => {
    const ds = makeDs();
    (ds as { worker: unknown }).worker = { killed: false };
    expect(composeRowFromActive(ds).status).toBe('starting');
  });

  it('screen status still wins once reported', () => {
    const ds = makeDs();
    (ds as { worker: unknown }).worker = { killed: false };
    (ds as { workerReady?: boolean }).workerReady = true;
    (ds as { lastScreenStatus?: string }).lastScreenStatus = 'idle';
    expect(composeRowFromActive(ds).status).toBe('idle');
  });
});

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

  it('can skip expensive token scans for bulk session list snapshots', () => {
    const active = composeRowFromActive(makeDs(), { includeTokenUsage: false });
    const persisted = composeRowFromPersistedActive({
      ...makeDs().session,
      status: 'active',
    }, { includeTokenUsage: false });
    const closed = composeRowFromClosed({
      ...makeDs().session,
      status: 'closed',
    }, { includeTokenUsage: false });

    expect(active.tokenUsage).toBeNull();
    expect(persisted.tokenUsage).toBeNull();
    expect(closed.tokenUsage).toBeNull();
    expect(getSessionTokenUsage).not.toHaveBeenCalled();
  });

  it('keeps closed token usage visible even when bulk scans are disabled', () => {
    const tokenUsage = {
      in: 12,
      out: 3,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 1,
      model: 'persisted-model',
    };
    const row = composeRowFromClosed({
      ...makeDs().session,
      status: 'closed',
      tokenUsage,
    }, { includeTokenUsage: false });

    expect(row.tokenUsage).toEqual(tokenUsage);
    expect(getSessionTokenUsage).not.toHaveBeenCalled();
  });

  it('does not expose stale token usage for persisted active rows in bulk list mode', () => {
    const row = composeRowFromPersistedActive({
      ...makeDs().session,
      status: 'active',
      tokenUsage: {
        in: 12,
        out: 3,
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheCreateTokens: 0,
        turns: 1,
        model: 'stale-active-model',
      },
    }, { includeTokenUsage: false });

    expect(row.tokenUsage).toBeNull();
    expect(getSessionTokenUsage).not.toHaveBeenCalled();
  });

  it('does not let a persisted active detail row short-circuit on a stale snapshot', () => {
    const row = composeRowFromPersistedActive({
      ...makeDs().session,
      status: 'active',
      workingDir: '/repo',
      tokenUsage: {
        in: 12,
        out: 3,
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheCreateTokens: 0,
        turns: 1,
        model: 'stale-active-model',
      },
    });

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

  it('does not let an active runtime row short-circuit on a stale persisted snapshot', () => {
    const staleTokenUsage = {
      in: 12,
      out: 3,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 1,
      model: 'stale-closed-model',
    };
    const ds = makeDs();
    ds.session.tokenUsage = staleTokenUsage;

    const row = composeRowFromActive(ds);

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

  it('still skips active runtime token scans in bulk list mode even if a stale snapshot exists', () => {
    const ds = makeDs();
    ds.session.tokenUsage = {
      in: 12,
      out: 3,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreateTokens: 0,
      turns: 1,
      model: 'stale-closed-model',
    };

    const row = composeRowFromActive(ds, { includeTokenUsage: false });

    expect(row.tokenUsage).toBeNull();
    expect(getSessionTokenUsage).not.toHaveBeenCalled();
  });

  it('worker-pool close publishes the durable token usage snapshot directly', () => {
    const source = readFileSync(join(process.cwd(), 'src/core/worker-pool.ts'), 'utf8');

    expect(source).toContain('{ tokenUsage: after?.tokenUsage ?? null }');
    expect(source).not.toContain("import { composeRowFromActive, composeRowFromClosed }");
    expect(source).not.toContain('composeRowFromClosed(after).tokenUsage');
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

  it('exposes a direct topic link only from a persisted native omt id', () => {
    const active = makeDs();
    active.session.scope = 'thread';
    active.session.larkThreadId = 'omt_topic';
    expect(composeRowFromActive(active).feishuThreadLink).toContain('/client/thread/open?');
    expect(composeRowFromActive(active).feishuThreadLink).toContain('open_thread_id=omt_topic');

    const persisted = { ...active.session, status: 'active' as const };
    expect(composeRowFromPersistedActive(persisted).feishuThreadLink).toContain('open_thread_id=omt_topic');
    const closed = { ...active.session, status: 'closed' as const };
    expect(composeRowFromClosed(closed).feishuThreadLink).toContain('open_thread_id=omt_topic');

    const legacy = makeDs();
    legacy.session.scope = 'thread';
    expect(composeRowFromActive(legacy).feishuThreadLink).toBeUndefined();

    const corrupt = makeDs();
    corrupt.session.scope = 'thread';
    corrupt.session.larkThreadId = 'om_not_a_topic';
    expect(composeRowFromActive(corrupt).feishuThreadLink).toBeUndefined();
  });
});
