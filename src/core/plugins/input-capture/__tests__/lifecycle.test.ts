import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureDigest,createInputCaptureStore} from '../store.js';
import {createInputCaptureRuntime,type InputCaptureRuntime} from '../runtime.js';
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'capture-lifecycle-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const store=createInputCaptureStore(dir,'cli_app');
 const session={sessionId:'s',larkAppId:'cli_app',chatId:'oc_group',anchor:'oc_group',ownerOpenId:'ou_owner',active:true,scope:'chat',chatType:'group'};
 const options={larkAppId:'cli_app',store,session:(_id:string)=>session,pluginEnabled:(p:string)=>p==='provider',canTalk:(_:unknown,a:string)=>a!=='ou_denied',deliver:async()=>{throw Error('offline');}};
 const runtime=createInputCaptureRuntime(options);cleanup.push(()=>runtime.stop());
 const registration={pluginId:'provider',requestId:'one',providerRef:'opaque',actorOpenId:'ou_owner'};
 const input={messageId:'om_first',chatId:'oc_group',anchor:'oc_group',senderOpenId:'ou_owner',text:'answer',botSender:false};
 return {store,session,options,runtime,registration,input};
}
function tx(runtime:InputCaptureRuntime,intentKey:string,expected:unknown[],close:unknown[],open:unknown[]){
 return runtime.reconcile('s',{intentKey,expected,close,open,requestHash:captureDigest(['s',expected,close,open])});
}
it('fences absent registration, survives restart and replays the same close intent',async()=>{
 const f=fixture(),key={pluginId:'provider',requestId:'one'};
 expect(f.runtime.inspectRegistration('s',key).state).toBe('absent');
 const expected=[{...key,expectedRevision:null,throughSequence:0}];
 const closed=tx(f.runtime,'close',expected,[key],[]);
 await f.runtime.stop();
 const resumed=createInputCaptureRuntime(f.options);cleanup.push(()=>resumed.stop());
 expect(tx(resumed,'close',expected,[key],[])).toEqual(closed);
 expect(resumed.inspectRegistration('s',key).state).toBe('closed');
 expect(()=>resumed.register('s',f.registration)).toThrow('registration_closed');
 expect(()=>tx(resumed,'close',[],[],[])).toThrow('identity_conflict');
});
it('atomically hands over only at the observed input high-water and preserves accepted input',()=>{
 const f=fixture(),old=f.runtime.register('s',f.registration),next={...f.registration,requestId:'two',actorSelector:'authorized_humans'};
 const key={pluginId:'provider',requestId:'one'},newKey={pluginId:'provider',requestId:'two'};
 f.runtime.capture(f.input);
 expect(()=>tx(f.runtime,'handover',[{...key,expectedRevision:1,throughSequence:0},{...newKey,expectedRevision:null,throughSequence:0}],[key],[next])).toThrow('inputs_conflict');
 expect(f.runtime.inspect('s',old.id)?.binding.active).toBe(true);
 tx(f.runtime,'handover',[{...key,expectedRevision:1,throughSequence:1},{...newKey,expectedRevision:null,throughSequence:0}],[key],[next]);
 expect(f.runtime.capture({...f.input,messageId:'om_second',senderOpenId:'ou_member'})).toBe(true);
 expect(f.store.read().inputs).toHaveLength(2);
 expect(f.store.read().inputs[0].bindingId).toBe(old.id);
 expect(f.store.read().inputs[1].bindingId).not.toBe(old.id);
 expect(f.runtime.capture(f.input)).toBe(true);
 expect(f.store.read().inputs).toHaveLength(2);
});
it('rolls back every close when any new binding conflicts',()=>{
 const f=fixture(),old=f.runtime.register('s',f.registration);
 f.runtime.register('s',{...f.registration,requestId:'card',inputAnchor:'om_card'});
 const key={pluginId:'provider',requestId:'one'},newKey={pluginId:'provider',requestId:'next'};
 expect(()=>tx(f.runtime,'bad',[{...key,expectedRevision:1,throughSequence:0},{...newKey,expectedRevision:null,throughSequence:0}],[key],[{...f.registration,requestId:'next',inputAnchor:'om_card'}])).toThrow('anchor_conflict');
 expect(f.runtime.inspect('s',old.id)?.binding.active).toBe(true);
 expect(f.store.read().closures).toBeUndefined();
});
it('captures all authorized humans with specific card precedence, never a bot or an unauthorized member',()=>{
 const f=fixture();
 const root=f.runtime.register('s',{...f.registration,actorSelector:'authorized_humans',captureAttachments:true});
 const card=f.runtime.register('s',{...f.registration,requestId:'card',inputAnchor:'om_card'});
 expect(f.runtime.capture({...f.input,anchor:'om_card'})).toBe(true);
 expect(f.runtime.capture({...f.input,messageId:'om_member',anchor:'om_other',threadId:'omt_other',senderOpenId:'ou_member'})).toBe(true);
 expect(f.store.read().inputs.map(i=>i.bindingId)).toEqual([card.id,root.id]);
 expect(f.runtime.capture({...f.input,messageId:'om_bot',botSender:true})).toBe(false);
 expect(()=>f.runtime.capture({...f.input,messageId:'om_denied',senderOpenId:'ou_denied'})).toThrow('authority_changed');
 expect(()=>f.runtime.register('s',{...f.registration,requestId:'conflict'})).toThrow('anchor_conflict');
 expect(f.runtime.capture({...f.input,messageId:'om_unmanaged',chatId:'oc_other'})).toBe(false);
});
it('cannot widen a thread binding to authorized humans',()=>{
 const f=fixture();f.session.scope='thread';f.session.anchor='om_root';
 expect(()=>f.runtime.register('s',{...f.registration,actorSelector:'authorized_humans'})).toThrow('invalid_input_capture_selector');
});
it('captures native message edits as ordered immutable versions, independently of ACK and replay',async()=>{
 const f=fixture();f.runtime.register('s',{...f.registration,actorSelector:'authorized_humans'});
 f.runtime.capture(f.input);
 f.runtime.capture({...f.input,contentVersion:'100',text:'revised answer'});
 f.runtime.capture({...f.input,contentVersion:'100',text:'revised answer'});
 expect(f.store.read().inputs.map(i=>[i.sequence,i.text,i.contentVersion])).toEqual([[1,'answer',undefined],[2,'revised answer','100']]);
 expect(()=>f.runtime.capture({...f.input,contentVersion:'100',text:'different bytes'})).toThrow('message_conflict');
 await f.runtime.stop();
 const resumed=createInputCaptureRuntime(f.options);cleanup.push(()=>resumed.stop());
 expect(resumed.capture({...f.input,contentVersion:'101',text:'third version'})).toBe(true);
 expect(f.store.read().inputs).toHaveLength(3);
});
it('hands a thread registration to a configured group without changing the original source identity',()=>{
 const f=fixture();const group={...f.session};f.session.scope='thread';f.session.anchor='om_root';
 const old=f.runtime.register('s',f.registration),oldKey={sessionId:'s',pluginId:'provider',requestId:'one'};
 // The host resolves each original session; a transaction must not reinterpret
 // the old key under the new group session.
 f.options.session=(id:string)=>id==='group'?{...group,sessionId:'group'}:f.session;
 const runtime=createInputCaptureRuntime(f.options);cleanup.push(()=>runtime.stop());
 const next={sessionId:'group',...f.registration,requestId:'new',actorSelector:'authorized_humans'};
 const result=tx(runtime,'cross-session',[{...oldKey,expectedRevision:1,throughSequence:0},
  {sessionId:'group',pluginId:'provider',requestId:'new',expectedRevision:null,throughSequence:0}],[oldKey],[next]) as any;
 expect(result.bindings[0].sessionId).toBe('group');
 expect(runtime.inspect('s',old.id)?.binding.active).toBe(false);
});
