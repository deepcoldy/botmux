import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';
const harness=vi.hoisted(()=>({socket:undefined as any,child:undefined as any,env:undefined as any,exitSoon:false,spawns:0}));
vi.mock('../src/im/wecom/protocol/transport.js', async original => {
 const actual = await original<typeof import('../src/im/wecom/protocol/transport.js')>();
 return { ...actual, WecomTransport: class extends actual.WecomTransport {
  constructor(options:any) { super({...options, socketFactory:()=>{
   queueMicrotask(()=>harness.socket.emit('open')); return harness.socket;
  }}); }
 }};
});
vi.mock('../src/im/wecom/gateway/managed-core.js', async original => {
 const actual = await original<typeof import('../src/im/wecom/gateway/managed-core.js')>();
 return {...actual, startWecomManagedCore:(config:any,options:any)=>actual.startWecomManagedCore(config,{
  ...options, shutdownTimeoutMs:200,
  spawn:(_command,_args,spawnOptions)=>{
   harness.spawns++; harness.env=spawnOptions.env;
   harness.child=spawnTsEval(`console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')');${harness.exitSoon?'setTimeout(()=>process.exit(21),150);':'setInterval(()=>{},1000);'}`,spawnOptions);
   return harness.child;
  }
 })};
});
vi.mock('../src/utils/file-lock.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../src/utils/file-lock.js')>();
 return {...actual,withFileLock:async(_file:string,fn:()=>Promise<unknown>)=>fn()};
});
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
class Socket extends EventEmitter{
 sent:any[]=[];terminated=false;
 send(data:string,cb?:(error?:Error)=>void){const frame=JSON.parse(data);this.sent.push(frame);cb?.();queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({headers:frame.headers,errcode:0}))))}
 terminate(){this.terminated=true;this.emit('close')}
 receive(frame:any){this.emit('message',Buffer.from(JSON.stringify(frame)))}
}
const roots:string[]=[];afterEach(async()=>{await releaseWecomCorePorts();if(harness.child?.exitCode===null&&harness.child?.signalCode===null)harness.child.kill('SIGKILL');for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();harness.child=undefined;harness.env=undefined;harness.spawns=0;harness.exitSoon=false});
async function fixture(managed=true){const port=await reserveWecomCorePort();const root=mkdtempSync(join(tmpdir(),'wecom-setup-managed-'));roots.push(root);harness.socket=new Socket();const secret=join(root,'credential');writeFileSync(secret,'fake-credential',{mode:0o600});const config={botId:'acceptance-managed',secretEnv:'CUSTOM_GATEWAY_SECRET',coreUrl:`http://127.0.0.1:${port}`,allowedUsers:['alice'],stateDir:join(root,'bridge'),...(managed?{managedCore:{cli:'codex',backend:'pty',workingDirectory:root,port,stateDir:join(root,'core'),botId:'local_acceptance'}}:{})};const file=join(root,'config.json');writeFileSync(file,JSON.stringify(config));vi.stubEnv('CUSTOM_GATEWAY_SECRET','fake-credential');vi.stubEnv('WECOM_BOT_SECRET','default-fake-credential');return {root,file,config}}
async function until(predicate:()=>boolean){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('controlled fixture did not become ready');await new Promise(done=>setTimeout(done,5))}}
function replaced(){harness.socket.receive({cmd:'aibot_event_callback',body:{event:{eventtype:'disconnected_event'}}})}
describe('WeCom setup and owned runtime cross-boundaries',()=>{
 it('scrubs configured and default secrets from the real child environment and reaps owned core after WS replacement',async()=>{
  const f=await fixture();const running=runWecomCommand(['--config',f.file]);await until(()=>harness.socket.sent.some((frame:any)=>frame.cmd==='aibot_subscribe'));
  expect(harness.env.CUSTOM_GATEWAY_SECRET).toBeUndefined();expect(harness.env.WECOM_BOT_SECRET).toBeUndefined();expect(harness.env.BOTMUX_CORE_SKIP_DOTENV).toBe('1');expect(harness.env.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.1');
  replaced();expect(await running).toBe(1);const child=harness.child as ChildProcess;expect(child.exitCode!==null||child.signalCode!==null).toBe(true);expect(harness.socket.terminated).toBe(true);
 });
 it('shuts the gateway down when its owned core exits unexpectedly',async()=>{
  const f=await fixture();harness.exitSoon=true;expect(await runWecomCommand(['--config',f.file])).toBe(1);expect(harness.socket.terminated).toBe(true);expect(harness.spawns).toBe(1);
 });
 it('never creates or owns a core child for legacy external configuration',async()=>{
  const f=await fixture(false);const running=runWecomCommand(['--config',f.file]);await until(()=>harness.socket.sent.length>0);replaced();expect(await running).toBe(1);expect(harness.spawns).toBe(0);
 });
 it('rejects foreign pending core state before spawning any owned process',async()=>{
  const f=await fixture();const bridge=new WecomBridge({botId:f.config.botId,allowedUsers:['alice'],coreIdentity:'old-core',stateFile:join(f.config.stateDir,'state.json'),transport:{reply:async()=>{},send:async()=>{}},core:{trigger:async()=>({ok:false}),result:async()=>({ok:false}),interrupt:async()=>{}}});
  await bridge.receive({messageId:'pending',text:'old task',userId:'alice',conversationId:'alice',chatType:'single',replyContext:{requestId:'pending'},attachments:[]});
  expect(await runWecomCommand(['--config',f.file])).toBe(1);expect(harness.spawns).toBe(0);expect(harness.socket.sent).toHaveLength(0);
 });
 it('does not attach to or stop an incumbent on the managed port',async()=>{
  const f=await fixture(),server=createServer();server.listen(f.config.managedCore!.port,'127.0.0.1');await once(server,'listening');
  try{expect(await runWecomCommand(['--config',f.file])).toBe(1);expect(harness.spawns).toBe(0);expect(server.listening).toBe(true);expect(harness.socket.sent).toHaveLength(0)}finally{await new Promise<void>(done=>server.close(()=>done()))}
 });
 it('applies newly committed native ACL before the next inbound command',async()=>{
  const f=await fixture(false);const running=runWecomCommand(['--config',f.file]);await until(()=>harness.socket.sent.length>0);
  writeFileSync(f.file,JSON.stringify({...f.config,allowedUsers:['bob']}));
  const callback=(id:string,userId:string)=>({cmd:'aibot_msg_callback',headers:{req_id:id},body:{msgid:id,chattype:'single',from:{userid:userId},msgtype:'text',text:{content:'/status'}}});
  harness.socket.receive(callback('bob-status','bob'));harness.socket.receive(callback('alice-status','alice'));await until(()=>harness.socket.sent.some((frame:any)=>frame.headers.req_id==='bob-status'));
  expect(harness.socket.sent.some((frame:any)=>frame.headers.req_id==='alice-status')).toBe(false);replaced();expect(await running).toBe(1);
 });
});
