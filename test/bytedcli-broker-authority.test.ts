import { afterEach, describe, expect, it } from 'vitest';
import { resolveBytedcliAuthority, type BytedcliAuthorityDependencies } from '../src/core/bytedcli-broker-authority.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { rememberLarkToolDelegation, clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
const dataDir='/tmp/bytedcli-authority-test';
afterEach(()=>clearLarkToolDelegations(dataDir,'s-authority'));
function setup(){
  const ds:any={session:{sessionId:'s-authority',status:'active',backendType:'pty'},larkAppId:'cli_authority',chatId:'oc_authority',workerGeneration:7,
    worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:7,cliPid:process.pid,cliProcStart:readProcessStartIdentity(process.pid)},
    managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'arrival-B',identityTurnId:'executing-A',
      trustedCaller:{senderType:'user',requestUserOpenId:'ou_A'},callerOpenId:'ou_A',preexistingProcessIdentities:[`${process.pid}:${readProcessStartIdentity(process.pid)}`]}};
  let policy:any={enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor',credentialSource:'local'};
  let allowed=true,contained=true,epoch=0,binding='binding-A',identities=0;
  const deps:BytedcliAuthorityDependencies={daemonBootId:'boot',dataDir,findSession:id=>id==='s-authority'?ds:undefined,
    policy:()=>policy,contains:()=>contained,canTalk:()=>allowed,identity:async(_app,id)=>{identities++;return {openId:id,type:'user',email:'a@example.com'};},
    unionIdentity:async()=>({openId:'ou_target',email:'a@example.com'}),schedule:()=>undefined,authEpoch:()=>epoch,bindingKey:()=>binding};
  return {ds,deps,identities:()=>identities,change:(key:string)=>{if(key==='policy')policy={...policy,credentialSource:'platform'};if(key==='acl')allowed=false;
    if(key==='containment')contained=false;if(key==='epoch')epoch++;if(key==='binding')binding='binding-B';if(key==='worker')ds.worker={...ds.worker};
    if(key==='identityTurn')ds.managedTurnOrigin.identityTurnId='B';}};
}
const read=parseBytedcliOperation(['codebase','repo','list']);
const write=parseBytedcliOperation(['codebase','mr','create','--repo','ns/repo','--head','feature','--base','master','--title','demo']);
const resolve=(f:ReturnType<typeof setup>,op=read)=>resolveBytedcliAuthority(f.deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},op);
describe('frozen peer business authority',()=>{
  it('unknown requires a verified personal actor and follows authority revocation',async()=>{
    const unknown=parseBytedcliOperation(['unreviewed','mutate']);
    const f=setup();const result=await resolve(f,unknown);expect(result.ok).toBe(true);
    if(result.ok){expect(result.authority).toMatchObject({executionIdentity:'actor',actor:{verifiedEmail:'a@example.com'}});f.change('epoch');expect(await result.authority.recheck()).toBeDefined();}
    expect(f.identities()).toBeGreaterThan(0);
    const g=setup();g.ds.managedTurnOrigin.trustedCaller={senderType:'bot'};expect(await resolve(g,unknown)).toMatchObject({ok:false,errorCode:'actor_required'});
  });
  it('keeps A identity for B arrival and gives reads no actor lookup',async()=>{
    const f=setup();const result=await resolve(f);expect(result.ok).toBe(true);if(!result.ok)return;
    expect(result.authority).toMatchObject({turnId:'arrival-B',identityTurnId:'executing-A',dispatchAttempt:0});
    expect(result.authority.actor).toBeUndefined();expect(f.identities()).toBe(0);
  });
  it('requires conversation admission and actual containment for reads',async()=>{
    const f=setup();f.change('acl');expect(await resolve(f)).toMatchObject({ok:false,errorCode:'permission_denied'});
    const g=setup();g.change('containment');expect(await resolve(g)).toMatchObject({ok:false,errorCode:'broker_containment_unavailable'});
  });
  it('does not promote unknown/bot sender or implicit owner to a write actor',async()=>{
    for(const senderType of [undefined,'bot']){const f=setup();f.ds.managedTurnOrigin.trustedCaller.senderType=senderType;
      expect(await resolve(f,write)).toMatchObject({ok:false,errorCode:'actor_required'});expect(f.identities()).toBe(0);}
    const f=setup();f.ds.managedTurnOrigin.identityTurnId='trg_owner_123';expect(await resolve(f,write)).toMatchObject({ok:false,errorCode:'actor_required'});
  });
  it('verifies the direct human and accepts a verified scoped delegation',async()=>{
    const f=setup();const result=await resolve(f,write);expect(result.ok).toBe(true);if(result.ok)expect(result.authority.actor).toMatchObject({verifiedEmail:'a@example.com',credentialOpenId:'ou_A'});
    f.ds.managedTurnOrigin.trustedCaller={senderType:'bot'};
    rememberLarkToolDelegation(dataDir,'s-authority','executing-A',{targetOpenId:'ou_target',credentialOpenId:'ou_source',unionId:'on_human',tools:['bytedcli'],dispatchRoot:'root'});
    const delegated=await resolve(f,write);expect(delegated.ok).toBe(true);if(delegated.ok)expect(delegated.authority.actor?.credentialOpenId).toBe('ou_source');
  });
  it.each(['policy','acl','containment','epoch','binding','worker','identityTurn'])('rejects %s changes after admission',async key=>{
    const f=setup();const result=await resolve(f,write);expect(result.ok).toBe(true);if(!result.ok)return;f.change(key);
    expect(await result.authority.recheck()).toBeDefined();
  });
  it('does not let revocation during an async task recheck reach dispatch',async()=>{
    const f=setup();let revoked=false;
    rememberLarkToolDelegation(dataDir,'s-authority','executing-A',{targetOpenId:'ou_target',credentialOpenId:'ou_source',unionId:'on_human',tools:['bytedcli'],dispatchRoot:'root',
      recheck:()=>revoked?'revoked':undefined,taskAuthorized:async()=>{await Promise.resolve();revoked=true;return true;}});
    expect(await resolve(f,write)).toMatchObject({ok:false,errorCode:'delegation_revoked'});
  });
});

