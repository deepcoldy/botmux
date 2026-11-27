import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { _resetForTest, registerAsk, setCardDispatcher } from '../src/core/ask-broker.js';
import { createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import { nativeGatewayAskDecision, nativeGatewayAskSnapshots } from '../src/core/native-gateway-ask-control.js';
import { dispatchWecomAsks, type NativeAskState } from '../src/im/wecom/gateway/native-ask.js';
import { validateWecomMessageConfig } from '../src/im/wecom/config/message-config.js';
import type { WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
const dirs:string[]=[];
beforeEach(()=>{vi.useFakeTimers();_resetForTest();});
afterEach(()=>{_resetForTest();vi.restoreAllMocks();vi.useRealTimers();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const message=(messageId:string,userId:string,text:string,conversationId='group'):WecomInboundMessage=>({messageId,userId,text,conversationId,chatType:'group',attachments:[],replyContext:{requestId:messageId}});
describe('WeCom Ask and final card publishing gates',()=>{
 it('rechecks revoked native admission before each Ask card after a long send returns',async()=>{
  setCardDispatcher(createNativeGatewayAskDispatcher());
  const origin={sessionId:'session',turnId:'turn',workerGeneration:1,dispatchAttempt:1};
  const asks=['one','two'].map(requestId=>registerAsk({sessionId:'session',larkAppId:'local_bot',chatId:'http:test',rootMessageId:null,nativeGatewayOrigin:origin,requestId,questions:[{prompt:requestId,options:[{key:'yes',label:'Yes'}],multiSelect:false}],timeoutMs:10000}));
  const state:NativeAskState={};let admitted=true;let release!:()=>void;
  const sendCard=vi.fn(async()=>{if(sendCard.mock.calls.length===1)await new Promise<void>(resolve=>{release=resolve;});});
  const pending=dispatchWecomAsks({state,sessionId:'session',triggerId:'turn',message:message('m','alice','ask'),save(){},allowed:()=>admitted,sendCard,core:{asks:async()=>nativeGatewayAskSnapshots(origin,'local_bot','http:test'),answerAsk:async(_id,body)=>({outcome:nativeGatewayAskDecision(body,origin,'local_bot','http:test')})}});
  await Promise.resolve();expect(sendCard).toHaveBeenCalledTimes(1);
  admitted=false;release();await pending;
  const sent=sendCard.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10001);await Promise.all(asks);
  expect(sent).toBe(1);
 });
 it('applies the source chat feedback kill switch to the final card',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wecom-card-feedback-'));dirs.push(dir);const file=join(dir,'bridge.json');
  const feedback=validateWecomMessageConfig({feedback:{enabled:true}}).feedback!;
  const policy:WecomBridgePolicy={allowedUsers:['alice'],feedback,chatFeedbackPolicies:{group:feedback}};
  const transport={reply:vi.fn(async()=>{}),send:vi.fn(async()=>{}),sendCard:vi.fn(async(_to:string,_card:WecomTemplateCard)=>{}),updateCard:vi.fn(async()=>{})};
  const core:WecomCore={trigger:async()=>({ok:true,triggerId:'turn',target:{kind:'turn',sessionId:'session'}}),result:async()=>({ok:true,state:'completed',output:{content:'answer'}}),interrupt:async()=>{}};
  const bridge=new WecomBridge({botId:'bot',stateFile:file,allowedUsers:policy.allowedUsers,policy:()=>policy,transport,core});
  await bridge.receive(message('feedback-question','alice','question'));await bridge.tick();
  const [recipient,card]=transport.sendCard.mock.calls.find(([,card])=>card.button_list?.some(b=>b.key.startsWith('feedback:')))!;
  expect(recipient).toBe('group');policy.chatFeedbackPolicies={group:{enabled:false}};
  await bridge.receiveCardEvent({botId:'bot',messageId:'callback',userId:'alice',conversationId:'group',chatType:'group',requestId:'r',taskId:card.task_id,eventKey:'feedback:conclusive_usable',receivedAt:Date.now()});
  const task=Object.values(JSON.parse(readFileSync(file,'utf8')).tasks)[0] as any;
  expect(task.feedback).toBeUndefined();
 });

 it('does not publish an Ask fetched before the real bridge stop intent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wecom-card-ask-stop-'));dirs.push(dir);setCardDispatcher(createNativeGatewayAskDispatcher());
  const origin={sessionId:'sid',turnId:'turn',workerGeneration:1,dispatchAttempt:1};
  const result=registerAsk({sessionId:'sid',larkAppId:'local_bot',chatId:'http:test',rootMessageId:null,nativeGatewayOrigin:origin,questions:[{prompt:'QUESTION_AFTER_CANCEL',options:[{key:'yes',label:'Yes'}],multiSelect:false}],timeoutMs:10000});
  let release!:(value:any)=>void,reached!:()=>void;const waiting=new Promise<void>(resolve=>{reached=resolve;});const sendCard=vi.fn(async()=>{});
  const bridge=new WecomBridge({botId:'bot',stateFile:join(dir,'state.json'),allowedUsers:['alice'],transport:{reply:async()=>{},send:async()=>{},sendCard},core:{trigger:async()=>({ok:true,triggerId:'turn',target:{kind:'turn',sessionId:'sid'}}),result:async()=>({ok:true,state:'running'}),interrupt:async()=>{},asks:async()=>{reached();return new Promise(resolve=>{release=resolve;});},answerAsk:async(_id,body)=>({outcome:nativeGatewayAskDecision(body,origin,'local_bot','http:test')})}});
  await bridge.receive(message('ask-stop','alice','question'));const ticking=bridge.tick();await waiting;
  const stopped=bridge.receive(message('stop-real','alice','/stop'));release(nativeGatewayAskSnapshots(origin,'local_bot','http:test'));await Promise.all([ticking,stopped]);
  const cards=JSON.stringify(sendCard.mock.calls);await vi.advanceTimersByTimeAsync(10001);await result;
  expect(cards).not.toContain('QUESTION_AFTER_CANCEL');
 });

});
