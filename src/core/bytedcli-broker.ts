import { runBytedcliSafeCommand } from './bytedcli-safe-commands.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BYTEDCLI_EXEC_LIMITS, BYTEDCLI_EXEC_SCHEMA, BYTEDCLI_EXEC_ERROR_CODES, parseBytedcliExecRequest,
  type BytedcliExecErrorCode, type BytedcliExecResponse } from '../cli/bytedcli-exec-protocol.js';
import { parseBytedcliOperation, BytedcliOperationPolicyError } from './bytedcli-operation-policy.js';
import { resolveLoopbackPeerProcesses } from './current-actor-attestation.js';
import type { BytedcliAuthorityResult, BytedcliAuthorityRequestContext } from './bytedcli-broker-authority.js';
import { resolveBytedcliAuthority } from './bytedcli-broker-authority.js';
import { BytedcliExecutor, type BytedcliExecutionRequest } from './bytedcli-executor.js';
import { createBytedcliHostCredentialResolver } from './bytedcli-broker-credentials.js';
import { BytedcliBrokerAudit, ensureBytedcliPrivateDirectory } from './bytedcli-broker-audit.js';
import { BytedcliBrokerError, discoverBytedcliTrustedCli, type BytedcliTrustedCli } from './bytedcli-broker-process.js';
import { bytedcliContainmentAvailable, markBytedcliStrictSession } from './bytedcli-broker-containment.js';
import { bytecloudBrokerEnabled } from './identity-policy.js';
import type { BytedcliOperation } from './bytedcli-operation-policy.js';
import type { ProcessIdentity } from './current-actor-attestation.js';
export interface BytedcliBrokerDependencies {
  readonly authority: (sessionId:string,peer:ProcessIdentity,operation:BytedcliOperation,context?:BytedcliAuthorityRequestContext) => Promise<BytedcliAuthorityResult>;
  readonly personalLeases?: () => Promise<import('./bytedcli-broker-credentials.js').BytedcliLeaseResolver>;
  readonly currentWorkerGeneration?: (sessionId:string)=>number|undefined;
  readonly executor: {execute:(request:BytedcliExecutionRequest)=>Promise<BytedcliExecResponse>;
    retireSession:(sessionId:string,workerGeneration?:number)=>Promise<void>; close:()=>Promise<void>};
  /** Lower-only timeout seam for hosts/tests; the public body cannot choose it. */
  readonly deadlineMs?: number; readonly bodyTimeoutMs?:number; readonly maxPreauth?:number;
}
function refusal(code:BytedcliExecErrorCode,requestId='unparsed',operationId='unparsed'):BytedcliExecResponse {
  return {schema:BYTEDCLI_EXEC_SCHEMA,requestId,operationId,effectiveIdentity:{kind:'none'},outcome:'rejected',
    stdoutBase64:'',stderrBase64:'',exitCode:77,errorCode:code};
}
function answer(res:ServerResponse,status:number,body:BytedcliExecResponse):void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));
}
function readBody(req:IncomingMessage,signal:AbortSignal,timeoutMs:number):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let bytes=0;
    const finish=(error?:Error)=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',errorHandler);
      signal.removeEventListener('abort',aborted);error?reject(error):resolve(Buffer.concat(chunks,bytes));};
    const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>BYTEDCLI_EXEC_LIMITS.httpBodyBytes){req.pause();finish(new Error('input_limit'));}else chunks.push(Buffer.from(chunk));};
    const end=()=>finish();const errorHandler=()=>finish(new Error('invalid_request'));
    const aborted=()=>finish(new Error('cancelled'));
    const timer=setTimeout(()=>{req.pause();finish(new Error('timeout'));},timeoutMs);
    req.on('data',data);req.once('end',end);req.once('error',errorHandler);signal.addEventListener('abort',aborted,{once:true});
    if(signal.aborted)aborted();
  });
}
/** Each instance owns one daemon executor and pre-auth budget. Socket process
 * resolution is mandatory even when the outer HTTP HMAC gate exempts this route. */
