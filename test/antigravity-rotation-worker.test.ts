import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { annotateAntigravityUsageLimit } from '../src/adapters/cli/antigravity.js';
import { detectCliUsageLimit, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';

const INCIDENT_QUOTA_SCREEN = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\n'
  + 'Error ID: af1698f6-aaaa-bbbb-cccc-dddddddddddd-1\n────\n>\n────\n? for shortcuts  accept-edits · Gemini 4 Neon · xhigh';
const NO_ERROR_ID_QUOTA_SCREEN = INCIDENT_QUOTA_SCREEN.replace(/Error ID: [^\n]+\n/, '');
const FIXED_TIME_QUOTA_SCREEN = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets at 11:59 PM.\n'
  + 'Error ID: fixed-time-episode\n────\n>\n────\n';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

let scenarioSeq = 0;
async function setupRotationScenario(input: {
  directFailure: boolean; accountCount?: number; limitedDirectFailure?: boolean; recordStatus?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-worker-rotation-'));
  const previousHome = process.env.HOME;
  const previousDataDir = process.env.SESSION_DATA_DIR;
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.SESSION_DATA_DIR = join(root, 'data');
  const app = `agy_rotation_test_${++scenarioSeq}`;
  const { registerBot } = await import('../src/bot-registry.js');
  const sessionStore = await import('../src/services/session-store.js');
  const { initWorkerPool, __testOnly_setupWorkerHandlers, setActiveSessionsRegistry } = await import('../src/core/worker-pool.js');
  const { activeSessionKey } = await import('../src/core/types.js');
  const { saveAntigravityAccount } = await import('../src/services/antigravity-accounts.js');

  registerBot({
    larkAppId: app,
    larkAppSecret: 'test-secret',
    cliId: 'antigravity',
    allowedUsers: ['ou_owner'],
    disableStreamingCard: true,
  } as never);
  sessionStore.init(app);
  const failedTurnRecovery = input.recordStatus
    ? await import('../src/core/failed-turn-recovery.js') : undefined;
  const replies: unknown[][] = [];
  initWorkerPool({
    sessionReply: async (...args: unknown[]) => { replies.push(args); return 'om_reply'; },
    getSessionWorkingDir: () => root,
    getActiveCount: () => 1,
    closeSession: () => {},
    ...(failedTurnRecovery ? {
      onScreenStatus: (ds: any, context: any) => {
        if (context.status === 'limited') failedTurnRecovery.recordLimitedFailedTurn(ds, context.turnId);
        else if (context.prevStatus === 'limited') failedTurnRecovery.clearLimitedFailedTurn(ds, context.turnId);
      },
    } : {}),
  } as never);
  const session = sessionStore.createSession('oc_probe', 'om_root', 'rotation probe', 'group', 'chat');
  session.ownerOpenId = 'ou_owner';
  session.lastCliInput = 'do work';
  session.lastUserPrompt = 'do work';
  session.lastCliInputTurnId = 'turn-1';
  session.antigravityAccountId = 'acc1';
  session.cliSessionId = 'a4331552-f261-4f1f-a460-e15e7f2fe0ea';
  session.lastFailedTurn = {
    turnId: 'turn-1',
    cliInput: 'do work',
    userPrompt: 'do work',
    failedAt: new Date().toISOString(),
    status: 'failed',
    retryCount: 0,
    ...(input.directFailure ? { directFailure: true as const } : { limitedSnapshot: true }),
    ...(input.limitedDirectFailure ? { directFailure: true as const } : {}),
  };
  sessionStore.updateSession(session);
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    pid: process.pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const sent: Array<{ type: string; content?: string; attemptId?: string }> = [];
  Object.assign(worker, {
    send: (msg: { type: string }) => { sent.push(msg); return true; },
    kill: () => { worker.killed = true; return true; },
  });
  const ds = {
    session,
    larkAppId: app,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    workerPort: 9999,
    workerReady: true,
    cliReady: true,
    spawnedAt: Date.now(),
    lastMessageAt: 1000,
    lastCliInput: 'do work',
    lastUserPrompt: 'do work',
    lastCliInputTurnId: 'turn-1',
    antigravityAccountId: 'acc1',
    localProcessAttestation: { cliPid: process.pid },
  };
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds as never), ds]]));
  const nowMs = Date.now();
  const rawToken = (email: string) => JSON.stringify({
    id_token_email: email,
    token: {
      access_token: `access-${email}`, refresh_token: `refresh-${email}`,
      expiry: new Date(nowMs + 3_600_000).toISOString(), token_type: 'Bearer',
    },
  });
  const live = join(home, '.gemini/antigravity-cli/antigravity-oauth-token');
  mkdirSync(dirname(live), { recursive: true, mode: 0o700 });
  writeFileSync(live, rawToken('a@example.test'), { mode: 0o600 });
  saveAntigravityAccount('acc1');
  const accountCount = input.accountCount ?? 2;
  for (let i = 2; i <= accountCount; i++) {
    const source = join(root, `account-${i}.json`);
    writeFileSync(source, rawToken(i === 2 ? 'b@example.test' : `acc${i}@example.test`), { mode: 0o600 });
    saveAntigravityAccount(`acc${i}`, { sourceTokenPath: source });
  }
  __testOnly_setupWorkerHandlers(ds as never, worker as never);
  const transcriptPath = join(home, '.gemini', 'antigravity-cli', 'brain',
    session.cliSessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    content: '<USER_REQUEST>\ndo work\n</USER_REQUEST>',
  }) + '\n');
  const transcriptFd = openSync(transcriptPath, 'r');
  cleanups.push(() => closeSync(transcriptFd));
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  cleanups.push(() => {
    setActiveSessionsRegistry(new Map());
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  return { ds, worker, sent, replies, flush, nowMs, sessionStore, transcriptPath };
}

function nativeUsageLimit(screen: string, key: string, nowMs: number): CliUsageLimitState {
  const detected = detectCliUsageLimit(screen, new Date(nowMs));
  if (!detected.limited) throw new Error('incident quota text was not detected');
  return annotateAntigravityUsageLimit(screen, detected, { text: screen, key });
}

async function emitQuotaAndStart(
  h: Awaited<ReturnType<typeof setupRotationScenario>>,
  turnId: string | null = 'turn-1',
  retryOffsetMs = 60_000,
  requireRestart = true,
  nativeScreen?: string,
  nativeEpisodeKey = 'native-episode-1',
  limitDirectFailure = false,
) {
  const previousRestartCount = h.sent.filter(msg => msg.type === 'restart').length;
  const frameTurnId = turnId ?? undefined;
  h.worker.emit('message', { type: 'screen_update', content: 'working\nesc to cancel', status: 'working', ...(frameTurnId ? { turnId: frameTurnId } : {}) });
  await h.flush();
  let usageLimit: CliUsageLimitState = {
    limited: true, kind: 'usage', retryAtMs: h.nowMs + retryOffsetMs,
    retryLabel: '1m', retryReady: false, source: 'antigravity-error-composer',
  };
  let content = 'quota exceeded';
  if (nativeScreen) {
    usageLimit = nativeUsageLimit(nativeScreen, nativeEpisodeKey, h.nowMs);
    content = nativeScreen;
  }
  if ((limitDirectFailure || h.ds.session.lastFailedTurn?.directFailure === true)
    && h.ds.session.lastFailedTurn?.turnId === frameTurnId) {
    usageLimit = { ...usageLimit, directFailure: true };
  }
  h.worker.emit('message', {
    type: 'screen_update', content, status: 'limited', ...(frameTurnId ? { turnId: frameTurnId } : {}),
    usageLimit,
  });
  await h.flush();
  const restart = h.sent.slice(previousRestartCount).find(msg => msg.type === 'restart');
  if (!restart?.attemptId) {
    if (requireRestart) throw new Error(`rotation did not start: ${JSON.stringify(h.sent)}`);
    return undefined;
  }
  return restart;
}

describe('Antigravity worker-pool replay safety', () => {
  it('rotates, restarts and replays the failed turn for the observed quota screen with a shortcuts footer', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true });
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN);
    expect(h.ds.lastScreenStatus).toBe('limited');
    expect(h.ds.session.antigravityAccountId).toBe('acc1');

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(msg => msg.type)).toEqual(['restart', 'message']);
    expect(h.sent.find(msg => msg.type === 'message')).toMatchObject({ content: 'do work' });
    expect(h.ds.session.antigravityAccountId).toBe('acc2');
    expect(h.ds.usageLimit).toBeUndefined();
  });

  it('rotates without replaying a turn that already completed tool work', async () => {
    const h = await setupRotationScenario({ directFailure: false });
    const afterTool = '● Bash(create-the-file)\n  ⎿  file created\n' + INCIDENT_QUOTA_SCREEN;
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, afterTool);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(msg => msg.type)).toEqual(['restart']);
    expect(h.ds.session.antigravityAccountId).toBe('acc2');
  });

  it('does not rotate again for the same Error ID after a successful replay', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true });
    const first = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: first!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: first!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    const replay = h.sent.find(msg => msg.type === 'message');
    expect(replay).toBeDefined();
    const consumed = h.ds.session.consumedAntigravityQuotaKeys;
    expect(consumed).toHaveLength(1);
    const sessionStore = await import('../src/services/session-store.js');
    expect(sessionStore.getSessionFresh(h.ds.session.sessionId)?.consumedAntigravityQuotaKeys).toEqual(consumed);
    h.ds.antigravityRotation = undefined;

    const second = await emitQuotaAndStart(h, (replay as any).turnId, 60_000, false, INCIDENT_QUOTA_SCREEN);
    expect(second).toBeUndefined();
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(1);
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(1);
    expect(h.ds.usageLimit).toBeUndefined();
  });

  it('rotates for a fresh native episode with the same countdown and no screen Error ID', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true, accountCount: 3 });
    const first = await emitQuotaAndStart(h, 'turn-1', 60_000, true, NO_ERROR_ID_QUOTA_SCREEN, 'native-episode-a');
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: first!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: first!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    const replay = h.sent.find(msg => msg.type === 'message');
    expect(replay).toBeDefined();
    const replayTurnId = (replay as any).turnId as string;
    h.ds.session.lastFailedTurn = {
      turnId: replayTurnId, cliInput: 'do work', userPrompt: 'do work',
      failedAt: new Date().toISOString(), status: 'failed', retryCount: 1,
      limitedSnapshot: true, directFailure: true,
    };
    h.ds.session.lastCliInputTurnId = replayTurnId;
    h.ds.lastCliInputTurnId = replayTurnId;
    const sessionStore = await import('../src/services/session-store.js');
    sessionStore.updateSession(h.ds.session);

    const second = await emitQuotaAndStart(h, replayTurnId, 60_000, true, NO_ERROR_ID_QUOTA_SCREEN, 'native-episode-b');
    expect(second).toBeDefined();
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc3', attemptId: second!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: second!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(2);
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(2);
    expect(h.ds.session.consumedAntigravityQuotaKeys).toEqual([
      'log:native-episode-a', 'log:native-episode-b',
    ]);
  });

  it('deduplicates an identical fixed-time native Error ID', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true });
    const first = await emitQuotaAndStart(h, 'turn-1', 60_000, true, FIXED_TIME_QUOTA_SCREEN);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: first!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: first!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    const replay = h.sent.find(msg => msg.type === 'message');
    expect(replay).toBeDefined();
    expect(h.ds.session.consumedAntigravityQuotaKeys).toEqual(['composer:fixed-time-episode']);

    const second = await emitQuotaAndStart(h, (replay as any).turnId, 60_000, false, FIXED_TIME_QUOTA_SCREEN);
    expect(second).toBeUndefined();
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(1);
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(1);
    expect(h.ds.usageLimit).toBeUndefined();
  });

  it.each([
    { suppressRecoveryCard: true, frameType: 'screen_update' as const },
    { suppressRecoveryCard: false, frameType: 'screen_update' as const },
    { suppressRecoveryCard: true, frameType: 'screenshot_uploaded' as const },
    { suppressRecoveryCard: false, frameType: 'screenshot_uploaded' as const },
  ])('filters a consumed episode before persistent state (restore=$suppressRecoveryCard, frame=$frameType)', async ({
    suppressRecoveryCard, frameType,
  }) => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    delete h.ds.session.lastFailedTurn;
    h.ds.session.consumedAntigravityQuotaKeys = ['log:native-episode-1'];
    h.ds.suppressRecoveryCard = suppressRecoveryCard;
    h.ds.lastScreenStatus = 'idle';
    h.ds.activeInteractiveTurn = { turnId: 'turn-1', caller: {
      senderType: 'user', requestLarkAppId: h.ds.larkAppId, requestUserOpenId: 'ou_owner',
    } };
    h.sessionStore.updateSession(h.ds.session);
    const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
    const dashboardStatuses: unknown[] = [];
    const off = dashboardEventBus.subscribe((event: any) => {
      if (event.type === 'session.update' && event.body.sessionId === h.ds.session.sessionId) {
        dashboardStatuses.push(event.body.patch.status);
      }
    });
    cleanups.push(off);
    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    h.worker.emit('message', frameType === 'screen_update'
      ? { type: frameType, content: INCIDENT_QUOTA_SCREEN, status: 'limited', turnId: 'turn-1', usageLimit }
      : { type: frameType, imageKey: 'img-consumed', status: 'limited', turnId: 'turn-1', usageLimit });
    await h.flush();

    const stored = h.sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(0);
    expect(h.ds.usageLimit).toBeUndefined();
    expect(h.ds.lastScreenStatus).not.toBe('limited');
    expect(stored?.usageLimit).toBeUndefined();
    expect(stored?.lastFailedTurn).toBeUndefined();
    expect(dashboardStatuses).not.toContain('limited');
  });

  it('publishes screenshot recovery after clearing a sticky consumed episode', async () => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    h.ds.usageLimit = usageLimit;
    h.ds.lastScreenStatus = 'limited';
    h.ds.suppressRecoveryCard = true;
    h.ds.session.usageLimit = usageLimit;
    h.ds.session.consumedAntigravityQuotaKeys = ['log:native-episode-1'];
    h.ds.session.lastFailedTurn = {
      turnId: 'turn-1', cliInput: 'do work', userPrompt: 'do work',
      failedAt: new Date().toISOString(), status: 'failed', retryCount: 0,
      limitedSnapshot: true,
    };
    h.sessionStore.updateSession(h.ds.session);
    const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
    const statuses: unknown[] = [];
    const off = dashboardEventBus.subscribe((event: any) => {
      if (event.type === 'session.update' && event.body.sessionId === h.ds.session.sessionId) {
        statuses.push(event.body.patch.status);
      }
    });
    cleanups.push(off);

    h.worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-consumed-recovery', status: 'limited', turnId: 'turn-1', usageLimit,
    });
    await h.flush();

    const stored = h.sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(h.ds.lastScreenStatus).toBe('idle');
    expect(stored?.usageLimit).toBeUndefined();
    expect(stored?.lastFailedTurn).toBeUndefined();
    expect(statuses).toContain('idle');
  });

  it('retries a consumed sticky screenshot clear and publishes recovery without another frame', async () => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    h.ds.usageLimit = usageLimit;
    h.ds.lastScreenStatus = 'limited';
    h.ds.suppressRecoveryCard = true;
    h.ds.session.usageLimit = usageLimit;
    h.ds.session.consumedAntigravityQuotaKeys = ['log:native-episode-1'];
    h.sessionStore.updateSession(h.ds.session);
    const { dashboardEventBus } = await import('../src/core/dashboard-events.js');
    const statuses: unknown[] = [];
    const off = dashboardEventBus.subscribe((event: any) => {
      if (event.type === 'session.update' && event.body.sessionId === h.ds.session.sessionId) {
        statuses.push(event.body.patch.status);
      }
    });
    cleanups.push(off);

    let failOnce = true;
    let writes = 0;
    const previousImageKey = h.ds.currentImageKey;
    h.sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes += 1;
      if (failOnce) { failOnce = false; throw new Error('injected consumed-clear failure'); }
    });
    cleanups.push(() => h.sessionStore.__testOnly_setBeforeRowPersist(undefined));
    h.worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-consumed-retry', status: 'limited', turnId: 'turn-1', usageLimit,
    });
    await h.flush();
    h.sessionStore.__testOnly_setBeforeRowPersist(undefined);
    expect(h.ds.usageLimit?.nativeEpisodeKey).toBe('log:native-episode-1');
    expect(h.ds.lastScreenStatus).toBe('limited');
    expect(writes).toBe(1);
    expect(h.ds.currentImageKey).toBe(previousImageKey);
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.currentImageKey).toBe(previousImageKey);
    expect(statuses).not.toContain('idle');

    await new Promise(resolve => setTimeout(resolve, 600));
    await h.flush();
    const stored = h.sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(h.ds.usageLimit).toBeUndefined();
    expect(h.ds.lastScreenStatus).toBe('idle');
    expect(stored?.usageLimit).toBeUndefined();
    expect(stored?.lastFailedTurn).toBeUndefined();
    expect(statuses).toContain('idle');
  });

  it('retries provisional failed-turn cleanup after recovery when its SQLite write fails', async () => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    h.ds.usageLimit = usageLimit;
    h.ds.lastScreenStatus = 'limited';
    h.ds.suppressRecoveryCard = true;
    h.ds.session.usageLimit = usageLimit;
    h.ds.session.consumedAntigravityQuotaKeys = ['log:native-episode-1'];
    h.sessionStore.updateSession(h.ds.session);

    let writes = 0;
    h.sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes += 1;
      if (writes === 2) throw new Error('injected failed-turn cleanup failure');
    });
    cleanups.push(() => h.sessionStore.__testOnly_setBeforeRowPersist(undefined));
    h.worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-cleanup-retry', status: 'limited', turnId: 'turn-1', usageLimit,
    });
    await h.flush();
    h.sessionStore.__testOnly_setBeforeRowPersist(undefined);
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(h.ds.usageLimit).toBeUndefined();
    expect(h.ds.lastScreenStatus).toBe('idle');
    expect(h.ds.session.lastFailedTurn?.turnId).toBe('turn-1');
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn?.turnId).toBe('turn-1');

    await new Promise(resolve => setTimeout(resolve, 600));
    await h.flush();
    expect(h.ds.session.lastFailedTurn).toBeUndefined();
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn).toBeUndefined();
  });

  it('records a limited failed turn when the first native evidence is a screenshot', async () => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    delete h.ds.session.lastFailedTurn;
    h.ds.activeInteractiveTurn = { turnId: 'turn-1', caller: {
      senderType: 'user', requestLarkAppId: h.ds.larkAppId, requestUserOpenId: 'ou_owner',
    } };
    h.sessionStore.updateSession(h.ds.session);
    const usageLimit = {
      ...nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs),
      directFailure: true as const,
    };
    h.worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img-first-limit', status: 'limited', turnId: 'turn-1', usageLimit,
    });
    await h.flush();

    expect(h.ds.session.lastFailedTurn).toMatchObject({
      turnId: 'turn-1', limitedSnapshot: true, directFailure: true,
    });
    const restart = h.sent.find(msg => msg.type === 'restart');
    expect(restart?.attemptId).toBeDefined();
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.find(msg => msg.type === 'message')).toMatchObject({ content: 'do work' });
  });

  it.each(['screen_update', 'screenshot_uploaded'] as const)('accepts late no-progress proof before an active rotation replays (%s)', async frameType => {
    const h = await setupRotationScenario({ directFailure: false, recordStatus: true });
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN);
    expect(restart?.attemptId).toBeDefined();
    expect(h.ds.session.lastFailedTurn?.directFailure).toBeUndefined();

    const usageLimit = {
      ...nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs),
      directFailure: true as const,
    };
    const frame = frameType === 'screen_update'
      ? { type: frameType, content: INCIDENT_QUOTA_SCREEN, status: 'limited', turnId: 'turn-1', usageLimit }
      : { type: frameType, imageKey: 'img-late-proof', status: 'limited', turnId: 'turn-1', usageLimit };
    for (const listener of h.worker.listeners('message')) await listener(frame);
    await h.flush();

    expect(h.ds.usageLimit?.directFailure).toBe(true);
    expect(h.ds.session.lastFailedTurn).toMatchObject({ limitedSnapshot: true, directFailure: true });
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn?.directFailure).toBe(true);

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(1);
    expect(h.sent.find(msg => msg.type === 'message')).toMatchObject({ content: 'do work' });
  });

  it('revokes a cached replay when no-progress proof disappears before restart settles', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true, recordStatus: true });
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN, 'native-episode-1', true);
    expect(h.ds.usageLimit?.directFailure).toBe(true);

    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    const frame = { type: 'screen_update', content: INCIDENT_QUOTA_SCREEN, status: 'limited', turnId: 'turn-1', usageLimit };
    for (const listener of h.worker.listeners('message')) await listener(frame);
    await h.flush();
    expect(h.ds.usageLimit?.directFailure).toBeUndefined();
    expect(h.ds.session.lastFailedTurn?.directFailure).toBeUndefined();
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn?.directFailure).toBeUndefined();

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(0);
  });

  it.each([false, true])('invalidates a cached replay for a pre-ready replacement native episode (proof=%s)', async directFailure => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true, recordStatus: true });
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN, 'native-episode-a', true);
    expect(h.ds.usageLimit?.nativeEpisodeKey).toBe('log:native-episode-a');

    const replacement = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-b', h.nowMs);
    const usageLimit = directFailure ? { ...replacement, directFailure: true as const } : replacement;
    const frame = { type: 'screen_update', content: INCIDENT_QUOTA_SCREEN, status: 'limited', turnId: 'turn-1', usageLimit };
    await Promise.all(h.worker.listeners('message').map(listener => listener(frame)));
    await h.flush();
    expect(h.ds.usageLimit?.nativeEpisodeKey).toBe('log:native-episode-b');
    expect(h.ds.usageLimit?.directFailure).toBe(directFailure ? true : undefined);
    expect(h.sessionStore.getSessionFresh(h.ds.session.sessionId)?.usageLimit?.nativeEpisodeKey).toBe('log:native-episode-b');

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(0);
  });

  it('fails closed when revoking proof loses its failed-turn SQLite write before settlement', async () => {
    const h = await setupRotationScenario({ directFailure: false, limitedDirectFailure: true, recordStatus: true });
    const restart = await emitQuotaAndStart(h, 'turn-1', 60_000, true, INCIDENT_QUOTA_SCREEN, 'native-episode-1', true);
    expect(h.ds.usageLimit?.directFailure).toBe(true);

    let writes = 0;
    h.sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes += 1;
      if (writes === 2) throw new Error('injected proof-revocation write failure');
    });
    cleanups.push(() => h.sessionStore.__testOnly_setBeforeRowPersist(undefined));
    const usageLimit = nativeUsageLimit(INCIDENT_QUOTA_SCREEN, 'native-episode-1', h.nowMs);
    const frame = { type: 'screen_update', content: INCIDENT_QUOTA_SCREEN, status: 'limited', turnId: 'turn-1', usageLimit };
    await Promise.all(h.worker.listeners('message').map(listener => listener(frame)));
    h.sessionStore.__testOnly_setBeforeRowPersist(undefined);
    await h.flush();

    expect(writes).toBe(2);
    expect(h.ds.usageLimit?.directFailure).toBeUndefined();
    expect(h.ds.session.lastFailedTurn?.directFailure).toBe(true);
    const stored = h.sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(stored?.usageLimit?.directFailure).toBeUndefined();
    expect(stored?.lastFailedTurn?.directFailure).toBe(true);

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(0);
  });

  it('uses the attested CLI PID rather than the worker PID for settlement proof', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const restart = await emitQuotaAndStart(h);
    h.ds.worker.pid = 999999;
    delete h.ds.session.cliSessionId;

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(1);
  });

  it.each(['no-attestation', 'missing', 'ambiguous', 'stored-conflict'] as const)('rejects settlement without a unique attested current identity (%s)', async mode => {
    const h = await setupRotationScenario({ directFailure: true });
    const restart = await emitQuotaAndStart(h);
    if (mode === 'no-attestation') delete h.ds.localProcessAttestation;
    if (mode === 'missing') h.ds.localProcessAttestation.cliPid = 999999;
    if (mode === 'ambiguous') {
      const otherPath = join(process.env.HOME!, '.gemini', 'antigravity-cli', 'brain',
        '61fc8ef7-1886-40af-9bac-c6ee8f8d172e', '.system_generated', 'logs', 'transcript_full.jsonl');
      mkdirSync(dirname(otherPath), { recursive: true });
      writeFileSync(otherPath, '');
      const otherFd = openSync(otherPath, 'r');
      cleanups.push(() => closeSync(otherFd));
    }
    if (mode === 'stored-conflict') h.ds.session.cliSessionId = '61fc8ef7-1886-40af-9bac-c6ee8f8d172e';

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(0);
  });

  it('re-reads no-progress proof at settlement when the transcript advances without another frame', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const restart = await emitQuotaAndStart(h);
    appendFileSync(h.transcriptPath, JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      tool_calls: [{ id: 'late-tool', name: 'create_the_file', args: {} }],
    }) + '\n');

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(msg => msg.type === 'message')).toHaveLength(0);
  });

  it('reports pool exhaustion and the observed reset duration instead of leaving a working card', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 1 });
    const retryOffsetMs = ((2 * 60 + 39) * 60 + 35) * 1000;
    const restart = await emitQuotaAndStart(h, 'turn-1', retryOffsetMs, false, INCIDENT_QUOTA_SCREEN);

    expect(restart).toBeUndefined();
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(0);
    expect(h.ds.lastScreenStatus).toBe('limited');
    expect(h.replies.flat().join('\n')).toContain('所有 Antigravity 账号均已达到限额');
    expect(h.replies.flat().join('\n')).toContain('2 小时 39 分钟');
  });

  it('does not replay a native quota snapshot when the frame has no proven turn', async () => {
    const h = await setupRotationScenario({ directFailure: false });
    const restart = await emitQuotaAndStart(h, null);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(msg => msg.type)).toEqual(['restart']);
    expect(h.ds.session.antigravityAccountId).toBe('acc2');
  });

  it('cancels even a proven-safe replay when Web Terminal submits new input mid-restart', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const restart = await emitQuotaAndStart(h);
    h.worker.emit('message', { type: 'terminal_input', submitted: true, at: h.nowMs + 1 });
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(msg => msg.type)).toEqual(['restart']);
    expect(h.ds.session.antigravityAccountId).toBe('acc2');
    expect(h.ds.lastMessageAt).toBe(1000);
  });

  it('surfaces account-settlement SQLite failure without replaying', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const sessionStore = await import('../src/services/session-store.js');
    const restart = await emitQuotaAndStart(h);
    // Supply the authoritative observation without persisting it first, then
    // make the settlement write itself fail inside the real pool callback.
    (h.ds as any).antigravityRotation.workerReportedAccountId = 'acc2';
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('injected settlement SQLite failure'); });
    cleanups.push(() => sessionStore.__testOnly_setBeforeRowPersist(undefined));
    h.worker.emit('message', { type: 'restart_result', attemptId: restart.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    sessionStore.__testOnly_setBeforeRowPersist(undefined);

    expect(h.sent.map(msg => msg.type)).toEqual(['restart']);
    expect((h.ds as any).antigravityRotation.inFlightToken).toBeUndefined();
  });

  it('marks accepted replay uncertain when a later session write fails', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const sessionStore = await import('../src/services/session-store.js');
    const restart = await emitQuotaAndStart(h);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart.attemptId });
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      // Account settlement and usage-limit cleanup must succeed. The first
      // post-replay write happens after markRetryAttempt incremented the count.
      if ((h.ds.session.lastFailedTurn?.retryCount ?? 0) > 0) {
        throw new Error('injected post-replay SQLite failure');
      }
    });
    cleanups.push(() => sessionStore.__testOnly_setBeforeRowPersist(undefined));
    h.worker.emit('message', { type: 'restart_result', attemptId: restart.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    sessionStore.__testOnly_setBeforeRowPersist(undefined);

    expect(h.sent.map(msg => msg.type)).toEqual(['restart', 'message']);
    const replay = h.sent.find(msg => msg.type === 'message');
    const rotation = (h.ds as any).antigravityRotation;
    expect(rotation.lastReplayTurnId).toBe((replay as any).turnId);
    expect(rotation.replayUncertain).toBe(true);
  });

  it('stops before replay when clearing the usage limit cannot be persisted', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const sessionStore = await import('../src/services/session-store.js');
    const restart = await emitQuotaAndStart(h);
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
    let writes = 0;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      writes++;
      if (writes > 1) throw new Error('injected usage-limit clear failure');
    });
    cleanups.push(() => sessionStore.__testOnly_setBeforeRowPersist(undefined));
    h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    sessionStore.__testOnly_setBeforeRowPersist(undefined);

    expect(h.sent.map(msg => msg.type)).toEqual(['restart']);
    expect(h.ds.lastScreenStatus).toBe('limited');
    expect((h.ds as any).antigravityRotation.lastReplayTurnId).toBeUndefined();
  });

  it('rejects a previous restart attempt account report instead of settling or replaying with it', async () => {
    const h = await setupRotationScenario({ directFailure: true });
    const { saveAntigravityAccount } = await import('../src/services/antigravity-accounts.js');
    const first = await emitQuotaAndStart(h);
    // R1 succeeds without its account report: fail closed and do not replay.
    h.worker.emit('message', { type: 'restart_result', attemptId: first!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    const third = join(process.env.HOME!, 'third.json');
    const nowMs = Date.now();
    writeFileSync(third, JSON.stringify({
      id_token_email: 'c@example.test',
      token: { access_token: 'access-c', refresh_token: 'refresh-c', expiry: new Date(nowMs + 3_600_000).toISOString() },
    }), { mode: 0o600 });
    saveAntigravityAccount('acc3', { sourceTokenPath: third });
    const second = await emitQuotaAndStart(h);
    // The late R1 report must not settle R2, even though it names a valid
    // account and arrives while R2 is in flight.
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: first!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: second!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(msg => msg.type)).toEqual(['restart', 'restart']);
    expect(h.ds.session.antigravityAccountId).toBe('acc1');
  });

  it('stops at eight direct-terminal rotations even with a stale IM turn ID', async () => {
    const h = await setupRotationScenario({ directFailure: false, accountCount: 10 });
    h.ds.session.lastCliInputTurnId = 'stale-im-turn';
    (h.ds as any).lastCliInputTurnId = 'stale-im-turn';

    for (let target = 2; target <= 9; target++) {
      const restart = await emitQuotaAndStart(h, null);
      h.worker.emit('message', { type: 'antigravity_account', accountId: `acc${target}`, attemptId: restart!.attemptId });
      h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
      await h.flush();
      expect(h.ds.session.antigravityAccountId).toBe(`acc${target}`);
    }
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(8);

    const blocked = await emitQuotaAndStart(h, null, 60_000, false);
    expect(blocked).toBeUndefined();
    expect(h.sent.filter(msg => msg.type === 'restart')).toHaveLength(8);
    expect((h.ds as any).antigravityRotation.rotationsUsed).toBe(8);
  });
});
