import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyNativeCoreState,nativeGrant,nativeCapability,nativeReserve,nativeTaskAllowed,nativeGrantKey,nativeCanApprove,nativeApproveRequest,nativeRequestGrant,nativePolicyRevision} from '../src/im/wecom/gateway/native-core.js';
import {WecomBridge,type WecomBridgePolicy} from '../src/im/wecom/gateway/bridge.js';
import type {WecomInboundMessage} from '../src/im/wecom/protocol/types.js';
const message=(id='m1',userId='guest'):WecomInboundMessage=>({messageId:id,userId,conversationId:'chat',chatType:'group',text:'do work',attachments:[],replyContext:{requestId:id}});
afterEach(()=>vi.useRealTimers());
describe('native admission and durable task quota',()=>{
 // Mutation: nativeCanApprove returning true for an operate grantee, or false for an allowed user, turns this red.
 it('lets allowed users approve and grant, and nobody else — an operate grantee included',()=>{
  const state=emptyNativeCoreState(),p={allowedUsers:['owner']};
  expect(nativeCanApprove(p,'owner')).toBe(true);
  expect(nativeCanApprove({...p,blockedUsers:['owner']},'owner')).toBe(false);
  nativeGrant(state,p,'owner','delegate','group:chat','operate',100);
  expect(nativeCapability(state,p,message('m','delegate'),101)).toBe('operate');
  expect(nativeCanApprove(p,'delegate')).toBe(false);
  expect(()=>nativeGrant(state,p,'delegate','child','group:chat','talk',101)).toThrow('wecom_grant_forbidden');
  expect(()=>nativeGrant(state,p,'guest','child','group:chat','talk',101)).toThrow('wecom_grant_forbidden');
  expect(nativeCapability(state,p,message('m','child'),102)).toBe('denied');
  expect(nativeCapability(state,p,{...message('m','delegate'),conversationId:'other'},101)).toBe('denied');
 });
 it('allows the last admitted result while rejecting new tasks, revocation and expiry',()=>{
  const state=emptyNativeCoreState(),p={allowedUsers:['admin'],messageQuotaDefaultLimit:1,grantDefaultDurationMs:1000};
  nativeGrant(state,p,'admin','guest','group:chat','talk',100);
  expect(nativeReserve(state,p,message(),'task1',101)).toBe(true);
  expect(nativeCapability(state,p,message('m2'),102)).toBe('denied');
  expect(nativeReserve(state,p,message('m2'),'task2',102)).toBe(false);
  expect(nativeTaskAllowed(state,p,message(),'task1',102)).toBe(true);
  expect(nativeTaskAllowed(state,{...p,blockedUsers:['guest']},message(),'task1',102)).toBe(false);
  expect(nativeTaskAllowed(state,p,message(),'task1',1100)).toBe(false);
  state.grants[nativeGrantKey('guest','group:chat')].revoked=true;
  expect(nativeReserve(state,p,message(),'task1',102)).toBe(false);
 });
 // Mutation: dropping the min() to the 1000 bound in wecomEffectiveMessageQuota turns this red.
 it('gives a new grant at most 1000 tasks under a larger legacy quota',()=>{
  const state=emptyNativeCoreState();
  expect(nativeGrant(state,{allowedUsers:['admin'],messageQuotaDefaultLimit:5000},'admin','guest','group:chat','talk',100).limit).toBe(1000);
  expect(nativeGrant(state,{allowedUsers:['admin'],messageQuotaDefaultLimit:7},'admin','guest','group:chat','talk',100).limit).toBe(7);
  expect(nativeGrant(state,{allowedUsers:['admin']},'admin','guest','group:chat','talk',100).limit).toBe(100);
 });
 // Mutation: removing the `parent` / `peer` / `peerParents` checks in nativeGrantLive turns this red.
 it('treats a grant an earlier version derived from another grant or from a peer as no longer live',()=>{
  const p={allowedUsers:['owner']};
  for(const legacy of [{parent:{key:'k',revision:1}},{peer:{id:'a'.repeat(64),epoch:1,peerEpoch:1}},{peerParents:[{id:'a'.repeat(64),epoch:1,peerEpoch:1}]}]){
   const state=emptyNativeCoreState();
   nativeGrant(state,p,'owner','guest','group:chat','talk',100);
   expect(nativeCapability(state,p,message(),101)).toBe('talk');
   Object.assign(state.grants[nativeGrantKey('guest','group:chat')],legacy);
   expect(nativeCapability(state,p,message(),101),JSON.stringify(legacy)).toBe('denied');
   expect(nativeReserve(state,p,message(),'task',101),JSON.stringify(legacy)).toBe(false);
  }
 });
 it('CAS checks request configuration revision and makes approval single use',()=>{
  const state=emptyNativeCoreState(),p={allowedUsers:['owner']};
  const request=nativeRequestGrant(state,p,message(),100);
  expect(nativeApproveRequest(state,{...p,messageQuotaDefaultLimit:2},request.id,'owner',101)).toBe(false);
  expect(nativeApproveRequest(state,p,request.id,'guest',101)).toBe(false);
  expect(nativeApproveRequest(state,p,request.id,'owner',101)).toBe(true);
  expect(nativeApproveRequest(state,p,request.id,'owner',102)).toBe(false);
 });
 it('limits open direct messages to talk and keeps group admission closed',()=>{
  const state=emptyNativeCoreState(),p={allowedUsers:[],p2pOpen:true};
  expect(nativeCapability(state,p,{...message(),chatType:'single'},100)).toBe('talk');
  expect(nativeCapability(state,p,message(),100)).toBe('denied');
 });
 // Cross-version persisted value: grant requests and selected repositories store this digest. A
 // configuration that never had the retired `repositories` or `approverUsers` lists must hash exactly as
 // before; the expected digests were computed by the code that still read both.
 it('keeps the policy revision of a configuration without retired lists byte-identical across the upgrade',()=>{
  expect(nativePolicyRevision({allowedUsers:['alice']})).toBe('783cae31fc1fa338817c3951ad478b18354761dc1ebd3718fae5c72adceb262d');
  const full={allowedUsers:['alice','bob'],blockedUsers:['mallory'],grantDefaultDurationMs:7200000,messageQuotaDefaultLimit:50};
  expect(nativePolicyRevision(full)).toBe('8b1e64dc8754d5c2e172720d1bc11c2d419e9cad99576a5a60ef986499b7ed05');
  // A legacy quota above the bound is not rewritten, so its digest stays too.
  expect(nativePolicyRevision({allowedUsers:['alice'],messageQuotaDefaultLimit:5000})).toBe('00388ca07a923ff21fc464ad89839fd9a396520f1938910135e7973837d768e4');
  // Keys outside the digest never moved it, then or now.
  expect(nativePolicyRevision({...full,p2pOpen:true,workingDirectory:'/srv/x',trustSameOwnerBots:false} as any)).toBe('8b1e64dc8754d5c2e172720d1bc11c2d419e9cad99576a5a60ef986499b7ed05');
 });
 it('persists grant quota and task admission in one bridge state and completes last task after reload',async()=>{
  vi.useFakeTimers();vi.setSystemTime(10000);
  const root=mkdtempSync(join(tmpdir(),'wecom-grant-task-')),file=join(root,'state.json'),reply=vi.fn(async()=>{});
  const policy:WecomBridgePolicy={allowedUsers:['admin'],messageQuotaDefaultLimit:1,canTalkDaemonCommands:['/status'],disableStreamingCard:true};
  const core={trigger:vi.fn(async()=>({ok:true,target:{kind:'turn' as const,sessionId:'s1'},triggerId:'t1'})),result:vi.fn(async()=>({ok:true,state:'completed' as const,output:{content:'last result'}})),interrupt:vi.fn(async()=>{})};
  const options={botId:'bot',allowedUsers:['admin'],stateFile:file,policy:()=>policy,transport:{reply,send:vi.fn(async()=>{})},core};
  const bridge=new WecomBridge(options);
  await bridge.receive({...message('grant','admin'),text:'/grant guest talk'});
  await bridge.receive(message());
  const saved=JSON.parse(readFileSync(file,'utf8'));expect(Object.keys(saved.tasks)).toHaveLength(1);expect(Object.values(saved.native.grants)[0]).toMatchObject({used:1});expect(Object.keys(saved.native.receipts)).toHaveLength(1);
  await bridge.receive(message('m2'));expect(Object.keys(JSON.parse(readFileSync(file,'utf8')).tasks)).toHaveLength(1);
  const restored=new WecomBridge(options);await restored.tick();expect(reply.mock.calls.some(call=>(call as unknown[])[1]==='last result')).toBe(true);expect(core.trigger).toHaveBeenCalledTimes(1);
 });
});

