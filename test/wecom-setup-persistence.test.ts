import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { commitWecomConfiguration, loadWecomSecret, parseWecomConfig, readWecomConfigSnapshot, type WecomConfig } from '../src/im/wecom/config/config.js';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { configureWecom, createWecomPrompter, runWecomSetup } from '../src/cli/wecom/manual-setup.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture(){const root=mkdtempSync(join(tmpdir(),'wecom-setup-persistence-'));roots.push(root);return {root,file:join(root,'config.json')}}
const config=():WecomConfig=>({botId:'bot',secretEnv:'FAKE_EXISTING_SECRET',coreUrl:'http://127.0.0.1:19123',allowedUsers:['alice']});
const read=(file:string)=>parseWecomConfig(JSON.parse(readFileSync(file,'utf8')));
const prompt=(answers:Array<string|null>=[])=>{const output:string[]=[];return {output,ask:async()=>answers.shift()??null,write:(text:string)=>{output.push(text)}}};
const values=(root:string)=>({botId:'bot',secret:'new-fake-secret',allowedUsers:['bob'],cli:'codex',backend:'pty',workingDirectory:root,port:'19123'});
describe('WeCom setup configuration and credential persistence',()=>{
 it('leaves old config and credential byte-identical when final confirmation cancels',async()=>{
  const f=fixture();await commitWecomConfiguration({file:f.file,previous:undefined,config:config(),newSecret:'old-fake-secret'});
  const before=readWecomConfigSnapshot(f.file),old=read(f.file);const p=prompt(['no']);
  expect(await configureWecom({file:f.file,prompt:p,values:values(f.root),validateCli:async()=>true})).toBe('cancelled');
  expect(readWecomConfigSnapshot(f.file)).toBe(before);expect(loadWecomSecret(old)).toBe('old-fake-secret');expect(p.output.join('\n')).not.toContain('new-fake-secret');
 });
 it('removes only the unreferenced new generation when config commit fails',async()=>{
  const f=fixture();await commitWecomConfiguration({file:f.file,previous:undefined,config:config(),newSecret:'old-fake-secret'});
  const previous=readWecomConfigSnapshot(f.file),old=read(f.file);
  await expect(commitWecomConfiguration({file:f.file,previous,config:config(),newSecret:'new-fake-secret',write:(path,data,options)=>{if(path===f.file)throw new Error('config write failed');atomicWriteFileSync(path,data,options)}})).rejects.toThrow('config write failed');
  expect(readWecomConfigSnapshot(f.file)).toBe(previous);expect(loadWecomSecret(old)).toBe('old-fake-secret');expect(readdirSync(join(f.root,'credentials'))).toHaveLength(1);
  await commitWecomConfiguration({file:f.file,previous,config:config(),newSecret:'new-fake-secret'});expect(loadWecomSecret(read(f.file))).toBe('new-fake-secret');
 });
 it('keeps the referenced credential if a post-rename durability error reports failure',async()=>{
  const f=fixture();await expect(commitWecomConfiguration({file:f.file,previous:undefined,config:config(),newSecret:'new-fake-secret',write:(path,data,options)=>{atomicWriteFileSync(path,data,options);if(path===f.file)throw new Error('directory fsync failed after rename')}})).rejects.toThrow('directory fsync failed after rename');
  expect(loadWecomSecret(read(f.file))).toBe('new-fake-secret');expect(statSync(read(f.file).secretFile!).mode&0o777).toBe(0o600);
 });
 it('allows old-reader snapshots to load old credentials while new pointer commits',async()=>{
  const f=fixture();await commitWecomConfiguration({file:f.file,previous:undefined,config:config(),newSecret:'old-fake-secret'});
  const old=read(f.file),previous=readWecomConfigSnapshot(f.file);let observations=0;
  await commitWecomConfiguration({file:f.file,previous,config:config(),newSecret:'new-fake-secret',write:(path,data,options)=>{
   expect(loadWecomSecret(old)).toBe('old-fake-secret');atomicWriteFileSync(path,data,options);expect(loadWecomSecret(old)).toBe('old-fake-secret');observations++;
  }});expect(observations).toBe(2);expect(loadWecomSecret(read(f.file))).toBe('new-fake-secret');
 });
 it('rejects stale setup snapshots and leaves the winning ACL and secret intact',async()=>{
  const f=fixture();const previous=undefined;
  await commitWecomConfiguration({file:f.file,previous,config:{...config(),allowedUsers:['bob']},newSecret:'winner-fake-secret'});
  await expect(commitWecomConfiguration({file:f.file,previous,config:{...config(),allowedUsers:['alice']},newSecret:'loser-fake-secret'})).rejects.toThrow(/另一个向导修改/);
  expect(read(f.file).allowedUsers).toEqual(['bob']);expect(loadWecomSecret(read(f.file))).toBe('winner-fake-secret');
 });
 it('competing processes with one prior snapshot cannot both commit',async()=>{
  const f=fixture();const source=`import {commitWecomConfiguration} from './src/im/wecom/config/config.js';
  process.stdout.write('ready\\n'); process.stdin.once('data',async()=>{try{await commitWecomConfiguration({file:${JSON.stringify(f.file)},previous:undefined,config:${JSON.stringify(config())},newSecret:'fake-secret'});process.stdout.write('won\\n')}catch{process.stdout.write('lost\\n')}process.exit(0)});`;
  const children=[0,1].map(()=>spawnTsEvalWithRepoImports(source,{cwd:process.cwd(),env:{...process.env},stdio:['pipe','pipe','pipe']}));
  const output=['',''];const ready=children.map((child,index)=>new Promise<void>((resolve,reject)=>{child.stdout!.on('data',chunk=>{output[index]+=chunk;if(output[index].includes('ready'))resolve()});child.on('error',reject)}));
  try{await Promise.all(ready);const exits=children.map(child=>new Promise<void>(resolve=>child.once('exit',()=>resolve())));children.forEach(child=>child.stdin!.write('go'));await Promise.all(exits);expect(output.filter(value=>value.includes('won'))).toHaveLength(1);expect(output.filter(value=>value.includes('lost'))).toHaveLength(1);expect(loadWecomSecret(read(f.file))).toBe('fake-secret')}finally{children.forEach(child=>child.kill())}
 });
 it('non-TTY missing inputs fail without asking, leaking credentials, or writing state',async()=>{
  const f=fixture(),p=prompt();p.ask=async()=>{throw new Error('must never ask')};
  expect(await runWecomSetup(['--config',f.file,'--bot-id','bot'],{tty:false,prompt:p})).toBe(2);expect(readWecomConfigSnapshot(f.file)).toBeUndefined();
 });
 it('does not print exception details containing secret bytes',async()=>{
  const f=fixture(),p=prompt();const source=join(f.root,'input.secret');writeFileSync(source,'marker-secret',{mode:0o600});
  expect(await runWecomSetup(['--config',f.file,'--secret-file',source,'--bot-id','bot','--allow-user','alice','--cli','codex','--backend','pty','--working-dir',join(f.root,'marker-secret'),'--core-port','19123','--yes'],{tty:false,prompt:p})).toBe(2);
  expect(p.output.join('\n')).not.toContain('marker-secret');expect(readWecomConfigSnapshot(f.file)).toBeUndefined();
 });
 it('retains legacy secretEnv when an interactive edit keeps its credential',async()=>{
  const f=fixture();await commitWecomConfiguration({file:f.file,previous:undefined,config:config()});
  const p=prompt(['','no']);const v=values(f.root);delete (v as {secret?:string}).secret;
  expect(await configureWecom({file:f.file,prompt:p,values:v,confirm:true,validateCli:async()=>true})).toBe('saved');
  expect(read(f.file).secretEnv).toBe('FAKE_EXISTING_SECRET');expect(loadWecomSecret(read(f.file),{FAKE_EXISTING_SECRET:'legacy-fake-secret'})).toBe('legacy-fake-secret');
 });
 it('preserves an external pending turn by default but never imports it into a managed migration',async()=>{
  const f=fixture(),oldState=join(f.root,'old-bridge');await commitWecomConfiguration({file:f.file,previous:undefined,config:{...config(),stateDir:oldState},newSecret:'old-fake-secret'});
  const calls:any[]=[];const core={trigger:async(request:any)=>{calls.push(request);return {ok:true,triggerId:'old-trigger',target:{kind:'turn' as const,sessionId:'old-session'}}},result:async()=>({ok:true,state:'running' as const}),interrupt:async()=>{}};
  const transport={reply:async()=>{},send:async()=>{}};const bridge=(stateDir:string)=>new WecomBridge({botId:'bot',allowedUsers:['alice'],stateFile:join(stateDir,'state.json'),transport,core});
  const message=(messageId:string)=>({messageId,userId:'alice',conversationId:'alice',chatType:'single' as const,text:'task',replyContext:{requestId:messageId},attachments:[]});
  const old=bridge(oldState);await old.receive(message('old'));await old.tick();expect(calls).toHaveLength(1);const disk=readFileSync(join(oldState,'state.json'),'utf8');
  const v={...values(f.root),allowedUsers:['alice']};expect(await configureWecom({file:f.file,prompt:prompt(),values:v,nonInteractive:true,confirm:true,validateCli:async()=>true})).toBe('saved');
  const retained=read(f.file);expect(retained.managedCore).toBeUndefined();expect(retained.stateDir).toBe(oldState);await bridge(retained.stateDir!).tick();expect(calls).toHaveLength(1);
  expect(await configureWecom({file:f.file,prompt:prompt(),values:v,nonInteractive:true,confirm:true,manageCore:true,validateCli:async()=>true})).toBe('saved');
  const migrated=read(f.file);expect(migrated.stateDir).not.toBe(oldState);const fresh=bridge(migrated.stateDir!);await fresh.tick();expect(calls).toHaveLength(1);
  await fresh.receive(message('new'));await fresh.tick();expect(calls).toHaveLength(2);expect(calls[1].target.sessionId).toBeUndefined();expect(readFileSync(join(oldState,'state.json'),'utf8')).toBe(disk);
 });
 it('never echoes hidden typed bytes and restores terminal raw state on cancellation',async()=>{
  const input=new PassThrough() as unknown as NodeJS.ReadStream;let raw=false;Object.assign(input,{isTTY:true,setRawMode:(value:boolean)=>{raw=value}});
  let output='';const stream=new Writable({write(chunk,_encoding,done){output+=chunk;done()}}) as unknown as NodeJS.WriteStream;
  const prompter=createWecomPrompter(input,stream),answer=prompter.ask('Secret',{hidden:true});input.write('marker-secret\r');expect(await answer).toBe('marker-secret');expect(output).not.toContain('marker-secret');expect(raw).toBe(false);
  const cancel=prompter.ask('Secret',{hidden:true});input.write('another-secret\u0003');expect(await cancel).toBeNull();expect(output).not.toContain('another-secret');expect(raw).toBe(false);input.destroy();
 });
});
