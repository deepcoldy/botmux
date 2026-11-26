import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerAsk,
  registerHostAsk,
  restorePersistedAsks,
  startHookAskReclaim,
  toggleAsk,
  tryResolveAsk,
  submitAskChoices,
  submitCustomReply,
  submitDocumentAskReply,
  findPendingAskByAnchor,
  findPendingLegacyAskByCard,
  hydrateLegacyExplicitAskCardRoot,
  listPendingAsksByAnchor,
  setCardDispatcher,
  setCanTalkChecker,
  setAskPersistStore,
  _getPending,
  _resetForTest,
  _setHookReclaimGraceForTest,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, askKeyFor, dispatchUuidForAsk, ASK_STORE_SENTINEL, type PersistedAsk } from '../src/core/ask-persist-store.js';
import { createExplicitAskContinuation } from '../src/core/explicit-ask-continuation.js';
import type { AskCardDispatcher, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

/**
 * Restart-resume for `botmux ask` — the AskUserQuestion picker-desync root fix,
 * hardened per codex's REQUEST_CHANGES. Covers BOTH restart orderings:
 *   - reattach → click  (hook reconnects first, then user answers)
 *   - click → reattach  (user answers the dormant card first — durable handoff)
 * plus card re-send when the restart lands before cardMessageId was recorded,
 * request-id/originKind identity, and dependency-injected store isolation.
 */

const OPTIONS = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '回滚' },
];

function makeInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    requestId: 'req-1',
    originKind: 'hook',
    backendSurvivesRestart: true, // tmux-backed hook: resumable (daemon-computed)
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
    timeoutMs: 60_000,
    ...over,
  };
}

/** Dispatcher that records sends and lets a test control the returned messageId
 *  (default: undefined-safe id). Also records onSettle for card-flip assertions. */
function mockDispatcher(sendImpl?: (ask: PendingAsk) => Promise<{ messageId?: string }>): AskCardDispatcher & {
  sendCalls: PendingAsk[];
  settleCalls: AskResult[];
} {
  const sendCalls: PendingAsk[] = [];
  const settleCalls: AskResult[] = [];
  return {
    async send(ask) { sendCalls.push(ask); return sendImpl ? sendImpl(ask) : { messageId: `om_card_${ask.askId}` }; },
    onSettle(_ask, result) { settleCalls.push(result); },
    sendCalls,
    settleCalls,
  };
}

let dataDir: string;
let prevDataDir: string | undefined;

/** Rebind a fresh injected store on the broker after a simulated restart. */
function bindStore() {
  setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
}

