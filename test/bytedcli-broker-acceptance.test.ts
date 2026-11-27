import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import { resolveBytedcliAuthority } from '../src/core/bytedcli-broker-authority.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { BytedcliBrokerAudit } from '../src/core/bytedcli-broker-audit.js';
import { readCommittedBytedcliAudit } from './helpers/bytedcli-audit-records.js';
import { BytedcliCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
import { runBytedcliExecClient } from '../src/cli/bytedcli-exec.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import { BYTEDCLI_OPERATION_CATALOG } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';
let cleanup: (()=>Promise<void>) | undefined;
afterEach(async()=>{await cleanup?.();cleanup=undefined;});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function setup(options:{failResultAudit?:boolean;denyActorWrites?:readonly string[]}={}){
 const root=mkdtempSync(join(tmpdir(),'bytedcli-acceptance-')),privateRoot=join(root,'private'),auditRoot=join(root,'audit');
 const operationPolicy=createBytedcliHostOperationPolicyReader(privateRoot);
 const business=join(root,'fake-business.cjs'),writesFile=join(root,'fake-upstream-writes.jsonl'),attemptsFile=join(root,'fake-upstream-attempts.jsonl');
 writeFileSync(business,`
  const fs=require('node:fs'),args=process.argv.slice(2);
  const token=fs.readFileSync(args[args.indexOf('--bytecloud-user-jwt-file')+1],'utf8');
  const account=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).account;
  const operation=args.includes('close')?'write':'read';
  const denied=operation==='write' && ${JSON.stringify(options.denyActorWrites??[])}.includes(account);
  fs.appendFileSync(${JSON.stringify(attemptsFile)},JSON.stringify({account,operation,denied})+'\\n');
  if(denied){process.stderr.write('Fake upstream denied this authenticated actor by ACL\\n');process.exit(13);}
  if(operation==='write')fs.appendFileSync(${JSON.stringify(writesFile)},JSON.stringify({account})+'\\n');
  process.stdout.write(JSON.stringify({account,argv:args.filter((v,i)=>i!==args.indexOf('--bytecloud-user-jwt-file')+1),
   cwdEmpty:fs.readdirSync(process.cwd()).length===0,homeEmpty:fs.readdirSync(process.env.HOME).length===0,injected:!!process.env.NODE_OPTIONS})+'\\n');
 `);
 const actors:Record<string,string>={ou_A:'a@example.test',ou_B:'b@example.test'};
 const mintedAccounts:string[]=[],identityLookups:string[]=[];
 const accountForHome=(home:string)=>{
  if(home===join(root,'machine'))return 'machine';
  const entry=Object.entries(actors).find(([openId])=>home===join(root,'actors',openId));
  if(!entry)throw new Error('unrecognized fake personal HOME');return entry[1];
 };
 const rows=(file:string)=>existsSync(file)?readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
 const binaryHome=join(root,'client-home');mkdirSync(binaryHome);writeFileSync(join(binaryHome,'bots.json'),'[]');
 const calls:string[]=[],dispatches:string[]=[];let epoch=0,grant=true,lookup=0,policy:any={enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor',credentialSource:'local'};
 const procStart=readProcessStartIdentity(process.pid)!;
 const ds:any={session:{sessionId:'acceptance',status:'active',backendType:'pty'},larkAppId:'cli_acceptance',chatId:'oc_acceptance',workerGeneration:1,
 worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:1,cliPid:process.pid,cliProcStart:procStart},
 managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'arrival-B',identityTurnId:'executing-A',trustedCaller:{senderType:'user',requestUserOpenId:'ou_A'},preexistingProcessIdentities:[`${process.pid}:${procStart}`]}};
 const jwt=(account:string)=>`e30.${Buffer.from(JSON.stringify({region:'cn',exp:Math.floor(Date.now()/1000)+3600,account})).toString('base64url')}.signature`;
 let providerGate: ReturnType<typeof deferred>|undefined;const entered=deferred();
 const leases=new BytedcliCredentialResolver({machineHome:join(root,'machine'),provider:{
 observe:async({home})=>{const account=accountForHome(home);calls.push(account==='machine'?'observe-machine':'observe-actor');return {authenticated:account==='machine'||grant,loginFingerprint:`login-${account}`};},
 mint:async({home})=>{const account=accountForHome(home);calls.push(account==='machine'?'mint-machine':'mint-actor');mintedAccounts.push(account);if(providerGate){entered.resolve();await providerGate.promise;}return jwt(account);},
 userinfo:async token=>{const account=JSON.parse(Buffer.from(token.split('.')[1]!,'base64url').toString()).account;const email=account==='machine'?'machine@example.test':account;return {username:email.split('@')[0],email,rawToken:'DO-NOT-EXPOSE'} as any;}},
 localHome:openId=>join(root,'actors',openId),localQueue:async(_id,work)=>work(),readEpoch:()=>epoch,epochAllows:()=>true,
 platform:{bindingKey:()=>undefined,resolve:async()=>{throw new Error('local cannot fall back');}}});
 const node=realpathSync('/proc/self/exe');
 const audit=new BytedcliBrokerAudit(auditRoot);
 const dispatchEntered=deferred();let dispatchGate:ReturnType<typeof deferred>|undefined;
 const executor=new BytedcliExecutor({privateRoot,audit:{append:async record=>{if(options.failResultAudit && record.phase==='result')throw new Error('fake result disk failure');await audit.append(record);}},leases,
 trustedCli:async()=>({executable:node,prefixArgs:[business],path:'/usr/bin:/bin',version:'0.199.0',stillCurrent:()=>true}),
 run:async invocation=>{dispatches.push(invocation.argv.join(' '));const {runBoundedBytedcliChild}=await import('../src/core/bytedcli-broker-process.js');const result=await runBoundedBytedcliChild(invocation);if(dispatchGate){dispatchEntered.resolve();await dispatchGate.promise;}return result;}});
 const broker=new BytedcliBroker({authority:(id,peer,op,context)=>resolveBytedcliAuthority({daemonBootId:'boot',dataDir:root,findSession:s=>s==='acceptance'?ds:undefined,
 policy:()=>policy,operationPolicy,contains:()=>true,canTalk:()=>true,identity:async(_app,openId)=>{lookup++;identityLookups.push(openId);return actors[openId]?{openId,type:'user',email:actors[openId]}:undefined;},unionIdentity:async()=>undefined,schedule:()=>undefined,authEpoch:()=>epoch,bindingKey:()=>undefined},id,peer,op,context),executor,personalLeases:async()=>leases} as any);
 let requestCount=0;
 const server:Server=createServer((req,res)=>{requestCount++;void broker.handle(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 cleanup=async()=>{providerGate?.resolve();dispatchGate?.resolve();await broker.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});};
 let sequence=0;
 const client=async(argv:string[],extra:any={})=>{
  let stdout='',stderr='';
  const binary=process.env.BOTMUX_BYTEDCLI_ACCEPTANCE_BINARY;
  if(binary && !extra.requestId){
   const child=spawn(binary,['__bytedcli-exec-runner','--session-id','acceptance','--ipc-port',String(port),'--',...argv],{
    cwd:binaryHome,env:{HOME:binaryHome,PATH:process.env.PATH,BOTS_CONFIG:join(binaryHome,'bots.json'),SESSION_DATA_DIR:join(binaryHome,'data'),BOTMUX_NO_CLAIM:'1',BOTMUX_FENCED_RUN:'1'},stdio:['ignore','pipe','pipe']});
   const childStart=readProcessStartIdentity(child.pid!)!;
   ds.localProcessAttestation.cliPid=child.pid;ds.localProcessAttestation.cliProcStart=childStart;
   ds.managedTurnOrigin.preexistingProcessIdentities=[`${child.pid}:${childStart}`];
   child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
   const exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??77));});
   return {exitCode,stdout,stderr};
  }
  const exitCode=await runBytedcliExecClient({sessionId:'acceptance',port,requestId:`acceptance-${++sequence}`,argv,stdout:b=>stdout+=b,stderr:b=>stderr+=b,...extra});return {exitCode,stdout,stderr};
 };
 const setGlobal=(rules:Record<string,string>)=>{operationPolicy();const next=join(privateRoot,'policy','next');writeFileSync(next,JSON.stringify({schema:'botmux.bytedcli-operation-policy.v2',cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules}),{mode:0o600});renameSync(next,join(privateRoot,'policy','operation-policy.json'));};
 return {client,setGlobal,setBot:(rules:Record<string,string>)=>policy={...policy,bytedcliOperationPolicy:parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v2',cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules})},calls,dispatches,ds,root,auditRoot,mintedAccounts,identityLookups,requests:()=>requestCount,writes:()=>rows(writesFile),attempts:()=>rows(attemptsFile),waitDispatch:()=>{dispatchGate=deferred();return {entered:dispatchEntered.promise,release:dispatchGate.resolve};},lookup:()=>lookup,grant:(v:boolean)=>grant=v,revoke:()=>epoch++,changePolicy:()=>policy={...policy,credentialSource:'platform'},
 waitProvider:()=>{providerGate=deferred();return {entered:entered.promise,release:providerGate.resolve};}};
}
const read=['codebase','repo','list'];const write=['codebase','mr','close','42','--repo','org/repo'];
it('HTTP fixed write ID never retries a fake upstream mutation after policy replacement or cache GC',async()=>{
 const f=await setup({failResultAudit:true});const first=await f.client(write,{requestId:'fixed-policy-write'});
 expect(first.stderr).toContain('write_outcome_unknown');expect(f.writes()).toEqual([{account:'a@example.test'}]);
 f.setGlobal({'codebase.repo.list':'actor'});expect((await f.client(read,{requestId:'policy-gc'})).exitCode).toBe(77);
 const repeated=await f.client(write,{requestId:'fixed-policy-write'});expect(repeated.stderr).toContain('write_outcome_unknown');expect(repeated.stdout).toBe('');
 expect(f.attempts().filter(row=>row.operation==='write')).toEqual([{account:'a@example.test',operation:'write',denied:false}]);
 f.ds.managedTurnOrigin.turnId='next-policy-turn';f.ds.managedTurnOrigin.identityTurnId='next-policy-identity';
 await f.client(write,{requestId:'fixed-policy-write'});expect(f.writes()).toEqual([{account:'a@example.test'},{account:'a@example.test'}]);
});
it('HTTP actor-read authenticates the exact official personal account and deny precedes identity lookup',async()=>{
 const f=await setup();f.setBot({'codebase.repo.list':'machine'});f.setGlobal({'codebase.repo.list':'actor'});const personal=await f.client(read);expect(personal.exitCode).toBe(0);expect(JSON.parse(personal.stdout).account).toBe('a@example.test');
 expect(f.mintedAccounts).toEqual(['a@example.test']);expect(f.writes()).toEqual([]);
 f.grant(false);expect((await f.client(read)).stderr).toContain('actor_auth_required');
 const lookups=f.lookup();f.setGlobal({'codebase.repo.list':'deny'});expect((await f.client(read)).stderr).toContain('operation_disabled');expect(f.lookup()).toBe(lookups);
 expect(f.attempts()).toEqual([{account:'a@example.test',operation:'read',denied:false}]);
});
it('real HTTP and client execute machine reads without grants, and only A writes while B has arrived',async()=>{
 const f=await setup();f.grant(false);const readResult=await f.client(read);expect(readResult.exitCode).toBe(0);expect(JSON.parse(readResult.stdout)).toMatchObject({account:'machine',cwdEmpty:true,homeEmpty:true,injected:false});expect(f.lookup()).toBe(0);
 expect(f.calls.every(c=>c.endsWith('machine'))).toBe(true);expect((await f.client(write)).stderr).toContain('actor_auth_required');expect(f.dispatches).toHaveLength(1);
 f.grant(true);const written=await f.client(write);expect(written.exitCode).toBe(0);expect(JSON.parse(written.stdout).account).toBe('a@example.test');expect(f.ds.managedTurnOrigin.turnId).toBe('arrival-B');expect(f.dispatches).toHaveLength(2);expect(f.writes()).toEqual([{account:'a@example.test'}]);
 expect(readdirSync(join(f.root,'private'))).toEqual(['policy']);expect(readdirSync(join(f.root,'private','policy'))).toEqual([]);
});
it('help/version report the audited catalog without identity lookup or a credential provider',async()=>{
 const f=await setup();f.grant(false);const help=await f.client(['--help']);expect(help.exitCode).toBe(0);
 const data=JSON.parse(help.stdout);expect(data.catalog.map((e:any)=>e.id)).toEqual(BYTEDCLI_OPERATION_CATALOG.map(e=>e.id));
 expect(data.auditedCliVersion).toBe('0.199.0');expect(JSON.parse((await f.client(['--version'])).stdout).auditedCliVersion).toBe('0.199.0');
 expect(f.lookup()).toBe(0);expect(f.calls).toEqual([]);expect(f.dispatches).toEqual([]);
});
it('personal status/userinfo are actor-only safe projections and login/logout never claim control happened',async()=>{
 const f=await setup();const status=await f.client(['auth','status']);expect(status.exitCode).toBe(0);expect(JSON.parse(status.stdout)).toMatchObject({state:'authorized',identity:'actor',source:'local'});
 const info=await f.client(['auth','userinfo']);expect(info.exitCode).toBe(0);expect(JSON.parse(info.stdout)).toMatchObject({email:'a@example.test'});expect(info.stdout).not.toContain('DO-NOT-EXPOSE');
 expect(f.calls.some(c=>c.includes('machine'))).toBe(false);expect(f.dispatches).toEqual([]);
 const before=f.calls.length;for(const action of ['login','logout']){const result=await f.client(['auth',action]);expect(result.exitCode).toBe(77);expect(result.stderr).toContain('personal_auth_control_required');expect(JSON.parse(result.stdout)).toMatchObject({performed:false,action});expect(result.stdout).not.toContain('https://');expect(result.stdout).not.toContain('/logout');}expect(f.calls).toHaveLength(before);
 f.grant(false);const missing=await f.client(['auth','status']);expect(missing.exitCode).toBe(0);expect(JSON.parse(missing.stdout).state).toBe('needs-login');
});
it.each(['policy','epoch'] as const)('withdrawal of %s during a provider wait prevents write dispatch',async kind=>{
 const f=await setup(),gate=f.waitProvider();const pending=f.client(write);await gate.entered;kind==='policy'?f.changePolicy():f.revoke();gate.release();const result=await pending;
 expect(result.exitCode).toBe(77);expect(result.stderr).toContain(kind==='policy'?'policy_changed':'authorization_revoked');expect(f.dispatches).toEqual([]);
});

