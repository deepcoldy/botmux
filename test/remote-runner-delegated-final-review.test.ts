import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type { RemoteRunnerBackendState } from '../src/adapters/backend/remote-runner-protocol.js';
const backends: RemoteRunnerBackend[] = [];
const dirs: string[] = [];
afterEach(() => { backends.splice(0).forEach(b => b.kill()); dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})); });
function probe(mode: 'usage' | 'recovery') {
 const dir=mkdtempSync(join(tmpdir(),'botmux-final-review-')); dirs.push(dir);
 const provider=join(dir,'provider.mjs');
 writeFileSync(provider, `import readline from 'node:readline';
 const emit=e=>process.stdout.write(JSON.stringify({protocol:'botmux.remote-runner',version:1,...e})+'\\n');
 let state={version:1,provider:'review',generation:1,remoteSessionId:'compute',agentThreadId:'old'};
 const reject=()=>{state={...state,agentThreadId:'uncommitted'};emit({type:'lineage_changed',state});emit({type:'failure',turnId:'adopt',code:'reject',message:'reject',status:'failed',retryable:false});};
 readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='hello')return emit({type:'hello',requestId:c.requestId,provider:'review',capabilities:['start','resume','turn','cancel','detach','reattach','status','turn_recovery']});
 if(c.type==='resume'){emit({type:'ready',requestId:c.requestId,state,recoveredTurn:{turnId:'adopt',generation:1}});setTimeout(reject,20);return;}
 if(c.type==='start')return emit({type:'ready',requestId:c.requestId,state});
 if(c.type==='turn'){emit({type:'status',requestId:c.requestId,status:'busy',state});emit({type:'final',turnId:c.turnId,content:'bound',state:{...state,agentThreadId:'uncommitted'},usage:{generation:2,snapshot:{context:null,tokens:null}}});}
 });`);
 const initial: RemoteRunnerBackendState={version:1,provider:'review',generation:1,remoteSessionId:'compute',agentThreadId:'old'};
 const backend=new RemoteRunnerBackend({expectedProvider:'review',delegatedSlashCommands:['/adopt','/detach']},'review',mode==='recovery'?initial:undefined);backends.push(backend);
 const states: RemoteRunnerBackendState[]=[];backend.onBackendState(s=>states.push(structuredClone(s)));
 backend.onTurnRecovered(t=>backend.setRecoveredTurnHostContext(t.turnId,{}));
 const failed=new Promise<void>(resolve=>backend.onTurnFailure(()=>resolve()));
 const ready=new Promise<void>(resolve=>backend.onReady(resolve));
 backend.spawn(process.execPath,[provider],{cwd:process.cwd(),cols:80,rows:24,env:{...process.env} as Record<string,string>});
 return {backend,states,failed,ready};
}
describe('delegated final publication review',()=>{
 it('does not publish binding from a final rejected for a mismatched usage generation',async()=>{
  const {backend,states,failed,ready}=probe('usage');await ready;
  await backend.submitTurn({turnId:'adopt',content:'/adopt new'});await failed;
  expect(states.at(-1)?.agentThreadId).toBe('old');
 });
 it('keeps final-only binding fence after recovering an in-flight delegated turn',async()=>{
  const {states,failed,ready}=probe('recovery');await ready;await failed;
  expect(states.at(-1)?.agentThreadId).toBe('old');
 });
});