beforeEach(() => {
  prevDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-resume-'));
  _resetForTest();          // detaches store (never deletes)
  bindStore();
  setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  // Teardown deletes ONLY this test's own temp dir, and only if it carries the
  // store sentinel (guard against ever reaping a shared/real dir — codex P1-4).
  const store = join(dataDir, 'asks');
  if (existsSync(join(store, ASK_STORE_SENTINEL)) || !existsSync(store)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

function persistedFiles(): string[] {
  const dir = join(dataDir, 'asks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json'));
}

/** Read the single persisted ask record (fails if not exactly one). */
function onlyPersisted(): PersistedAsk {
  const files = persistedFiles();
  if (files.length !== 1) throw new Error(`expected 1 persisted ask, got ${files.length}`);
  return JSON.parse(readFileSync(join(dataDir, 'asks', files[0]), 'utf-8')) as PersistedAsk;
}

describe('ask persistence (injected store)', () => {
  it('群会话的提问话题在恢复与重连后保留，文字候选仍按原始话题隔离', async () => {
    const input = makeInput({ rootMessageId: null, cardRootMessageId: 'om_ask_topic' });
    const first = mockDispatcher();
    setCardDispatcher(first);
    registerAsk(input);
    await vi.waitFor(() => expect(onlyPersisted().cardMessageId).toBeDefined());
    expect(onlyPersisted()).toMatchObject({ cardRootMessageId: 'om_ask_topic', topicIsolated: true });
    const original = first.sendCalls[0]!;
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const waiting = registerAsk(input);
    const route = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' };
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_other_topic' })).toEqual([]);
    expect(listPendingAsksByAnchor({ ...route, messageRootId: null })).toEqual([]);
    const found = findPendingAskByAnchor({ ...route, messageRootId: 'om_ask_topic' });
    expect(found?.askId).toBe(original.askId);
    expect(submitCustomReply({ askId: found!.askId, by: 'ou_owner', text: '同话题答案' })).toBe('accepted');
    expect(await waiting).toMatchObject({ kind: 'answered', comment: '同话题答案' });
  });

  it('新版群外层 ask 落盘携带显式隔离标记，经历一/二次重启及重新落盘后仍严格按群外层隔离', async () => {
    const input = makeInput({
      rootMessageId: null,
      originKind: 'host_explicit',
      requestId: 'req-outer-explicit',
      questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: true }],
    });
    const first = mockDispatcher();
    setCardDispatcher(first);
    void registerHostAsk(input);
    await vi.waitFor(() => expect(onlyPersisted().cardMessageId).toBeDefined());
    const disk1 = onlyPersisted();
    expect(disk1.cardRootMessageId).toBeUndefined();
    expect(disk1.topicIsolated).toBe(true);
    const original = first.sendCalls[0]!;

    // 1st restart: restore without reattach (host_explicit is active immediately)
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const route = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' };
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_topic_a' })).toEqual([]);
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_topic_a' })).toBeUndefined();
    expect(findPendingAskByAnchor({ ...route, messageRootId: null })?.askId).toBe(original.askId);

    // Re-persist via toggleAsk and submitAskChoices(needs_empty_confirm), then 2nd restart.
    expect(toggleAsk({ askId: original.askId, nonce: original.nonce, questionIndex: 0, key: 'yes', by: 'ou_owner' })).toBe('toggled');
    expect(onlyPersisted().topicIsolated).toBe(true);
    expect(submitAskChoices({ askId: original.askId, nonce: original.nonce, by: 'ou_owner', selections: [[]], fields: {}, revision: 0 })).toBe('needs_empty_confirm');
    expect(onlyPersisted().topicIsolated).toBe(true);

    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const reattached = registerHostAsk(input);
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_topic_a' })).toEqual([]);
    const found = findPendingAskByAnchor({ ...route, messageRootId: null });
    expect(found?.askId).toBe(original.askId);
    expect(submitCustomReply({ askId: found!.askId, by: 'ou_owner', text: '群外层答复' })).toBe('accepted');
    expect(await reattached).toMatchObject({ kind: 'answered', comment: '群外层答复' });
  });

  it('新版群会话话题内 host_explicit ask 经无 presentation 重连与二次重启后仍保留冻结话题隔离', async () => {
    const baseInput = makeInput({
      rootMessageId: null,
      originKind: 'host_explicit',
      requestId: 'req-topic-explicit',
      questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: true }],
    });
    const first = mockDispatcher();
    setCardDispatcher(first);
    void registerHostAsk({ ...baseInput, cardRootMessageId: 'om_ask_topic' });
    await vi.waitFor(() => expect(onlyPersisted().cardMessageId).toBeDefined());
    expect(onlyPersisted()).toMatchObject({ cardRootMessageId: 'om_ask_topic', topicIsolated: true });
    const original = first.sendCalls[0]!;

    // 1st restart + sweep-style reattach without cardRootMessageId
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    void registerHostAsk(baseInput); // omits cardRootMessageId like explicitAskContinuation.sweep()
    expect(toggleAsk({ askId: original.askId, nonce: original.nonce, questionIndex: 0, key: 'yes', by: 'ou_owner' })).toBe('toggled');
    expect(onlyPersisted()).toMatchObject({ cardRootMessageId: 'om_ask_topic', topicIsolated: true });

    // 2nd restart: still strictly isolated to om_ask_topic
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    const route = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' };
    expect(listPendingAsksByAnchor({ ...route, messageRootId: null })).toEqual([]);
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_other_topic' })).toEqual([]);
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_ask_topic' })?.askId).toBe(original.askId);
  });

  it('旧版 v2 无隔离标记的 hook 记录：dormant 期不收文字，无 cardRoot 重连走兼容回退，带 cardRoot 重连自动升级隔离', async () => {
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const now = Date.now();
    const legacyHookBase = (requestId: string, askId: string): PersistedAsk => ({
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-1', 'hook', requestId),
      requestId,
      originKind: 'hook',
      askId,
      nonce: 'n_legacy',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: null,
      sessionId: 'sess-1',
      chatType: 'group',
      questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
      createdAt: now - 1000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      cardMessageId: `om_card_${askId}`,
      selections: [[]],
    });
    const route = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' };

    // Case A: legacy hook reconnects WITHOUT cardRootMessageId -> keeps legacy pre-upgrade fallback
    store.put(legacyHookBase('legacy-hook-fallback', 'ask-legacy-hook-a'));
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    // Still dormant -> must NOT match text before hook reconnects
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_orig_topic' })).toEqual([]);
    expect(listPendingAsksByAnchor({ ...route, messageRootId: null })).toEqual([]);

    const waitingA = registerAsk(makeInput({ rootMessageId: null, requestId: 'legacy-hook-fallback' }));
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_orig_topic' })?.askId).toBe('ask-legacy-hook-a');
    expect(findPendingAskByAnchor({ ...route, messageRootId: null })?.askId).toBe('ask-legacy-hook-a');
    expect(submitCustomReply({ askId: 'ask-legacy-hook-a', by: 'ou_owner', text: '旧记录原话题答复' })).toBe('accepted');
    expect(await waitingA).toMatchObject({ kind: 'answered', comment: '旧记录原话题答复' });

    // Case B: legacy hook reconnects WITH cardRootMessageId -> hydrates and upgrades to strict topic isolation
    store.put(legacyHookBase('legacy-hook-hydrate', 'ask-legacy-hook-b'));
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    const waitingB = registerAsk(makeInput({ rootMessageId: null, requestId: 'legacy-hook-hydrate', cardRootMessageId: 'om_hydrated_topic' }));
    expect(onlyPersisted()).toMatchObject({ cardRootMessageId: 'om_hydrated_topic', topicIsolated: true });
    expect(listPendingAsksByAnchor({ ...route, messageRootId: null })).toEqual([]);
    expect(listPendingAsksByAnchor({ ...route, messageRootId: 'om_other_topic' })).toEqual([]);
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_hydrated_topic' })?.askId).toBe('ask-legacy-hook-b');
    expect(submitCustomReply({ askId: 'ask-legacy-hook-b', by: 'ou_owner', text: '升级后精确答复' })).toBe('accepted');
    expect(await waitingB).toMatchObject({ kind: 'answered', comment: '升级后精确答复' });
  });

  it('旧版 v2 host_explicit 记录恢复后无需重连即生效，且经 toggle/answer-stash 再次落盘与二次重启后保持兼容形状', async () => {
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const now = Date.now();
    const requestId = 'legacy-explicit-1';
    const legacyExplicit: PersistedAsk = {
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-1', 'host_explicit', requestId),
      requestId,
      originKind: 'host_explicit',
      askId: 'ask-legacy-explicit',
      nonce: 'n_exp',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: null,
      sessionId: 'sess-1',
      chatType: 'group',
      questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: true }],
      createdAt: now - 1000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      timeoutStartedAt: now - 900,
      cardMessageId: 'om_card_legacy_explicit',
      selections: [[]],
    };
    store.put(legacyExplicit);

    // 1st restart: NO reattach! host_explicit is immediately eligible via legacy fallback.
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    const route = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' };
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_orig_topic' })?.askId).toBe('ask-legacy-explicit');
    expect(findPendingAskByAnchor({ ...route, messageRootId: null })?.askId).toBe('ask-legacy-explicit');

    // Re-persist via toggleAsk -> must NOT stamp topicIsolated: true
    expect(toggleAsk({ askId: 'ask-legacy-explicit', nonce: 'n_exp', questionIndex: 0, key: 'yes', by: 'ou_owner' })).toBe('toggled');
    expect(onlyPersisted().topicIsolated).toBeUndefined();

    // 2nd restart: legacy compatibility still preserved; answer while dormant stashes without losing shape
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    expect(findPendingAskByAnchor({ ...route, messageRootId: 'om_orig_topic' })?.askId).toBe('ask-legacy-explicit');
    expect(submitCustomReply({ askId: 'ask-legacy-explicit', by: 'ou_owner', text: '旧显式原话题答复' })).toBe('accepted');
    const stashed = onlyPersisted();
    expect(stashed.topicIsolated).toBeUndefined();
    expect(stashed.answeredResult).toMatchObject({ kind: 'answered', comment: '旧显式原话题答复' });

    // 3rd restart: claimant reconnects and receives stashed answer
    _resetForTest();
    bindStore();
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    const claimed = await registerHostAsk(makeInput({
      rootMessageId: null,
      originKind: 'host_explicit',
      requestId,
      questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: true }],
    }));
    expect(claimed).toMatchObject({ kind: 'answered', comment: '旧显式原话题答复' });
  });

  it('旧版 v2 chat-scope 记录与新版精确话题 ask 共存时，精确匹配优先且不串进独立 thread/私聊子话题，显式引用旧卡仍可命中', async () => {
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const now = Date.now();
    store.put({
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-legacy', 'host_explicit', 'legacy-coexist'),
      requestId: 'legacy-coexist',
      originKind: 'host_explicit',
      askId: 'ask-legacy-coexist',
      nonce: 'n_coex',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: null,
      sessionId: 'sess-legacy',
      chatType: 'group',
      questions: [{ prompt: '旧提问？', options: OPTIONS, multiSelect: false }],
      createdAt: now - 2000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      timeoutStartedAt: now - 1900,
      cardMessageId: 'om_legacy_card_coexist',
      selections: [[]],
    });
    // Also seed a legacy v2 p2p ask: must NOT turn into wildcard for /t DM topics
    store.put({
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-dm', 'host_explicit', 'legacy-dm'),
      requestId: 'legacy-dm',
      originKind: 'host_explicit',
      askId: 'ask-legacy-dm',
      nonce: 'n_dm',
      larkAppId: 'cli_app',
      chatId: 'oc_dm',
      rootMessageId: null,
      sessionId: 'sess-dm',
      chatType: 'p2p',
      questions: [{ prompt: '旧私聊？', options: OPTIONS, multiSelect: false }],
      createdAt: now - 2000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      timeoutStartedAt: now - 1900,
      cardMessageId: 'om_legacy_dm_card',
      selections: [[]],
    });

    _resetForTest();
    bindStore();
    const d = mockDispatcher();
    setCardDispatcher(d);
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(2);

    // 1. Independent thread-scope session (anchor !== chatId) is NOT shadowed by legacy chat-scope ask.
    expect(listPendingAsksByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'om_indep_topic', messageRootId: 'om_indep_topic' })).toEqual([]);
    // 2. Legacy p2p ask matches continuous DM (anchor=oc_dm) but NOT explicit /t DM topic (anchor=om_dm_sub).
    expect(findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_dm', anchor: 'oc_dm' })?.askId).toBe('ask-legacy-dm');
    expect(findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_dm', anchor: 'om_dm_sub' })).toBeUndefined();

    // 3. New exact-location folded topic ask in the same chat-scope session takes precedence over legacy ask.
    void registerAsk(makeInput({
      rootMessageId: null,
      cardRootMessageId: 'om_topic_a',
      sessionId: 'sess-new',
      requestId: 'new-topic-a',
    }));
    await vi.waitFor(() => expect(d.sendCalls).toHaveLength(1));
    const newTopicAskId = d.sendCalls[0]!.askId;
    const foldedRoute = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_topic_a' };
    expect(listPendingAsksByAnchor(foldedRoute).map(a => a.askId)).toEqual([newTopicAskId]);
    expect(findPendingAskByAnchor(foldedRoute)?.askId).toBe(newTopicAskId);

    // 4. Unrelated folded topic with NO exact ask still falls back to legacy ask; quoting legacy card explicitly still resolves it.
    expect(findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_legacy_only_topic' })?.askId)
      .toBe('ask-legacy-coexist');
    expect(findPendingLegacyAskByCard({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', cardMessageId: 'om_legacy_card_coexist' })?.askId)
      .toBe('ask-legacy-coexist');
  });

  it('旧版 v2 host_explicit 经 explicitAskContinuation sweep 与重连（含未发卡重发与 active replay）自动回填 cardRootMessageId', async () => {
    const store = createAskPersistStore(join(dataDir, 'asks'));
    const receiptsDir = join(dataDir, 'receipts');
    const now = Date.now();

    // Case A: undelivered legacy v2 host_explicit hydrated by sweep(resolveCardRoot) BEFORE card resend
    const inputA: CreateAskInput & { requestId: string } = {
      ...makeInput({ rootMessageId: null, originKind: 'host_explicit', requestId: 'legacy-exp-sweep' }),
      requestId: 'legacy-exp-sweep',
    };
    const contInit = createExplicitAskContinuation({
      dir: receiptsDir, appId: 'cli_app',
      register: () => new Promise(() => {}),
      canResume: () => false, dispatch: async () => false, onError: () => {},
    });
    void contInit.wait(inputA, { turnId: 'turn-A' });
    store.put({
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-1', 'host_explicit', 'legacy-exp-sweep'),
      requestId: 'legacy-exp-sweep',
      originKind: 'host_explicit',
      askId: 'ask-legacy-exp-sweep',
      nonce: 'n_sw',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: null,
      sessionId: 'sess-1',
      chatType: 'group',
      questions: inputA.questions,
      createdAt: now - 1000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      selections: [[]],
    });

    _resetForTest();
    bindStore();
    const d = mockDispatcher();
    setCardDispatcher(d);
    setCanTalkChecker(() => true);
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);

    const contRecovered = createExplicitAskContinuation({
      dir: receiptsDir, appId: 'cli_app',
      register: registerHostAsk,
      resolveCardRoot: receipt => receipt.origin?.turnId === 'turn-A' ? 'om_hydrated_exp_topic' : undefined,
      hydrateCardRoot: hydrateLegacyExplicitAskCardRoot,
      canResume: () => true, dispatch: async () => false, onError: err => { throw err; },
    });
    await contRecovered.sweep();
    await vi.waitFor(() => expect(onlyPersisted().cardMessageId).toBeDefined());

    expect(d.sendCalls).toHaveLength(1);
    expect(d.sendCalls[0]!.cardRootMessageId).toBe('om_hydrated_exp_topic');
    expect(onlyPersisted()).toMatchObject({ cardRootMessageId: 'om_hydrated_exp_topic', topicIsolated: true });
    expect(listPendingAsksByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_other' })).toEqual([]);
    expect(findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_hydrated_exp_topic' })?.askId)
      .toBe('ask-legacy-exp-sweep');

    // Case B: already-running legacy host_explicit (sweep had no resolveCardRoot) hydrated when CLI reconnects with presentation
    _resetForTest();
    const inputB: CreateAskInput & { requestId: string } = {
      ...makeInput({ rootMessageId: null, originKind: 'host_explicit', requestId: 'legacy-exp-join' }),
      requestId: 'legacy-exp-join',
    };
    const receiptsDirB = join(dataDir, 'receipts-b');
    const storeB = createAskPersistStore(join(dataDir, 'asks-b'));
    setAskPersistStore(storeB);
    setCardDispatcher(mockDispatcher());
    setCanTalkChecker(() => true);
    const contBInit = createExplicitAskContinuation({
      dir: receiptsDirB, appId: 'cli_app',
      register: () => new Promise(() => {}),
      canResume: () => false, dispatch: async () => false, onError: () => {},
    });
    void contBInit.wait(inputB);
    storeB.put({
      v: 2,
      askKey: askKeyFor('cli_app', 'sess-1', 'host_explicit', 'legacy-exp-join'),
      requestId: 'legacy-exp-join',
      originKind: 'host_explicit',
      askId: 'ask-legacy-exp-join',
      nonce: 'n_jn',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: null,
      sessionId: 'sess-1',
      chatType: 'group',
      questions: inputB.questions,
      createdAt: now - 1000,
      deadlineAt: now + 60_000,
      timeoutMs: 60_000,
      timeoutStartsAfterDelivery: true,
      timeoutStartedAt: now - 900,
      cardMessageId: 'om_card_join',
      selections: [[]],
    });
    expect(restorePersistedAsks(now, 'cli_app')).toBe(1);
    const contB = createExplicitAskContinuation({
      dir: receiptsDirB, appId: 'cli_app',
      register: registerHostAsk,
      hydrateCardRoot: hydrateLegacyExplicitAskCardRoot,
      canResume: () => true, dispatch: async () => false, onError: err => { throw err; },
    });
    await contB.sweep(); // flips dormant=false and caches promise in running
    void contB.wait(inputB, undefined, { cardRootMessageId: 'om_joined_topic' });
    expect(listPendingAsksByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_other' })).toEqual([]);
    expect(findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat', messageRootId: 'om_joined_topic' })?.askId)
      .toBe('ask-legacy-exp-join');
  });

  it('preserves document recipient, responder lock and exact-card text routing across restart', async () => {
    const target = { kind: 'document-author' as const, openId: 'ou_owner', turnId: 'turn-A',
      fileToken: 'fixture', commentId: 'comment' };
    const input = makeInput({ chatId: 'doc:fixture:comment', rootMessageId: null,
      answererOpenId: 'ou_owner', deliveryTarget: target });
    const first = mockDispatcher();
    setCardDispatcher(first);
    void registerAsk(input);
    await new Promise(r => setTimeout(r, 5));
    expect(onlyPersisted()).toMatchObject({ deliveryTarget: target, answererOpenId: 'ou_owner' });
    const original = first.sendCalls[0];
    _resetForTest();
    bindStore();
    const second = mockDispatcher();
    setCardDispatcher(second);
    setCanTalkChecker((_app, _chat, by, type) => by === 'ou_owner' && type === 'p2p');
    restorePersistedAsks(Date.now(), 'cli_app');
    const pending = registerAsk(input);
    expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'ou_intruder' })).toBe('unauthorized');
    expect(submitDocumentAskReply({ larkAppId: 'cli_app', chatType: 'p2p',
      parentMessageId: `om_card_${original.askId}`, by: 'ou_owner', text: 'Keep the original scope' })).toBe(true);
    expect(await pending).toMatchObject({ kind: 'answered', by: 'ou_owner', comment: 'Keep the original scope' });
    expect(second.sendCalls).toHaveLength(0);
  });

  it('registerAsk writes a durable record; answering removes it', async () => {
    setCardDispatcher(mockDispatcher());
    const p = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(1);
    const rec = onlyPersisted();
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    await p;
    expect(persistedFiles()).toHaveLength(0);
  });

  it('does nothing when no store is wired (no global-dir writes)', async () => {
    setAskPersistStore(null);
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(0); // never touched the dir
  });
});

describe('reattach → click (hook reconnects first)', () => {
  it('restores dormant (no re-post), hook re-registers, then click resolves', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Simulate restart: reset memory, rebind store (disk survives), restore.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(d2.sendCalls).toHaveLength(0); // card still live → no re-post

    // Hook reconnects: same requestId → re-attach (no new card).
    const reattached = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(0);

    // Now the user clicks → resolves the re-attached waiter.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    const result = await reattached;
    expect(result.kind).toBe('answered');
    expect(persistedFiles()).toHaveLength(0);
  });
});

describe('click → reattach (durable handoff — codex P1-1)', () => {
  it('user answers dormant card first; hook reconnect delivers the stashed answer, 0 new cards', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Restart → restore dormant.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // User clicks the dormant card BEFORE the hook reconnects.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    // Answer is stashed durably (record kept, not deleted) + card flipped.
    expect(persistedFiles()).toHaveLength(1);
    expect(d2.settleCalls).toHaveLength(1);

    // Hook reconnects (same requestId) → claims the stashed answer, no new card.
    const reattached = registerAsk(makeInput());
    const result = await reattached;
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['yes']]);
    expect(d2.sendCalls).toHaveLength(0);           // never posted a second card
    expect(persistedFiles()).toHaveLength(0);       // claimed → cleaned
  });

  it('stashed answer survives a SECOND restart before the hook claims it', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'no', by: 'ou_owner' }); // answered while dormant
    expect(persistedFiles()).toHaveLength(1); // stashed

    // Second restart before claim: the stashed answer must persist.
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    const result = await registerAsk(makeInput());
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['no']]);
    expect(persistedFiles()).toHaveLength(0);
  });
});