it('a partial durable write is unknown and the client never retries it',async()=>{
 const f=await setup({failResultAudit:true});const result=await f.client(write);
 expect(result.exitCode).toBe(77);expect(result.stderr).toContain('write_outcome_unknown');expect(f.dispatches).toHaveLength(1);
 const records=readCommittedBytedcliAudit(f.auditRoot);
 expect(f.writes()).toEqual([{account:'a@example.test'}]);expect(records.map(record=>record.phase)).toEqual(['intent']);expect(JSON.stringify(records)).not.toContain('signature');
 expect(readdirSync(join(f.root,'private'))).toEqual(['policy']);expect(readdirSync(join(f.root,'private','policy'))).toEqual([]);
});
it('revocation after the real child wrote suppresses success without a second write',async()=>{
 const f=await setup(),gate=f.waitDispatch();const pending=f.client(write);await gate.entered;f.revoke();gate.release();const result=await pending;
 expect(result.stderr).toContain('write_outcome_unknown');expect(f.dispatches).toHaveLength(1);expect(f.writes()).toEqual([{account:'a@example.test'}]);expect(result.stdout).toBe('');
});
it('personal status is withdrawn when the auth epoch changes while the provider is running',async()=>{
 const f=await setup(),gate=f.waitProvider();const pending=f.client(['auth','status']);await gate.entered;f.revoke();gate.release();const result=await pending;
 expect(result.exitCode).toBe(77);expect(result.stderr).toContain('authorization_revoked');expect(result.stdout).toBe('');expect(f.dispatches).toEqual([]);
});