it('authorizes an explicit host schedule actor and fences task edits',async()=>{
  const f=setup();const turn='schedule:ab12:12345678-1234-1234-1234-123456789abc';f.ds.managedTurnOrigin.turnId=turn;f.ds.managedTurnOrigin.identityTurnId=turn;
  f.ds.managedTurnOrigin.trustedCaller=undefined;
  let record:any={kind:'direct',state:'active',selfManage:false,runScopes:['bytedcli'],credentialOpenId:'ou_A',
    task:{id:'ab12',enabled:true,larkAppId:'cli_authority',chatId:'oc_authority',ownerOpenId:'ou_A',ownerUnionId:'on_creator',prompt:'do business'}};
  const deps={...f.deps,schedule:()=>record};
  const result=await resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},write);
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.authority.actor?.credentialOpenId).toBe('ou_A');record={...record,runScopes:[]};
  expect(await result.authority.recheck()).toBe('delegation_revoked');
});
it('rejects a schedule projection without host authority and missing run scope',async()=>{
  const f=setup();const turn='schedule:ab12:12345678-1234-1234-1234-123456789abc';f.ds.managedTurnOrigin.turnId=turn;f.ds.managedTurnOrigin.identityTurnId=turn;
  expect(await resolve(f,write)).toMatchObject({errorCode:'permission_denied'});
  const record:any={kind:'direct',state:'active',selfManage:false,runScopes:[],credentialOpenId:'ou_A',task:{id:'ab12',enabled:true,larkAppId:'cli_authority',chatId:'oc_authority',ownerOpenId:'ou_A',ownerUnionId:'on_creator'}};
  expect(await resolveBytedcliAuthority({...f.deps,schedule:()=>record},'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},write)).toMatchObject({errorCode:'actor_required'});
});
it('accepts a daemon-authenticated explicit runAs human',async()=>{
  const f=setup();f.ds.managedTurnOrigin.identityTurnId='trg_runas_123';
  const result=await resolve(f,write);expect(result.ok).toBe(true);if(result.ok)expect(result.authority.actor?.credentialOpenId).toBe('ou_A');
});

it('does not promote an explicit callerless origin through old human registry data',async()=>{
  const f=setup();f.ds.managedTurnOrigin.trustedCaller=null;
  f.ds.session.replyTargets={ 'executing-A':{senderOpenId:'ou_old',participants:[{openId:'ou_old',isBot:false}],senderType:'user'} };
  expect(await resolve(f,write)).toMatchObject({errorCode:'actor_required'});expect(f.identities()).toBe(0);
});

it('allows host-authorized ownerless scheduled shared reads while fencing task lifetime and chat',async()=>{
 const f=setup();const turn='schedule:ab12:12345678-1234-1234-1234-123456789abc';f.ds.managedTurnOrigin.turnId=turn;f.ds.managedTurnOrigin.identityTurnId=turn;f.ds.managedTurnOrigin.trustedCaller=null;
 let record:any={kind:'direct',state:'active',selfManage:false,runScopes:[],task:{id:'ab12',enabled:true,larkAppId:'cli_authority',chatId:'oc_authority',prompt:'shared read'}};
 const deps={...f.deps,schedule:()=>record};const result=await resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read);
 expect(result.ok).toBe(true);expect(f.identities()).toBe(0);if(!result.ok)return;
 record={...record,state:'revoked'};expect(await result.authority.recheck()).toBe('delegation_revoked');
 record={...record,state:'active',task:{...record.task,chatId:'oc_foreign'}};
 expect(await resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read)).toMatchObject({errorCode:'permission_denied'});
});

