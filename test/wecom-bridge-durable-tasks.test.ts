import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';
import { WecomBridge, type WecomCore, type BridgeTransport } from '../src/im/wecom/gateway/bridge.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); vi.useRealTimers(); });
function message(id: string, text = 'task', userId = 'alice'): WecomInboundMessage {
  return {messageId:id,text,userId,conversationId:userId,chatType:'single',replyContext:{requestId:id},attachments:[]};
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'wecom-bridge-durable-')); roots.push(root);
  const stateFile = join(root,'state.json');
  const trigger = vi.fn(async (_request: TriggerRequest) => ({ok:true,triggerId:'turn',target:{kind:'turn' as const,sessionId:'session'}}));
  const result = vi.fn(async () => ({ok:true,state:'completed' as const,output:{content:'answer'}}));
  const interrupt = vi.fn(async () => {});
  const reply = vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: {finish?:boolean;streamId?:string}) => {});
  const send = vi.fn(async (_conversation:string,_text:string) => {});
  const core: WecomCore = {trigger,result,interrupt}; const transport: BridgeTransport = {reply,send};
  const bridge = (allowedUsers=['alice','bob']) => new WecomBridge({botId:'bot',allowedUsers,stateFile,transport,core});
  return {root,stateFile,core,transport,trigger,result,interrupt,reply,send,bridge};
}
describe('WeCom bridge durable task admission, dispatch and delivery', () => {
  it('revokes durable admission before dispatch and never replies after permission removal', async () => {
    const f=fixture(); await f.bridge().receive(message('admit')); f.reply.mockClear();
    await f.bridge(['bob']).tick();
    expect(f.trigger).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('cancels an admitted undispatched task across restart', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('admit')); await bridge.receive(message('stop','/stop'));
    await f.bridge().tick(); expect(f.trigger).not.toHaveBeenCalled();
    expect(f.reply.mock.calls.some(call=>call[2]?.finish===true)).toBe(true);
  });
  it('replays a lost trigger response with the same request before stopping the recovered turn', async () => {
    const f=fixture(); f.trigger.mockRejectedValueOnce(new Error('response lost'));
    const first=f.bridge(); await first.receive(message('admit')); await first.tick(); await first.receive(message('stop','/stop'));
    await f.bridge().tick(); expect(f.trigger).toHaveBeenCalledTimes(2);
    expect(f.trigger.mock.calls[0]).toEqual(f.trigger.mock.calls[1]); expect(f.interrupt).toHaveBeenCalledWith('session','turn');
  });
  it('does not let one unavailable user prevent another route from dispatching', async () => {
    const f=fixture(); f.trigger.mockRejectedValueOnce(new Error('network failed'));
    const bridge=f.bridge(); await bridge.receive(message('a')); await bridge.receive(message('b','task','bob')); await bridge.tick();
    expect(f.trigger).toHaveBeenCalledTimes(2); expect(f.reply.mock.calls.some(call=>call[0].userId==='bob'&&call[2]?.finish===true)).toBe(true);
  });
  it('does not redispatch an already delivered inbound task', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('a')); await bridge.tick();
    await f.bridge().receive(message('a')); await f.bridge().tick(); expect(f.trigger).toHaveBeenCalledTimes(1);
  });
  it('does not replay an old restart command against a later session after process restart', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('a')); await bridge.tick(); await bridge.receive(message('r','/restart'));
    await bridge.receive(message('b')); await bridge.tick();
    const restored=f.bridge(); await restored.receive(message('r','/restart')); await restored.receive(message('c')); await restored.tick();
    expect(f.trigger.mock.calls[2][0].target.sessionId).toBe('session');
  });
  it('stops polling safely poisoned memory after a durable write failure', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('a'));
    const unblock=blockWecomStateWrites(f.stateFile); await expect(bridge.tick()).rejects.toMatchObject({ code: 'EISDIR' });
    unblock(); await expect(bridge.tick()).rejects.toThrow(/状态写入失败/); expect(f.trigger).not.toHaveBeenCalled();
    await f.bridge().tick(); expect(f.trigger).toHaveBeenCalledTimes(1);
  });
  it('does not let replayed old stop cancel a later task', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('a')); await bridge.receive(message('stop','/stop')); await bridge.tick();
    await bridge.receive(message('b')); await bridge.receive(message('stop','/stop')); await bridge.tick();
    expect(f.trigger).toHaveBeenCalledTimes(1);
  });
  it('poisons admission when state directory creation itself fails', async () => {
    const f=fixture(), bridge=f.bridge(); await bridge.receive(message('a'));
    const backup=`${f.root}-backup`; roots.push(backup); renameSync(f.root,backup); writeFileSync(f.root,'blocked parent');
    await expect(bridge.tick()).rejects.toMatchObject({ code: 'EEXIST' }); rmSync(f.root); renameSync(backup,f.root);
    await expect(bridge.tick()).rejects.toThrow(/状态写入失败/); expect(f.trigger).not.toHaveBeenCalled();
  });
  it('continues result convergence if stop races an already completed turn', async () => {
    const f=fixture(); let completed=false;
    const request = vi.fn(async (url: string | URL | Request) => {
      const path=String(url);
      if(path.endsWith('/api/trigger')) return Response.json({ok:true,triggerId:'turn',target:{kind:'turn',sessionId:'session'}});
      if(path.endsWith('/interrupt')) return Response.json({ok:false,error:'already terminal'},{status:409});
      return Response.json(completed?{ok:true,state:'completed',output:{content:'done'}}:{ok:true,state:'running'});
    });
    const http=new WecomHttpCore('http://127.0.0.1:12345',request as typeof fetch); Object.assign(f.core,{trigger:http.trigger.bind(http),result:http.result.bind(http),interrupt:http.interrupt.bind(http)});
    const bridge=f.bridge(); await bridge.receive(message('a')); await bridge.tick(); completed=true;
    await bridge.receive(message('stop','/stop')).catch(()=>{}); f.reply.mockClear();
    await bridge.tick(); await bridge.tick();
    expect(f.reply.mock.calls.some(call=>call[1]==='done')).toBe(true);
  });
  it('resumes only unconfirmed UTF-8 parts after a fallback send failure and restart', async () => {
    const f=fixture(); const text='😀'.repeat(11000); f.result.mockResolvedValue({ok:true,state:'completed',output:{content:text}});
    f.reply.mockImplementation(async (_m,_t,options)=>{if(options?.finish) throw new Error('callback expired')});
    f.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second part not sent'));
    const bridge=f.bridge(); await bridge.receive(message('a')); await bridge.tick();
    const confirmed=f.send.mock.calls[0][1]; f.send.mockClear(); await f.bridge().tick();
    expect(f.send.mock.calls.some(call=>call[1]===confirmed)).toBe(false);
    expect(f.send.mock.calls.length).toBeGreaterThan(0); expect(f.trigger).toHaveBeenCalledTimes(1);
    for(const call of f.send.mock.calls) expect(call[1]).not.toContain('�');
  });
  it('fails closed in memory after send confirmation cannot be persisted and exposes the documented replay window', async () => {
    const f=fixture(); f.reply.mockImplementation(async (_m,_t,options)=>{if(options?.finish) throw new Error('callback expired')});
    let unblock=()=>{}; f.send.mockImplementationOnce(async()=>{unblock=blockWecomStateWrites(f.stateFile)});
    const bridge=f.bridge(); await bridge.receive(message('a')); await expect(bridge.tick()).rejects.toMatchObject({ code: 'EISDIR' });
    unblock(); await expect(bridge.tick()).rejects.toThrow(/状态写入失败/);
    expect(f.send).toHaveBeenCalledTimes(1); await f.bridge().tick(); expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.trigger).toHaveBeenCalledTimes(1);
  });
  it('attributes fallback results to native users sharing a group', async () => {
    const f=fixture(); f.reply.mockImplementation(async (_m,_t,options)=>{if(options?.finish) throw new Error('callback expired')});
    const bridge=f.bridge(); await bridge.receive({...message('a'),chatType:'group',conversationId:'shared'});
    await bridge.receive({...message('b','task','bob'),chatType:'group',conversationId:'shared'}); await bridge.tick();
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[0][0]).toBe('shared');
    expect(f.send.mock.calls[0][1]).toContain('alice'); expect(f.send.mock.calls[1][1]).toContain('bob');
  });
  it('processes stop while a core network wait is in progress before final delivery', async () => {
    const f=fixture(); let release!:()=>void; const blocked=new Promise<void>(resolve=>release=resolve);
    f.trigger.mockImplementationOnce(async()=>{await blocked;return {ok:true,triggerId:'turn',target:{kind:'turn',sessionId:'session'}}});
    const bridge=f.bridge(); await bridge.receive(message('a')); const tick=bridge.tick(); await Promise.resolve();
    const stopping=bridge.receive(message('stop','/stop')); release(); await tick; await stopping;
    expect(f.interrupt).toHaveBeenCalled();
  });
});
