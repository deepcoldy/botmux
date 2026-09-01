// test/dashboard-attention-signals.test.ts
//
// Attention signals for the dashboard sessions board (needs-you column):
//   - composeRowFromActive carries pendingRepo / tuiPromptActive
//   - publishAttentionPatch emits a session.update derived from live state
//   - announcePendingRepoSession announces card-waiting sessions (which have
//     no worker yet, so the normal spawn-time announce never fires) and
//     no-ops for non-pending sessions
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
} from '../src/core/dashboard-rows.js';
import {
  announcePendingRepoSession,
  announceSessionRow,
  clearAgentAttention,
  publishAttentionPatch,
  publishClosedSessionPatch,
  publishLastInputFromBotPatch,
  publishNativeTopicLinkPatch,
  publishSessionMessagePreviewPatch,
} from '../src/core/session-activity.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { fillNativeTopicId } from '../src/core/native-topic-id.js';
import { attentionWaitSince } from '../src/dashboard/web/ui.js';
import {
  setTerminalProxyPort,
  setTerminalExternalPort,
  resetTerminalProxy,
} from '../src/core/terminal-url.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1',
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
    ...overrides,
  } as DaemonSession;
}

function collectEvents(): DashboardEvent[] {
  const seen: DashboardEvent[] = [];
  const off = dashboardEventBus.subscribe(e => seen.push(e));
  // vitest runs this file in one process — detach after each test via closure
  collectEvents.off = off;
  return seen;
}
collectEvents.off = () => {};