describe('reserving a task: grant, quota and an open private chat',()=>{
 type Grant='none'|'talk'|'operate';
 type Quota='remaining'|'last'|'used up';
 type User='allowed'|'other'|'blocked';
 const LIMIT=3;
 const cases:Array<[ 'single'|'group', boolean, Grant, Quota, User ]>=[];
 for(const chatType of ['single','group'] as const) for(const p2pOpen of [true,false]) for(const grant of ['none','talk','operate'] as const)
  for(const quota of ['remaining','last','used up'] as const) for(const user of ['allowed','other','blocked'] as const) cases.push([chatType,p2pOpen,grant,quota,user]);
 /** What a reservation should do: admit or not, and whether it takes one from the grant (with a receipt). */
 const expected=(chatType:'single'|'group',p2pOpen:boolean,grant:Grant,quota:Quota,user:User)=>{
  if(user==='blocked')return {admitted:false,charged:false};
  if(user==='allowed')return {admitted:true,charged:false};
  const openPrivate=chatType==='single'&&p2pOpen;
  if(grant==='none')return {admitted:openPrivate,charged:false};
  if(quota!=='used up')return {admitted:true,charged:true};
  // A used-up talk grant talks like anyone in an open private chat; a used-up operate grant is refused.
  return {admitted:openPrivate&&grant==='talk',charged:false};
 };
 // Mutation: admitting every used-up grant (operate too), or refusing every used-up grant again, turns this red.
 it.each(cases)('%s chat, p2pOpen %s, %s grant, quota %s, %s user',(chatType,p2pOpen,grant,quota,user)=>{
  const userId={allowed:'owner',other:'guest',blocked:'mallory'}[user];
  const p={allowedUsers:['owner','admin'],blockedUsers:['mallory'],p2pOpen,messageQuotaDefaultLimit:LIMIT};
  const m={...message('task',userId),chatType,conversationId:chatType==='single'?userId:'chat'};
  const state=emptyNativeCoreState();
  const key=nativeGrantKey(userId,`${chatType}:${m.conversationId}`);
  if(grant!=='none'){
   nativeGrant(state,p,'admin',userId,`${chatType}:${m.conversationId}`,grant,100);
   state.grants[key].used={remaining:0,last:LIMIT-1,'used up':LIMIT}[quota];
  }
  const before=state.grants[key]?.used;
  const want=expected(chatType,p2pOpen,grant,quota,user);
  expect(nativeReserve(state,p,m,'task-key',101)).toBe(want.admitted);
  expect(state.grants[key]?.used).toBe(before===undefined?undefined:before+(want.charged?1:0));
  expect(state.receipts['task-key']).toEqual(want.charged?{grant:key,revision:state.grants[key].revision}:undefined);
 });
 it('admits a used-up talk grant in an open private chat exactly as a stranger: no receipt, and no quota taken on every next task',()=>{
  const p={allowedUsers:['admin'],p2pOpen:true,messageQuotaDefaultLimit:1};
  const state=emptyNativeCoreState();
  const dm=(id:string,userId:string)=>({...message(id,userId),chatType:'single' as const,conversationId:userId});
  nativeGrant(state,p,'admin','guest','single:guest','talk',100);
  expect(nativeReserve(state,p,dm('t1','guest'),'k1',101)).toBe(true);
  for(const key of ['k2','k3'])expect(nativeReserve(state,p,dm(key,'guest'),key,102)).toBe(true);
  expect(state.grants[nativeGrantKey('guest','single:guest')].used).toBe(1);
  expect(Object.keys(state.receipts)).toEqual(['k1']);
  // While the private chat is open, both tasks without a receipt run on, like a stranger's.
  expect(nativeReserve(state,p,dm('s1','stranger'),'s1',102)).toBe(true);
  for(const [key,userId] of [['k2','guest'],['s1','stranger']])expect(nativeTaskAllowed(state,p,dm(key,userId),key,103)).toBe(true);
  // Closing it stops the stranger's task.
  expect(nativeTaskAllowed(state,{...p,p2pOpen:false},dm('s1','stranger'),'s1',103)).toBe(false);
 });
});

