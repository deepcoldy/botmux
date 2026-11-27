import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,it,expect,vi} from 'vitest';
import {BOT_PROFILE_SHARED_PARTS,BotAgentSection} from '../src/dashboard/web/bot-defaults-page.js';
import {WecomBotDefaultsCard} from '../src/dashboard/web/wecom-bot-defaults-card.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let renderer:TestRenderer.ReactTestRenderer|undefined;
afterEach(async()=>{await act(async()=>renderer?.unmount());vi.unstubAllGlobals();});
it('saves shared agent, role and access operations only through the source revision adapter',async()=>{
 let config:any={editable:true,revision:'1',cli:'codex',model:'',backend:'pty',workingDirectory:'/workspace',botConfig:{},allowedUsers:['owner'],blockedUsers:[],role:{content:'',injectMode:'once'}};
 const calls:Array<{url:string;method:string;body:any}>=[];
 vi.stubGlobal('fetch',async(input:any,init:any={})=>{const url=String(input),method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;calls.push({url,method,body});
  if(method==='PATCH'){config={...config,...body,botConfig:{...config.botConfig,...body.botConfig},revision:String(Number(config.revision)+1)};return {ok:true,status:200,json:async()=>({savedRestartRequired:true,config})};}
  return {ok:true,status:200,json:async()=>url.endsWith('/config')?config:url.endsWith('/environment')?{scope:'bot',rows:[],reserved:{keys:[],prefixes:[]},redactedHostKeys:[],conflicts:[],inherit:config.botConfig.envPolicy??{mode:'inherit'},canReveal:false,sessions:[],overlayApplies:true}:url.endsWith('/codex-profiles')?{connectionId:'source',status:'empty',candidates:[]}:{status:'unknown',models:[]}};
 });
 await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id:'source',label:'WeCom',configuration:'ready',ownership:'dashboard',gateway:'stopped'} as any,cliState:{options:[{id:'codex',label:'Codex'},{id:'claude-code',label:'Claude Code'}]} as any,activeTab:'common',onTabChange:vi.fn(),onRefresh:vi.fn(),onAction:vi.fn()}));});
 await act(async()=>renderer!.root.findByProps({'data-action':'save-agent'}).props.onClick());
 await act(async()=>renderer!.root.findByProps({'data-action':'save-access'}).props.onClick());
 await act(async()=>renderer!.root.findByProps({'data-action':'save-role'}).props.onClick());
 await act(async()=>renderer!.root.findByProps({'data-input':'envPolicyMode'}).props.onChange({currentTarget:{value:'strict'}}));
 await act(async()=>renderer!.root.findByProps({'data-action':'save-env-policy'}).props.onClick());
 expect(calls.filter(c=>c.method==='PATCH').map(c=>c.body.revision)).toEqual(['1','2','3','4']);
 expect(calls.filter(c=>c.method==='PATCH')[3]!.body.botConfig.envPolicy).toEqual({mode:'strict',inherit:[]});
 expect(calls.filter(c=>c.method==='PATCH')[2]!.body.role).toEqual({content:'',injectMode:'once'});
 expect(calls.filter(c=>c.method==='PATCH')[0]!.body).toMatchObject({cli:'codex',botConfig:{reasoningEffort:null}});
 expect(calls.some(c=>/^\/api\/(bots|team\/local-bots)\//.test(c.url))).toBe(false);
 expect(renderer!.root.findAllByProps({id:'bd-tab-security'})).toHaveLength(1);
 expect(renderer!.root.findAllByProps({id:'bd-tab-cards'})).toHaveLength(1);
 expect(renderer!.root.findAllByProps({'data-action':'toggle-private-card'})).toHaveLength(0);
 expect(renderer!.root.findAllByProps({'data-action':'toggle-streaming-button-stop'})).toHaveLength(1);
 expect(renderer!.root.findAllByProps({'data-action':'toggle-streaming-button-resume'})).toHaveLength(0);
 await act(async()=>renderer!.root.findByProps({'data-action':'toggle-disable-streaming'}).props.onChange({currentTarget:{checked:false}}));
 expect(calls.filter(c=>c.method==='PATCH').at(-1)!.body).toMatchObject({revision:'5',botConfig:{disableStreamingCard:true}});
 expect(renderer!.root.findByType(BotAgentSection).props.bot).toMatchObject({larkAppId:'',provider:'wecom',providerBotId:'source'});
 await act(async()=>renderer!.root.findByProps({dataInput:'agentCliId'}).props.onChange('claude-code'));
 await act(async()=>renderer!.root.findByProps({dataInput:'agentCliId'}).props.onChange('codex'));
 expect(calls.filter(call=>call.url.startsWith('/api/cli-options')).every(call=>!new URL(call.url,'https://fixture.invalid').searchParams.has('bot'))).toBe(true);
 expect(calls.some(c=>/^\/api\/(bots|team\/local-bots)\//.test(c.url))).toBe(false);
});

it('submits the actual shared Agent defaults and security controls through the real canonical WeCom configuration service',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {WecomDashboardConfig}=await import('../src/dashboard/wecom/config.js'),{wecomConfigId}=await import('../src/im/wecom/config/discovery.js');
 const root=mkdtempSync(join(tmpdir(),'wecom-ui-config-')),file=join(root,'config.json');
 writeFileSync(file,JSON.stringify({botId:'native-ui',secretEnv:'FAKE_WECOM_SECRET',allowedUsers:['owner'],coreUrl:'http://127.0.0.1:19442',role:{content:'',injectMode:'once'},managedCore:{botId:'local_ui',cli:'codex',model:'gpt-5.4',backend:'pty',workingDirectory:root,stateDir:join(root,'core'),port:19442}}));
 const service=new WecomDashboardConfig(root),id=wecomConfigId(file),writes:any[]=[],attempts:any[]=[],failures:string[]=[];
 vi.stubGlobal('fetch',async(input:any,init:any={})=>{
  const url=String(input),method=init.method??'GET';let status=200,body:any;
  try{
   if(method==='PATCH'){const patch=JSON.parse(init.body);attempts.push(patch);body=await service.patch(id,patch);writes.push(patch);}
   else if(url.endsWith('/config'))body=service.get(id);
   else if(url.endsWith('/environment'))body=service.environment(id);
   else if(url.includes('/command-triggers'))body=service.commandTriggers(id);
   else if(url.endsWith('/codex-profiles'))body={connectionId:id,status:'empty',candidates:[]};
   else body={status:'unknown',models:[]};
  }catch(error){status=409;body={error:String(error)};failures.push(String(error));}
  return {ok:status===200,status,json:async()=>body};
 });
 try{
  await act(async()=>{renderer=TestRenderer.create(React.createElement(WecomBotDefaultsCard,{shared:BOT_PROFILE_SHARED_PARTS,connection:{id,label:'WeCom',configuration:'ready',ownership:'dashboard',gateway:'stopped'} as any,cliState:{options:[{id:'codex',label:'Codex'},{id:'aiden-x-codex',label:'Aiden Codex'},{id:'forge-x-traex',label:'Forge TraeX'}]} as any,activeTab:'common',onTabChange:vi.fn(),onRefresh:vi.fn(),onAction:vi.fn()}));});
  const saveAndWait=async(action:string,count:number)=>{await act(async()=>{renderer!.root.findByProps({'data-action':action}).props.onClick();const deadline=Date.now()+2000;while(writes.length<count&&!failures.length&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));});};
  await saveAndWait('save-agent',1);
  expect(writes,JSON.stringify({attempts,failures})).toHaveLength(1);expect(service.get(id)).toMatchObject({cli:'codex',model:'gpt-5.4'});
  await act(async()=>renderer!.root.findByProps({'data-input':'teamRole'}).props.onChange({currentTarget:{value:'Reply concisely.'}}));
  await saveAndWait('save-role',2);
  await act(async()=>renderer!.root.findByProps({'data-input':'envPolicyMode'}).props.onChange({currentTarget:{value:'strict'}}));
  await saveAndWait('save-env-policy',3);
  expect(writes).toHaveLength(3);expect(new Set(writes.map(row=>row.revision)).size).toBe(3);
  expect(service.get(id)).toMatchObject({role:{injectMode:'once'},botConfig:{envPolicy:{mode:'strict'}}});
  await act(async()=>renderer!.root.findByProps({dataInput:'agentCliId'}).props.onChange('aiden-x-codex'));
  await saveAndWait('save-agent',4);expect(service.get(id)).toMatchObject({cli:'codex',botConfig:{wrapperCli:'aiden x codex'}});
  await act(async()=>renderer!.root.findByProps({dataInput:'agentCliId'}).props.onChange('codex'));
  await saveAndWait('save-agent',5);expect(service.get(id).botConfig).not.toHaveProperty('wrapperCli');
  await act(async()=>renderer!.root.findByProps({dataInput:'agentCliId'}).props.onChange('forge-x-traex'));
  await saveAndWait('save-agent',6);expect(service.get(id)).toMatchObject({cli:'traex',botConfig:{cliLaunchMode:'forge-traex'}});
  await act(async()=>renderer!.root.findByProps({'data-input':'startupCommands'}).props.onChange({currentTarget:{value:'/model changed\n/effort high'}}));
  await saveAndWait('save-startup-commands',7);expect(service.get(id).botConfig).toMatchObject({startupCommands:['/model changed','/effort high']});
  expect(renderer!.root.findByProps({'data-input':'startupCommands'}).props.value).toBe('/model changed\n/effort high');
 }finally{await act(async()=>renderer?.unmount());renderer=undefined;rmSync(root,{recursive:true,force:true});}
});
