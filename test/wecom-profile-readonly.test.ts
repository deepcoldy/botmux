import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { applyGlobalSessionEnvOps, invalidateGlobalConfigCache } from '../src/global-config.js';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();invalidateGlobalConfigCache();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'wecom-profile-readonly-'));roots.push(root);
 const home=join(root,'home'),bin=join(root,'profile-cli');mkdirSync(join(home,'.codex'),{recursive:true});
 writeFileSync(join(home,'.codex','production.config.toml'),'model="fixture-model"\n');
 writeFileSync(bin,'#!/bin/sh\n[ -n "$CUSTOM_WECOM_SECRET" ] && exit 93\n[ "$PROFILE_FLAG" != "expected" ] && exit 94\ncase "$1" in\n--version) echo "codex-cli 0.134.0";;\n--help) echo "--profile <PROFILE>";;\n*) exit 91;;\nesac\n',{mode:0o700});
 const config={botId:'native-bot',allowedUsers:['owner'],secretEnv:'CUSTOM_WECOM_SECRET',coreUrl:'http://127.0.0.1:19997',managedCore:{cli:'codex',backend:'pty',botId:'local_readonly',port:19997,stateDir:join(root,'core'),workingDirectory:root,botConfig:{cliRuntime:{id:'profile-fixture',executable:bin},cliPathOverride:bin,env:{HOME:home,PROFILE_FLAG:'expected'}}}};
 const file=join(root,'config.json');writeFileSync(file,JSON.stringify(config),{mode:0o600});
 vi.stubEnv('CUSTOM_WECOM_SECRET','fake-gateway-secret');
 return {root,file,config,service:new WecomDashboardConfig(root),id:wecomConfigId(file)};
}
describe('WeCom source-bound read-only configuration operations',()=>{
 it('scans the selected connection runtime and profile home without gateway credentials or configuration writes',async()=>{
  const f=fixture(),before=readFileSync(f.file,'utf8');
  const catalog=await f.service.codexProfiles(f.id);
  expect(catalog).toMatchObject({connectionId:f.id,status:'ok',version:'0.134.0',candidates:[{name:'production',available:true}]});
  expect(catalog).not.toHaveProperty('larkAppId');expect(readFileSync(f.file,'utf8')).toBe(before);
  expect(await f.service.cliProbe(f.id,'availability','codex')).toMatchObject({status:'available'});
  const models=await f.service.cliProbe(f.id,'models','codex');expect(models).toHaveProperty('models');
  expect(JSON.stringify({catalog,models})).not.toContain('fake-gateway-secret');
 });
 it('uses host, global and bot environment layers with masking and strict inheritance from its actual core boundary',async()=>{
  const f=fixture();vi.stubEnv('PROFILE_HOST_VALUE','host');vi.stubEnv('PROFILE_SECRET_TOKEN','host-secret-value');
  vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE',join(f.root,'global.json'));invalidateGlobalConfigCache();
  applyGlobalSessionEnvOps([{op:'set',key:'PROFILE_GLOBAL_VALUE',value:'global'},{op:'set',key:'PROFILE_FLAG',value:'global'}]);
  const before=readFileSync(f.file,'utf8'),view=f.service.environment(f.id);
  expect(view.rows.find(row=>row.key==='PROFILE_HOST_VALUE')).toMatchObject({source:'host',value:'host'});
  expect(view.rows.find(row=>row.key==='PROFILE_GLOBAL_VALUE')).toMatchObject({source:'global',value:'global'});
  expect(view.rows.find(row=>row.key==='PROFILE_FLAG')).toMatchObject({source:'bot',value:'expected'});
  expect(view.rows.find(row=>row.key==='PROFILE_SECRET_TOKEN')).toMatchObject({masked:true});
  expect(JSON.stringify(view)).not.toContain('host-secret-value');expect(JSON.stringify(view)).not.toContain('fake-gateway-secret');
  expect(view.rows.some(row=>row.key==='CUSTOM_WECOM_SECRET')).toBe(false);
  expect(readFileSync(f.file,'utf8')).toBe(before);
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,botConfig:{envPolicy:{mode:'strict'}}});
  expect(f.service.environment(f.id).notInheritedKeys).toContain('PROFILE_HOST_VALUE');
 });
 it('authenticates every provider read before source access and prevents browser mutation without CSRF',async()=>{
  const f=fixture(),spy=vi.spyOn(f.service,'codexProfiles');
  const res=()=>({status:0,writeHead(n:number){this.status=n;},end(){}});
  const response=res();await handleWecomConnectionsApi({method:'GET'} as any,response as any,new URL(`http://localhost/api/wecom/connections/${f.id}/codex-profiles`),{hostAdmin:false,csrfValid:false,configuration:f.service});
  expect(response.status).toBe(403);expect(spy).not.toHaveBeenCalled();
  const write=res();await handleWecomConnectionsApi({method:'PATCH'} as any,write as any,new URL(`http://localhost/api/wecom/connections/${f.id}/config`),{hostAdmin:true,csrfValid:false,configuration:f.service});expect(write.status).toBe(403);
 });
});