describe('granting in a chat',()=>{
 const bridgeWith=(policy:WecomBridgePolicy)=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-grant-chat-')),file=join(root,'state.json'),replies:string[]=[];
  const bridge=new WecomBridge({botId:'bot',allowedUsers:policy.allowedUsers,stateFile:file,policy:()=>policy,transport:{reply:async(_m,text)=>{replies.push(text);},send:async()=>{}},core:{trigger:async()=>({ok:true,target:{kind:'turn',sessionId:'s'},triggerId:'t'}),result:async()=>({ok:true,state:'running'}),interrupt:async()=>{}}});
  const grants=()=>JSON.parse(readFileSync(file,'utf8')).native.grants as Record<string,any>;
  return {bridge,replies,grants};
 };
 // Mutation: letting nativeCanApprove accept an operate grantee turns the second half red.
 it('an allowed user grants operate; the operate grantee cannot grant anyone',async()=>{
  const {bridge,replies,grants}=bridgeWith({allowedUsers:['owner']});
  await bridge.receive({...message('g1','owner'),text:'/grant ops operate'});
  expect(grants()[nativeGrantKey('ops','group:chat')]).toMatchObject({rights:'operate'});
  await bridge.receive({...message('g2','ops'),text:'/grant friend talk'});
  expect(grants()[nativeGrantKey('friend','group:chat')]).toBeUndefined();
  // Each command is answered once, and the refusal does not read like the success.
  expect(replies).toHaveLength(2); expect(replies[1]).not.toBe(replies[0]);
 });
 it('a user of a retired approverUsers list grants, as an allowed user, right after the upgrade',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-legacy-approver-')),file=join(root,'config.json');
  writeFileSync(file,JSON.stringify({botId:'bot',secretEnv:'FAKE',coreUrl:'http://127.0.0.1:19501',allowedUsers:['alice'],native:{approverUsers:['owner']}}));
  const {parseWecomConfig}=await import('../src/im/wecom/config/config.js');
  const config=parseWecomConfig(JSON.parse(readFileSync(file,'utf8')));
  const {bridge,grants}=bridgeWith({...config.native,allowedUsers:config.allowedUsers});
  await bridge.receive({...message('g1','owner'),text:'/grant guest talk'});
  expect(grants()[nativeGrantKey('guest','group:chat')]).toMatchObject({rights:'talk'});
 });
});

