import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import {request as httpRequest} from 'node:http';
import { spawnTsEval } from './helpers/ts-runner.js';
import { BYTEDCLI_EXEC_SCHEMA } from '../src/cli/bytedcli-exec-protocol.js';
let ipc: IpcServerHandle | undefined;
import {readProcessStartIdentity} from '../src/utils/process-identity.js';
afterEach(async () => { await ipc?.close(); ipc = undefined;vi.restoreAllMocks(); });
const body = { schema: BYTEDCLI_EXEC_SCHEMA, sessionId: 's-broker', requestId: 'r-1', argv: ['codebase','repo','list','--json'] };
async function post(value: unknown) {
  return fetch(`http://127.0.0.1:${ipc!.port}/api/bytedcli-exec`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(value) });
}
describe('credential-free broker HTTP boundary', () => {
  it('gives a safe broker refusal through the narrow outer-auth aperture', async () => {
    ipc = await startIpcServer({ port:0, host:'127.0.0.1', authRequired:true });
    const response = await post(body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ schema:BYTEDCLI_EXEC_SCHEMA, errorCode:'execution_unverified', stdoutBase64:'' });
  });
  it('refuses caller-owned identity fields before any execution', async () => {
    ipc = await startIpcServer({ port:0, host:'127.0.0.1', authRequired:true });
    const response = await post({...body, actor:{email:'owner@example.com'}, HOME:'/tmp/evil', pid:process.pid });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({errorCode:'invalid_request'});
  });
});

