import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delivery, productionFunction } from './helpers/codex-async-answer-function-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainCodexRollout,
  codexRolloutHasAsyncQuestionReply,
  findPendingCodexAsyncQuestion,
  selectNewCodexAsyncQuestions,
  type CodexBridgeEvent,
} from '../src/services/codex-transcript.js';
import {
  CODEX_ASYNC_ASK_ORIGIN,
  CODEX_ASYNC_RESTORE_ASK_ORIGIN,
  codexAsyncAnswerNeedsRawInput,
  codexAsyncAnswerSteerable,
  codexAsyncAnswerSteerTarget,
  codexAsyncAnswerText,
  codexAsyncAskOriginEligible,
  parseCodexAsyncQuestions,
} from '../src/services/codex-async-user-input.js';
import { parseAskBody } from '../src/core/ask-api.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { traexPendingAsyncQuestionCount } from '../src/utils/traex-question-page.js';

const THREAD = '01a20831-84de-7c81-8a41-e466b35212fb';
const TURN = '01a20ccc-01be-7912-a1f4-366ac89c697d';
const ITEM = 'call_a193c0364dda416284b1dc64cd51eab6';
const QUESTION = {
  title: '是否允许在测试环境新增独立 TCC 资源？',
  options: ['允许创建并启用', '先只验证类型收窄'],
};

let dir: string;
let path: string;

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function taskStarted(ts = '2026-11-24T09:20:00.000Z') {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', thread_id: THREAD, turn_id: TURN } };
}

function userMessage(text: string, ts = '2026-11-24T09:20:01.000Z') {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}

function asyncQuestion(overrides: Record<string, unknown> = {}, ts = '2026-11-24T09:21:11.465Z') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: THREAD,
      turn_id: TURN,
      item: {
        type: 'AgentMessage',
        id: ITEM,
        content: [{ type: 'Text', text: QUESTION.title }],
        phase: 'final_answer',
        delivery: 'async',
        questions: [QUESTION],
        ...overrides,
      },
    },
  };
}

function taskComplete(ts = '2026-11-24T09:22:00.000Z') {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', thread_id: THREAD, turn_id: TURN, last_agent_message: 'done' } };
}

function replyEnvelope(ts = '2026-11-24T09:35:37.342Z') {
  const text = `<send_user_message_question_reply>\n${JSON.stringify([{
    questionItemId: JSON.stringify(['request_user_input_async', ITEM, 0]),
    question: QUESTION.title,
    answer: '允许创建并启用',
  }])}\n</send_user_message_question_reply>`;
  return userMessage(text, ts);
}

