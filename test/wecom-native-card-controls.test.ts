import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WecomBridge,type WecomBridgePolicy} from '../src/im/wecom/gateway/bridge.js';
import {validateWecomMessageConfig} from '../src/im/wecom/config/message-config.js';
import {createDaemonClient} from '../src/dashboard/daemon-internal-client.js';
import {createNonceStore,verifyDaemonRequest} from '../src/dashboard/daemon-internal-auth.js';
import type {WecomTemplateCard,WecomCardEvent} from '../src/im/wecom/protocol/types.js';
import {buildWecomTaskCard} from '../src/im/wecom/gateway/presentation.js';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
describe('real bridge action cards',()=>{
 it('emits every configured action alongside feedback, consumes signed terminal mints and rejects callbacks after hiding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-card-controls-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'state.json');
  const calls:any[]=[],secret='test-private-mint-secret',nonces=createNonceStore();
  const server=createServer(async(req,res)=>{const proof=await verifyDaemonRequest(req,secret,nonces);if(!proof.ok){res.writeHead(403);res.end('{}');return;}calls.push(JSON.parse(proof.bodyRaw));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,url:'http://127.0.0.1:12345/wecom-native-terminal/exchange?code=short',expiresAt:Date.now()+60000}));});server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>new Promise<void>(done=>server.close(()=>done())));
  const port=(server.address() as {port:number}).port,mint=createDaemonClient({dashboardUrl:`http://127.0.0.1:${port}`,appId:'wecom-native-terminal',secret}),cards:WecomTemplateCard[]=[],sends:string[]=[];let finished=false;
  let policy:WecomBridgePolicy={allowedUsers:['alice'],replyCardActions:true,cli:'claude-code',writableTerminalLinkInCard:true,feedback:validateWecomMessageConfig({feedback:{enabled:true}}).feedback};
  const options={botId:'bot',connectionId:'a'.repeat(64),allowedUsers:['alice'],stateFile:file,policy:()=>policy,terminalMintClient:mint,transport:{send:async(_to:string,text:string)=>{sends.push(text);},reply:async()=>{},sendCard:async(_to:string,card:WecomTemplateCard)=>{cards.push(card);},updateCard:async()=>{}},core:{trigger:async()=>({ok:true,target:{kind:'turn' as const,sessionId:'s'},triggerId:'t'}),result:async()=>({ok:true,state:finished?'completed' as const:'running' as const,output:{content:'answer'}}),interrupt:async()=>{},close:async()=>({ok:true}),slash:vi.fn(async()=>{})}};
  const bridge=new WecomBridge(options);await bridge.receive({messageId:'m',userId:'alice',conversationId:'g',chatType:'group',text:'work',attachments:[],replyContext:{requestId:'m'}});await bridge.tick();finished=true;await bridge.tick();
  const keys=cards.flatMap(c=>c.button_list?.map(b=>b.key)??[]);for(const key of ['action:stop','action:close','action:output','action:compact','action:terminal','action:writeLink'])expect(keys).toContain(key);expect(keys.some(k=>k.startsWith('feedback:'))).toBe(true);expect(cards.every(c=>(c.button_list?.length??0)<=6)).toBe(true);
  const task=(Object.values(JSON.parse(readFileSync(file,'utf8')).tasks) as any[])[0],event=(key:string,id:string):WecomCardEvent=>({messageId:id,botId:'bot',userId:'alice',conversationId:'g',chatType:'group',requestId:id,taskId:`${task.streamId}-controls`,eventKey:key,receivedAt:Date.now()});
  await bridge.receiveCardEvent(event('action:terminal','read'));await bridge.receiveCardEvent(event('action:writeLink','write'));expect(calls.map(c=>c.permission)).toEqual(['read','write']);expect(calls.some(c=>'baseUrl' in c)).toBe(false);expect(calls.every(c=>c.identity.provider==='wecom'&&c.identity.connectionId==='a'.repeat(64)&&c.sessionId==='s'&&c.triggerId==='t')).toBe(true);expect(sends).toHaveLength(2);
  policy={...policy,hiddenStreamingCardButtons:['terminal','writeLink']};await bridge.receiveCardEvent(event('action:terminal','hidden-read'));await bridge.receiveCardEvent(event('action:writeLink','hidden-write'));expect(calls).toHaveLength(2);
  const count=cards.length;await new WecomBridge(options).tick();expect(cards).toHaveLength(count);
 });
 it('never replays an attempted controls card or final answer after a lost auxiliary ACK and reload',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-card-ack-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'state.json'),reply=vi.fn(async()=>{}),sendCard=vi.fn(async(_to:string,card:WecomTemplateCard)=>{if(card.task_id.endsWith('-controls'))throw new Error('ACK unknown');});
  const options={botId:'bot',allowedUsers:['alice'],stateFile:file,policy:()=>({allowedUsers:['alice'],replyCardActions:true,cli:'claude-code'}),transport:{reply,send:async()=>{},sendCard},core:{trigger:async()=>({ok:true,target:{kind:'turn' as const,sessionId:'s'},triggerId:'t'}),result:async()=>({ok:true,state:'completed' as const,output:{content:'answer'}}),interrupt:async()=>{}}};
  const bridge=new WecomBridge(options);await bridge.receive({messageId:'m',userId:'alice',conversationId:'g',chatType:'group',text:'work',attachments:[],replyContext:{requestId:'m'}});await bridge.tick();const calls=sendCard.mock.calls.length,replies=reply.mock.calls.length;expect(sendCard.mock.calls.some(c=>c[1].task_id.endsWith('-controls'))).toBe(true);await new WecomBridge(options).tick();expect(sendCard).toHaveBeenCalledTimes(calls);expect(reply).toHaveBeenCalledTimes(replies);
 });
});

