import { RemoteRunnerTestHarness } from './helpers/remote-runner-harness.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type { RemoteRunnerBackendState } from '../src/adapters/backend/remote-runner-protocol.js';
const harness = new RemoteRunnerTestHarness();
afterEach(() => harness.dispose());
function probe(mode: 'usage' | 'recovery', delegationEnabled = true) {
 const dir=harness.root();
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
 const backend=new RemoteRunnerBackend({expectedProvider:'review',...(delegationEnabled ? {delegatedSlashCommands:['/adopt','/detach'] as Array<'/adopt' | '/detach'>} : {})},'review',mode==='recovery'?initial:undefined);
 const states: RemoteRunnerBackendState[]=[];backend.onBackendState(s=>states.push(structuredClone(s)));
 backend.onTurnRecovered(t=>backend.setRecoveredTurnHostContext(t.turnId,{}));
 const failed=new Promise<void>(resolve=>backend.onTurnFailure(()=>resolve()));
 const ready=harness.spawn(backend,provider);
 return {backend,states,failed,ready};
}
describe('delegated final publication review',()=>{
 it.each(['/adopt new', 'hello'])('does not publish binding from invalid final usage for %s',async content=>{
  const {backend,states,failed,ready}=probe('usage');await ready;
  await backend.submitTurn({turnId:'adopt',content});await failed;
  expect(states.at(-1)?.agentThreadId).toBe('old');
 });
 it('preserves the existing non-delegated final publication order',async()=>{
  const {backend,states,failed,ready}=probe('usage',false);await ready;
  await backend.submitTurn({turnId:'ordinary',content:'hello'});await failed;
  expect(states.at(-1)?.agentThreadId).toBe('uncommitted');
 });
 it('keeps final-only binding fence after recovering an in-flight delegated turn',async()=>{
  const {states,failed,ready}=probe('recovery');await ready;await failed;
  expect(states.at(-1)?.agentThreadId).toBe('old');
 });
});

function writeProvider(name: string, body: string): string {
  const provider = join(harness.root(), name);
  writeFileSync(provider, `import readline from 'node:readline';
const emit=e=>process.stdout.write(JSON.stringify({protocol:'botmux.remote-runner',version:1,...e})+'\\n');
let state={version:1,provider:'review',generation:1,remoteSessionId:'compute',agentThreadId:'bound',providerState:{adoptCandidates:['a']}};
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='hello')return emit({type:'hello',requestId:c.requestId,provider:'review',capabilities:['start','resume','turn','cancel','detach','reattach','status']});
 ${body}
});`);
  return provider;
}
const delegation = (enabled: boolean) => enabled ? { delegatedSlashCommands: ['/adopt', '/detach'] as Array<'/adopt' | '/detach'> } : {};

describe('delegated binding guard boundaries', () => {
  it.each([true, false])('treats a providerState-only lineage change as a binding change (delegation=%s)', async enabled => {
    const provider = writeProvider('selection.mjs', `if(c.type==='start')return emit({type:'ready',requestId:c.requestId,state});
 if(c.type==='turn'){emit({type:'status',requestId:c.requestId,status:'busy',state});
  emit({type:'lineage_changed',state:{...state,providerState:{adoptCandidates:['a','b']}}});
  emit({type:'final',turnId:c.turnId,content:'listed',state});}`);
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review', ...delegation(enabled) }, 'selection');
    const published: string[] = [];
    backend.onBackendState(state => published.push(JSON.stringify(state.providerState)));
    const exited = new Promise<'exit'>(done => backend.onExit(() => done('exit')));
    const final = new Promise<'final'>(done => backend.onTurnFinal(() => done('final')));
    await harness.spawn(backend, provider);
    await backend.submitTurn({ turnId: 'list', content: '/adopt' });
    expect(await Promise.race([exited, final])).toBe(enabled ? 'exit' : 'final');
    expect(published.includes(JSON.stringify({ adoptCandidates: ['a', 'b'] }))).toBe(!enabled);
  });

  it('lets resume ready reconcile a binding the host had not persisted yet', async () => {
    const provider = writeProvider('resume.mjs', `if(c.type==='resume')return emit({type:'ready',requestId:c.requestId,state:{...c.state,agentThreadId:'committed-before-crash',providerState:{adoptCandidates:['a','b']}}});
 if(c.type==='turn'){emit({type:'status',requestId:c.requestId,status:'busy',state});emit({type:'final',turnId:c.turnId,content:'ok',state:{...c.state}});}`);
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review', ...delegation(true) }, 'resume', {
      version: 1, provider: 'review', generation: 1, remoteSessionId: 'compute', agentThreadId: 'old' });
    const exited = new Promise<'exit'>(done => backend.onExit(() => done('exit')));
    expect(await Promise.race([harness.spawn(backend, provider).then(() => 'ready' as const), exited])).toBe('ready');
    expect(backend.getBackendState()).toMatchObject({ agentThreadId: 'committed-before-crash',
      providerState: { adoptCandidates: ['a', 'b'] } });
  });

  it.each([true, false])('publishes usage for the generation a valid final advances to (delegation=%s)', async enabled => {
    const provider = writeProvider('advance.mjs', `if(c.type==='start')return emit({type:'ready',requestId:c.requestId,state});
 if(c.type==='turn'){emit({type:'status',requestId:c.requestId,status:'busy',state});
  state={...state,generation:2,remoteSessionId:'compute:2'};
  emit({type:'final',turnId:c.turnId,content:'moved',state,usage:{generation:2,snapshot:{context:null,tokens:null}}});}`);
    const backend = new RemoteRunnerBackend({ expectedProvider: 'review', ...delegation(enabled) }, 'advance');
    const usages: number[] = [];
    backend.onUsageSnapshot(usage => usages.push(usage.generation));
    const exited = new Promise<'exit'>(done => backend.onExit(() => done('exit')));
    const final = new Promise<'final'>(done => backend.onTurnFinal(() => done('final')));
    await harness.spawn(backend, provider);
    await backend.submitTurn({ turnId: 'advance', content: 'hello' });
    expect(await Promise.race([exited, final])).toBe('final');
    expect(usages).toEqual([2]);
    expect(backend.getBackendState()).toMatchObject({ generation: 2, remoteSessionId: 'compute:2', agentThreadId: 'bound' });
  });
});
