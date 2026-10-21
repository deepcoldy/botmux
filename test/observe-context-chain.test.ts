/**
 * transcript on disk → daemon SessionRow → `botmux observe` session, with nothing
 * stubbed between the transcript lookup and the normalizer: the shape a caller
 * of `botmux observe --session <id>` actually receives, for both CLIs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/transcript-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/transcript-resolver.js')>()),
  resolveSessionTranscriptPath: vi.fn(),
}));

import { config } from '../src/config.js';
import { __resetSessionUsageCachesForTest } from '../src/core/cost-calculator.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { normalizeSessionRow } from '../src/services/session-observe.js';
import { resolveSessionTranscriptPath } from '../src/services/transcript-resolver.js';
import { __testOnly_resetStatuslineCache, writeStatuslineSnapshot } from '../src/services/statusline-snapshot.js';

const T0 = Date.parse('2026-10-21T08:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let dir: string;
let prevDataDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-observe-chain-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dir;
  __resetSessionUsageCachesForTest();
  __testOnly_resetStatuslineCache();
});
afterEach(() => {
  config.session.dataDir = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function liveSession(cliId: string): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1', cliSessionId: 'cli-1', cliId, chatId: 'oc_chat', rootMessageId: 'om_root',
      title: 't', status: 'active', createdAt: new Date(T0).toISOString(),
    },
    worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle',
    workerPort: null, workerToken: null, larkAppId: 'cli_app', chatId: 'oc_chat', chatType: 'group', scope: 'thread',
    spawnedAt: T0, cliVersion: 'test', lastMessageAt: T0, hasHistory: false, workingDir: '/repo',
  } as unknown as DaemonSession;
}

const observe = (ds: DaemonSession) => normalizeSessionRow(
  composeRowFromActive(ds) as unknown as Parameters<typeof normalizeSessionRow>[0],
  { observedAt: T0 + 60_000 },
);

describe('observe context, end to end', () => {
  it('Claude Code: latest request, statusline window, compactions', () => {
    const transcript = join(dir, 'claude.jsonl');
    vi.mocked(resolveSessionTranscriptPath).mockReturnValue({ path: transcript, kind: 'claude' });
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', timestamp: iso(10), message: { id: 'a', usage: { input_tokens: 6, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 2_000, output_tokens: 800 } } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso(12) }),
      JSON.stringify({ type: 'assistant', timestamp: iso(20), message: { id: 'b', usage: { input_tokens: 4, cache_read_input_tokens: 31_000, cache_creation_input_tokens: 1_000, output_tokens: 300 } } }),
      '',
    ].join('\n'));
    writeStatuslineSnapshot(dir, 'sess-1', { ts: Date.now(), contextWindowTokens: 1_000_000 });

    expect(observe(liveSession('claude-code')).context).toEqual({
      usedTokens: 32_004,
      windowTokens: 1_000_000,
      compactions: 1,
      measuredAt: T0 + 20_000,
      source: 'claude-transcript',
    });
  });

  it('Codex: last_token_usage, model_context_window, compacted entries only', () => {
    const rollout = join(dir, 'rollout.jsonl');
    vi.mocked(resolveSessionTranscriptPath).mockReturnValue({ path: rollout, kind: 'codex' });
    const tokenCount = (used: number, sec: number) => JSON.stringify({
      timestamp: iso(sec), type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: used * 3, output_tokens: 90 },
        last_token_usage: { total_tokens: used, input_tokens: used - 30, output_tokens: 30 },
        model_context_window: 258_400,
      } },
    });
    writeFileSync(rollout, [
      tokenCount(200_000, 10),
      JSON.stringify({ timestamp: iso(11), type: 'compacted', payload: { message: '' } }),
      JSON.stringify({ timestamp: iso(11), type: 'event_msg', payload: { type: 'context_compacted' } }),
      tokenCount(41_500, 12),
      '',
    ].join('\n'));

    expect(observe(liveSession('codex')).context).toEqual({
      usedTokens: 41_500,
      windowTokens: 258_400,
      compactions: 1,
      measuredAt: T0 + 12_000,
      source: 'codex-rollout',
    });

    appendFileSync(rollout, `${tokenCount(52_000, 30)}\n`);
    __resetSessionUsageCachesForTest(); // skip the 15s reparse throttle
    expect(observe(liveSession('codex')).context).toMatchObject({ usedTokens: 52_000, compactions: 1, measuredAt: T0 + 30_000 });
  });

  it('a session with no transcript yet has no context key at all', () => {
    vi.mocked(resolveSessionTranscriptPath).mockReturnValue(null);
    const session = observe(liveSession('claude-code'));
    expect(session).not.toHaveProperty('context');
    expect(session.probe.status).toBe('ok');
  });
});
