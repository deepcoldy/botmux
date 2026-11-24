import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import type { TaskRoutingGlobalConfig, TaskRoutingRecord } from '../src/core/task-routing/model.js';
import { TaskRoutingStore, taskRoutingDbPath } from '../src/services/task-routing-store.js';
import { handleTaskRoutingApi, type TaskRoutingApiDeps } from '../src/dashboard/task-routing-api.js';
import { botDefaultsPayload, sparseOverridesFromRawBotConfig } from '../src/dashboard/bot-payload.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-tr-dash-api-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeReq(method: string, path: string, headers: Record<string, string> = {}): {
  req: IncomingMessage;
  url: URL;
} {
  return {
    req: { method, headers } as unknown as IncomingMessage,
    url: new URL(path, 'http://127.0.0.1:8787'),
  };
}

function makeRes(): {
  res: ServerResponse;
  status: () => number;
  json: () => any;
} {
  let statusCode = 0;
  let rawBody = '';
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    json: () => JSON.parse(rawBody),
  };
}

function sampleBots(): BotConfig[] {
  return [
    {
      larkAppId: 'cli_econ',
      larkAppSecret: 'sec_1',
      cliId: 'claude-code',
      name: 'EconomyWorker',
      displayName: 'EconomyWorker',
      model: 'kimi-k2',
      taskRouting: {
        enabled: true,
        costTier: 'low',
        strengths: '改文案、小修、补单测',
        limitations: '不适合大型跨模块重构',
      },
    } as BotConfig,
    {
      larkAppId: 'cli_flagship',
      larkAppSecret: 'sec_2',
      cliId: 'claude-code',
      name: 'FlagshipWorker',
      displayName: 'FlagshipWorker',
      model: 'opus',
      taskRouting: {
        enabled: true,
        costTier: 'high',
        strengths: '复杂架构重构与根因排查',
      },
    } as BotConfig,
    {
      larkAppId: 'cli_steward',
      larkAppSecret: 'sec_3',
      cliId: 'claude-code',
      name: 'StewardBot',
      displayName: 'StewardBot',
      steward: { enabled: true },
    } as BotConfig,
  ];
}

function makeDeps(overrides: Partial<TaskRoutingApiDeps> = {}): TaskRoutingApiDeps {
  const dataDir = overrides.dataDir ?? makeTempDir();
  return {
    canManageHost: true,
    dataDir,
    readJsonBody: vi.fn(async () => ({})),
    readGlobalTaskRouting: () => ({ enabled: false }),
    serviceDeps: {
      loadConfigs: sampleBots,
      probeDeps: {
        readBotsInfo: () => [],
        readBotProfile: () => null,
        discoverDaemons: () => [
          {
            larkAppId: 'cli_econ',
            botName: 'EconomyWorker',
            ipcPort: 19001,
            pid: 1001,
            botIndex: 0,
            cliId: 'claude-code',
            startedAt: 1_760_000_000_000,
            larkConnection: { state: 'connected' },
          } as any,
          {
            larkAppId: 'cli_flagship',
            botName: 'FlagshipWorker',
            ipcPort: 19002,
            pid: 1002,
            botIndex: 1,
            cliId: 'claude-code',
            startedAt: 1_760_000_000_000,
            larkConnection: { state: 'connected' },
          } as any,
        ],
        fetchObserve: async ({ larkAppId }) => {
          const allEnvelopes = [
            {
              larkAppId: 'cli_econ',
              botName: 'EconomyWorker',
              ipcPort: 19001,
              probe: { status: 'ok' },
              sessions: [],
            },
            {
              larkAppId: 'cli_flagship',
              botName: 'FlagshipWorker',
              ipcPort: 19002,
              probe: { status: 'ok' },
              sessions: [{ sessionId: 's1', liveness: 'alive', turn: 'working', closed: false, queued: false }],
            },
          ];
          const filtered = larkAppId
            ? allEnvelopes.filter(e => e.larkAppId === larkAppId)
            : allEnvelopes;
          return {
            generatedAt: '2026-11-24T04:00:00.000Z',
            daemons: filtered as any,
            sessions: [] as any,
            counts: { total: 1, working: 1, idle: 0, waiting: 0, parked: 0, limited: 0, other: 0 },
          } as any;
        },
        fetchDaemonExtra: async () => ({
          maxLiveWorkers: 8,
          residentSessionCount: 1,
          pendingTurnCount: 0,
          activeUsageLimit: null,
        }),
        inspectAgyAccounts: () => ({ managed: false, accounts: [], active: null, activeAccount: null } as any),
        readBudgetStatus: () => null,
      },
    },
    ...overrides,
  };
}

