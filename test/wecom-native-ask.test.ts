import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { _resetForTest, setCardDispatcher, registerAsk, listPendingAsks, submitAsk } from '../src/core/ask-broker.js';
import { createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import { nativeGatewayAskDecision, nativeGatewayAskSnapshots, type NativeGatewayAskOrigin } from '../src/core/native-gateway-ask-control.js';
import { dispatchWecomAsks, wecomAskCardEvent, wecomAskText, buildWecomAskCard, type NativeAskState, type NativeAskCore } from '../src/im/wecom/gateway/native-ask.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
const origin:NativeGatewayAskOrigin={sessionId:'session',turnId:'turn',workerGeneration:3,dispatchAttempt:2};
// A private chat: the ask card goes back to the conversation the turn came from.
const message:WecomInboundMessage={messageId:'m',userId:'alice',conversationId:'alice',chatType:'single',text:'question',attachments:[],replyContext:{requestId:'m'}};
const questions=[{prompt:'Choose environment',multiSelect:true,options:[{key:'linux',label:'Linux'},{key:'mac',label:'macOS'}]},{prompt:'Choose action',multiSelect:false,options:[{key:'build',label:'Build'},{key:'test',label:'Test'}]}];
const register=(extra:Record<string,unknown>={})=>registerAsk({sessionId:'session',larkAppId:'local_bot',chatId:'http:test',rootMessageId:null,questions,timeoutMs:10000,nativeGatewayOrigin:origin,...extra});
const event=(taskId:string,key:string,extra:Partial<WecomCardEvent>={}):WecomCardEvent=>({messageId:`event-${key}`,botId:'bot',userId:'alice',conversationId:'alice',chatType:'single',requestId:'callback',taskId,eventKey:key,receivedAt:Date.now(),...extra});
beforeEach(()=>{vi.useFakeTimers();_resetForTest();setCardDispatcher(createNativeGatewayAskDispatcher());});
afterEach(()=>{_resetForTest();vi.useRealTimers();});
function setup(){
 const state:NativeAskState={},cards:Array<[string,WecomTemplateCard]>=[],updates:WecomTemplateCard[]=[];
 const core:NativeAskCore={asks:async()=>nativeGatewayAskSnapshots(origin,'local_bot','http:test'),answerAsk:async(_sid,body)=>({outcome:nativeGatewayAskDecision(body,origin,'local_bot','http:test')})};
 const sendCard=async(recipient:string,card:WecomTemplateCard)=>{cards.push([recipient,card]);};
 const dispatch=()=>dispatchWecomAsks({state,core,sessionId:'session',triggerId:'turn',message,sendCard,save(){},allowed:()=>true});
 const click=(key:string,extra:Partial<WecomCardEvent>={})=>wecomAskCardEvent({state,core,event:event(cards[0][1].task_id,key,extra),save(){},allowed:user=>user==='alice',update:async card=>{updates.push(card);}});
 return {state,core,cards,updates,dispatch,click};
}
describe('real Ask broker through native gateway dispatcher',()=>{
 it('delivers to the private chat it came from, commits broker receipt, toggles multiple questions and resolves the actual waiting caller',async()=>{
  const result=register();const f=setup();await f.dispatch();
  expect(f.cards).toHaveLength(1);expect(f.cards[0][0]).toBe('alice');
  await Promise.resolve();expect(listPendingAsks()[0].cardMessageId).toBe(f.cards[0][1].task_id);
  const ask=listPendingAsks()[0];expect(submitAsk({askId:ask.askId,nonce:ask.nonce,by:'alice',selections:[['linux'],['test']]})).toBe('unauthorized');
  await f.click('ask:toggle:0:0');await f.click('ask:toggle:0:1');await f.click('ask:toggle:1:1');await f.click('ask:submit');
  expect(await result).toMatchObject({kind:'answered',by:'alice',answers:[['linux','mac'],['test']]});
  expect(listPendingAsks()).toHaveLength(0);
 });
 it('rejects native ACL, replay, forwarded cards and stale worker/attempt before settlement',async()=>{
  const result=register();const f=setup();await f.dispatch();
  await f.click('ask:toggle:0:0',{userId:'mallory'});await f.click('ask:toggle:0:0',{conversationId:'other'});
  expect(listPendingAsks()[0].selections).toEqual([[],[]]);
  await f.click('ask:toggle:0:0');await f.click('ask:toggle:0:0');expect(listPendingAsks()[0].selections).toEqual([['linux'],[]]);
  await f.click('ask:toggle:1:0');
  const ask=listPendingAsks()[0];
  for(const wrong of [{...origin,workerGeneration:4},{...origin,turnId:'later'},{...origin,dispatchAttempt:3}])expect(nativeGatewayAskDecision({action:'submit',askId:ask.askId,nonce:ask.nonce,by:'alice',origin:wrong},origin,'local_bot','http:test')).toBe('stale');
  await vi.advanceTimersByTimeAsync(10001);expect(await result).toMatchObject({kind:'timedOut'});
 });
 it('supports explicit askId text fallback without fake principals or a separate gateway broker',async()=>{
  const result=register({questions:[{prompt:'Explain',options:[],multiSelect:false,inputMode:'text'}]});const f=setup();await f.dispatch();
  expect(f.cards[0][1].card_type).toBe('text_notice');const ask=listPendingAsks()[0];
  expect(await wecomAskText({state:f.state,core:f.core,message:{...message,conversationId:'alice',chatType:'single',text:`/ask ${ask.askId} use the safer option`},allowed:()=>true,reply:async()=>{}})).toBe(true);
  expect(await result).toMatchObject({kind:'answered',by:'alice',comment:'use the safer option'});
 });
 it('validates typed form fallback and forbids custom text on constrained choices',async()=>{
  let result=register({questions:[{prompt:'Count',input:{type:'number',min:1,max:3},options:[],multiSelect:false}]});let f=setup();await f.dispatch();let ask=listPendingAsks()[0];
  const send=(text:string)=>wecomAskText({state:f.state,core:f.core,message:{...message,conversationId:'alice',chatType:'single',text:`/ask ${ask.askId} ${text}`},allowed:()=>true,reply:async()=>{}});
  await send('{"q0":"99"}');expect(listPendingAsks()).toHaveLength(1);await send('{"q0":"2"}');expect(await result).toMatchObject({kind:'answered',inputs:['2']});
  result=register({requestId:'constrained',questions:[{...questions[1],allowCustom:false}]});f=setup();await f.dispatch();ask=listPendingAsks()[0];await wecomAskText({state:f.state,core:f.core,message:{...message,conversationId:'alice',chatType:'single',text:`/ask ${ask.askId} arbitrary bypass`},allowed:()=>true,reply:async()=>{}});expect(listPendingAsks()).toHaveLength(1);
  await f.click('ask:toggle:0:1');await f.click('ask:submit');expect(await result).toMatchObject({kind:'answered',answers:[['test']]});
 });
 it('keeps an uncertain native delivery at most once and refuses a false receipt',async()=>{
  const result=register();const f=setup();const reject=vi.fn(async()=>{throw new Error('ack lost');});
  const dispatch=()=>dispatchWecomAsks({state:f.state,core:f.core,sessionId:'session',triggerId:'turn',message,sendCard:reject,save(){},allowed:()=>true});
  await dispatch();await dispatch();expect(reject).toHaveBeenCalledTimes(1);expect(listPendingAsks()[0].cardMessageId).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10001);expect(await result).toMatchObject({kind:'timedOut'});
 });
 it('requires explicit empty confirmation',async()=>{
  const result=register({questions:[questions[0]]});const f=setup();await f.dispatch();
  await f.click('ask:submit');expect(f.updates.at(-1)?.button_list?.some(b=>b.key==='ask:confirm')).toBe(true);await f.click('ask:confirm');
  expect(await result).toMatchObject({kind:'answered',answers:[[]]});
 });
 // Mutation: changing the fixed page size turns this red.
 it('shows four options per page, the rest behind the next-page button',async()=>{
  register({questions:[{prompt:'Pick',multiSelect:false,options:['a','b','c','d','e','f'].map(key=>({key,label:key.toUpperCase()}))}]});
  const f=setup();await f.dispatch();const snapshot=(await f.core.asks('session','turn'))[0];
  const options=(card:WecomTemplateCard)=>(card.button_list??[]).filter(button=>button.key.startsWith('ask:toggle:')).map(button=>button.text);
  expect(options(f.cards[0][1])).toEqual(['A','B','C','D']);
  expect(f.cards[0][1].button_list?.some(button=>button.key==='ask:page:1')).toBe(true);
  expect(options(buildWecomAskCard(snapshot,1))).toEqual(['E','F']);
 });
});

