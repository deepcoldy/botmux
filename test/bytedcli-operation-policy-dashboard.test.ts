import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TriggerUserAuthSection } from '../src/dashboard/web/bot-defaults-page.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';
import { BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION } from '../src/core/bytedcli-operation-catalog.js';
import { BYTEDCLI_OPERATION_POLICY_SCHEMA, parseBytedcliOperationPolicy, projectBytedcliOperationPolicyStatus } from '../src/core/bytedcli-operation-policy-config.js';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';
import { bytedcliTrustedHostLayout } from '../src/core/bytedcli-host-layout.js';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const config = (rules: Record<string, string>) => ({ schema: BYTEDCLI_OPERATION_POLICY_SCHEMA, cliVersion: BYTEDCLI_AUDITED_RELEASE, catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, rules });
const full = parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud','lark-user','meego'], bytecloudExecution: 'read-machine-write-actor',
  credentialSource: { default:'auto', bytecloud:'local' }, delegateOnMention:false, allowOwnerActor:true, gitCommitIdentity:true,
  dispatchOnly:{tools:['bytedcli'],targetAppIds:['cli_target'],chatIds:['oc_target']}, bytedcliOperationPolicy:config({'codebase.mr.list':'machine','codebase.mr.close':'deny'}) })!;
