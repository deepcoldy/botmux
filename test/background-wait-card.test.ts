/**
 * Daemon side of 「主回合已结束 · 后台子任务运行中（N）」: the worker reports the
 * count on screen_update, and the live card must follow it even when the status
 * underneath does not change (the PATCH path otherwise only fires on a status
 * edge). Everything else keyed on status stays untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { t } from '../src/i18n/index.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry, streamCardLabel,
  usageRefreshShouldRun, syncUsageRefreshTimer,
  __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { markSessionActivity } from '../src/core/session-activity.js';
import { normalizeExecutionActivity } from '../src/core/execution-activity.js';
import { sessionLastActivityAt } from '../src/dashboard/web/sessions.js';

const APP = 'cli_background_wait_card';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let ds: DaemonSession;
let worker: EventEmitter & { killed: boolean };

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'background-wait-card-'));
  const data = join(home, 'data'); mkdirSync(data, { mode: 0o700 });
  config.session.dataDir = data;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', replyCardMode: 'legacy' });
  ds = { larkAppId: APP, chatId: 'oc_bg', scope: 'chat', chatType: 'group',
    currentReplyTarget: { turnId: 'om_turn', rootMessageId: 'om_root' },
    session: { sessionId: 'sid_bg', larkAppId: APP, chatId: 'oc_bg', scope: 'chat',
      rootMessageId: 'om_root', cliId: 'claude-code', status: 'active', title: 'bg', workingDir: data },
  } as unknown as DaemonSession;
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_bg', 'om_root', 'bg', 'group', 'chat');
  ds.session = { ...stored, ...ds.session, sessionId: stored.sessionId };
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  mocks.request.mockReset().mockResolvedValue({ code: 0, data: { items: [] } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => data, getActiveCount: () => 1, closeSession: vi.fn() });
  // A live card for the current turn, so updates take the PATCH path.
  worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  ds.worker = worker as any;
  ds.workerReady = true;
  ds.workerGeneration = 1;
  ds.session.workerGeneration = 1;
  ds.displayMode = 'hidden';
  ds.lastScreenStatus = 'working';
  ds.streamCardId = 'om_card';
  ds.streamCardNonce = 'nonce';
  setupWorkerHandlers(ds, worker as any);
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

async function screenUpdate(status: 'working' | 'idle' | 'limited', backgroundTasks?: number): Promise<void> {
  await worker.listeners('message')[0]({
    type: 'screen_update', content: 'screen', status, turnId: 'om_turn',
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
  });
  await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
}

function patchedHeaders(): string[] {
  return mocks.patch.mock.calls.map(([request]) => JSON.parse(request.data.content).header.title.content as string);
}

async function withActivityClock(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try { await run(); } finally {
    if (ds.usageRefreshTimer) clearInterval(ds.usageRefreshTimer);
    ds.usageRefreshTimer = undefined;
    vi.useRealTimers();
  }
}

async function beginActivity(cliId: 'traex' | 'codex', usageDisplay: 'streaming' | 'footer' | 'off'): Promise<void> {
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId, replyCardMode: 'legacy', usageDisplay });
  ds.session.cliId = cliId;
  ds.currentTurnId = 'om_turn';
  const input = { turnId: 'om_turn', dispatchAttempt: 1 };
  await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, ...input });
  await worker.listeners('message')[0]({ type: 'turn_execution_started', ...input, startedAtMs: Date.now() - 1000 });
}

describe('activity-triggered refresh boundaries', () => {
  it.each([
    ['codex', 'streaming', 0], ['codex', 'footer', 0], ['codex', 'off', 0],
    ['traex', 'streaming', 1], ['traex', 'footer', 1], ['traex', 'off', 1],
  ] as const)('%s with usage %s adds %s stage-change PATCH', async (cliId, usageDisplay, patches) => {
    await withActivityClock(async () => {
      await beginActivity(cliId, usageDisplay);
      await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_turn', dispatchAttempt: 1, stage: 'tool_started' });
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(mocks.patch).toHaveBeenCalledTimes(patches);
      if (cliId === 'traex') {
        const content = JSON.parse(mocks.patch.mock.calls.at(-1)![0].data.content);
        expect(content.elements.some((element: any) => element.element_id === 'botmux_stream_activity')).toBe(true);
      }
    });
  });

  it.each(['footer', 'off'] as const)('does not arm a %s timer for backgroundTasks alone', async usageDisplay => {
    await withActivityClock(async () => {
      await beginActivity('traex', usageDisplay);
      ds.backgroundTaskCount = 2;
      expect(streamCardLabel(ds)).toEqual({ backgroundTasks: 2 });
      expect(usageRefreshShouldRun(ds)).toBe(false);
      syncUsageRefreshTimer(ds);
      expect(ds.usageRefreshTimer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(36_000);
      expect(mocks.patch).not.toHaveBeenCalled();
    });
  });

  it('does not rewrite a previous generation execution record or PATCH for it', async () => {
    await withActivityClock(async () => {
      await beginActivity('traex', 'streaming');
      const key = JSON.stringify(['om_turn', 1]);
      const stale = { startedAtMs: Date.now() - 2000, lastProgressAtMs: Date.now() - 1000, workerGeneration: 0, stage: 'model_output' as const };
      ds.replyExecutionStarts!.set(key, stale);
      const before = { ...stale };
      await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_turn', dispatchAttempt: 1, stage: 'tool_started' });
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(ds.replyExecutionStarts!.get(key)).toEqual(before);
      expect(mocks.patch).not.toHaveBeenCalled();
    });
  });

  it('updates progress age for repeated stages without additional PATCH, and PATCHes a new stage once', async () => {
    await withActivityClock(async () => {
      await beginActivity('traex', 'streaming');
      const input = { type: 'turn_progress' as const, turnId: 'om_turn', dispatchAttempt: 1, stage: 'model_output' as const };
      await worker.listeners('message')[0](input);
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      mocks.patch.mockClear();
      let lastProgressAtMs = 0;
      for (let n = 0; n < 20; n++) {
        await vi.advanceTimersByTimeAsync(100);
        lastProgressAtMs = Date.now();
        await worker.listeners('message')[0](input);
        await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      }
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(ds.replyExecutionStarts!.get(JSON.stringify(['om_turn', 1]))!.lastProgressAtMs).toBe(lastProgressAtMs);
      await worker.listeners('message')[0]({ ...input, stage: 'tool_started' });
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool' });
    });
  });
});

describe('Dashboard execution activity patches', () => {
  /** Rows as the Dashboard store holds them: snapshot, then every SSE patch merged over it after a JSON round trip. */
  function dashboardRow(): { current: () => Record<string, any>; stop: () => void } {
    let row: Record<string, any> = JSON.parse(JSON.stringify(composeRowFromActive(ds, { includeTokenUsage: false })));
    const stop = dashboardEventBus.subscribe((event: any) => {
      if (event.type !== 'session.update' || event.body.sessionId !== ds.session.sessionId) return;
      row = { ...row, ...JSON.parse(JSON.stringify(event.body.patch)) };
    });
    return { current: () => row, stop };
  }
  /** Returns the execution start the worker reported (waitFor advances a faked clock). */
  async function startTurn(turnId: string): Promise<number> {
    ds.currentTurnId = turnId;
    markSessionActivity(ds, Date.now());
    const startedAtMs = Date.now();
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: Date.now(), turnId, dispatchAttempt: 1 });
    await worker.listeners('message')[0]({ type: 'turn_execution_started', turnId, dispatchAttempt: 1, startedAtMs });
    await worker.listeners('message')[0]({ type: 'screen_update', content: 'screen', status: 'working', turnId });
    await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
    return startedAtMs;
  }
  async function settle(turnId: string): Promise<void> {
    await worker.listeners('message')[0]({ type: 'screen_update', content: 'screen', status: 'idle', turnId });
    await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
  }

  it('replaces a settled turn\'s observation instead of carrying it into the next turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ds.lastScreenStatus = 'idle';
    const view = dashboardRow();
    try {
      const turnOneStart = await startTurn('om_turn');
      vi.setSystemTime(Date.now() + 30_000);
      expect(view.current().executionActivity?.startedAtMs).toBe(turnOneStart);
      await settle('om_turn');
      expect(view.current().executionActivity ?? null).toBeNull();
      vi.setSystemTime(Date.now() + 600_000);
      const turnTwoStart = await startTurn('om_turn_2');
      vi.setSystemTime(turnTwoStart + 5_000);
      expect(view.current().executionActivity?.startedAtMs).toBe(turnTwoStart);
      // The row was measured at the turn start; the live view advances it with the render clock.
      expect(normalizeExecutionActivity(view.current().executionActivity, Date.now())).toMatchObject({ elapsedSeconds: 5 });
    } finally { view.stop(); vi.useRealTimers(); }
  });

  it('picks up the turn start when the working edge arrived before it', async () => {
    ds.lastScreenStatus = 'idle';
    const view = dashboardRow();
    try {
      ds.currentTurnId = 'om_turn';
      await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, turnId: 'om_turn', dispatchAttempt: 1 });
      await worker.listeners('message')[0]({ type: 'screen_update', content: 'screen', status: 'working', turnId: 'om_turn' });
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(view.current().executionActivity).toMatchObject({ phase: 'unknown', source: 'unavailable' });
      const startedAtMs = Date.now();
      await worker.listeners('message')[0]({ type: 'turn_execution_started', turnId: 'om_turn', dispatchAttempt: 1, startedAtMs });
      expect(view.current().executionActivity).toMatchObject({ source: 'turn-start', startedAtMs });
    } finally { view.stop(); }
  });

  it('keeps lastMessageAt on the last routed input while the CLI reports progress (display time follows progress)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'traex', replyCardMode: 'legacy' });
    ds.session.cliId = 'traex';
    ds.lastScreenStatus = 'idle';
    const view = dashboardRow();
    try {
      await startTurn('om_turn');
      const inputAt = Date.parse(ds.session.lastMessageAt!);
      vi.setSystemTime(Date.now() + 45_000);
      await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_turn', dispatchAttempt: 1, stage: 'tool_started' });
      expect(view.current().executionActivity).toMatchObject({ phase: 'tool', lastProgressAtMs: Date.now() });
      expect(view.current().lastMessageAt).toBe(inputAt);
      expect(composeRowFromActive(ds, { includeTokenUsage: false }).lastMessageAt).toBe(inputAt);
      // The 「最近」/「更新于」 display reads the separate activity time, which does follow progress.
      expect(sessionLastActivityAt(view.current())).toBe(Date.now());
      expect(sessionLastActivityAt(composeRowFromActive(ds, { includeTokenUsage: false }) as any)).toBe(Date.now());
    } finally { view.stop(); vi.useRealTimers(); }
  });

  it('does not count the write itself as the last execution activity', async () => {
    ds.lastScreenStatus = 'idle';
    await startTurn('om_turn');
    const activity = composeRowFromActive(ds, { includeTokenUsage: false }).executionActivity;
    expect(activity).toMatchObject({ phase: 'unknown', source: 'turn-start' });
    expect(activity).not.toHaveProperty('lastProgressAtMs');
  });

  it.each(['streaming', 'footer', 'off'] as const)('leaves a non-Trae card on the plain working header (usage %s)', async usageDisplay => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', replyCardMode: 'legacy', usageDisplay });
    ds.lastScreenStatus = 'idle';
    await startTurn('om_turn');
    expect(composeRowFromActive(ds, { includeTokenUsage: false }).executionActivity).toMatchObject({ source: 'turn-start' });
    expect(streamCardLabel(ds)).toBeUndefined();
    expect(patchedHeaders().at(-1)).toContain(t('card.status.working', undefined, 'zh'));
    if (usageDisplay !== 'streaming') expect(usageRefreshShouldRun(ds)).toBe(false);
  });
});

