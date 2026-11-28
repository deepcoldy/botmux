import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBytedcliAuthority, type BytedcliAuthorityDependencies } from '../src/core/bytedcli-broker-authority.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { BytedcliCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
import { BytedcliBrokerError } from '../src/core/bytedcli-broker-process.js';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { runBytedcliSafeCommand } from '../src/core/bytedcli-safe-commands.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
const config = (rules: Record<string, string> = {}) => ({ schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: '0.199.0', catalogVersion: '2026-11-26.1', rules });
const read = () => parseBytedcliOperation(['codebase', 'mr', 'list', '--repo', 'org/repo']);
const write = () => parseBytedcliOperation(['codebase', 'mr', 'close', '1', '--repo', 'org/repo']);
function deferred() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
async function setup() {
 const root = mkdtempSync(join(tmpdir(), 'bytedcli-runtime-policy-')), privateRoot = join(root, 'private');
 const reader = createBytedcliHostOperationPolicyReader(privateRoot), file = join(privateRoot, 'policy', 'operation-policy.json');
 let policy:any = { enabled:true, tools:['bytedcli'], bytecloudExecution:'read-machine-write-actor', credentialSource:'local' };
 let grant=true, official='person@example.test', identityLookups=0, minted:string[]=[];
 let onMint:(() => Promise<void>) | undefined, onRun:(() => Promise<typeof empty>) | undefined;
 const dispatches:string[]=[], audit:any[]=[];
 const start = readProcessStartIdentity(process.pid)!;
 const ds:any={session:{sessionId:'runtime',status:'active',backendType:'pty'},larkAppId:'cli_runtime',chatId:'oc_runtime',workerGeneration:1,
  worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:1,cliPid:process.pid,cliProcStart:start},
  managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'turn',identityTurnId:'identity',trustedCaller:{senderType:'user',requestUserOpenId:'ou_person'},preexistingProcessIdentities:[`${process.pid}:${start}`]}};
 const deps:BytedcliAuthorityDependencies={daemonBootId:'boot',dataDir:root,findSession:id=>id==='runtime'?ds:undefined,policy:()=>policy,
  operationPolicy:reader,contains:()=>true,canTalk:()=>true,identity:async(_app,id)=>{identityLookups++;return {openId:id,type:'user',email:'person@example.test'};},unionIdentity:async()=>undefined,schedule:()=>undefined,authEpoch:()=>0,bindingKey:()=>undefined};
 const account=(home:string)=>home===join(root,'machine')?'machine':'person@example.test';
 const leases=new BytedcliCredentialResolver({machineHome:join(root,'machine'),localHome:()=>join(root,'person'),localQueue:async(_id,work)=>work(),readEpoch:()=>0,epochAllows:()=>true,
  platform:{bindingKey:()=>undefined,resolve:async()=>{throw new Error('no platform fallback');}},provider:{observe:async({home})=>({authenticated:account(home)==='machine'||grant,loginFingerprint:'fake-login'}),
   mint:async({home})=>{const who=account(home);minted.push(who);await onMint?.();return `e30.${Buffer.from(JSON.stringify({region:'cn',exp:Math.floor(Date.now()/1000)+3600,account:who})).toString('base64url')}.signature`;},
   userinfo:async jwt=>{const who=JSON.parse(Buffer.from(jwt.split('.')[1]!,'base64url').toString()).account;return {username:who==='machine'?'machine':'person',email:who==='machine'?'machine@example.test':official};}}});
 const executor=new BytedcliExecutor({privateRoot,leases,audit:{append:async record=>{audit.push(record);}},trustedCli:async()=>({executable:'/trusted/cli',path:'/usr/bin:/bin',version:'0.199.0',stillCurrent:()=>true}),
  run:async invocation=>{const jwt=readFileSync(invocation.argv[invocation.argv.indexOf('--bytecloud-user-jwt-file')+1]!,'utf8');const who=JSON.parse(Buffer.from(jwt.split('.')[1]!,'base64url').toString()).account;dispatches.push(who);return onRun?onRun():{...empty,stdout:Buffer.from(who)};}});
 cleanups.push(async()=>{await executor.close();rmSync(root,{recursive:true,force:true});});
 const authority=async(op=read())=>{const result=await resolveBytedcliAuthority(deps,'runtime',{pid:process.pid,procStart:start},op);if(!result.ok)throw new BytedcliBrokerError(result.errorCode);return result.authority;};
 const execute=async(op=read(),requestId='request')=>{try{return await executor.execute({operation:op,requestId,authority:await authority(op)});}catch(error){return {outcome:'rejected',errorCode:(error as BytedcliBrokerError).code,stdoutBase64:''};}};
 const setGlobal=(rules:Record<string,string>,atomic=false)=>{reader();const target=atomic?join(privateRoot,'policy','next'):file;writeFileSync(target,JSON.stringify(config(rules)),{mode:0o600});if(atomic)renameSync(target,file);};
 return {root,privateRoot,file,reader,executor,authority,execute,dispatches,audit,ds,minted,identityLookups:()=>identityLookups,
  setGlobal,setBot:(rules:Record<string,string>)=>policy={...policy,bytedcliOperationPolicy:parseBytedcliOperationPolicy(config(rules))},grant:(value:boolean)=>grant=value,
  official:(value:string)=>official=value,onMint:(hook:()=>Promise<void>)=>onMint=hook,onRun:(hook:()=>Promise<typeof empty>)=>onRun=hook};
}
describe('hot host policy through real authority, credentials and executor', () => {
 it('default reads tolerate request staging without policy churn and touch machine only',async()=>{
  const s=await setup();s.grant(false);const before=s.reader();expect((await s.execute()).outcome).toBe('completed');
  expect(s.dispatches).toEqual(['machine']);expect(s.minted).toEqual(['machine']);expect(s.identityLookups()).toBe(0);expect(s.reader().revision).toBe(before.revision);
 });
 it.each(['global','bot'])('explicit %s machine write never looks up actor or personal grant and reverting restores actor gates',async layer=>{
  const s=await setup();s.grant(false);
  (layer==='global'?s.setGlobal:s.setBot)({'codebase.mr.close':'machine'});
  const result=await s.execute(write());expect(result).toMatchObject({outcome:'completed',effectiveIdentity:{kind:'machine'}});
  expect(s.identityLookups()).toBe(0);expect(s.minted).toEqual(['machine']);expect(s.dispatches).toEqual(['machine']);
  expect(s.audit.map(row=>[row.phase,row.effect,row.source])).toEqual([['intent','write','machine'],['result','write','machine']]);
  s.setGlobal({'codebase.mr.close':'actor'});expect((await s.execute(write(),'actor-restored')).errorCode).toBe('actor_auth_required');expect(s.identityLookups()).toBe(1);expect(s.dispatches).toEqual(['machine']);
 });
 it('actor-read uses the officially matched personal grant and cannot fall back',async()=>{
  const s=await setup();s.setGlobal({'codebase.mr.list':'actor'});const result=await s.execute();expect(result.outcome).toBe('completed');
  expect(s.dispatches).toEqual(['person@example.test']);expect(s.identityLookups()).toBe(1);expect(s.audit).toHaveLength(1);expect(s.audit[0]).toMatchObject({effect:'read',phase:'result'});expect(s.audit.some(row=>row.phase==='intent')).toBe(false);
  s.grant(false);expect((await s.execute(read(),'no-grant')).errorCode).toBe('actor_auth_required');expect(s.dispatches).toHaveLength(1);
  s.grant(true);s.official('wrong@example.test');expect((await s.execute(read(),'wrong-account')).errorCode).toBe('actor_identity_unverified');expect(s.dispatches).toHaveLength(1);expect(s.minted).not.toContain('machine');
 });
 it('global/Bot deny refuses canonical aliases before any identity or mint',async()=>{
  const s=await setup();s.setGlobal({'codebase.mr.list':'deny'});s.setBot({'codebase.mr.list':'machine'});
  const alias=parseBytedcliOperation(['codebase','pr','list','-R','org/repo','--page-num','1']);expect(alias.id).toBe('codebase.mr.list');
  expect((await s.execute(alias)).errorCode).toBe('operation_disabled');expect(s.identityLookups()).toBe(0);expect(s.minted).toEqual([]);expect(s.dispatches).toEqual([]);
 });
 it('safe help projects effective identity and deny without personal lookup and preserves auth controls',async()=>{
  const s=await setup();s.setGlobal({'codebase.mr.list':'actor','codebase.mr.close':'deny'});s.setBot({'codebase.mr.list':'machine'});
  const help=parseBytedcliOperation(['codebase','mr','--help']);const response=await runBytedcliSafeCommand({requestId:'help',operation:help,authority:await s.authority(help)});
  const data=JSON.parse(Buffer.from(response.stdoutBase64,'base64').toString());
  expect(data.catalog.find((row:any)=>row.id==='codebase.mr.list')).toMatchObject({effect:'read',executionIdentity:'actor',enabled:true});
  expect(data.catalog.find((row:any)=>row.id==='codebase.mr.close')).toMatchObject({effect:'write',enabled:false});expect(s.identityLookups()).toBe(0);expect(s.minted).toEqual([]);
  const login=parseBytedcliOperation(['auth','login']);expect((await runBytedcliSafeCommand({requestId:'login',operation:login,authority:await s.authority(login)})).errorCode).toBe('personal_auth_control_required');
 });
 it.each(['mint','queue'])('editing policy during %s refuses dispatch after the wait',async wait=>{
  const s=await setup(),gate=deferred(),entered=deferred();
  if(wait==='mint'){s.onMint(async()=>{entered.release();await gate.promise;});const executing=s.execute(write());await entered.promise;s.setGlobal({'codebase.mr.close':'deny'});gate.release();expect((await executing).errorCode).toBe('policy_changed');}
  else {s.onRun(async()=>{entered.release();await gate.promise;return empty;});const op=write();const auth=await s.authority(op);const first=s.executor.execute({requestId:'first',operation:op,authority:auth});await entered.promise;
   const queued=s.executor.execute({requestId:'queued',operation:op,authority:auth});await Promise.resolve();s.setGlobal({'codebase.mr.close':'deny'});gate.release();expect((await queued).errorCode).toBe('policy_changed');await first;}
  expect(s.dispatches).toHaveLength(wait==='mint'?0:1);
 });
 it('an edit after actual write suppresses output and keeps write unknown semantics',async()=>{
  const s=await setup();s.onRun(async()=>{s.setGlobal({'codebase.mr.close':'deny'});return {...empty,stdout:Buffer.from('secret-result')};});
  const result=await s.execute(write());expect(result.outcome).toBe('write_outcome_unknown');expect(result.stdoutBase64).toBe('');expect(s.dispatches).toHaveLength(1);
 });
 it('actor-read retains read concurrency, failed exit and timeout semantics without write intent',async()=>{
  const s=await setup();s.setBot({'codebase.mr.list':'actor'});const gate=deferred(),entered=deferred();let active=0;
  s.onRun(async()=>{if(++active===4)entered.release();await gate.promise;return {...empty,exitCode:9};});
  const pending=Array.from({length:4},(_,i)=>s.execute(read(),`read-${i}`));await entered.promise;gate.release();
  expect((await Promise.all(pending)).every(result=>result.outcome==='failed'&&result.errorCode==='upstream_failed')).toBe(true);expect(s.audit.some(row=>row.phase==='intent')).toBe(false);
  s.onRun(async()=>{throw new BytedcliBrokerError('timeout');});expect((await s.execute(read(),'timeout')).outcome).toBe('rejected');
 });
 it('rejects forged host write→machine and actor-read without verified actor before leases',async()=>{
  const s=await setup();const op=write(),auth=await s.authority(op);
  expect((await s.executor.execute({requestId:'forged',operation:op,authority:{...auth,executionIdentity:'machine'}})).errorCode).toBe('actor_required');
  expect((await s.executor.execute({requestId:'no-actor',operation:read(),authority:{...auth,actor:undefined,executionIdentity:'actor'}})).errorCode).toBe('actor_required');expect(s.minted).toEqual([]);expect(s.dispatches).toEqual([]);
 });
 it('same-execution dispatched write IDs survive an atomic policy edit and stale-cache GC while a genuine next turn proceeds',async()=>{
  const s=await setup();s.onRun(async()=>{throw new BytedcliBrokerError('upstream_failed');});expect((await s.execute(write(),'fixed-write')).outcome).toBe('write_outcome_unknown');
  s.setGlobal({'codebase.mr.list':'actor'},true);expect((await s.execute(read(),'gc-trigger')).outcome).toBe('rejected');
  const repeated=await s.execute(write(),'fixed-write');expect(repeated.outcome).toBe('write_outcome_unknown');expect(repeated.stdoutBase64).toBe('');expect(s.dispatches).toHaveLength(2);
  s.ds.managedTurnOrigin.turnId='next-turn';s.ds.managedTurnOrigin.identityTurnId='next-identity';
  await s.execute(write(),'fixed-write');expect(s.dispatches).toHaveLength(3);
 });
 it('never replays a cached machine read after effective policy selects actor',async()=>{
  const s=await setup();expect((await s.execute(read(),'same-read')).outcome).toBe('completed');s.setGlobal({'codebase.mr.list':'actor'});
  const result=await s.execute(read(),'same-read');expect(Buffer.from(result.stdoutBase64,'base64').toString()).toBe('person@example.test');expect(s.dispatches).toEqual(['machine','person@example.test']);
 });
 it('refuses partial configuration, detects deletion, and recovers on a new valid request',async()=>{
  const s=await setup();s.setGlobal({'codebase.mr.list':'actor'});const frozen=await s.authority();writeFileSync(s.file,'{');
  expect((await s.execute()).errorCode).toBe('operation_policy_invalid');expect(frozen.current?.()).toBe('policy_changed');expect(s.minted).toEqual([]);
  s.setGlobal({'codebase.mr.list':'actor'});expect((await s.execute(read(),'recovered')).outcome).toBe('completed');unlinkSync(s.file);expect(await frozen.recheck()).toBe('policy_changed');
 });
});
