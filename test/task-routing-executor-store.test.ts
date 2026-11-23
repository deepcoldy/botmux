import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import {
  createHostGroupDispatcher,
  executeTaskRoutingRun,
} from '../src/core/task-routing/executor.js';
import type { BotRuntimeSnapshot, TaskRoutingDecision } from '../src/core/task-routing/model.js';
import { evaluateCandidates } from '../src/core/task-routing/selector.js';
import { TaskRoutingStore, taskRoutingDbPath } from '../src/services/task-routing-store.js';

const NOW = 1_800_000_000_000;

function makeSnapshot(id: string, name: string, tier: 'low' | 'medium' | 'high', extra: Partial<BotRuntimeSnapshot['runtime']> = {}): BotRuntimeSnapshot {
  return {
    larkAppId: id,
    name,
    cliId: id.includes('agy') ? 'antigravity' : 'claude-code',
    isSteward: false,
    apiOnly: false,
    configOrder: 0,
    profile: { enabled: true, costTier: tier },
    runtime: {
      online: true,
      probeStatus: 'ok',
      larkConnected: true,
      workingCount: 0,
      queuedCount: 0,
      residentCount: 0,
      maxLiveWorkers: null,
      limitedCount: 0,
      ...extra,
    },
  };
}

describe('TaskRoutingStore lazy creation & executeTaskRoutingRun fallback', () => {
  const tempDirs: string[] = [];
  function makeDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-tr-store-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create task-routing.sqlite on read-only queries', () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    expect(store.listRecords()).toEqual([]);
    expect(store.getRecord('tr_missing')).toBeNull();
    expect(existsSync(taskRoutingDbPath(dataDir))).toBe(false);
  });

  it('falls back cleanly when primary fails preflight or explicit spawn refusal and persists full history', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    let clock = NOW;

    const snaps = [
      makeSnapshot('cli_agy', 'Bot-Mid-Agy', 'medium'),
      makeSnapshot('cli_paid', 'Bot-High', 'high'),
      makeSnapshot('cli_low', 'Bot-Low', 'low'),
    ];
    const { eligible } = evaluateCandidates(snaps, {}, clock);
    const decision: TaskRoutingDecision = {
      selectedAppId: 'cli_agy',
      selectedName: 'Bot-Mid-Agy',
      fallbackOrder: ['cli_agy', 'cli_paid', 'cli_low'],
      matcherKind: 'bot',
      confidence: 'high',
      reason: '鉴权重构首选 Bot-Mid-Agy，备选 Bot-High',
      candidates: eligible,
      excluded: [],
    };

    const result = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '重构鉴权链路',
        callerKind: 'steward_session',
        callerAppId: 'cli_steward',
        callerSessionId: 'sess_steward',
        constraints: {},
        decision,
      },
      {
        store,
        now: () => (clock += 1_000),
        preflightCandidate: async appId => {
          if (appId === 'cli_agy') {
            // Last-second agy exhaustion discovered at preflight!
            return makeSnapshot('cli_agy', 'Bot-Mid-Agy', 'medium', {
              agyAccounts: { managed: true, availableCount: 0, enabledCount: 3, earliestRecoveryMs: clock + 30 * 60_000 },
            });
          }
          return snaps.find(s => s.larkAppId === appId) ?? null;
        },
        dispatchCandidate: async (cand, ctx) => {
          if (cand.appId === 'cli_paid') {
            // Explicit non-acceptance (retryable) -> should fall back to cli_low
            return { ok: false, retryable: true, error: '建群失败：rate_limit' };
          }
          ctx.onChatCreated?.('oc_task_group_3');
          return { ok: true, chatId: 'oc_task_group_3', sessionId: 'sess_new_3' };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.record.outcome).toBe('fallback_dispatched');
    expect(result.record.selectedAppId).toBe('cli_low');
    expect(result.record.targetChatId).toBe('oc_task_group_3');
    expect(result.record.targetSessionId).toBe('sess_new_3');
    expect(result.record.attempts.map(a => [a.appId, a.outcome])).toEqual([
      ['cli_agy', 'skipped'],
      ['cli_paid', 'failed'],
      ['cli_low', 'dispatched'],
    ]);
    expect(result.record.attempts[0]?.reason).toContain('agy 3/3');

    const persisted = store.getRecord(result.record.id);
    expect(persisted?.outcome).toBe('fallback_dispatched');
    expect(persisted?.attempts).toHaveLength(3);
  });

  it('stops without double-dispatching when post-group-create spawn is ambiguous (non-retryable)', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    const snaps = [
      makeSnapshot('cli_first', 'First', 'low'),
      makeSnapshot('cli_second', 'Second', 'high'),
    ];
    const { eligible } = evaluateCandidates(snaps, {}, NOW);
    const called: string[] = [];

    const result = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '修一个数据库迁移 bug',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_first',
          selectedName: 'First',
          fallbackOrder: ['cli_first', 'cli_second'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: '默认选经济档',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store,
        now: () => NOW,
        dispatchCandidate: async (cand, ctx) => {
          called.push(cand.appId);
          ctx.onChatCreated?.('oc_created_1');
          return { ok: false, retryable: false, chatId: 'oc_created_1', error: 'spawn_delivery_unknown' };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(called).toEqual(['cli_first']);
    expect(result.chatId).toBe('oc_created_1');
    const saved = store.getRecord(result.record.id);
    expect(saved?.outcome).toBe('failed');
    expect(saved?.targetChatId).toBe('oc_created_1');
    expect(saved?.error).toContain('spawn_delivery_unknown');
  });

  it('createHostGroupDispatcher uses target bot own resolvedAllowedUsers and binds workingDir', async () => {
    const calls: Array<{ path: string; body?: any }> = [];
    const dispatcher = createHostGroupDispatcher({
      secret: 'test-secret',
      discoverDaemons: () => [{ larkAppId: 'cli_target', ipcPort: 19999 }],
      fetchIpc: async (_port, path, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === '/api/bot-default-oncall') {
          return new Response(JSON.stringify({
            resolvedAllowedUsers: ['ou_target_owner', 'on_shared_union'],
          }), { status: 200 });
        }
        if (path === '/api/groups/create') {
          return new Response(JSON.stringify({ ok: true, chatId: 'oc_new_99', shareLink: 'https://feishu.cn/join/99' }), { status: 200 });
        }
        if (path === '/api/sessions/spawn') {
          return new Response(JSON.stringify({ ok: true, sessionId: 'sess_99' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      },
    });

    const createdChats: string[] = [];
    const out = await dispatcher(
      { appId: 'cli_target', name: 'Target' },
      {
        mode: 'group',
        task: '检查日志轮转',
        title: '日志轮转排查',
        workingDir: '/tmp/repo',
        onChatCreated: id => createdChats.push(id),
      },
    );

    expect(out).toEqual({
      ok: true,
      chatId: 'oc_new_99',
      sessionId: 'sess_99',
      shareLink: 'https://feishu.cn/join/99',
    });
    expect(createdChats).toEqual(['oc_new_99']);
    const createCall = calls.find(c => c.path === '/api/groups/create');
    expect(createCall?.body).toMatchObject({
      name: '日志轮转排查',
      larkAppIds: ['cli_target'],
      userOpenIds: ['ou_target_owner'],
      ownerUnionIds: ['on_shared_union'],
      transferOwnerTo: 'ou_target_owner',
      bindWorkingDir: '/tmp/repo',
    });
  });

  it('prunes oldest records beyond maxRecords retention cap', () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir, { maxRecords: 10 });
    for (let i = 0; i < 15; i++) {
      store.insertRecord({
        id: `tr_${i}`,
        createdAt: NOW + i * 1000,
        updatedAt: NOW + i * 1000,
        mode: 'group',
        taskSummary: `task ${i}`,
        callerKind: 'host_cli',
        constraints: {},
        selectedAppId: 'cli_a',
        selectedName: 'BotA',
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [],
        excluded: [],
        attempts: [],
        outcome: 'dispatched',
      });
    }
    const list = store.listRecords({ limit: 50 });
    expect(list).toHaveLength(10);
    expect(list[0]?.id).toBe('tr_14');
    expect(list[9]?.id).toBe('tr_5');
  });

  it('aborts fallback and settles failed when global taskRouting is disabled mid-flight', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    const snaps = [makeSnapshot('cli_a', 'A', 'low'), makeSnapshot('cli_b', 'B', 'high')];
    const { eligible } = evaluateCandidates(snaps, {}, NOW);
    let enabled = true;
    const called: string[] = [];

    const out = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '测试中途关闭',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_a',
          selectedName: 'A',
          fallbackOrder: ['cli_a', 'cli_b'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: 'rule',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store,
        now: () => NOW,
        isRoutingStillEnabled: () => enabled,
        dispatchCandidate: async cand => {
          called.push(cand.appId);
          // Flip kill-switch mid-flight while primary fails retryably.
          enabled = false;
          return { ok: false, retryable: true, error: '建群失败' };
        },
      },
    );

    expect(out.ok).toBe(false);
    expect(called).toEqual(['cli_a']);
    const saved = store.getRecord(out.record.id);
    expect(saved?.outcome).toBe('failed');
    expect(saved?.attempts.map(a => [a.appId, a.outcome])).toEqual([
      ['cli_a', 'failed'],
      ['cli_b', 'skipped'],
    ]);
  });

  it('skips a candidate whose per-bot taskRouting.enabled is turned off mid-flight during preflight', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    const snaps = [makeSnapshot('cli_a', 'A', 'low'), makeSnapshot('cli_b', 'B', 'high')];
    const { eligible } = evaluateCandidates(snaps, {}, NOW);

    const out = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '测试单 bot 中途退出参与池',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_a',
          selectedName: 'A',
          fallbackOrder: ['cli_a', 'cli_b'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: 'rule',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store,
        now: () => NOW,
        preflightCandidate: async appId => {
          if (appId === 'cli_a') {
            return { ...snaps[0]!, profile: { enabled: false, costTier: 'low' } };
          }
          return snaps[1]!;
        },
        dispatchCandidate: async (cand, ctx) => {
          ctx.onChatCreated?.('oc_b_ok');
          return { ok: true, chatId: 'oc_b_ok', sessionId: `sess_${cand.appId}` };
        },
      },
    );

    expect(out.ok).toBe(true);
    expect(out.record.outcome).toBe('fallback_dispatched');
    expect(out.record.selectedAppId).toBe('cli_b');
    expect(out.record.attempts.map(a => [a.appId, a.outcome])).toEqual([
      ['cli_a', 'skipped'],
      ['cli_b', 'dispatched'],
    ]);
  });

  it('settles failed (never stuck pending) on unexpected throw and clears stale retryable targetChatId', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    const snaps = [makeSnapshot('cli_a', 'A', 'low'), makeSnapshot('cli_b', 'B', 'high')];
    const { eligible } = evaluateCandidates(snaps, {}, NOW);

    // Case 1: primary creates group then fails retryably; secondary throws before group creation -> both fail, top-level targetChatId cleared, orphaned chatId preserved in attempts[0]
    const out1 = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '测试异常收敛',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_a',
          selectedName: 'A',
          fallbackOrder: ['cli_a', 'cli_b'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: 'rule',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store,
        now: () => NOW,
        dispatchCandidate: async (cand, ctx) => {
          if (cand.appId === 'cli_a') {
            ctx.onChatCreated?.('oc_orphan_a');
            return { ok: false, retryable: true, chatId: 'oc_orphan_a', error: 'spawn refused' };
          }
          throw new Error('socket hang up');
        },
      },
    );
    expect(out1.ok).toBe(false);
    const saved1 = store.getRecord(out1.record.id);
    expect(saved1?.outcome).toBe('failed');
    expect(saved1?.targetChatId).toBeUndefined();
    expect(saved1?.attempts[0]?.chatId).toBe('oc_orphan_a');

    // Case 2: primary throws AFTER onChatCreated -> stops without invoking secondary, preserves targetChatId
    const called2: string[] = [];
    const out2 = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: '测试建群后抛异常',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_a',
          selectedName: 'A',
          fallbackOrder: ['cli_a', 'cli_b'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: 'rule',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store,
        now: () => NOW,
        dispatchCandidate: async (cand, ctx) => {
          called2.push(cand.appId);
          ctx.onChatCreated?.('oc_ambiguous_a');
          throw new Error('unexpected crash after group create');
        },
      },
    );
    expect(out2.ok).toBe(false);
    expect(called2).toEqual(['cli_a']);
    const saved2 = store.getRecord(out2.record.id);
    expect(saved2?.outcome).toBe('failed');
    expect(saved2?.targetChatId).toBe('oc_ambiguous_a');
  });

  it('createHostGroupDispatcher forwards all target ou_ owners and uses transferOwnerUnionId when only on_ exists', async () => {
    const createBodies: any[] = [];
    const runWithAllowed = async (resolvedAllowedUsers: string[]) => {
      const dispatcher = createHostGroupDispatcher({
        secret: 'test-secret',
        discoverDaemons: () => [{ larkAppId: 'cli_t', ipcPort: 19999 }],
        fetchIpc: async (_port, path, init) => {
          if (path === '/api/bot-default-oncall') {
            return new Response(JSON.stringify({ resolvedAllowedUsers }), { status: 200 });
          }
          if (path === '/api/groups/create') {
            createBodies.push(JSON.parse(String(init?.body ?? '{}')));
            return new Response(JSON.stringify({ ok: true, chatId: 'oc_g1' }), { status: 200 });
          }
          if (path === '/api/sessions/spawn') {
            return new Response(JSON.stringify({ ok: true, sessionId: 's_1' }), { status: 200 });
          }
          return new Response('{}', { status: 404 });
        },
      });
      await dispatcher({ appId: 'cli_t', name: 'T' }, { mode: 'group', task: 't', title: 'T' });
    };

    await runWithAllowed(['ou_owner1', 'ou_owner2', 'on_u1']);
    await runWithAllowed(['on_union_only']);

    expect(createBodies[0]).toMatchObject({
      userOpenIds: ['ou_owner1', 'ou_owner2'],
      transferOwnerTo: 'ou_owner1',
      ownerUnionIds: ['on_u1'],
    });
    expect(createBodies[1]).toMatchObject({
      userOpenIds: [],
      ownerUnionIds: ['on_union_only'],
      transferOwnerUnionId: 'on_union_only',
    });
    expect(createBodies[1].transferOwnerTo).toBeUndefined();
  });

  it('fails closed (retryable:false, zero double-dispatch) on group-create timeout and spawn mid-body abort/malformed 200', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir);
    const events: string[] = [];
    let mode: 'spawn_mid_body_timeout' | 'spawn_malformed_200' | 'create_timeout' = 'spawn_mid_body_timeout';

    const srv = createServer((req, res) => {
      events.push(`${req.method}:${req.url}`);
      if (req.url === '/api/bot-default-oncall') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resolvedAllowedUsers: ['ou_owner'] }));
        return;
      }
      if (req.url === '/api/groups/create') {
        if (mode === 'create_timeout') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"ok":true'); // stall mid-body past timeout
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, chatId: 'oc_real_1' }));
        return;
      }
      if (req.url === '/api/sessions/spawn') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'spawn_mid_body_timeout') {
          res.write('{"ok":true,"sess'); // stall mid-body past timeout
          return;
        }
        res.end('not-json-body');
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as AddressInfo).port;

    try {
      const dispatcher = createHostGroupDispatcher({
        secret: 'test-secret',
        discoverDaemons: () => [
          { larkAppId: 'cli_first', ipcPort: port },
          { larkAppId: 'cli_second', ipcPort: port },
        ],
        fetchIpc: fetchDaemonIpc,
        groupCreateTimeoutMs: 120,
        spawnTimeoutMs: 120,
      });

      const snaps = [makeSnapshot('cli_first', 'First', 'low'), makeSnapshot('cli_second', 'Second', 'high')];
      const { eligible } = evaluateCandidates(snaps, {}, NOW);

      for (const scenario of ['spawn_mid_body_timeout', 'spawn_malformed_200', 'create_timeout'] as const) {
        mode = scenario;
        events.length = 0;
        const out = await executeTaskRoutingRun(
          {
            mode: 'group',
            task: `at-most-once ${scenario}`,
            callerKind: 'host_cli',
            constraints: {},
            decision: {
              selectedAppId: 'cli_first',
              selectedName: 'First',
              fallbackOrder: ['cli_first', 'cli_second'],
              matcherKind: 'rule',
              confidence: 'medium',
              reason: 'rule',
              candidates: eligible,
              excluded: [],
            },
          },
          { store, now: () => NOW, dispatchCandidate: dispatcher },
        );
        expect(out.ok).toBe(false);
        expect(out.record.attempts).toHaveLength(1);
        expect(out.record.attempts[0]?.appId).toBe('cli_first');
        // Must NEVER fall back to cli_second after an ambiguous timeout or malformed 200!
        expect(events.filter(e => e === 'POST:/api/groups/create')).toHaveLength(1);
      }
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  it('preserves in-flight pending records across retention pruning, survives onChatCreated store errors, and handles 0-byte db files', async () => {
    const dataDir = makeDataDir();
    const store = new TaskRoutingStore(dataDir, { maxRecords: 10 });

    // Insert an in-flight pending record first, then flood with 15 settled records.
    store.insertRecord({
      id: 'tr_inflight_pending',
      createdAt: NOW,
      updatedAt: NOW,
      mode: 'group',
      taskSummary: 'slow in-flight',
      callerKind: 'host_cli',
      constraints: {},
      selectedAppId: 'cli_a',
      selectedName: 'A',
      matcherKind: 'rule',
      confidence: 'medium',
      reason: 'rule',
      candidates: [],
      excluded: [],
      attempts: [],
      outcome: 'pending',
    });
    for (let i = 0; i < 15; i++) {
      store.insertRecord({
        id: `tr_settled_${i}`,
        createdAt: NOW + (i + 1) * 1000,
        updatedAt: NOW + (i + 1) * 1000,
        mode: 'group',
        taskSummary: `settled ${i}`,
        callerKind: 'host_cli',
        constraints: {},
        selectedAppId: 'cli_a',
        selectedName: 'A',
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [],
        excluded: [],
        attempts: [],
        outcome: 'dispatched',
      });
    }
    expect(store.getRecord('tr_inflight_pending')?.outcome).toBe('pending');
    expect(store.settlePendingRecord('tr_inflight_pending', { outcome: 'dispatched', targetChatId: 'oc_ok' })).toBe(true);
    expect(store.settlePendingRecord('tr_inflight_pending', { outcome: 'failed' })).toBe(false);

    // Transient SQLITE_BUSY during onChatCreated must NOT abort spawn or throw uncaught.
    let spawnCalled = false;
    let updateCalls = 0;
    const flakyStore = Object.assign(Object.create(TaskRoutingStore.prototype), {
      insertRecord: (r: any) => store.insertRecord(r),
      updateRecord: (id: string, patch: any) => {
        updateCalls++;
        if (updateCalls === 1) throw new Error('SQLITE_BUSY: database is locked');
        return store.updateRecord(id, patch);
      },
      getRecord: (id: string) => store.getRecord(id),
    }) as TaskRoutingStore;
    const snaps = [makeSnapshot('cli_a', 'A', 'low')];
    const { eligible } = evaluateCandidates(snaps, {}, NOW);
    const out = await executeTaskRoutingRun(
      {
        mode: 'group',
        task: 'transient busy during checkpoint',
        callerKind: 'host_cli',
        constraints: {},
        decision: {
          selectedAppId: 'cli_a',
          selectedName: 'A',
          fallbackOrder: ['cli_a'],
          matcherKind: 'rule',
          confidence: 'medium',
          reason: 'rule',
          candidates: eligible,
          excluded: [],
        },
      },
      {
        store: flakyStore,
        now: () => NOW,
        dispatchCandidate: async (_cand, ctx) => {
          ctx.onChatCreated?.('oc_busy_ok');
          spawnCalled = true;
          return { ok: true, chatId: 'oc_busy_ok', sessionId: 'sess_busy_ok' };
        },
      },
    );
    expect(spawnCalled).toBe(true);
    expect(out.ok).toBe(true);
    expect(store.getRecord(out.record.id)?.outcome).toBe('dispatched');

    // 0-byte uninitialized sqlite file: updateRecord/settlePendingRecord return false without throwing.
    const emptyDir = makeDataDir();
    writeFileSync(taskRoutingDbPath(emptyDir), '');
    const emptyStore = new TaskRoutingStore(emptyDir);
    expect(emptyStore.listRecords()).toEqual([]);
    expect(emptyStore.getRecord('tr_none')).toBeNull();
    expect(emptyStore.updateRecord('tr_none', { outcome: 'failed' })).toBe(false);
    expect(emptyStore.settlePendingRecord('tr_none', { outcome: 'failed' })).toBe(false);
  });
});