interface BytedcliRequestOwner {
  readonly controller:AbortController;
  sessionId?:string; workerGeneration?:number; work:Promise<void>;
}
const retirementKey=(sessionId:string,generation:number)=>JSON.stringify([sessionId,generation]);
/** A failing cleanup must not release ownership of another pending provider. */
async function joinOwnedWork(work:readonly Promise<unknown>[]):Promise<void>{
  const settled=await Promise.allSettled(work);
  const failed=settled.find((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(failed)throw failed.reason;
}
export class BytedcliBroker {
  private preauth=0;private closed=false;
  private readonly owners=new Set<BytedcliRequestOwner>();
  private readonly retiring=new Map<string,Promise<void>>();
  constructor(private readonly deps:BytedcliBrokerDependencies){}
  handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    const owner:BytedcliRequestOwner={controller:new AbortController(),work:Promise.resolve()};
    this.owners.add(owner);
    owner.work=this.handleRequest(req,res,owner);
    void owner.work.then(()=>this.owners.delete(owner),()=>this.owners.delete(owner));
    return owner.work;
  }
  private freezeGeneration(owner:BytedcliRequestOwner,generation:number):boolean{
    if(owner.controller.signal.aborted || (owner.workerGeneration!==undefined && owner.workerGeneration!==generation))return false;
    owner.workerGeneration=generation;
    if(owner.sessionId && this.retiring.has(retirementKey(owner.sessionId,generation))){owner.controller.abort();return false;}
    return true;
  }
  private async handleRequest(req:IncomingMessage,res:ServerResponse,owner:BytedcliRequestOwner):Promise<void>{
    if(this.closed)return answer(res,503,refusal('broker_disabled'));
    if(this.preauth>=Math.min(64,this.deps.maxPreauth??64)){res.setHeader('connection','close');return answer(res,503,refusal('busy'));}
    this.preauth++;let preauthHeld=true;
    const controller=owner.controller;
    let deadline=false,submitted=false,write=false;
    let executorOutcome:BytedcliExecResponse['outcome']|undefined;
    let requestId='unparsed',operationId='unparsed';
    const unsafeWrite=()=>submitted&&write&&executorOutcome!=='rejected';
    const failed=(code:BytedcliExecErrorCode):BytedcliExecResponse=>{
      const rejected=refusal(code,requestId,operationId);
      return unsafeWrite()?{...rejected,effectiveIdentity:{kind:'actor'},outcome:'write_outcome_unknown',errorCode:'write_outcome_unknown'}:rejected;
    };
    const abort=()=>controller.abort();
    const responseClosed=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);res.once('close',responseClosed);
    const timer=setTimeout(()=>{deadline=true;abort();answer(res,408,failed('timeout'));},Math.min(180_000,this.deps.deadlineMs??180_000));
    try {
      const request=parseBytedcliExecRequest(await readBody(req,controller.signal,Math.min(1000,this.deps.bodyTimeoutMs??1000)));
      requestId=request.requestId;owner.sessionId=request.sessionId;
      owner.workerGeneration=this.deps.currentWorkerGeneration?.(request.sessionId);
      if(owner.workerGeneration!==undefined&&!this.freezeGeneration(owner,owner.workerGeneration))return answer(res,403,failed('execution_stale'));
      const operation=parseBytedcliOperation(request.argv,request.inputs);operationId=operation.id;write=operation.effect==='write';
      const peer=await resolveLoopbackPeerProcesses({remoteAddress:req.socket.remoteAddress,remotePort:req.socket.remotePort,localPort:req.socket.localPort});
      if(controller.signal.aborted)return answer(res,408,failed(deadline?'timeout':'cancelled'));
      if(!peer.ok)return answer(res,403,failed('execution_unverified'));
      // freezeGeneration runs synchronously from host proof, before identity
      // queries, so retirement owns these provider waits as well as execution.
      const result=await this.deps.authority(request.sessionId,peer.peer,operation,{signal:controller.signal,
        freezeGeneration:generation=>this.freezeGeneration(owner,generation)});
      if(!result.ok)return answer(res,403,failed(result.errorCode));
      if(!this.freezeGeneration(owner,result.authority.workerGeneration))return answer(res,403,failed('execution_stale'));
      const current=await result.authority.recheck();
      if(current)return answer(res,403,failed(current));
      if(controller.signal.aborted)return answer(res,408,failed(deadline?'timeout':'cancelled'));
      const safe = operation.effect === 'help' || operation.effect === 'auth';
      // Keep the preauth slot until safe adapter provider work settles. Business
      // operations transfer ownership to the executor's bounded queue instead.
      if (!safe) { this.preauth--;preauthHeld=false; }
      submitted=!safe;
      const execution = {requestId,operation,authority:result.authority,signal:controller.signal};
      const response=safe ? await runBytedcliSafeCommand(execution,this.deps.personalLeases)
        : await this.deps.executor.execute(execution);
      executorOutcome=response.outcome;
      // A refusal/unknown result releases no business data or authority. Do
      // not start another delegated verifier after its executor deadline;
      // successful results still require the frozen result-authority check.
      const refused = response.outcome === 'rejected' || response.outcome === 'write_outcome_unknown';
      const after=refused && result.authority.current ? result.authority.current() : await result.authority.recheck();
      if(after||controller.signal.aborted)return answer(res,403,failed(after??(deadline?'timeout':'cancelled')));
      answer(res,200,response);
    }catch(error){
      const code:BytedcliExecErrorCode=error instanceof BytedcliOperationPolicyError?error.code
        :controller.signal.aborted?(deadline?'timeout':'cancelled')
        :(BYTEDCLI_EXEC_ERROR_CODES as readonly unknown[]).includes((error as {code?:unknown})?.code)?(error as {code:BytedcliExecErrorCode}).code
        :(error as Error)?.message==='input_limit'?'input_limit':(error as Error)?.message==='timeout'?'timeout':'invalid_request';
      if((code==='input_limit'||code==='timeout')&&!res.writableEnded){res.setHeader('connection','close');res.once('finish',()=>req.destroy());}
      answer(res,code==='input_limit'?413:code==='timeout'?408:400,failed(code));
    }finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',responseClosed);if(preauthHeld)this.preauth--;}
  }
  /** The daemon supplies the closed worker generation. Legacy embedders without
   * one retire only the request generations present in this call's snapshot. */
  async retireSession(sessionId:string,workerGeneration?:number):Promise<void>{
    const generation=workerGeneration??this.deps.currentWorkerGeneration?.(sessionId);
    const snapshot=[...this.owners].filter(owner=>owner.sessionId===sessionId
      &&(generation===undefined||owner.workerGeneration===generation));
    const generations=generation===undefined?[...new Set(snapshot.flatMap(owner=>owner.workerGeneration===undefined?[]:[owner.workerGeneration]))]:[generation];
    const keys=generations.map(value=>retirementKey(sessionId,value));
    if(keys.length===1&&this.retiring.has(keys[0]!))return this.retiring.get(keys[0]!)!;
    const retiring=Promise.resolve().then(async()=>{
      for(const owner of snapshot)owner.controller.abort();
      await joinOwnedWork([Promise.resolve().then(()=>this.deps.executor.retireSession(sessionId,generation)),...snapshot.map(owner=>owner.work)]);
    });
    for(const key of keys)this.retiring.set(key,retiring);
    try{await retiring;}finally{for(const key of keys)if(this.retiring.get(key)===retiring)this.retiring.delete(key);}
  }
  async close():Promise<void>{
    this.closed=true;const snapshot=[...this.owners];for(const owner of snapshot)owner.controller.abort();
    await joinOwnedWork([Promise.resolve().then(()=>this.deps.executor.close()),...snapshot.map(owner=>owner.work)]);
  }
}
export { bytedcliTrustedHostLayout, type BytedcliHostLayout } from './bytedcli-host-layout.js';
import { freezeBytedcliHostLayout, type BytedcliHostLayout } from './bytedcli-host-layout.js';
/** The caller supplies only frozen daemon host dependencies. Task4 uses the
 * exact protectedRoots of this same layout when it compiles worker isolation. */
