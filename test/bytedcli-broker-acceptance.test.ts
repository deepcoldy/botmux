import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import { resolveBytedcliAuthority } from '../src/core/bytedcli-broker-authority.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { BytedcliBrokerAudit } from '../src/core/bytedcli-broker-audit.js';
import { BytedcliCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
import { runBytedcliExecClient } from '../src/cli/bytedcli-exec.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { BYTEDCLI_OPERATION_CATALOG } from '../src/core/bytedcli-operation-policy.js';
let cleanup: (()=>Promise<void>) | undefined;
afterEach(async()=>{await cleanup?.();cleanup=undefined;});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function setup(options:{failResultAudit?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'bytedcli-acceptance-')),privateRoot=join(root,'private'),auditRoot=join(root,'audit');
 const business=join(root,'fake-business.cjs'),writesFile=join(root,'fake-upstream-writes.jsonl');
 writeFileSync(business,`const fs=require('node:fs');const args=process.argv.slice(2);const token=fs.readFileSync(args[args.indexOf('--bytecloud-user-jwt-file')+1],'utf8');const account=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).account;if(args.includes('close'))fs.appendFileSync(${JSON.stringify(writesFile)},JSON.stringify({account})+'\\n');process.stdout.write(JSON.stringify({account,argv:args.filter((v,i)=>i!==args.indexOf('--bytecloud-user-jwt-file')+1),cwdEmpty:fs.readdirSync(process.cwd()).length===0,homeEmpty:fs.readdirSync(process.env.HOME).length===0,injected:!!process.env.NODE_OPTIONS})+'\\n');`);
 const binaryHome=join(root,'client-home');mkdirSync(binaryHome);writeFileSync(join(binaryHome,'bots.json'),'[]');
 const calls:string[]=[],dispatches:string[]=[];let epoch=0,grant=true,lookup=0,policy:any={enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor',credentialSource:'local'};
 const procStart=readProcessStartIdentity(process.pid)!;
 const ds:any={session:{sessionId:'acceptance',status:'active',backendType:'pty'},larkAppId:'cli_acceptance',chatId:'oc_acceptance',workerGeneration:1,
 worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:1,cliPid:process.pid,cliProcStart:procStart},
 managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'arrival-B',identityTurnId:'executing-A',trustedCaller:{senderType:'user',requestUserOpenId:'ou_A'},preexistingProcessIdentities:[`${process.pid}:${procStart}`]}};
 const jwt=(account:string)=>`e30.${Buffer.from(JSON.stringify({region:'cn',exp:Math.floor(Date.now()/1000)+3600,account})).toString('base64url')}.signature`;
 let providerGate: ReturnType<typeof deferred>|undefined;const entered=deferred();
 const leases=new BytedcliCredentialResolver({machineHome:join(root,'machine'),provider:{
 observe:async({home})=>{calls.push(home.endsWith('machine')?'observe-machine':'observe-actor');return {authenticated:home.endsWith('machine')||grant,loginFingerprint:'login1'};},
 mint:async({home})=>{calls.push(home.endsWith('machine')?'mint-machine':'mint-actor');if(providerGate){entered.resolve();await providerGate.promise;}return jwt(home.endsWith('machine')?'machine':'a@example.test');},
 userinfo:async()=>({username:'a',email:'a@example.test',rawToken:'DO-NOT-EXPOSE'} as any)},localHome:()=>join(root,'actor'),localQueue:async(_id,work)=>work(),readEpoch:()=>epoch,epochAllows:()=>true,
 platform:{bindingKey:()=>undefined,resolve:async()=>{throw new Error('local cannot fall back');}}});
 const node=realpathSync('/proc/self/exe');
 const audit=new BytedcliBrokerAudit(auditRoot);
 const dispatchEntered=deferred();let dispatchGate:ReturnType<typeof deferred>|undefined;
 const executor=new BytedcliExecutor({privateRoot,audit:{append:async record=>{if(options.failResultAudit && record.phase==='result')throw new Error('fake result disk failure');await audit.append(record);}},leases,
 trustedCli:async()=>({executable:node,prefixArgs:[business],path:'/usr/bin:/bin',version:'0.199.0',stillCurrent:()=>true}),
 run:async invocation=>{dispatches.push(invocation.argv.join(' '));const {runBoundedBytedcliChild}=await import('../src/core/bytedcli-broker-process.js');const result=await runBoundedBytedcliChild(invocation);if(dispatchGate){dispatchEntered.resolve();await dispatchGate.promise;}return result;}});
 const broker=new BytedcliBroker({authority:(id,peer,op,context)=>resolveBytedcliAuthority({daemonBootId:'boot',dataDir:root,findSession:s=>s==='acceptance'?ds:undefined,
 policy:()=>policy,contains:()=>true,canTalk:()=>true,identity:async(_app,openId)=>{lookup++;return {openId,type:'user',email:'a@example.test'};},unionIdentity:async()=>undefined,schedule:()=>undefined,authEpoch:()=>epoch,bindingKey:()=>undefined},id,peer,op,context),executor,personalLeases:async()=>leases} as any);
 const server:Server=createServer((req,res)=>void broker.handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 cleanup=async()=>{providerGate?.resolve();dispatchGate?.resolve();await broker.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});};
 let sequence=0;
 const client=async(argv:string[],extra:any={})=>{
  let stdout='',stderr='';
  const binary=process.env.BOTMUX_BYTEDCLI_ACCEPTANCE_BINARY;
  if(binary){
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
 return {client,calls,dispatches,ds,root,auditRoot,writes:()=>existsSync(writesFile)?readFileSync(writesFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],waitDispatch:()=>{dispatchGate=deferred();return {entered:dispatchEntered.promise,release:dispatchGate.resolve};},lookup:()=>lookup,grant:(v:boolean)=>grant=v,revoke:()=>epoch++,changePolicy:()=>policy={...policy,credentialSource:'platform'},
 waitProvider:()=>{providerGate=deferred();return {entered:entered.promise,release:providerGate.resolve};}};
}
const read=['codebase','repo','list'];const write=['codebase','mr','close','42','--repo','org/repo'];
it('real HTTP and client execute machine reads without grants, and only A writes while B has arrived',async()=>{
 const f=await setup();f.grant(false);const readResult=await f.client(read);expect(readResult.exitCode).toBe(0);expect(JSON.parse(readResult.stdout)).toMatchObject({account:'machine',cwdEmpty:true,homeEmpty:true,injected:false});expect(f.lookup()).toBe(0);
 expect(f.calls.every(c=>c.endsWith('machine'))).toBe(true);expect((await f.client(write)).stderr).toContain('actor_auth_required');expect(f.dispatches).toHaveLength(1);
 f.grant(true);const written=await f.client(write);expect(written.exitCode).toBe(0);expect(JSON.parse(written.stdout).account).toBe('a@example.test');expect(f.ds.managedTurnOrigin.turnId).toBe('arrival-B');expect(f.dispatches).toHaveLength(2);expect(f.writes()).toEqual([{account:'a@example.test'}]);
 expect(readdirSync(join(f.root,'private'))).toEqual([]);
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
 const records=readFileSync(join(f.auditRoot,'audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 expect(f.writes()).toEqual([{account:'a@example.test'}]);expect(records.map(record=>record.phase)).toEqual(['intent']);expect(JSON.stringify(records)).not.toContain('signature');
 expect(readdirSync(join(f.root,'private'))).toEqual([]);
});
it('revocation after the real child wrote suppresses success without a second write',async()=>{
 const f=await setup(),gate=f.waitDispatch();const pending=f.client(write);await gate.entered;f.revoke();gate.release();const result=await pending;
 expect(result.stderr).toContain('write_outcome_unknown');expect(f.dispatches).toHaveLength(1);expect(f.writes()).toEqual([{account:'a@example.test'}]);expect(result.stdout).toBe('');
});
it('personal status is withdrawn when the auth epoch changes while the provider is running',async()=>{
 const f=await setup(),gate=f.waitProvider();const pending=f.client(['auth','status']);await gate.entered;f.revoke();gate.release();const result=await pending;
 expect(result.exitCode).toBe(77);expect(result.stderr).toContain('authorization_revoked');expect(result.stdout).toBe('');expect(f.dispatches).toEqual([]);
});
