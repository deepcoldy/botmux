import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {Readable} from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBytedcliExecClient } from '../src/cli/bytedcli-exec.js';
let server:Server|undefined;const roots:string[]=[];
afterEach(async()=>{server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());server=undefined;for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
async function host(handler:Parameters<typeof createServer>[0]){server=createServer(handler as any);await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));return (server.address() as any).port;}
describe('sandbox broker client',()=>{
  it('snapshots body files, preserves stdout/stderr and upstream exit code',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'bytedcli-client-'));roots.push(dir);const file=join(dir,'body.txt');writeFileSync(file,'original\nbody');let received:any;
    const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);writeFileSync(file,'later');res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'codebase.mr.create',effectiveIdentity:{kind:'actor'},outcome:'failed',stdoutBase64:'b3V0Cg==',stderrBase64:'ZXJyCg==',exitCode:17,errorCode:'upstream_failed'}));});});
    let stdout='',stderr='';const code=await runBytedcliExecClient({sessionId:'s',port,argv:['codebase','mr','create','--repo','ns/repo','--head','x','--base','master','--title','x','--body-file',file],
      stdout:b=>stdout+=b.toString(),stderr:b=>stderr+=b.toString()});
    expect(code).toBe(17);expect(stdout).toBe('out\n');expect(stderr).toContain('err\n');expect(received.argv).not.toContain(file);
    expect(Buffer.from(received.inputs.files[0].dataBase64,'base64').toString()).toBe('original\nbody');
    expect(Object.keys(received).sort()).toEqual(['argv','inputs','requestId','schema','sessionId']);
  });
  it('never retries a write whose response is lost and retains the request id',async()=>{
    let calls=0;const port=await host((req:any)=>{calls++;req.socket.destroy();});let stderr='';
    const code=await runBytedcliExecClient({sessionId:'s',port,requestId:'unknown-1',argv:['codebase','mr','update','42','--repo','ns/repo','--title','x'],stdout:()=>{},stderr:b=>stderr+=b.toString()});
    expect(code).toBe(75);expect(calls).toBe(1);expect(stderr).toContain('unknown-1');expect(stderr).toContain('write_outcome_unknown');
  });
});

it('snapshots bounded stdin once inside the client',async()=>{
  let received:any;const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'codebase.mr.create',effectiveIdentity:{kind:'actor'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0}));});});
  const argv=['codebase','mr','create','--repo','ns/repo','--head','x','--base','master','--title','x','--body-file','-'];
  const code=await runBytedcliExecClient({sessionId:'s',port,argv,stdin:Readable.from(['one','two']),stdout:()=>{},stderr:()=>{}});
  expect(code).toBe(0);expect(received.inputs).toEqual({stdinBase64:'b25ldHdv'});
  const rejected=await runBytedcliExecClient({sessionId:'s',port,argv,stdin:Readable.from([Buffer.alloc(2*1024*1024+1)]),stdout:()=>{},stderr:()=>{}});
  expect(rejected).toBe(77);
});
