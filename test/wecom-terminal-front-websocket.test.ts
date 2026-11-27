import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { WecomTerminalFront } from '../src/dashboard/wecom/terminal.js';
const clean:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close()});
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');clean.push(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>(done=>server.close(()=>done()))});return (server.address() as {port:number}).port}
async function fixture(){
 const requests:IncomingMessage[]=[];const upstream=createServer((req,res)=>{requests.push(req);res.writeHead(200,{'content-type':'text/plain'});res.end('private terminal fixture')});const wsServer=new WebSocketServer({noServer:true});upstream.on('upgrade',(req,socket,head)=>{requests.push(req);wsServer.handleUpgrade(req,socket,head,ws=>{ws.on('message',data=>ws.send(data))})});clean.push(()=>{for(const ws of wsServer.clients)ws.terminate();wsServer.close()});const upstreamPort=await listen(upstream);
 let binding='core-a:worker-birth-a';const live=new Set(['login-a','login-b']);const sessions={terminal:vi.fn(async()=>({nativeSessionId:'same-native-sid',proxyPort:upstreamPort,binding}))};
 const actor=(req:IncomingMessage)=>{const auth=req.headers['x-test-login'];if(typeof auth!=='string')return null;return {kind:auth==='h5'?'feishu-h5':'legacy-dashboard',userId:auth,authSessionId:auth,expiresAt:Date.now()+60000,terminalCapability:'owner' as const,previewCapability:'operate' as const}};
 const front=new WecomTerminalFront({sessions,secret:'fixture-secret',audit:{append:()=>{}},resolveActor:actor,isAuthSessionLive:id=>live.has(id)});
 const server=createServer((req,res)=>{void front.http(req,res,new URL(req.url??'/','http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end()}})});server.on('upgrade',(req,socket,head)=>{void front.upgrade(req,socket,head)});const port=await listen(server);
 const url=`http://127.0.0.1:${port}/wecom-terminal/opaque-source-id/`;
 const connect=async(login:string)=>{const ws=new WebSocket(url.replace('http:','ws:'),{headers:{'x-test-login':login}});clean.push(()=>ws.terminate());await once(ws,'open');return ws};
 return {front,url,requests,sessions,live,connect,changeBinding:()=>{binding='core-a:worker-birth-b'}};
}
it('keeps anonymous and H5 requests away from the terminal and never returns raw upstream credentials',async()=>{
 const f=await fixture();expect((await fetch(f.url)).status).toBe(403);expect((await fetch(f.url,{headers:{'x-test-login':'h5'}})).status).toBe(403);expect(f.requests).toHaveLength(0);
 const response=await fetch(f.url,{headers:{'x-test-login':'login-a'}});expect(response.status).toBe(200);expect(await response.text()).toBe('private terminal fixture');expect(f.requests).toHaveLength(1);expect(Object.keys(f.requests[0].headers).some(key=>key.includes('grant')||key.includes('control'))).toBe(true);
});
it('closes an existing real WebSocket when its source worker binding changes',async()=>{
 const f=await fixture(),ws=await f.connect('login-a');f.changeBinding();await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED),{timeout:2500,interval:25});
});
it('revokes only the old login real WebSocket while preserving another login to the same source',async()=>{
 const f=await fixture(),old=await f.connect('login-a'),current=await f.connect('login-b');f.live.delete('login-a');f.front.releaseByAuthSession('login-a');await vi.waitFor(()=>expect(old.readyState).toBe(WebSocket.CLOSED),{timeout:1500,interval:25});expect(current.readyState).toBe(WebSocket.OPEN);
});
