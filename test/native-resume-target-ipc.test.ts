import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, routeHasNarrowUntrustedAuth, ipcRoute, ipcHmacAuthorized, readJsonBody, jsonRes,
  type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as pool from '../src/core/worker-pool.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { tryWithBotTurnMutation } from '../src/core/bot-turn-mutation-gate.js';
import { sameIdRuntimeRestartSupported } from '../src/utils/native-resume-target-plan.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { sandboxEnabled } from '../src/adapters/backend/sandbox.js';

const secret='owned-native-resume-management';
const path='/api/sessions/owned-session/resume-target';
const request={sourceId:'00000000-0000-4000-8000-000000000001',
  targetId:'00000000-0000-4000-8000-000000000002',sourceSha256:'a'.repeat(64),targetSha256:'b'.repeat(64)};
let ipc:IpcServerHandle|undefined;
const mutation = process.env.NATIVE_RUNTIME_PARK_MUTATION;
const parkPath = mutation ? '/__runtime_park/owned-session' : `${path}/park`;
if (mutation) {
  // 非文本断言：执行真实路由的内存副本，摘掉一个 guard 证明 HTTP 行为断言会失败。
  // 源码结构护栏(K2)：原闭包没有导出 seam；变异不写回源码，不触及真实服务。
  const source = ts.createSourceFile('ipc.ts', readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  let handler: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcRoute'
      && node.arguments[1] && ts.isStringLiteral(node.arguments[1])
      && node.arguments[1].text === '/api/sessions/:sessionId/resume-target/park') handler = node.arguments[2];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!handler) throw new Error('Cannot construct park mutant');
  const text = handler.getText(source);
  const broken = mutation === 'drop-source'
    ? text.replace('ds.session.cliSessionId === sourceId', 'true')
    : mutation === 'drop-input'
      ? text.replace('sessionAcceptsDirectCommand(ds, operationId && runtime ? { operationId, runtime } : undefined)', 'true')
      : text;
  if (broken === text) throw new Error('Park mutation did not alter its guard');
  const scope = { ipcHmacAuthorized, jsonRes, readJsonBody, cachedLarkAppId: 'cli_owned',
    findActiveBySessionId: (...args: any[]) => (pool.findActiveBySessionId as any)(...args),
    tryWithBotTurnMutation, sameIdRuntimeRestartSupported, sandboxEnabled, controllerForSession,
    isSessionLifecycleInFlight: (...args: any[]) => (pool.isSessionLifecycleInFlight as any)(...args),
    sessionAcceptsDirectCommand: (...args: any[]) => (pool.sessionAcceptsDirectCommand as any)(...args),
    hasPendingOrdinaryImDelivery: (...args: any[]) => (pool.hasPendingOrdinaryImDelivery as any)(...args),
    hasUnsettledAcceptedInput: (...args: any[]) => (pool.hasUnsettledAcceptedInput as any)(...args),
    suspendWorkerAsync: (...args: any[]) => (pool.suspendWorkerAsync as any)(...args) };
  const compiled = ts.transpileModule(`const handler = ${broken};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  ipcRoute('POST', '/__runtime_park/:sessionId', new Function(...Object.keys(scope), `${compiled};return handler;`)(...Object.values(scope)));
}
afterEach(async()=>{await ipc?.close();ipc=undefined;setIpcAuthSecret(null);setLarkAppId('');vi.restoreAllMocks();__testOnly_resetBotRegistry();});
async function call(body:unknown,signed=true,method='POST',routePath=path){
  if(!ipc){setIpcAuthSecret(secret);setLarkAppId('cli_owned');
    ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});}
  const headers=signed?daemonIpcAuthHeaders({secret,port:ipc.port,method,path:routePath,
    headers:{'content-type':'application/json'}}):{'content-type':'application/json'};
  return fetch(`http://127.0.0.1:${ipc.port}${routePath}`,{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})});
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

describe('same-ID Codex runtime refresh', () => {
  function idle() {
    const f = arm();
    Object.assign(f.ds, { worker: { killed: false }, workerGeneration: 8, workerReady: true,
      cliReady: true, lastScreenStatus: 'idle', backgroundTaskCount: 0,
      initConfig: { cliId: 'codex', backendType: 'tmux', sandbox: false } });
    Object.assign(f.ds.session, { cliId: 'codex', cliSessionId: request.sourceId, backendType: 'tmux' });
    return f;
  }
  it('requires management identity, exact source and strict idle; never calls interrupting restart', async () => {
    const f = idle();
    const suspend = vi.spyOn(pool, 'suspendWorkerAsync').mockResolvedValue(true);
    const park = (body: unknown = { sourceId: request.sourceId }, signed = true) => call(body, signed, 'POST', parkPath);
    expect((await park(undefined, false)).status).toBe(401);
    expect((await park({ sourceId: request.sourceId, prompt: 'replay' })).status).toBe(400);
    expect((await park({ sourceId: request.targetId })).status).toBe(409);
    f.ds.lastScreenStatus = 'working'; expect((await park()).status).toBe(409);
    f.ds.lastScreenStatus = 'idle'; f.ds.pendingRawInput = 'human'; expect((await park()).status).toBe(409);
    f.ds.pendingRawInput = undefined; f.ds.backgroundTaskCount = 1; expect((await park()).status).toBe(409);
    f.ds.backgroundTaskCount = 0; f.ds.initConfig.backendType = 'pty'; expect((await park()).status).toBe(409);
    f.ds.initConfig.backendType = 'tmux';
    expect(suspend).not.toHaveBeenCalled();
    const response = await park();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'parked', sourceId: request.sourceId });
    expect(suspend).toHaveBeenCalledOnce();
    expect(f.restart).not.toHaveBeenCalled();
  });
  it('refuses to erase an accepted input whose exact terminal is still missing', async () => {
    const f = idle();
    f.ds.acceptedInputTurns = new Map([['open-turn', {
      workerGeneration: f.ds.workerGeneration, turnId: 'open-turn', phase: 'native-submit', at: Date.now(),
    }]]);
    const suspend = vi.spyOn(pool, 'suspendWorkerAsync').mockResolvedValue(true);
    const response = await call({ sourceId: request.sourceId }, true, 'POST', parkPath);
    expect(response.status).toBe(409);
    expect(suspend).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
  });
  it('rechecks source, generation and human input at the asynchronous suspension boundary', async () => {
    const f = idle();
    const effects: string[] = [];
    let intervene = () => {};
    vi.spyOn(pool, 'suspendWorkerAsync').mockImplementation(async (_ds, _reason, stillOwned) => {
      expect(stillOwned?.()).toBe(true);
      await Promise.resolve();
      intervene();
      if (!stillOwned?.()) return false;
      effects.push('physical-suspend');
      return true;
    });
    for (const mutate of [
      () => { f.ds.pendingRawInput = 'new human input'; },
      () => { f.ds.workerGeneration++; },
      () => { f.ds.session.cliSessionId = request.targetId; },
    ]) {
      Object.assign(f.ds, { pendingRawInput: undefined, workerGeneration: 8 });
      f.ds.session.cliSessionId = request.sourceId;
      intervene = mutate;
      expect((await call({ sourceId: request.sourceId }, true, 'POST', parkPath)).status).toBe(409);
    }
    expect(effects).toEqual([]);
    expect(f.restart).not.toHaveBeenCalled();
  });
});
