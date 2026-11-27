import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WecomDashboardSessions, wecomCoreIdentity } from '../src/dashboard/wecom/sessions.js';
import { registerWecomConfig, wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import {startWecomGatewayControl} from '../src/im/wecom/gateway/gateway-control.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { verifyHmac, cliAuthBind } from '../src/dashboard/auth.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { createControlledWecomCore, privateUnifiedSessionRow, seedControlledBridgeTask } from './helpers/wecom-controlled-core.js';
const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()});
async function fixture(){const root=mkdtempSync(join(tmpdir(),'wecom-unified-source-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const births=new Map<number,string>(),parents=new Map<number,number>();const sources:any[]=[];
 for(let n=0;n<2;n++){
  const corePid=500+n,gatewayPid=700+n,botId=`wecom-${n}`,coreBotId=`local_core_${n}`,boot=`boot-${n}`,coreState=join(root,`core-${n}`),stateDir=join(root,`bridge-${n}`),row=privateUnifiedSessionRow('same-native-sid',coreBotId);
  births.set(corePid,`core-birth-${n}`);births.set(gatewayPid,`gateway-birth-${n}`);parents.set(corePid,gatewayPid);
  const server=await createControlledWecomCore({health:{ok:true},sessions:[row,{...row,sessionId:'unassociated-private-sid'}],reply:call=>call.path==='/api/core/source-identity'?{body:{coreOnly:true,coreBotId,bootInstanceId:boot,pid:corePid,processStart:births.get(corePid)}}:call.path.startsWith('/api/sessions/')?{body:{session:row}}:undefined as any});cleanup.push(()=>server.close());
  const file=join(root,n?'second.json':'config.json'),config={botId,secretEnv:'FAKE',coreUrl:server.url,allowedUsers:['fixture-user'],stateDir,managedCore:{cli:'codex',backend:'pty' as const,workingDirectory:root,port:server.port,stateDir:coreState,botId:coreBotId}};writeFileSync(file,JSON.stringify(config));await registerWecomConfig(file,root);
  const seeded=await seedControlledBridgeTask({botId,connectionId:wecomConfigId(file),stateFile:join(stateDir,'state.json'),coreIdentity:wecomCoreIdentity(config),nativeSessionId:'same-native-sid'});mkdirSync(wecomBotRoot(botId,root),{recursive:true});writeFileSync(join(wecomBotRoot(botId,root),'runtime.json'),JSON.stringify({version:1,configId:wecomConfigId(file),instanceId:`gateway-instance-${n}`,pid:gatewayPid,processStart:births.get(gatewayPid),connection:'connected',phase:'running',updatedAt:Date.now()}));mkdirSync(join(coreState,'dashboard-daemons'),{recursive:true});const descriptor=join(coreState,'dashboard-daemons',`${coreBotId}.json`);writeFileSync(descriptor,JSON.stringify({larkAppId:coreBotId,ipcPort:server.port,pid:corePid,processStartIdentity:births.get(corePid),bootInstanceId:boot,lastHeartbeat:Date.now()}));seedPersistedSessionRows(coreState,coreBotId,{'same-native-sid':row,'unassociated-private-sid':{...row,sessionId:'unassociated-private-sid'}});
  sources.push({server,file,config,descriptor,corePid,gatewayPid,row,stateDir,seeded});
 }
 const service=new WecomDashboardSessions({root,gatewaySecret:'fixture-private-hmac-key',runtime:{readIdentity:pid=>births.get(pid),readCommandLine:()=>undefined,readPidNamespace:()=>undefined,pidExists:pid=>births.has(pid)},readParentPid:pid=>parents.get(pid),fetchCore:(port,path,init)=>fetchDaemonIpc(port,path,init,'fixture-private-hmac-key')});
 return {root,sources,births,parents,service};}
describe('WeCom Dashboard session source isolation',()=>{
 it('revalidates native channel ACL through signed gateway IPC and binds the returned target to the live worker',async()=>{
  const f=await fixture(),source=f.sources[0],coreIdentity=wecomCoreIdentity(source.config),instanceId='native-gateway-instance';
  const gateway=await startWecomGatewayControl({bridge:source.seeded.bridge,instanceId,coreIdentity,secret:'fixture-private-hmac-key',coreAction:async()=>({ok:true})});cleanup.push(()=>gateway.stop());
  const runtimeFile=join(wecomBotRoot(source.config.botId,f.root),'runtime.json'),runtime=JSON.parse(readFileSync(runtimeFile,'utf8'));writeFileSync(runtimeFile,JSON.stringify({...runtime,control:{port:gateway.port,instanceId}}));
  f.births.set(999,'worker-birth');source.server.state.reply=(call:any)=>call.path.startsWith('/api/core/source-identity')?{body:{coreOnly:true,coreBotId:source.config.managedCore.botId,bootInstanceId:'boot-0',pid:source.corePid,processStart:f.births.get(source.corePid),...(call.path.includes('?')?{terminal:{sessionId:'same-native-sid',workerPid:999,workerProcessStart:'worker-birth',proxyPort:source.server.port}}:{})}}:{body:{session:{...source.row,workerPid:999,workerGeneration:7,proxyPort:source.server.port}}};
  const input={identity:{provider:'wecom' as const,connectionId:wecomConfigId(source.file),botId:source.config.botId,userId:'fixture-user'},sessionId:'same-native-sid',triggerId:'fixture-turn',permission:'read' as const};
  const target=await f.service.nativeTerminal(input);expect(target.nativeSessionId).toBe(input.sessionId);expect(target.proxyPort).toBe(source.server.port);expect(target.epoch).toBeTruthy();
  await expect(f.service.nativeTerminal({...input,triggerId:'stale'})).rejects.toThrow('wecom_terminal_forbidden');
  await expect(f.service.nativeTerminal({...input,identity:{...input.identity,userId:'foreign'}})).rejects.toThrow('wecom_terminal_forbidden');
  await expect(f.service.nativeTerminal({...input,identity:{...input.identity,botId:f.sources[1].config.botId}})).rejects.toThrow('wecom_terminal_identity_mismatch');
  await expect(f.service.nativeTerminal({...input,permission:'write'})).rejects.toThrow('wecom_terminal_forbidden');
  f.births.set(999,'replaced-worker');await expect(f.service.nativeTerminal(input)).rejects.toThrow('wecom_terminal_unavailable');
 });

 it('keeps duplicate native session ids isolated and excludes unrelated core sessions',async()=>{
  const f=await fixture(),rows=await f.service.list();expect(rows).toHaveLength(2);expect(rows[0].sessionId).not.toBe(rows[1].sessionId);expect(rows.every(row=>row.provider==='wecom')).toBe(true);
  const first=await f.service.request(rows.find(row=>row.providerBotId===wecomConfigId(f.sources[0].file))!.sessionId,'detail');expect(first.status).toBe(200);expect(f.sources[0].server.calls.some((call:any)=>call.path==='/api/sessions/same-native-sid')).toBe(true);expect(f.sources[1].server.calls.some((call:any)=>call.path==='/api/sessions/same-native-sid')).toBe(false);
 });
 it('requires real port-and-route-bound host HMAC on the private source proof',async()=>{
  const f=await fixture();for(const source of f.sources){const original=source.server.state.reply;source.server.state.reply=async(call:any)=>{const h=call.headers,ok=verifyHmac('fixture-private-hmac-key',{ts:h['x-botmux-cli-ts']??'',nonce:h['x-botmux-cli-nonce']??'',sig:h['x-botmux-cli-auth']??''},'127.0.0.1',cliAuthBind(call.method,new URL(call.path,'http://localhost').pathname,source.server.port)).ok;if(!ok)return {status:401,body:{error:'unauthorized'}};return await original?.(call) as any}}
  expect((await fetch(f.sources[0].server.url+'/api/core/source-identity')).status).toBe(401);expect(await f.service.list()).toHaveLength(2);
 });
 it('fails closed for an old source id after state-directory configuration changes',async()=>{
  const f=await fixture(),rows=await f.service.list(),source=f.sources[0],id=rows.find(row=>row.providerBotId===wecomConfigId(source.file))!.sessionId;writeFileSync(source.file,JSON.stringify({...source.config,managedCore:{...source.config.managedCore,stateDir:join(f.root,'new-core')}}));
  expect((await f.service.request(id,'detail')).status).toBe(404);expect(source.server.calls.some((call:any)=>call.path==='/api/sessions/same-native-sid')).toBe(false);
 });
 it('rejects a post-fetch birth change instead of publishing data from the reused core process',async()=>{
  const f=await fixture(),source=f.sources[0];let changed=false;source.server.state.reply=(call:any)=>{if(call.path==='/api/core/source-identity')return {body:{coreOnly:true,coreBotId:source.config.managedCore.botId,bootInstanceId:'boot-0',pid:source.corePid,processStart:changed?'reused-birth':f.births.get(source.corePid)}};if(call.path==='/api/sessions'){changed=true;f.births.set(source.corePid,'reused-birth');return {body:{sessions:[{...source.row,title:'wrong-process-secret'}]}}}return {status:404,body:{}}};
  const rows=await f.service.list();expect(rows.find(row=>row.providerBotId===wecomConfigId(source.file))?.offline).toBe(true);expect(JSON.stringify(rows)).not.toContain('wrong-process-secret');
 });
 it('returns only bridge-associated offline SQLite rows and never routes unsupported operations to Lark',async()=>{
  const f=await fixture();f.parents.clear();const rows=await f.service.list();expect(rows).toHaveLength(2);expect(rows.every(row=>row.offline)).toBe(true);const before=f.sources.flatMap(source=>source.server.calls).length;expect((await f.service.request(rows[0].sessionId,'larkNative')).status).toBe(409);expect(f.sources.flatMap(source=>source.server.calls)).toHaveLength(before);
 });
 it('binds a terminal to a live worker proof and rejects a changed worker generation',async()=>{
  const f=await fixture(),rows=await f.service.list(),source=f.sources[0],id=rows.find(row=>row.providerBotId===wecomConfigId(source.file))!.sessionId;f.births.set(999,'worker-birth');f.parents.set(999,source.corePid);let mismatch=false;
  source.server.state.reply=(call:any)=>call.path.startsWith('/api/core/source-identity')?{body:{coreOnly:true,coreBotId:source.config.managedCore.botId,bootInstanceId:'boot-0',pid:source.corePid,processStart:f.births.get(source.corePid),...(call.path.includes('?')?{terminal:{sessionId:'same-native-sid',workerPid:999,workerProcessStart:mismatch?'wrong-worker-birth':'worker-birth',proxyPort:source.server.port}}:{})}}:{body:{session:{...source.row,workerPid:999,workerGeneration:7,proxyPort:source.server.port}}};
  expect((await f.service.terminal(id)).proxyPort).toBe(source.server.port);mismatch=true;await expect(f.service.terminal(id)).rejects.toThrow('wecom_terminal_unavailable');
 });
 it('does not mint a terminal target for a closed row with an unrelated recycled worker PID',async()=>{
  const f=await fixture(),rows=await f.service.list(),source=f.sources[0],id=rows.find(row=>row.providerBotId===wecomConfigId(source.file))!.sessionId;f.births.set(999,'unrelated-process-birth');
  source.server.state.reply=(call:any)=>call.path==='/api/core/source-identity'?{body:{coreOnly:true,coreBotId:source.config.managedCore.botId,bootInstanceId:'boot-0',pid:source.corePid,processStart:f.births.get(source.corePid)}}:{body:{session:{...source.row,status:'closed',workerPid:999,workerGeneration:7,proxyPort:f.sources[1].server.port}}};
  await expect(f.service.terminal(id)).rejects.toThrow('wecom_terminal_unavailable');
 });
 it('does not serve detail from a mismatched raw session response',async()=>{
  const f=await fixture(),rows=await f.service.list(),source=f.sources[0],id=rows.find(row=>row.providerBotId===wecomConfigId(source.file))!.sessionId;source.server.state.reply=(call:any)=>call.path==='/api/core/source-identity'?{body:{coreOnly:true,coreBotId:source.config.managedCore.botId,bootInstanceId:'boot-0',pid:source.corePid,processStart:f.births.get(source.corePid)}}:{body:{session:{...source.row,sessionId:'foreign-sid',title:'foreign-private-title'}}};
  const response=await f.service.request(id,'detail');expect(JSON.stringify(await response.json())).not.toContain('foreign-private-title');
 });
});