describe('card re-send when restart precedes cardMessageId (codex P1-2)', () => {
  it('an undelivered host ask survives past its nominal timeout and starts timing after re-delivery', async () => {
    let resolveFirstSend!: (value: { messageId?: string }) => void;
    setCardDispatcher(mockDispatcher(() => new Promise((resolve) => {
      resolveFirstSend = resolve;
    })));
    registerHostAsk(makeInput({
      originKind: 'host_cross_principal_classification',
      requestId: 'host-before-delivery',
      backendSurvivesRestart: undefined,
      timeoutMs: 20,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onlyPersisted().cardMessageId).toBeUndefined();

    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);

    const reattached = registerHostAsk(makeInput({
      originKind: 'host_cross_principal_classification',
      requestId: 'host-before-delivery',
      backendSurvivesRestart: undefined,
      timeoutMs: 20,
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d2.sendCalls).toHaveLength(1);
    await expect(reattached).resolves.toMatchObject({ kind: 'timedOut' });
    void resolveFirstSend;
  });

  it('a restored ask without cardMessageId re-sends exactly one card on re-attach', async () => {
    // Dispatcher that never resolves a messageId → simulates restart before the
    // .then() that records cardMessageId runs.
    let resolveSend: (v: { messageId?: string }) => void;
    const slow = mockDispatcher(() => new Promise((res) => { resolveSend = res; }));
    setCardDispatcher(slow);
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    // Record persisted WITHOUT cardMessageId (send still pending).
    const files = readdirSync(join(dataDir, 'asks')).filter(n => n.endsWith('.json'));
    const orig = onlyPersisted();
    expect(orig.cardMessageId).toBeUndefined();

    // Restart → restore → hook re-attach: MUST re-send the card exactly once.
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(d2.sendCalls).toHaveLength(0);           // restore alone doesn't send
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(1);           // re-attach re-sends exactly one
    void resolveSend!;
  });
});

describe('identity + isolation (codex P1-3)', () => {
  it('askKeyFor scopes by larkAppId+session+originKind+requestId (not a bearer secret)', () => {
    const k = askKeyFor('cli_app', 'sess-1', 'hook', 'req-1');
    expect(k).toBe(askKeyFor('cli_app', 'sess-1', 'hook', 'req-1'));
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-2', 'hook', 'req-1')); // diff session
    expect(k).not.toBe(askKeyFor('cli_b', 'sess-1', 'hook', 'req-1'));   // diff bot
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-1', 'explicit', 'req-1')); // diff origin
    expect(k).not.toBe(askKeyFor('cli_app', 'sess-1', 'hook', 'req-2')); // diff request
  });

  it('session B CANNOT reclaim session A dormant ask by reusing the same requestId', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ sessionId: 'sess-A', requestId: 'shared-req' }));
    await new Promise((r) => setTimeout(r, 5));
    const a = onlyPersisted();

    // Restart → restore A's dormant ask.
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_x, _y, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // Session B re-registers with the SAME requestId but its own session id.
    // Different scoped key → must NOT re-attach to A; posts B's own new card.
    const bPromise = registerAsk(makeInput({ sessionId: 'sess-B', requestId: 'shared-req' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(1); // B got its OWN card, did not steal A's

    // Answering A's original card must resolve nobody's B promise.
    tryResolveAsk({ askId: a.askId, nonce: a.nonce, selected: 'yes', by: 'ou_owner' });
    let bResolved = false;
    void bPromise.then(() => { bResolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(bResolved).toBe(false); // B never received A's answer
  });

  it('two concurrent same-question asks from one session get distinct records (distinct requestId)', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ requestId: 'req-A' }));
    registerAsk(makeInput({ requestId: 'req-B' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(2); // NOT collapsed by a questions hash
  });

  it('restore skips a different bot', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ larkAppId: 'cli_other', sessionId: 'sess-o', requestId: 'req-other' }));
    await new Promise((r) => setTimeout(r, 5));
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
  });
});

