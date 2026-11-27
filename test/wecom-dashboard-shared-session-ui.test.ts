import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS, BotDefaultsCard, BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { BotProfileLayout } from '../src/dashboard/web/bot-profile-ui.js';
import { useWecomBotConfiguration } from '../src/dashboard/web/wecom-bot-config.js';
import { SessionDetailsDrawer } from '../src/dashboard/web/sessions-page.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock('../src/dashboard/web/modal-dialog.js',()=>({ModalDialog:({children}:any)=>React.createElement('div',{},children)}));
let renderer:TestRenderer.ReactTestRenderer|undefined;
afterEach(async()=>{if(renderer)await act(async()=>renderer!.unmount());renderer=undefined;vi.unstubAllGlobals()});
const base={sessionId:'fixture-session',botName:'Fixture Bot',title:'Fixture session',status:'idle',cliId:'codex',backendType:'pty',workingDir:'/workspace/fixture',chatType:'p2p',webPort:8801,proxyPort:8800,workerPid:123,terminalUrl:'/wecom-terminal/fixture-source/'};
const common={history:true,terminal:true,takeover:true,close:true,restart:true,resume:true,suspend:true,interrupt:true,insight:false,spawnCommand:false,environment:false,locate:false,lock:false,topics:false,larkNative:false};
function props(row:any){return {row,onClose:vi.fn(),locateSession:vi.fn(async()=>true),openHistory:vi.fn(),resumeSession:vi.fn(async()=>true),restartSession:vi.fn(async()=>true),closeSession:vi.fn(async()=>true),setSessionLocked:vi.fn(async()=>true),startSession:vi.fn(async()=>true),onTakeover:vi.fn(),onOpenTerminal:vi.fn(),interruptSession:vi.fn(async()=>true),suspendSession:vi.fn(async()=>true)}}
function text(node:any):string{return typeof node==='string'?node:(node?.children??[]).map(text).join('')}
async function mount(row:any){await act(async()=>{renderer=TestRenderer.create(React.createElement(SessionDetailsDrawer,props(row)))});return renderer!}
it('renders the same main drawer action structure for equivalent supported capabilities',async()=>{
 vi.stubGlobal('window',{location:{protocol:'https:',origin:'https://fixture.invalid',hostname:'fixture.invalid'}});
 const legacy=await mount({...base,larkAppId:'fixture-app',capabilities:common});const first=legacy.root.findByProps({className:'drawer-foot-actions'}).findAllByType('button').map(node=>({id:node.props.id??'',label:text(node),disabled:!!node.props.disabled}));await act(async()=>renderer!.unmount());renderer=undefined;
 const native=await mount({...base,provider:'wecom',providerBotId:'fixture-provider',capabilities:common});const second=native.root.findByProps({className:'drawer-foot-actions'}).findAllByType('button').map(node=>({id:node.props.id??'',label:text(node),disabled:!!node.props.disabled}));expect(second).toEqual(first);
});
it('omits unsupported WeCom actions from the actual component rather than leaving clickable Lark controls',async()=>{
 const row={...base,provider:'wecom',providerBotId:'fixture-provider',capabilities:Object.fromEntries(Object.keys(common).map(key=>[key,false])),rootMessageId:'private-lark-root-must-not-render',feishuChatLink:'https://lark.invalid/must-not-render'};const p=props(row);await act(async()=>{renderer=TestRenderer.create(React.createElement(SessionDetailsDrawer,p))});
 for(const id of ['resume-btn','takeover-btn','restart-btn','close-btn','history-drawer-btn','copy-cmd-btn','lock-btn','locate-btn'])expect(renderer!.root.findAllByProps({id})).toHaveLength(0);
 expect(JSON.stringify(renderer!.toJSON())).not.toContain('must-not-render');for(const callback of [p.locateSession,p.onTakeover,p.onOpenTerminal,p.restartSession])expect(callback).not.toHaveBeenCalled();
});

