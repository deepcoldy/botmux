import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { createWecomRuntimePublisher, wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { wecomRoot } from '../src/im/wecom/config/discovery.js';
import { WecomDashboardManager } from '../src/dashboard/wecom/manager.js';
import { fleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';
class Socket extends EventEmitter {
 sent:any[]=[];
 send(data:string,cb?:()=>void){const frame=JSON.parse(data);this.sent.push(frame);cb?.();if(frame.cmd!=='aibot_subscribe')queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({headers:frame.headers,errcode:0}))))}
 terminate(){this.emit('close')}
 frame(body:any,id='callback'){this.emit('message',Buffer.from(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:id},body})))}
 auth(){this.emit('message',Buffer.from(JSON.stringify({headers:this.sent[0].headers,errcode:0})))}
}
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks()});
const flush=async()=>{for(let n=0;n<60;n++)await Promise.resolve()};
function fixture(){
 const root=wecomRoot();mkdirSync(root,{recursive:true});cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'config.json'),botId='private-bot-marker';
 writeFileSync(file,JSON.stringify({botId,secretFile:join(root,'private-credential-marker'),coreUrl:'http://127.0.0.1:19123',allowedUsers:['allowed-private-user']}));
 vi.spyOn(fleetProcessIdentityRuntime,'readIdentity').mockReturnValue('controlled-birth');const ns=fleetProcessIdentityRuntime.readPidNamespace(process.pid);
 const publisher=createWecomRuntimePublisher(botId,file);cleanup.push(()=>publisher.stop());publisher.update({phase:'running',connection:'connected'});
 const socket=new Socket();const transport=new WecomTransport({botId,secret:'private-secret-marker',socketFactory:()=>socket as unknown as WebSocket,onInboundEvent:event=>publisher.inbound(event)});cleanup.push(()=>transport.stop());
 const state=join(root,'bridge.json'),trigger=vi.fn(async()=>({ok:true,triggerId:'private-turn',target:{kind:'turn' as const,sessionId:'private-session'}}));
 const core={trigger,result:async()=>({ok:true,state:'running' as const}),interrupt:async()=>{}};
 const bridge=new WecomBridge({botId,allowedUsers:['allowed-private-user'],stateFile:state,transport,core,onAdmission:event=>publisher.admission(event)});
 const manager=new WecomDashboardManager({root,runtime:{readIdentity:()=> 'controlled-birth',readCommandLine:()=>undefined,readPidNamespace:()=>ns,pidExists:()=>true}});
 const body=(id:string,user='allowed-private-user',text='private-message-marker')=>({msgid:id,chattype:'single',from:{userid:user},msgtype:'text',text:{content:text}});
 return {root,file,botId,state,publisher,socket,transport,bridge,trigger,core,manager,body};
}
describe('WeCom redacted diagnostics counters',()=>{
 it('counts callbacks, normalized messages and actual durable admissions separately across the real transport and bridge',async()=>{
  const f=fixture(),started=f.transport.start(message=>f.bridge.receive(message));f.socket.emit('open');f.socket.frame(f.body('pre-auth'));f.socket.auth();await started;
  f.socket.frame({msgtype:'text',text:{content:'private-invalid-marker'}},'invalid');
  f.socket.frame(f.body('denied','denied-private-user'),'denied');await flush();expect(existsSync(f.state)).toBe(false);expect(f.trigger).not.toHaveBeenCalled();
  f.socket.frame(f.body('accepted'),'accepted');await flush();f.socket.frame(f.body('accepted'),'accepted');f.socket.frame(f.body('busy'),'busy');f.socket.frame(f.body('command','allowed-private-user','/status'),'command');f.socket.frame(f.body('unsupported','allowed-private-user','/unavailable'),'unsupported');await flush();
  const diagnostics=(await f.manager.list())[0].diagnostics;expect(diagnostics).toMatchObject({callbacks:8,normalized:6,invalid:1,beforeAuth:1,accepted:1,denied:1,duplicates:1,busy:1,commands:1,unsupported:1});
  expect(Object.keys(JSON.parse(readFileSync(f.state,'utf8')).tasks)).toHaveLength(1);expect(f.trigger).not.toHaveBeenCalled();await f.bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);
  const dto=JSON.stringify((await f.manager.list())[0]);for(const marker of ['private-message-marker','private-invalid-marker','denied-private-user','allowed-private-user','private-secret-marker','private-credential-marker','private-turn','private-session'])expect(dto).not.toContain(marker);
 });
 it('does not count a task as accepted when its durable save fails',async()=>{
  const f=fixture();cleanup.push(blockWecomStateWrites(f.state));await expect(f.bridge.receive({messageId:'failed',userId:'allowed-private-user',conversationId:'allowed-private-user',chatType:'single',text:'private-message-marker',replyContext:{requestId:'failed'},attachments:[]})).rejects.toMatchObject({ code: 'EISDIR' });
  expect((await f.manager.list())[0].diagnostics?.accepted).toBe(0);expect(f.trigger).not.toHaveBeenCalled();
 });
 it.each(['throw','reject'] as const)('does not let %s diagnostics hooks change business admission',async mode=>{
  const f=fixture();const observer=()=>{if(mode==='throw')throw Error('private-secret-marker');return Promise.reject(Error('private-secret-marker'))};
  const transport=new WecomTransport({botId:'fake',secret:'fake',socketFactory:()=>f.socket as unknown as WebSocket,onInboundEvent:observer});cleanup.push(()=>transport.stop());
  const bridge=new WecomBridge({botId:f.botId,allowedUsers:['allowed-private-user'],stateFile:f.state,transport,core:f.core,onAdmission:observer});
  const started=transport.start(message=>bridge.receive(message));f.socket.emit('open');f.socket.auth();await started;f.socket.frame(f.body('admit'));await flush();await bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);
 });
 it('uses a strict diagnostics allowlist and hides stale or malformed evidence',async()=>{
  const f=fixture(),path=join(wecomBotRoot(f.botId),'runtime.json');const record=JSON.parse(readFileSync(path,'utf8'));record.diagnostics.secret='private-secret-marker';record.diagnostics.userId='private-user-marker';writeFileSync(path,JSON.stringify(record));
  const fresh=JSON.stringify(await f.manager.list());expect(fresh).not.toContain('private-secret-marker');expect(fresh).not.toContain('private-user-marker');record.updatedAt=Date.now()-11000;writeFileSync(path,JSON.stringify(record));expect((await f.manager.list())[0].diagnostics).toBeUndefined();
  record.updatedAt=Date.now();record.diagnostics.accepted=-1;writeFileSync(path,JSON.stringify(record));expect((await f.manager.list())[0].diagnostics).toBeUndefined();
 });
});
