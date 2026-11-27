import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { parseBotConfigsFromText, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { registerAsk, _resetForTest, setCardDispatcher } from '../src/core/ask-broker.js';
import { createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import { dispatchWecomAsks, wecomAskCardEvent, type NativeAskState } from '../src/im/wecom/gateway/native-ask.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import * as pool from '../src/core/worker-pool.js';
let server:IpcServerHandle|undefined;
const secret='native-ask-http-fixture';
afterEach(async()=>{_resetForTest();await server?.close();server=undefined;setIpcAuthSecret(null);setLarkAppId('');__testOnly_resetBotRegistry();vi.unstubAllEnvs();vi.restoreAllMocks();});
async function setup(){
 vi.stubEnv('BOTMUX_CORE_ONLY','1');__testOnly_resetBotRegistry();registerBot(parseBotConfigsFromText(JSON.stringify([{larkAppId:'local_ask',apiOnly:true,cliId:'codex'}]))[0]);
 setLarkAppId('local_ask');setIpcAuthSecret(secret);_resetForTest();setCardDispatcher(createNativeGatewayAskDispatcher());
 const ds:any={larkAppId:'local_ask',chatId:'http_async_fixture',workerGeneration:2,session:{sessionId:'session',larkAppId:'local_ask'},asyncTriggerResults:new Map([['turn',{status:'pending'}]]),activeInteractiveTurn:{turnId:'turn'},managedTurnOrigin:{turnId:'turn',dispatchAttempt:4}};
 vi.spyOn(pool,'findActiveBySessionId').mockImplementation(id=>id==='session'?ds:undefined);
 server=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,coreOnlyPublicRoutes:true});
 const origin={turnId:'turn',workerGeneration:2,dispatchAttempt:4};
 const result=registerAsk({larkAppId:'local_ask',chatId:ds.chatId,sessionId:'session',rootMessageId:null,nativeGatewayOrigin:origin,questions:[{prompt:'Proceed?',options:[{key:'yes',label:'Yes'},{key:'no',label:'No'}],multiSelect:false}],timeoutMs:10000});
 const request=(async(input:any,init?:RequestInit)=>{const url=new URL(String(input)),path=url.pathname+url.search,method=init?.method??'GET';return fetch(input,{...init,headers:daemonIpcAuthHeaders({secret,port:server!.port,method,path,headers:init?.headers})});}) as typeof fetch;
 const core=new WecomHttpCore(`http://127.0.0.1:${server.port}`,request);
 return {ds,result,core};
}
describe('native Ask HTTP uses real broker and native gateway',()=>{
 it('requires HMAC, binds exact origin, receives native card and resumes the waiting Ask caller',async()=>{
  const f=await setup(),url=`http://127.0.0.1:${server!.port}/api/sessions/session/native-gateway-asks?triggerId=turn`;
  expect((await fetch(url)).status).toBe(401);
  const snapshots=await f.core.asks!('session','turn');expect(snapshots).toHaveLength(1);
  const state:NativeAskState={},cards:any[]=[];
  await dispatchWecomAsks({state,core:f.core as any,sessionId:'session',triggerId:'turn',message:{messageId:'m',userId:'alice',chatType:'group',conversationId:'g',text:'question',attachments:[],replyContext:{requestId:'m'}},sendCard:async(recipient,card)=>{cards.push({recipient,card});},save(){},allowed:()=>true});
  // The card goes to the chat the question came from, and is answered there.
  expect(cards.map(c=>c.recipient)).toEqual(['g']);
  const click=async(key:string)=>wecomAskCardEvent({state,core:f.core as any,event:{messageId:key,botId:'bot',userId:'alice',conversationId:'g',chatType:'group',requestId:'callback',taskId:cards[0].card.task_id,eventKey:key,receivedAt:Date.now()},save(){},allowed:()=>true,update:async()=>{}});
  await click('ask:toggle:0:0');
  const old=snapshots[0];f.ds.workerGeneration=3;
  expect(await f.core.answerAsk!('session',{action:'submit',askId:old.ask.askId,nonce:old.ask.nonce,by:'alice',origin:old.origin})).toMatchObject({outcome:'stale'});
  f.ds.workerGeneration=2;await click('ask:submit');expect(await f.result).toMatchObject({kind:'answered',by:'alice',answers:[['yes']]});
 });
});
