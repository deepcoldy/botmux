import { RemoteRunnerTestHarness } from './helpers/remote-runner-harness.js';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import { registerBot } from '../src/bot-registry.js';
import { classifySlash } from '../src/core/command-router.js';
import { prepareLinkRefTurnPayload } from '../src/core/link-ref-turn.js';
import { admitDelegatedSlashTurn } from '../src/core/remote-runner-slash.js';
import { buildFollowUpCliInput } from '../src/core/session-manager.js';
import { deriveSessionPhase } from '../src/core/session-phase.js';
import { admitQueuedActivationTail, isResumeRecoveryPlaceholder } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { createLinkRefRuntime } from '../src/services/link-ref-runtime.js';
import type { LinkRefDiagnostic } from '../src/services/link-ref-types.js';
import * as sessionStore from '../src/services/session-store.js';

const harness = new RemoteRunnerTestHarness();
afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
});

describe('delegated command end-to-end contract', () => {
  it.each(['final', 'failure'])('rejects idle lineage after %s without overwriting the committed binding', async terminal => {
    const provider = join(harness.root(), 'late-provider.mjs');
    writeFileSync(provider, `import readline from 'node:readline';
const emit=e=>process.stdout.write(JSON.stringify({protocol:'botmux.remote-runner',version:1,...e})+'\\n');
let state={version:1,provider:'late',generation:1,remoteSessionId:'compute',agentThreadId:'old'};
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='hello')return emit({type:'hello',requestId:c.requestId,provider:'late',capabilities:['start','resume','turn','cancel','detach','reattach','status']});
 if(c.type==='start')return emit({type:'ready',requestId:c.requestId,state});
 if(c.type==='turn'){
  emit({type:'status',requestId:c.requestId,status:'busy',state});
  ${terminal === 'final' ? "state={...state,agentThreadId:'committed'};emit({type:'final',turnId:c.turnId,content:'bound',state});"
    : "emit({type:'failure',turnId:c.turnId,code:'rejected',message:'rejected',status:'failed',retryable:false});"}
  emit({type:'lineage_changed',state:{...state,agentThreadId:'late-uncommitted'}});
 }
});`);
    const backend = new RemoteRunnerBackend({ expectedProvider: 'late', delegatedSlashCommands: ['/adopt'] }, 'late');
    const states: string[] = [];
    backend.onBackendState(state => { if (state.agentThreadId) states.push(state.agentThreadId); });
    const exited = new Promise<void>(done => backend.onExit(() => done()));
    await harness.spawn(backend, provider);
    await backend.submitTurn({ turnId: 'bind', content: '/adopt alpha' });
    await exited;
    expect(backend.getBackendState()?.agentThreadId).toBe(terminal === 'final' ? 'committed' : 'old');
    expect(states).not.toContain('late-uncommitted');
  });

  it('preserves command bytes through queue restore, LinkRefs registration and the actual provider', async () => {
    registerBot({ larkAppId: 'cli_command_contract', larkAppSecret: 's', cliId: 'remote-runner',
      backendType: 'remote-runner', linkRefs: { mode: 'enabled' } });
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const caller = { requestUserOpenId: 'ou_operator', requestLarkAppId: 'cli_command_contract', senderType: 'user' as const };
    const diagnostics: LinkRefDiagnostic[] = [];
    const runtime = createLinkRefRuntime(harness.root(), { onDiagnostic: event => diagnostics.push(event) });
    try {
      const ds = { larkAppId: 'cli_command_contract', session: { sessionId: 'wire-command', cliId: 'remote-runner',
        backendType: 'remote-runner', status: 'active' } } as DaemonSession;
      const payload = buildFollowUpCliInput('/DISCONNECT', ds.session.sessionId, {
        cliId: 'remote-runner', larkAppId: ds.larkAppId, linkRefMode: 'enabled',
        acceptedInput: { content: '/DISCONNECT', trustedCaller: caller },
        sharedGroupContext: 'Read https://example.org/context',
      });
      admitQueuedActivationTail(ds, { userPrompt: '/DISCONNECT', turnId: 'unbind', cliInput: payload });
      const restored = JSON.parse(JSON.stringify(ds.session.queuedActivationTail![0]));
      expect(restored.cliInput.linkRefs.presentation).toBe('registry-only');
      const key = { appId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'unbind' };
      const prepared = prepareLinkRefTurnPayload({ runtime, key, mode: 'enabled', payload: restored.cliInput });
      expect(prepared.content).toBe('/DISCONNECT');
      expect(prepared.trustedCaller).toEqual(caller);
      expect(diagnostics.some(event => (event.registered ?? 0) > 0)).toBe(true);
      expect(runtime.restoreMode(key)).toBe('enabled');
      const backend = new RemoteRunnerBackend({ expectedProvider: 'reference', delegatedSlashCommands: ['/detach'] }, 'wire-command', {
        version: 1, provider: 'reference', generation: 1, remoteSessionId: 'reference:wire-command', agentThreadId: 'reference-thread:alpha',
      });
      await harness.spawn(backend, resolve('examples/remote-runner/reference-runner.mjs'));
      const final = new Promise<string>(done => backend.onTurnFinal(done));
      await backend.submitTurn({ turnId: 'unbind', content: prepared.content, trustedCaller: prepared.trustedCaller });
      await final;
      expect(backend.getBackendState()).not.toHaveProperty('agentThreadId');
      const ordinaryFinal = new Promise<string>(done => backend.onTurnFinal(done));
      await backend.submitTurn({ turnId: 'ordinary-after-detach', content: 'hello' });
      await ordinaryFinal;
      expect(backend.getBackendState()?.agentThreadId).toBe('reference-thread:ordinary-after-detach');
      const ordinary = prepareLinkRefTurnPayload({ runtime, key: { ...key, turnId: 'ordinary' }, mode: 'enabled',
        payload: { content: 'ordinary message', linkRefs: { mode: 'enabled', sources: [
          { sourceType: 'user_message', kind: 'text', text: 'https://example.org/ordinary' },
        ] } } });
      expect(ordinary.content).not.toBe('ordinary message');
    } finally { runtime.close(); }
  });

  it.each(['/detach', '/disconnect'])('does not admit %s against a command-only scratch session', async text => {
    const ds = { worker: null, pendingRepo: false, session: { sessionId: 'scratch', status: 'active',
      cliId: 'remote-runner', backendType: 'remote-runner' } } as DaemonSession;
    expect(isResumeRecoveryPlaceholder(ds)).toBe(true);
    const decision = classifySlash({ cliId: 'remote-runner', text, context: 'thread', phase: deriveSessionPhase(ds),
      sessionIsCommandScratch: isResumeRecoveryPlaceholder(ds), passthrough: new Set(), coldStartPassthrough: new Set(),
      senderIsBot: false, acceptSlashFromBots: true, delegatedCommands: new Set(['/adopt', '/detach']) });
    expect(decision.kind).toBe('delegated_turn');
    if (decision.kind !== 'delegated_turn') throw new Error('Wrong slash route');
    const replies: string[] = [];
    const accepted = await admitDelegatedSlashTurn(decision, { authorized: true, primary: false,
      larkAppId: 'cli_command_contract', reply: async value => { replies.push(value); } });
    expect(accepted).toBeUndefined();
    expect(replies).toHaveLength(1);
  });
});


