import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const mode = process.argv[2];
const source = process.env.REVIEW_SOURCE ?? repo;
const root = fs.mkdtempSync(join(tmpdir(), 'bmx-final-probe-'));
const out = (value: unknown) => console.log(JSON.stringify(value));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve=r); return {promise, resolve}; };
const drain = async () => { for(let n=0;n<100;n++) await Promise.resolve(); };

if(mode === 'overlap' || mode === 'broker-pre-admission') {
  const {BytedcliExecutor} = await import(source+'/src/core/bytedcli-executor.ts');
  const {BytedcliCredentialResolver} = await import(source+'/src/core/bytedcli-broker-credentials.ts');
  const {BytedcliBrokerAudit} = await import(source+'/src/core/bytedcli-broker-audit.ts');
  const {resolveBytedcliAuthority} = await import(source+'/src/core/bytedcli-broker-authority.ts');
  const {rememberLarkToolDelegation} = await import(source+'/src/core/lark-tool-delegation.ts');
  const {readProcessStartIdentity} = await import(source+'/src/utils/process-identity.ts');
  const {parseBytedcliOperation} = await import(source+'/src/core/bytedcli-operation-policy.ts');
  const originalNow=Date.now, originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  let now=originalNow(),serial=0;const timers=new Map<any,{at:number;run:()=>void}>();
  Date.now=()=>now;
  globalThis.setTimeout=((fn:any,ms:number,...args:any[])=>{const id={serial:++serial,ref(){return this},unref(){return this},refresh(){return this}};timers.set(id,{at:now+ms,run:()=>fn(...args)});return id;}) as any;
  globalThis.clearTimeout=((id:any)=>timers.delete(id)) as any;
  const tick=async(ms:number)=>{now+=ms;for(let pass=0;pass<20;pass++){for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.run();}await drain();}};
  const procStart=readProcessStartIdentity(process.pid)!;
  const ds:any={session:{sessionId:'s',status:'active',backendType:'pty'},larkAppId:'cli_probe',chatId:'oc_probe',workerGeneration:1,worker:{pid:process.pid,killed:false},localProcessAttestation:{backendType:'pty',workerGeneration:1,cliPid:process.pid,cliProcStart:procStart},managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'A',identityTurnId:'A',trustedCaller:{senderType:'user',requestUserOpenId:'ou_A'},preexistingProcessIdentities:[`${process.pid}:${procStart}`]}};
  let epoch=0;
  const authorityDeps:any={daemonBootId:'boot',dataDir:root,findSession:()=>ds,policy:()=>({enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor',credentialSource:'local'}),contains:()=>true,canTalk:()=>true,identity:async(_app:string,id:string)=>({openId:id,type:'user',email:id==='ou_A'?'a@example.test':'b@example.test'}),unionIdentity:async()=>({openId:'ou_A',email:'a@example.test'}),schedule:()=>undefined,authEpoch:()=>epoch,bindingKey:()=>undefined};
  const operation={...parseBytedcliOperation(['codebase','mr','close','42','--repo','org/repo']),timeoutMs:10_000};
  const proof=()=>resolveBytedcliAuthority(authorityDeps,'s',{pid:process.pid,procStart},operation);
  const gate=deferred();let mints=0,dispatches=0;const accounts:string[]=[];
  const jwt=(email:string)=>`e30.${Buffer.from(JSON.stringify({region:'cn',exp:Math.floor(Date.now()/1000)+3600,email})).toString('base64url')}.signature`;
  const leases=new BytedcliCredentialResolver({machineHome:join(root,'machine'),localHome:id=>join(root,id),localQueue:async(_id,run)=>run(),readEpoch:()=>epoch,epochAllows:()=>true,platform:{bindingKey:()=>undefined,resolve:async()=>undefined},provider:{observe:async({home})=>({authenticated:true,loginFingerprint:home}),mint:async({home})=>{mints++;if(mints===1&&mode==='overlap')await gate.promise;return jwt(home.endsWith('ou_A')?'a@example.test':'b@example.test');},userinfo:async token=>{const email=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).email;return {username:email.split('@')[0],email};}}});
  const executor=new BytedcliExecutor({privateRoot:join(root,'private'),audit:new BytedcliBrokerAudit(join(root,'audit')),leases,trustedCli:async()=>({executable:'/usr/bin/false',path:'/usr/bin:/bin',version:'0.199.0',stillCurrent:()=>true}),run:async invocation=>{dispatches++;const token=fs.readFileSync(invocation.argv[invocation.argv.indexOf('--bytecloud-user-jwt-file')+1],'utf8');accounts.push(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).email);return {stdout:Buffer.from('done'),stderr:Buffer.alloc(0),exitCode:0};}});
  if(mode==='overlap') {
    const a=await proof();assert(a.ok);
    const one=executor.execute({requestId:'same-id',operation,authority:a.authority});await drain();assert.equal(mints,1);
    const duplicate=executor.execute({requestId:'same-id',operation,authority:a.authority});await drain();
    await tick(10001);assert.equal((await one).errorCode,'timeout');assert.equal((await duplicate).errorCode,'timeout');
    epoch++;ds.managedTurnOrigin={...ds.managedTurnOrigin,turnId:'B',identityTurnId:'B',trustedCaller:{senderType:'user',requestUserOpenId:'ou_B'}};
    const b=await proof();assert(b.ok);
    const queued=executor.execute({requestId:'same-id',operation,authority:b.authority});await drain();
    const mintsBeforeRecovery=mints;assert.equal(mintsBeforeRecovery,1,'cancelled A released its provider slot before cleanup');
    await tick(5001);const busy=await queued;assert.equal(busy.errorCode,'busy');
    gate.resolve();await drain();
    const repeated=await executor.execute({requestId:'same-id',operation,authority:b.authority});assert.equal(repeated.errorCode,'busy');
    const next=await executor.execute({requestId:'explicit-new-id',operation,authority:b.authority});await executor.close();
    assert.equal(next.outcome,'completed');assert.deepEqual(accounts,['b@example.test']);
    out({mode,root,mintsBeforeRecovery,queued:busy.errorCode,repeated:repeated.errorCode,next:next.outcome,dispatches,accounts});
  } else {
    const {BytedcliBroker}=await import(source+'/src/core/bytedcli-broker.ts');
    const {createServer, request:httpRequest}=await import('node:http');
    let armed=false,active=0;let entered=deferred(),submittedEntered=deferred();const pendingGate=deferred();
    ds.managedTurnOrigin.trustedCaller={senderType:'bot'};
    rememberLarkToolDelegation(root,'s','A',{targetOpenId:'ou_A',credentialOpenId:'ou_A',unionId:'on_A',tools:['bytedcli'],dispatchRoot:'root',taskAuthorized:async()=>{
      if(armed){armed=false;active++;entered.resolve();await pendingGate.promise;active--;}return true;
    }});
    const broker=new BytedcliBroker({currentWorkerGeneration:()=>1,
      authority:(sid,peer,op,context)=>resolveBytedcliAuthority(authorityDeps,sid,peer,op,context),
      executor:{execute:r=>{armed=true;submittedEntered.resolve();return executor.execute(r);},retireSession:(...a)=>executor.retireSession(...a),close:()=>executor.close()}});
    const server=createServer((req,res)=>{void broker.handle(req,res);});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const port=(server.address() as any).port;
    const post=()=>new Promise<any>((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/api/bytedcli-exec',method:'POST'},res=>{
      let text='';res.on('data',b=>text+=b);res.once('end',()=>{armed=false;resolve(JSON.parse(text));});
    });req.once('error',reject);req.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',sessionId:'s',requestId:'same-id',argv:operation.argv}));});
    const responses=[];
    for(let n=0;n<17;n++){
      entered=deferred();submittedEntered=deferred();const response=post();await submittedEntered.promise;if(n===0)await entered.promise;await tick(60_001);
      const result=await response;assert(['timeout','busy'].includes(result.errorCode),JSON.stringify(result));responses.push(result.errorCode);
    }
    let closeSettled=false;const close=broker.close().then(()=>closeSettled=true);await drain();
    out({mode,root,responseCount:responses.length,timeoutResponses:responses.filter(code=>code==='timeout').length,busyResponses:responses.filter(code=>code==='busy').length,activeProviderAfterTimeout:active,closeSettledBeforeProvider:closeSettled,dispatches});
    assert.equal(active,1,'same-ID HTTP requests started extra initial verifiers');assert.equal(closeSettled,false,'close failed to join the underlying initial authority work');assert.equal(dispatches,0);
    pendingGate.resolve();await drain();await close;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  }
  Date.now=originalNow;globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
} else throw new Error('unknown mode');