describe('terminal buttons without a per-bot terminal address',()=>{
 const keys=(policy:Parameters<typeof buildWecomTaskCard>[0]['policy'])=>buildWecomTaskCard({taskId:'t',running:true,policy})?.button_list?.map(button=>button.key)??[];
 it('shows the read-only terminal whenever card actions are on, and the write link only when it is enabled as well',()=>{
  expect(keys({replyCardActions:true})).toContain('action:terminal');
  expect(keys({replyCardActions:true})).not.toContain('action:writeLink');
  expect(keys({replyCardActions:true,writableTerminalLinkInCard:true})).toEqual(expect.arrayContaining(['action:terminal','action:writeLink']));
  const hidden=keys({replyCardActions:true,writableTerminalLinkInCard:true,hiddenStreamingCardButtons:['terminal','writeLink']});
  expect(hidden).not.toContain('action:terminal');expect(hidden).not.toContain('action:writeLink');
  for(const off of [{writableTerminalLinkInCard:true},{replyCardActions:false,writableTerminalLinkInCard:true}]){
   expect(keys(off)).not.toContain('action:terminal');expect(keys(off)).not.toContain('action:writeLink');
  }
 });
});

describe('the retired reply-draft button',()=>{
 it('is never offered, and a click on one from an earlier card is ignored: nothing recorded, answered or run',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-substitute-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'state.json');
  const cards:WecomTemplateCard[]=[],updateCard=vi.fn(async()=>{}),send=vi.fn(async()=>{}),reply=vi.fn(async()=>{}),close=vi.fn(async()=>({ok:true})),slash=vi.fn(async()=>{}),interrupt=vi.fn(async()=>{});let finished=false;
  // A policy that still carries the retired draft prompt, as an old configuration would have.
  const policy={allowedUsers:['alice'],replyCardActions:true,cli:'claude-code',substitutePrompt:'editable draft'} as WecomBridgePolicy;
  const bridge=new WecomBridge({botId:'bot',allowedUsers:['alice'],stateFile:file,policy:()=>policy,transport:{send,reply,sendCard:async(_to:string,card:WecomTemplateCard)=>{cards.push(card);},updateCard},core:{trigger:async()=>({ok:true,target:{kind:'turn' as const,sessionId:'s'},triggerId:'t'}),result:async()=>({ok:true,state:finished?'completed' as const:'running' as const,output:{content:'answer'}}),interrupt,close,slash}});
  await bridge.receive({messageId:'m',userId:'alice',conversationId:'g',chatType:'group',text:'work',attachments:[],replyContext:{requestId:'m'}});await bridge.tick();finished=true;await bridge.tick();
  expect(cards.flatMap(card=>card.button_list?.map(button=>button.key)??[])).not.toContain('action:substitute');
  const task=(Object.values(JSON.parse(readFileSync(file,'utf8')).tasks) as any[])[0],before=readFileSync(file,'utf8'),sentBefore=send.mock.calls.length+reply.mock.calls.length;
  for(const taskId of [`${task.streamId}-controls`,`${task.streamId}-final`]){
   await expect(bridge.receiveCardEvent({messageId:`click-${taskId}`,botId:'bot',userId:'alice',conversationId:'g',chatType:'group',requestId:'r',taskId,eventKey:'action:substitute',receivedAt:Date.now()})).resolves.toBeUndefined();
  }
  expect(readFileSync(file,'utf8')).toBe(before);
  expect(updateCard).not.toHaveBeenCalled();expect(send.mock.calls.length+reply.mock.calls.length).toBe(sentBefore);
  expect(close).not.toHaveBeenCalled();expect(slash).not.toHaveBeenCalled();expect(interrupt).not.toHaveBeenCalled();expect(bridge.poisoned).toBe(false);
 });
});
