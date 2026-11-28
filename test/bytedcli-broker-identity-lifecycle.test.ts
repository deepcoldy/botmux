import {afterEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BytedcliBroker} from '../src/core/bytedcli-broker.js';
import {resolveBytedcliAuthority} from '../src/core/bytedcli-broker-authority.js';
import {readProcessStartIdentity} from '../src/utils/process-identity.js';
import {rememberLarkToolDelegation,clearLarkToolDelegations} from '../src/core/lark-tool-delegation.js';
import {resolveVerifiedUserIdentity,resolveVerifiedUserIdentityByUnionId,getIdentity,flushIdentityCacheSync} from '../src/im/lark/identity-cache.js';
import * as registry from '../src/bot-registry.js';
import {config} from '../src/config.js';
let server:Server|undefined,broker:BytedcliBroker|undefined,root='',prior='';let release=()=>{};
afterEach(async()=>{release();await broker?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;broker=undefined;flushIdentityCacheSync();clearLarkToolDelegations(root,'s-owned');vi.restoreAllMocks();if(prior)config.session.dataDir=prior;if(root)rmSync(root,{recursive:true,force:true});root='';});
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
it.each(['retire','close','http-timeout'] as const)('joins the actual delegated token/contact provider after %s without late identity publication',async method=>{
 root=mkdtempSync(join(tmpdir(),'broker-owned-'));prior=config.session.dataDir;config.session.dataDir=root;
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let providerSignal:AbortSignal|undefined;let contacts=0;
 const token=new Promise<void>(r=>release=r);
 // Actual larkGet forwards this request-owned signal. Emulate an SDK token
 // promise ignoring abort; contact must not begin after that token settles.
 vi.spyOn(registry,'getBotClient').mockReturnValue({request:async (options:any)=>{
  providerSignal=options.signal;entered();await token;if(options.signal.aborted)throw new Error('cancelled before contact');contacts++;
  return {code:0,data:{user:{open_id:'ou_target',union_id:'on_owned',enterprise_email:'owned@example.com'}}};
 }} as any);
 const procStart=readProcessStartIdentity(process.pid)!;
 const ds:any={session:{sessionId:'s-owned',status:'active',backendType:'pty'},larkAppId:`cli_lifecycle_${method}`,chatId:'oc_owned',workerGeneration:1,worker:{pid:process.pid,killed:false},
  localProcessAttestation:{backendType:'pty',workerGeneration:1,cliPid:process.pid,cliProcStart:procStart},
  managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'owned-turn',trustedCaller:{senderType:'bot'},preexistingProcessIdentities:[`${process.pid}:${procStart}`]}};
 rememberLarkToolDelegation(root,'s-owned','owned-turn',{targetOpenId:'ou_target',credentialOpenId:'ou_source',unionId:'on_owned',tools:['bytedcli'],dispatchRoot:'root'});
 let writes=0;
 const deps:any={daemonBootId:'boot',dataDir:root,findSession:()=>ds,policy:()=>({enabled:true,tools:['bytedcli'],bytecloudExecution:'read-machine-write-actor',credentialSource:'local'}),contains:()=>true,canTalk:()=>true,
  identity:(app:string,id:string,options:any)=>resolveVerifiedUserIdentity(app,id,{...options,timeoutMs:20}),unionIdentity:(app:string,id:string,options:any)=>resolveVerifiedUserIdentityByUnionId(app,id,{...options,timeoutMs:20}),schedule:()=>undefined,authEpoch:()=>0,bindingKey:()=> 'binding'};
 broker=new BytedcliBroker({deadlineMs:1000,currentWorkerGeneration:()=>1,authority:(sid,peer,operation,context)=>resolveBytedcliAuthority(deps,sid,peer,operation,context),
  executor:{execute:async r=>{writes++;return {schema:'botmux.bytedcli-exec.v1',requestId:r.requestId,operationId:r.operation.id,effectiveIdentity:{kind:'actor'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0};},retireSession:async()=>{},close:async()=>{}}});
 server=createServer((req,res)=>{void broker!.handle(req,res);});await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
 const port=(server.address() as any).port;
 const response=fetch(`http://127.0.0.1:${port}/api/bytedcli-exec`,{method:'POST',body:JSON.stringify({schema:'botmux.bytedcli-exec.v1',sessionId:'s-owned',requestId:'owned-1',argv:['codebase','mr','close','42','--repo','ns/repo']})});
 await started;await delay(35);expect(providerSignal?.aborted).toBe(true);
 if(method==='http-timeout')expect(await (await response).json()).toMatchObject({outcome:'rejected',errorCode:'timeout'});
 let stopped=false;const stop=(method==='retire'?broker.retireSession('s-owned',1):broker.close()).then(()=>stopped=true);
 await delay(15);const premature=stopped;release();await stop;if(method!=='http-timeout')await response;
 expect(premature).toBe(false);expect(contacts).toBe(0);expect(writes).toBe(0);expect(getIdentity(ds.larkAppId,'ou_target')).toBeUndefined();
});