it('allows compute lineage changes with equal business JSON in a different key order', async () => {
  const provider = join(harness.root(), 'compute-provider.mjs');
  writeFileSync(provider, `import readline from 'node:readline';
const emit=e=>process.stdout.write(JSON.stringify({protocol:'botmux.remote-runner',version:1,...e})+'\\n');
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='hello')emit({type:'hello',requestId:c.requestId,provider:'compute',capabilities:['start','resume','turn','cancel','detach','reattach','status']});
 if(c.type==='start'){
  const state={version:1,provider:'compute',generation:1,remoteSessionId:'compute:old',agentThreadId:'bound',providerState:{a:1,b:{x:2,y:3}}};
  emit({type:'ready',requestId:c.requestId,state});
  setTimeout(()=>emit({type:'lineage_changed',state:{...state,generation:2,remoteSessionId:'compute:new',providerState:{b:{y:3,x:2},a:1}}}),20);
 }
});`);
  const backend = new RemoteRunnerBackend({ expectedProvider: 'compute', delegatedSlashCommands: ['/adopt'] }, 'compute');
  const advanced = new Promise<void>((done, reject) => {
    backend.onBackendState(state => { if (state.generation === 2) done(); });
    backend.onExit(() => reject(new Error('Valid compute lineage was rejected')));
  });
  await harness.spawn(backend, provider);
  await advanced;
  expect(backend.getBackendState()).toMatchObject({ generation: 2, remoteSessionId: 'compute:new', agentThreadId: 'bound' });
});


it('admits detach for a restored provider snapshot even before the first conversation turn', async () => {
  const ds = { worker: null, pendingRepo: false, session: { sessionId: 'restored-empty', status: 'active',
    cliId: 'remote-runner', backendType: 'remote-runner', initialUserTurnPending: true,
    remoteBackendState: { version: 1, provider: 'reference', generation: 1, remoteSessionId: 'remote', agentThreadId: 'bound' },
  } } as DaemonSession;
  expect(isResumeRecoveryPlaceholder(ds)).toBe(true);
  const decision = classifySlash({ cliId: 'remote-runner', text: '/detach', context: 'thread', phase: deriveSessionPhase(ds),
    sessionIsCommandScratch: true, sessionHasBackendState: !!ds.session.remoteBackendState,
    passthrough: new Set(), coldStartPassthrough: new Set(), senderIsBot: false, acceptSlashFromBots: true,
    delegatedCommands: new Set(['/detach']) });
  expect(decision).toMatchObject({ kind: 'delegated_turn', sessionPolicy: 'existing' });
  if (decision.kind !== 'delegated_turn') throw new Error('Wrong slash route');
  let replies = 0;
  expect(await admitDelegatedSlashTurn(decision, { authorized: true, primary: false, larkAppId: 'cli_command_contract',
    reply: async () => { replies++; } })).toEqual({ content: '/detach' });
  expect(replies).toBe(0);
});
