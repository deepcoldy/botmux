import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { AntigravityNativeQuotaLog, currentAntigravityNativeQuota } from '../src/services/antigravity-native-quota.js';
import { createAntigravityQuotaStateMachine } from '../src/services/antigravity-quota-state.js';
import { recordLimitedFailedTurn, clearLimitedFailedTurn } from '../src/core/failed-turn-recovery.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { reconcileUsageLimitState, isSameUsageLimitEpisode } from '../src/utils/cli-usage-limit.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

let scenarioSeq = 0;
async function setupRotationScenario(input: { directFailure: boolean; accountCount?: number }) {
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
  const replies: unknown[][] = [];
  initWorkerPool({
    sessionReply: async (...args: unknown[]) => { replies.push(args); return 'om_reply'; },
    getSessionWorkingDir: () => root,
    getActiveCount: () => 1,
    closeSession: () => {},
  } as never);
  const session = sessionStore.createSession('oc_probe', 'om_root', 'rotation probe', 'group', 'chat');
  session.ownerOpenId = 'ou_owner';
  session.lastCliInput = 'do work';
  session.lastUserPrompt = 'do work';
  session.lastCliInputTurnId = 'turn-1';
  session.antigravityAccountId = 'acc1';
  session.lastFailedTurn = {
    turnId: 'turn-1',
    cliInput: 'do work',
    userPrompt: 'do work',
    failedAt: new Date().toISOString(),
    status: 'failed',
    retryCount: 0,
    ...(input.directFailure ? { directFailure: true as const } : { limitedSnapshot: true }),
  };
  sessionStore.updateSession(session);
  const worker = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 4242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const sent: Array<{ type: string; content?: string; attemptId?: string }> = [];
  Object.assign(worker, {
    send: (msg: { type: string }) => { sent.push(msg); return true; },
    kill: () => { worker.killed = true; return true; },
  });
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const presenceDir = join(home, '.gemini', 'antigravity-cli', 'presence');
  const logsDir = join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(presenceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const presenceLockPath = join(presenceDir, `${conversationId}.lock`);
  writeFileSync(presenceLockPath, '');
  let presenceFd: number | undefined;
  const fullTranscriptPath = join(logsDir, 'transcript_full.jsonl');
  const compactTranscriptPath = join(logsDir, 'transcript.jsonl');
  if (input.directFailure) {
    presenceFd = openSync(presenceLockPath, 'r');
    const cleanInputLine = JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\ndo work\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
    }) + '\n';
    writeFileSync(fullTranscriptPath, cleanInputLine);
    writeFileSync(compactTranscriptPath, cleanInputLine);
  }
  const procStart = readProcessStartIdentity(process.pid);
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
    ...(input.directFailure && procStart ? {
      localProcessAttestation: {
        cliPid: process.pid,
        cliProcStart: procStart,
        cliSpawnGeneration: 1,
      },
    } : {}),
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
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  cleanups.push(() => {
    if (presenceFd !== undefined) {
      try { closeSync(presenceFd); } catch { /* ignore */ }
    }
    setActiveSessionsRegistry(new Map());
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ds, worker, sent, replies, flush, nowMs, home, root,
    directFailure: input.directFailure,
    conversationId, fullTranscriptPath, compactTranscriptPath, presenceLockPath,
  };
}

