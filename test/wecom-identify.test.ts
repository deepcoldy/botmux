import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { identifyWecomIdentity } from '../src/cli/wecom/identify.js';
import type { WecomIdentityTransport } from '../src/im/wecom/protocol/identity-challenge.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { WecomTransportOptions } from '../src/im/wecom/protocol/transport.js';
const roots:string[]=[]; afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so an
 * assertion created before the event would observe the 1s identify timeout instead.
 */
const settled=(promise:Promise<unknown>)=>promise.then(()=>undefined,()=>undefined);
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'wecom-identify-'));roots.push(root);const file=join(root,'config.json'),output=join(root,'identity.json'),secret=join(root,'credential');
 writeFileSync(secret,'fake-sensitive-secret',{mode:0o600});writeFileSync(file,JSON.stringify({botId:randomUUID(),secretFile:secret,coreUrl:'http://127.0.0.1:19123',allowedUsers:['old-authorized-user']}));
 const printed:string[]=[];let handler!:(message:WecomInboundMessage)=>Promise<void>|void;let settings!:WecomTransportOptions;
 const transport:WecomIdentityTransport={start:vi.fn(async message=>{handler=message}),stop:vi.fn(async()=>{})};
 const factory=vi.fn((options:WecomTransportOptions)=>{settings=options;return transport});
 const options={configFile:file,outputFile:output,write:(line:string)=>printed.push(line),challenge:()=> 'BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF',createTransport:factory,timeoutMs:1000};
 const message=(text=options.challenge(),chatType:'single'|'group'='single'):WecomInboundMessage=>({messageId:randomUUID(),userId:'new-verified-user',conversationId:'conversation',chatType,text,replyContext:{requestId:'callback'},attachments:[]});
 return {root,file,output,printed,transport,factory,options,message,getHandler:()=>handler,getSettings:()=>settings};
}
describe('一次性私聊身份校验',()=>{
 it('只接受完整单聊challenge，结果0600并绑定原配置，不输出userid或secret',async()=>{
  const f=fixture(),before=readFileSync(f.file,'utf8');const running=identifyWecomIdentity(f.options);
  await vi.waitFor(()=>expect(f.printed).toContain(f.options.challenge()));
  for(const event of [f.message('wrong'),f.message(' '+f.options.challenge()),f.message(undefined,'group'),{...f.message(),quote:{type:'text',text:'quoted'}},{...f.message(),attachments:[{type:'image' as const,url:'https://fake.invalid'}]}])await f.getHandler()(event);
  expect(existsSync(f.output)).toBe(false);await f.getHandler()(f.message());await running;
  const record=JSON.parse(readFileSync(f.output,'utf8'));expect(record.userid).toBe('new-verified-user');expect(record.configDigest).toBe(createHash('sha256').update(before).digest('hex'));
  expect(statSync(f.output).mode&0o777).toBe(0o600);expect(readFileSync(f.file,'utf8')).toBe(before);expect(f.printed.join('\n')).not.toContain('new-verified-user');expect(f.printed.join('\n')).not.toContain('fake-sensitive-secret');expect(f.transport.stop).toHaveBeenCalled();
 });
 it('超时和terminal disconnect都清理且不产出结果',async()=>{
  const f=fixture();const running=identifyWecomIdentity(f.options);const runningSettled=settled(running);
  await vi.waitFor(()=>expect(f.printed).toContain(f.options.challenge()));f.getSettings().onTerminalDisconnect?.('replaced');await runningSettled;await expect(running).rejects.toThrow('wecom_identify_disconnected');expect(f.transport.stop).toHaveBeenCalled();expect(existsSync(f.output)).toBe(false);
  const timeout=fixture();await expect(identifyWecomIdentity({...timeout.options,timeoutMs:20})).rejects.toThrow('wecom_identify_timeout');expect(timeout.transport.stop).toHaveBeenCalled();expect(existsSync(timeout.output)).toBe(false);
 });
 it('认证阶段取消时保留取消原因并退出',async()=>{
  const f=fixture(),abort=new AbortController();let fail!:(error:Error)=>void;
  f.transport.start=vi.fn(()=>new Promise<void>((_done,reject)=>{fail=reject}));f.transport.stop=vi.fn(async()=>{fail?.(new Error('generic transport stopped'))});
  const running=identifyWecomIdentity({...f.options,signal:abort.signal});const runningSettled=settled(running);
  await vi.waitFor(()=>expect(f.transport.start).toHaveBeenCalled());abort.abort();await runningSettled;await expect(running).rejects.toThrow('wecom_identify_cancelled');expect(existsSync(f.output)).toBe(false);
 });
 it('已有结果或symlink在连接前拒绝，不覆写任何文件',async()=>{
  const f=fixture();writeFileSync(f.output,'original');await expect(identifyWecomIdentity(f.options)).rejects.toThrow('output_exists');expect(f.factory).not.toHaveBeenCalled();expect(readFileSync(f.output,'utf8')).toBe('original');
  const linked=fixture();symlinkSync(linked.file,linked.output);await expect(identifyWecomIdentity(linked.options)).rejects.toThrow('output_exists');expect(linked.factory).not.toHaveBeenCalled();
 });
});
