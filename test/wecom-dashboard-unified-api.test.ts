import { describe,it,expect,vi,afterEach } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { handleWecomSessionApi,mergeWecomSessionSnapshot } from '../src/dashboard/wecom/session-api.js';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function response(){const res={status:0,body:'',writeHead(status:number){this.status=status;},end(body:string){this.body=body;}};return res;}
describe('unified WeCom private HTTP contract',()=>{
 it('denies anonymous/H5 before touching private source and requires CSRF before writes',async()=>{
  const request=vi.fn(async()=>Response.json({ok:true})),terminal=vi.fn(),control=vi.fn();
  for(const hostAdmin of [false,true]){
   const res=response();let csrf=0;
   await handleWecomSessionApi({method:'POST'} as any,res as any,new URL('http://localhost/api/sessions/wecom%3Aopaque/close'),{hostAdmin,csrfValid:()=>{csrf++;return false;},readBody:async()=>({}),sessions:{request,terminal},terminal:{control}});
   expect(request).not.toHaveBeenCalled();expect(control).not.toHaveBeenCalled();expect(csrf).toBe(hostAdmin?1:0);if(!hostAdmin)expect(res.status).toBe(403);
  }
 });
 it('forwards safe reads and query/turn path through the same source handler, never Lark',async()=>{
  const request=vi.fn(async()=>Response.json({ok:true})),res=response();
  expect(await handleWecomSessionApi({method:'GET'} as any,res as any,new URL('http://localhost/api/sessions/wecom%3Aopaque/insight/turn/2?offset=0&limit=40000'),{hostAdmin:true,csrfValid:()=>false,readBody:async()=>({}),sessions:{request,terminal:vi.fn()},terminal:{control:vi.fn()}})).toBe(true);
  expect(request.mock.calls[0]?.slice(0,3)).toEqual(['wecom:opaque','insight/turn/2',{}]);expect(String((request.mock.calls as any)[0][3])).toBe('offset=0&limit=40000');expect(res.status).toBe(200);
 });
 it('excludes private history before totals/cursors, and publishes delete metadata only for complete admin snapshots',()=>{
  const legacy=[{sessionId:'lark',status:'closed',lastMessageAt:1}],privateRows=[{sessionId:'wecom:private',status:'closed',lastMessageAt:2}];
  for(const admin of [false,true])for(const complete of [false,true]){
   const merged=mergeWecomSessionSnapshot(legacy,admin,{sessions:privateRows,complete});const page=selectSessionPage(merged.sessions,new URLSearchParams('view=closed'));
   expect(page.closedTotal).toBe(admin?2:1);expect(merged.wecomSessionIds).toEqual(admin&&complete?['wecom:private']:undefined);
  }
 });
 it('edits only shared execution settings with CAS and retains native ACL/credentials/state identity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-config-editor-'));roots.push(root);const file=join(root,'config.json');
  const config={botId:'fixture-native-bot',secretFile:join(root,'private-secret'),allowedUsers:['fixture-real-user'],coreUrl:'http://127.0.0.1:9944',stateDir:join(root,'bridge'),managedCore:{botId:'local_fixture',cli:'codex',backend:'pty',workingDirectory:root,stateDir:join(root,'core'),port:9944}};
  writeFileSync(file,JSON.stringify(config),{mode:0o600});const service=new WecomDashboardConfig(root),id=wecomConfigId(file),previous=service.get(id);
  await expect(service.patch(id,{...previous,editable:undefined} as any)).rejects.toThrow('wecom_invalid_configuration');
  const update={revision:previous.revision,displayName:'fixture local display',cli:'claude-code',backend:'tmux',model:'fixture-model',workingDirectory:root};
  await service.patch(id,update);const saved=JSON.parse(readFileSync(file,'utf8'));
  expect(saved).toMatchObject({displayName:'fixture local display',botId:config.botId,secretFile:config.secretFile,allowedUsers:config.allowedUsers,stateDir:config.stateDir,managedCore:{...config.managedCore,cli:'claude-code',backend:'tmux',model:'fixture-model'}});
  await expect(service.patch(id,{...update,model:'stale'})).rejects.toThrow('wecom_configuration_changed');
  expect(JSON.stringify(service.get(id))).not.toContain(config.secretFile);expect(service.get(id)).toMatchObject({allowedUsers:config.allowedUsers});
 });
});