/**
 * How the core's ask-answer route answers (the delivery receipts always go
 * through the real decision):
 *  - live:     the real decision for the live execution;
 *  - stale409: 409 stale_execution — the execution is gone (session closed,
 *              another turn or worker generation);
 *  - stale200: the real decision against a newer worker generation, i.e.
 *              outcome `stale`;
 *  - error500 / network: no verdict at all.
 */
type AnswerRoute = 'live' | 'stale409' | 'stale200' | 'other409' | 'error500' | 'network';

describe('answering an ask that can no longer be answered, through the gateway bridge', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A real bridge whose turn (session/turn of `origin`) is running with one
   * ask card delivered to Alice's private chat. Only the ask-answer route goes
   * through the real HTTP client, so a refusal reaches the gateway as it would
   * from the core.
   */
  async function bridgeFixture() {
    register();
    const root = mkdtempSync(join(tmpdir(), 'wecom-stale-ask-'));
    roots.push(root);
    const route = { mode: 'live' as AnswerRoute };
    const answerRoute = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.action === 'delivered' || route.mode === 'live') {
        return Response.json({ ok: true, outcome: nativeGatewayAskDecision(body, origin, 'local_bot', 'http:test') });
      }
      if (route.mode === 'stale409') {
        return Response.json({ ok: false, error: 'stale_execution' }, { status: 409 });
      }
      if (route.mode === 'stale200') {
        const newer = { ...origin, workerGeneration: origin.workerGeneration + 1 };
        return Response.json({ ok: true, outcome: nativeGatewayAskDecision(body, newer, 'local_bot', 'http:test') });
      }
      if (route.mode === 'other409') {
        return Response.json({ ok: false, error: 'session_transferring' }, { status: 409 });
      }
      if (route.mode === 'error500') {
        return Response.json({ ok: false }, { status: 500 });
      }
      throw new TypeError('fetch failed');
    });
    const http = new WecomHttpCore('http://127.0.0.1:12345', answerRoute as unknown as typeof fetch);
    const core: WecomCore = {
      trigger: vi.fn(async () => ({ ok: true, triggerId: origin.turnId, target: { kind: 'turn' as const, sessionId: origin.sessionId } })),
      result: vi.fn(async () => ({ ok: true, state: 'running' as const })),
      interrupt: vi.fn(async () => {}),
      asks: async () => nativeGatewayAskSnapshots(origin, 'local_bot', 'http:test'),
      answerAsk: (sessionId, body) => http.answerAsk(sessionId, body),
    };
    const transport = {
      reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {}),
      send: vi.fn(async (_recipient: string, _text: string) => {}),
      sendCard: vi.fn(async (_recipient: string, _card: WecomTemplateCard) => {}),
      updateCard: vi.fn(async (_event: WecomCardEvent, _card: WecomTemplateCard) => {}),
    };
    const bridge = new WecomBridge({ botId: 'bot', stateFile: join(root, 'state.json'), allowedUsers: ['alice'], core, transport });
    await bridge.receive(message);
    await bridge.tick();
    expect(transport.sendCard).toHaveBeenCalledTimes(1);
    const askCard = transport.sendCard.mock.calls[0][1];
    const askId = listPendingAsks()[0].askId;
    // Only what the answer causes counts below.
    transport.reply.mockClear();
    answerRoute.mockClear();
    const answer = (id: string): WecomInboundMessage => ({
      ...message,
      messageId: id,
      text: `/ask ${askId} linux please`,
      replyContext: { requestId: id },
    });
    const click = (id: string): WecomCardEvent => event(askCard.task_id, 'ask:toggle:0:0', { messageId: id, botId: 'bot' });
    /** Requests the answer route got for anything but a delivery receipt. */
    const answersSent = () => answerRoute.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action !== 'delivered');
    return { bridge, route, transport, answer, click, answersSent };
  }

  type Fixture = Awaited<ReturnType<typeof bridgeFixture>>;
  const repliesTo = (f: Fixture) => f.transport.reply.mock.calls.map(([to]) => ({ messageId: to.messageId, conversationId: to.conversationId }));
  const updatedCards = (f: Fixture) => f.transport.updateCard.mock.calls.map(([, card]) => card);

  it('a text answer the core refuses as stale_execution (409) is told once, in the answerer\'s chat', async () => {
    const f = await bridgeFixture();
    f.route.mode = 'stale409';

    await f.bridge.receive(f.answer('answer-409'));

    expect(f.answersSent()).toHaveLength(1);
    expect(repliesTo(f)).toEqual([{ messageId: 'answer-409', conversationId: 'alice' }]);
    expect(f.transport.updateCard).not.toHaveBeenCalled();
  });

  it('a card click the core refuses as stale_execution (409) turns the card into a notice without buttons', async () => {
    const f = await bridgeFixture();
    f.route.mode = 'stale409';

    await f.bridge.receiveCardEvent(f.click('click-409'));

    expect(f.answersSent()).toHaveLength(1);
    const cards = updatedCards(f);
    expect(cards).toHaveLength(1);
    expect(cards[0].card_type).toBe('text_notice');
    expect(cards[0].button_list).toBeUndefined();
    expect(f.transport.reply).not.toHaveBeenCalled();
  });

  it('a text answer the core judges stale (200, outcome stale) is told once', async () => {
    const f = await bridgeFixture();
    f.route.mode = 'stale200';

    await f.bridge.receive(f.answer('answer-200-stale'));

    expect(f.answersSent()).toHaveLength(1);
    expect(repliesTo(f)).toEqual([{ messageId: 'answer-200-stale', conversationId: 'alice' }]);
  });

  it('after a close revoked the asking task, text and card answers are told without asking the core', async () => {
    const f = await bridgeFixture();
    const closed = await f.bridge.controlSession(
      { sessionId: origin.sessionId, operation: 'close', requestId: 'close-asking-turn' },
      async () => ({ ok: true }),
    );
    expect(closed).toMatchObject({ ok: true });

    await f.bridge.receive(f.answer('answer-after-close'));
    await f.bridge.receiveCardEvent(f.click('click-after-close'));

    expect(f.answersSent()).toEqual([]);
    expect(repliesTo(f)).toEqual([{ messageId: 'answer-after-close', conversationId: 'alice' }]);
    const cards = updatedCards(f);
    expect(cards).toHaveLength(1);
    expect(cards[0].card_type).toBe('text_notice');
    expect(cards[0].button_list).toBeUndefined();
  });

  // Not a verdict: the error still surfaces and nothing claims the ask is stale.
  it.each(['other409', 'error500', 'network'] as const)('%s: no stale notice, the error propagates', async mode => {
    const f = await bridgeFixture();
    f.route.mode = mode;

    // The core's own failure, not something the stale handling raised.
    const failure = { other409: 'HTTP 409', error500: 'HTTP 500', network: 'fetch failed' }[mode];
    await expect(f.bridge.receive(f.answer(`answer-${mode}`))).rejects.toThrow(failure);
    await expect(f.bridge.receiveCardEvent(f.click(`click-${mode}`))).rejects.toThrow(failure);

    expect(f.answersSent()).toHaveLength(2);
    expect(f.transport.reply).not.toHaveBeenCalled();
    expect(f.transport.updateCard).not.toHaveBeenCalled();
  });
});

