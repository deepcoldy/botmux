import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { BYTEDCLI_EXEC_LIMITS, BYTEDCLI_EXEC_SCHEMA, BYTEDCLI_EXEC_ERROR_CODES, parseBytedcliExecRequest,
  type BytedcliExecErrorCode, type BytedcliExecResponse } from '../cli/bytedcli-exec-protocol.js';
import { parseBytedcliOperation, BytedcliOperationPolicyError } from './bytedcli-operation-policy.js';
import { resolveLoopbackPeerProcesses } from './current-actor-attestation.js';
import type { BytedcliAuthorityResult } from './bytedcli-broker-authority.js';
import { resolveBytedcliAuthority } from './bytedcli-broker-authority.js';
import { BytedcliExecutor, type BytedcliExecutionRequest } from './bytedcli-executor.js';
import { createBytedcliHostCredentialResolver, parseBytedcliMachineProfile } from './bytedcli-broker-credentials.js';
import { BytedcliBrokerAudit, ensureBytedcliPrivateDirectory } from './bytedcli-broker-audit.js';
import { discoverBytedcliTrustedCli, type BytedcliTrustedCli } from './bytedcli-broker-process.js';
import { bytedcliContainmentAvailable, markBytedcliStrictSession } from './bytedcli-broker-containment.js';
import { bytecloudBrokerEnabled } from './identity-policy.js';
import type { BytedcliOperation } from './bytedcli-operation-policy.js';
import type { ProcessIdentity } from './current-actor-attestation.js';
export interface BytedcliBrokerDependencies {
  readonly authority: (sessionId:string,peer:ProcessIdentity,operation:BytedcliOperation) => Promise<BytedcliAuthorityResult>;
  readonly executor: {execute:(request:BytedcliExecutionRequest)=>Promise<BytedcliExecResponse>;
    retireSession:(sessionId:string)=>Promise<void>; close:()=>Promise<void>};
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
export class BytedcliBroker {
  private readonly controllers=new Set<AbortController>();private preauth=0;private closed=false;
  private readonly handlers=new Set<Promise<void>>();
  private readonly sessions=new Map<AbortController,string>();
  private readonly retiring=new Set<string>();
  private readonly retiredHandlers=new Map<string,Set<Promise<void>>>();
  constructor(private readonly deps:BytedcliBrokerDependencies){}
  handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    let work:Promise<void>;
    const bindSession=(id:string)=>{
      let group=this.retiredHandlers.get(id);if(!group){group=new Set();this.retiredHandlers.set(id,group);}
      group.add(work);
      void work.then(()=>{group!.delete(work);if(!group!.size)this.retiredHandlers.delete(id);},()=>{group!.delete(work);if(!group!.size)this.retiredHandlers.delete(id);});
    };
    work=this.handleRequest(req,res,bindSession);this.handlers.add(work);
    void work.then(()=>this.handlers.delete(work),()=>this.handlers.delete(work));return work;
  }
  private async handleRequest(req:IncomingMessage,res:ServerResponse,bindSession:(id:string)=>void):Promise<void>{
    if(this.closed)return answer(res,503,refusal('broker_disabled'));
    if(this.preauth>=Math.min(64,this.deps.maxPreauth??64)){res.setHeader('connection','close');return answer(res,503,refusal('busy'));}
    this.preauth++;let preauthHeld=true;
    const controller=new AbortController();this.controllers.add(controller);
    let deadline=false,submitted=false,write=false;
    let requestId='unparsed',operationId='unparsed';
    const abort=()=>controller.abort();
    const responseClosed=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);res.once('close',responseClosed);
    const timer=setTimeout(()=>{
      deadline=true;abort();
      const result=refusal('timeout',requestId,operationId);
      answer(res,408,submitted&&write?{...result,effectiveIdentity:{kind:'actor'},outcome:'write_outcome_unknown',errorCode:'write_outcome_unknown'}:result);
    },Math.min(180_000,this.deps.deadlineMs??180_000));
    try {
      const request=parseBytedcliExecRequest(await readBody(req,controller.signal,Math.min(1000,this.deps.bodyTimeoutMs??1000)));
      requestId=request.requestId;this.sessions.set(controller,request.sessionId);bindSession(request.sessionId);
      if(this.retiring.has(request.sessionId))return answer(res,403,refusal('execution_stale',requestId));
      const operation=parseBytedcliOperation(request.argv,request.inputs);operationId=operation.id;write=operation.effect==='write';
      const peer=await resolveLoopbackPeerProcesses({remoteAddress:req.socket.remoteAddress,remotePort:req.socket.remotePort,localPort:req.socket.localPort});
      if(controller.signal.aborted)return answer(res,408,refusal(deadline?'timeout':'cancelled',requestId,operationId));
      if(!peer.ok)return answer(res,403,refusal('execution_unverified',requestId,operationId));
      const result=await this.deps.authority(request.sessionId,peer.peer,operation);
      if(!result.ok)return answer(res,403,refusal(result.errorCode,requestId,operationId));
      // Admission remains owned through all provider waits. The executor also
      // checks before its quota wait, lease, audit intent, dispatch and return.
      const current=await result.authority.recheck();
      if(current)return answer(res,403,refusal(current,requestId,operationId));
      if(controller.signal.aborted)return answer(res,408,refusal(deadline?'timeout':'cancelled',requestId,operationId));
      this.preauth--;preauthHeld=false;
      submitted=true;
      const response=await this.deps.executor.execute({requestId,operation,authority:result.authority,signal:controller.signal});
      const after=await result.authority.recheck();
      if(after||controller.signal.aborted){
        const code=after??(deadline?'timeout':'cancelled');
        const rejected=refusal(code,requestId,operationId);
        return answer(res,403,write&&response.outcome!=='rejected'?{...rejected,effectiveIdentity:{kind:'actor'},outcome:'write_outcome_unknown',errorCode:'write_outcome_unknown'}:rejected);
      }
      answer(res,200,response);
    }catch(error){
      const code:BytedcliExecErrorCode=error instanceof BytedcliOperationPolicyError?error.code
        :controller.signal.aborted?(deadline?'timeout':'cancelled')
        :(BYTEDCLI_EXEC_ERROR_CODES as readonly unknown[]).includes((error as {code?:unknown})?.code)?(error as {code:BytedcliExecErrorCode}).code
        :(error as Error)?.message==='input_limit'?'input_limit':(error as Error)?.message==='timeout'?'timeout':'invalid_request';
      if(code==='input_limit'||code==='timeout'){res.setHeader('connection','close');res.once('finish',()=>req.destroy());}
      answer(res,code==='input_limit'?413:code==='timeout'?408:400,refusal(code,requestId,operationId));
    }finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',responseClosed);this.controllers.delete(controller);this.sessions.delete(controller);if(preauthHeld)this.preauth--;}
  }
  async retireSession(sessionId:string):Promise<void>{
    this.retiring.add(sessionId);
    if(this.retiring.size>4096)this.retiring.delete(this.retiring.values().next().value!);
    for(const [controller,id] of this.sessions)if(id===sessionId)controller.abort();
    await this.deps.executor.retireSession(sessionId);
    await Promise.allSettled([...(this.retiredHandlers.get(sessionId)??[])]);
  }
  async close():Promise<void>{this.closed=true;for(const controller of this.controllers)controller.abort();await this.deps.executor.close();await Promise.allSettled([...this.handlers]);}
}
/** Frozen once at host assembly. PATH is daemon startup configuration, never
 * Bot/Agent env, and discover validates canonical install/runtime ownership. */
