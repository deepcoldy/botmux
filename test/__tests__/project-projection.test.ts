import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectCoordinator,type ProjectCoordinatorTransport} from '../../src/services/project-coordinator.js';
import {readProjectGroup} from '../../src/services/project-group-store.js';
import {parseProjectProjection,type ProjectProjection} from '../../src/services/project-projection.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'project-projection-'));roots.push(dataDir);
  const transport:ProjectCoordinatorTransport={sendCard:vi.fn(async()=> 'om_card'),updateCard:vi.fn(async()=>{}),pinMessage:vi.fn(async()=>true),
    unpinMessage:vi.fn(async()=>true),resolveThreadId:vi.fn(async()=>null),isMessageWithdrawn:()=>false,isMessageUpdateExpired:()=>false,brand:()=> 'feishu'};
  return {transport,coordinator:new ProjectCoordinator(transport),context:{dataDir,chatId:'oc_group',larkAppId:'cli_owner',coordinatorSessionId:''}};
}
const input=(revision=1):ProjectProjection=>({providerId:'platform',sourceId:'project',revision,workingDir:'/workspace',snapshot:{
  title:'Project',goal:'Scope',status:'active',stateLabel:'等待你的答复',phase:'architecture',focus:'Decision',remaining:'Implementation',blockers:[],board:'Waiting for owner\n'}});
it('serializes snapshots, ignores stale delivery, and blocks legacy CLI writes',async()=>{
  const f=fixture(),write=vi.fn(async()=>{}),v2=input(2);
  await Promise.all([f.coordinator.project(f.context,v2,write),f.coordinator.project(f.context,input(),write)]);
  expect(readProjectGroup(f.context.dataDir,f.context.chatId)?.projection?.revision).toBe(2);
  expect(write).toHaveBeenCalledTimes(1);
  await expect(f.coordinator.run(f.context,{action:'close'})).rejects.toThrow('project_managed_by_provider');
  await f.coordinator.project(f.context,v2,write);expect(write).toHaveBeenCalledTimes(1);
  await expect(f.coordinator.project(f.context,{...v2,snapshot:{...v2.snapshot,goal:'changed'}},write)).rejects.toThrow('revision_conflict');
});
it('restart retries partial publication and closes from the same snapshot',async()=>{
  const f=fixture(),write=vi.fn(async()=>{}),v=input();
  vi.mocked(f.transport.sendCard).mockRejectedValueOnce(Error('network'));
  await expect(f.coordinator.project(f.context,v,write)).rejects.toThrow('network');
  expect(readProjectGroup(f.context.dataDir,f.context.chatId)?.projection?.appliedHash).toBeUndefined();
  const restarted=new ProjectCoordinator(f.transport);
  await restarted.project(f.context,v,write);
  const final=input(2);final.snapshot.status='completed';final.snapshot.stateLabel='任务已取消';final.snapshot.board='任务已取消\n';
  const closed=await restarted.project(f.context,final,write);
  expect(closed.status).toBe('completed');expect(closed.projection?.appliedHash).toBe(closed.projection?.hash);
  expect(write).toHaveBeenLastCalledWith(final,closed.projection?.hash);
  expect(f.transport.updateCard).toHaveBeenLastCalledWith('cli_owner','om_card',expect.stringContaining('任务已取消'));
});
it('does not seize an existing unmanaged project',async()=>{
  const f=fixture();await f.coordinator.run({...f.context,coordinatorSessionId:'session'},{action:'init',title:'Original',goal:'Scope'});
  await expect(f.coordinator.project(f.context,input(),async()=>{})).rejects.toThrow('owner_conflict');
});
it('validates the entire incoming snapshot',()=>{
  expect(parseProjectProjection(input()).revision).toBe(1);
  expect(()=>parseProjectProjection({...input(),revision:NaN})).toThrow('invalid_project_projection');
  expect(()=>parseProjectProjection({...input(),snapshot:{...input().snapshot,board:3}})).toThrow('invalid_project_projection:board');
});
