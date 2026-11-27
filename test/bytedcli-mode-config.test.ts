import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TriggerUserAuthSection } from '../src/dashboard/web/bot-defaults-page.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';
import { startIpcServer, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { mergeGlobalConfig, readGlobalConfig, invalidateGlobalConfigCache } from '../src/global-config.js';
import { bytecloudBrokerEnabled } from '../src/core/identity-policy.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let ipc: IpcServerHandle | undefined;
const roots: string[] = [];
afterEach(async () => { await ipc?.close(); ipc=undefined; vi.unstubAllEnvs(); vi.unstubAllGlobals(); invalidateGlobalConfigCache(); for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); });
const full = { enabled:true, capabilities:['bytecloud','lark-user','meego'], bytecloudExecution:'read-machine-write-actor',
 bytedcliOperationPolicy:{schema:'botmux.bytedcli-operation-policy.v1',cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules:{'codebase.mr.list':'actor','codebase.mr.close':'deny'}},
 credentialSource:{default:'auto','lark-user':'platform',bytecloud:'local'}, delegateOnMention:false, allowSpeakerSwitch:true,
 allowOwnerActor:true, dispatchOnly:{tools:['bytedcli'],targetAppIds:['cli_target'],chatIds:['oc_target']},
 gitHost:'code.example.test',gitTokenExchangeUrl:'https://code.example.test/exchange',gitCommitIdentity:true };
