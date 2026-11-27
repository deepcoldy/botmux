import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { identifyWecomIdentity } from '../src/cli/wecom/identify.js';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
class Socket extends EventEmitter {sent:any[]=[];terminated=false;send(data:string){this.sent.push(JSON.parse(data))}terminate(){this.terminated=true;this.emit('close')}frame(text:string,type='single'){this.emit('message',Buffer.from(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'callback'},body:{msgid:randomUUID(),from:{userid:'fake-callback-user'},chattype:type,chatid:'fake-group',msgtype:'text',text:{content:text}}})))}}
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture(){const root=mkdtempSync(join(tmpdir(),'wecom-identify-challenge-'));roots.push(root);const file=join(root,'config.json'),secret=join(root,'credential'),output=join(root,'result.json');writeFileSync(secret,'fake-secret',{mode:0o600});writeFileSync(file,JSON.stringify({botId:randomUUID(),secretFile:secret,coreUrl:'http://127.0.0.1:19123',allowedUsers:['old-user']}));const socket=new Socket(),printed:string[]=[];const challenge='BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF';const options={configFile:file,outputFile:output,write:(line:string)=>{printed.push(line)},challenge:()=>challenge,timeoutMs:1000,createTransport:(settings:any)=>new WecomTransport({...settings,socketFactory:()=>socket as unknown as WebSocket})};return {root,file,secret,output,socket,printed,challenge,options}}
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve()};
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so an
 * assertion created before the event would observe the 1s identify timeout instead.
 */
const settled=(promise:Promise<unknown>)=>promise.then(()=>undefined,()=>undefined);
it('real transport rejects pre-auth/incorrect/group challenges and writes only one bound private identity',async()=>{
 const f=fixture(),before=readFileSync(f.file,'utf8'),credential=readFileSync(f.secret,'utf8'),running=identifyWecomIdentity(f.options);await vi.waitFor(()=>expect(f.socket.listenerCount('open')).toBe(1));
 f.socket.emit('open');f.socket.frame(f.challenge);await flush();expect(existsSync(f.output)).toBe(false);f.socket.emit('message',Buffer.from(JSON.stringify({headers:f.socket.sent[0].headers,errcode:0})));await vi.waitFor(()=>expect(f.printed).toContain(f.challenge));
 f.socket.frame('incorrect');f.socket.frame(f.challenge,'group');await flush();expect(existsSync(f.output)).toBe(false);f.socket.frame(f.challenge);await running;
 expect(statSync(f.output).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(f.output,'utf8')).configDigest).toMatch(/^[a-f0-9]{64}$/);expect(readFileSync(f.file,'utf8')).toBe(before);expect(readFileSync(f.secret,'utf8')).toBe(credential);expect(f.printed.join('\n')).not.toContain('fake-callback-user');expect(f.socket.terminated).toBe(true);
});
it('real transport preserves auth-before-cancel reason and removes pending socket',async()=>{
 const f=fixture(),abort=new AbortController(),running=identifyWecomIdentity({...f.options,signal:abort.signal});const runningSettled=settled(running);await vi.waitFor(()=>expect(f.socket.listenerCount('open')).toBe(1));abort.abort();await runningSettled;await expect(running).rejects.toThrow('wecom_identify_cancelled');expect(f.socket.terminated).toBe(true);expect(existsSync(f.output)).toBe(false);
});
it('refuses a symlink introduced after authentication without changing target or ACL',async()=>{
 const f=fixture(),before=readFileSync(f.file,'utf8'),running=identifyWecomIdentity(f.options),runningSettled=settled(running);await vi.waitFor(()=>expect(f.socket.listenerCount('open')).toBe(1));f.socket.emit('open');f.socket.emit('message',Buffer.from(JSON.stringify({headers:f.socket.sent[0].headers,errcode:0})));await vi.waitFor(()=>expect(f.printed).toContain(f.challenge));symlinkSync(f.file,f.output);f.socket.frame(f.challenge);await runningSettled;await expect(running).rejects.toMatchObject({ code: 'EEXIST' });expect(readFileSync(f.file,'utf8')).toBe(before);expect(f.socket.terminated).toBe(true);
});
it('never executes a redelivered verification challenge after the sender becomes authorized',async()=>{
 const f=fixture(),trigger=vi.fn(async()=>({ok:false}));const bridge=new WecomBridge({botId:'fake',allowedUsers:['fake-callback-user'],stateFile:join(f.root,'bridge.json'),transport:{reply:async()=>{},send:async()=>{}},core:{trigger,result:async()=>({ok:false}),interrupt:async()=>{}}});await bridge.receive({messageId:'redelivered',userId:'fake-callback-user',conversationId:'fake-callback-user',chatType:'single',text:f.challenge,replyContext:{requestId:'callback'},attachments:[]});await bridge.tick();expect(trigger).not.toHaveBeenCalled();expect(Object.keys(JSON.parse(readFileSync(join(f.root,'bridge.json'),'utf8')).tasks)).toHaveLength(0);
});