it('preserves WeCom CAS revisions and CSRF while shared fields queue independent edits',async()=>{
 vi.stubGlobal('document',{querySelector:()=>({getAttribute:()=> 'fixture-csrf-ticket'})});
 const writes:Array<{url:string;init:any}>=[];let revision=1;
 const initial={editable:true,revision:'r1',displayName:'Fixture',cli:'codex',backend:'pty',model:'',workingDirectory:'/workspace/fixture',requiresRestart:true};
 const request=vi.fn(async(url:string,init?:any)=>{if(!init?.method||init.method==='GET')return {status:200,ok:true,json:async()=>initial};writes.push({url,init});const body=JSON.parse(init.body);return {status:200,ok:true,json:async()=>({savedRestartRequired:true,config:{...body,revision:`r${++revision}`}})}});vi.stubGlobal('fetch',request);
 let controller:ReturnType<typeof useWecomBotConfiguration>|undefined;
 function Fields(){controller=useWecomBotConfiguration('private-source');return null}
 await act(async()=>{renderer=TestRenderer.create(React.createElement(Fields))});
 await act(async()=>{await Promise.all([controller!.save({cli:'claude-code'}),controller!.save({model:'new-model'})])});
 expect(writes).toHaveLength(2);expect(writes.every(write=>write.url==='/api/wecom/connections/private-source/config'&&write.init.method==='PATCH')).toBe(true);
 expect(JSON.parse(writes[0].init.body)).toMatchObject({revision:'r1',cli:'claude-code'});expect(JSON.parse(writes[1].init.body)).toMatchObject({revision:'r2',model:'new-model'});
 expect(writes.every(write=>write.init.headers['x-botmux-csrf']==='fixture-csrf-ticket')).toBe(true);
 expect(writes.some(write=>write.url.includes('/api/bots/')||/\/(start|stop)$/.test(write.url))).toBe(false);
});

it('removes unsupported name editing from the actual external-core bot detail composition',async()=>{
 const request=vi.fn(async()=>({status:200,ok:true,json:async()=>({editable:false,revision:'external-r1',requiresRestart:true})}));vi.stubGlobal('fetch',request);
 await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id:'external',label:'External Fixture',botIdHint:'…fixture',allowedUserCount:1,coreMode:'external',configuration:'ready',gateway:'stopped',connection:'unknown',ownership:'none',canStart:true,canStop:false},cliState:{options:[]} as any,activeTab:'common',onTabChange:vi.fn(),onRefresh:vi.fn(),onAction:vi.fn()}))});
 expect(renderer!.root.findAllByProps({'data-action':'edit-bot-name'})).toHaveLength(0);expect(renderer!.root.findAllByProps({'data-action':'save-agent'})).toHaveLength(0);
 expect(request.mock.calls.some(([url])=>String(url).startsWith('/api/bots/'))).toBe(false);
 for(const [url] of request.mock.calls)if(String(url).startsWith('/api/cli-options/availability'))expect(new URL(String(url),'https://fixture.invalid').searchParams.has('bot')).toBe(false);
 expect(request.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
});

it('assembles both actual bot details through the same profile and full agent section at equivalent capabilities',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:any)=>({status:200,ok:true,json:async()=>/\/(environment|session-env)$/.test(String(input))?{scope:'bot',rows:[],reserved:{keys:[],prefixes:[]},conflicts:[],redactedHostKeys:[],inherit:{mode:'inherit'},sessions:[],canReveal:false}:{editable:true,revision:'r1',displayName:'Fixture',cli:'codex',backend:'pty',model:'',workingDirectory:'/workspace/fixture',requiresRestart:true}})));
 const cliState={options:[{id:'codex',label:'Codex',models:[]}]} as any;
 await act(async()=>{renderer=TestRenderer.create(React.createElement(BotDefaultsCard,{bot:{larkAppId:'legacy-app',botName:'Fixture',cliId:'codex',backendType:'pty',online:true,defaultWorkingDir:'/workspace/fixture'} as any,bots:[],cliState,patchBot:vi.fn(),brandEnabled:false,activeTab:'common',onTabChange:vi.fn(),onLocate:vi.fn(),filterQuery:'',onFilterQuery:vi.fn(),modifiedOnly:false,onModifiedOnly:vi.fn(),onClearFilter:vi.fn()}))});
 const summary=()=>({profile:renderer!.root.findAllByType(BotProfileLayout).length,agent:renderer!.root.findAllByType(BotAgentSection).length,sections:renderer!.root.findByProps({id:'bd-panel-common'}).findAllByProps({className:'bd-section-title'}).map(text)});
 const first=summary();await act(async()=>renderer!.unmount());renderer=undefined;
 await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id:'native',label:'Fixture',botIdHint:'…fixture',allowedUserCount:1,coreMode:'managed',configuration:'ready',gateway:'running',connection:'connected',ownership:'external',canStart:false,canStop:false},cliState,activeTab:'common',onTabChange:vi.fn(),onRefresh:vi.fn(),onAction:vi.fn()}))});
 const native=summary();expect(native.profile).toBe(first.profile);expect(native.agent).toBe(first.agent);expect(native.sections).toEqual(expect.arrayContaining(first.sections));expect(first.profile).toBe(1);expect(first.agent).toBe(1);
 const nativePanel=renderer!.root.findByProps({id:'bd-panel-common'});expect(nativePanel.findAllByProps({'data-action':'save-agent'})).toHaveLength(1);expect(nativePanel.findAllByType('input').some(input=>input.props.value==='https://work.weixin.qq.com/wework_admin/')).toBe(false);expect(renderer!.root.findAll(node=>node.type==='a'&&node.props.href==='https://work.weixin.qq.com/wework_admin/')).toHaveLength(1);
 for(const tab of ['sessions','security','cards'])expect(renderer!.root.findAllByProps({'data-bd-tab':tab})).toHaveLength(1);
 for(const panel of ['bd-panel-sessions','bd-panel-security','bd-panel-cards'])expect(renderer!.root.findAllByProps({id:panel})).toHaveLength(1);
});
it('leaves configuration load errors visible outside any hidden tab panel',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({status:500,ok:false,json:async()=>({})})));
 await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id:'unavailable',label:'Fixture',botIdHint:'…fixture',allowedUserCount:1,coreMode:'managed',configuration:'ready',gateway:'stopped',connection:'unknown',ownership:'none',canStart:true,canStop:false},cliState:{options:[]} as any,activeTab:'common',onTabChange:vi.fn(),onRefresh:vi.fn(),onAction:vi.fn()}))});
 const alerts=renderer!.root.findAllByProps({role:'alert'});expect(alerts.length).toBeGreaterThan(0);for(const alert of alerts){let parent=alert.parent;while(parent){expect(parent.props.hidden).not.toBe(true);parent=parent.parent}}
 expect(renderer!.root.findAllByProps({'data-action':'edit-bot-name'})).toHaveLength(0);
});