describe('active same-requestId replay joins one ask (codex P1-1)', () => {
  it('a second live register with the same identity shares the ONE ask/card and both get the answer', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p1 = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    // Client reset → re-POST same requestId while still active: joins, no 2nd card.
    const p2 = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d.sendCalls).toHaveLength(1);        // ONE card
    expect(persistedFiles()).toHaveLength(1);   // ONE record

    const rec = onlyPersisted();
    tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('answered');
    expect(r2).toEqual(r1);                     // both waiters got the SAME result
  });
});

describe('dispatch uuid + non-resumable origins (codex P1-1/P1-4)', () => {
  it('resumable (hook) card send carries a stable dispatchUuid derived from the scoped key + ask instance', async () => {
    let seenUuid: string | undefined = 'UNSET';
    const d = mockDispatcher((ask) => { seenUuid = ask.dispatchUuid; return Promise.resolve({ messageId: 'om_x' }); });
    setCardDispatcher(d);
    registerAsk(makeInput({ requestId: 'req-uuid-1' }));
    await new Promise((r) => setTimeout(r, 5));
    const askId = d.sendCalls[0]!.askId;
    expect(seenUuid).toBe(dispatchUuidForAsk(askKeyFor('cli_app', 'sess-1', 'hook', 'req-uuid-1'), askId));
  });

  it('explicit origin is NOT persisted but DOES carry a dispatchUuid (codex P1-1)', async () => {
    let seenUuid: string | undefined = 'UNSET';
    const d = mockDispatcher((ask) => { seenUuid = ask.dispatchUuid; return Promise.resolve({ messageId: 'om_x' }); });
    setCardDispatcher(d);
    // Explicit ask: originKind='explicit', no requestId → not resumable.
    registerAsk(makeInput({ originKind: 'explicit', requestId: undefined }));
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(0);   // never persisted → no orphan handoff
    // But it STILL carries a dedupe uuid: the bounded retry re-sends even a
    // non-resumable card, so it needs server-side dedupe. uuid gates dispatch
    // idempotency (intra-process); resumable gates persistence (cross-restart).
    expect(seenUuid).toBeTruthy();
  });
});

