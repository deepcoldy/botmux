import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTest as resetAskBroker,
  invalidateHostAsk,
  registerHostAsk,
  setCanTalkChecker,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import type { AskResult, CreateAskInput } from '../src/core/ask-types.js';
import {
  buildCodexCapacityFallbackPrompt,
  CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
  CODEX_CAPACITY_FALLBACK_TURN_PREFIX,
  handleCodexCapacityRetry,
  MAX_CODEX_CAPACITY_HOPS,
  selectCodexCapacityFallbackModel,
  settleCodexCapacityFallback,
  type CodexCapacityFallbackDeps,
  type CodexCapacityFallbackTrigger,
} from '../src/core/codex-capacity-fallback.js';

const APP = 'cli_codex_cap';
const CHAT = 'oc_chat';
const HUMAN = 'ou_human';
const TURN = 'om_turn_1';

function fakeWorker(): any {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.exitCode = null;
  worker.signalCode = null;
  return worker;
}

function makeDs(overrides: Record<string, any> = {}, session: Record<string, any> = {}): any {
  const worker = fakeWorker();
  return {
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    worker,
    workerGeneration: 1,
    hasHistory: true,
    activeModel: 'gpt-6.1-sol',
    lastCliInputTurnId: TURN,
    lastUserPrompt: '帮我排查线上接口超时原因',
    activeInteractiveTurn: {
      turnId: TURN,
      caller: { requestUserOpenId: HUMAN, requestLarkAppId: APP, senderType: 'user' },
      userPrompt: '帮我排查线上接口超时原因',
    },
    session: {
      sessionId: 'sess-codex-cap',
      chatId: CHAT,
      rootMessageId: 'om_root',
      status: 'active',
      ownerOpenId: 'ou_owner',
      cliId: 'codex',
      model: 'gpt-6.1-sol',
      cliSessionId: '01a21656-47a5-7c23-94b6-464238559697',
      replyTargets: {
        [TURN]: {
          rootMessageId: 'om_root',
          senderOpenId: HUMAN,
          participants: [{ openId: HUMAN, isBot: false }],
          updatedAt: '2026-11-26T00:00:00.000Z',
        },
      },
      ...session,
    },
    ...overrides,
  };
}

