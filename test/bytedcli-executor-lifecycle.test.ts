import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { BytedcliCredentialResolver } from '../src/core/bytedcli-broker-credentials.js';
import { BytedcliBrokerError } from '../src/core/bytedcli-broker-process.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => release = resolve); return { promise, release }; }
const drain = () => new Promise<void>(resolve => setTimeout(resolve, 15));
const read = () => parseBytedcliOperation(['codebase', 'repo', 'get', 'org/repo']);
const write = () => parseBytedcliOperation(['codebase', 'mr', 'close', '1', '--repo', 'org/repo']);
const empty = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
function setup(leases: any, run: any = async () => empty) {
  const root = mkdtempSync(join(tmpdir(), 'broker-lifecycle-')); roots.push(root);
  const executor = new BytedcliExecutor({ privateRoot: root, leases, run,
    trustedCli: async () => ({ executable: '/trusted/node', prefixArgs: ['/trusted/cli.js'], path: '/usr/bin:/bin', version: '0.199.0', stillCurrent: () => true }),
    audit: { append: async () => undefined } });
  const authority = { daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', workerGeneration: 1,
    dispatchAttempt: 1, policyFingerprint: 'policy', recheck: async () => undefined,
    actor: { verifiedEmail: 'person@example.test', credentialOpenId: 'ou_person', unionId: 'on_person', source: 'platform' as const } };
  const request = (operation = read(), requestId = 'request', extra: any = {}) => ({ authority, operation, requestId, ...extra });
  return { executor, request, authority };
}
async function fillRetainedCache(s: ReturnType<typeof setup>) {
  for (let id = 0; id < 8192; id++) {
    if ((await s.executor.execute(s.request(read(), 'cache-' + id))).errorCode === 'busy') return;
  }
  throw new Error('response cache did not remain bounded');
}
function platformProvider() {
  let active = 0; let maximum = 0; const pending: Array<{ gate: ReturnType<typeof deferred>; signal: AbortSignal }> = [];
  const resolver = new BytedcliCredentialResolver({ machineHome: '/trusted/home', localHome: () => '/trusted/person',
    localQueue: async (_id, run) => run(), readEpoch: () => 0, epochAllows: () => true,
    provider: { observe: async () => ({ authenticated: false }), mint: async () => undefined, userinfo: async () => { throw new Error('unexpected userinfo'); } },
    platform: { bindingKey: () => 'binding', resolve: async request => {
      const gate = deferred(); pending.push({ gate, signal: request.signal }); active++; maximum = Math.max(maximum, active);
      try { await gate.promise; return undefined; } finally { active--; }
    } } });
  return { resolver, pending, active: () => active, maximum: () => maximum, release: () => pending.forEach(item => item.gate.release()) };
}
describe('underlying broker work ownership', () => {
  it('bounds retained dispatched-write fences across policy changes and frees them only for a genuine successor', async () => {
    let dispatches = 0;
    const lease = { jwt:'fake-only',kind:'actor',region:'cn',expiresAt:Date.now()+120_000,accountFingerprint:'sha256:actor',source:'local',stillCurrent:async()=>undefined };
    const s = setup({actor:async()=>lease,machine:async()=>{throw new Error('no machine');}},async()=>{dispatches++;return empty;});
    let retained = 0;
    for (;retained<8192;retained++) {
      const result=await s.executor.execute(s.request(write(),`fenced-${retained}`));
      if(result.errorCode==='busy')break;
      expect(result.outcome).toBe('completed');
    }
    expect(retained).toBe(4096);expect(dispatches).toBe(4096);
    const changed={...s.authority,policyFingerprint:'policy-new'};
    expect((await s.executor.execute(s.request(write(),'fresh',{authority:changed}))).errorCode).toBe('busy');
    expect((await s.executor.execute(s.request(write(),'fenced-0',{authority:changed}))).outcome).toBe('write_outcome_unknown');expect(dispatches).toBe(4096);
    const successor={...changed,turnId:'explicit-next-turn',workerGeneration:2};
    expect((await s.executor.execute(s.request(write(),'fenced-0',{authority:successor}))).outcome).toBe('completed');
    await s.executor.close();expect(dispatches).toBe(4097);
  }, 20_000);
  it('admits an authorized successor after the previous frozen tuple fills the retained response cache', async () => {
    let renewed = false; let dispatches = 0;
    const lease = { jwt: 'fake-only', kind: 'machine' as const, region: 'cn' as const, expiresAt: Date.now() + 60_000,
      accountFingerprint: 'sha256:machine', source: 'machine' as const, stillCurrent: async () => undefined };
    const s = setup({ machine: async () => { if (!renewed) throw new BytedcliBrokerError('machine_auth_required'); return lease; }, actor: async () => { throw new Error('unexpected actor'); } }, async () => { dispatches++; return empty; });
    await fillRetainedCache(s);
    renewed = true;
    const next = await s.executor.execute(s.request(read(), 'successor', { authority: { ...s.authority, workerGeneration: 2, turnId: 'next-turn' } }));
    await s.executor.close();
    expect(next.outcome).toBe('completed'); expect(dispatches).toBe(1);
  });
  it.each(['denied', 'timeout'] as const)('cleans a %s full-cache placeholder after owned authority settlement and admits an explicit successor', async mode => {
    const gate = deferred(); let checks = 0; let renewed = false; let dispatches = 0;
    const lease = { jwt: 'fake-only', kind: 'actor', region: 'cn', expiresAt: Date.now() + 60_000,
      accountFingerprint: 'sha256:actor', source: 'local', stillCurrent: async () => undefined };
    const s = setup({ machine: async () => { throw new BytedcliBrokerError('machine_auth_required'); },
      actor: async () => { if (!renewed) throw new Error('placeholder reached credential resolution'); return lease; } }, async () => { dispatches++; return empty; });
    await fillRetainedCache(s);
    const authority = { ...s.authority, workerGeneration: 2, turnId: 'placeholder-turn', recheck: async () => {
      checks++; if (mode === 'timeout') await gate.promise; return 'permission_denied' as const;
    } };
    const request = s.request({ ...write(), timeoutMs: 25 }, 'placeholder', { authority });
    expect((await s.executor.execute(request)).errorCode).toBe(mode === 'timeout' ? 'timeout' : 'permission_denied');
    if (mode === 'timeout') expect((await s.executor.execute(request)).errorCode).toBe('timeout');
    expect(checks).toBe(1); expect(dispatches).toBe(0);
    gate.release(); await drain(); renewed = true;
    const successor = await s.executor.execute(s.request(write(), 'explicit-successor', { authority: { ...s.authority, workerGeneration: 3, turnId: 'successor-turn' } }));
    await s.executor.close(); expect(successor.outcome).toBe('completed'); expect(dispatches).toBe(1);
  });
  it.each(['close', 'retireSession'] as const)('binds repeated IDs and joins the initial authority wait after timeout during %s', async method => {
    const gate = deferred(); let active = 0; let maximum = 0; let dispatches = 0;
    const s = setup({ machine: async () => { throw new Error('unexpected lease'); }, actor: async () => { throw new Error('unexpected lease'); } }, async () => { dispatches++; return empty; });
    const authority = { ...s.authority, recheck: async () => { active++; maximum = Math.max(maximum, active); try { await gate.promise; } finally { active--; } } };
    const responses = [];
    for (let id = 0; id < 5; id++) responses.push(await s.executor.execute(s.request({ ...write(), timeoutMs: 25 }, 'same-id', { authority })));
    let closed = false; const stop = (method === 'close' ? s.executor.close() : s.executor.retireSession('session', 1)).then(() => closed = true);
    await drain(); const premature = closed; const retained = active;
    gate.release(); await stop;
    expect(responses.every(response => response.errorCode === 'timeout')).toBe(true);
    expect(retained).toBe(1); expect(maximum).toBe(1); expect(premature).toBe(false); expect(dispatches).toBe(0);
  });
  it.each(['cancel', 'timeout'])('keeps a personal write slot until platform cleanup actually ends after %s', async mode => {
    const provider = platformProvider(); let dispatches = 0; const s = setup(provider.resolver, async () => { dispatches++; return empty; });
    const abort = new AbortController(); const first = s.executor.execute(s.request({ ...write(), timeoutMs: mode === 'timeout' ? 35 : 1000 }, 'first', { signal: abort.signal }));
    await drain(); if (mode === 'cancel') abort.abort(); expect((await first).errorCode).toBe(mode === 'cancel' ? 'cancelled' : 'timeout');
    const secondAbort = new AbortController(); const second = s.executor.execute(s.request(write(), 'second', { signal: secondAbort.signal }));
    await drain(); const active = provider.active(); secondAbort.abort(); await second;
    let closed = false; const close = s.executor.close().then(() => closed = true); await drain(); const closedBeforeCleanup = closed;
    const sawAbort = provider.pending.every(item => item.signal.aborted); provider.release(); await close;
    expect(active).toBe(1); expect(provider.maximum()).toBe(1); expect(closedBeforeCleanup).toBe(false);
    expect(sawAbort).toBe(true); expect(provider.active()).toBe(0); expect(dispatches).toBe(0);
  });
  it('keeps the four daemon write slots occupied while cancelled platform grants finish cleanup', async () => {
    const provider = platformProvider(); const s = setup(provider.resolver);
    for (let id = 0; id < 4; id++) {
      const abort = new AbortController(); const execution = s.executor.execute(s.request(write(), `r${id}`, { authority: { ...s.authority, sessionId: `s${id}` }, signal: abort.signal }));
      await drain(); abort.abort(); await execution;
    }
    const abort = new AbortController(); const fifth = s.executor.execute(s.request(write(), 'fifth', { authority: { ...s.authority, sessionId: 's5' }, signal: abort.signal }));
    await drain(); const active = provider.active(); abort.abort(); await fifth;
    let closed = false; const close = s.executor.close().then(() => closed = true); await drain(); const premature = closed;
    provider.release(); await close; expect(active).toBe(4); expect(provider.maximum()).toBe(4); expect(premature).toBe(false); expect(provider.active()).toBe(0);
  });
});
describe('replay lifecycle registration', () => {
  it('allows a follower to cancel without aborting its primary provider or business process', async () => {
    const gate = deferred(); let primarySignal: AbortSignal | undefined;
    const lease = { jwt: 'fake-only', kind: 'machine', region: 'cn', expiresAt: Date.now() + 60_000,
      accountFingerprint: 'sha256:machine', source: 'machine', stillCurrent: async () => undefined };
    const s = setup({ machine: async () => lease, actor: async () => { throw new Error('unexpected actor'); } }, async (invocation: any) => {
      primarySignal = invocation.signal; await gate.promise; return empty;
    });
    const primary = s.executor.execute(s.request()); await drain(); const abort = new AbortController();
    const follower = s.executor.execute(s.request(read(), 'request', { signal: abort.signal })); await drain(); abort.abort();
    expect((await follower).errorCode).toBe('cancelled'); expect(primarySignal?.aborted).toBe(false);
    gate.release(); expect((await primary).outcome).toBe('completed'); await s.executor.close();
  });
  it.each(['close', 'retireSession'])('aborts and joins replay credential cleanup during %s', async method => {
    const gate = deferred(); let signal: AbortSignal | undefined; let active = 0;
    const lease = { jwt: 'fake-only', kind: 'machine', region: 'cn', expiresAt: Date.now() + 60_000, accountFingerprint: 'sha256:machine', source: 'machine',
      stillCurrent: async (replaySignal?: AbortSignal) => { if (replaySignal) { signal = replaySignal; active++; try { await gate.promise; } finally { active--; } } } };
    const s = setup({ machine: async () => lease, actor: async () => { throw new Error('unexpected actor'); } });
    expect((await s.executor.execute(s.request())).outcome).toBe('completed');
    const replay = s.executor.execute(s.request()); await drain();
    let stopped = false; const stop = (method === 'close' ? s.executor.close() : s.executor.retireSession('session')).then(() => stopped = true);
    await drain(); const aborted = signal?.aborted; const premature = stopped; const response = await Promise.race([replay, drain().then(() => ({ errorCode: 'hung' }))]);
    gate.release(); await replay; await stop;
    expect(aborted).toBe(true); expect(premature).toBe(false); expect(response.errorCode).toBe('cancelled'); expect(active).toBe(0);
  });
  it.each(['close', 'retireSession'])('settles a follower waiting for its primary during %s', async method => {
    const gate = deferred(); const lease = { jwt: 'fake-only', kind: 'machine', region: 'cn', expiresAt: Date.now() + 60_000,
      accountFingerprint: 'sha256:machine', source: 'machine', stillCurrent: async () => undefined };
    const s = setup({ machine: async () => lease, actor: async () => { throw new Error('unexpected actor'); } }, async () => { await gate.promise; return empty; });
    const primary = s.executor.execute(s.request()); await drain(); const follower = s.executor.execute(s.request()); await drain();
    let stopped = false; const stop = (method === 'close' ? s.executor.close() : s.executor.retireSession('session')).then(() => stopped = true);
    await drain(); const response = await Promise.race([follower, drain().then(() => ({ errorCode: 'hung' }))]); const premature = stopped;
    gate.release(); await primary; await follower; await stop; expect(response.errorCode).toBe('cancelled'); expect(premature).toBe(false);
  });
  it.each(['close', 'retireSession'])('settles a replay waiting for quota during %s', async method => {
    const gate = deferred(); let revalidations = 0;
    const lease = { jwt: 'fake-only', kind: 'actor', region: 'cn', expiresAt: Date.now() + 60_000, accountFingerprint: 'sha256:actor', source: 'platform',
      stillCurrent: async (signal?: AbortSignal) => { if (signal) revalidations++; } };
    const s = setup({ actor: async () => lease, machine: async () => { throw new Error('unexpected machine'); } }, async (invocation: any) => {
      if (invocation.argv.includes('reopen')) await gate.promise; return empty;
    });
    const cached = s.request(write(), 'cached'); await s.executor.execute(cached);
    const blocker = s.executor.execute(s.request(parseBytedcliOperation(['codebase', 'mr', 'reopen', '1', '--repo', 'org/repo']), 'blocker'));
    await drain(); const replay = s.executor.execute(cached); await drain();
    const stop = method === 'close' ? s.executor.close() : s.executor.retireSession('session'); await drain();
    const response = await Promise.race([replay, drain().then(() => ({ errorCode: 'hung' }))]); gate.release(); await blocker; await replay; await stop;
    expect(response.errorCode).toBe('write_outcome_unknown'); expect(revalidations).toBe(0);
  });
});