describe('attention signals', () => {
  beforeEach(() => {
    collectEvents.off();
  });

  it('composeRowFromActive exposes pendingRepo and tuiPromptActive', () => {
    const row = composeRowFromActive(makeDs({ pendingRepo: true, tuiPromptCardId: 'om_card' }));
    expect(row.pendingRepo).toBe(true);
    expect(row.tuiPromptActive).toBe(true);

    const quiet = composeRowFromActive(makeDs());
    expect(quiet.pendingRepo).toBe(false);
    expect(quiet.tuiPromptActive).toBe(false);
  });

  it('projects the frozen runtime identity without changing the adapter id', () => {
    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.session.cliRuntime = {
      id: 'vendor-codex',
      displayName: 'Vendor Codex',
      executable: '/opt/vendor-codex',
      source: 'configured',
      update: { provider: 'none' },
    };
    expect(composeRowFromActive(ds)).toMatchObject({
      cliId: 'codex',
      runtimeId: 'vendor-codex',
      runtimeDisplayName: 'Vendor Codex',
    });

    const legacy = structuredClone(ds.session);
    delete legacy.cliRuntime;
    legacy.cliPathOverride = 'C:\\tools\\legacy-codex.exe';
    expect(composeRowFromClosed(legacy)).toMatchObject({
      cliId: 'codex',
      runtimeId: 'legacy-codex.exe',
      runtimeDisplayName: 'legacy-codex.exe',
    });
  });

  it('composeRowFromActive marks restored workerless active sessions as dormant', () => {
    expect(composeRowFromActive(makeDs()).status).toBe('dormant');
    expect(composeRowFromActive(makeDs({ worker: {} as any })).status).toBe('starting');
    // Stale screen state belongs to the process that was suspended. Without a
    // live process the logical session is dormant; with one it remains idle.
    expect(composeRowFromActive(makeDs({ lastScreenStatus: 'idle' })).status).toBe('dormant');
    expect(composeRowFromActive(makeDs({ worker: {} as any, lastScreenStatus: 'idle' })).status).toBe('idle');

    const queued = makeDs();
    queued.session.queued = true;
    expect(composeRowFromActive(queued).status).toBe('idle');
  });

  it('composeRowFromActive carries the agent raise-hand signal with its reason', () => {
    const raised = composeRowFromActive(makeDs({
      agentAttention: { kind: 'authz', reason: '需要 prod 部署授权', at: 1234 },
    }));
    // `at` (raise time) is exposed so the UI shows a true "waiting since" time
    expect(raised.agentAttention).toEqual({ kind: 'authz', reason: '需要 prod 部署授权', at: 1234 });

    // quiet sessions omit the field entirely (not a needs-you row)
    expect(composeRowFromActive(makeDs()).agentAttention).toBeUndefined();
  });

  it('composeRowFromActive carries the session scope (locate vs open-chat)', () => {
    const chatScoped = makeDs();
    chatScoped.session.scope = 'chat';
    expect(composeRowFromActive(chatScoped).scope).toBe('chat');

    const threadScoped = makeDs();
    threadScoped.session.scope = 'thread';
    expect(composeRowFromActive(threadScoped).scope).toBe('thread');

    // legacy sessions persisted before the scope field existed
    expect(composeRowFromActive(makeDs()).scope).toBeUndefined();
  });

  it('composeRowFromActive exposes the latest Bot-authored inbound turn as an inferred signal', () => {
    const botTriggered = makeDs();
    botTriggered.session.quoteTargetSenderIsBot = true;
    expect(composeRowFromActive(botTriggered).lastInputFromBot).toBe(true);

    const humanTriggered = makeDs();
    humanTriggered.session.quoteTargetSenderIsBot = false;
    expect(composeRowFromActive(humanTriggered).lastInputFromBot).toBe(false);
  });

  it('publishLastInputFromBotPatch updates the inferred sender signal in real time', () => {
    const seen = collectEvents();
    const ds = makeDs();
    ds.session.quoteTargetSenderIsBot = true;
    publishLastInputFromBotPatch(ds);
    ds.session.quoteTargetSenderIsBot = false;
    publishLastInputFromBotPatch(ds);

    expect(seen).toEqual([
      {
        type: 'session.update',
        body: { sessionId: 'sess-1', patch: { lastInputFromBot: true } },
      },
      {
        type: 'session.update',
        body: { sessionId: 'sess-1', patch: { lastInputFromBot: false } },
      },
    ]);
  });

  it('immediately adds a direct topic link to an already-hydrated active row', () => {
    const ds = makeDs();
    ds.session.scope = 'thread';
    const aggregator = new Aggregator();
    aggregator.hydrateSessions(ds.larkAppId, [composeRowFromActive(ds)]);
    expect(aggregator.getSession('sess-1')?.feishuThreadLink).toBeUndefined();

    const seen = collectEvents();
    expect(fillNativeTopicId(ds.session, 'thread', 'omt_original')).toBe(true);
    expect(publishNativeTopicLinkPatch(ds)).toBe(true);
    expect(seen).toEqual([{
      type: 'session.update',
      body: {
        sessionId: 'sess-1',
        patch: { feishuThreadLink: expect.stringContaining('open_thread_id=omt_original') },
      },
    }]);
    aggregator.applyEvent(ds.larkAppId, seen[0]);
    expect(aggregator.getSession('sess-1')?.feishuThreadLink).toContain('open_thread_id=omt_original');

    // A repeated message cannot overwrite the original topic or emit another
    // Dashboard patch; malformed/chat ids are rejected before this helper.
    expect(fillNativeTopicId(ds.session, 'thread', 'omt_other')).toBe(false);
    expect(fillNativeTopicId(ds.session, 'chat', 'omt_chat')).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('does not publish a native topic patch without a valid link', () => {
    const seen = collectEvents();
    expect(publishNativeTopicLinkPatch(makeDs())).toBe(false);
    expect(seen).toEqual([]);
  });

  it('publishSessionMessagePreviewPatch refreshes the exchange after queue append', () => {
    const previousDataDir = process.env.SESSION_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-patch-'));
    config.session.dataDir = dataDir;
    try {
      mkdirSync(join(dataDir, 'queues'), { recursive: true });
      writeFileSync(join(dataDir, 'queues', 'om_root.jsonl'), `${JSON.stringify({
        senderType: 'user',
        content: 'latest question',
        createTime: '2000',
      })}\n`);
      const seen = collectEvents();

      publishSessionMessagePreviewPatch(makeDs());

      expect(seen).toEqual([{
        type: 'session.update',
        body: {
          sessionId: 'sess-1',
          patch: expect.objectContaining({
            previewUserText: 'latest question',
            previewUserAt: 2_000,
            previewBotState: 'waiting',
          }),
        },
      }]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it('publishClosedSessionPatch clears every merged preview field', () => {
    const seen = collectEvents();

    publishClosedSessionPatch('sess-1', 2_000, { tokenUsage: null });

    expect(seen).toEqual([{
      type: 'session.update',
      body: {
        sessionId: 'sess-1',
        patch: {
          status: 'closed',
          closedAt: 2_000,
          tokenUsage: null,
          previewUserText: null,
          previewBotText: null,
          previewUserFullText: null,
          previewBotFullText: null,
          previewUserAt: null,
          previewBotAt: null,
          previewBotState: null,
        },
      },
    }]);
  });

  it('composeRowFromActive exposes backend metadata for external session bridges', () => {
    const zmx = makeDs();
    zmx.session.backendType = 'zmx';
    zmx.session.titleUpdatedAt = '2026-07-13T10:00:00.000Z';
    zmx.session.titleSource = 'agent';
    expect(composeRowFromActive(zmx)).toMatchObject({
      backendType: 'zmx',
      backendSessionName: 'bmx-sess-1',
      titleUpdatedAt: '2026-07-13T10:00:00.000Z',
      titleSource: 'agent',
    });

    const herdr = makeDs();
    herdr.session.backendType = 'herdr';
    herdr.session.persistentBackendTarget = {
      backendType: 'herdr',
      sessionName: 'botmux',
      agentName: 'botmux-sess-1',
    };
    expect(composeRowFromActive(herdr)).toMatchObject({
      backendType: 'herdr',
      backendSessionName: 'botmux',
    });

    const adopted = makeDs();
    adopted.session.backendType = 'zmx';
    adopted.session.adoptedFrom = { source: 'tmux', tmuxTarget: 'user:1.0', cwd: '/repo' };
    expect(composeRowFromActive(adopted).backendSessionName).toBeUndefined();

    const closed = { ...zmx.session, status: 'closed' as const, closedAt: '2026-07-13T11:00:00.000Z' };
    expect(composeRowFromClosed(closed)).toMatchObject({
      status: 'closed',
      backendType: 'zmx',
      backendSessionName: 'bmx-sess-1',
    });

    const legacy = { ...closed, backendType: undefined };
    expect(composeRowFromClosed(legacy).backendSessionName).toBeUndefined();
  });

  it('composeRowFromPersistedActive keeps quarantined backend metadata and previews', () => {
    const previousDataDir = process.env.SESSION_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-persisted-row-'));
    config.session.dataDir = dataDir;
    try {
      mkdirSync(join(dataDir, 'queues'), { recursive: true });
      writeFileSync(join(dataDir, 'queues', 'om_root.jsonl'), `${JSON.stringify({
        senderType: 'user',
        content: 'pending recovery question',
        createTime: '3000',
      })}\n`);

      const ds = makeDs();
      ds.session.backendType = 'zmx';
      ds.session.restoreQuarantinedAt = '2026-07-31T00:00:00.000Z';
      const row = composeRowFromPersistedActive(ds.session);

      expect(row).toMatchObject({
        status: 'dormant',
        backendType: 'zmx',
        backendSessionName: 'bmx-sess-1',
        quarantined: true,
        previewUserText: 'pending recovery question',
        previewUserAt: 3_000,
        previewBotState: 'waiting',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it('publishAttentionPatch emits session.update derived from session state', () => {
    const seen = collectEvents();
    publishAttentionPatch(makeDs({ tuiPromptCardId: 'om_card' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: 'session.update',
      body: {
        sessionId: 'sess-1',
        patch: { pendingRepo: false, tuiPromptActive: true, agentAttention: null },
      },
    });
  });

  it('publishAttentionPatch carries agentAttention (object when raised, null to clear)', () => {
    const seen = collectEvents();
    const ds = makeDs({ agentAttention: { kind: 'decision', reason: '要删 old_users 表', at: 5 } });
    publishAttentionPatch(ds);
    ds.agentAttention = undefined;
    publishAttentionPatch(ds);
    expect(seen.map(e => (e as any).body.patch.agentAttention)).toEqual([
      { kind: 'decision', reason: '要删 old_users 表', at: 5 },
      null,
    ]);
  });

  it('clearAgentAttention clears once and publishes the null patch', () => {
    const seen = collectEvents();
    const ds = makeDs({ agentAttention: { kind: 'blocked', reason: '缺权限', at: 5 } });

    expect(clearAgentAttention(ds)).toBe(true);
    expect(ds.agentAttention).toBeUndefined();
    expect(clearAgentAttention(ds)).toBe(false);
    expect(seen.map(e => (e as any).body.patch.agentAttention)).toEqual([null]);
  });

  it('publishAttentionPatch reflects cleared signals (idempotent re-derive)', () => {
    const seen = collectEvents();
    const ds = makeDs({ pendingRepo: true });
    publishAttentionPatch(ds);
    ds.pendingRepo = false;
    publishAttentionPatch(ds);
    expect(seen.map(e => (e as any).body.patch.pendingRepo)).toEqual([true, false]);
  });

  it('announcePendingRepoSession publishes a full session.spawned row when pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('session.spawned');
    const row = (seen[0] as any).body.session;
    expect(row.sessionId).toBe('sess-1');
    expect(row.pendingRepo).toBe(true);
    expect(row.status).toBe('dormant'); // no live worker/screen yet; pendingRepo still routes it to needs-you
  });

  it('announceSessionRow publishes a full session.spawned row for restored active sessions', () => {
    const seen = collectEvents();
    announceSessionRow(makeDs({ hasHistory: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('session.spawned');
    const row = (seen[0] as any).body.session;
    expect(row.sessionId).toBe('sess-1');
    expect(row.hasHistory).toBe(true);
    expect(row.status).toBe('dormant');
  });

  it('announcePendingRepoSession is a no-op when the session is not pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: false }));
    announcePendingRepoSession(makeDs());
    expect(seen).toHaveLength(0);
  });

  it('handleThreadReply clears agent attention before early-return intercepts', () => {
    const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('async function handleThreadReply(');
    expect(start).toBeGreaterThanOrEqual(0);
    // Bound the source-order assertion by the next top-level sibling instead
    // of a character count. Legitimate additions to handleThreadReply (for
    // example master's CAS handoff paths or PR #597's admission and recovery
    // guards) must not make this regression test silently inspect only the
    // first part of the function.
    const end = src.indexOf('\nasync function autoCreateDocSession(', start);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    const clearIdx = region.indexOf('clearAgentAttentionForHumanInbound();');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    for (const marker of [
      'isCallbackUrl(content)',
      'handleV3SavedWorkflowCommandIfAny',
      'parseWorkflowGrillTrigger',
      'isLegacyTemplateCommand',
      'parseSlashCommandInvocation',
      'findPendingAskByAnchor',
    ]) {
      const markerIdx = region.indexOf(marker);
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeLessThan(markerIdx);
    }
  });

  it('attentionWaitSince prefers agent raise time and falls back safely', () => {
    expect(attentionWaitSince({ agentAttention: { at: 1234 }, lastMessageAt: 9999 })).toBe(1234);
    expect(attentionWaitSince({ pendingRepo: true, lastMessageAt: 9999 })).toBe(9999);
    expect(attentionWaitSince({ agentAttention: { at: 'bad' }, lastMessageAt: 9999 })).toBe(9999);
    expect(attentionWaitSince({})).toBe(0);
  });
});

describe('goal dashboard daemon IPC wiring', () => {
  const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

  function between(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from, `missing marker: ${start}`).toBeGreaterThanOrEqual(0);
    expect(to, `missing marker: ${end}`).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  it('signs live-risk reads and all goal mutations sent to daemon IPC', () => {
    const regions = [
      between('async function collectGoalAttentionLiveRisks(', '/** Create a Feishu group'),
      between('const mGoalWatchdog =', 'const mGoalNotificationRetry ='),
      between('const mGoalNotificationRetry =', 'const mGoalDecision ='),
      between('const mGoalDecision =', 'const mWhiteboard ='),
    ];
    for (const region of regions) {
      expect(region).toContain('fetchDaemonIpc(');
      expect(region).not.toContain('await fetch(`http://127.0.0.1:');
    }
  });
});

// The dashboard "open terminal" link is built from row.proxyPort (sessions.ts
// terminalHref), NOT buildTerminalUrl — so the row must carry the SAME advertised
// port the card links use, or the relay scenario gives a broken dashboard link.
describe('composeRowFromActive — advertised proxy port (WEB_EXTERNAL_PORT)', () => {
  afterEach(() => resetTerminalProxy());

  it('advertises WEB_EXTERNAL_PORT (relay port) to the dashboard, not the local proxy port', () => {
    setTerminalProxyPort(8800);     // local bound proxy port
    setTerminalExternalPort(9000);  // WEB_EXTERNAL_PORT + botIndex
    expect(composeRowFromActive(makeDs()).proxyPort).toBe(9000);
  });

  it('advertises the bound proxy port when WEB_EXTERNAL_PORT is unset', () => {
    setTerminalProxyPort(8800);
    expect(composeRowFromActive(makeDs()).proxyPort).toBe(8800);
  });

  it('omits proxyPort (→ frontend uses direct webPort) when the proxy never bound', () => {
    resetTerminalProxy();
    setTerminalExternalPort(9000);
    expect(composeRowFromActive(makeDs()).proxyPort).toBeUndefined();
  });
});
