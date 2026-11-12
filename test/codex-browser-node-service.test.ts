import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBrowserNodeService, createBrowserWireCodec } from '../src/services/codex-browser-node-service.js';
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
  if(request.method==='events')return events;
  if(request.method==='exit')process.exit(7);
  if(request.method==='wait')return new Promise(()=>{});
  throw new Error('Unsupported test operation');
}`;

describe('Node browser service boundary', () => {
  let service: CodexBrowserNodeService | undefined;
  const roots: string[] = [];
  function setup() {
    const root=mkdtempSync(join(tmpdir(),'botmux-node-browser-'));roots.push(root);
    mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/browser-service.mjs'),fixture);
    const runtime:any={requestMeta:{turn:'first'},config:{read:vi.fn(async p=>({p,ok:true}))},createElicitation:vi.fn(async()=>({action:'decline'})),fetch:vi.fn(async()=>new Response('output',{status:201}))};
    service=new CodexBrowserNodeService(root,()=>runtime,resolveNodeExecutable()!);
    return {root,runtime};
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
});
