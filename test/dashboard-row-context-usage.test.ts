/**
 * SessionRow.contextUsage — what the daemon hands `botmux observe`.
 *
 * The transcript read itself is covered in session-context-observation.test.ts;
 * here the row composer is exercised with a stubbed read and REAL statusline
 * files, because the window source (a fresh statusline snapshot, never a model
 * name) and the "absent unless proven" rule live in the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionUsageWithContext: vi.fn(),
}));

import { config } from '../src/config.js';
import { getSessionUsageWithContext } from '../src/core/cost-calculator.js';
import { composeRowFromActive, composeRowFromClosed } from '../src/core/dashboard-rows.js';
import {
  STATUSLINE_STALE_MS,
  __testOnly_resetStatuslineCache,
  writeStatuslineSnapshot,
} from '../src/services/statusline-snapshot.js';

const MEASURED_AT = Date.parse('2026-10-21T08:00:20.000Z');
const TOKENS = {
  in: 100, out: 10, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1, model: 'm',
};

let dataDir: string;
let prevDataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-row-context-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  __testOnly_resetStatuslineCache();
  vi.mocked(getSessionUsageWithContext).mockReset();
});
afterEach(() => {
  config.session.dataDir = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function activeSession(cliId: string, extra: Record<string, unknown> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1', cliSessionId: 'cli-1', cliId, chatId: 'oc_chat', rootMessageId: 'om_root',
      title: 't', status: 'active', createdAt: new Date(1000).toISOString(), ...extra,
    },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'cli_app', chatId: 'oc_chat', chatType: 'group',
    scope: 'thread', spawnedAt: 1000, cliVersion: 'test', lastMessageAt: 1000, hasHistory: false, workingDir: '/repo',
  } as unknown as DaemonSession;
}

function claudeRead(compactions: number | null = 3) {
  return {
    snapshot: { context: { usedTokens: 161_240 }, tokens: TOKENS, turnTokens: null },
    contextObservation: { measuredAtMs: MEASURED_AT, compactions, source: 'claude-transcript' as const },
  };
}

describe('Claude Code row context', () => {
  it('takes the window from a fresh statusline snapshot', () => {
    writeStatuslineSnapshot(dataDir, 'sess-1', { ts: Date.now(), contextWindowTokens: 1_000_000, contextPercent: 16 });
    vi.mocked(getSessionUsageWithContext).mockReturnValue(claudeRead());

    expect(composeRowFromActive(activeSession('claude-code')).contextUsage).toEqual({
      usedTokens: 161_240,
      windowTokens: 1_000_000,
      compactions: 3,
      measuredAt: MEASURED_AT,
      source: 'claude-transcript',
    });
  });

  it('reports the window as null once the statusline snapshot is older than ten minutes', () => {
    writeStatuslineSnapshot(dataDir, 'sess-1', { ts: Date.now() - STATUSLINE_STALE_MS - 1_000, contextWindowTokens: 1_000_000 });
    vi.mocked(getSessionUsageWithContext).mockReturnValue(claudeRead());

    expect(composeRowFromActive(activeSession('claude-code')).contextUsage).toMatchObject({
      usedTokens: 161_240,
      windowTokens: null,
    });
  });

  it('never infers a window from the model when there is no snapshot at all', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue({
      ...claudeRead(),
      snapshot: { context: { usedTokens: 161_240 }, tokens: { ...TOKENS, model: 'claude-opus-4-1[1m]' }, turnTokens: null },
    });

    expect(composeRowFromActive(activeSession('claude-code')).contextUsage?.windowTokens).toBeNull();
  });

  it('passes an unknown compaction count through as null', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue(claudeRead(null));
    expect(composeRowFromActive(activeSession('claude-code')).contextUsage?.compactions).toBeNull();
  });
});

describe('Codex row context', () => {
  it('takes the window from the rollout and ignores any statusline file', () => {
    writeStatuslineSnapshot(dataDir, 'sess-1', { ts: Date.now(), contextWindowTokens: 12_345 });
    vi.mocked(getSessionUsageWithContext).mockReturnValue({
      snapshot: { context: { usedTokens: 61_000, windowTokens: 258_400, percentUsed: 24 }, tokens: TOKENS, turnTokens: null },
      contextObservation: { measuredAtMs: MEASURED_AT, compactions: 1, source: 'codex-rollout' },
    });

    expect(composeRowFromActive(activeSession('codex')).contextUsage).toEqual({
      usedTokens: 61_000,
      windowTokens: 258_400,
      compactions: 1,
      measuredAt: MEASURED_AT,
      source: 'codex-rollout',
    });
  });

  it('reports the window as null when the rollout did not carry one', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue({
      snapshot: { context: { usedTokens: 61_000 }, tokens: TOKENS, turnTokens: null },
      contextObservation: { measuredAtMs: MEASURED_AT, compactions: 0, source: 'codex-rollout' },
    });

    expect(composeRowFromActive(activeSession('codex')).contextUsage).toMatchObject({ windowTokens: null });
  });
});

describe('absent unless proven', () => {
  it('omits the block (and keeps token totals) when the read produced no observation', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue({
      snapshot: { context: { usedTokens: 900 }, tokens: TOKENS, turnTokens: null },
    });

    const row = composeRowFromActive(activeSession('gemini'));
    expect('contextUsage' in row).toBe(false);
    expect(row.tokenUsage).toEqual(TOKENS);
  });

  it('omits the block when there is no usable context measurement', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue({
      snapshot: { context: null, tokens: null, turnTokens: null },
      contextObservation: { measuredAtMs: MEASURED_AT, compactions: 0, source: 'claude-transcript' },
    });

    expect('contextUsage' in composeRowFromActive(activeSession('claude-code'))).toBe(false);
  });

  it('never scans in bulk-list mode, so list rows carry no block', () => {
    const row = composeRowFromActive(activeSession('claude-code'), { includeTokenUsage: false });
    expect('contextUsage' in row).toBe(false);
    expect(getSessionUsageWithContext).not.toHaveBeenCalled();
  });

  it('does not read a Remote Runner transcript off the daemon host', () => {
    vi.mocked(getSessionUsageWithContext).mockReturnValue(claudeRead());
    const row = composeRowFromActive(activeSession('claude-code', { backendType: 'remote-runner' }));
    expect('contextUsage' in row).toBe(false);
  });

  it('does not rescan a closed session that already has a persisted token snapshot', () => {
    const row = composeRowFromClosed({
      ...activeSession('claude-code').session, status: 'closed', tokenUsage: TOKENS,
    } as never);
    expect('contextUsage' in row).toBe(false);
    expect(getSessionUsageWithContext).not.toHaveBeenCalled();
  });
});