function summary(bot=full, rules:Record<string,string>={'codebase.mr.list':'actor','codebase.repo.list':'deny'}) {
  const global = parseBytedcliOperationPolicy(config(rules))!;
  return projectBytedcliOperationPolicyStatus({ revision:'fake-revision', policy:global }, bot.bytedcliOperationPolicy, bot.enabled);
}
afterEach(()=>{vi.unstubAllGlobals();});
async function panel(initial:any, status:any) {
  const requests:any[]=[];
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{if(init?.method==='PUT'){const raw=JSON.parse(init.body).triggerUserAuth;requests.push(raw);parseTriggerUserAuthConfig(raw);}return {ok:true,json:async()=>({ok:true,bytedcliOperationPolicy:status})};});
  function Harness(){const [bot,setBot]=React.useState<any>({larkAppId:'cli_dashboard_policy',triggerUserAuth:initial});return React.createElement(TriggerUserAuthSection,{bot,patchBot:(_id,patch)=>setBot((old:any)=>({...old,...patch}))});}
  let renderer!:TestRenderer.ReactTestRenderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(Harness));});
  const control=(action:string)=>renderer.root.findByProps({'data-action':action});
  return {requests,renderer,control,close:async()=>{await act(async()=>renderer.unmount());}};
}
it('command controls expose true effect and the global floor; writes expose explicit machine exceptions',async()=>{
 const p=await panel(full,summary());try{
  const read=p.control('bytedcli-policy-codebase.mr.list');expect(read.props.value).toBe('machine');
  expect(p.control('bytedcli-effective-codebase.mr.list').props['data-identity']).toBe('actor');
  expect(p.control('bytedcli-effective-codebase.repo.list').props['data-enabled']).toBe(false);
  const write=p.control('bytedcli-policy-codebase.mr.close');expect(write.findAllByType('option').map(o=>o.props.value)).toEqual(['','machine','actor','deny']);
  expect(p.control('bytedcli-effect-codebase.mr.close').props['data-effect']).toBe('write');
  await act(async()=>write.props.onChange({currentTarget:{value:'machine'}}));
  expect(p.requests.at(-1).bytedcliOperationPolicy).toEqual(config({'codebase.mr.list':'machine','codebase.mr.close':'machine'}));
  expect(p.control('bytedcli-effective-codebase.mr.close').props['data-identity']).toBe('machine');
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-machine-exception-codebase.mr.close'})).toHaveLength(1);
  await act(async()=>read.props.onChange({currentTarget:{value:'actor'}}));
  expect(p.requests.at(-1)).toMatchObject({...full,bytedcliOperationPolicy:config({'codebase.mr.list':'actor','codebase.mr.close':'machine'})});
  await act(async()=>p.control('bytedcli-policy-codebase.mr.close').props.onChange({currentTarget:{value:''}}));
  expect(p.requests.at(-1).bytedcliOperationPolicy.rules).toEqual({'codebase.mr.list':'actor'});
  await act(async()=>p.control('trigger-user-auth-source-default').props.onChange({currentTarget:{value:'platform'}}));
  expect(p.requests.at(-1).bytedcliOperationPolicy.rules).toEqual({'codebase.mr.list':'actor'});
  await act(async()=>p.control('bytedcli-policy-clear').props.onClick());expect(p.requests.at(-1).bytedcliOperationPolicy).toBeNull();
 }finally{await p.close();}
});
it('dormant command rules remain editable and disabling preserves every hidden option',async()=>{
 const p=await panel({...full,enabled:false},summary({...full,enabled:false}));try{
  await act(async()=>p.control('bytedcli-policy-codebase.mr.list').props.onChange({currentTarget:{value:'deny'}}));
  expect(p.requests.at(-1)).toMatchObject({...full,enabled:false,bytedcliOperationPolicy:config({'codebase.mr.list':'deny','codebase.mr.close':'deny'})});
  await act(async()=>p.control('toggle-trigger-user-auth').props.onChange({currentTarget:{checked:true}}));
  await act(async()=>p.control('toggle-trigger-user-auth').props.onChange({currentTarget:{checked:false}}));
  expect(p.requests.at(-1)).toMatchObject({enabled:false,dispatchOnly:full.dispatchOnly,allowOwnerActor:true,bytedcliOperationPolicy:config({'codebase.mr.list':'deny','codebase.mr.close':'deny'})});
 }finally{await p.close();}
});
it('unselected ByteCloud keeps command preview inactive and selecting it loads the host floor',async()=>{
 const p=await panel({...full,capabilities:['lark-user']},summary());try{
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe('inactive');
  expect(p.control('bytedcli-policy-codebase.mr.list').props.disabled).toBe(true);
  await act(async()=>p.control('trigger-user-auth-capability-bytecloud').props.onChange({currentTarget:{checked:true}}));
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe('ready');
  expect(p.control('bytedcli-effective-codebase.mr.list').props['data-identity']).toBe('actor');
 }finally{await p.close();}
});
it.each([{label:'old daemon',status:undefined},{label:'v1 daemon',status:{...summary(),schema:'botmux.bytedcli-operation-policy-status.v1'}},{label:'unknown catalog',status:{...summary(),catalogVersion:'old'}},{label:'invalid global',status:{...summary(),global:{state:'invalid',revision:'invalid',errorCode:'operation_policy_invalid'}}}])('unavailable or invalid host state blocks rule saves but permits emergency disable ($label)',async ({status})=>{
 const p=await panel(full,status);try{
  const select=p.control('bytedcli-policy-codebase.mr.list');expect(select.props.disabled).toBe(true);
  await act(async()=>select.props.onChange({currentTarget:{value:'deny'}}));expect(p.requests).toEqual([]);
  await act(async()=>p.control('bytedcli-policy-clear').props.onClick());expect(p.requests).toEqual([]);
  await act(async()=>p.control('toggle-trigger-user-auth').props.onChange({currentTarget:{checked:false}}));expect(p.requests.at(-1).enabled).toBe(false);
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe(status?.global?.state==='invalid'?'invalid':'unavailable');
 }finally{await p.close();}
});
let ipc:IpcServerHandle, root:string, botsFile:string, policyFile:string;
const previousBotsConfig=process.env.BOTS_CONFIG;
beforeAll(async()=>{
 root=mkdtempSync(join(tmpdir(),'dashboard-policy-'));botsFile=join(root,'bots.json');process.env.BOTS_CONFIG=botsFile;
 writeFileSync(botsFile,JSON.stringify([{larkAppId:'cli_dashboard_policy',larkAppSecret:'fake',cliId:'codex',triggerUserAuth:full}]));
 __testOnly_resetBotRegistry();loadBotConfigs().forEach(registerBot);setLarkAppId('cli_dashboard_policy');
 const base=bytedcliTrustedHostLayout();const privateRoot=join(root,'trusted-private');
 ipc=await startIpcServer({port:0,host:'127.0.0.1',bytedcliHostLayout:Object.freeze({...base,privateRoot,auditRoot:join(privateRoot,'audit')})});
 policyFile=join(privateRoot,'policy','operation-policy.json');
});
afterAll(async()=>{await ipc?.close();setLarkAppId('');__testOnly_resetBotRegistry();rmSync(root,{recursive:true,force:true});if(previousBotsConfig===undefined)delete process.env.BOTS_CONFIG;else process.env.BOTS_CONFIG=previousBotsConfig;});
const get=async()=>await (await fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth-status`)).json();
const put=async(value:any)=>fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth`,{method:'PUT',body:JSON.stringify({triggerUserAuth:value})});
it('status getters leave actor-all and unselected ByteCloud inert while dormant strict preview reads the fixed root',async()=>{
 const privateRoot=join(root,'getter-private'),reader=createBytedcliHostOperationPolicyReader(privateRoot);let reads=0;
 const broker=new BytedcliBroker({operationPolicy:()=>{reads++;return reader();},authority:async()=>{throw new Error('no authority from status');},
  executor:{execute:async()=>{throw new Error('no execution from status');},retireSession:async()=>{},close:async()=>{}}});
 try{
  expect(broker.operationPolicyStatus({...full,bytecloudExecution:'trigger-user'})).toBeUndefined();
  expect(broker.operationPolicyStatus({...full,capabilities:['lark-user']})).toBeUndefined();
  expect(broker.operationPolicyStatus()).toBeUndefined();expect(reads).toBe(0);expect(existsSync(privateRoot)).toBe(false);
  expect(broker.operationPolicyStatus({...full,enabled:false})).toMatchObject({active:false,global:{state:'default'}});
  expect(reads).toBe(1);expect(existsSync(join(privateRoot,'policy'))).toBe(true);
 }finally{await broker.close();}
});
it('legacy HTTP status does not initialize host policy files; selected dormant strict mode offers inactive preview',async()=>{
 const cfg=getBot('cli_dashboard_policy').config,original=cfg.triggerUserAuth;
 try{
  cfg.triggerUserAuth={...full,bytecloudExecution:'trigger-user'};
  expect((await get()).bytedcliOperationPolicy).toBeUndefined();expect(existsSync(join(root,'trusted-private'))).toBe(false);
  cfg.triggerUserAuth={...full,capabilities:['lark-user']};
  expect((await get()).bytedcliOperationPolicy).toBeUndefined();expect(existsSync(join(root,'trusted-private'))).toBe(false);
  cfg.triggerUserAuth={...full,enabled:false};
  expect((await get()).bytedcliOperationPolicy).toMatchObject({active:false,global:{state:'default'}});
 }finally{cfg.triggerUserAuth=original;}
});
it('status shares the trusted runtime root, projects restrictions and sanitizes invalid host configuration',async()=>{
 const first=(await get()).bytedcliOperationPolicy;expect(first).toMatchObject({schema:'botmux.bytedcli-operation-policy-status.v2',global:{state:'default'},botRules:{'codebase.mr.close':'deny'}});
 writeFileSync(policyFile,JSON.stringify(config({'codebase.mr.list':'actor','codebase.repo.list':'deny'})),{mode:0o600});
 const second=(await get()).bytedcliOperationPolicy;expect(second.global.revision).not.toBe(first.global.revision);
 expect(second.effectiveEntries.find((r:any)=>r.operationId==='codebase.mr.list')).toMatchObject({effect:'read',enabled:true,identity:'actor'});
 expect(second.effectiveEntries.find((r:any)=>r.operationId==='codebase.repo.list')).toMatchObject({enabled:false});
 writeFileSync(policyFile,JSON.stringify({error:root,token:'private-error-token'}));
 const invalid=(await get()).bytedcliOperationPolicy;expect(invalid.global).toMatchObject({state:'invalid',errorCode:'operation_policy_invalid'});expect(invalid.effectiveEntries).toEqual([]);
 const serialized=JSON.stringify(invalid);expect(serialized).not.toContain(root);expect(serialized).not.toContain('private-error-token');
 expect((await put({enabled:false})).status).toBe(200);
 const next=policyFile+'.next';writeFileSync(next,JSON.stringify(config({})),{mode:0o600});renameSync(next,policyFile);expect((await get()).bytedcliOperationPolicy).toMatchObject({active:false,global:{state:'valid'}});
});
it('actual old-client updates retain rules; explicit null clears, and invalid policy updates are atomic',async()=>{
 const stored=()=>JSON.parse(readFileSync(botsFile,'utf8'))[0].triggerUserAuth;
 expect((await put({enabled:false,bytedcliOperationPolicy:full.bytedcliOperationPolicy})).status).toBe(200);
 expect((await put({gitCommitIdentity:false})).status).toBe(200);expect(stored().bytedcliOperationPolicy).toEqual(full.bytedcliOperationPolicy);
 for(const bad of [config({'unknown.read':'actor'}),{...config({}),catalogVersion:'bad'},{...config({'codebase.mr.close':'machine'}),schema:'botmux.bytedcli-operation-policy.v1'}]){
  const before=readFileSync(botsFile,'utf8');expect((await put({bytedcliOperationPolicy:bad})).status).toBe(400);expect(readFileSync(botsFile,'utf8')).toBe(before);
 }
 expect((await put({bytedcliOperationPolicy:null})).status).toBe(200);expect(stored()).not.toHaveProperty('bytedcliOperationPolicy');expect(stored()).toMatchObject({enabled:false,allowOwnerActor:true,dispatchOnly:full.dispatchOnly});
});

