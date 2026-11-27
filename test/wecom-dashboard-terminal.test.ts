import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket,WebSocketServer } from 'ws';
import { describe,it,expect } from 'vitest';
import { WecomTerminalFront } from '../src/dashboard/wecom/terminal.js';
import { verifyTerminalControlGrant } from '../src/core/terminal-control-grant.js';
const secret='fixture-terminal-secret';
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
async function fixture(){
 const claims:any[]=[],wss=new WebSocketServer({noServer:true});
 const upstream=createServer((req,res)=>{const grant=verifyTerminalControlGrant(secret,req.headers['x-botmux-terminal-control'] as string,'shared-native');claims.push(grant);res.end('fixture terminal');});
 upstream.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{ws.send('ready');}));
 const port=await listen(upstream),state={binding:'boot-one',available:true};
 const front=new WecomTerminalFront({secret,audit:{append(){}},sessions:{terminal:async id=>{if(!state.available)throw new Error();return {nativeSessionId:'shared-native',proxyPort:port,binding:id+state.binding};}},resolveActor:req=>req.headers.cookie==='fixture-auth'?{kind:'legacy-dashboard',userId:'host',authSessionId:'fixture-auth',expiresAt:Date.now()+60000,terminalCapability:'controlled'}:null,isAuthSessionLive:()=>true});
 const dashboard=createServer(async(req,res)=>{await front.http(req,res,new URL(req.url!,'http://localhost'));});
 dashboard.on('upgrade',(req,socket,head)=>{void front.upgrade(req,socket,head);});const dashboardPort=await listen(dashboard);
 return {front,claims,state,url:`http://127.0.0.1:${dashboardPort}`,async close(){for(const ws of wss.clients)ws.terminate();await close(dashboard);await close(upstream);wss.close();}};
}
describe('source-bound WeCom terminal proxy',()=>{
 it('requires host-admin cookies and keeps worker grants on the server, with isolated same-native leases',async()=>{
  const f=await fixture();try{
   expect((await fetch(f.url+'/wecom-terminal/source-a/')).status).toBe(403);expect(f.claims).toHaveLength(0);
   const headers={cookie:'fixture-auth'};expect(await (await fetch(f.url+'/wecom-terminal/source-a/',{headers})).text()).toBe('fixture terminal');
   expect(f.claims.at(-1)).toMatchObject({ok:true,claims:{scope:'read',sessionId:'shared-native'}});
   const req={method:'POST',headers} as any;expect((await f.front.control(req,'source-a','takeover',new URLSearchParams('acq=fixture-acquisition'))).status).toBe(200);
   await fetch(f.url+'/wecom-terminal/source-a/',{headers});expect(f.claims.at(-1)).toMatchObject({ok:true,claims:{scope:'write'}});
   await fetch(f.url+'/wecom-terminal/source-b/',{headers});expect(f.claims.at(-1)).toMatchObject({ok:true,claims:{scope:'read'}});
   expect((await fetch(f.url+'/wecom-terminal/source-a/?token=foreign',{headers})).status).toBe(403);
   f.front.releaseByAuthSession('fixture-auth');await fetch(f.url+'/wecom-terminal/source-a/',{headers});expect(f.claims.at(-1)).toMatchObject({ok:true,claims:{scope:'read'}});
  }finally{await f.close();}
 });
 it('revokes an established WebSocket when its bound core/worker generation changes',async()=>{
  const f=await fixture();let ws:WebSocket|undefined;try{
   ws=new WebSocket(f.url.replace('http:','ws:')+'/wecom-terminal/source-a/',{headers:{cookie:'fixture-auth'}});await once(ws,'message');
   const ended=once(ws,'close');f.state.binding='boot-two';await ended;expect(ws.readyState).toBe(WebSocket.CLOSED);
  }finally{ws?.terminate();await f.close();}
 });
});
