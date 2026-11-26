import { request as httpRequest } from 'node:http';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BYTEDCLI_EXEC_LIMITS, BYTEDCLI_EXEC_ROUTE, BYTEDCLI_EXEC_SCHEMA,
  decodeBytedcliBase64, parseBytedcliExecRequest, parseBytedcliExecResponse,
  type BytedcliExecInputs } from './bytedcli-exec-protocol.js';
import { parseBytedcliOperation } from '../core/bytedcli-operation-policy.js';
export interface BytedcliExecClientOptions {
  readonly sessionId:string;readonly port:number;readonly requestId?:string;readonly argv:readonly string[];
  readonly stdout:(buffer:Buffer)=>void;readonly stderr:(buffer:Buffer)=>void;
  readonly stdin?:NodeJS.ReadableStream;readonly signal?:AbortSignal;readonly timeoutMs?:number;
}
function snapshotFile(path:string,limit:number):Buffer{
  const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw new Error('input_limit');
    const bytes:Buffer[]=[];let count=0;
    for(;;){const chunk=Buffer.alloc(Math.min(64*1024,limit-count+1));const size=readSync(fd,chunk,0,chunk.length,null);
      if(!size)break;count+=size;if(count>limit)throw new Error('input_limit');bytes.push(chunk.subarray(0,size));}
    return Buffer.concat(bytes,count);
  }finally{closeSync(fd);}
}
async function snapshotStdin(stream:NodeJS.ReadableStream,signal:AbortSignal,limit:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let bytes=0;
    const cleanup=()=>{stream.off('data',data);stream.off('end',end);stream.off('error',error);signal.removeEventListener('abort',aborted);};
    const error=()=>{cleanup();reject(new Error('invalid_request'));};
    const data=(raw:Buffer|string)=>{const b=Buffer.from(raw);bytes+=b.length;if(bytes>limit){stream.pause();cleanup();reject(new Error('input_limit'));}else chunks.push(b);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks,bytes));};
    const aborted=()=>{stream.pause();cleanup();reject(new Error('cancelled'));};
    stream.on('data',data);stream.once('end',end);stream.once('error',error);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
  });
}
async function snapshotInputs(argv:readonly string[],stdin:NodeJS.ReadableStream|undefined,signal:AbortSignal){
  const result=[...argv];const files:{id:string;dataBase64:string}[]=[];let stdinBase64:string|undefined,total=0;
  for(let index=0;index<result.length;index++){
    const arg=result[index]!;let path:string|undefined,valueIndex:number|undefined;
    if(arg==='--body-file'||arg==='-F'){valueIndex=index+1;path=result[valueIndex];}
    else if(arg.startsWith('--body-file=')){path=arg.slice('--body-file='.length);}
    else if(arg.startsWith('-F=')){path=arg.slice(3);}
    else continue;
    if(path===undefined||!path)throw new Error('invalid_request');
    const data=path==='-'?await snapshotStdin(stdin??process.stdin,signal,BYTEDCLI_EXEC_LIMITS.inputBytes-total):snapshotFile(path,BYTEDCLI_EXEC_LIMITS.inputBytes-total);
    total+=data.length;const id=path==='-'?'-':`input${files.length}`;
    if(path==='-'){if(stdinBase64!==undefined)throw new Error('invalid_request');stdinBase64=data.toString('base64');}
    else files.push({id,dataBase64:data.toString('base64')});
    if(valueIndex!==undefined){result[index]='--body-file';result[valueIndex]=id;index++;}
    else result[index]=`--body-file=${id}`;
  }
  const inputs:BytedcliExecInputs|undefined=files.length||stdinBase64!==undefined?{
    ...(files.length?{files}:{}),...(stdinBase64!==undefined?{stdinBase64}:{})}:undefined;
  return {argv:result,inputs};
}
function send(port:number,body:string,signal:AbortSignal):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path:BYTEDCLI_EXEC_ROUTE,method:'POST',agent:false,
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},signal},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*Math.ceil(BYTEDCLI_EXEC_LIMITS.outputBytes/3)+4096){req.destroy(new Error('output_limit'));}else chunks.push(Buffer.from(chunk));});
      res.once('error',reject);res.once('aborted',()=>reject(new Error('response_lost')));
      res.once('end',()=>resolve(Buffer.concat(chunks,bytes)));
    });req.once('error',reject);req.end(body);
  });
}
/** No secret, caller PID, account, HOME, cwd or executable crosses the wire.
 * Routing hints are untrusted; the daemon proves the actual TCP socket holder. */
export async function runBytedcliExecClient(options:BytedcliExecClientOptions):Promise<number>{
  const requestId=options.requestId??randomUUID();let effect='read',submitted=false;
  const controller=new AbortController(),abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const timer=setTimeout(abort,Math.min(180_000,options.timeoutMs??180_000));
  try{
    if(!Number.isSafeInteger(options.port)||options.port<1||options.port>65535)throw new Error('invalid_request');
    const snapshot=await snapshotInputs(options.argv,options.stdin,controller.signal);
    const operation=parseBytedcliOperation(snapshot.argv,snapshot.inputs);effect=operation.effect;
    const request=parseBytedcliExecRequest({schema:BYTEDCLI_EXEC_SCHEMA,sessionId:options.sessionId,requestId,argv:snapshot.argv,...(snapshot.inputs?{inputs:snapshot.inputs}:{})});
    const body=JSON.stringify(request);if(Buffer.byteLength(body)>BYTEDCLI_EXEC_LIMITS.httpBodyBytes)throw new Error('input_limit');
    submitted=true;
    const response=parseBytedcliExecResponse(await send(options.port,body,controller.signal));
    if(response.requestId!==requestId||(response.operationId!==operation.id&&response.operationId!=='unparsed'))throw new Error('response_unverified');
    options.stdout(decodeBytedcliBase64(response.stdoutBase64,BYTEDCLI_EXEC_LIMITS.outputBytes));
    options.stderr(decodeBytedcliBase64(response.stderrBase64,BYTEDCLI_EXEC_LIMITS.outputBytes));
    if(response.errorCode)options.stderr(Buffer.from(`bytedcli: ${response.errorCode} (requestId=${requestId})\n`));
    return response.exitCode;
  }catch{
    const unknown=submitted&&effect==='write';
    options.stderr(Buffer.from(`bytedcli: ${unknown?'write_outcome_unknown':'broker_request_failed'} (requestId=${requestId})\n`));
    return unknown?75:77;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
/** Private wrapper entry. Session/port can come from embedded routing hints;
 * they never authorize a call and cannot select a remote HTTP destination. */
export async function runBytedcliExecEntry(args:readonly string[],env:NodeJS.ProcessEnv=process.env):Promise<number>{
  if(env.BOTMUX_AS){process.stderr.write('bytedcli: actor switching is unavailable in broker mode\n');return 77;}
  let sessionId=env.BOTMUX_SESSION_ID??'',port=Number(env.BOTMUX_DAEMON_IPC_PORT);let index=0;
  for(;index<args.length;index++){
    if(args[index]==='--'){index++;break;}
    if(args[index]==='--session-id'){sessionId=args[++index]??'';continue;}
    if(args[index]==='--ipc-port'){port=Number(args[++index]);continue;}
    break;
  }
  return runBytedcliExecClient({sessionId,port,argv:args.slice(index),stdout:b=>process.stdout.write(b),stderr:b=>process.stderr.write(b)});
}
