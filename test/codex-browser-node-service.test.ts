import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBrowserNodeService, createBrowserWireCodec, DEFAULT_BROWSER_NODE_REQUEST_TIMEOUT_MS } from '../src/services/codex-browser-node-service.js';
import { TOOL_TIMEOUT_MS } from '../src/services/codex-browser-broker.js';
import { resolveNodeExecutable, spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

const fixture = `
let events = [];
export async function handleRpc(request) {
  const r=globalThis.nodeRepl;
  if(request.method==='probe') {
    const {WASI}=await import('node:wasi');
    const w=new WASI({version:'preview1'});
    const module=new WebAssembly.Module(Buffer.from('0061736d01000000010401600000030201000503010001071802066d656d6f727902000b5f696e697469616c697a6500000a040102000b','hex'));
    const instance=new WebAssembly.Instance(module,w.getImportObject());
    w.initialize(instance);
    return {node:process.versions.node,pid:process.pid,reactor:instance.exports.memory instanceof WebAssembly.Memory};
  }
  if(request.method==='echo')return {value:request.params,meta:r.requestMeta,pid:process.pid};
  if(request.method==='config')return r.config.read({cwd:'trusted',includeLayers:false});
  if(request.method==='approval')return r.createElicitation(request.params);
  if(request.method==='fetch') { const response=await r.fetch('https://identity.example.invalid/test',{method:'POST',body:'input'});return {status:response.status,body:await response.text()}; }
  if(request.method==='hook'){r.addTurnEndedHandler({run:e=>events.push(e)});return;}
  if(request.method==='slow-hook'){r.addTurnEndedHandler({timeoutMs:150,run:()=>new Promise(()=>{})});return;}
  if(request.method==='events')return events;
  if(request.method==='exit')process.exit(7);
  if(request.method==='wait')return new Promise(()=>{});
  throw new Error('Unsupported test operation');
}`;

describe('Node browser service boundary', () => {
  let service: CodexBrowserNodeService | undefined;
  const roots: string[] = [];
  function setup(requestTimeoutMs?: number, startupTimeoutMs?: number) {
    const root=mkdtempSync(join(tmpdir(),'botmux-node-browser-'));roots.push(root);
    mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/browser-service.mjs'),fixture);
    const runtime:any={requestMeta:{turn:'first'},config:{read:vi.fn(async p=>({p,ok:true}))},createElicitation:vi.fn(async()=>({action:'decline'})),fetch:vi.fn(async()=>new Response('output',{status:201}))};
    service=new CodexBrowserNodeService(root,()=>runtime,resolveNodeExecutable()!,requestTimeoutMs,startupTimeoutMs);
    return {root,runtime};
  }
  function setupHangingPlugin(startupTimeoutMs: number) {
    const root=mkdtempSync(join(tmpdir(),'botmux-node-browser-hang-'));roots.push(root);
    mkdirSync(join(root,'scripts'));
    writeFileSync(join(root,'scripts/browser-service.mjs'),`
await new Promise(() => {});
export async function handleRpc(){ return null; }`);
    service=new CodexBrowserNodeService(root,()=>({requestMeta:{}}),resolveNodeExecutable()!,60_000,startupTimeoutMs);
    return root;
  }
  afterEach(async()=>{await service?.close();service=undefined;roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});

  it('preserves data types and page-controlled wire tag names',()=>{
    const w=createBrowserWireCodec();
    const v={t:'x',v:'not-a-buffer',id:7654103270265734157n,bytes:new Uint8Array([0,255,12]),u:undefined,a:[false,null,'text']};
    expect(w.decode(JSON.parse(JSON.stringify(w.encode(v))))).toEqual(v);
    const proto=JSON.parse('{"__proto__":{"polluted":true}}');
    expect(w.decode(w.encode(proto))).toEqual(proto);
    expect(({} as any).polluted).toBeUndefined();
  });
  it('initializes a real WASI reactor under Node and reuses one child for concurrent calls',async()=>{
    setup();const proof:any=await service!.handleRpc({method:'probe'});
    expect(proof.reactor).toBe(true);
    const results:any[]=await Promise.all(Array.from({length:8},(_,i)=>service!.handleRpc({method:'echo',params:{i}})));
    expect(new Set(results.map(x=>x.pid))).toEqual(new Set([proof.pid]));
    expect(results.map(x=>x.value.i)).toEqual([0,1,2,3,4,5,6,7]);
  });
  it('keeps config, origin decisions, authenticated fetch and turn metadata with the owner',async()=>{
    const {runtime}=setup();
    expect(await service!.handleRpc({method:'config'})).toEqual({p:{cwd:'trusted',includeLayers:false},ok:true});
    expect(await service!.handleRpc({method:'approval',params:{message:'origin prompt'}})).toEqual({action:'decline'});
    expect(runtime.createElicitation).toHaveBeenCalledWith({message:'origin prompt'});
    expect(await service!.handleRpc({method:'fetch'})).toEqual({status:201,body:'output'});
    expect(runtime.fetch).toHaveBeenCalledOnce();
    runtime.requestMeta={turn:'second'};
    expect((await service!.handleRpc({method:'echo'}) as any).meta).toEqual({turn:'second'});
    await service!.handleRpc({method:'hook'});
    await service!.handleTurnEnded({turn_id:'second'});
    expect(await service!.handleRpc({method:'events'})).toEqual([{turn_id:'second'}]);
  });
  it('reports callback failures without exposing private bodies',async()=>{
    const {runtime}=setup();runtime.fetch.mockRejectedValueOnce(new Error('secret-credential-body'));
    await expect(service!.handleRpc({method:'fetch'})).rejects.toThrow('Browser runtime callback failed');
  });
  it('fails pending work when the child exits and rejects use after close',async()=>{
    setup();await expect(service!.handleRpc({method:'exit'})).rejects.toThrow('Browser Node runtime exited');
    await service!.close();await expect(service!.handleRpc({method:'probe'})).rejects.toThrow('closed');
  });
  it('runs the same service from the actual Bun host without Bun WASI',()=>{
    const {root}=setup();
    const source=`import {CodexBrowserNodeService} from './src/services/codex-browser-node-service.js';const s=new CodexBrowserNodeService(${JSON.stringify(root)},()=>({requestMeta:{}}),${JSON.stringify(resolveNodeExecutable())});try{console.log(JSON.stringify(await s.handleRpc({method:'probe'})))}finally{await s.close()}`;
    const r=spawnSyncBunTsEvalWithRepoImports(source,{cwd:process.cwd(),encoding:'utf8',timeout:20000});
    expect(r.status,r.stderr.toString()).toBe(0);
    expect(JSON.parse(r.stdout.toString()).reactor).toBe(true);
  });
  it('times out a silent call without killing the shared child',async()=>{
    setup(300);
    const started=Date.now();
    await expect(service!.handleRpc({method:'wait'})).rejects.toThrow('Browser Node runtime request timed out');
    expect(Date.now()-started).toBeGreaterThanOrEqual(250);
    // The child stays connected: a later call succeeds on the same process.
    const proof:any=await service!.handleRpc({method:'probe'});
    expect(proof.reactor).toBe(true);
  });
  it('waits for a slow owner-side approval instead of cutting it off',async()=>{
    const {runtime}=setup(2_000);
    runtime.createElicitation=vi.fn(()=>new Promise(resolve=>setTimeout(()=>resolve({action:'accept',meta:{persist:'session'}}),400)));
    await expect(service!.handleRpc({method:'approval',params:{message:'origin prompt'}})).resolves.toMatchObject({action:'accept'});
    expect(runtime.createElicitation).toHaveBeenCalledOnce();
  });
  it('keeps the default request budget no shorter than the broker tool timeout',()=>{
    // Both sides read their real exported symbols: mutating the broker budget
    // past the Node default must make this relationship fail.
    expect(DEFAULT_BROWSER_NODE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(TOOL_TIMEOUT_MS);
  });
  it('leaves the abort budget with the owner fetch instead of injecting a signal',async()=>{
    const {runtime}=setup();
    const initCapture:RequestInit[]=[];
    runtime.fetch=vi.fn(async(_url:string,init:RequestInit)=>{
      initCapture.push(init);
      await new Promise(resolve=>setTimeout(resolve,100));
      return new Response('slow-output',{status:200});
    });
    await expect(service!.handleRpc({method:'fetch'})).resolves.toMatchObject({status:200,body:'slow-output'});
    expect(initCapture).toHaveLength(1);
    expect(initCapture[0]!.signal).toBeUndefined();
  });
  it('bounds a hanging plugin initialize with the startup watchdog and relaunches on retry',async()=>{
    setupHangingPlugin(300);
    const first=Date.now();
    await expect(service!.handleRpc({method:'probe'}))
      .rejects.toThrow('Browser Node runtime is unavailable: startup timed out after 300ms');
    expect(Date.now()-first).toBeGreaterThanOrEqual(250);
    // The failed launch is not cached: a retry spawns a fresh child and hits the
    // same watchdog instead of replaying the stored rejection immediately.
    const second=Date.now();
    await expect(service!.handleRpc({method:'probe'}))
      .rejects.toThrow(/startup timed out/);
    expect(Date.now()-second).toBeGreaterThanOrEqual(250);
  },15_000);
  it('enforces the plugin handler own timeoutMs inside the Node worker',async()=>{
    setup();
    await service!.handleRpc({method:'slow-hook'});
    const started=Date.now();
    await expect(service!.handleTurnEnded({turn_id:'slow'}))
      .rejects.toThrow('turn-ended handler timed out after 150ms');
    expect(Date.now()-started).toBeLessThan(1_000);
  },10_000);
});

describe('Node browser service child generation and reaping', () => {
  let dir = '';
  let service: CodexBrowserNodeService | undefined;
  let pidFile = '';
  const spawnedPids: number[] = [];

  function writeLauncher(): string {
    const launcher = join(dir, 'node-launcher.sh');
    pidFile = join(dir, 'pids.log');
    // exec keeps the shell PID, so the recorded PID is the Node process itself.
    writeFileSync(launcher, `#!/bin/sh\necho $$ >> "${pidFile}"\nexec "${resolveNodeExecutable()}" "$@"\n`);
    chmodSync(launcher, 0o755);
    return launcher;
  }
  function readPids(): number[] {
    try { return readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number); }
    catch { return []; }
  }
  function makeRoot(fixtureSource: string): string {
    dir = mkdtempSync(join(tmpdir(), 'botmux-node-browser-gen-'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/browser-service.mjs'), fixtureSource);
    return dir;
  }
  afterEach(async () => {
    await service?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    // Defensive cleanup of exactly the PIDs this test spawned.
    for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    spawnedPids.length = 0;
  });

  it('a late exit from the previous child cannot reject the next generation startup', async () => {
    const delayedExit = `
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
await new Promise(() => {});
export async function handleRpc(){ return null; }`;
    const root = makeRoot(delayedExit);
    service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), writeLauncher(), 60_000, 250);

    const first = await service.handleRpc({ method: 'echo' })
      .then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
    expect(first).toMatch(/startup timed out/);

    const started = Date.now();
    const second = await service.handleRpc({ method: 'echo' })
      .then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
    const elapsed = Date.now() - started;
    spawnedPids.push(...readPids());
    // The new child is governed by its own 250ms watchdog, not the old child's
    // ~80ms delayed exit; two distinct PIDs prove the generations were separate.
    expect(new Set(readPids()).size).toBeGreaterThanOrEqual(2);
    expect(second).toMatch(/startup timed out/);
    expect(second).not.toMatch(/exited/);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  }, 20_000);

  it('SIGKILLs a child that ignores SIGTERM so failed startups never leak processes', async () => {
    const ignoreSigterm = `
process.on('SIGTERM', () => {});
await new Promise(() => {});
export async function handleRpc(){ return null; }`;
    const root = makeRoot(ignoreSigterm);
    service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), writeLauncher(), 60_000, 60, 100);

    for (let i = 0; i < 2; i++) {
      await expect(service.handleRpc({ method: 'echo' })).rejects.toThrow(/startup timed out/);
    }
    await service.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    const pids = readPids();
    spawnedPids.push(...pids);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    const alive = pids.map(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    expect(alive).not.toContain(true);
  }, 20_000);

  it('settles an in-flight startup RPC when close() runs before ready, without waiting for the watchdog', async () => {
    const normal = `export async function handleRpc(){ return { pid: process.pid }; }`;
    const root = makeRoot(normal);
    service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), resolveNodeExecutable()!, 60_000, 300);
    const rpc = service.handleRpc({ method: 'probe' })
      .then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);
    await service.close();
    const afterClose = Date.now();
    const outcome = await rpc;
    const elapsed = Date.now() - afterClose;
    // Close must settle the startup generation itself; the 300ms watchdog must
    // not be the thing that rejects this RPC after close has already returned.
    expect(elapsed).toBeLessThan(150);
    expect(outcome).toMatch(/rejected/);
    expect(outcome).not.toMatch(/startup timed out/);
  }, 15_000);

  it('makes every concurrent close() await the same child reaping', async () => {
    const ignoreSigterm = `
process.on('SIGTERM', () => {});
export async function handleRpc(){ return { pid: process.pid }; }`;
    const root = makeRoot(ignoreSigterm);
    service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), writeLauncher(), 60_000, 4_000, 300);
    await service.handleRpc({ method: 'probe' });
    const pids = readPids();
    spawnedPids.push(...pids);
    const pid = pids[0]!;

    const first = service.close();
    const second = service.close();
    await second;
    let aliveAfterSecond = true;
    try { process.kill(pid, 0); } catch { aliveAfterSecond = false; }
    // The second close shares the termination promise: by the time it returns,
    // the SIGKILL reaping has completed rather than merely being scheduled.
    expect(aliveAfterSecond).toBe(false);
    await first;
  }, 15_000);

  it('leaves no grace or hard-cap timer after close settles', async () => {
    const normal = `export async function handleRpc(){ return { pid: process.pid }; }`;
    const root = makeRoot(normal);
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const active = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const handle = originalSetTimeout(handler, timeout, ...args);
      active.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== undefined) active.delete(handle);
      originalClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), resolveNodeExecutable()!, 60_000, 4_000, 1_000);
      await service.handleRpc({ method: 'probe' });
      active.clear(); // only count timers created by the teardown
      await service.close();
      await new Promise(resolve => originalSetTimeout(resolve, 100));
      expect(active.size).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  }, 15_000);
});

