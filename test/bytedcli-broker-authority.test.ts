import { afterEach, describe, expect, it } from 'vitest';
import { resolveBytedcliAuthority, type BytedcliAuthorityDependencies } from '../src/core/bytedcli-broker-authority.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { rememberLarkToolDelegation, clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';
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