describe('grant requests',()=>{
 const setup=(policy:WecomBridgePolicy)=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-grant-request-')),file=join(root,'state.json'),cards:any[]=[],replies:string[]=[],trigger=vi.fn(async()=>({ok:true,target:{kind:'turn' as const,sessionId:'s'},triggerId:'t'}));
  const options={botId:'bot',connectionId:'a'.repeat(64),stateFile:file,allowedUsers:policy.allowedUsers,policy:()=>policy,transport:{reply:async(_m:WecomInboundMessage,text:string)=>{replies.push(text);},send:async()=>{},sendCard:async(to:string,card:any)=>{cards.push({to,card});},updateCard:async()=>{}},core:{trigger,result:async()=>({ok:true,state:'running' as const}),interrupt:async()=>{}}};
  return {bridge:new WecomBridge(options),options,cards,replies,trigger};
 };
 const privateHello=(userId:string)=>({...message(`dm-${userId}`,userId),conversationId:userId,chatType:'single' as const,text:'/status'});
 // Mutation: sending the card to every allowed user (dropping the privateUsers filter) turns this red.
 it('sends the request card privately to the allowed users who messaged the bot privately, and an allowed user approves it',async()=>{
  const {bridge,options,cards,trigger}=setup({allowedUsers:['owner','quiet'],autoGrantRequestCards:true,grantRequestToOwnerDm:true,messageQuotaDefaultLimit:1});
  await bridge.receive(privateHello('owner'));
  await bridge.receive(message('denied'));expect(trigger).not.toHaveBeenCalled();
  expect(cards.map(c=>c.to)).toEqual(['owner']);const card=cards[0].card;
  await bridge.receiveCardEvent({botId:'bot',messageId:'approve',userId:'owner',conversationId:'owner',chatType:'single',taskId:card.task_id,eventKey:card.button_list[0].key,receivedAt:Date.now(),requestId:'r'});
  await bridge.receive(message('accepted'));await bridge.tick();expect(trigger).toHaveBeenCalledTimes(1);
  expect(()=>new WecomBridge({...options,connectionId:'b'.repeat(64)})).toThrow('connection_identity_mismatch');
 });
 it('keeps the group notice unchanged when no allowed user can be reached privately',async()=>{
  const {bridge,cards,replies,options}=setup({allowedUsers:['owner'],autoGrantRequestCards:true,grantRequestToOwnerDm:true});
  await bridge.receive(message('denied'));
  expect(cards).toEqual([]);
  expect(replies).toHaveLength(1);
  // The group notice carries the approve command for the request it just recorded.
  const [request]=Object.values(JSON.parse(readFileSync(options.stateFile,'utf8')).native.requests) as Array<{id:string}>;
  expect(replies[0]).toContain(`/grant-approve ${request!.id}`);
 });
 it('a card approval from someone who is not an allowed user grants nothing',async()=>{
  const {bridge,cards,trigger}=setup({allowedUsers:['owner'],autoGrantRequestCards:true,grantRequestToOwnerDm:true});
  await bridge.receive(privateHello('owner'));
  await bridge.receive(message('denied'));
  const card=cards[0].card;
  await bridge.receiveCardEvent({botId:'bot',messageId:'approve',userId:'guest',conversationId:'chat',chatType:'group',taskId:card.task_id,eventKey:card.button_list[0].key,receivedAt:Date.now(),requestId:'r'});
  await bridge.receive(message('still-denied'));await bridge.tick();
  expect(trigger).not.toHaveBeenCalled();
 });
});