// Composed identity tests use the real inbound reply registry and the real
// HTTP/client/authority/credential/executor path with fake providers/containment.
function activateActor(f: Awaited<ReturnType<typeof setup>>, openId: string, turnId: string): void {
 f.ds.currentTurnId=turnId;
 f.ds.managedTurnOrigin={...f.ds.managedTurnOrigin,turnId,identityTurnId:turnId,
  trustedCaller:{senderType:'user',requestUserOpenId:openId}};
}
it('upstream ACL denial attempts only the actor write, with no mutation, machine fallback or retry',async()=>{
 const f=await setup({denyActorWrites:['a@example.test']});
 const readable=await f.client(read);expect(readable.exitCode).toBe(0);expect(JSON.parse(readable.stdout).account).toBe('machine');
 const afterRead=f.calls.length;
 const denied=await f.client(write);
 // The upstream fake explicitly denies A; a generic nonzero write is still
 // conservatively unknown to the broker. Never classify it by stderr text.
 expect(f.writes()).toEqual([]);
 expect(denied.exitCode).toBe(77);expect(denied.stderr).toContain('write_outcome_unknown');
 expect(f.attempts()).toEqual([{account:'machine',operation:'read',denied:false},{account:'a@example.test',operation:'write',denied:true}]);
 expect(f.dispatches).toHaveLength(2);expect(f.requests()).toBe(2);
 expect(f.mintedAccounts).toEqual(['machine','a@example.test']);
 expect(f.calls.slice(afterRead).some(call=>call.includes('machine'))).toBe(false);
});
it('in-flight A stays A as B arrives, then the authenticated B successor writes as B',async()=>{
 const f=await setup();activateActor(f,'ou_A','om_A');
 const gate=f.waitProvider(),pendingA=f.client(write);await gate.entered;
 // Model an actually admitted later human message with production registry
 // code, while the worker's executing origin still belongs to A.
 beginReplyTargetTurn(f.ds,'om_root','om_B',undefined,{senderOpenId:'ou_B',participants:[{openId:'ou_B',isBot:false}]});
 f.ds.currentTurnId='om_B';
 gate.release();const a=await pendingA;expect(a.exitCode).toBe(0);expect(JSON.parse(a.stdout).account).toBe('a@example.test');
 f.ds.managedTurnOrigin={...f.ds.managedTurnOrigin,turnId:'om_B',identityTurnId:'om_B'};
 delete f.ds.managedTurnOrigin.trustedCaller;
 // No explicit caller: the successor must authenticate B from the new human
 // registry row, not borrow A's frozen credential or contact result.
 const b=await f.client(write);expect(b.exitCode).toBe(0);expect(JSON.parse(b.stdout).account).toBe('b@example.test');
 expect(f.writes()).toEqual([{account:'a@example.test'},{account:'b@example.test'}]);
 expect(f.identityLookups).toEqual(['ou_A','ou_B']);expect(f.mintedAccounts).toEqual(['a@example.test','b@example.test']);
 expect(f.attempts()).toEqual([{account:'a@example.test',operation:'write',denied:false},{account:'b@example.test',operation:'write',denied:false}]);
});
it('worker generation replacement during a provider wait rejects the old write and admits its successor',async()=>{
 const f=await setup();activateActor(f,'ou_A','om_A');
 const gate=f.waitProvider(),old=f.client(write);await gate.entered;
 f.ds.worker={...f.ds.worker};f.ds.workerGeneration++;
 f.ds.localProcessAttestation={...f.ds.localProcessAttestation,workerGeneration:f.ds.workerGeneration};
 gate.release();const stale=await old;expect(stale.exitCode).toBe(77);expect(stale.stderr).toContain('execution_stale');
 expect(f.dispatches).toEqual([]);expect(f.writes()).toEqual([]);expect(f.attempts()).toEqual([]);
 activateActor(f,'ou_A','om_successor');const successor=await f.client(write);expect(successor.exitCode).toBe(0);
 expect(f.writes()).toEqual([{account:'a@example.test'}]);
 const records=readCommittedBytedcliAudit(f.auditRoot);
 expect(records.map(record=>[record.workerGeneration,record.phase]).sort()).toEqual([[2,'intent'],[2,'result']]);
});

