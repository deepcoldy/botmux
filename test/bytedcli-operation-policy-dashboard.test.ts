import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TriggerUserAuthSection } from '../src/dashboard/web/bot-defaults-page.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';
import { capabilitiesOf, larkUserNative, parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';
import { BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION, BYTEDCLI_OPERATION_CATALOG } from '../src/core/bytedcli-operation-catalog.js';
import { BYTEDCLI_OPERATION_POLICY_SCHEMA, parseBytedcliOperationPolicy, projectBytedcliOperationPolicyStatus } from '../src/core/bytedcli-operation-policy-config.js';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';
import { bytedcliTrustedHostLayout } from '../src/core/bytedcli-host-layout.js';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { readPluginRegistry, removeInstalledPlugin, upsertInstalledPlugin } from '../src/services/plugin-registry-store.js';
import { parsePluginBytedcliOperationPresets, readPluginBytedcliOperationPresets } from '../src/core/plugins/bytedcli-operation-presets.js';
import { globalConfigPath, invalidateGlobalConfigCache, readGlobalConfig } from '../src/global-config.js';
import { pluginRegistryPath } from '../src/core/plugins/paths.js';
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
async function panel(initial:any, status:any, presets:any={presets:[],issues:[]}, failure=false, commitGate?:Promise<void>) {
  let server=initial;
  const requests:any[]=[], reads:string[]=[];
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{
    if(init?.method==='PUT'){
      const body=JSON.parse(init.body),raw=body.triggerUserAuth;requests.push(raw??body);
      if(raw)parseTriggerUserAuthConfig(raw);
      if(raw && failure)return {ok:false,json:async()=>({ok:false,error:"save_failed"})};
      if(raw){await commitGate;server=raw;}
      if(body.bytedcliOperationPreset){
        if(failure)return {ok:false,json:async()=>({ok:false,error:'bytedcli_operation_preset_changed'})};
        const selected=presets.presets.find((row:any)=>row.pluginId===body.bytedcliOperationPreset.pluginId&&row.id===body.bytedcliOperationPreset.presetId);
        return {ok:true,json:async()=>({ok:true,triggerUserAuth:{...initial,bytedcliOperationPolicy:selected.policy}})};
      }
    }
    if(init?.method!=='PUT')reads.push(String(_url));
    return {ok:true,json:async()=>({ok:true,bytedcliOperationPolicy:typeof status==='function'?status(server):status,bytedcliOperationPresets:presets})};
  });
  function Harness(){const [bot,setBot]=React.useState<any>({larkAppId:'cli_dashboard_policy',triggerUserAuth:initial});return React.createElement(TriggerUserAuthSection,{bot,patchBot:(_id,patch)=>setBot((old:any)=>({...old,...patch}))});}
  let renderer!:TestRenderer.ReactTestRenderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(Harness));});
  const control=(action:string)=>renderer.root.findByProps({'data-action':action});
  return {requests,reads,renderer,control,close:async()=>{await act(async()=>renderer.unmount());}};
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
it('identity tabs filter explicit Bot rules and filtered edits preserve hidden rules',async()=>{
 const initial={...full,bytedcliOperationPolicy:config({...full.bytedcliOperationPolicy!.rules,'codebase.mr.files':'actor'})};
 const p=await panel(initial,summary(initial));
 const visible=()=>p.renderer.root.findAllByType('select')
  .map(select=>String(select.props['data-action']??'')).filter(action=>action.startsWith('bytedcli-policy-'))
  .map(action=>action.slice('bytedcli-policy-'.length));
 const text=(node:any):string=>typeof node==='string'?node:(node.children??[]).map(text).join('');
 try{
  const all=p.control('bytedcli-policy-filter-all');expect(all.props['aria-selected']).toBe(true);
  const total=BYTEDCLI_OPERATION_CATALOG.filter(row=>row.effect==='read'||row.effect==='write').length;
  expect(visible()).toHaveLength(total);expect(text(all)).toContain(`(${total})`);
  await act(async()=>p.control('bytedcli-policy-filter-machine').props.onClick());
  expect(visible()).toEqual(['codebase.mr.list']);expect(text(p.control('bytedcli-policy-filter-machine'))).toContain('(1)');
  expect(p.control('bytedcli-effective-codebase.mr.list').props['data-identity']).toBe('actor');
  await act(async()=>p.control('bytedcli-policy-filter-actor').props.onClick());
  expect(visible()).toEqual(['codebase.mr.files']);expect(p.requests).toEqual([]);
  await act(async()=>p.control('bytedcli-policy-codebase.mr.files').props.onChange({currentTarget:{value:'machine'}}));
  expect(p.requests).toHaveLength(1);
  expect(p.requests[0].bytedcliOperationPolicy).toEqual(config({...initial.bytedcliOperationPolicy.rules,'codebase.mr.files':'machine'}));
  expect(visible()).toEqual([]);expect(p.control('bytedcli-policy-empty')).toBeDefined();
  expect(text(p.control('bytedcli-policy-filter-actor'))).toContain('(0)');
  await act(async()=>p.control('bytedcli-policy-filter-machine').props.onClick());
  expect(visible().sort()).toEqual(['codebase.mr.files','codebase.mr.list']);
  expect(text(p.control('bytedcli-policy-filter-machine'))).toContain('(2)');
  await act(async()=>p.control('bytedcli-policy-filter-all').props.onClick());
  expect(visible()).toHaveLength(total);expect(visible()).toContain('codebase.mr.close');expect(visible()).toContain('codebase.repo.list');
 }finally{await p.close();}
});
it.each([
 {label:'missing policy',initial:undefined,mode:'machine'},
 {label:'disabled policy with saved mixed rules',initial:{...full,enabled:false},mode:'machine'},
 {label:'missing enabled with mixed rules',initial:{...full,enabled:undefined},mode:'machine'},
 {label:'legacy sender policy',initial:{enabled:true,tools:['bytedcli']},mode:'actor'},
 {label:'explicit sender policy with saved rules',initial:{...full,bytecloudExecution:'trigger-user'},mode:'actor'},
 {label:'mixed enum without ByteCloud',initial:{...full,capabilities:['lark-user']},mode:'actor'},
])('renders the effective $mode mode without saving or exposing dormant rules ($label)',async({initial,mode})=>{
 const p=await panel(initial,summary());try{
  expect(p.control(`cli-identity-mode-${mode}`).props['aria-checked']).toBe(true);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-plugin-preset'})).toHaveLength(0);
  expect(p.requests).toEqual([]);if(mode==='machine')expect(p.reads).toEqual([]);
  if(initial?.tools && !initial?.capabilities)expect(p.renderer.root.findAllByProps({'data-action':'trigger-user-auth-lark-user-native-note'})).toHaveLength(0);
 }finally{await p.close();}
});
it('switching between three modes preserves command rules and hidden identity settings',async()=>{
 const p=await panel(full,summary());try{
  expect(p.control('cli-identity-mode-mixed').props['aria-checked']).toBe(true);
  await act(async()=>p.control('cli-identity-mode-machine').props.onClick());
  expect(p.requests.at(-1)).toEqual({...full,enabled:false});
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
  await act(async()=>p.control('cli-identity-mode-actor').props.onClick());
  expect(p.requests.at(-1)).toMatchObject({...full,bytecloudExecution:'trigger-user'});
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
  await act(async()=>p.control('cli-identity-mode-mixed').props.onClick());
  expect(p.requests.at(-1)).toMatchObject(full);
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe('ready');
  expect(p.control('bytedcli-policy-codebase.mr.list').props.value).toBe('machine');
 }finally{await p.close();}
});
it('choosing mixed mode adds required ByteCloud without changing other capabilities',async()=>{
 const p=await panel({...full,capabilities:['lark-user']},summary());try{
  await act(async()=>p.control('cli-identity-mode-mixed').props.onClick());
  expect(p.requests.at(-1)).toMatchObject({...full,capabilities:['lark-user','bytecloud']});
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe('ready');
  expect(p.control('trigger-user-auth-capability-bytecloud').props.disabled).toBe(true);
  await act(async()=>p.control('trigger-user-auth-capability-bytecloud').props.onChange({currentTarget:{checked:false}}));
  expect(p.requests).toHaveLength(1);
 }finally{await p.close();}
});
it('editing sender capabilities cannot silently reactivate an old mixed enum',async()=>{
 const p=await panel({...full,capabilities:['lark-user']},summary());try{
  await act(async()=>p.control('trigger-user-auth-capability-bytecloud').props.onChange({currentTarget:{checked:true}}));
  expect(p.requests.at(-1)).toMatchObject({enabled:true,bytecloudExecution:'trigger-user',capabilities:['lark-user','bytecloud'],bytedcliOperationPolicy:full.bytedcliOperationPolicy});
  expect(p.control('cli-identity-mode-actor').props['aria-checked']).toBe(true);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
 }finally{await p.close();}
});
it.each([
 {tools:['lark-cli'],capabilities:['lark-user'],mixedCapabilities:['lark-user','bytecloud'],mixedNative:false},
 {tools:['bytedcli'],capabilities:['bytecloud','meego'],mixedCapabilities:['bytecloud','meego'],mixedNative:false},
 {tools:[],capabilities:[],mixedCapabilities:['bytecloud'],mixedNative:true},
])('legacy tools $tools keep scope and Lark behavior until ByteCloud is explicitly added',async({tools,capabilities,mixedCapabilities,mixedNative})=>{
 const initial=botDefaultsPayload({larkAppId:'cli_dashboard_policy'} as any,{triggerUserAuth:{...full,capabilities:undefined,tools,bytecloudExecution:'trigger-user'}} as any).triggerUserAuth;
 const p=await panel(initial,summary());try{
  for(const cap of ['lark-user','bytecloud','meego'])expect(p.control(`trigger-user-auth-capability-${cap}`).props.checked).toBe(capabilities.includes(cap));
  await act(async()=>p.control('trigger-user-auth-source-default').props.onChange({currentTarget:{value:'platform'}}));
  expect([...capabilitiesOf(parseTriggerUserAuthConfig(p.requests.at(-1)))]).toEqual(capabilities);
  expect(larkUserNative(parseTriggerUserAuthConfig(p.requests.at(-1)))).toBe(false);
  await act(async()=>p.control('cli-identity-mode-machine').props.onClick());
  await act(async()=>p.control('cli-identity-mode-actor').props.onClick());
  expect([...capabilitiesOf(parseTriggerUserAuthConfig(p.requests.at(-1)))]).toEqual(capabilities);
  expect(larkUserNative(parseTriggerUserAuthConfig(p.requests.at(-1)))).toBe(false);
  expect(p.requests.at(-1).bytedcliOperationPolicy).toEqual(full.bytedcliOperationPolicy);
  await act(async()=>p.control('cli-identity-mode-mixed').props.onClick());
  expect([...capabilitiesOf(parseTriggerUserAuthConfig(p.requests.at(-1)))]).toEqual(mixedCapabilities);
  expect(larkUserNative(parseTriggerUserAuthConfig(p.requests.at(-1)))).toBe(mixedNative);
 }finally{await p.close();}
});
it('mixed mode refreshes host rules after the policy save has committed',async()=>{
 let commit!:()=>void;const gate=new Promise<void>(resolve=>{commit=resolve;});
 const p=await panel({...full,bytecloudExecution:'trigger-user'},(saved:any)=>saved.bytecloudExecution==='read-machine-write-actor'?summary(saved):undefined,undefined,false,gate);
 try{
  await act(async()=>p.control('cli-identity-mode-mixed').props.onClick());
  expect(p.control('cli-identity-mode-mixed').props['aria-checked']).toBe(true);
  expect(p.control('bytedcli-policy-codebase.mr.list').props.disabled).toBe(true);
  await act(async()=>commit());
  expect(p.control('bytedcli-policy-state').props['data-state']).toBe('ready');
  expect(p.control('bytedcli-policy-codebase.mr.list').props.disabled).toBe(false);
  expect(p.control('bytedcli-effective-codebase.mr.list').props['data-identity']).toBe('actor');
 }finally{commit();await p.close();}
});
it('failed mode changes roll back to machine with all saved rules hidden',async()=>{
 const p=await panel({...full,enabled:false},summary(),undefined,true);try{
  await act(async()=>p.control('cli-identity-mode-mixed').props.onClick());
  expect(p.control('cli-identity-mode-machine').props['aria-checked']).toBe(true);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
  expect(p.requests.at(-1)).toMatchObject(full);
 }finally{await p.close();}
});
it.each([{label:'old daemon',status:undefined},{label:'v1 daemon',status:{...summary(),schema:'botmux.bytedcli-operation-policy-status.v1'}},{label:'unknown catalog',status:{...summary(),catalogVersion:'old'}},{label:'invalid global',status:{...summary(),global:{state:'invalid',revision:'invalid',errorCode:'operation_policy_invalid'}}}])('unavailable or invalid host state blocks rule saves but permits emergency disable ($label)',async ({status})=>{
 const p=await panel(full,status);try{
  const select=p.control('bytedcli-policy-codebase.mr.list');expect(select.props.disabled).toBe(true);
  await act(async()=>select.props.onChange({currentTarget:{value:'deny'}}));expect(p.requests).toEqual([]);
  await act(async()=>p.control('bytedcli-policy-clear').props.onClick());expect(p.requests).toEqual([]);
  await act(async()=>p.control('cli-identity-mode-machine').props.onClick());expect(p.requests.at(-1).enabled).toBe(false);
  expect(p.control('cli-identity-mode-machine').props['aria-checked']).toBe(true);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-table'})).toHaveLength(0);
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
const supportDeclaration=()=>parsePluginBytedcliOperationPresets({schema:'botmux.bytedcli-operation-presets.v1',presets:[{id:'support',title:'Shared support',description:'Reviewed shared commands',policy:config({'codebase.mr.close':'machine','codebase.mr.list':'actor'})}]});
function installSupportPreset(){
 const now=new Date().toISOString();upsertInstalledPlugin({id:'support',packageName:'botmux-plugin-support',version:'1.0.0',source:{type:'local',spec:root},manifest:{schemaVersion:1,id:'support'},contributions:{bytedcliOperationPresets:supportDeclaration()},installedAt:now,updatedAt:now});
 return readPluginBytedcliOperationPresets({plugins:['support']},{});
}
it('renders external plugin presets, applies only a source reference and keeps global floors visible',async()=>{
 const presets=installSupportPreset(),row=presets.presets[0]!;
 const p=await panel(full,summary(full,{'codebase.mr.close':'actor'}),presets);
 try{
  const buttons=p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-plugin-preset'});expect(buttons).toHaveLength(1);
  await act(async()=>buttons[0]!.props.onClick());
  expect(p.requests).toEqual([{bytedcliOperationPreset:{pluginId:'support',presetId:'support',revision:row.revision}}]);
  expect(p.control('bytedcli-policy-codebase.mr.close').props.value).toBe('machine');
  expect(p.control('bytedcli-effective-codebase.mr.close').props['data-identity']).toBe('actor');
  expect(p.control('bytedcli-policy-codebase.mr.list').props.value).toBe('actor');
 }finally{await p.close();removeInstalledPlugin('support');}
});
it('has no built-in business preset when no enabled plugin contributes one',async()=>{
 const p=await panel(full,summary());try{
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-plugin-preset'})).toHaveLength(0);
  expect(p.renderer.root.findAllByProps({'data-action':'bytedcli-policy-mix-preset'})).toHaveLength(0);
 }finally{await p.close();}
});
it('a stale preset application keeps the current rules and does not retry the write',async()=>{
 const presets=installSupportPreset(),p=await panel(full,summary(),presets,true);
 try{
  await act(async()=>p.control('bytedcli-policy-plugin-preset').props.onClick());
  expect(p.requests).toHaveLength(1);expect(p.control('bytedcli-policy-codebase.mr.close').props.value).toBe('deny');
 }finally{await p.close();removeInstalledPlugin('support');}
});
it('HTTP applies an installed bound preset from the latest disk settings and rejects stale or removed sources',async()=>{
 const cfg=getBot('cli_dashboard_policy').config,original=cfg.triggerUserAuth,originalPlugins=cfg.plugins;
 const before=readFileSync(botsFile,'utf8');installSupportPreset();cfg.plugins=['support'];
 try{
  const disk=JSON.parse(before);disk[0].plugins=['support'];disk[0].triggerUserAuth={...full,allowSpeakerSwitch:true};writeFileSync(botsFile,JSON.stringify(disk));
  const status=await get();expect(status.bytedcliOperationPresets.presets).toHaveLength(1);const row=status.bytedcliOperationPresets.presets[0];
  const ref={pluginId:row.pluginId,presetId:row.id,revision:row.revision};
  const apply=(body:any)=>fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth`,{method:'PUT',body:JSON.stringify(body)});
  const response=await apply({bytedcliOperationPreset:ref});expect(response.status).toBe(200);
  const saved=(await response.json()).triggerUserAuth;expect(saved).toMatchObject({credentialSource:full.credentialSource,capabilities:full.capabilities,dispatchOnly:full.dispatchOnly,allowSpeakerSwitch:true});
  expect(saved.bytedcliOperationPolicy).toEqual(config({'codebase.mr.close':'machine','codebase.mr.list':'actor'}));
  const persisted=readFileSync(botsFile,'utf8');
  expect((await apply({bytedcliOperationPreset:{...ref,revision:'sha256:'+'a'.repeat(43)}})).status).toBe(409);
  expect((await apply({bytedcliOperationPreset:ref,triggerUserAuth:full})).status).toBe(400);
  const record=readPluginRegistry().plugins.support!;upsertInstalledPlugin({...record,version:'1.0.1'});
  expect((await apply({bytedcliOperationPreset:ref})).status).toBe(409);
  removeInstalledPlugin('support');expect((await apply({bytedcliOperationPreset:ref})).status).toBe(409);
  expect(readFileSync(botsFile,'utf8')).toBe(persisted);
 }finally{writeFileSync(botsFile,before);cfg.triggerUserAuth=original;cfg.plugins=originalPlugins;removeInstalledPlugin('support');}
});
it('HTTP discovery and application use fresh global and bot bindings after another process disables a plugin',async()=>{
 const cfg=getBot('cli_dashboard_policy').config,originalAuth=cfg.triggerUserAuth,originalPlugins=cfg.plugins;
 const before=readFileSync(botsFile,'utf8'),globalPath=globalConfigPath(),previousGlobal=existsSync(globalPath)?readFileSync(globalPath,'utf8'):undefined;
 installSupportPreset();
 try{
  const disk=JSON.parse(before);disk[0].plugins=[];disk[0].triggerUserAuth=full;writeFileSync(botsFile,JSON.stringify(disk));cfg.triggerUserAuth=full;cfg.plugins=['support'];
  writeFileSync(globalPath,JSON.stringify({plugins:['support']}));invalidateGlobalConfigCache();expect(readGlobalConfig().plugins).toEqual(['support']);
  const row=(await get()).bytedcliOperationPresets.presets[0],ref={pluginId:row.pluginId,presetId:row.id,revision:row.revision};
  writeFileSync(globalPath,JSON.stringify({plugins:[]}));
  const response=await fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth`,{method:'PUT',body:JSON.stringify({bytedcliOperationPreset:ref})});
  expect(response.status).toBe(409);expect((await get()).bytedcliOperationPresets.presets).toEqual([]);
  expect(JSON.parse(readFileSync(botsFile,'utf8'))[0].triggerUserAuth.bytedcliOperationPolicy).toEqual(full.bytedcliOperationPolicy);
 }finally{
  writeFileSync(botsFile,before);cfg.triggerUserAuth=originalAuth;cfg.plugins=originalPlugins;removeInstalledPlugin('support');
  if(previousGlobal===undefined)rmSync(globalPath,{force:true});else writeFileSync(globalPath,previousGlobal);invalidateGlobalConfigCache();
 }
});
it('HTTP keeps manual policy status and healthy presets available when unrelated MCP metadata is corrupt',async()=>{
 const cfg=getBot('cli_dashboard_policy').config,originalAuth=cfg.triggerUserAuth;
 const before=readFileSync(botsFile,'utf8');installSupportPreset();const registryFile=pluginRegistryPath(),registryBytes=readFileSync(registryFile,'utf8');
 try{
  const disk=JSON.parse(before);disk[0].plugins=['support'];disk[0].triggerUserAuth=full;writeFileSync(botsFile,JSON.stringify(disk));cfg.triggerUserAuth=full;
  const registry=JSON.parse(registryBytes);registry.plugins.broken={...registry.plugins.support,id:'broken',manifest:{schemaVersion:1,id:'broken'},contributions:{mcp:{token:'private-mcp-secret'}}};
  writeFileSync(registryFile,JSON.stringify(registry));
  const response=await fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth-status`);expect(response.status).toBe(200);
  const status=await response.json();expect(status.bytedcliOperationPolicy.schema).toBe('botmux.bytedcli-operation-policy-status.v2');
  expect(status.bytedcliOperationPresets.presets.map((row:any)=>row.pluginId)).toEqual(['support']);expect(JSON.stringify(status)).not.toContain('private-mcp-secret');
  expect((await put({bytedcliOperationPolicy:config({'codebase.mr.list':'actor'})})).status).toBe(200);
 }finally{writeFileSync(registryFile,registryBytes);removeInstalledPlugin('support');writeFileSync(botsFile,before);cfg.triggerUserAuth=originalAuth;}
});

it('same-path RPC rules have distinct visible and accessible identities and save only the named rule', async()=>{
 const ids=['api-test.rpc-call.picko-troubleshoot-ticket','api-test.rpc-call.picko-size-ticket'];
 const initial=parseTriggerUserAuthConfig({...full,allowSpeakerSwitch:false,bytedcliOperationPolicy:config({...full.bytedcliOperationPolicy!.rules,[ids[0]!]: 'actor',[ids[1]!]: 'actor'})})!;
 const p=await panel(initial,summary(initial,{[ids[0]!]: 'actor'}));
 const text=(node:any):string=>typeof node==='string'?node:(node.children??[]).map(text).join(' ');
 try {
  const controls=ids.map(id=>{
   const named=p.renderer.root.findAllByType('select').filter(select=>String(select.props['aria-label']??'').includes(id));
   expect(named).toHaveLength(1);
   return named[0]!;
  });
  expect(controls[0]!.props['aria-label']).not.toBe(controls[1]!.props['aria-label']);
  for(const [index,control] of controls.entries()){
   const row=control.parent!.parent!;
   expect(row.findAllByType('code').map(code=>text(code))).toContain(ids[index]);
   expect(text(row)).toContain(index===0?'ecom.market.udc_dump/PickoTroubleShoot/manual_check':'ecom.market.udc_dump/Debug/picko_size');
   expect(text(row)).toContain('permission ticket required (write)');
   const description=p.renderer.root.findByProps({id:control.props['aria-describedby']});
   expect(text(description)).toContain(index===0?'manual_check':'picko_size');
  }
  await act(async()=>controls[1]!.props.onChange({currentTarget:{value:'machine'}}));
  expect(p.requests.at(-1).bytedcliOperationPolicy.rules).toEqual({...initial.bytedcliOperationPolicy!.rules,[ids[1]!]: 'machine'});
  expect(parseTriggerUserAuthConfig(p.requests.at(-1))).toEqual({...initial,bytedcliOperationPolicy:config({...initial.bytedcliOperationPolicy!.rules,[ids[1]!]: 'machine'})});
  expect(controls[0]!.props.value).toBe('actor');
  expect(controls[1]!.props.value).toBe('machine');
 }finally{await p.close();}
});
it('core-only synthetic bots retain manual status without requiring a bots.json file',async()=>{
 const previous={BOTMUX_CORE_ONLY:process.env.BOTMUX_CORE_ONLY,BOTMUX_API_ONLY_BOT:process.env.BOTMUX_API_ONLY_BOT,BOTS_CONFIG:process.env.BOTS_CONFIG};
 try{
  process.env.BOTMUX_CORE_ONLY='1';process.env.BOTMUX_API_ONLY_BOT='local_riff';delete process.env.BOTS_CONFIG;
  __testOnly_resetBotRegistry();loadBotConfigs().forEach(registerBot);setLarkAppId('local_riff');
  const response=await fetch(`http://127.0.0.1:${ipc.port}/api/bot-trigger-user-auth-status`);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok:true,bytedcliOperationPresets:{presets:[]}});
 }finally{
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  __testOnly_resetBotRegistry();loadBotConfigs().forEach(registerBot);setLarkAppId('cli_dashboard_policy');
 }
});
