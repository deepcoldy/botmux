import { RemoteRunnerTestHarness } from './helpers/remote-runner-harness.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRunnerBackend } from '../src/adapters/backend/remote-runner-backend.js';
import type { RemoteRunnerBackendState } from '../src/adapters/backend/remote-runner-protocol.js';
import { stagePendingRepoSetup, restorePendingRepoRuntime, persistPendingRepoCardMessageId } from '../src/core/pending-repo-journal.js';
import { buildNewTopicCliInput } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';

const harness = new RemoteRunnerTestHarness();
afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
});

function runtime(): DaemonSession {
  return {
    session: { sessionId: 'review-delegated', chatId: 'oc_review', rootMessageId: 'om_root',
      title: 'review', status: 'active', createdAt: '2026-01-01T00:00:00Z', cliId: 'remote-runner', backendType: 'remote-runner' },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'cli_review', chatId: 'oc_review',
    chatType: 'group', scope: 'thread', spawnedAt: 1, cliVersion: 'review', lastMessageAt: 1, hasHistory: false,
    pendingPrompt: '/adopt alpha', pendingAcceptedInput: { content: '/adopt alpha', trustedCaller: { requestUserOpenId: 'ou_actor', requestLarkAppId: 'cli_review', senderType: 'user' } }, pendingTurnId: 'om_adopt',
    pendingTrustedCaller: { requestUserOpenId: 'ou_actor', requestLarkAppId: 'cli_review', senderType: 'user' },
  } as DaemonSession;
}

