import { afterEach, expect, it, vi } from 'vitest';
import { _resetForTest, registerAsk, setCardDispatcher, setCanTalkChecker, submitAsk, submitDocumentAskReply } from '../src/core/ask-broker.js';
import { createLarkAskCardDispatcher, buildAskCard, handleAskCardAction, ASK_SELECT_ACTION } from '../src/im/lark/ask-card.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { resolveDocumentAskDelivery } from '../src/core/doc-comment-ask.js';
import { codexUserInputAnswer, parseCodexUserInputQuestions } from '../src/services/codex-user-input.js';
import { parseAskBody } from '../src/core/ask-api.js';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';

afterEach(() => _resetForTest());

const input: CreateAskInput = {
  sessionId: 'doc-session', larkAppId: 'cli_source',
  chatId: 'doc:document:comment', rootMessageId: null, chatType: 'group',
  questions: [{ prompt: 'Rebuild only this chart?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }],
  timeoutMs: 60_000, originKind: 'native-user-input',
};

it('delivers a document confirmation to its frozen author and returns their answer to the original ask', async () => {
  const send = vi.fn(async () => { throw new Error('invalid receive_id'); });
  const dm = vi.fn(async () => 'om_direct_card');
  const dispatcher = createLarkAskCardDispatcher({ sendMessage: send, sendUserMessage: dm });
  let card!: PendingAsk;
  setCardDispatcher({ send: ask => { card = ask; return dispatcher.send(ask); } });
  setCanTalkChecker((_app, _chat, by, type) => by === 'ou_author' && type === 'p2p');
  const result = registerAsk({ ...input, answererOpenId: 'ou_author',
    deliveryTarget: { kind: 'document-author', openId: 'ou_author', turnId: 'turn-A', fileToken: 'document', commentId: 'comment' } });
  await vi.waitFor(() => expect(dm).toHaveBeenCalledTimes(1));
  expect(send).not.toHaveBeenCalled();
  expect(dm).toHaveBeenCalledWith('cli_source', 'ou_author', expect.any(String), 'interactive', expect.any(String));
  expect(card.chatId).toBe('doc:document:comment');
  expect(card.sessionId).toBe('doc-session');
  expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_other', selections: [['yes']] })).toBe('unauthorized');
  expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_author', selections: [['yes']] })).toBe('accepted');
  expect(await result).toMatchObject({ kind: 'answered', answers: [['yes']], by: 'ou_author' });
});

it('resolves the exact comment author, never a newer caller or the session owner', async () => {
  const session = { larkAppId: 'cli_source', chatId: input.chatId,
    session: { docCommentTargets: {
      'turn-A': { fileToken: 'document', commentId: 'comment', replyToOpenId: 'ou_author', turnId: 'turn-A' },
      'turn-B': { fileToken: 'other', commentId: 'other', replyToOpenId: 'ou_later', turnId: 'turn-B' },
    }, ownerOpenId: 'ou_owner', lastCallerOpenId: 'ou_later' } };
  const verify = vi.fn(async (app, by) => app === 'cli_source' && by === 'ou_author');
  expect(await resolveDocumentAskDelivery(session, 'turn-A', verify)).toEqual({
    kind: 'document-author', openId: 'ou_author', turnId: 'turn-A', fileToken: 'document', commentId: 'comment',
  });
  expect(verify).toHaveBeenCalledWith('cli_source', 'ou_author');
  await expect(resolveDocumentAskDelivery(session, 'missing', verify)).rejects.toThrow(/recipient/i);
  await expect(resolveDocumentAskDelivery(session, 'turn-B', verify)).rejects.toThrow(/recipient/i);
  expect(await resolveDocumentAskDelivery({ ...session, chatId: 'oc_real' }, undefined, verify)).toBeUndefined();
});

it('does not send invalid virtual ids and reports delivery failure rather than an unanswered question', async () => {
  const send = vi.fn();
  setCardDispatcher(createLarkAskCardDispatcher({ sendMessage: send }));
  const result = await registerAsk(input);
  expect(result).toMatchObject({ kind: 'invalidated', failureCode: 'card_delivery_failed', timedOut: false });
  expect(send).not.toHaveBeenCalled();
  const questions = parseCodexUserInputQuestions({ questions: [{ id: 'q', question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  expect(() => codexUserInputAnswer(questions, result)).toThrow(/could not be delivered/i);
  expect(() => codexUserInputAnswer(questions, result)).not.toThrow(/ask not answered/);
});

it('rejects client-supplied delivery targets and answerer locks at the Ask HTTP input boundary', () => {
  expect(parseAskBody({ ...input, deliveryTarget: { kind: 'document-author', openId: 'ou_attacker' } })).toEqual({ error: 'unsupported_fields' });
  expect(parseAskBody({ ...input, answererOpenId: 'ou_attacker' })).toEqual({ error: 'unsupported_fields' });
});

it('routes only an exact private reply to the delivered card back to the originating document task', async () => {
  let card!: PendingAsk;
  setCanTalkChecker((_app, _chat, by) => by === 'ou_author');
  setCardDispatcher({ async send(ask) { card = ask; return { messageId: 'om_doc_card' }; } });
  const result = registerAsk({ ...input, answererOpenId: 'ou_author',
    deliveryTarget: { kind: 'document-author', openId: 'ou_author', turnId: 'turn-A', fileToken: 'document', commentId: 'comment' } });
  await vi.waitFor(() => expect(card).toBeDefined());
  await Promise.resolve();
  const reply = { larkAppId: 'cli_source', parentMessageId: 'om_doc_card', by: 'ou_author', text: 'Keep labels unchanged', chatType: 'p2p' as const };
  expect(submitDocumentAskReply({ ...reply, parentMessageId: undefined })).toBe(false);
  expect(submitDocumentAskReply({ ...reply, parentMessageId: 'om_other' })).toBe(false);
  expect(submitDocumentAskReply({ ...reply, by: 'ou_other' })).toBe(false);
  expect(submitDocumentAskReply({ ...reply, larkAppId: 'cli_other' })).toBe(false);
  expect(submitDocumentAskReply({ ...reply, chatType: 'group' })).toBe(false);
  expect(submitDocumentAskReply(reply)).toBe(true);
  expect(await result).toMatchObject({ kind: 'answered', comment: 'Keep labels unchanged' });
  expect(submitDocumentAskReply(reply)).toBe(false);
});

it('freezes the recipient while a newer comment arrives during verification', async () => {
  const source = { fileToken: 'fixture', commentId: 'comment', turnId: 'A', replyToOpenId: 'ou_original' };
  const session = { chatId: 'doc:fixture:comment', larkAppId: 'cli_source', session: { docCommentTargets: { A: source } } };
  const target = await resolveDocumentAskDelivery(session, 'A', async () => {
    source.replyToOpenId = 'ou_newer';
    return true;
  });
  expect(target?.openId).toBe('ou_original');
});

it.each([
  { turnId: 'old-turn', replyToOpenId: 'ou_author' },
  { turnId: 'A', replyToOpenId: 'oc_not_a_user' },
  { turnId: 'A', replyToOpenId: undefined },
])('rejects incomplete or stale comment recipients before any lookup: %j', async source => {
  const verify = vi.fn(async () => true);
  await expect(resolveDocumentAskDelivery({ chatId: input.chatId, larkAppId: 'cli_source',
    session: { docCommentTargets: { A: { fileToken: 'fixture', commentId: 'comment', ...source } } } },
  'A', verify)).rejects.toThrow(/no verified document-turn recipient/);
  expect(verify).not.toHaveBeenCalled();
});

it('retries a transient private send with the same recipient and UUID, never the virtual chat id', async () => {
  const dm = vi.fn(async () => 'om_retried')
    .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 99991400 }));
  const send = vi.fn();
  let card!: PendingAsk;
  const dispatcher = createLarkAskCardDispatcher({ sendMessage: send, sendUserMessage: dm });
  setCardDispatcher({ send: ask => { card = ask; return dispatcher.send(ask); } });
  let allowed = true;
  setCanTalkChecker(() => allowed);
  const result = registerAsk({ ...input, answererOpenId: 'ou_author',
    deliveryTarget: { kind: 'document-author', openId: 'ou_author', turnId: 'A', fileToken: 'fixture', commentId: 'comment' } });
  await vi.waitFor(() => expect(dm).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect(dm.mock.calls[0][1]).toBe('ou_author');
  expect(dm.mock.calls[0][4]).toBeTruthy();
  expect(dm.mock.calls[0][4]).toBe(dm.mock.calls[1][4]);
  expect(send).not.toHaveBeenCalled();
  allowed = false;
  expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_author', selections: [['yes']] })).toBe('unauthorized');
  allowed = true;
  expect(submitAsk({ askId: card.askId, nonce: card.nonce, by: 'ou_author', selections: [['yes']] })).toBe('accepted');
  expect(await result).toMatchObject({ kind: 'answered', by: 'ou_author' });
});

it('reports a permanent private delivery rejection without falling back to another destination', async () => {
  const dm = vi.fn(async () => { throw Object.assign(new Error('invalid receive_id'), { code: 230001 }); });
  const send = vi.fn();
  setCardDispatcher(createLarkAskCardDispatcher({ sendMessage: send, sendUserMessage: dm }));
  const result = await registerAsk({ ...input, answererOpenId: 'ou_author',
    deliveryTarget: { kind: 'document-author', openId: 'ou_author', turnId: 'A', fileToken: 'fixture', commentId: 'comment' } });
  expect(result).toMatchObject({ kind: 'invalidated', failureCode: 'card_delivery_failed', timedOut: false });
  expect(dm).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});

it('routes oversized question attachments and their card to the same private recipient', async () => {
  const recipient = 'ou_12345678901234567890123456789012';
  const dm = vi.fn(async () => 'om_private');
  const send = vi.fn();
  const upload = vi.fn(async () => 'file_fixture');
  const dispatcher = createLarkAskCardDispatcher({ sendMessage: send, sendUserMessage: dm, uploadFile: upload });
  const ask: PendingAsk = { ...input, askId: 'oversize', nonce: 'nonce', createdAt: 0, deadlineAt: 1,
    settled: false, dispatchUuid: 'stable-card-uuid', answererOpenId: recipient,
    questions: [{ ...input.questions[0], prompt: 'Question '.repeat(15_000) }],
    deliveryTarget: { kind: 'document-author', openId: recipient, turnId: 'A', fileToken: 'fixture', commentId: 'comment' } };
  await dispatcher.send(ask);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(dm.mock.calls.map(call => [call[1], call[3]])).toEqual([[recipient, 'file'], [recipient, 'interactive']]);
  expect(dm.mock.calls[0][4]).toMatch(/^askf_/);
  expect(dm.mock.calls[1][4]).toBe('stable-card-uuid');
  expect(turnReplyCardRequestBytes(dm.mock.calls[1][2], recipient, 'stable-card-uuid')).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
  expect(send).not.toHaveBeenCalled();
});

it('a forwarded document card cannot request grants or change the frozen answerer', async () => {
  let card!: PendingAsk;
  setCardDispatcher({ async send(ask) { card = ask; return { messageId: 'om_card' }; } });
  setCanTalkChecker(() => true);
  const controller = new AbortController();
  const result = registerAsk({ ...input, answererOpenId: 'ou_author',
    deliveryTarget: { kind: 'document-author', openId: 'ou_author', turnId: 'A', fileToken: 'fixture', commentId: 'comment' } }, controller.signal);
  await Promise.resolve();
  const requestGrant = vi.fn();
  const response = await handleAskCardAction({ operator: { open_id: 'ou_other' },
    action: { value: { action: ASK_SELECT_ACTION, ask_id: card.askId, nonce: card.nonce, key: 'yes' } } },
  { requestGrant, larkAppId: 'cli_source' });
  expect(response).toMatchObject({ toast: { type: 'warning', content: expect.stringMatching(/没有权限|not allowed/) } });
  expect(requestGrant).not.toHaveBeenCalled();
  expect(buildAskCard(card)).toContain('fixture');
  expect(buildAskCard(card)).toMatch(/引用这张卡片|this exact card/);
  controller.abort(); await result;
});