it('includes supported bot categories in keyboard navigation in the actual native detail',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:any)=>({status:200,ok:true,json:async()=>String(input).endsWith('/environment')?{scope:'bot',rows:[],reserved:{keys:[],prefixes:[]},conflicts:[],redactedHostKeys:[],inherit:{mode:'inherit'},sessions:[],canReveal:false}:{editable:true,revision:'r1',displayName:'Fixture',cli:'codex',backend:'pty',model:'',workingDirectory:'/workspace/fixture',requiresRestart:true}})));
 const change=vi.fn();await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id:'native',label:'Fixture',botIdHint:'…fixture',allowedUserCount:1,coreMode:'managed',configuration:'ready',gateway:'running',connection:'connected',ownership:'external',canStart:false,canStop:false},cliState:{options:[]} as any,activeTab:'common',onTabChange:change,onRefresh:vi.fn(),onAction:vi.fn()}))});
 const commonTab=renderer!.root.findByProps({'data-bd-tab':'common'});await act(async()=>commonTab.props.onKeyDown({key:'ArrowRight',preventDefault(){}}));expect(change).toHaveBeenLastCalledWith('sessions');
 const advanced=renderer!.root.findByProps({'data-bd-tab':'advanced'});await act(async()=>advanced.props.onKeyDown({key:'ArrowRight',preventDefault(){}}));expect(change).toHaveBeenLastCalledWith('common');
 expect(renderer!.root.findAll(node=>typeof node.type==='string'&&node.props.role==='tab')).toHaveLength(5);
});
it('keeps takeover disabled when the native row lacks its verified same-origin terminal target',async()=>{
 vi.stubGlobal('window',{location:{protocol:'https:',origin:'https://fixture.invalid',hostname:'fixture.invalid'}});
 await mount({...base,provider:'wecom',providerBotId:'fixture-provider',terminalUrl:undefined,capabilities:common});
 expect(renderer!.root.findByProps({id:'takeover-btn'}).props.disabled).toBe(true);
});

it('merges queued native edits against the last committed snapshot',async()=>{
 let committed:any={editable:true,revision:'r1',cli:'codex',backend:'pty',workingDirectory:'/workspace',requiresRestart:true,native:{p2pOpen:false,autoGrantRequestCards:false,summaryRange:{limit:20}}};
 const writes:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:any)=>{if(!init?.method||init.method==='GET')return {status:200,ok:true,json:async()=>committed};const patch=JSON.parse(init.body);writes.push(patch);committed={...committed,...patch,revision:`r${writes.length+1}`};return {status:200,ok:true,json:async()=>({savedRestartRequired:true,config:committed})};}));
 let controller:ReturnType<typeof useWecomBotConfiguration>|undefined;
 function Fields(){controller=useWecomBotConfiguration('private-source');return null;}
 await act(async()=>{renderer=TestRenderer.create(React.createElement(Fields));});
 await act(async()=>{await Promise.all([controller!.save({native:{p2pOpen:true}}),controller!.save({native:{autoGrantRequestCards:true}})]);});
 expect(writes).toHaveLength(2);expect(writes[1]).toMatchObject({revision:'r2',native:{p2pOpen:true,autoGrantRequestCards:true,summaryRange:{limit:20}}});
});