it('global policy replacement during personal mint refuses dispatch without machine fallback',async()=>{
 const f=await setup();f.setBot({'codebase.repo.list':'machine'});f.setGlobal({'codebase.repo.list':'actor'});
 const gate=f.waitProvider(),pending=f.client(read);await gate.entered;f.setGlobal({'codebase.repo.list':'deny'});gate.release();
 const result=await pending;expect(result.stderr).toContain('policy_changed');expect(result.stdout).toBe('');
 expect(f.attempts()).toEqual([]);expect(f.mintedAccounts).toEqual(['a@example.test']);expect(f.writes()).toEqual([]);
});
it('global policy replacement after native write suppresses output and retains one upstream attempt',async()=>{
 const f=await setup(),gate=f.waitDispatch(),pending=f.client(write);await gate.entered;f.setGlobal({'codebase.mr.close':'deny'});gate.release();
 const result=await pending;expect(result.stderr).toContain('write_outcome_unknown');expect(result.stdout).toBe('');
 expect(f.attempts()).toEqual([{account:'a@example.test',operation:'write',denied:false}]);expect(f.writes()).toEqual([{account:'a@example.test'}]);
 const audit=readCommittedBytedcliAudit(f.auditRoot);expect(audit.some(row=>row.phase==='intent')).toBe(true);
});