function startProvider(mode: string) {
  const dir = harness.root();
  const fixture = join(dir, 'provider.mjs');
  const release = join(dir, 'release');
  const seen = join(dir, 'seen.jsonl');
  writeFileSync(fixture, `import readline from 'node:readline';
import fs from 'node:fs';
const emit = event => process.stdout.write(JSON.stringify({protocol:'botmux.remote-runner',version:1,...event})+'\\n');
let state = { version:1, provider:'review', generation:1, remoteSessionId:'compute', agentThreadId:'old' };
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line', line => {
 const c=JSON.parse(line); fs.appendFileSync(${JSON.stringify(seen)},JSON.stringify(c)+'\\n');
 if(c.type==='hello') return emit({type:'hello',requestId:c.requestId,provider:'review',capabilities:['start','resume','turn','cancel','detach','reattach','status']});
 if(c.type==='start'||c.type==='resume') {if(c.state)state=c.state; return emit({type:'ready',requestId:c.requestId,state});}
 if(c.type==='turn') {
   emit({type:'status',requestId:c.requestId,status:'busy',state});
   emit({type:'progress',turnId:c.turnId,content:'waiting'});
   ${mode === 'early-state' ? `state={...state,agentThreadId:'uncommitted'};
   emit({type:'lineage_changed',state});
   emit({type:'failure',turnId:c.turnId,code:'rejected',message:'binding rejected',status:'failed',retryable:false});` : `const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);state={...state,agentThreadId:'committed'};emit({type:'final',turnId:c.turnId,content:'bound',state});},5);`}
   return;
 }
 if(c.type==='detach')return emit({type:'status',requestId:c.requestId,status:'detached',state});
 if(c.type==='reattach')return emit({type:'status',requestId:c.requestId,status:'ready',state});
 if(c.type==='cancel')return emit({type:'status',requestId:c.requestId,status:'closed',state});
 if(c.type==='status')return emit({type:'status',requestId:c.requestId,status:'ready',state});
});`);
  const backend = new RemoteRunnerBackend({ expectedProvider: 'review', operationTimeoutMs: 1000,
    delegatedSlashCommands: ['/adopt', '/detach'] }, 'review-session');
  const ready = harness.spawn(backend, fixture);
  return { backend, ready, release, commands: () => readFileSync(seen, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

describe('delegated slash abnormal-boundary review', () => {
  it('keeps trusted caller across a pending-repo journal restart', () => {
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const ds = runtime();
    stagePendingRepoSetup(ds, { mode: 'picker', turnId: ds.pendingTurnId, linkRefMode: 'disabled' });
    const restored = { ...runtime(), session: JSON.parse(JSON.stringify(ds.session)), pendingTrustedCaller: undefined };
    expect(restorePendingRepoRuntime(restored)).toBe(true);
    const payload = buildNewTopicCliInput(restored.pendingPrompt!, restored.session.sessionId, 'remote-runner',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { acceptedInput: restored.pendingAcceptedInput, trustedCaller: restored.pendingTrustedCaller });
    expect(payload.content).toBe('/adopt alpha');
    expect(payload.trustedCaller).toEqual(ds.pendingTrustedCaller);
  });

  it('restores the durable command after only the setup write succeeded', () => {
    let persisted: any;
    vi.spyOn(sessionStore, 'updateSession').mockImplementationOnce(session => { persisted = JSON.parse(JSON.stringify(session)); })
      .mockImplementationOnce(() => { throw new Error('card persistence unavailable'); });
    const ds = runtime();
    stagePendingRepoSetup(ds, { mode: 'picker', turnId: 'om_adopt', linkRefMode: 'disabled' });
    expect(() => persistPendingRepoCardMessageId(ds, 'om_picker')).toThrow('card persistence unavailable');
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBeUndefined();
    const restored = { ...runtime(), session: persisted, pendingAcceptedInput: undefined };
    expect(restorePendingRepoRuntime(restored)).toBe(true);
    expect(restored.pendingAcceptedInput?.content).toBe('/adopt alpha');
    expect(restored.repoCardMessageId).toBeUndefined();
  });

  it('does not persist a rejected adopt binding before final', async () => {
    const { backend, ready } = startProvider('early-state');
    const states: RemoteRunnerBackendState[] = [];
    backend.onBackendState(state => states.push(state));
    await ready;
    const failed = new Promise<void>(resolve => backend.onTurnFailure(() => resolve()));
    expect(await backend.submitTurn({ turnId: 'om_adopt', content: '/adopt new',
      trustedCaller: runtime().pendingTrustedCaller })).toEqual({ submitted: true });
    await failed;
    expect(states.at(-1)?.agentThreadId).toBe('old');
  });

  it('fences a provider final after an operator kills its waiting worker', async () => {
    const { backend, ready, release } = startProvider('release');
    const states: RemoteRunnerBackendState[] = [];
    backend.onBackendState(state => states.push(state));
    const final = vi.fn();
    backend.onTurnFinal(final);
    await ready;
    await backend.submitTurn({ turnId: 'om_adopt', content: '/adopt new' });
    backend.kill();
    writeFileSync(release, 'go');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(final).not.toHaveBeenCalled();
    expect(states.at(-1)?.agentThreadId).toBe('old');
  });

  it('drains a long adopt before shutdown detach and resumes the committed binding', async () => {
    const { backend, ready, release, commands } = startProvider('release');
    await ready;
    await backend.submitTurn({ turnId: 'om_adopt', content: '/adopt new' });
    const detach = backend.prepareShutdownDetach(1000);
    await Promise.resolve();
    expect(commands().filter(c => c.type === 'detach')).toHaveLength(0);
    writeFileSync(release, 'go');
    const outcome = await detach;
    expect(outcome.ok).toBe(true);
    expect(commands().map(c => c.type)).toContain('detach');
    const next = new RemoteRunnerBackend({ expectedProvider: 'reference' }, 'review-session', {
      version: 1, provider: 'reference', generation: 1, remoteSessionId: 'reference:review-session', agentThreadId: 'committed',
    });
    const restoredStates: RemoteRunnerBackendState[] = [];
    next.onBackendState(state => restoredStates.push(state));
    await harness.spawn(next, 'examples/remote-runner/reference-runner.mjs');
    expect(restoredStates.at(-1)?.agentThreadId).toBe('committed');
  });
});