describe('Node browser service turn-ended batch semantics', () => {
  let root = '';
  let service: CodexBrowserNodeService | undefined;
  afterEach(async () => { await service?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  function makeService(fixtureSource: string): void {
    root = mkdtempSync(join(tmpdir(), 'botmux-node-browser-turn-'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/browser-service.mjs'), fixtureSource);
    service = new CodexBrowserNodeService(root, () => ({ requestMeta: {} }), resolveNodeExecutable()!, 60_000, 4_000);
  }

  it('waits for the whole hook batch before accepting the next turn', async () => {
    makeService(`
let bRunning = false;
const events = [];
export async function handleRpc(request){
  const r = globalThis.nodeRepl;
  if(request.method==='register'){
    r.addTurnEndedHandler({ timeoutMs: 40, run: async () => { await new Promise(()=>{}); } });
    r.addTurnEndedHandler({ run: async (e) => {
      events.push('B-start:'+e.turn_id+':overlap='+bRunning);
      bRunning = true;
      await new Promise(resolve => setTimeout(resolve, 180));
      bRunning = false;
      events.push('B-end:'+e.turn_id);
    }});
    return { registered: true };
  }
  if(request.method==='snapshot') return { events };
  throw new Error('unsupported');
}`);
    await service.handleRpc({ method: 'register' });
    await service.handleTurnEnded({ turn_id: 'one' }).catch(() => {});
    await service.handleTurnEnded({ turn_id: 'two' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 400));
    const snapshot = await service.handleRpc({ method: 'snapshot' }) as { events: string[] };
    const secondBatch = snapshot.events.find(line => line.startsWith('B-start:two'))!;
    expect(secondBatch).toContain('overlap=false');
  }, 15_000);

  it('clears the hook timeout timer once a fast hook settles', async () => {
    makeService(`
export async function handleRpc(request){
  const r = globalThis.nodeRepl;
  if(request.method==='register'){
    r.addTurnEndedHandler({ timeoutMs: 1000, run: async () => {} });
    return { registered: true };
  }
  if(request.method==='timers')
    return { timeouts: process.getActiveResourcesInfo().filter(x => x === 'Timeout').length };
  throw new Error('unsupported');
}`);
    await service.handleRpc({ method: 'register' });
    await service.handleTurnEnded({ turn_id: 'one' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const timers = await service.handleRpc({ method: 'timers' }) as { timeouts: number };
    expect(timers.timeouts).toBe(0);
  }, 15_000);
});