it('real HTTP and client machine writes persist intent/result without personal lookup or grants',async()=>{
 const f=await setup();f.grant(false);f.setBot({'codebase.mr.close':'machine'});
 const result=await f.client(write,{requestId:'explicit-machine-write'});
 expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout).account).toBe('machine');expect(f.identityLookups).toEqual([]);expect(f.mintedAccounts).toEqual(['machine']);
 expect(f.writes()).toEqual([{account:'machine'}]);
 const records=readCommittedBytedcliAudit(f.auditRoot);
 expect(records.sort((a,b)=>a.phase.localeCompare(b.phase)).map(row=>[row.phase,row.effect,row.source])).toEqual([['intent','write','machine'],['result','write','machine']]);
 f.setGlobal({'codebase.mr.close':'actor'});
 const repeated=await f.client(write,{requestId:'explicit-machine-write'});expect(repeated.stderr).toContain('write_outcome_unknown');expect(repeated.stdout).toBe('');expect(f.writes()).toEqual([{account:'machine'}]);
 const restored=await f.client(write);expect(restored.stderr).toContain('actor_auth_required');expect(f.writes()).toEqual([{account:'machine'}]);
});
it('machine write result loss reaches the real client as unknown without automatic retry after policy change',async()=>{
 const f=await setup({failResultAudit:true});f.grant(false);f.setGlobal({'codebase.mr.close':'machine'});
 const result=await f.client(write,{requestId:'lost-machine-result'});expect(result.exitCode).toBe(77);expect(result.stderr).toContain('write_outcome_unknown');expect(result.stdout).toBe('');
 expect(f.requests()).toBe(1);expect(f.writes()).toEqual([{account:'machine'}]);expect(f.lookup()).toBe(0);
 f.setBot({'codebase.mr.close':'actor'});
 const repeated=await f.client(write,{requestId:'lost-machine-result'});expect(repeated.stderr).toContain('write_outcome_unknown');expect(repeated.stdout).toBe('');expect(f.writes()).toEqual([{account:'machine'}]);
});
