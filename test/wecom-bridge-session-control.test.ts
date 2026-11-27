import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.useRealTimers()});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
async function fixture(){const root=mkdtempSync(join(tmpdir(),'wecom-unified-control-'));roots.push(root);const stateFile=join(root,'state.json');let completed=false;let counter=0;const trigger=vi.fn(async(_request:TriggerRequest)=>({ok:true,triggerId:`turn-${++counter}`,target:{kind:'turn' as const,sessionId:'same-native-sid'}}));const result=vi.fn(async()=>completed?{ok:true,state:'completed' as const,output:{content:'done'}}:{ok:true,state:'running' as const});const interrupt=vi.fn(async()=>{});const reply=vi.fn(async()=>{});const options={botId:'fixture',allowedUsers:['user'],coreIdentity:'core-a',stateFile,transport:{reply,send:async()=>{}},core:{trigger,result,interrupt}};const create=()=>new WecomBridge(options);const message=(id:string)=>({messageId:id,userId:'user',conversationId:'user',chatType:'single' as const,text:'task',replyContext:{requestId:id},attachments:[]});const bridge=create();await bridge.receive(message('first'));await bridge.tick();return {root,stateFile,options,create,message,bridge,trigger,result,interrupt,reply,complete:()=>{completed=true}}}
describe('WeCom bridge durable session control',()=>{
 it('never replays an action whose core succeeded but final state persistence failed',async()=>{
  const f=await fixture();f.complete();await f.bridge.tick();let unblock=()=>{};const action=vi.fn(async()=>{unblock=blockWecomStateWrites(f.stateFile);return {ok:true}});const request={sessionId:'same-native-sid',operation:'close' as const,requestId:'half-write'};
  await expect(f.bridge.controlSession(request,action)).rejects.toMatchObject({ code: 'EISDIR' });unblock();const restored=f.create();expect(await restored.controlSession(request,action)).toMatchObject({ok:false,status:'uncertain'});expect(action).toHaveBeenCalledTimes(1);
  await restored.receive(f.message('after-close'));await restored.tick();expect(f.trigger.mock.calls.at(-1)?.[0].target.sessionId).toBeUndefined();
 });
 it('blocks input throughout a delayed suspend action and replays the same control id without another RPC',async()=>{
  const f=await fixture();f.complete();await f.bridge.tick();const gate=deferred(),action=vi.fn(async()=>{await gate.promise;return {ok:true}}),request={sessionId:'same-native-sid',operation:'suspend' as const,requestId:'slow-suspend'};
  const pending=f.bridge.controlSession(request,action);await Promise.resolve();const input=f.bridge.receive(f.message('during-suspend'));expect(await f.bridge.controlSession(request,action)).toEqual({ok:false,status:'pending'});gate.resolve();await pending;await input;await f.bridge.tick();expect(f.trigger).toHaveBeenCalledTimes(1);expect(action).toHaveBeenCalledTimes(1);
  await f.create().controlSession(request,action);expect(action).toHaveBeenCalledTimes(1);
 });
 it('does not perform an admitted control after gateway halt while its queue is blocked',async()=>{
  const f=await fixture(),gate=deferred();f.result.mockImplementationOnce(async()=>{await gate.promise;return {ok:true,state:'running'}});const tick=f.bridge.tick();await Promise.resolve();const action=vi.fn(async()=>({ok:true}));const control=f.bridge.controlSession({sessionId:'same-native-sid',operation:'close',requestId:'halt-control'},action);f.bridge.halt();gate.resolve();await tick;expect(await control).toMatchObject({ok:false,status:'pending'});expect(action).not.toHaveBeenCalled();
  expect(await f.create().controlSession({sessionId:'same-native-sid',operation:'close',requestId:'halt-control'},action)).toMatchObject({status:'uncertain'});expect(action).not.toHaveBeenCalled();
 });
 it('orders distinct concurrent controls without releasing the route during an unfinished resume',async()=>{
  const f=await fixture();f.complete();await f.bridge.tick();const gate=deferred(),order:string[]=[];const action=vi.fn(async(_sid:string,operation:string)=>{order.push(operation);if(operation==='suspend')await gate.promise;return {ok:true}});
  const suspend=f.bridge.controlSession({sessionId:'same-native-sid',operation:'suspend',requestId:'suspend'},action);const resume=f.bridge.controlSession({sessionId:'same-native-sid',operation:'resume',requestId:'resume'},action);await Promise.resolve();gate.resolve();await suspend;await resume;expect(order).toEqual(['suspend','resume']);await f.bridge.receive(f.message('after-resume'));await f.bridge.tick();expect(f.trigger.mock.calls[1][0].target.sessionId).toBe('same-native-sid');
 });
 it('detaches a queued continuation from its frozen target while its trigger RPC is pending',async()=>{
  const f=await fixture();f.complete();await f.bridge.tick();const gate=deferred();f.trigger.mockImplementationOnce(async()=>{await gate.promise;return {ok:true,triggerId:'new-turn',target:{kind:'turn',sessionId:'same-native-sid'}}});await f.bridge.receive(f.message('continuation'));const tick=f.bridge.tick();await Promise.resolve();const action=vi.fn(async()=>({ok:true}));const close=f.bridge.controlSession({sessionId:'same-native-sid',operation:'close',requestId:'close-continuation',expectedGeneration:'turn-1'},action);gate.resolve();await tick;await close;
  const restored=f.create();await restored.receive(f.message('fresh'));await restored.tick();expect(f.trigger.mock.calls.at(-1)?.[0].target.sessionId).toBeUndefined();expect(action).toHaveBeenCalledTimes(1);
 });
 it('does not permit a conflicting replay or an unknown native session to execute host control',async()=>{
  const f=await fixture();f.complete();await f.bridge.tick();const action=vi.fn(async()=>({ok:true}));await f.bridge.controlSession({sessionId:'same-native-sid',operation:'suspend',requestId:'request'},action);
  await expect(f.bridge.controlSession({sessionId:'same-native-sid',operation:'resume',requestId:'request'},action)).rejects.toThrow('request_conflict');await expect(f.bridge.controlSession({sessionId:'other-core-sid',operation:'close',requestId:'foreign'},action)).rejects.toThrow('session_not_owned');expect(action).toHaveBeenCalledTimes(1);
 });
});