describe('background-wait label on the live card', () => {
  it('keeps current capture tuples intact and rejects superseded or mismatching activity', async () => {
    ds.session.cliId = 'traex'; ds.currentTurnId = 'om_turn';
    type Execution = NonNullable<DaemonSession['replyExecutionStarts']> extends Map<string, infer V> ? V : never;
    const execution: Execution = { startedAtMs: Date.now() - 1000, workerGeneration: ds.workerGeneration!, stage: 'tool_started' };
    ds.replyExecutionStarts = new Map([
      [JSON.stringify(['om_turn', 1]), execution],
      [JSON.stringify(['om_turn', 2]), { ...execution, stage: 'tool_returned' }],
      [JSON.stringify(['om_other', 1]), execution],
    ]);
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, turnId: 'om_turn', dispatchAttempt: 1 });
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool' });
    ds.turnDispatchAttemptHighWater = { turnId: 'om_turn', dispatchAttempt: 2 };
    expect(streamCardLabel(ds)).toBeUndefined();
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 2, turnId: 'om_turn', dispatchAttempt: 2 });
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'working' });
    ds.managedTurnOrigin = { turnId: 'om_turn', dispatchAttempt: 2 } as NonNullable<DaemonSession['managedTurnOrigin']>;
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 3, turnId: 'om_other', dispatchAttempt: 1 });
    expect(streamCardLabel(ds)).toBeUndefined();
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 4 });
    expect(streamCardLabel(ds)).toBeUndefined();
    ds.captureIdentity = undefined;
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'working' });
  });

  it('carries real Trae transcript tool activity through the native bridge into the card', async () => {
    ds.session.cliId = 'traex'; ds.currentTurnId = 'om_turn';
    const input = { turnId: 'om_turn', dispatchAttempt: 1 };
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, ...input });
    await worker.listeners('message')[0]({ type: 'turn_execution_started', ...input, startedAtMs: Date.now() - 1000 });
    const pending: Promise<unknown>[] = []; const published: unknown[] = [];
    const observe = loadWorkerFunction('observeCotEntries', {
      lastInitConfig: { cliId: 'traex', noProgressNotify: { cliEnabled: false } },
      send: (message: unknown) => { published.push(message); pending.push(worker.listeners('message')[0](message)); },
      thinkingTurnKey: 'om_turn|1', thinkingTotalChars: 60_000,
      THINKING_ACCUMULATED_CAP: 60_000, thinkingCapNoted: true,
    });
    const path = join(home, 'native-tool.jsonl'); const now = Date.now();
    writeFileSync(path, [
      { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'execute task', turn_id: 'native-turn' } },
      { timestamp: new Date(now + 1).toISOString(), type: 'history_mutation', payload: { version: 1, commit_id: 'native-turn', turn_id: 'native-turn', operation: 'append',
        items: [{ type: 'function_call', call_id: 'tool', name: 'read_file', arguments: '{"path":"private-argument"}' }] } },
    ].map(value => JSON.stringify(value) + '\n').join(''));
    const queue = new CodexBridgeQueue(Date.now);
    queue.mark('om_turn', 'execute task', now - 1, 1);
    queue.setCotObserver((entries, turn) => observe(entries, turn));
    queue.ingest(drainTraexRollout(path, 0).events);
    await Promise.all(pending);
    await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
    expect(published).toEqual([{ type: 'turn_progress', ...input, stage: 'tool_started' }]);
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool' });
    expect(JSON.stringify(published)).not.toContain('private-argument');
  });

  it.each(['off', 'footer'] as const)('refreshes activity while token usage is %s', async usageDisplay => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'traex', replyCardMode: 'legacy', usageDisplay });
      ds.session.cliId = 'traex'; ds.currentTurnId = 'om_turn';
      const input = { turnId: 'om_turn', dispatchAttempt: 1 };
      await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, ...input });
      await worker.listeners('message')[0]({ type: 'turn_execution_started', ...input, startedAtMs: Date.now() - 1000 });
      await worker.listeners('message')[0]({ type: 'turn_progress', ...input, stage: 'tool_started' });
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(ds.usageRefreshTimer).toBeDefined();
      const before = mocks.patch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(36_000);
      await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
      expect(mocks.patch.mock.calls.length).toBeGreaterThan(before);
      expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool', progressAgeSeconds: 36 });
    } finally {
      if (ds.usageRefreshTimer) clearInterval(ds.usageRefreshTimer);
      ds.usageRefreshTimer = undefined; vi.useRealTimers();
    }
  });

  it.each([undefined, 1])('uses exact native turn progress at attempt %s and drops it on a successor', async dispatchAttempt => {
    ds.session.cliId = 'traex';
    ds.currentTurnId = 'om_turn';
    await worker.listeners('message')[0]({ type: 'capture_identity', revision: 1, turnId: 'om_turn', dispatchAttempt });
    await worker.listeners('message')[0]({ type: 'turn_execution_started', turnId: 'om_turn', dispatchAttempt, startedAtMs: Date.now() - 60_000 });
    await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_turn', dispatchAttempt, stage: 'tool_started' });
    await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool' });
    const content = JSON.parse(mocks.patch.mock.calls.at(-1)![0].data.content);
    expect(content.elements.some((element: any) => element.element_id === 'botmux_stream_activity')).toBe(true);
    await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_other', dispatchAttempt, stage: 'tool_returned' });
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'tool' });
    await worker.listeners('message')[0]({ type: 'turn_progress', turnId: 'om_turn', dispatchAttempt, stage: 'tool_returned' });
    expect(streamCardLabel(ds)).toMatchObject({ activity: 'working' });
    ds.currentTurnId = 'om_successor';
    expect(streamCardLabel(ds)).toBeUndefined();
  });

  it('patches the header when only the background count changes', async () => {
    await screenUpdate('working');
    expect(mocks.patch).not.toHaveBeenCalled();

    await screenUpdate('working', 2);
    expect(ds.backgroundTaskCount).toBe(2);
    expect(streamCardLabel(ds)).toEqual({ backgroundTasks: 2 });
    expect(patchedHeaders().at(-1)).toContain('主回合已结束 · 后台子任务运行中（2）');

    // Same status, same count: nothing to redraw.
    await screenUpdate('working', 2);
    expect(mocks.patch).toHaveBeenCalledTimes(1);

    await screenUpdate('working', 1);
    expect(patchedHeaders().at(-1)).toContain('后台子任务运行中（1）');

    // The worker drops the field once the main agent works again.
    await screenUpdate('working');
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(patchedHeaders().at(-1)).toContain('工作中');
    expect(mocks.patch).toHaveBeenCalledTimes(3);
  });

  it('shows the label over idle too, and falls back to the idle label when the work is done', async () => {
    ds.completedIdleTurnId = 'om_turn';
    await screenUpdate('idle', 1);
    expect(patchedHeaders().at(-1)).toContain('后台子任务运行中（1）');
    await screenUpdate('idle');
    expect(patchedHeaders().at(-1)).toContain('✓ 本轮已结束 · 等待输入');
    expect(streamCardLabel(ds)).toBe('completed');
  });

  it('ignores the count under a status it does not describe', async () => {
    await screenUpdate('limited', 3);
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(patchedHeaders().every(header => !header.includes('后台子任务'))).toBe(true);
  });
});