export function bytedcliTrustedHostLayout(settings:{readonly machineProfile?:string;readonly protectedRoots?:readonly string[]}={}){
  const machineHome=homedir(),path=process.env.PATH??'/usr/local/bin:/usr/bin:/bin';
  const directories=path.split(delimiter).filter(isAbsolute);
  const candidates=directories.map(dir=>join(dir,'bytedcli')).filter(existsSync).flatMap(file=>{try{return [realpathSync(file)];}catch{return [];}});
  const runtimeCandidates=directories.map(dir=>join(dir,'node')).filter(existsSync);
  const runtimeExecutable=runtimeCandidates[0]??'/usr/bin/node';
  const installationRoots=[...new Set(candidates.map(file=>dirname(dirname(file))))];
  const privateRoot=join(machineHome,'.botmux','host-authority','bytedcli-broker');
  const auditRoot=join(privateRoot,'audit');
  const credentialRoots=[join(machineHome,'.local','share','bytedcli'),join(machineHome,'.botmux','data','bytedcli-home'),
    join(machineHome,'.botmux','data','cli-auth-epoch'),join(machineHome,'.botmux','host-authority'),
    join(machineHome,'.botmux','device-auth'),join(machineHome,'.botmux','platform.json'),
    ...['AIME_WORKSPACE_PATH','AILY_WORKSPACE_PATH','AILY_WORKSPACE_DIR'].flatMap(key=>process.env[key]&&isAbsolute(process.env[key]!)?[process.env[key]!]:[]),
    ...(settings.protectedRoots??[])];
  const executableReadOnlyRoots=[...installationRoots,...directories.map(dir=>join(dir,'bytedcli')).filter(existsSync),
    runtimeExecutable,dirname(runtimeExecutable)];
  const protectedRoots=[...credentialRoots,...executableReadOnlyRoots];
  if(protectedRoots.some(root=>!isAbsolute(root)||root.startsWith('/$bunfs/')))throw new Error('invalid trusted protected root');
  const canonicalAliases=(paths:readonly string[])=>Object.freeze([...new Set(paths.flatMap(root=>{
    let ancestor=root;const suffix:string[]=[];
    while(!existsSync(ancestor)&&dirname(ancestor)!==ancestor){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
    try{return [root,join(realpathSync(ancestor),...suffix)];}catch{return [root];}
  }))]);
  const aliases=canonicalAliases(protectedRoots);
  const networkEnv:NodeJS.ProcessEnv={};
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']){
    if(process.env[key])networkEnv[key]=process.env[key];
  }
  return Object.freeze({machineHome,path,candidates:Object.freeze(candidates),runtimeExecutable,
    installationRoots:Object.freeze(installationRoots),privateRoot,auditRoot,machineProfile:parseBytedcliMachineProfile(settings.machineProfile),credentialRoots:canonicalAliases(credentialRoots),
    executableReadOnlyRoots:canonicalAliases(executableReadOnlyRoots),protectedRoots:aliases,networkEnv:Object.freeze(networkEnv)});
}
export type BytedcliHostLayout=ReturnType<typeof bytedcliTrustedHostLayout>;
/** The caller supplies only frozen daemon host dependencies. Task4 uses the
 * exact protectedRoots of this same layout when it compiles worker isolation. */