function fixture(options:{blocked?:boolean;wait?:boolean;maxPreauth?:number;machine?:boolean}={}) {
  let calls=0,aborted=false;let started!:()=>void;const entered=new Promise<void>(r=>started=r);
  const authority:any={daemonBootId:'boot',botAppId:'cli_broker',sessionId:'s-broker',turnId:'turn-A',identityTurnId:'A',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'frozen',
    executionIdentity:options.machine?'machine':'actor',actor:{verifiedEmail:'a@example.com',credentialOpenId:'ou_A',source:'local'},recheck:async()=>options.blocked?'policy_changed':undefined};
  const broker=new BytedcliBroker({deadlineMs:1000,maxPreauth:options.maxPreauth,authority:async(sid,peer)=>sid==='s-broker'&&peer.pid===process.pid?{ok:true,authority}:{ok:false,errorCode:'execution_unverified'},
    executor:{execute:async request=>{
      calls++;started();if(options.wait)await new Promise<void>(resolve=>{request.signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});
      return {schema:BYTEDCLI_EXEC_SCHEMA,requestId:request.requestId,operationId:request.operation.id,effectiveIdentity:{kind:options.machine?'machine':'actor',accountFingerprint:'sha256:broker-account'},outcome:'completed',stdoutBase64:'b2sK',stderrBase64:'',exitCode:0};
    },retireSession:async()=>{},close:async()=>{}}});
  return {broker,entered,calls:()=>calls,aborted:()=>aborted};
}
it('rechecks frozen authority immediately before a write can reach upstream',async()=>{
  const f=fixture({blocked:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const response=await post({...body,argv:['codebase','mr','create','--repo','ns/repo','--head','x','--base','master','--title','demo']});
  expect(f.calls()).toBe(0);expect(await response.json()).toMatchObject({errorCode:'policy_changed',outcome:'rejected'});
});
it('independently refuses a foreign socket process even with known routing',async()=>{
  const f=fixture();ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const child=spawnTsEval(`const response=await fetch('http://127.0.0.1:${ipc.port}/api/bytedcli-exec',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}); console.log(await response.text());`,{stdio:['ignore','pipe','pipe']});
  const text=await new Promise<string>((resolve,reject)=>{let output='';child.stdout!.on('data',b=>output+=b);child.once('error',reject);child.once('close',()=>resolve(output));});
  expect(JSON.parse(text)).toMatchObject({errorCode:'execution_unverified'});expect(f.calls()).toBe(0);
});
it('does not cancel a normal completed request body',async()=>{
  const f=fixture();ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const response=await post(body);expect(await response.json()).toMatchObject({outcome:'completed',stdoutBase64:'b2sK'});expect(f.calls()).toBe(1);expect(f.aborted()).toBe(false);
});
it('hard deadline cancels provider work and marks an in-flight write unknown',async()=>{
  const f=fixture({wait:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const pending=post({...body,argv:['codebase','mr','create','--repo','ns/repo','--head','x','--base','master','--title','demo']});
  await f.entered;const response=await pending;
  expect(await response.json()).toMatchObject({outcome:'write_outcome_unknown',errorCode:'write_outcome_unknown'});expect(f.aborted()).toBe(true);
});
it('unknown hard deadline projects unknown effect and actor identity over the real HTTP route',async()=>{
  const f=fixture({wait:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const pending=post({...body,argv:['unreviewed','mutate','--force']});await f.entered;
  expect(await (await pending).json()).toMatchObject({operationEffect:'unknown',effectiveIdentity:{kind:'actor'},outcome:'write_outcome_unknown',errorCode:'write_outcome_unknown'});
  expect(f.calls()).toBe(1);expect(f.aborted()).toBe(true);
});
it('session retirement aborts a request waiting inside the executor',async()=>{
  const f=fixture({wait:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const pending=post(body);await f.entered;await ipc.retireBytedcliSession('s-broker');await pending;expect(f.aborted()).toBe(true);
});

it('production route refuses an active strict worker with no actual containment record',async()=>{
  const ds:any={session:{sessionId:'s-broker',status:'active',backendType:'pty'},larkAppId:'cli_broker',chatId:'oc_broker',workerGeneration:7,
    worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:7,cliPid:process.pid,cliProcStart:readProcessStartIdentity(process.pid)},
    managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'current',preexistingProcessIdentities:[`${process.pid}:${readProcessStartIdentity(process.pid)}`]}};
  vi.spyOn(await import('../src/core/worker-pool.js'),'findActiveBySessionId').mockReturnValue(ds);
  vi.spyOn(await import('../src/bot-registry.js'),'getBot').mockReturnValue({config:{larkAppId:'cli_broker',triggerUserAuth:{enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor'}}} as any);
  const lookup=vi.spyOn(await import('../src/im/lark/identity-cache.js'),'resolveVerifiedUserIdentity');
  ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});
  expect(await (await post(body)).json()).toMatchObject({errorCode:'broker_containment_unavailable'});expect(lookup).not.toHaveBeenCalled();
});

it('cancels only when an unfinished response socket is closed',async()=>{
  const f=fixture({wait:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const controller=new AbortController();const pending=fetch(`http://127.0.0.1:${ipc.port}/api/bytedcli-exec`,{method:'POST',body:JSON.stringify(body),signal:controller.signal}).catch(()=>undefined);
  await f.entered;controller.abort();await pending;
  for(let i=0;i<100&&!f.aborted();i++)await new Promise(r=>setTimeout(r,5));
  expect(f.aborted()).toBe(true);
});

it('bounds preauth request ownership while an earlier body stalls',async()=>{
  const f=fixture({maxPreauth:1});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const stalled=httpRequest({hostname:'127.0.0.1',port:ipc.port,path:'/api/bytedcli-exec',method:'POST'});stalled.on('error',()=>{});stalled.write('{');
  try{await new Promise(r=>setTimeout(r,20));const response=await post(body);expect(response.status).toBe(503);expect(await response.json()).toMatchObject({errorCode:'busy'});expect(f.calls()).toBe(0);}
  finally{stalled.destroy();}
});
it('rejects an oversized HTTP body before peer/credential admission',async()=>{
  const f=fixture();ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
  const response=await fetch(`http://127.0.0.1:${ipc.port}/api/bytedcli-exec`,{method:'POST',body:' '.repeat(3*1024*1024+1)});
  expect(response.status).toBe(413);expect(await response.json()).toMatchObject({errorCode:'input_limit'});expect(f.calls()).toBe(0);
});

it('keeps a known pre-dispatch executor rejection rejected after authority withdrawal',async()=>{
 let withdrawn=false;const authority:any={daemonBootId:'boot',botAppId:'app',sessionId:'s-broker',turnId:'t',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'p',actor:{verifiedEmail:'a@example.com',credentialOpenId:'ou_A',source:'local'},recheck:async()=>withdrawn?'policy_changed':undefined};
 const broker=new BytedcliBroker({authority:async()=>({ok:true,authority}),executor:{execute:async r=>{withdrawn=true;return {schema:BYTEDCLI_EXEC_SCHEMA,requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:'none'},outcome:'rejected',stdoutBase64:'',stderrBase64:'',exitCode:77,errorCode:'actor_auth_required'};},retireSession:async()=>{},close:async()=>{}}});
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 const response=await post({...body,argv:['codebase','mr','close','42','--repo','ns/repo']});
 expect(await response.json()).toMatchObject({outcome:'rejected',errorCode:'policy_changed'});
});

it.each(['completed','rejected'] as const)('preserves write safety when post-result recheck throws after %s',async outcome=>{
 let finished=false,writes=0;const authority:any={daemonBootId:'boot',botAppId:'app',sessionId:'s-broker',turnId:'t',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'p',actor:{verifiedEmail:'a@example.com',credentialOpenId:'ou_A',source:'local'},recheck:async()=>{if(finished)throw new Error('provider failure');}};
 const broker=new BytedcliBroker({authority:async()=>({ok:true,authority}),executor:{execute:async r=>{finished=true;if(outcome==='completed')writes++;return {schema:BYTEDCLI_EXEC_SCHEMA,requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:outcome==='completed'?'actor':'none'},outcome,stdoutBase64:'',stderrBase64:'',exitCode:outcome==='completed'?0:77,...(outcome==='rejected'?{errorCode:'actor_auth_required' as const}:{})};},retireSession:async()=>{},close:async()=>{}}});
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 const response=await post({...body,argv:['codebase','mr','close','42','--repo','ns/repo']});
 expect(writes).toBe(outcome==='completed'?1:0);
 expect(await response.json()).toMatchObject(outcome==='completed'?{outcome:'write_outcome_unknown',effectiveIdentity:{kind:'actor'},errorCode:'write_outcome_unknown'}:{outcome:'rejected'});
});
it('admits a successor generation after retiring the same session',async()=>{
 let generation=1;
 const broker=new BytedcliBroker({currentWorkerGeneration:()=>generation,
  authority:async()=>({ok:true,authority:{daemonBootId:'boot',botAppId:'app',sessionId:'s-broker',turnId:'t',workerGeneration:generation,dispatchAttempt:0,policyFingerprint:'p',recheck:async()=>undefined}}),
  executor:{execute:async (r:any)=>({schema:BYTEDCLI_EXEC_SCHEMA,requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:'machine'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0}),retireSession:async()=>{},close:async()=>{}}} as any);
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 expect((await (await post(body)).json()).outcome).toBe('completed');
 await ipc.retireBytedcliSession('s-broker',1);generation=2;
 expect((await (await post({...body,requestId:'generation-2'})).json()).outcome).toBe('completed');
});
it('does not let an old close callback cancel a successor generation request',async()=>{
 let generation=2,started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);let aborted=false;
 const authority:any={daemonBootId:'boot',botAppId:'app',sessionId:'s-broker',turnId:'t',workerGeneration:2,dispatchAttempt:0,policyFingerprint:'p',recheck:async()=>undefined};
 const broker=new BytedcliBroker({currentWorkerGeneration:()=>generation,authority:async()=>({ok:true,authority}),executor:{execute:async r=>{r.signal!.addEventListener('abort',()=>aborted=true,{once:true});started();await gate;return {schema:BYTEDCLI_EXEC_SCHEMA,requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:'machine'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0};},retireSession:async()=>{},close:async()=>{}}} as any);
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 const pending=post(body);await entered;const retired=ipc.retireBytedcliSession('s-broker',1);
 await new Promise(r=>setTimeout(r,20));const cancelledSuccessor=aborted;release();await retired;
 const result=await (await pending).json();expect(cancelledSuccessor).toBe(false);expect(result.outcome).toBe('completed');
});
it.each(['retire','close'] as const)('joins pending authority even when executor %s cleanup rejects',async method=>{
 let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 const cleanupError=new Error('cleanup failed');let cleanupCalls=0;
 const cleanup=async()=>{if(cleanupCalls++===0)throw cleanupError;};
 const broker=new BytedcliBroker({currentWorkerGeneration:()=>1,authority:async(_sid,_peer,_operation,context)=>{
  context!.freezeGeneration!(1);started();await gate;return {ok:false,errorCode:'cancelled'};
 },executor:{execute:async()=>{throw new Error('must not execute');},retireSession:cleanup,close:cleanup}});
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 const pending=post(body);await entered;let settled=false;
 const stop=(method==='retire'?broker.retireSession('s-broker',1):broker.close()).then(()=>{settled=true;return undefined;},error=>{settled=true;return error;});
 await new Promise(r=>setTimeout(r,15));const premature=settled;release();
 const result=await stop;await pending;
 expect(premature).toBe(false);expect(result).toBe(cleanupError);
});

it('broker deadlines preserve frozen machine write identity before executor settlement',async()=>{
 const f=fixture({wait:true,machine:true});ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:f.broker});
 const pending=post({...body,argv:['codebase','mr','close','1','--repo','ns/repo']});await f.entered;
 const result=await (await pending).json();expect(result).toMatchObject({outcome:'write_outcome_unknown',effectiveIdentity:{kind:'machine'},stdoutBase64:''});
});
it('broker post-result revocation preserves machine write identity and account fingerprint',async()=>{
 let finished=false;const authority:any={daemonBootId:'boot',botAppId:'app',sessionId:'s-broker',turnId:'t',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'p',executionIdentity:'machine',recheck:async()=>finished?'policy_changed':undefined};
 const broker=new BytedcliBroker({authority:async()=>({ok:true,authority}),executor:{execute:async r=>{finished=true;return {schema:BYTEDCLI_EXEC_SCHEMA,requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:'machine',accountFingerprint:'sha256:actual-machine'},outcome:'completed',stdoutBase64:'cHJpdmF0ZQ==',stderrBase64:'',exitCode:0};},retireSession:async()=>{},close:async()=>{}}});
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,bytedcliBroker:broker});
 expect(await (await post({...body,argv:['codebase','mr','close','1','--repo','ns/repo']})).json()).toMatchObject({outcome:'write_outcome_unknown',effectiveIdentity:{kind:'machine',accountFingerprint:'sha256:actual-machine'},stdoutBase64:''});
});
