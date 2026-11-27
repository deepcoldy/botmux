import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomDashboardManager } from '../src/dashboard/wecom/manager.js';
import { registerWecomConfig, wecomConfigId, wecomRoot } from '../src/im/wecom/config/discovery.js';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import type WebSocket from 'ws';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
import { resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { ControlCsrfTokens } from '../src/dashboard/control-csrf.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { createWecomRuntimePublisher, wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { fleetProcessIdentityRuntime, type FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.useRealTimers()});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'wecom-dashboard-manager-'));roots.push(root);const file=join(root,'config.json');
 const config={botId:'same-bot',secretFile:join(root,'credential-secret-path'),coreUrl:'http://127.0.0.1:19123',allowedUsers:['private-user-marker']};writeFileSync(file,JSON.stringify(config));
 const identities=new Map<number,string>();
 const runtime:FleetProcessIdentityRuntime={readIdentity:pid=>identities.get(pid),readCommandLine:()=>undefined,readPidNamespace:()=>undefined,pidExists:pid=>identities.has(pid)};
 // The Dashboard acts only through `botmux wecom <action> --json`; this stands in for that command.
 const runLifecycle=vi.fn(async()=>({ok:true,state:'started',message:''}));
 const fleetStatePath=join(root,'fleet-state.json');
 const manager=()=>new WecomDashboardManager({root,runtime,runLifecycle,readFleetState:()=>readFleetState(fleetStatePath),now:()=>1000});
 return {root,file,config,identities,runLifecycle,fleetStatePath,manager,id:wecomConfigId(file)};
}
describe('WeCom Dashboard connection manager lifecycle',()=>{
 it('projects safe DTOs without user lists, credential paths, process ids, or full bot id',async()=>{
  const f=await fixture();const serialized=JSON.stringify(await f.manager().list());for(const forbidden of ['private-user-marker','credential-secret-path','same-bot','secretFile','secretEnv','processStart'])expect(serialized).not.toContain(forbidden);
 });
 it('blocks ownership takeover when a manual instance holds the existing single-active lock',async()=>{
  const f=await fixture();f.identities.set(200,'manual-birth');const bot=wecomBotRoot(f.config.botId,f.root);mkdirSync(bot,{recursive:true});writeFileSync(join(bot,'instance.lock'),JSON.stringify({pid:200,procStart:'manual-birth'}));
  const manager=f.manager();expect((await manager.list())[0]).toMatchObject({ownership:'external',connection:'unknown',canStart:false,canStop:false,canRestart:false});await expect(manager.start(f.id)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');await expect(manager.stop(f.id)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');await expect(manager.restart(f.id)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');expect(f.runLifecycle).not.toHaveBeenCalled();
 });
 it('keeps default discovery readable and never overwrites a corrupt auxiliary index',async()=>{
  const f=await fixture(),index=join(f.root,'config-registry.json');writeFileSync(index,'{broken');
  expect(await f.manager().list()).toHaveLength(1);await expect(registerWecomConfig(join(f.root,'custom.json'),f.root)).rejects.toThrow('wecom_registry_invalid');expect(readFileSync(index,'utf8')).toBe('{broken');
 });
 it('enforces management GET and CSRF POST at the new API handler with existing identity gates',async()=>{
  const f=await fixture(),manager=f.manager();const list=vi.spyOn(manager,'list');
  const path='/api/wecom/connections';
  const anonymous=resolveDashboardRequestGate({method:'GET',pathname:path,hasTokenParam:false,identity:null,tokenFromRequest:undefined,activeToken:'active',publicReadOnly:true});expect(anonymous.decision.kind).toBe('deny401');
  const workbench=resolveDashboardRequestGate({method:'GET',pathname:path,hasTokenParam:false,identity:{kind:'feishu-h5',canManageHost:false} as any,tokenFromRequest:undefined,activeToken:'active',publicReadOnly:true});expect(workbench.decision.kind).toBe('deny401');
  const invoke=async(method:string,url:string,hostAdmin:boolean,csrfValid:boolean)=>{let status=0,body='';const res={writeHead:(value:number)=>{status=value},end:(value:string)=>{body=value}} as unknown as ServerResponse;await handleWecomConnectionsApi({method,headers:{}} as IncomingMessage,res,new URL(url,'http://127.0.0.1'),{hostAdmin,csrfValid,manager});return {status,body}};
  expect((await invoke('GET',path,false,false)).status).toBe(403);expect(list).not.toHaveBeenCalled();
  const denied=await invoke('POST',`${path}/${f.id}/start`,true,false);expect(denied.status).toBe(403);expect(f.runLifecycle).not.toHaveBeenCalled();
  const csrf=new ControlCsrfTokens(),ticket=csrf.mint('owner-session');expect(csrf.verify(ticket,'other-session')).toBe(false);
  const allowed=await invoke('POST',`${path}/${f.id}/start`,true,csrf.verify(ticket,'owner-session'));expect(allowed.status).toBe(202);expect(f.runLifecycle).toHaveBeenCalledExactlyOnceWith('start',f.id);
  const get=await invoke('GET',path,true,false);expect(get.status).toBe(200);expect(get.body).not.toContain('private-user-marker');expect(get.body).not.toContain('credential-secret-path');
 });
 it('does not let runtime publication disk errors break the real WebSocket authentication callback',async()=>{
  const f=await fixture(),botId=`acceptance-disk-${Date.now()}`,root=wecomBotRoot(botId);roots.push(root);const identity=vi.spyOn(fleetProcessIdentityRuntime,'readIdentity').mockReturnValue('self-birth');const publisher=createWecomRuntimePublisher(botId,f.file);rmSync(join(root,'runtime.json'));mkdirSync(join(root,'runtime.json'));
  class Socket extends EventEmitter{sent:any[]=[];send(data:string,cb?:()=>void){this.sent.push(JSON.parse(data));cb?.()}terminate(){this.emit('close')}}
  const socket=new Socket(),onError=vi.fn();const transport=new WecomTransport({botId:'fake-bot',secret:'fake-secret',socketFactory:()=>socket as unknown as WebSocket,onConnectionState:connection=>publisher.update({connection}),onError});
  try{const start=transport.start();socket.emit('open');socket.emit('message',Buffer.from(JSON.stringify({headers:socket.sent[0].headers,errcode:0})));await start;expect(onError).toHaveBeenCalled();expect(socket.sent[0].cmd).toBe('aibot_subscribe')}finally{await transport.stop();publisher.stop();identity.mockRestore()}
 });
 it('ignores stale connection proof even when the fleet member is still alive',async()=>{
  const f=await fixture();f.identities.set(300,'gateway-birth');f.identities.set(400,'supervisor-birth');
  const member=wecomFleetMemberName(f.id);
  writeFileSync(f.fleetStatePath,JSON.stringify({supervisorPid:400,supervisorStartedAt:'t',supervisorProcessStart:'supervisor-birth',supervisorCommand:'fixture supervisor',procs:[{name:member,appId:'',pid:300,generation:1,status:'online',restarts:0,lastExitCode:null,startedAt:'t',processStart:'gateway-birth'}]}));
  const bot=wecomBotRoot(f.config.botId,f.root);mkdirSync(bot,{recursive:true});
  writeFileSync(join(bot,'runtime.json'),JSON.stringify({version:1,configId:f.id,pid:300,processStart:'gateway-birth',instanceId:'i',connection:'connected',phase:'running',updatedAt:-10000}));
  expect((await f.manager().list())[0]).toMatchObject({gateway:'running',ownership:'fleet',connection:'unknown'});
 });
});
