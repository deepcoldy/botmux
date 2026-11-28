import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema, CreateMessageRequestSchema, ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { PluginMcpGateway, type GatewayTrustedTurnIdentity } from '../src/core/plugins/mcp/gateway.js';
import { refreshSessionMcpRuntimeManifest, readSessionMcpRuntimeManifest, sessionMcpRuntimeManifestPath } from '../src/core/plugins/mcp/session-runtime.js';
import { readSessionPluginManifest } from '../src/core/plugins/session-manifest.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';
import { approvedReadOnlyTools, assertHostReadOnlyMcpRuntime, isCurrentReadOnlyMcpExecution } from '../src/core/plugins/mcp/read-only-policy.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadBotConfigs } from '../src/bot-registry.js';
import { readGlobalConfig as readHostGlobalConfig, globalConfigPath } from '../src/global-config.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { resolveEffectivePluginIds } from '../src/core/plugins/effective.js';

describe('read-only MCP boundary enforcement', () => {
 let home:string,dataDir:string,identity:GatewayTrustedTurnIdentity;
 let upstreamTransport:any; let rawSeq=10000; const rawPending=new Map<number,(value:any)=>void>();
 async function rawRequest(request:any) {const id=++rawSeq; const result=new Promise(resolve=>rawPending.set(id,resolve));await upstreamTransport.send({jsonrpc:"2.0",id,...request});return result;}
 let executionScope:WorkerSessionEventScope;
 let authorized:boolean; let gateway:PluginMcpGateway|undefined, client:Client|undefined;
 const policy={reader:['echo']};
 function install() {
  const source=join(home,'source');mkdirSync(join(source,'dist','mcp'),{recursive:true});
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'@botmux-ai/plugin-reader',version:'0.1.0',keywords:['botmux-plugin'],botmux:{schemaVersion:1,id:'reader'}}));
  writeFileSync(join(source,'dist','mcp','index.json'),JSON.stringify({transport:'stdio',command:[process.execPath,resolve('test/fixtures/plugin-mcp-read-only-server.mjs'),home]}));installLocalPlugin(source);
 }
 function snapshot() {return refreshSessionMcpRuntimeManifest({sessionId:'strict-reader',pluginIds:['reader'],hostMcpEnabled:false,hostReadOnlyMcpTools:policy,dataDir});}
 async function connect(extra:any={}) {
  gateway=new PluginMcpGateway(undefined,{...process.env,BOTMUX_SESSION_ID:'strict-reader',SESSION_DATA_DIR:dataDir},{trustedTurnIdentity:()=>identity,readOnly:{tools:policy,authorize:()=>authorized},...extra});
  client=new Client({name:'boundary-test',version:'1'},{capabilities:{roots:{},sampling:{},elicitation:{}}});
  const [a,b]=InMemoryTransport.createLinkedPair(); await Promise.all([gateway.connect(b),client.connect(a)]);await client.listTools();upstreamTransport=a;const original=a.onmessage;a.onmessage=(message:any,extra:any)=>{if(rawPending.has(message.id)){rawPending.get(message.id)!(message);rawPending.delete(message.id);return;} original?.(message,extra);};return client;
 }
 async function captureLiveAuthorizer(globalReader: typeof readHostGlobalConfig = ()=>({bytedcliBroker:{hostReadOnlyMcpTools:policy}})) {
  let captured:any;
  const scope:any={lastInitConfig:{larkAppId:'cli_test',pluginBindings:['reader'],bytedcliContainment:{hostReadOnlyMcpTools:policy}},config:{session:{dataDir}},workerSessionEventScope:executionScope,isCurrentReadOnlyMcpExecution,readSessionMcpRuntimeManifest,assertHostReadOnlyMcpRuntime,approvedReadOnlyTools,loadBotConfigs,resolveEffectivePluginIds,readGlobalConfig:globalReader,currentGatewayTrustedTurnIdentity:()=>identity,deliverPluginResultThroughHost:()=>{},log:()=>{},writeMcpGatewayLaunchRecord:()=>{},startSessionMcpGatewayHost:async(opts:any)=>{captured=opts;return {socketPath:'fixture'}}};
  await loadWorkerFunction<any>('startAndRecordSessionMcpGatewayHost',scope)('strict-reader');return captured.readOnly.authorize;
 }
 async function waitEntered() {const end=Date.now()+3000;while(!existsSync(join(home,'entered')) && Date.now()<end)await new Promise(r=>setTimeout(r,5));expect(existsSync(join(home,'entered'))).toBe(true);}
 beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'botmux-boundary-ro-'));dataDir=join(home,'.botmux','data');vi.stubEnv('HOME',home);vi.stubEnv('SESSION_DATA_DIR',dataDir);
  identity={turnId:'turn-one',dispatchAttempt:1,sessionOrigin:{bindingId:'binding',runtime:{runtimeId:'runtime',epoch:1},execution:{executionId:'exec-one',turnId:'turn-one',dispatchAttempt:1}}} as any;
  executionScope=new WorkerSessionEventScope({appId:'cli_test',sessionId:'strict-reader'},{workerId:'worker',generation:1});const binding=executionScope.beginRuntime();executionScope.assign(binding.bindingId,identity.sessionOrigin!.runtime!);identity={...identity,sessionOrigin:{...identity.sessionOrigin!,bindingId:binding.bindingId}};executionScope.noteAdmission({ref:identity.sessionOrigin!.execution!,runtime:identity.sessionOrigin!.runtime!,phase:'accepted'});
  authorized=true;install();snapshot();
 });
 afterEach(async()=>{await client?.close();await gateway?.close();client=undefined;gateway=undefined;vi.useRealTimers();vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});});
 it.each(['authorization','turn','epoch','execution'])('independently discards a held result after %s changes',async change=>{
  const c=await connect();const p=c.callTool({name:'echo',arguments:{mode:'hold'}});const outcome=p.then(value=>({value}),error=>({error}));await waitEntered();
  if(change==='authorization')authorized=false;
  else if(change==='turn')identity={...identity,turnId:'turn-two',sessionOrigin:{...identity.sessionOrigin!,execution:{...identity.sessionOrigin!.execution!,turnId:'turn-two',executionId:'exec-two'}}};
  else if(change==='epoch')identity={...identity,sessionOrigin:{...identity.sessionOrigin!,runtime:{...identity.sessionOrigin!.runtime!,epoch:2}}};
  else identity={...identity,sessionOrigin:{...identity.sessionOrigin!,execution:{...identity.sessionOrigin!.execution!,executionId:'exec-two'}}};
  writeFileSync(join(home,'release'),'1');expect(await outcome).toHaveProperty('error');
 });
 it('rejects a newly dispatched read when the valid turn remains but authorization alone is revoked',async()=>{
  const c=await connect();authorized=false;await expect(c.callTool({name:'echo'})).rejects.toThrow();
 });
 it('drops arbitrary client meta and never forwards raw reverse requests/log/progress',async()=>{
  const c=await connect();const reverse=vi.fn();const logs=vi.fn();const progress=vi.fn();
  c.setRequestHandler(ListRootsRequestSchema,async()=>{reverse();return {roots:[]};});
  c.setRequestHandler(CreateMessageRequestSchema,async()=>{reverse();return {role:'assistant',content:{type:'text',text:'secret'},model:'test'};});
  c.setRequestHandler(ElicitRequestSchema,async()=>{reverse();return {action:'accept',content:{}};});
  c.setNotificationHandler(LoggingMessageNotificationSchema,logs);
  const result=await c.callTool({name:'echo',arguments:{mode:'sidechannels'},_meta:{customAttack:'evil',progressToken:'attack',botmuxGrantedCapabilities:['attack']}},undefined,{onprogress:progress});
  expect(reverse).not.toHaveBeenCalled();expect(logs).not.toHaveBeenCalled();expect(progress).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('evil');
  const content=JSON.parse((result.content as any)[0].text);expect(content.side).toHaveLength(3);expect(content.side.every((v:any)=>v.error?.code===-32601)).toBe(true);
 });
 it('rejects every non-tool entrypoint and malicious readOnlyHint siblings',async()=>{
  const c=await connect();expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['echo']);
  for(const request of [{method:'resources/list',params:{}},{method:'resources/templates/list',params:{}},{method:'resources/read',params:{uri:'demo://secret'}},{method:'resources/subscribe',params:{uri:'demo://secret'}},{method:'prompts/list',params:{}},{method:'prompts/get',params:{name:'secret'}},{method:'completion/complete',params:{ref:{type:'ref/prompt',name:'secret'},argument:{name:'arg',value:'x'}}},{method:'logging/setLevel',params:{level:'debug'}}]) expect(await rawRequest(request)).toHaveProperty('error.code',-32601);
  await expect(c.callTool({name:'sibling'})).rejects.toThrow();
 });
 it('fails closed after a corrupt manifest and recovers on the next successful refresh',async()=>{
  writeFileSync(sessionMcpRuntimeManifestPath('strict-reader',dataDir),'{');expect(readSessionMcpRuntimeManifest('strict-reader',dataDir)).toBeNull();expect(()=>new PluginMcpGateway(undefined,{BOTMUX_SESSION_ID:'strict-reader',SESSION_DATA_DIR:dataDir},{readOnly:{tools:policy,authorize:()=>true}})).toThrow();snapshot();await connect();
 });
 it('keeps generation failure visible after only the plugin manifest commits and recovers on retry',()=>{
  const opts={sessionId:'strict-reader',bot:{larkAppId:'cli_test',plugins:['reader']},dataDir,cliId:'codex' as const,adapter:{id:'codex',skillsDir:join(home,'codex-skills')} as any,workingDir:home,prompt:'',replacesPriorGeneration:true,hostMcpEnabled:false,hostReadOnlyMcpTools:policy,promptInjection:'none' as const};
  const privatePath=pluginMcpPrivatePath('reader');const good=readFileSync(privatePath,'utf8');writeFileSync(privatePath,'{');expect(()=>prepareCliPluginGeneration(opts)).toThrow();expect(readSessionPluginManifest('strict-reader',dataDir)?.pluginIds).toEqual(['reader']);expect(readSessionMcpRuntimeManifest('strict-reader',dataDir)?.entries).toHaveLength(1);writeFileSync(privatePath,good);expect(()=>prepareCliPluginGeneration(opts)).not.toThrow();
 });
 it.each(['missing','malformed','removed'])('worker authorization must reject when live bot configuration is %s',async mode=>{
  const bots=join(home,'bots.json');vi.stubEnv('BOTS_CONFIG',bots);writeFileSync(bots,JSON.stringify([{larkAppId:'cli_test',larkAppSecret:'fixture',plugins:['reader']} ]));
  const authorize=await captureLiveAuthorizer();
  expect(authorize('reader','echo',identity)).toBe(true);
  vi.useFakeTimers();setTimeout(()=>{if(mode==='missing')rmSync(bots);else writeFileSync(bots,mode==='malformed'?'{':'[]');},100);await vi.advanceTimersByTimeAsync(100);
  expect(authorize('reader','echo',identity)).toBe(false);
 });
 it.each(['queued','cancelled','failed','succeeded','unknown'])('real worker read gate rejects %s execution',async phase=>{
  const bots=join(home,'bots.json');vi.stubEnv('BOTS_CONFIG',bots);writeFileSync(bots,JSON.stringify([{larkAppId:'cli_test',larkAppSecret:'fixture',plugins:['reader']} ]));
  const authorize=await captureLiveAuthorizer();expect(authorize('reader','echo',identity)).toBe(true);
  if(phase==='unknown')identity={...identity,turnId:'other',sessionOrigin:{...identity.sessionOrigin!,execution:{executionId:'unknown',turnId:'other',dispatchAttempt:1}}};
  else if(phase==='queued') {executionScope=new WorkerSessionEventScope({appId:'cli_test',sessionId:'strict-reader'},{workerId:'worker',generation:1});const binding=executionScope.beginRuntime();executionScope.assign(binding.bindingId,identity.sessionOrigin!.runtime!);identity={...identity,sessionOrigin:{...identity.sessionOrigin!,bindingId:binding.bindingId}};executionScope.noteAdmission({ref:identity.sessionOrigin!.execution!,runtime:identity.sessionOrigin!.runtime!,phase:'queued'});}
  else executionScope.noteAdmission({ref:identity.sessionOrigin!.execution!,runtime:identity.sessionOrigin!.runtime!,phase:phase as any});
  const after=phase==='queued'?await captureLiveAuthorizer():authorize;expect(after('reader','echo',identity)).toBe(false);
 });
 it('forbids host delivery and its status tool even with trusted human identity and handlers supplied',async()=>{
  identity={...identity,caller:{senderType:'user',requestUserUnionId:'on_fixture',requestLarkAppId:'cli_test'}};
  const delivery=vi.fn(async()=>({delivered:true,deliveryId:'delivery_fixture_001',fileCount:0}));const status=vi.fn();
  const c=await connect({trustedResultDelivery:delivery,trustedResultStatus:status});
  expect((await c.listTools()).tools.map(t=>t.name)).toEqual(['echo']);
  await expect(c.callTool({name:'echo',arguments:{mode:'delivery'}})).rejects.toThrow();expect(delivery).not.toHaveBeenCalled();
  await expect(c.callTool({name:'botmux_result_delivery_status',arguments:{plugin_id:'reader',delivery_id:'delivery_fixture_001'}})).rejects.toThrow();expect(status).not.toHaveBeenCalled();
 });

 it('uses a fresh global allowlist at release even when the ordinary global config cache is warm',async()=>{
  const bots=join(home,'bots.json');vi.stubEnv('BOTS_CONFIG',bots);writeFileSync(bots,JSON.stringify([{larkAppId:'cli_test',larkAppSecret:'fixture',plugins:['reader']} ]));
  mkdirSync(join(home,'.botmux'),{recursive:true});writeFileSync(globalConfigPath(),JSON.stringify({bytedcliBroker:{hostReadOnlyMcpTools:policy}}));
  vi.useFakeTimers();
  const authorize=await captureLiveAuthorizer(readHostGlobalConfig);expect(authorize('reader','echo',identity)).toBe(true);
  setTimeout(()=>writeFileSync(globalConfigPath(),JSON.stringify({bytedcliBroker:{hostReadOnlyMcpTools:{}}})),100);await vi.advanceTimersByTimeAsync(100);
  expect(authorize('reader','echo',identity)).toBe(false);
 });

 it('discards a held gateway result when the real global allowlist is revoked inside its cache TTL',async()=>{
  const bots=join(home,'bots.json');vi.stubEnv('BOTS_CONFIG',bots);writeFileSync(bots,JSON.stringify([{larkAppId:'cli_test',larkAppSecret:'fixture',plugins:['reader']} ]));
  mkdirSync(join(home,'.botmux'),{recursive:true});writeFileSync(globalConfigPath(),JSON.stringify({bytedcliBroker:{hostReadOnlyMcpTools:policy}}));
  const authorize=await captureLiveAuthorizer(readHostGlobalConfig);const c=await connect({readOnly:{tools:policy,authorize}});
  const p=c.callTool({name:'echo',arguments:{mode:'hold'}});const outcome=p.then(value=>({value}),error=>({error}));await waitEntered();
  vi.useFakeTimers();setTimeout(()=>writeFileSync(globalConfigPath(),JSON.stringify({bytedcliBroker:{hostReadOnlyMcpTools:{}}})),100);await vi.advanceTimersByTimeAsync(100);writeFileSync(join(home,'release'),'1');
  expect(await outcome).toHaveProperty('error');
 });

});
