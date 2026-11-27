import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WecomBridge} from '../src/im/wecom/gateway/bridge.js';
import {WecomDashboardSessions,wecomCoreIdentity} from '../src/dashboard/wecom/sessions.js';
import {registerWecomConfig,wecomConfigId} from '../src/im/wecom/config/discovery.js';
import {wecomBotRoot} from '../src/im/wecom/config/runtime.js';
import {startWecomGatewayControl} from '../src/im/wecom/gateway/gateway-control.js';
import {NativeTerminalAccess,type NativeTerminalRequest} from '../src/dashboard/wecom/terminal-access.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'wecom-terminal-cancel-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const file=join(root,'config.json'),stateDir=join(root,'bridge'),coreState=join(root,'core');
 const config={botId:'bot',secretEnv:'FAKE',coreUrl:'http://127.0.0.1:41234',allowedUsers:['alice'],stateDir,managedCore:{cli:'codex',backend:'pty' as const,workingDirectory:root,port:41234,stateDir:coreState,botId:'local_core'}};
 writeFileSync(file,JSON.stringify(config));await registerWecomConfig(file,root);
 const coreIdentity=wecomCoreIdentity(config),instanceId='gateway-instance',births=new Map([[500,'gateway-birth'],[600,'core-birth'],[700,'worker-birth']]);
 const message={messageId:'question',userId:'alice',conversationId:'alice',chatType:'single' as const,text:'question',attachments:[],replyContext:{requestId:'question'}};
 const bridge=new WecomBridge({botId:'bot',connectionId:wecomConfigId(file),stateFile:join(stateDir,'state.json'),coreIdentity,allowedUsers:['alice'],transport:{reply:async()=>{},send:async()=>{}},core:{trigger:async()=>({ok:true,triggerId:'turn',target:{kind:'turn',sessionId:'sid'}}),result:async()=>({ok:true,state:'running'}),interrupt:async()=>{}}});
 await bridge.receive(message);await bridge.tick();
 const gateway=await startWecomGatewayControl({bridge,instanceId,coreIdentity,secret:'isolated-secret',coreAction:async()=>({ok:true})});cleanup.push(()=>gateway.stop());
 mkdirSync(wecomBotRoot('bot',root),{recursive:true});writeFileSync(join(wecomBotRoot('bot',root),'runtime.json'),JSON.stringify({version:1,configId:wecomConfigId(file),instanceId,pid:500,processStart:'gateway-birth',connection:'connected',phase:'running',updatedAt:Date.now(),control:{port:gateway.port,instanceId}}));
 mkdirSync(join(coreState,'dashboard-daemons'),{recursive:true});writeFileSync(join(coreState,'dashboard-daemons','local_core.json'),JSON.stringify({larkAppId:'local_core',ipcPort:41234,pid:600,bootInstanceId:'boot',lastHeartbeat:Date.now()}));
 let held=false,release!:()=>void,reached!:()=>void;const waiting=new Promise<void>(resolve=>{reached=resolve;});
 const service=new WecomDashboardSessions({root,gatewaySecret:'isolated-secret',runtime:{readIdentity:pid=>births.get(pid),readCommandLine:()=>undefined,readPidNamespace:()=>undefined,pidExists:pid=>births.has(pid)},readParentPid:pid=>pid===600?500:undefined,fetchCore:async(_port,path)=>{
  if(path==='/api/sessions/sid'){if(held){reached();await new Promise<void>(resolve=>{release=resolve;});}return Response.json({session:{sessionId:'sid',larkAppId:'local_core',status:'active',workerPid:700,workerGeneration:1,proxyPort:41235}});}
  return Response.json({coreOnly:true,coreBotId:'local_core',bootInstanceId:'boot',pid:600,processStart:'core-birth',...(path.includes('?')?{terminal:{sessionId:'sid',workerPid:700,workerProcessStart:'worker-birth',proxyPort:41235}}:{})});
 }});
 const input:NativeTerminalRequest={identity:{provider:'wecom',connectionId:wecomConfigId(file),botId:'bot',userId:'alice'},sessionId:'sid',triggerId:'turn',permission:'read'};
 return {service,input,bridge,message,hold(){held=true;},waiting,release(){held=false;release();}};
}
describe('native terminal authorization interleaved with cancellation',()=>{
 it('rejects an authorization cancelled through the real gateway while worker proof is in flight',async()=>{
  const f=await fixture();f.hold();const target=f.service.nativeTerminal(f.input);await f.waiting;
  await f.bridge.receive({...f.message,messageId:'stop',text:'/stop'});f.release();
  await expect(target).rejects.toThrow('wecom_terminal_forbidden');
 });
 it('invalidates an existing browser when cancellation happens during its live worker lookup',async()=>{
  const f=await fixture(),access=new NativeTerminalAccess({secret:'isolated-secret',resolve:input=>f.service.nativeTerminal(input),origin:()=>'http://127.0.0.1:12345'});
  const link=await access.mint(f.input),result=(await access.exchange(new URL(link.url).searchParams.get('code')!))!;
  expect(result).toBeDefined();f.hold();const live=access.live(result.browser.id);await f.waiting;
  await f.bridge.receive({...f.message,messageId:'stop',text:'/stop'});f.release();
  expect(await live).toBe(false);
 });
});