it.each(['status','userinfo','login','logout'])('auth %s requires verified direct personal authority and fences revocation',async action=>{
 const f=setup();const operation=parseBytedcliOperation(['auth',action]);
 const result=await resolve(f,operation);expect(result.ok).toBe(true);
 if(!result.ok)return;expect(result.authority.actor?.credentialOpenId).toBe('ou_A');expect(f.identities()).toBe(1);
 f.change('epoch');expect(await result.authority.recheck()).toBe('authorization_revoked');
});
it('business delegation never conveys control of personal authorization',async()=>{
 const f=setup();rememberLarkToolDelegation(dataDir,'s-authority','executing-A',{targetOpenId:'ou_target',credentialOpenId:'ou_source',unionId:'on_human',tools:['bytedcli'],dispatchRoot:'root'});
 expect(await resolve(f,parseBytedcliOperation(['auth','login']))).toMatchObject({ok:false,errorCode:'actor_required'});
});
it('help does not resolve personal contact identity',async()=>{
 const f=setup();delete f.ds.managedTurnOrigin.trustedCaller;
 expect((await resolve(f,parseBytedcliOperation(['--help']))).ok).toBe(true);expect(f.identities()).toBe(0);
});

describe('configured business execution identity', () => {
 const configured = (rules: Record<string,string>) => parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v1',cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules});
 const actorRead = (f:ReturnType<typeof setup>) => ({...f.deps,policy:()=>({...f.deps.policy(f.ds)!,bytedcliOperationPolicy:configured({'codebase.repo.list':'actor'})})});
 it('verifies actor-read and binds its identity while retaining the audited read effect', async () => {
  const f=setup(); const result=await resolveBytedcliAuthority(actorRead(f),'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read);
  expect(read.effect).toBe('read'); expect(result.ok).toBe(true); if(!result.ok)return;
  expect(result.authority).toMatchObject({executionIdentity:'actor',actor:{credentialOpenId:'ou_A',verifiedEmail:'a@example.com'}});
  expect(Buffer.byteLength(result.authority.policyFingerprint)).toBeLessThanOrEqual(256); expect(f.identities()).toBe(1);
  f.change('epoch');expect(result.authority.current?.()).toBe('authorization_revoked');
 });
 it.each(['bot','callerless','owner'])('refuses %s actor-read before personal identity lookup',async kind=>{
  const f=setup(); if(kind==='owner')f.ds.managedTurnOrigin.identityTurnId='trg_owner_123';else f.ds.managedTurnOrigin.trustedCaller=kind==='bot'?{senderType:'bot'}:null;
  expect(await resolveBytedcliAuthority(actorRead(f),'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read)).toMatchObject({errorCode:'actor_required'});
  expect(f.identities()).toBe(0);
 });
 it('refuses global/Bot deny and invalid global state before actor/provider lookup',async()=>{
  for(const global of [false,true]){const f=setup();const denied=configured({'codebase.repo.list':'deny'});
   const deps={...f.deps,policy:()=>({...f.deps.policy(f.ds)!,...(global?{}:{bytedcliOperationPolicy:denied})}),...(global?{operationPolicy:()=>({revision:'global',policy:denied})}:{})};
   expect(await resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read)).toMatchObject({errorCode:'operation_disabled'});expect(f.identities()).toBe(0);
  }
  const f=setup();expect(await resolveBytedcliAuthority({...f.deps,operationPolicy:()=>({revision:'invalid',errorCode:'operation_policy_invalid' as const})},'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read)).toMatchObject({errorCode:'operation_policy_invalid'});
 });
 it('keeps ownerless schedule machine-read but requires personal run scope for actor-read',async()=>{
  const f=setup();const turn='schedule:ab12:12345678-1234-1234-1234-123456789abc';f.ds.managedTurnOrigin.turnId=turn;f.ds.managedTurnOrigin.identityTurnId=turn;f.ds.managedTurnOrigin.trustedCaller=null;
  const record:any={kind:'direct',state:'active',selfManage:false,runScopes:[],task:{id:'ab12',enabled:true,larkAppId:'cli_authority',chatId:'oc_authority',prompt:'read'}};
  const peer={pid:process.pid,procStart:readProcessStartIdentity(process.pid)!};
  expect((await resolveBytedcliAuthority({...f.deps,schedule:()=>record},'s-authority',peer,read)).ok).toBe(true);
  expect(await resolveBytedcliAuthority({...actorRead(f),schedule:()=>record},'s-authority',peer,read)).toMatchObject({errorCode:'permission_denied'});
  record.task.ownerOpenId='ou_A';record.task.ownerUnionId='on_creator';record.credentialOpenId='ou_A';
  expect(await resolveBytedcliAuthority({...actorRead(f),schedule:()=>record},'s-authority',peer,read)).toMatchObject({errorCode:'actor_required'});
  record.runScopes=['bytedcli'];expect((await resolveBytedcliAuthority({...actorRead(f),schedule:()=>record},'s-authority',peer,read)).ok).toBe(true);
 });
 it('does not invoke host policy in disabled/legacy modes',async()=>{
  const f=setup();let calls=0;const deps={...f.deps,policy:()=>({...f.deps.policy(f.ds)!,bytecloudExecution:'actor' as const}),operationPolicy:()=>{calls++;throw new Error('must stay dormant');}};
  expect(await resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read)).toMatchObject({errorCode:'broker_disabled'});expect(calls).toBe(0);
 });
 it('uses personal scoped delegation for actor-read and fences a policy edit during contact lookup',async()=>{
  const f=setup();f.ds.managedTurnOrigin.trustedCaller={senderType:'bot'};
  rememberLarkToolDelegation(dataDir,'s-authority','executing-A',{targetOpenId:'ou_target',credentialOpenId:'ou_source',unionId:'on_human',tools:['bytedcli'],dispatchRoot:'root'});
  const delegated=await resolveBytedcliAuthority(actorRead(f),'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read);
  expect(delegated.ok).toBe(true);if(delegated.ok)expect(delegated.authority).toMatchObject({executionIdentity:'actor',actor:{credentialOpenId:'ou_source',unionId:'on_human'}});
  clearLarkToolDelegations(dataDir,'s-authority');f.ds.managedTurnOrigin.trustedCaller={senderType:'user',requestUserOpenId:'ou_A'};
  let revision='first',entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const deps={...actorRead(f),operationPolicy:()=>({revision}),identity:async(_app:string,id:string)=>{entered();await gate;return {openId:id,type:'user' as const,email:'a@example.com'};}};
  const pending=resolveBytedcliAuthority(deps,'s-authority',{pid:process.pid,procStart:readProcessStartIdentity(process.pid)!},read);await ready;revision='next';release();
  expect(await pending).toMatchObject({errorCode:'policy_changed'});
 });
});
