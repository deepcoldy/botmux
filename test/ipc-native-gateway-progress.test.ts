import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { parseBotConfigsFromText, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
let server: IpcServerHandle | undefined;
const secret = 'native-gateway-progress-fixture-secret';
afterEach(async () => { await server?.close(); server = undefined; setIpcAuthSecret(null); setLarkAppId(''); __testOnly_resetBotRegistry(); vi.restoreAllMocks(); });
async function fixture() {
  __testOnly_resetBotRegistry();
  const bot = registerBot(parseBotConfigsFromText(JSON.stringify([{larkAppId:'local_progress',apiOnly:true,cliId:'codex'}]))[0]);
  setIpcAuthSecret(secret); setLarkAppId('local_progress');
  const ds: any = { larkAppId:'local_progress',chatId:'http_async_fixture',workerGeneration:2,
    session:{sessionId:'session',larkAppId:'local_progress',chatId:'http_async_fixture'},
    asyncTriggerResults:new Map([['turn',{status:'pending'}]]), activeInteractiveTurn:{turnId:'turn'},
    lastThinkingUpdate:{workerGeneration:2,turnId:'turn',entries:[{type:'thinking',text:'current turn reasoning'}]} };
  vi.spyOn(pool,'findActiveBySessionId').mockImplementation(id=>id==='session'?ds:undefined);
  server=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true,coreOnlyPublicRoutes:true});
  const request = (query='triggerId=turn', trusted=true,endpoint='native-gateway-progress') => {
    const path=`/api/sessions/session/${endpoint}?${query}`;
    return fetch(`http://127.0.0.1:${server!.port}${path}`,{headers:trusted?daemonIpcAuthHeaders({secret,port:server!.port,method:'GET',path}):{}});
  };
  return {ds,bot,request};
}
describe('dedicated core native gateway progress HTTP boundary',()=>{
  it('requires trusted-host authentication even when ordinary core polling is public',async()=>{
    const f=await fixture(),response=await f.request('triggerId=turn',false);
    expect(response.status).toBe(401);expect(await response.text()).not.toContain('current turn reasoning');
  });
  it('returns only the current authenticated HTTP turn with no cached response',async()=>{
    const f=await fixture(),response=await f.request();
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ok:true,progress:{turnId:'turn',workerGeneration:2,entries:[{text:'current turn reasoning'}]}});
    expect(await (await f.request('triggerId=prior')).json()).toEqual({ok:true,progress:null});
  });
  it('refuses cross-bot, real IM and transport-enabled sessions',async()=>{
    const f=await fixture();
    f.ds.session.larkAppId='local_other';expect((await f.request()).status).toBe(404);
    f.ds.session.larkAppId='local_progress';f.ds.chatId='oc_lark';expect((await f.request()).status).toBe(404);
    f.ds.chatId='http_async_fixture';f.bot.config.apiOnly=false;expect((await f.request()).status).toBe(404);
  });
  it('keeps native recipient reminders authenticated and bound to the latest session turn',async()=>{
    const f=await fixture();f.ds.latestAsyncTriggerId='turn';f.ds.session.status='active';f.ds.worker={killed:false};f.ds.lastScreenStatus='idle';f.ds.lastMessageAt=1;
    expect((await f.request('triggerId=turn',false,'native-gateway-reminder-state')).status).toBe(401);
    const response=await f.request('triggerId=turn',true,'native-gateway-reminder-state');
    expect(await response.json()).toMatchObject({ok:true,reminder:{triggerId:'turn',states:['idle'],active:true}});
    expect(await (await f.request('triggerId=prior',true,'native-gateway-reminder-state')).json()).toEqual({ok:true,reminder:null});
  });
  it('rejects ambiguous trigger selectors and does not fall back to a prior generation',async()=>{
    const f=await fixture();expect((await f.request('triggerId=turn&triggerId=other')).status).toBe(400);
    f.ds.principalLaneRunningTurn={turnId:'turn',workerGeneration:1};
    expect(await (await f.request()).json()).toEqual({ok:true,progress:null});
  });
});