describe('a stale ask stays silent toward whoever may not answer it', () => {
  it('no reply, no card update and no core request for someone without access, another chat or a repeated callback', async () => {
    register();
    const f = setup();
    await f.dispatch();
    const askId = listPendingAsks()[0].askId;
    const answerAsk = vi.spyOn(f.core, 'answerAsk');
    const replied: string[] = [];
    // The gateway knows the asking task ended.
    const current = () => false;
    const text = (id: string, extra: Partial<WecomInboundMessage> = {}) => wecomAskText({
      state: f.state,
      core: f.core,
      current,
      message: { ...message, messageId: id, text: `/ask ${askId} linux`, ...extra },
      allowed: user => user === 'alice',
      reply: async () => {
        replied.push(id);
      },
    });
    const click = (id: string, extra: Partial<WecomCardEvent> = {}) => wecomAskCardEvent({
      state: f.state,
      core: f.core,
      current,
      event: event(f.cards[0][1].task_id, 'ask:toggle:0:0', { messageId: id, ...extra }),
      save() {},
      allowed: user => user === 'alice',
      update: async card => {
        f.updates.push(card);
      },
    });

    await text('text-mallory', { userId: 'mallory' });
    await text('text-other-chat', { conversationId: 'other-chat', chatType: 'group' });
    await click('click-mallory', { userId: 'mallory' });
    await click('click-other-chat', { conversationId: 'other-chat', chatType: 'group' });
    expect(replied).toEqual([]);
    expect(f.updates).toEqual([]);

    // Alice, in her chat, is told; the same callback delivered again is not.
    await click('click-alice');
    await click('click-alice');
    await text('text-alice');
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].button_list).toBeUndefined();
    expect(replied).toEqual(['text-alice']);
    expect(answerAsk).not.toHaveBeenCalled();
  });
});