function daemonDeliveryScope(tui: boolean): Record<string, any> {
  const scope: Record<string, any> = {
    asyncTuiCodex: tui,
    result: { kind: 'answered', by: 'ou_owner' },
    actor: { senderType: 'user' },
    askAnswerActorFor: () => scope.actor,
    isKnownPeerBot: () => false,
    config: { session: { dataDir: '/unused' } },
    askSession: {
      larkAppId: 'app', chatId: 'oc_chat',
      session: { backendType: 'tmux' }, initConfig: { codexRpcInput: false },
    },
    resolveSender: async () => ({ name: 'User' }),
    isCurrent: () => true,
    asyncCaller: 'ou_owner',
    randomUUID: () => 'probe',
    getBot: () => ({ config: {}, botName: 'Bot', botOpenId: 'ou_bot' }),
    asyncOriginMessageId: 'om_original',
    asyncOriginTurn: 'om_original',
    audience: { kind: 'human', answererOpenId: 'ou_owner' },
    boundAsk: { sessionId: 'session', larkAppId: 'app', chatId: 'oc_chat', rootMessageId: 'om_root' },
    beginReplyTargetTurn: vi.fn(),
    sessionPromptInjection: () => undefined,
    buildFollowUpCliInput: vi.fn(() => ({ content: 'wrapped', codexAppInput: { text: 'wrapped' } })),
    documentDelivery: undefined,
    asyncDocumentTarget: undefined,
    noteTurnReceived: vi.fn(async () => undefined),
    trustedCallerForInboundTurn: vi.fn(async () => ({
      senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_owner',
    })),
    asyncInput: { threadId: 'thread', itemId: 'call', nativeTurnId: 'native-original' },
    codexAsyncAnswerSteerTarget,
    codexAsyncAnswerSteerable,
    larkTransportEnabled: () => true,
    codexAppCleanInputAcceptedForSession: () => !tui,
    sendWorkerInput: vi.fn(() => true),
    beginNewTurn: vi.fn(),
    rememberLastCliInput: vi.fn(),
    markSessionActivity: vi.fn(),
    sessionStore: { updateSession: vi.fn() },
    logger: { info: vi.fn() },
  };
  return scope;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-async-question-'));
  path = join(dir, 'rollout.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Codex TUI async questions', () => {
  it('emits the question from the rollout without moving the turn boundary', () => {
    writeFileSync(path, [
      line(taskStarted()),
      line(userMessage('继续验证')),
      line(asyncQuestion()),
      line(taskComplete()),
    ].join(''));

    const result = drainCodexRollout(path, 0);
    const question = result.events.find(event => event.kind === 'async_question');
    expect(question?.asyncQuestion).toEqual({
      itemId: ITEM, threadId: THREAD, nativeTurnId: TURN, questions: [QUESTION],
    });
    // The ordinary turn is still exactly one user record and one terminal.
    expect(result.events.filter(event => event.kind === 'user')).toHaveLength(1);
    expect(result.events.filter(event => event.kind === 'assistant_final')).toHaveLength(1);
  });

  it('leaves the bridge queue untouched', () => {
    const queue = new CodexBridgeQueue(() => 0);
    queue.ingest([{
      uuid: 'question-only', timestampMs: 1, kind: 'async_question', text: '',
      asyncQuestion: { itemId: ITEM, threadId: THREAD, questions: [QUESTION] },
    }]);
    expect(queue.peek()).toEqual([]);
  });

  it('cards each item once and ignores another thread', () => {
    const events: CodexBridgeEvent[] = [
      { uuid: 'a', timestampMs: 1, kind: 'async_question', text: '', asyncQuestion: { itemId: ITEM, threadId: THREAD, questions: [QUESTION] } },
      { uuid: 'b', timestampMs: 2, kind: 'async_question', text: '', asyncQuestion: { itemId: ITEM, threadId: THREAD, questions: [QUESTION] } },
      { uuid: 'c', timestampMs: 3, kind: 'async_question', text: '', asyncQuestion: { itemId: 'call_other', threadId: 'other-thread', questions: [QUESTION] } },
    ];
    const seen = new Set<string>();
    expect(selectNewCodexAsyncQuestions(events, THREAD, seen).map(question => question.itemId)).toEqual([ITEM]);
    expect(selectNewCodexAsyncQuestions(events, THREAD, seen)).toEqual([]);
  });

  it('detects the native reply and clears the pending question', () => {
    writeFileSync(path, [line(asyncQuestion()), line(taskComplete())].join(''));
    expect(codexRolloutHasAsyncQuestionReply(path, ITEM)).toBe(false);
    expect(findPendingCodexAsyncQuestion(path)?.itemId).toBe(ITEM);

    appendFileSync(path, line(replyEnvelope()));
    expect(codexRolloutHasAsyncQuestionReply(path, ITEM)).toBe(true);
    expect(findPendingCodexAsyncQuestion(path)).toBeUndefined();
  });

  it('builds the exact native reply envelope for a TUI identity', () => {
    const questions = parseCodexAsyncQuestions({
      type: 'agentMessage', delivery: 'async',
      questions: [{ title: QUESTION.title, options: QUESTION.options }],
    });
    const text = codexAsyncAnswerText({ threadId: THREAD, itemId: ITEM, nativeTurnId: TURN }, questions, {
      kind: 'answered', answers: [['o0']], selected: null, by: 'ou_owner', comment: null, timedOut: false,
    });
    const json = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
    expect(json).toEqual([{
      questionItemId: JSON.stringify(['request_user_input_async', ITEM, 0]),
      question: QUESTION.title,
      answer: '允许创建并启用',
    }]);
  });

  it('admits only a TUI Codex launch to the raw-input path', () => {
    expect(codexAsyncAnswerNeedsRawInput('codex', false)).toBe(true);
    expect(codexAsyncAnswerNeedsRawInput('codex', undefined)).toBe(true);
    expect(codexAsyncAnswerNeedsRawInput('codex', true)).toBe(false);
    expect(codexAsyncAnswerNeedsRawInput('codex-app', false)).toBe(false);
    expect(codexAsyncAskOriginEligible('codex', false)).toBe(true);
    expect(codexAsyncAskOriginEligible('codex', true)).toBe(false);
    expect(codexAsyncAskOriginEligible('codex-app', true)).toBe(true);
  });

  it('delivers the native envelope verbatim to a TUI Codex session', async () => {
    const scope = daemonDeliveryScope(true);
    const envelope = '<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>';
    await delivery(scope)(envelope, 'ou_owner');
    expect(scope.buildFollowUpCliInput).not.toHaveBeenCalled();
    expect(scope.sendWorkerInput).toHaveBeenCalledWith(
      scope.askSession, { content: envelope }, 'codex-async-answer-probe',
      expect.objectContaining({ atMostOnce: true }),
    );
  });

  it('keeps the structured codex-app input for a non-TUI answer', async () => {
    const scope = daemonDeliveryScope(false);
    await delivery(scope)('answer', 'ou_owner');
    expect(scope.buildFollowUpCliInput).toHaveBeenCalledWith(
      'answer', 'session', expect.objectContaining({ cliId: 'codex-app', codexAppText: 'answer' }),
    );
    expect(scope.sendWorkerInput).toHaveBeenCalledWith(
      scope.askSession,
      expect.objectContaining({ content: 'wrapped', codexAppInput: expect.any(Object) }),
      'codex-async-answer-probe',
      expect.objectContaining({ atMostOnce: true, codexAppSteerable: true }),
    );
  });

  it('admits only a live local Codex TUI to the bridge', () => {
    function eligible(patch: Record<string, unknown> = {}) {
      const scope: Record<string, unknown> = {
        cliAdapter: { id: 'codex' }, codexRpcEngine: undefined, backend: {}, remoteWsUrl: undefined,
        lastInitConfig: { adoptMode: false, backendType: 'tmux' },
        isRemoteBackendType: () => false,
        ...patch,
      };
      return loadWorkerFunction<() => boolean>('codexTuiAsyncQuestionEligible', scope)();
    }
    expect(eligible()).toBe(true);
    expect(eligible({ cliAdapter: { id: 'traex' } })).toBe(false);
    expect(eligible({ codexRpcEngine: {} })).toBe(false);
    expect(eligible({ lastInitConfig: { adoptMode: false, backendType: 'tmux', codexRpcInput: true } })).toBe(false);
    expect(eligible({ backend: null })).toBe(false);
    expect(eligible({ remoteWsUrl: 'ws://remote' })).toBe(false);
    expect(eligible({ lastInitConfig: { adoptMode: true } })).toBe(false);
    expect(eligible({ lastInitConfig: { adoptMode: false, backendType: 'riff' }, isRemoteBackendType: () => true })).toBe(false);
  });

  it('posts the card with the native identity and skips a settled question', async () => {
    writeFileSync(path, line(asyncQuestion()));
    const postCodexAsk = vi.fn(async () => ({ kind: 'answered' }));
    const scope: Record<string, unknown> = {
      lastInitConfig: { sessionId: 's', larkAppId: 'app', chatId: 'c', rootMessageId: 'om_root', cliSessionId: THREAD },
      codexBridgeRolloutPath: path,
      currentBotmuxTurnId: 'om_turn',
      currentBotmuxDispatchAttempt: 2,
      postCodexAsk,
      log: vi.fn(),
      codexTuiAsyncQuestionAborts: new Map(),
      codexTuiAsyncQuestionsSeen: new Set(),
      codexTuiAsyncQuestionThread: () => THREAD,
      codexTuiAsyncAskQuestions: () => [{
        prompt: QUESTION.title, multiSelect: false, options: [{ key: 'o0', label: QUESTION.options[0] }],
      }],
      codexRolloutHasAsyncQuestionReply,
    };
    const open = loadWorkerFunction<(question: any, restored?: boolean) => Promise<void>>('openCodexTuiAsyncQuestion', scope);
    await open({ itemId: ITEM, threadId: THREAD, nativeTurnId: TURN, questions: [QUESTION] });
    expect(postCodexAsk).toHaveBeenCalledTimes(1);
    expect(postCodexAsk).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's', originTurnId: 'om_turn', originDispatchAttempt: 2 }),
      expect.any(Array),
      expect.any(AbortSignal),
      { threadId: THREAD, itemId: ITEM, nativeTurnId: TURN },
      undefined,
      false,
    );

    // A restored card must use the fresh broker origin so a retained
    // invalidated result from the dead worker cannot swallow it.
    await open({ itemId: ITEM, threadId: THREAD, nativeTurnId: TURN, questions: [QUESTION] }, true);
    expect(postCodexAsk).toHaveBeenCalledTimes(2);
    expect(postCodexAsk.mock.calls[1][5]).toBe(true);

    appendFileSync(path, line(replyEnvelope()));
    await open({ itemId: ITEM, threadId: THREAD, nativeTurnId: TURN, questions: [QUESTION] });
    expect(postCodexAsk).toHaveBeenCalledTimes(2);
  });

  it('accepts the restore origin as an async ask and keeps the request identity', () => {
    const questions = parseCodexAsyncQuestions({
      type: 'agentMessage', delivery: 'async',
      questions: [{ title: QUESTION.title, options: QUESTION.options }],
    });
    const body = {
      sessionId: 's', chatId: 'oc_chat', larkAppId: 'app', rootMessageId: 'om_root',
      questions, timeoutMs: 60_000, requestId: ITEM,
      originKind: CODEX_ASYNC_RESTORE_ASK_ORIGIN,
      asyncUserInput: { threadId: THREAD, itemId: ITEM },
    };
    expect(parseAskBody(body)).toMatchObject({ asyncUserInput: { threadId: THREAD, itemId: ITEM } });
    expect(parseAskBody({ ...body, requestId: 'other' })).toEqual({ error: 'bad_asyncUserInput' });
    expect(parseAskBody({ ...body, asyncUserInput: undefined })).toEqual({ error: 'bad_asyncUserInput' });
    expect(parseAskBody({ ...body, originKind: CODEX_ASYNC_ASK_ORIGIN })).toMatchObject({
      asyncUserInput: { threadId: THREAD, itemId: ITEM },
    });
  });

  it('freezes a restored card to the last human caller instead of widening it', () => {
    function audience(patch: Record<string, unknown> = {}) {
      const scope: Record<string, unknown> = {
        isKnownPeerBot: () => false,
        config: { session: { dataDir: '/unused' } },
        evaluateAskAnswerTalk: () => true,
        asyncAskAudience: () => ({ kind: 'shared' }),
        ...patch,
      };
      return productionFunction('src/daemon.ts', 'restoredAsyncAskAudience', scope);
    }
    const ds = {
      larkAppId: 'app', chatId: 'oc_chat', chatType: 'group',
      session: { lastCallerOpenId: 'ou_owner' },
    };
    expect(audience()(ds)).toEqual({ kind: 'human', answererOpenId: 'ou_owner' });
    expect(audience({ isKnownPeerBot: () => true })(ds)).toEqual({ kind: 'shared' });
    expect(audience()({ ...ds, session: {} })).toEqual({ kind: 'shared' });
  });

  it('ignores secret async questions instead of leaking them into a card', () => {
    writeFileSync(path, line(asyncQuestion({ questions: [{ title: '生产数据库密码', isSecret: true }] })));
    expect(drainCodexRollout(path, 0).events.some(event => event.kind === 'async_question')).toBe(false);
  });

  it('retries restore after an early screen capture without the pending marker', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    writeFileSync(path, line(asyncQuestion()));
    let screen = '❯ \n  model · Context 90% left';
    const opened: any[] = [];
    const scope: Record<string, unknown> = {
      codexTuiAsyncRestoreChecked: false,
      codexTuiAsyncQuestionEligible: () => true,
      codexBridgeRolloutPath: path,
      backend: {},
      captureBackendScreen: () => screen,
      traexPendingAsyncQuestionCount,
      findPendingCodexAsyncQuestion,
      codexTuiAsyncQuestionsSeen: new Set<string>(),
      codexRolloutHasAsyncQuestionReply,
      codexTuiAsyncQuestionThread: () => THREAD,
      openCodexTuiAsyncQuestion: (question: any) => { opened.push(question); },
      CODEX_TUI_RESTORE_SETTLE_MS: 5000,
    };
    const restore = loadWorkerFunction<() => void>('maybeRestoreCodexTuiAsyncQuestion', scope);
    restore();
    expect(opened).toHaveLength(0);
    screen = ['  ? 1 question', '  shift+← to answer', '› Ask Codex to do anything'].join('\n');
    restore();
    expect(opened.map(question => question.itemId)).toEqual([ITEM]);
    vi.useRealTimers();
  });

  it('ignores malformed async items instead of guessing a question', () => {
    writeFileSync(path, [
      line(asyncQuestion({ id: '' })),
      line(asyncQuestion({ questions: [] })),
      line(asyncQuestion({ delivery: 'sync' })),
      line(asyncQuestion({ questions: [{ title: 'x', options: ['ok', 42] }] })),
    ].join(''));
    expect(drainCodexRollout(path, 0).events.some(event => event.kind === 'async_question')).toBe(false);
  });
});
