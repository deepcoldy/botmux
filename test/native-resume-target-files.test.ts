import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseNativeResumeTarget, verifyNativeResumeTarget, nativeResumeTargetFailure } from '../src/services/native-resume-target.js';

const sourceId='00000000-0000-4000-8000-000000000001',targetId='00000000-0000-4000-8000-000000000002';
const timestamp='2026-11-17T00:00:00Z';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const encode=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const folders:string[]=[];
afterEach(()=>{for(const f of folders.splice(0))rmSync(f,{recursive:true,force:true});});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'native-target-files-'));folders.push(dir);
  const root=join(dir,'sessions');mkdirSync(root);
  const source=join(root,`${sourceId}.jsonl`),target=join(root,`${targetId}.jsonl`);
  const rows=[
    {type:'session_meta',payload:{id:sourceId,history_format:'canonical_v1'}},
    {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},
    {type:'history_mutation',timestamp,payload:{version:1,operation:'append',items:[{type:'message',role:'user',content:[{type:'input_text',text:'owned fixture'}]}]}},
    {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}},
  ];
  const copied=structuredClone(rows);Object.assign(copied[0].payload,{id:targetId,forked_from_id:sourceId});
  writeFileSync(source,encode(rows));writeFileSync(target,encode(copied));
  const request={sourceId,targetId,sourceSha256:sha(readFileSync(source)),targetSha256:sha(readFileSync(target))};
  return{dir,root,source,target,rows,copied,request,
    verify:()=>verifyNativeResumeTarget(request,{root,source,target}),
    sourceRows(next:unknown[]){writeFileSync(source,encode(next));request.sourceSha256=sha(readFileSync(source));},
    targetRows(next:unknown[]){writeFileSync(target,encode(next));request.targetSha256=sha(readFileSync(target));}};
}
describe('prepared native history copy validation',()=>{
  it('verifies exact bytes and leaves both files untouched across repeated checks',()=>{
    const f=fixture(),before=[readFileSync(f.source),readFileSync(f.target)];
    f.verify();f.verify();
    expect(readFileSync(f.source)).toEqual(before[0]);expect(readFileSync(f.target)).toEqual(before[1]);
  });
  it('manual source mutation between the two checks is refused',()=>{
    const f=fixture();f.verify();
    writeFileSync(f.source,encode([...f.rows,{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'manual'}}]));
    expect(f.verify).toThrow('native_resume_history_changed');
  });
  it('a half-written target cannot be adopted even if the caller hashes the partial bytes',()=>{
    const f=fixture();const broken=readFileSync(f.target).subarray(0,-3);writeFileSync(f.target,broken);
    f.request.targetSha256=sha(broken);expect(f.verify).toThrow('native_resume_history_incomplete');
  });
  it.each(['source','target']as const)('rejects an unterminated %s conversation',which=>{
    const f=fixture(),rows=which==='source'?f.rows:f.copied;
    const changed=[...rows,{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'active'}}];
    if(which==='source')f.sourceRows(changed);else f.targetRows(changed);
    expect(f.verify).toThrow('native_resume_history_not_terminal');
  });
  it('an old or auxiliary terminal cannot close a newer open turn',()=>{
    const f=fixture();f.sourceRows([...f.rows,
      {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'current'}},
      {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'previous'}}]);
    expect(f.verify).toThrow('native_resume_history_not_terminal');
  });
  it('a parallel nested start cannot erase an earlier unfinished turn',()=>{
    const f=fixture();
    const [header,start,mutation,complete]=f.rows as any[];
    const nested=(type:string,turnId:string)=>({type:'event_msg',timestamp,
      payload:{type,turn_id:turnId,root_turn_id:'turn'}});
    f.sourceRows([header,start,mutation,
      nested('task_started','child-still-open'),nested('task_started','child-finished'),
      nested('task_complete','child-finished'),complete]);
    expect(f.verify).toThrow('native_resume_history_not_terminal');
  });
  it('terminal records require an actual turn identity and timestamp',()=>{
    for(const patch of [{timestamp:undefined},{payload:{type:'task_complete'}}]){
      const f=fixture();const rows=structuredClone(f.rows);Object.assign(rows.at(-1)!,patch);
      f.sourceRows(rows);expect(f.verify).toThrow('native_resume_history_not_terminal');
    }
  });
  it('rejects a changed target, mismatched header and unrelated lineage',()=>{
    const f=fixture();f.verify();writeFileSync(f.target,encode(f.rows));
    expect(f.verify).toThrow('native_resume_history_changed');
    f.request.targetSha256=sha(readFileSync(f.target));expect(f.verify).toThrow('native_resume_history_identity');
    const rows=structuredClone(f.copied);Object.assign(rows[0].payload,{forked_from_id:targetId});
    f.targetRows(rows);expect(f.verify).toThrow('native_resume_history_lineage');
  });
  it('rejects direct and symlink escapes, including a root-prefix sibling',()=>{
    const f=fixture(),outside=join(f.dir,'sessions-outside');mkdirSync(outside);
    const file=join(outside,'target.jsonl');writeFileSync(file,readFileSync(f.target));
    expect(()=>verifyNativeResumeTarget(f.request,{root:f.root,source:f.source,target:file})).toThrow('outside_root');
    rmSync(f.target);symlinkSync(file,f.target);expect(f.verify).toThrow('outside_root');
  });
  it('guards file size before allocating the full input',()=>{
    const f=fixture();truncateSync(f.target,65*1024*1024);expect(f.verify).toThrow('history_size');
  });
  it('rejects mixed formats and malformed mutation operations',()=>{
    const f=fixture();f.targetRows([...f.copied,{type:'response_item',payload:{}}]);
    expect(f.verify).toThrow('history_format');
    const rows=structuredClone(f.copied);Object.assign(rows[2].payload,{operation:'unknown'});
    f.targetRows(rows);expect(f.verify).toThrow('history_format');
  });
  it('uses strict string fields, not array/object/number coercion, and rejects extra authority',()=>{
    const f=fixture();
    for(const value of [{...f.request,sourceId:[sourceId]},{...f.request,targetSha256:[f.request.targetSha256]},
      {...f.request,targetId:sourceId},{...f.request,prompt:'replay'},{...f.request,sourcePath:'/outside'},null,[]]){
      expect(()=>parseNativeResumeTarget(value)).toThrow('invalid_native_resume_target');
    }
  });
  it('failure projection never returns private path or JSON contents',()=>{
    expect(nativeResumeTargetFailure(new Error('ENOENT /private/secret'))).toBe('native_resume_target_unavailable');
    expect(nativeResumeTargetFailure(new SyntaxError('private JSON'))).toBe('native_resume_target_unavailable');
    expect(nativeResumeTargetFailure(new Error('native_resume_history_changed'))).toBe('native_resume_history_changed');
  });
});