describe('WeCom host control of a session the core no longer has', () => {
  const SID = 'same-native-sid';

  /** One finished turn in the chat; for resume, the session is first suspended successfully. */
  async function settled(operation: 'restart' | 'resume' | 'suspend') {
    const f = await fixture();
    f.complete();
    await f.bridge.tick();
    if (operation === 'resume') {
      const suspended = await f.bridge.controlSession(
        { sessionId: SID, operation: 'suspend', requestId: 'suspend-first' },
        async () => ({ ok: true }),
      );
      expect(suspended).toMatchObject({ ok: true });
    }
    return f;
  }

  /** The chat's next message: did it go to the core, and as which kind of request? */
  async function nextMessage(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const before = f.trigger.mock.calls.length;
    await f.bridge.receive(f.message(id));
    await f.bridge.tick();
    const dispatched = f.trigger.mock.calls.slice(before).map(call => call[0]);
    return { dispatched };
  }

  it.each(['restart', 'resume', 'suspend'] as const)(
    '%s: a definite session_not_active refusal leaves no lock, and the next message starts a new session',
    async operation => {
      const f = await settled(operation);
      const action = vi.fn(async () => ({ ok: false, sessionGone: true }));

      const result = await f.bridge.controlSession({ sessionId: SID, operation, requestId: 'gone' }, action);

      expect(action).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false, status: 'rejected', error: 'session_not_active' });
      // The Dashboard projects a saved lock as the session's managementState; none may remain.
      expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).sessionLocks?.[SID]).toBeUndefined();
      const { dispatched } = await nextMessage(f, 'after-gone');
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].target.sessionId).toBeUndefined();
    },
  );

  it('a replay of the same request id gives the same answer without asking the core again, also after a restart', async () => {
    const f = await settled('restart');
    const action = vi.fn(async () => ({ ok: false, sessionGone: true }));
    const request = { sessionId: SID, operation: 'restart' as const, requestId: 'gone-replay' };
    const first = await f.bridge.controlSession(request, action);

    expect(await f.bridge.controlSession(request, action)).toEqual(first);
    expect(await f.create().controlSession(request, action)).toEqual(first);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('a restarted gateway also lets the chat start a new session (the refusal was saved)', async () => {
    const f = await settled('restart');
    await f.bridge.controlSession(
      { sessionId: SID, operation: 'restart', requestId: 'gone-saved' },
      async () => ({ ok: false, sessionGone: true }),
    );
    const restored = f.create();
    const before = f.trigger.mock.calls.length;

    await restored.receive(f.message('after-restore'));
    await restored.tick();

    const dispatched = f.trigger.mock.calls.slice(before).map(call => call[0]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].target.sessionId).toBeUndefined();
  });

  // Fail closed: a failure that is not the definite refusal keeps the chat locked.
  it.each([
    ['a plain failure', async () => ({ ok: false })],
    ['an explicit sessionGone: false', async () => ({ ok: false, sessionGone: false })],
    ['a throw (timeout, no connection)', async () => { throw new Error('core unreachable'); }],
  ] as const)('restart that ends in %s stays uncertain and blocks the chat', async (_name, outcome) => {
    const f = await settled('restart');
    const action = vi.fn(outcome);

    const result = await f.bridge.controlSession({ sessionId: SID, operation: 'restart', requestId: 'unknown' }, action);

    expect(result).toEqual({ ok: false, status: 'uncertain' });
    const repliesBefore = f.reply.mock.calls.length;
    const { dispatched } = await nextMessage(f, 'after-unknown');
    expect(dispatched).toEqual([]);
    // The blocked message is answered, not silently dropped.
    expect(f.reply.mock.calls.length).toBe(repliesBefore + 1);
  });
});
