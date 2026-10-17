import {createHash} from 'node:crypto';
import type {ProjectGroupState} from './project-group-store.js';
import type {ProjectCoordinatorContext} from './project-coordinator.js';
export interface ProjectProjection {
  providerId: string; sourceId: string; revision: number; workingDir: string;
  snapshot: {title: string; goal: string; status: 'active'|'paused'|'completed'; stateLabel: string;
    phase: string; focus: string; remaining: string; blockers: string[]; board: string};
}
export function parseProjectProjection(value: unknown): ProjectProjection {
  const v=value as ProjectProjection;
  if(!v || typeof v!=='object' || !/^[a-z][a-z0-9._-]{1,40}$/.test(v.providerId ?? '')
    || typeof v.sourceId!=='string' || !v.sourceId || v.sourceId.length>240 || !Number.isSafeInteger(v.revision) || v.revision<1
    || typeof v.workingDir!=='string' || !v.workingDir.startsWith('/') || v.workingDir.includes('\0')
    || !v.snapshot || !['active','paused','completed'].includes(v.snapshot.status))throw Error('invalid_project_projection');
  for(const [key,max] of Object.entries({title:80,goal:500,stateLabel:80,phase:80,focus:1000,remaining:2000,board:64000})) {
    const text=v.snapshot[key as keyof typeof v.snapshot];
    if(typeof text!=='string' || text.length>max)throw Error('invalid_project_projection:'+key);
  }
  if(!Array.isArray(v.snapshot.blockers) || v.snapshot.blockers.length>50
    || v.snapshot.blockers.some(s=>typeof s!=='string' || s.length>1000))throw Error('invalid_project_projection:blockers');
  return structuredClone(v);
}
export async function applyProjectProjection(context: ProjectCoordinatorContext, input: ProjectProjection, deps: {
  mutate(fn:(current:ProjectGroupState|undefined)=>ProjectGroupState):Promise<ProjectGroupState|undefined>;
  publish(project:ProjectGroupState):Promise<ProjectGroupState>;
  writeBoard(input:ProjectProjection, hash:string):Promise<void>;
}) {
  const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let stale=false;
  const project=(await deps.mutate(current=>{
    if(current && (!current.projection || current.larkAppId!==context.larkAppId
      || current.projection.providerId!==input.providerId || current.projection.sourceId!==input.sourceId))throw Error('project_projection_owner_conflict');
    if(current?.projection) {
      if(current.projection.revision>input.revision){stale=true;return current;}
      if(current.projection.revision===input.revision) {
        if(current.projection.hash!==hash)throw Error('project_projection_revision_conflict');
        return current;
      }
    }
    const now=new Date().toISOString(),{board,stateLabel,...snapshot}=input.snapshot;
    return {...current,schemaVersion:1,revision:(current?.revision ?? 0)+1,chatId:context.chatId,larkAppId:context.larkAppId,
      coordinatorSessionId:context.coordinatorSessionId,...snapshot,blockers:[...snapshot.blockers],workstreams:[],milestones:[],
      createdAt:current?.createdAt ?? now,updatedAt:now,
      projection:{providerId:input.providerId,sourceId:input.sourceId,revision:input.revision,hash,stateLabel}};
  }))!;
  if(stale || project.projection?.appliedHash===hash)return project;
  await deps.writeBoard(input,hash);
  await deps.publish(project);
  return (await deps.mutate(current=>{
    if(!current || current.projection?.hash!==hash)throw Error('project_projection_changed');
    return {...current,projection:{...current.projection,appliedHash:hash}};
  }))!;
}