it('UI edits preserve hidden identity options, and enabling depends on ByteCloud selection',async()=>{
 const requests:any[]=[];
 vi.stubGlobal('fetch',async(_url:any,init:any)=>{if(init?.method==='PUT')requests.push(JSON.parse(init.body).triggerUserAuth);return {ok:true,json:async()=>({ok:true})};});
 function Harness(){const [bot,setBot]=React.useState<any>({larkAppId:'cli_mode',triggerUserAuth:full});return React.createElement(TriggerUserAuthSection,{bot,patchBot:(_id,patch)=>setBot((old:any)=>({...old,...patch}))});}
 let renderer!:TestRenderer.ReactTestRenderer;
 await act(async()=>{renderer=TestRenderer.create(React.createElement(Harness));});
 try{
 const control=(name:string)=>renderer.root.findByProps({'data-action':name});
 await act(async()=>control('trigger-user-auth-source-default').props.onChange({currentTarget:{value:'local'}}));
 expect(requests.at(-1)).toMatchObject({...full,credentialSource:{...full.credentialSource,default:'local'}});
 expect(control('trigger-user-auth-bytecloud-execution').props.value).toBe('read-machine-write-actor');
 expect(control('trigger-user-auth-bytecloud-state').props['data-active']).toBe(true);
 await act(async()=>control('trigger-user-auth-capability-bytecloud').props.onChange({currentTarget:{checked:false}}));
 expect(control('trigger-user-auth-bytecloud-state').props['data-active']).toBe(false);
 expect(requests.at(-1).bytecloudExecution).toBe(full.bytecloudExecution);
 await act(async()=>control('toggle-trigger-user-auth').props.onChange({currentTarget:{checked:false}}));
 expect(requests.at(-1)).toMatchObject({enabled:false,bytecloudExecution:full.bytecloudExecution,dispatchOnly:full.dispatchOnly});
 }finally{await act(async()=>renderer.unmount());}
});
it('new and old Dashboard saves, reload, explicit legacy and reset preserve the supported policy contract',async()=>{
 const migrated={...full,bytedcliOperationPolicy:{...full.bytedcliOperationPolicy,schema:'botmux.bytedcli-operation-policy.v2',catalogVersion:'2026-11-27.2'}};
 const root=mkdtempSync(join(tmpdir(),'bytedcli-config-'));roots.push(root);const file=join(root,'bots.json');vi.stubEnv('BOTS_CONFIG',file);
 writeFileSync(file,JSON.stringify([{larkAppId:'cli_mode_config',larkAppSecret:'fake',cliId:'codex',triggerUserAuth:full}]));
 loadBotConfigs().forEach(registerBot);setLarkAppId('cli_mode_config');ipc=await startIpcServer({port:0,host:'127.0.0.1'});
 const put=(value:any)=>fetch(`http://127.0.0.1:${ipc!.port}/api/bot-trigger-user-auth`,{method:'PUT',body:JSON.stringify({triggerUserAuth:value})});
 const stored=()=>JSON.parse(readFileSync(file,'utf8'))[0].triggerUserAuth;
 expect((await put({enabled:true,tools:['bytedcli']})).status).toBe(200);expect(stored()).toMatchObject(migrated);
 const reloaded=loadBotConfigs()[0]!.triggerUserAuth;expect(reloaded).toMatchObject(migrated);expect(bytecloudBrokerEnabled(reloaded)).toBe(true);
 const payload=botDefaultsPayload({larkAppId:'cli_mode_config'} as any,{triggerUserAuth:reloaded});expect(payload.triggerUserAuth).toMatchObject(migrated);
 const unchanged=stored();expect((await put({bytecloudExecution:'machine'})).status).toBe(400);expect(stored()).toEqual(unchanged);
 expect((await put({enabled:false})).status).toBe(200);expect(stored()).toMatchObject({...migrated,enabled:false});expect(bytecloudBrokerEnabled(loadBotConfigs()[0]!.triggerUserAuth)).toBe(false);
 expect((await put({enabled:true,bytecloudExecution:'trigger-user'})).status).toBe(200);expect(stored()).toMatchObject({...migrated,bytecloudExecution:'trigger-user'});
 expect((await put({bytedcliOperationPolicy:null})).status).toBe(200);expect(stored()).not.toHaveProperty('bytedcliOperationPolicy');
 expect(stored()).toMatchObject({credentialSource:full.credentialSource,dispatchOnly:full.dispatchOnly});
 expect((await put(null)).status).toBe(200);expect(stored()).toBeUndefined();
});
it('machine profile roundtrips independently and rejects invalid profile rather than choosing the default identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'bytedcli-global-'));roots.push(root);vi.stubEnv('HOME',root);invalidateGlobalConfigCache();
 mergeGlobalConfig({bytedcliBroker:{machineProfile:'shared-read'}} as any);
 expect((readGlobalConfig() as any).bytedcliBroker).toEqual({machineProfile:'shared-read'});
 mergeGlobalConfig({lang:'en'});expect((readGlobalConfig() as any).bytedcliBroker).toEqual({machineProfile:'shared-read'});
 expect(()=>mergeGlobalConfig({bytedcliBroker:{machineProfile:'../actor'}} as any)).toThrow();
 expect((readGlobalConfig() as any).bytedcliBroker.machineProfile).toBe('shared-read');
});

it('the first host layout freezes machine config for both broker and workers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bytedcli-frozen-config-'));roots.push(root);
 const {spawnTsEvalWithRepoImports}=await import('./helpers/ts-runner.js');
 const child=spawnTsEvalWithRepoImports(`
  import {mergeGlobalConfig} from './src/global-config.js';
  import {freezeBytedcliHostLayout,bytedcliTrustedHostLayout} from './src/core/bytedcli-host-layout.js';
  mergeGlobalConfig({bytedcliBroker:{machineProfile:'shared-read'}});
  const first=freezeBytedcliHostLayout();
  mergeGlobalConfig({bytedcliBroker:{machineProfile:'next-generation'}});
  const second=freezeBytedcliHostLayout();let rejected=false;
  try{freezeBytedcliHostLayout(bytedcliTrustedHostLayout({machineProfile:'next-generation'}));}catch{rejected=true;}
  console.log(JSON.stringify({first:first.machineProfile,second:second.machineProfile,same:first===second,rejected}));
 `,{env:{...process.env,HOME:root},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 expect(exit,stderr).toBe(0);expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({first:'shared-read',second:'shared-read',same:true,rejected:true});
});
