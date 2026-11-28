import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {Readable} from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBytedcliExecClient } from '../src/cli/bytedcli-exec.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
let server:Server|undefined;const roots:string[]=[];
afterEach(async()=>{server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());server=undefined;for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
async function host(handler:Parameters<typeof createServer>[0]){server=createServer(handler as any);await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));return (server.address() as any).port;}
describe('sandbox broker client',()=>{
  it.each([false,true])('snapshots a MindAI image with its media extension and omits the host path (equals=%s)',async equals=>{
    const dir=mkdtempSync(join(tmpdir(),'bytedcli-mindai-client-'));roots.push(dir);const file=join(dir,'reference.PNG');writeFileSync(file,Buffer.from([0,255,42]));let received:any;
    const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);writeFileSync(file,'later');res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'mindai.chart.update',operationEffect:'write',effectiveIdentity:{kind:'machine'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0}));});});
    const argv=['mindai','chart','update','--task-id','task-1','--prompt','draw',...(equals?['--attachment='+file]:['--attachment',file])];
    expect(await runBytedcliExecClient({sessionId:'s',port,argv,stdout:()=>{},stderr:()=>{}})).toBe(0);
    expect(JSON.stringify(received)).not.toContain(file);
    expect(received.inputs.files).toEqual([{id:'input0-png',dataBase64:'AP8q'}]);
    expect(parseBytedcliOperation(received.argv,received.inputs)).toMatchObject({id:'mindai.chart.update',effect:'write'});
  });
  it.each([{argv:['--no-auto-upgrade','--version'],id:'help.version'}, {argv:['--no-auto-upgrade','--help'],id:'help.root'},
    {argv:['codebase','--no-auto-upgrade','--help'],id:'help.codebase'}])('keeps safe help flags compatible with upgrade disabled: $argv',({argv,id})=>{
    expect(parseBytedcliOperation(argv)).toMatchObject({id,effect:'help'});
  });
  it.each([{argv:['--no-auto-upgrade','--json','auth','status']},{argv:['auth','status','--no-auto-upgrade','--json']}])('submits reviewed auth status with upgrade disabled: $argv',async ({argv})=>{
    let calls=0,received:any;const port=await host((req:any,res:any)=>{let body='';req.on('data',(b:Buffer)=>body+=b);req.on('end',()=>{calls++;received=JSON.parse(body);res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'auth.status',operationEffect:'auth',effectiveIdentity:{kind:'none'},outcome:'rejected',stdoutBase64:'',stderrBase64:'',exitCode:77,errorCode:'actor_required'}));});});
    let stderr='';expect(await runBytedcliExecClient({sessionId:'s',port,argv,stdout:()=>{},stderr:b=>stderr+=b})).toBe(77);
    expect(calls).toBe(1);expect(received.argv).toEqual(argv);expect(stderr).toContain('actor_required');
  });
  it('preserves reviewed remote --file selectors without reading a local file',async()=>{
    let received:any;const argv=['codebase','mr','diff','42','--repo','ns/repo','--file','does-not-exist-locally.ts'];
    const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'codebase.mr.diff',operationEffect:'read',effectiveIdentity:{kind:'machine'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0}));});});
    expect(await runBytedcliExecClient({sessionId:'s',port,argv,stdout:()=>{},stderr:()=>{}})).toBe(0);
    expect(received.argv).toEqual(argv);expect(received.inputs).toBeUndefined();
  });
  it('snapshots binary TOS files before host submission and verifies returned effect',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'bytedcli-client-binary-'));roots.push(dir);const file=join(dir,'input.bin');writeFileSync(file,Buffer.from([0,255,42]));let received:any;
    const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);writeFileSync(file,'changed');res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:'tos.upload-object.c4-report',operationEffect:'write',effectiveIdentity:{kind:'machine'},outcome:'completed',stdoutBase64:'b2s=',stderrBase64:'',exitCode:0}));});});
    let stdout='';const code=await runBytedcliExecClient({sessionId:'s',port,argv:['tos','upload-object','--bucket-id','20001326','--key','c4_config_checker_res/a.bin','--file='+file,'--timeout-ms','30000'],stdout:b=>stdout+=b.toString(),stderr:()=>{}});
    expect(code).toBe(0);expect(stdout).toBe('ok');expect(JSON.stringify(received)).not.toContain(file);expect(received.inputs.files[0].dataBase64).toBe('AP8q');
  });
  it.each(['lost','mismatched-effect'])('unknown treats %s as an uncertain write and never retries',async mode=>{
    let calls=0;const argv=['new-business','mutate','--force'];const op=parseBytedcliOperation(argv);
    const port=await host((req:any,res:any)=>{calls++;if(mode==='lost'){req.socket.destroy();return;}let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{const request=JSON.parse(text);res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:request.requestId,operationId:op.id,operationEffect:'read',effectiveIdentity:{kind:'actor'},outcome:'completed',stdoutBase64:'c2hvdWxkLW5vdC1lc2NhcGU=',stderrBase64:'',exitCode:0}));});});
    let stderr='',stdout='';expect(await runBytedcliExecClient({sessionId:'s',port,argv,stdout:b=>stdout+=b.toString(),stderr:b=>stderr+=b.toString()})).toBe(75);
    expect(calls).toBe(1);expect(stdout).toBe('');expect(stderr).toContain('write_outcome_unknown');
  });
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

it('snapshots large Skill JSON before host admission without transmitting caller paths',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'skill-client-'));roots.push(dir);const file=join(dir,'request.json');
 const body={name:'chart.png',mimeType:'image/png',dataBase64:Buffer.alloc(90000,1).toString('base64')};writeFileSync(file,JSON.stringify(body));let received:any;
 const port=await host((req:any,res:any)=>{let text='';req.on('data',(b:Buffer)=>text+=b);req.on('end',()=>{received=JSON.parse(text);writeFileSync(file,'changed');const op=parseBytedcliOperation(received.argv,received.inputs);res.end(JSON.stringify({schema:'botmux.bytedcli-exec.v1',requestId:received.requestId,operationId:op.id,operationEffect:op.effect,effectiveIdentity:{kind:'actor'},outcome:'completed',stdoutBase64:'',stderrBase64:'',exitCode:0}));});});
 expect(await runBytedcliExecClient({sessionId:'s',port,argv:['skill-api','mindai.attachment.upload','--body-file',file],stdout:()=>{},stderr:()=>{}})).toBe(0);
 expect(JSON.stringify(received)).not.toContain(file);expect(JSON.parse(Buffer.from(received.inputs.files[0].dataBase64,'base64').toString())).toEqual(body);
});