export function createProductionBytedcliBroker(host:Omit<import('./bytedcli-broker-authority.js').BytedcliAuthorityDependencies,'contains'>,
  layout:BytedcliHostLayout=bytedcliTrustedHostLayout()):BytedcliBroker{
  let executor:BytedcliExecutor|undefined,pending:Promise<BytedcliExecutor>|undefined,closed=false;
  const trustedCli=async(signal:AbortSignal):Promise<BytedcliTrustedCli>=>{
    ensureBytedcliPrivateDirectory(layout.privateRoot);const root=mkdtempSync(join(layout.privateRoot,'probe-'));
    const home=join(root,'home'),cwd=join(root,'cwd');mkdirSync(home,{mode:0o700});mkdirSync(cwd,{mode:0o700});
    try{return await discoverBytedcliTrustedCli({candidates:layout.candidates,installationRoots:layout.installationRoots,
      runtimeExecutable:layout.runtimeExecutable,path:layout.path,probeHome:home,probeCwd:cwd,signal});}
    finally{rmSync(root,{recursive:true,force:true});}
  };
  const getExecutor=()=>pending??=(async()=>{
    const leases=await createBytedcliHostCredentialResolver({machineHome:layout.machineHome,machineProfile:layout.machineProfile,privateRoot:layout.privateRoot,trustedCli,networkEnv:layout.networkEnv});
    executor=new BytedcliExecutor({privateRoot:layout.privateRoot,trustedCli,leases,audit:new BytedcliBrokerAudit(layout.auditRoot),networkEnv:layout.networkEnv});
    if(closed)await executor.close();return executor;
  })();
  return new BytedcliBroker({authority:(sessionId,peer,operation)=>resolveBytedcliAuthority({...host,contains:ds=>{
    if(bytecloudBrokerEnabled(host.policy(ds)))markBytedcliStrictSession(ds);
    return bytedcliContainmentAvailable(ds,layout.protectedRoots);
  }},sessionId,peer,operation),executor:{execute:async request=>{
    if(closed)return refusal('broker_disabled',request.requestId,request.operation.id);
    return (await getExecutor()).execute(request);
  },retireSession:async id=>{await executor?.retireSession(id);},close:async()=>{closed=true;if(pending){const instance=await pending.catch(()=>undefined);await instance?.close();}}}});
}
