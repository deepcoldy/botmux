/**
 * Restore resilience: restoreActiveSessions must complete daemon startup even
 * when the persisted store holds unrecoverable legacy records.
 *
 *   - A non-adopt, non-queued active record with no cliId is a legacy row that
 *     cannot be safely lazy-resumed (the CLI that owns its transcript is
 *     unknown). It must be SKIPPED with a warning carrying locatable
 *     diagnostics — not registered, and never allowed to crash the loop.
 *   - Any other per-record throw ("缺 cliId 等" — the unforeseen cousins) must
 *     be contained to that record: siblings in the same batch still restore.
 *
 * Heavy collaborators are mocked at the module boundary; the session-store
 * runs for real against a temp dir (same pattern as restore-zombie-close).
 *
 * Run:  pnpm exec vitest run --project unit test/session-restore-resilience.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
    daemon: { backendType: 'pty', recoveryForkBatchSize: 5, recoveryForkDelayMs: 0, workingDir: '~', workingDirs: ['~'] },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: vi.fn(),
}));

const wp = vi.hoisted(() => ({ registry: null as Map<string, any> | null }));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getActiveSessionsRegistry: vi.fn(() => wp.registry ?? undefined),
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, key: string, ds: any) => {
    map.set(key, ds);
  }),
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
  closeSession: vi.fn(async () => ({ ok: true, alreadyClosed: false })),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', cliId: 'claude-code', workingDir: '~', workingDirs: ['~'] },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  })),
  getAllBots: vi.fn(() => [{
    config: { larkAppId: 'app_test', cliId: 'claude-code' },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  }]),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/core/session-discovery.js', () => ({
  validateAdoptTarget: vi.fn(() => true),
  validateAdoptTargetState: vi.fn(() => 'alive'),
  adoptTargetLabel: vi.fn(() => 'target'),
}));

vi.mock('../src/core/session-activity.js', () => ({
  announceSessionRow: vi.fn(),
  markSessionActivity: vi.fn(),
}));

import { restoreActiveSessions } from '../src/core/session-manager.js';
import { announceSessionRow } from '../src/core/session-activity.js';
import { logger } from '../src/utils/logger.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'restore-resilience-test-'));
  sessionStore.init();
  wp.registry = null;
  vi.mocked(announceSessionRow).mockReset();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeActiveSession(rootMessageId: string, opts: { cliId?: string } = {}) {
  const s = sessionStore.createSession('oc_chat1', rootMessageId, 'Topic', 'group');
  s.larkAppId = 'app_test';
  s.workingDir = '/tmp/proj';
  if (opts.cliId !== undefined) s.cliId = opts.cliId as never;
  s.scope = 'thread';
  sessionStore.updateSession(s);
  return s;
}

describe('restoreActiveSessions — unrecoverable legacy records', () => {
  it('skips a legacy record missing cliId with a locatable warning; siblings restore', async () => {
    const legacy = makeActiveSession('om_legacy_no_cli');
    const healthy = makeActiveSession('om_healthy', { cliId: 'claude-code' });
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    // The healthy sibling is registered and announced.
    const restored = map.get(sessionKey('om_healthy', 'app_test'));
    expect(restored).toBeDefined();
    expect(restored!.session.sessionId).toBe(healthy.sessionId);

    // The legacy record is skipped — never registered.
    expect([...map.values()].some(ds => ds.session.sessionId === legacy.sessionId)).toBe(false);

    // The warning carries locatable diagnostics: session id and the reason.
    const warnings = vi.mocked(logger.warn).mock.calls.map(call => String(call[0]));
    const skipWarning = warnings.find(line => line.includes(legacy.sessionId));
    expect(skipWarning).toBeDefined();
    expect(skipWarning).toMatch(/cliId/);
    expect(skipWarning).toContain('oc_chat1');
    expect(skipWarning).toContain('om_legacy_no_cli');
  });

  it('contains an unexpected per-record failure so the rest of the batch still restores', async () => {
    // Created first so its failure would previously abort the whole loop
    // before the healthy sibling was reached.
    const poisoned = makeActiveSession('om_poisoned', { cliId: 'claude-code' });
    const healthy = makeActiveSession('om_survivor', { cliId: 'claude-code' });
    vi.mocked(announceSessionRow).mockImplementation((ds: DaemonSession) => {
      if (ds.session.sessionId === poisoned.sessionId) {
        throw new Error('injected legacy-record corruption');
      }
    });
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    const restored = map.get(sessionKey('om_survivor', 'app_test'));
    expect(restored).toBeDefined();
    expect(restored!.session.sessionId).toBe(healthy.sessionId);

    const warnings = vi.mocked(logger.warn).mock.calls.map(call => String(call[0]));
    const failureWarning = warnings.find(line => line.includes(poisoned.sessionId));
    expect(failureWarning).toBeDefined();
    expect(failureWarning).toMatch(/injected legacy-record corruption/);
  });

  it('does not skip queued (待办池) records that legitimately have no cliId yet', async () => {
    const queued = makeActiveSession('om_queued');
    queued.queued = true;
    queued.queuedPrompt = '排队中的首轮任务';
    sessionStore.updateSession(queued);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await expect(restoreActiveSessions(map)).resolves.toBeUndefined();

    const restored = map.get(sessionKey('om_queued', 'app_test'));
    expect(restored).toBeDefined();
    expect(restored!.session.queued).toBe(true);
    expect(restored!.pendingPrompt).toBe('排队中的首轮任务');
  });
});
