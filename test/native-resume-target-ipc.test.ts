import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, routeHasNarrowUntrustedAuth,
  type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as pool from '../src/core/worker-pool.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';

const secret='owned-native-resume-management';
const path='/api/sessions/owned-session/resume-target';
const request={sourceId:'00000000-0000-4000-8000-000000000001',
  targetId:'00000000-0000-4000-8000-000000000002',sourceSha256:'a'.repeat(64),targetSha256:'b'.repeat(64)};
let ipc:IpcServerHandle|undefined;
afterEach(async()=>{await ipc?.close();ipc=undefined;setIpcAuthSecret(null);setLarkAppId('');vi.restoreAllMocks();__testOnly_resetBotRegistry();});
async function call(body:unknown,signed=true,method='POST'){
  if(!ipc){setIpcAuthSecret(secret);setLarkAppId('cli_owned');
    ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});}
  const headers=signed?daemonIpcAuthHeaders({secret,port:ipc.port,method,path,
    headers:{'content-type':'application/json'}}):{'content-type':'application/json'};
  return fetch(`http://127.0.0.1:${ipc.port}${path}`,{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})});
}
function arm(){
  registerBot({ larkAppId:'cli_owned', larkAppSecret:'fixture', cliId:'traex', apiOnly:true });
  const ds:any={larkAppId:'cli_owned',session:{sessionId:'owned-session',status:'active',cliId:'traex'}};
  vi.spyOn(pool,'findActiveBySessionId').mockReturnValue(ds);
  vi.spyOn(pool,'isSessionLifecycleInFlight').mockReturnValue(false);
  vi.spyOn(pool,'isSessionTransferring').mockReturnValue(false);
  const restart=vi.spyOn(pool,'requestSessionRestart').mockReturnValue({attemptId:'owned-attempt',joined:false});
  return{ds,restart};
}
describe('native resume-target HTTP authority',()=>{
  it('readback exposes actual identity/readiness, not prompts, paths, tokens or guessed success',async()=>{
    const f=arm();Object.assign(f.ds,{worker:{killed:false},workerReady:true,cliReady:false,
      lastScreenStatus:'idle',initConfig:{prompt:'private prompt',env:{TOKEN:'private credential'}}});
    f.ds.session.cliSessionId=request.sourceId;
    const r=await call(undefined,true,'GET');expect(r.status).toBe(200);
    const text=await r.text();expect(text).not.toContain('private');
    expect(JSON.parse(text)).toMatchObject({protocol:1,nativeSessionId:request.sourceId,workerReady:true,cliReady:false});
    expect(f.restart).not.toHaveBeenCalled();
    expect((await call(undefined,false,'GET')).status).toBe(401);
  });
  it('never exposes management replacement as a worker capability route',async()=>{
    const f=arm();expect(routeHasNarrowUntrustedAuth('POST',path)).toBe(false);
    for(const body of [request,{...request,originCapability:'ab'.repeat(32)}]){
      expect((await call(body,false)).status).toBe(401);
    }
    expect(f.restart).not.toHaveBeenCalled();
  });
  it('only admits an exact host request and never reports migration complete on admission',async()=>{
    const f=arm();const r=await call(request);
    expect(r.status).toBe(202);expect(await r.json()).toMatchObject({state:'accepted',attemptId:'owned-attempt',targetId:request.targetId});
    expect(f.restart).toHaveBeenCalledWith(f.ds,expect.any(Object),{nativeResumeTarget:request});
    for(const extra of [{model:'replacement'},{sourcePath:'/outside'},{callerOpenId:'other'},{prompt:'replay'}]){
      expect((await call({...request,...extra})).status).toBe(400);
    }
    expect(f.restart).toHaveBeenCalledTimes(1);
  });
  it('rejects a foreign Bot, a replaced session, queued work and overlapping lifecycle operation',async()=>{
    const f=arm();f.ds.larkAppId='cli_other';expect((await call(request)).status).toBe(404);
    f.ds.larkAppId='cli_owned';f.ds.session.queued=true;expect((await call(request)).status).toBe(409);
    delete f.ds.session.queued;
    vi.mocked(pool.isSessionLifecycleInFlight).mockReturnValue(true);
    expect((await call(request)).status).toBe(409);expect(f.restart).not.toHaveBeenCalled();
  });
  it('a worker preflight refusal or IPC failure is not a successful migration',async()=>{
    const f=arm();f.restart.mockReturnValue(undefined);
    expect((await call(request)).status).toBe(409);
    f.restart.mockReturnValue({attemptId:'a',joined:false,startFailure:{error:new Error('private detail')}});
    const r=await call(request);expect(r.status).toBe(502);expect(await r.text()).not.toContain('private detail');
  });
});