async function emitQuotaAndStart(
  h: Awaited<ReturnType<typeof setupRotationScenario>>,
  turnId: string | null = 'turn-1',
  retryOffsetMs = 60_000,
  requireRestart = true,
) {
  const previousRestartCount = h.sent.filter(msg => msg.type === 'restart').length;
  const frameTurnId = turnId ?? undefined;
  h.worker.emit('message', { type: 'screen_update', content: 'working\nesc to cancel', status: 'working', ...(frameTurnId ? { turnId: frameTurnId } : {}) });
  await h.flush();
  h.worker.emit('message', {
    type: 'screen_update', content: 'quota exceeded', status: 'limited', ...(frameTurnId ? { turnId: frameTurnId } : {}),
    usageLimit: {
      limited: true, kind: 'usage', retryAtMs: h.nowMs + retryOffsetMs,
      retryLabel: '1m', retryReady: false, source: 'antigravity-error-composer',
      ...(h.directFailure ? { directFailure: true as const } : {}),
    },
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
  it('does not replay an agy turn without a durable no-progress proof', async () => {
    const h = await setupRotationScenario({ directFailure: false });
    const restart = await emitQuotaAndStart(h);
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
    // Atomic settlement persists account + consumed keys + usage-limit clear in
    // one SQLite write; injecting a failure rolls all three back and stops before replay.
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      throw new Error('injected usage-limit clear failure');
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

  it('settles pre-ready replacement episode B atomically with A so re-delivering B does not rotate a second time, while distinct episode C rotates', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 3 });
    const sessionStore = await import('../src/services/session-store.js');

    // Step 1: Episode A starts rotation (acc1 -> acc2).
    const limitA = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:native-episode-a', directFailure: true as const,
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota A', status: 'limited', turnId: 'turn-1', usageLimit: limitA });
    await h.flush();
    const restart1 = h.sent.find(m => m.type === 'restart');
    expect(restart1?.attemptId).toBeTruthy();

    // Step 2: Before restart settles (even when worker is pre-ready), replacement B arrives on same turn!
    h.ds.workerReady = false;
    const limitB = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:native-episode-b', directFailure: true as const,
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota B', status: 'limited', turnId: 'turn-1', usageLimit: limitB });
    await h.flush();
    expect((h.ds as any).usageLimit?.nativeEpisodeKey).toBe('log:native-episode-b');

    // Negative controls during pre-ready: unrelated turn, generic limit, ordinary working do NOT overwrite B!
    h.worker.emit('message', { type: 'screen_update', content: 'working', status: 'working', turnId: 'turn-1' });
    h.worker.emit('message', {
      type: 'screen_update', content: 'other turn', status: 'limited', turnId: 'turn-other',
      usageLimit: { ...limitB, nativeEpisodeKey: 'log:other-turn' },
    });
    h.worker.emit('message', {
      type: 'screen_update', content: 'generic', status: 'limited', turnId: 'turn-1',
      usageLimit: { limited: true, kind: 'usage', retryAtMs: h.nowMs + 60_000, retryLabel: '1m', retryReady: false },
    });
    await h.flush();
    expect((h.ds as any).usageLimit?.nativeEpisodeKey).toBe('log:native-episode-b');

    // Step 3: Restart settles -> rejects replay of A (A !== B -> regression case), clears usageLimit AND consumes BOTH A and B!
    h.ds.workerReady = true;
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart1!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: restart1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect(h.sent.map(m => m.type)).toEqual(['restart']);
    expect((h.ds as any).usageLimit).toBeUndefined();
    const stored = sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(stored?.usageLimit).toBeUndefined();
    expect(stored?.consumedAntigravityQuotaKeys).toEqual(
      expect.arrayContaining(['log:native-episode-a', 'log:native-episode-b']),
    );

    // Step 4: Re-delivering exact same B evidence stays idle (NO 2nd rotation!).
    h.worker.emit('message', { type: 'screen_update', content: 'quota B', status: 'limited', turnId: 'turn-1', usageLimit: limitB });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(1);
    expect((h.ds as any).lastScreenStatus).toBe('idle');

    // Step 5: Genuinely new episode C on acc2 rotates acc2 -> acc3!
    const limitC = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:native-episode-c',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota C', status: 'limited', turnId: 'turn-2', usageLimit: limitC });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(2);
  });

  it('filters consumed episodes at ingress bidirectionally across linked log<->composer keys, both frame types, and suppressRecoveryCard=true/false without touching unrelated episodes', async () => {
    for (const suppressRecoveryCard of [false, true]) {
      for (const frameType of ['screen_update', 'screenshot_uploaded'] as const) {
        const h = await setupRotationScenario({ directFailure: false, accountCount: 3 });
        const sessionStore = await import('../src/services/session-store.js');
        const dashboardEvents: any[] = [];
        const unsub = dashboardEventBus.subscribe(ev => dashboardEvents.push(ev));
        cleanups.push(unsub);

        // Consume linked pair (log:A + composer:E) via real rotation.
        const linkedA = {
          limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
          retryLabel: '1h', retryReady: false, source: 'antigravity-error-composer' as const,
          nativeEpisodeKey: 'log:A-linked', linkedNativeEpisodeKey: 'composer:E-linked',
        };
        h.worker.emit('message', { type: 'screen_update', content: 'quota linked', status: 'limited', turnId: 'turn-1', usageLimit: linkedA });
        await h.flush();
        const r1 = h.sent.find(m => m.type === 'restart');
        h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: r1!.attemptId });
        h.worker.emit('message', { type: 'restart_result', attemptId: r1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
        await h.flush();
        expect(sessionStore.getSessionFresh(h.ds.session.sessionId)?.consumedAntigravityQuotaKeys).toEqual(
          expect.arrayContaining(['log:A-linked', 'composer:E-linked']),
        );

        // Re-deliver ONLY composer:E-linked (or ONLY log:A-linked) while suppressRecoveryCard is set.
        (h.ds as any).suppressRecoveryCard = suppressRecoveryCard;
        (h.ds as any).lastScreenStatus = 'limited';
        (h.ds as any).usageLimit = linkedA;
        h.ds.session.usageLimit = linkedA;
        sessionStore.updateSession(h.ds.session);

        const composerOnly = {
          limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
          retryLabel: '1h', retryReady: false, source: 'antigravity-error-composer' as const,
          nativeEpisodeKey: 'composer:E-linked',
        };
        dashboardEvents.length = 0;
        h.worker.emit('message', frameType === 'screen_update'
          ? { type: 'screen_update', content: 'stale composer', status: 'limited', turnId: 'turn-1', usageLimit: composerOnly }
          : { type: 'screenshot_uploaded', imageKey: 'img_consumed', status: 'limited', turnId: 'turn-1', usageLimit: composerOnly });
        await h.flush();

        expect((h.ds as any).usageLimit).toBeUndefined();
        expect((h.ds as any).lastScreenStatus).toBe('idle');
        expect(sessionStore.getSessionFresh(h.ds.session.sessionId)?.usageLimit).toBeUndefined();
        expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(1);
        expect(dashboardEvents.some(e => e.type === 'session.update' && e.body?.patch?.status === 'idle')).toBe(true);
      }
    }
  });

  it('aborts frame commit on consumed sticky SQLite clear failure and merges afterRecovered onto compatible pending recovery retry across backoff', async () => {
    vi.useFakeTimers();
    try {
      const h = await setupRotationScenario({ directFailure: false, accountCount: 2 });
      const sessionStore = await import('../src/services/session-store.js');
      const { initWorkerPool, __testOnly_setupWorkerHandlers } = await import('../src/core/worker-pool.js');
      const statuses: string[] = [];
      initWorkerPool({
        sessionReply: async () => 'om_reply',
        getSessionWorkingDir: () => h.root,
        getActiveCount: () => 1,
        closeSession: () => {},
        onScreenStatus: (_ds, ctx) => { statuses.push(ctx.status); },
      } as never);
      h.worker.removeAllListeners('message');
      __testOnly_setupWorkerHandlers(h.ds as never, h.worker as never);

      const ep = {
        limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
        retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
        nativeEpisodeKey: 'log:consumed-retry-ep',
      };
      (h.ds as any).usageLimit = ep;
      (h.ds as any).lastScreenStatus = 'limited';
      h.ds.session.usageLimit = ep;
      h.ds.session.consumedAntigravityQuotaKeys = ['log:consumed-retry-ep'];
      h.ds.session.lastFailedTurn = {
        turnId: 'turn-1', cliInput: 'do work', userPrompt: 'do work',
        failedAt: new Date().toISOString(), status: 'failed', retryCount: 0, limitedSnapshot: true,
      };
      sessionStore.updateSession(h.ds.session);

      // Step 1: ready-composer clear fails -> schedules hookless retry.
      sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('sqlite fail 1'); });
      h.worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle', usageLimitRecovery: 'antigravity-ready-composer' });
      await vi.advanceTimersByTimeAsync(10);
      expect((h.ds as any).lastScreenStatus).toBe('limited');

      // Step 2: consumed screenshot clear also fails -> aborts (currentImageKey untouched!) and merges afterRecovered hook!
      h.worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_must_not_commit', status: 'limited', usageLimit: ep });
      await vi.advanceTimersByTimeAsync(10);
      expect((h.ds as any).currentImageKey).toBeUndefined();
      expect((h.ds as any).lastScreenStatus).toBe('limited');

      // Step 3: first 500ms backoff also fails (hookless follow-up in between must NOT erase merged hook!), then 1000ms succeeds!
      await vi.advanceTimersByTimeAsync(500);
      expect((h.ds as any).lastScreenStatus).toBe('limited');
      h.worker.emit('message', { type: 'screen_update', content: 'ready again', status: 'idle', usageLimitRecovery: 'antigravity-ready-composer' });

      sessionStore.__testOnly_setBeforeRowPersist(undefined);
      await vi.advanceTimersByTimeAsync(1_100);

      expect((h.ds as any).usageLimit).toBeUndefined();
      expect((h.ds as any).lastScreenStatus).toBe('idle');
      expect(h.ds.session.lastFailedTurn).toBeUndefined();
      expect(sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn).toBeUndefined();
      expect(statuses).toContain('idle');
    } finally {
      const sessionStore = await import('../src/services/session-store.js');
      sessionStore.__testOnly_setBeforeRowPersist(undefined);
      vi.useRealTimers();
    }
  });

  it('re-verifies live attested transcript at settlement: rejects appended progress, compact-only tool, birth mismatch, missing birth, and stored/live conflict', async () => {
    for (const fault of ['late-answer', 'compact-tool', 'birth-mismatch', 'birth-missing', 'stored-conflict'] as const) {
      const h = await setupRotationScenario({ directFailure: true, accountCount: 2 });
      const restart = await emitQuotaAndStart(h);

      if (fault === 'late-answer') {
        const answer = JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'done' }) + '\n';
        appendFileSync(h.fullTranscriptPath, answer);
        appendFileSync(h.compactTranscriptPath, answer);
      } else if (fault === 'compact-tool') {
        const tool = JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'run_command' }] }) + '\n';
        appendFileSync(h.compactTranscriptPath, tool);
      } else if (fault === 'birth-mismatch') {
        (h.ds as any).localProcessAttestation = { cliPid: process.pid, cliProcStart: 'birth-of-exited-cli', cliSpawnGeneration: 1 };
      } else if (fault === 'birth-missing') {
        (h.ds as any).localProcessAttestation = { cliPid: process.pid, cliSpawnGeneration: 1 };
      } else if (fault === 'stored-conflict') {
        h.ds.session.cliSessionId = '99999999-9999-4999-8999-999999999999';
      }

      h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: restart!.attemptId });
      h.worker.emit('message', { type: 'restart_result', attemptId: restart!.attemptId, status: 'succeeded', category: 'prompt_ready' });
      await h.flush();

      expect(h.sent.map(m => m.type), `fault=${fault} must fail closed with zero replay`).toEqual(['restart']);
    }
  });

  it('triggers rotation on generic->native confirmation without duplicating @owner ping, and records screenshot-only turn-2 lastFailedTurn before rotation', async () => {
    const h = await setupRotationScenario({ directFailure: false, accountCount: 2 });
    const sessionStore = await import('../src/services/session-store.js');
    const { initWorkerPool, __testOnly_setupWorkerHandlers } = await import('../src/core/worker-pool.js');
    const replies: string[] = [];
    initWorkerPool({
      sessionReply: async (_root: string, text: string) => { replies.push(text); return 'om_reply'; },
      getSessionWorkingDir: () => h.root,
      getActiveCount: () => 1,
      closeSession: () => {},
      onScreenStatus: (ds, ctx) => {
        if (ctx.status === 'limited') recordLimitedFailedTurn(ds, ctx.turnId);
        else if (ctx.prevStatus === 'limited') clearLimitedFailedTurn(ds);
      },
    } as never);
    h.worker.removeAllListeners('message');
    __testOnly_setupWorkerHandlers(h.ds as never, h.worker as never);

    // Frame 1: generic limited (no native source -> no rotation, sends 1 @owner notice).
    const generic = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, relativeResetKey: 'usage:3600000:err-confirm',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: generic });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(0);
    expect(replies).toHaveLength(1);

    // Frame 2: confirmed native arrives on identical banner -> triggers rotation!
    const confirmed = {
      ...generic,
      source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:native-confirm-1',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: confirmed });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(1);

    // Repeat frame 3: deduped -> no second rotation!
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: confirmed });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(1);

    // screenshot-only new turn-2 records lastFailedTurn before rotation!
    const r1 = h.sent.find(m => m.type === 'restart');
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: r1!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: r1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    h.ds.session.larkAppId = h.ds.larkAppId;
    h.ds.session.replyTargets = {
      'turn-2': {
        rootMessageId: 'om_root',
        senderOpenId: 'ou_owner',
        participants: [{ openId: 'ou_owner', isBot: false }],
        updatedAt: new Date().toISOString(),
      },
    };
    h.ds.lastCliInputTurnId = 'turn-2';
    h.ds.lastCliInput = 'turn 2 work';
    h.ds.lastUserPrompt = 'turn 2 work';
    const turn2Limit = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 7_200_000,
      retryLabel: '2h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:turn-2-ep',
    };
    h.worker.emit('message', {
      type: 'screenshot_uploaded', imageKey: 'img_t2', status: 'limited',
      turnId: 'turn-2', usageLimit: turn2Limit,
    });
    await h.flush();
    expect(h.ds.session.lastFailedTurn?.turnId).toBe('turn-2');
    expect(sessionStore.getSessionFresh(h.ds.session.sessionId)?.lastFailedTurn?.turnId).toBe('turn-2');
  });

  it('end-to-end real native log reader + SSOT state machine + worker-pool does NOT rotate after same input internally retries and answers', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 2 });
    const reader = new AntigravityNativeQuotaLog('sess-answered-native-retry', join(h.home, '.gemini', 'antigravity-cli'));
    mkdirSync(dirname(reader.path), { recursive: true });
    writeFileSync(reader.path, [
      'I1125 00:00:01.000000 100 input_loop.go:104] HandleUserInput called with text: "do work"',
      'E1125 00:00:02.000000 200 errorreport.go:282] agent executor error: generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.',
    ].join('\n') + '\n');

    const sm = createAntigravityQuotaStateMachine();
    sm.beginTurn('');
    const logQuota = currentAntigravityNativeQuota(reader.read(), 'do work');
    expect(logQuota?.nativeEpisodeKey).toBe('log:E1125 00:00:02.000000');

    // Same input internally retries & answers -> noteTurnAnswered retires log refusal!
    sm.noteTurnAnswered(logQuota!.nativeEpisodeKey);
    const readyScreen = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\nError ID: e1\nFinal answer text.\n────\n>\n────\n? for shortcuts';
    const verdict = sm.classify({
      screen: readyScreen,
      nativeViewportCaptured: true,
      runtimeStatus: 'idle',
      supportsReadyFooterQuota: true,
      nativeLogQuota: currentAntigravityNativeQuota(reader.read(), 'do work'),
    });
    expect(verdict.status).toBe('idle');
    expect(verdict.usageLimit).toBeUndefined();

    h.worker.emit('message', {
      type: 'screen_update',
      content: readyScreen,
      status: verdict.status,
      usageLimit: verdict.usageLimit,
      usageLimitRecovery: verdict.usageLimitRecovery,
      turnId: 'turn-1',
    });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(0);
  });

  it('end-to-end emits replay_started notice when late directFailure proof arrives before settlement, and uses settlement sourceTurnId on replay failure', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 2 });
    const { initWorkerPool, __testOnly_setupWorkerHandlers } = await import('../src/core/worker-pool.js');
    const replies: string[] = [];
    initWorkerPool({
      sessionReply: async (_root: string, text: string) => { replies.push(text); return 'om_reply'; },
      getSessionWorkingDir: () => h.root,
      getActiveCount: () => 1,
      closeSession: () => {},
      onScreenStatus: (ds, ctx) => {
        if (ctx.status === 'limited') recordLimitedFailedTurn(ds, ctx.turnId);
        else if (ctx.prevStatus === 'limited') clearLimitedFailedTurn(ds);
      },
    } as never);
    h.worker.removeAllListeners('message');
    __testOnly_setupWorkerHandlers(h.ds as never, h.worker as never);

    // Frame 1 arrives WITHOUT directFailure proof -> notifySwitching(willAutoReplay=false).
    h.ds.session.lastFailedTurn = {
      turnId: 'turn-1', cliInput: 'do work', userPrompt: 'do work',
      failedAt: new Date().toISOString(), status: 'failed', retryCount: 0, limitedSnapshot: true,
    };
    const epNoProof = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:late-proof-ep',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: epNoProof });
    await h.flush();
    const r1 = h.sent.find(m => m.type === 'restart');
    expect(r1?.attemptId).toBeTruthy();
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain('重试本轮消息');

    // Frame 2 brings late directFailure proof BEFORE restart settles!
    h.worker.emit('message', {
      type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1',
      usageLimit: { ...epNoProof, directFailure: true },
    });
    await h.flush();
    expect(h.ds.session.lastFailedTurn?.directFailure).toBe(true);

    // Settlement succeeds -> emits follow-up replay_started notice AND replays!
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: r1!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: r1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.map(m => m.type)).toEqual(['restart', 'message']);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain('自动重试本轮消息');
  });

  it('reports pool exhaustion with observed remaining duration when all accounts are in cooldown', async () => {
    const h = await setupRotationScenario({ directFailure: false, accountCount: 1 });
    const ep = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + ((2 * 60 + 39) * 60 + 35) * 1000,
      retryLabel: '2h39m35s', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:pool-exhausted-1',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: ep });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(0);
    expect((h.ds as any).lastScreenStatus).toBe('limited');
    expect(h.replies.some(args => String(args[1]).includes('2 小时') && String(args[1]).includes('均已达到限额'))).toBe(true);
  });

  it('clears and consumes pre-settlement replacement episode B atomically even when user intervenes mid-restart (/stop or Web Terminal)', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 3 });
    const sessionStore = await import('../src/services/session-store.js');
    // Live worker emits ready first so startupState.ready === true (production in-worker restart path).
    h.worker.emit('message', { type: 'ready', port: 9999, token: 'tok' });
    await h.flush();

    const limitA = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:live-ep-A', directFailure: true as const,
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota A', status: 'limited', turnId: 'turn-1', usageLimit: limitA });
    await h.flush();
    const r1 = h.sent.find(m => m.type === 'restart');
    expect(r1?.attemptId).toBeTruthy();
    expect(h.ds.workerReady).toBe(false);

    // Pre-settlement replacement B arrives via screenshot_uploaded while in-worker restart is in flight.
    const limitB = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:live-ep-B',
    };
    h.worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_b', status: 'limited', turnId: 'turn-1', usageLimit: limitB });
    // Negative control during live in-worker restart: dying ready-composer must NOT clear usageLimit!
    h.worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle', usageLimitRecovery: 'antigravity-ready-composer' });
    await h.flush();
    expect((h.ds as any).usageLimit?.nativeEpisodeKey).toBe('log:live-ep-B');
    expect((h.ds as any).currentImageKey).toBeUndefined();

    // User intervenes mid-restart via Web Terminal submission (intervened === true).
    h.worker.emit('message', { type: 'terminal_input', submitted: true, at: h.nowMs + 5 });
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: r1!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: r1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    expect((h.ds as any).usageLimit).toBeUndefined();
    const stored = sessionStore.getSessionFresh(h.ds.session.sessionId);
    expect(stored?.usageLimit).toBeUndefined();
    expect(stored?.consumedAntigravityQuotaKeys).toEqual(
      expect.arrayContaining(['log:live-ep-A', 'log:live-ep-B']),
    );
    // Re-delivering B stays idle and never triggers a 2nd rotation.
    h.worker.emit('message', { type: 'screen_update', content: 'quota B', status: 'limited', turnId: 'turn-1', usageLimit: limitB });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'restart')).toHaveLength(1);
    expect((h.ds as any).lastScreenStatus).toBe('idle');
  });

  it('preserves caller attribution across multi-hop auto-replay (acc1 -> acc2 -> acc3)', async () => {
    const h = await setupRotationScenario({ directFailure: true, accountCount: 3 });
    const { initWorkerPool, __testOnly_setupWorkerHandlers } = await import('../src/core/worker-pool.js');
    initWorkerPool({
      sessionReply: async () => 'om_reply',
      getSessionWorkingDir: () => h.root,
      getActiveCount: () => 1,
      closeSession: () => {},
      onScreenStatus: (ds, ctx) => {
        if (ctx.status === 'limited') recordLimitedFailedTurn(ds, ctx.turnId);
        else if (ctx.prevStatus === 'limited') clearLimitedFailedTurn(ds);
      },
    } as never);
    h.worker.removeAllListeners('message');
    __testOnly_setupWorkerHandlers(h.ds as never, h.worker as never);

    h.ds.session.larkAppId = h.ds.larkAppId;
    beginReplyTargetTurn(h.ds as never, 'om_root', 'turn-1', new Date().toISOString(), {
      senderOpenId: 'ou_owner',
      participants: [{ openId: 'ou_owner', isBot: false }],
    });
    h.ds.session.lastFailedTurn = {
      turnId: 'turn-1', originalTurnId: 'turn-1', cliInput: 'do work', userPrompt: 'do work',
      failedAt: new Date().toISOString(), status: 'failed', retryCount: 0,
      limitedSnapshot: true, directFailure: true,
      trustedCaller: { requestUserOpenId: 'ou_owner', requestLarkAppId: h.ds.larkAppId, senderType: 'user' },
    };

    // Hop 1: acc1 -> acc2 auto-replay mints agy-rotate-* with preserved caller attribution.
    const ep1 = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:hop-1', directFailure: true as const,
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota 1', status: 'limited', turnId: 'turn-1', usageLimit: ep1 });
    await h.flush();
    const r1 = h.sent.find(m => m.type === 'restart');
    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc2', attemptId: r1!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: r1!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();

    const replay1 = h.sent.find(m => m.type === 'message') as any;
    expect(replay1?.turnId).toMatch(/^agy-rotate-/);
    expect(h.ds.session.failedTurnRecovery?.originalTurnId).toBe('turn-1');
    expect(h.ds.session.failedTurnRecovery?.turnId).toBe(replay1.turnId);

    // Hop 2: acc2 immediately hits a new quota refusal on replay1.turnId -> records lastFailedTurn and replays onto acc3!
    (h.ds as any).streamCardPending = false;
    const ep2 = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:hop-2', directFailure: true as const,
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota 2', status: 'limited', turnId: replay1.turnId, usageLimit: ep2 });
    await h.flush();
    expect(h.ds.session.lastFailedTurn?.turnId).toBe(replay1.turnId);
    expect(h.ds.session.lastFailedTurn?.originalTurnId).toBe('turn-1');
    const r2 = h.sent.filter(m => m.type === 'restart')[1];
    expect(r2?.attemptId).toBeTruthy();

    h.worker.emit('message', { type: 'antigravity_account', accountId: 'acc3', attemptId: r2!.attemptId });
    h.worker.emit('message', { type: 'restart_result', attemptId: r2!.attemptId, status: 'succeeded', category: 'prompt_ready' });
    await h.flush();
    expect(h.sent.filter(m => m.type === 'message')).toHaveLength(2);
    expect(h.ds.session.antigravityAccountId).toBe('acc3');
  });

  it('emits exhausted-pool notice on generic->native confirmation without duplicating @owner ping, and keeps unrelated cursor isolated from consumed frames', async () => {
    const h = await setupRotationScenario({ directFailure: false, accountCount: 1 });
    const sessionStore = await import('../src/services/session-store.js');

    const generic = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 3_600_000,
      retryLabel: '1h', retryReady: false, relativeResetKey: 'usage:3600000:err-exh',
    };
    h.worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1', usageLimit: generic });
    await h.flush();
    expect(h.replies).toHaveLength(1);

    const confirmed = {
      ...generic,
      source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:exh-confirm',
    };
    const activeCursor = { lastConfirmed: confirmed, recoveredEpisodeKey: null };
    h.worker.emit('message', {
      type: 'screen_update', content: 'quota', status: 'limited', turnId: 'turn-1',
      usageLimit: confirmed, antigravityQuotaCursor: activeCursor,
    });
    await h.flush();
    // 2nd reply is the exhausted-pool notice, NOT a duplicate @owner ping.
    expect(h.replies).toHaveLength(2);
    expect(String(h.replies[1]![1])).toContain('均已达到限额');

    // Consumed episode C re-appearing against unrelated active unconsumed episode U must NOT poison U's cursor.
    h.ds.session.consumedAntigravityQuotaKeys = ['log:old-consumed-C'];
    sessionStore.updateSession(h.ds.session);
    const consumedC = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 60_000,
      retryLabel: '1m', retryReady: false, source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:old-consumed-C',
    };
    h.worker.emit('message', {
      type: 'screen_update', content: 'old C', status: 'limited', turnId: 'turn-1',
      usageLimit: consumedC,
      antigravityQuotaCursor: { lastConfirmed: consumedC, recoveredEpisodeKey: null },
    });
    await h.flush();
    expect((h.ds as any).usageLimit?.nativeEpisodeKey).toBe('log:exh-confirm');
    expect((h.ds as any).antigravityQuotaCursor?.lastConfirmed?.nativeEpisodeKey).toBe('log:exh-confirm');

    // Merging bare composer:E over linked (log:A + composer:E) preserves log:A canonically.
    const linked = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 60_000,
      retryLabel: '1m', retryReady: false, source: 'antigravity-error-composer' as const,
      nativeEpisodeKey: 'log:A-keep', linkedNativeEpisodeKey: 'composer:E-keep',
    };
    const bare = {
      limited: true as const, kind: 'usage' as const, retryAtMs: h.nowMs + 90_000,
      retryLabel: '1m', retryReady: false, source: 'antigravity-error-composer' as const,
      nativeEpisodeKey: 'composer:E-keep',
    };
    const merged = reconcileUsageLimitState(linked, bare, { nowMs: h.nowMs });
    expect(merged.nativeEpisodeKey).toBe('log:A-keep');
    expect(merged.linkedNativeEpisodeKey).toBe('composer:E-keep');
    expect(isSameUsageLimitEpisode(merged, { ...linked, linkedNativeEpisodeKey: undefined })).toBe(true);
  });
});