describe('generation-scoped retirement',()=>{
 it.each(['close','retireSession'] as const)('finishes replay ownership after listener cleanup throws during %s',async method=>{
  const gate=deferred(),entered=deferred();const parent=new AbortController();
  const lease={jwt:'fake-only',kind:'machine',region:'cn',expiresAt:Date.now()+60_000,accountFingerprint:'sha256:machine',source:'machine',stillCurrent:async(signal?:AbortSignal)=>{if(signal){entered.release();await gate.promise;}}};
  const s=setup({machine:async()=>lease,actor:async()=>{throw new Error('unexpected actor');}});
  expect((await s.executor.execute(s.request())).outcome).toBe('completed');
  const execution=s.executor.execute(s.request(read(),'request',{signal:parent.signal}));await entered.promise;
  const detach=vi.spyOn(parent.signal,'removeEventListener').mockImplementationOnce(()=>{throw new Error('listener detach failed');});
  let settled=false;const stop=(method==='close'?s.executor.close():s.executor.retireSession('session',1)).then(()=>{settled=true;return 'stopped';},()=>{settled=true;return 'failed';});
  await drain();const premature=settled;gate.release();await execution;detach.mockRestore();
  const result=await Promise.race([stop,new Promise<string>(resolve=>setTimeout(()=>resolve('hung'),100))]);
  expect(premature).toBe(false);expect(result).toBe('stopped');
 });
 it.each(['close','retireSession'] as const)('joins underlying work after response finalization throws during %s',async method=>{
  const gate=deferred(),entered=deferred();const parent=new AbortController();
  const lease={jwt:'fake-only',kind:'machine',region:'cn',expiresAt:Date.now()+60_000,accountFingerprint:'sha256:machine',source:'machine',stillCurrent:async()=>undefined};
  const s=setup({machine:async()=>lease,actor:async()=>{throw new Error('unexpected actor');}},async()=>{entered.release();await gate.promise;return empty;});
  const execution=s.executor.execute(s.request(read(),'faulty',{signal:parent.signal}));await entered.promise;
  const cleanupError=new Error('listener detach failed');
  const detach=vi.spyOn(parent.signal,'removeEventListener').mockImplementationOnce(()=>{throw cleanupError;});
  let settled=false;const stop=(method==='close'?s.executor.close():s.executor.retireSession('session',1)).then(()=>{settled=true;return undefined;},error=>{settled=true;return error;});
  await drain();const premature=settled;gate.release();const failure=await stop;await execution;detach.mockRestore();
  expect(premature).toBe(false);expect(failure).toBe(cleanupError);
 });
 it('retires old owned work without cancelling successor execution or future admissions',async()=>{
  const oldGate=deferred(),newGate=deferred();const invocations:any[]=[];
  const lease={jwt:'fake-only',kind:'machine',region:'cn',expiresAt:Date.now()+60_000,accountFingerprint:'sha256:machine',source:'machine',stillCurrent:async()=>undefined};
  const s=setup({machine:async()=>lease,actor:async()=>{throw new Error('unexpected actor');}},async (invocation:any)=>{
   const index=invocations.push(invocation)-1;if(index===0)await oldGate.promise;if(index===1)await newGate.promise;return empty;
  });
  const old=s.executor.execute(s.request(read(),'old',{authority:{...s.authority,workerGeneration:1}}));await drain();
  const next=s.executor.execute(s.request(read(),'next',{authority:{...s.authority,workerGeneration:2}}));await drain();
  let stopped=false;const retiring=s.executor.retireSession('session',1).then(()=>stopped=true);await drain();
  const oldAborted=invocations[0]?.signal.aborted,newAborted=invocations[1]?.signal.aborted,premature=stopped;
  newGate.release();const fresh=await next;oldGate.release();await old;await retiring;
  const later=await s.executor.execute(s.request(read(),'later',{authority:{...s.authority,workerGeneration:3}}));await s.executor.close();
  expect(oldAborted).toBe(true);expect(newAborted).toBe(false);expect(premature).toBe(false);expect(fresh.outcome).toBe('completed');expect(later.outcome).toBe('completed');
 });
});