/**
 * A dormant hook ask must be re-claimed by its hook, or the CLI that asked is no
 * longer waiting. Live incident: the CLI was killed (its hook with it), the ask
 * stayed dormant through a restart and later captured a plain chat message as
 * its "answer" — never delivered, no notice.
 */
describe('dormant hook asks must be re-claimed by their hook', () => {
  const GRACE = 40;
  const anchor = { larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'om_root' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Register, then restart and restore — the hook has not re-attached yet. */
  async function restartWithPendingAsk(input = makeInput()) {
    setCardDispatcher(mockDispatcher());
    void registerAsk(input);
    await sleep(5);
    const orig = onlyPersisted();
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    _setHookReclaimGraceForTest(GRACE);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    return { orig, d2 };
  }

  it('does not take free text while no hook is attached, and keeps the record intact', async () => {
    const { orig, d2 } = await restartWithPendingAsk();
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
    // Not even as a quoted-card / ambiguity candidate (daemon reads this list first).
    expect(listPendingAsksByAnchor(anchor)).toEqual([]);
    expect(submitCustomReply({ askId: orig.askId, by: 'ou_owner', text: 'a plain chat message' })).toBe('stale');
    expect(onlyPersisted().answeredResult).toBeUndefined();
    expect(d2.settleCalls).toHaveLength(0);
  });

  it('a hook that re-attaches in time keeps the ask fully answerable (incl. free text)', async () => {
    const { orig } = await restartWithPendingAsk();
    expect(startHookAskReclaim()).toBe(1);
    const reattached = registerAsk(makeInput());
    await sleep(GRACE * 3);
    expect(findPendingAskByAnchor(anchor)?.askId).toBe(orig.askId);
    expect(listPendingAsksByAnchor(anchor).map((a) => a.askId)).toEqual([orig.askId]);
    expect(submitCustomReply({ askId: orig.askId, by: 'ou_owner', text: '先灰度' })).toBe('accepted');
    expect(await reattached).toMatchObject({ kind: 'answered', comment: '先灰度' });
  });

  it.each([false, true])('no hook within the grace → invalidated, record removed, card expired; a late hook gets a fresh card (daemon restarted in between: %s)', async (restartedBetween) => {
    // Feishu dedupes a send by uuid (1h): the same uuid returns the ORIGINAL message.
    const feishu = new Map<string, string>();
    const dedupingSend = (ask: PendingAsk) => {
      const uuid = ask.dispatchUuid!;
      if (!feishu.has(uuid)) feishu.set(uuid, `om_card_${feishu.size + 1}`);
      return Promise.resolve({ messageId: feishu.get(uuid) });
    };
    setCardDispatcher(mockDispatcher(dedupingSend));
    void registerAsk(makeInput());
    await sleep(5);
    const orig = onlyPersisted();
    _resetForTest(); bindStore();
    const d2 = mockDispatcher(dedupingSend);
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    _setHookReclaimGraceForTest(GRACE);
    restorePersistedAsks(Date.now(), 'cli_app');

    startHookAskReclaim();
    await sleep(GRACE * 3);
    expect(d2.settleCalls).toEqual([expect.objectContaining({ kind: 'invalidated', failureCode: 'claimant_gone' })]);
    expect(persistedFiles()).toHaveLength(0);
    expect(_getPending(orig.askId)).toBeUndefined();
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('stale');

    let lateDispatcher = d2;
    if (restartedBetween) {
      _resetForTest(); bindStore();
      lateDispatcher = mockDispatcher(dedupingSend);
      setCardDispatcher(lateDispatcher);
      setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
      expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
    }

    // The hook shows up after all (same requestId → same key). It must get a NEW
    // card it can be answered on, not the expired one handed back by dedupe.
    const late = registerAsk(makeInput());
    await sleep(5);
    expect(lateDispatcher.sendCalls).toHaveLength(1);
    const fresh = lateDispatcher.sendCalls[0]!;
    expect(fresh.dispatchUuid).not.toBe(dispatchUuidForAsk(orig.askKey, orig.askId));
    expect(onlyPersisted()).toMatchObject({ cardMessageId: 'om_card_2' });
    void late; // its connection dies with the next simulated restart

    // A restart keeps the fresh card's own uuid (a re-send must dedupe onto IT).
    _resetForTest(); bindStore();
    setCardDispatcher(mockDispatcher(dedupingSend));
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(_getPending(fresh.askId)?.dispatchUuid).toBe(fresh.dispatchUuid);
    const reattached = registerAsk(makeInput());
    expect(tryResolveAsk({ askId: fresh.askId, nonce: fresh.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    expect(await reattached).toMatchObject({ kind: 'answered', answers: [['yes']] });
  });

  it('a card click stashed while dormant is reported as undelivered when no hook claims it', async () => {
    const { orig, d2 } = await restartWithPendingAsk();
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    expect(onlyPersisted().answeredResult).toMatchObject({ kind: 'answered' });
    startHookAskReclaim();
    await sleep(GRACE * 3);
    expect(d2.settleCalls.map((r) => r.kind)).toEqual(['answered', 'invalidated']);
    expect(d2.settleCalls[1]).toMatchObject({ failureCode: 'answer_undelivered' });
    expect(persistedFiles()).toHaveLength(0);
  });

  it('the restore clock waits for the daemon to serve; asks restored later arm at once', async () => {
    const { d2 } = await restartWithPendingAsk();
    await sleep(GRACE * 3);
    expect(d2.settleCalls).toHaveLength(0); // boot time is not charged to the hook
    expect(persistedFiles()).toHaveLength(1);

    _resetForTest(); bindStore();
    const d3 = mockDispatcher();
    setCardDispatcher(d3);
    _setHookReclaimGraceForTest(GRACE);
    expect(startHookAskReclaim()).toBe(0);
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    await sleep(GRACE * 3);
    expect(d3.settleCalls).toEqual([expect.objectContaining({ failureCode: 'claimant_gone' })]);
  });

  it('a hook that drops while the daemon stays up and never returns is invalidated too', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    _setHookReclaimGraceForTest(GRACE);
    const controller = new AbortController();
    const first = registerAsk(makeInput(), controller.signal);
    await sleep(5);
    controller.abort(); // the CLI (and its hook) was killed
    expect(await first).toMatchObject({ kind: 'invalidated' });
    expect(findPendingAskByAnchor(anchor)).toBeUndefined();
    await sleep(GRACE * 3);
    expect(d.settleCalls).toEqual([expect.objectContaining({ failureCode: 'claimant_gone' })]);
    expect(persistedFiles()).toHaveLength(0);
  });

  it('a click after the hook dropped keeps the reclaim deadline: no hook → reported undelivered', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    _setHookReclaimGraceForTest(GRACE);
    const controller = new AbortController();
    void registerAsk(makeInput(), controller.signal);
    await sleep(5);
    const rec = onlyPersisted();
    controller.abort();
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'no', by: 'ou_owner' })).toBe('accepted');
    await sleep(GRACE * 3);
    expect(d.settleCalls.map((r) => r.kind)).toEqual(['answered', 'invalidated']);
    expect(d.settleCalls[1]).toMatchObject({ failureCode: 'answer_undelivered' });
    expect(persistedFiles()).toHaveLength(0);
  });

  it('host-owned asks are not reclaimed (the daemon is their claimant)', async () => {
    const host = makeInput({ originKind: 'host_cross_principal_classification', requestId: 'host-1',
      backendSurvivesRestart: undefined });
    setCardDispatcher(mockDispatcher());
    void registerHostAsk(host);
    await sleep(5);
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    _setHookReclaimGraceForTest(GRACE);
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(startHookAskReclaim()).toBe(0);
    await sleep(GRACE * 3);
    expect(d2.settleCalls).toHaveLength(0);
    expect(persistedFiles()).toHaveLength(1);
  });
});
