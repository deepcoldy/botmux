import { t, localeForBot } from '../i18n/index.js';
import { createHash } from 'node:crypto';
import type { AskAnswerDelivery } from './ask-broker.js';
import type { AskContinuation } from './ask-types.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';

export function continuationRequest(answer: AskAnswerDelivery): TriggerRequest {
  const key = 'ask-answer:' + createHash('sha256').update(answer.askKey).digest('hex');
  return { source: { type: 'ui', connectorId: 'native-ask', requestId: key, receivedAt: new Date(answer.answeredAt).toISOString() },
    target: { kind: 'turn', botId: answer.larkAppId, sessionId: answer.sessionId, chatId: answer.chatId,
      ...(answer.rootMessageId ? { rootMessageId: answer.rootMessageId } : {}) },
    envelope: { format: 'json', sourceName: 'User answer to the original question', trusted: false,
      payload: { askId: answer.askId, originTurnId: answer.continuation.originTurnId,
        questions: answer.questions, answer: answer.result } },
    instruction: 'The user answered the question from this same task. Read the original question and answer in the event data and continue the original task. The answer is not proof of business completion. Do not repeat the question or duplicate effects already completed.',
    options: { turnIdempotencyKey: key, asyncReturnSessionId: true, resultDelivery: 'conversation' },
    presentation: { liveCard: 'on-start', title: t('card.ask.continuation_title', {}, localeForBot(answer.larkAppId)) } };
}
export function createAskContinuationDispatcher(deps: {
  submit: (request: TriggerRequest) => Promise<TriggerResponse>;
  observe: (sessionId: string, key: string) => { status: number; body: Record<string, unknown> };
}) {
  return async (answer: AskAnswerDelivery): Promise<Partial<AskContinuation> & { state: 'accepted' | 'committed' | 'blocked' }> => {
    const request = continuationRequest(answer), key = request.options!.turnIdempotencyKey!;
    const observed = () => {
      const { status, body } = deps.observe(answer.sessionId, key);
      if (status !== 200 || body.ok !== true || body.sessionId !== answer.sessionId || body.larkAppId !== answer.larkAppId)
        throw new Error('ask_continuation_observation_unavailable');
      return body as { state: string; registration?: { triggerId: string }; inputCommitted?: { state: string }; result?: { state: string } };
    };
    let value = observed();
    if (value.state !== 'registered' && answer.continuation.triggerId) return { state: 'blocked', key, reason: 'original_answer_input_unproven' };
    if (value.state !== 'registered') {
      // The native queue owns the cross-boot CAS and payload hash. A lost
      // response is retried with precisely this key and immutable payload.
      const result = await deps.submit(request);
      if (!result.ok) return { state: 'blocked', key, reason: result.errorCode ?? 'answer_queue_rejected' };
      value = observed();
    }
    if (value.state !== 'registered' || !value.registration?.triggerId) return { state: 'blocked', key, reason: 'answer_queue_unproven' };
    if (answer.continuation.triggerId && answer.continuation.triggerId !== value.registration.triggerId) throw new Error('ask_continuation_identity_changed');
    if (value.inputCommitted?.state !== 'observed' && value.result?.state === 'failed') return { state: 'blocked', key, triggerId: value.registration.triggerId, reason: 'answer_input_failed_before_commit' };
    return { state: value.inputCommitted?.state === 'observed' ? 'committed' : 'accepted', key,
      triggerId: value.registration.triggerId, reason: undefined };
  };
}
