import {createServer,request as httpRequest,type Server} from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {afterEach,describe,expect,it} from 'vitest';
import {NativeTerminalAccess,nativeTerminalOrigin,type NativeTerminalRequest,type NativeTerminalTarget} from '../src/dashboard/wecom/terminal-access.js';
import {WecomTerminalFront} from '../src/dashboard/wecom/terminal.js';
import {createDaemonClient} from '../src/dashboard/daemon-internal-client.js';
import {TERMINAL_CONTROL_HEADER} from '../src/dashboard/terminal-front-proxy.js';
import {verifyTerminalControlGrant} from '../src/core/terminal-control-grant.js';
import { WECOM_DASHBOARD_ROUTE_PATHS } from '../src/im/wecom/contract/dashboard-routes.js';
const SECRET='native-terminal-isolated-test-key';
const request:NativeTerminalRequest={identity:{provider:'wecom',connectionId:'connection-A',botId:'bot-A',userId:'native-human'},sessionId:'session-A',triggerId:'trigger-A',permission:'read'};
const target:NativeTerminalTarget={uiSessionId:'wecom:source:core:session',nativeSessionId:'session-A',binding:'worker-birth-A',proxyPort:1,epoch:'acl-A'};
const servers:Server[]=[],sockets:WebSocket[]=[],wsses:WebSocketServer[]=[];
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;}
afterEach(async()=>{for(const socket of sockets.splice(0))socket.terminate();for(const wss of wsses.splice(0))wss.close();await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})));});
function authority(){let now=Date.now(),allowed=true,current={...target};const resolve=async(input:NativeTerminalRequest)=>{if(!allowed||JSON.stringify(input.identity)!==JSON.stringify(request.identity)||input.sessionId!==request.sessionId||input.triggerId!==request.triggerId)throw new Error('forbidden');return {...current};};return {resolve,now:()=>now,advance:(ms:number)=>{now+=ms;},revoke:()=>{allowed=false;},change:(patch:Partial<NativeTerminalTarget>)=>{current={...current,...patch};}};}
function mockRequest(cookie:string,origin='http://127.0.0.1:12345'){return {headers:{cookie,host:new URL(origin).host},socket:{remoteAddress:'127.0.0.1'}} as any;}
describe('native terminal exchange authority',()=>{
 it('binds identity, bot, session and trigger, consumes a code only once including concurrent exchange',async()=>{
  const a=authority(),access=new NativeTerminalAccess({secret:SECRET,resolve:a.resolve,now:a.now,origin:()=>'http://127.0.0.1:12345'});
  for(const bad of [{...request,identity:{...request.identity,botId:'bot-B'}},{...request,identity:{...request.identity,connectionId:'connection-B'}},{...request,identity:{...request.identity,userId:'other'}},{...request,sessionId:'session-B'},{...request,triggerId:'old-trigger'}])await expect(access.mint(bad)).rejects.toThrow('forbidden');
  const link=await access.mint(request),code=new URL(link.url).searchParams.get('code')!;
  const exchanges=await Promise.all([access.exchange(code),access.exchange(code)]);expect(exchanges.filter(Boolean)).toHaveLength(1);
  const result=exchanges.find(Boolean)!,req=mockRequest(`bmx_native_terminal=${result.token}`);
  expect(await access.authenticate(req,result.browser.id)).toBeDefined();expect(await access.authenticate(req,'different-session')).toBeUndefined();
  expect(await access.authenticate(mockRequest('bmx_native_terminal=wrong'),result.browser.id)).toBeUndefined();
  expect(await access.authenticate(req,result.browser.id)).toBeDefined();
 });
 it('expires codes and browser sessions and rejects revocation, epoch changes and replaced workers',async()=>{
  for(const mutation of ['expiry','acl','epoch','worker'] as const){
   const a=authority(),access=new NativeTerminalAccess({secret:SECRET,resolve:a.resolve,now:a.now,origin:()=>'http://127.0.0.1:12345'});
   const code=new URL((await access.mint(request)).url).searchParams.get('code')!,result=(await access.exchange(code))!;
   if(mutation==='expiry')a.advance(300001);if(mutation==='acl')a.revoke();if(mutation==='epoch')a.change({epoch:'acl-B'});if(mutation==='worker')a.change({binding:'worker-birth-B'});
   expect(await access.authenticate(mockRequest(`bmx_native_terminal=${result.token}`),result.browser.id)).toBeUndefined();
  }
  const a=authority(),access=new NativeTerminalAccess({secret:SECRET,resolve:a.resolve,now:a.now,origin:()=>'http://127.0.0.1:12345'}),code=new URL((await access.mint(request)).url).searchParams.get('code')!;a.advance(60001);expect(await access.exchange(code)).toBeUndefined();
 });
 it('builds a link only on a bare http(s) origin',async()=>{
  for(const origin of ['https://example.com/path','https://user:secret@example.com','https://example.com/?token=x','ftp://example.com']){
   const access=new NativeTerminalAccess({secret:SECRET,resolve:authority().resolve,origin:()=>origin});
   await expect(access.mint(request),origin).rejects.toThrow('invalid_terminal_origin');
  }
  const access=new NativeTerminalAccess({secret:SECRET,resolve:authority().resolve,origin:()=>'https://terminal.example.com'});
  expect((await access.mint(request)).url).toMatch(/^https:\/\/terminal.example.com\/wecom-terminal\/exchange\?code=/);
 });
});
describe('the origin the Dashboard builds native terminal links on',()=>{
 it('is the self-hosted reverse proxy URL when one is set, otherwise the local form on the listening port',()=>{
  expect(nativeTerminalOrigin({publicUrl:'https://botmux.example.com',host:'10.0.0.5',port:7891})).toBe('https://botmux.example.com');
  expect(nativeTerminalOrigin({publicUrl:'http://botmux.example.com:8080',host:'10.0.0.5',port:7891})).toBe('http://botmux.example.com:8080');
  for(const publicUrl of [null,undefined,'','  '])expect(nativeTerminalOrigin({publicUrl,host:'10.0.0.5',port:7893})).toBe('http://10.0.0.5:7893');
 });
 it('brackets an IPv6 host in the local form',()=>{
  expect(nativeTerminalOrigin({host:'::1',port:7891})).toBe('http://[::1]:7891');
  expect(nativeTerminalOrigin({host:'fd00::5',port:7892})).toBe('http://[fd00::5]:7892');
 });
 it('falls back to the local form for a public URL with a path prefix, or one that is not a bare origin',()=>{
  for(const publicUrl of ['https://x.example/botmux','https://x.example/botmux/','https://user:pw@x.example','https://x.example/?a=1','ftp://x.example','not a url']){
   expect(nativeTerminalOrigin({publicUrl,host:'10.0.0.5',port:7891}),publicUrl).toBe('http://10.0.0.5:7891');
  }
 });
 it('marks the browser cookie Secure exactly when the link origin is https',async()=>{
  for(const [origin,secure] of [['https://botmux.example.com',true],['http://10.0.0.5:7891',false]] as const){
   const access=new NativeTerminalAccess({secret:SECRET,resolve:authority().resolve,origin:()=>origin});
   const link=new URL((await access.mint(request)).url);
   let headers:Record<string,string>={};
   const res={writeHead:(_status:number,h:Record<string,string>)=>{headers=h;},end:()=>{}} as any;
   expect(await access.handle({method:'GET',headers:{host:link.host}} as any,res,link)).toBe(true);
   expect(headers['set-cookie'],origin).toBeDefined();
   expect(/;\s*Secure\b/.test(headers['set-cookie']),origin).toBe(secure);
  }
 });
});
async function fixture(){
 const a=authority(),seen:Array<Record<string,unknown>>=[];let beforeReply:(()=>void)|undefined;
 const worker=createServer((req,res)=>{const proof=verifyTerminalControlGrant(SECRET,typeof req.headers[TERMINAL_CONTROL_HEADER]==='string'?req.headers[TERMINAL_CONTROL_HEADER]:undefined,'session-A');seen.push({headers:req.headers,proof});beforeReply?.();res.writeHead(proof.ok?200:403,{'content-type':'text/plain'}).end(proof.ok?`terminal-${proof.claims.scope}`:'denied');});
 const wss=new WebSocketServer({noServer:true});wsses.push(wss);
 worker.on('upgrade',(req,socket,head)=>{const proof=verifyTerminalControlGrant(SECRET,typeof req.headers[TERMINAL_CONTROL_HEADER]==='string'?req.headers[TERMINAL_CONTROL_HEADER]:undefined,'session-A');if(!proof.ok){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}beforeReply?.();wss.handleUpgrade(req,socket,head,ws=>{sockets.push(ws);ws.send(proof.claims.scope);ws.on('message',data=>ws.send(proof.claims.scope==='write'?`input:${data}`:'readonly'));});});
 const workerPort=await listen(worker);a.change({proxyPort:workerPort});
 // The Dashboard's own address: known once the server below listens.
 let dashboardOrigin='';
 const access=new NativeTerminalAccess({secret:SECRET,resolve:a.resolve,now:a.now,origin:()=>dashboardOrigin});
 const front=new WecomTerminalFront({sessions:{terminal:async()=>({...target,proxyPort:workerPort})},secret:SECRET,audit:{append(){}},resolveActor:req=>req.headers.cookie==='host-admin=ok'?{kind:'legacy-dashboard',userId:'host',authSessionId:'host-auth',expiresAt:Date.now()+60000}:null,isAuthSessionLive:()=>true,nativeAccess:access});
 const server=createServer(async(req,res)=>{if(await front.http(req,res,new URL(req.url??'/','http://localhost')))return;res.writeHead(req.headers.cookie==='host-admin=ok'?200:403).end('host-only-config');});
 server.on('upgrade',(req,socket,head)=>{void front.upgrade(req,socket,head).then(handled=>{if(!handled)socket.destroy();});});
 const port=await listen(server),origin=`http://127.0.0.1:${port}`;dashboardOrigin=origin;const client=createDaemonClient({dashboardUrl:origin,secret:SECRET,appId:'native-fixture'});
 async function open(permission: 'read' | 'write') {
  const minted = await client.request({
   method: 'POST',
   path: WECOM_DASHBOARD_ROUTE_PATHS.terminalMint,
   body: { ...request, permission },
  });
  expect(minted.status).toBe(200);
  const body = minted.body as { url: string };
  expect(body.url).not.toContain(SECRET);
  const exchanged = await fetch(body.url, { redirect: 'manual' });
  expect(exchanged.status).toBe(303);
  const cookie = exchanged.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  expect(cookie).toContain('Path=/wecom-terminal/native/');
  expect(exchanged.headers.get('referrer-policy')).toBe('no-referrer');
  expect((await fetch(body.url, { redirect: 'manual' })).status).toBe(403);
  return { path: exchanged.headers.get('location')!, cookie: cookie.split(';')[0] };
 }
 return {a,origin,port,open,seen,onUpstreamReply:(callback:()=>void)=>{beforeReply=callback;}};
}
async function connectSocket(origin:string,path:string,cookie:string){const ws=new WebSocket(origin.replace('http:','ws:')+path,{headers:{cookie,origin}});sockets.push(ws);const first=once(ws,'message');await once(ws,'open');return {ws,first:await first};}
describe('native terminal production front HTTP and websocket',()=>{
 it('exchanges over signed loopback RPC and keeps a native read cookie outside host/admin and other-session routes',async()=>{
  const f=await fixture(),read=await f.open('read');
  const response=await fetch(f.origin+read.path,{headers:{cookie:read.cookie,'x-botmux-role':'owner','x-botmux-terminal-control':'forged'}});expect(await response.text()).toBe('terminal-read');
  const forwarded=f.seen.at(-1)!.headers as Record<string,unknown>;expect(forwarded.cookie).toBeUndefined();expect(forwarded['x-botmux-role']).toBeUndefined();expect(forwarded[TERMINAL_CONTROL_HEADER]).not.toBe('forged');
  expect((await fetch(f.origin+'/api/config',{headers:{cookie:read.cookie}})).status).toBe(403);
  expect((await fetch(f.origin+'/wecom-terminal/other-session/',{headers:{cookie:read.cookie}})).status).toBe(403);
  expect((await fetch(f.origin+read.path+'riff/host-tools',{headers:{cookie:read.cookie}})).status).toBe(403);
  expect((await fetch(f.origin+read.path+'control/takeover?acq=takeover123',{method:'POST',headers:{cookie:read.cookie,origin:f.origin}})).status).toBe(403);
  const socket=await connectSocket(f.origin,read.path,read.cookie);expect(String(socket.first[0])).toBe('read');const message=once(socket.ws,'message');socket.ws.send('arbitrary input');expect(String((await message)[0])).toBe('readonly');
  const closed=once(socket.ws,'close');f.a.revoke();await closed;
  expect((await fetch(f.origin+read.path,{headers:{cookie:read.cookie}})).status).toBe(403);
 });
 it('converts native operate permission into a lease and write grant only on loopback, with origin and worker-restart revocation',async()=>{
  const f=await fixture(),write=await f.open('write');expect(await(await fetch(f.origin+write.path,{headers:{cookie:write.cookie}})).text()).toBe('terminal-write');
  const socket=await connectSocket(f.origin,write.path,write.cookie);expect(String(socket.first[0])).toBe('write');const message=once(socket.ws,'message');socket.ws.send('hello');expect(String((await message)[0])).toBe('input:hello');
  expect((await fetch(f.origin+write.path+'control/release',{method:'POST',headers:{cookie:write.cookie,origin:'https://evil.example','x-forwarded-proto':'https'}})).status).toBe(403);
  const closed=once(socket.ws,'close');f.a.change({binding:'new-worker-birth'});await closed;
  expect((await fetch(f.origin+write.path,{headers:{cookie:write.cookie}})).status).toBe(403);
  expect(await(await fetch(f.origin+'/wecom-terminal/host-session/',{headers:{cookie:'host-admin=ok'}})).text()).toBe('terminal-read');
 });
 it('rechecks native ACL after an upstream HTTP or websocket handshake before relaying any terminal bytes',async()=>{
  const http=await fixture(),read=await http.open('read');http.onUpstreamReply(()=>http.a.revoke());
  const response=await fetch(http.origin+read.path,{headers:{cookie:read.cookie}});expect(response.status).toBe(403);expect(await response.text()).not.toContain('terminal-read');
  const upgrade=await fixture(),wsRead=await upgrade.open('read');upgrade.onUpstreamReply(()=>upgrade.a.revoke());
  const status=await new Promise<number>((resolve,reject)=>{const ws=new WebSocket(upgrade.origin.replace('http:','ws:')+wsRead.path,{headers:{cookie:wsRead.cookie,origin:upgrade.origin}});sockets.push(ws);ws.on('open',()=>reject(new Error('revoked handshake was relayed')));ws.on('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(res.statusCode??0);});ws.on('error',()=>{});});expect(status).toBe(403);
 });
 it('builds the link on its own address even when an earlier gateway names another one', async () => {
  const f = await fixture();
  const client = createDaemonClient({ dashboardUrl: f.origin, secret: SECRET, appId: 'native-fixture-old-gateway' });
  const minted = await client.request({
   method: 'POST',
   path: WECOM_DASHBOARD_ROUTE_PATHS.terminalMint,
   body: { ...request, baseUrl: 'https://attacker.example' },
  });
  expect(minted.status).toBe(200);
  const url = new URL((minted.body as { url: string }).url);
  expect(url.origin).toBe(f.origin);
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(303);
 });
 it('refuses browser-forged mint requests and invalid host exchanges', async () => {
  const f = await fixture();
  const ordinary = await f.open('read');
  const wrongHost = await new Promise<number>((resolve, reject) => {
   const req = httpRequest(f.origin + ordinary.path, { headers: { cookie: ordinary.cookie, host: 'attacker.invalid' } }, res => {
    res.resume();
    resolve(res.statusCode ?? 0);
   });
   req.on('error', reject);
   req.end();
  });
  expect(wrongHost).toBe(403);
  const forged = await fetch(f.origin + WECOM_DASHBOARD_ROUTE_PATHS.terminalMint, {
   method: 'POST',
   body: JSON.stringify(request),
  });
  expect(forged.status).toBeGreaterThanOrEqual(400);
 });
});
