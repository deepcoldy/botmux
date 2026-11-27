import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'wecom-command-trigger-'));roots.push(root);const file=join(root,'config.json');
 writeFileSync(file,JSON.stringify({botId:'native-bot',secretEnv:'FAKE_SECRET',allowedUsers:['alice'],coreUrl:'http://127.0.0.1:19443',managedCore:{botId:'local_commands',cli:'codex',backend:'pty',workingDirectory:root,stateDir:join(root,'core'),port:19443,botConfig:{senderTag:false}}}));
 const service=new WecomDashboardConfig(root),id=wecomConfigId(file),read=()=>parseWecomConfig(JSON.parse(readFileSync(file,'utf8')));
 const trigger=vi.fn(async(_req:TriggerRequest)=>({ok:true,triggerId:'turn',target:{kind:'turn' as const,sessionId:'session'}}));
 const bridge=new WecomBridge({botId:'native-bot',allowedUsers:['alice'],stateFile:join(root,'bridge.json'),policy:()=>({...read(),senderTag:false}),transport:{reply:async()=>{},send:async()=>{}},core:{trigger,result:async()=>({ok:true,state:'completed',output:{content:'done'}}),interrupt:async()=>{}}});
 const receive=(messageId:string,text:string,conversationId='native-group',userId='alice')=>bridge.receive({messageId,text,conversationId,userId,chatType:'group',replyContext:{requestId:messageId},attachments:[]});
 const patch=(change:Record<string,unknown>)=>service.patch(id,{revision:service.get(id).revision,...change});
 return {service,id,read,trigger,bridge,receive,patch};
}
describe('WeCom native command trigger configuration',()=>{
 it('renders templates with native chat scope and freezes each admitted request across later edits',async()=>{
  const f=fixture();await f.patch({commandTriggers:{enabled:true,commands:[{cmd:'/Solve',prompt:'Solve this: {args}'}],chats:['native-group']}});
  await f.receive('first','/SOLVE preserve CASE');
  await f.patch({commandTriggers:{enabled:false,commands:[{cmd:'/solve',prompt:'changed'}]}});
  await f.bridge.tick();expect(f.trigger.mock.calls[0][0].envelope.rawText).toBe('Solve this: preserve CASE');
  await f.receive('disabled','/solve ignored');await f.bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);
  await f.patch({commandTriggers:{enabled:true,commands:[{cmd:'/solve',prompt:'New template'}],chats:['native-group'],excludedChats:['native-group']}});
  await f.receive('excluded','/solve ignored');await f.bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);
  await f.patch({commandTriggers:{enabled:true,commands:[{cmd:'/solve',prompt:'New template'}],chats:['native-group']}});
  await f.receive('outsider','/solve no','native-group','mallory');await f.receive('other-group','/solve no','other');await f.bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);
  await f.receive('second','/solve additional input');await f.bridge.tick();expect(f.trigger.mock.calls[1][0].envelope.rawText).toBe('New template\n\nadditional input');
  expect(f.trigger.mock.calls[1][0].target.sessionId).toBe('session');
 });
 it('rejects daemon, native passthrough, malformed and oversized commands at the same write boundary',async()=>{
  const f=fixture();await f.patch({botConfig:{customPassthroughCommands:['/native-command']}});
  for(const cmd of ['/stop','/model','/native-command','/bad command'])await expect(f.patch({commandTriggers:{enabled:true,commands:[{cmd,prompt:'request'}]}})).rejects.toThrow('wecom_invalid_configuration');
  await expect(f.patch({commandTriggers:{enabled:true,commands:[{cmd:'/solve',prompt:'x'.repeat(9000)}]}})).rejects.toThrow('wecom_invalid_configuration');
  expect(f.read().commandTriggers).toBeUndefined();
  expect(f.service.commandTriggers(f.id,['/solve','/stop','/native-command'])).toMatchObject({results:[{cmd:'/solve',kind:null},{cmd:'/stop',kind:'daemon'},{cmd:'/native-command',kind:'passthrough'}]});
 });
});
