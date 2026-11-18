import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ProjectCoordinator,type ProjectCoordinatorTransport} from '../../src/services/project-coordinator.js';
import {readProjectGroup,mutateProjectGroup} from '../../src/services/project-group-store.js';
import type {ProjectProjection} from '../../src/services/project-projection.js';
const roots:string[]=[];afterEach(()=>{roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));vi.restoreAllMocks();});
const input=(revision=1):ProjectProjection=>({providerId:'platform',sourceId:'project',revision,workingDir:'/workspace',snapshot:{title:'Original task',goal:'Original scope',status:'active',stateLabel:'正在执行',phase:'deployment',focus:'Original request',remaining:'Validation',blockers:[],board:'Original task'}});
function fixture(){
 const dataDir=mkdtempSync(join(tmpdir(),'card-lifetime-'));roots.push(dataDir);const cards=new Map<string,string>(),receipts=new Map<string,string>();let count=0,lose=false;
 const transport:ProjectCoordinatorTransport={
  sendCard:vi.fn(async(_app,_chat,content,pub)=>{await pub?.beforeSend();const prior=pub&&receipts.get(pub.uuid);if(prior){expect(cards.get(prior)).toBe(content);return prior;}const id='om_'+(++count);cards.set(id,content);if(pub)receipts.set(pub.uuid,id);if(lose){lose=false;throw Error('reply lost');}return id;}),
  updateCard:vi.fn(async(_app,id,content)=>{if(id==='om_1')throw Object.assign(Error('expired'),{name:'MessageUpdateExpiredError'});cards.set(id,content);}),
  pinMessage:vi.fn(async()=>true),unpinMessage:vi.fn(async()=>true),resolveThreadId:vi.fn(async()=>null),isMessageWithdrawn:()=>false,
  isMessageUpdateExpired:e=>e instanceof Error&&e.name==='MessageUpdateExpiredError',brand:()=> 'feishu'};
 return {dataDir,context:{dataDir,chatId:'oc_original',larkAppId:'cli_owner',coordinatorSessionId:''},transport,cards,coordinator:new ProjectCoordinator(transport),lose:()=>{lose=true;},count:()=>count};
}
it('rotates an expired projection once, preserves task data and retires the old pin',async()=>{
 const f=fixture(),write=vi.fn(async()=>{});await f.coordinator.project(f.context,input(),write);const updated=await f.coordinator.project(f.context,input(2),write);
 expect(updated.card?.messageId).toBe('om_2');expect(updated.projection?.revision).toBe(2);expect(updated.goal).toBe('Original scope');expect(updated.retiredCards).toMatchObject([{messageId:'om_1',reason:'expired',replacedBy:'om_2',pinned:false}]);
 await new ProjectCoordinator(f.transport).project(f.context,input(2),write);expect(f.count()).toBe(2);expect(f.transport.unpinMessage).toHaveBeenCalledWith('cli_owner','om_1');
});
it('a lost replacement reply reuses the original UUID and frozen content across restart',async()=>{
 const f=fixture(),write=async()=>{};await f.coordinator.project(f.context,input(),write);f.lose();await expect(f.coordinator.project(f.context,input(2),write)).rejects.toThrow('reply lost');
 expect(readProjectGroup(f.dataDir,f.context.chatId)?.cardReplacement?.startedAt).toBeTypeOf('number');const latest=input(3);latest.snapshot.focus='Actual next step';
 const result=await new ProjectCoordinator(f.transport).project(f.context,latest,write);expect(f.count()).toBe(2);expect(result.projection?.revision).toBe(3);expect(f.cards.get('om_2')).toContain('Actual next step');
});
it('an unknown send outside the provider dedupe window is preserved without another send',async()=>{
 const f=fixture(),write=async()=>{};await f.coordinator.project(f.context,input(),write);f.lose();await expect(f.coordinator.project(f.context,input(2),write)).rejects.toThrow('reply lost');
 await mutateProjectGroup(f.dataDir,f.context.chatId,current=>{current!.cardReplacement!.startedAt=Date.now()-56*60*1000;return current;});const calls=vi.mocked(f.transport.sendCard).mock.calls.length;
 await expect(new ProjectCoordinator(f.transport).project(f.context,input(2),write)).rejects.toThrow('outcome_unknown');expect(f.transport.sendCard).toHaveBeenCalledTimes(calls);
});
it('pin failure keeps the acknowledged replacement; failed old-pin cleanup is retried on the same snapshot',async()=>{
 const f=fixture(),write=async()=>{};await f.coordinator.project(f.context,input(),write);vi.mocked(f.transport.pinMessage).mockRejectedValueOnce(Error('pin temporarily unavailable'));
 await expect(f.coordinator.project(f.context,input(2),write)).rejects.toThrow('pin temporarily');expect(readProjectGroup(f.dataDir,f.context.chatId)?.cardReplacement?.messageId).toBe('om_2');
 vi.mocked(f.transport.unpinMessage).mockResolvedValueOnce(false);await new ProjectCoordinator(f.transport).project(f.context,input(2),write);expect(readProjectGroup(f.dataDir,f.context.chatId)?.retiredCards?.[0].pinned).toBe(true);
 await f.coordinator.project(f.context,input(2),write);expect(readProjectGroup(f.dataDir,f.context.chatId)?.retiredCards?.[0].pinned).toBe(false);expect(f.count()).toBe(2);
});
it('a temporary update failure does not rotate a card',async()=>{
 const f=fixture(),write=async()=>{};await f.coordinator.project(f.context,input(),write);vi.mocked(f.transport.updateCard).mockRejectedValueOnce(Error('temporary network'));
 await expect(f.coordinator.project(f.context,input(2),write)).rejects.toThrow('temporary network');expect(f.count()).toBe(1);expect(readProjectGroup(f.dataDir,f.context.chatId)?.cardReplacement).toBeUndefined();
});
