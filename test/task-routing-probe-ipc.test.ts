import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetBotRegistry, getBot, registerBot, type BotConfig } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  routeHasNarrowUntrustedAuth,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { collectBotRuntimeSnapshots } from '../src/core/task-routing/probe.js';
import {
  TaskRoutingError,
  getTaskRoutingStatus,
  listTaskRoutingHistory,
  recommendBotForTask,
  runTaskRouting,
} from '../src/core/task-routing/service.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { setBotCapability, setBotSpecialties } from '../src/services/bot-profile-store.js';
import { OBSERVE_SCHEMA_VERSION, type ObserveSnapshot } from '../src/services/session-observe.js';
import { TaskRoutingStore } from '../src/services/task-routing-store.js';

const NOW = 1_800_000_000_000;

function makeBotConfig(overrides: Partial<BotConfig> & { larkAppId: string; cliId: BotConfig['cliId'] }): BotConfig {
  return {
    larkAppSecret: 'test-secret',
    ...overrides,
  } as BotConfig;
}

describe('task-routing probe, service orchestration, and IPC aperture', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-tr-probe-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens only POST /api/sessions/:id/task-routing on the narrow untrusted auth aperture', () => {
    expect(routeHasNarrowUntrustedAuth('POST', '/api/sessions/s123/task-routing')).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', '/api/sessions/s123/task-routing')).toBe(false);
    expect(routeHasNarrowUntrustedAuth('PUT', '/api/bot-task-routing')).toBe(false);
  });

  it('collectBotRuntimeSnapshots merges observe sessions, daemon extras, agy-accounts, budget, and legacy bot-profiles', async () => {
    const dataDir = makeTempDir();
    setBotCapability(dataDir, 'cli_cheap', '轻量小修和文档整理');
    setBotSpecialties(dataDir, 'cli_cheap', ['docs', 'tests']);
    writeFileSync(
      join(dataDir, 'bots-info.json'),
      JSON.stringify([
        { larkAppId: 'cli_cheap', botName: 'CheapBot', botOpenId: 'ou_b1', cliId: 'claude-code' },
        { larkAppId: 'cli_agy', botName: 'AgyBot', botOpenId: 'ou_b2', cliId: 'antigravity' },
      ]),
    );

    const configs: BotConfig[] = [
      makeBotConfig({
        larkAppId: 'cli_cheap',
        cliId: 'claude-code',
        model: 'kimi',
        maxLiveWorkers: 4,
        taskRouting: { enabled: true, costTier: 'low' },
      }),
      makeBotConfig({
        larkAppId: 'cli_agy',
        cliId: 'antigravity',
        taskRouting: { enabled: true, costTier: 'medium', strengths: '复杂重构' },
      }),
    ];

    const observeSnapshot: ObserveSnapshot = {
      schemaVersion: OBSERVE_SCHEMA_VERSION,
      observedAt: NOW,
      daemons: [
        {
          larkAppId: 'cli_cheap',
          probe: { status: 'ok', source: 'daemon-ipc', larkAppId: 'cli_cheap' },
          sessions: [
            {
              schemaVersion: OBSERVE_SCHEMA_VERSION,
              observedAt: NOW,
              probe: { status: 'ok', source: 'daemon-ipc', larkAppId: 'cli_cheap' },
              identity: { sessionId: 's1', larkAppId: 'cli_cheap' },
              cli: { id: 'claude-code' },
              backend: { adopted: false },
              liveness: 'alive',
              turn: 'working',
              phase: 'unknown',
              queued: false,
              parkedOrSuspended: false,
              closed: false,
            },
            {
              schemaVersion: OBSERVE_SCHEMA_VERSION,
              observedAt: NOW,
              probe: { status: 'ok', source: 'daemon-ipc', larkAppId: 'cli_cheap' },
              identity: { sessionId: 's2', larkAppId: 'cli_cheap' },
              cli: { id: 'claude-code' },
              backend: { adopted: false },
              liveness: 'not_running',
              turn: 'idle',
              phase: 'unknown',
              queued: true,
              parkedOrSuspended: true,
              closed: false,
            },
          ],
        },
        {
          larkAppId: 'cli_agy',
          probe: { status: 'ok', source: 'daemon-ipc', larkAppId: 'cli_agy' },
          sessions: [],
        },
      ],
    };

    const snaps = await collectBotRuntimeSnapshots({
      dataDir,
      now: () => NOW,
      loadConfigs: () => configs,
      discoverDaemons: () => [
        { larkAppId: 'cli_cheap', ipcPort: 10001, larkConnection: { state: 'connected', since: NOW - 10_000, attempts: 0 } },
        { larkAppId: 'cli_agy', ipcPort: 10002, larkConnection: { state: 'connected', since: NOW - 10_000, attempts: 0 } },
      ],
      fetchObserve: async () => observeSnapshot,
      fetchDaemonExtra: async d => d.larkAppId === 'cli_cheap'
        ? { maxLiveWorkers: 4, residentSessionCount: 1, pendingTurnCount: 2, botName: 'CheapBot', activeUsageLimit: null }
        : { maxLiveWorkers: null, residentSessionCount: 0, pendingTurnCount: 0, botName: 'AgyBot', activeUsageLimit: null },
      inspectAgyAccounts: () => ({
        managed: true,
        autoRotate: true,
        activeId: 'acc1',
        liveTokenPresent: true,
        liveTokenMatchesActive: true,
        keyringRisk: { status: 'file-storage-active' },
        accounts: [],
        availableCount: 2,
        enabledCount: 3,
      }),
    });

    expect(snaps).toHaveLength(2);
    const cheap = snaps.find(s => s.larkAppId === 'cli_cheap')!;
    expect(cheap.runtime.workingCount).toBe(1);
    // 1 parked session + 2 pending turns = 3
    expect(cheap.runtime.queuedCount).toBe(3);
    expect(cheap.profile.legacyCapability).toBe('轻量小修和文档整理');
    expect(cheap.profile.legacySpecialties).toEqual(['docs', 'tests']);

    const agy = snaps.find(s => s.larkAppId === 'cli_agy')!;
    expect(agy.runtime.agyAccounts).toEqual({ managed: true, availableCount: 2, enabledCount: 3 });
  });

  it('orchestrates status -> recommend -> run -> history end-to-end and enforces global disabled gate', async () => {
    const dataDir = makeTempDir();
    const configs: BotConfig[] = [
      makeBotConfig({
        larkAppId: 'cli_low',
        cliId: 'claude-code',
        displayName: 'EconomyBot',
        taskRouting: { enabled: true, costTier: 'low', strengths: '小修、文案' },
      }),
      makeBotConfig({
        larkAppId: 'cli_high',
        cliId: 'claude-code',
        displayName: 'FlagshipBot',
        taskRouting: { enabled: true, costTier: 'high', strengths: '复杂重构' },
      }),
      makeBotConfig({
        larkAppId: 'cli_steward',
        cliId: 'claude-code',
        displayName: 'Steward',
        steward: { enabled: true, chatId: 'oc_steward' },
      }),
    ];

    const sharedProbeDeps = {
      dataDir,
      now: () => NOW,
      loadConfigs: () => configs,
      discoverDaemons: () => [
        { larkAppId: 'cli_low', ipcPort: 20001 },
        { larkAppId: 'cli_high', ipcPort: 20002 },
        { larkAppId: 'cli_steward', ipcPort: 20003 },
      ],
      fetchObserve: async ({ larkAppId }: { larkAppId?: string }) => ({
        schemaVersion: OBSERVE_SCHEMA_VERSION,
        observedAt: NOW,
        daemons: (larkAppId ? [larkAppId] : ['cli_low', 'cli_high', 'cli_steward']).map(id => ({
          larkAppId: id,
          probe: { status: 'ok' as const, source: 'daemon-ipc' as const, larkAppId: id },
          sessions: [],
        })),
      }),
      fetchDaemonExtra: async () => ({ maxLiveWorkers: null, residentSessionCount: 0, pendingTurnCount: 0, activeUsageLimit: null }),
    };

    // Disabled by default -> rejects with task_routing_disabled
    await expect(
      getTaskRoutingStatus({ dataDir, readGlobalTaskRouting: () => undefined, probeDeps: sharedProbeDeps }),
    ).rejects.toThrow(TaskRoutingError);

    const enabledDeps = {
      dataDir,
      now: () => NOW,
      readGlobalTaskRouting: () => ({ enabled: true, matcher: { mode: 'rule' as const } }),
      loadConfigs: () => configs,
      probeDeps: sharedProbeDeps,
    };

    const status = await getTaskRoutingStatus(enabledDeps);
    expect(status.eligible.map(e => e.larkAppId)).toEqual(['cli_low', 'cli_high']);
    expect(status.excluded.map(e => [e.larkAppId, e.exclusionCode])).toEqual([['cli_steward', 'steward_bot']]);

    const rec = await recommendBotForTask({ task: '把按钮文案改成应用' }, enabledDeps);
    expect(rec.decision.selectedAppId).toBe('cli_low');

    // Conflicting --prefer and --exclude fails cleanly
    await expect(
      recommendBotForTask({ task: 'test', constraints: { prefer: 'EconomyBot', exclude: ['EconomyBot'] } }, enabledDeps),
    ).rejects.toThrow(TaskRoutingError);

    const ran = await runTaskRouting(
      {
        mode: 'group',
        task: '把按钮文案改成应用',
        callerKind: 'host_cli',
      },
      {
        ...enabledDeps,
        dispatchGroupCandidate: async (cand, ctx) => {
          ctx.onChatCreated?.('oc_done_1');
          return { ok: true, chatId: 'oc_done_1', sessionId: `sess_${cand.appId}` };
        },
      },
    );
    expect(ran.ok).toBe(true);
    expect(ran.record.selectedAppId).toBe('cli_low');
    expect(ran.record.excluded.some(e => e.larkAppId === 'cli_steward' && e.exclusionCode === 'steward_bot')).toBe(true);

    const history = await listTaskRoutingHistory({ limit: 10, botRef: 'EconomyBot' }, enabledDeps);
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(ran.record.id);
    expect(history[0]?.targetChatId).toBe('oc_done_1');
  });

  it('enforces capability auth, owner gate, and single-settlement invariants over real HTTP IPC', async () => {
    const dir = makeTempDir();
    const prevDataDir = config.session.dataDir;
    const prevGlobalCfg = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    const prevBotsCfg = process.env.BOTS_CONFIG;
    let handle: IpcServerHandle | null = null;
    try {
      config.session.dataDir = dir;
      const globalCfgPath = join(dir, 'config.json');
      writeFileSync(globalCfgPath, JSON.stringify({ taskRouting: { enabled: true, matcher: { mode: 'rule' } } }));
      process.env.BOTMUX_GLOBAL_CONFIG_FILE = globalCfgPath;
      invalidateGlobalConfigCache();

      const botsCfgPath = join(dir, 'bots.json');
      const botCfg = makeBotConfig({
        larkAppId: 'cli_ipc_host',
        cliId: 'claude-code',
        allowedUsers: ['ou_owner'],
      });
      writeFileSync(botsCfgPath, JSON.stringify([botCfg]));
      process.env.BOTS_CONFIG = botsCfgPath;
      __testOnly_resetBotRegistry();
      registerBot(botCfg);
      getBot('cli_ipc_host').resolvedAllowedUsers = ['ou_owner'];
      setLarkAppId('cli_ipc_host');
      setIpcAuthSecret('ipc-task-routing-test-secret');

      const capOwner = 'aa11bb22'.repeat(8);
      const capGuest = 'cc33dd44'.repeat(8);
      const capOtherOwner = 'ee55ff66'.repeat(8);
      const capIsolatedCodex = '11223344'.repeat(8);
      const sessions: Record<string, any> = {
        sess_owner: {
          session: { sessionId: 'sess_owner', status: 'active', scope: 'chat', chatId: 'oc_1', rootMessageId: '' },
          larkAppId: 'cli_ipc_host',
          chatId: 'oc_1',
          chatType: 'group',
          scope: 'chat',
          managedTurnOrigin: {
            capability: capOwner,
            turnId: 'om_turn_1',
            trustedCaller: {
              senderType: 'user',
              requestLarkAppId: 'cli_ipc_host',
              requestUserOpenId: 'ou_owner',
            },
          },
        },
        sess_other_owner: {
          session: { sessionId: 'sess_other_owner', status: 'active', scope: 'chat', chatId: 'oc_2', rootMessageId: '' },
          larkAppId: 'cli_ipc_host',
          chatId: 'oc_2',
          chatType: 'group',
          scope: 'chat',
          managedTurnOrigin: {
            capability: capOtherOwner,
            turnId: 'om_turn_1',
            trustedCaller: {
              senderType: 'user',
              requestLarkAppId: 'cli_ipc_host',
              requestUserOpenId: 'ou_owner',
            },
          },
        },
        sess_isolated_codex: {
          session: {
            sessionId: 'sess_isolated_codex',
            status: 'active',
            scope: 'chat',
            chatId: 'oc_3',
            rootMessageId: '',
            cliId: 'codex-app',
            codexAppDispatchLedger: [{
              dispatchId: 'disp_1',
              turnId: 'om_turn_codex',
              dispatchAttempt: 1,
              deliverySink: 'http_wait',
              state: 'accepted',
            }],
          },
          initConfig: { cliId: 'codex-app' },
          larkAppId: 'cli_ipc_host',
          chatId: 'oc_3',
          chatType: 'group',
          scope: 'chat',
          managedTurnOrigin: {
            capability: capIsolatedCodex,
            turnId: 'om_turn_codex',
            dispatchAttempt: 1,
            trustedCaller: {
              senderType: 'user',
              requestLarkAppId: 'cli_ipc_host',
              requestUserOpenId: 'ou_owner',
            },
          },
        },
        sess_guest: {
          session: { sessionId: 'sess_guest', status: 'active', scope: 'chat', chatId: 'oc_1', rootMessageId: '' },
          larkAppId: 'cli_ipc_host',
          chatId: 'oc_1',
          chatType: 'group',
          scope: 'chat',
          managedTurnOrigin: {
            capability: capGuest,
            turnId: 'om_turn_2',
            trustedCaller: {
              senderType: 'user',
              requestLarkAppId: 'cli_ipc_host',
              requestUserOpenId: 'ou_stranger',
            },
          },
        },
      };
      vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
      handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

      const post = async (sessionId: string, body: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${sessionId}/task-routing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
      };

      // 1. Missing/wrong capability rejected by narrow untrusted auth aperture
      const noCap = await post('sess_owner', { action: 'status' });
      expect(noCap.status).toBe(403);

      // 2. Stranger in regular group can read status, but is blocked from `run`
      const guestStatus = await post('sess_guest', { originCapability: capGuest, action: 'status' });
      expect(guestStatus.status).toBe(200);
      expect(guestStatus.json.ok).toBe(true);

      const guestRun = await post('sess_guest', { originCapability: capGuest, action: 'run', task: '偷偷派活' });
      expect(guestRun.status).toBe(403);
      expect(guestRun.json.error).toBe('assign_run_forbidden');

      // 2b. Isolated Codex App turn with non-sendable sink is blocked from `run` (409 origin_not_sendable)
      const isolatedRun = await post('sess_isolated_codex', {
        originCapability: capIsolatedCodex,
        action: 'run',
        task: '非可发送回合禁止派发',
      });
      expect(isolatedRun.status).toBe(409);
      expect(isolatedRun.json.error).toBe('origin_not_sendable');

      // 3. Seed a pending topic record for sess_owner on om_turn_1 and verify settlement guards
      const store = new TaskRoutingStore(dir);
      store.insertRecord({
        id: 'tr_topic_guard',
        createdAt: NOW,
        updatedAt: NOW,
        mode: 'topic',
        taskSummary: '开子话题',
        callerKind: 'owner_turn',
        callerAppId: 'cli_ipc_host',
        callerSessionId: 'sess_owner',
        callerTurnId: 'om_turn_1',
        constraints: {},
        selectedAppId: 'cli_cand_1',
        selectedName: 'Cand1',
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [{
          larkAppId: 'cli_cand_1',
          name: 'Cand1',
          cliId: 'claude-code',
          costTier: 'low',
          participating: true,
          eligible: true,
          runtimeSummary: '空闲',
          runtime: {
            online: true,
            probeStatus: 'ok',
            larkConnected: true,
            workingCount: 0,
            queuedCount: 0,
            residentCount: 0,
            maxLiveWorkers: null,
            limitedCount: 0,
          },
        }],
        excluded: [],
        attempts: [],
        outcome: 'pending',
      });

      // Cross-session settlement attempt -> 404
      const crossSess = await post('sess_other_owner', {
        originCapability: capOtherOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: 'cli_cand_1',
        outcome: 'dispatched',
      });
      expect(crossSess.status).toBe(404);
      expect(crossSess.json.error).toBe('routing_record_not_found');

      // Non-terminal 'pending' and garbage outcome -> 400 invalid_settlement_outcome
      const pendingRes = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        outcome: 'pending',
        targetChatId: 'oc_tampered',
      });
      expect(pendingRes.status).toBe(400);
      expect(pendingRes.json.error).toBe('invalid_settlement_outcome');

      const garbageRes = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        outcome: 'not_a_real_outcome',
      });
      expect(garbageRes.status).toBe(400);
      expect(garbageRes.json.error).toBe('invalid_settlement_outcome');

      // Dispatched with selectedAppId:null -> 400
      const nullApp = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: null,
        selectedName: 'FORGED_NAME',
        outcome: 'dispatched',
      });
      expect(nullApp.status).toBe(400);
      expect(nullApp.json.error).toBe('invalid_selected_bot');

      // Forged selectedAppId outside candidates -> 400
      const forged = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: 'cli_forged',
        outcome: 'dispatched',
      });
      expect(forged.status).toBe(400);
      expect(forged.json.error).toBe('invalid_selected_bot');

      // Turn mismatch (both rotated turn AND cleared undefined turnId) -> 409
      sessions.sess_owner.managedTurnOrigin.turnId = 'om_turn_other';
      const wrongTurn = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: 'cli_cand_1',
        outcome: 'dispatched',
      });
      expect(wrongTurn.status).toBe(409);
      expect(wrongTurn.json.error).toBe('routing_record_turn_mismatch');

      sessions.sess_owner.managedTurnOrigin.turnId = undefined;
      const missingTurn = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: 'cli_cand_1',
        outcome: 'dispatched',
      });
      expect(missingTurn.status).toBe(409);
      expect(missingTurn.json.error).toBe('routing_record_turn_mismatch');

      // Forged settlementToken -> 403
      sessions.sess_owner.managedTurnOrigin.turnId = 'om_turn_1';
      const badToken = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        settlementToken: 'forged_token_value',
        selectedAppId: 'cli_cand_1',
        outcome: 'dispatched',
      });
      expect(badToken.status).toBe(403);
      expect(badToken.json.error).toBe('invalid_settlement_token');

      // Matching turn settles once -> 200; authoritative selectedName ignores forged name, non-candidate attempts stripped!
      const settled = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        selectedAppId: 'cli_cand_1',
        selectedName: 'FORGED_DISPLAY_NAME',
        outcome: 'dispatched',
        targetChatId: 'oc_1',
        targetRootMessageId: 'om_root_1',
        attempts: [
          { appId: 'cli_not_a_candidate', name: 'Evil', outcome: 'failed', reason: 'fake', at: NOW },
          { appId: 'cli_cand_1', name: 'FORGED_ATTEMPT_NAME', outcome: 'dispatched', reason: 'ok', at: NOW },
        ],
      });
      expect(settled.status).toBe(200);
      expect(settled.json.record.outcome).toBe('dispatched');
      expect(settled.json.record.selectedName).toBe('Cand1');
      expect(settled.json.record.attempts).toHaveLength(1);
      expect(settled.json.record.attempts[0]).toMatchObject({ appId: 'cli_cand_1', name: 'Cand1' });

      // Double settlement -> 409
      const doubleSettle = await post('sess_owner', {
        originCapability: capOwner,
        action: 'record-topic-attempt',
        recordId: 'tr_topic_guard',
        outcome: 'failed',
      });
      expect(doubleSettle.status).toBe(409);
      expect(doubleSettle.json.error).toBe('routing_record_already_settled');

      // 4. `preflight-topic-candidate` enforces live global kill-switch (abortAll:true) without waiting for 2s cache
      store.insertRecord({
        id: 'tr_topic_preflight',
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
        mode: 'topic',
        taskSummary: 'preflight kill switch',
        callerKind: 'owner_turn',
        callerAppId: 'cli_ipc_host',
        callerSessionId: 'sess_owner',
        callerTurnId: 'om_turn_1',
        constraints: {},
        selectedAppId: 'cli_cand_1',
        selectedName: 'Cand1',
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [{
          larkAppId: 'cli_cand_1',
          name: 'Cand1',
          cliId: 'claude-code',
          costTier: 'low',
          participating: true,
          eligible: true,
          runtimeSummary: '空闲',
          runtime: {
            online: true,
            probeStatus: 'ok',
            larkConnected: true,
            workingCount: 0,
            queuedCount: 0,
            residentCount: 0,
            maxLiveWorkers: null,
            limitedCount: 0,
          },
        }],
        excluded: [],
        attempts: [],
        outcome: 'pending',
      });
      writeFileSync(globalCfgPath, JSON.stringify({ taskRouting: { enabled: false } }, null, 2));
      const pfAborted = await post('sess_owner', {
        originCapability: capOwner,
        action: 'preflight-topic-candidate',
        recordId: 'tr_topic_preflight',
        candidateAppId: 'cli_cand_1',
      });
      expect(pfAborted.status).toBe(200);
      expect(pfAborted.json).toMatchObject({ ok: true, allowed: false, abortAll: true });
    } finally {
      if (handle) await handle.close();
      setIpcAuthSecret(null);
      setLarkAppId('');
      __testOnly_resetBotRegistry();
      config.session.dataDir = prevDataDir;
      if (prevGlobalCfg === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
      else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prevGlobalCfg;
      if (prevBotsCfg === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBotsCfg;
      invalidateGlobalConfigCache();
      vi.restoreAllMocks();
    }
  });
});
