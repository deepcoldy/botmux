import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('../src/bot-registry.js',()=>({getBotClient:()=>({})}));
vi.mock('../src/config.js',()=>({config:{session:{dataDir:''}}}));
vi.mock('../src/im/lark/client.js',()=>({larkGet:vi.fn(),getMessageDetail:vi.fn(),getLarkErrorCode:vi.fn()}));
import {config} from '../src/config.js';
import {larkGet} from '../src/im/lark/client.js';
import {resolveVerifiedUserIdentity,resolveVerifiedUserIdentityByUnionId,getIdentity,flushIdentityCacheSync} from '../src/im/lark/identity-cache.js';
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'identity-owned-'));config.session.dataDir=root;vi.mocked(larkGet).mockReset();vi.useFakeTimers();});
afterEach(()=>{flushIdentityCacheSync();vi.useRealTimers();rmSync(root,{recursive:true,force:true});});
it.each(['open_id','union_id'])('request-owned %s query verifies and publishes a current identity',async kind=>{
 vi.mocked(larkGet).mockResolvedValueOnce({code:0,data:{user:{open_id:'ou_valid',union_id:'on_valid',name:' Verified User ',enterprise_email:' verified@example.com '}}});
 const resolve=kind==='open_id'?resolveVerifiedUserIdentity:resolveVerifiedUserIdentityByUnionId;
 const result=await (resolve as any)(`cli_owned_valid_${kind}`,kind==='open_id'?'ou_valid':'on_valid',{signal:new AbortController().signal});
 expect(result).toMatchObject({openId:'ou_valid',name:'Verified User',email:'verified@example.com',...(kind==='union_id'?{unionId:'on_valid'}:{})});
 expect(getIdentity(`cli_owned_valid_${kind}`,'ou_valid')).toMatchObject({email:'verified@example.com'});
 expect(vi.mocked(larkGet).mock.calls[0]?.[3]?.signal?.aborted).toBe(false);
});
it.each(['open_id','union_id'])('request-owned %s query refuses a mismatched returned identity',async kind=>{
 vi.mocked(larkGet).mockResolvedValueOnce({code:0,data:{user:{open_id:'ou_wrong',union_id:'on_wrong',enterprise_email:'wrong@example.com'}}});
 const resolve=kind==='open_id'?resolveVerifiedUserIdentity:resolveVerifiedUserIdentityByUnionId;
 expect(await (resolve as any)(`cli_owned_mismatch_${kind}`,kind==='open_id'?'ou_expected':'on_expected',{signal:new AbortController().signal})).toBeUndefined();
 expect(getIdentity(`cli_owned_mismatch_${kind}`,'ou_wrong')).toBeUndefined();
});
it.each(['open_id','union_id'])('request-owned %s query holds underlying settlement and cannot publish after timeout',async kind=>{
 let settle!:(value:any)=>void;let started!:()=>void;const entered=new Promise<void>(r=>started=r);
 vi.mocked(larkGet).mockImplementationOnce(()=>new Promise(resolve=>{settle=resolve;started();}));
 const signal=new AbortController().signal;const resolve=kind==='open_id'?resolveVerifiedUserIdentity:resolveVerifiedUserIdentityByUnionId;
 let done=false;const pending=(resolve as any)(`cli_owned_${kind}`,kind==='open_id'?'ou_owned':'on_owned',{signal,timeoutMs:20}).then((value:any)=>{done=true;return value;});
 await entered;await vi.advanceTimersByTimeAsync(3001);
 expect(done).toBe(false);
 expect(vi.mocked(larkGet).mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
 settle({code:0,data:{user:{open_id:'ou_owned',union_id:'on_owned',enterprise_email:'owned@example.com'}}});
 expect(await pending).toBeUndefined();expect(getIdentity(`cli_owned_${kind}`,'ou_owned')).toBeUndefined();
});
it('request cancellation is isolated from a legacy shared lookup for the same union',async()=>{
 let settleOwned!:(value:any)=>void;const response={code:0,data:{user:{open_id:'ou_same',union_id:'on_same',enterprise_email:'same@example.com'}}};
 vi.mocked(larkGet).mockImplementationOnce(()=>new Promise(r=>settleOwned=r));vi.mocked(larkGet).mockResolvedValueOnce(response);
 const controller=new AbortController();const owned=(resolveVerifiedUserIdentityByUnionId as any)('cli_shared_owned','on_same',{signal:controller.signal,timeoutMs:20});
 const legacy=resolveVerifiedUserIdentityByUnionId('cli_shared_owned','on_same');controller.abort();await vi.advanceTimersByTimeAsync(3001);
 expect(await legacy).toMatchObject({openId:'ou_same'});settleOwned(response);expect(await owned).toBeUndefined();
 expect(getIdentity('cli_shared_owned','ou_same')).toMatchObject({email:'same@example.com'});
});
