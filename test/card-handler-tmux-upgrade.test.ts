import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import {
  readTmuxUpgradeStoreFrom,
  startTmuxUpgradeMonitor,
  stopTmuxUpgradeMonitor,
  type TmuxFacts,
  type TmuxUpgradeAdvisorDeps,
} from '../src/core/tmux-upgrade.js';
import {
  TMUX_UPGRADE_ACTION_RUN,
  buildTmuxUpgradeCard,
} from '../src/core/tmux-upgrade-card.js';
import {
  parseTmuxSwitchSuspendRequest,
  selectTmuxSwitchCandidates,
} from '../src/core/tmux-switch-candidates.js';
import { __testOnly_setSuspendBackingVerifier } from '../src/core/worker-pool.js';

const dirs: string[] = [];
afterEach(() => {
  stopTmuxUpgradeMonitor();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(dataDir: string, over: Partial<TmuxUpgradeAdvisorDeps> = {}): TmuxUpgradeAdvisorDeps {
  const facts: TmuxFacts = { client: '3.3a', serverRunning: true, server: '3.3a', serverUnknown: false, sessions: 2 };
  return {
    dataDir,
    larkAppId: 'cli_primary',
    ownerOpenId: () => 'ou_owner',
    isAdmin: (_a, id) => id === 'ou_owner',
    locale: () => 'zh',
    now: () => 1_000,
    tmuxBackendInUse: () => true,
    socketName: () => 'botmux',
    probeFacts: async () => facts,
    plan: async () => ({ auto: true, owner: { kind: 'brew', brewBin: '/opt/homebrew/bin/brew' }, tmuxPath: '/opt/homebrew/bin/tmux', display: 'brew upgrade tmux' }),
    executeUpgrade: vi.fn(async () => ({ ok: true, ran: [] })),
    sendCard: vi.fn(async () => 'om_card'),
    updateCard: vi.fn(async () => {}),
    isUpdateExpired: () => false,
    fanOutSuspend: vi.fn(async () => ({ candidates: 0, affected: 0, failed: 0 })),
    killServer: vi.fn(async () => {}),
    retireEmptyServer: vi.fn(async () => {}),
    sleep: async () => {},
    processStart: () => 'start',
    log: () => {},
    newNonce: () => 'nonce-x',
    progressPatchMs: 0,
    ...over,
  };
}

function click(action: string, operator: string, nonce = 'nonce-x') {
  return handleCardAction({
    operator: { open_id: operator },
    context: { open_message_id: 'om_card' },
    action: { value: { action, nonce } },
  }, { activeSessions: new Map(), sessionReply: vi.fn(), lastRepoScan: new Map() } as any, 'cli_primary');
}

describe('tmux upgrade buttons through the real card handler', () => {
  it('without the primary-daemon advisor the click is answered, not dropped', async () => {
    const res = await click(TMUX_UPGRADE_ACTION_RUN, 'ou_owner');
    expect(res).toHaveProperty('toast.type', 'warning');
  });

  it('routes to the advisor: admins get the live card, others a refusal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tmux-upgrade-card-handler-'));
    dirs.push(dataDir);
    const d = deps(dataDir);
    const advisor = startTmuxUpgradeMonitor(d);
    await advisor.tick();
    expect(readTmuxUpgradeStoreFrom(dataDir).card?.messageId).toBe('om_card');

    const refused = await click(TMUX_UPGRADE_ACTION_RUN, 'ou_someone_else');
    expect(refused).toHaveProperty('toast.type', 'error');
    expect(readTmuxUpgradeStoreFrom(dataDir).job).toBeUndefined();

    const accepted = await click(TMUX_UPGRADE_ACTION_RUN, 'ou_owner');
    expect(accepted.card?.type).toBe('raw');
    expect(typeof accepted.afterAck).toBe('function');
    await accepted.afterAck();
    expect(d.executeUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('tmux upgrade card in chat history', () => {
  it('its buttons never leak into model-visible text, even unstamped', () => {
    const raw = buildTmuxUpgradeCard({
      phase: 'pending_switch', min: '3.4', why: 'w', client: '3.5a', server: '3.3a', serverSessions: 2,
    }, 'n', 'zh');
    const text = extractCardContent(raw);
    expect(text).toContain('3.5a');
    // Buttons would render as `[label]`; the prose may name the options.
    expect(text).not.toContain('[立即切换]');
    expect(text).not.toContain('[空闲时自动切换]');
    expect(text).not.toContain('tmux_upgrade_');
  });
});

describe('which sessions a daemon may suspend for the server switch', () => {
  function ds(sessionId: string, target: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
    const lastMessageAt = 1_000;
    return {
      session: {
        sessionId,
        status: 'active',
        title: sessionId,
        cliId: 'claude-code',
        lastMessageAt: new Date(lastMessageAt).toISOString(),
        ...(target ? { persistentBackendTarget: target } : {}),
      },
      initConfig: { backendType: (target?.backendType as string) ?? 'tmux' },
      worker: { killed: false, send: vi.fn(), once: vi.fn(), kill: vi.fn(), exitCode: null, signalCode: null },
      workerPort: 1,
      workerToken: 't',
      workerReady: true,
      larkAppId: 'cli_x',
      spawnedAt: lastMessageAt,
      lastMessageAt,
      lastScreenStatus: 'idle',
      exitEventEmitted: false,
      ...over,
    } as any;
  }

  it('only idle tmux sessions on the server being replaced', () => {
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      const registry = new Map<string, any>([
        ['a', ds('on-botmux', { backendType: 'tmux', sessionName: 'bmx-a', socketName: 'botmux' })],
        ['b', ds('on-default', { backendType: 'tmux', sessionName: 'bmx-b' })],
        ['c', ds('busy', { backendType: 'tmux', sessionName: 'bmx-c', socketName: 'botmux' }, { lastScreenStatus: 'working' })],
        ['d', ds('herdr', { backendType: 'herdr', sessionName: 'bmx-d', sessionId: 'herdr' })],
        ['e', ds('other-sock', { backendType: 'tmux', sessionName: 'bmx-e', socketName: 'elsewhere' })],
      ]);
      const now = 1_000 + 60 * 60_000;
      expect(selectTmuxSwitchCandidates(registry, { socketName: 'botmux', olderThanMs: 1, now })
        .map(c => c.sessionId)).toEqual(['on-botmux']);
      expect(selectTmuxSwitchCandidates(registry, { socketName: undefined, olderThanMs: 1, now })
        .map(c => c.sessionId)).toEqual(['on-default']);
      // Not idle long enough yet.
      expect(selectTmuxSwitchCandidates(registry, { socketName: 'botmux', olderThanMs: 2 * 60 * 60_000, now })).toEqual([]);
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
  });

  it('request validation rejects anything but a plain socket name and a positive age', () => {
    expect(parseTmuxSwitchSuspendRequest({ socketName: 'botmux', olderThanMs: 1, dryRun: true }))
      .toEqual({ socketName: 'botmux', olderThanMs: 1, dryRun: true });
    expect(parseTmuxSwitchSuspendRequest({ socketName: null, olderThanMs: 5, dryRun: false }))
      .toEqual({ socketName: null, olderThanMs: 5, dryRun: false });
    for (const bad of [
      null, {}, { socketName: '../x', olderThanMs: 1, dryRun: true },
      { socketName: 'botmux', olderThanMs: 0, dryRun: true },
      { socketName: 'botmux', olderThanMs: 1, dryRun: 'yes' },
      { socketName: 'a b', olderThanMs: 1, dryRun: true },
    ]) {
      expect(parseTmuxSwitchSuspendRequest(bad)).toBeNull();
    }
  });
});