export function createProductionBytedcliBroker(host:Omit<import('./bytedcli-broker-authority.js').BytedcliAuthorityDependencies,'contains'>,
  layout:BytedcliHostLayout=freezeBytedcliHostLayout()):BytedcliBroker{
  let executor:BytedcliExecutor|undefined,pending:Promise<BytedcliExecutor>|undefined,closed=false;
  const trustedCli=async(signal:AbortSignal):Promise<BytedcliTrustedCli>=>{
    if (layout.unavailableReason || !layout.runtimeStillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
    ensureBytedcliPrivateDirectory(layout.privateRoot);const root=mkdtempSync(join(layout.privateRoot,'probe-'));
    const home=join(root,'home'),cwd=join(root,'cwd');mkdirSync(home,{mode:0o700});mkdirSync(cwd,{mode:0o700});
    try{return await discoverBytedcliTrustedCli({candidates:layout.candidates,installationRoots:layout.installationRoots,
      runtimeExecutable:layout.runtimeExecutable,path:layout.path,runtimeStillCurrent:layout.runtimeStillCurrent,probeHome:home,probeCwd:cwd,signal});}
    finally{rmSync(root,{recursive:true,force:true});}
  };
  let personalLeases: Promise<import('./bytedcli-broker-credentials.js').BytedcliLeaseResolver> | undefined;
  const getLeases=()=>personalLeases??=createBytedcliHostCredentialResolver({machineHome:layout.machineHome,machineProfile:layout.machineProfile,privateRoot:layout.privateRoot,trustedCli,networkEnv:layout.networkEnv});
  const getExecutor=()=>pending??=(async()=>{
    const leases=await getLeases();
    executor=new BytedcliExecutor({privateRoot:layout.privateRoot,trustedCli,leases,audit:new BytedcliBrokerAudit(layout.auditRoot),networkEnv:layout.networkEnv});
    if(closed)await executor.close();return executor;
  })();
  return new BytedcliBroker({personalLeases:getLeases,currentWorkerGeneration:id=>host.findSession(id)?.workerGeneration,authority:(sessionId,peer,operation,context)=>resolveBytedcliAuthority({...host,contains:ds=>{
    if(bytecloudBrokerEnabled(host.policy(ds)))markBytedcliStrictSession(ds);
    if(layout.unavailableReason || !layout.runtimeStillCurrent()) return false;
    return bytedcliContainmentAvailable(ds,layout.protectedRoots);
  }},sessionId,peer,operation,context),executor:{execute:async request=>{
    if(closed)return refusal('broker_disabled',request.requestId,request.operation.id);
    return (await getExecutor()).execute(request);
  },retireSession:async (id,generation)=>{await executor?.retireSession(id,generation);},close:async()=>{closed=true;if(pending){const instance=await pending.catch(()=>undefined);await instance?.close();}}}});
}