function makeTrigger(ds: any, overrides: Partial<CodexCapacityFallbackTrigger> = {}) {
  const reply = vi.fn(async (_text: string) => 'om_notice');
  const trigger: CodexCapacityFallbackTrigger = {
    turnId: TURN,
    nativeSessionId: '01a21656-47a5-7c23-94b6-464238559697',
    model: 'gpt-6.1-sol',
    codexTurnId: 'codex-turn-1',
    retryAttempt: 1,
    maxRetries: 5,
    retryDelaySec: 370,
    observedAtMs: 1795673295_000,
    worker: ds.worker,
    reply,
    ...overrides,
  };
  return { trigger, reply };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('selectCodexCapacityFallbackModel', () => {
  const catalog = ['gpt-6.1-sol', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini'];

  it('picks the next lower model along Codex priority ladder', () => {
    expect(selectCodexCapacityFallbackModel({
      currentModel: 'gpt-6.1-sol',
      availableModels: catalog,
    })).toBe('gpt-5.4');
  });

  it('prefers live botCfg.model when present in catalog and not overloaded', () => {
    expect(selectCodexCapacityFallbackModel({
      currentModel: 'gpt-6.1-sol',
      availableModels: catalog,
      preferredModel: 'gpt-5.3-codex',
    })).toBe('gpt-5.3-codex');
  });

  it('skips previously overloaded models case-insensitively and wraps when at bottom', () => {
    expect(selectCodexCapacityFallbackModel({
      currentModel: 'gpt-5.4',
      availableModels: catalog,
      excludedModels: new Set(['GPT-6.1-SOL', 'gpt-5.3-codex']),
    })).toBe('gpt-5.4-mini');

    expect(selectCodexCapacityFallbackModel({
      currentModel: 'gpt-5.4-mini',
      availableModels: catalog,
      excludedModels: new Set(['gpt-6.1-sol']),
    })).toBe('gpt-5.4');
  });

  it('returns undefined when no valid non-excluded model remains', () => {
    expect(selectCodexCapacityFallbackModel({
      currentModel: 'gpt-6.1-sol',
      availableModels: ['gpt-6.1-sol', 'bad model slug!'],
    })).toBeUndefined();
  });
});

describe('buildCodexCapacityFallbackPrompt', () => {
  it('formats zh and en continuation prompts with side-effect guard and original request', () => {
    const zh = buildCodexCapacityFallbackPrompt({
      fromModel: 'gpt-6.1-sol',
      toModel: 'gpt-5.4',
      userPrompt: '检查构建日志',
      locale: 'zh',
    });
    expect(zh).toContain('gpt-6.1-sol');
    expect(zh).toContain('gpt-5.4');
    expect(zh).toContain('不要重复执行');
    expect(zh).toContain('检查构建日志');

    const en = buildCodexCapacityFallbackPrompt({
      fromModel: 'gpt-6.1-sol',
      toModel: 'gpt-5.4',
      userPrompt: 'Check the build log',
      locale: 'en',
    });
    expect(en).toContain('gpt-6.1-sol');
    expect(en).toContain('gpt-5.4');
    expect(en).toContain('do not repeat side-effecting operations');
    expect(en).toContain('Check the build log');
  });
});

describe('invalidateHostAsk', () => {
  beforeEach(() => {
    resetAskBroker();
    setCanTalkChecker(() => true);
    setCardDispatcher({
      async send(ask) { return { messageId: `om_card_${ask.askId}` }; },
    });
  });

  afterEach(() => {
    resetAskBroker();
  });

  it('invalidates an active host_* ask by scoped identity and rejects non-host origins', async () => {
    const promise = registerHostAsk({
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      originKind: CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
      requestId: 'req-1',
      timeoutMs: 60_000,
      questions: [{ prompt: 'downgrade?', multiSelect: false, options: [{ key: 'temporary', label: 'Switch' }] }],
    });
    await Promise.resolve();

    expect(invalidateHostAsk({
      larkAppId: APP,
      sessionId: 'sess-1',
      originKind: 'agent_explicit',
      requestId: 'req-1',
    }, 'wrong_origin')).toBe(false);

    expect(invalidateHostAsk({
      larkAppId: APP,
      sessionId: 'sess-1',
      originKind: CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
      requestId: 'req-1',
    }, 'turn_terminal:completed')).toBe(true);

    const res = await promise;
    expect(res.kind).toBe('invalidated');
    if (res.kind === 'invalidated') {
      expect(res.reason).toBe('turn_terminal:completed');
    }

    // Already settled -> false
    expect(invalidateHostAsk({
      larkAppId: APP,
      sessionId: 'sess-1',
      originKind: CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
      requestId: 'req-1',
    }, 'second')).toBe(false);
  });
});

describe('handleCodexCapacityRetry', () => {
  function makeDeps(ds: any, overrides: Partial<CodexCapacityFallbackDeps> = {}) {
    const askInputs: CreateAskInput[] = [];
    const invalidated: Array<{ target: any; reason: string }> = [];
    const killed: any[] = [];
    const destroyedPanes: any[] = [];
    const updatedSessions: Array<{ session: any; opts: any }> = [];
    const publishedUpdates: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const nextWorker = fakeWorker();
    const forkedCalls: any[] = [];

    const deps: CodexCapacityFallbackDeps = {
      getBotConfig: () => ({
        larkAppId: APP,
        larkAppSecret: 'secret',
        cliId: 'codex',
        model: 'gpt-6.1-sol',
      } as any),
      getLocale: () => 'zh',
      modelChoices: async () => ['gpt-6.1-sol', 'gpt-5.4', 'gpt-5.3-codex'],
      registerAsk: async (input) => {
        askInputs.push(input);
        return { kind: 'answered', answers: [['temporary']], by: HUMAN, comment: null, timedOut: false };
      },
      invalidateAsk: (target, reason) => {
        invalidated.push({ target, reason });
        return true;
      },
      canOperate: () => true,
      findActive: (sid) => (sid === ds.session.sessionId ? ds : undefined),
      withBotTurnMutation: async (_appId, _timeoutMs, fn) => ({ acquired: true, value: await fn() }),
      killWorker: ((targetDs: any) => {
        killed.push(targetDs);
        const old = targetDs.worker;
        targetDs.worker = null;
        queueMicrotask(() => old?.emit('exit', 0));
      }) as any,
      waitForWorkerExit: (async (worker: any) => {
        if (worker) await new Promise<void>(resolve => worker.once('exit', () => resolve()));
        return true;
      }) as any,
      destroyLivePaneBeforeRestart: ((targetDs: any) => { destroyedPanes.push(targetDs); }) as any,
      forkWorker: ((targetDs: any, input: any, opts: any) => {
        forkedCalls.push({ input, opts, spawnModelOverride: targetDs.spawnModelOverride, modelPin: targetDs.session.modelPin });
        targetDs.worker = nextWorker;
        return true;
      }) as any,
      prepareRecoveryIdentity: async () => {},
      updateSession: ((session: any, opts?: any) => {
        updatedSessions.push({ session: structuredClone(session), opts });
      }) as any,
      buildFollowUpInput: ((prompt: string) => ({ content: `<follow-up>${prompt}` })) as any,
      rememberLastInput: ((targetDs: any, userPrompt: string, input: any, turnId: string) => {
        targetDs.lastUserPrompt = userPrompt;
        targetDs.lastCliInput = input.content;
        targetDs.lastCliInputTurnId = turnId;
      }) as any,
      noteTurnStarted: () => {},
      persistStreamCard: () => {},
      publishSessionUpdate: (sessionId, patch) => { publishedUpdates.push({ sessionId, patch }); },
      isTransferring: () => false,
      isRestartInFlight: () => false,
      hasProtectedOwnership: () => false,
      resolveCaller: () => ({ requestUserOpenId: HUMAN, requestLarkAppId: APP, senderType: 'user' } as any),
      ...overrides,
    };

    return {
      deps,
      askInputs,
      invalidated,
      killed,
      destroyedPanes,
      updatedSessions,
      publishedUpdates,
      forkedCalls,
      nextWorker,
    };
  }

  it('temporarily downgrades on user confirmation, resumes native Codex session, and carries overloadedModels across hops', async () => {
    const ds = makeDs({}, { lastAttachments: [{ type: 'file', path: '/tmp/a.log' }] });
    const harness = makeDeps(ds);
    const { trigger, reply } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(harness.askInputs).toHaveLength(1);
    expect(harness.askInputs[0]?.originKind).toBe(CODEX_CAPACITY_FALLBACK_ASK_ORIGIN);
    expect(harness.askInputs[0]?.answererOpenId).toBe(HUMAN);
    expect(harness.askInputs[0]?.questions[0]?.options.map(o => o.key)).toEqual(['temporary', 'pin', 'wait']);

    expect(harness.killed).toHaveLength(1);
    expect(harness.destroyedPanes).toHaveLength(1);
    expect(harness.forkedCalls).toHaveLength(1);

    const fork = harness.forkedCalls[0];
    expect(fork.spawnModelOverride).toBe('gpt-5.4');
    expect(fork.modelPin).toBeUndefined();
    expect(fork.opts.resume).toBe(true);
    expect(fork.opts.turnId).toMatch(new RegExp(`^${CODEX_CAPACITY_FALLBACK_TURN_PREFIX}`));
    expect(fork.input.content).toContain('gpt-6.1-sol');
    expect(fork.input.content).toContain('gpt-5.4');
    expect(fork.input.content).toContain('帮我排查线上接口超时原因');
    expect(fork.input.attachments).toEqual([{ type: 'file', path: '/tmp/a.log' }]);
    expect(ds.session.cliSessionId).toBe('01a21656-47a5-7c23-94b6-464238559697');
    expect(ds.codexCapacityFallback?.overloadedModels).toEqual(['gpt-6.1-sol']);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('临时降级'));

    // Second hop: if gpt-5.4 is ALSO at capacity on the resumed turn, it must pick gpt-5.3-codex, not bounce back to gpt-6.1-sol.
    const nextTurnId = ds.lastCliInputTurnId;
    const { trigger: trigger2 } = makeTrigger(ds, {
      turnId: nextTurnId,
      model: 'gpt-5.4',
      worker: ds.worker,
    });
    expect(handleCodexCapacityRetry(ds, trigger2, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(harness.askInputs).toHaveLength(2);
    expect(harness.askInputs[1]?.requestId).toBe(`${nextTurnId}:gpt-5.4:gpt-5.3-codex`);
    expect(harness.forkedCalls[1]?.spawnModelOverride).toBe('gpt-5.3-codex');
  });

  it('pins the fallback model for the topic when user chooses pin and has operate permission', async () => {
    const ds = makeDs({}, {
      modelPin: { model: 'gpt-6.1-sol', effort: 'high', source: 'card', setBy: HUMAN, setAt: '2026-11-25T00:00:00.000Z' },
    });
    const harness = makeDeps(ds, {
      registerAsk: async (input) => {
        harness.askInputs.push(input);
        return { kind: 'answered', answers: [['pin']], by: HUMAN, comment: null, timedOut: false };
      },
    });
    const { trigger, reply } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(ds.session.modelPin?.model).toBe('gpt-5.4');
    expect(ds.session.modelPin?.setBy).toBe(HUMAN);
    expect(ds.spawnModelOverride).toBeUndefined();
    expect(harness.publishedUpdates).toHaveLength(1);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('固定本话题'));
  });

  it('rejects pin choice when clicking user lacks operate permission', async () => {
    const ds = makeDs();
    const harness = makeDeps(ds, {
      canOperate: () => false,
      registerAsk: async () => ({ kind: 'answered', answers: [['pin']], by: 'ou_guest', comment: null, timedOut: false }),
    });
    const { trigger, reply } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(harness.killed).toHaveLength(0);
    expect(harness.forkedCalls).toHaveLength(0);
    expect(ds.codexCapacityFallback?.declinedForTurn).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('无权修改本话题固定模型'));
  });

  it('honors wait choice and suppresses duplicate prompts for the same turn', async () => {
    const ds = makeDs();
    const harness = makeDeps(ds, {
      registerAsk: async (input) => {
        harness.askInputs.push(input);
        return { kind: 'answered', answers: [['wait']], by: HUMAN, comment: null, timedOut: false };
      },
    });
    const { trigger, reply } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(harness.killed).toHaveLength(0);
    expect(ds.codexCapacityFallback?.declinedForTurn).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('继续排队等待'));

    // A later retry on the same turn is ignored once user chose wait.
    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(false);
    expect(harness.askInputs).toHaveLength(1);
  });

  it('deduplicates concurrent retries while model catalog lookup is still resolving', async () => {
    const ds = makeDs();
    let releaseCatalog!: (models: string[]) => void;
    const catalogPromise = new Promise<string[]>(resolve => { releaseCatalog = resolve; });
    const harness = makeDeps(ds, {
      modelChoices: () => catalogPromise,
      registerAsk: async (input) => {
        harness.askInputs.push(input);
        return { kind: 'answered', answers: [['wait']], by: HUMAN, comment: null, timedOut: false };
      },
    });
    const { trigger } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    // Second retry arrives before modelChoices resolves — must be rejected via resolving guard.
    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(false);

    releaseCatalog(['gpt-6.1-sol', 'gpt-5.4']);
    await flushMicrotasks();
    expect(harness.askInputs).toHaveLength(1);
  });

  it('restores launch and routing state atomically if forkWorker fails after retirement', async () => {
    const ds = makeDs({ spawnModelOverride: 'gpt-6.1-sol' });
    const harness = makeDeps(ds, {
      forkWorker: (() => false) as any,
    });
    const { trigger, reply } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();

    expect(ds.spawnModelOverride).toBe('gpt-6.1-sol');
    expect(ds.activeInteractiveTurn?.turnId).toBe(TURN);
    expect(ds.codexCapacityFallback?.declinedForTurn).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('失败'));
  });

  it('invalidates an open confirmation card when the turn settles on its own', async () => {
    const ds = makeDs();
    let resolveAsk!: (res: AskResult) => void;
    const harness = makeDeps(ds, {
      registerAsk: async (input) => {
        harness.askInputs.push(input);
        return new Promise<AskResult>(resolve => { resolveAsk = resolve; });
      },
    });
    const { trigger } = makeTrigger(ds);

    expect(handleCodexCapacityRetry(ds, trigger, harness.deps)).toBe(true);
    await flushMicrotasks();
    expect(ds.codexCapacityFallback?.pendingAsk).toBeDefined();

    settleCodexCapacityFallback(ds, 'turn_terminal:completed', TURN, { invalidateAsk: harness.deps.invalidateAsk });
    expect(harness.invalidated).toHaveLength(1);
    expect(harness.invalidated[0]?.reason).toBe('turn_terminal:completed');
    expect(ds.codexCapacityFallback).toBeUndefined();

    resolveAsk({ kind: 'invalidated', reason: 'turn_terminal:completed', selected: null, by: null, comment: null, timedOut: false });
    await flushMicrotasks();
    expect(harness.killed).toHaveLength(0);
  });

  it('rejects ineligible sessions and enforces MAX_CODEX_CAPACITY_HOPS', () => {
    const nonCodex = makeDs({}, { cliId: 'claude-code' });
    expect(handleCodexCapacityRetry(nonCodex, makeTrigger(nonCodex).trigger, makeDeps(nonCodex).deps)).toBe(false);

    const adopted = makeDs({ adoptedFrom: { pid: 123 } });
    expect(handleCodexCapacityRetry(adopted, makeTrigger(adopted).trigger, makeDeps(adopted).deps)).toBe(false);

    const maxHops = makeDs();
    maxHops.codexCapacityFallback = {
      sourceTurnId: TURN,
      logicalTurnId: TURN,
      worker: maxHops.worker,
      overloadedModels: Array.from({ length: MAX_CODEX_CAPACITY_HOPS }, (_, i) => `gpt-m${i}`),
    };
    expect(handleCodexCapacityRetry(maxHops, makeTrigger(maxHops).trigger, makeDeps(maxHops).deps)).toBe(false);
  });
});