function seedRecord(store: TaskRoutingStore, patch: Partial<TaskRoutingRecord>): TaskRoutingRecord {
  const record: TaskRoutingRecord = {
    id: patch.id ?? `rec_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: patch.createdAt ?? 1_760_000_000_000,
    updatedAt: patch.updatedAt ?? 1_760_000_005_000,
    mode: patch.mode ?? 'group',
    taskSummary: patch.taskSummary ?? '重构鉴权链路',
    callerKind: patch.callerKind ?? 'steward_session',
    constraints: patch.constraints ?? {},
    selectedAppId: patch.selectedAppId ?? 'cli_flagship',
    selectedName: patch.selectedName ?? 'FlagshipWorker',
    matcherKind: patch.matcherKind ?? 'bot',
    confidence: patch.confidence ?? 'high',
    reason: patch.reason ?? '首选耗尽后兜底切换到 FlagshipWorker',
    candidates: patch.candidates ?? [],
    excluded: patch.excluded ?? [],
    attempts: patch.attempts ?? [
      { appId: 'cli_econ', name: 'EconomyWorker', outcome: 'skipped', reason: '派发前复检跳过：额度耗尽', at: 1_760_000_001_000 },
      { appId: 'cli_flagship', name: 'FlagshipWorker', outcome: 'dispatched', reason: '已建任务群并投递', at: 1_760_000_004_000, chatId: 'oc_task_1', sessionId: 'sess_1' },
    ],
    outcome: patch.outcome ?? 'fallback_dispatched',
    targetChatId: patch.targetChatId ?? 'oc_task_1',
    targetSessionId: patch.targetSessionId ?? 'sess_1',
  };
  store.insertRecord(record);
  return record;
}

describe('handleTaskRoutingApi', () => {
  it('returns false for unrelated routes and 401 when caller lacks management auth', async () => {
    const deps = makeDeps({ canManageHost: false });
    const other = makeReq('GET', '/api/settings');
    const otherRes = makeRes();
    expect(await handleTaskRoutingApi(other.req, otherRes.res, other.url, deps)).toBe(false);

    for (const [method, path] of [
      ['GET', '/api/task-routing/status'],
      ['GET', '/api/task-routing/history'],
      ['POST', '/api/task-routing/recommend'],
    ] as const) {
      const { req, url } = makeReq(method, path, { 'content-type': 'application/json' });
      const res = makeRes();
      expect(await handleTaskRoutingApi(req, res.res, url, deps)).toBe(true);
      expect(res.status()).toBe(401);
      expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
    }
  });

  it('stays side-effect free when globally disabled (no daemon probe, no SQLite creation, 403 on recommend)', async () => {
    const dataDir = makeTempDir();
    const loadConfigs = vi.fn(sampleBots);
    const deps = makeDeps({
      dataDir,
      readGlobalTaskRouting: () => ({ enabled: false, policy: 'kept policy' }),
      serviceDeps: { loadConfigs },
    });

    const stReq = makeReq('GET', '/api/task-routing/status');
    const stRes = makeRes();
    await handleTaskRoutingApi(stReq.req, stRes.res, stReq.url, deps);
    expect(stRes.status()).toBe(200);
    expect(stRes.json()).toMatchObject({
      ok: true,
      enabled: false,
      policy: 'kept policy',
      eligible: [],
      excluded: [],
    });
    expect(loadConfigs).not.toHaveBeenCalled();

    const hiReq = makeReq('GET', '/api/task-routing/history');
    const hiRes = makeRes();
    await handleTaskRoutingApi(hiReq.req, hiRes.res, hiReq.url, deps);
    expect(hiRes.status()).toBe(200);
    expect(hiRes.json()).toEqual({ ok: true, enabled: false, records: [] });

    const recReq = makeReq('POST', '/api/task-routing/recommend', { 'content-type': 'application/json' });
    const recRes = makeRes();
    await handleTaskRoutingApi(recReq.req, recRes.res, recReq.url, {
      ...deps,
      readJsonBody: vi.fn(async () => ({ task: '修一个小 typo' })),
    });
    expect(recRes.status()).toBe(403);
    expect(recRes.json().error).toBe('task_routing_disabled');
    expect(existsSync(taskRoutingDbPath(dataDir))).toBe(false);
  });

  it('returns live eligible and excluded candidates with matcher metadata when enabled', async () => {
    const cfg: TaskRoutingGlobalConfig = {
      enabled: true,
      policy: '拿不准优先便宜空闲的 Bot',
      matcher: { mode: 'bot', botAppId: 'cli_econ', timeoutMs: 12_000 },
    };
    const deps = makeDeps({ readGlobalTaskRouting: () => cfg });
    const { req, url } = makeReq('GET', '/api/task-routing/status');
    const res = makeRes();
    await handleTaskRoutingApi(req, res.res, url, deps);

    expect(res.status()).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.matcherMode).toBe('bot');
    expect(body.matcherBotAppId).toBe('cli_econ');
    expect(body.matcherBotName).toBe('EconomyWorker');
    expect(body.matcherTimeoutMs).toBe(12_000);
    expect(body.policy).toBe('拿不准优先便宜空闲的 Bot');
    expect(body.eligible.map((c: any) => c.larkAppId)).toEqual(['cli_econ', 'cli_flagship']);
    expect(body.excluded).toEqual([
      expect.objectContaining({ larkAppId: 'cli_steward', exclusionCode: 'steward_bot' }),
    ]);
  });

  it('reads history lazily without creating SQLite when absent, and supports bot/outcome/limit filters', async () => {
    const dataDir = makeTempDir();
    const deps = makeDeps({ dataDir, readGlobalTaskRouting: () => ({ enabled: true }) });

    // Empty read must NOT create task-routing.sqlite.
    const emptyReq = makeReq('GET', '/api/task-routing/history');
    const emptyRes = makeRes();
    await handleTaskRoutingApi(emptyReq.req, emptyRes.res, emptyReq.url, deps);
    expect(emptyRes.status()).toBe(200);
    expect(emptyRes.json()).toEqual({ ok: true, enabled: true, records: [] });
    expect(existsSync(taskRoutingDbPath(dataDir))).toBe(false);

    // Invalid outcome filter fails closed with 400.
    const badReq = makeReq('GET', '/api/task-routing/history?outcome=unknown');
    const badRes = makeRes();
    await handleTaskRoutingApi(badReq.req, badRes.res, badReq.url, deps);
    expect(badRes.status()).toBe(400);
    expect(badRes.json().error).toBe('invalid_outcome');

    // Seed two records and verify filtering.
    const store = new TaskRoutingStore(dataDir);
    seedRecord(store, {
      id: 'rec_1',
      createdAt: 1_760_000_000_000,
      selectedAppId: 'cli_econ',
      selectedName: 'EconomyWorker',
      outcome: 'dispatched',
      attempts: [{ appId: 'cli_econ', name: 'EconomyWorker', outcome: 'dispatched', reason: 'ok', at: 1_760_000_001_000 }],
    });
    seedRecord(store, {
      id: 'rec_2',
      createdAt: 1_760_000_010_000,
      selectedAppId: 'cli_flagship',
      selectedName: 'FlagshipWorker',
      outcome: 'fallback_dispatched',
    });
    // A newer unrelated row must not consume LIMIT before the attempts match.
    seedRecord(store, {
      id: 'rec_3',
      createdAt: 1_760_000_020_000,
      selectedAppId: 'cli_other',
      selectedName: 'OtherWorker',
      outcome: 'dispatched',
      attempts: [{ appId: 'cli_other', name: 'OtherWorker', outcome: 'dispatched', reason: 'ok', at: 1_760_000_020_001 }],
    });

    const filteredReq = makeReq('GET', '/api/task-routing/history?outcome=fallback_dispatched&bot=cli_flagship&limit=10');
    const filteredRes = makeRes();
    await handleTaskRoutingApi(filteredReq.req, filteredRes.res, filteredReq.url, deps);
    expect(filteredRes.status()).toBe(200);
    expect(filteredRes.json().records.map((r: TaskRoutingRecord) => r.id)).toEqual(['rec_2']);

    // Bot A participated in rec_2's fallback chain even though Bot B was selected.
    // The latest matching row is rec_2; rec_3 must be excluded before LIMIT 1.
    const attemptReq = makeReq('GET', '/api/task-routing/history?bot=cli_econ&limit=1');
    const attemptRes = makeRes();
    await handleTaskRoutingApi(attemptReq.req, attemptRes.res, attemptReq.url, deps);
    expect(attemptRes.status()).toBe(200);
    expect(attemptRes.json().records.map((r: TaskRoutingRecord) => r.id)).toEqual(['rec_2']);
  });

  it('performs dry-run recommend with zero SQLite side effects and rejects malformed bodies', async () => {
    const dataDir = makeTempDir();
    const deps = makeDeps({
      dataDir,
      readGlobalTaskRouting: () => ({ enabled: true }),
    });

    // Reject missing JSON content-type
    const nonJson = makeReq('POST', '/api/task-routing/recommend', { 'content-type': 'text/plain' });
    const nonJsonRes = makeRes();
    await handleTaskRoutingApi(nonJson.req, nonJsonRes.res, nonJson.url, deps);
    expect(nonJsonRes.status()).toBe(400);

    // Reject empty task
    const emptyTask = makeReq('POST', '/api/task-routing/recommend', { 'content-type': 'application/json' });
    const emptyTaskRes = makeRes();
    await handleTaskRoutingApi(emptyTask.req, emptyTaskRes.res, emptyTask.url, {
      ...deps,
      readJsonBody: vi.fn(async () => ({ task: '   ' })),
    });
    expect(emptyTaskRes.status()).toBe(400);
    expect(emptyTaskRes.json().error).toBe('empty_task');

    // Valid dry-run with exclude selects FlagshipWorker and leaves no DB behind
    const validReq = makeReq('POST', '/api/task-routing/recommend', { 'content-type': 'application/json' });
    const validRes = makeRes();
    await handleTaskRoutingApi(validReq.req, validRes.res, validReq.url, {
      ...deps,
      readJsonBody: vi.fn(async () => ({
        task: '重构登录鉴权流程',
        exclude: ['cli_econ'],
        noLlm: true,
      })),
    });
    expect(validRes.status()).toBe(200);
    const body = validRes.json();
    expect(body.ok).toBe(true);
    expect(body.decision.selectedAppId).toBe('cli_flagship');
    expect(body.decision.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ larkAppId: 'cli_econ', exclusionCode: 'excluded_by_caller' }),
      ]),
    );
    expect(existsSync(taskRoutingDbPath(dataDir))).toBe(false);
  });
});

describe('offline bot taskRouting payload round-trip', () => {
  it('preserves saved taskRouting profile in sparseOverridesFromRawBotConfig for offline bots', () => {
    const rawEntry = {
      larkAppId: 'cli_offline',
      taskRouting: {
        enabled: true,
        costTier: 'low',
        strengths: '写测试与改文档',
        limitations: '不做数据库迁移',
      },
    };
    const overrides = sparseOverridesFromRawBotConfig(rawEntry);
    const payload = botDefaultsPayload({ larkAppId: 'cli_offline', cliId: 'claude-code' }, overrides);
    expect(payload.taskRouting).toEqual(rawEntry.taskRouting);
  });
});
