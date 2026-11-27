import React from 'react';import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
// 配置页里「等页面画完再做」的可选探测（模型列表等）也走 requestAnimationFrame；深链用例用它数落点次数，
// 所以让那类探测直接执行，不占用 requestAnimationFrame。
vi.mock('../src/dashboard/web/deferred-task.js',()=>({afterNextPaint:(task:()=>void)=>{task();return ()=>{};}}));
import {useWecomConnections} from '../src/dashboard/web/wecom-connections-section.js';
import {useWecomBotConfiguration} from '../src/dashboard/web/wecom-bot-config.js';
import {BotModelField} from '../src/dashboard/web/bot-profile-ui.js';
import {BOT_PROFILE_SHARED_PARTS,BotDefaultsPage} from '../src/dashboard/web/bot-defaults-page.js';
import {WecomBotDefaultsCard} from '../src/dashboard/web/wecom-bot-defaults-card.js';
import {publishProviderRoster} from '../src/dashboard/web/provider-roster.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let renderer:TestRenderer.ReactTestRenderer|undefined;
// 这些用例模拟的是已有企业微信连接的部署：名册（看板快照里的连接数）先说有企业微信，企业微信名单才会去拉。
beforeEach(()=>publishProviderRoster('wecom',1));
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;vi.unstubAllGlobals();vi.restoreAllMocks();});
async function mount(node:React.ReactElement){await act(async()=>{renderer=TestRenderer.create(node);});return renderer!;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const connection={id:'fixture',label:'Fixture bot',botIdHint:'…fixture',allowedUserCount:1,coreMode:'managed' as const,configuration:'ready' as const,gateway:'stopped' as const,connection:'unknown' as const,ownership:'none' as const,canStart:true,canStop:false};
const config={editable:true,revision:'r1',displayName:'Fixture bot',cli:'codex',backend:'pty',model:'',workingDirectory:'/workspace/demo',requiresRestart:true};
describe('provider adapters behind the common bot configuration UI',()=>{
 it('deduplicates lifecycle requests synchronously and refreshes actual state without inferring authentication',async()=>{
  let observed!:ReturnType<typeof useWecomConnections>;const waiting=deferred<{ok:boolean;status:number}>(),action=vi.fn(()=>waiting.promise),list=vi.fn().mockResolvedValueOnce({status:200,body:{connections:[connection]}}).mockResolvedValue({status:200,body:{connections:[{...connection,gateway:'starting',connection:'connecting',canStart:false,canStop:true}]}});
  const client={list,action};function StableProbe(){observed=useWecomConnections({client});return null;}
  await mount(React.createElement(StableProbe));await act(async()=>{observed.onAction('fixture','start');observed.onAction('fixture','start');});expect(action).toHaveBeenCalledTimes(1);
  await act(async()=>waiting.resolve({ok:true,status:202}));expect(observed.connections[0].connection).toBe('connecting');expect(observed.pending.size).toBe(0);
 });
 it('never exposes denied host-admin data or raw errors',async()=>{
  let observed!:ReturnType<typeof useWecomConnections>;const client={list:vi.fn().mockResolvedValue({status:403,body:{connections:[connection]}}),action:vi.fn()};function Probe(){observed=useWecomConnections({client});return null;}
  await mount(React.createElement(Probe));expect(observed.restricted).toBe(true);expect(observed.connections).toEqual([]);await act(async()=>observed.onAction('fixture','start'));expect(client.action).not.toHaveBeenCalled();
 });
 it('serializes independent field edits against the last committed revision and preserves both changes',async()=>{
  const first=deferred<any>(),bodies:any[]=[];let persisted={...config};const fetch=vi.fn(async(_url:any,init:any)=>{if(!init?.method)return {status:200,json:async()=>config};const body=JSON.parse(init.body);bodies.push(body);if(bodies.length===1)return first.promise;return {status:200,ok:true,json:async()=>({savedRestartRequired:true,config:(persisted={...persisted,...body,revision:'r3'})})};});vi.stubGlobal('fetch',fetch);
  let hook!:ReturnType<typeof useWecomBotConfiguration>;function Probe(){hook=useWecomBotConfiguration('fixture');return null;}await mount(React.createElement(Probe));
  let one!:Promise<void>,two!:Promise<void>;await act(async()=>{one=hook.save({cli:'claude-code'});two=hook.save({backend:'tmux'});await Promise.resolve();});expect(bodies).toHaveLength(1);
  await act(async()=>{first.resolve({status:200,ok:true,json:async()=>({savedRestartRequired:true,config:(persisted={...persisted,...bodies[0],revision:'r2'})})});await Promise.all([one,two]);});
  expect(bodies[1]).toEqual({revision:'r2',backend:'tmux'});expect(hook.config).toMatchObject({revision:'r3',cli:'claude-code',backend:'tmux'});expect(fetch.mock.calls.every(([url])=>String(url).startsWith('/api/wecom/'))).toBe(true);
 });
 it('does not let an older selected bot response overwrite the new selection',async()=>{
  const pending=deferred<any>();vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>init?.method?pending.promise:{status:200,json:async()=>({...config,revision:String(url).includes('/second/')?'second-revision':'first-revision'})}));
  let hook!:ReturnType<typeof useWecomBotConfiguration>;function Probe({id}:{id:string}){hook=useWecomBotConfiguration(id);return null;}await mount(React.createElement(Probe,{id:'first'}));let save!:Promise<void>;await act(async()=>{save=hook.save({cli:'claude-code'});await Promise.resolve();});
  await act(async()=>renderer!.update(React.createElement(Probe,{id:'second'})));await act(async()=>{pending.resolve({status:200,ok:true,json:async()=>({savedRestartRequired:true,config:{...config,revision:'old-response'}})});await save;});expect(hook.config?.revision).toBe('second-revision');
 });
 it('preserves edited CLI/model drafts on a CAS conflict and never starts or stops a process',async()=>{
  const fetch=vi.fn(async(_url:any,init:any)=>init?.method?{status:409,ok:false,json:async()=>({error:'wecom_configuration_changed'})}:{status:200,json:async()=>config});vi.stubGlobal('fetch',fetch);
  await mount(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection,cliState:{options:[{id:'codex',label:'Codex'},{id:'claude-code',label:'Claude'}],ttadkModelDefault:'',ttadkModelSuggestions:[]},activeTab:'common',onTabChange:()=>{},onRefresh:()=>{},onAction:()=>{}}));
  const picker=renderer!.root.findByType(BotModelField);await act(async()=>picker.props.onChange('edited-model'));await act(async()=>renderer!.root.findByProps({'data-action':'save-agent'}).props.onClick());
  expect(renderer!.root.findByType(BotModelField).props.value).toBe('edited-model');expect(fetch.mock.calls.filter(([,init])=>(init as any)?.method==='PATCH')).toHaveLength(1);expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/start')||String(url).endsWith('/stop'))).toBe(false);
 });
 it('keeps configuration loading and failure visible when unsupported common sections are not selected',async()=>{
  const load=deferred<any>();vi.stubGlobal('fetch',vi.fn(()=>load.promise));
  await mount(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection,cliState:{options:[],ttadkModelDefault:'',ttadkModelSuggestions:[]},activeTab:'common',onTabChange:()=>{},onRefresh:()=>{},onAction:()=>{}}));
  expect(renderer!.root.findAllByProps({role:'status'}).some(node=>{let current:any=node;while(current){if(current.props?.hidden)return false;current=current.parent;}return true;})).toBe(true);
  await act(async()=>load.resolve({status:409,json:async()=>({error:'private-backend-error'})}));const error=renderer!.root.findByProps({role:'alert'});let ancestor:any=error;while(ancestor){expect(ancestor.props?.hidden).not.toBe(true);ancestor=ancestor.parent;}expect(JSON.stringify(renderer!.toJSON())).not.toContain('private-backend-error');
 });
 it('re-reads the selected configuration revision through the real page Refresh after a CAS conflict',async()=>{
  let reads=0;const writes:any[]=[];vi.stubGlobal('location',{hash:'#/bot-defaults?provider=wecom&bot=fixture'});
  vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
   let body:any={};let status=200;const path=String(url);
   if(path==='/api/wecom/connections')body={connections:[connection]};
   else if(path==='/api/wecom/connections/fixture/config'){
    if(init?.method==='PATCH'){writes.push(JSON.parse(init.body));status=writes.length===1?409:200;body=status===409?{error:'wecom_configuration_changed'}:{savedRestartRequired:true,config:{...config,...writes.at(-1),revision:'r3'}};}
    else body={...config,revision:++reads===1?'r1':'r2'};
   }else if(path==='/api/bots')body={bots:[]};else if(path.startsWith('/api/cli-options/availability'))body={status:'available'};else if(path.startsWith('/api/cli-options'))body={options:[{id:'codex',label:'Codex'}]};else if(path==='/api/agents')body={agents:[],links:{}};else body={bots:[],chats:[]};
   return {status,ok:status===200,json:async()=>body};
  }));
  await mount(React.createElement(BotDefaultsPage));await act(async()=>renderer!.root.findByProps({'data-action':'save-agent'}).props.onClick());expect(writes[0].revision).toBe('r1');
  await act(async()=>{renderer!.root.findByProps({id:'bd-refresh'}).props.onClick();});expect(reads).toBe(2);await act(async()=>renderer!.root.findByProps({'data-action':'save-agent'}).props.onClick());expect(writes[1].revision).toBe('r2');
 });
 it('waits for the selected provider fields before consuming a configuration search deep link',async()=>{
  const pending=deferred<any>(),frame=vi.fn();vi.stubGlobal('location',{hash:'#/bot-defaults?provider=wecom&bot=fixture&section=agent&field=botDefaults.agentModel'});vi.stubGlobal('window',{requestAnimationFrame:frame});
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{const path=String(url);if(path==='/api/wecom/connections/fixture/config')return pending.promise;const body=path==='/api/wecom/connections'?{connections:[connection]}:path==='/api/bots'?{bots:[]}:path==='/api/agents'?{agents:[],links:{}}:path.startsWith('/api/cli-options/availability')?{status:'available'}:path.startsWith('/api/cli-options')?{options:[{id:'codex',label:'Codex'}]}:{bots:[],chats:[]};return {status:200,ok:true,json:async()=>body};}));
  await mount(React.createElement(BotDefaultsPage));expect(frame).not.toHaveBeenCalled();await act(async()=>pending.resolve({status:200,ok:true,json:async()=>config}));expect(renderer!.root.findAllByType(BotModelField)).toHaveLength(1);expect(frame).toHaveBeenCalledTimes(1);
 });
 it('uses common profile/fields/save actions and does not render unsupported platform controls',async()=>{
  const fetch=vi.fn(async(_url:any,init:any)=>init?.method?{status:200,ok:true,json:async()=>({savedRestartRequired:true,config:{...config,...JSON.parse(init.body),revision:'r2'}})}:{status:200,json:async()=>config});vi.stubGlobal('fetch',fetch);
  await mount(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection,cliState:{options:[{id:'codex',label:'Codex'},{id:'claude-code',label:'Claude'}],ttadkModelDefault:'',ttadkModelSuggestions:[]},activeTab:'common',onTabChange:()=>{},onRefresh:()=>{},onAction:()=>{}}));
  expect(renderer!.root.findAllByProps({className:'bd-card bd-profile'})).toHaveLength(1);expect(renderer!.root.findAllByType('form')).toHaveLength(0);expect(renderer!.root.findAllByProps({'data-action':'save-agent'})).toHaveLength(1);expect(renderer!.root.findAllByProps({'data-wd-worktree-row':true})).toHaveLength(1);expect(renderer!.root.findAllByProps({'data-action':'toggle-auto-start-on-new-topic'})).toHaveLength(0);
  const save=renderer!.root.findByProps({'data-action':'save-agent'});await act(async()=>save.props.onClick());expect(fetch.mock.calls.some(([,init])=>(init as any)?.method==='PATCH')).toBe(true);
 });
});