it('writes saved by the real HTTP route keep machine effect and migrate valid legacy rules atomically',async()=>{
 expect((await put({bytedcliOperationPolicy:config({'codebase.mr.close':'machine'})})).status).toBe(200);
 const machine=(await get()).bytedcliOperationPolicy;
 expect(machine.effectiveEntries.find((row:any)=>row.operationId==='codebase.mr.close')).toMatchObject({effect:'write',identity:'machine',enabled:true});
 const legacy={...config({'codebase.mr.close':'actor','codebase.mr.list':'machine'}),schema:'botmux.bytedcli-operation-policy.v1',catalogVersion:'2026-11-26.1'};
 expect((await put({bytedcliOperationPolicy:legacy})).status).toBe(200);
 expect(JSON.parse(readFileSync(botsFile,'utf8'))[0].triggerUserAuth.bytedcliOperationPolicy).toEqual(config(legacy.rules));
});
it('global actor floors remain visible when a write row saves machine',async()=>{
 const p=await panel(full,summary(full,{'codebase.mr.close':'actor'}));try{
  await act(async()=>p.control('bytedcli-policy-codebase.mr.close').props.onChange({currentTarget:{value:'machine'}}));
  expect(p.requests.at(-1).bytedcliOperationPolicy.rules['codebase.mr.close']).toBe('machine');
  expect(p.control('bytedcli-effective-codebase.mr.close').props['data-identity']).toBe('actor');
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-machine-exception-codebase.mr.close'})).toHaveLength(0);
 }finally{await p.close();}
});
it('applies selected MIX machine preset, preserves full settings and global floors', async()=>{
 const p=await panel(full,summary(full,{'skill-api.bits.release.owner.update':'actor','tos.upload-object.c4-report':'deny','codebase.mr.create':'machine'}));
 try {
  const button=p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-mix-preset'});
  expect(button).toHaveLength(1);
  await act(async()=>button[0]!.props.onClick());
  const saved=p.requests.at(-1);expect(saved).toMatchObject({credentialSource:full.credentialSource,dispatchOnly:full.dispatchOnly});
  expect(saved.bytedcliOperationPolicy.rules['skill-api.bits.release.owner.update']).toBe('machine');
  expect(saved.bytedcliOperationPolicy.rules['codebase.mr.create']).toBe('actor');
  expect(saved.bytedcliOperationPolicy.rules['bits.pipelines.run']).toBe('actor');
  expect(saved.bytedcliOperationPolicy.rules['skill-api.argos.duties.get']).toBe('actor');
  expect(p.control('bytedcli-effective-skill-api.bits.release.owner.update').props['data-identity']).toBe('actor');
  expect(p.control('bytedcli-effective-tos.upload-object.c4-report').props['data-enabled']).toBe(false);
  expect(p.control('bytedcli-effective-codebase.mr.create').props['data-identity']).toBe('actor');
 }finally{await p.close();}
});
