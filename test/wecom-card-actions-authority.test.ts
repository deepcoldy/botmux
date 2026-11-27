import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WecomBridge,type WecomBridgePolicy} from '../src/im/wecom/gateway/bridge.js';
import {validateWecomMessageConfig} from '../src/im/wecom/config/message-config.js';
import {WecomDeliveryUncertainError,type WecomInboundMessage,type WecomTemplateCard} from '../src/im/wecom/protocol/types.js';
import {NativeTerminalAccess} from '../src/dashboard/wecom/terminal-access.js';
import {startWecomGatewayControl} from '../src/im/wecom/gateway/gateway-control.js';
import {createDaemonClient} from '../src/dashboard/daemon-internal-client.js';
import { WECOM_DASHBOARD_ROUTE_PATHS } from '../src/im/wecom/contract/dashboard-routes.js';
import { WECOM_GATEWAY_CONTROL_PATHS, type WecomTerminalAuthorization } from '../src/im/wecom/contract/gateway-control.js';
const redirect={url:'',secret:'actions-isolated-hmac'};
const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{redirect.url='';for(const close of cleanup.splice(0).reverse())await close();});
const message=(id:string,text:string,userId='alice',chatType:'group'|'single'='group'):WecomInboundMessage=>({messageId:id,userId,conversationId:chatType==='group'?'group':userId,chatType,text,attachments:[],replyContext:{requestId:id}});
function fixture(extra:Partial<WecomBridgePolicy>={}){
 const dir=mkdtempSync(join(tmpdir(),'wecom-card-actions-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'state.json');
 const policy:WecomBridgePolicy={allowedUsers:['alice'],cli:'claude',replyCardActions:true,writableTerminalLinkInCard:true,feedback:validateWecomMessageConfig({feedback:{enabled:true}}).feedback,...extra};
 let completed=false;const core={trigger:vi.fn(async()=>({ok:true,triggerId:'turn',target:{kind:'turn' as const,sessionId:'sid'}})),result:vi.fn(async()=>({ok:true,state:completed?'completed' as const:'running' as const,output:{content:'result'}})),interrupt:vi.fn(async()=>{}),close:vi.fn(async()=>({ok:true})),slash:vi.fn(async()=>({ok:true})),progress:vi.fn(async()=>({turnId:'turn',workerGeneration:1,entries:[]}))};
 const transport={send:vi.fn(async(_recipient:string,_text:string)=>{}),reply:vi.fn(async()=>{}),sendCard:vi.fn(async(_recipient:string,_card:WecomTemplateCard)=>{}),updateCard:vi.fn(async()=>{})};
 const create=()=>new WecomBridge({botId:'bot',connectionId:'connection',stateFile:file,allowedUsers:policy.allowedUsers,policy:()=>policy,transport,core,terminalMintClient:{request:options=>createDaemonClient({dashboardUrl:redirect.url,appId:'actions-native-card',secret:redirect.secret}).request(options)}});
 const state=()=>JSON.parse(readFileSync(file,'utf8'));const event=(card:WecomTemplateCard,key:string)=>({botId:'bot',messageId:'event-'+key,taskId:card.task_id,eventKey:'action:'+key,userId:'alice',conversationId:'group',chatType:'group' as const,receivedAt:Date.now(),requestId:'callback'});
 return {policy,core,transport,create,state,event,complete(){completed=true;}};
}
describe('native action cards on real bridge cards',()=>{
 it('makes every configured action reachable on actual bridge cards within the native button limit',async()=>{
  const f=fixture(),bridge=f.create();await bridge.receive(message('q','question'));await bridge.tick();f.complete();await bridge.tick();
  const cards=f.transport.sendCard.mock.calls.map(([,card])=>card),keys=cards.flatMap(card=>card.button_list?.map(button=>button.key)??[]);
  expect(cards.every(card=>(card.button_list?.length??0)<=6)).toBe(true);
  for(const key of ['output','terminal','writeLink','compact','stop','close'])expect(keys).toContain('action:'+key);
  expect(cards.some(card=>card.button_list?.some(button=>button.key.startsWith('feedback:')))).toBe(true);
 });
 it.each(['output','terminal','writeLink','compact','stop','close'] as const)('rejects an already-sent %s action after its current policy is hidden',async key=>{
  const f=fixture(),bridge=f.create();await bridge.receive(message('q','question'));await bridge.tick();if(key!=='stop'){f.complete();await bridge.tick();}
  const card=f.transport.sendCard.mock.calls.map(([,card])=>card).find(card=>card.button_list?.some(button=>button.key==='action:'+key));expect(card).toBeDefined();
  f.policy.hiddenStreamingCardButtons=[key];const event=f.event(card!,key);await bridge.receiveCardEvent(event);
  const task=Object.values(f.state().tasks)[0] as any;expect(task.cardEvents?.[event.messageId]).toBeUndefined();
  expect(f.core.close).not.toHaveBeenCalled();expect(f.core.slash).not.toHaveBeenCalled();expect(f.transport.updateCard).not.toHaveBeenCalled();
 });
 it('recovers unsent final actions after a prior feedback card has an unknown ACK without replaying that unknown card',async()=>{
  const f=fixture(),bridge=f.create();await bridge.receive(message('q','question'));await bridge.tick();
  let reached!:()=>void,release!:()=>void;let feedbackAttempts=0;const waiting=new Promise<void>(resolve=>{reached=resolve;});
  f.transport.sendCard.mockImplementation(async(_recipient,card)=>{if(card.button_list?.some(button=>button.key.startsWith('feedback:'))){feedbackAttempts++;if(feedbackAttempts===1){reached();await new Promise<void>(resolve=>{release=resolve;});}throw new WecomDeliveryUncertainError('ACK unknown');}});
  f.complete();const oldTick=bridge.tick();await waiting;
  const before=f.transport.sendCard.mock.calls.length;await f.create().tick();const recovered=f.transport.sendCard.mock.calls.slice(before).map(([,card])=>card);
  release();await oldTick;
  expect(recovered.some(card=>card.button_list?.some(button=>button.key==='action:close'))).toBe(true);
  expect(recovered.some(card=>card.button_list?.some(button=>button.key.startsWith('feedback:')))).toBe(false);
 });
 it.each([{key:'terminal',permission:'read'},{key:'writeLink',permission:'write'}] as const)('uses a delivered $key action to mint and exchange a scoped browser through real signed handlers',async({key,permission})=>{
  const f=fixture(),bridge=f.create();const gateway=await startWecomGatewayControl({bridge,instanceId:'instance',coreIdentity:'core',secret:redirect.secret,coreAction:async()=>({ok:true})});cleanup.push(()=>gateway.stop());
  const gatewayClient=createDaemonClient({dashboardUrl:`http://127.0.0.1:${gateway.port}`,appId:'actions-authority',secret:redirect.secret});let mintCalls=0;
  const access = new NativeTerminalAccess({
   secret: redirect.secret,
   origin: () => redirect.url,
   resolve: async input => {
    const result = await gatewayClient.request({
     method: 'POST',
     path: WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize,
     body: { ...input, instanceId: 'instance' },
    });
    const body = result.body as WecomTerminalAuthorization;
    if (!body.allowed) throw new Error('denied');
    return { uiSessionId: 'source', nativeSessionId: input.sessionId, binding: 'worker-1', proxyPort: 12346, epoch: body.epoch };
   },
  });
  const server = createServer(async (req, res) => {
   if (req.url?.startsWith(WECOM_DASHBOARD_ROUTE_PATHS.terminalMint)) mintCalls++;
   if (!await access.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) {
    res.writeHead(404).end();
   }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
   server.closeAllConnections();
   await new Promise<void>(resolve => server.close(() => resolve()));
  });
  redirect.url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await bridge.receive(message('q','question'));await bridge.tick();
  const card=f.transport.sendCard.mock.calls.map(([,card])=>card).find(card=>card.button_list?.some(button=>button.key==='action:'+key));expect(card).toBeDefined();
  await bridge.receiveCardEvent(f.event(card!,key));expect(mintCalls).toBe(1);
  const sent=f.transport.send.mock.calls.find(([,text])=>text.includes('/wecom-terminal/exchange?code='));expect(sent?.[0]).toBe('alice');const link=sent![1].match(/https?:\/\/\S+/)![0];expect(link).not.toContain(redirect.secret);
  const response=await fetch(link,{redirect:'manual'});expect(response.status).toBe(303);expect(response.headers.get('set-cookie')).toContain('HttpOnly');expect(response.headers.get('location')).toMatch(/^\/wecom-terminal\/native\//);
  const browserId=response.headers.get('location')!.split('/')[3],cookie=response.headers.get('set-cookie')!.split(';')[0];const browser=await access.authenticate({headers:{cookie,host:new URL(redirect.url).host}} as any,browserId);expect(browser?.claim.permission).toBe(permission);
  expect((await fetch(link,{redirect:'manual'})).status).toBe(403);
 });

});
