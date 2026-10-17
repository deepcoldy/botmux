// Only the external IM transport is replaced. Botmux's built daemon, handlers,
// broker, queues, worker pool and Worker/CLI processes are loaded unchanged.
import {createServer} from 'node:http';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.env.BOTMUX_TEST_ROOT, repo=process.env.BOTMUX_TEST_REPO;
const load=p=>import(pathToFileURL(`${repo}/${p}`));
const sdk=await load('node_modules/@larksuiteoapi/node-sdk/lib/index.js');
let dispatcher;
const externalFile=`${root}/external-im.json`;
let im;try{im=JSON.parse(readFileSync(externalFile,'utf8'));}catch{im={sequence:0,messages:{},requests:[]};}
const save=()=>writeFileSync(externalFile,JSON.stringify(im));
sdk.defaultHttpInstance.defaults.adapter=async cfg=>{
 const url=new URL(cfg.url,'https://open.feishu.cn');
 if(!['open.feishu.cn','open.larksuite.com'].includes(url.hostname))throw Error('unexpected SDK host');
 const method=(cfg.method||'get').toUpperCase(), path=url.pathname.replace(/\/$/,'');
 const body=typeof cfg.data==='string'?JSON.parse(cfg.data):cfg.data||{};
 im.requests.push({method,path,body});save();
 let data={code:0,msg:'success',data:{}};
 if(path.includes('/auth/v3/'))data={code:0,tenant_access_token:'fixture-only',app_access_token:'fixture-only',expire:7200};
 else if(path==='/open-apis/bot/v3/info')data={code:0,bot:{open_id:'ou_runtime_bot',app_name:'Isolated runtime test'}};
 else if(path.includes('/application/v6/')&&path.endsWith('/scopes'))data.data={scopes:[],has_more:false};
 else if(path.includes('/contact/v3/'))data.data={user:{open_id:'ou_runtime_owner',user_id:'fixture-owner',union_id:'on_fixture_owner',name:'Fixture owner',email:'fixture@example.invalid'},items:[],has_more:false};
 else if(path.endsWith('/members/is_in_chat'))data.data={is_in_chat:true};
 else if(path.endsWith('/members/bots'))data.data={items:[{open_id:'ou_runtime_bot',app_id:'cli_runtime_fixture'}],has_more:false};
 else if(path.endsWith('/reactions'))data.data={items:[],has_more:false,reaction_id:'fixture-reaction'};
 else if(path==='/open-apis/im/v1/messages'&&method==='POST'||path.endsWith('/reply')&&method==='POST'){
  const parent=im.messages[path.split('/').at(-2)];
  const id=`om_fixture_out_${++im.sequence}`;
  const message={message_id:id,chat_id:body.receive_id||parent?.chat_id||'oc_fixture_c2',root_id:parent?.root_id||parent?.message_id||'',message_type:body.msg_type,body:{content:body.content},sender:{id:'ou_runtime_bot',id_type:'open_id',sender_type:'app'},create_time:String(Date.now())};
  im.messages[id]=message;save();data.data=message;
 } else if(/\/im\/v1\/messages\/[^/]+$/.test(path)){
  const id=path.split('/').at(-1),msg=im.messages[id];
  if(method==='GET')data.data={items:msg?[msg]:[]};
  else if(msg){if(body.content)msg.body.content=body.content;save();data.data={message_id:id};}
 } else if(/\/im\/v1\/chats\/[^/]+$/.test(path))data.data={chat_id:path.split('/').at(-1),chat_mode:'group',chat_type:'private',name:'Isolated test',owner_id:'ou_runtime_owner',tenant_key:'fixture'};
 else if(path.endsWith('/members'))data.data={items:[{member_id:'ou_runtime_owner',member_id_type:'open_id',name:'Fixture owner'}],has_more:false};
 else if(path.includes('/cardkit/'))data.data={card_id:`fixture-card-${++im.sequence}`};
 else data={code:99999999,msg:`fixture unsupported ${method} ${path}`};
 return {data,status:200,statusText:'OK',headers:{},config:cfg};
};
const realFetch=globalThis.fetch;
globalThis.fetch=async (input,init={})=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(['open.feishu.cn','open.larksuite.com'].includes(url.hostname)){
  const response=await sdk.defaultHttpInstance.defaults.adapter({url:url.href,method:init.method??'GET',data:init.body});
  return new Response(JSON.stringify(response.data),{status:200,headers:{'content-type':'application/json'}});
 }
 if(['127.0.0.1','localhost','::1'].includes(url.hostname))return realFetch(input,init);
 throw Error('unexpected external fetch in isolated fixture: '+url.hostname);
};
sdk.WSClient.prototype.start=async function(options){dispatcher=options.eventDispatcher;};
const server=createServer(async(req,res)=>{
 try{
  let chunks='';for await(const c of req)chunks+=c;const body=chunks?JSON.parse(chunks):{};
  let result;
  const url=new URL(req.url,'http://fixture.invalid');
  if(url.pathname==='/event'){
   if(!dispatcher)throw Error('dispatcher not ready');
   if(body.event?.message){const m=body.event.message;im.messages[m.message_id]={...m,body:{content:m.content},sender:{id:body.event.sender.sender_id.open_id,id_type:'open_id',sender_type:'user'}};save();}
   result=await dispatcher.invoke(body,{needCheck:false});
  } else if(url.pathname==='/state'){
   const broker=await load('dist/core/ask-broker.js');const sessions=await load('dist/services/session-store.js');
   const {readTurnRegistration}=await load('dist/core/trigger-registration.js');
   const waits=broker.listAskContinuations();
   result={ready:!!dispatcher,pid:process.pid,asks:broker.listPendingAsks(),waits,sessions:sessions.listSessions(),registrations:waits.map(w=>({askId:w.askId,evidence:readTurnRegistration('cli_runtime_fixture',w.sessionId,w.continuation?.key??null)}))};
  }else throw Error('unknown fixture operation');
  if(url.searchParams.has('drop')){req.socket.destroy();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,result}));
 }catch(error){appendFileSync(`${root}/fixture-errors.log`,String(error.stack)+'\n');res.writeHead(500);res.end(JSON.stringify({ok:false,error:String(error)}));}
});
await new Promise(r=>server.listen(Number(process.env.BOTMUX_TEST_CONTROL_PORT),'127.0.0.1',r));
const {startDaemon}=await load('dist/daemon.js');
await startDaemon(0);
