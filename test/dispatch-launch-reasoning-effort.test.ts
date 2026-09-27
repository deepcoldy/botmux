/**
 * dispatch-launch-reasoning-effort.test.ts
 *
 * Locks the P1 regression closed for the direct-IPC dispatch launch path:
 * when the source requests `reasoningEffort: 'high'`, the value stamped in
 * `session.dispatchLaunchSpec.effective` MUST survive to the spawn config.
 *
 * Before the fix, only `dispatchLaunchSpec` was written by
 * `createDispatchLaunchSession` — `session.reasoningEffort` stayed undefined,
 * so `sessionAgentConfig`'s non-frozen branch fell back to `botCfg.reasoningEffort`,
 * silently downgrading the launch to the target bot's default while the
 * operation record still claimed `high`.
 *
 * The classic Lark `--repo` path, which stamps `session.reasoningEffort` via
 * `applyDispatchLaunchBinding`, already worked; this test also captures that
 * shape so future refactors can't diverge the two paths again.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { cliId: 'codex', larkAppId: 'cli_target_app' },
    botName: 'TargetBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotBrand: vi.fn(() => 'feishu'),
}));

vi.mock('../src/global-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/global-config.js')>();
  return { ...actual, readGlobalConfig: vi.fn(() => ({})) };
});

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    updateSession: vi.fn(),
    updateSessionPid: vi.fn(),
    registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
    cleanupSessionBridgeSendMarkers: vi.fn(),
    cleanupSessionBridgeSendMarkersNow: vi.fn(),
  };
});

import {
  __testOnly_sessionAgentConfig as sessionAgentConfig,
} from '../src/core/worker-pool.js';
import { createDispatchLaunchSession } from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';

const TARGET_APP = 'cli_target_app';
const CHAT_ID = 'oc_target_chat';
const ROOT_MESSAGE = 'om_target_root';

function makeDs(sessionOverrides: any, dsOverrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      chatId: CHAT_ID,
      rootMessageId: ROOT_MESSAGE,
      title: 'dispatched',
      status: 'active',
      createdAt: new Date().toISOString(),
      scope: 'thread',
      chatType: 'group',
      larkAppId: TARGET_APP,
      workingDir: '/tmp/project',
      ...sessionOverrides,
    } as any,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: TARGET_APP,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: 'unknown',
    lastMessageAt: Date.now(),
    hasHistory: false,
    workingDir: '/tmp/project',
    ownerOpenId: undefined,
    ...dsOverrides,
  } as DaemonSession;
}

describe('P1 — dispatchLaunchSpec.effective.reasoningEffort survives to spawn config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honors requested high on the direct-IPC path even when the target bot defaults to medium', () => {
    // Reproduces pi's probe: the direct-IPC session (only `dispatchLaunchSpec`,
    // no `session.reasoningEffort` in v1) must not let the target bot's
    // configured `medium` silently override the requested `high`.
    const dir = mkdtempSync(join(tmpdir(), 'p1-ipc-'));
    const session = createDispatchLaunchSession({
      dispatchId: `dl_${'a'.repeat(32)}`,
      chatId: CHAT_ID, rootMessageId: ROOT_MESSAGE, title: 'run codex',
      chatType: 'group', workingDir: dir, larkAppId: TARGET_APP,
      requestedOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(session.reasoningEffort).toBe('high');
    const ds = makeDs(session);
    const cfg = sessionAgentConfig(ds, {
      cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'medium',
    } as any);
    expect(cfg.model).toBe('gpt-5.6-sol');
    expect(cfg.reasoningEffort).toBe('high');
  });

  it('honors requested high when the target bot has no effort configured', () => {
    // Same probe with `reasoningEffort` unset on the bot: the old bug returned
    // undefined here (falling through the `?? botCfg.reasoningEffort` gap).
    const dir = mkdtempSync(join(tmpdir(), 'p1-ipc-'));
    const session = createDispatchLaunchSession({
      dispatchId: `dl_${'b'.repeat(32)}`,
      chatId: CHAT_ID, rootMessageId: ROOT_MESSAGE, title: 'run codex',
      chatType: 'group', workingDir: dir, larkAppId: TARGET_APP,
      requestedOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      effectiveOverride: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const ds = makeDs(session);
    const cfg = sessionAgentConfig(ds, { cliId: 'codex', model: 'gpt-5.6-sol' } as any);
    expect(cfg.reasoningEffort).toBe('high');
  });

  it('classic --repo path (session.reasoningEffort stamped) keeps the same outcome', () => {
    // Guarantee that the IPC and classic paths converge: both end up with the
    // effective effort stamped on the session BEFORE `sessionAgentConfig` runs,
    // so future refactors cannot diverge them by dropping either write site.
    const ds = makeDs({
      cliId: undefined,
      reasoningEffort: 'high',
      dispatchLaunchSpec: {
        version: 1, targetLarkAppId: TARGET_APP, chatId: CHAT_ID,
        rootMessageId: ROOT_MESSAGE,
        requested: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        effective: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const cfg = sessionAgentConfig(ds, {
      cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'medium',
    } as any);
    expect(cfg.reasoningEffort).toBe('high');
  });

  it('clears the effort when the effective model does not support it (worker-pool safety net kept)', () => {
    // The pre-existing safety net (worker-pool.ts) must still clear an effort
    // that the resolved model cannot honor. Use a model with no `ultra` support.
    const dir = mkdtempSync(join(tmpdir(), 'p1-ipc-'));
    const session = createDispatchLaunchSession({
      dispatchId: `dl_${'c'.repeat(32)}`,
      chatId: CHAT_ID, rootMessageId: ROOT_MESSAGE, title: 'run codex',
      chatType: 'group', workingDir: dir, larkAppId: TARGET_APP,
      requestedOverride: { model: 'gpt-5.4', reasoningEffort: 'ultra' as any },
      effectiveOverride: { model: 'gpt-5.4', reasoningEffort: 'ultra' as any },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(session.reasoningEffort).toBe('ultra');
    const ds = makeDs(session);
    const cfg = sessionAgentConfig(ds, { cliId: 'codex', model: 'gpt-5.4' } as any);
    expect(cfg.reasoningEffort).toBeUndefined();
  });
});
