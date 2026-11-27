import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { startWecomManagedCore, WecomManagedCoreSettingsError, type WecomManagedCoreOptions } from '../src/im/wecom/gateway/managed-core.js';
import { spawnTsEval, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

const roots:string[]=[];
const handles:{stop():Promise<void>}[]=[];
afterEach(async()=>{for(const handle of handles.splice(0)) await handle.stop();await releaseWecomCorePorts();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function config() {
 const port=await reserveWecomCorePort();
 const root=mkdtempSync(join(tmpdir(),'wecom-managed-'));roots.push(root);
 return {secretEnv:'MY_WECHAT_SECRET',managedCore:{botId:'local_wecom_test',cli:'codex',backend:'pty' as const,workingDirectory:root,stateDir:join(root,'state'),port}};
}
function childFactory(source:string, observed?:{child?:ChildProcess;options?:SpawnOptions}):NonNullable<WecomManagedCoreOptions['spawn']> {
 return (_command,_args,options)=>{const child=spawnTsEval(source,options);if(observed){observed.child=child;observed.options=options;}return child;};
}
const ready=`console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')'); setInterval(()=>{},1000);`;
describe('WeCom managed core ownership',()=>{
 it('waits for owned stdout readiness and closes only its child with idempotent stop',async()=>{
  const cfg=await config(), observed:{child?:ChildProcess}={},onExit=vi.fn();
  const handle=await startWecomManagedCore(cfg,{spawn:childFactory(ready,observed),onExit,shutdownTimeoutMs:500});handles.push(handle);
  expect(observed.child?.exitCode).toBeNull();await Promise.all([handle.stop(),handle.stop()]);
  expect(observed.child?.exitCode!==null || observed.child?.signalCode!==null).toBe(true);expect(onExit).not.toHaveBeenCalled();
 });
 it('rejects an occupied port without spawning or touching the incumbent',async()=>{
  const cfg=await config(),server=createServer();server.listen(cfg.managedCore.port,'127.0.0.1');await once(server,'listening');const spawn=vi.fn();
  try{await expect(startWecomManagedCore(cfg,{spawn})).rejects.toThrow(/端口已占用/);expect(spawn).not.toHaveBeenCalled();expect(server.listening).toBe(true);}finally{await new Promise<void>(done=>server.close(()=>done()));}
 });
 it('rejects a child that exits before ready and does not accept unrelated stdout',async()=>{
  const cfg=await config();await expect(startWecomManagedCore(cfg,{spawn:childFactory("console.log('[core-only] listening on 127.0.0.1:1 (bot other, cli codex)');process.exit(0)")})).rejects.toThrow(/就绪前退出/);
 });
 it('cancels startup and reaps a child that never becomes ready',async()=>{
  const cfg=await config(),controller=new AbortController(),observed:{child?:ChildProcess}={};
  const start=startWecomManagedCore(cfg,{signal:controller.signal,spawn:childFactory('setInterval(()=>{},1000)',observed),shutdownTimeoutMs:500});
  // Asserted only after the abort: under bun test, `expect(promise).rejects` waits for the promise right where it is written.
  start.catch(()=>{});
  while(!observed.child)await new Promise(done=>setTimeout(done,5));controller.abort();await expect(start).rejects.toThrow(/启动已取消/);
  expect(observed.child.exitCode!==null || observed.child.signalCode!==null).toBe(true);
 });
 it('times out startup and reaps a silent owned child',async()=>{
  const cfg=await config(),observed:{child?:ChildProcess}={};
  await expect(startWecomManagedCore(cfg,{spawn:childFactory('setInterval(()=>{},1000)',observed),startupTimeoutMs:30,shutdownTimeoutMs:100})).rejects.toThrow(/就绪超时/);
  expect(observed.child?.exitCode!==null || observed.child?.signalCode!==null).toBe(true);
 });
 it('does not create a child when already canceled or given external-only config',async()=>{
  const cfg=await config(),controller=new AbortController();controller.abort();const spawn=vi.fn();
  await expect(startWecomManagedCore(cfg,{signal:controller.signal,spawn})).rejects.toThrow(/启动已取消/);
  await expect(startWecomManagedCore({},{spawn})).rejects.toThrow(WecomManagedCoreSettingsError);expect(spawn).not.toHaveBeenCalled();
 });
 it('reports unexpected exit after ready without claiming other processes',async()=>{
  const cfg=await config(),onExit=vi.fn(),observed:{child?:ChildProcess}={};const handle=await startWecomManagedCore(cfg,{spawn:childFactory(ready,observed),onExit});handles.push(handle);
  const exited=once(observed.child!,'exit');observed.child!.kill('SIGTERM');await exited;expect(onExit).toHaveBeenCalledExactlyOnceWith(null);
 });
 it('removes gateway credentials and inherited session/fleet authority from the real child environment',async()=>{
  const cfg=await config();
  const assertion=`const forbidden=['MY_WECHAT_SECRET','BOTMUX_SESSION_ID','BOTMUX_OWNER_OPEN_ID','__OWNER_OPEN_ID','BOTS_CONFIG','SESSION_DATA_DIR','CLAUDECODE','CODEX_HOME','BOTMUX_WORKFLOW']; if(forbidden.some(key=>process.env[key])) process.exit(9);`;
  const observed:{options?:SpawnOptions}={};const handle=await startWecomManagedCore(cfg,{spawn:childFactory(assertion+ready,observed),env:{...process.env,MY_WECHAT_SECRET:'secret',BOTMUX_SESSION_ID:'session',BOTMUX_OWNER_OPEN_ID:'owner',__OWNER_OPEN_ID:'owner',BOTS_CONFIG:'/secret',SESSION_DATA_DIR:'/fleet',CLAUDECODE:'1',CODEX_HOME:'/sibling',BOTMUX_WORKFLOW:'1'}});handles.push(handle);
  expect(observed.options?.env).toMatchObject({BOTMUX_CORE_SKIP_DOTENV:'1',BOTMUX_CORE_STATE_DIR:cfg.managedCore.stateDir,BOTMUX_CORE_ONLY:'1'});
 });
 it('passes the saved model only to its dedicated core environment',async()=>{
  const cfg=await config(),observed:{options?:SpawnOptions}={};
  const handle=await startWecomManagedCore({...cfg,managedCore:{...cfg.managedCore,model:'fixture-model'}},{spawn:childFactory(ready,observed)});handles.push(handle);
  expect(observed.options?.env?.BOTMUX_CORE_MODEL).toBe('fixture-model');
 });
 it('kills a hung owned child after a bounded graceful shutdown',async()=>{
  const cfg=await config(),observed:{child?:ChildProcess}={};const handle=await startWecomManagedCore(cfg,{spawn:childFactory("process.on('SIGTERM',()=>{});"+ready,observed),shutdownTimeoutMs:30});handles.push(handle);
  await handle.stop();expect(observed.child?.signalCode).toBe('SIGKILL');
 });
 it.each([true,false])('real core-only entry skips dotenv only when explicitly requested (%s)',async skip=>{
  const cfg=await config(),home=cfg.managedCore.workingDirectory;mkdirSync(join(home,'.botmux'),{recursive:true});writeFileSync(join(home,'.botmux','.env'),'WECOM_DOTENV_LEAK=private\n');
  const source=`process.on('exit',()=>console.log('DOTENV_PROBE='+JSON.stringify({present:!!process.env.WECOM_DOTENV_LEAK}))); await import(${JSON.stringify(resolve('src/index-core-only.ts'))});`;
  const env={...process.env,HOME:home,BOTMUX_API_PORT:'invalid',BOTMUX_CORE_STATE_DIR:cfg.managedCore.stateDir,BOTMUX_CORE_SKIP_DOTENV:skip?'1':'0'};delete (env as NodeJS.ProcessEnv).WECOM_DOTENV_LEAK;
  const child=spawnTsEvalWithRepoImports(source,{env,cwd:resolve('.'),stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout!.on('data',data=>output+=data);child.stderr!.on('data',data=>errors+=data);await once(child,'close');
  expect(output,errors).toContain('DOTENV_PROBE='+JSON.stringify({present:!skip}));
 });
});
