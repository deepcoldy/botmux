import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wecomObservedSummary, rememberWecomSummary, writeWecomSummaryMemory, wecomFeedbackPolicy, type WecomPlatformState } from '../src/im/wecom/gateway/native-platform.js';
import { renderWecomProgress } from '../src/im/wecom/gateway/presentation.js';
import { enqueueWecomFeedbackEvent, dispatchWecomFeedbackOutbox, type NativeFeedbackState } from '../src/im/wecom/gateway/native-feedback.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import { validateWecomNativePlatformConfig } from '../src/im/wecom/config/native-platform-config.js';
const dirs:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const message=(text='question',id='m',userId='alice'):WecomInboundMessage=>({messageId:id,userId,conversationId:'g',chatType:'group',text,attachments:[],replyContext:{requestId:id}});
describe('native platform policies',()=>{
 // Mutation: falling back to 100 turns / no time bound when summaryRange is unset turns the second half red.
 it('restricts summaries to exact route, time and message window, 50 turns and 24 hours when unset',()=>{
  const state:WecomPlatformState={tasks:{old:{message:message(),route:'a',createdAt:0,result:'old'},other:{message:message(),route:'b',createdAt:999,result:'hidden'},recent:{message:message('recent'),route:'a',createdAt:1000,result:'observed'},latest:{message:message('latest'),route:'a',createdAt:1100,result:'latest answer'}}};
  const result=wecomObservedSummary(message(),{summaryRange:{limit:1,sinceHours:1}},state,1200,'a');
  expect(result.cursor).toBe('latest');expect(result.prompt).toContain('latest answer');expect(result.prompt).not.toContain('hidden');expect(result.prompt).not.toContain('observed');
  const hour=3600000,now=100*hour,many:WecomPlatformState={tasks:{}};
  for(let i=0;i<60;i++)many.tasks[`t${i}`]={message:message(`turn ${i}`),route:'a',createdAt:now-hour+i,result:`answer ${i}`};
  many.tasks.old={message:message('stale'),route:'a',createdAt:now-25*hour,result:'stale answer'};
  const unset=wecomObservedSummary(message(),{},many,now,'a');
  expect(unset.prompt).not.toContain('stale answer');
  expect(unset.prompt).not.toContain('answer 9\n');expect(unset.prompt).toContain('answer 10');expect(unset.prompt).toContain('answer 59');
  expect(unset.prompt.match(/机器人：/g)).toHaveLength(50);
 });
 it('rolls forward memory only after a durable consumed cursor and keeps scope provenance',()=>{
  const state:WecomPlatformState={tasks:{old:{message:message('consumed'),route:'a',createdAt:1},fresh:{message:message('fresh'),route:'a',createdAt:2}},summaryCursors:{a:'old'}};
  expect(rememberWecomSummary(state,'a','prior summary',3)).toContain('old');
  const prompt=wecomObservedSummary(message(),{summaryMemory:true},state,4,'a').prompt;expect(prompt).toContain('prior summary');expect(prompt).toContain('fresh');expect(prompt).not.toContain('consumed');
 });
 it('writes summary atomically inside real workspace and rejects symlink escapes',()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-memory-'));dirs.push(root);const workspace=join(root,'work'),outside=join(root,'outside');mkdirSync(workspace);mkdirSync(outside);
  writeWecomSummaryMemory(workspace,'nested/memory.md','summary');expect(readFileSync(join(workspace,'nested/memory.md'),'utf8')).toBe('summary');
  symlinkSync(outside,join(workspace,'escape'));expect(()=>writeWecomSummaryMemory(workspace,'escape/private.md','no')).toThrow('wecom_summary_path_escape');
  expect(()=>writeWecomSummaryMemory(workspace,'../outside/private.md','no')).toThrow('wecom_summary_path_escape');
 });
 // Mutation: judging either containment check of writeWecomSummaryMemory by `relative(...).startsWith('..')` again refuses these directories and turns this red.
 it('writes summary memory under directories whose names start with two dots, and still refuses such a name that links out',()=>{
  const root=mkdtempSync(join(tmpdir(),'wecom-memory-dots-'));dirs.push(root);const workspace=join(root,'work'),outside=join(root,'outside');mkdirSync(workspace);mkdirSync(outside);
  writeWecomSummaryMemory(workspace,'..notes/memory.md','new dir');expect(readFileSync(join(workspace,'..notes','memory.md'),'utf8')).toBe('new dir');
  mkdirSync(join(workspace,'..kept'));writeWecomSummaryMemory(workspace,'..kept/memory.md','existing dir');expect(readFileSync(join(workspace,'..kept','memory.md'),'utf8')).toBe('existing dir');
  symlinkSync(outside,join(workspace,'..escape'));expect(()=>writeWecomSummaryMemory(workspace,'..escape/private.md','no')).toThrow('wecom_summary_path_escape');
  expect(existsSync(join(outside,'private.md'))).toBe(false);
 });
 // Mutation: dropping the try around `new URL` for a feedback webhook lets a TypeError through and turns this red.
 it('refuses a feedback webhook url that is not a URL with the same error as any other invalid webhook',()=>{
  const hook={id:'hook',enabled:true,url:'https://example.com/feedback',secretRef:'ref',eventTypes:['turn.completed']};
  const errorOf=(url:unknown):Error=>{try{validateWecomNativePlatformConfig({feedbackWebhooks:[{...hook,url}]});}catch(error){return error as Error;}throw new Error('accepted');};
  const insecure=errorOf('http://example.com/feedback');
  for(const url of ['not a url','',42,undefined]){const error=errorOf(url);expect(error,String(url)).not.toBeInstanceOf(TypeError);expect(error.message,String(url)).toBe(insecure.message);}
  expect(validateWecomNativePlatformConfig({feedbackWebhooks:[hook]}).feedbackWebhooks).toEqual([hook]);
 });
 it('applies conversation feedback override',()=>{
  expect(wecomFeedbackPolicy({chatFeedbackPolicies:{g:{enabled:false}}},'g')).toEqual({enabled:false});
 });
 it('keeps thinking and tools private unless explicitly enabled',()=>{
  const progress={turnId:'turn',workerGeneration:1,entries:[{kind:'thinking' as const,text:'secret'},{kind:'tool_result' as const,id:'1',result:'private file'}]};
  expect(renderWecomProgress(progress,{})).toBe('');
 });
});
describe('native feedback transactional outbox',()=>{
 it('dedupes replay, keeps revision events distinct and retries outcome unknown using stable event identity',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1000);
  const state:NativeFeedbackState={},policy={feedbackWebhooks:[{id:'hook',enabled:true,url:'https://example.com/feedback',secretRef:'ref',eventTypes:['feedback.revised' as const]}]};
  const input={type:'feedback.revised' as const,botId:'bot',taskId:'task',sessionId:'session',triggerId:'turn',conversationId:'g',actor:'alice',revision:1,feedback:{semantic:'positive'}};
  enqueueWecomFeedbackEvent(state,policy,input);input.feedback.semantic='negative';expect(Object.values(state.nativeFeedbackOutbox!)[0].event.data.feedback).toMatchObject({semantic:'positive'});enqueueWecomFeedbackEvent(state,policy,input);enqueueWecomFeedbackEvent(state,policy,{...input,revision:2});
  expect(Object.keys(state.nativeFeedbackOutbox!)).toHaveLength(2);
  let durable=JSON.parse(JSON.stringify(state)),calls:string[]=[];
  const save=()=>{durable=JSON.parse(JSON.stringify(state));};
  const dispatch=vi.fn(async args=>{calls.push(args.event.eventId);expect(Object.values(durable.nativeFeedbackOutbox).some((row:any)=>row.status==='sending')).toBe(true);return {kind:'retry' as const,error:'webhook_outcome_unknown'};});
  await dispatchWecomFeedbackOutbox({state,save,secretDir:'/unused',readSecret:()=> 'secret',dispatch});
  vi.setSystemTime(1000000);
  await dispatchWecomFeedbackOutbox({state,save,secretDir:'/unused',readSecret:()=> 'secret',dispatch:async args=>{calls.push(args.event.eventId);return {kind:'delivered'};}});
  expect(calls[0]).toBe(calls[2]);expect(calls[1]).toBe(calls[3]);expect(Object.values(state.nativeFeedbackOutbox!).every(row=>row.status==='delivered')).toBe(true);
 });
});
